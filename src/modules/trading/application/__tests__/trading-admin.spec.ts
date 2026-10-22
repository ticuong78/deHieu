import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STAKE_PLAN, type StakeTier } from '../../domain/stake-plan.js';
import type { TradingAccount } from '../../domain/trading-account.js';
import {
  DEFAULT_RISK_LIMITS,
  DEFAULT_STRATEGY,
  type TraderProfile,
} from '../../domain/trader-profile.js';
import {
  DEFAULT_TRADING_SETTINGS,
  type TradingSettings,
} from '../../domain/trading-settings.js';
import { TradingAdmin, type ProfileInput } from '../trading-admin.js';
import { TraderConfigSync } from '../trader-config.sync.js';
import type { TraderRuntimeConfig } from '../trader-config.js';
import type {
  RunningTrader,
  SecretCipher,
  TradeAttemptRepository,
  TraderTaskGateway,
  TradingSettingsStore,
} from '../trading.ports.js';

class MemRepo<T extends { id: string }> {
  readonly rows = new Map<string, T>();
  list = () => Promise.resolve([...this.rows.values()]);
  get = (id: string) => Promise.resolve(this.rows.get(id) ?? null);
  save = (x: T) => {
    this.rows.set(x.id, x);
    return Promise.resolve();
  };
  delete = (id: string) => Promise.resolve(this.rows.delete(id));
}

const TIERS: StakeTier[] = [
  { id: 'vip', name: 'VIP', minMargin: 0.05, maxMargin: null },
  { id: 'std', name: 'Thường', minMargin: 0.02, maxMargin: 0.05 },
];

const fakeCipher = (ok: boolean): SecretCipher => ({
  available: () => ok,
  encrypt: (p) => `enc(${p})`,
  decrypt: (c) => c.slice(4, -1),
});

class FakeGateway implements TraderTaskGateway {
  running: RunningTrader[] = [];
  pushed: { taskId: string; config: TraderRuntimeConfig }[] = [];
  listRunning = () => Promise.resolve(this.running);
  push = (taskId: string, config: TraderRuntimeConfig) => {
    this.pushed.push({ taskId, config });
    return Promise.resolve(true);
  };
  commands: { taskId: string; name: string }[] = [];
  command = (taskId: string, name: string) => {
    this.commands.push({ taskId, name });
    return Promise.resolve(true);
  };
}

describe('TradingAdmin: xóa lệnh', () => {
  const calls: { op: string; f: unknown }[] = [];
  const trades = {
    count: (f: unknown) => {
      calls.push({ op: 'count', f });
      return Promise.resolve(5);
    },
    purge: (f: unknown) => {
      calls.push({ op: 'purge', f });
      return Promise.resolve(5);
    },
    delete: (id: string) => Promise.resolve(id === 'have'),
  } as unknown as TradeAttemptRepository;
  const admin = new TradingAdmin(
    new MemRepo<TradingAccount>(),
    new MemRepo<TraderProfile>(),
    trades,
    {} as TradingSettingsStore,
    { listTiers: () => Promise.resolve(TIERS) },
    fakeCipher(true),
    {
      resetSeen: (profileId?: string) => {
        calls.push({ op: 'resetSeen', f: profileId ?? null });
        return Promise.resolve(1);
      },
    } as unknown as TraderConfigSync,
  );
  beforeEach(() => (calls.length = 0));

  it('bắt buộc chọn trạng thái hoặc all; không cho cả hai', async () => {
    expect(await admin.purgeTrades({})).toMatchObject({ status: 'FAILED' });
    expect(await admin.purgeTrades({ statuses: [] })).toMatchObject({
      status: 'FAILED',
    });
    expect(
      await admin.purgeTrades({ all: true, statuses: ['skipped'] }),
    ).toMatchObject({ status: 'FAILED' });
    expect(calls).toEqual([]);
  });

  it('kết hợp nhiều trạng thái (bỏ trùng) + profile; all = không lọc trạng thái', async () => {
    expect(
      await admin.purgeTrades({
        statuses: ['skipped', 'error', 'skipped'],
        profileId: 'p1',
      }),
    ).toEqual({ status: 'SUCEED', data: { matched: 5, deleted: 5 } });
    expect(calls[1]).toEqual({
      op: 'purge',
      f: { statuses: ['skipped', 'error'], profileId: 'p1' },
    });
    expect(calls.some((c) => c.op === 'resetSeen')).toBe(false);
    calls.length = 0;
    // xóa toàn bộ → báo trader xét lại kèo còn sống
    expect(await admin.purgeTrades({ all: true })).toEqual({
      status: 'SUCEED',
      data: { matched: 5, deleted: 5, resetTasks: 1 },
    });
    expect(calls[1]).toEqual({ op: 'purge', f: {} });
    expect(calls[2]).toEqual({ op: 'resetSeen', f: null });
    calls.length = 0;
    await admin.purgeTrades({ all: true, profileId: 'p1' });
    expect(calls[2]).toEqual({ op: 'resetSeen', f: 'p1' });
    // toàn bộ nhưng có mốc thời gian → không phải "toàn bộ", không xét lại
    calls.length = 0;
    await admin.purgeTrades({ all: true, before: 1 });
    expect(calls.some((c) => c.op === 'resetSeen')).toBe(false);
  });

  it('TraderConfigSync.resetSeen: chỉ gửi tới task của profile', async () => {
    const gw = new FakeGateway();
    gw.running = [
      { taskId: 't-a', profileId: 'a' },
      { taskId: 't-b', profileId: 'b' },
    ];
    const sync = new TraderConfigSync(
      new MemRepo<TradingAccount>(),
      new MemRepo<TraderProfile>(),
      {} as TradingSettingsStore,
      { listTiers: () => Promise.resolve(TIERS) },
      gw,
    );
    expect(await sync.resetSeen('b')).toBe(1);
    expect(gw.commands).toEqual([{ taskId: 't-b', name: 'reset_seen' }]);
    expect(await sync.resetSeen()).toBe(2);
  });

  it('dryRun chỉ đếm', async () => {
    expect(
      await admin.purgeTrades({ statuses: ['paper_filled'], dryRun: true }),
    ).toEqual({ status: 'SUCEED', data: { matched: 5, deleted: 0 } });
    expect(calls.map((c) => c.op)).toEqual(['count']);
  });

  it('xóa một lệnh', async () => {
    expect((await admin.deleteTrade('have')).status).toBe('SUCEED');
    expect((await admin.deleteTrade('none')).status).toBe('NOT_FOUND');
  });
});

describe('TradingAdmin + TraderConfigSync', () => {
  let accounts: MemRepo<TradingAccount>;
  let profiles: MemRepo<TraderProfile>;
  let settings: TradingSettings;
  let gateway: FakeGateway;
  let admin: TradingAdmin;
  let sync: TraderConfigSync;

  const make = (cipherOk = true) => {
    const settingsStore: TradingSettingsStore = {
      get: () => Promise.resolve(settings),
      save: (s) => {
        settings = s;
        return Promise.resolve();
      },
    };
    const tiers = { listTiers: () => Promise.resolve(TIERS) };
    sync = new TraderConfigSync(
      accounts,
      profiles,
      settingsStore,
      tiers,
      gateway,
    );
    admin = new TradingAdmin(
      accounts,
      profiles,
      {} as TradeAttemptRepository,
      settingsStore,
      tiers,
      fakeCipher(cipherOk),
      sync,
    );
  };

  beforeEach(() => {
    accounts = new MemRepo();
    profiles = new MemRepo();
    settings = DEFAULT_TRADING_SETTINGS;
    gateway = new FakeGateway();
    make();
  });

  const addAccounts = async () => {
    const e = await admin.saveAccount(null, {
      label: 'Empire 1',
      enabled: true,
      config: { venue: 'csgoempire', browserProfile: 'empire-1' },
    });
    const p = await admin.saveAccount(null, {
      label: 'Poly 1',
      enabled: true,
      config: {
        venue: 'polymarket',
        walletAddress: `0x${'a'.repeat(40)}`,
        funderAddress: null,
      },
      privateKey: 'B'.repeat(64),
    });
    if (e.status !== 'SUCEED' || p.status !== 'SUCEED')
      throw new Error('setup');
    return { empire: e.data, poly: p.data };
  };

  const profileInput = (empire: string, poly: string): ProfileInput => ({
    name: 'Trader A',
    enabled: true,
    mode: 'paper',
    csgoempireAccountId: empire,
    polymarketAccountId: poly,
    stakePlan: {
      ...DEFAULT_STAKE_PLAN,
      trend: 'up',
      baseStake: 40,
      stepPct: 0.5,
    },
    strategy: DEFAULT_STRATEGY,
    risk: DEFAULT_RISK_LIMITS,
  });

  it('mã hóa private key, API chỉ báo hasSecret', async () => {
    const { poly } = await addAccounts();
    expect(poly.hasSecret).toBe(true);
    expect(JSON.stringify(poly)).not.toContain('bbbb');
    expect(accounts.rows.get(poly.id)?.secretCipher).toBe(
      `enc(0x${'b'.repeat(64)})`,
    );

    // sửa không gửi key = giữ key cũ
    const again = await admin.saveAccount(poly.id, {
      label: 'Poly 1',
      enabled: false,
      config: poly.config,
    });
    expect(again).toMatchObject({
      status: 'SUCEED',
      data: { hasSecret: true, enabled: false },
    });
  });

  it('encrypts csgoempire credentials, never returns them, and retains them on an ordinary edit', async () => {
    const result = await admin.saveAccount(null, {
      label: 'Auto login',
      enabled: true,
      config: { venue: 'csgoempire', browserProfile: 'auto-login' },
      loginUsername: 'saved-user',
      loginPassword: ' password with spaces ',
    });
    if (result.status !== 'SUCEED') throw new Error('setup');
    expect(result.data.hasSecret).toBe(true);
    expect(JSON.stringify(result.data)).not.toMatch(
      /saved-user|password with spaces/,
    );
    const encrypted = accounts.rows.get(result.data.id)?.secretCipher;
    expect(encrypted).toBe(
      'enc({"username":"saved-user","password":" password with spaces "})',
    );
    await admin.saveAccount(result.data.id, {
      label: 'Renamed',
      enabled: true,
      config: result.data.config,
    });
    expect(accounts.rows.get(result.data.id)?.secretCipher).toBe(encrypted);
    expect(JSON.stringify(await admin.listAccounts())).not.toMatch(
      /saved-user|password with spaces/,
    );
  });

  it('requires both login fields and a master encryption key', async () => {
    const input = {
      label: 'Auto login',
      enabled: true,
      config: { venue: 'csgoempire' as const, browserProfile: 'auto-login' },
      loginUsername: 'user',
    };
    expect(await admin.saveAccount(null, input)).toMatchObject({
      status: 'FAILED',
    });
    make(false);
    expect(
      await admin.saveAccount(null, { ...input, loginPassword: 'password' }),
    ).toMatchObject({ status: 'FAILED' });
    expect(accounts.rows.size).toBe(0);
  });

  it('không có TRADING_SECRET_KEY → từ chối lưu private key', async () => {
    make(false);
    const r = await admin.saveAccount(null, {
      label: 'Poly',
      enabled: true,
      config: {
        venue: 'polymarket',
        walletAddress: `0x${'a'.repeat(40)}`,
        funderAddress: null,
      },
      privateKey: 'c'.repeat(64),
    });
    expect(r).toMatchObject({ status: 'FAILED' });
    expect(r.status === 'FAILED' && r.reason).toMatch(/^SECRET_KEY_MISSING/);
  });

  it('profile phải ghép đúng 1 csgoempire + 1 polymarket; tài khoản đang dùng không xóa được', async () => {
    const { empire, poly } = await addAccounts();
    const wrong = await admin.saveProfile(
      null,
      profileInput(poly.id, empire.id),
    );
    expect(wrong.status).toBe('FAILED');
    const ok = await admin.saveProfile(null, profileInput(empire.id, poly.id));
    expect(ok.status).toBe('SUCEED');
    expect((await admin.deleteAccount(empire.id)).status).toBe('FAILED');
  });

  it('nhiều tài khoản mỗi sàn: mỗi profile nhận đúng cặp của mình, không lẫn chéo', async () => {
    const ids: Record<string, string> = {};
    for (const n of [1, 2, 3]) {
      const e = await admin.saveAccount(null, {
        label: `Empire ${n}`,
        enabled: true,
        config: { venue: 'csgoempire', browserProfile: `empire-${n}` },
        loginUsername: `user${n}@example.test`,
        loginPassword: 'pw',
      });
      const p = await admin.saveAccount(null, {
        label: `Poly ${n}`,
        enabled: true,
        config: {
          venue: 'polymarket',
          walletAddress: `0x${String(n).repeat(40)}`,
          funderAddress: null,
        },
        privateKey: String(n).repeat(64),
      });
      if (e.status !== 'SUCEED' || p.status !== 'SUCEED')
        throw new Error('setup');
      ids[`e${n}`] = e.data.id;
      ids[`p${n}`] = p.data.id;
    }
    // ghép chéo có chủ đích: A = E1+P3, B = E3+P1, C = E2+P2
    const pairs = { A: ['e1', 'p3'], B: ['e3', 'p1'], C: ['e2', 'p2'] };
    gateway.running = [];
    for (const [name, [e, p]] of Object.entries(pairs)) {
      const r = await admin.saveProfile(null, {
        ...profileInput(ids[e], ids[p]),
        name,
      });
      if (r.status !== 'SUCEED') throw new Error('profile');
      gateway.running.push({ taskId: `trader-${name}`, profileId: r.data.id });
    }
    await sync.pushAll();
    for (const [name, [e, p]] of Object.entries(pairs)) {
      const cfg = gateway.pushed
        .filter((x) => x.taskId === `trader-${name}`)
        .at(-1)!.config;
      expect(cfg.accounts).toEqual({
        csgoempire: { id: ids[e], label: `Empire ${e.slice(1)}` },
        polymarket: { id: ids[p], label: `Poly ${p.slice(1)}` },
      });
    }
  });

  it('chặn hai bản ghi trỏ vào cùng một ví / cùng một tài khoản csgoempire thật', async () => {
    const { poly } = await addAccounts();
    const sameWallet = await admin.saveAccount(null, {
      label: 'Poly copy',
      enabled: true,
      config: {
        venue: 'polymarket',
        walletAddress: `0x${'c'.repeat(40)}`,
        // funder trùng ví của Poly 1 (khác chữ hoa/thường)
        funderAddress: `0x${'A'.repeat(40)}`,
      },
    });
    expect(sameWallet.status === 'FAILED' && sameWallet.reason).toMatch(
      /^WALLET_TAKEN/,
    );
    // sửa chính nó thì không bị chặn
    expect(
      (
        await admin.saveAccount(poly.id, {
          label: 'Poly 1',
          enabled: true,
          config: poly.config,
        })
      ).status,
    ).toBe('SUCEED');
    await admin.saveAccount(null, {
      label: 'E-a',
      enabled: true,
      config: { venue: 'csgoempire', browserProfile: 'e-a' },
      loginUsername: 'Same@Example.test',
      loginPassword: 'pw',
    });
    const dup = await admin.saveAccount(null, {
      label: 'E-b',
      enabled: true,
      config: { venue: 'csgoempire', browserProfile: 'e-b' },
      loginUsername: 'same@example.test ',
      loginPassword: 'pw',
    });
    expect(dup.status === 'FAILED' && dup.reason).toMatch(/^LOGIN_TAKEN/);
  });

  it('gửi cấu hình đã tính sẵn (bảng vốn theo hạng) cho task trader đang chạy', async () => {
    const { empire, poly } = await addAccounts();
    const r = await admin.saveProfile(null, profileInput(empire.id, poly.id));
    if (r.status !== 'SUCEED') throw new Error('profile');
    gateway.running = [{ taskId: 'trader-a', profileId: r.data.id }];

    expect(await sync.pushAll()).toBe(1);
    const cfg = gateway.pushed.at(-1)!.config;
    expect(cfg).toMatchObject({
      active: true,
      inactiveReason: null,
      matchExposureCapUsd: 500,
    });
    // up 50%: hạng thấp (Thường) 40, hạng cao (VIP) 60
    expect(cfg.stakeTable.map((x) => [x.tierName, x.stake])).toEqual([
      ['Thường', 40],
      ['VIP', 60],
    ]);

    // không đổi → không gửi lại; đổi cấu hình chung → gửi
    expect(await sync.pushAll()).toBe(0);
    await admin.saveSettings({
      ...DEFAULT_TRADING_SETTINGS,
      matchExposureCapUsd: 0,
    });
    expect(gateway.pushed.at(-1)!.config.matchExposureCapUsd).toBe(0);
  });

  it('chọn hạng: [] → đứng yên; chọn VIP → chỉ VIP enabled; bỏ hạng không tồn tại; null = mọi hạng', async () => {
    const { empire, poly } = await addAccounts();
    const base = profileInput(empire.id, poly.id);
    const none = await admin.saveProfile(null, {
      ...base,
      stakePlan: { ...base.stakePlan, tierIds: [] },
    });
    if (none.status !== 'SUCEED') throw new Error('profile');
    expect(await admin.runtimeConfig(none.data.id)).toMatchObject({
      active: false,
      inactiveReason: 'NO_TIER_SELECTED',
    });

    const vip = await admin.saveProfile(none.data.id, {
      ...base,
      stakePlan: { ...base.stakePlan, tierIds: ['vip', 'vip', 'gone'] },
    });
    if (vip.status !== 'SUCEED') throw new Error('profile');
    expect(vip.data.stakePlan.tierIds).toEqual(['vip']);
    const cfg = await admin.runtimeConfig(none.data.id);
    expect(cfg.active).toBe(true);
    expect(cfg.stakeTable.map((x) => [x.tierId, x.enabled])).toEqual([
      ['std', false],
      ['vip', true],
    ]);

    await admin.saveProfile(none.data.id, {
      ...base,
      stakePlan: { ...base.stakePlan, tierIds: null },
    });
    expect(
      (await admin.runtimeConfig(none.data.id)).stakeTable.every(
        (x) => x.enabled,
      ),
    ).toBe(true);
  });

  it('chọn market: [] → đứng yên; danh sách được bỏ trùng và gửi cho worker', async () => {
    const { empire, poly } = await addAccounts();
    const base = profileInput(empire.id, poly.id);
    const r = await admin.saveProfile(null, {
      ...base,
      risk: { ...base.risk, markets: [] },
    });
    if (r.status !== 'SUCEED') throw new Error('profile');
    expect((await admin.runtimeConfig(r.data.id)).inactiveReason).toBe(
      'NO_MARKET_SELECTED',
    );
    await admin.saveProfile(r.data.id, {
      ...base,
      risk: {
        ...base.risk,
        markets: ['game-winner', 'game-winner', 'map-handicap-p1.5'],
      },
    });
    const cfg = await admin.runtimeConfig(r.data.id);
    expect(cfg.active).toBe(true);
    expect(cfg.risk.markets).toEqual(['game-winner', 'map-handicap-p1.5']);
  });

  it('tài khoản tắt → worker nhận active=false kèm lý do', async () => {
    const { empire, poly } = await addAccounts();
    const r = await admin.saveProfile(null, profileInput(empire.id, poly.id));
    if (r.status !== 'SUCEED') throw new Error('profile');
    await admin.saveAccount(empire.id, {
      label: 'Empire 1',
      enabled: false,
      config: empire.config,
    });
    const cfg = await admin.runtimeConfig(r.data.id);
    expect(cfg).toMatchObject({
      active: false,
      inactiveReason: 'CSGOEMPIRE_ACCOUNT_DISABLED',
    });
    expect((await admin.runtimeConfig('missing')).inactiveReason).toBe(
      'PROFILE_NOT_FOUND',
    );
  });

  it('xem trước bảng vốn theo hạng hiện có', async () => {
    const r = await admin.previewStakeTable({
      ...DEFAULT_STAKE_PLAN,
      trend: 'down',
      baseStake: 90,
      stepPct: 0.5,
    });
    expect(r.status === 'SUCEED' && r.data.rows.map((x) => x.stake)).toEqual([
      90, 60,
    ]);
  });
});
