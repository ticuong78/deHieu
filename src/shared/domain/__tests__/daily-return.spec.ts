import { describe, expect, it } from 'vitest';
import { DAY_MS, MATCH_SETTLE_MS, dailyReturn } from '../daily-return.js';

describe('dailyReturn', () => {
  const now = 1_800_000_000_000;

  it('chia margin cho số ngày tới khi trận có kết quả', () => {
    const r = dailyReturn(0.03, now + 5 * DAY_MS - MATCH_SETTLE_MS, now);
    expect(r?.days).toBeCloseTo(5);
    expect(r?.perDay).toBeCloseTo(0.006);
  });

  it('trận trong ngày hoặc đang đá tính tối thiểu 1 ngày', () => {
    expect(dailyReturn(0.15, now + 3_600_000, now)).toEqual({
      days: 1,
      perDay: 0.15,
    });
    expect(dailyReturn(0.15, now - 3_600_000, now)?.days).toBe(1);
  });

  it('không có giờ bắt đầu → null', () => {
    expect(dailyReturn(0.05, null, now)).toBeNull();
    expect(dailyReturn(0.05, undefined, now)).toBeNull();
    expect(dailyReturn(0.05, Number.NaN, now)).toBeNull();
  });
});
