import {
  type BaseSecureClient,
  createSecureClient,
  AssetType,
  OrderSide,
  OrderType,
  OrderPostStatus,
  SignerType,
} from '@polymarket/client';
import {
  fetchOrder,
  fetchBalanceAllowance,
  fetchPortfolioValue,
  updateBalanceAllowance,
} from '@polymarket/client/actions';
import { privateKey } from '@polymarket/client/viem';
import { createHash } from 'node:crypto';
import type { LiveTradingConfig } from '../../application/live-trading.js';
import { AesGcmSecretCipher } from './secret-cipher.js';
import { SESSION_EXPIRED } from './empire-session.js';

export const SESSION_REJECTED =
  'CSGOEMPIRE_SESSION_REJECTED: BetBy từ chối phiên';
import { accountResource, type EmpireBalanceRead } from './account-lock.js';

export interface OrderPlan {
  id: string;
  bookRef: Readonly<Record<string, string>>;
  bookSide: number;
  bookOdds: number;
  stake: number;
  tokenId: string;
  shares: number;
  polyLimit: number;
  polyFee: number;
  expiresAt: number;
}
export interface VenueFill {
  status: 'filled' | 'partial' | 'accepted' | 'rejected' | 'error';
  orderRef: string | null;
  filledAmount: number;
  avgPrice: number;
  fee: number;
  cost: number;
  sentAt: number;
  ackedAt: number;
  filledAt: number | null;
  error: string | null;
}
/** Tài khoản thật mà sàn trả về (đọc từ chính phiên/ví dùng để vào lệnh). */
export interface VenueAccountIdentity {
  /** csgoempire: user id; polymarket: địa chỉ ví ký lệnh (signer). */
  id: string | null;
  /** csgoempire: tên Steam / username; polymarket: null. */
  name: string | null;
  /** polymarket: ví giữ tiền (funder hoặc chính ví ký). */
  wallet: string | null;
}
export interface VenueBalance {
  account: VenueAccountIdentity;
  /** Cash dùng được (USD). */
  cash: number;
}
export interface PreparedOrder {
  cash: number;
  requiredCash: number;
  account: VenueAccountIdentity;
  /** Thời gian từng bước chuẩn bị (ms), vd { cash: 3, limit: 410 } — để biết bước nào chậm. */
  timing?: Record<string, number>;
  /**
   * Gửi lệnh. csgoempire: `hedge` = chân Polymarket ĐÃ khớp (share, chi phí thật). Vé ở odds gốc bị
   * từ chối (thường do odds giảm) thì đặt lại MỘT lần với tiền cược + odds sàn tính từ hedgeBet.
   */
  submit(options?: {
    hedge?: { shares: number; cost: number };
  }): Promise<VenueFill>;
}
export interface VenueOrders {
  empire(
    config: LiveTradingConfig['empire'],
    plan: OrderPlan,
    signal: AbortSignal,
  ): Promise<PreparedOrder>;
  polymarket(
    config: LiveTradingConfig['polymarket'],
    plan: OrderPlan,
    signal: AbortSignal,
  ): Promise<PreparedOrder>;
}

async function json(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    redirect: 'error',
  });
  // Cloudflare chặn (trang chống bot, không phải API trả lời): KHÔNG phải phiên hết hạn,
  // nên không được khóa tài khoản như phiên hết hạn.
  if (response.headers.get('cf-mitigated') === 'challenge')
    throw new Error(`CSGOEMPIRE_CLOUDFLARE_BLOCKED: HTTP ${response.status}`);
  // Lỗi trả trang HTML (không phải API trả lời): sàn từ chối endpoint, không phải phiên hết hạn.
  if (
    !response.ok &&
    /text\/html/i.test(response.headers.get('content-type') ?? '')
  )
    throw new Error(`CSGOEMPIRE_HTTP_REJECTED: HTTP ${response.status}`);
  if (response.status === 401 || response.status === 403)
    throw new Error(
      // JWT còn hạn mà BetBy từ chối = JWT bị vô hiệu (thường do site vừa cấp JWT mới khi làm mới
      // phiên): KHÔNG khóa tài khoản — worker xin phiên mới, app tự lấy lại.
      `${SESSION_REJECTED} — BetBy ${endpoint(url)} HTTP ${response.status}${await bodyHint(response)}`,
    );
  if (!response.ok)
    throw new Error(
      `VENUE_HTTP_${response.status}: ${endpoint(url)}${await bodyHint(response)}`,
    );
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`VENUE_NOT_JSON: HTTP ${response.status}`);
  }
}
/**
 * Đặt bù BetBy khi đã có S share Polymarket (chi phí Cₚ) mà odds BetBy giảm.
 *  - Cửa BetBy thắng: x·k ≥ x + Cₚ  ⇔ x ≥ Cₚ / (k − 1)
 *  - Cửa Polymarket thắng: S ≥ x + Cₚ ⇔ x ≤ S − Cₚ
 * Tiền cược x = S/k cho cả hai cửa nhận về như nhau; còn bù được khi k ≥ S/(S − Cₚ) (odds sàn).
 * Đặt ở odds sàn (làm tròn lên 0.01), x làm tròn XUỐNG tới cent, kiểm lại cả hai điều kiện sau làm
 * tròn. Odds thật cao hơn odds sàn (BetBy nhận nhờ "higher") thì cửa BetBy còn trả nhiều hơn.
 * null = không có odds nào thấp hơn odds gốc mà còn bù được.
 */
export function hedgeBet(
  shares: number,
  polyCost: number,
  plannedOdds: number,
): { odds: number; stake: number } | null {
  if (!(shares > polyCost && polyCost >= 0)) return null;
  let odds = Math.ceil((shares / (shares - polyCost)) * 100 - 1e-9) / 100;
  for (; odds < plannedOdds - 1e-9; odds = Math.round(odds * 100 + 1) / 100) {
    const stake = Math.floor((shares / odds) * 100 + 1e-9) / 100;
    if (
      stake > 0 &&
      stake * odds + 1e-9 >= stake + polyCost &&
      shares + 1e-9 >= stake + polyCost
    )
      return { odds, stake };
  }
  return null;
}

/** Chờ tối đa bấy lâu cho lệnh "delayed" (độ trễ khớp của market thể thao) ra kết quả cuối. */
export const DELAY_WAIT_MS = 15_000;
const TERMINAL =
  /^(matched|canceled|cancelled|unmatched|expired|killed|filled)$/i;

/**
 * Hỏi lại lệnh FOK đang "delayed" tới khi có kết quả cuối: khớp đủ / khớp một phần / bị giết; hết
 * giờ chờ = chưa rõ ("pending").
 */
async function settleDelayed(
  client: Awaited<ReturnType<typeof polymarketClient>>,
  orderId: string,
  shares: number,
  waitMs = DELAY_WAIT_MS,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
): Promise<{
  kind: 'filled' | 'partial' | 'killed' | 'pending';
  matched: number;
  price: number;
  status: string;
}> {
  const deadline = Date.now() + waitMs;
  let last = { matched: 0, price: 0, status: '' };
  for (;;) {
    await sleep(500);
    const o = await fetchOrder(client, { orderId }).catch(() => null);
    if (o) {
      last = {
        matched: Number(o.sizeMatched) || 0,
        price: Number(o.price) || 0,
        status: o.status,
      };
      if (last.matched >= shares - 1e-6) return { kind: 'filled', ...last };
      if (TERMINAL.test(o.status))
        return { kind: last.matched > 0 ? 'partial' : 'killed', ...last };
    }
    if (Date.now() >= deadline) return { kind: 'pending', ...last };
  }
}

/** Số có tối đa `n` chữ số thập phân (dung sai dấu phẩy động). */
export function fitsDecimals(v: number, n: number) {
  const scaled = v * 10 ** n;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/**
 * Lỗi mà sàn ĐÃ trả lời từ chối (HTTP 4xx, gồm 429): lệnh không vào sổ. 5xx / mạng / quá hạn KHÔNG
 * tính — có thể lệnh đã vào, phải đối soát.
 */
function rejectedByVenue(
  e: unknown,
): e is Error & { name: string; status?: number } {
  if (!(e instanceof Error)) return false;
  if (e.name === 'RateLimitError') return true;
  const status = (e as { status?: unknown }).status;
  return (
    e.name === 'RequestRejectedError' &&
    typeof status === 'number' &&
    status >= 400 &&
    status < 500
  );
}

/** Đường dẫn API (không query) để biết endpoint nào lỗi. */
function endpoint(url: string) {
  try {
    return new URL(url).pathname;
  } catch {
    return '?';
  }
}

/** Che chuỗi giống token / khóa trước khi đưa vào lý do lỗi. */
export function maskSecrets(s: string) {
  return s
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[ẩn]')
    .replace(/(0x)?[0-9a-fA-F]{64,}/g, '[ẩn]')
    .replace(/[A-Za-z0-9+/_=-]{40,}/g, '[ẩn]');
}

/** Mã / thông điệp lỗi sàn trả về (đã che, tối đa 160 ký tự) — để biết VÌ SAO bị từ chối. */
async function bodyHint(response: Response) {
  try {
    const text = (await response.text()).trim();
    if (!text) return '';
    let hint = text;
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const parts = ['code', 'error', 'message', 'msg', 'reason', 'detail']
        .map((k) => j[k])
        .filter((v) => typeof v === 'string' || typeof v === 'number')
        .map(String);
      if (parts.length) hint = parts.join(' · ');
    } catch {
      // không phải JSON: dùng chữ thô
    }
    return ` — ${maskSecrets(hint).replace(/\s+/g, ' ').slice(0, 160)}`;
  } catch {
    return '';
  }
}

function finite(value: unknown): number {
  const n =
    typeof value === 'string' || typeof value === 'number'
      ? Number(value)
      : NaN;
  if (!Number.isFinite(n) || n < 0) throw new Error('CASH_UNAVAILABLE');
  return n;
}

const insufficientCash = (
  cash: number,
  requiredCash: number,
  account: VenueAccountIdentity,
): PreparedOrder => ({
  cash,
  requiredCash,
  account,
  submit: () => Promise.reject(new Error('INSUFFICIENT_CASH')),
});

const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim()
    ? v.trim()
    : typeof v === 'number' && Number.isFinite(v)
      ? String(v)
      : null;

/**
 * Tính số dư từ phản hồi /api/v2/metadata + /api/v2/metadata/exchange-rates mà CHROME đã đọc
 * (csgoempire từ chối các request API không đến từ trình duyệt thật, kể cả có cookie).
 */
export function empireBalanceFrom(
  meta: unknown,
  rates: unknown,
): VenueBalance & {
  coins: number;
  username: string | null;
  email: string | null;
} {
  const user = (meta as { user?: unknown } | null)?.user as
    Record<string, unknown> | null | undefined;
  // khách (chưa đăng nhập) → không có user
  if (!user || typeof user !== 'object') throw new Error(SESSION_EXPIRED);
  if (user.default_balance_type !== 1)
    throw new Error('CSGOEMPIRE_BALANCE_TYPE_UNSUPPORTED');
  const coins = empireCoins(user);
  const fx = (rates as { rates?: Record<string, unknown> } | null)?.rates;
  const coinsRate = finite(fx?.CSGOEMPIRE_COIN);
  if (!coinsRate) throw new Error('CASH_UNAVAILABLE');
  // rates cùng một đơn vị gốc: coin → USD. Làm tròn XUỐNG tới cent như csgoempire hiển thị
  // (không bao giờ báo dư hơn số tiền thật; +1e-9 bù sai số dấu phẩy động khi đúng tròn cent).
  const cash =
    Math.floor(((coins * finite(fx?.USD)) / coinsRate) * 100 + 1e-9) / 100;
  const username = text(user.username);
  return {
    cash,
    coins,
    account: {
      id: text(user.id),
      name: text(user.steam_name) ?? username,
      wallet: null,
    },
    username,
    email: text(user.email),
  };
}

/** Kho số dư csgoempire do Chrome nền ghi (Redis) — worker chỉ đọc ở đây, không gọi csgoempire. */
export interface EmpireBalanceStore {
  readEmpireBalance(resource: string): Promise<EmpireBalanceRead>;
  spendEmpire(resource: string, amount: number): Promise<void>;
}
/** Số dư đọc cách đây quá chừng này thì không dùng để vào lệnh. */
export const EMPIRE_BALANCE_MAX_AGE_MS = 60_000;

/**
 * Số coin hiện có. `user.balance` là phần trăm coin (HAR gốc); `balances[].balance_coins` là coin.
 * Có cả hai thì PHẢI khớp (lệch ≤ 1%), không thì từ chối thay vì đoán đơn vị → không tính sai tiền.
 */
export function empireCoins(user: Record<string, unknown>): number {
  const fromCents = finite(user.balance) / 100;
  const list = Array.isArray(user.balances)
    ? (user.balances as Record<string, unknown>[])
    : [];
  const entry =
    list.find((b) => b.balance_type === user.default_balance_type) ?? list[0];
  const raw = entry?.balance_coins;
  if (raw === undefined || raw === null || raw === '') return fromCents;
  const coins = finite(raw);
  const scale = Math.max(Math.abs(coins), Math.abs(fromCents), 1e-9);
  if (Math.abs(coins - fromCents) / scale > 0.01)
    throw new Error(
      'CASH_UNAVAILABLE: số coin và balance của csgoempire không khớp đơn vị',
    );
  return coins;
}

/** Bộ ký của ví Polymarket (giải mã private key bằng TRADING_SECRET_KEY). */
export function polymarketSigner(c: LiveTradingConfig['polymarket']) {
  return privateKey(
    new AesGcmSecretCipher(process.env.TRADING_SECRET_KEY).decrypt(
      c.secretCipher,
    ),
  );
}

async function polymarketClient(c: LiveTradingConfig['polymarket']) {
  const signer = polymarketSigner(c);
  const client = await createSecureClient({
    signer,
    wallet: c.funderAddress ?? c.walletAddress,
  });
  if (client.account.signer.toLowerCase() !== c.walletAddress.toLowerCase())
    throw new Error('POLYMARKET_WALLET_MISMATCH');
  // Ví funder phải là ví Polymarket (proxy / safe / deposit wallet) SINH RA từ chính private key này.
  // Không khớp thì thư viện coi key là "session key" của một deposit wallet → sàn báo "no deposit
  // wallet found for owner". Báo rõ thay vì để lỗi đó lọt ra.
  if (c.funderAddress && client.account.signerType !== SignerType.OWNER)
    throw new Error(
      'POLYMARKET_FUNDER_MISMATCH: ví funder không phải ví Polymarket của private key này',
    );
  return client;
}

/** Kết nối Polymarket đã xác thực, giữ theo (ví, key đã mã hóa): tạo mới mất hàng giây. */
const POLY_CLIENT_TTL_MS = 30 * 60_000;
const polyClients = new Map<
  string,
  { at: number; client: ReturnType<typeof polymarketClient> }
>();
const polyKey = (c: LiveTradingConfig['polymarket']) =>
  createHash('sha256')
    .update(`${c.walletAddress}|${c.funderAddress ?? ''}|${c.secretCipher}`)
    .digest('hex');

/** Kết nối giữ sẵn (≤ 30 phút); tạo lỗi thì không giữ. Đổi key / ví → khóa khác → tạo mới. */
function cachedPolymarketClient(c: LiveTradingConfig['polymarket']) {
  const key = polyKey(c);
  const hit = polyClients.get(key);
  if (hit && Date.now() - hit.at < POLY_CLIENT_TTL_MS) return hit.client;
  const client = polymarketClient(c);
  polyClients.set(key, { at: Date.now(), client });
  client.catch(() => {
    if (polyClients.get(key)?.client === client) polyClients.delete(key);
  });
  return client;
}
/**
 * Kết nối Polymarket giữ sẵn, kiểu công khai của SDK (BaseSecureClient) — để module khác (chuyển tiền)
 * dùng lại mà không xuất kiểu suy luận của client (không đặt tên được khi build .d.ts).
 */
export function polymarketSecureClient(
  c: LiveTradingConfig['polymarket'],
): Promise<BaseSecureClient> {
  return cachedPolymarketClient(c);
}
export function forgetPolymarketClient(c: LiveTradingConfig['polymarket']) {
  polyClients.delete(polyKey(c));
}
/** Chỉ dùng trong test. */
export function resetPolymarketClients() {
  polyClients.clear();
}

async function polymarketCash(
  client: Awaited<ReturnType<typeof polymarketClient>>,
  c: LiveTradingConfig['polymarket'],
  refresh = false,
) {
  // CLOB lưu đệm số dư: tiền vừa nạp / vừa khớp có thể chưa hiện (vd Polymarket 0.08$ mà CLOB báo 0).
  // `refresh` bắt CLOB đọc lại số dư on-chain trước khi trả.
  const read = refresh ? updateBalanceAllowance : fetchBalanceAllowance;
  const cashBalance = await read(client, {
    assetType: AssetType.COLLATERAL,
  });
  // COLLATERAL is spendable cash in base units, never portfolio value.
  const cash = finite(cashBalance.balance) / 1e6;
  const allowance = Math.max(
    0,
    ...Object.values(cashBalance.allowances).map((a) => Number(a) / 1e6),
  );
  const account: VenueAccountIdentity = {
    id: client.account.signer,
    name: null,
    wallet: c.funderAddress ?? c.walletAddress,
  };
  return { cash, allowance, account };
}

/** Đọc ví + Cash Polymarket bằng đúng private key sẽ ký lệnh. */
export async function readPolymarketBalance(
  c: LiveTradingConfig['polymarket'],
  signal: AbortSignal,
): Promise<VenueBalance & { allowance: number; positions: number | null }> {
  signal.throwIfAborted();
  const client = await cachedPolymarketClient(c);
  const [balance, positions] = await Promise.all([
    polymarketCash(client, c, true),
    // Giá trị vị thế đang mở: CHỈ để hiển thị, không bao giờ dùng để tính tiền vào lệnh.
    fetchPortfolioValue(client, { user: client.account.wallet })
      .then((v) => {
        const n = Number(v.value);
        return Number.isFinite(n) ? n : null;
      })
      .catch(() => null),
  ]);
  return { ...balance, positions };
}

/** No portfolio valuation, positions, or mark-to-market values enter these checks. */
export class ApiVenueOrders implements VenueOrders {
  constructor(private readonly empireBalances?: EmpireBalanceStore) {}

  /** Số dư còn dùng được = số Chrome nền đọc gần nhất − tiền bot đã cược sau lần đọc đó. */
  private async empireCash(browserProfile: string) {
    if (!this.empireBalances)
      throw new Error('CSGOEMPIRE_BALANCE_UNAVAILABLE: chưa có kho số dư');
    const resource = accountResource('csgoempire', browserProfile);
    const { snapshot, lastError, spent } =
      await this.empireBalances.readEmpireBalance(resource);
    const age = snapshot ? Date.now() - snapshot.at : Infinity;
    if (!snapshot || age > EMPIRE_BALANCE_MAX_AGE_MS) {
      const why = lastError
        ? `lần đọc gần nhất lỗi ${lastError.error}`
        : snapshot
          ? `đọc cách đây ${Math.round(age / 1000)} giây`
          : 'Chrome nền chưa đọc được lần nào';
      throw new Error(`CSGOEMPIRE_BALANCE_UNAVAILABLE: ${why}`);
    }
    // Lần đọc/kiểm tra tài khoản GẦN NHẤT lỗi (sau số dư đang có): không tin số dư cũ, từ chối vào lệnh
    // cho tới khi Chrome nền đọc lại thành công.
    if (lastError && lastError.at >= snapshot.at)
      throw new Error(
        `CSGOEMPIRE_BALANCE_UNAVAILABLE: lần đọc gần nhất lỗi ${lastError.error}`,
      );
    return {
      resource,
      at: snapshot.at,
      cash: Math.max(0, snapshot.cash - spent),
      account: { ...snapshot.account, wallet: null },
    };
  }

  async empire(
    c: LiveTradingConfig['empire'],
    p: OrderPlan,
    signal: AbortSignal,
  ): Promise<PreparedOrder> {
    if (c.expiresAt <= Date.now() + 20_000)
      throw new Error(
        `${SESSION_EXPIRED} — JWT BetBy ${
          c.expiresAt <= Date.now()
            ? `đã hết hạn ${Math.round((Date.now() - c.expiresAt) / 1000)} giây trước`
            : `chỉ còn ${Math.round((c.expiresAt - Date.now()) / 1000)} giây`
        }, chưa được làm mới kịp`,
      );
    if (!p.bookRef.e || !p.bookRef.m || !p.bookRef[`o${p.bookSide}`])
      throw new Error('CSGOEMPIRE_REF_MISSING');
    if (Math.abs(p.stake * 100 - Math.round(p.stake * 100)) > 1e-6)
      throw new Error(
        'CSGOEMPIRE_STAKE_PRECISION: cần số tiền chính xác đến cent',
      );
    if (p.stake < c.minBet) throw new Error('CSGOEMPIRE_BELOW_MIN_BET');
    const headers = {
      Authorization: `Bearer ${c.token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Session-Id': c.sessionId,
      Origin: 'https://csgoempire.com',
      Referer: 'https://csgoempire.com/',
      ...(c.userAgent ? { 'User-Agent': c.userAgent } : {}),
    };
    const coupon = {
      type: '1/1',
      sum: p.stake.toFixed(2),
      k: String(p.bookOdds),
      global_id: null,
      bonus_id: null,
      bet_request_id: p.id,
      odds_change: 'higher',
      selections: [
        {
          event_id: p.bookRef.e,
          market_id: p.bookRef.m,
          specifiers: p.bookRef.s ?? '',
          outcome_id: p.bookRef[`o${p.bookSide}`],
          k: String(p.bookOdds),
          source: {
            layout: 'tile',
            page: '/:sportSlug/:categorySlug/:tournamentSlug/:eventSlugAndId',
            section: '',
            extra: { market: 'Main', timeFilter: '', banner_type: '', tab: '' },
          },
          promo_id: null,
          bonus_id: null,
          timestamp: Date.now(),
        },
      ],
    };
    signal.throwIfAborted();
    // Số dư (Redis) và hạn mức BetBy (HTTP) độc lập nhau: đọc SONG SONG cho nhanh.
    const t0 = Date.now();
    const timing: Record<string, number> = {};
    const [{ cash, account, resource }, limit] = await Promise.all([
      this.empireCash(c.browserProfile).finally(() => {
        timing.cash = Date.now() - t0;
      }),
      json(
        `${c.apiUrl}/api/v1/coupon/max`,
        { method: 'POST', headers, body: JSON.stringify(coupon) },
        signal,
      )
        .finally(() => {
          timing.limit = Date.now() - t0;
        })
        .catch((e: unknown) => {
          // 401 khi JWT còn hạn = JWT bị BetBy vô hiệu (không phải hết giờ): ghi kèm thời hạn để phân biệt
          if (
            e instanceof Error &&
            e.message.startsWith('CSGOEMPIRE_SESSION_REJECTED')
          )
            throw new Error(
              `${e.message} · JWT còn ${Math.round((c.expiresAt - Date.now()) / 60_000)} phút`,
            );
          throw e;
        }),
    ]);
    if (cash < p.stake) return insufficientCash(cash, p.stake, account);
    if (finite(limit.max_bet) < p.stake)
      throw new Error('CSGOEMPIRE_BET_LIMIT');
    return {
      cash,
      requiredCash: p.stake,
      account,
      timing,
      submit: async (options = {}) => {
        // Một lần đặt vé ở odds `k` (BetBy nhận nếu odds hiện tại ≥ k, nhờ odds_change "higher").
        const place = async (k: number, stake: number, requestId: string) => {
          const body = {
            ...coupon,
            sum: stake.toFixed(2),
            k: String(k),
            bet_request_id: requestId,
            selections: coupon.selections.map((sel) => ({
              ...sel,
              k: String(k),
              timestamp: Date.now(),
            })),
          };
          const sentAt = Date.now();
          const result = await json(
            `${c.apiUrl}/api/v2/coupon/brand/${c.brandId}/bet/place`,
            { method: 'POST', headers, body: JSON.stringify([body]) },
            new AbortController().signal,
          );
          const ackedAt = Date.now();
          const accepted = Array.isArray(result.accepted)
            ? (result.accepted.find(
                (v: { bet_request_id?: string }) =>
                  v.bet_request_id === requestId,
              ) as { bet_id?: string } | undefined)
            : undefined;
          if (accepted?.bet_id) {
            // trừ ngay vào số dư đã đọc, để lệnh kế tiếp không dùng lại cùng số tiền
            await this.empireBalances
              ?.spendEmpire(resource, stake)
              .catch(() => undefined);
            return {
              status: 'filled',
              orderRef: accepted.bet_id,
              filledAmount: stake,
              // odds đã yêu cầu = mức thấp nhất được nhận (BetBy có thể trả odds cao hơn)
              avgPrice: k,
              fee: 0,
              cost: stake,
              sentAt,
              ackedAt,
              filledAt: ackedAt,
              error: null,
            } satisfies VenueFill;
          }
          if (Array.isArray(result.error) && result.error.length)
            return {
              status: 'rejected',
              orderRef: null,
              filledAmount: 0,
              avgPrice: 0,
              fee: 0,
              cost: 0,
              sentAt,
              ackedAt,
              filledAt: null,
              // giữ lời BetBy (vd odds đổi, vượt hạn mức) để biết vì sao vé không vào
              error: `CSGOEMPIRE_ORDER_REJECTED: odds ${k} — ${maskSecrets(JSON.stringify(result.error)).slice(0, 200)}`,
            } satisfies VenueFill;
          throw new Error('CSGOEMPIRE_ORDER_UNKNOWN');
        };
        const first = await place(p.bookOdds, p.stake, p.id);
        if (first.status !== 'rejected' || !options.hedge) return first;
        // Bị từ chối (thường do odds giảm) khi Polymarket ĐÃ khớp: đặt lại ở odds sàn còn bù được cả
        // hai cửa, với tiền cược ĐỔI theo odds đó (x = share / odds) — xem hedgeBet.
        const h = hedgeBet(
          options.hedge.shares,
          options.hedge.cost,
          p.bookOdds,
        );
        const why = !h
          ? 'không có odds nào thấp hơn odds gốc mà còn bù được cả hai cửa'
          : h.stake < c.minBet
            ? `tiền bù ${h.stake}$ dưới cược tối thiểu ${c.minBet}$`
            : h.stake > finite(limit.max_bet)
              ? `tiền bù ${h.stake}$ vượt hạn mức BetBy ${finite(limit.max_bet)}$`
              : h.stake > cash
                ? `tiền bù ${h.stake}$ vượt Cash csgoempire ${cash.toFixed(2)}$`
                : null;
        if (why || !h)
          return { ...first, error: `${first.error} · không đặt bù: ${why}` };
        // Mã yêu cầu mới, dẫn xuất cố định từ mã cũ (lần đầu bị từ chối hẳn → không có vé trùng).
        const retry = await place(
          h.odds,
          h.stake,
          createHash('sha256').update(`${p.id}:hedge`).digest('hex'),
        );
        return retry.status === 'rejected'
          ? {
              ...retry,
              error: `${first.error} · đặt bù ${h.stake}$ ở odds sàn ${h.odds}: ${retry.error}`,
            }
          : retry;
      },
    };
  }

  async polymarket(
    c: LiveTradingConfig['polymarket'],
    p: OrderPlan,
    signal: AbortSignal,
  ): Promise<PreparedOrder> {
    signal.throwIfAborted();
    const t0 = Date.now();
    const timing: Record<string, number> = {};
    // Kết nối đã xác thực được GIỮ SẴN theo ví (không tạo lại mỗi lệnh — bước chậm nhất).
    const client = await cachedPolymarketClient(c);
    timing.client = Date.now() - t0;
    const t1 = Date.now();
    let cashInfo: Awaited<ReturnType<typeof polymarketCash>>;
    let signed: Awaited<ReturnType<typeof client.createLimitOrder>>;
    try {
      // Số dư (HTTP) và ký lệnh độc lập nhau: làm SONG SONG. Ký trước không gửi gì lên sàn.
      [cashInfo, signed] = await Promise.all([
        polymarketCash(client, c).finally(() => {
          timing.cash = Date.now() - t1;
        }),
        client
          .createLimitOrder({
            assetId: p.tokenId,
            side: OrderSide.BUY,
            price: p.polyLimit,
            size: p.shares,
          })
          .finally(() => {
            timing.sign = Date.now() - t1;
          }),
      ]);
    } catch (e) {
      // kết nối giữ sẵn có thể đã hỏng (khóa API hết hạn…): bỏ để lần sau tạo lại
      forgetPolymarketClient(c);
      throw e;
    }
    const { cash, allowance, account } = cashInfo;
    const requiredCash =
      Math.ceil((p.shares * p.polyLimit + p.polyFee) * 1e6) / 1e6;
    if (cash < requiredCash)
      return insufficientCash(cash, requiredCash, account);
    if (cash >= requiredCash && allowance < requiredCash)
      throw new Error('POLYMARKET_ALLOWANCE_INSUFFICIENT');
    // orderType is submission policy, outside the signed EIP-712 order fields.
    const order = { ...signed, orderType: OrderType.FOK };
    const signedShares = Number(order.takerAmount) / 1e6;
    if (Math.abs(signedShares - p.shares) > 1e-6)
      throw new Error('POLYMARKET_SIZE_PRECISION');
    // Lệnh mua FOK (lệnh thị trường) của Polymarket: tiền USDC (maker) tối đa 2 số lẻ, share (taker)
    // tối đa 4 số lẻ — sai là sàn từ chối. Kiểm TRƯỚC khi gửi để hủy gọn cả cặp, không phải đối soát.
    const makerUsd = Number(order.makerAmount) / 1e6;
    if (!fitsDecimals(makerUsd, 2) || !fitsDecimals(signedShares, 4))
      throw new Error(
        `POLYMARKET_AMOUNT_PRECISION: ${signedShares} share × ${p.polyLimit} = ${makerUsd}$ — Polymarket chỉ nhận tiền 2 số lẻ, share 4 số lẻ`,
      );
    signal.throwIfAborted();
    return {
      cash,
      requiredCash,
      account,
      timing,
      submit: async () => {
        const sentAt = Date.now();
        let response: Awaited<ReturnType<typeof client.postOrder>>;
        try {
          response = await client.postOrder(order);
        } catch (e) {
          // Sàn TRẢ LỜI từ chối (4xx: sai dữ liệu, hạn chế, quá tải): lệnh chắc chắn không vào sổ →
          // "bị từ chối" (hủy gọn cả cặp), không phải "không rõ kết quả" (phải đối soát).
          if (rejectedByVenue(e))
            return {
              status: 'rejected',
              orderRef: null,
              filledAmount: 0,
              avgPrice: 0,
              fee: 0,
              cost: 0,
              sentAt,
              ackedAt: Date.now(),
              filledAt: null,
              error: `POLYMARKET_REJECTED:${e.name} ${e.status ?? ''} — ${maskSecrets(e.message).slice(0, 200)}`,
            };
          throw e;
        }
        const ackedAt = Date.now();
        if (!response.ok)
          return {
            status: 'rejected',
            orderRef: null,
            filledAmount: 0,
            avgPrice: 0,
            fee: 0,
            cost: 0,
            sentAt,
            ackedAt,
            filledAt: null,
            // giữ cả lời giải thích của sàn (vd FOK không khớp đủ) để biết vì sao chân này hỏng
            error: `POLYMARKET_REJECTED:${response.code} — ${maskSecrets(response.message).slice(0, 200)}`,
          };
        const fee = p.polyFee;
        if (response.status === OrderPostStatus.DELAYED) {
          // Market thể thao có ĐỘ TRỄ KHỚP: lệnh vào hàng chờ vài giây rồi mới khớp / bị giết (FOK).
          // Chờ kết quả cuối thay vì coi là "chưa rõ" (phải đối soát).
          const final = await settleDelayed(client, response.orderId, p.shares);
          const ackedAt2 = Date.now();
          if (final.kind === 'killed')
            return {
              status: 'rejected',
              orderRef: response.orderId,
              filledAmount: 0,
              avgPrice: 0,
              fee: 0,
              cost: 0,
              sentAt,
              ackedAt: ackedAt2,
              filledAt: null,
              error: `POLYMARKET_REJECTED:delayed_${final.status} — FOK không khớp sau độ trễ khớp của market`,
            };
          if (final.kind === 'filled' || final.kind === 'partial')
            return {
              status: final.kind,
              orderRef: response.orderId,
              filledAmount: final.matched,
              // giá giới hạn = giá xấu nhất có thể khớp (giá khớp thật có thể tốt hơn)
              avgPrice: final.price,
              fee,
              cost: final.matched * final.price + fee,
              sentAt,
              ackedAt: ackedAt2,
              filledAt: final.kind === 'filled' ? ackedAt2 : null,
              error:
                final.kind === 'filled'
                  ? null
                  : `POLYMARKET_FILL_UNCONFIRMED: sau độ trễ khớp chỉ khớp ${final.matched}/${p.shares} share (${final.status})`,
            };
          return {
            status: 'accepted',
            orderRef: response.orderId,
            filledAmount: 0,
            avgPrice: 0,
            fee: 0,
            cost: 0,
            sentAt,
            ackedAt: ackedAt2,
            filledAt: null,
            error: `POLYMARKET_FILL_UNCONFIRMED: lệnh vào hàng chờ (delayed) mà sau ${DELAY_WAIT_MS / 1000} giây chưa có kết quả${final.status ? ` (trạng thái ${final.status})` : ''}`,
          };
        }
        const filledAmount = finite(response.takingAmount);
        const notional = finite(response.makingAmount);
        let status: VenueFill['status'] =
          response.status === OrderPostStatus.MATCHED &&
          filledAmount >= p.shares - 1e-6
            ? 'filled'
            : filledAmount > 0
              ? 'partial'
              : 'accepted';
        if (status === 'filled') {
          try {
            await client.waitForOrderFillSettlement(response, {
              timeoutMs: 20_000,
            });
          } catch {
            status = 'partial';
          }
        }
        return {
          status,
          orderRef: response.orderId,
          filledAmount,
          avgPrice: filledAmount > 0 ? notional / filledAmount : 0,
          fee,
          cost: notional + (filledAmount > 0 ? fee : 0),
          sentAt,
          ackedAt,
          filledAt: status === 'filled' ? Date.now() : null,
          error:
            status === 'filled'
              ? null
              : `POLYMARKET_FILL_UNCONFIRMED: trạng thái ${response.status}, khớp ${filledAmount}/${p.shares} share`,
        };
      },
    };
  }
}
