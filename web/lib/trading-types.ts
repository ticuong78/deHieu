/** Kiểu dữ liệu của module auto trade (backend /trading/*). */
import type { SignalTier } from './types';

export type TradingVenue = 'csgoempire' | 'polymarket';

export type TradingAccountConfig =
  | {
      venue: 'csgoempire';
      browserProfile: string;
      /** Địa chỉ nạp USDT Polygon csgoempire đã xác nhận (tự chuyển Polymarket → csgoempire). */
      usdtDepositAddress?: string | null;
    }
  | {
      venue: 'polymarket';
      walletAddress: string;
      funderAddress: string | null;
      /** Địa chỉ nạp USDT Polygon ở trang Deposit của Polymarket (tự rút csgoempire → Polymarket). */
      usdtDepositAddress?: string | null;
    };

export interface TradingAccountView {
  id: string;
  venue: TradingVenue;
  label: string;
  enabled: boolean;
  config: TradingAccountConfig;
  /** Đã lưu private key (mã hóa) hay chưa. Key không bao giờ được trả về. */
  hasSecret: boolean;
  usedBy: string[];
}

/** Tài khoản thật + Cash đọc trực tiếp từ sàn (POST trading/accounts/:id/check). */
export interface TradingAccountCheck {
  accountId: string;
  venue: TradingVenue;
  label: string;
  /** csgoempire: user id; polymarket: ví ký lệnh. */
  remoteId: string | null;
  /** csgoempire: tên Steam / username trên sàn. */
  remoteName: string | null;
  /** polymarket: ví giữ tiền. */
  wallet: string | null;
  cash: number;
  allowance: number | null;
  /** polymarket: giá trị vị thế đang mở; Portfolio = cash + positions. null = không áp dụng. */
  positions: number | null;
  /** Lý do tài khoản đang bị khóa vào lệnh; null = không khóa. */
  halted: string | null;
  /** Khớp cấu hình đã lưu (email/username csgoempire; key ↔ ví Polymarket). null = không so được. */
  matchesConfig: boolean | null;
  checkedAt: number;
}

/** Tài khoản thật sàn trả về lúc vào lệnh. */
export interface VenueAccountIdentity {
  id: string | null;
  name: string | null;
  wallet: string | null;
}

export type StakeTrend = 'flat' | 'up' | 'down' | 'custom';

export interface TierStakeOverride {
  stake?: number;
  minStake?: number;
  maxStake?: number;
  /** Số lệnh tối đa mỗi cửa ở hạng này (ghi đè mặc định của profile); 0 = không giới hạn. */
  maxEntries?: number;
  /** Lãi tối thiểu mỗi ngày khóa vốn ở hạng này (tỉ lệ, ghi đè profile); 0 = tắt cho hạng này. */
  minDailyMargin?: number;
}

export interface StakePlan {
  trend: StakeTrend;
  baseStake: number;
  stepPct: number;
  minStakeRatio: number;
  maxStakeRatio: number;
  scaleWithinTier: boolean;
  overrides: Record<string, TierStakeOverride>;
  /** Hạng profile được vào. [] = chưa chọn (profile đứng yên); null = mọi hạng (profile cũ). */
  tierIds: string[] | null;
}

export const DEFAULT_STAKE_PLAN: StakePlan = {
  trend: 'flat',
  baseStake: 50,
  stepPct: 0.5,
  minStakeRatio: 0.5,
  maxStakeRatio: 1,
  scaleWithinTier: false,
  overrides: {},
  // profile mới: chưa chọn hạng nào, người tạo tự chọn
  tierIds: [],
};

export interface StakeRow {
  tierId: string;
  tierName: string;
  minMargin: number;
  maxMargin: number | null;
  stake: number;
  minStake: number;
  maxStake: number;
  scaleWithinTier: boolean;
  /** false = profile không vào hạng này. */
  enabled?: boolean;
  /** Số lệnh mỗi cửa riêng của hạng; null = theo mặc định profile. */
  maxEntries?: number | null;
  /** Lãi tối thiểu mỗi ngày riêng của hạng; null = theo profile. */
  minDailyMargin?: number | null;
}

export interface StakePreview {
  tiers: SignalTier[];
  rows: StakeRow[];
}

export interface RiskLimits {
  minNetMargin: number;
  matchCapUsd: number;
  maxSignalAgeMs: number;
  /** Số lệnh tối đa cho một cửa ở mỗi hạng kèo (mỗi hạng tính riêng); 0 = không giới hạn. */
  maxEntriesPerTier: number;
  /** Lý do hủy kèo mà trader vẫn vào tiếp lệnh đang tính. */
  ignoreCancelReasons: string[];
  /** Market được vào (vd 'game-winner'). null = mọi market; [] = chưa chọn (profile đứng yên). */
  markets: string[] | null;
  /** Giá bán thấp nhất Polymarket ≥ ngưỡng này → bot không tự vào, chuyển sang On click chờ người vào. 0 = tắt. */
  oneClickMinPrice: number;
  /** Margin kèo / lãi ròng vượt số này (vd 0.15) → nghi giá cũ, bỏ qua (cả vào tay). 0 = tắt. */
  maxNetMargin: number;
  /** Lãi tối thiểu mỗi ngày khóa vốn (margin ÷ số ngày tới khi trận có kết quả, vd 0.01 = 1%/ngày). 0 = tắt. */
  minDailyMargin: number;
}

export const DEFAULT_RISK: RiskLimits = {
  minNetMargin: 0.01,
  matchCapUsd: 0,
  maxSignalAgeMs: 3_000,
  maxEntriesPerTier: 1,
  ignoreCancelReasons: ['better_opportunity'],
  markets: null,
  oneClickMinPrice: 0.5,
  maxNetMargin: 0.15,
  minDailyMargin: 0,
};

/** Kết quả của kèo On click (lọc lịch sử). */
export type OneClickOutcome =
  'open' | 'manual' | 'cancelled' | 'expired' | 'auto' | 'other';

/** GET /trading/oneclick/history — mỗi profile × kèo một dòng. */
export interface OneClickHistoryEntry {
  profileId: string;
  signalId: string;
  room: string;
  sport: string;
  market: string;
  phase: string;
  comboId: string;
  teams: [string, string];
  signalMargin: number;
  tierName: string | null;
  minAsk: number | null;
  threshold: number | null;
  analysis: TradeAttempt;
  updates: number;
  firstAt: number;
  lastAt: number;
  expiresAt: number;
  endedAt: number | null;
  /** manual:<kết quả> | cancelled:<lý do hủy> | expired | result:<kết quả> | app_restart */
  endReason: string | null;
  enteredBy: string | null;
}

/** GET /trading/oneclick?profileId= — kèo chờ người vào lệnh. */
export interface OneClickCandidate {
  profileId: string;
  signalId: string;
  expiresAt: number;
  /** Lúc trader gửi bản phân tích này (ms). */
  updatedAt: number;
  /** "Nếu vào bây giờ": phân tích như lệnh bot (status paper_filled = dự kiến, reason ONE_CLICK). */
  analysis: TradeAttempt;
}

export interface TraderProfile {
  id: string;
  name: string;
  enabled: boolean;
  mode: 'paper' | 'live';
  csgoempireAccountId: string;
  polymarketAccountId: string;
  stakePlan: StakePlan;
  strategy: { id: string; params: Record<string, unknown> };
  risk: RiskLimits;
}

export interface TraderRuntimeConfig {
  profileId: string;
  active: boolean;
  inactiveReason: string | null;
  stakeTable: StakeRow[];
  matchExposureCapUsd: number;
}

export type RebalanceMode = 'off' | 'dry_run' | 'live';

/** Tự chuyển tiền cân bằng 35/65 giữa csgoempire và Polymarket. */
export interface RebalanceSettings {
  mode: RebalanceMode;
  maxPerTransferUsd: number;
  maxPerDayUsd: number;
  minTransferUsd: number;
}

export interface TradingSettings {
  matchExposureCapUsd: number;
  /** Bản backend cũ không có. */
  rebalance?: RebalanceSettings;
  secretKeyConfigured: boolean;
}

export type TradeStatus =
  'paper_filled' | 'filled' | 'partial' | 'skipped' | 'cancelled' | 'error';

export interface TradeLeg {
  tenant: string;
  side: number;
  pick: string;
  odds: number;
  /** Trang trận trên sàn. */
  url?: string | null;
  /** Giờ bắt đầu trận theo sàn này lúc kèo phát (ms). */
  startsAt?: number | null;
  /** Trận thứ `no` / `of` trận trong giải `name` theo sàn này (trong các trận sàn đang liệt kê). */
  tournament?: { name: string | null; no: number; of: number } | null;
}

/** Một mức giá của sổ lệnh Polymarket lúc quyết định. */
export interface DepthLevel {
  price: number;
  size: number;
  usd: number;
  netMargin: number;
  ok: boolean;
}

/** Phần `detail` worker ghi (các trường có thể thiếu tùy kết quả). */
export interface TradeDetail {
  cash?: {
    venue: string;
    available: number;
    required: number;
    /** Tài khoản thật đọc từ sàn ngay trước khi gửi lệnh. */
    account?: VenueAccountIdentity;
  }[];
  /** Tài khoản trong cấu hình profile lúc vào lệnh. */
  accounts?: {
    csgoempire: { id: string; label: string } | null;
    polymarket: { id: string; label: string } | null;
  };
  submitted?: boolean;
  feeEstimated?: boolean;
  /** Lệnh thật: mốc thời gian (ms). Polymarket gửi trước, BetBy chỉ gửi khi Polymarket khớp đủ. */
  execution?: {
    prepareMs: number | null;
    /** Tuổi kèo khi lệnh Polymarket rời app. */
    fireAgeMs: number | null;
    polymarketMs: number | null;
    csgoempireMs: number | null;
    gapMs: number | null;
    /** Chuẩn bị từng sàn (song song): tổng + từng bước (ms). */
    prepare?: Record<string, { totalMs: number; steps: Record<string, number> }> | null;
  };
  signalAgeMs?: number;
  targetStake?: number | null;
  bestAsk?: number | null;
  budget?: number | null;
  fee?: { enabled: boolean; rate: number; exponent: number };
  limitedBy?: 'stake' | 'depth' | 'budget';
  levels?: { price: number; shares: number; fee: number }[];
  depth?: {
    levels: DepthLevel[];
    maxPrice: number | null;
    sharesAtEdge: number;
    usdAtEdge: number;
    targetShares: number;
    maxStakeAtEdge: number;
  };
  sizing?: {
    targetStake: number;
    minStake: number;
    minShares: number;
    minNetMargin: number;
  };
  cancelledAfterMs?: number;
  bookAt?: number | null;
  /** Kèo bị hủy khi trader đang tính. ignored = lý do được bỏ qua nên vẫn vào tiếp. */
  cancel?: {
    reason: string;
    ignored: boolean;
    detail: import('./types').SignalCloseDetail | null;
  };
  /** Người vào lệnh tay ở On click (không phải bot). */
  manual?: { by: string };
  /** Kèo chuyển On click: giá bán thấp nhất lúc đó và ngưỡng của profile. */
  minAsk?: number;
  oneClickMinPrice?: number;
}

export interface TradeAttempt {
  id: string;
  profileId: string;
  mode: string;
  signalId: string;
  room: string;
  sport: string;
  market: string;
  teams: [string, string];
  phase: string;
  comboId: string;
  status: TradeStatus;
  reason: string | null;
  signalMargin: number;
  tierName: string | null;
  book: (TradeLeg & { stake: number }) | null;
  polymarket:
    | (TradeLeg & {
        tokenId: string;
        shares: number;
        avgPrice: number;
        fee: number;
        cost: number;
      })
    | null;
  totalCost: number;
  payout: number;
  profit: number;
  netMargin: number;
  latencyMs: number;
  detail: Record<string, unknown>;
  createdAt: number;
  csgoempireAccountId: string | null;
  polymarketAccountId: string | null;
  /** Mốc thời gian (ms epoch): kèo phát → worker nhận → đọc xong sổ lệnh → quyết định. */
  timing: {
    signalIssuedAt: number;
    receivedAt: number;
    marketDataAt: number | null;
    decidedAt: number;
  } | null;
  legs: TradeLegRecord[];
}

/** Một chân lệnh. Giấy: status = simulated. */
export interface TradeLegRecord {
  venue: string;
  accountId: string | null;
  side: number;
  pick: string;
  signalPrice: number;
  requestedPrice: number;
  requestedAmount: number;
  filledAmount: number;
  avgPrice: number;
  fee: number;
  cost: number;
  status: string;
  marketRef: string | null;
  orderRef: string | null;
  sentAt: number | null;
  ackedAt: number | null;
  filledAt: number | null;
  error: string | null;
}

export interface TradeStats {
  attempts: number;
  filled: number;
  skipped: number;
  cancelled: number;
  errors: number;
  totalCost: number;
  profit: number;
  skipReasons: Record<string, number>;
}

/** Kind task trader (danh mục task backend). */
export const TRADER_KIND = 'trader.arbitrage';

// ===================== Sổ phơi nhiễm thật (Redis) — GET /trading/exposure =====================

export interface ExposureMatchView {
  /** `cs2:a~b`. */
  match: string;
  usedUsd: number;
  /** Giới hạn chung; 0 = tắt. */
  capUsd: number;
  ttlMs: number | null;
  profiles: {
    profileId: string;
    profileName: string | null;
    usedUsd: number;
    capUsd: number;
    ttlMs: number | null;
  }[];
}

export interface ExposureEntryView {
  profileId: string;
  profileName: string | null;
  room: string;
  comboId: string;
  tierId: string;
  tierName: string | null;
  count: number;
  max: number | null;
  ttlMs: number | null;
}

export interface ExposureView {
  available: boolean;
  error: string | null;
  matches: ExposureMatchView[];
  entries: ExposureEntryView[];
}

/** Báo cáo tài khoản (GET trading/accounts/:id/report). */
export type ReportMode = 'live' | 'shadow' | 'paper';
export type ReportPeriod = 'day' | 'week' | 'month' | 'quarter' | 'year';
export type SettleWinner = 'polymarket' | 'csgoempire' | 'void';

export interface ReportBucket {
  key: string;
  trades: number;
  settled: number;
  staked: number;
  legPnl: number;
  pairPnl: number;
  expected: number;
  legWins: number;
  legLosses: number;
}

export interface ReportLeg {
  venue: TradingVenue;
  pick: string;
  amount: number;
  price: number;
  cost: number;
  result: 'won' | 'lost' | 'void' | null;
  pnl: number | null;
}

export interface ReportTrade {
  id: string;
  createdAt: number;
  mode: string;
  status: string;
  profileId: string;
  room: string;
  market: string;
  teams: [string, string];
  leg: ReportLeg;
  other: ReportLeg;
  expected: number;
  pairPnl: number | null;
  settlement: {
    winner: SettleWinner;
    source: 'polymarket' | 'manual';
    by: string | null;
    resolvedAt: number;
    polyPrice: number;
  } | null;
  pairedWith: string | null;
}

export interface ModeSummary {
  trades: number;
  settled: number;
  staked: number;
  totalCost: number;
  expected: number;
  legPnl: number;
  pairPnl: number;
}

export interface AccountReport {
  accountId: string;
  venue: TradingVenue;
  label: string;
  timeZone: string;
  modes: ReportMode[];
  generatedAt: number;
  truncated: boolean;
  totals: ModeSummary & {
    legWins: number;
    legLosses: number;
    legVoids: number;
    bestLeg: number | null;
    worstLeg: number | null;
  };
  series: Record<ReportPeriod, ReportBucket[]>;
  compare: {
    byMode: Record<ReportMode, ModeSummary>;
    paired: {
      count: number;
      liveExpected: number;
      shadowExpected: number;
      bothSettled: number;
      livePnl: number;
      shadowPnl: number;
      shadowOnly: number;
    };
  };
  trades: ReportTrade[];
}

/** Kế hoạch chuyển tiền giữa hai tài khoản của profile (tỉ lệ csgoempire / Polymarket). */
export interface RebalancePlan {
  empireShare: number;
  totalUsd: number;
  current: { csgoempire: number; polymarket: number };
  target: { csgoempire: number; polymarket: number };
  currentEmpireShare: number;
  from: 'csgoempire' | 'polymarket';
  to: 'csgoempire' | 'polymarket';
  amountUsd: number;
}

/** Đề xuất cân bằng tiền khi lệnh thật bị hủy vì thiếu Cash. */
export interface RebalanceSuggestion {
  profileId: string;
  profileName: string;
  csgoempireAccountId: string | null;
  polymarketAccountId: string | null;
  tradeId: string;
  teams: [string, string];
  firstAt: number;
  updatedAt: number;
  triggers: number;
  balances: { csgoempire: number; polymarket: number };
  shortages: { venue: 'csgoempire' | 'polymarket'; available: number; required: number }[];
  plan: RebalancePlan | null;
  helpsShortage: boolean;
  /** transfer = chuyển vào thêm được lệnh; insufficient = tổng < một lệnh nhỏ nhất; none = chuyển không vào thêm lệnh; ratio = chỉ theo tỉ lệ. */
  verdict?: 'transfer' | 'insufficient' | 'none' | 'ratio';
  /** Tổng tối thiểu cho một lệnh nhỏ nhất (verdict = insufficient). */
  needUsd?: number | null;
  summary: string;
}

export interface RebalanceView {
  empireShare: number;
  suggestions: RebalanceSuggestion[];
}

export type TransferState =
  | 'dry_run'
  | 'skipped'
  | 'planned'
  | 'submitted'
  | 'sent'
  | 'completed'
  | 'failed'
  | 'unconfirmed'
  | 'unknown';

/** Một lượt tự chuyển tiền. */
export interface RebalanceTransfer {
  id: string;
  profileId: string;
  profileName: string;
  trigger: 'auto' | 'manual';
  mode: 'dry_run' | 'live';
  from: 'csgoempire' | 'polymarket' | null;
  to: 'csgoempire' | 'polymarket' | null;
  amountUsd: number;
  destination: string | null;
  balances: { csgoempire: number; polymarket: number } | null;
  state: TransferState;
  reason: string | null;
  ref: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RebalanceTransfersView {
  transfers: RebalanceTransfer[];
  /** profileId → lý do tự chuyển đang bị chặn. */
  blocked: Record<string, string>;
}
