import { describe, expect, it, vi } from 'vitest';
import { InMemoryOpsEventBus } from '../../../../shared/infrastructure/ops/in-memory-ops-event-bus.js';
import { TradingReconcileIncidentRelay } from '../trading-reconcile-incident.relay.js';
import type { IncidentTracker } from '../incident-tracker.js';

describe('sự cố "cần đối soát lệnh thật"', () => {
  it('mở sự cố nghiêm trọng theo profile; gỡ khóa thì đóng', () => {
    const ops = new InMemoryOpsEventBus();
    const incidents = { raise: vi.fn(), clear: vi.fn() };
    new TradingReconcileIncidentRelay(
      ops,
      incidents as unknown as IncidentTracker,
    ).start();
    ops.publish({
      type: 'trading.reconcile_required',
      topic: 'alerts',
      at: 1,
      data: {
        profileId: 'p1',
        profileName: 'test',
        tradeId: 't1',
        summary: 'csgoempire: không vào · Polymarket: khớp 20 share, 8.50$',
      },
    });
    const [key, sig] = incidents.raise.mock.calls[0] as [
      string,
      { kind: string; severity: string; message: string },
    ];
    expect(key).toBe('trading.reconcile:p1');
    expect(sig).toMatchObject({
      kind: 'trading.reconcile',
      severity: 'critical',
    });
    expect(sig.message).toContain('Polymarket: khớp 20 share');
    ops.publish({
      type: 'trading.reconciled',
      topic: 'alerts',
      at: 2,
      data: { profileId: 'p1', cleared: 2 },
    });
    expect(incidents.clear).toHaveBeenCalledWith('trading.reconcile:p1');
  });

  it('mất phiên csgoempire (tự lấy bỏ cuộc) → sự cố nghiêm trọng theo hồ sơ; lấy lại được → đóng', () => {
    const ops = new InMemoryOpsEventBus();
    const incidents = { raise: vi.fn(), clear: vi.fn() };
    new TradingReconcileIncidentRelay(
      ops,
      incidents as unknown as IncidentTracker,
    ).start();
    ops.publish({
      type: 'trading.session_lost',
      topic: 'alerts',
      at: 1,
      data: { browserProfile: 'empire-test', error: 'x', attempts: 4 },
    });
    const [key, sig] = incidents.raise.mock.calls[0] as [
      string,
      { kind: string; severity: string },
    ];
    expect(key).toBe('trading.session:empire-test');
    expect(sig).toMatchObject({
      kind: 'trading.session',
      severity: 'critical',
    });
    ops.publish({
      type: 'trading.session_restored',
      topic: 'alerts',
      at: 2,
      data: { browserProfile: 'empire-test' },
    });
    expect(incidents.clear).toHaveBeenCalledWith('trading.session:empire-test');
  });

  it('lệnh hủy vì hết tiền → sự cố cảnh báo "cần cân bằng tiền"; đã chuyển xong → đóng', () => {
    const ops = new InMemoryOpsEventBus();
    const incidents = { raise: vi.fn(), clear: vi.fn() };
    new TradingReconcileIncidentRelay(
      ops,
      incidents as unknown as IncidentTracker,
    ).start();
    ops.publish({
      type: 'trading.rebalance_needed',
      topic: 'alerts',
      at: 1,
      data: {
        profileId: 'p1',
        profileName: 'test',
        tradeId: 't1',
        summary: 'Chuyển 65.00$ từ Polymarket sang csgoempire',
        fromVenue: 'polymarket',
        toVenue: 'csgoempire',
        amountUsd: 65,
      },
    });
    const [key, sig] = incidents.raise.mock.calls[0] as [
      string,
      { kind: string; severity: string; message: string },
    ];
    expect(key).toBe('trading.rebalance:p1');
    expect(sig).toMatchObject({
      kind: 'trading.rebalance',
      severity: 'warning',
    });
    expect(sig.message).toContain('Chuyển 65.00$');
    ops.publish({
      type: 'trading.rebalanced',
      topic: 'alerts',
      at: 2,
      data: { profileId: 'p1', by: 'admin' },
    });
    expect(incidents.clear).toHaveBeenCalledWith(
      'trading.rebalance:p1',
      'transferred',
    );
  });
});
