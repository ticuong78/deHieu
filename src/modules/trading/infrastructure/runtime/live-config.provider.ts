import { Logger } from '@nestjs/common';
import type {
  TraderExecutionConfigProvider,
  EmpireBrowserGateway,
  TradingAccountCheck,
  TradingAccountChecker,
  TradingHaltControl,
} from '../../application/trading.ports.js';
import { readPolymarketBalance } from '../../../../shared/infrastructure/trading/venue-orders.js';
import { EmpireCashier } from '../../../../shared/infrastructure/trading/empire-cashier.js';
import { sendUsdtFromPolymarket } from '../../../../shared/infrastructure/trading/polymarket-cashier.js';
import type {
  EmpireAccount,
  PolyAccount,
  RebalanceGateway,
} from '../../application/rebalance-executor.js';
import { EmpireBalanceWatcher } from '../../../../shared/infrastructure/trading/empire-balance-watcher.js';
import type {
  EmpireCredentials,
  EmpireLoginStatus,
  EmpireJwtPreview,
} from '../../../../shared/application/empire-login.js';
import { AesGcmSecretCipher } from '../../../../shared/infrastructure/trading/secret-cipher.js';
import { SESSION_EXPIRED } from '../../../../shared/infrastructure/trading/empire-session.js';
import { createHash, randomUUID } from 'node:crypto';
import type { TraderRuntimeConfig } from '../../application/trader-config.js';
import type {
  TradingAccount,
  TradingVenue,
} from '../../domain/trading-account.js';
import {
  AccountLock,
  accountResource,
} from '../../../../shared/infrastructure/trading/account-lock.js';
import {
  closeAllProfiles,
  EmpireSessions,
} from '../../../../shared/infrastructure/trading/empire-session.js';

export class LiveConfigProvider
  implements
    TraderExecutionConfigProvider,
    EmpireBrowserGateway,
    TradingAccountChecker,
    TradingHaltControl,
    RebalanceGateway
{
  private readonly jobs = new Map<
    string,
    {
      state: EmpireLoginStatus;
      abort: AbortController;
      done: Promise<void>;
      preview?: EmpireJwtPreview & { availableUntil: number };
    }
  >();
  private readonly locks: AccountLock | null;
  private readonly logger = new Logger('EmpireSession');
  private readonly sessions: EmpireSessions | null;
  /** Chrome nền đọc số dư csgoempire vào Redis (worker vào lệnh đọc ở đó). */
  private readonly balances: EmpireBalanceWatcher | null;
  constructor() {
    this.locks = process.env.REDIS_URL
      ? new AccountLock(process.env.REDIS_URL)
      : null;
    this.balances = this.locks
      ? new EmpireBalanceWatcher(
          this.locks,
          (message) => this.logger.warn(message),
          // nhịp đọc số dư csgoempire (ms); mặc định 2 giây, tối thiểu 1 giây
          Math.max(
            1_000,
            Number(process.env.TRADING_EMPIRE_BALANCE_INTERVAL_MS) || 2_000,
          ),
        )
      : null;
    this.sessions = this.locks
      ? new EmpireSessions(
          this.locks,
          (profile, error) =>
            this.logger.warn(
              `csgoempire ${profile}: làm mới phiên lỗi tạm thời (${error}), dùng tiếp token cũ còn hạn, thử lại sau 1 phút`,
            ),
          (profile, info) =>
            this.logger.log(
              `csgoempire ${profile}: thăm dò sau đăng nhập — ${info}`,
            ),
          // làm mới phiên / đăng nhập dùng chung hồ sơ với Chrome nền: tạm đóng Chrome nền,
          // rồi bàn giao luôn tab vừa lấy JWT để đọc số dư (không mở Chrome thứ hai)
          this.balances
            ? {
                acquire: (profile) => this.balances!.pause(profile),
                adopt: (profile, context, page, expected, headers) =>
                  this.balances!.adopt(
                    profile,
                    context,
                    page,
                    expected,
                    headers,
                  ),
                release: (profile) => this.balances!.resume(profile),
              }
            : undefined,
          (profile, event) => {
            if (event.type === 'gave_up')
              this.logger.error(
                `csgoempire ${profile}: tự lấy phiên hỏng ${event.attempts} lần liên tiếp (${event.error}) — dừng, chờ bấm Đăng nhập`,
              );
            else
              this.logger.log(`csgoempire ${profile}: đã lấy lại được phiên`);
            for (const l of this.sessionListeners) l(profile, event);
          },
        )
      : null;
  }

  private readonly sessionListeners: ((
    browserProfile: string,
    event:
      | { type: 'gave_up'; error: string; attempts: number }
      | { type: 'recovered' },
  ) => void)[] = [];

  /** Nghe khi tự lấy phiên csgoempire bỏ cuộc / lấy lại được (để báo người vận hành). */
  onSessionHealth(listener: (typeof this.sessionListeners)[number]) {
    this.sessionListeners.push(listener);
  }
  private credentials(account: TradingAccount): EmpireCredentials | undefined {
    if (!account.secretCipher) return undefined;
    const value = JSON.parse(
      new AesGcmSecretCipher(process.env.TRADING_SECRET_KEY).decrypt(
        account.secretCipher,
      ),
    ) as Partial<EmpireCredentials>;
    if (
      typeof value.username !== 'string' ||
      !value.username ||
      typeof value.password !== 'string' ||
      !value.password
    )
      throw new Error('CSGOEMPIRE_LOGIN_CREDENTIALS_INVALID');
    return { username: value.username, password: value.password };
  }
  private version(account: TradingAccount) {
    return createHash('sha256')
      .update(account.secretCipher ?? '')
      .digest('hex');
  }
  loginStatus(profile: string) {
    const job = this.jobs.get(profile);
    if (!job) return null;
    if (job.preview && Date.now() >= job.preview.availableUntil) {
      delete job.preview;
      job.state = { ...job.state, jwtAvailable: false };
    }
    return { ...job.state };
  }
  takeJwtPreview(profile: string, attemptId: string): EmpireJwtPreview | null {
    this.loginStatus(profile); // Discard expired previews before returning one.
    const job = this.jobs.get(profile);
    if (!job || job.state.attemptId !== attemptId || !job.preview) return null;
    const { token, expiresAt } = job.preview;
    // Synchronous consumption: even concurrent requests can only receive it once.
    delete job.preview;
    job.state = { ...job.state, jwtAvailable: false };
    return { token, expiresAt };
  }
  startLogin(account: TradingAccount): EmpireLoginStatus {
    if (account.config.venue !== 'csgoempire')
      throw new Error('CSGOEMPIRE_ACCOUNT_UNAVAILABLE');
    const profile = account.config.browserProfile;
    const previous = this.jobs.get(profile);
    if (
      previous &&
      ['opening', 'signing_in', 'obtaining_session'].includes(
        previous.state.stage,
      )
    )
      return previous.state;
    const job: {
      state: EmpireLoginStatus;
      abort: AbortController;
      done: Promise<void>;
      preview?: EmpireJwtPreview & { availableUntil: number };
    } = {
      state: {
        stage: 'opening',
        updatedAt: Date.now(),
        expiresAt: null as number | null,
        error: null as string | null,
        attemptId: randomUUID(),
        jwtAvailable: false,
      },
      abort: new AbortController(),
      done: Promise.resolve(),
    };
    this.jobs.set(profile, job);
    job.done = Promise.resolve()
      .then(async () => {
        if (!this.sessions || !this.locks)
          throw new Error('LIVE_REDIS_REQUIRED');
        if (!process.env.TRADING_SECRET_KEY)
          throw new Error('TRADING_SECRET_KEY_REQUIRED');
        const credentials = this.credentials(account);
        if (!credentials)
          throw new Error('CSGOEMPIRE_LOGIN_CREDENTIALS_MISSING');
        const session = await this.sessions.get(profile, {
          credentials,
          credentialsVersion: this.version(account),
          headed: true,
          force: true,
          signal: job.abort.signal,
          onStage: (stage) => {
            job.state = { ...job.state, stage, updatedAt: Date.now() };
          },
          onDiagnostic: (diagnostic) => {
            job.state = { ...job.state, diagnostic, updatedAt: Date.now() };
          },
        });
        await this.locks.clearHalt(
          [accountResource('csgoempire', profile)],
          SESSION_EXPIRED,
        );
        job.preview = {
          token: session.token,
          expiresAt: session.expiresAt,
          availableUntil: Math.min(session.expiresAt, Date.now() + 5 * 60_000),
        };
        job.state = {
          ...job.state,
          stage: 'ready',
          updatedAt: Date.now(),
          expiresAt: session.expiresAt,
          error: null,
          jwtAvailable: true,
        };
      })
      .catch((e: unknown) => {
        const raw = e instanceof Error ? e.message.split(':')[0] : '';
        const code =
          /^(CSGOEMPIRE_[A-Z_]+|LIVE_REDIS_REQUIRED|TRADING_SECRET_KEY_REQUIRED|ACCOUNT_BUSY|TRADING_REDIS_UNAVAILABLE)$/.test(
            raw,
          )
            ? raw
            : 'CSGOEMPIRE_LOGIN_FAILED';
        job.state = {
          ...job.state,
          stage: job.abort.signal.aborted
            ? 'cancelled'
            : code === 'CSGOEMPIRE_VERIFICATION_REQUIRED'
              ? 'verification_required'
              : 'error',
          updatedAt: Date.now(),
          expiresAt: null,
          error: code,
        };
        if (!job.abort.signal.aborted) {
          const d = job.state.diagnostic;
          // chuỗi lỗi gốc (cause) đã được che tài khoản/mật khẩu ở empire-session
          const chain: string[] = [];
          for (
            let c: unknown = e instanceof Error ? e.cause : undefined;
            c instanceof Error && chain.length < 3;
            c = c.cause
          )
            chain.push(c.message.split('\n')[0].slice(0, 200));
          this.logger.warn(
            `csgoempire ${profile}: đăng nhập lỗi ${code}${d ? ` ở bước ${d.step}` : ''}${d?.httpStatus ? ` · HTTP ${d.httpStatus}` : ''}${d?.accountIssue ? ` · ${d.accountIssue}` : ''}${d?.cause ? ` · ${d.cause}` : ''}${!d?.cause && chain.length ? ` · ${chain.join(' ← ')}` : ''}`,
          );
        }
      });
    return job.state;
  }
  async cancelLogin(profile: string) {
    const job = this.jobs.get(profile);
    if (!job) return null;
    if (
      ['opening', 'signing_in', 'obtaining_session'].includes(job.state.stage)
    ) {
      job.abort.abort();
      await job.done;
    }
    return job.state;
  }
  async prepare(
    config: TraderRuntimeConfig,
    accounts: readonly TradingAccount[],
  ): Promise<TraderRuntimeConfig> {
    const inactive = (reason: string) => ({
      ...config,
      active: false,
      inactiveReason: reason,
    });
    if (!this.locks || !this.sessions) return inactive('LIVE_REDIS_REQUIRED');
    if (!process.env.TRADING_SECRET_KEY)
      return inactive('TRADING_SECRET_KEY_REQUIRED');
    const empire = accounts.find(
      (a) => a.id === config.accounts.csgoempire?.id,
    );
    const poly = accounts.find((a) => a.id === config.accounts.polymarket?.id);
    if (
      empire?.config.venue !== 'csgoempire' ||
      poly?.config.venue !== 'polymarket' ||
      !poly.secretCipher
    )
      return inactive('LIVE_CREDENTIALS_MISSING');
    const job = this.jobs.get(empire.config.browserProfile);
    if (
      job &&
      ['opening', 'signing_in', 'obtaining_session'].includes(job.state.stage)
    )
      return inactive('CSGOEMPIRE_LOGIN_IN_PROGRESS');
    try {
      await this.locks.connect();
      const reason = await this.locks.halted([
        accountResource('csgoempire', empire.config.browserProfile),
        accountResource(
          'polymarket',
          (
            poly.config.funderAddress ?? poly.config.walletAddress
          ).toLowerCase(),
        ),
      ]);
      if (reason) return inactive(reason);
      const empireSession = await this.sessions.get(
        empire.config.browserProfile,
        {
          credentials: this.credentials(empire),
          credentialsVersion: this.version(empire),
        },
      );
      // profile chạy thật cần số dư Empire: giữ Chrome nền đọc số dư (nhịp đối chiếu gọi lại mỗi 30 giây)
      this.balances?.want(
        empire.config.browserProfile,
        this.credentials(empire)?.username ?? null,
      );
      return {
        ...config,
        execution: {
          empire: empireSession,
          polymarket: polyExecution(poly.config, poly.secretCipher),
        },
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : '';
      return inactive(
        message.startsWith('CSGOEMPIRE_')
          ? message
          : 'LIVE_ACCOUNT_UNAVAILABLE',
      );
    }
  }
  async check(account: TradingAccount): Promise<TradingAccountCheck> {
    if (!process.env.TRADING_SECRET_KEY)
      throw new Error('TRADING_SECRET_KEY_REQUIRED');
    const signal = AbortSignal.timeout(90_000);
    const base = {
      accountId: account.id,
      venue: account.config.venue,
      label: account.label,
    };
    // Khóa vào lệnh đang có trên tài khoản (đọc trước: kể cả khi đọc số dư lỗi phía sau cũng không sao)
    const halted = await this.haltedReason(account);
    if (account.config.venue === 'polymarket') {
      if (!account.secretCipher) throw new Error('POLYMARKET_KEY_MISSING');
      const r = await readPolymarketBalance(
        polyExecution(account.config, account.secretCipher),
        signal,
      );
      return {
        ...base,
        remoteId: r.account.id,
        remoteName: null,
        wallet: r.account.wallet,
        cash: r.cash,
        allowance: r.allowance,
        positions: r.positions,
        halted,
        // readPolymarketBalance ném POLYMARKET_WALLET_MISMATCH nếu key không ra đúng ví.
        matchesConfig: true,
        checkedAt: Date.now(),
      };
    }
    if (!this.sessions) throw new Error('LIVE_REDIS_REQUIRED');
    const profile = account.config.browserProfile;
    const job = this.jobs.get(profile);
    if (
      job &&
      ['opening', 'signing_in', 'obtaining_session'].includes(job.state.stage)
    )
      throw new Error('CSGOEMPIRE_LOGIN_IN_PROGRESS');
    const credentials = this.credentials(account);
    // bảo đảm hồ sơ đang đăng nhập đúng tài khoản (xác nhận ở bước lấy phiên)
    await this.sessions.get(profile, {
      credentials,
      credentialsVersion: this.version(account),
    });
    if (!this.balances) throw new Error('LIVE_REDIS_REQUIRED');
    signal.throwIfAborted();
    // csgoempire chỉ trả số dư cho trình duyệt thật: đọc bằng Chrome nền
    // (ném CSGOEMPIRE_ACCOUNT_MISMATCH + chặn vào lệnh nếu sàn báo tài khoản khác)
    const r = await this.balances.readNow(
      profile,
      credentials?.username ?? null,
    );
    const expected = credentials?.username.trim().toLowerCase();
    return {
      ...base,
      remoteId: r.account.id,
      remoteName: r.account.name,
      wallet: null,
      cash: r.cash,
      allowance: null,
      positions: null,
      halted,
      matchesConfig:
        expected && (r.username || r.email)
          ? [r.username, r.email].some(
              (v) => v?.trim().toLowerCase() === expected,
            )
          : // sàn không trả email: phiên đã được xác nhận ở bước lấy phiên (gõ đúng tài khoản đã lưu)
            expected
            ? true
            : null,
      checkedAt: Date.now(),
    };
  }
  // ------------------------------------------------------------- tự chuyển tiền (RebalanceGateway)

  private cashier(): EmpireCashier {
    if (!this.balances) throw new Error('LIVE_REDIS_REQUIRED');
    return new EmpireCashier(this.balances);
  }

  async halted(empire: EmpireAccount, poly: PolyAccount) {
    if (!this.locks) return 'LIVE_REDIS_REQUIRED';
    await this.locks.connect();
    return this.locks.halted([haltResource(empire), haltResource(poly)]);
  }

  async readBalances(empire: EmpireAccount, poly: PolyAccount) {
    if (!poly.secretCipher) throw new Error('POLYMARKET_KEY_MISSING');
    if (!this.balances) throw new Error('LIVE_REDIS_REQUIRED');
    const [e, p] = await Promise.all([
      this.balances.readNow(
        empire.config.browserProfile,
        this.credentials(empire)?.username ?? null,
      ),
      readPolymarketBalance(
        polyExecution(poly.config, poly.secretCipher),
        AbortSignal.timeout(60_000),
      ),
    ]);
    return { csgoempire: e.cash, polymarket: p.cash };
  }

  async empireDepositAddress(empire: EmpireAccount) {
    return (await this.cashier().deposit(empire.config.browserProfile)).address;
  }

  async sendFromPolymarket(
    poly: PolyAccount,
    usd: number,
    recipient: string,
    onSubmitted: (ref: string | null) => Promise<void>,
  ) {
    if (!poly.secretCipher) throw new Error('POLYMARKET_KEY_MISSING');
    const relayerCipher = poly.config.relayerApiKeyCipher;
    const relayerAddress = poly.config.relayerApiKeyAddress;
    if (!relayerCipher || !relayerAddress)
      throw new Error(
        'POLYMARKET_RELAYER_KEY_MISSING: chưa lưu Relayer API Key + Signer Address cho ví Polymarket',
      );
    const r = await sendUsdtFromPolymarket(
      polyExecution(poly.config, poly.secretCipher),
      { amountUsd: usd, recipient },
      {
        key: new AesGcmSecretCipher(process.env.TRADING_SECRET_KEY).decrypt(
          relayerCipher,
        ),
        address: relayerAddress,
      },
      {
        onSubmitted: (s) =>
          onSubmitted(
            s.txHash ?? (s.transactionId ? `relayer:${s.transactionId}` : null),
          ),
      },
    );
    return { txHash: r.txHash };
  }

  async withdrawFromEmpire(
    empire: EmpireAccount,
    usd: number,
    address: string,
    minUsdt: number,
  ) {
    const r = await this.cashier().withdraw(
      empire.config.browserProfile,
      usd,
      address,
      minUsdt,
    );
    return {
      id: r.withdrawal.id,
      coinCents: r.withdrawal.coinCents,
      usdt: Number(r.request.crypto_amount),
    };
  }

  /** Mức nạp tối thiểu Polymarket công bố cho USDT Polygon (bridge.polymarket.com/supported-assets). */
  async depositMinimumUsd(venue: TradingVenue) {
    if (venue !== 'polymarket') return null;
    const r = await fetch('https://bridge.polymarket.com/supported-assets', {
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as {
      supportedAssets?: {
        chainId?: string | number;
        token?: { address?: string };
        minCheckoutUsd?: number;
      }[];
    };
    const a = (j.supportedAssets ?? []).find(
      (x) =>
        String(x.chainId) === '137' &&
        x.token?.address?.toLowerCase() ===
          '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
    );
    return typeof a?.minCheckoutUsd === 'number' ? a.minCheckoutUsd : null;
  }

  async polymarketCash(poly: PolyAccount) {
    if (!poly.secretCipher) throw new Error('POLYMARKET_KEY_MISSING');
    const r = await readPolymarketBalance(
      polyExecution(poly.config, poly.secretCipher),
      AbortSignal.timeout(60_000),
    );
    return r.cash;
  }

  /**
   * Trạng thái khoản nạp USDT (Polygon) vào địa chỉ nạp Polymarket, theo API bridge công khai của Polymarket.
   * Chỉ xét khoản cùng số tiền (±2%) tạo sau `sinceMs`. null = chưa thấy.
   */
  async polymarketDeposit(
    depositAddress: string,
    usdt: number,
    sinceMs: number,
  ) {
    const r = await fetch(
      `https://bridge.polymarket.com/status/${depositAddress}`,
      { signal: AbortSignal.timeout(20_000) },
    );
    if (!r.ok)
      throw new Error(`POLYMARKET_BRIDGE_STATUS_FAILED: HTTP ${r.status}`);
    const j = (await r.json()) as {
      transactions?: {
        fromChainId?: string | number;
        fromAmountBaseUnit?: string;
        status?: string;
        createdTimeMs?: number;
      }[];
    };
    const want = usdt * 1e6;
    const tx = (j.transactions ?? []).find((t) => {
      const amt = Number(t.fromAmountBaseUnit);
      return (
        String(t.fromChainId) === '137' &&
        Math.abs(amt - want) <= want * 0.02 &&
        (t.createdTimeMs == null || t.createdTimeMs >= sinceMs)
      );
    });
    if (!tx) return null;
    if (tx.status === 'COMPLETED') return 'completed' as const;
    if (tx.status === 'FAILED') return 'failed' as const;
    return 'pending' as const;
  }

  async empireWithdrawal(empire: EmpireAccount, id: number) {
    const w = await this.cashier().withdrawal(empire.config.browserProfile, id);
    return w ? { state: w.state, txHash: w.txHash } : null;
  }

  async empireDepositCredited(empire: EmpireAccount, txHash: string) {
    const { deposits } = await this.cashier().deposit(
      empire.config.browserProfile,
    );
    return deposits.some(
      (d) => d.credited && d.txHash?.toLowerCase() === txHash.toLowerCase(),
    );
  }

  sessionRejected(browserProfile: string, tokenHash: string) {
    if (this.sessions?.invalidate(browserProfile, tokenHash))
      this.logger.warn(
        `csgoempire ${browserProfile}: BetBy từ chối JWT còn hạn — lấy phiên mới ngay`,
      );
  }

  async clearReconciliation(
    accounts: readonly TradingAccount[],
  ): Promise<string[]> {
    if (!this.locks) throw new Error('LIVE_REDIS_REQUIRED');
    await this.locks.connect();
    return this.locks.clearHaltPrefix(
      accounts.map(haltResource),
      'LIVE_RECONCILIATION_REQUIRED',
    );
  }

  /** Lý do khóa vào lệnh của tài khoản (Redis); không đọc được Redis → null (không chặn nút kiểm tra). */
  private async haltedReason(account: TradingAccount): Promise<string | null> {
    if (!this.locks) return null;
    const resource = haltResource(account);
    try {
      await this.locks.connect();
      return await this.locks.halted([resource]);
    } catch {
      return null;
    }
  }
  async onApplicationShutdown() {
    for (const job of this.jobs.values()) job.abort.abort();
    try {
      await this.balances?.closeAll();
      await closeAllProfiles();
    } finally {
      await Promise.allSettled([...this.jobs.values()].map((j) => j.done));
      this.locks?.close();
    }
  }
}

/** Khóa Redis của tài khoản — cùng khóa mà worker đặt (csgoempire: hồ sơ; polymarket: ví funder, chữ thường). */
function haltResource(account: TradingAccount) {
  return account.config.venue === 'polymarket'
    ? accountResource(
        'polymarket',
        (
          account.config.funderAddress ?? account.config.walletAddress
        ).toLowerCase(),
      )
    : accountResource('csgoempire', account.config.browserProfile);
}

/** Cấu hình ký lệnh Polymarket: bỏ Relayer API Key mã hóa (không gửi sang worker / không cần khi vào lệnh). */
function polyExecution(
  c: TradingAccount['config'] & { venue: 'polymarket' },
  secretCipher: string,
) {
  return {
    venue: c.venue,
    walletAddress: c.walletAddress,
    funderAddress: c.funderAddress,
    secretCipher,
  };
}
