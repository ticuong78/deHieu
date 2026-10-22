import { describe, expect, it, vi } from 'vitest';
import { InMemoryOpsEventBus } from '../../../../shared/infrastructure/ops/in-memory-ops-event-bus.js';
import type { OpsEvent } from '../../../../shared/application/ops-event-bus.js';
import { RebalanceAdvisor, isCashShortage } from '../rebalance-advisor.js';
import type { TradeAttempt } from '../trade-attempt.js';

const trade = (
  empire: number,
  poly: number,
  need: { empire?: number; poly?: number } = {},
  over: Partial<Record<string, unknown>> = {},
) =>
  ({
    id: `t-${empire}-${poly}`,
    profileId: 'p1',
    mode: 'live',
    teams: ['Navi', 'G2'],
    status: 'cancelled',
    reason: 'INSUFFICIENT_CASH: hủy cả hai chân',
    csgoempireAccountId: 'e1',
    polymarketAccountId: 'm1',
    detail: {
      cash: [
        { venue: 'csgoempire', available: empire, required: need.empire ?? 20 },
        { venue: 'polymarket', available: poly, required: need.poly ?? 30 },
      ],
    },
    legs: [],
    ...over,
  }) as unknown as TradeAttempt;

function setup(now = { t: 1_000 }) {
  const ops = new InMemoryOpsEventBus();
  const events: OpsEvent[] = [];
  ops.subscribe((e) => events.push(e));
  const push = { send: vi.fn(() => Promise.resolve({ id: 'n1', errors: [] })) };
  const advisor = new RebalanceAdvisor(
    ops,
    push,
    () => Promise.resolve('Trader A'),
    'https://arb.example',
    undefined,
    () => now.t,
  );
  return { advisor, events, push, now };
}

describe('đề xuất cân bằng tiền khi lệnh hủy vì hết tiền', () => {
  it('chỉ lệnh THẬT hủy vì INSUFFICIENT_CASH', () => {
    expect(isCashShortage(trade(1, 1))).toBe(true);
    expect(isCashShortage(trade(1, 1, {}, { mode: 'paper' }))).toBe(false);
    expect(
      isCashShortage(trade(1, 1, {}, { reason: 'CASH_UNAVAILABLE: x' })),
    ).toBe(false);
  });

  it('csgoempire thiếu → đề xuất chuyển từ Polymarket, báo sự kiện + push một lần', async () => {
    const { advisor, events, push } = setup();
    await advisor.trade(trade(5, 195));
    const [s] = advisor.list();
    expect(s).toMatchObject({
      profileId: 'p1',
      profileName: 'Trader A',
      triggers: 1,
      helpsShortage: true,
      plan: { from: 'polymarket', to: 'csgoempire', amountUsd: 75 },
    });
    expect(s.summary).toContain(
      'Chuyển 75.00$ từ Polymarket sang csgoempire: từ không vào được lệnh nào lên 4 lệnh đầy đủ',
    );
    expect(events.map((e) => e.type)).toEqual(['trading.rebalance_needed']);
    expect(push.send).toHaveBeenCalledTimes(1);
    // lệnh hủy tiếp theo cùng tình trạng: chỉ cập nhật, không báo lại
    await advisor.trade(trade(6, 194));
    expect(advisor.list()[0].triggers).toBe(2);
    expect(events).toHaveLength(1);
    expect(push.send).toHaveBeenCalledTimes(1);
  });

  it('kế hoạch đổi chiều → báo lại', async () => {
    const { advisor, events } = setup();
    await advisor.trade(trade(5, 195));
    await advisor.trade(trade(190, 10, { poly: 30 }));
    expect(events).toHaveLength(2);
    expect(advisor.list()[0].plan).toMatchObject({ from: 'csgoempire' });
  });

  it('tổng hai bên < một lệnh → không có kế hoạch, báo cần nạp', async () => {
    const { advisor } = setup();
    await advisor.trade(trade(7, 13, { empire: 20 }));
    const [s] = advisor.list();
    expect(s.plan).toBeNull();
    expect(s.helpsShortage).toBe(false);
    expect(s!.verdict).toBe('insufficient');
    expect(s.summary).toContain('cần cho MỘT lệnh nhỏ nhất');
  });

  it('Đã chuyển xong → xóa đề xuất, phát sự kiện đóng', async () => {
    const { advisor, events } = setup();
    await advisor.trade(trade(5, 195));
    expect(advisor.resolve('p1', 'admin')?.profileId).toBe('p1');
    expect(advisor.list()).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: 'trading.rebalanced',
      data: { profileId: 'p1', by: 'admin' },
    });
    expect(advisor.resolve('p1', 'admin')).toBeNull();
  });

  it('không rõ tiền một lệnh (sàn không báo số cần) → theo tỉ lệ 35/65', async () => {
    const { advisor } = setup();
    await advisor.trade(trade(5, 195, { empire: 0, poly: 0 }));
    expect(advisor.list()[0]).toMatchObject({
      verdict: 'ratio',
      plan: { amountUsd: 65 },
    });
  });

  it('chuyển qua lại không vào thêm được lệnh → không đề xuất chuyển', async () => {
    const { advisor } = setup();
    // cần 20$ + 30$ / lệnh, có 25$ + 40$ → vào được 1 lệnh; 65$ không đủ 2 lệnh (100$) dù chuyển thế nào
    await advisor.trade(trade(25, 40, { empire: 20, poly: 30 }));
    expect(advisor.list()[0]).toMatchObject({ verdict: 'none', plan: null });
  });
});
