'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, GitMerge } from 'lucide-react';
import { toast } from 'sonner';
import type { MatchCandidate, MatchDetail } from '@/lib/types';
import { matchHref } from '@/lib/match-links';
import { fmtDuration, fmtStamp } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useApi } from '@/hooks/use-api';
import { useIsMobile } from '@/hooks/use-media';
import { useGuard, useMutate } from '../shell/shell-context';
import { SportIcon, StartsAt } from '../domain';
import { Button } from '../ui/button';
import { Select } from '../ui/controls';
import { PageHeader } from '../ui/layout';
import { Confirm, Panel } from '../ui/panel';
import { Empty, ErrorState, SkeletonRows } from '../ui/states';
import { Meter } from '../ui/stats';
import { Tenant } from '../ui/tenant';
import { LiveStamp } from '../ui/values';
import { TenantSourceLinks } from '../matches/tenant-source-links';

const DISMISS_KEY = 'arbops-dismissed-candidates';
const cid = (c: MatchCandidate) => `${c.a.match}|${c.b.match}`;
const scoreTone = (s: number): 'ok' | 'accent' | 'warn' => (s >= 0.85 ? 'ok' : s >= 0.7 ? 'accent' : 'warn');

interface AliasSuggestion {
  alias: string;
  canonical: string;
  similarity: number;
  matches: number;
  conflict: boolean;
  example: string;
}

function uniqueSuggestions(candidates: MatchCandidate[]): AliasSuggestion[] {
  const byAlias = new Map<string, AliasSuggestion>();
  for (const candidate of candidates) {
    for (const item of candidate.aliases) {
      const old = byAlias.get(item.alias);
      if (old) {
        old.matches++;
        old.similarity = Math.max(old.similarity, item.similarity);
        if (old.canonical !== item.canonical) old.conflict = true;
      } else {
        byAlias.set(item.alias, {
          ...item,
          matches: 1,
          conflict: false,
          example: `${candidate.a.teams.join(' vs ')} · ${candidate.a.match.split(':')[0]}`,
        });
      }
    }
  }
  return [...byAlias.values()].sort((a, b) => b.similarity - a.similarity || a.alias.localeCompare(b.alias));
}

export function CandidatesPage() {
  const mobile = useIsMobile();
  const [sport, setSport] = useState('');
  const [minScore, setMinScore] = useState('0.5');
  const [selected, setSelected] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const aliasWriteReason = useGuard('team-aliases:write');
  const mutate = useMutate();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [resolvedAliases, setResolvedAliases] = useState<Set<string>>(new Set());
  const qs = new URLSearchParams({ minScore, limit: '50' });
  if (sport) qs.set('sport', sport);
  const { data, error, reload, updatedAt } = useApi<MatchCandidate[]>(`arbitrage/match-candidates?${qs}`, 15_000);

  useEffect(() => {
    try {
      setDismissed(new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]') as string[]));
    } catch {
      /* bỏ qua */
    }
  }, []);
  const dismiss = (c: MatchCandidate) => {
    const n = new Set(dismissed).add(cid(c));
    setDismissed(n);
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify([...n]));
    } catch {
      /* bỏ qua */
    }
    setSelected(null);
  };

  const list = useMemo(() => (data ?? [])
    .filter((c) => !dismissed.has(cid(c)))
    .map((c) => ({ ...c, aliases: c.aliases.filter((a) => !resolvedAliases.has(a.alias)) }))
    .filter((c) => c.aliases.length > 0), [data, dismissed, resolvedAliases]);
  const suggestions = useMemo(() => uniqueSuggestions(list), [list]);
  const eligible = suggestions.filter((s) => !s.conflict);
  const selectedSuggestions = eligible.filter((s) => picked.has(s.alias));
  const createBulk = async () => {
    if (!selectedSuggestions.length) return;
    setBulkBusy(true);
    const result = await mutate<{
      created: { alias: string }[];
      unchanged: string[];
      failed: { alias: string; reason: string }[];
    }>('team-aliases/bulk', {
      method: 'POST',
      body: { aliases: selectedSuggestions.map(({ alias, canonical }) => ({ alias, canonical })) },
    });
    setBulkBusy(false);
    if (!result) return;
    setResolvedAliases((previous) => new Set([...previous, ...result.created.map((item) => item.alias), ...result.unchanged]));
    if (result.failed.length) {
      toast.error(`Đã tạo ${result.created.length}, lỗi ${result.failed.length} bí danh`, {
        description: result.failed.slice(0, 3).map((f) => `${f.alias}: ${f.reason}`).join('; '),
      });
      setPicked(new Set(result.failed.map((f) => f.alias)));
    } else {
      toast.success(`Đã tạo ${result.created.length} bí danh${result.unchanged.length ? ` · ${result.unchanged.length} đã có` : ''}`);
      setPicked(new Set());
      setBulkOpen(false);
    }
    void reload();
  };
  const aliasDone = (alias: string) => {
    setResolvedAliases((previous) => new Set(previous).add(alias));
    setSelected(null);
    void reload();
  };
  const current = list.find((c) => cid(c) === selected) ?? (mobile ? null : list[0]) ?? null;

  return (
    <div>
      <PageHeader
        title="Ghép trượt"
        description="Cặp trận có thể là một nhưng không ghép được vì tên đội lệch giữa các tenant. Có thể tạo từng bí danh hoặc chọn nhiều bí danh để tạo cùng lúc; ẩn cặp chỉ có hiệu lực trên trình duyệt này."
        meta={<LiveStamp at={updatedAt} staleAfter={30_000} />}
        actions={
          <>
            <Button variant="primary" size="sm" disabled={!eligible.length} disabledReason={aliasWriteReason} onClick={() => setBulkOpen(true)}>
              Tạo bí danh hàng loạt
            </Button>
            <Select value={sport} onChange={(e) => setSport(e.target.value)} className="w-32" aria-label="Môn">
              <option value="">Mọi môn</option>
              <option value="cs2">CS2</option>
              <option value="lol">LoL</option>
              <option value="dota2">Dota 2</option>
              <option value="valorant">Valorant</option>
            </Select>
            <Select value={minScore} onChange={(e) => setMinScore(e.target.value)} className="w-36" aria-label="Điểm tối thiểu">
              {['0.5', '0.6', '0.7', '0.8', '0.9'].map((v) => (
                <option key={v} value={v}>
                  Điểm ≥ {v}
                </option>
              ))}
            </Select>
          </>
        }
      />

      <Confirm
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        title="Tạo bí danh hàng loạt?"
        description={`Chọn các bí danh cần áp dụng từ ${list.length} cặp đang hiển thị. Mỗi tên chỉ được tạo một lần.`}
        confirmLabel={`Tạo ${selectedSuggestions.length} bí danh`}
        confirmDisabled={!selectedSuggestions.length}
        loading={bulkBusy}
        onConfirm={() => void createBulk()}
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-caption">
          <span className="text-muted-fg">{selectedSuggestions.length}/{eligible.length} đã chọn</span>
          <span className="flex flex-wrap justify-end gap-1">
            <Button variant="ghost" size="sm" onClick={() => setPicked(new Set(eligible.filter((s) => s.similarity >= 0.85).map((s) => s.alias)))}>Chọn ≥ 0.85</Button>
            <Button variant="ghost" size="sm" onClick={() => setPicked(new Set(eligible.map((s) => s.alias)))}>Chọn tất cả</Button>
            <Button variant="ghost" size="sm" onClick={() => setPicked(new Set())}>Bỏ chọn</Button>
          </span>
        </div>
        <div className="max-h-[45vh] overflow-y-auto border-y border-line">
          {suggestions.map((s) => (
            <label key={s.alias} className="flex items-start gap-3 border-b border-line py-2.5 last:border-0">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
                disabled={s.conflict || bulkBusy}
                checked={!s.conflict && picked.has(s.alias)}
                onChange={(e) => setPicked((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(s.alias);
                  else next.delete(s.alias);
                  return next;
                })}
              />
              <span className="min-w-0 text-body">
                <span className="num break-all text-fg">{s.alias} → {s.canonical}</span>
                <span className="block text-caption text-muted-fg">
                  {s.conflict ? 'Tên này có nhiều tên chuẩn khác nhau; xử lý riêng' : `Giống ${s.similarity.toFixed(2)} · ${s.matches} cặp đề xuất`}
                </span>
                <span className="block truncate text-caption text-faint">Ví dụ: {s.example}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-3 text-caption text-muted-fg">Các tên đã chọn sẽ được lưu vào database và hệ thống ghép lại các trận đang chạy. Hãy kiểm tra kỹ trước khi tạo.</p>
      </Confirm>

      {error && !data ? <ErrorState message={error} onRetry={reload} /> : null}
      {!data && !error ? <SkeletonRows rows={4} cols={[30, 10]} /> : null}
      {data && !list.length ? (
        <Empty icon={GitMerge}>Không có cặp nào nghi ghép trượt với điểm ≥ {minScore}. Mọi trận đã ghép đúng.</Empty>
      ) : null}

      {list.length ? (
        <div className="grid gap-10 md:grid-cols-[260px_minmax(0,1fr)] lg:grid-cols-[300px_minmax(0,1fr)]">
          {/* rail */}
          <ul className="md:border-r md:border-line md:pr-6">
            {list.map((c) => {
              const on = current && cid(c) === cid(current);
              return (
                <li key={cid(c)}>
                  <button
                    type="button"
                    onClick={() => setSelected(cid(c))}
                    className={cn(
                      'flex w-full items-center gap-3 border-b border-line py-3 text-left last:border-0 md:rounded-[6px] md:border-0 md:px-3 md:py-2.5',
                      on ? 'md:bg-accent-soft' : 'md:hover:bg-hover/60',
                    )}
                  >
                    <SportIcon sport={c.a.match.split(':')[0]!} />
                    <span className="min-w-0 flex-1">
                      <span className={cn('block truncate text-body', on ? 'text-accent-text md:font-medium' : 'text-fg')}>
                        {c.aliases.map((a) => `${a.alias} → ${a.canonical}`).join(', ')}
                      </span>
                      <span className="block truncate text-caption text-muted-fg">
                        {c.a.teams.join(' vs ')}
                      </span>
                    </span>
                    <span className="num text-body text-fg">{c.score.toFixed(2)}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          {/* chi tiết */}
          {!mobile && current ? <CandidateView c={current} onDismiss={() => dismiss(current)} onDone={aliasDone} /> : null}
        </div>
      ) : null}

      {mobile ? (
        <Panel open={!!selected && !!current} onOpenChange={(v) => !v && setSelected(null)} title="Cặp nghi ghép trượt">
          {current ? <CandidateView c={current} onDismiss={() => dismiss(current)} onDone={aliasDone} /> : null}
        </Panel>
      ) : null}
    </div>
  );
}

function CandidateView({ c, onDismiss, onDone }: { c: MatchCandidate; onDismiss: () => void; onDone: (alias: string) => void }) {
  const mobile = useIsMobile();
  return (
    <div className="min-w-0 animate-fade-in">
      <div className="mb-8 flex flex-wrap items-end gap-x-10 gap-y-4">
        <div className="w-full max-w-xs">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-caption text-muted-fg">Điểm giống nhau</span>
            <span className="num text-[22px] font-medium text-fg">{c.score.toFixed(2)}</span>
          </div>
          <Meter value={c.score} tone={scoreTone(c.score)} label="Điểm giống nhau" />
        </div>
        <div>
          <div className="text-caption text-muted-fg">Lệch giờ bắt đầu</div>
          <div className="num mt-1 text-[15px] text-fg">{c.startsDiffMs ? fmtDuration(c.startsDiffMs) : 'trùng giờ'}</div>
        </div>
      </div>

      {/* A | B */}
      <div className={cn('grid', mobile ? 'gap-6' : 'grid-cols-[1fr_auto_1fr] gap-8')}>
        <Side key={c.a.match} label="A" side={c.a} />
        {!mobile ? <div className="w-px bg-line" /> : <div className="h-px bg-line" />}
        <Side key={c.b.match} label="B" side={c.b} />
      </div>

      {/* nối tên đội */}
      <div className="mt-10">
        <div className="mb-3 text-caption text-muted-fg">Ghép tên đội</div>
        {c.pairs.map(([a, b], i) => {
          const sim = a === b ? 1 : c.aliases.find((x) => (x.alias === b && x.canonical === a) || (x.alias === a && x.canonical === b))?.similarity ?? 0;
          const exact = a === b;
          return (
            <div key={i} className="grid h-12 grid-cols-[minmax(0,1fr)_minmax(80px,180px)_minmax(0,1fr)] items-center gap-3">
              <span className="truncate text-right text-[15px] font-medium text-fg">{a}</span>
              <span className="relative flex items-center justify-center">
                <svg viewBox="0 0 100 8" preserveAspectRatio="none" className="absolute inset-x-0 top-1/2 h-2 w-full -translate-y-1/2" aria-hidden>
                  <line x1="0" y1="4" x2="100" y2="4" stroke={exact ? 'var(--line-strong)' : 'var(--accent)'} strokeWidth="1" strokeDasharray={exact ? undefined : '3 3'} vectorEffect="non-scaling-stroke" />
                  <circle cx="1" cy="4" r="1.6" fill={exact ? 'var(--fg-faint)' : 'var(--accent)'} />
                  <circle cx="99" cy="4" r="1.6" fill={exact ? 'var(--fg-faint)' : 'var(--accent)'} />
                </svg>
                <span className={cn('num relative bg-bg px-2 text-caption md:bg-bg', exact ? 'text-faint' : 'text-accent-text')}>{exact ? 'khớp' : sim.toFixed(2)}</span>
              </span>
              <span className="truncate text-[15px] font-medium text-fg">{b}</span>
            </div>
          );
        })}
      </div>

      {/* bí danh đề xuất */}
      <div className="mt-10">
        <div className="mb-1 text-caption text-muted-fg">Bí danh đề xuất</div>
        {c.aliases.map((a) => (
          <AliasRow key={a.alias} c={c} a={a} onDone={onDone} />
        ))}
        <div className="mt-4 flex justify-end">
          <Button variant="ghost" onClick={onDismiss}>
            Ẩn trên máy này
          </Button>
        </div>
      </div>
    </div>
  );
}

function Side({ label, side }: { label: string; side: MatchCandidate['a'] }) {
  const { data, error, reload } = useApi<MatchDetail>(`arbitrage/matches/${encodeURIComponent(side.match)}`, 15_000);
  return (
    <div className="min-w-0">
      <div className="mb-3 flex items-center gap-3">
        <span className="num text-caption text-faint">{label}</span>
        {side.tenants.map((t) => (
          <Tenant key={t} tenant={t} />
        ))}
      </div>
      <Link href={matchHref(side.match)} className="block text-[18px] font-semibold text-fg hover:text-accent-text hover:underline [overflow-wrap:anywhere]">
        {side.teams[0]} <span className="font-normal text-faint">vs</span> {side.teams[1]}
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <StartsAt at={side.startsAt} />
        <span className="num text-caption text-faint">{fmtStamp(side.startsAt)}</span>
      </div>
      <Link href={matchHref(side.match)} className="num mt-2 flex min-h-8 min-w-0 items-center gap-2 text-caption text-accent-text hover:underline">
        <span className="break-all">{side.match}</span> <ArrowRight className="size-3 shrink-0" />
      </Link>
      <div className="mt-2">
        {data ? <TenantSourceLinks markets={data.markets} tenants={side.tenants} /> : error ? <ErrorState message={error} onRetry={reload} /> : <span className="text-caption text-faint">Đang tải nguồn trận…</span>}
      </div>
    </div>
  );
}

function AliasRow({ c, a, onDone }: { c: MatchCandidate; a: MatchCandidate['aliases'][number]; onDone: (alias: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const reason = useGuard('team-aliases:write');
  const mutate = useMutate();
  const from = c.a.teams.includes(a.alias) ? c.a : c.b;
  const to = from === c.a ? c.b : c.a;
  const renamed = `${from.match.split(':')[0]}:${from.teams.map((team) => team === a.alias ? a.canonical : team).sort().join('~')}`;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-line py-4 last:border-0">
      <span className="flex min-w-0 flex-1 items-center gap-3 text-[15px]">
        <span className="num text-fg">{a.alias}</span>
        <ArrowRight className="size-4 shrink-0 text-faint" />
        <span className="num font-medium text-fg">{a.canonical}</span>
        <span className="num text-caption text-faint">giống {a.similarity.toFixed(2)}</span>
      </span>
      <Button variant="primary" onClick={() => setOpen(true)} disabledReason={reason}>
        Tạo bí danh
      </Button>
      <Confirm
        open={open}
        onOpenChange={setOpen}
        title="Tạo bí danh đội?"
        description="Bí danh áp dụng cho mọi trận có tên đội này. Cặp còn tên đội khác chưa khớp sẽ tiếp tục hiển thị."
        confirmLabel="Tạo bí danh"
        loading={busy}
        onConfirm={async () => {
          setBusy(true);
          const r = await mutate('team-aliases', { method: 'POST', body: { alias: a.alias, canonical: a.canonical } }, `Đã tạo bí danh ${a.alias} → ${a.canonical}`);
          setBusy(false);
          if (r) {
            setOpen(false);
            onDone(a.alias);
          }
        }}
      >
        <div className="flex flex-col gap-3 text-body">
          <div className="flex items-center gap-3">
            <span className="num text-fg">{a.alias}</span>
            <ArrowRight className="size-4 text-faint" />
            <span className="num font-medium text-fg">{a.canonical}</span>
          </div>
          <div className="border-t border-line pt-3 text-caption text-muted-fg">
            Ảnh hưởng: <span className="num text-fg">{from.match}</span> ({from.tenants.join(', ')}) sẽ thành <span className="num text-fg">{renamed}</span> và ghép với{' '}
            <span className="num text-fg">{to.match}</span> ({to.tenants.join(', ')}), nếu đội còn lại cũng khớp. Tổ hợp còn phụ thuộc market, giờ bắt đầu và trạng thái odds; kèo chỉ được phát khi đạt ngưỡng và kênh được bật.
          </div>
        </div>
      </Confirm>
    </div>
  );
}
