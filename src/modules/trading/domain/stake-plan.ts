/**
 * Kế hoạch vốn của auto trade, dựa trên hạng kèo do admin đặt (dùng chung với kênh thông báo).
 *
 * - Mỗi hạng có số tiền vào lệnh + mức tối thiểu/tối đa.
 * - Tiền giữa các hạng theo một XU HƯỚNG: ngang / lên / xuống (theo bước %) hoặc tùy chỉnh từng hạng.
 * - Tùy chọn tăng dần TRONG một hạng: margin càng gần cận trên của hạng thì tiền càng gần mức tối đa.
 *
 * Thuần (không I/O). Bảng kết quả (StakeRow) là ngôn ngữ chung với worker trader (shared/domain/stake-table).
 */
import { round2, type StakeRow } from '../../../shared/domain/stake-table.js';

export {
  targetStake,
  type StakeRow,
} from '../../../shared/domain/stake-table.js';

/** Hạng kèo (cùng dạng với hạng của kênh thông báo). Margin dạng tỉ lệ: 0.05 = 5%. */
export interface StakeTier {
  readonly id: string;
  readonly name: string;
  readonly minMargin: number;
  /** null = không giới hạn trên. */
  readonly maxMargin: number | null;
}

export const STAKE_TRENDS = ['flat', 'up', 'down', 'custom'] as const;
export type StakeTrend = (typeof STAKE_TRENDS)[number];

/** Ghi đè của admin cho một hạng (bắt buộc khi trend = custom; các trend khác chỉ dùng min/max nếu có). */
export interface TierStakeOverride {
  readonly stake?: number;
  readonly minStake?: number;
  readonly maxStake?: number;
  /** Số lệnh tối đa mỗi cửa ở hạng này (ghi đè mặc định của profile); 0 = không giới hạn. */
  readonly maxEntries?: number;
  /** Lãi tối thiểu mỗi ngày khóa vốn ở hạng này (ghi đè risk.minDailyMargin); 0 = tắt cho hạng này. */
  readonly minDailyMargin?: number;
}

export interface StakePlan {
  readonly trend: StakeTrend;
  /** Tiền vào lệnh của hạng THẤP NHẤT (USD, tính trên chân sptpub). */
  readonly baseStake: number;
  /** Bước giữa hai hạng liền nhau, vd 0.5 = 50%: lên ×1.5 mỗi hạng, xuống ÷1.5 mỗi hạng. */
  readonly stepPct: number;
  /** Mức tối thiểu/tối đa mặc định = tỉ lệ so với tiền của hạng, vd 0.5 và 2. */
  readonly minStakeRatio: number;
  readonly maxStakeRatio: number;
  /** Tăng dần trong hạng: margin ở cận dưới → stake, ở cận trên → maxStake. */
  readonly scaleWithinTier: boolean;
  /** tierId → ghi đè. */
  readonly overrides: Readonly<Record<string, TierStakeOverride>>;
  /**
   * Hạng kèo profile được vào (tierId). [] = chưa chọn hạng nào → profile đứng yên.
   * null = mọi hạng (profile tạo trước khi có tính năng chọn hạng).
   */
  readonly tierIds: readonly string[] | null;
}

export const DEFAULT_STAKE_PLAN: StakePlan = {
  trend: 'flat',
  baseStake: 50,
  stepPct: 0.5,
  minStakeRatio: 0.5,
  maxStakeRatio: 1,
  scaleWithinTier: false,
  overrides: {},
  // bản ghi cũ không có trường này → mọi hạng (giữ nguyên hành vi trước đây)
  tierIds: null,
};

/** Profile có vào hạng này không. */
export const tierSelected = (plan: StakePlan, tierId: string): boolean =>
  plan.tierIds === null || plan.tierIds.includes(tierId);

/** Hạng sắp theo minMargin tăng dần (thứ tự này quyết định xu hướng lên/xuống). */
export const sortTiers = <T extends StakeTier>(tiers: readonly T[]): T[] =>
  [...tiers].sort(
    (a, b) => a.minMargin - b.minMargin || a.name.localeCompare(b.name),
  );

/** Tính bảng vốn cho mọi hạng từ kế hoạch. */
export function resolveStakeTable(
  plan: StakePlan,
  tiers: readonly StakeTier[],
): StakeRow[] {
  return sortTiers(tiers).map((t, i) => {
    const o = plan.overrides[t.id] ?? {};
    const factor = 1 + plan.stepPct;
    const auto =
      plan.trend === 'up'
        ? plan.baseStake * factor ** i
        : plan.trend === 'down'
          ? plan.baseStake / factor ** i
          : plan.baseStake;
    const stake = round2(plan.trend === 'custom' ? (o.stake ?? 0) : auto);
    const minStake = round2(o.minStake ?? stake * plan.minStakeRatio);
    const maxStake = round2(
      Math.max(stake, o.maxStake ?? stake * plan.maxStakeRatio),
    );
    return {
      tierId: t.id,
      tierName: t.name,
      minMargin: t.minMargin,
      maxMargin: t.maxMargin,
      stake,
      minStake: Math.min(minStake, stake),
      maxStake,
      scaleWithinTier: plan.scaleWithinTier,
      enabled: tierSelected(plan, t.id),
      maxEntries: o.maxEntries ?? null,
      minDailyMargin: o.minDailyMargin ?? null,
    };
  });
}

/** Lỗi cấu hình kế hoạch vốn (null = hợp lệ). */
export function validateStakePlan(plan: StakePlan): string | null {
  if (!(plan.baseStake >= 0)) return 'baseStake phải ≥ 0';
  if (!(plan.stepPct >= 0) || plan.stepPct > 10)
    return 'stepPct phải trong [0, 10]';
  if (!(plan.minStakeRatio >= 0 && plan.minStakeRatio <= 1))
    return 'minStakeRatio phải trong [0, 1]';
  if (!(plan.maxStakeRatio >= 1 && plan.maxStakeRatio <= 100))
    return 'maxStakeRatio phải trong [1, 100]';
  if (plan.tierIds !== null && plan.tierIds.length > 200)
    return 'tierIds tối đa 200 hạng';
  for (const [id, o] of Object.entries(plan.overrides)) {
    for (const v of [o.stake, o.minStake, o.maxStake])
      if (v !== undefined && !(v >= 0))
        return `override ${id}: số tiền phải ≥ 0`;
    if (
      o.minStake !== undefined &&
      o.maxStake !== undefined &&
      o.minStake > o.maxStake
    )
      return `override ${id}: minStake > maxStake`;
    if (
      o.maxEntries !== undefined &&
      !(
        Number.isInteger(o.maxEntries) &&
        o.maxEntries >= 0 &&
        o.maxEntries <= 100
      )
    )
      return `override ${id}: maxEntries phải là số nguyên 0–100 (0 = không giới hạn)`;
    if (
      o.minDailyMargin !== undefined &&
      !(o.minDailyMargin >= 0 && o.minDailyMargin <= 10)
    )
      return `override ${id}: minDailyMargin phải trong [0, 10]`;
  }
  return null;
}
