/**
 * Bus sự kiện VẬN HÀNH (khác domain event): các module báo "trạng thái vừa đổi"
 * để admin theo dõi/cảnh báo/ghi audit. Module phát không biết ai nghe.
 *
 * topic dùng để admin subscribe: tasks | nodes | consumers | signals | odds | alerts | audit | room:{id}
 */
export type OpsSeverity = 'info' | 'warning' | 'critical';

interface Base<TType extends string, TData> {
  readonly type: TType;
  readonly topic: string;
  readonly at: number;
  readonly data: TData;
}

export type OpsEvent =
  | Base<
      'task.state',
      {
        taskId: string;
        kind: string;
        tenant: string;
        from: string;
        to: string;
        reason?: string;
      }
    >
  | Base<
      'task.error',
      { taskId: string; kind: string; message: string; fatal: boolean }
    >
  | Base<'task.removed', { taskId: string; kind: string }>
  | Base<'node.connected', { nodeId: string }>
  | Base<'node.disconnected', { nodeId: string; affectedTasks: string[] }>
  | Base<'consumer.connected', { consumerId: string; role: string }>
  | Base<'consumer.disconnected', { consumerId: string; role: string }>
  | Base<
      'signal.issued' | 'signal.refreshed',
      {
        signalId: string;
        room: string;
        comboId: string;
        phase: string;
        margin: number;
        supersedes?: string | null;
      }
    >
  | Base<
      'signal.cancelled',
      {
        signalId: string;
        room: string;
        comboId: string;
        reason: string;
        /** Giờ bắt đầu từng chân + độ lệch lúc hủy. */
        detail?: {
          readonly startTimes: readonly {
            readonly tenant: string;
            readonly startsAt: number;
          }[];
          readonly startDriftMs: number | null;
          readonly maxStartDriftMs: number;
        } | null;
      }
    >
  /** Mọi thay đổi dòng kèo — CHỈ gửi cho ai subscribe đúng room (topic room:{id}). */
  | Base<
      'odds.changed',
      {
        room: string;
        tenant: string;
        phase: string;
        removed: boolean;
        odds?: readonly [number, number];
        status?: string;
        reason?: string;
      }
    >
  /** Chuyển trạng thái dòng kèo: xuất hiện / open↔suspended / bị gỡ. */
  | Base<
      'odds.transition',
      {
        room: string;
        tenant: string;
        phase: string;
        from: string | null; // null = mới xuất hiện
        to: string; // open | suspended | removed
        reason?: string;
      }
    >
  /** Xóa sạch room lúc khởi động (dòng kèo mồ côi từ lần chạy trước). */
  | Base<'odds.reset', { rooms: number; lines: number; reason: string }>
  /** Kết quả một vòng đối chiếu danh sách market của tenant (vd polymarket descriptor). */
  | Base<
      'odds.reconciled',
      {
        tenant: string;
        taskId: string;
        /** Market task này đang sở hữu trước khi đối chiếu. */
        known: number;
        /** Có mặt trong vòng quét. */
        seen: number;
        /** Vắng mặt nhưng chưa đủ số vòng để gỡ. */
        pending: number;
        /** Đã gỡ trong vòng này. */
        removed: number;
        /** Đang giữ lại (không gỡ) vì số lượng vắng mặt bất thường. */
        held: number;
        /** Tỉ lệ vắng mặt đủ điều kiện gỡ / known. */
        ratio: number;
        massive: boolean;
      }
    >
  | Base<
      'incident.opened' | 'incident.resolved' | 'incident.acknowledged',
      {
        key: string;
        kind: string;
        severity: OpsSeverity;
        title: string;
        message: string;
        by?: string;
      }
    >
  | Base<
      'trading.reconcile_required',
      {
        profileId: string;
        profileName: string;
        tradeId: string;
        /** "csgoempire: … · Polymarket: …" — chân nào khớp, chân nào lỗi. */
        summary: string;
      }
    >
  | Base<'trading.reconciled', { profileId: string; cleared: number }>
  | Base<
      'trading.rebalance_needed',
      {
        profileId: string;
        profileName: string;
        /** Lệnh thật vừa bị hủy vì thiếu Cash. */
        tradeId: string;
        /** Số dư hai bên, bên thiếu, đề xuất chuyển bao nhiêu từ đâu sang đâu (tỉ lệ 35/65). */
        summary: string;
        fromVenue: string | null;
        toVenue: string | null;
        amountUsd: number;
      }
    >
  | Base<'trading.rebalanced', { profileId: string; by: string }>
  | Base<
      'trading.rebalance_transfer',
      {
        profileId: string;
        profileName: string;
        /** dry_run · skipped · completed · failed · unconfirmed · unknown … */
        state: string;
        mode: 'dry_run' | 'live';
        fromVenue: string | null;
        toVenue: string | null;
        amountUsd: number;
        ref: string | null;
        reason: string | null;
      }
    >
  | Base<'trading.rebalance_unblocked', { profileId: string; by: string }>
  | Base<
      'trading.session_lost',
      { browserProfile: string; error: string; attempts: number }
    >
  | Base<'trading.session_restored', { browserProfile: string }>
  | Base<
      'audit.recorded',
      {
        principalId: string | null;
        method: string;
        route: string;
        ok: boolean;
        status: number;
      }
    >;

export type OpsEventType = OpsEvent['type'];
export type OpsListener = (event: OpsEvent) => void;

export interface OpsEventBus {
  publish(event: OpsEvent): void;
  /** Trả về hàm hủy đăng ký. */
  subscribe(listener: OpsListener): () => void;
}

export const OPS_EVENT_BUS = Symbol('OPS_EVENT_BUS');
