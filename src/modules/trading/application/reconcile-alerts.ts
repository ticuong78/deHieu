import type { OpsEventBus } from '../../../shared/application/ops-event-bus.js';
import type { TradeAttempt } from './trade-attempt.js';
import type { PushSender } from './one-click-notifier.js';

/**
 * Lệnh thật làm bot dừng chờ đối soát (lệch chân / không rõ kết quả sau khi đã gửi). Lệnh bị HỦY vì
 * profile đang khóa sẵn (lý do = khóa của lệnh trước) không gửi gì lên sàn → không phải lệnh cần đối
 * soát, không báo lại (báo lại sẽ đè mô tả của lệnh thật cần đối soát).
 */
export function needsReconcile(t: TradeAttempt): boolean {
  const code = (t.reason ?? '').split(':')[0].trim();
  return (
    t.mode === 'live' &&
    ((code === 'LIVE_RECONCILIATION_REQUIRED' && t.status !== 'cancelled') ||
      (t.status === 'error' && code === 'LIVE_EXECUTION_ERROR'))
  );
}

const LEG_STATUS: Record<string, string> = {
  filled: 'khớp',
  partial: 'khớp một phần',
  accepted: 'đã nhận, chưa khớp',
  rejected: 'không vào',
  cancelled: 'không gửi',
  error: 'KHÔNG RÕ',
};

/** "csgoempire: không vào (…) · Polymarket: khớp 20 share, 8.50$" */
export function legSummary(t: TradeAttempt): string {
  if (!t.legs.length) return 'chưa rõ chân nào đã gửi';
  return t.legs
    .map((l) => {
      const name = l.venue === 'polymarket' ? 'Polymarket' : 'csgoempire';
      const st = LEG_STATUS[l.status] ?? l.status;
      const amount =
        l.filledAmount > 0
          ? ` ${l.venue === 'polymarket' ? `${+l.filledAmount.toFixed(2)} share` : `${l.filledAmount.toFixed(2)}$`}, ${l.cost.toFixed(2)}$`
          : '';
      const why =
        l.status !== 'filled' && l.error ? ` (${l.error.slice(0, 120)})` : '';
      return `${name}: ${st}${amount}${why}`;
    })
    .join(' · ');
}

/**
 * Báo khi bot dừng chờ đối soát: sự kiện vận hành (→ mục Sự cố + kênh cảnh báo của admin) và push về
 * điện thoại (OneSignal, nếu đã cấu hình). Gỡ khóa bằng nút → đóng sự cố.
 */
export class ReconcileAlerts {
  constructor(
    private readonly _ops: OpsEventBus | null,
    private readonly _push: PushSender | null,
    private readonly _profileName: (id: string) => Promise<string | null>,
    private readonly _webUrl: string | null,
    private readonly _onError: (e: unknown) => void = () => undefined,
    private readonly _now: () => number = Date.now,
  ) {}

  /** Gọi cho MỌI lệnh ghi về; chỉ báo lệnh cần đối soát. Không ném lỗi. */
  async trade(t: TradeAttempt): Promise<void> {
    if (!needsReconcile(t)) return;
    try {
      const profileName = (await this._profileName(t.profileId)) ?? t.profileId;
      const summary = legSummary(t);
      this._ops?.publish({
        type: 'trading.reconcile_required',
        topic: 'alerts',
        at: this._now(),
        data: {
          profileId: t.profileId,
          profileName,
          tradeId: t.id,
          summary,
          match: `${t.teams[0]} vs ${t.teams[1]}`,
          tradeAt: t.createdAt,
        },
      });
      await this._push?.send({
        title: `Cần đối soát: ${t.teams[0]} vs ${t.teams[1]}`,
        body: `${summary}\nProfile ${profileName} đã DỪNG vào lệnh. Kiểm tra hai chân trên sàn rồi bấm "Đã đối soát — gỡ khóa".`,
        url: this._webUrl
          ? `${this._webUrl.replace(/\/+$/, '')}/giao-dich`
          : null,
        collapseId: `reconcile:${t.profileId}`.slice(0, 64),
        ttlSec: 24 * 3600,
      });
    } catch (e) {
      this._onError(e);
    }
  }

  /** Tự lấy phiên csgoempire hỏng đủ số lần → cần người bấm Đăng nhập: sự cố + push. Không ném lỗi. */
  async sessionLost(
    browserProfile: string,
    error: string,
    attempts: number,
  ): Promise<void> {
    try {
      this._ops?.publish({
        type: 'trading.session_lost',
        topic: 'alerts',
        at: this._now(),
        data: { browserProfile, error: error.slice(0, 300), attempts },
      });
      await this._push?.send({
        title: `Cần đăng nhập lại csgoempire (${browserProfile})`,
        body: `App tự lấy phiên hỏng ${attempts} lần liên tiếp: ${error.slice(0, 160)}\nProfile dùng tài khoản này đang đứng yên. Mở Auto trade → Tài khoản → Mở Chromium & đăng nhập.`,
        url: this._webUrl
          ? `${this._webUrl.replace(/\/+$/, '')}/giao-dich`
          : null,
        collapseId: `session:${browserProfile}`.slice(0, 64),
        ttlSec: 24 * 3600,
      });
    } catch (e) {
      this._onError(e);
    }
  }

  /** Đã lấy lại được phiên (đăng nhập tay / tự động) sau khi bỏ cuộc → đóng sự cố. */
  sessionRestored(browserProfile: string): void {
    try {
      this._ops?.publish({
        type: 'trading.session_restored',
        topic: 'alerts',
        at: this._now(),
        data: { browserProfile },
      });
    } catch (e) {
      this._onError(e);
    }
  }

  /** Đã gỡ khóa đối soát (nút trên web) → đóng sự cố. */
  resolved(profileId: string, cleared: number): void {
    try {
      this._ops?.publish({
        type: 'trading.reconciled',
        topic: 'alerts',
        at: this._now(),
        data: { profileId, cleared },
      });
    } catch (e) {
      this._onError(e);
    }
  }
}
