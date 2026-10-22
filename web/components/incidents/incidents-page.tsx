'use client';

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { History } from 'lucide-react';
import type { Incident, ListResult } from '@/lib/types';
import { fmtDuration, fmtStamp } from '@/lib/format';
import { useApi } from '@/hooks/use-api';
import { useIsMobile } from '@/hooks/use-media';
import { useConsoleData } from '../console-data';
import { DrawerSection } from '../room-drawer';
import { Button } from '../ui/button';
import { Segmented, Select } from '../ui/controls';
import { PageHeader } from '../ui/layout';
import { Panel } from '../ui/panel';
import { Empty, ErrorState, SkeletonRows } from '../ui/states';
import { Pill, SEVERITY_LABEL, SEVERITY_TONE, StatusDot } from '../ui/status';
import { Table, TD, TH, THead, TR } from '../ui/table';
import { LiveStamp } from '../ui/values';
import { JsonBlock } from '../ui/code';
import { IncidentList, sortIncidents, useAck } from './incident-list';
import { cn } from '@/lib/utils';

const KINDS = ['task.failed', 'task.flapping', 'source.stale', 'node.down', 'infra.down', 'consumer.down', 'consumer.backlog', 'lane.backlog', 'odds.mass_removal', 'trading.reconcile', 'trading.session', 'trading.rebalance', 'trading.rebalance_transfer'];

export function IncidentsPage() {
  const params = useSearchParams();
  const { snapshot, snapshotAt, reloadSnapshot } = useConsoleData();
  const [tab, setTab] = useState<'open' | 'history'>('open');
  const [open, setOpen] = useState<Incident | null>(null);
  const hl = params.get('hl');
  const incidents = snapshot?.incidents ?? [];

  return (
    <div>
      <PageHeader
        title="Sự cố"
        description="Watchdog kiểm tra mỗi 5 giây. Xác nhận = đã biết, sự cố vẫn mở tới khi hết thật."
        meta={<LiveStamp at={snapshotAt} />}
        actions={
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'open', label: 'Đang mở', count: incidents.length },
              { value: 'history', label: 'Lịch sử' },
            ]}
          />
        }
      />
      {tab === 'open' ? (
        snapshot ? (
          <IncidentList incidents={incidents} onAcked={reloadSnapshot} onOpen={setOpen} highlight={hl} />
        ) : (
          <SkeletonRows rows={4} cols={[50, 10, 10]} />
        )
      ) : (
        <HistoryTable onOpen={setOpen} />
      )}
      <IncidentSheet incident={open} onClose={() => setOpen(null)} onAcked={reloadSnapshot} />
    </div>
  );
}

function HistoryTable({ onOpen }: { onOpen: (i: Incident) => void }) {
  const mobile = useIsMobile();
  const [severity, setSeverity] = useState('');
  const [kind, setKind] = useState('');
  const { data, error, reload } = useApi<ListResult<Incident>>(`admin/incidents?limit=200${kind ? `&kind=${kind}` : ''}`, 30_000);
  const items = useMemo(() => {
    return sortIncidents((data?.items ?? []).filter((i) => !severity || i.severity === severity)).sort((a, b) => b.openedAt - a.openedAt);
  }, [data, severity]);
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Select value={severity} onChange={(e) => setSeverity(e.target.value)} className="w-40" aria-label="Mức độ">
          <option value="">Mọi mức độ</option>
          <option value="critical">Nghiêm trọng</option>
          <option value="warning">Cảnh báo</option>
        </Select>
        <Select value={kind} onChange={(e) => setKind(e.target.value)} className="w-48" aria-label="Loại">
          <option value="">Mọi loại</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
        <span className="num ml-auto text-caption text-faint">{data ? `${data.total} sự cố` : ''}</span>
      </div>
      {error && !data ? <ErrorState message={error} onRetry={reload} /> : null}
      {!data && !error ? <SkeletonRows rows={8} cols={[8, 36, 14, 14, 10, 12]} /> : null}
      {data && !items.length ? <Empty icon={History}>Không có sự cố nào trong khoảng này.</Empty> : null}
      {items.length ? (
        mobile ? (
          <ul>
            {items.map((i) => (
              <li key={i.id} onClick={() => onOpen(i)} className="flex min-h-14 cursor-pointer items-start gap-3 border-b border-line py-3">
                <StatusDot tone={SEVERITY_TONE[i.severity]} className="mt-1.5" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body text-fg">{i.title}</div>
                  <div className="num mt-0.5 text-caption text-muted-fg">
                    {fmtStamp(i.openedAt)} · {i.resolvedAt ? fmtDuration(i.resolvedAt - i.openedAt) : 'đang mở'}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Mức độ</TH>
                <TH>Sự cố</TH>
                <TH>Loại</TH>
                <TH>Mở lúc</TH>
                <TH numeric>Kéo dài</TH>
                <TH>Xác nhận</TH>
                <TH>Kết thúc</TH>
              </tr>
            </THead>
            <tbody>
              {items.map((i) => (
                <TR key={i.id} interactive onClick={() => onOpen(i)}>
                  <TD>
                    <span className="inline-flex items-center gap-2 text-caption text-muted-fg">
                      <StatusDot tone={SEVERITY_TONE[i.severity]} /> {SEVERITY_LABEL[i.severity]}
                    </span>
                  </TD>
                  <TD className="max-w-[340px] truncate text-fg">{i.title}</TD>
                  <TD className="num text-caption text-muted-fg">{i.kind}</TD>
                  <TD className="num text-caption text-muted-fg">{fmtStamp(i.openedAt)}</TD>
                  <TD numeric className="text-caption">{i.resolvedAt ? fmtDuration(i.resolvedAt - i.openedAt) : <span className="text-warn">đang mở</span>}</TD>
                  <TD className="text-caption text-muted-fg">{i.acknowledgedBy ?? <span className="text-faint">—</span>}</TD>
                  <TD className="num text-caption text-muted-fg">{i.resolution ?? '—'}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )
      ) : null}
    </div>
  );
}

/** Chi tiết sự cố + dòng thời gian (mở → xác nhận → lần thấy cuối → hết). */
function IncidentSheet({ incident: i, onClose, onAcked }: { incident: Incident | null; onClose: () => void; onAcked: () => void }) {
  const { ack, busy, reason } = useAck(() => {
    onAcked();
    onClose();
  });
  const steps = i
    ? ([
        ['Mở', i.openedAt, 'critical'],
        i.acknowledgedAt ? [`Xác nhận bởi ${i.acknowledgedBy}`, i.acknowledgedAt, 'accent'] : null,
        !i.resolvedAt ? ['Lần thấy cuối', i.lastSeenAt, 'warn'] : null,
        i.resolvedAt ? [`Kết thúc · ${i.resolution ?? ''}`, i.resolvedAt, 'ok'] : null,
      ].filter(Boolean) as [string, number, string][])
    : [];
  return (
    <Panel
      open={!!i}
      onOpenChange={(v) => !v && onClose()}
      eyebrow={i ? <span className="num">{i.key}</span> : null}
      title={i?.title ?? ''}
      description={i ? <Pill tone={SEVERITY_TONE[i.severity]}>{SEVERITY_LABEL[i.severity]}</Pill> : null}
      footer={
        i && !i.resolvedAt && !i.acknowledgedAt ? (
          <Button variant="primary" loading={busy === i.key} disabledReason={reason} onClick={() => void ack(i.key)}>
            Xác nhận
          </Button>
        ) : null
      }
    >
      {i ? (
        <div>
          <p className="mb-6 text-body text-muted-fg">{i.message}</p>
          <DrawerSection title="Dòng thời gian">
            <ol className="relative ml-1.5 border-l border-line">
              {steps.map(([label, at, tone]) => (
                <li key={label} className="relative pb-4 pl-5 last:pb-0">
                  <span className={cn('absolute -left-[4.5px] top-1.5 size-2 rounded-full ring-4 ring-raised', `bg-${tone}`)} />
                  <div className="text-body text-fg">{label}</div>
                  <div className="num text-caption text-muted-fg">{fmtStamp(at)}</div>
                </li>
              ))}
            </ol>
          </DrawerSection>
          <JsonBlock value={i.details} title="Chi tiết" />
        </div>
      ) : null}
    </Panel>
  );
}
