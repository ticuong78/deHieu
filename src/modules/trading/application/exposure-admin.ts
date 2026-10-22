import type { OperationStatus } from '../../../shared/domain/domain-repository.js';
import type { TraderProfile } from '../domain/trader-profile.js';
import type { EntryRef, ExposureLedgerReader } from './exposure.ports.js';
import type { TraderConfigSync } from './trader-config.sync.js';
import type {
  StakeTierSource,
  TraderProfileRepository,
  TradingSettingsStore,
} from './trading.ports.js';

export interface MatchUsageView {
  readonly match: string;
  readonly usedUsd: number;
  /** Giới hạn chung (0 = tắt). */
  readonly capUsd: number;
  readonly ttlMs: number | null;
  readonly profiles: readonly {
    readonly profileId: string;
    readonly profileName: string | null;
    readonly usedUsd: number;
    /** Giới hạn riêng của profile (0 = không có). */
    readonly capUsd: number;
    readonly ttlMs: number | null;
  }[];
}

export interface EntryUsageView extends EntryRef {
  readonly profileName: string | null;
  readonly tierName: string | null;
  readonly count: number;
  /** Số lệnh tối đa hiện cấu hình cho cửa này ở hạng này; 0 = không giới hạn. */
  readonly max: number | null;
  readonly ttlMs: number | null;
}

export interface ExposureView {
  /** false = không đọc được Redis (xem error). */
  readonly available: boolean;
  readonly error: string | null;
  readonly matches: readonly MatchUsageView[];
  readonly entries: readonly EntryUsageView[];
}

/** Xem / đặt lại sổ phơi nhiễm thật (Redis) mà trader dùng để quyết định. */
export class ExposureAdmin {
  constructor(
    private readonly _reader: ExposureLedgerReader,
    private readonly _profiles: TraderProfileRepository,
    private readonly _tiers: StakeTierSource,
    private readonly _settings: TradingSettingsStore,
    /** Báo trader xét lại kèo bị chặn vì hạn mức / số lệnh sau khi trả lại. */
    private readonly _sync: TraderConfigSync | null = null,
  ) {}

  private async _freed(profileId?: string): Promise<void> {
    if (this._sync) await this._sync.broadcast('exposure_freed', profileId);
  }

  async view(mode?: 'paper' | 'live'): Promise<ExposureView> {
    const [profiles, tiers, settings] = await Promise.all([
      this._profiles.list(),
      this._tiers.listTiers(),
      this._settings.get(),
    ]);
    let snap;
    try {
      snap = await this._reader.snapshot(mode);
    } catch (e: unknown) {
      return {
        available: false,
        error: e instanceof Error ? e.message : String(e),
        matches: [],
        entries: [],
      };
    }
    const prof = new Map<string, TraderProfile>(profiles.map((p) => [p.id, p]));
    const tierName = new Map(tiers.map((t) => [t.id, t.name]));
    return {
      available: true,
      error: null,
      matches: snap.matches.map((m) => ({
        match: m.match,
        usedUsd: m.usedUsd ?? 0,
        capUsd: settings.matchExposureCapUsd,
        ttlMs: m.ttlMs,
        profiles: m.byProfile.map((b) => ({
          ...b,
          profileName: prof.get(b.profileId)?.name ?? null,
          capUsd: prof.get(b.profileId)?.risk.matchCapUsd ?? 0,
        })),
      })),
      entries: snap.entries.map((e) => {
        const p = prof.get(e.profileId);
        return {
          ...e,
          profileName: p?.name ?? null,
          tierName: tierName.get(e.tierId) ?? null,
          max: p
            ? (p.stakePlan.overrides[e.tierId]?.maxEntries ??
              p.risk.maxEntriesPerTier)
            : null,
        };
      }),
    };
  }

  async resetMatch(
    match: string,
    mode?: 'paper' | 'live',
  ): Promise<OperationStatus<{ keys: number }>> {
    if (!match.trim()) return { status: 'FAILED', reason: 'MATCH_REQUIRED' };
    const keys = await this._reader.resetMatch(match, mode);
    await this._freed();
    return { status: 'SUCEED', data: { keys } };
  }

  async resetEntry(
    e: EntryRef,
    mode?: 'paper' | 'live',
  ): Promise<OperationStatus<{ keys: number }>> {
    const keys = await this._reader.resetEntry(e, mode);
    await this._freed(e.profileId);
    return { status: 'SUCEED', data: { keys } };
  }
}
