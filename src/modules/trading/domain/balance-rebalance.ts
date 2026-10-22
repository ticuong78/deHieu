/**
 * Cân bằng tiền giữa hai tài khoản của một profile: csgoempire giữ EMPIRE_SHARE (35%) tổng tiền,
 * Polymarket giữ phần còn lại (65%). Thuần, không I/O — chỉ TÍNH kế hoạch chuyển; việc chuyển do người làm
 * (csgoempire là số dư lưu ký của sàn, không phải ví on-chain app giữ key).
 */
import type { TradingVenue } from './trading-account.js';

/** Tỉ lệ tiền của csgoempire trong tổng hai tài khoản (Polymarket = 1 − số này). */
export const EMPIRE_SHARE = 0.35;
/** Chênh lệch nhỏ hơn số này (USD) thì coi như đã cân, không đề xuất chuyển. */
export const MIN_REBALANCE_USD = 1;

export interface VenueBalances {
  readonly csgoempire: number;
  readonly polymarket: number;
}

export interface RebalancePlan {
  readonly empireShare: number;
  readonly totalUsd: number;
  readonly current: VenueBalances;
  readonly target: VenueBalances;
  /** Tỉ lệ csgoempire hiện tại (0–1). */
  readonly currentEmpireShare: number;
  readonly from: TradingVenue;
  readonly to: TradingVenue;
  /** Số tiền cần chuyển (USD, làm tròn xuống tới cent). */
  readonly amountUsd: number;
}

const floor2 = (n: number) => Math.floor(n * 100 + 1e-9) / 100;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Kế hoạch chuyển để về đúng tỉ lệ. null = số dư không hợp lệ, tổng = 0, hoặc đã cân (lệch < minUsd).
 */
export function planRebalance(
  b: VenueBalances,
  empireShare = EMPIRE_SHARE,
  minUsd = MIN_REBALANCE_USD,
): RebalancePlan | null {
  const e = b.csgoempire;
  const p = b.polymarket;
  if (
    !Number.isFinite(e) ||
    !Number.isFinite(p) ||
    e < 0 ||
    p < 0 ||
    !(empireShare > 0 && empireShare < 1)
  )
    return null;
  const total = e + p;
  if (!(total > 0)) return null;
  const targetEmpire = total * empireShare;
  const diff = targetEmpire - e;
  const amountUsd = floor2(Math.abs(diff));
  if (amountUsd < minUsd) return null;
  return {
    empireShare,
    totalUsd: round2(total),
    current: { csgoempire: round2(e), polymarket: round2(p) },
    target: {
      csgoempire: round2(targetEmpire),
      polymarket: round2(total - targetEmpire),
    },
    currentEmpireShare: e / total,
    from: diff > 0 ? 'polymarket' : 'csgoempire',
    to: diff > 0 ? 'csgoempire' : 'polymarket',
    amountUsd,
  };
}

// ---------------------------------------------------------------------------------------------------
// Cân bằng theo LỆNH: tỉ lệ 35/65 là mục tiêu, nhưng chỉ chuyển khi việc chuyển làm vào được NHIỀU lệnh
// hơn (hoặc vào được lệnh đầu tiên); tổng hai bên không đủ cho một lệnh tối thiểu thì không chuyển.

/** Tiền một lệnh cần ở mỗi bên (USD): csgoempire = tiền cược, Polymarket = share × giá + phí. */
export interface TradeUnit {
  readonly csgoempire: number;
  readonly polymarket: number;
  /** Lệnh nhỏ nhất còn chấp nhận = tỉ lệ này × lệnh đầy đủ (Tối thiểu của hạng ÷ tiền mục tiêu), 0–1. */
  readonly minFraction: number;
}

/** Số lệnh (có phần lẻ) vào được với số dư này: bên hết trước quyết định. */
export function fundable(b: VenueBalances, u: TradeUnit): number {
  return Math.min(b.csgoempire / u.csgoempire, b.polymarket / u.polymarket);
}

/** Số dư sau khi chuyển `amount` từ `from` sang bên kia. */
export function afterTransfer(
  b: VenueBalances,
  from: TradingVenue,
  amount: number,
): VenueBalances {
  return from === 'polymarket'
    ? { csgoempire: b.csgoempire + amount, polymarket: b.polymarket - amount }
    : { csgoempire: b.csgoempire - amount, polymarket: b.polymarket + amount };
}

const EPS = 1e-9;
/**
 * Mức "vào được" để so sánh: số lệnh ĐẦY ĐỦ (phần nguyên); chưa đủ một lệnh đầy đủ thì 0 nếu vào được lệnh
 * tối thiểu (lệnh nhỏ hơn mục tiêu), −1 nếu không vào được lệnh nào.
 */
export function tradeLevel(b: VenueBalances, u: TradeUnit): number {
  const f = fundable(b, u);
  if (f + EPS >= 1) return Math.floor(f + EPS);
  return f + EPS >= u.minFraction ? 0 : -1;
}

/** Lệnh nhỏ hơn mục tiêu lớn thêm ít nhất chừng này (tỉ lệ của lệnh đầy đủ) mới đáng chuyển. */
export const PARTIAL_GAIN = 0.1;

/**
 * Chuyển có đáng không: vào được thêm lệnh đầy đủ / vào được lệnh đầu tiên; hoặc khi chưa đủ một lệnh
 * đầy đủ thì lệnh vào được lớn thêm ≥ PARTIAL_GAIN.
 */
export function improves(
  before: VenueBalances,
  after: VenueBalances,
  u: TradeUnit,
): boolean {
  const lb = tradeLevel(before, u);
  const la = tradeLevel(after, u);
  if (la !== lb) return la > lb;
  return (
    la === 0 && fundable(after, u) - fundable(before, u) + EPS >= PARTIAL_GAIN
  );
}

export type RebalanceDecision =
  | {
      readonly kind: 'transfer';
      readonly plan: RebalancePlan;
      /** Số lệnh đầy đủ vào được trước / sau (−1 = không vào được lệnh nào, 0 = chỉ lệnh nhỏ hơn mục tiêu). */
      readonly levelBefore: number;
      readonly levelAfter: number;
    }
  | {
      /** Tổng hai bên không đủ cho một lệnh tối thiểu: chuyển cũng vô ích → nạp thêm. */
      readonly kind: 'insufficient';
      readonly totalUsd: number;
      readonly needUsd: number;
    }
  | {
      /** Chuyển không vào thêm được lệnh nào (đã tối ưu / lệch không đáng kể). */
      readonly kind: 'none';
      readonly levelBefore: number;
    };

/**
 * Kế hoạch chuyển tối ưu số lệnh vào được, ưu tiên giữ gần tỉ lệ `empireShare`:
 * - tổng < một lệnh tối thiểu → `insufficient`, không chuyển;
 * - tổng < một lệnh đầy đủ → chia theo đúng tỉ lệ tiền lệnh cần ở hai bên (lệnh vào được LỚN nhất);
 * - còn lại: chia theo `empireShare`; nếu chia vậy vào được ít lệnh hơn mức tối đa có thể
 *   (floor(tổng ÷ tiền một lệnh)) thì dành đủ tiền cho chừng ấy lệnh ở mỗi bên, phần dư chia theo tỉ lệ;
 * - chỉ chuyển khi mức vào được TĂNG (xem tradeLevel); không thì `none`.
 */
export function planForTrades(
  b: VenueBalances,
  u: TradeUnit,
  empireShare = EMPIRE_SHARE,
): RebalanceDecision | null {
  const e = b.csgoempire;
  const p = b.polymarket;
  if (
    ![e, p, u.csgoempire, u.polymarket, u.minFraction].every(Number.isFinite) ||
    e < 0 ||
    p < 0 ||
    !(u.csgoempire > 0 && u.polymarket > 0) ||
    !(empireShare > 0 && empireShare < 1)
  )
    return null;
  const total = e + p;
  const unit = u.csgoempire + u.polymarket;
  const minFraction = Math.min(1, Math.max(0, u.minFraction));
  const need = unit * minFraction;
  if (total + EPS < need)
    return {
      kind: 'insufficient',
      totalUsd: round2(total),
      needUsd: round2(need),
    };

  let targetE: number;
  if (total < unit) targetE = (total * u.csgoempire) / unit;
  else {
    const byShare = total * empireShare;
    const k = Math.floor(total / unit + EPS);
    const shareLevel = Math.floor(
      fundable({ csgoempire: byShare, polymarket: total - byShare }, u) + EPS,
    );
    targetE =
      shareLevel >= k
        ? byShare
        : k * u.csgoempire + (total - k * unit) * empireShare;
  }
  const levelBefore = tradeLevel(b, u);
  const diff = targetE - e;
  // làm tròn LÊN tới cent cho bên nhận (đủ tiền lệnh), không quá số bên chuyển đang có
  const from: TradingVenue = diff > 0 ? 'polymarket' : 'csgoempire';
  const amountUsd = Math.min(
    Math.ceil(Math.abs(diff) * 100 - EPS) / 100,
    from === 'polymarket' ? floor2(p) : floor2(e),
  );
  const after = afterTransfer(b, from, amountUsd);
  const levelAfter = tradeLevel(after, u);
  if (!(amountUsd > 0) || !improves(b, after, u))
    return { kind: 'none', levelBefore };
  return {
    kind: 'transfer',
    levelBefore,
    levelAfter,
    plan: {
      empireShare,
      totalUsd: round2(total),
      current: { csgoempire: round2(e), polymarket: round2(p) },
      target: {
        csgoempire: round2(after.csgoempire),
        polymarket: round2(after.polymarket),
      },
      currentEmpireShare: total > 0 ? e / total : 0,
      from,
      to: from === 'polymarket' ? 'csgoempire' : 'polymarket',
      amountUsd,
    },
  };
}
