/**
 * Tài khoản giao dịch. Mỗi nền tảng có thể có NHIỀU tài khoản.
 * - csgoempire: phiên nằm trong hồ sơ riêng; tài khoản/mật khẩu tùy chọn được mã hóa để tự đăng nhập.
 * - polymarket: mỗi ví một private key, lưu MÃ HÓA (khóa chủ TRADING_SECRET_KEY), API không bao giờ trả ra.
 */
export const TRADING_VENUES = ['csgoempire', 'polymarket'] as const;
export type TradingVenue = (typeof TRADING_VENUES)[number];

/** Nền tảng → tenant của chân kèo (leg.tenant trong ArbitrageSignal). */
export const VENUE_TENANT: Readonly<Record<TradingVenue, string>> = {
  csgoempire: 'sptpub',
  polymarket: 'polymarket',
};

export interface CsgoEmpireAccountConfig {
  readonly venue: 'csgoempire';
  /** Tên hồ sơ trình duyệt (thư mục profile) giữ phiên đăng nhập của tài khoản này. */
  readonly browserProfile: string;
  /**
   * Địa chỉ nạp USDT (Polygon) csgoempire cấp cho tài khoản (trang Deposit → USDT Polygon), đã được người
   * vận hành XÁC NHẬN. Tự chuyển tiền Polymarket → csgoempire chỉ gửi tới đúng địa chỉ này, và chỉ khi trang
   * csgoempire lúc chuyển vẫn trả đúng địa chỉ đó. null = chưa xác nhận → không tự chuyển chiều này.
   */
  readonly usdtDepositAddress?: string | null;
}

export interface PolymarketAccountConfig {
  readonly venue: 'polymarket';
  /** Địa chỉ ví (để hiển thị / đối chiếu). */
  readonly walletAddress: string;
  /** Ví proxy (funder) nếu tài khoản dùng ví Polymarket; trống = ký và trả bằng chính ví. */
  readonly funderAddress: string | null;
  /**
   * Địa chỉ NẠP của Polymarket (trang Deposit → Crypto → USDT Polygon): Polymarket tự đổi USDT nhận được
   * sang tiền giao dịch rồi đưa vào ví. KHÔNG phải ví ký / ví proxy (gửi USDT thẳng vào ví sẽ không thành
   * tiền giao dịch). Tự rút csgoempire → Polymarket chỉ rút về địa chỉ này. null = không tự chuyển chiều này.
   */
  readonly usdtDepositAddress?: string | null;
}

export type TradingAccountConfig =
  CsgoEmpireAccountConfig | PolymarketAccountConfig;

export interface TradingAccount {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly config: TradingAccountConfig;
  /** Mã hóa: polymarket = private key; csgoempire = JSON tài khoản/mật khẩu. null = chưa có. */
  readonly secretCipher: string | null;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Lỗi cấu hình tài khoản (null = hợp lệ). */
export function validateAccountConfig(c: TradingAccountConfig): string | null {
  if (
    c.usdtDepositAddress !== undefined &&
    c.usdtDepositAddress !== null &&
    !EVM_ADDRESS.test(c.usdtDepositAddress)
  )
    return 'DEPOSIT_ADDRESS_INVALID: dạng 0x + 40 ký tự hex';
  if (c.venue === 'csgoempire')
    return /^[\w.-]{1,64}$/.test(c.browserProfile) &&
      !['.', '..'].includes(c.browserProfile)
      ? null
      : 'BROWSER_PROFILE_INVALID: chỉ chữ, số, . _ - (tối đa 64 ký tự)';
  if (!EVM_ADDRESS.test(c.walletAddress))
    return 'WALLET_ADDRESS_INVALID: dạng 0x + 40 ký tự hex';
  if (c.funderAddress !== null && !EVM_ADDRESS.test(c.funderAddress))
    return 'FUNDER_ADDRESS_INVALID: dạng 0x + 40 ký tự hex';
  const dep = c.usdtDepositAddress?.toLowerCase();
  if (
    dep &&
    [c.walletAddress, c.funderAddress].some((w) => w?.toLowerCase() === dep)
  )
    return 'DEPOSIT_ADDRESS_IS_WALLET: địa chỉ nạp phải là địa chỉ ở trang Deposit của Polymarket, không phải ví ký / ví proxy';
  return null;
}

/** Private key EVM: 0x + 64 hex (cho phép thiếu 0x). Trả về dạng chuẩn hóa hoặc null. */
export function normalizePrivateKey(raw: string): string | null {
  const k = raw.trim().replace(/^0x/i, '');
  return /^[0-9a-fA-F]{64}$/.test(k) ? `0x${k.toLowerCase()}` : null;
}
