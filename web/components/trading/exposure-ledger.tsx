'use client';

import { useState } from 'react';
import { Database, RotateCcw } from 'lucide-react';
import { fmtDuration } from '@/lib/format';
import { marketLabel, parseMatchId } from '@/lib/markets';
import type {
  ExposureEntryView,
  ExposureMatchView,
  ExposureView,
} from '@/lib/trading-types';
import { cn } from '@/lib/utils';
import { useApi } from '@/hooks/use-api';
import { useGuard, useMutate } from '../shell/shell-context';
import { Button } from '../ui/button';
import { Segmented } from '../ui/controls';
import { Section } from '../ui/layout';
import { Confirm } from '../ui/panel';
import { Empty, ErrorState, SkeletonRows } from '../ui/states';
import { Table, TD, TH, THead, TR } from '../ui/table';
import { Tenant } from '../ui/tenant';

const usd = (n: number) => `${n.toFixed(2)}$`;
const ttl = (ms: number | null) => (ms == null ? '—' : fmtDuration(ms));

/** `room:cs2:a~b:market` → trận + market. */
const parseRoom = (room: string) => {
  const parts = room.replace(/^room:/, '').split(':');
  const market = parts.at(-1) ?? '';
  return { ...parseMatchId(parts.slice(0, -1).join(':')), market };
};

/** `sptpub>0|polymarket>1` → hai chân. */
const comboLegs = (combo: string) =>
  combo.split('|').map((p) => {
    const [tenant = '', side = ''] = p.split('>');
    return { tenant, side };
  });

function Meter({ used, cap }: { used: number; cap: number }) {
  if (!(cap > 0))
    return <span className="text-caption text-faint">không giới hạn</span>;
  const pct = Math.min(1, used / cap);
  return (
    <span className="ml-auto block w-36">
      <span className="block h-1.5 overflow-hidden rounded-full bg-hover">
        <span
          className={cn(
            'block h-full rounded-full',
            pct >= 0.95 ? 'bg-critical' : pct >= 0.7 ? 'bg-warn' : 'bg-accent',
          )}
          style={{ width: `${pct * 100}%` }}
        />
      </span>
      <span className="num mt-1 block text-caption text-muted-fg">
        còn {usd(Math.max(0, cap - used))}
      </span>
    </span>
  );
}

type Pending =
  | { kind: 'match'; m: ExposureMatchView }
  | { kind: 'entry'; e: ExposureEntryView }
  | null;

/**
 * Sổ phơi nhiễm THẬT trader dùng để quyết định, đọc thẳng từ Redis (không phụ thuộc lịch sử lệnh):
 * tiền đã dùng theo trận và số lệnh đã vào mỗi cửa mỗi hạng; đặt lại từng mục.
 */
export function ExposureLedger() {
  const [mode, setMode] = useState<'paper' | 'live'>('live');
  const { data, error, reload } = useApi<ExposureView>(
    `trading/exposure?mode=${mode}`,
    10_000,
  );
  const manage = useGuard('trading:manage');
  const mutate = useMutate();
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);

  const body = !data ? null : !data.available ? null : (
    <>
      <Section
        title="Hạn mức đã dùng theo trận"
        description="Tổng tiền đã vào (cả hai chân, mọi market, mọi hạng) theo bộ đếm trader dùng. Gồm cả lệnh đã xóa khỏi Lệnh giấy; mỗi lệnh vào mới gia hạn 12 giờ."
      >
        {!data.matches.length ? (
          <Empty icon={Database}>Chưa trận nào dùng hạn mức.</Empty>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Trận</TH>
                <TH numeric>Đã dùng (chung)</TH>
                <TH numeric>Hạn mức chung</TH>
                <TH>Riêng profile</TH>
                <TH numeric>Hết hạn sau</TH>
                <TH />
              </tr>
            </THead>
            <tbody>
              {data.matches.map((m) => {
                const { sport, teams } = parseMatchId(m.match);
                return (
                  <TR key={m.match}>
                    <TD>
                      <span className="block text-fg">
                        {teams[0]} vs {teams[1]}
                      </span>
                      <span className="num block text-caption text-muted-fg">
                        {sport}
                      </span>
                    </TD>
                    <TD numeric>
                      <span className="text-fg">{usd(m.usedUsd)}</span>
                      {m.capUsd > 0 ? (
                        <span className="text-caption text-muted-fg">
                          {' '}
                          / {usd(m.capUsd)}
                        </span>
                      ) : null}
                    </TD>
                    <TD numeric>
                      <Meter used={m.usedUsd} cap={m.capUsd} />
                    </TD>
                    <TD className="text-caption text-muted-fg">
                      {m.profiles.length
                        ? m.profiles.map((p) => (
                            <span key={p.profileId} className="block">
                              {p.profileName ?? p.profileId.slice(0, 8)}:{' '}
                              <span className="num text-fg">
                                {usd(p.usedUsd)}
                              </span>
                              {p.capUsd > 0 ? (
                                <span className="num"> / {usd(p.capUsd)}</span>
                              ) : null}
                            </span>
                          ))
                        : '—'}
                    </TD>
                    <TD numeric className="num text-caption text-muted-fg">
                      {ttl(m.ttlMs)}
                    </TD>
                    <TD numeric>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabledReason={manage}
                        onClick={() => setPending({ kind: 'match', m })}
                      >
                        <RotateCcw aria-hidden /> Trả lại
                      </Button>
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        )}
      </Section>

      <Section
        className="mt-10"
        title="Số lệnh đã vào theo cửa"
        description="Mỗi profile, mỗi cửa (market + cặp sàn/phía), mỗi hạng. Đạt tối đa → kèo cùng cửa ở hạng đó bị bỏ qua im lặng (không ghi dòng ở Lệnh giấy). Giữ 12 giờ từ lệnh vào gần nhất."
      >
        {!data.entries.length ? (
          <Empty icon={Database}>Chưa cửa nào có lệnh vào.</Empty>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Profile</TH>
                <TH>Trận · market</TH>
                <TH>Cửa</TH>
                <TH>Hạng</TH>
                <TH numeric>Đã vào</TH>
                <TH numeric>Hết hạn sau</TH>
                <TH />
              </tr>
            </THead>
            <tbody>
              {data.entries.map((e) => {
                const r = parseRoom(e.room);
                // max 0 = không giới hạn số lệnh
                const full = e.max !== null && e.max > 0 && e.count >= e.max;
                return (
                  <TR key={`${e.profileId}|${e.room}|${e.comboId}|${e.tierId}`}>
                    <TD className="text-muted-fg">
                      {e.profileName ?? e.profileId.slice(0, 8)}
                    </TD>
                    <TD>
                      <span className="block text-fg">
                        {r.teams[0]} vs {r.teams[1]}
                      </span>
                      <span className="block text-caption text-muted-fg">
                        {r.sport} · {marketLabel(r.market)}
                      </span>
                    </TD>
                    <TD className="text-caption">
                      {comboLegs(e.comboId).map((l) => (
                        <span
                          key={l.tenant + l.side}
                          className="flex items-center gap-1.5"
                        >
                          <Tenant tenant={l.tenant} />{' '}
                          <span className="text-muted-fg">
                            cửa {Number(l.side) + 1}
                          </span>
                        </span>
                      ))}
                    </TD>
                    <TD className="text-muted-fg">
                      {e.tierName ?? <span className="num">{e.tierId}</span>}
                    </TD>
                    <TD numeric>
                      <span
                        className={cn('num', full ? 'text-warn' : 'text-fg')}
                      >
                        {e.count}
                        {e.max !== null ? ` / ${e.max > 0 ? e.max : '∞'}` : ''}
                      </span>
                    </TD>
                    <TD numeric className="num text-caption text-muted-fg">
                      {ttl(e.ttlMs)}
                    </TD>
                    <TD numeric>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabledReason={manage}
                        onClick={() => setPending({ kind: 'entry', e })}
                      >
                        <RotateCcw aria-hidden /> Đặt lại
                      </Button>
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        )}
      </Section>
    </>
  );

  return (
    <div className="mt-12">
      <div className="mb-6 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-fg">
            Sổ phơi nhiễm (Redis)
          </h2>
          <p className="mt-1 text-caption text-muted-fg">
            Số liệu trader dùng để quyết định, đọc thẳng từ Redis. Khác thống kê
            ở Lệnh giấy (tính từ lịch sử lệnh còn lưu): xóa lệnh không làm sổ
            này đổi. Chỉ có khi task trader bật dùng chung qua Redis (mặc định
            bật).
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void reload()}>
          Tải lại
        </Button>
      </div>
      <Segmented<'paper' | 'live'>
        value={mode}
        onChange={(value) => {
          if (!busy) {
            setMode(value);
            setPending(null);
          }
        }}
        options={[
          { value: 'live', label: 'Giao dịch thật' },
          { value: 'paper', label: 'Giấy' },
        ]}
      />
      {error && !data ? <ErrorState message={error} onRetry={reload} /> : null}
      {!data && !error ? <SkeletonRows rows={4} /> : null}
      {data && !data.available ? (
        <ErrorState
          message={`Không đọc được Redis: ${data.error ?? 'không rõ'}`}
          onRetry={reload}
        />
      ) : null}
      {body}
      <Confirm
        open={!!pending}
        onOpenChange={(v) => !v && setPending(null)}
        tone="danger"
        title={
          pending?.kind === 'match'
            ? 'Trả lại hạn mức của trận?'
            : 'Đặt lại số lệnh của cửa?'
        }
        description={
          pending?.kind === 'match'
            ? `Xóa bộ đếm tiền đã dùng của ${parseMatchId(pending.m.match).teams.join(' vs ')} (chung và riêng mọi profile, ${usd(pending.m.usedUsd)}). Trader được vào trận này lại từ 0$.`
            : pending?.kind === 'entry'
              ? `Đếm lại từ 0 lệnh cho cửa này ở hạng ${pending.e.tierName ?? pending.e.tierId}: kèo cùng cửa có thể được vào thêm.`
              : undefined
        }
        confirmLabel={pending?.kind === 'match' ? 'Trả lại hạn mức' : 'Đặt lại'}
        loading={busy}
        onConfirm={async () => {
          if (!pending) return;
          setBusy(true);
          const r = await mutate(
            'trading/exposure/reset',
            {
              method: 'POST',
              body:
                pending.kind === 'match'
                  ? { match: pending.m.match, mode }
                  : {
                      mode,
                      entry: {
                        profileId: pending.e.profileId,
                        room: pending.e.room,
                        comboId: pending.e.comboId,
                        tierId: pending.e.tierId,
                      },
                    },
            },
            'Đã đặt lại',
          );
          setBusy(false);
          if (r !== null) {
            setPending(null);
            void reload();
          }
        }}
      />
    </div>
  );
}
