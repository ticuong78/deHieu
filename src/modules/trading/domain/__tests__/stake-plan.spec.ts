import {
  DEFAULT_STAKE_PLAN,
  resolveStakeTable,
  targetStake,
  validateStakePlan,
  type StakeTier,
} from '../stake-plan.js';

const tiers: StakeTier[] = [
  { id: 'svip', name: 'SVIP', minMargin: 0.09, maxMargin: null },
  { id: 'pt', name: 'Phổ thông', minMargin: 0.02, maxMargin: 0.05 },
  { id: 'vip', name: 'VIP', minMargin: 0.05, maxMargin: 0.09 },
];
const plan = { ...DEFAULT_STAKE_PLAN, baseStake: 50, stepPct: 0.5 };
const stakes = (p: typeof plan) =>
  resolveStakeTable(p, tiers).map((r) => r.stake);

describe('kế hoạch vốn theo hạng kèo', () => {
  it('xu hướng ngang / lên / xuống theo bước %, hạng sắp theo minMargin', () => {
    expect(resolveStakeTable(plan, tiers).map((r) => r.tierName)).toEqual([
      'Phổ thông',
      'VIP',
      'SVIP',
    ]);
    expect(stakes({ ...plan, trend: 'flat' })).toEqual([50, 50, 50]);
    expect(stakes({ ...plan, trend: 'up' })).toEqual([50, 75, 112.5]);
    expect(stakes({ ...plan, trend: 'down' })).toEqual([50, 33.33, 22.22]);
  });

  it('tùy chỉnh từng hạng; hạng không nhập = 0 (không vào lệnh)', () => {
    const t = resolveStakeTable(
      {
        ...plan,
        trend: 'custom',
        overrides: { vip: { stake: 80 }, svip: { stake: 200, maxStake: 300 } },
      },
      tiers,
    );
    expect(t.map((r) => [r.stake, r.maxStake])).toEqual([
      [0, 0],
      [80, 80],
      [200, 300],
    ]);
    expect(targetStake(t, 0.03)).toBeNull();
  });

  it('mức tối thiểu/tối đa mặc định theo tỉ lệ, ghi đè được', () => {
    const t = resolveStakeTable(
      {
        ...plan,
        minStakeRatio: 0.4,
        maxStakeRatio: 2,
        overrides: { vip: { minStake: 10 } },
      },
      tiers,
    );
    expect(t.map((r) => [r.minStake, r.maxStake])).toEqual([
      [20, 100],
      [10, 100],
      [20, 100],
    ]);
  });

  it('chọn hạng khớp cao nhất; tăng dần trong hạng khi bật', () => {
    const flat = resolveStakeTable({ ...plan, trend: 'up' }, tiers);
    expect(targetStake(flat, 0.06)?.row.tierId).toBe('vip');
    expect(targetStake(flat, 0.12)?.stake).toBe(112.5);
    expect(targetStake(flat, 0.01)).toBeNull();

    const scaled = resolveStakeTable(
      { ...plan, maxStakeRatio: 2, scaleWithinTier: true },
      tiers,
    );
    expect(targetStake(scaled, 0.05)?.stake).toBe(50); // cận dưới VIP
    expect(targetStake(scaled, 0.07)?.stake).toBe(75); // giữa VIP
    expect(targetStake(scaled, 0.2)?.stake).toBe(50); // SVIP không có cận trên → giữ nguyên
  });

  it('kiểm tra cấu hình', () => {
    expect(validateStakePlan(plan)).toBeNull();
    expect(validateStakePlan({ ...plan, maxStakeRatio: 0.5 })).toContain(
      'maxStakeRatio',
    );
    expect(
      validateStakePlan({
        ...plan,
        overrides: { x: { minStake: 5, maxStake: 1 } },
      }),
    ).toContain('minStake > maxStake');
    // 0 = không giới hạn số lệnh
    expect(
      validateStakePlan({ ...plan, overrides: { x: { maxEntries: 0 } } }),
    ).toBeNull();
    expect(
      validateStakePlan({ ...plan, overrides: { x: { maxEntries: -1 } } }),
    ).toContain('maxEntries');
    expect(
      validateStakePlan({ ...plan, overrides: { x: { minDailyMargin: -1 } } }),
    ).toContain('minDailyMargin');
  });

  it('lãi tối thiểu mỗi ngày của hạng: ghi đè đi vào bảng, không ghi đè = null', () => {
    const rows = resolveStakeTable(
      { ...plan, overrides: { [tiers[0].id]: { minDailyMargin: 0.02 } } },
      tiers,
    );
    const byId = new Map(rows.map((r) => [r.tierId, r]));
    expect(byId.get(tiers[0].id)?.minDailyMargin).toBe(0.02);
    expect(byId.get(tiers[1].id)?.minDailyMargin).toBeNull();
  });
});
