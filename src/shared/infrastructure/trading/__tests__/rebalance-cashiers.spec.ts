import { describe, expect, it, vi } from 'vitest';
import {
  EmpireCashier,
  empireWithdrawRequest,
  parseEmpireRate,
  parseEmpireWithdrawal,
} from '../empire-cashier.js';
import {
  PUSD,
  PUSD_OFFRAMP,
  USDC_E,
  USDT_POLYGON,
  offrampCalls,
  relayCalls,
} from '../polymarket-cashier.js';

// số liệu lấy từ HAR thật (rút 8,14 coin = 5,0051 USDT)
const RATES = {
  timestamp: 1792640184,
  rates: {
    usdt_polygon: {
      type: 'usdt_polygon',
      rate: 1.6263409175999999,
      rate_usd: 0.99903,
      min_withdraw: 100,
    },
  },
};
const POLY_DEPOSIT = '0x2d01165D44945004766dC59caAC3f5E7367Ca977';
const EMPIRE_DEPOSIT = '0x6A07093Ec021fbDb4fb112fF73a8119218518F5C';
const WALLET = '0x0d72946e0F7A7967843F5b2A9132Effd187cA791';

describe('csgoempire: nạp / rút USDT Polygon', () => {
  it('lệnh rút đúng dạng trang gửi: coin cent, crypto_amount = coin ÷ rate, timestamp của bảng tỷ giá', () => {
    const rate = parseEmpireRate(RATES);
    const req = empireWithdrawRequest(rate, 5.0, POLY_DEPOSIT);
    expect(req).toMatchObject({
      type: 'usdt_polygon',
      address: POLY_DEPOSIT,
      fee_crypto_amount: '0',
      fee_type: 'fast',
      timestamp: 1792640184,
    });
    // 5$ ÷ 0.99903 × 1.62634 × 100 = 813.9 → 813 (làm tròn xuống)
    expect(req.amount).toBe(813);
    expect(Number(req.crypto_amount)).toBeCloseTo(813 / 100 / 1.6263409176, 9);
    // HAR: 814 coin cent → 5.005100659960178
    expect(814 / 100 / rate.rate).toBeCloseTo(5.005100659960178, 9);
  });

  it('dưới mức rút tối thiểu / địa chỉ sai / tỷ giá bất thường → từ chối', () => {
    const rate = parseEmpireRate(RATES);
    expect(() => empireWithdrawRequest(rate, 0.3, POLY_DEPOSIT)).toThrow(
      /TOO_SMALL/,
    );
    expect(() => empireWithdrawRequest(rate, 5, '0x123')).toThrow(/ADDRESS/);
    expect(() =>
      parseEmpireRate({
        ...RATES,
        rates: { usdt_polygon: { ...RATES.rates.usdt_polygon, rate_usd: 3 } },
      }),
    ).toThrow(/RATE_INVALID/);
  });

  it('trạng thái lệnh rút: status 200 = chờ, 300/CONFIRMED = xong', () => {
    expect(
      parseEmpireWithdrawal({
        id: 2215499,
        address: POLY_DEPOSIT,
        coin_value: 814,
        transaction_id: null,
        metadata: { status: 200 },
      })?.state,
    ).toBe('pending');
    expect(
      parseEmpireWithdrawal({
        id: 2215499,
        address: POLY_DEPOSIT,
        coin_value: 814,
        transaction_id: '0xc360',
        metadata: { status: 300, subStatus: 'CONFIRMED' },
      }),
    ).toMatchObject({ state: 'confirmed', txHash: '0xc360', coinCents: 814 });
  });

  it('rút: hỏi phí trước, phí > 0 thì không rút; rút xong đối chiếu địa chỉ sàn ghi', async () => {
    const calls: { path: string; body?: unknown }[] = [];
    const fee = { value: 0 };
    const api = {
      call: vi.fn((_p: string, path: string, init?: { body?: unknown }) => {
        calls.push({ path, body: init?.body });
        if (path.endsWith('exchange-rate'))
          return Promise.resolve({ status: 200, json: RATES, type: null });
        if (path.includes('/fee'))
          return Promise.resolve({
            status: 200,
            type: null,
            json: {
              success: true,
              data: {
                feeOptions: [
                  { optionType: 'fast', coinCentsFeeAmount: fee.value },
                ],
              },
            },
          });
        return Promise.resolve({
          status: 200,
          type: null,
          json: {
            success: true,
            data: {
              id: 9,
              address: POLY_DEPOSIT,
              coin_value: 813,
              transaction_id: null,
              metadata: { status: 200 },
            },
          },
        });
      }),
    };
    const c = new EmpireCashier(api);
    const r = await c.withdraw('empire-1', 5, POLY_DEPOSIT);
    expect(r.withdrawal).toMatchObject({ id: 9, state: 'pending' });
    expect(calls.at(-1)).toMatchObject({
      path: '/api/v2/trade/crypto/withdraw/usdt_polygon',
      body: { amount: 813, address: POLY_DEPOSIT },
    });
    fee.value = 8;
    calls.length = 0;
    await expect(c.withdraw('empire-1', 5, POLY_DEPOSIT)).rejects.toThrow(
      /WITHDRAW_FEE/,
    );
    expect(calls.some((x) => x.body)).toBe(false);
  });
});

describe('Polymarket → USDT Polygon (đúng chuỗi lệnh gọi trang Polymarket dùng)', () => {
  const amount = 5_000_000n;

  it('pUSD.approve(offramp) rồi offramp.unwrap(USDC.e, ví, số tiền) — khớp calldata HAR', () => {
    const [approve, unwrap] = offrampCalls(WALLET, amount);
    expect(approve.to).toBe(PUSD);
    expect(approve.data).toBe(
      '0x095ea7b30000000000000000000000002957922eb93258b93368531d39facca3b4dc585400000000000000000000000000000000000000000000000000000000004c4b40',
    );
    expect(unwrap.to).toBe(PUSD_OFFRAMP);
    expect(unwrap.data).toBe(
      '0x8cc7104f0000000000000000000000002791bca1f2de4661ed88a30c99a7a9449aa841740000000000000000000000000d72946e0f7a7967843f5b2a9132effd187ca79100000000000000000000000000000000000000000000000000000000004c4b40',
    );
  });

  const quote = (over: Record<string, unknown> = {}) => ({
    steps: [
      {
        id: 'approve',
        kind: 'transaction',
        items: [
          {
            data: {
              from: WALLET,
              to: USDC_E,
              data: '0x095ea7b3000000000000000000000000ccc88a9d1b4ed6b0eaba998850414b24f1c315be00000000000000000000000000000000000000000000000000000000004c4b40',
              value: '0',
              chainId: 137,
            },
          },
        ],
      },
      {
        id: 'swap',
        kind: 'transaction',
        items: [
          {
            data: {
              from: WALLET,
              to: '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be',
              data: `0xf9e4bab4${'0'.repeat(24)}${EMPIRE_DEPOSIT.slice(2).toLowerCase()}`,
              value: '0',
              chainId: 137,
            },
          },
        ],
      },
    ],
    details: {
      recipient: EMPIRE_DEPOSIT,
      currencyOut: {
        amount: '5003364',
        minimumAmount: '4998706',
        currency: { address: USDT_POLYGON, chainId: 137 },
      },
    },
    ...over,
  });
  const p = { wallet: WALLET, recipient: EMPIRE_DEPOSIT, amount };

  it('báo giá hợp lệ → approve + swap', () => {
    expect(relayCalls(quote(), p)).toHaveLength(2);
  });

  it('báo giá sai (ra token khác / người nhận khác / nhận quá ít / approve quá số tiền) → từ chối', () => {
    const q = quote();
    expect(() =>
      relayCalls({ ...q, details: { ...q.details, recipient: WALLET } }, p),
    ).toThrow(/địa chỉ khác/);
    expect(() =>
      relayCalls(
        {
          ...q,
          details: {
            ...q.details,
            currencyOut: { ...q.details.currencyOut, minimumAmount: '4000000' },
          },
        },
        p,
      ),
    ).toThrow(/tối thiểu/);
    expect(() =>
      relayCalls(
        {
          ...q,
          details: {
            ...q.details,
            currencyOut: {
              ...q.details.currencyOut,
              currency: { address: USDC_E, chainId: 137 },
            },
          },
        },
        p,
      ),
    ).toThrow(/USDT/);
    expect(() => relayCalls(q, { ...p, amount: 1_000_000n })).toThrow();
  });
});
