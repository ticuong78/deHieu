'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ExternalLink, Trash2 } from 'lucide-react';
import { fmtMargin, fmtStamp } from '@/lib/format';
import { roomHref, tenantHref } from '@/lib/match-links';
import { CANCEL_REASONS } from '@/lib/skip-reasons';
import {
  insufficientCashLabel,
  insufficientCashExplanation,
} from '@/lib/trade-cash-reason';
import type { TradeAttempt, TradeDetail as Detail } from '@/lib/trading-types';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { JsonBlock } from '../ui/code';
import { KV } from '../ui/layout';
import { Panel } from '../ui/panel';
import { Pill } from '../ui/status';
import { identityText } from './account-check';
import { Table, TD, TH, THead, TR } from '../ui/table';
import { DrawerSection } from '../room-drawer';
import { driftSummary, StartTimeDetail } from '../start-time-detail';

export const TRADE_STATUS: Record<
  TradeAttempt['status'],
  { label: string; tone: 'ok' | 'muted' | 'warn' | 'critical' }
> = {
  filled: { label: 'Vào (thật)', tone: 'ok' },
  partial: { label: 'Cần đối soát', tone: 'critical' },
  paper_filled: { label: 'Vào (giấy)', tone: 'ok' },
  skipped: { label: 'Bỏ qua', tone: 'muted' },
  cancelled: { label: 'Kèo hủy', tone: 'warn' },
  error: { label: 'Lỗi', tone: 'critical' },
};

/** Lý do (mã trước dấu ":") → nhãn ngắn. */
export const REASON_LABEL: Record<string, string> = {
  INSUFFICIENT_CASH: 'Không đủ số dư — hủy cả hai chân',
  CASH_UNAVAILABLE: 'Không đọc được Cash — hủy cả hai chân',
  LIVE_RECONCILIATION_REQUIRED: 'Dừng để đối soát hai chân',
  CSGOEMPIRE_SESSION_EXPIRED: 'Phiên csgoempire hết hạn',
  CSGOEMPIRE_SESSION_REJECTED: 'BetBy từ chối phiên — app tự lấy phiên mới',
  CSGOEMPIRE_CLOUDFLARE_BLOCKED:
    'Cloudflare của csgoempire chặn yêu cầu đọc số dư — hủy cả hai chân',
  VENUE_NOT_JSON: 'Sàn trả trang web thay vì dữ liệu — hủy cả hai chân',
  CSGOEMPIRE_BALANCE_UNAVAILABLE:
    'Chưa có số dư csgoempire mới (Chrome nền) — hủy cả hai chân',
  CSGOEMPIRE_HTTP_REJECTED:
    'csgoempire từ chối yêu cầu đọc số dư — hủy cả hai chân',
  BOTH_ORDERS_REJECTED: 'Hai sàn từ chối lệnh',
  POLYMARKET_NOT_FILLED: 'Polymarket không khớp — không vào BetBy',
  SUSPICIOUS_MARGIN: 'Margin cao bất thường — nghi giá cũ',
  LOW_DAILY_RETURN: 'Lãi theo ngày thấp — trận còn xa',
  LIVE_ALREADY_SUBMITTED: 'Cặp lệnh đã được gửi',
  NO_EDGE: 'Hết lãi sau phí',
  INSUFFICIENT_DEPTH: 'Sổ lệnh mỏng',
  BUDGET_EXHAUSTED: 'Hết hạn mức trận',
  CAP_REACHED: 'Hết hạn mức trận',
  BELOW_MIN_ORDER: 'Dưới lệnh tối thiểu',
  NO_TIER: 'Không thuộc hạng nào',
  TIER_NOT_SELECTED: 'Hạng không được chọn',
  MARKET_NOT_SELECTED: 'Market không được chọn',
  INACTIVE: 'Profile đứng yên',
  STALE_SIGNAL: 'Kèo quá cũ',
  SIGNAL_EXPIRED: 'Kèo hết hạn',
  UNSUPPORTED_COMBO: 'Cặp sàn chưa hỗ trợ',
  MISSING_REF: 'Thiếu mã Polymarket',
  MARKET_CLOSED: 'Market đã đóng',
  UNKNOWN_STRATEGY: 'Chiến lược không có',
  HUB_PAUSED: 'Consumer bị tạm dừng',
  ALREADY_ENTERED: 'Cửa này đã vào',
  SIGNAL_CANCELLED: 'Kèo bị hủy',
  TASK_STOPPED: 'Task bị dừng',
  ONE_CLICK: 'Chuyển On click',
};

const code = (r: string | null) => (r ?? '').split(':')[0]!.trim();
const rest = (r: string | null) =>
  (r ?? '').split(':').slice(1).join(':').trim();

/** Nhãn đọc được: kèo hủy thì kèm lý do hủy của publisher. */
export function reasonText(
  t: Pick<TradeAttempt, 'reason'> & { detail?: Pick<Detail, 'cash'> },
): string {
  const c = code(t.reason);
  if (c === 'INSUFFICIENT_CASH') return insufficientCashLabel(t.detail?.cash);
  if (c === 'SIGNAL_CANCELLED') {
    const why = rest(t.reason);
    return `Kèo bị hủy: ${CANCEL_REASONS[why] ?? why}`;
  }
  if (c === 'INACTIVE') {
    // "Profile đứng yên" kèm LÝ DO (vd phiên csgoempire hết hạn) thay vì chỉ nhãn chung
    const why = rest(t.reason);
    const inner = REASON_LABEL[code(why)];
    return why
      ? `${REASON_LABEL.INACTIVE}: ${inner ?? why}`
      : REASON_LABEL.INACTIVE;
  }
  return REASON_LABEL[c] ?? c;
}

/** Giải thích đầy đủ vì sao có kết quả này. */
function explain(t: TradeAttempt, d: Detail): string {
  const c = code(t.reason);
  const minPct = d.sizing
    ? `${+(d.sizing.minNetMargin * 100).toFixed(2)}%`
    : 'ngưỡng';
  switch (c) {
    case 'INSUFFICIENT_CASH':
      return insufficientCashExplanation(d.cash);
    case '':
      return t.status === 'paper_filled' || t.status === 'filled'
        ? `Vào ${usd(t.book?.stake ?? 0)} bên csgoempire và ${+(t.polymarket?.shares ?? 0).toFixed(2)} share bên Polymarket${d.limitedBy === 'depth' ? ' — ít hơn mục tiêu vì sổ lệnh chỉ có chừng đó ở giá còn lãi' : d.limitedBy === 'budget' ? ' — bị cắt bớt theo hạn mức trận' : ''}.`
        : '';
    case 'SIGNAL_CANCELLED': {
      const why = rest(t.reason);
      const drift =
        why === 'start_time_mismatch' ? driftSummary(d.cancel?.detail) : null;
      return `Publisher hủy kèo (${CANCEL_REASONS[why] ?? why}${drift ? `: ${drift}` : ''})${d.cancelledAfterMs !== undefined ? ` sau ${d.cancelledAfterMs}ms kể từ lúc trader nhận` : ''}, khi trader còn đang đọc sổ lệnh / tính lệnh nên dừng, không vào.`;
    }
    case 'NO_EDGE':
      return `Ở giá ask tốt nhất (${d.bestAsk ?? '—'}), sau phí taker lãi ròng đã dưới ${minPct}, nên không có mức giá nào đáng mua.`;
    case 'INSUFFICIENT_DEPTH':
      return d.depth && d.sizing
        ? `Ở các mức giá còn lãi ≥ ${minPct} (tới ${d.depth.maxPrice ?? '—'}), sổ lệnh chỉ có ${+d.depth.sharesAtEdge.toFixed(2)} share — đủ cho ${usd(d.depth.maxStakeAtEdge)} bên csgoempire, dưới mức tối thiểu ${usd(d.sizing.minStake)} (mục tiêu ${usd(d.sizing.targetStake)} cần ${+d.depth.targetShares.toFixed(2)} share).`
        : rest(t.reason);
    case 'BELOW_MIN_ORDER':
      return `Số share mua được dưới lệnh tối thiểu của market (${d.sizing?.minShares ?? '—'} share). ${rest(t.reason)}`;
    case 'LOW_DAILY_RETURN':
      return `Lãi chia cho số ngày vốn bị khóa tới khi trận có kết quả (${rest(t.reason)}) dưới ngưỡng lãi tối thiểu mỗi ngày của profile/hạng, nên bỏ qua để dành tiền cho kèo trận gần lãi cao hơn. Kèo được xét lại mỗi lần làm mới: trận càng gần, lãi/ngày càng cao.`;
    case 'ONE_CLICK':
      return `Giá bán thấp nhất Polymarket ${d.minAsk ?? '—'} ≥ ngưỡng On click ${d.oneClickMinPrice ?? '—'} của profile, nên bot không tự vào mà chuyển kèo sang trang On click chờ người bấm vào lệnh.`;
    case 'BUDGET_EXHAUSTED':
    case 'CAP_REACHED':
      return `Giới hạn tổng tiền cho trận này (chung mọi trader hoặc riêng profile) chỉ còn ${d.budget !== undefined && d.budget !== null ? usd(d.budget) : 'ít'}, không đủ mức tối thiểu.`;
    default:
      return rest(t.reason) || reasonText(t);
  }
}

const msv = (v: number | null) => (v === null ? '—' : `${v} ms`);
const PREP_STEP: Record<string, string> = {
  cash: 'số dư',
  limit: 'hạn mức BetBy',
  client: 'kết nối',
  sign: 'ký lệnh',
};
/** "412 ms (số dư 3 ms · hạn mức BetBy 410 ms)" */
const prepText = (p: { totalMs: number; steps: Record<string, number> }) => {
  const steps = Object.entries(p.steps)
    .map(([k, v]) => `${PREP_STEP[k] ?? k} ${v} ms`)
    .join(' · ');
  return `${p.totalMs} ms${steps ? ` (${steps})` : ''}`;
};
const usd = (n: number) => `${n < 0 ? '-' : ''}${Math.abs(n).toFixed(2)}$`;

/** "Trận 8/12 · iem-cologne" theo một sàn. */
export function TournamentLine({
  leg,
}: {
  leg:
    | { tournament?: { name: string | null; no: number; of: number } | null }
    | null
    | undefined;
}) {
  const t = leg?.tournament;
  if (!t)
    return (
      <div className="mt-1 text-caption text-faint">
        Không rõ thứ tự trong giải
      </div>
    );
  return (
    <div className="mt-1 text-caption text-muted-fg">
      Trận thứ <span className="num text-fg">{t.no}</span>/
      <span className="num">{t.of}</span> trong giải
      {t.name ? <span className="text-fg"> {t.name}</span> : null}
    </div>
  );
}
const ms = (a: number | null | undefined, b: number | null | undefined) =>
  a != null && b != null ? `${Math.max(0, b - a)}ms` : '—';

function SourceLink({
  url,
  label,
}: {
  url: string | null | undefined;
  label: string;
}) {
  const href = tenantHref({ url: url ?? '' });
  if (!href)
    return <span className="text-caption text-faint">không có link</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 text-caption text-accent-text hover:underline"
    >
      {label} <ExternalLink className="size-3.5" aria-hidden />
    </a>
  );
}

export function TradeDetailPanel({
  trade,
  profileName,
  onClose,
  onDelete,
  deleteDisabledReason,
  badge,
  footer,
}: {
  trade: TradeAttempt | null;
  profileName: (id: string) => string;
  onClose: () => void;
  /** Có = hiện nút xóa lệnh ở chân panel. */
  onDelete?: (t: TradeAttempt) => void;
  deleteDisabledReason?: string | null;
  /** Thay nhãn trạng thái ở đầu panel. */
  badge?: ReactNode;
  /** Thay chân panel (vd nút Vào lệnh ở On click). */
  footer?: ReactNode;
}) {
  const t = trade;
  const d = (t?.detail ?? {}) as Detail;
  const tm = t?.timing;
  const st = t ? TRADE_STATUS[t.status] : null;
  const room = t ? roomHref(t.room) : null;
  return (
    <Panel
      open={!!t}
      onOpenChange={(v) => !v && onClose()}
      width="lg"
      eyebrow={t ? `${t.sport} · ${t.market} · ${t.phase}` : undefined}
      title={t ? `${t.teams[0]} vs ${t.teams[1]}` : ''}
      actions={
        badge ??
        (st ? (
          <span className="flex items-center gap-2">
            {d.manual ? <Pill tone="muted">Vào tay</Pill> : null}
            <Pill tone={st.tone}>{st.label}</Pill>
          </span>
        ) : null)
      }
      footer={
        footer !== undefined ? (
          footer
        ) : t && onDelete ? (
          <Button
            variant="danger-ghost"
            size="sm"
            disabledReason={deleteDisabledReason}
            onClick={() => onDelete(t)}
          >
            <Trash2 aria-hidden /> Xóa lệnh này
          </Button>
        ) : undefined
      }
    >
      {t ? (
        <div>
          <DrawerSection title="Kết quả">
            {t.reason ? (
              <div className="mb-1 text-body font-medium text-fg">
                {reasonText(t)}
              </div>
            ) : null}
            <p className="text-body text-muted-fg">{explain(t, d)}</p>
            {t.reason ? (
              <p className="num mt-2 text-caption text-faint">{t.reason}</p>
            ) : null}
            {d.cash ? (
              <KV
                className="mt-4"
                items={d.cash.flatMap((c) => {
                  const configured =
                    c.venue === 'csgoempire' || c.venue === 'polymarket'
                      ? d.accounts?.[c.venue]?.label
                      : undefined;
                  return [
                    [
                      `Tài khoản ${c.venue}`,
                      <span key={`a-${c.venue}`} className="num">
                        {configured ? (
                          <span className="text-muted-fg">{configured} → </span>
                        ) : null}
                        {c.account
                          ? identityText(c.venue, c.account)
                          : 'không ghi (lệnh cũ)'}
                      </span>,
                    ],
                    [
                      `Cash ${c.venue}`,
                      `${usd(c.available)} / cần ${usd(c.required)}${c.available < c.required ? ' — thiếu tiền, hủy cả cặp' : ''}`,
                    ],
                  ];
                })}
              />
            ) : null}
            {d.feeEstimated && t.mode === 'live' ? (
              <p className="mt-2 text-caption text-faint">
                Phí Polymarket đang dùng mức ước tính bảo thủ.
              </p>
            ) : null}
            {d.manual ? (
              <p className="mt-2 text-caption text-muted-fg">
                Người vào lệnh ở On click:{' '}
                <span className="text-fg">{d.manual.by}</span> (không phải bot).
              </p>
            ) : null}
            {d.cancel?.ignored ? (
              <p className="mt-2 text-caption text-warn">
                Kèo bị hủy khi đang tính (
                {CANCEL_REASONS[d.cancel.reason] ?? d.cancel.reason}
                {d.cancel.reason === 'start_time_mismatch' &&
                driftSummary(d.cancel.detail)
                  ? `: ${driftSummary(d.cancel.detail)}`
                  : ''}
                ) nhưng profile được cấu hình vẫn vào tiếp với lý do này.
              </p>
            ) : null}
            {t.status === 'paper_filled' || t.status === 'filled' ? (
              <KV
                className="mt-4"
                items={[
                  ['Tổng tiền (2 chân)', usd(t.totalCost)],
                  ['Nhận về nếu thắng', usd(t.payout)],
                  [
                    'Lãi giả định',
                    <span
                      key="p"
                      className={t.profit >= 0 ? 'text-ok' : 'text-critical'}
                    >{`${usd(t.profit)} (${fmtMargin(t.netMargin)})`}</span>,
                  ],
                ]}
              />
            ) : null}
          </DrawerSection>

          <DrawerSection title="Kèo">
            <KV
              items={[
                [
                  'Margin kèo',
                  `${fmtMargin(t.signalMargin)}${t.tierName ? ` · hạng ${t.tierName}` : ''}`,
                ],
                [
                  'Tiền mục tiêu',
                  d.sizing
                    ? `${usd(d.sizing.targetStake)} (tối thiểu ${usd(d.sizing.minStake)})`
                    : d.targetStake != null
                      ? usd(d.targetStake)
                      : '—',
                ],
                ['Profile', profileName(t.profileId)],
                ['Lúc', fmtStamp(t.createdAt)],
              ]}
            />
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
              {room ? (
                <Link
                  href={room}
                  className="text-caption text-accent-text hover:underline"
                >
                  Xem trận trong Arb Ops →
                </Link>
              ) : null}
              <Link
                href={`/keo?tab=history&q=${encodeURIComponent(t.signalId)}`}
                className="num text-caption text-faint hover:text-accent-text hover:underline"
              >
                kèo {t.signalId} → lịch sử kèo
              </Link>
            </div>
          </DrawerSection>

          <DrawerSection title="Hai chân">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {t.book ? (
                <div className="rounded-[8px] border border-line p-3">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-caption text-muted-fg">
                      csgoempire
                    </span>
                    <SourceLink url={t.book.url} label="Mở csgoempire" />
                  </div>
                  <div className="text-body text-fg">
                    {t.book.pick}{' '}
                    <span className="num">@ {t.book.odds.toFixed(2)}</span>
                  </div>
                  <div className="num mt-1 text-caption text-muted-fg">
                    {t.book.stake > 0
                      ? `cược ${usd(t.book.stake)} → thắng nhận ${usd(t.book.stake * t.book.odds)}`
                      : 'không vào'}
                  </div>
                  <TournamentLine leg={t.book} />
                </div>
              ) : null}
              {t.polymarket ? (
                <div className="rounded-[8px] border border-line p-3">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-caption text-muted-fg">
                      Polymarket
                    </span>
                    <SourceLink url={t.polymarket.url} label="Mở Polymarket" />
                  </div>
                  <div className="text-body text-fg">
                    {t.polymarket.pick}{' '}
                    <span className="num">
                      @ {t.polymarket.odds.toFixed(2)}
                    </span>
                    <span className="num text-caption text-muted-fg">
                      {' '}
                      (giá{' '}
                      {t.polymarket.odds > 0
                        ? (1 / t.polymarket.odds).toFixed(3)
                        : '—'}
                      )
                    </span>
                  </div>
                  <div className="num mt-1 text-caption text-muted-fg">
                    {t.polymarket.shares > 0
                      ? `${+t.polymarket.shares.toFixed(2)} share × ${t.polymarket.avgPrice.toFixed(3)} + phí ${usd(t.polymarket.fee)} = ${usd(t.polymarket.cost)}`
                      : 'không vào'}
                  </div>
                  <TournamentLine leg={t.polymarket} />
                </div>
              ) : null}
            </div>
            {t.mode === 'live'
              ? t.legs.map((leg) => (
                  <div
                    key={leg.venue}
                    className="mt-3 text-caption text-muted-fg"
                  >
                    {leg.venue}: {leg.status}
                    {leg.orderRef ? ` · mã ${leg.orderRef}` : ''}
                    {leg.error ? ` · ${leg.error}` : ''}
                  </div>
                ))
              : null}
            <p className="mt-2 text-caption text-faint">
              Thứ tự trong giải: đếm các trận cùng giải mà sàn đang liệt kê, xếp
              theo giờ bắt đầu (sàn thường không liệt kê trận đã xong).
            </p>
          </DrawerSection>

          {d.depth ? (
            <DrawerSection
              title="Sổ lệnh Polymarket lúc quyết định"
              hint={
                d.bookAt
                  ? `sổ lệnh lúc ${new Date(d.bookAt).toLocaleTimeString('en-GB')}`
                  : undefined
              }
            >
              <p className="mb-3 text-caption text-muted-fg">
                Ở giá còn lãi ≥{' '}
                {d.sizing
                  ? `${+(d.sizing.minNetMargin * 100).toFixed(2)}%`
                  : 'ngưỡng'}
                :{' '}
                <span className="num text-fg">
                  {+d.depth.sharesAtEdge.toFixed(2)}
                </span>{' '}
                share (
                <span className="num text-fg">{usd(d.depth.usdAtEdge)}</span>),
                đủ cân{' '}
                <span className="num text-fg">
                  {usd(d.depth.maxStakeAtEdge)}
                </span>{' '}
                bên csgoempire · cần{' '}
                <span className="num text-fg">
                  {+d.depth.targetShares.toFixed(2)}
                </span>{' '}
                share cho tiền mục tiêu
                {d.fee?.enabled
                  ? ` · phí taker ${d.fee.rate}×p(1−p)`
                  : ' · market không thu phí'}
              </p>
              <Table>
                <THead>
                  <tr>
                    <TH numeric>Giá</TH>
                    <TH numeric>Share</TH>
                    <TH numeric>Tiền (gồm phí)</TH>
                    <TH numeric>Lãi ròng nếu mua</TH>
                    <TH numeric>Đã ăn</TH>
                  </tr>
                </THead>
                <tbody>
                  {d.depth.levels.map((l) => {
                    const took = d.levels?.find(
                      (x) => x.price === l.price,
                    )?.shares;
                    return (
                      <TR key={l.price} highlight={!!took}>
                        <TD numeric>{l.price.toFixed(3)}</TD>
                        <TD numeric>{+l.size.toFixed(2)}</TD>
                        <TD numeric>{usd(l.usd)}</TD>
                        <TD
                          numeric
                          className={cn(l.ok ? 'text-ok' : 'text-faint')}
                        >
                          {fmtMargin(l.netMargin)}
                        </TD>
                        <TD numeric>
                          {took ? (
                            +took.toFixed(2)
                          ) : (
                            <span className="text-faint">—</span>
                          )}
                        </TD>
                      </TR>
                    );
                  })}
                </tbody>
              </Table>
              {!d.depth.levels.length ? (
                <p className="text-caption text-faint">Sổ lệnh bán trống.</p>
              ) : null}
            </DrawerSection>
          ) : null}

          {t.book?.startsAt != null ||
          t.polymarket?.startsAt != null ||
          d.cancel?.detail ? (
            <DrawerSection title="Giờ bắt đầu">
              <StartTimeDetail
                legs={[t.book, t.polymarket].filter(
                  (l): l is NonNullable<typeof l> => !!l,
                )}
                detail={d.cancel?.detail ?? null}
              />
            </DrawerSection>
          ) : null}

          <DrawerSection title="Mốc thời gian">
            {tm ? (
              <KV
                items={[
                  [
                    'Kèo phát → trader nhận',
                    ms(tm.signalIssuedAt, tm.receivedAt),
                  ],
                  [
                    'Đọc sổ lệnh + phí',
                    tm.marketDataAt ? ms(tm.receivedAt, tm.marketDataAt) : '—',
                  ],
                  [
                    'Tính lệnh',
                    tm.marketDataAt
                      ? ms(tm.marketDataAt, tm.decidedAt)
                      : ms(tm.receivedAt, tm.decidedAt),
                  ],
                  [
                    'Tổng (phát → quyết định)',
                    ms(tm.signalIssuedAt, tm.decidedAt),
                  ],
                  ...(d.execution
                    ? ([
                        [
                          'Chuẩn bị lệnh thật (số dư, hạn mức, ký)',
                          msv(d.execution.prepareMs),
                        ],
                        ...(['csgoempire', 'polymarket'] as const).flatMap(
                          (v): [string, string][] => {
                            const prep = d.execution?.prepare?.[v];
                            return prep
                              ? [[`  · chuẩn bị ${v}`, prepText(prep)]]
                              : [];
                          },
                        ),
                        [
                          'Tuổi kèo lúc bắn Polymarket',
                          msv(d.execution.fireAgeMs),
                        ],
                        ['Polymarket phản hồi', msv(d.execution.polymarketMs)],
                        ['Polymarket → gửi BetBy', msv(d.execution.gapMs)],
                        [
                          'BetBy phản hồi',
                          d.execution.csgoempireMs === null
                            ? 'không gửi'
                            : msv(d.execution.csgoempireMs),
                        ],
                      ] as [string, string][])
                    : []),
                ]}
              />
            ) : (
              <p className="text-caption text-faint">
                Lệnh cũ, chưa ghi mốc thời gian.
              </p>
            )}
          </DrawerSection>

          <DrawerSection title="Dữ liệu gốc">
            <JsonBlock value={t} />
          </DrawerSection>
        </div>
      ) : null}
    </Panel>
  );
}
