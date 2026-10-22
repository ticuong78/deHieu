'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, Scale } from 'lucide-react';
import { toast } from 'sonner';
import type {
  RebalanceMode,
  RebalanceSettings,
  RebalanceSuggestion,
  RebalanceTransfer,
  RebalanceTransfersView,
  RebalanceView,
  TradingSettings,
  TransferState,
} from '@/lib/trading-types';
import { useApi } from '@/hooks/use-api';
import { useGuard, useMutate } from '../shell/shell-context';
import { Button } from '../ui/button';
import { Field, Segmented } from '../ui/controls';
import { Section } from '../ui/layout';
import { Empty } from '../ui/states';
import { Pill, type Tone } from '../ui/status';
import { Table, TD, TH, THead, TR } from '../ui/table';
import { NumInput } from './stake-plan-editor';

const usd = (n: number) => `${n.toFixed(2)}$`;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const VENUE: Record<string, string> = { csgoempire: 'csgoempire', polymarket: 'Polymarket' };
const time = (ms: number) =>
  new Date(ms).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

/**
 * Đề xuất cân bằng tiền: lệnh thật bị hủy vì một bên thiếu Cash → app tính cần chuyển bao nhiêu giữa hai
 * tài khoản của profile để về tỉ lệ csgoempire / Polymarket (mặc định 35/65). Bật "Tự chuyển tiền" thì app tự chuyển (RebalanceExecutor); không thì
 * người chuyển tay rồi bấm "Đã chuyển xong". Chỉ hiện khi có đề xuất.
 */
export function RebalancePanel() {
  const { data, reload } = useApi<RebalanceView>('trading/rebalance', 15_000);
  const transfers = useApi<RebalanceTransfersView>('trading/rebalance/transfers', 15_000);
  const blocked = transfers.data?.blocked ?? {};
  if (!data?.suggestions.length && !Object.keys(blocked).length) return null;
  const ratio = `${pct((data?.empireShare ?? 0.35))} / ${pct(1 - (data?.empireShare ?? 0.35))}`;
  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Scale className="size-4 text-warn" aria-hidden /> Cân bằng tiền
        </span>
      }
      description={`Lệnh thật bị hủy vì hết tiền ở một bên. Tỉ lệ mục tiêu csgoempire / Polymarket = ${ratio}, tính trên số dư rảnh (chưa gồm tiền đang nằm trong lệnh chưa có kết quả). Bật "Tự chuyển tiền" ở Giới hạn chung thì app tự chuyển trong hạn mức; không thì chuyển tay rồi bấm "Đã chuyển xong".`}
    >
      <div className="flex flex-col gap-3">
        {Object.entries(blocked).map(([profileId, reason]) => (
          <BlockedCard
            key={profileId}
            profileId={profileId}
            name={transfers.data?.transfers.find((t) => t.profileId === profileId)?.profileName ?? profileId}
            reason={reason}
            onDone={() => void transfers.reload()}
          />
        ))}
        {data?.suggestions.map((s) => (
          <SuggestionCard
            key={s.profileId}
            s={s}
            active={transfers.data?.transfers.find(
              (t) => t.profileId === s.profileId && ACTIVE.includes(t.state),
            )}
            onDone={() => {
              void reload();
              void transfers.reload();
            }}
          />
        ))}
      </div>
    </Section>
  );
}

/** Lượt chuyển đang chạy (chưa có kết quả cuối). */
const ACTIVE: TransferState[] = ['planned', 'submitted', 'sent'];
const txHash = (ref: string | null) => ref?.match(/0x[0-9a-fA-F]{64}/)?.[0] ?? null;

function SuggestionCard({ s, active, onDone }: { s: RebalanceSuggestion; active?: RebalanceTransfer; onDone: () => void }) {
  const manage = useGuard('trading:manage');
  const mutate = useMutate();
  const [busy, setBusy] = useState(false);
  const p = s.plan;
  const [running, setRunning] = useState(false);
  const execute = async () => {
    setRunning(true);
    const r = await mutate<RebalanceTransfer | { started: true }>(
      `trading/rebalance/${encodeURIComponent(s.profileId)}/execute`,
      { method: 'POST' },
    );
    setRunning(false);
    if (r && 'state' in r) toastTransfer(r);
    onDone();
  };
  const done = async () => {
    setBusy(true);
    const r = await mutate(`trading/rebalance/${encodeURIComponent(s.profileId)}/done`, { method: 'POST' }, `Đã đóng đề xuất của ${s.profileName}`);
    setBusy(false);
    if (r !== null) onDone();
  };
  return (
    <div className="rounded-lg border border-line bg-raised p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">{s.profileName}</span>
        <Pill tone="warn">{s.triggers} lệnh hủy vì thiếu tiền</Pill>
        <span className="text-caption text-muted-fg">
          gần nhất {time(s.updatedAt)} · {s.teams[0]} vs {s.teams[1]}
        </span>
      </div>
      {p ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-body">
          <span className="text-muted-fg">Chuyển</span>
          <span className="num font-semibold text-fg">{usd(p.amountUsd)}</span>
          <span className="text-fg">{VENUE[p.from]}</span>
          <ArrowRight className="size-4 text-muted-fg" aria-hidden />
          <span className="text-fg">{VENUE[p.to]}</span>
        </div>
      ) : (
        <p className="mb-2 text-body text-warn">
          {s.verdict === 'insufficient'
            ? `Tổng hai tài khoản ${usd(s.balances.csgoempire + s.balances.polymarket)} không đủ cho một lệnh nhỏ nhất${s.needUsd ? ` (cần ${usd(s.needUsd)})` : ''} — chuyển qua lại vô ích, cần nạp thêm.`
            : s.verdict === 'none'
              ? 'Chuyển qua lại không vào thêm được lệnh nào — không chuyển. Nạp thêm nếu muốn vào nhiều hơn.'
              : 'Hai tài khoản đã đúng tỉ lệ — tổng tiền không đủ cho lệnh.'}
        </p>
      )}
      <div className="num mb-2 grid grid-cols-1 gap-1 text-caption text-muted-fg sm:grid-cols-2">
        <span>
          csgoempire: {usd(s.balances.csgoempire)}
          {p ? ` → ${usd(p.target.csgoempire)}` : ''}
        </span>
        <span>
          Polymarket: {usd(s.balances.polymarket)}
          {p ? ` → ${usd(p.target.polymarket)}` : ''}
        </span>
      </div>
      {s.shortages.length ? (
        <p className="mb-2 text-caption text-muted-fg">
          Thiếu: {s.shortages.map((x) => `${VENUE[x.venue]} có ${usd(x.available)}, lệnh cần ${usd(x.required)}`).join('; ')}
        </p>
      ) : null}
      {p && !s.helpsShortage ? (
        <p className="mb-2 text-caption text-warn">Chuyển theo tỉ lệ không bù được bên đang thiếu: cần nạp thêm hoặc giảm tiền theo hạng.</p>
      ) : null}
      {active ? (
        <p className="mb-2 flex flex-wrap items-center gap-2 text-caption text-muted-fg">
          <Pill tone="info">{STATE[active.state].label}</Pill>
          Đang chuyển {usd(active.amountUsd)} {active.from ? VENUE[active.from] : ''} → {active.to ? VENUE[active.to] : ''} (bắt đầu {time(active.createdAt)}). Đề xuất tự đóng khi tiền tới nơi.
          {txHash(active.ref) ? (
            <a
              className="text-accent-text hover:underline"
              href={`https://polygonscan.com/tx/${txHash(active.ref)}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              Xem trên Polygonscan
            </a>
          ) : null}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {p ? (
          <Button
            size="sm"
            variant="primary"
            loading={running || !!active}
            disabledReason={active ? 'Đang có lượt chuyển cho profile này' : manage}
            onClick={execute}
          >
            {active ? 'Đang chuyển…' : 'Chuyển ngay'}
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" loading={busy} disabledReason={manage} onClick={done}>
          Đã chuyển xong
        </Button>
      </div>
    </div>
  );
}

const STATE: Record<TransferState, { label: string; tone: Tone }> = {
  dry_run: { label: 'Chạy thử', tone: 'info' },
  skipped: { label: 'Bỏ qua', tone: 'muted' },
  planned: { label: 'Chuẩn bị', tone: 'info' },
  submitted: { label: 'Đã gửi', tone: 'info' },
  sent: { label: 'Đang về', tone: 'info' },
  completed: { label: 'Xong', tone: 'ok' },
  failed: { label: 'Lỗi', tone: 'warn' },
  unconfirmed: { label: 'Chưa xác nhận', tone: 'critical' },
  unknown: { label: 'Không rõ', tone: 'critical' },
};

function toastTransfer(t: RebalanceTransfer) {
  // kết quả hiện ngay ở bảng lịch sử; ở đây chỉ cần đọc lý do khi bị bỏ qua
  if (t.state === 'skipped' || t.state === 'dry_run' || t.state === 'failed')
    toast(STATE[t.state].label, { description: t.reason ?? undefined });
}

function BlockedCard({ profileId, name, reason, onDone }: { profileId: string; name: string; reason: string; onDone: () => void }) {
  const manage = useGuard('trading:manage');
  const mutate = useMutate();
  const [busy, setBusy] = useState(false);
  return (
    <div className="rounded-lg border border-line bg-raised p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">{name}</span>
        <Pill tone="critical">Tự chuyển tiền đang bị chặn</Pill>
      </div>
      <p className="mb-2 text-caption text-muted-fg">{reason}</p>
      <p className="mb-2 text-caption text-muted-fg">
        Kiểm tra số dư hai sàn và giao dịch trên Polygonscan (mã ở bảng lịch sử bên dưới). Tiền đã tới nơi hoặc đã xử lý xong thì gỡ chặn.
      </p>
      <Button
        size="sm"
        variant="secondary"
        loading={busy}
        disabledReason={manage}
        onClick={async () => {
          setBusy(true);
          const r = await mutate(`trading/rebalance/${encodeURIComponent(profileId)}/unblock`, { method: 'POST' }, `Đã gỡ chặn ${name}`);
          setBusy(false);
          if (r !== null) onDone();
        }}
      >
        Đã kiểm tra — gỡ chặn
      </Button>
    </div>
  );
}

const MODES: { value: RebalanceMode; label: string }[] = [
  { value: 'off', label: 'Tắt' },
  { value: 'dry_run', label: 'Chạy thử' },
  { value: 'live', label: 'Chuyển thật' },
];

/** Cấu hình tự chuyển tiền + lịch sử các lượt (tab Giới hạn chung). */
export function RebalanceSettingsSection({ settings, onSaved }: { settings: TradingSettings | null; onSaved: () => void }) {
  const manage = useGuard('trading:manage');
  const mutate = useMutate();
  const [form, setForm] = useState<RebalanceSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const transfers = useApi<RebalanceTransfersView>('trading/rebalance/transfers', 15_000);
  useEffect(() => {
    if (settings?.rebalance) setForm(settings.rebalance);
  }, [settings]);
  if (!settings || !settings.rebalance || !form) return null;
  const cur = settings.rebalance;
  const dirty = JSON.stringify(cur) !== JSON.stringify(form);
  const set = (p: Partial<RebalanceSettings>) => setForm({ ...form, ...p });
  return (
    <Section
      title="Tự chuyển tiền (cân bằng 35/65)"
      description="Lệnh thật bị hủy vì hết tiền → app đọc số dư mới của hai tài khoản trong profile và chuyển phần chênh về tỉ lệ csgoempire 35% / Polymarket 65%. Polymarket → csgoempire: đổi tiền giao dịch ra USDT (Polygon) gửi tới địa chỉ nạp csgoempire. csgoempire → Polymarket: rút USDT (Polygon) về địa chỉ nạp Polymarket. Chỉ gửi tới địa chỉ nạp đã lưu trong từng tài khoản."
    >
      <div className="flex max-w-xl flex-col gap-4">
        <Field
          label="Chế độ"
          help={
            form.mode === 'off'
              ? 'Tắt: chỉ đề xuất, chuyển tay.'
              : form.mode === 'dry_run'
                ? 'Chạy thử: tính và ghi "sẽ chuyển X$" vào lịch sử, KHÔNG gửi tiền. Chạy vài lần thấy đúng rồi mới chuyển thật.'
                : 'Chuyển thật: tự gửi tiền trong hạn mức. Kết quả không rõ → tự dừng cho profile đó và báo sự cố, chờ người gỡ.'
          }
        >
          <Segmented<RebalanceMode> value={form.mode} onChange={(mode) => set({ mode })} options={MODES} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Tối đa mỗi lần ($)" htmlFor="rb-per">
            <NumInput id="rb-per" value={form.maxPerTransferUsd} onValue={(v) => v !== undefined && set({ maxPerTransferUsd: v })} />
          </Field>
          <Field label="Tối đa mỗi ngày ($)" htmlFor="rb-day" help="Mỗi profile, theo ngày UTC.">
            <NumInput id="rb-day" value={form.maxPerDayUsd} onValue={(v) => v !== undefined && set({ maxPerDayUsd: v })} />
          </Field>
          <Field label="Tối thiểu ($)" htmlFor="rb-min" help="Lệch ít hơn thì không chuyển.">
            <NumInput id="rb-min" value={form.minTransferUsd} onValue={(v) => v !== undefined && set({ minTransferUsd: v })} />
          </Field>
        </div>
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={!dirty}
            loading={busy}
            disabledReason={manage}
            onClick={async () => {
              setBusy(true);
              const r = await mutate(
                'trading/settings',
                { method: 'PUT', body: { matchExposureCapUsd: settings.matchExposureCapUsd, rebalance: form } },
                'Đã lưu tự chuyển tiền',
              );
              setBusy(false);
              if (r !== null) onSaved();
            }}
          >
            Lưu
          </Button>
          {dirty ? (
            <Button variant="ghost" onClick={() => setForm(cur)}>
              Hoàn tác
            </Button>
          ) : null}
        </div>
      </div>
      <h3 className="mb-2 mt-8 text-body font-semibold text-fg">Lịch sử chuyển</h3>
      {!transfers.data?.transfers.length ? (
        <Empty icon={Scale}>Chưa có lượt chuyển nào.</Empty>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Lúc</TH>
              <TH>Profile</TH>
              <TH>Chiều</TH>
              <TH numeric>Số tiền</TH>
              <TH>Trạng thái</TH>
              <TH>Chi tiết</TH>
            </tr>
          </THead>
          <tbody>
            {transfers.data.transfers.map((t) => (
              <TR key={t.id}>
                <TD className="num text-caption text-muted-fg">{time(t.createdAt)}</TD>
                <TD className="text-muted-fg">
                  {t.profileName}
                  <span className="block text-caption text-faint">{t.trigger === 'manual' ? 'bấm tay' : 'tự động'}</span>
                </TD>
                <TD className="text-caption">{t.from && t.to ? `${VENUE[t.from]} → ${VENUE[t.to]}` : '—'}</TD>
                <TD numeric className="num">{t.amountUsd > 0 ? usd(t.amountUsd) : '—'}</TD>
                <TD>
                  <Pill tone={STATE[t.state].tone}>{STATE[t.state].label}</Pill>
                </TD>
                <TD className="max-w-md text-caption text-muted-fg">
                  {t.reason ?? ''}
                  {t.ref ? <span className="num block break-all text-faint">{t.ref}</span> : null}
                </TD>
              </TR>
            ))}
          </tbody>
        </Table>
      )}
    </Section>
  );
}
