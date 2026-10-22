import { describe, expect, it } from 'vitest';
import {
  planForTrades,
  planRebalance,
  tradeLevel,
} from '../balance-rebalance.js';

describe('kế hoạch cân bằng tiền 35/65', () => {
  it('csgoempire thiếu → chuyển từ Polymarket sang', () => {
    const p = planRebalance({ csgoempire: 10, polymarket: 190 });
    expect(p).toMatchObject({
      from: 'polymarket',
      to: 'csgoempire',
      amountUsd: 60,
      totalUsd: 200,
      target: { csgoempire: 70, polymarket: 130 },
    });
  });

  it('Polymarket thiếu → chuyển từ csgoempire sang', () => {
    const p = planRebalance({ csgoempire: 150, polymarket: 50 });
    expect(p).toMatchObject({
      from: 'csgoempire',
      to: 'polymarket',
      amountUsd: 80,
    });
  });

  it('đã đúng tỉ lệ (lệch < 1$) hoặc số dư không hợp lệ → null', () => {
    expect(planRebalance({ csgoempire: 35.4, polymarket: 64.6 })).toBeNull();
    expect(planRebalance({ csgoempire: 0, polymarket: 0 })).toBeNull();
    expect(planRebalance({ csgoempire: -1, polymarket: 10 })).toBeNull();
    expect(
      planRebalance({ csgoempire: Number.NaN, polymarket: 10 }),
    ).toBeNull();
  });

  it('làm tròn XUỐNG tới cent', () => {
    expect(planRebalance({ csgoempire: 0, polymarket: 10.01 })?.amountUsd).toBe(
      3.5,
    );
  });
});

describe('cân bằng theo LỆNH (ví dụ: csgoempire cần 10$, cả lệnh cần 28$)', () => {
  const unit = { csgoempire: 10, polymarket: 18, minFraction: 1 };

  it('tổng < 28$ (lệnh tối thiểu = đầy đủ) → không chuyển, báo cần bao nhiêu', () => {
    expect(planForTrades({ csgoempire: 3, polymarket: 20 }, unit)).toEqual({
      kind: 'insufficient',
      totalUsd: 23,
      needUsd: 28,
    });
  });

  it('35% tổng không đủ 10$ nhưng tổng ≥ 28$ → vẫn dành đủ 10$ cho csgoempire', () => {
    // tổng 28.5$: 35% = 9.98$ < 10$ → chia theo tiền lệnh cần, đủ 1 lệnh
    const d = planForTrades({ csgoempire: 0, polymarket: 28.5 }, unit);
    expect(d?.kind).toBe('transfer');
    if (d?.kind !== 'transfer') return;
    expect(d.plan.target.csgoempire).toBeGreaterThanOrEqual(10);
    expect(d.plan.target.polymarket).toBeGreaterThanOrEqual(18);
    expect(d.levelAfter).toBe(1);
  });

  it('cho phép lệnh nhỏ hơn mục tiêu (tối thiểu 50%) → tổng ≥ 14$ đã đáng chuyển', () => {
    const d = planForTrades(
      { csgoempire: 1, polymarket: 15 },
      { ...unit, minFraction: 0.5 },
    );
    expect(d?.kind).toBe('transfer');
    if (d?.kind === 'transfer') expect(d.levelBefore).toBe(-1);
  });

  it('đã vào được tối đa → none; tradeLevel đếm đúng', () => {
    expect(tradeLevel({ csgoempire: 21, polymarket: 39 }, unit)).toBe(2);
    expect(planForTrades({ csgoempire: 21, polymarket: 39 }, unit)?.kind).toBe(
      'none',
    );
  });
});
