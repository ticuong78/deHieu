/**
 * Chuyển tiền RA khỏi ví Polymarket tới một địa chỉ nạp USDT (Polygon), theo đúng cách trang Polymarket
 * rút tiền (lấy từ HAR): MỘT giao dịch gasless qua relayer của Polymarket, gồm các lệnh gọi:
 *
 *   1. pUSD.approve(OFFRAMP, a)                         — cho phép đổi tiền giao dịch (pUSD) ra
 *   2. OFFRAMP.unwrap(USDC.e, ví, a)  (selector 0x8cc7104f) — pUSD → USDC.e về chính ví
 *   3. các bước của báo giá Relay (approve USDC.e + swap) — USDC.e → USDT gửi thẳng tới địa chỉ nhận
 *
 * Báo giá lấy từ API công khai của Relay (relay.link) — trang Polymarket dùng cùng báo giá Relay qua fun.xyz.
 * Mọi bước được kiểm tra trước khi ký: đúng chuỗi Polygon, không gửi native token, báo giá ra USDT, tới đúng
 * địa chỉ nhận, nhận tối thiểu ≥ 98% số gửi.
 */
import { prepareGaslessTransaction } from '@polymarket/client/actions';
import { encodeAbiParameters, encodeFunctionData, getAddress } from 'viem';
import type { LiveTradingConfig } from '../../application/live-trading.js';
import { polymarketRelayerClient, polymarketSigner } from './venue-orders.js';

export const POLYGON = 137;
/** Tiền giao dịch Polymarket (pUSD) — collateralToken của môi trường production trong SDK. */
export const PUSD = getAddress('0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB');
/** Hợp đồng đổi pUSD → USDC.e mà trang Polymarket gọi khi rút. */
export const PUSD_OFFRAMP = getAddress(
  '0x2957922eb93258b93368531d39facca3b4dc5854',
);
export const USDC_E = getAddress('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174');
export const USDT_POLYGON = getAddress(
  '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
);
const RELAY_QUOTE = 'https://api.relay.link/quote';
/** Nhận tối thiểu / gửi (USDC.e → USDT gần 1:1). */
const MIN_OUT_RATIO = 0.98;

export interface Call {
  readonly to: `0x${string}`;
  readonly data: `0x${string}`;
}

const ERC20_APPROVE = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

/** Bước 1 + 2: pUSD → USDC.e về chính ví (`wallet`). */
export function offrampCalls(wallet: string, amount: bigint): Call[] {
  return [
    {
      to: PUSD,
      data: encodeFunctionData({
        abi: ERC20_APPROVE,
        functionName: 'approve',
        args: [PUSD_OFFRAMP, amount],
      }),
    },
    {
      to: PUSD_OFFRAMP,
      data: `0x8cc7104f${encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }],
        [USDC_E, getAddress(wallet), amount],
      ).slice(2)}`,
    },
  ];
}

interface RelayItem {
  data?: {
    from?: string;
    to?: string;
    data?: string;
    value?: string | number;
    chainId?: number;
  };
}
interface RelayQuote {
  steps?: { id?: string; kind?: string; items?: RelayItem[] }[];
  details?: {
    recipient?: string;
    currencyOut?: {
      amount?: string;
      minimumAmount?: string;
      currency?: { address?: string; chainId?: number };
    };
  };
}

/** Kiểm tra báo giá Relay rồi lấy các lệnh gọi (approve + swap). Sai bất kỳ điều kiện nào → ném lỗi. */
export function relayCalls(
  quote: RelayQuote,
  p: { wallet: string; recipient: string; amount: bigint },
): Call[] {
  const lower = (s: string | undefined) => (s ?? '').toLowerCase();
  const out = quote.details?.currencyOut;
  if (lower(out?.currency?.address) !== lower(USDT_POLYGON))
    throw new Error('RELAY_QUOTE_INVALID: báo giá không ra USDT Polygon');
  if (lower(quote.details?.recipient) !== lower(p.recipient))
    throw new Error('RELAY_QUOTE_INVALID: báo giá gửi tới địa chỉ khác');
  const min = BigInt(out?.minimumAmount ?? out?.amount ?? '0');
  if (min * 100n < p.amount * BigInt(Math.round(MIN_OUT_RATIO * 100)))
    throw new Error(
      `RELAY_QUOTE_INVALID: nhận tối thiểu ${min} < ${MIN_OUT_RATIO * 100}% số gửi ${p.amount}`,
    );
  const items = (quote.steps ?? []).flatMap((s) => {
    if (s.kind !== 'transaction')
      throw new Error(
        `RELAY_QUOTE_INVALID: bước "${s.id}" không phải giao dịch`,
      );
    return s.items ?? [];
  });
  if (!items.length) throw new Error('RELAY_QUOTE_INVALID: không có bước nào');
  const recipientHex = lower(p.recipient).slice(2);
  let sawRecipient = false;
  const calls = items.map((it) => {
    const d = it.data ?? {};
    if (d.chainId !== POLYGON)
      throw new Error('RELAY_QUOTE_INVALID: bước không ở mạng Polygon');
    if (BigInt(d.value ?? 0) !== 0n)
      throw new Error('RELAY_QUOTE_INVALID: bước gửi kèm POL');
    if (d.from && lower(d.from) !== lower(p.wallet))
      throw new Error('RELAY_QUOTE_INVALID: bước ký từ ví khác');
    if (
      !d.to ||
      !/^0x[0-9a-fA-F]{40}$/.test(d.to) ||
      !/^0x[0-9a-fA-F]*$/.test(d.data ?? '')
    )
      throw new Error('RELAY_QUOTE_INVALID: bước thiếu địa chỉ / dữ liệu');
    // approve USDC.e: không cho phép quá số tiền chuyển
    if (lower(d.to) === lower(USDC_E)) {
      if (!d.data!.startsWith('0x095ea7b3'))
        throw new Error('RELAY_QUOTE_INVALID: gọi USDC.e không phải approve');
      const approved = BigInt(`0x${d.data!.slice(74, 138)}`);
      if (approved > p.amount)
        throw new Error('RELAY_QUOTE_INVALID: approve nhiều hơn số chuyển');
    } else if (lower(d.data).includes(recipientHex)) sawRecipient = true;
    return { to: getAddress(d.to), data: d.data as `0x${string}` };
  });
  if (!sawRecipient)
    throw new Error('RELAY_QUOTE_INVALID: lệnh swap không chứa địa chỉ nhận');
  return calls;
}

export async function relayQuote(
  p: { wallet: string; recipient: string; amount: bigint },
  fetchFn: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<RelayQuote> {
  const r = await fetchFn(RELAY_QUOTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user: p.wallet,
      recipient: p.recipient,
      originChainId: POLYGON,
      destinationChainId: POLYGON,
      originCurrency: USDC_E,
      destinationCurrency: USDT_POLYGON,
      amount: p.amount.toString(),
      tradeType: 'EXACT_INPUT',
    }),
    signal,
  });
  const text = await r.text();
  if (!r.ok)
    throw new Error(
      `RELAY_QUOTE_FAILED: HTTP ${r.status} — ${text.slice(0, 200)}`,
    );
  return JSON.parse(text) as RelayQuote;
}

export interface PolymarketSendResult {
  readonly txHash: string | null;
  readonly transactionId: string | null;
  readonly amount: bigint;
  readonly minOut: string | null;
}

/**
 * Gửi `amountUsd` từ ví Polymarket (tiền giao dịch pUSD) thành USDT Polygon tới `recipient`.
 * submitted = đã gửi lên relayer: sau mốc này lỗi nào cũng KHÔNG được gửi lại (onSubmitted báo trước khi chờ).
 */
export async function sendUsdtFromPolymarket(
  c: LiveTradingConfig['polymarket'],
  p: { amountUsd: number; recipient: string },
  /** Relayer API Key (polymarket.com → Settings → API Keys): key + Signer Address. */
  relayer: { key: string; address: string },
  hooks: {
    onSubmitted?: (r: {
      txHash: string | null;
      transactionId: string | null;
    }) => Promise<void> | void;
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Promise<PolymarketSendResult> {
  const client = await polymarketRelayerClient(c, relayer);
  const wallet = client.account.wallet;
  const amount = BigInt(Math.floor(p.amountUsd * 1e6));
  if (amount <= 0n) throw new Error('POLYMARKET_SEND_AMOUNT_INVALID');
  const quote = await relayQuote(
    { wallet, recipient: p.recipient, amount },
    hooks.fetchFn,
    hooks.signal,
  );
  const calls = [
    ...offrampCalls(wallet, amount),
    ...relayCalls(quote, { wallet, recipient: p.recipient, amount }),
  ];
  hooks.signal?.throwIfAborted();
  const wf = await prepareGaslessTransaction(client, {
    calls: calls.map((x) => ({ to: x.to, data: x.data })),
    metadata: 'rebalance:withdraw',
  });
  const signer = polymarketSigner(c);
  let step = await wf.next();
  while (!step.done) {
    const req = step.value;
    if (req.kind === 'requestAddress')
      step = await wf.next(await signer.getAddress());
    else if (req.kind === 'signGaslessTypedData')
      step = await wf.next(await signer.signTypedData(req.payload));
    else step = await wf.next(await signer.signMessage(req.payload));
  }
  const handle = step.value;
  await hooks.onSubmitted?.({
    txHash: handle.transactionHash ?? null,
    transactionId: handle.transactionId ?? null,
  });
  const outcome = await handle.wait();
  return {
    txHash: outcome.transactionHash ?? handle.transactionHash ?? null,
    transactionId: handle.transactionId ?? null,
    amount,
    minOut:
      quote.details?.currencyOut?.minimumAmount ??
      quote.details?.currencyOut?.amount ??
      null,
  };
}
