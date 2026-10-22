import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type {
  TaskCommandHandler,
  TaskContext,
} from '../../../application/task.js';
import { InMemoryExposureLedger } from '../exposure-ledger.js';
import {
  matchOf,
  TraderArbitrageTask,
  type TraderArbitrageParams,
} from '../trader-arbitrage.task.js';
import type { TraderConfig } from '../trader-config.schema.js';
import type { ExecutionResult } from '../../../../../shared/infrastructure/trading/live-executor.js';

const TOKEN = 'consumer-token-for-tests';

/** Hub giả: welcome mọi hello đúng token, phát frame tới mọi consumer. */
class FakeHub {
  readonly wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  readonly consumers = new Map<string, WebSocket>();
  readonly acks: string[] = [];
  private _seq = 0;

  constructor() {
    this.wss.on('connection', (ws) =>
      ws.on('message', (raw) => {
        const f = JSON.parse((raw as Buffer).toString('utf8')) as Record<
          string,
          string
        >;
        if (f.type === 'hello') {
          if (f.token !== TOKEN) return ws.close();
          this.consumers.set(f.consumerId, ws);
          ws.send(JSON.stringify({ type: 'welcome', paused: false }));
        } else if (f.type === 'ack') this.acks.push(f.deliveryId);
      }),
    );
  }

  get url() {
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}`;
  }

  broadcast(frame: Record<string, unknown>) {
    for (const ws of this.consumers.values())
      ws.send(JSON.stringify({ ...frame, deliveryId: `d${++this._seq}` }));
  }

  close() {
    for (const ws of this.consumers.values()) ws.terminate();
    return new Promise((r) => this.wss.close(r));
  }
}

const config = (
  profileId: string,
  over: Partial<TraderConfig> = {},
): TraderConfig => ({
  v: 1,
  profileId,
  profileName: profileId,
  active: true,
  inactiveReason: null,
  mode: 'paper',
  accounts: {
    csgoempire: { id: 'e', label: 'E' },
    polymarket: { id: 'p', label: 'P' },
  },
  stakeTable: [
    {
      tierId: 'std',
      tierName: 'Thường',
      minMargin: 0.02,
      maxMargin: null,
      stake: 25,
      minStake: 5,
      maxStake: 25,
      scaleWithinTier: false,
      enabled: true,
      maxEntries: null,
      minDailyMargin: null,
    },
  ],
  strategy: { id: 'arb-taker', params: {} },
  risk: {
    minNetMargin: 0.01,
    matchCapUsd: 0,
    maxSignalAgeMs: 0,
    maxEntriesPerTier: 1,
    ignoreCancelReasons: ['better_opportunity'],
    markets: null,
    oneClickMinPrice: 0,
    maxNetMargin: 0,
    minDailyMargin: 0,
  },
  matchExposureCapUsd: 0,
  ...over,
});

const signal = (id: string, margin = 0.06) => ({
  signalId: id,
  room: 'room:lol:alpha~beta:match-winner',
  sport: 'lol',
  market: 'match-winner',
  teams: ['alpha', 'beta'],
  comboId: 'sptpub>0|polymarket>1',
  phase: 'live',
  margin,
  legs: [
    {
      tenant: 'sptpub',
      side: 0,
      pick: 'alpha',
      odds: 2,
      ref: {
        e: '1',
        url: 'https://csgoempire.com/match-betting?bt-path=x',
        tour: 'iem-cologne',
        tno: '3',
        tof: '12',
      },
      startsAt: 1_000_000,
    },
    {
      tenant: 'polymarket',
      side: 1,
      pick: 'beta',
      odds: 2.4,
      ref: { c: 'cond-1', t0: 'tok-0', t1: 'tok-1' },
    },
  ],
  issuedAt: Date.now(),
  expiresAt: Date.now() + 30_000,
});

interface Running {
  emitted: { payload: Record<string, unknown>; channel?: string }[];
  command: (name: string, data: unknown) => Promise<void>;
  stop: () => Promise<void>;
}

function start(
  task: TraderArbitrageTask,
  params: TraderArbitrageParams,
): Running {
  const ac = new AbortController();
  const emitted: Running['emitted'] = [];
  let handler: TaskCommandHandler = () => undefined;
  const ctx: TaskContext<TraderArbitrageParams> = {
    taskId: `trader-${params.profileId}`,
    tenant: 'trader',
    params,
    signal: ac.signal,
    emit: (payload, channel) =>
      emitted.push({ payload: payload as Record<string, unknown>, channel }),
    onCommand: (h) => {
      handler = h;
    },
    warn: () => undefined,
  };
  const done = task.run(ctx);
  return {
    emitted,
    command: async (name, data) => {
      await handler(name, data);
    },
    stop: async () => {
      ac.abort();
      await done;
    },
  };
}

const trades = (r: Running) =>
  r.emitted.filter((e) => e.channel === 'trade').map((e) => e.payload);

const until = async (cond: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('TraderArbitrageTask (giấy)', () => {
  let hub: FakeHub;
  let bookGate: Promise<void> | null;
  /** Thay sổ lệnh trả về (null = mặc định). */
  let asks: { price: string; size: string }[] | null;

  beforeEach(async () => {
    process.env.CONSUMER_WS_TOKEN = TOKEN;
    hub = new FakeHub();
    await new Promise((r) => hub.wss.once('listening', r));
    bookGate = null;
    asks = null;
    vi.stubGlobal(
      'fetch',
      async (url: string, init?: { signal?: AbortSignal }) => {
        if (url.includes('/book?')) {
          if (bookGate)
            await Promise.race([
              bookGate,
              new Promise((_, rej) =>
                init?.signal?.addEventListener('abort', () =>
                  rej(new Error('aborted')),
                ),
              ),
            ]);
          return Response.json({
            asks: asks ?? [
              { price: '0.49', size: '1000' },
              { price: '0.40', size: '50' },
            ],
            bids: [],
            min_order_size: '5',
            tick_size: '0.01',
          });
        }
        if (url.includes('/markets?'))
          return Response.json([
            {
              feeSchedule: { exponent: 1, rate: 0.05, takerOnly: true },
              feesEnabled: true,
              orderMinSize: 5,
              orderPriceMinTickSize: 0.01,
              acceptingOrders: true,
            },
          ]);
        throw new Error(`unexpected ${url}`);
      },
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await hub.close();
  });

  const params = (profileId: string): TraderArbitrageParams => ({
    profileId,
    hubUrl: hub.url,
    sharedExposure: false,
  });

  it('chờ cấu hình rồi mới nối hub; ghi lệnh giấy theo sổ lệnh + phí thật', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    await until(() => t.emitted.some((e) => e.channel === 'config_request'));
    expect(hub.consumers.size).toBe(0);
    await t.command('config', config('A'));
    await until(() => hub.consumers.has('trader:A'));

    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('s1') });
    await until(() => trades(t).length === 1);
    expect(trades(t)[0]).toMatchObject({
      id: 'A:s1',
      status: 'paper_filled',
      tierName: 'Thường',
      book: {
        tenant: 'sptpub',
        stake: 25,
        url: 'https://csgoempire.com/match-betting?bt-path=x',
        // thứ tự trận trong giải theo sàn (ACL gắn vào ref)
        tournament: { name: 'iem-cologne', no: 3, of: 12 },
      },
      detail: {
        depth: { maxPrice: 0.4, sharesAtEdge: 50 },
        sizing: { targetStake: 25 },
      },
      polymarket: {
        tokenId: 'tok-1',
        shares: 50,
        avgPrice: 0.4,
        fee: 0.6,
        url: null,
        tournament: null,
      },
      totalCost: 45.6,
      payout: 50,
    });
    const t1 = trades(t)[0];
    expect(t1.legs).toMatchObject([
      {
        venue: 'csgoempire',
        accountId: 'e',
        status: 'simulated',
        requestedAmount: 25,
        avgPrice: 2,
      },
      {
        venue: 'polymarket',
        accountId: 'p',
        status: 'simulated',
        requestedAmount: 50,
        requestedPrice: 0.4,
        marketRef: 'tok-1',
      },
    ]);
    const tm = t1.timing as Record<string, number>;
    expect(tm.receivedAt).toBeGreaterThanOrEqual(tm.signalIssuedAt);
    expect(tm.marketDataAt).toBeGreaterThanOrEqual(tm.receivedAt);
    expect(tm.decidedAt).toBeGreaterThanOrEqual(tm.marketDataAt);
    await until(() => hub.acks.length === 1);
    expect(hub.acks.length).toBe(1);

    // hub gửi lại (ít nhất một lần) → không xử lý lần hai
    hub.broadcast({ type: 'signal', kind: 'refreshed', signal: signal('s1') });
    await new Promise((r) => setTimeout(r, 100));
    expect(trades(t)).toHaveLength(1);
    await t.stop();
  });

  it('kèo hủy rồi phát lại (signalId mới, cùng cửa, cùng hạng) → đủ số lệnh thì bỏ qua im lặng', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    await t.command('config', config('A'));
    await until(() => hub.consumers.has('trader:A'));
    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('r1') });
    await until(() => trades(t).length === 1);
    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('r2') });
    await new Promise((r) => setTimeout(r, 80));
    // cửa đã đủ 1 lệnh ở hạng này → không vào, không ghi dòng "Cửa này đã vào"
    expect(trades(t).map((x) => x.status)).toEqual(['paper_filled']);
    await t.stop();
  });

  it('mỗi hạng tính riêng: cùng cửa lên hạng cao hơn thì vào tiếp', async () => {
    const vip = {
      tierId: 'vip',
      tierName: 'VIP',
      minMargin: 0.05,
      maxMargin: null,
      stake: 25,
      minStake: 5,
      maxStake: 25,
      scaleWithinTier: false,
      enabled: true,
      maxEntries: null,
      minDailyMargin: null,
    };
    const std = {
      ...vip,
      tierId: 'std',
      tierName: 'Thường',
      minMargin: 0.02,
      maxMargin: 0.05,
    };
    const t = start(new TraderArbitrageTask(), params('A'));
    await t.command('config', config('A', { stakeTable: [std, vip] }));
    await until(() => hub.consumers.has('trader:A'));
    const send = async (id: string, m: number) => {
      hub.broadcast({ type: 'signal', kind: 'issued', signal: signal(id, m) });
      await new Promise((r) => setTimeout(r, 80));
    };
    await send('m1', 0.03); // Thường
    await send('m2', 0.06); // lên VIP → vào
    await send('m3', 0.035); // tụt về Thường → đủ lệnh hạng này, im lặng
    await send('m4', 0.07); // VIP lần 2 → đủ lệnh hạng này, im lặng
    expect(trades(t).map((x) => [x.tierName, x.status])).toEqual([
      ['Thường', 'paper_filled'],
      ['VIP', 'paper_filled'],
    ]);
    await t.stop();
  });

  it('cấu hình số lệnh mỗi hạng: 2 → vào 2 lần rồi bỏ qua', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    await t.command(
      'config',
      config('A', {
        risk: {
          minNetMargin: 0.01,
          matchCapUsd: 0,
          maxSignalAgeMs: 0,
          maxEntriesPerTier: 2,
          ignoreCancelReasons: [],
          markets: null,
          oneClickMinPrice: 0,
          maxNetMargin: 0,
          minDailyMargin: 0,
        },
      }),
    );
    await until(() => hub.consumers.has('trader:A'));
    for (const id of ['q1', 'q2', 'q3']) {
      hub.broadcast({ type: 'signal', kind: 'issued', signal: signal(id) });
      await new Promise((r) => setTimeout(r, 80));
    }
    expect(trades(t).map((x) => x.status)).toEqual([
      'paper_filled',
      'paper_filled',
    ]);
    await t.stop();
  });

  it('số lệnh mỗi hạng = 0 → không giới hạn (vẫn đếm trong sổ)', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    const base = config('A');
    await t.command(
      'config',
      config('A', { risk: { ...base.risk, maxEntriesPerTier: 0 } }),
    );
    await until(() => hub.consumers.has('trader:A'));
    for (const id of ['u1', 'u2', 'u3', 'u4']) {
      hub.broadcast({ type: 'signal', kind: 'issued', signal: signal(id) });
      await new Promise((r) => setTimeout(r, 80));
    }
    expect(trades(t).map((x) => x.status)).toEqual([
      'paper_filled',
      'paper_filled',
      'paper_filled',
      'paper_filled',
    ]);
    await t.stop();
  });

  it('hạng ghi đè số lệnh = 0 → không giới hạn dù mặc định profile là 1', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    const base = config('A');
    await t.command(
      'config',
      config('A', {
        stakeTable: base.stakeTable.map((r) => ({ ...r, maxEntries: 0 })),
      }),
    );
    await until(() => hub.consumers.has('trader:A'));
    for (const id of ['v1', 'v2', 'v3']) {
      hub.broadcast({ type: 'signal', kind: 'issued', signal: signal(id) });
      await new Promise((r) => setTimeout(r, 80));
    }
    expect(trades(t).filter((x) => x.status === 'paper_filled')).toHaveLength(
      3,
    );
    await t.stop();
  });

  it('lãi/ngày: kèo 6% trận cách 6 ngày (1%/ngày) dưới ngưỡng 2%/ngày → bỏ qua; trận trong ngày → vào', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    const base = config('A');
    await t.command(
      'config',
      config('A', {
        risk: { ...base.risk, maxEntriesPerTier: 0, minDailyMargin: 0.02 },
      }),
    );
    await until(() => hub.consumers.has('trader:A'));
    const at = (id: string, startsAt: number) => {
      const s = signal(id);
      return { ...s, legs: s.legs.map((l) => ({ ...l, startsAt })) };
    };
    // 6 ngày tới giờ bắt đầu (+3 giờ ra kết quả) → ~6,1 ngày → 0,98%/ngày
    hub.broadcast({
      type: 'signal',
      kind: 'issued',
      signal: at('far', Date.now() + 6 * 86_400_000),
    });
    await until(() => trades(t).length === 1);
    expect(trades(t)[0]?.status).toBe('skipped');
    expect(trades(t)[0]?.reason).toMatch(/^LOW_DAILY_RETURN:/);
    // trận 2 giờ nữa → tính 1 ngày → 6%/ngày
    hub.broadcast({
      type: 'signal',
      kind: 'issued',
      signal: at('near', Date.now() + 2 * 3_600_000),
    });
    await until(() => trades(t).length === 2);
    expect(trades(t)[1]?.status).toBe('paper_filled');
    await t.stop();
  });

  it('lãi/ngày: hạng ghi đè 0 → tắt kiểm tra cho hạng đó dù profile đặt ngưỡng', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    const base = config('A');
    await t.command(
      'config',
      config('A', {
        stakeTable: base.stakeTable.map((r) => ({ ...r, minDailyMargin: 0 })),
        risk: { ...base.risk, minDailyMargin: 0.5 },
      }),
    );
    await until(() => hub.consumers.has('trader:A'));
    const s = signal('d1');
    hub.broadcast({
      type: 'signal',
      kind: 'issued',
      signal: {
        ...s,
        legs: s.legs.map((l) => ({
          ...l,
          startsAt: Date.now() + 10 * 86_400_000,
        })),
      },
    });
    await until(() => trades(t).length === 1);
    expect(trades(t)[0]?.status).toBe('paper_filled');
    await t.stop();
  });

  it('số lệnh riêng của hạng ghi đè mặc định profile (hạng 3 lệnh, mặc định 1)', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    const base = config('A');
    await t.command(
      'config',
      config('A', {
        stakeTable: base.stakeTable.map((r) => ({ ...r, maxEntries: 3 })),
      }),
    );
    await until(() => hub.consumers.has('trader:A'));
    for (const id of ['e1', 'e2', 'e3', 'e4']) {
      hub.broadcast({ type: 'signal', kind: 'issued', signal: signal(id) });
      await new Promise((r) => setTimeout(r, 80));
    }
    expect(trades(t).map((x) => x.status)).toEqual([
      'paper_filled',
      'paper_filled',
      'paper_filled',
    ]);
    // tăng số lệnh của hạng → cửa đang bị chặn được xét lại
    await t.command(
      'config',
      config('A', {
        stakeTable: base.stakeTable.map((r) => ({ ...r, maxEntries: 4 })),
      }),
    );
    await until(() => trades(t).length === 4);
    expect(trades(t)[3]).toMatchObject({
      id: 'A:e4:2',
      status: 'paper_filled',
    });
    await t.stop();
  });

  it('hủy vì có kèo tốt hơn → vẫn vào tiếp lệnh đang tính', async () => {
    let open!: () => void;
    bookGate = new Promise<void>((r) => (open = r));
    const t = start(new TraderArbitrageTask(), params('A'));
    await t.command('config', config('A'));
    await until(() => hub.consumers.has('trader:A'));
    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('b1') });
    await new Promise((r) => setTimeout(r, 50));
    hub.broadcast({
      type: 'cancel',
      signalId: 'b1',
      room: 'x',
      comboId: 'x',
      reason: 'better_opportunity',
    });
    await new Promise((r) => setTimeout(r, 50));
    open();
    await until(() => trades(t).length === 1);
    expect(trades(t)[0]).toMatchObject({ status: 'paper_filled' });
    await t.stop();
  });

  it('mọi trader nhận cùng kèo; giới hạn tổng theo trận áp cho tất cả', async () => {
    const ledger = new InMemoryExposureLedger();
    const a = start(new TraderArbitrageTask({ ledger }), params('A'));
    const b = start(new TraderArbitrageTask({ ledger }), params('B'));
    await a.command('config', config('A', { matchExposureCapUsd: 60 }));
    await b.command('config', config('B', { matchExposureCapUsd: 60 }));
    await until(() => hub.consumers.size === 2);

    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('s2') });
    await until(() => trades(a).length === 1 && trades(b).length === 1);
    const all = [...trades(a), ...trades(b)];
    const filled = all.filter((x) => x.status === 'paper_filled');
    expect(filled.length).toBeGreaterThanOrEqual(1);
    const spent = filled.reduce((s, x) => s + (x.totalCost as number), 0);
    expect(spent).toBeLessThanOrEqual(60 + 1e-9);
    for (const x of all.filter((y) => y.status !== 'paper_filled'))
      expect(String(x.reason)).toMatch(/^CAP_REACHED|^BUDGET_EXHAUSTED/);
    await a.stop();
    await b.stop();
  });

  it('kèo bị hủy vì lệch giờ khi đang tính → ghi giờ từng chân lúc hủy + giờ lúc phát', async () => {
    let open!: () => void;
    bookGate = new Promise<void>((r) => (open = r));
    const t = start(new TraderArbitrageTask(), params('A'));
    await t.command('config', config('A'));
    await until(() => hub.consumers.has('trader:A'));
    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('s7') });
    await new Promise((r) => setTimeout(r, 50));
    const detail = {
      startTimes: [
        { tenant: 'sptpub', startsAt: 1_000_000 + 2_700_000 },
        { tenant: 'polymarket', startsAt: 1_000_000 },
      ],
      startDriftMs: 2_700_000,
      maxStartDriftMs: 1_200_000,
    };
    hub.broadcast({
      type: 'cancel',
      signalId: 's7',
      room: 'room:lol:alpha~beta:match-winner',
      comboId: 'x',
      reason: 'start_time_mismatch',
      detail,
    });
    await until(() => trades(t).length === 1);
    expect(trades(t)[0]).toMatchObject({
      status: 'cancelled',
      book: { startsAt: 1_000_000 },
      polymarket: { startsAt: null },
      detail: {
        cancel: { reason: 'start_time_mismatch', ignored: false, detail },
      },
    });
    open();
    await t.stop();
  });

  it('kèo bị hủy khi đang đọc sổ lệnh → cancelled, không vào lệnh', async () => {
    let open!: () => void;
    bookGate = new Promise<void>((r) => (open = r));
    const t = start(new TraderArbitrageTask(), params('A'));
    await t.command('config', config('A'));
    await until(() => hub.consumers.has('trader:A'));

    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('s3') });
    await new Promise((r) => setTimeout(r, 50));
    hub.broadcast({
      type: 'cancel',
      signalId: 's3',
      room: 'room:lol:alpha~beta:match-winner',
      comboId: 'x',
      reason: 'margin_decreased',
    });
    await until(() => trades(t).length === 1);
    expect(trades(t)[0]).toMatchObject({ status: 'cancelled' });
    expect(String(trades(t)[0].reason)).toContain('margin_decreased');
    open();
    await t.stop();
  });

  it('hạng không được chọn trong profile → bỏ qua TIER_NOT_SELECTED', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    const base = config('A');
    await t.command(
      'config',
      config('A', {
        stakeTable: base.stakeTable.map((r) => ({ ...r, enabled: false })),
      }),
    );
    await until(() => hub.consumers.has('trader:A'));
    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('s5') });
    await until(() => trades(t).length === 1);
    expect(trades(t)[0]).toMatchObject({
      status: 'skipped',
      tierName: 'Thường',
    });
    expect(trades(t)[0]?.reason).toMatch(/^TIER_NOT_SELECTED:/);
    await t.stop();
  });

  it('margin kèo vượt ngưỡng "đẹp bất thường" → bỏ qua SUSPICIOUS_MARGIN, không đọc sổ lệnh', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    const base = config('A');
    await t.command(
      'config',
      config('A', { risk: { ...base.risk, maxNetMargin: 0.01 } }),
    );
    await until(() => hub.consumers.has('trader:A'));
    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('s6m') });
    await until(() => trades(t).length === 1);
    expect(trades(t)[0]?.status).toBe('skipped');
    expect(trades(t)[0]?.reason).toMatch(
      /^SUSPICIOUS_MARGIN: margin kèo .*% > ngưỡng 1\.00% — nghi giá cũ$/,
    );
    await t.stop();
  });

  it('market không được chọn trong profile → bỏ qua MARKET_NOT_SELECTED', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    const base = config('A');
    await t.command(
      'config',
      config('A', { risk: { ...base.risk, markets: ['map-handicap-p1.5'] } }),
    );
    await until(() => hub.consumers.has('trader:A'));
    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('s6') });
    await until(() => trades(t).length === 1);
    expect(trades(t)[0]?.status).toBe('skipped');
    expect(trades(t)[0]?.reason).toMatch(/^MARKET_NOT_SELECTED:/);
    await t.stop();
  });

  it('hạng chồng nhau: chỉ chọn trong hạng được tick (VIP không tick, VIP-auto tick → vào VIP-auto)', async () => {
    const row = {
      maxEntries: null,
      minDailyMargin: null,
      minStake: 5,
      maxStake: 25,
      stake: 25,
      scaleWithinTier: false,
      maxMargin: null,
    };
    const t = start(new TraderArbitrageTask(), params('A'));
    await t.command(
      'config',
      config('A', {
        stakeTable: [
          // VIP cận dưới cao hơn nhưng không tick → không được chọn
          {
            ...row,
            tierId: 'vip',
            tierName: 'VIP',
            minMargin: 0.03,
            enabled: false,
          },
          {
            ...row,
            tierId: 'auto',
            tierName: 'VIP auto',
            minMargin: 0.02,
            enabled: true,
          },
        ],
      }),
    );
    await until(() => hub.consumers.has('trader:A'));
    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('s8') });
    await until(() => trades(t).length === 1);
    expect(trades(t)[0]).toMatchObject({ tierName: 'VIP auto' });
    expect(trades(t)[0]?.reason ?? '').not.toMatch(/TIER_NOT_SELECTED/);
    await t.stop();
  });

  it('đổi cấu hình → kèo còn sống bị bỏ qua vì cấu hình được xét lại một lần (id mới)', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    const base = config('A');
    await t.command(
      'config',
      config('A', { risk: { ...base.risk, markets: ['map-handicap-p1.5'] } }),
    );
    await until(() => hub.consumers.has('trader:A'));
    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('s9') });
    await until(() => trades(t).length === 1);
    expect(trades(t)[0]?.reason).toMatch(/^MARKET_NOT_SELECTED/);

    // đổi phần cấu hình KHÔNG liên quan → không xét lại
    await t.command(
      'config',
      config('A', {
        risk: {
          ...base.risk,
          markets: ['map-handicap-p1.5'],
          maxSignalAgeMs: 1,
        },
      }),
    );
    await new Promise((r) => setTimeout(r, 80));
    expect(trades(t)).toHaveLength(1);

    // mở market → xét lại ngay, không cần kèo phát mới
    await t.command('config', config('A'));
    await until(() => trades(t).length === 2);
    expect(trades(t)[1]).toMatchObject({
      id: 'A:s9:2',
      status: 'paper_filled',
    });
    // cấu hình gửi lại y hệt → không xét lại nữa
    await t.command('config', config('A'));
    await new Promise((r) => setTimeout(r, 80));
    expect(trades(t)).toHaveLength(2);
    await t.stop();
  });

  it('làm mới cùng kèo → vào tiếp mỗi lần tới đủ số lệnh của hạng; reset_seen không vượt số lệnh', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    const base = config('A');
    const withMax = (n: number) =>
      config('A', {
        stakeTable: base.stakeTable.map((r) => ({ ...r, maxEntries: n })),
      });
    await t.command('config', withMax(3));
    await until(() => hub.consumers.has('trader:A'));
    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('s10') });
    await until(() => trades(t).length === 1);
    for (let i = 0; i < 4; i++) {
      hub.broadcast({
        type: 'signal',
        kind: 'refreshed',
        signal: signal('s10'),
      });
      await new Promise((r) => setTimeout(r, 80));
    }
    // 3 lệnh (đủ số lệnh của hạng), lần làm mới thứ 3, 4 im lặng
    expect(trades(t).map((x) => [x.id, x.status])).toEqual([
      ['A:s10', 'paper_filled'],
      ['A:s10:2', 'paper_filled'],
      ['A:s10:3', 'paper_filled'],
    ]);
    await t.command('reset_seen', {});
    await new Promise((r) => setTimeout(r, 80));
    expect(trades(t)).toHaveLength(3);
    // tăng số lệnh của hạng → vào tiếp ngay
    await t.command('config', withMax(4));
    await until(() => trades(t).length === 4);
    expect(trades(t)[3]).toMatchObject({ status: 'paper_filled' });
    await t.stop();
  });

  it('mỗi lần phát (mới/làm mới) là một lệnh: lần trước bị bỏ (hết hạn mức) vẫn xét lại; hub giao lại cùng bản tin không tính', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    const base = config('A');
    // hạn mức trận của profile quá nhỏ → bỏ qua vì hạn mức
    await t.command(
      'config',
      config('A', { risk: { ...base.risk, matchCapUsd: 1 } }),
    );
    await until(() => hub.consumers.has('trader:A'));
    const first = signal('s20');
    hub.broadcast({ type: 'signal', kind: 'issued', signal: first });
    await until(() => trades(t).length === 1);
    expect(trades(t)[0]?.status).toBe('skipped');
    // hub giao lại CÙNG bản tin (cùng issuedAt) → không thành lệnh mới
    hub.broadcast({ type: 'signal', kind: 'issued', signal: first });
    await new Promise((r) => setTimeout(r, 80));
    expect(trades(t)).toHaveLength(1);
    // publisher làm mới kèo (mốc mới) → xét như một lệnh mới, vẫn áp hạn mức
    hub.broadcast({
      type: 'signal',
      kind: 'refreshed',
      signal: { ...first, issuedAt: first.issuedAt + 1 },
    });
    await until(() => trades(t).length === 2);
    expect(trades(t)[1]).toMatchObject({ id: 'A:s20:2', status: 'skipped' });
    await t.stop();
  });

  it('bỏ vì sổ lệnh (hết lãi) → xét lại theo nhịp, cùng lý do không ghi thêm dòng; sổ có lãi thì vào', async () => {
    const t = start(
      new TraderArbitrageTask({ bookRecheckMs: 40 }),
      params('A'),
    );
    asks = [{ price: '0.6', size: '1000' }];
    await t.command('config', config('A'));
    await until(() => hub.consumers.has('trader:A'));
    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('s30') });
    await until(() => trades(t).length === 1);
    expect(trades(t)[0]?.reason).toMatch(/^NO_EDGE/);
    // vài nhịp xét lại vẫn hết lãi → không ghi thêm
    await new Promise((r) => setTimeout(r, 150));
    expect(trades(t)).toHaveLength(1);
    // sổ lệnh có lãi trở lại → nhịp kế tiếp vào lệnh
    asks = null;
    await until(() => trades(t).length === 2);
    expect(trades(t)[1]).toMatchObject({ status: 'paper_filled' });
    await t.stop();
  });

  it('nâng hạn mức trận → kèo bị chặn vì hạn mức xét lại ngay', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    const base = config('A');
    await t.command(
      'config',
      config('A', { risk: { ...base.risk, matchCapUsd: 1 } }),
    );
    await until(() => hub.consumers.has('trader:A'));
    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('s31') });
    await until(() => trades(t).length === 1);
    expect(trades(t)[0]?.status).toBe('skipped');
    await t.command(
      'config',
      config('A', { risk: { ...base.risk, matchCapUsd: 500 } }),
    );
    await until(() => trades(t).length === 2);
    expect(trades(t)[1]).toMatchObject({ status: 'paper_filled' });
    await t.stop();
  });

  it('trả lại sổ phơi nhiễm (exposure_freed) → cửa đã đủ số lệnh được vào tiếp', async () => {
    const ledger = new InMemoryExposureLedger();
    const t = start(new TraderArbitrageTask({ ledger }), params('A'));
    await t.command('config', config('A'));
    await until(() => hub.consumers.has('trader:A'));
    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('s32') });
    await until(() => trades(t).length === 1);
    // kèo khác mã cùng cửa → đủ số lệnh, bỏ qua im lặng
    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('s33') });
    await new Promise((r) => setTimeout(r, 80));
    expect(trades(t)).toHaveLength(1);
    // admin đặt lại số lệnh của cửa → trader được báo, xét lại
    const slots = (ledger as unknown as { _slots: Map<string, unknown> })
      ._slots;
    for (const k of slots.keys()) await ledger.giveBack(k);
    await t.command('exposure_freed', {});
    await until(() => trades(t).length === 2);
    expect(trades(t)[1]).toMatchObject({
      signalId: 's33',
      status: 'paper_filled',
    });
    await t.stop();
  });

  it('trader khởi động lại: kèo còn sống đã có dấu "đã xử lý" vẫn được xét lại một lần (id kèm mã phiên)', async () => {
    const ledger = new InMemoryExposureLedger();
    const base = config('A');
    const cfg = config('A', { risk: { ...base.risk, matchCapUsd: 1 } });
    const t1 = start(new TraderArbitrageTask({ ledger }), params('A'));
    await t1.command('config', cfg);
    await until(() => hub.consumers.has('trader:A'));
    const sig = signal('s40');
    hub.broadcast({ type: 'signal', kind: 'issued', signal: sig });
    await until(() => trades(t1).length === 1);
    expect(trades(t1)[0]?.status).toBe('skipped');
    await t1.stop();
    hub.consumers.delete('trader:A');

    // phiên mới, cùng sổ (Redis) — hub gửi lại kèo còn sống, bản lưu cũ
    const t2 = start(new TraderArbitrageTask({ ledger }), params('A'));
    await t2.command(
      'config',
      config('A', { risk: { ...base.risk, matchCapUsd: 500 } }),
    );
    await until(() => hub.consumers.has('trader:A'));
    hub.broadcast({
      type: 'signal',
      kind: 'refreshed',
      signal: { ...sig, issuedAt: sig.issuedAt - 20_000 },
    });
    await until(() => trades(t2).length === 1);
    expect(trades(t2)[0]).toMatchObject({ status: 'paper_filled' });
    expect(String(trades(t2)[0]?.id)).toMatch(/^A:s40:[a-z0-9]+\.2$/);
    // giao lại cùng bản tin → không xét nữa
    hub.broadcast({
      type: 'signal',
      kind: 'refreshed',
      signal: { ...sig, issuedAt: sig.issuedAt - 20_000 },
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(trades(t2)).toHaveLength(1);
    await t2.stop();
  });

  it('kèo bị bộ lọc profile loại (market) → làm mới không ghi thêm dòng', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    const base = config('A');
    await t.command(
      'config',
      config('A', { risk: { ...base.risk, markets: ['handicap'] } }),
    );
    await until(() => hub.consumers.has('trader:A'));
    const first = signal('s21');
    hub.broadcast({ type: 'signal', kind: 'issued', signal: first });
    await until(() => trades(t).length === 1);
    hub.broadcast({
      type: 'signal',
      kind: 'refreshed',
      signal: { ...first, issuedAt: first.issuedAt + 1 },
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(trades(t)).toHaveLength(1);
    await t.stop();
  });

  it('"quá cũ" là tạm thời: hub gửi lại bản cũ khi nối lại → lần làm mới kế tiếp vẫn được xét', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    const base = config('A');
    await t.command(
      'config',
      config('A', { risk: { ...base.risk, maxSignalAgeMs: 3_000 } }),
    );
    await until(() => hub.consumers.has('trader:A'));
    // bản lưu lúc làm mới 13 giây trước (hub gửi lại sau khi trader nối lại)
    hub.broadcast({
      type: 'signal',
      kind: 'refreshed',
      signal: { ...signal('s13'), issuedAt: Date.now() - 13_000 },
    });
    await until(() => trades(t).length === 1);
    expect(trades(t)[0]?.reason).toMatch(/^STALE_SIGNAL/);
    // hub làm mới kèo (cùng mã, mốc mới) → xét lại
    hub.broadcast({ type: 'signal', kind: 'refreshed', signal: signal('s13') });
    await until(() => trades(t).length === 2);
    expect(trades(t)[1]).toMatchObject({
      id: 'A:s13:2',
      status: 'paper_filled',
    });
    // làm mới tiếp → đã vào, không xét nữa
    hub.broadcast({ type: 'signal', kind: 'refreshed', signal: signal('s13') });
    await new Promise((r) => setTimeout(r, 80));
    expect(trades(t)).toHaveLength(2);
    await t.stop();
  });

  it('On click: giá bán thấp nhất ≥ ngưỡng → bot không vào, gửi phân tích; người bấm thì vào (ghi người vào)', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    const base = config('A');
    // sổ lệnh giả: ask thấp nhất 0.40 → ngưỡng 0.30 thì chuyển On click
    await t.command(
      'config',
      config('A', { risk: { ...base.risk, oneClickMinPrice: 0.3 } }),
    );
    await until(() => hub.consumers.has('trader:A'));
    const board = () =>
      t.emitted.filter((e) => e.channel === 'oneclick').map((e) => e.payload);
    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('oc1') });
    await until(() => board().length === 1);
    expect(board()[0]).toMatchObject({
      profileId: 'A',
      signalId: 'oc1',
      candidate: { status: 'paper_filled', detail: { minAsk: 0.4 } },
    });
    // Lệnh giấy: đúng một dòng "chuyển On click"
    await until(() => trades(t).length === 1);
    expect(trades(t)[0]?.reason).toMatch(/^ONE_CLICK/);
    // làm mới → cập nhật phân tích, không ghi thêm dòng
    hub.broadcast({ type: 'signal', kind: 'refreshed', signal: signal('oc1') });
    await until(() => board().length === 2);
    expect(trades(t)).toHaveLength(1);
    // người bấm vào lệnh
    await t.command('manual_enter', { signalId: 'oc1', by: 'alice' });
    await until(() => trades(t).length === 2);
    expect(trades(t)[1]).toMatchObject({
      status: 'paper_filled',
      detail: { manual: { by: 'alice' } },
    });
    // kèo đã vào → gỡ khỏi bảng
    await until(() => board().some((b) => b.removed === true));
    // lý do rời bảng cho lịch sử: người bấm, kết quả, người vào
    expect(board().find((b) => b.removed === true)).toMatchObject({
      reason: 'manual:paper_filled',
      by: 'alice',
    });
    await expect(
      t.command('manual_enter', { signalId: 'khong-co', by: 'alice' }),
    ).rejects.toThrow(/SIGNAL_NOT_LIVE/);
    await t.stop();
  });

  it('On click: người nhập tiền mục tiêu → vào theo tiền đó, vẫn taker (sổ mỏng thì vào ít hơn)', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    const base = config('A');
    await t.command(
      'config',
      config('A', {
        risk: { ...base.risk, oneClickMinPrice: 0.3, maxEntriesPerTier: 5 },
      }),
    );
    await until(() => hub.consumers.has('trader:A'));
    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('oc3') });
    await until(() => trades(t).length === 1);
    // nhập 10$: odds 2 → cần 20 share, mức 0.40 có 50 share → vào đủ 10$
    await t.command('manual_enter', {
      signalId: 'oc3',
      by: 'bob',
      targetStake: 10,
    });
    await until(() => trades(t).length === 2);
    expect(trades(t)[1]).toMatchObject({
      status: 'paper_filled',
      book: { stake: 10 },
      polymarket: { shares: 20 },
      detail: { manual: { by: 'bob', targetStake: 10 }, targetStake: 10 },
    });
    // nhập 80$: cần 160 share nhưng chỉ mức 0.40 (50 share) còn lãi → dừng ở 25$
    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('oc4') });
    await until(() => trades(t).length === 3);
    await t.command('manual_enter', {
      signalId: 'oc4',
      by: 'bob',
      targetStake: 80,
    });
    await until(() => trades(t).length === 4);
    expect(trades(t)[3]).toMatchObject({
      status: 'paper_filled',
      book: { stake: 25 },
      polymarket: { shares: 50 },
      detail: { limitedBy: 'depth' },
    });
    await expect(
      t.command('manual_enter', {
        signalId: 'oc4',
        by: 'bob',
        targetStake: -1,
      }),
    ).rejects.toThrow(/TARGET_STAKE_INVALID/);
    await t.stop();
  });

  it('On click: kèo bị hủy → rời bảng kèm lý do hủy', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    const base = config('A');
    await t.command(
      'config',
      config('A', { risk: { ...base.risk, oneClickMinPrice: 0.3 } }),
    );
    await until(() => hub.consumers.has('trader:A'));
    const board = () =>
      t.emitted.filter((e) => e.channel === 'oneclick').map((e) => e.payload);
    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('oc2') });
    await until(() => board().length === 1);
    hub.broadcast({
      type: 'cancel',
      signalId: 'oc2',
      reason: 'margin_decreased',
    });
    await until(() => board().length === 2);
    expect(board()[1]).toEqual({
      profileId: 'A',
      signalId: 'oc2',
      removed: true,
      reason: 'cancelled:margin_decreased',
    });
    await t.stop();
  });

  it('profile tắt → ghi bỏ qua kèm lý do', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    await t.command(
      'config',
      config('A', { active: false, inactiveReason: 'PROFILE_DISABLED' }),
    );
    await until(() => hub.consumers.has('trader:A'));
    hub.broadcast({ type: 'signal', kind: 'issued', signal: signal('s4') });
    await until(() => trades(t).length === 1);
    expect(trades(t)[0]).toMatchObject({
      status: 'skipped',
      reason: 'INACTIVE: PROFILE_DISABLED',
    });
    await t.stop();
  });

  it('cấu hình sai profile bị từ chối', async () => {
    const t = start(new TraderArbitrageTask(), params('A'));
    await expect(t.command('config', config('B'))).rejects.toThrow(
      /PROFILE_MISMATCH/,
    );
    await t.stop();
  });

  it('matchOf gộp mọi market của cùng trận', () => {
    expect(matchOf('room:cs2:a~b:map-1-winner')).toBe('cs2:a~b');
  });

  it.each([false, true])(
    'live: cash cancellation applies to auto/manual=%s and releases exposure',
    async (manual) => {
      const ledger = new InMemoryExposureLedger();
      const execute = vi.fn((): Promise<ExecutionResult> =>
        Promise.resolve({
          status: 'cancelled',
          reason: 'INSUFFICIENT_CASH: hủy cả hai chân',
          submitted: false,
          fills: [],
          cash: [{ venue: 'polymarket', available: 0, required: 20 }],
        }),
      );
      const t = start(
        new TraderArbitrageTask({ ledger, executor: { execute, close() {} } }),
        params('A'),
      );
      const cfg = config('A', {
        mode: 'live',
        matchExposureCapUsd: 100,
        execution: {
          empire: {
            browserProfile: 'test',
            token: 'token',
            cookie: 'cookie',
            expiresAt: Date.now() + 1_800_000,
            apiUrl: 'https://api-h-c7818b61-608.sptpub.com',
            brandId: '2432911154364948480',
            sessionId: 'test',
            minBet: 0.1,
          },
          polymarket: {
            walletAddress: 'test',
            funderAddress: null,
            secretCipher: 'test',
          },
        },
      });
      if (manual) cfg.risk.oneClickMinPrice = 0.3;
      await t.command('config', cfg);
      await until(() => hub.consumers.has('trader:A'));
      hub.broadcast({
        type: 'signal',
        kind: 'issued',
        signal: signal('cash-test'),
      });
      if (manual) {
        await until(() => t.emitted.some((e) => e.channel === 'oneclick'));
        expect(execute).not.toHaveBeenCalled();
        await t.command('manual_enter', { signalId: 'cash-test', by: 'alice' });
      }
      await until(() => trades(t).some((e) => e.status === 'cancelled'));
      expect(execute).toHaveBeenCalledOnce();
      const result = trades(t).find((e) => e.status === 'cancelled')!;
      expect(result).toMatchObject({
        mode: 'live',
        totalCost: 0,
        book: { stake: 0 },
        polymarket: { shares: 0 },
      });
      expect(result.legs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ venue: 'csgoempire', status: 'cancelled' }),
          expect.objectContaining({ venue: 'polymarket', status: 'cancelled' }),
        ]),
      );
      expect(await ledger.used(['match:lol:alpha~beta'])).toEqual([0]);
      expect(
        await ledger.count(
          'entry:A:room:lol:alpha~beta:match-winner:sptpub>0|polymarket>1:std',
        ),
      ).toBe(0);
      // lệnh thật luôn kèm một bản giấy đối chiếu, cùng tài khoản, trỏ về lệnh thật
      const shadow = trades(t).find((e) => e.mode === 'shadow')!;
      expect(shadow).toMatchObject({
        id: `${String(result.id)}:shadow`,
        status: 'paper_filled',
        detail: { shadowOf: result.id },
        csgoempireAccountId: result.csgoempireAccountId,
        polymarketAccountId: result.polymarketAccountId,
      });
      expect(shadow.totalCost).toBeGreaterThan(0);
      await t.stop();
    },
  );
});
