/** Chế độ tự chuyển tiền cân bằng: tắt / chạy thử (chỉ ghi "sẽ chuyển") / chuyển thật. */
export const REBALANCE_MODES = ['off', 'dry_run', 'live'] as const;
export type RebalanceMode = (typeof REBALANCE_MODES)[number];

/** Tự chuyển tiền giữa csgoempire và Polymarket của một profile khi lệnh hủy vì hết tiền. */
export interface RebalanceSettings {
  readonly mode: RebalanceMode;
  /** Tối đa mỗi lần chuyển (USD). */
  readonly maxPerTransferUsd: number;
  /** Tối đa mỗi ngày (USD, mỗi profile, theo ngày UTC). */
  readonly maxPerDayUsd: number;
  /** Chênh lệch dưới số này thì không chuyển (phí + tối thiểu của sàn). */
  readonly minTransferUsd: number;
}

/** Cấu hình chung của auto trade (mọi profile). */
export interface TradingSettings {
  /**
   * Tổng tiền tối đa (USD, cả hai chân) vào MỘT trận, cộng dồn MỌI tài khoản/profile.
   * Mặc định bật; 0 = tắt giới hạn.
   */
  readonly matchExposureCapUsd: number;
  readonly rebalance: RebalanceSettings;
}

export const DEFAULT_REBALANCE_SETTINGS: RebalanceSettings = {
  // mặc định TẮT: người vận hành bật chạy thử trước, xem ổn rồi mới chuyển thật
  mode: 'off',
  maxPerTransferUsd: 100,
  maxPerDayUsd: 300,
  minTransferUsd: 5,
};

export const DEFAULT_TRADING_SETTINGS: TradingSettings = {
  matchExposureCapUsd: 500,
  rebalance: DEFAULT_REBALANCE_SETTINGS,
};

export function validateTradingSettings(s: TradingSettings): string | null {
  if (!(s.matchExposureCapUsd >= 0))
    return 'matchExposureCapUsd phải ≥ 0 (0 = tắt)';
  const r = s.rebalance;
  if (!REBALANCE_MODES.includes(r.mode)) return 'rebalance.mode không hợp lệ';
  if (!(r.minTransferUsd >= 1)) return 'rebalance.minTransferUsd phải ≥ 1';
  if (!(r.maxPerTransferUsd >= r.minTransferUsd))
    return 'rebalance.maxPerTransferUsd phải ≥ minTransferUsd';
  if (!(r.maxPerDayUsd >= r.maxPerTransferUsd))
    return 'rebalance.maxPerDayUsd phải ≥ maxPerTransferUsd';
  return null;
}
