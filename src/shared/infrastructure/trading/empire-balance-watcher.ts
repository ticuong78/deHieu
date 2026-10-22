import type { BrowserContext, Page, Response } from 'playwright';
import { accountResource, type EmpireBalanceSnapshot } from './account-lock.js';
import { closeProfile, launchProfile } from './empire-session.js';
import { empireBalanceFrom } from './venue-orders.js';

/** Nơi ghi số dư (Redis qua AccountLock) để worker vào lệnh đọc. */
export interface EmpireBalanceSink {
  saveEmpireBalance(
    resource: string,
    snapshot: EmpireBalanceSnapshot,
  ): Promise<void>;
  saveEmpireBalanceError(resource: string, error: string): Promise<void>;
}

/** Một phản hồi API của trang (chỉ JSON công khai của chính tài khoản, không có cookie/token). */
interface ApiRead {
  status: number;
  json: unknown;
  type: string | null;
}

const PAGE = 'https://csgoempire.com/match-betting';
/** Tỷ giá coin → USD gần như cố định: đọc lại mỗi phút là đủ. */
const RATES_TTL_MS = 60_000;
/** Đọc lỗi liên tiếp: giãn nhịp đọc nền tối đa tới mức này. */
const MAX_BACKOFF_MS = 60_000;
/** Trang xin JWT BetBy (luồng phiên của bot dùng); Chrome nền KHÔNG được gọi. */
const BETBY_SESSION_PATH = '/api/v2/match-betting/betby/user-session/';
const META = '/api/v2/metadata';
const RATES = '/api/v2/metadata/exchange-rates';

function isApi(r: Response, path: string) {
  try {
    const u = new URL(r.url());
    return (
      /(^|\.)csgoempire\.com$/.test(u.hostname) &&
      u.pathname === path &&
      r.request().method() === 'GET'
    );
  } catch {
    return false;
  }
}

async function toRead(r: Response): Promise<ApiRead> {
  let json: unknown;
  try {
    json = await r.json();
  } catch {
    json = null;
  }
  return {
    status: r.status(),
    json,
    type: r.headers()['content-type'] ?? null,
  };
}

/**
 * Header riêng của csgoempire mà trang gửi kèm request API (vd x-empire-device-identifier,
 * x-env-class). Thiếu chúng, fetch trong trang bị 403. Chỉ giữ trong bộ nhớ, KHÔNG ghi log/Redis.
 */
async function siteHeaders(r: Response): Promise<Record<string, string>> {
  try {
    const h = await r.request().allHeaders();
    return Object.fromEntries(
      Object.entries(h).filter(([k]) => /^x-(empire|env)-/i.test(k)),
    );
  } catch {
    return {};
  }
}

/** Gọi API ngay trong trang (cùng cookie), kèm header riêng của trang. */
async function fetchInPage(
  page: Page,
  path: string,
  headers: Record<string, string>,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<ApiRead> {
  return page.evaluate(
    async ({ url, headers, method, body }) => {
      const r = await fetch(url, {
        method,
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let json: unknown;
      try {
        json = JSON.parse(await r.text());
      } catch {
        json = null;
      }
      return { status: r.status, json, type: r.headers.get('content-type') };
    },
    { url: path, headers, method: init.method ?? 'GET', body: init.body },
  );
}

/** Kết quả gọi API csgoempire trong Chrome nền (JSON của chính tài khoản). */
export type EmpireApiResult = ApiRead;

const norm = (v: string | null | undefined) => v?.trim().toLowerCase() || null;

/** Trang đang ở csgoempire.com (fetch đường dẫn tương đối / cookie đúng nguồn). */
function onEmpire(page: Page) {
  try {
    return /(^|\.)csgoempire\.com$/.test(new URL(page.url()).hostname);
  } catch {
    return false;
  }
}

const good = (r: ApiRead | null) => !!r && !!r.json && r.status < 400;

interface Watched {
  /** Còn cần đọc tới mốc này (profile chạy thật gọi want() mỗi nhịp đối chiếu 30 giây). */
  wantedUntil: number;
  /** >0: đang nhường hồ sơ cho bước làm mới phiên / đăng nhập (Chrome nền phải đóng). */
  paused: number;
  context: BrowserContext | null;
  page: Page | null;
  opening: Promise<void> | null;
  reading: Promise<EmpireBalanceSnapshot> | null;
  /** Lệnh gọi API (nạp/rút) đang chạy: xếp hàng, không chạy chồng với nhau. */
  calling: Promise<unknown> | null;
  /** Tỷ giá đọc gần nhất (gần như không đổi): dùng lại tới RATES_TTL_MS để mỗi nhịp chỉ 1 request. */
  rates: { read: ApiRead; at: number } | null;
  /** Số lần đọc lỗi liên tiếp → giãn nhịp đọc nền (không dội sàn khi đang bị từ chối). */
  failures: number;
  /** Nhịp đọc nền kế tiếp không sớm hơn mốc này (giãn khi lỗi). */
  nextAt: number;
  /** Số request cấp phiên BetBy mới đã chặn (chẩn đoán). */
  blockedBetby: number;
  /** Header riêng của trang (lấy từ request trang tự gửi); null = chưa có, phải mở lại trang. */
  headers: Record<string, string> | null;
  /** Tài khoản đã lưu (username/email, chữ thường) mà hồ sơ này PHẢI đang đăng nhập; null = không kiểm. */
  expected: string | null;
  last: EmpireBalanceSnapshot | null;
}

/**
 * Giữ MỘT Chrome chạy nền cho mỗi tài khoản csgoempire đang chạy thật và đọc số dư mỗi `intervalMs`
 * vào Redis. csgoempire chỉ trả /api/v2/metadata cho trình duyệt thật (request từ Node bị 403), còn
 * mở Chrome lúc vào lệnh thì quá chậm. Hồ sơ dùng chung với bước làm mới phiên: khi phiên cần làm
 * mới, Chrome nền đóng lại (pause) rồi mở lại sau (resume) — không bao giờ hai Chrome một hồ sơ.
 */
export class EmpireBalanceWatcher {
  private readonly watched = new Map<string, Watched>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sink: EmpireBalanceSink,
    private readonly log: (message: string) => void = () => undefined,
    private readonly intervalMs = 2_000,
    private readonly idleMs = 120_000,
  ) {}

  /** Profile chạy thật cần số dư của hồ sơ này (gọi lặp lại; thôi gọi quá `idleMs` thì đóng Chrome). */
  want(profile: string, expected?: string | null) {
    const w = this.entry(profile);
    if (expected !== undefined) w.expected = norm(expected);
    w.wantedUntil = Date.now() + this.idleMs;
    this.start();
    if (!w.last && !w.reading && !w.paused) void this.tick(profile);
  }

  /** Đọc ngay (nút "Kiểm tra số dư"): mở Chrome nền nếu chưa có, đọc, lưu và trả kết quả. */
  async readNow(
    profile: string,
    expected?: string | null,
  ): Promise<
    EmpireBalanceSnapshot & {
      username: string | null;
      email: string | null;
    }
  > {
    const w = this.entry(profile);
    if (expected !== undefined) w.expected = norm(expected);
    w.wantedUntil = Math.max(w.wantedUntil, Date.now() + this.idleMs);
    this.start();
    if (w.paused) throw new Error('CSGOEMPIRE_LOGIN_IN_PROGRESS');
    return this.read(profile, w, true) as Promise<
      EmpireBalanceSnapshot & { username: string | null; email: string | null }
    >;
  }

  /**
   * Gọi API csgoempire bằng Chrome nền của hồ sơ (cùng cookie + header riêng của trang, như trang tự gọi).
   * Dùng cho nạp/rút tiền. Mở Chrome nếu chưa có; chờ lượt đọc số dư đang chạy xong để không đụng nhau.
   * Không tự thử lại: request ghi (POST) có thể đã tới sàn.
   */
  async call(
    profile: string,
    path: string,
    init: { method?: 'GET' | 'POST'; body?: unknown } = {},
  ): Promise<EmpireApiResult> {
    if (!path.startsWith('/api/'))
      throw new Error('CSGOEMPIRE_API_PATH_INVALID');
    const w = this.entry(profile);
    w.wantedUntil = Math.max(w.wantedUntil, Date.now() + this.idleMs);
    this.start();
    const run = async () => {
      if (w.paused) throw new Error('CSGOEMPIRE_LOGIN_IN_PROGRESS');
      await w.reading?.catch(() => undefined);
      const page = await this.ensurePage(profile, w);
      if (!w.headers || !onEmpire(page)) {
        const { meta } = await this.reloadPage(profile, page, w);
        if (!good(meta) || !w.headers)
          throw new Error(
            `CSGOEMPIRE_API_UNAVAILABLE: trang csgoempire không sẵn sàng (metadata HTTP ${meta.status})`,
          );
      }
      return fetchInPage(page, path, w.headers, init);
    };
    const prev = w.calling ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(run);
    w.calling = next;
    try {
      return await next;
    } finally {
      if (w.calling === next) w.calling = null;
    }
  }

  /** Nhường hồ sơ (làm mới phiên / đăng nhập sắp mở Chrome trên hồ sơ này). */
  async pause(profile: string) {
    const w = this.watched.get(profile);
    if (!w) return;
    w.paused++;
    await w.reading?.catch(() => undefined);
    await this.closeBrowser(profile, w);
  }

  /** Bước làm mới phiên đã đóng Chrome của nó: Chrome nền mở lại ở nhịp kế tiếp. */
  resume(profile: string) {
    const w = this.watched.get(profile);
    if (!w) return;
    w.paused = Math.max(0, w.paused - 1);
    if (!w.paused && w.wantedUntil > Date.now()) void this.tick(profile);
  }

  /**
   * Nhận luôn Chrome/tab vừa lấy JWT thành công. Route bảo vệ được gắn trước khi watcher sở hữu
   * context; nếu không gắn được thì trả false để EmpireSessions đóng context theo luồng cũ.
   */
  async adopt(
    profile: string,
    context: BrowserContext,
    page: Page,
    expected?: string,
    headers?: Record<string, string>,
  ): Promise<boolean> {
    const w = this.entry(profile);
    if (w.context && w.context !== context) return false;
    try {
      await this.protectJwt(context, w);
      if (page.isClosed()) return false;
      w.context = context;
      w.page = page;
      w.headers =
        headers && Object.keys(headers).length ? { ...headers } : null;
      w.failures = 0;
      w.nextAt = 0;
      if (expected !== undefined) w.expected = norm(expected);
      w.wantedUntil = Math.max(w.wantedUntil, Date.now() + this.idleMs);
      this.start();
      await page.bringToFront().catch(() => undefined);
      return true;
    } catch (error) {
      const code =
        error instanceof Error ? error.message : 'BROWSER_HANDOFF_FAILED';
      this.log(
        `csgoempire ${profile}: không thể giữ lại Chrome đăng nhập để đọc số dư — ${code}`,
      );
      return false;
    }
  }

  /** Số Chrome nền đang mở (theo dõi). */
  get openCount() {
    return [...this.watched.values()].filter((w) => w.context).length;
  }

  async closeAll() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled(
      [...this.watched.entries()].map(([p, w]) => this.closeBrowser(p, w)),
    );
    this.watched.clear();
  }

  // ---------------------------------------------------------------- nội bộ

  private entry(profile: string): Watched {
    let w = this.watched.get(profile);
    if (!w) {
      w = {
        wantedUntil: 0,
        paused: 0,
        context: null,
        page: null,
        opening: null,
        reading: null,
        calling: null,
        headers: null,
        expected: null,
        blockedBetby: 0,
        rates: null,
        failures: 0,
        nextAt: 0,
        last: null,
      };
      this.watched.set(profile, w);
    }
    return w;
  }

  private start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const profile of [...this.watched.keys()]) void this.tick(profile);
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private async tick(profile: string) {
    const w = this.watched.get(profile);
    if (!w || w.paused || w.reading) return;
    if (w.wantedUntil > Date.now() && Date.now() < w.nextAt) return; // đang giãn nhịp vì lỗi
    if (w.wantedUntil <= Date.now()) {
      // không còn profile chạy thật nào dùng: đóng Chrome cho nhẹ máy
      await this.closeBrowser(profile, w);
      if (!w.paused && w.wantedUntil <= Date.now())
        this.watched.delete(profile);
      return;
    }
    await this.read(profile, w, false).catch(() => undefined);
  }

  private read(profile: string, w: Watched, rethrow: boolean) {
    if (w.reading) return w.reading;
    const resource = accountResource('csgoempire', profile);
    w.reading = (async () => {
      try {
        const page = await this.ensurePage(profile, w);
        // mốc BẮT ĐẦU đọc: cược của bot từ mốc này được worker trừ thêm (xem AccountLock)
        const startedAt = Date.now();
        // Nhanh: fetch trong trang kèm header riêng của trang. Không có header / bị từ chối → mở lại
        // trang Match betting, lấy đúng phản hồi metadata trang tự gọi và cập nhật header.
        let meta: ApiRead | null = null;
        let rates: ApiRead | null = null;
        // Chỉ fetch nhanh khi trang đang ở csgoempire.com (Chrome vừa mở lại thì còn about:blank).
        if (w.headers && onEmpire(page)) {
          try {
            meta = await fetchInPage(page, META, w.headers);
            if (good(meta))
              rates =
                w.rates && Date.now() - w.rates.at < RATES_TTL_MS
                  ? w.rates.read
                  : await fetchInPage(page, RATES, w.headers);
          } catch {
            meta = rates = null; // fetch hỏng (trang đổi / đóng): mở lại trang bên dưới
          }
        }
        if (!meta || !rates || !good(meta) || !good(rates))
          ({ meta, rates } = await this.reloadPage(profile, page, w));
        if (!good(meta))
          throw new Error(
            `CSGOEMPIRE_BALANCE_READ_FAILED: metadata (trang tự gọi) HTTP ${meta.status}${meta.json ? '' : ` (${meta.type ?? 'không rõ kiểu'})`}`,
          );
        if (!good(rates))
          throw new Error(
            `CSGOEMPIRE_BALANCE_READ_FAILED: exchange-rates HTTP ${rates.status}`,
          );
        if (w.rates?.read !== rates) w.rates = { read: rates, at: Date.now() };
        let b: ReturnType<typeof empireBalanceFrom>;
        for (let attempt = 0; ; attempt++) {
          try {
            b = empireBalanceFrom(meta.json, rates.json);
            break;
          } catch (error) {
            const guestMetadata =
              error instanceof Error &&
              error.message.startsWith('CSGOEMPIRE_SESSION_EXPIRED');
            if (!guestMetadata || attempt >= 2 || !w.headers || !onEmpire(page))
              throw error;
            // Ngay sau login, request metadata đầu tiên đôi khi vẫn là trạng thái guest trong lúc
            // device session vừa được gắn. Đọc lại bằng đúng header của trang trước khi kết luận hết phiên.
            await page.waitForTimeout(750);
            meta = await fetchInPage(page, META, w.headers);
            if (!good(meta))
              throw new Error(
                `CSGOEMPIRE_BALANCE_READ_FAILED: metadata đọc lại HTTP ${meta.status}`,
                { cause: error },
              );
          }
        }
        // Đúng tài khoản đã lưu? Sàn trả username/email mà không khớp → sai tài khoản: lưu lỗi để
        // worker TỪ CHỐI vào lệnh (kiểm lại mỗi lần đọc, không chỉ lúc bấm nút kiểm tra).
        const remote = [b.username, b.email].map(norm).filter(Boolean);
        if (w.expected && remote.length && !remote.includes(w.expected))
          throw new Error(
            'CSGOEMPIRE_ACCOUNT_MISMATCH: Chrome nền đang đăng nhập tài khoản khác tài khoản đã lưu',
          );
        const snapshot: EmpireBalanceSnapshot & {
          username: string | null;
          email: string | null;
        } = {
          cash: b.cash,
          coins: b.coins,
          at: startedAt,
          account: { id: b.account.id, name: b.account.name },
          username: b.username,
          email: b.email,
        };
        // email/username KHÔNG lưu Redis: chỉ trả cho nút kiểm tra trong cùng tiến trình
        const { username: _u, email: _e, ...stored } = snapshot;
        void _u;
        void _e;
        await this.sink.saveEmpireBalance(resource, stored);
        w.last = stored;
        w.failures = 0;
        w.nextAt = 0;
        return snapshot;
      } catch (e) {
        const code =
          e instanceof Error
            ? e.message.slice(0, 200)
            : 'CSGOEMPIRE_BALANCE_READ_FAILED';
        await this.sink
          .saveEmpireBalanceError(resource, code)
          .catch(() => undefined);
        // lỗi liên tiếp: giãn nhịp đọc nền (2s → 4s → 8s … tối đa 60s) để không dội sàn
        w.failures++;
        const wait = Math.min(
          MAX_BACKOFF_MS,
          this.intervalMs * 2 ** w.failures,
        );
        w.nextAt = Date.now() + wait;
        this.log(
          `csgoempire ${profile}: Chrome nền đọc số dư lỗi — ${code} (đọc lại sau ${Math.round(wait / 1000)} giây)`,
        );
        // trang hỏng / bị đăng xuất: đóng để lần sau mở lại sạch
        await this.closeBrowser(profile, w);
        throw e;
      } finally {
        w.reading = null;
      }
    })();
    if (!rethrow) w.reading.catch(() => undefined);
    return w.reading;
  }

  /** Mở lại trang Match betting: lấy phản hồi metadata/tỷ giá trang tự gọi + header của nó. */
  private async reloadPage(
    profile: string,
    page: Page,
    w: Watched,
  ): Promise<{ meta: ApiRead; rates: ApiRead }> {
    w.headers = null;
    const metaRes = page.waitForResponse((r) => isApi(r, META), {
      timeout: 45_000,
    });
    metaRes.catch(() => undefined);
    const ratesRes = page
      .waitForResponse((r) => isApi(r, RATES), { timeout: 45_000 })
      .catch(() => null);
    const blockedBefore = w.blockedBetby;
    await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const metaR = await metaRes.catch(() => {
      throw new Error(
        'CSGOEMPIRE_BALANCE_READ_FAILED: trang Match betting không gọi /api/v2/metadata trong 45 giây',
      );
    });
    const meta = await toRead(metaR);
    if (w.blockedBetby > blockedBefore)
      this.log(
        `csgoempire ${profile}: Chrome nền đã chặn ${w.blockedBetby - blockedBefore} request phiên BetBy của trang (giữ nguyên JWT bot đang dùng)`,
      );
    const headers = await siteHeaders(metaR);
    if (good(meta)) w.headers = headers;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const siteRates = await Promise.race([
      ratesRes,
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), 5_000);
      }),
    ]);
    clearTimeout(timer);
    const rates = siteRates
      ? await toRead(siteRates)
      : await fetchInPage(page, RATES, headers);
    return { meta, rates };
  }

  private async ensurePage(profile: string, w: Watched): Promise<Page> {
    if (w.page && !w.page.isClosed()) return w.page;
    if (!w.opening)
      w.opening = (async () => {
        const context = await launchProfile(profile, {
          slotWaitMs: 15_000,
          visible: true,
        });
        w.context = context;
        await this.protectJwt(context, w);
        // Hồ sơ persistent có thể khôi phục tab roulette của lần chạy trước. Dùng một tab mới sau
        // khi route bảo vệ đã được gắn, rồi đóng các tab khởi động để chúng không chạy nền hoặc
        // xin một phiên BetBy khác trước tab mà watcher kiểm soát.
        const startupPages = context.pages();
        const page = await context.newPage();
        await Promise.allSettled(
          startupPages
            .filter((candidate) => candidate !== page)
            .map((p) => p.close()),
        );
        await page.bringToFront();
        w.page = page;
      })().finally(() => {
        w.opening = null;
      });
    await w.opening;
    return w.page!;
  }

  /** Chặn riêng endpoint cấp JWT BetBy mới; vẫn cho Sptpub và API số dư hoạt động. */
  private protectJwt(context: BrowserContext, w: Watched) {
    return context.route(
      (url) => url.pathname.startsWith(BETBY_SESSION_PATH),
      (route) => {
        w.blockedBetby++;
        return route.abort('blockedbyclient');
      },
    );
  }

  private async closeBrowser(profile: string, w: Watched) {
    await w.opening?.catch(() => undefined);
    const context = w.context;
    w.context = null;
    w.page = null;
    // header gắn với trang đã đóng: Chrome mở lại phải lấy header mới từ trang
    w.headers = null;
    if (context) await context.close().catch(() => undefined);
    // chắc chắn nhả hồ sơ kể cả khi đang mở dở
    await closeProfile(profile).catch(() => undefined);
  }
}
