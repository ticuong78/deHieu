'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  LockOpen,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  Users,
} from 'lucide-react';
import type { TaskRecord } from '@/lib/types';
import {
  DEFAULT_RISK,
  DEFAULT_STAKE_PLAN,
  TRADER_KIND,
  type RiskLimits,
  type StakePlan,
  type TradingAccountView,
  type TraderProfile,
  type TraderRuntimeConfig,
} from '@/lib/trading-types';
import { CANCEL_REASONS } from '@/lib/skip-reasons';
import {
  MARKET_GROUPS,
  MARKET_TYPES,
  marketGroup,
  marketLabel,
} from '@/lib/markets';
import { cn } from '@/lib/utils';
import { useApi } from '@/hooks/use-api';
import { useGuard, useMutate } from '../shell/shell-context';
import { Button } from '../ui/button';
import { AccountCheckButton, AccountCheckLine } from './account-check';
import { AccountDetail } from './account-detail';
import {
  Field,
  FilterChip,
  Input,
  Segmented,
  Select,
  Switch,
} from '../ui/controls';
import { Section } from '../ui/layout';
import { Menu, MenuItem, MenuSeparator } from '../ui/menu';
import { Confirm, Panel } from '../ui/panel';
import { Empty, ErrorState, SkeletonRows } from '../ui/states';
import { Pill, StatusDot, TASK_STATE_TONE } from '../ui/status';
import { Hint } from '../ui/tooltip';
import { NumInput, StakePlanEditor } from './stake-plan-editor';

/** Chiến lược worker hỗ trợ (id khớp danh mục chiến lược trong worker). */
const STRATEGIES = [
  {
    id: 'arb-taker',
    label: 'Ăn lệnh có sẵn (taker)',
    help: 'Mua ngay các mức giá Polymarket còn lãi ≥ ngưỡng sau phí taker; cân hai chân theo odds csgoempire.',
  },
];

const TREND_SHORT = {
  flat: 'ngang',
  up: 'tăng dần',
  down: 'giảm dần',
  custom: 'tùy chỉnh',
} as const;

const INACTIVE_LABEL: Record<string, string> = {
  CSGOEMPIRE_LOGIN_IN_PROGRESS: 'Đang đăng nhập trong Chromium',
  CSGOEMPIRE_VERIFICATION_REQUIRED: 'Sàn yêu cầu xác minh — đã dừng',
  CSGOEMPIRE_LOGIN_REJECTED: 'Tài khoản hoặc mật khẩu bị từ chối',
  CSGOEMPIRE_LOGIN_ACCOUNT_MISMATCH: 'Hồ sơ đang đăng nhập tài khoản khác',
  CSGOEMPIRE_SESSION_EXPIRED: 'Phiên csgoempire hết hạn',
  CSGOEMPIRE_BROWSER_UNAVAILABLE: 'Không mở được Chromium',
  CSGOEMPIRE_SESSION_REFRESH_FAILED: 'Chưa làm mới được phiên csgoempire',
  LIVE_RECONCILIATION_REQUIRED: 'Đã dừng: cần đối soát hai chân trên sàn',
  LIVE_REDIS_REQUIRED: 'Chưa cấu hình Redis cho giao dịch thật',
  TRADING_SECRET_KEY_REQUIRED: 'Chưa cấu hình khóa mã hóa ví',
  LIVE_CREDENTIALS_MISSING: 'Chưa có thông tin ví để giao dịch thật',
  LIVE_ACCOUNT_UNAVAILABLE: 'Tài khoản đang bận hoặc chưa sẵn sàng',
  PROFILE_DISABLED: 'Profile đang tắt',
  CSGOEMPIRE_ACCOUNT_MISSING: 'Thiếu tài khoản csgoempire',
  CSGOEMPIRE_ACCOUNT_DISABLED: 'Tài khoản csgoempire đang tắt',
  POLYMARKET_ACCOUNT_MISSING: 'Thiếu ví Polymarket',
  POLYMARKET_ACCOUNT_DISABLED: 'Ví Polymarket đang tắt',
  NO_STAKE_TIER: 'Bảng vốn không có hạng nào > 0$',
  NO_TIER_SELECTED: 'Chưa chọn hạng kèo nào để vào',
  NO_MARKET_SELECTED: 'Chưa chọn market nào để vào',
  PROFILE_NOT_FOUND: 'Profile không tồn tại',
};

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'profile';

const traderTask = (tasks: TaskRecord[] | null, profileId: string) =>
  tasks?.find(
    (t) => t.spec.kind === TRADER_KIND && t.spec.params.profileId === profileId,
  ) ?? null;

/** Profile trader: 1 csgoempire + 1 ví Polymarket + kế hoạch vốn + chiến lược + giới hạn rủi ro. */
export function TraderProfiles() {
  const profiles = useApi<TraderProfile[]>('trading/profiles', 15_000);
  const accounts = useApi<TradingAccountView[]>('trading/accounts', 15_000);
  const tasks = useApi<TaskRecord[]>('tasks', 5_000);
  const manage = useGuard('trading:manage');
  const runGuard = useGuard('tasks:manage');
  const mutate = useMutate();
  const [editing, setEditing] = useState<TraderProfile | 'new' | null>(null);
  const [removing, setRemoving] = useState<TraderProfile | null>(null);
  // "Đã đối soát — gỡ khóa": hỏi xác nhận trước khi cho bot chạy lại
  const [reconciling, setReconciling] = useState<TraderProfile | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const accountLink = (id: string) => (
    <button
      type="button"
      onClick={() => setViewing(id)}
      className="hover:text-accent-text hover:underline"
    >
      {label(id)}
    </button>
  );
  const [busy, setBusy] = useState(false);
  const accountList = accounts.data ?? [];
  const label = (id: string) =>
    accountList.find((a) => a.id === id)?.label ?? '—';
  const ready =
    accountList.some((a) => a.venue === 'csgoempire') &&
    accountList.some((a) => a.venue === 'polymarket');

  const start = async (p: TraderProfile) => {
    const existing = traderTask(tasks.data, p.id);
    const r = existing
      ? await mutate(
          `tasks/${encodeURIComponent(existing.spec.taskId)}/start`,
          { method: 'POST' },
          `Đã chạy lại trader ${p.name}`,
        )
      : await mutate(
          'tasks',
          {
            method: 'POST',
            body: {
              taskId: `trader-${slug(p.name)}`,
              kind: TRADER_KIND,
              runtime: { type: 'worker' },
              persist: true,
              params: { profileId: p.id },
            },
          },
          `Đã chạy trader ${p.name}`,
        );
    if (r !== null) void tasks.reload();
  };
  // trader bỏ dấu "đã xử lý", xét lại ngay mọi kèo còn sống (không xóa lệnh)
  const reevaluate = async (p: TraderProfile) => {
    const r = await mutate<{ tasks: number }>(
      `trading/profiles/${encodeURIComponent(p.id)}/reevaluate`,
      { method: 'POST' },
    );
    if (r)
      toast.success(
        r.tasks
          ? `${p.name}: đang xét lại các kèo còn sống`
          : `${p.name}: không có task trader nào đang chạy`,
      );
  };
  const confirmReconcile = async () => {
    if (!reconciling) return;
    setBusy(true);
    const r = await mutate<{ cleared: string[] }>(
      `trading/profiles/${encodeURIComponent(reconciling.id)}/reconciled`,
      { method: 'POST' },
    );
    setBusy(false);
    if (r) {
      toast.success(
        `${reconciling.name}: đã gỡ ${r.cleared.length} khóa đối soát — bot chạy lại trong giây lát`,
      );
      setReconciling(null);
      void profiles.reload();
    }
  };
  const stop = async (t: TaskRecord) => {
    const r = await mutate(
      `tasks/${encodeURIComponent(t.spec.taskId)}/stop`,
      { method: 'POST' },
      `Đã dừng ${t.spec.taskId}`,
    );
    if (r !== null) void tasks.reload();
  };

  const add = (
    <Button
      variant="primary"
      size="sm"
      onClick={() => setEditing('new')}
      disabledReason={
        manage ??
        (ready ? null : 'Cần ít nhất 1 tài khoản csgoempire và 1 ví Polymarket')
      }
    >
      <Plus /> Thêm profile
    </Button>
  );

  return (
    <Section
      title="Profile trader"
      description="Mỗi profile nhận cùng một kèo từ ConsumerHub. Chọn chế độ giấy để mô phỏng hoặc chế độ thật để đặt cả hai chân theo bảng vốn."
      actions={add}
    >
      {profiles.error && !profiles.data ? (
        <ErrorState message={profiles.error} onRetry={profiles.reload} />
      ) : null}
      {!profiles.data && !profiles.error ? (
        <SkeletonRows rows={2} cols={[30, 24, 20]} />
      ) : null}
      {profiles.data && !profiles.data.length ? (
        <Empty icon={Users} action={add}>
          {ready
            ? 'Chưa có profile trader.'
            : 'Thêm tài khoản csgoempire và ví Polymarket ở tab Tài khoản trước, rồi tạo profile.'}
        </Empty>
      ) : null}
      {profiles.data?.length ? (
        <ul>
          {profiles.data.map((p) => {
            const t = traderTask(tasks.data, p.id);
            const running =
              t &&
              [
                'RUNNING',
                'STARTING',
                'INITIALIZING',
                'READY',
                'RESTARTING',
              ].includes(t.state);
            return (
              <li
                key={p.id}
                className="flex min-h-14 flex-wrap items-center gap-x-6 gap-y-1.5 border-b border-line py-3 last:border-0"
              >
                <span className="flex min-w-0 flex-1 items-center gap-3">
                  <StatusDot
                    tone={t ? TASK_STATE_TONE[t.state] : 'muted'}
                    label={t ? t.state : 'Chưa chạy'}
                  />
                  <span className="min-w-0">
                    <span
                      className={cn(
                        'block truncate text-body',
                        p.enabled ? 'text-fg' : 'text-muted-fg',
                      )}
                    >
                      {p.name}
                    </span>
                    <span className="block truncate text-caption text-faint">
                      {accountLink(p.csgoempireAccountId)} +{' '}
                      {accountLink(p.polymarketAccountId)}
                    </span>
                    <AccountCheckLine
                      accountId={p.csgoempireAccountId}
                      venue="csgoempire"
                      label={label(p.csgoempireAccountId)}
                      className="mt-1"
                    />
                    <AccountCheckLine
                      accountId={p.polymarketAccountId}
                      venue="polymarket"
                      label={label(p.polymarketAccountId)}
                      className="mt-1"
                    />
                  </span>
                  <Pill tone={p.mode === 'live' ? 'warn' : 'muted'}>
                    {p.mode === 'live' ? 'thật' : 'giấy'}
                  </Pill>
                  {!p.enabled ? <Pill tone="muted">Tắt</Pill> : null}
                </span>
                <span className="w-full text-caption text-muted-fg md:w-56">
                  <span className="block">
                    Vốn {TREND_SHORT[p.stakePlan.trend]}
                    {p.stakePlan.trend !== 'custom' ? (
                      <span className="num text-fg">
                        {' '}
                        · {p.stakePlan.baseStake}$
                      </span>
                    ) : null}
                    {p.stakePlan.scaleWithinTier ? ' · tăng trong hạng' : ''}
                    {p.stakePlan.tierIds === null
                      ? ' · mọi hạng'
                      : ` · ${p.stakePlan.tierIds.length} hạng`}
                    {!p.risk.markets
                      ? ' · mọi market'
                      : p.risk.markets.length <= 2
                        ? ` · ${p.risk.markets.map(marketLabel).join(', ') || '0 market'}`
                        : ` · ${p.risk.markets.length} market`}
                  </span>
                  <span className="num block text-faint">
                    lãi ròng ≥ {+(p.risk.minNetMargin * 100).toFixed(2)}%
                    {p.risk.matchCapUsd
                      ? ` · ≤ ${p.risk.matchCapUsd}$/trận`
                      : ''}
                  </span>
                </span>
                <span className="w-full md:w-48">
                  <RuntimeState
                    profileId={p.id}
                    task={t}
                    onReconcile={manage ? undefined : () => setReconciling(p)}
                  />
                </span>
                <span className="ml-auto flex items-center gap-1 md:ml-0">
                  <AccountCheckButton
                    accountIds={[p.csgoempireAccountId, p.polymarketAccountId]}
                    disabledReason={manage}
                  >
                    Kiểm tra TK
                  </AccountCheckButton>
                  {running && t ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void stop(t)}
                      disabledReason={runGuard}
                    >
                      <Square /> Dừng
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void start(p)}
                      disabledReason={runGuard}
                    >
                      <Play /> Chạy
                    </Button>
                  )}
                  <Menu
                    trigger={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Thao tác ${p.name}`}
                      >
                        <MoreHorizontal />
                      </Button>
                    }
                  >
                    <MenuItem
                      icon={<Pencil />}
                      disabledReason={manage}
                      onSelect={() => setEditing(p)}
                    >
                      Sửa
                    </MenuItem>
                    <MenuItem
                      icon={<RefreshCw />}
                      disabledReason={
                        manage ?? (running ? null : 'Task trader chưa chạy')
                      }
                      onSelect={() => void reevaluate(p)}
                    >
                      Xét lại kèo đang sống
                    </MenuItem>
                    <MenuItem
                      icon={<LockOpen />}
                      disabledReason={manage}
                      onSelect={() => setReconciling(p)}
                    >
                      Đã đối soát — gỡ khóa
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      icon={<Trash2 />}
                      danger
                      disabledReason={manage}
                      onSelect={() => setRemoving(p)}
                    >
                      Xóa
                    </MenuItem>
                  </Menu>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      <AccountDetail
        account={accountList.find((a) => a.id === viewing) ?? null}
        onClose={() => setViewing(null)}
      />
      <ProfileForm
        value={editing}
        accounts={accountList}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void profiles.reload();
        }}
      />
      <Confirm
        open={!!reconciling}
        onOpenChange={(v) => !v && setReconciling(null)}
        tone="danger"
        title={`Đã đối soát ${reconciling?.name ?? ''}?`}
        description="Chỉ bấm khi đã kiểm tra hai chân của lệnh gây khóa trên csgoempire (My bets) và Polymarket (Activity), và đã tự xử lý chân lẻ nếu có (bù tay hoặc bán lại share). Gỡ khóa đối soát trên cả hai tài khoản của profile, bot vào lệnh lại ngay. Khóa phiên hết hạn không gỡ ở đây — bấm Đăng nhập."
        confirmLabel="Đã đối soát, gỡ khóa"
        loading={busy}
        onConfirm={() => void confirmReconcile()}
      />
      <Confirm
        open={!!removing}
        onOpenChange={(v) => !v && setRemoving(null)}
        tone="danger"
        title={`Xóa profile ${removing?.name ?? ''}?`}
        description="Task trader của profile (nếu đang chạy) sẽ đứng yên với lý do PROFILE_NOT_FOUND — dừng/xóa task ở trang Publisher. Lệnh giấy đã ghi vẫn giữ."
        confirmLabel="Xóa profile"
        loading={busy}
        onConfirm={async () => {
          if (!removing) return;
          setBusy(true);
          const r = await mutate(
            `trading/profiles/${encodeURIComponent(removing.id)}`,
            { method: 'DELETE' },
            `Đã xóa ${removing.name}`,
          );
          setBusy(false);
          if (r !== null) {
            setRemoving(null);
            void profiles.reload();
          }
        }}
      />
    </Section>
  );
}

/** Trạng thái task + cấu hình worker đang nhận (active / lý do đứng yên). */
function RuntimeState({
  profileId,
  task,
  onReconcile,
}: {
  profileId: string;
  task: TaskRecord | null;
  /** Có = profile đang đứng yên vì khóa đối soát thì hiện nút gỡ khóa ngay tại đây. */
  onReconcile?: () => void;
}) {
  const cfg = useApi<TraderRuntimeConfig>(
    `trading/profiles/${encodeURIComponent(profileId)}/runtime-config`,
    15_000,
  );
  if (!task)
    return <span className="text-caption text-faint">Chưa có task trader</span>;
  const reason =
    cfg.data && !cfg.data.active
      ? (INACTIVE_LABEL[(cfg.data.inactiveReason ?? '').split(':')[0] ?? ''] ??
        cfg.data.inactiveReason)
      : null;
  return (
    <span className="block text-caption">
      <span className="num block truncate text-muted-fg">
        {task.spec.taskId}
      </span>
      {reason ? (
        <>
          <Hint content="Worker vẫn nhận kèo nhưng bỏ qua và ghi lý do">
            <span className="block truncate text-warn">Đứng yên: {reason}</span>
          </Hint>
          {onReconcile &&
          (cfg.data?.inactiveReason ?? '').startsWith(
            'LIVE_RECONCILIATION_REQUIRED',
          ) ? (
            <Button
              variant="ghost"
              size="sm"
              className="mt-1"
              onClick={onReconcile}
            >
              <LockOpen aria-hidden /> Đã đối soát — gỡ khóa
            </Button>
          ) : null}
        </>
      ) : task.lastError ? (
        <Hint content={task.lastError}>
          <span className="block truncate text-critical/85">
            {task.lastError}
          </span>
        </Hint>
      ) : (
        <span className="block text-faint">
          {task.state === 'RUNNING'
            ? 'đang nhận kèo'
            : task.state.toLowerCase()}
        </span>
      )}
    </span>
  );
}

function ProfileForm({
  value,
  accounts,
  onClose,
  onSaved,
}: {
  value: TraderProfile | 'new' | null;
  accounts: TradingAccountView[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const mutate = useMutate();
  const editing = value && value !== 'new' ? value : null;
  const empires = accounts.filter((a) => a.venue === 'csgoempire');
  const polys = accounts.filter((a) => a.venue === 'polymarket');
  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [mode, setMode] = useState<TraderProfile['mode']>('paper');
  const [empire, setEmpire] = useState('');
  const [poly, setPoly] = useState('');
  const [plan, setPlan] = useState<StakePlan>(DEFAULT_STAKE_PLAN);
  const [strategy, setStrategy] = useState('arb-taker');
  const [risk, setRisk] = useState<RiskLimits>(DEFAULT_RISK);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!value) return;
    const e = value === 'new' ? null : value;
    setName(e?.name ?? '');
    setEnabled(e?.enabled ?? true);
    setMode(e?.mode ?? 'paper');
    setEmpire(e?.csgoempireAccountId ?? empires[0]?.id ?? '');
    setPoly(e?.polymarketAccountId ?? polys[0]?.id ?? '');
    setPlan(
      e
        ? {
            ...DEFAULT_STAKE_PLAN,
            ...e.stakePlan,
            tierIds: e.stakePlan.tierIds ?? null,
          }
        : DEFAULT_STAKE_PLAN,
    );
    setStrategy(e?.strategy.id ?? 'arb-taker');
    setRisk({ ...DEFAULT_RISK, ...e?.risk });
  }, [value]);

  const missing = !name.trim() || !empire || !poly;
  const submit = async () => {
    setBusy(true);
    const r = await mutate(
      editing
        ? `trading/profiles/${encodeURIComponent(editing.id)}`
        : 'trading/profiles',
      {
        method: editing ? 'PUT' : 'POST',
        body: {
          name: name.trim(),
          enabled,
          mode,
          csgoempireAccountId: empire,
          polymarketAccountId: poly,
          stakePlan: plan,
          strategy: {
            id: strategy,
            params:
              editing?.strategy.id === strategy ? editing.strategy.params : {},
          },
          risk,
        },
      },
      editing ? `Đã lưu ${name.trim()}` : `Đã thêm profile ${name.trim()}`,
    );
    setBusy(false);
    if (r !== null) onSaved();
  };

  const strat = STRATEGIES.find((s) => s.id === strategy);
  return (
    <Panel
      open={!!value}
      onOpenChange={(v) => !v && onClose()}
      width="xl"
      title={editing ? `Sửa ${editing.name}` : 'Thêm profile trader'}
      description="Lưu xong, task trader đang chạy của profile nhận cấu hình mới ngay (không cần khởi động lại)."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Hủy
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={busy}
            disabled={missing}
          >
            {editing ? 'Lưu' : 'Thêm profile'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <Field label="Tên" htmlFor="pf-name">
          <Input
            id="pf-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
          />
        </Field>
        <Field
          label="Chế độ giao dịch"
          htmlFor="pf-mode"
          help="Áp dụng chung cho Auto trade và nút Trade ở On click. Một bên thiếu Cash sẽ hủy cả cặp trước khi gửi."
        >
          <Select
            id="pf-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as TraderProfile['mode'])}
          >
            <option value="paper">Giấy (mô phỏng)</option>
            <option value="live">Thật (đặt lệnh trên hai sàn)</option>
          </Select>
        </Field>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Tài khoản csgoempire" htmlFor="pf-empire">
            <Select
              id="pf-empire"
              value={empire}
              onChange={(e) => setEmpire(e.target.value)}
            >
              {empires.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                  {a.enabled ? '' : ' (tắt)'}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Ví Polymarket" htmlFor="pf-poly">
            <Select
              id="pf-poly"
              value={poly}
              onChange={(e) => setPoly(e.target.value)}
            >
              {polys.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                  {a.enabled ? '' : ' (tắt)'}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Chiến lược" htmlFor="pf-strategy" help={strat?.help}>
          <Select
            id="pf-strategy"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
          >
            {STRATEGIES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>

        <MarketPicker
          value={risk.markets}
          onChange={(markets) => setRisk({ ...risk, markets })}
        />

        <div className="h-px bg-line" />
        <StakePlanEditor
          value={plan}
          onChange={setPlan}
          defaultEntries={risk.maxEntriesPerTier}
          defaultDaily={risk.minDailyMargin}
        />
        <div className="h-px bg-line" />

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label="Lãi ròng tối thiểu (%)"
            htmlFor="pf-net"
            help="Sau phí taker và trượt giá thật của sổ lệnh."
          >
            <NumInput
              id="pf-net"
              value={+(risk.minNetMargin * 100).toFixed(4)}
              onValue={(v) =>
                v !== undefined &&
                v < 100 &&
                setRisk({ ...risk, minNetMargin: v / 100 })
              }
            />
          </Field>
          <Field
            label="Tối đa / trận của profile ($)"
            htmlFor="pf-cap"
            help="0 = chỉ theo giới hạn chung."
          >
            <NumInput
              id="pf-cap"
              value={risk.matchCapUsd}
              onValue={(v) =>
                v !== undefined && setRisk({ ...risk, matchCapUsd: v })
              }
            />
          </Field>
          <Field
            label="Bỏ kèo cũ hơn (giây)"
            htmlFor="pf-age"
            help="Tính từ lúc phát; 0 = không kiểm tra."
          >
            <NumInput
              id="pf-age"
              value={risk.maxSignalAgeMs / 1000}
              onValue={(v) =>
                v !== undefined &&
                setRisk({ ...risk, maxSignalAgeMs: Math.round(v * 1000) })
              }
            />
          </Field>
          <Field
            label="Số lệnh mỗi cửa mỗi hạng (mặc định)"
            htmlFor="pf-entries"
            help="Cùng cửa ở cùng hạng vào tối đa bấy nhiêu lệnh (kể cả vào lặp lại cùng một kèo mỗi lần làm mới), dù margin lên hay xuống; lên hạng khác thì tính lại từ đầu. Đủ số thì bỏ qua im lặng. 0 = không giới hạn số lệnh (chỉ còn hạn mức tiền theo trận chặn). Đặt riêng cho từng hạng ở cột Số lệnh mỗi cửa trong bảng tiền."
          >
            <NumInput
              id="pf-entries"
              value={risk.maxEntriesPerTier}
              onValue={(v) =>
                v !== undefined &&
                v >= 0 &&
                v <= 100 &&
                setRisk({ ...risk, maxEntriesPerTier: Math.floor(v) })
              }
            />
          </Field>
          <Field
            label="Lãi tối thiểu mỗi ngày (%/ngày)"
            htmlFor="pf-daily"
            help="Ưu tiên kèo lãi cao theo ngày khóa vốn: lãi/ngày = margin kèo ÷ số ngày tới khi trận có kết quả (giờ bắt đầu + 3 giờ, tối thiểu 1 ngày). Dưới ngưỡng → bỏ qua để dành tiền cho kèo trận gần lãi cao; kèo được xét lại mỗi lần làm mới nên trận tới gần thì tự vào. Vd 1%/ngày: kèo 3% cách 5 ngày (0,6%/ngày) bỏ, kèo 15% cách 2 ngày (7,5%/ngày) vào. Ghi đè từng hạng ở cột Lãi tối thiểu / ngày trong bảng tiền. 0 = tắt."
          >
            <NumInput
              id="pf-daily"
              value={+((risk.minDailyMargin ?? 0) * 100).toFixed(4)}
              onValue={(v) =>
                v !== undefined &&
                v >= 0 &&
                v <= 1000 &&
                setRisk({ ...risk, minDailyMargin: v / 100 })
              }
            />
          </Field>
          <Field
            label="Chuyển On click khi giá bán thấp nhất ≥"
            htmlFor="pf-oneclick"
            help="Giá ask thấp nhất trên sổ lệnh Polymarket (0–1). Đạt ngưỡng → bot KHÔNG tự vào, kèo hiện ở trang On click (mục Vận hành) để người bấm vào lệnh. 0 = tắt (bot vào mọi kèo)."
          >
            <NumInput
              id="pf-oneclick"
              value={risk.oneClickMinPrice}
              onValue={(v) =>
                v !== undefined &&
                v >= 0 &&
                v <= 1 &&
                setRisk({ ...risk, oneClickMinPrice: v })
              }
            />
          </Field>
          <Field
            label="Bỏ kèo margin cao bất thường (%)"
            htmlFor="pf-maxnet"
            help="Margin kèo hoặc lãi ròng tính ra vượt số này → nghi giá cũ / sổ lệnh lỗi, bỏ qua, kể cả lệnh bấm tay ở On click. Kèo quá đẹp thường biến mất trước khi lệnh tới sàn (một chân khớp, chân kia không). Mặc định 15; 0 = tắt."
          >
            <NumInput
              id="pf-maxnet"
              value={+((risk.maxNetMargin ?? 0) * 100).toFixed(4)}
              onValue={(v) =>
                v !== undefined &&
                v >= 0 &&
                v <= 1000 &&
                setRisk({ ...risk, maxNetMargin: v / 100 })
              }
            />
          </Field>
        </div>
        <Field
          label="Vẫn vào lệnh khi kèo bị hủy vì"
          help="Kèo bị hủy trong lúc trader đang đọc sổ lệnh / tính lệnh: lý do được chọn thì vẫn vào tiếp, lý do khác thì dừng."
        >
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {Object.entries(CANCEL_REASONS).map(([k, label]) => {
              const on = risk.ignoreCancelReasons.includes(k);
              return (
                <label
                  key={k}
                  className="flex cursor-pointer items-center gap-3 text-body"
                >
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--accent)]"
                    checked={on}
                    onChange={() =>
                      setRisk({
                        ...risk,
                        ignoreCancelReasons: on
                          ? risk.ignoreCancelReasons.filter((x) => x !== k)
                          : [...risk.ignoreCancelReasons, k],
                      })
                    }
                  />
                  <span className="text-fg">{label}</span>
                </label>
              );
            })}
          </div>
        </Field>
        <Field
          label="Bật profile"
          htmlFor="pf-on"
          help="Tắt = task trader vẫn chạy nhưng bỏ qua mọi kèo (ghi lý do)."
        >
          <Switch
            id="pf-on"
            checked={enabled}
            onCheckedChange={setEnabled}
            label="Bật profile"
          />
        </Field>
      </div>
    </Panel>
  );
}

/** Market profile được vào: mọi market (null) hoặc danh sách chọn. */
function MarketPicker({
  value,
  onChange,
}: {
  value: string[] | null;
  onChange: (v: string[] | null) => void;
}) {
  const all = value === null;
  const picked = value ?? [];
  const toggle = (m: string) =>
    onChange(
      picked.includes(m) ? picked.filter((x) => x !== m) : [...picked, m],
    );
  return (
    <Field
      label="Market sẽ vào"
      help={
        all
          ? 'Vào mọi market, kể cả market thêm sau. Chọn "Chỉ market đã chọn" để giới hạn, vd chỉ Thắng trận hoặc chỉ Chấp +1.5.'
          : 'Kèo ở market không chọn bị bỏ qua (Market không được chọn). Market thêm sau không tự được chọn.'
      }
    >
      <div className="flex flex-col gap-3">
        <Segmented<'all' | 'pick'>
          value={all ? 'all' : 'pick'}
          onChange={(v) => onChange(v === 'all' ? null : [])}
          options={[
            { value: 'all', label: 'Mọi market' },
            { value: 'pick', label: 'Chỉ market đã chọn' },
          ]}
        />
        {!all ? (
          <div className="flex flex-col gap-2">
            {MARKET_GROUPS.map((g) => {
              const ms = MARKET_TYPES.filter((m) => marketGroup(m) === g.id);
              if (!ms.length) return null;
              return (
                <div key={g.id} className="flex flex-wrap items-center gap-2">
                  <span className="w-28 shrink-0 text-caption text-muted-fg">
                    {g.label}
                  </span>
                  {ms.map((m) => (
                    <Hint key={m} content={m}>
                      <span>
                        <FilterChip
                          active={picked.includes(m)}
                          onClick={() => toggle(m)}
                        >
                          {marketLabel(m)}
                        </FilterChip>
                      </span>
                    </Hint>
                  ))}
                </div>
              );
            })}
            <p
              className={cn(
                'text-caption',
                picked.length ? 'text-muted-fg' : 'text-warn',
              )}
            >
              {picked.length
                ? `Đã chọn ${picked.length} market: ${picked.map(marketLabel).join(', ')}.`
                : 'Chưa chọn market nào: lưu lúc này thì profile đứng yên.'}
            </p>
          </div>
        ) : null}
      </div>
    </Field>
  );
}
