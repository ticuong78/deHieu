'use client';

import { useEffect, useState } from 'react';
import { Info, Layers } from 'lucide-react';
import { api } from '@/lib/api';
import type { StakePlan, StakePreview, StakeTrend, TierStakeOverride } from '@/lib/trading-types';
import { cn } from '@/lib/utils';
import { Field, Input, Segmented, Switch } from '../ui/controls';
import { Empty } from '../ui/states';
import { Table, TD, TH, THead, TR } from '../ui/table';
import { Hint } from '../ui/tooltip';
import { tierRange } from '../consumers/notify-channels';

const TREND_LABEL: Record<StakeTrend, string> = { flat: 'Ngang', up: 'Tăng dần', down: 'Giảm dần', custom: 'Tùy chỉnh' };
const TREND_HELP: Record<StakeTrend, string> = {
  flat: 'Mọi hạng cùng một số tiền.',
  up: 'Hạng cao hơn (margin lớn hơn) vào nhiều tiền hơn: mỗi hạng × (1 + bước).',
  down: 'Hạng cao hơn vào ít tiền hơn: mỗi hạng ÷ (1 + bước).',
  custom: 'Tự nhập tiền cho từng hạng trong bảng bên dưới; hạng để trống = không vào lệnh.',
};

const money = (n: number) => `${+n.toFixed(2)}$`;

/** Profile có vào hạng này không (null = mọi hạng). */
const tierSelected = (plan: StakePlan, tierId: string) => plan.tierIds == null || plan.tierIds.includes(tierId);

function TierCheck({ label, checked, indeterminate, onChange }: { label: string; checked: boolean; indeterminate?: boolean; onChange: (v: boolean) => void }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      title={label}
      className="size-4 cursor-pointer accent-[var(--accent)]"
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = !!indeterminate;
      }}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

/** Số trong ô nhập: rỗng = undefined (dùng giá trị tự tính). */
const parseNum = (s: string): number | undefined => {
  if (!s.trim()) return undefined;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/**
 * Kế hoạch vốn theo hạng kèo (dùng chung hạng với kênh thông báo): xu hướng giữa các hạng
 * + mức tối thiểu/tối đa, xem trước bảng tiền do backend tính (cùng công thức worker dùng).
 */
export function StakePlanEditor({
  value,
  onChange,
  defaultEntries,
  defaultDaily = 0,
}: {
  value: StakePlan;
  onChange: (p: StakePlan) => void;
  /** Số lệnh mỗi cửa mặc định của profile (ô trống ở cột Số lệnh = dùng số này). */
  defaultEntries: number;
  /** Lãi tối thiểu mỗi ngày mặc định của profile (tỉ lệ; ô trống ở cột Lãi/ngày = dùng số này). */
  defaultDaily?: number;
}) {
  const [preview, setPreview] = useState<StakePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<StakePlan>) => onChange({ ...value, ...p });
  const setOverride = (tierId: string, o: TierStakeOverride) => {
    const next = { ...value.overrides[tierId], ...o };
    const clean = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined)) as TierStakeOverride;
    const overrides = { ...value.overrides };
    if (Object.keys(clean).length) overrides[tierId] = clean;
    else delete overrides[tierId];
    onChange({ ...value, overrides });
  };

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api<StakePreview>('trading/stake-preview', { method: 'POST', body: JSON.stringify(value) })
        .then((p) => {
          if (!alive) return;
          setPreview(p);
          setError(null);
        })
        .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [value]);

  const custom = value.trend === 'custom';
  const rows = preview?.rows ?? [];
  const selectedCount = rows.filter((r) => tierSelected(value, r.tierId)).length;
  // profile cũ (null = mọi hạng): bấm bỏ một hạng → chuyển sang danh sách cụ thể
  const toggleTier = (tierId: string, on: boolean) => {
    const cur = value.tierIds ?? rows.map((r) => r.tierId);
    set({ tierIds: on ? [...new Set([...cur, tierId])] : cur.filter((t) => t !== tierId) });
  };
  return (
    <div className="flex flex-col gap-6">
      <Field label="Xu hướng tiền giữa các hạng" help={TREND_HELP[value.trend]}>
        <Segmented<StakeTrend>
          value={value.trend}
          onChange={(trend) => set({ trend })}
          options={(Object.keys(TREND_LABEL) as StakeTrend[]).map((t) => ({ value: t, label: TREND_LABEL[t] }))}
        />
      </Field>
      {!custom ? (
        <div className="grid grid-cols-2 gap-4">
          <Field label="Tiền hạng thấp nhất ($)" htmlFor="sp-base" help="Tính trên chân csgoempire.">
            <NumInput id="sp-base" value={value.baseStake} onValue={(v) => set({ baseStake: v ?? 0 })} />
          </Field>
          {value.trend !== 'flat' ? (
            <Field label="Bước mỗi hạng (%)" htmlFor="sp-step" help="50 = ×1.5 mỗi hạng.">
              <NumInput id="sp-step" value={+(value.stepPct * 100).toFixed(4)} onValue={(v) => set({ stepPct: (v ?? 0) / 100 })} />
            </Field>
          ) : null}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Tối thiểu (% tiền hạng)"
          htmlFor="sp-min"
          help="Sổ lệnh Polymarket mỏng → worker vào nhỏ lại; nhỏ hơn mức này thì bỏ qua. 0 = vào được bao nhiêu cũng vào."
        >
          <NumInput id="sp-min" value={+(value.minStakeRatio * 100).toFixed(4)} onValue={(v) => set({ minStakeRatio: Math.min(1, (v ?? 0) / 100) })} />
        </Field>
        <Field label="Tối đa (× tiền hạng)" htmlFor="sp-max" help="Chỉ dùng khi bật Tăng dần trong hạng. ×1 = không tăng.">
          <NumInput id="sp-max" value={value.maxStakeRatio} onValue={(v) => set({ maxStakeRatio: Math.max(1, v ?? 1) })} />
        </Field>
      </div>
      <Field
        label="Tăng dần trong hạng"
        htmlFor="sp-scale"
        help="Bật: trong CÙNG một hạng, kèo margin cao hơn vào nhiều tiền hơn. Cận dưới → Tiền mục tiêu, cận trên → Tối đa, ở giữa tăng đều theo margin (tuyến tính, không theo bậc). Ví dụ hạng 1,5–3%, mục tiêu 50$, tối đa 100$: 1,5% → 50$, 2% → 66,67$, 2,5% → 83,33$, tức +3,33$ mỗi 0,1% margin. Tối thiểu giữ nguyên. Hạng không có cận trên luôn dùng Tiền mục tiêu. Khác với Bước mỗi hạng (chênh lệch GIỮA các hạng)."
      >
        <Switch id="sp-scale" checked={value.scaleWithinTier} onCheckedChange={(scaleWithinTier) => set({ scaleWithinTier })} label="Tăng dần trong hạng" />
      </Field>
      {value.scaleWithinTier && value.maxStakeRatio <= 1 && !Object.values(value.overrides).some((o) => o.maxStake !== undefined) ? (
        <p className="-mt-3 text-caption text-warn">Tối đa đang là ×1 nên bật Tăng dần trong hạng chưa có tác dụng: đặt Tối đa lớn hơn 1 (vd 2).</p>
      ) : null}

      <div>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <span className="text-body font-medium text-fg">Bảng tiền theo hạng</span>
          <span className="text-caption text-faint">ô trống = tự tính</span>
        </div>
        <p className="mb-3 text-caption text-muted-fg">
          Mọi số trong bảng là <span className="text-fg">USD cược bên csgoempire</span> cho một kèo, không phải số share. Số share Polymarket worker tự tính = tiền × odds csgoempire.
        </p>
        {error ? <p className="mb-2 text-caption text-critical">{error}</p> : null}
        {preview && !preview.rows.length ? (
          <Empty icon={Layers}>Chưa có hạng kèo. Thêm hạng ở trang Consumer → Hạng kèo; trader chỉ vào lệnh với kèo thuộc một hạng.</Empty>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH className="w-10">
                  <TierCheck
                    label="Chọn mọi hạng"
                    checked={rows.length > 0 && rows.every((r) => tierSelected(value, r.tierId))}
                    indeterminate={rows.some((r) => tierSelected(value, r.tierId)) && !rows.every((r) => tierSelected(value, r.tierId))}
                    onChange={(on) => set({ tierIds: on ? rows.map((r) => r.tierId) : [] })}
                  />
                </TH>
                <TH>Hạng</TH>
                <TH numeric>
                  <HeadHint label="Tiền mục tiêu ($)" hint={COL_HINT.target} />
                </TH>
                <TH numeric>
                  <HeadHint label="Tiền mục tiêu tối thiểu ($)" hint={COL_HINT.min} />
                </TH>
                <TH numeric>
                  <HeadHint label="Tiền mục tiêu tối đa ($)" hint={COL_HINT.max} />
                </TH>
                <TH numeric>
                  <HeadHint label="Số lệnh mỗi cửa" hint={COL_HINT.entries} />
                </TH>
                <TH numeric>
                  <HeadHint label="Lãi tối thiểu / ngày (%)" hint={COL_HINT.daily} />
                </TH>
              </tr>
            </THead>
            <tbody>
              {rows.map((r) => {
                const o = value.overrides[r.tierId] ?? {};
                const on = tierSelected(value, r.tierId);
                return (
                  <TR key={r.tierId} className={cn(!on && '[&>td:not(:first-child)]:opacity-45')}>
                    <TD>
                      <TierCheck label={`Vào hạng ${r.tierName}`} checked={on} onChange={(v) => toggleTier(r.tierId, v)} />
                    </TD>
                    <TD>
                      <span className="block text-fg">{r.tierName}</span>
                      <span className="num block text-caption text-muted-fg">{tierRange({ id: r.tierId, name: r.tierName, minMargin: r.minMargin, maxMargin: r.maxMargin })}</span>
                      {r.scaleWithinTier && r.stake > 0 ? (
                        <span className="num block text-caption text-faint">
                          {stepPer01(r) !== null
                            ? `${pctTxt(r.minMargin)} → ${money(r.stake)} · ${pctTxt(r.maxMargin!)} → ${money(r.maxStake)} · +${money(stepPer01(r)!)} / 0,1%`
                            : r.maxMargin === null
                              ? 'không có cận trên → luôn vào tiền mục tiêu'
                              : 'tối đa = mục tiêu → không tăng'}
                        </span>
                      ) : null}
                    </TD>
                    <TD numeric>
                      {custom ? (
                        <CellInput label={`Tiền mục tiêu ${r.tierName}`} value={o.stake} placeholder="0" onValue={(stake) => setOverride(r.tierId, { stake })} />
                      ) : (
                        <span className={cn(r.stake > 0 ? 'text-fg' : 'text-faint')}>{money(r.stake)}</span>
                      )}
                    </TD>
                    <TD numeric>
                      <CellInput label={`Tiền mục tiêu tối thiểu ${r.tierName}`} value={o.minStake} placeholder={String(r.minStake)} onValue={(minStake) => setOverride(r.tierId, { minStake })} />
                    </TD>
                    <TD numeric>
                      <CellInput label={`Tiền mục tiêu tối đa ${r.tierName}`} value={o.maxStake} placeholder={String(r.maxStake)} onValue={(maxStake) => setOverride(r.tierId, { maxStake })} />
                    </TD>
                    <TD numeric>
                      <CellInput
                        label={`Số lệnh mỗi cửa ${r.tierName}`}
                        value={o.maxEntries}
                        placeholder={defaultEntries > 0 ? String(defaultEntries) : '∞'}
                        narrow
                        onValue={(v) => setOverride(r.tierId, { maxEntries: v === undefined ? undefined : Math.min(100, Math.max(0, Math.floor(v))) })}
                      />
                    </TD>
                    <TD numeric>
                      <CellInput
                        label={`Lãi tối thiểu mỗi ngày ${r.tierName}`}
                        value={o.minDailyMargin === undefined ? undefined : +(o.minDailyMargin * 100).toFixed(4)}
                        placeholder={defaultDaily > 0 ? String(+(defaultDaily * 100).toFixed(4)) : 'tắt'}
                        narrow
                        onValue={(v) => setOverride(r.tierId, { minDailyMargin: v === undefined ? undefined : Math.min(10, Math.max(0, v / 100)) })}
                      />
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        )}
        {rows.length ? (
          <p className={cn('mt-2 text-caption', selectedCount ? 'text-muted-fg' : 'text-warn')}>
            {selectedCount
              ? `Profile vào ${selectedCount}/${rows.length} hạng. Kèo thuộc hạng không chọn sẽ bị bỏ qua (Hạng không được chọn).`
              : 'Chưa chọn hạng nào: tick ô đầu dòng các hạng profile sẽ vào. Lưu khi chưa chọn → profile đứng yên.'}
          </p>
        ) : null}
        <Mechanism />
      </div>
    </div>
  );
}

const COL_HINT = {
  target:
    'Tiền cược bên csgoempire mà worker muốn vào cho một kèo của hạng này (mức cao nhất, không bao giờ vào hơn). Từ đó worker cần mua tiền × odds share Polymarket, ví dụ 50$ @ 2.0 → 100 share. Sổ Polymarket chỉ có 80 share còn lãi → csgoempire vào 80 ÷ 2.0 = 40$. Bật Tăng dần trong hạng thì đây là mục tiêu ở cận dưới của hạng.',
  min: 'Tiền cược csgoempire thấp nhất chấp nhận được, so với TỔNG share mua được ở mọi mức giá cộng lại (không phải từng người bán). Ví dụ mục tiêu 50$, tối thiểu 35$: mua được 80 share → 40$ ≥ 35$ thì vào 40$; chỉ 60 share → 30$ thì bỏ qua cả hai chân. Giữ nguyên cho mọi margin trong hạng, kể cả khi bật Tăng dần trong hạng.',
  max: 'Chỉ có tác dụng khi bật Tăng dần trong hạng. Khi bật: tiền mục tiêu tăng đều từ cột Tiền mục tiêu (ở cận dưới của hạng) lên số này (ở cận trên), theo margin của kèo.',
  entries:
    'Một cửa (cùng market, cùng cặp sàn/phía) ở hạng này được vào tối đa bấy nhiêu lệnh — kể cả vào lặp lại CÙNG một kèo mỗi lần kèo được làm mới. Đủ số thì bỏ qua im lặng. Ô trống = theo "Số lệnh mỗi cửa mỗi hạng" mặc định của profile (ô bên dưới). 0 = không giới hạn. Mỗi hạng đếm riêng.',
  daily:
    'Ưu tiên kèo lãi cao theo ngày khóa vốn. Lãi/ngày = margin kèo ÷ số ngày tới khi trận có kết quả (giờ bắt đầu + 3 giờ, tối thiểu 1 ngày). Dưới số này thì bỏ qua (Lãi theo ngày thấp) để dành tiền cho kèo trận gần. Ví dụ ngưỡng 1%/ngày: kèo 3% trận cách 5 ngày = 0,6%/ngày → bỏ; kèo 15% trận cách 2 ngày = 7,5%/ngày → vào. Ô trống = theo "Lãi tối thiểu mỗi ngày" của profile; 0 = tắt cho hạng này.',
} as const;

/** Tăng dần trong hạng: mục tiêu tăng thêm bao nhiêu $ mỗi 0,1% margin (null = không tăng). */
const stepPer01 = (r: { stake: number; maxStake: number; minMargin: number; maxMargin: number | null }) =>
  r.maxMargin !== null && r.maxMargin > r.minMargin && r.maxStake > r.stake
    ? ((r.maxStake - r.stake) / (r.maxMargin - r.minMargin)) * 0.001
    : null;
const pctTxt = (x: number) => `${+(x * 100).toFixed(2)}%`;

function HeadHint({ label, hint }: { label: string; hint: string }) {
  return (
    <Hint content={<span className="block max-w-72 text-left">{hint}</span>}>
      <span className="inline-flex cursor-help items-center gap-1">
        {label}
        <Info className="size-3.5 text-faint" aria-label={`Giải thích: ${label}`} />
      </span>
    </Hint>
  );
}

/** Giải thích cơ chế vào lệnh (luôn thu gọn lúc đầu; chi tiết ở Tài liệu hệ thống). */
function Mechanism() {
  const b = (t: string) => <b className="font-medium text-fg">{t}</b>;
  return (
    <details className="group mt-4 rounded-[8px] px-3 py-2 shadow-[inset_0_0_0_1px_var(--line)]">
      <summary className="cursor-pointer list-none text-caption font-medium text-muted-fg hover:text-fg">
        <span className="group-open:hidden">▸ Cơ chế vào lệnh và tăng dần tiền mục tiêu</span>
        <span className="hidden group-open:inline">▾ Cơ chế vào lệnh và tăng dần tiền mục tiêu</span>
      </summary>
      <div className="mt-3 space-y-3 text-caption text-muted-fg">
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>
            {b('Chọn hạng.')} Hạng không được tick bị loại trước. Kèo đến → xếp vào một hạng ĐƯỢC TICK theo margin (nhiều hạng tick cùng khớp thì lấy hạng có cận dưới cao nhất). Không khớp hạng tick nào → bỏ qua (Hạng không được chọn), kể cả khi kèo khớp một hạng không tick chồng khoảng.
          </li>
          <li>
            {b('Tính số share cần mua.')} Hệ thống luôn lấy {b('Tiền mục tiêu')} của hạng: share cần mua bên Polymarket = tiền mục tiêu × odds csgoempire. Ví dụ 50$ @ 2.0 → 100 share. Mỗi share trả 1$ nếu thắng nên hai chân nhận về bằng nhau.
          </li>
          <li>
            {b('Gom share trên Polymarket')} (taker): mua lệnh bán từ giá rẻ nhất lên, cộng dồn mọi người bán. Dừng khi đủ share, hết sổ lệnh, mức giá kế tiếp làm lãi ròng (sau phí) dưới {b('Lãi ròng tối thiểu')}, hoặc hết hạn mức theo trận.
          </li>
          <li>
            {b('Đủ share')} → vào đúng tiền mục tiêu bên csgoempire.
          </li>
          <li>
            {b('Vào lặp lại:')} kèo vừa vào lệnh, mỗi lần được làm mới (cùng kèo, dữ liệu mới) lại được xét vào tiếp, tới khi cửa đủ {b('Số lệnh mỗi cửa')} của hạng. Hạn mức theo trận vẫn áp cho tổng các lệnh.
          </li>
          <li>
            {b('Sổ lệnh mỏng, thiếu share')} → hạ tiền bên csgoempire xuống cho khớp: {b('tiền csgoempire = số share Polymarket mua được ÷ odds csgoempire')}. Ví dụ chỉ gom được 80 share → 80 ÷ 2.0 = 40$.
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>Số tiền đã hạ ≥ {b('Tiền mục tiêu tối thiểu')} → vào với số tiền đó (40$ ≥ 35$ → vào 40$).</li>
              <li>Nhỏ hơn → bỏ qua cả hai chân (Sổ lệnh mỏng), không bao giờ vào csgoempire mà thiếu chân Polymarket.</li>
            </ul>
          </li>
          <li>
            {b('Các kết quả bỏ qua khác:')} Hết lãi sau phí (giá rẻ nhất đã không đủ lãi) · Dưới lệnh tối thiểu (ít hơn số share tối thiểu của market) · Hết hạn mức trận · Kèo quá cũ / hết hạn · Kèo bị hủy khi đang tính. Cửa đã đủ số lệnh của hạng thì bỏ qua im lặng (không ghi dòng).
          </li>
        </ol>
        <div>
          <p className="mb-1">{b('Tăng dần tiền mục tiêu trong hạng')} (chỉ khi bật Tăng dần trong hạng):</p>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>Trong CÙNG một hạng, kèo margin cao hơn có tiền mục tiêu cao hơn: cận dưới → Tiền mục tiêu, cận trên → Tiền mục tiêu tối đa, ở giữa tăng đều (không theo bậc).</li>
            <li className="num">mục tiêu = tiền mục tiêu + (tối đa − tiền mục tiêu) × (margin − cận dưới) ÷ (cận trên − cận dưới)</li>
            <li>Ví dụ hạng 1,5–3%, 50$ → 100$: 1,5% → 50$, 2% → 66,67$, 2,5% → 83,33$ (+3,33$ mỗi 0,1%). Mức tăng của từng hạng ghi dưới tên hạng trong bảng.</li>
            <li>Tiền mục tiêu tối thiểu giữ nguyên cho cả hạng. Hạng không có cận trên luôn dùng Tiền mục tiêu.</li>
            <li>Khác với Bước mỗi hạng: bước là chênh lệch tiền GIỮA các hạng.</li>
          </ul>
        </div>
        <p className="text-faint">Chi tiết và ví dụ sổ lệnh: Tài liệu hệ thống → mục Auto trade.</p>
      </div>
    </details>
  );
}

/** Ô số giữ chữ người dùng gõ (vd "1."), chỉ báo giá trị khi hợp lệ. */
export function NumInput({ id, value, onValue }: { id: string; value: number; onValue: (v: number | undefined) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (parseNum(text) !== value) setText(String(value));
  }, [value]);
  return (
    <Input
      id={id}
      inputMode="decimal"
      className="num"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const v = parseNum(e.target.value);
        if (v !== undefined) onValue(v);
      }}
    />
  );
}

function CellInput({
  label,
  value,
  placeholder,
  onValue,
  narrow,
}: {
  label: string;
  value: number | undefined;
  placeholder: string;
  onValue: (v: number | undefined) => void;
  narrow?: boolean;
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => {
    if (parseNum(text) !== value) setText(value === undefined ? '' : String(value));
  }, [value]);
  return (
    <Input
      aria-label={label}
      inputMode="decimal"
      className={cn('num ml-auto h-8 text-right', narrow ? 'w-16' : 'w-24')}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        onValue(parseNum(e.target.value));
      }}
    />
  );
}
