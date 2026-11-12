import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  chromium,
  type BrowserContext,
  type Page,
  type Response as BrowserResponse,
} from 'playwright';
import type { LiveTradingConfig } from '../../application/live-trading.js';
import { accountResource, type AccountLock } from './account-lock.js';
import { autoLogin, assertNoVerification } from './empire-auto-login.js';
import { launchSeleniumContext } from './selenium-browser.js';
import { selectUsdSession } from './empire-currency.js';
import type {
  EmpireCredentials,
  EmpireLoginStage,
  EmpireLoginDiagnostic,
} from '../../application/empire-login.js';

export const SESSION_EXPIRED =
  'CSGOEMPIRE_SESSION_EXPIRED: Phiên csgoempire hết hạn';
const REFRESH_BEFORE_EXPIRY_MS = 10 * 60_000;
/** Làm mới hỏng vì lý do tạm thời: vẫn dùng token cũ nếu còn ít nhất chừng này. */
const STALE_TOKEN_MARGIN_MS = 2 * 60_000;
/** ...và thử làm mới lại sau chừng này (không mở Chrome liên tục khi sàn / máy đang chập chờn). */
const RETRY_AFTER_FAILURE_MS = 60_000;
/**
 * Tự lấy phiên hỏng (không còn JWT dùng được): thử lại sau 1, 2, 5 phút; vẫn hỏng → bỏ cuộc, báo
 * người vận hành bấm Đăng nhập (push + sự cố). Tổng 4 lần thử trong khoảng 8 phút.
 */
export const SESSION_RETRY_DELAYS_MS = [60_000, 120_000, 300_000] as const;
/** Chờ khóa tài khoản (vd đang có lệnh đặt) thay vì báo bận ngay. */
const LOCK_WAIT_MS = 20_000;
/** Làm mới nền chờ chỗ mở Chrome tối đa chừng này; đăng nhập tay thì chờ tới khi có chỗ / bị hủy. */
const BACKGROUND_SLOT_WAIT_MS = 60_000;

/** Nội bộ: hồ sơ giữ phiên cũ / sai tài khoản, đã xóa cookie → mở lại và đăng nhập từ đầu. */
const RELOGIN = 'CSGOEMPIRE_RELOGIN_REQUIRED';

export interface EmpireSessionOptions {
  /** Nội bộ: lần mở lại sau khi xóa phiên cũ (không xóa lần nữa). */
  relogin?: boolean;
  credentials?: EmpireCredentials;
  credentialsVersion?: string;
  headed?: boolean;
  force?: boolean;
  signal?: AbortSignal;
  onStage?: (stage: EmpireLoginStage) => void;
  onDiagnostic?: (diagnostic: EmpireLoginDiagnostic) => void;
}
type EmpireSession = LiveTradingConfig['empire'];
const STEP_FAILURE: Record<EmpireLoginDiagnostic['step'], string> = {
  browser: 'CSGOEMPIRE_BROWSER_UNAVAILABLE',
  page: 'CSGOEMPIRE_PAGE_NAVIGATION_FAILED',
  login: 'CSGOEMPIRE_LOGIN_FLOW_FAILED',
  currency: 'CSGOEMPIRE_CURRENCY_SWITCH_FAILED',
  jwt: 'CSGOEMPIRE_SESSION_RESPONSE_FAILED',
  identify: 'CSGOEMPIRE_SESSION_IDENTIFY_FAILED',
  account: 'CSGOEMPIRE_SESSION_ACCOUNT_FAILED',
};
function sessionToken(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as { success?: unknown; data?: { token?: unknown } };
  const token = payload.data?.token;
  return payload.success === true && typeof token === 'string' && token.trim()
    ? token.trim()
    : null;
}
export function profilePath(name: string): string {
  if (!/^[\w.-]{1,64}$/.test(name) || name === '.' || name === '..')
    throw new Error('BROWSER_PROFILE_INVALID');
  const root = resolve(process.env.TRADING_BROWSER_ROOT ?? '.trading/profiles');
  const path = resolve(root, name);
  if (!path.startsWith(root + sep)) throw new Error('BROWSER_PROFILE_INVALID');
  return path;
}

export interface LaunchProfileOptions {
  login?: boolean;
  port?: number;
  har?: string;
  signal?: AbortSignal;
  /**
   * Chờ tối đa chừng này để có chỗ mở Chrome (giới hạn TRADING_MAX_BROWSERS). Bỏ trống = chờ tới
   * khi có chỗ hoặc bị hủy (đăng nhập tay); làm mới phiên nền đặt hạn để không treo hàng đợi.
   */
  slotWaitMs?: number;
  /**
   * Mở Chrome CÓ giao diện (không đăng nhập). Chrome ẩn (headless) tự xưng "HeadlessChrome" và bị
   * csgoempire từ chối API; trên server có giao diện vẫn vô hình vì chạy trong Xvfb.
   */
  visible?: boolean;
}

/** Số Chrome tối đa cùng mở trong một tiến trình (mỗi cái vài trăm MB RAM). */
export const maxBrowsers = () => {
  const n = Number(process.env.TRADING_MAX_BROWSERS ?? 2);
  return Number.isInteger(n) && n >= 1 ? n : 2;
};

/** Hàng chờ chỗ mở Chrome: vào trước được trước, hủy/hết hạn thì rời hàng. */
class BrowserSlots {
  private used = 0;
  private readonly queue: (() => void)[] = [];

  get inUse() {
    return this.used;
  }
  get waiting() {
    return this.queue.length;
  }

  acquire(signal: AbortSignal, waitMs?: number): Promise<() => void> {
    signal.throwIfAborted();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.used--;
    };
    if (this.used < maxBrowsers()) {
      this.used++;
      return Promise.resolve(release);
    }
    return new Promise((resolveSlot, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grant = () => {
        cleanup();
        resolveSlot(release);
      };
      const leave = (error: Error) => {
        const i = this.queue.indexOf(grant);
        if (i >= 0) this.queue.splice(i, 1);
        cleanup();
        reject(error);
      };
      const onAbort = () =>
        leave(
          signal.reason instanceof Error
            ? signal.reason
            : new Error('BROWSER_LAUNCH_ABORTED'),
        );
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (waitMs !== undefined)
        timer = setTimeout(
          () => leave(new Error('BROWSER_SLOTS_BUSY')),
          Math.max(0, waitMs),
        );
      // chỗ được chuyển thẳng cho người chờ: `used` giữ nguyên
      this.queue.push(grant);
    });
  }
}
const browserSlots = new BrowserSlots();

/** Số Chrome đang mở / đang chờ chỗ (để theo dõi). */
export const browserSlotUsage = () => ({
  max: maxBrowsers(),
  inUse: browserSlots.inUse,
  waiting: browserSlots.waiting,
});

const runningProfiles = new Map<
  string,
  { controller: AbortController; context: Promise<BrowserContext> }
>();

/** Start on demand. Call context.close() or closeProfile(name) to release RAM. */
export function launchProfile(
  name: string,
  options: LaunchProfileOptions = {},
): Promise<BrowserContext> {
  const path = profilePath(name);
  if (runningProfiles.has(path)) throw new Error('BROWSER_PROFILE_IN_USE');
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) ||
      options.port < 0 ||
      options.port > 65535)
  )
    throw new Error('BROWSER_DEBUG_PORT_INVALID');
  const controller = new AbortController();
  const forget = () => {
    if (runningProfiles.get(path)?.controller === controller)
      runningProfiles.delete(path);
  };
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  let release: (() => void) | undefined;
  const context = browserSlots
    .acquire(signal, options.slotWaitMs)
    .then((r) => {
      release = r;
      return openProfile(path, { ...options, signal });
    })
    .then(async (context) => {
      const originalClose = context.close.bind(context);
      let closing: Promise<void> | undefined;
      context.close = () =>
        (closing ??= Promise.resolve().then(async () => {
          signal.removeEventListener('abort', onAbort);
          try {
            await originalClose();
          } finally {
            release?.();
            forget();
          }
        }));
      const onAbort = () => {
        void context.close().catch(() => undefined);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      context.once('close', onAbort);
      if (signal.aborted) {
        await context.close();
        signal.throwIfAborted();
      }
      return context;
    })
    .catch((error: unknown) => {
      release?.();
      forget();
      throw error;
    });
  runningProfiles.set(path, { controller, context });
  return context;
}

/** Also cancels startup; repeated shutdown calls are safe. Profiles stay on disk. */
export async function closeProfile(name: string): Promise<void> {
  const running = runningProfiles.get(profilePath(name));
  if (!running) return;
  running.controller.abort();
  const context = await running.context.catch(() => undefined);
  await context?.close();
}

export async function closeAllProfiles(): Promise<void> {
  const results = await Promise.allSettled(
    [...runningProfiles.values()].map(async ({ controller, context }) => {
      controller.abort();
      await (await context.catch(() => undefined))?.close();
    }),
  );
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length)
    throw new AggregateError(
      failed.map((r) => r.reason as unknown),
      'BROWSER_CLOSE_FAILED',
    );
}

async function openProfile(
  path: string,
  options: LaunchProfileOptions & { signal: AbortSignal },
): Promise<BrowserContext> {
  options.signal.throwIfAborted();
  const engine = process.env.TRADING_BROWSER_ENGINE ?? 'seleniumbase';
  if (engine !== 'seleniumbase' && engine !== 'playwright')
    throw new Error('BROWSER_ENGINE_INVALID');
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (options.login) {
    const defaults = resolve(path, 'Default');
    await mkdir(defaults, { recursive: true, mode: 0o700 });
    const preferencesPath = resolve(defaults, 'Preferences');
    const preferences = JSON.parse(
      await readFile(preferencesPath, 'utf8').catch(() => '{}'),
    ) as Record<string, unknown>;
    preferences.credentials_enable_service = false;
    preferences.profile = {
      ...(preferences.profile as Record<string, unknown> | undefined),
      password_manager_enabled: false,
    };
    await writeFile(preferencesPath, JSON.stringify(preferences), {
      mode: 0o600,
    });
  }
  options.signal.throwIfAborted();
  // HAR recording must be configured at context creation, unavailable on CDP's
  // existing persistent context. Keep the native Playwright path for --har.
  if (engine === 'seleniumbase' && !options.har)
    return launchSeleniumContext(path, {
      headless:
        !options.login &&
        !options.visible &&
        process.env.TRADING_BROWSER_HEADED !== '1',
      port: options.port,
      signal: options.signal,
    });
  return chromium.launchPersistentContext(path, {
    headless:
      !options.login &&
      !options.visible &&
      process.env.TRADING_BROWSER_HEADED !== '1',
    executablePath: process.env.TRADING_CHROMIUM_PATH || undefined,
    acceptDownloads: false,
    args: [
      '--disable-save-password-bubble',
      '--disable-features=PasswordManagerOnboarding,PasswordLeakDetection',
      ...(options.login && options.port !== undefined
        ? [
            `--remote-debugging-port=${options.port ?? 9222}`,
            '--remote-debugging-address=127.0.0.1',
          ]
        : []),
    ],
    ...(options.har
      ? { recordHar: { path: options.har, mode: 'full' as const } }
      : {}),
  });
}

async function readRevision(name: string) {
  return readFile(resolve(profilePath(name), '.login-ready'), 'utf8').catch(
    () => '',
  );
}
/**
 * Dấu "phiên trong hồ sơ đã xác nhận đúng tài khoản": băm email đã lưu + revision hồ sơ lúc xác nhận.
 * Đăng nhập tay sau đó (revision đổi) hoặc đổi tài khoản lưu → dấu không còn hợp lệ.
 */
const verifiedPath = (name: string) =>
  resolve(profilePath(name), '.verified-account');
const accountHash = (username: string) =>
  createHash('sha256').update(username.trim().toLowerCase()).digest('hex');
async function isVerified(name: string, username: string) {
  const mark = await readFile(verifiedPath(name), 'utf8').catch(() => '');
  return mark === `${accountHash(username)}:${await readRevision(name)}`;
}
async function markVerified(name: string, username: string) {
  await writeFile(
    verifiedPath(name),
    `${accountHash(username)}:${await readRevision(name)}`,
    { mode: 0o600 },
  );
}
async function clearVerified(name: string) {
  try {
    await writeFile(verifiedPath(name), '', { mode: 0o600 });
  } catch {
    // không ghi được dấu thì lần sau chỉ phải đăng nhập lại; không chặn luồng
  }
}

export async function loginReady(name: string) {
  await writeFile(resolve(profilePath(name), '.login-ready'), randomUUID(), {
    mode: 0o600,
  });
}

/** Refresh by letting the site's own session flow obtain its security token. No CAPTCHA bypass. */
export class EmpireSessions {
  private readonly cache = new Map<string, CacheEntry>();
  /** Lần làm mới đang chạy theo hồ sơ: lời gọi trùng dùng chung, không mở Chrome thứ hai. */
  private readonly inflight = new Map<
    string,
    {
      revision: string;
      promise: Promise<EmpireSession>;
      abort: AbortController;
    }
  >();
  constructor(
    private readonly locks: AccountLock,
    /** Báo khi làm mới hỏng tạm thời và đang dùng tiếp token cũ (để ghi log). */
    private readonly onStaleToken?: (
      browserProfile: string,
      error: string,
    ) => void,
    /** Thông tin thăm dò (API trang gọi, vị trí trường số dư) sau khi lấy phiên xong, để ghi log. */
    private readonly onProbe?: (browserProfile: string, info: string) => void,
    /**
     * Hồ sơ đang được dùng ở nơi khác trong tiến trình (Chrome nền đọc số dư): `acquire` đóng nó
     * trước khi mở Chrome làm mới phiên. Sau khi lấy JWT thành công, `adopt` có thể nhận luôn
     * context/tab vừa đăng nhập; `release` kết thúc thời gian nhường hồ sơ.
     */
    private readonly profileHooks?: {
      acquire(browserProfile: string): Promise<void>;
      adopt?(
        browserProfile: string,
        context: BrowserContext,
        page: Page,
        expected?: string,
        headers?: Record<string, string>,
      ): Promise<boolean>;
      release(browserProfile: string): void;
    },
    /**
     * Tự lấy phiên hỏng liên tiếp tới hết số lần thử (gave up) / lấy lại được sau đó (recovered):
     * để báo người vận hành bấm Đăng nhập.
     */
    private readonly onSessionHealth?: (
      browserProfile: string,
      event:
        | { type: 'gave_up'; error: string; attempts: number }
        | { type: 'recovered' },
    ) => void,
  ) {}

  /** Lần tự lấy phiên hỏng liên tiếp theo hồ sơ (không tính đăng nhập tay). */
  private readonly failures = new Map<
    string,
    {
      revision: string;
      count: number;
      nextAt: number;
      lastError: string;
      gaveUp: boolean;
    }
  >();

  /** Trạng thái tự lấy phiên (cho trang Tài khoản / chẩn đoán). */
  sessionFailures(browserProfile: string) {
    const f = this.failures.get(browserProfile);
    return f ? { ...f } : null;
  }

  /**
   * Worker báo BetBy từ chối JWT này (401 khi còn hạn): nếu đó vẫn là JWT đang giữ thì lần get() kế
   * tiếp phải làm mới (mở Chrome lấy JWT mới), không dùng tiếp. `tokenHash` = sha256(JWT) 16 ký tự
   * đầu (không truyền JWT qua kênh worker → backend). Trả true nếu đã đánh dấu.
   */
  invalidate(browserProfile: string, tokenHash: string): boolean {
    const cached = this.cache.get(browserProfile);
    if (!cached?.session) return false;
    if (tokenFingerprint(cached.session.token) !== tokenHash) return false;
    // nhiều lệnh cùng bị 401 trong lúc làm mới: chỉ ép làm mới tối đa 1 lần / phút
    const now = Date.now();
    if (cached.invalidatedAt && now - cached.invalidatedAt < 60_000)
      return false;
    cached.invalidatedAt = now;
    cached.refreshAt = 0;
    // không dùng tiếp JWT đã bị từ chối khi làm mới lỗi tạm thời
    cached.retryAt = 0;
    return true;
  }

  async get(
    browserProfile: string,
    options: EmpireSessionOptions = {},
  ): Promise<EmpireSession> {
    const revision = `${await readRevision(browserProfile)}:${options.credentialsVersion ?? ''}`;
    const cached = this.cache.get(browserProfile);
    const now = Date.now();
    const failed = this.failures.get(browserProfile);
    if (failed && failed.revision !== revision)
      this.failures.delete(browserProfile);
    const fail = this.failures.get(browserProfile);
    if (!options.force && fail) {
      // đã thử đủ số lần: dừng, chờ người bấm Đăng nhập (không mở Chrome mỗi nhịp 30 giây)
      if (fail.gaveUp)
        throw new Error(
          `CSGOEMPIRE_SESSION_GAVE_UP: tự lấy phiên hỏng ${fail.count} lần liên tiếp (${fail.lastError}) — bấm Đăng nhập`,
        );
      // chưa tới lượt thử lại: không mở Chrome; còn JWT dùng được thì dùng, không thì báo lỗi lần trước
      if (now < fail.nextAt) {
        if (
          cached?.session &&
          cached.revision === revision &&
          usable(cached.session, now)
        )
          return cached.session;
        throw new Error(fail.lastError);
      }
    }
    if (!options.force && cached?.revision === revision) {
      // lỗi lâu dài đã ghi: chỉ thử lại khi tới lượt (tối đa SESSION_RETRY_DELAYS_MS lần)
      if (cached.error && !(fail && now >= fail.nextAt))
        throw new Error(cached.error);
      if (cached.session && now < cached.refreshAt) return cached.session;
      // vừa làm mới hỏng: chưa thử lại, dùng tiếp token cũ còn hạn
      if (
        cached.session &&
        now < (cached.retryAt ?? 0) &&
        usable(cached.session, now)
      )
        return cached.session;
    }
    let running = this.inflight.get(browserProfile);
    if (running && running.revision === revision && !options.force)
      return running.promise;
    // Khi tài khoản/mật khẩu đổi, hủy lần lấy phiên đang dùng thông tin cũ.
    // Lần đăng nhập tay cùng phiên bản vẫn chờ để không mở hai Chrome cùng hồ sơ.
    while (running) {
      if (running.revision !== revision) running.abort.abort();
      await running.promise.catch(() => undefined);
      running = this.inflight.get(browserProfile);
      if (running?.revision === revision && !options.force)
        return running.promise;
    }
    const abort = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, abort.signal])
      : abort.signal;
    const effectiveOptions = { ...options, signal };
    const promise = this.refresh(
      browserProfile,
      revision,
      effectiveOptions,
      this.cache.get(browserProfile),
    ).then(
      (session) => {
        // lấy được phiên (tự động hay đăng nhập tay): xóa đếm lỗi; trước đó đã bỏ cuộc → báo đã ổn
        const before = this.failures.get(browserProfile);
        this.failures.delete(browserProfile);
        if (before?.gaveUp)
          this.onSessionHealth?.(browserProfile, { type: 'recovered' });
        return session;
      },
      (e: unknown) => {
        if (!options.force && !signal.aborted)
          this.countFailure(browserProfile, revision, e);
        throw e;
      },
    );
    const job = { revision, promise, abort };
    this.inflight.set(browserProfile, job);
    try {
      return await promise;
    } finally {
      if (this.inflight.get(browserProfile) === job)
        this.inflight.delete(browserProfile);
    }
  }

  /** Một lần tự lấy phiên hỏng: hẹn lần thử kế (giãn dần); hết lượt → bỏ cuộc và báo. */
  private countFailure(browserProfile: string, revision: string, e: unknown) {
    const code =
      e instanceof Error
        ? e.message.split(':')[0].trim()
        : 'CSGOEMPIRE_SESSION_REFRESH_FAILED';
    const prev = this.failures.get(browserProfile);
    const count = (prev?.revision === revision ? prev.count : 0) + 1;
    // cần người thật (CAPTCHA / xác minh): thử lại vô ích → bỏ cuộc ngay
    const hopeless = code === 'CSGOEMPIRE_VERIFICATION_REQUIRED';
    const gaveUp = hopeless || count > SESSION_RETRY_DELAYS_MS.length;
    this.failures.set(browserProfile, {
      revision,
      count,
      nextAt:
        Date.now() +
        (SESSION_RETRY_DELAYS_MS[count - 1] ?? SESSION_RETRY_DELAYS_MS.at(-1)!),
      lastError: e instanceof Error ? e.message : code,
      gaveUp,
    });
    if (gaveUp && !prev?.gaveUp)
      this.onSessionHealth?.(browserProfile, {
        type: 'gave_up',
        error: e instanceof Error ? e.message : code,
        attempts: count,
      });
  }

  /**
   * Làm mới; hỏng vì lý do TẠM THỜI (tài khoản bận, hết chỗ mở Chrome, trang / mạng lỗi) mà token cũ
   * còn hạn thì trả token cũ và hẹn thử lại. Lỗi được phân loại là lâu dài (cần đăng nhập lại, sai
   * tài khoản, phiên hết hạn...) vẫn ném ra như cũ.
   */
  private async refresh(
    browserProfile: string,
    revision: string,
    options: EmpireSessionOptions,
    before: CacheEntry | undefined,
  ): Promise<EmpireSession> {
    try {
      try {
        return await this.open(browserProfile, revision, options);
      } catch (e) {
        if (!(e instanceof Error && e.message === RELOGIN)) throw e;
        // cookie đã xóa: lần này trang hiện form, app gõ tài khoản/mật khẩu đã lưu
        return await this.open(browserProfile, revision, {
          ...options,
          relogin: true,
        });
      }
    } catch (e) {
      const keep =
        !options.force &&
        !options.signal?.aborted &&
        before?.session &&
        !before.error &&
        before.revision === revision &&
        // open() không ghi lỗi lâu dài vào cache
        this.cache.get(browserProfile) === before &&
        usable(before.session, Date.now());
      if (!keep) throw e;
      const code =
        e instanceof Error
          ? e.message.split(':')[0].trim()
          : 'CSGOEMPIRE_SESSION_REFRESH_FAILED';
      this.cache.set(browserProfile, {
        ...before,
        retryAt: Date.now() + RETRY_AFTER_FAILURE_MS,
        lastError: code,
      });
      this.onStaleToken?.(browserProfile, code);
      return before.session!;
    }
  }

  private open(
    browserProfile: string,
    revision: string,
    options: EmpireSessionOptions,
  ): Promise<EmpireSession> {
    return this.locks.with(
      [accountResource('csgoempire', browserProfile)],
      async () => {
        let context: BrowserContext | undefined;
        let acquired = false;
        let adopted = false;
        const signal = options.signal ?? new AbortController().signal;
        /** Lần này app có gõ tài khoản/mật khẩu đã lưu vào form không (hay dùng phiên có sẵn). */
        let typedCredentials = false;
        const stage = (next: EmpireLoginStage) => {
          if (next === 'signing_in') typedCredentials = true;
          options.onStage?.(next);
        };
        let step: EmpireLoginDiagnostic['step'] = 'browser';
        let lastHttp: number | undefined;
        const checkpoint = (
          next: EmpireLoginDiagnostic['step'],
          httpStatus?: number,
          sessionIssue?: EmpireLoginDiagnostic['sessionIssue'],
          extra: Pick<EmpireLoginDiagnostic, 'accountIssue' | 'cause'> = {},
        ) => {
          step = next;
          lastHttp = httpStatus;
          options.onDiagnostic?.({
            step,
            ...(httpStatus ? { httpStatus } : {}),
            ...(sessionIssue ? { sessionIssue } : {}),
            ...extra,
          });
        };
        const onAbort = () => {
          void context?.close().catch(() => undefined);
        };
        try {
          signal.throwIfAborted();
          stage('opening');
          checkpoint('browser');
          await this.profileHooks?.acquire(browserProfile);
          acquired = true;
          context = await launchProfile(browserProfile, {
            login: options.headed,
            signal,
            slotWaitMs: options.headed ? undefined : BACKGROUND_SLOT_WAIT_MS,
          });
          signal.addEventListener('abort', onAbort, { once: true });
          signal.throwIfAborted();
          const startupPages = context.pages();
          const page = await context.newPage();
          await Promise.allSettled(
            startupPages
              .filter((candidate) => candidate !== page)
              .map((candidate) => candidate.close()),
          );
          signal.throwIfAborted();
          // Ghi lại các API csgoempire mà CHÍNH trang gọi (đường dẫn + mã HTTP, không lưu nội dung),
          // và giữ phản hồi /api/v2/metadata (người dùng) của trang nếu có.
          const seen = observeSiteApi(page);
          let sessionReceived = false;
          const response = page.waitForResponse(
            async (r) => {
              const u = new URL(r.url());
              const matches =
                u.origin === 'https://csgoempire.com' &&
                u.pathname.startsWith(
                  '/api/v2/match-betting/betby/user-session/',
                );
              if (!matches) return false;
              if (!r.ok()) return !options.credentials;
              const payload: unknown = await r.json().catch(() => null);
              // An unauthenticated page can reply HTTP 200 / success:true
              // with an empty token. That must not skip the login form.
              if (!sessionToken(payload)) return false;
              sessionReceived = true;
              return true;
            },
            // Listen before navigation so early responses are not missed. Each
            // phase below owns its timeout; close() cancels this listener.
            { timeout: 0 },
          );
          // Attach immediately so a failed navigation cannot leave an unhandled rejection.
          void response.catch(() => undefined);
          checkpoint('page');
          await page.goto('https://csgoempire.com/match-betting', {
            waitUntil: 'domcontentloaded',
            timeout: 45_000,
          });
          if (options.credentials) {
            checkpoint('login');
            await autoLogin(page, options.credentials, {
              sessionReceived: () => sessionReceived,
              signal,
              stage,
              onDiagnostic: options.onDiagnostic,
            });
          }
          stage('obtaining_session');
          checkpoint('jwt');
          // Watch only visible verification/error state while awaiting the site's session response.
          let monitor: ReturnType<typeof setInterval> | undefined;
          let sessionTimeout: ReturnType<typeof setTimeout> | undefined;
          let checking = false;
          const verifiedResponse = new Promise<Awaited<typeof response>>(
            (resolveResponse, reject) => {
              void response.then(resolveResponse, reject);
              // Start the JWT budget after UI login completes, not before the
              // initial page load and potentially slow authentication step.
              sessionTimeout = setTimeout(
                () => reject(new Error('CSGOEMPIRE_SESSION_RESPONSE_FAILED')),
                45_000,
              );
              monitor = setInterval(() => {
                if (checking) return;
                checking = true;
                void assertNoVerification(page)
                  .catch(reject)
                  .finally(() => {
                    checking = false;
                  });
              }, 500);
            },
          );
          let res: Awaited<typeof response>;
          try {
            res = await verifiedResponse;
          } finally {
            if (monitor) clearInterval(monitor);
            clearTimeout(sessionTimeout);
          }
          // Saved profiles commonly use coins (EMP). Change the site's display
          // currency and use its replacement session; never relabel an EMP JWT.
          if (res.ok()) {
            const initialToken = sessionToken(await res.json());
            let initialCurrency: unknown;
            try {
              const claims = JSON.parse(
                Buffer.from(
                  initialToken?.split('.')[1] ?? '',
                  'base64url',
                ).toString(),
              ) as { currency?: unknown } | null;
              initialCurrency = claims?.currency;
            } catch {
              // The validation below reports malformed tokens precisely.
            }
            if (['EMP', 'EUR', 'GBP'].includes(String(initialCurrency))) {
              checkpoint('currency');
              res = await selectUsdSession(page, signal);
            }
          }
          checkpoint('jwt', res.status());
          if (res.status() >= 500)
            throw new Error('CSGOEMPIRE_SESSION_REFRESH_FAILED');
          if (!res.ok())
            throw new Error(
              res.status() === 401
                ? SESSION_EXPIRED
                : 'CSGOEMPIRE_SESSION_REQUEST_REJECTED',
            );
          const data: unknown = await res.json();
          const token = sessionToken(data);
          if (!token) throw new Error('CSGOEMPIRE_SESSION_REQUEST_REJECTED');
          function invalidSession(
            issue: NonNullable<EmpireLoginDiagnostic['sessionIssue']>,
            httpStatus = res.status(),
          ): never {
            checkpoint(step, httpStatus, issue);
            throw new Error('CSGOEMPIRE_SESSION_INVALID');
          }
          let claims: unknown;
          try {
            claims = JSON.parse(
              Buffer.from(token.split('.')[1] ?? '', 'base64url').toString(),
            );
          } catch {
            invalidSession('token_malformed');
          }
          if (!claims || typeof claims !== 'object' || Array.isArray(claims))
            invalidSession('token_malformed');
          const payload = claims as {
            exp?: unknown;
            iat?: unknown;
            currency?: unknown;
          };
          if (
            typeof payload.exp !== 'number' ||
            !Number.isFinite(payload.exp) ||
            !Number.isFinite(payload.exp * 1000)
          )
            invalidSession('expiry_invalid');
          const expiresAt = payload.exp * 1000;
          if (expiresAt < Date.now() + 60_000)
            invalidSession('expiry_too_short');
          if (
            payload.currency === undefined ||
            payload.currency === null ||
            payload.currency === ''
          )
            invalidSession('currency_missing');
          if (payload.currency !== 'USD')
            invalidSession('currency_unsupported');
          const sessionId = randomUUID();
          // Origin/brand observed in the supplied HAR. No request data or secrets imported from the HAR.
          const apiUrl = 'https://api-h-c7818b61-608.sptpub.com';
          const brandId = '2432911154364948480';
          checkpoint('identify');
          const identify = await fetch(
            `${apiUrl}/api/v2/auth/brand/${brandId}/identify`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                'X-Session-Id': sessionId,
                Origin: 'https://csgoempire.com',
                Referer: 'https://csgoempire.com/',
              },
              signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
              redirect: 'error',
            },
          );
          checkpoint('identify', identify.status);
          if (identify.status >= 500)
            throw new Error('CSGOEMPIRE_SESSION_REFRESH_FAILED');
          if (!identify.ok)
            throw new Error(
              identify.status === 401
                ? SESSION_EXPIRED
                : 'CSGOEMPIRE_SESSION_IDENTIFY_FAILED',
            );
          const who = (await identify.json()) as {
            currency?: string;
            currency_detail?: { min_bet?: string };
            geo?: { blocked?: boolean };
            blocked_rm?: boolean;
          };
          const identifyFields = [
            ...Object.keys(who).slice(0, 30),
            ...balanceFields(who).map((f) => `[số dư] ${f}`),
          ].join(', ');
          if (who.geo?.blocked || who.blocked_rm)
            throw new Error('CSGOEMPIRE_SESSION_ACCESS_BLOCKED');
          if (who.currency !== 'USD')
            invalidSession('identify_currency_unsupported', identify.status);
          // Đọc ngay trong Chrome vừa đăng nhập (cùng cookie, User-Agent, TLS): request "trần" từ Node
          // dễ bị Cloudflare chặn vì cookie chống bot gắn với chính trình duyệt đã nhận nó.
          let inPage = seen.user() ?? (await readUserInPage(page));
          // Vừa đăng nhập xong, cookie có thể chưa kịp có hiệu lực: đọc lại vài lần trước khi kết luận.
          for (
            let retry = 0;
            retry < 3 && accountIssue(inPage) === 'not_logged_in';
            retry++
          ) {
            await page.waitForTimeout(1_000);
            inPage = seen.user() ?? (await readUserInPage(page));
          }
          const userAgent = inPage.userAgent || undefined;
          if (options.credentials) {
            checkpoint('account');
            const issue = accountIssue(inPage);
            const account = (inPage.body ?? {}) as {
              success?: boolean;
              username?: string;
              email?: string;
            };
            const expected = options.credentials.username.trim().toLowerCase();
            const identities = [account.username, account.email].filter(
              (v): v is string => typeof v === 'string' && !!v.trim(),
            );
            // chỉ kết luận "tài khoản khác" khi sàn THỰC SỰ trả email/username để so
            const wrongAccount =
              !issue &&
              identities.length > 0 &&
              !identities.some((v) => v.trim().toLowerCase() === expected);
            // Sàn không cho đọc, hoặc đọc được nhưng không có email/username để so: không tự xác nhận
            // được → dùng việc gõ đúng tài khoản đã lưu / dấu đã xác nhận trước đó.
            const unreadable =
              issue === 'http_error' ||
              issue === 'challenge' ||
              issue === 'not_json' ||
              issue === 'network' ||
              (!issue && identities.length === 0);
            const apiNote = `API trang đã gọi: ${seen.summary() || 'không thấy'}`;
            const verifiedBefore =
              unreadable &&
              !typedCredentials &&
              (await isVerified(browserProfile, options.credentials.username));
            if (verifiedBefore) {
              // phiên có sẵn trong hồ sơ, đã được xác nhận ở lần đăng nhập trước: không đăng nhập lại
              checkpoint('account', inPage.status || undefined, undefined, {
                ...(issue ? { accountIssue: issue } : {}),
                cause: `Không đọc được thông tin tài khoản (${inPage.detail ?? issue ?? 'sàn không trả email'}); dùng phiên đã xác nhận ở lần đăng nhập trước.`,
              });
            } else if (unreadable && typedCredentials) {
              // Vừa gõ đúng email/mật khẩu đã lưu và sàn cấp phiên → phiên này là của tài khoản đó.
              checkpoint('account', inPage.status || undefined, undefined, {
                ...(issue ? { accountIssue: issue } : {}),
                cause:
                  `Không đọc được thông tin tài khoản (${inPage.detail ?? issue ?? 'sàn không trả email'}); đã xác nhận bằng việc đăng nhập bằng email đã lưu. ${apiNote}`.slice(
                    0,
                    400,
                  ),
              });
            } else {
              // Hồ sơ giữ phiên cũ (chưa đăng nhập / 401), phiên của tài khoản KHÁC, hoặc phiên có sẵn
              // mà không đọc được tài khoản để kiểm tra: xóa cookie csgoempire rồi đăng nhập lại từ đầu
              // bằng tài khoản đã lưu (một lần) — sau đó việc gõ đúng tài khoản là bằng chứng xác nhận.
              const stale =
                issue === 'not_logged_in' ||
                inPage.status === 401 ||
                wrongAccount ||
                unreadable;
              if (stale && !options.relogin) {
                checkpoint('account', inPage.status || undefined, undefined, {
                  cause: wrongAccount
                    ? 'Hồ sơ đang đăng nhập tài khoản khác — xóa phiên cũ, đăng nhập lại'
                    : unreadable
                      ? `Không đọc được tài khoản của phiên có sẵn (${inPage.detail ?? issue ?? 'sàn không trả email'}) — đăng nhập lại bằng email đã lưu để xác nhận`
                      : 'Phiên trong hồ sơ đã cũ — xóa phiên cũ, đăng nhập lại',
                });
                await context.clearCookies({
                  domain: /(^|\.)csgoempire\.com$/,
                });
                await clearVerified(browserProfile);
                throw new Error(RELOGIN);
              }
              checkpoint('account', inPage.status || undefined, undefined, {
                ...(issue ? { accountIssue: issue } : {}),
                ...(issue || unreadable
                  ? {
                      cause:
                        `${issue ? '' : 'Sàn không trả email/username để so với tài khoản đã lưu. '}${inPage.detail ? `${inPage.detail}. ` : ''}${apiNote}`.slice(
                          0,
                          400,
                        ),
                    }
                  : {}),
              });
              if (inPage.status === 401) throw new Error(SESSION_EXPIRED);
              // không đọc được / sàn không trả email để so, và không gõ form được → không xác nhận được
              if (issue || unreadable)
                throw new Error('CSGOEMPIRE_SESSION_ACCOUNT_FAILED');
              if (wrongAccount)
                throw new Error('CSGOEMPIRE_LOGIN_ACCOUNT_MISMATCH');
            }
          }
          const session = {
            browserProfile,
            token,
            expiresAt,
            apiUrl,
            brandId,
            sessionId,
            minBet: Number(who.currency_detail?.min_bet ?? '0.1'),
            ...(userAgent ? { userAgent } : {}),
          };
          const issued =
            typeof payload.iat === 'number' && Number.isFinite(payload.iat)
              ? payload.iat * 1000
              : Date.now();
          if (options.headed) await loginReady(browserProfile);
          // ghi dấu SAU loginReady để khớp revision hiện tại của hồ sơ
          if (options.credentials)
            await markVerified(browserProfile, options.credentials.username);
          const cacheRevision = options.headed
            ? `${await readRevision(browserProfile)}:${options.credentialsVersion ?? ''}`
            : revision;
          signal.throwIfAborted();
          this.cache.set(browserProfile, {
            revision: cacheRevision,
            session,
            // Refresh normal 30-minute tokens with 10 minutes left. If the
            // provider issues a shorter token, avoid refreshing on every poll.
            refreshAt:
              expiresAt - REFRESH_BEFORE_EXPIRY_MS > issued
                ? expiresAt - REFRESH_BEFORE_EXPIRY_MS
                : issued + (expiresAt - issued) * 0.8,
          });
          stage('ready');
          if (options.headed)
            this.onProbe?.(
              browserProfile,
              `identify BetBy gồm: ${identifyFields || '—'} || API trang đã gọi: ${seen.summary() || 'không thấy'} || trường giống số dư: ${seen.balances() || 'không thấy'}`,
            );
          if (this.profileHooks?.adopt)
            adopted = await this.profileHooks
              .adopt(
                browserProfile,
                context,
                page,
                options.credentials?.username,
                await seen.headers(),
              )
              .catch(() => false);
          return session;
        } catch (e) {
          if (signal.aborted)
            throw new Error('CSGOEMPIRE_LOGIN_CANCELLED', { cause: e });
          // không ghi vào cache như lỗi lâu dài: refresh() sẽ mở lại và đăng nhập từ đầu
          if (e instanceof Error && e.message === RELOGIN) throw e;
          if (
            e instanceof Error &&
            /^CSGOEMPIRE_(VERIFICATION_REQUIRED|LOGIN_|BROWSER_CLOSED)/.test(
              e.message,
            )
          ) {
            this.cache.set(browserProfile, {
              revision,
              refreshAt: 0,
              error: e.message,
            });
            throw e;
          }
          // Do not turn navigation errors, timeouts, or invalid API responses
          // into a false diagnosis that the user's login has expired.
          if (!context)
            throw new Error(
              e instanceof Error && e.message === 'BROWSER_SLOTS_BUSY'
                ? 'CSGOEMPIRE_BROWSER_SLOTS_BUSY'
                : 'CSGOEMPIRE_BROWSER_UNAVAILABLE',
              { cause: e },
            );
          if (!(e instanceof Error && e.message.startsWith('CSGOEMPIRE_'))) {
            // Lỗi ngoài dự kiến (timeout, mạng, Playwright...): giữ lý do thật để web + log hiện được.
            checkpoint(step, lastHttp, undefined, {
              cause: describeCause(e, options.credentials),
            });
            throw new Error(STEP_FAILURE[step], { cause: e });
          }
          if (e.message === 'CSGOEMPIRE_SESSION_REFRESH_FAILED')
            throw new Error('CSGOEMPIRE_SESSION_REFRESH_FAILED', { cause: e });
          const error = e.message;
          this.cache.set(browserProfile, { revision, refreshAt: 0, error });
          throw new Error(error, { cause: e });
        } finally {
          signal.removeEventListener('abort', onAbort);
          if (!adopted) await context?.close();
          if (acquired) this.profileHooks?.release(browserProfile);
        }
      },
      { waitMs: LOCK_WAIT_MS, signal: options.signal },
    );
  }
}

/** Dấu vân tay JWT (sha256, 16 ký tự hex đầu): để worker báo JWT nào bị từ chối mà không gửi JWT. */
export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

interface CacheEntry {
  revision: string;
  refreshAt: number;
  session?: EmpireSession;
  error?: string;
  /** Lần làm mới vừa hỏng tạm thời: chưa thử lại trước mốc này. */
  retryAt?: number;
  /** Lần gần nhất worker báo JWT đang giữ bị BetBy từ chối (giới hạn ép làm mới). */
  invalidatedAt?: number;
  lastError?: string;
}

const usable = (s: EmpireSession, now: number) =>
  s.expiresAt > now + STALE_TOKEN_MARGIN_MS;

interface InPageUser {
  status: number;
  body: unknown;
  /** Phản hồi là HTML thay vì JSON. */
  html: boolean;
  /** Dấu hiệu trang chống bot của Cloudflare. */
  challenge: boolean;
  userAgent: string;
  detail: string | null;
}

/** GET /api/v2/metadata trong chính trang csgoempire (fetch của trình duyệt, kèm cookie của nó). */
async function readUserInPage(page: {
  evaluate: <R>(fn: () => Promise<R>) => Promise<R>;
}): Promise<InPageUser> {
  try {
    return await page.evaluate(async () => {
      const userAgent = navigator.userAgent;
      try {
        // endpoint trang dùng để lấy người dùng + số dư (đã thấy trong log thăm dò)
        const r = await fetch('https://csgoempire.com/api/v2/metadata', {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        const text = await r.text();
        let body: unknown = null;
        try {
          const meta = JSON.parse(text) as { user?: unknown };
          // chuẩn hóa: { success, ...user } — khách (chưa đăng nhập) không có user
          body =
            meta && typeof meta.user === 'object' && meta.user !== null
              ? { success: true, ...meta.user }
              : { success: false };
        } catch {
          body = null;
        }
        const challenge =
          r.headers.get('cf-mitigated') === 'challenge' ||
          /just a moment|challenge-platform|cf-chl|attention required/i.test(
            text,
          );
        return {
          status: r.status,
          body,
          html: body === null && /<html|<!doctype/i.test(text),
          challenge,
          userAgent,
          detail:
            body === null
              ? `HTTP ${r.status}, ${r.headers.get('content-type') ?? 'không rõ kiểu'}${
                  /<title[^>]*>([^<]{1,100})/i.exec(text)?.[1]
                    ? ` "${/<title[^>]*>([^<]{1,100})/i.exec(text)![1].trim()}"`
                    : ''
                }`
              : null,
        };
      } catch (e) {
        return {
          status: 0,
          body: null,
          html: false,
          challenge: false,
          userAgent,
          detail: `fetch trong trình duyệt lỗi: ${String(e).slice(0, 120)}`,
        };
      }
    });
  } catch (e) {
    return {
      status: 0,
      body: null,
      html: false,
      challenge: false,
      userAgent: '',
      detail: `không chạy được script trong trang: ${
        e instanceof Error ? e.message.split('\n')[0].slice(0, 120) : 'lỗi'
      }`,
    };
  }
}

function accountIssue(
  r: InPageUser,
): EmpireLoginDiagnostic['accountIssue'] | null {
  if (r.challenge) return 'challenge';
  if (r.status === 0) return 'network';
  if (r.status === 401) return null; // báo SESSION_EXPIRED riêng
  if (r.status < 200 || r.status >= 300) return 'http_error';
  if (r.body === null || typeof r.body !== 'object') return 'not_json';
  if ((r.body as { success?: unknown }).success !== true)
    return 'not_logged_in';
  return null;
}

/** Dòng đầu của lỗi, cắt ngắn, che tài khoản/mật khẩu nếu lọt vào thông báo. */
export function describeCause(
  e: unknown,
  credentials?: EmpireCredentials,
): string {
  let msg =
    e instanceof Error
      ? `${e.name !== 'Error' ? `${e.name}: ` : ''}${e.message}`
      : String(e);
  const lines = msg.split('\n').map((l) => l.trim());
  msg = lines[0] ?? '';
  // Playwright ghi lý do thật trong call log (vd "element is not enabled", "<div> intercepts
  // pointer events"): lấy dòng cuối có lý do đó, không chỉ "Timeout 10000ms exceeded".
  const reason = [...lines]
    .reverse()
    .find((l) =>
      /element is not|intercepts pointer events|not enabled|not visible|not stable|disabled|detached/i.test(
        l,
      ),
    );
  if (reason && reason !== msg) msg = `${msg} — ${reason.replace(/^-\s*/, '')}`;
  for (const secret of [credentials?.password, credentials?.username])
    if (secret) msg = msg.split(secret).join('***');
  return msg.slice(0, 300);
}

/** Đường dẫn API đã bỏ query và thay các đoạn định danh (số dài, uuid, token) bằng :id. */
function apiPath(url: URL) {
  return url.pathname
    .split('/')
    .map((seg) =>
      /^\d{3,}$/.test(seg) ||
      /^[0-9a-f-]{20,}$/i.test(seg) ||
      /^[\w-]{32,}$/.test(seg)
        ? ':id'
        : seg,
    )
    .join('/');
}

/** Vị trí các trường có tên giống số dư trong một JSON (chỉ đường dẫn + kiểu, KHÔNG lấy giá trị). */
export function balanceFields(body: unknown, limit = 6): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (out.length >= limit || depth > 5 || v === null || typeof v !== 'object')
      return;
    const entries = Array.isArray(v)
      ? v.slice(0, 3).map((x, i) => [String(i), x] as const)
      : Object.entries(v as Record<string, unknown>);
    for (const [k, x] of entries) {
      const p = path ? `${path}.${k}` : k;
      if (
        /balance|wallet|funds|available/i.test(k) &&
        x !== null &&
        typeof x !== 'object'
      )
        out.push(`${p}:${typeof x}`);
      else walk(x, p, depth + 1);
      if (out.length >= limit) return;
    }
  };
  walk(body, '', 0);
  return out;
}

/**
 * Theo dõi các request API csgoempire + BetBy (sptpub) do chính trang gửi: đường dẫn + mã HTTP, không
 * lưu nội dung/query. Ghi lại VỊ TRÍ các trường giống số dư (không ghi số tiền) để tìm nguồn đọc số dư.
 * Nếu trang tự gọi /api/v2/metadata thành công thì giữ lại người dùng trong đó để dùng.
 */
function observeSiteApi(page: {
  on?: (event: 'response', fn: (r: BrowserResponse) => void) => unknown;
}) {
  const calls: string[] = [];
  const balances: string[] = [];
  let user: InPageUser | null = null;
  let headers = Promise.resolve<Record<string, string>>({});
  page.on?.('response', (r: BrowserResponse) => {
    let url: URL;
    try {
      url = new URL(r.url());
    } catch {
      return;
    }
    const empire =
      /(^|\.)csgoempire\.com$/.test(url.hostname) &&
      url.pathname.startsWith('/api/');
    const betby = /(^|\.)sptpub\.com$/.test(url.hostname);
    if (!empire && !betby) return;
    const label = `${betby ? 'betby' : 'empire'}${apiPath(url)}`;
    if (calls.length < 60) calls.push(`${label} ${r.status()}`);
    if (empire && url.pathname === '/api/v2/metadata' && r.ok()) {
      headers = r
        .request()
        .allHeaders()
        .then((all) =>
          Object.fromEntries(
            Object.entries(all).filter(([key]) =>
              /^x-(empire|env)-/i.test(key),
            ),
          ),
        )
        .catch(() => ({}));
      void r
        .json()
        .then((meta: { user?: unknown } | null) => {
          if (!meta || typeof meta.user !== 'object' || meta.user === null)
            return; // khách: để bước đọc trong trang kết luận
          user = {
            status: r.status(),
            body: { success: true, ...meta.user },
            html: false,
            challenge: false,
            userAgent: '',
            detail: null,
          };
        })
        .catch(() => undefined);
    }
    const type = r.headers()['content-type'] ?? '';
    if (r.ok() && /json/i.test(type) && balances.length < 12)
      void r
        .json()
        .then((body: unknown) => {
          const fields = balanceFields(body);
          if (fields.length) balances.push(`${label} → ${fields.join(', ')}`);
        })
        .catch(() => undefined);
  });
  return {
    user: () => user,
    headers: () => headers,
    summary: () => [...new Set(calls)].slice(0, 25).join(', '),
    balances: () => [...new Set(balances)].join(' | '),
  };
}
