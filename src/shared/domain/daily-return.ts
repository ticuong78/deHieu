/**
 * Lãi theo ngày của một kèo: tiền bị "khóa" từ lúc vào lệnh tới khi trận có kết quả, nên kèo lãi
 * vài % nhưng phải chờ nhiều ngày kém hơn kèo 15–20% của trận sắp đá. Thuần, không I/O.
 */

/** Ước lượng thời gian từ giờ bắt đầu tới lúc trận có kết quả (tiền được trả lại). */
export const MATCH_SETTLE_MS = 3 * 3_600_000;
export const DAY_MS = 86_400_000;
/** Số ngày khóa vốn tối thiểu: trận trong ngày (kể cả đang đá) tính là 1 ngày. */
export const MIN_LOCK_DAYS = 1;

export interface DailyReturn {
  /** Số ngày vốn bị khóa (≥ 1): từ bây giờ tới giờ bắt đầu + MATCH_SETTLE_MS. */
  readonly days: number;
  /** margin ÷ days, vd 0.03 / 5 = 0.006 (0,6%/ngày). */
  readonly perDay: number;
}

/**
 * startsAt = giờ bắt đầu trận (ms epoch); null/không hợp lệ → không tính được (null).
 * Lấy giờ MUỘN NHẤT giữa các chân khi gọi để không đánh giá thấp thời gian khóa vốn.
 */
export function dailyReturn(
  margin: number,
  startsAt: number | null | undefined,
  now: number,
): DailyReturn | null {
  if (
    typeof startsAt !== 'number' ||
    !Number.isFinite(startsAt) ||
    startsAt <= 0 ||
    !Number.isFinite(margin)
  )
    return null;
  const days = Math.max(
    MIN_LOCK_DAYS,
    (startsAt + MATCH_SETTLE_MS - now) / DAY_MS,
  );
  return { days, perDay: margin / days };
}
