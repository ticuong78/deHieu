import type { OpsEventBus } from '../../../shared/application/ops-event-bus.js';
import {
  afterTransfer,
  EMPIRE_SHARE,
  improves,
  planForTrades,
  planRebalance,
  type RebalancePlan,
  type TradeUnit,
  type VenueBalances,
} from '../domain/balance-rebalance.js';
import type {
  CsgoEmpireAccountConfig,
  PolymarketAccountConfig,
  TradingAccount,
  TradingVenue,
} from '../domain/trading-account.js';
import type { RebalanceSettings } from '../domain/trading-settings.js';
import type { OperationStatus } from '../../../shared/domain/domain-repository.js';
import type { PushSender } from './one-click-notifier.js';
import type { RebalanceAdvisor } from './rebalance-advisor.js';
import type {
  TraderProfileRepository,
  TradingAccountRepository,
  TradingSettingsStore,
} from './trading.ports.js';

export type EmpireAccount = TradingAccount & {
  config: CsgoEmpireAccountConfig;
};
export type PolyAccount = TradingAccount & { config: PolymarketAccountConfig };

/** Cổng tới hai sàn (LiveConfigProvider): đọc số dư, nạp/rút. */
export interface RebalanceGateway {
  /** Lý do tài khoản đang bị khóa (đối soát, phiên hết hạn…); null = được dùng. */
  halted(empire: EmpireAccount, poly: PolyAccount): Promise<string | null>;
  /** Số dư RẢNH (USD) đọc mới từ sàn. */
  readBalances(
    empire: EmpireAccount,
    poly: PolyAccount,
  ): Promise<VenueBalances>;
  /** Địa chỉ nạp USDT Polygon csgoempire đang trả cho tài khoản. */
  empireDepositAddress(empire: EmpireAccount): Promise<string>;
  /** pUSD → USDT Polygon tới `recipient`. onSubmitted gọi NGAY khi đã gửi lên relayer. */
  sendFromPolymarket(
    poly: PolyAccount,
    usd: number,
    recipient: string,
    onSubmitted: (ref: string | null) => Promise<void>,
  ): Promise<{ txHash: string | null }>;
  /** Tạo lệnh rút USDT Polygon csgoempire về `address`. */
  withdrawFromEmpire(
    empire: EmpireAccount,
    usd: number,
    address: string,
  ): Promise<{ id: number; coinCents: number; usdt: number }>;
  empireWithdrawal(
    empire: EmpireAccount,
    id: number,
  ): Promise<{
    state: 'pending' | 'confirmed' | 'failed';
    txHash: string | null;
  } | null>;
  /** Cash (tiền giao dịch) Polymarket hiện tại, USD. */
  polymarketCash(poly: PolyAccount): Promise<number>;
  /**
   * Trạng thái khoản nạp USDT tới địa chỉ nạp Polymarket (bridge.polymarket.com/status) có số tiền ≈ `usdt`
   * từ mốc `sinceMs`: completed / failed / pending; null = không tra được hoặc chưa thấy.
   */
  polymarketDeposit(
    depositAddress: string,
    usdt: number,
    sinceMs: number,
  ): Promise<'completed' | 'failed' | 'pending' | null>;
  /** Lần nạp có mã giao dịch này đã được cộng vào số dư csgoempire chưa. */
  empireDepositCredited(
    empire: EmpireAccount,
    txHash: string,
  ): Promise<boolean>;
}

export const TRANSFER_STATES = [
  'dry_run',
  'skipped',
  'planned',
  'submitted',
  'sent',
  'completed',
  'failed',
  'unconfirmed',
  'unknown',
] as const;
export type TransferState = (typeof TRANSFER_STATES)[number];

export interface RebalanceTransfer {
  readonly id: string;
  readonly profileId: string;
  readonly profileName: string;
  readonly trigger: 'auto' | 'manual';
  readonly mode: 'dry_run' | 'live';
  readonly from: TradingVenue | null;
  readonly to: TradingVenue | null;
  readonly amountUsd: number;
  readonly destination: string | null;
  readonly balances: VenueBalances | null;
  readonly state: TransferState;
  readonly reason: string | null;
  /** Mã giao dịch on-chain (Polymarket → csgoempire) hoặc mã lệnh rút csgoempire (+ tx khi có). */
  readonly ref: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Lưu bền (Redis): khóa mỗi profile một lượt, tổng đã chuyển trong ngày, lịch sử, chặn sau lỗi. */
export interface RebalanceTransferStore {
  begin(profileId: string, ttlMs: number): Promise<boolean>;
  end(profileId: string): Promise<void>;
  /** Cộng (âm = trả lại) vào tổng đã chuyển trong ngày; trả tổng mới. */
  addDaily(profileId: string, day: string, usd: number): Promise<number>;
  daily(profileId: string, day: string): Promise<number>;
  save(t: RebalanceTransfer): Promise<void>;
  list(limit: number): Promise<RebalanceTransfer[]>;
  /** Chặn tự chuyển của profile (kết quả không rõ) tới khi người gỡ. */
  block(profileId: string, reason: string): Promise<void>;
  blocked(profileId: string): Promise<string | null>;
  unblock(profileId: string): Promise<boolean>;
  /** Vừa chuyển xong: tự chuyển kế tiếp chờ tới mốc này. */
  cooldown(profileId: string, ms: number): Promise<void>;
  coolingDown(profileId: string): Promise<boolean>;
}

/**
 * Mức nạp tối thiểu của nơi NHẬN (USD): Polymarket không xử lý khoản nạp dưới 2$ trên Polygon (tiền nằm
 * kẹt ở địa chỉ nạp); để dư cho phí / tỷ giá USDT → dùng 3$. csgoempire: chưa rõ mức tối thiểu, lấy cùng 3$.
 */
export const MIN_DEPOSIT_USD: Record<TradingVenue, number> = {
  polymarket: 3,
  csgoempire: 3,
};

const DAY = (t: number) => new Date(t).toISOString().slice(0, 10);
const floor2 = (n: number) => Math.floor(n * 100 + 1e-9) / 100;
const usd = (n: number) => `${n.toFixed(2)}$`;
const NAME: Record<TradingVenue, string> = {
  csgoempire: 'csgoempire',
  polymarket: 'Polymarket',
};
const errMsg = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).slice(0, 300);

export interface RebalanceExecutorOptions {
  readonly pollMs: number;
  readonly confirmTimeoutMs: number;
  readonly cooldownMs: number;
  readonly lockMs: number;
}
const DEFAULT_OPTIONS: RebalanceExecutorOptions = {
  pollMs: 20_000,
  confirmTimeoutMs: 30 * 60_000,
  cooldownMs: 10 * 60_000,
  lockMs: 2 * 3_600_000,
};

/**
 * Tự chuyển tiền giữa hai tài khoản của profile về tỉ lệ csgoempire 35% / Polymarket 65%.
 *
 * - Cấu hình chung `rebalance.mode`: off (không làm gì), dry_run (chỉ ghi "sẽ chuyển X$"), live (chuyển thật).
 * - Số dư đọc MỚI lúc chuyển (không dùng số của lệnh vừa hủy), số tiền ≤ hạn mức mỗi lần và còn lại trong ngày.
 * - Chỉ chuyển tới địa chỉ nạp ĐÃ LƯU trong tài khoản; chiều vào csgoempire còn đối chiếu địa chỉ trang trả.
 * - Mỗi profile một lượt (khóa Redis). Đã gửi mà không rõ kết quả → CHẶN tự chuyển của profile, báo sự cố,
 *   chờ người kiểm tra rồi gỡ — không bao giờ tự gửi lại.
 */
export class RebalanceExecutor {
  private readonly _running = new Set<string>();

  constructor(
    private readonly _gateway: RebalanceGateway,
    private readonly _store: RebalanceTransferStore,
    private readonly _settings: TradingSettingsStore,
    private readonly _profiles: TraderProfileRepository,
    private readonly _accounts: TradingAccountRepository,
    private readonly _advisor: Pick<
      RebalanceAdvisor,
      'resolve' | 'empireShare' | 'unitFor'
    >,
    private readonly _ops: OpsEventBus | null,
    private readonly _push: PushSender | null,
    private readonly _onError: (e: unknown) => void = () => undefined,
    private readonly _now: () => number = Date.now,
    private readonly _sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
    private readonly _opts: RebalanceExecutorOptions = DEFAULT_OPTIONS,
  ) {}

  /** Lệnh hủy vì hết tiền (RebalanceAdvisor) → chạy nền nếu đang bật. Không ném lỗi. */
  auto(profileId: string): void {
    void this.run(profileId, 'auto').catch(this._onError);
  }

  list(limit = 50): Promise<RebalanceTransfer[]> {
    return this._store.list(limit);
  }

  blocked(profileId: string): Promise<string | null> {
    return this._store.blocked(profileId);
  }

  /** Người đã kiểm tra tiền trên hai sàn → gỡ chặn tự chuyển của profile. */
  async unblock(
    profileId: string,
    by: string,
  ): Promise<OperationStatus<{ unblocked: boolean }>> {
    const unblocked = await this._store.unblock(profileId);
    try {
      this._ops?.publish({
        type: 'trading.rebalance_unblocked',
        topic: 'alerts',
        at: this._now(),
        data: { profileId, by },
      });
    } catch (e) {
      this._onError(e);
    }
    return { status: 'SUCEED', data: { unblocked } };
  }

  /** Địa chỉ nạp USDT Polygon csgoempire đang trả cho tài khoản (nút "Lấy từ csgoempire"). */
  async empireDepositAddress(
    accountId: string,
  ): Promise<OperationStatus<{ address: string }>> {
    const a = (await this._accounts.list()).find((x) => x.id === accountId);
    if (!a) return { status: 'NOT_FOUND' };
    if (a.config.venue !== 'csgoempire')
      return { status: 'FAILED', reason: 'NOT_CSGOEMPIRE_ACCOUNT' };
    try {
      return {
        status: 'SUCEED',
        data: {
          address: await this._gateway.empireDepositAddress(a as EmpireAccount),
        },
      };
    } catch (e) {
      return { status: 'FAILED', reason: errMsg(e) };
    }
  }

  /**
   * Một lượt chuyển. Trả bản ghi (kể cả bỏ qua, có lý do); FAILED khi không chạy được (đang có lượt khác…).
   * manual = người bấm "Chuyển ngay" (chạy cả khi đang hạ nhiệt; vẫn theo chế độ dry_run/live).
   */
  async run(
    profileId: string,
    trigger: 'auto' | 'manual',
  ): Promise<OperationStatus<RebalanceTransfer>> {
    const settings = (await this._settings.get()).rebalance;
    if (settings.mode === 'off')
      return trigger === 'auto'
        ? { status: 'FAILED', reason: 'REBALANCE_OFF' }
        : {
            status: 'FAILED',
            reason:
              'REBALANCE_OFF: bật "Tự chuyển tiền" (chạy thử hoặc thật) ở Giới hạn chung',
          };
    if (this._running.has(profileId))
      return {
        status: 'FAILED',
        reason: 'REBALANCE_BUSY: đang có lượt chuyển',
      };
    if (trigger === 'auto' && (await this._store.coolingDown(profileId)))
      return { status: 'FAILED', reason: 'REBALANCE_COOLDOWN' };
    const block = await this._store.blocked(profileId);
    if (block)
      return { status: 'FAILED', reason: `REBALANCE_BLOCKED: ${block}` };
    if (!(await this._store.begin(profileId, this._opts.lockMs)))
      return {
        status: 'FAILED',
        reason: 'REBALANCE_BUSY: đang có lượt chuyển',
      };
    this._running.add(profileId);
    try {
      return {
        status: 'SUCEED',
        data: await this._once(profileId, trigger, settings),
      };
    } finally {
      this._running.delete(profileId);
      await this._store.end(profileId).catch(this._onError);
    }
  }

  private async _once(
    profileId: string,
    trigger: 'auto' | 'manual',
    settings: RebalanceSettings,
  ): Promise<RebalanceTransfer> {
    const now = this._now();
    const profile = await this._profiles.get(profileId);
    let t: RebalanceTransfer = {
      id: `${profileId}:${now}`,
      profileId,
      profileName: profile?.name ?? profileId,
      trigger,
      mode: settings.mode === 'live' ? 'live' : 'dry_run',
      from: null,
      to: null,
      amountUsd: 0,
      destination: null,
      balances: null,
      state: 'skipped',
      reason: null,
      ref: null,
      createdAt: now,
      updatedAt: now,
    };
    const update = async (p: Partial<RebalanceTransfer>) => {
      t = { ...t, ...p, updatedAt: this._now() };
      await this._store.save(t).catch(this._onError);
      return t;
    };
    const skip = (reason: string) =>
      this._finish(update, { state: 'skipped', reason });

    if (!profile) return skip('PROFILE_NOT_FOUND');
    const accounts = await this._accounts.list();
    const empire = accounts.find(
      (a): a is EmpireAccount =>
        a.id === profile.csgoempireAccountId && a.config.venue === 'csgoempire',
    );
    const poly = accounts.find(
      (a): a is PolyAccount =>
        a.id === profile.polymarketAccountId && a.config.venue === 'polymarket',
    );
    if (!empire || !poly) return skip('ACCOUNT_MISSING');
    const halted = await this._gateway.halted(empire, poly);
    if (halted) return skip(`ACCOUNT_HALTED: ${halted}`);

    let balances: VenueBalances;
    try {
      balances = await this._gateway.readBalances(empire, poly);
    } catch (e) {
      return skip(`BALANCE_UNAVAILABLE: ${errMsg(e)}`);
    }
    const share = this._advisor.empireShare ?? EMPIRE_SHARE;
    // tiền một lệnh (từ lệnh vừa hủy vì hết tiền): tối ưu theo SỐ LỆNH vào được; không có thì theo tỉ lệ
    const unit: TradeUnit | null = this._advisor.unitFor(profileId);
    t = { ...t, balances };
    let plan: RebalancePlan | null;
    if (unit) {
      const d = planForTrades(balances, unit, share);
      if (d?.kind === 'insufficient')
        return skip(
          `INSUFFICIENT_TOTAL: tổng hai tài khoản ${usd(d.totalUsd)} < ${usd(d.needUsd)} cần cho một lệnh nhỏ nhất — nạp thêm`,
        );
      if (d?.kind === 'none')
        return skip('NO_GAIN: chuyển qua lại không vào thêm được lệnh nào');
      plan = d?.kind === 'transfer' ? d.plan : null;
    } else plan = planRebalance(balances, share);
    if (!plan) return skip('BALANCED: hai tài khoản đã đúng tỉ lệ');
    const day = DAY(now);
    const usedToday = await this._store.daily(profileId, day);
    const cap = Math.min(
      settings.maxPerTransferUsd,
      settings.maxPerDayUsd - usedToday,
    );
    t = { ...t, from: plan.from, to: plan.to };
    let amount = floor2(Math.min(plan.amountUsd, cap));
    if (unit) {
      // chuyển ít nhất "Tối thiểu" nếu bên chuyển còn dư mà vẫn vào thêm được lệnh (đỡ chuyển lắt nhắt);
      // số tiền sau hạn mức phải còn làm vào thêm được lệnh, không thì không chuyển
      const spare =
        plan.from === 'polymarket' ? balances.polymarket : balances.csgoempire;
      const bumped = floor2(
        Math.min(Math.max(amount, settings.minTransferUsd), cap, spare),
      );
      if (
        bumped > amount &&
        improves(balances, afterTransfer(balances, plan.from, bumped), unit)
      )
        amount = bumped;
      if (!improves(balances, afterTransfer(balances, plan.from, amount), unit))
        return skip(
          amount < plan.amountUsd
            ? `LIMIT_NO_GAIN: hạn mức chỉ cho chuyển ${usd(Math.max(0, amount))} (cần ${usd(plan.amountUsd)}) — không đủ vào thêm lệnh${usedToday > 0 ? `; hôm nay đã chuyển ${usd(usedToday)}` : ''}`
            : 'NO_GAIN: chuyển qua lại không vào thêm được lệnh nào',
        );
    } else if (amount < settings.minTransferUsd)
      return skip(
        usedToday + settings.minTransferUsd > settings.maxPerDayUsd
          ? `DAILY_LIMIT: đã chuyển ${usd(usedToday)} hôm nay / tối đa ${usd(settings.maxPerDayUsd)}`
          : `TOO_SMALL: ${usd(amount)} < tối thiểu ${usd(settings.minTransferUsd)}`,
      );
    // nơi nhận không xử lý khoản nạp quá nhỏ (Polymarket < 2$ → tiền kẹt ở địa chỉ nạp): nâng lên mức nạp
    // tối thiểu nếu bên chuyển còn đủ và vẫn vào thêm được lệnh, không thì KHÔNG chuyển
    const depositMin = MIN_DEPOSIT_USD[plan.to];
    if (amount < depositMin) {
      const spare =
        plan.from === 'polymarket' ? balances.polymarket : balances.csgoempire;
      const raised = floor2(Math.min(depositMin, cap, spare));
      if (
        raised + 1e-9 >= depositMin &&
        !!unit &&
        improves(balances, afterTransfer(balances, plan.from, raised), unit)
      )
        amount = raised;
      else
        return skip(
          `BELOW_DEPOSIT_MIN: cần chuyển ${usd(amount)} nhưng ${NAME[plan.to]} không nhận khoản nạp dưới ${usd(depositMin)} (chuyển ${usd(depositMin)} thì ${spare < depositMin ? `${NAME[plan.from]} không đủ tiền` : cap < depositMin ? 'vượt hạn mức' : !unit ? 'lệch khỏi tỉ lệ 35/65' : 'không vào thêm được lệnh'}) — không chuyển`,
        );
    }

    // địa chỉ nhận: chỉ địa chỉ ĐÃ LƯU; chiều vào csgoempire đối chiếu thêm địa chỉ trang đang trả
    // chuyển RA khỏi Polymarket là giao dịch gasless: cần Relayer API Key của ví
    if (
      plan.from === 'polymarket' &&
      (!poly.config.relayerApiKeyCipher || !poly.config.relayerApiKeyAddress)
    )
      return skip(
        'NO_RELAYER_KEY: chưa lưu Relayer API Key (polymarket.com → Settings → API Keys → Relayer API Keys) cho ví Polymarket',
      );
    let destination: string | null;
    if (plan.to === 'csgoempire') {
      destination = empire.config.usdtDepositAddress ?? null;
      if (!destination)
        return skip(
          'NO_DEPOSIT_ADDRESS: chưa xác nhận địa chỉ nạp USDT Polygon của tài khoản csgoempire',
        );
      try {
        const live = await this._gateway.empireDepositAddress(empire);
        if (live.toLowerCase() !== destination.toLowerCase())
          return skip(
            `DEPOSIT_ADDRESS_CHANGED: csgoempire đang trả ${live}, khác địa chỉ đã xác nhận ${destination}`,
          );
      } catch (e) {
        return skip(`DEPOSIT_ADDRESS_UNAVAILABLE: ${errMsg(e)}`);
      }
    } else {
      destination = poly.config.usdtDepositAddress ?? null;
      if (!destination)
        return skip(
          'NO_DEPOSIT_ADDRESS: chưa nhập địa chỉ nạp USDT Polygon của Polymarket',
        );
    }
    t = { ...t, amountUsd: amount, destination };
    if (settings.mode !== 'live')
      return this._finish(update, {
        state: 'dry_run',
        reason: `Chạy thử: sẽ chuyển ${usd(amount)} ${NAME[plan.from]} → ${NAME[plan.to]} tới ${destination}`,
      });

    // ------------------------------------------------------------ chuyển thật
    await update({ state: 'planned' });
    // giữ hạn mức ngày TRƯỚC khi gửi (hai lượt song song không vượt)
    const total = await this._store.addDaily(profileId, day, amount);
    if (total > settings.maxPerDayUsd + 1e-9) {
      await this._store.addDaily(profileId, day, -amount);
      return this._finish(update, { state: 'skipped', reason: 'DAILY_LIMIT' });
    }
    let submitted = false;
    try {
      if (plan.from === 'polymarket') {
        const r = await this._gateway.sendFromPolymarket(
          poly,
          amount,
          destination,
          async (ref) => {
            submitted = true;
            await update({ state: 'submitted', ref });
          },
        );
        submitted = true;
        await update({ state: 'sent', ref: r.txHash ?? t.ref });
        if (!r.txHash)
          return this._unconfirmed(
            update,
            'không có mã giao dịch để đối chiếu',
          );
        const ok = await this._poll(() =>
          this._gateway.empireDepositCredited(empire, r.txHash!),
        );
        return ok
          ? this._completed(update, profileId)
          : this._unconfirmed(
              update,
              `chưa thấy khoản nạp ${r.txHash} cộng vào csgoempire`,
            );
      }
      const w = await this._gateway.withdrawFromEmpire(
        empire,
        amount,
        destination,
      );
      submitted = true;
      await update({ state: 'submitted', ref: `withdrawal:${w.id}` });
      // gán trong callback: giữ trong object để TS không thu hẹp kiểu
      const seen: { tx: string | null; failed: boolean } = {
        tx: null,
        failed: false,
      };
      const ok = await this._poll(async () => {
        const s = await this._gateway.empireWithdrawal(empire, w.id);
        if (s?.state === 'failed') seen.failed = true;
        seen.tx = s?.txHash ?? seen.tx;
        return s?.state === 'confirmed' || seen.failed;
      });
      if (seen.failed) {
        // sàn từ chối / hoàn lệnh rút: tiền vẫn ở csgoempire → trả hạn mức ngày
        await this._store.addDaily(profileId, day, -amount);
        return this._finish(update, {
          state: 'failed',
          reason: `csgoempire từ chối lệnh rút ${w.id}`,
        });
      }
      if (seen.tx) await update({ ref: `withdrawal:${w.id} · ${seen.tx}` });
      if (!ok)
        return this._unconfirmed(update, `lệnh rút ${w.id} chưa xác nhận`);
      // csgoempire đã gửi USDT on-chain; Polymarket còn phải đổi + cộng vào ví (bridge). Chỉ "Xong" khi
      // Polymarket báo khoản nạp hoàn tất HOẶC Cash Polymarket tăng ≥ 90% số gửi.
      await update({ state: 'sent' });
      const baseline = balances.polymarket;
      const status: { last: string | null } = { last: null };
      const arrived = await this._poll(async () => {
        const s = await this._gateway
          .polymarketDeposit(destination, w.usdt, now - 60_000)
          .catch(() => null);
        status.last = s ?? status.last;
        if (s === 'completed' || s === 'failed') return true;
        const cash = await this._gateway.polymarketCash(poly);
        return cash + 1e-9 >= baseline + 0.9 * amount;
      });
      if (status.last === 'failed')
        return this._unconfirmed(
          update,
          `Polymarket báo khoản nạp ${w.usdt} USDT tới ${destination} THẤT BẠI (tx ${seen.tx ?? '—'}) — liên hệ hỗ trợ Polymarket`,
        );
      return arrived
        ? this._completed(update, profileId)
        : this._unconfirmed(
            update,
            `csgoempire đã gửi (tx ${seen.tx ?? '—'}) nhưng chưa thấy tiền vào Polymarket — kiểm tra bridge.polymarket.com/status/${destination}`,
          );
    } catch (e) {
      if (!submitted) {
        await this._store.addDaily(profileId, day, -amount);
        return this._finish(update, { state: 'failed', reason: errMsg(e) });
      }
      // đã gửi lên sàn / relayer mà lỗi: KHÔNG rõ tiền đi đâu → chặn, chờ người kiểm tra
      const reason = `kết quả không rõ sau khi đã gửi: ${errMsg(e)}`;
      await this._store.block(profileId, reason);
      return this._finish(update, { state: 'unknown', reason });
    }
  }

  private async _poll(check: () => Promise<boolean>): Promise<boolean> {
    const until = this._now() + this._opts.confirmTimeoutMs;
    for (;;) {
      try {
        if (await check()) return true;
      } catch (e) {
        this._onError(e);
      }
      if (this._now() >= until) return false;
      await this._sleep(this._opts.pollMs);
    }
  }

  private async _completed(
    update: (p: Partial<RebalanceTransfer>) => Promise<RebalanceTransfer>,
    profileId: string,
  ) {
    await this._store.cooldown(profileId, this._opts.cooldownMs);
    const t = await this._finish(update, { state: 'completed', reason: null });
    this._advisor.resolve(profileId, 'auto');
    return t;
  }

  private async _unconfirmed(
    update: (p: Partial<RebalanceTransfer>) => Promise<RebalanceTransfer>,
    why: string,
  ) {
    // tiền có thể vẫn đang trên đường: chặn lượt mới tới khi người kiểm tra (tránh chuyển chồng)
    const reason = `quá ${Math.round(this._opts.confirmTimeoutMs / 60_000)} phút: ${why}`;
    const t = await update({ state: 'unconfirmed', reason });
    await this._store.block(t.profileId, reason);
    return this._finish(update, {});
  }

  /** Ghi trạng thái cuối + báo (sự kiện vận hành; push cho chuyển thật). */
  private async _finish(
    update: (p: Partial<RebalanceTransfer>) => Promise<RebalanceTransfer>,
    p: Partial<RebalanceTransfer>,
  ): Promise<RebalanceTransfer> {
    const t = await update(p);
    try {
      this._ops?.publish({
        type: 'trading.rebalance_transfer',
        topic: 'alerts',
        at: this._now(),
        data: {
          profileId: t.profileId,
          profileName: t.profileName,
          state: t.state,
          mode: t.mode,
          fromVenue: t.from,
          toVenue: t.to,
          amountUsd: t.amountUsd,
          ref: t.ref,
          reason: t.reason,
        },
      });
      if (
        t.mode === 'live' &&
        ['completed', 'failed', 'unconfirmed', 'unknown'].includes(t.state)
      )
        await this._push?.send({
          title:
            t.state === 'completed'
              ? `Đã chuyển ${usd(t.amountUsd)} ${t.from ? NAME[t.from] : ''} → ${t.to ? NAME[t.to] : ''}`
              : `Chuyển tiền ${t.state === 'failed' ? 'lỗi' : 'cần kiểm tra'}: ${t.profileName}`,
          body: `Profile ${t.profileName}: ${usd(t.amountUsd)} tới ${t.destination ?? '—'}${t.ref ? ` (${t.ref})` : ''}${t.reason ? `. ${t.reason}` : ''}`,
          url: null,
          collapseId: `rebalance-transfer:${t.profileId}`.slice(0, 64),
          ttlSec: 24 * 3600,
        });
    } catch (e) {
      this._onError(e);
    }
    return t;
  }
}
