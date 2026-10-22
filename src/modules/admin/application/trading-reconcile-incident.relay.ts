import type { OpsEventBus } from '../../../shared/application/ops-event-bus.js';
import type { IncidentTracker } from './incident-tracker.js';

/**
 * Bot dừng chờ đối soát hai chân (lệnh thật lệch chân / không rõ kết quả) → mở sự cố NGHIÊM TRỌNG
 * `trading.reconcile:{profileId}` (hiện ở mục Sự cố, báo qua kênh cảnh báo). Gỡ khóa đối soát → đóng.
 */
export class TradingReconcileIncidentRelay {
  constructor(
    private readonly _ops: OpsEventBus,
    private readonly _incidents: IncidentTracker,
  ) {}

  /** Trả về hàm hủy đăng ký. */
  start(): () => void {
    return this._ops.subscribe((e) => {
      if (e.type === 'trading.session_restored')
        return this._incidents.clear(
          `trading.session:${e.data.browserProfile}`,
        );
      if (e.type === 'trading.session_lost')
        return this._incidents.raise(
          `trading.session:${e.data.browserProfile}`,
          {
            kind: 'trading.session',
            severity: 'critical',
            title: `Cần đăng nhập lại csgoempire (hồ sơ ${e.data.browserProfile})`,
            message: `App tự lấy phiên hỏng ${e.data.attempts} lần liên tiếp: ${e.data.error}. Profile dùng tài khoản này đang đứng yên — mở Auto trade → Tài khoản → Mở Chromium & đăng nhập.`,
            details: { ...e.data },
          },
        );
      // lệnh thật hủy vì hết tiền ở một bên → sự cố CẢNH BÁO kèm đề xuất chuyển tiền 35/65; bấm
      // "Đã chuyển xong" → đóng
      // tự chuyển tiền: lỗi / không rõ kết quả → sự cố NGHIÊM TRỌNG (tự chuyển của profile bị chặn);
      // chuyển xong hoặc người gỡ chặn → đóng
      if (e.type === 'trading.rebalance_unblocked')
        return this._incidents.clear(
          `trading.rebalance_transfer:${e.data.profileId}`,
          'unblocked',
        );
      if (e.type === 'trading.rebalance_transfer') {
        const d = e.data;
        const key = `trading.rebalance_transfer:${d.profileId}`;
        if (d.state === 'completed')
          return this._incidents.clear(key, 'completed');
        if (!['failed', 'unconfirmed', 'unknown'].includes(d.state)) return;
        return this._incidents.raise(key, {
          kind: 'trading.rebalance_transfer',
          severity: d.state === 'failed' ? 'warning' : 'critical',
          title:
            d.state === 'failed'
              ? `Tự chuyển tiền lỗi — profile ${d.profileName}`
              : `Tự chuyển tiền chưa rõ kết quả — profile ${d.profileName}`,
          message: `${d.amountUsd.toFixed(2)}$ ${d.fromVenue ?? '?'} → ${d.toVenue ?? '?'}${d.ref ? ` (${d.ref})` : ''}: ${d.reason ?? d.state}.${d.state === 'failed' ? '' : ' Tự chuyển của profile đã DỪNG: kiểm tra tiền trên hai sàn / Polygonscan rồi bấm "Gỡ chặn" ở Auto trade → Cân bằng tiền.'}`,
          details: { ...d },
        });
      }
      if (e.type === 'trading.rebalanced')
        return this._incidents.clear(
          `trading.rebalance:${e.data.profileId}`,
          'transferred',
        );
      if (e.type === 'trading.rebalance_needed')
        return this._incidents.raise(`trading.rebalance:${e.data.profileId}`, {
          kind: 'trading.rebalance',
          severity: 'warning',
          title: `Cần cân bằng tiền — profile ${e.data.profileName}`,
          message: `${e.data.summary} Chuyển tay rồi bấm "Đã chuyển xong" ở Auto trade → Cân bằng tiền.`,
          details: { ...e.data },
        });
      if (e.type === 'trading.reconciled')
        return this._incidents.clear(`trading.reconcile:${e.data.profileId}`);
      if (e.type !== 'trading.reconcile_required') return;
      const d = e.data;
      this._incidents.raise(`trading.reconcile:${d.profileId}`, {
        kind: 'trading.reconcile',
        severity: 'critical',
        title: `Cần đối soát lệnh thật — profile ${d.profileName} đã dừng`,
        message: `${d.summary}. Kiểm tra hai chân trên csgoempire (My bets) và Polymarket (Activity), xử lý chân lẻ nếu có, rồi bấm "Đã đối soát — gỡ khóa" ở trang Auto trade → Profile.`,
        details: { ...d },
      });
    });
  }
}
