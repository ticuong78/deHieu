import type { StakeRow } from '../../../shared/domain/stake-table.js';
import { resolveStakeTable, type StakeTier } from '../domain/stake-plan.js';
import type { TradingAccount } from '../domain/trading-account.js';
import type {
  RiskLimits,
  StrategyRef,
  TraderMode,
  TraderProfile,
} from '../domain/trader-profile.js';
import type { TradingSettings } from '../domain/trading-settings.js';
import type { LiveTradingConfig } from '../../../shared/application/live-trading.js';

export const TRADER_CONFIG_VERSION = 1 as const;

/**
 * Cấu hình ĐÃ TÍNH SẴN gửi cho task trader (lệnh 'config'). Worker không đọc database, không biết
 * kế hoạch vốn: chỉ áp bảng vốn + giới hạn này. `active = false` → worker vẫn nhận kèo nhưng bỏ qua
 * (ghi lý do), để admin thấy vì sao trader đứng yên.
 */
export interface TraderRuntimeConfig {
  readonly execution?: LiveTradingConfig;
  readonly v: typeof TRADER_CONFIG_VERSION;
  readonly profileId: string;
  readonly profileName: string;
  readonly active: boolean;
  /** Lý do không hoạt động (profile tắt, tài khoản tắt/thiếu, chưa chọn hạng, chưa có hạng...). */
  readonly inactiveReason: string | null;
  readonly mode: TraderMode;
  readonly accounts: {
    readonly csgoempire: { readonly id: string; readonly label: string } | null;
    readonly polymarket: { readonly id: string; readonly label: string } | null;
  };
  readonly stakeTable: readonly StakeRow[];
  readonly strategy: StrategyRef;
  readonly risk: RiskLimits;
  /** Giới hạn tổng theo trận cho MỌI tài khoản (USD); 0 = tắt. */
  readonly matchExposureCapUsd: number;
}

const ref = (a: TradingAccount | undefined) =>
  a ? { id: a.id, label: a.label } : null;

/** Hồ sơ không tồn tại → cấu hình rỗng (worker đứng yên, báo lý do). */
export function buildTraderConfig(input: {
  readonly profileId: string;
  readonly profile: TraderProfile | null;
  readonly accounts: readonly TradingAccount[];
  readonly tiers: readonly StakeTier[];
  readonly settings: TradingSettings;
}): TraderRuntimeConfig {
  const { profile: p, settings } = input;
  if (!p)
    return {
      v: TRADER_CONFIG_VERSION,
      profileId: input.profileId,
      profileName: input.profileId,
      active: false,
      inactiveReason: 'PROFILE_NOT_FOUND',
      mode: 'paper',
      accounts: { csgoempire: null, polymarket: null },
      stakeTable: [],
      strategy: { id: 'none', params: {} },
      risk: {
        minNetMargin: 1,
        matchCapUsd: 0,
        maxSignalAgeMs: 0,
        maxEntriesPerTier: 1,
        ignoreCancelReasons: [],
        markets: [],
        oneClickMinPrice: 0,
        maxNetMargin: 0,
        minDailyMargin: 0,
      },
      matchExposureCapUsd: settings.matchExposureCapUsd,
    };
  const book = input.accounts.find(
    (a) => a.id === p.csgoempireAccountId && a.config.venue === 'csgoempire',
  );
  const poly = input.accounts.find(
    (a) => a.id === p.polymarketAccountId && a.config.venue === 'polymarket',
  );
  const stakeTable = resolveStakeTable(p.stakePlan, input.tiers);
  const inactiveReason = !p.enabled
    ? 'PROFILE_DISABLED'
    : !book
      ? 'CSGOEMPIRE_ACCOUNT_MISSING'
      : !book.enabled
        ? 'CSGOEMPIRE_ACCOUNT_DISABLED'
        : !poly
          ? 'POLYMARKET_ACCOUNT_MISSING'
          : !poly.enabled
            ? 'POLYMARKET_ACCOUNT_DISABLED'
            : p.stakePlan.tierIds?.length === 0
              ? 'NO_TIER_SELECTED'
              : p.risk.markets?.length === 0
                ? 'NO_MARKET_SELECTED'
                : !stakeTable.some((r) => r.enabled !== false && r.stake > 0)
                  ? 'NO_STAKE_TIER'
                  : null;
  return {
    v: TRADER_CONFIG_VERSION,
    profileId: p.id,
    profileName: p.name,
    active: inactiveReason === null,
    inactiveReason,
    mode: p.mode,
    accounts: { csgoempire: ref(book), polymarket: ref(poly) },
    stakeTable,
    strategy: p.strategy,
    risk: p.risk,
    matchExposureCapUsd: settings.matchExposureCapUsd,
  };
}
