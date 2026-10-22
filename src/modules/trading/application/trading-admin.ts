import { randomUUID } from 'node:crypto';
import type { OperationStatus } from '../../../shared/domain/domain-repository.js';
import type { StakeRow } from '../../../shared/domain/stake-table.js';
import {
  resolveStakeTable,
  sortTiers,
  validateStakePlan,
  type StakePlan,
  type StakeTier,
} from '../domain/stake-plan.js';
import {
  normalizePrivateKey,
  validateAccountConfig,
  type TradingAccount,
  type TradingAccountConfig,
  type TradingVenue,
} from '../domain/trading-account.js';
import {
  validateTraderProfile,
  type RiskLimits,
  type StrategyRef,
  type TraderMode,
  type TraderProfile,
} from '../domain/trader-profile.js';
import {
  validateTradingSettings,
  type TradingSettings,
} from '../domain/trading-settings.js';
import type {
  TradeAttempt,
  TradeAttemptQuery,
  TradePurgeFilter,
  TradePurgeResult,
  TradeStats,
  TradeStatus,
  TradeStatsQuery,
} from './trade-attempt.js';
import type { TraderConfigSync } from './trader-config.sync.js';
import type { TraderRuntimeConfig } from './trader-config.js';
import type {
  SecretCipher,
  StakeTierSource,
  TradeAttemptRepository,
  TraderProfileRepository,
  TradingAccountRepository,
  TradingSettingsStore,
} from './trading.ports.js';

export interface AccountInput {
  readonly loginUsername?: string;
  readonly loginPassword?: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly config: TradingAccountConfig;
  /** polymarket: private key. Bỏ trống khi sửa = giữ key cũ. */
  readonly privateKey?: string;
  /** polymarket: Relayer API Key (chuyển tiền gasless). Bỏ trống khi sửa = giữ key cũ. */
  readonly relayerApiKey?: string;
}

/** Tài khoản trả cho web: KHÔNG kèm bí mật, chỉ cho biết đã có hay chưa. */
export interface TradingAccountView {
  readonly id: string;
  readonly venue: TradingVenue;
  readonly label: string;
  readonly enabled: boolean;
  readonly config: TradingAccountConfig;
  readonly hasSecret: boolean;
  /** polymarket: đã lưu Relayer API Key (mã hóa) chưa. */
  readonly hasRelayerKey: boolean;
  /** Profile đang dùng tài khoản này. */
  readonly usedBy: readonly string[];
}

export interface ProfileInput {
  readonly name: string;
  readonly enabled: boolean;
  readonly mode: TraderMode;
  readonly csgoempireAccountId: string;
  readonly polymarketAccountId: string;
  readonly stakePlan: StakePlan;
  readonly strategy: StrategyRef;
  readonly risk: RiskLimits;
}

/** Yêu cầu xóa lệnh: chọn trạng thái (một hoặc nhiều) HOẶC all = true. */
export interface TradePurgeInput {
  readonly statuses?: readonly TradeStatus[];
  /** Xóa mọi trạng thái (vẫn áp profileId/before nếu có). */
  readonly all?: boolean;
  readonly profileId?: string;
  readonly before?: number;
  /** Chỉ đếm, không xóa. */
  readonly dryRun?: boolean;
}

export interface StakePreview {
  readonly tiers: readonly StakeTier[];
  readonly rows: readonly StakeRow[];
}

const fail = (reason: string) => ({ status: 'FAILED' as const, reason });

/**
 * Use case quản trị auto trade: tài khoản, profile, cấu hình chung, xem lệnh giấy.
 * Mọi thay đổi ghi database rồi gửi lại cấu hình cho các task trader đang chạy.
 */
export class TradingAdmin {
  constructor(
    private readonly _accounts: TradingAccountRepository,
    private readonly _profiles: TraderProfileRepository,
    private readonly _trades: TradeAttemptRepository,
    private readonly _settings: TradingSettingsStore,
    private readonly _tiers: StakeTierSource,
    private readonly _cipher: SecretCipher,
    private readonly _sync: TraderConfigSync,
  ) {}

  // ------------------------------------------------------------- tài khoản

  async listAccounts(): Promise<TradingAccountView[]> {
    const [accounts, profiles] = await Promise.all([
      this._accounts.list(),
      this._profiles.list(),
    ]);
    return accounts.map((a) => this._view(a, profiles));
  }

  async saveAccount(
    id: string | null,
    input: AccountInput,
  ): Promise<OperationStatus<TradingAccountView>> {
    const label = input.label.trim();
    if (!label) return fail('ACCOUNT_LABEL_REQUIRED');
    const invalid = validateAccountConfig(input.config);
    if (invalid) return fail(invalid);
    const all = await this._accounts.list();
    const old = id ? all.find((a) => a.id === id) : undefined;
    if (id && !old) return { status: 'NOT_FOUND' };
    if (old && old.config.venue !== input.config.venue)
      return fail('VENUE_IMMUTABLE: không đổi được nền tảng của tài khoản');
    if (
      all.some(
        (a) =>
          a.id !== id &&
          a.config.venue === input.config.venue &&
          a.label.toLowerCase() === label.toLowerCase(),
      )
    )
      return fail(`ACCOUNT_LABEL_TAKEN: đã có tài khoản "${label}"`);

    let secretCipher = old?.secretCipher ?? null;
    const accountConfig = input.config;
    if (
      accountConfig.venue === 'csgoempire' &&
      all.some(
        (a) =>
          a.id !== id &&
          a.config.venue === 'csgoempire' &&
          a.config.browserProfile === accountConfig.browserProfile,
      )
    )
      return fail(
        'BROWSER_PROFILE_TAKEN: hồ sơ trình duyệt đã thuộc tài khoản khác',
      );
    // Hai bản ghi trỏ vào CÙNG một ví thật → tiền bị tính hai lần, hạn mức tách đôi: chặn.
    if (accountConfig.venue === 'polymarket') {
      const own = (c: {
        walletAddress: string;
        funderAddress: string | null;
      }) =>
        [c.walletAddress, c.funderAddress]
          .filter((v): v is string => !!v)
          .map((v) => v.toLowerCase());
      const mine = own(accountConfig);
      const clash = all.find(
        (a) =>
          a.id !== id &&
          a.config.venue === 'polymarket' &&
          own(a.config).some((v) => mine.includes(v)),
      );
      if (clash)
        return fail(`WALLET_TAKEN: ví này đã thuộc tài khoản "${clash.label}"`);
    }
    const rawKey = input.privateKey?.trim();
    if (
      input.loginUsername !== undefined ||
      input.loginPassword !== undefined
    ) {
      if (input.config.venue !== 'csgoempire') return fail('LOGIN_NOT_ALLOWED');
      const username = input.loginUsername?.trim();
      const password = input.loginPassword;
      if (
        !username ||
        !password ||
        username.length > 200 ||
        password.length > 500
      )
        return fail(
          'LOGIN_CREDENTIALS_REQUIRED: nhập cả tài khoản và mật khẩu',
        );
      if (!this._cipher.available())
        return fail('SECRET_KEY_MISSING: chưa đặt TRADING_SECRET_KEY');
      // Cùng một tài khoản csgoempire thật ở hai hồ sơ → hai phiên đặt cược trên một số dư: chặn.
      const clash = all.find(
        (a) =>
          a.id !== id &&
          a.config.venue === 'csgoempire' &&
          this._loginOf(a) === username.toLowerCase(),
      );
      if (clash)
        return fail(
          `LOGIN_TAKEN: tài khoản đăng nhập này đã dùng ở "${clash.label}"`,
        );
      secretCipher = this._cipher.encrypt(
        JSON.stringify({ username, password }),
      );
    }
    if (rawKey) {
      if (input.config.venue !== 'polymarket')
        return fail('SECRET_NOT_ALLOWED: chỉ ví polymarket lưu private key');
      const key = normalizePrivateKey(rawKey);
      if (!key) return fail('PRIVATE_KEY_INVALID: 64 ký tự hex (có/không 0x)');
      if (!this._cipher.available())
        return fail(
          'SECRET_KEY_MISSING: chưa đặt TRADING_SECRET_KEY trong .env nên không lưu được private key',
        );
      secretCipher = this._cipher.encrypt(key);
    }

    let config = input.config;
    if (config.venue === 'polymarket') {
      // Relayer API Key: mã hóa như private key; bỏ trống = giữ key cũ
      const oldCipher =
        old?.config.venue === 'polymarket'
          ? (old.config.relayerApiKeyCipher ?? null)
          : null;
      let relayerApiKeyCipher = oldCipher;
      const rawRelayer = input.relayerApiKey?.trim();
      if (rawRelayer) {
        if (rawRelayer.length > 500) return fail('RELAYER_KEY_INVALID');
        if (!this._cipher.available())
          return fail(
            'SECRET_KEY_MISSING: chưa đặt TRADING_SECRET_KEY nên không lưu được Relayer API Key',
          );
        relayerApiKeyCipher = this._cipher.encrypt(rawRelayer);
      }
      config = { ...config, relayerApiKeyCipher };
    }
    const account: TradingAccount = {
      id: id ?? randomUUID(),
      label,
      enabled: input.enabled,
      config,
      secretCipher,
    };
    await this._accounts.save(account);
    await this._sync.pushAll();
    return {
      status: 'SUCEED',
      data: this._view(account, await this._profiles.list()),
    };
  }

  /** Email/username csgoempire đã lưu (chữ thường); null = chưa có / không giải mã được. */
  private _loginOf(a: TradingAccount): string | null {
    if (!a.secretCipher || !this._cipher.available()) return null;
    try {
      const v = JSON.parse(this._cipher.decrypt(a.secretCipher)) as {
        username?: unknown;
      };
      return typeof v.username === 'string'
        ? v.username.trim().toLowerCase()
        : null;
    } catch {
      return null;
    }
  }

  async deleteAccount(id: string): Promise<OperationStatus<true>> {
    const users = (await this._profiles.list()).filter(
      (p) => p.csgoempireAccountId === id || p.polymarketAccountId === id,
    );
    if (users.length)
      return fail(
        `ACCOUNT_IN_USE: đang dùng ở profile ${users.map((p) => `"${p.name}"`).join(', ')}`,
      );
    if (!(await this._accounts.delete(id))) return { status: 'NOT_FOUND' };
    return { status: 'SUCEED', data: true };
  }

  // ------------------------------------------------------------- profile

  listProfiles(): Promise<TraderProfile[]> {
    return this._profiles.list();
  }

  async getProfile(id: string): Promise<OperationStatus<TraderProfile>> {
    const p = await this._profiles.get(id);
    return p ? { status: 'SUCEED', data: p } : { status: 'NOT_FOUND' };
  }

  async saveProfile(
    id: string | null,
    input: ProfileInput,
  ): Promise<OperationStatus<TraderProfile>> {
    const profile: TraderProfile = {
      id: id ?? randomUUID(),
      ...input,
      name: input.name.trim(),
    };
    const invalid = validateTraderProfile(profile);
    if (invalid) return fail(invalid);
    const [all, accounts] = await Promise.all([
      this._profiles.list(),
      this._accounts.list(),
    ]);
    if (id && !all.some((p) => p.id === id)) return { status: 'NOT_FOUND' };
    if (
      all.some(
        (p) =>
          p.id !== profile.id &&
          p.name.toLowerCase() === profile.name.toLowerCase(),
      )
    )
      return fail(`PROFILE_NAME_TAKEN: đã có profile "${profile.name}"`);
    const venueOf = (accId: string) =>
      accounts.find((a) => a.id === accId)?.config.venue;
    if (venueOf(profile.csgoempireAccountId) !== 'csgoempire')
      return fail('CSGOEMPIRE_ACCOUNT_INVALID: chọn một tài khoản csgoempire');
    if (venueOf(profile.polymarketAccountId) !== 'polymarket')
      return fail('POLYMARKET_ACCOUNT_INVALID: chọn một tài khoản polymarket');
    const tiers = new Set((await this._tiers.listTiers()).map((t) => t.id));
    // hạng đã bị xóa ở module odds: bỏ ghi đè / lựa chọn mồ côi thay vì báo lỗi
    const plan = profile.stakePlan;
    const clean: TraderProfile = {
      ...profile,
      risk: {
        ...profile.risk,
        markets:
          profile.risk.markets === null
            ? null
            : [...new Set(profile.risk.markets)],
      },
      stakePlan: {
        ...plan,
        overrides: Object.fromEntries(
          Object.entries(plan.overrides).filter(([t]) => tiers.has(t)),
        ),
        tierIds:
          plan.tierIds === null
            ? null
            : [...new Set(plan.tierIds)].filter((t) => tiers.has(t)),
      },
    };
    await this._profiles.save(clean);
    await this._sync.pushAll();
    return { status: 'SUCEED', data: clean };
  }

  /**
   * Buộc task trader đang chạy của profile xét lại mọi kèo còn sống (bỏ dấu "đã xử lý"), không xóa lệnh.
   * Số lệnh mỗi hạng / hạn mức trận vẫn giữ nên không vào trùng. Trả số task đã nhận lệnh.
   */
  async reevaluateProfile(
    id: string,
  ): Promise<OperationStatus<{ tasks: number }>> {
    if (!(await this._profiles.get(id))) return { status: 'NOT_FOUND' };
    return {
      status: 'SUCEED',
      data: { tasks: await this._sync.resetSeen(id) },
    };
  }

  async deleteProfile(id: string): Promise<OperationStatus<true>> {
    if (!(await this._profiles.delete(id))) return { status: 'NOT_FOUND' };
    await this._sync.pushAll();
    return { status: 'SUCEED', data: true };
  }

  /** Cấu hình worker sẽ nhận cho profile (xem trước / gỡ lỗi). */
  runtimeConfig(profileId: string): Promise<TraderRuntimeConfig> {
    return this._sync.configFor(profileId);
  }

  // ------------------------------------------------------------- bảng vốn

  async previewStakeTable(
    plan: StakePlan,
  ): Promise<OperationStatus<StakePreview>> {
    const invalid = validateStakePlan(plan);
    if (invalid) return fail(`STAKE_PLAN_INVALID: ${invalid}`);
    const tiers = sortTiers(await this._tiers.listTiers());
    return {
      status: 'SUCEED',
      data: { tiers, rows: resolveStakeTable(plan, tiers) },
    };
  }

  // ------------------------------------------------------------- cấu hình chung

  getSettings(): Promise<TradingSettings> {
    return this._settings.get();
  }

  async saveSettings(
    s: TradingSettings,
  ): Promise<OperationStatus<TradingSettings>> {
    const invalid = validateTradingSettings(s);
    if (invalid) return fail(invalid);
    await this._settings.save(s);
    await this._sync.pushAll();
    return { status: 'SUCEED', data: s };
  }

  secretKeyConfigured(): boolean {
    return this._cipher.available();
  }

  // ------------------------------------------------------------- lệnh

  listTrades(q: TradeAttemptQuery): Promise<TradeAttempt[]> {
    return this._trades.list(q);
  }

  async getTrade(id: string): Promise<OperationStatus<TradeAttempt>> {
    const t = await this._trades.get(id);
    return t ? { status: 'SUCEED', data: t } : { status: 'NOT_FOUND' };
  }

  tradeStats(q: TradeStatsQuery): Promise<TradeStats> {
    return this._trades.stats(q);
  }

  /**
   * Xóa lệnh theo trạng thái (kết hợp nhiều trạng thái), theo profile/thời điểm, hoặc toàn bộ.
   * Bắt buộc chọn rõ trạng thái hoặc all = true để không lỡ tay xóa sạch.
   * Lưu ý: không trả lại hạn mức theo trận đã giữ trong sổ phơi nhiễm (tự hết hạn theo TTL).
   */
  async purgeTrades(
    input: TradePurgeInput,
  ): Promise<OperationStatus<TradePurgeResult>> {
    const statuses = [...new Set(input.statuses ?? [])];
    if (input.all && statuses.length)
      return fail(
        'TRADE_PURGE_SCOPE_CONFLICT: chọn statuses hoặc all, không chọn cả hai',
      );
    if (!input.all && !statuses.length)
      return fail(
        'TRADE_PURGE_SCOPE_REQUIRED: chọn ít nhất một trạng thái hoặc all = true',
      );
    const filter: TradePurgeFilter = {
      ...(statuses.length ? { statuses } : {}),
      ...(input.profileId ? { profileId: input.profileId } : {}),
      ...(input.before ? { before: input.before } : {}),
    };
    const matched = await this._trades.count(filter);
    if (input.dryRun || !matched)
      return { status: 'SUCEED', data: { matched, deleted: 0 } };
    const deleted = await this._trades.purge(filter);
    // xóa TOÀN BỘ (mọi trạng thái, không giới hạn thời điểm) → trader quên dấu "đã xử lý"
    // để xét lại kèo còn sống; số lệnh mỗi hạng / hạn mức trận vẫn giữ nên không vào trùng
    if (input.all && !input.before) {
      const resetTasks = await this._sync.resetSeen(input.profileId);
      return { status: 'SUCEED', data: { matched, deleted, resetTasks } };
    }
    return { status: 'SUCEED', data: { matched, deleted } };
  }

  async deleteTrade(id: string): Promise<OperationStatus<true>> {
    return (await this._trades.delete(id))
      ? { status: 'SUCEED', data: true }
      : { status: 'NOT_FOUND' };
  }

  private _view(
    a: TradingAccount,
    profiles: readonly TraderProfile[],
  ): TradingAccountView {
    return {
      id: a.id,
      venue: a.config.venue,
      label: a.label,
      enabled: a.enabled,
      // bỏ bí mật mã hóa khỏi cấu hình trả web
      config:
        a.config.venue === 'polymarket'
          ? (({ relayerApiKeyCipher: _c, ...rest }) => rest)(a.config)
          : a.config,
      hasSecret: a.secretCipher !== null,
      hasRelayerKey:
        a.config.venue === 'polymarket' && !!a.config.relayerApiKeyCipher,
      usedBy: profiles
        .filter(
          (p) =>
            p.csgoempireAccountId === a.id || p.polymarketAccountId === a.id,
        )
        .map((p) => p.name),
    };
  }
}
