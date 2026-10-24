import { describe, expect, it, vi } from 'vitest';
import { InMemoryOpsEventBus } from '../../../../shared/infrastructure/ops/in-memory-ops-event-bus.js';
import type { OpsEvent } from '../../../../shared/application/ops-event-bus.js';
import { InMemoryRebalanceTransferStore } from '../../infrastructure/rebalance/rebalance-transfer.store.js';
import {
  RebalanceExecutor,
  type RebalanceGateway,
} from '../rebalance-executor.js';
import {
  DEFAULT_TRADING_SETTINGS,
  type RebalanceSettings,
} from '../../domain/trading-settings.js';
import type { TradingAccount } from '../../domain/trading-account.js';
import type { TradeUnit } from '../../domain/balance-rebalance.js';

const EMPIRE_DEP = '0x6A07093Ec021fbDb4fb112fF73a8119218518F5C';
const POLY_DEP = '0x2d01165D44945004766dC59caAC3f5E7367Ca977';
const accounts: TradingAccount[] = [
  {
    id: 'e',
    label: 'E',
    enabled: true,
    secretCipher: null,
    config: {
      venue: 'csgoempire',
      browserProfile: 'empire-1',
      usdtDepositAddress: EMPIRE_DEP,
    },
  },
  {
    id: 'm',
    label: 'M',
    enabled: true,
    secretCipher: 'x',
    config: {
      venue: 'polymarket',
      walletAddress: '0x0000000000000000000000000000000000000001',
      funderAddress: null,
      usdtDepositAddress: POLY_DEP,
      relayerApiKeyAddress: '0x0000000000000000000000000000000000000002',
      relayerApiKeyCipher: 'enc',
    },
  },
];

function setup(
  balances: { csgoempire: number; polymarket: number },
  rebalance: Partial<RebalanceSettings> = {},
  gw: Partial<RebalanceGateway> = {},
  unit: TradeUnit | null = null,
) {
  const ops = new InMemoryOpsEventBus();
  const events: OpsEvent[] = [];
  ops.subscribe((e) => events.push(e));
  const gateway: RebalanceGateway = {
    halted: () => Promise.resolve(null),
    readBalances: () => Promise.resolve(balances),
    empireDepositAddress: () => Promise.resolve(EMPIRE_DEP),
    sendFromPolymarket: vi.fn(
      async (
        _p: unknown,
        _u: number,
        _r: string,
        onSubmitted: (ref: string | null) => Promise<void>,
      ) => {
        await onSubmitted('0xabc');
        return { txHash: '0xabc' };
      },
    ),
    withdrawFromEmpire: vi.fn(() =>
      Promise.resolve({ id: 7, coinCents: 100, usdt: 20 }),
    ),
    polymarketCash: vi.fn(() => Promise.resolve(1e6)),
    polymarketDeposit: vi.fn(() => Promise.resolve('completed' as const)),
    empireWithdrawal: () =>
      Promise.resolve({ state: 'confirmed' as const, txHash: '0xdef' }),
    empireDepositCredited: () => Promise.resolve(true),
    ...gw,
  };
  const store = new InMemoryRebalanceTransferStore();
  const advisor = {
    resolve: vi.fn(),
    empireShare: 0.35,
    unitFor: vi.fn((): TradeUnit | null => unit),
  };
  const ex = new RebalanceExecutor(
    gateway,
    store,
    {
      get: () =>
        Promise.resolve({
          ...DEFAULT_TRADING_SETTINGS,
          rebalance: {
            ...DEFAULT_TRADING_SETTINGS.rebalance,
            mode: 'live',
            ...rebalance,
          },
        }),
      save: () => Promise.resolve(),
    },
    {
      get: (id: string) =>
        Promise.resolve(
          id === 'p1'
            ? ({
                id: 'p1',
                name: 'Trader A',
                csgoempireAccountId: 'e',
                polymarketAccountId: 'm',
              } as never)
            : null,
        ),
    } as never,
    { list: () => Promise.resolve(accounts) } as never,
    advisor,
    ops,
    null,
    undefined,
    Date.now,
    () => Promise.resolve(),
    { pollMs: 1, confirmTimeoutMs: 0, cooldownMs: 60_000, lockMs: 60_000 },
  );
  return { ex, gateway, store, advisor, events };
}

describe('tự chuyển tiền 35/65', () => {
  it('csgoempire thiếu → gửi từ Polymarket tới địa chỉ nạp đã xác nhận, giới hạn mỗi lần, xong thì đóng đề xuất', async () => {
    const { ex, gateway, advisor, store } = setup({
      csgoempire: 10,
      polymarket: 390,
    });
    const r = await ex.run('p1', 'auto');
    expect(r.status).toBe('SUCEED');
    const t = (r as { data: { state: string; amountUsd: number } }).data;
    // cần 130$, tối đa 100$/lần
    expect(t).toMatchObject({
      state: 'completed',
      amountUsd: 100,
      from: 'polymarket',
      to: 'csgoempire',
    });
    expect(gateway.sendFromPolymarket).toHaveBeenCalledWith(
      expect.anything(),
      100,
      EMPIRE_DEP,
      expect.any(Function),
    );
    expect(advisor.resolve).toHaveBeenCalledWith('p1', 'auto');
    // vừa chuyển: lượt tự động kế tiếp hạ nhiệt
    expect(await ex.run('p1', 'auto')).toMatchObject({
      reason: 'REBALANCE_COOLDOWN',
    });
    expect(await store.daily('p1', new Date().toISOString().slice(0, 10))).toBe(
      100,
    );
  });

  it('Polymarket thiếu → rút csgoempire về địa chỉ nạp Polymarket', async () => {
    const { ex, gateway } = setup({ csgoempire: 150, polymarket: 50 });
    const r = await ex.run('p1', 'manual');
    expect(r).toMatchObject({
      data: { state: 'completed', to: 'polymarket', amountUsd: 80 },
    });
    // chặn ở csgoempire nếu USDT thực gửi < mức nạp tối thiểu Polymarket (3$)
    expect(gateway.withdrawFromEmpire).toHaveBeenCalledWith(
      expect.anything(),
      80,
      POLY_DEP,
      3,
    );
  });

  it('chạy thử: không gửi gì, chỉ ghi "sẽ chuyển"', async () => {
    const { ex, gateway } = setup(
      { csgoempire: 10, polymarket: 390 },
      { mode: 'dry_run' },
    );
    const r = await ex.run('p1', 'manual');
    expect(r).toMatchObject({ data: { state: 'dry_run', amountUsd: 100 } });
    expect(gateway.sendFromPolymarket).not.toHaveBeenCalled();
  });

  it('tắt → không làm gì', async () => {
    const { ex } = setup({ csgoempire: 10, polymarket: 390 }, { mode: 'off' });
    expect(await ex.run('p1', 'auto')).toMatchObject({
      reason: 'REBALANCE_OFF',
    });
  });

  it('địa chỉ nạp csgoempire đổi so với đã xác nhận → không gửi', async () => {
    const { ex, gateway } = setup(
      { csgoempire: 10, polymarket: 390 },
      {},
      {
        empireDepositAddress: () =>
          Promise.resolve('0x1111111111111111111111111111111111111111'),
      },
    );
    const r = await ex.run('p1', 'auto');
    expect(r).toMatchObject({ data: { state: 'skipped' } });
    expect((r as { data: { reason: string } }).data.reason).toMatch(
      /DEPOSIT_ADDRESS_CHANGED/,
    );
    expect(gateway.sendFromPolymarket).not.toHaveBeenCalled();
  });

  it('hạn mức ngày: còn ít hơn tối thiểu → bỏ qua', async () => {
    const { ex, store } = setup(
      { csgoempire: 10, polymarket: 390 },
      { maxPerDayUsd: 100 },
    );
    await store.addDaily('p1', new Date().toISOString().slice(0, 10), 98);
    const r = await ex.run('p1', 'manual');
    expect((r as { data: { reason: string } }).data.reason).toMatch(
      /DAILY_LIMIT/,
    );
  });

  it('lỗi SAU khi đã gửi → kết quả không rõ, chặn tự chuyển tới khi gỡ, báo sự kiện', async () => {
    const { ex, events } = setup(
      { csgoempire: 10, polymarket: 390 },
      {},
      {
        sendFromPolymarket: async (_p, _u, _r, onSubmitted) => {
          await onSubmitted('relayer:1');
          throw new Error('timeout chờ giao dịch');
        },
      },
    );
    expect(await ex.run('p1', 'auto')).toMatchObject({
      data: { state: 'unknown' },
    });
    expect(await ex.blocked('p1')).toMatch(/không rõ/);
    expect(await ex.run('p1', 'manual')).toMatchObject({ status: 'FAILED' });
    expect(events.some((e) => e.type === 'trading.rebalance_transfer')).toBe(
      true,
    );
    await ex.unblock('p1', 'admin');
    expect(await ex.blocked('p1')).toBeNull();
  });

  it('lỗi TRƯỚC khi gửi → thất bại, trả lại hạn mức ngày, không chặn', async () => {
    const { ex, store } = setup(
      { csgoempire: 10, polymarket: 390 },
      {},
      {
        sendFromPolymarket: () =>
          Promise.reject(new Error('RELAY_QUOTE_FAILED: HTTP 500')),
      },
    );
    expect(await ex.run('p1', 'auto')).toMatchObject({
      data: { state: 'failed' },
    });
    expect(await store.daily('p1', new Date().toISOString().slice(0, 10))).toBe(
      0,
    );
    expect(await ex.blocked('p1')).toBeNull();
  });

  it('chưa xác nhận trong thời gian chờ → chưa rõ, chặn', async () => {
    const { ex } = setup(
      { csgoempire: 150, polymarket: 50 },
      {},
      {
        empireWithdrawal: () =>
          Promise.resolve({ state: 'pending' as const, txHash: null }),
      },
    );
    expect(await ex.run('p1', 'auto')).toMatchObject({
      data: { state: 'unconfirmed' },
    });
    expect(await ex.blocked('p1')).toMatch(/chưa xác nhận/);
  });

  it('csgoempire từ chối lệnh rút → thất bại, trả hạn mức ngày', async () => {
    const { ex, store } = setup(
      { csgoempire: 150, polymarket: 50 },
      {},
      {
        empireWithdrawal: () =>
          Promise.resolve({ state: 'failed' as const, txHash: null }),
      },
    );
    expect(await ex.run('p1', 'auto')).toMatchObject({
      data: { state: 'failed' },
    });
    expect(await store.daily('p1', new Date().toISOString().slice(0, 10))).toBe(
      0,
    );
  });

  describe('tối ưu theo số lệnh (biết tiền một lệnh: csgoempire 10$, Polymarket 18$, tối thiểu 50%)', () => {
    const unit: TradeUnit = {
      csgoempire: 10,
      polymarket: 18,
      minFraction: 0.5,
    };
    const day = () => new Date().toISOString().slice(0, 10);

    it('tổng không đủ một lệnh nhỏ nhất (9$ < 14$) → không chuyển', async () => {
      const { ex, gateway } = setup(
        { csgoempire: 2, polymarket: 7 },
        {},
        {},
        unit,
      );
      const r = await ex.run('p1', 'auto');
      expect((r as { data: { reason: string } }).data.reason).toMatch(
        /INSUFFICIENT_TOTAL/,
      );
      expect(gateway.sendFromPolymarket).not.toHaveBeenCalled();
    });

    it('tổng 20$ < một lệnh đầy đủ 28$ → chia theo tiền lệnh cần để vào được lệnh lớn nhất', async () => {
      const { ex } = setup({ csgoempire: 2, polymarket: 18 }, {}, {}, unit);
      const r = await ex.run('p1', 'manual');
      // csgoempire 20 × 10/28 = 7.15 → chuyển 5.15$
      expect(r).toMatchObject({
        data: { state: 'completed', to: 'csgoempire', amountUsd: 5.15 },
      });
    });

    it('sang csgoempire: chỉ chuyển đúng phần còn thiếu cho lệnh kế tiếp, không chia hết về 35/65', async () => {
      // 35/65 sẽ chuyển 16$; csgoempire chỉ thiếu 5$ cho một lệnh đầy đủ (10$) → chuyển 5$
      const { ex } = setup({ csgoempire: 5, polymarket: 55 }, {}, {}, unit);
      expect(await ex.run('p1', 'manual')).toMatchObject({
        data: { to: 'csgoempire', amountUsd: 5 },
      });
    });

    it('đã vào được tối đa số lệnh có thể → không chuyển', async () => {
      const { ex, gateway } = setup(
        { csgoempire: 21, polymarket: 39 },
        {},
        {},
        unit,
      );
      const r = await ex.run('p1', 'manual');
      expect((r as { data: { reason: string } }).data.reason).toMatch(
        /NO_GAIN/,
      );
      expect(gateway.sendFromPolymarket).not.toHaveBeenCalled();
      expect(gateway.withdrawFromEmpire).not.toHaveBeenCalled();
    });

    it('35/65 vào được ít lệnh hơn tối đa (Polymarket cần 30$) → dành đủ tiền cho 2 lệnh', async () => {
      const { ex } = setup(
        { csgoempire: 40, polymarket: 40 },
        {},
        {},
        { csgoempire: 10, polymarket: 30, minFraction: 1 },
      );
      // 35/65 = 28/52 → 1 lệnh; dành 20/60 → 2 lệnh: rút 20$ csgoempire → Polymarket
      expect(await ex.run('p1', 'manual')).toMatchObject({
        data: { to: 'polymarket', amountUsd: 20, state: 'completed' },
      });
    });

    it('hạn mức chỉ cho chuyển quá ít để vào thêm lệnh → không chuyển', async () => {
      const { ex, store } = setup(
        { csgoempire: 5, polymarket: 55 },
        { maxPerDayUsd: 100 },
        {},
        unit,
      );
      await store.addDaily('p1', day(), 99.5);
      const r = await ex.run('p1', 'manual');
      expect((r as { data: { reason: string } }).data.reason).toMatch(
        /LIMIT_NO_GAIN/,
      );
    });

    it('sang csgoempire dưới "Tối thiểu" và dưới 3$ vẫn chuyển đúng số lệnh cần', async () => {
      // csgoempire 8$ (thiếu 2$ cho lệnh đầy đủ) → chuyển đúng 2$, không làm tròn lên 5$ / 3,10$
      const { ex } = setup({ csgoempire: 8, polymarket: 22 }, {}, {}, unit);
      expect(await ex.run('p1', 'manual')).toMatchObject({
        data: { state: 'completed', to: 'csgoempire', amountUsd: 2 },
      });
    });

    it('sang Polymarket dưới "Tối thiểu" → vẫn làm tròn lên (và ≥ mức nạp 3,10$)', async () => {
      // Polymarket 10$ (thiếu 8$ cho lệnh 18$), csgoempire dư → chuyển ≥ 8$
      const { ex } = setup(
        { csgoempire: 30, polymarket: 10 },
        { minTransferUsd: 1 },
        {},
        unit,
      );
      const r = await ex.run('p1', 'manual');
      expect(r).toMatchObject({ data: { to: 'polymarket' } });
      expect(
        (r as { data: { amountUsd: number } }).data.amountUsd,
      ).toBeGreaterThanOrEqual(8);
    });
  });

  it('chưa có Relayer API Key → không chuyển ra khỏi Polymarket (báo cách lấy key)', async () => {
    const saved = accounts[1]!.config;
    accounts[1] = {
      ...accounts[1]!,
      config: { ...saved, relayerApiKeyCipher: null } as never,
    };
    try {
      const { ex, gateway } = setup({ csgoempire: 10, polymarket: 390 });
      const r = await ex.run('p1', 'manual');
      expect((r as { data: { reason: string } }).data.reason).toMatch(
        /NO_RELAYER_KEY/,
      );
      expect(gateway.sendFromPolymarket).not.toHaveBeenCalled();
    } finally {
      accounts[1] = { ...accounts[1]!, config: saved };
    }
  });
  describe('khoản nạp tối thiểu + xác nhận tiền đã vào Polymarket', () => {
    it('cần chuyển dưới mức nạp tối thiểu của Polymarket (1,6$ < 3$) → không chuyển', async () => {
      const { ex, gateway } = setup(
        { csgoempire: 3, polymarket: 1 },
        { minTransferUsd: 1 },
      );
      const r = await ex.run('p1', 'manual');
      expect((r as { data: { reason: string } }).data.reason).toMatch(
        /BELOW_DEPOSIT_MIN/,
      );
      expect(gateway.withdrawFromEmpire).not.toHaveBeenCalled();
    });

    it('đúng 3$ vẫn chưa đủ: phải ≥ mức tối thiểu + đệm 0,1$ (tỷ giá / làm tròn)', async () => {
      // cần 3$ sang Polymarket, không biết tiền một lệnh → không nâng lên được → không chuyển
      const { ex, gateway } = setup(
        { csgoempire: 6.5, polymarket: 3.5 },
        { minTransferUsd: 1 },
      );
      const r = await ex.run('p1', 'manual');
      expect((r as { data: { reason: string } }).data.reason).toMatch(
        /BELOW_DEPOSIT_MIN.*3\.10/,
      );
      expect(gateway.withdrawFromEmpire).not.toHaveBeenCalled();
    });

    it('Polymarket công bố mức cao hơn (5$) → dùng mức đó', async () => {
      const { ex, gateway } = setup(
        { csgoempire: 8, polymarket: 7 },
        { minTransferUsd: 1 },
        { depositMinimumUsd: () => Promise.resolve(5) },
      );
      const r = await ex.run('p1', 'manual');
      expect((r as { data: { reason: string } }).data.reason).toMatch(
        /BELOW_DEPOSIT_MIN.*5\.10/,
      );
      expect(gateway.withdrawFromEmpire).not.toHaveBeenCalled();
    });

    it('csgoempire đã gửi nhưng Polymarket chưa nhận → KHÔNG báo xong, chặn', async () => {
      const { ex } = setup(
        { csgoempire: 150, polymarket: 50 },
        {},
        {
          polymarketDeposit: () => Promise.resolve('pending' as const),
          polymarketCash: () => Promise.resolve(50),
        },
      );
      const r = await ex.run('p1', 'manual');
      expect(r).toMatchObject({ data: { state: 'unconfirmed' } });
      expect((r as { data: { reason: string } }).data.reason).toMatch(
        /chưa thấy tiền vào Polymarket/,
      );
    });

    it('Polymarket báo khoản nạp thất bại → chặn, báo liên hệ hỗ trợ', async () => {
      const { ex } = setup(
        { csgoempire: 150, polymarket: 50 },
        {},
        {
          polymarketDeposit: () => Promise.resolve('failed' as const),
          polymarketCash: () => Promise.resolve(50),
        },
      );
      const r = await ex.run('p1', 'manual');
      expect(r).toMatchObject({ data: { state: 'unconfirmed' } });
      expect((r as { data: { reason: string } }).data.reason).toMatch(
        /THẤT BẠI/,
      );
    });

    it('bridge chưa trả trạng thái nhưng Cash Polymarket đã tăng → xong', async () => {
      const { ex } = setup(
        { csgoempire: 150, polymarket: 50 },
        {},
        {
          polymarketDeposit: () => Promise.reject(new Error('HTTP 503')),
          polymarketCash: () => Promise.resolve(129.5),
        },
      );
      const r = await ex.run('p1', 'manual');
      expect(r).toMatchObject({ data: { state: 'completed' } });
    });
  });
});
