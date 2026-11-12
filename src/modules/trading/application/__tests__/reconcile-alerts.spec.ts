import { describe, expect, it, vi } from 'vitest';
import { InMemoryOpsEventBus } from '../../../../shared/infrastructure/ops/in-memory-ops-event-bus.js';
import type { OpsEvent } from '../../../../shared/application/ops-event-bus.js';
import {
  ReconcileAlerts,
  legSummary,
  needsReconcile,
} from '../reconcile-alerts.js';
import type { TradeAttempt } from '../trade-attempt.js';

const leg = (venue: string, status: string, extra: object = {}) => ({
  venue,
  status,
  filledAmount: 0,
  cost: 0,
  error: null,
  ...extra,
});
const trade = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: 't1',
    profileId: 'p1',
    mode: 'live',
    teams: ['Navi', 'G2'],
    status: 'partial',
    reason: 'LIVE_RECONCILIATION_REQUIRED:abc',
    legs: [
      leg('csgoempire', 'rejected', {
        error: 'CSGOEMPIRE_ORDER_REJECTED: odds 2 — [odds changed]',
      }),
      leg('polymarket', 'filled', { filledAmount: 20, cost: 8.5 }),
    ],
    ...over,
  }) as unknown as TradeAttempt;

function setup() {
  const ops = new InMemoryOpsEventBus();
  const events: OpsEvent[] = [];
  ops.subscribe((e) => events.push(e));
  const push = { send: vi.fn(() => Promise.resolve({ id: 'n1', errors: [] })) };
  const alerts = new ReconcileAlerts(
    ops,
    push,
    (id) => Promise.resolve(id === 'p1' ? 'test lệnh nhỏ' : null),
    'https://arb.example/',
  );
  return { alerts, events, push };
}

describe('báo khi bot dừng chờ đối soát', () => {
  it('chỉ lệnh THẬT lệch chân / lỗi sau khi gửi mới cần đối soát', () => {
    expect(needsReconcile(trade())).toBe(true);
    expect(
      needsReconcile(
        trade({ status: 'error', reason: 'LIVE_EXECUTION_ERROR' }),
      ),
    ).toBe(true);
    expect(needsReconcile(trade({ mode: 'paper' }))).toBe(false);
    // bị hủy vì profile đang khóa sẵn bởi lệnh trước: không gửi gì → không báo lại
    expect(
      needsReconcile(
        trade({
          status: 'cancelled',
          reason: 'LIVE_RECONCILIATION_REQUIRED:9e7ec0f',
          legs: [
            leg('csgoempire', 'cancelled'),
            leg('polymarket', 'cancelled'),
          ],
        }),
      ),
    ).toBe(false);
    expect(
      needsReconcile(
        trade({ status: 'cancelled', reason: 'POLYMARKET_NOT_FILLED: x' }),
      ),
    ).toBe(false);
    expect(needsReconcile(trade({ status: 'filled', reason: null }))).toBe(
      false,
    );
  });

  it('tóm tắt từng chân: chân nào khớp, chân nào lỗi và vì sao', () => {
    expect(legSummary(trade())).toBe(
      'csgoempire: không vào (CSGOEMPIRE_ORDER_REJECTED: odds 2 — [odds changed]) · Polymarket: khớp 20 share, 8.50$',
    );
  });

  it('phát sự kiện vận hành (→ sự cố) + push về điện thoại mở trang Auto trade', async () => {
    const s = setup();
    await s.alerts.trade(trade());
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({
      type: 'trading.reconcile_required',
      data: { profileId: 'p1', profileName: 'test lệnh nhỏ', tradeId: 't1' },
    });
    expect(s.push.send).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Cần đối soát: Navi vs G2',
        url: 'https://arb.example/giao-dich',
        collapseId: 'reconcile:p1',
      }),
    );
  });

  it('lệnh bình thường: im lặng; gỡ khóa: phát sự kiện đã đối soát', async () => {
    const s = setup();
    await s.alerts.trade(trade({ status: 'filled', reason: null }));
    expect(s.events).toHaveLength(0);
    expect(s.push.send).not.toHaveBeenCalled();
    s.alerts.resolved('p1', 2);
    expect(s.events[0]).toMatchObject({
      type: 'trading.reconciled',
      data: { profileId: 'p1', cleared: 2 },
    });
  });

  it('tự lấy phiên bỏ cuộc → sự kiện + push nhắc đăng nhập; lấy lại được → sự kiện đóng', async () => {
    const s = setup();
    await s.alerts.sessionLost('empire-test', 'CSGOEMPIRE_SESSION_EXPIRED', 4);
    expect(s.events[0]).toMatchObject({
      type: 'trading.session_lost',
      data: { browserProfile: 'empire-test', attempts: 4 },
    });
    expect(s.push.send).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Cần đăng nhập lại csgoempire (empire-test)',
        url: 'https://arb.example/giao-dich',
        collapseId: 'session:empire-test',
      }),
    );
    s.alerts.sessionRestored('empire-test');
    expect(s.events[1]).toMatchObject({
      type: 'trading.session_restored',
      data: { browserProfile: 'empire-test' },
    });
  });

  it('push lỗi không làm hỏng luồng ghi lệnh', async () => {
    const onError = vi.fn();
    const alerts = new ReconcileAlerts(
      null,
      { send: () => Promise.reject(new Error('onesignal down')) },
      () => Promise.resolve(null),
      null,
      onError,
    );
    await expect(alerts.trade(trade())).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });
});
