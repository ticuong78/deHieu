/**
 * Bảng vốn ĐÃ TÍNH SẴN theo hạng kèo: ngôn ngữ chung giữa module trading (tính bảng từ kế hoạch vốn)
 * và worker trader (chọn tiền cho từng kèo). Thuần, không I/O.
 */

/** Một dòng bảng vốn cho một hạng. Margin dạng tỉ lệ: 0.05 = 5%. */
export interface StakeRow {
  readonly tierId: string;
  readonly tierName: string;
  readonly minMargin: number;
  /** null = không giới hạn trên. */
  readonly maxMargin: number | null;
  readonly stake: number;
  readonly minStake: number;
  readonly maxStake: number;
  /** Tăng dần trong hạng: margin ở cận dưới → stake, ở cận trên → maxStake. */
  readonly scaleWithinTier: boolean;
  /** false = profile không vào hạng này (kèo thuộc hạng bị bỏ qua). Không có = vào. */
  readonly enabled?: boolean;
  /** Số lệnh tối đa mỗi cửa ở hạng này; null/không có = theo mặc định của profile (risk.maxEntriesPerTier); 0 = không giới hạn. */
  readonly maxEntries?: number | null;
  /** Lãi tối thiểu mỗi ngày khóa vốn ở hạng này; null/không có = theo profile (risk.minDailyMargin); 0 = tắt. */
  readonly minDailyMargin?: number | null;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Tiền mục tiêu cho một kèo có lợi nhuận `margin`: hạng khớp CAO NHẤT (minMargin lớn nhất).
 * Không khớp hạng nào hoặc tiền = 0 → null (không vào lệnh).
 */
export function targetStake(
  table: readonly StakeRow[],
  margin: number,
): { readonly row: StakeRow; readonly stake: number } | null {
  const row = [...table]
    .filter(
      (r) =>
        margin >= r.minMargin && (r.maxMargin === null || margin < r.maxMargin),
    )
    .sort((a, b) => b.minMargin - a.minMargin)[0];
  if (!row || !(row.stake > 0)) return null;
  if (!row.scaleWithinTier || row.maxMargin === null)
    return { row, stake: row.stake };
  const t = (margin - row.minMargin) / (row.maxMargin - row.minMargin);
  return {
    row,
    stake: round2(
      row.stake + (row.maxStake - row.stake) * Math.min(1, Math.max(0, t)),
    ),
  };
}
