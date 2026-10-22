/**
 * Nạp / rút USDT (mạng Polygon) của tài khoản csgoempire, qua đúng API trang csgoempire gọi (lấy từ HAR):
 *
 * - GET  /api/v2/trade/crypto/deposit/usdt_polygon       → { data: { address, deposits[] } }
 * - GET  /api/v2/trade/crypto/deposit/exchange-rate      → { timestamp, rates: { usdt_polygon: { rate, rate_usd, min_withdraw } } }
 * - GET  /api/v2/trade/crypto/withdraw/usdt_polygon/fee?amount=<coin cent>&timestamp=<giây>
 * - POST /api/v2/trade/crypto/withdraw/usdt_polygon      { type, amount, crypto_amount, address, fee_crypto_amount, fee_type, timestamp }
 * - GET  /api/v2/trade/crypto/withdrawals                → { data: [{ id, address, coin_value, transaction_id, metadata: { status, subStatus } }] }
 *
 * Đơn vị: `amount` / `coin_value` = PHẦN TRĂM coin (814 = 8,14 coin). `rate` = số coin cho 1 USDT,
 * `rate_usd` = giá 1 USDT tính bằng USD. crypto_amount = coin ÷ rate; timestamp = timestamp của bảng tỷ giá.
 */
import type { EmpireApiResult } from './empire-balance-watcher.js';

export const EMPIRE_CRYPTO = 'usdt_polygon';
const DEPOSIT = `/api/v2/trade/crypto/deposit/${EMPIRE_CRYPTO}`;
const RATES = '/api/v2/trade/crypto/deposit/exchange-rate';
const WITHDRAW = `/api/v2/trade/crypto/withdraw/${EMPIRE_CRYPTO}`;
const WITHDRAWALS = '/api/v2/trade/crypto/withdrawals';
const EVM = /^0x[0-9a-fA-F]{40}$/;

/** Gọi API csgoempire trong Chrome của hồ sơ (EmpireBalanceWatcher.call). */
export interface EmpireApi {
  call(
    profile: string,
    path: string,
    init?: { method?: 'GET' | 'POST'; body?: unknown },
  ): Promise<EmpireApiResult>;
}

export interface EmpireRate {
  /** Coin cho 1 USDT. */
  readonly rate: number;
  /** USD cho 1 USDT. */
  readonly rateUsd: number;
  /** Rút tối thiểu (phần trăm coin). */
  readonly minWithdrawCents: number;
  /** Mốc của bảng tỷ giá (giây) — gửi kèm lệnh rút. */
  readonly timestamp: number;
}

export interface EmpireWithdrawRequest {
  readonly type: typeof EMPIRE_CRYPTO;
  /** Phần trăm coin. */
  readonly amount: number;
  readonly crypto_amount: string;
  readonly address: string;
  readonly fee_crypto_amount: '0';
  readonly fee_type: 'fast';
  readonly timestamp: number;
}

export type EmpireTransferState = 'pending' | 'confirmed' | 'failed';

export interface EmpireWithdrawal {
  readonly id: number;
  readonly address: string;
  readonly coinCents: number;
  readonly txHash: string | null;
  readonly state: EmpireTransferState;
  readonly raw: { status: unknown; subStatus: unknown };
}

export interface EmpireDeposit {
  readonly id: number | null;
  readonly txHash: string | null;
  readonly coinCents: number;
  /** 1 = đã cộng vào số dư. */
  readonly credited: boolean;
}

const num = (v: unknown) =>
  typeof v === 'number'
    ? v
    : typeof v === 'string' && v.trim()
      ? Number(v)
      : Number.NaN;

function ok(r: EmpireApiResult, what: string): Record<string, unknown> {
  if (r.status >= 400 || !r.json || typeof r.json !== 'object')
    throw new Error(
      `CSGOEMPIRE_CASHIER_FAILED: ${what} HTTP ${r.status}${r.json ? ` — ${JSON.stringify(r.json).slice(0, 200)}` : ''}`,
    );
  const j = r.json as Record<string, unknown>;
  if (j.success === false)
    throw new Error(
      `CSGOEMPIRE_CASHIER_REJECTED: ${what} — ${JSON.stringify(j).slice(0, 200)}`,
    );
  return j;
}

/** Bảng tỷ giá → tỷ giá USDT Polygon. */
export function parseEmpireRate(json: unknown): EmpireRate {
  const j = (json ?? {}) as {
    timestamp?: unknown;
    rates?: Record<string, Record<string, unknown>>;
  };
  const r = j.rates?.[EMPIRE_CRYPTO];
  const rate = num(r?.rate);
  const rateUsd = num(r?.rate_usd);
  const timestamp = num(j.timestamp);
  const minWithdrawCents = num(r?.min_withdraw);
  if (
    !(rate > 0) ||
    !(rateUsd > 0.9 && rateUsd < 1.1) ||
    !(timestamp > 0) ||
    !Number.isFinite(minWithdrawCents)
  )
    throw new Error(
      'CSGOEMPIRE_RATE_INVALID: tỷ giá USDT Polygon bất thường hoặc thiếu',
    );
  return { rate, rateUsd, minWithdrawCents, timestamp };
}

/**
 * Lệnh rút `usd` USD (giá trị USDT nhận về ≈ usd) tới `address`, theo tỷ giá. Làm tròn XUỐNG coin cent.
 */
export function empireWithdrawRequest(
  rate: EmpireRate,
  usd: number,
  address: string,
): EmpireWithdrawRequest {
  if (!EVM.test(address))
    throw new Error('CSGOEMPIRE_WITHDRAW_ADDRESS_INVALID');
  const usdt = usd / rate.rateUsd;
  const amount = Math.floor(usdt * rate.rate * 100 + 1e-9);
  if (!(amount >= Math.max(1, rate.minWithdrawCents)))
    throw new Error(
      `CSGOEMPIRE_WITHDRAW_TOO_SMALL: ${amount} < tối thiểu ${rate.minWithdrawCents} (phần trăm coin)`,
    );
  return {
    type: EMPIRE_CRYPTO,
    amount,
    crypto_amount: String(amount / 100 / rate.rate),
    address,
    fee_crypto_amount: '0',
    fee_type: 'fast',
    timestamp: rate.timestamp,
  };
}

const stateOf = (status: unknown, subStatus: unknown): EmpireTransferState => {
  const s = num(status);
  const sub = typeof subStatus === 'string' ? subStatus.toUpperCase() : '';
  if (sub === 'CONFIRMED' || s === 300) return 'confirmed';
  if (/FAIL|REJECT|CANCEL|REFUND|DECLIN/.test(sub) || s >= 400) return 'failed';
  return 'pending';
};

export function parseEmpireWithdrawal(x: unknown): EmpireWithdrawal | null {
  const w = (x ?? {}) as Record<string, unknown>;
  const meta = (w.metadata ?? {}) as Record<string, unknown>;
  const id = num(w.id);
  if (!(id > 0)) return null;
  return {
    id,
    address: typeof w.address === 'string' ? w.address : '',
    coinCents: num(w.coin_value),
    txHash: typeof w.transaction_id === 'string' ? w.transaction_id : null,
    state: stateOf(meta.status, meta.subStatus),
    raw: { status: meta.status ?? null, subStatus: meta.subStatus ?? null },
  };
}

export class EmpireCashier {
  constructor(private readonly _api: EmpireApi) {}

  /** Địa chỉ nạp USDT Polygon csgoempire cấp cho tài khoản + các lần nạp gần đây. */
  async deposit(
    profile: string,
  ): Promise<{ address: string; deposits: EmpireDeposit[] }> {
    const j = ok(await this._api.call(profile, DEPOSIT), 'địa chỉ nạp');
    const d = (j.data ?? {}) as { address?: unknown; deposits?: unknown };
    if (typeof d.address !== 'string' || !EVM.test(d.address))
      throw new Error('CSGOEMPIRE_DEPOSIT_ADDRESS_MISSING');
    const deposits = (Array.isArray(d.deposits) ? d.deposits : []).map(
      (x: Record<string, unknown>) => ({
        id: num(x.id) > 0 ? num(x.id) : null,
        txHash: typeof x.transaction_id === 'string' ? x.transaction_id : null,
        coinCents: num(x.coin_value),
        credited: num(x.status) === 1,
      }),
    );
    return { address: d.address, deposits };
  }

  async rate(profile: string): Promise<EmpireRate> {
    return parseEmpireRate(ok(await this._api.call(profile, RATES), 'tỷ giá'));
  }

  /** Rút `usd` USD (USDT Polygon) về `address`. Trả lệnh rút sàn vừa tạo. */
  async withdraw(
    profile: string,
    usd: number,
    address: string,
  ): Promise<{ request: EmpireWithdrawRequest; withdrawal: EmpireWithdrawal }> {
    const rate = await this.rate(profile);
    const request = empireWithdrawRequest(rate, usd, address);
    // phí rút (trang luôn hỏi trước khi rút): coin cent phí > 0 thì sàn trừ thêm — báo rõ thay vì rút
    const fee = ok(
      await this._api.call(
        profile,
        `${WITHDRAW}/fee?amount=${request.amount}&timestamp=${Math.floor(Date.now() / 1000)}`,
      ),
      'phí rút',
    );
    const fast = (
      ((fee.data ?? {}) as { feeOptions?: Record<string, unknown>[] })
        .feeOptions ?? []
    ).find((o) => o.optionType === 'fast');
    const feeCents = num(fast?.coinCentsFeeAmount);
    if (!fast || !Number.isFinite(feeCents))
      throw new Error('CSGOEMPIRE_WITHDRAW_FEE_UNKNOWN');
    if (feeCents > 0)
      throw new Error(
        `CSGOEMPIRE_WITHDRAW_FEE: sàn thu ${feeCents} phần trăm coin phí rút — không tự rút`,
      );
    const r = await this._api.call(profile, WITHDRAW, {
      method: 'POST',
      body: request,
    });
    const j = ok(r, 'tạo lệnh rút');
    const withdrawal = parseEmpireWithdrawal(j.data);
    if (!withdrawal)
      throw new Error(
        'CSGOEMPIRE_WITHDRAW_UNKNOWN: sàn không trả mã lệnh rút — kiểm tra lịch sử rút trên csgoempire',
      );
    if (withdrawal.address.toLowerCase() !== address.toLowerCase())
      throw new Error(
        `CSGOEMPIRE_WITHDRAW_ADDRESS_MISMATCH: sàn ghi địa chỉ ${withdrawal.address}`,
      );
    return { request, withdrawal };
  }

  async withdrawal(
    profile: string,
    id: number,
  ): Promise<EmpireWithdrawal | null> {
    const j = ok(await this._api.call(profile, WITHDRAWALS), 'lịch sử rút');
    const list = Array.isArray(j.data) ? (j.data as unknown[]) : [];
    return list.map(parseEmpireWithdrawal).find((w) => w?.id === id) ?? null;
  }
}
