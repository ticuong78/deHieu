'use client';

import { useEffect, useState } from 'react';
import {
  ChartColumn,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Wallet,
} from 'lucide-react';
import type { TradingAccountView, TradingVenue } from '@/lib/trading-types';
import { cn } from '@/lib/utils';
import { useApi } from '@/hooks/use-api';
import { useGuard, useMutate } from '../shell/shell-context';
import { Button } from '../ui/button';
import { Field, Input, Select, Switch } from '../ui/controls';
import { Section } from '../ui/layout';
import { Menu, MenuItem, MenuSeparator } from '../ui/menu';
import { Confirm, Panel } from '../ui/panel';
import { Empty, ErrorState, SkeletonRows } from '../ui/states';
import { Pill, StatusDot } from '../ui/status';
import { Hint } from '../ui/tooltip';
import { EmpireLoginButton } from './empire-login-button';
import { AccountCheckButton, AccountCheckLine } from './account-check';
import { AccountDetail } from './account-detail';

export const VENUE_LABEL: Record<TradingVenue, string> = {
  csgoempire: 'csgoempire',
  polymarket: 'Polymarket',
};

const short = (a: string) =>
  a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

const targetOf = (a: TradingAccountView) =>
  a.config.venue === 'csgoempire'
    ? `hồ sơ trình duyệt ${a.config.browserProfile}`
    : `ví ${short(a.config.walletAddress)}${a.config.funderAddress ? ` · funder ${short(a.config.funderAddress)}` : ''}`;

/** Tài khoản giao dịch: nhiều tài khoản mỗi nền tảng. */
export function TradingAccounts({
  secretKeyConfigured,
}: {
  secretKeyConfigured: boolean | null;
}) {
  const accounts = useApi<TradingAccountView[]>('trading/accounts', 15_000);
  const manage = useGuard('trading:manage');
  const mutate = useMutate();
  const [editing, setEditing] = useState<
    TradingAccountView | TradingVenue | null
  >(null);
  const [removing, setRemoving] = useState<TradingAccountView | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const add = (
    <span className="flex gap-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setEditing('csgoempire')}
        disabledReason={manage}
      >
        <Plus /> csgoempire
      </Button>
      <Button
        variant="primary"
        size="sm"
        onClick={() => setEditing('polymarket')}
        disabledReason={manage}
      >
        <Plus /> Ví Polymarket
      </Button>
    </span>
  );

  return (
    <Section
      title="Tài khoản"
      description="Mỗi tài khoản csgoempire có hồ sơ Chromium riêng. Tài khoản/mật khẩu đăng nhập và private key Polymarket được mã hóa khi lưu, không trả lại cho trình duyệt."
      actions={add}
    >
      {accounts.error && !accounts.data ? (
        <ErrorState message={accounts.error} onRetry={accounts.reload} />
      ) : null}
      {!accounts.data && !accounts.error ? (
        <SkeletonRows rows={3} cols={[30, 20, 20]} />
      ) : null}
      {accounts.data && !accounts.data.length ? (
        <Empty icon={Wallet} action={add}>
          Chưa có tài khoản. Một trader cần 1 tài khoản csgoempire + 1 ví
          Polymarket.
        </Empty>
      ) : null}
      {accounts.data?.length ? (
        <ul>
          {accounts.data.map((a) => (
            <li
              key={a.id}
              className="flex min-h-14 flex-wrap items-center gap-x-6 gap-y-1.5 border-b border-line py-3 last:border-0"
            >
              <span className="flex min-w-0 flex-1 items-center gap-3">
                <StatusDot
                  tone={a.enabled ? 'ok' : 'muted'}
                  label={a.enabled ? 'Đang bật' : 'Đang tắt'}
                />
                <span className="min-w-0">
                  <button
                    type="button"
                    onClick={() => setViewing(a.id)}
                    className={cn(
                      'block max-w-full truncate text-left text-body hover:text-accent-text hover:underline',
                      a.enabled ? 'text-fg' : 'text-muted-fg',
                    )}
                  >
                    {a.label}
                  </button>
                  <span className="num block truncate text-caption text-faint">
                    {VENUE_LABEL[a.venue]} · {targetOf(a)}
                  </span>
                </span>
                {!a.enabled ? <Pill tone="muted">Tắt</Pill> : null}
              </span>
              <span className="flex w-full flex-wrap items-center gap-1.5 md:w-64">
                {a.venue === 'polymarket' ? (
                  a.hasSecret ? (
                    <Pill tone="ok">
                      <KeyRound className="size-3" /> Đã lưu key
                    </Pill>
                  ) : (
                    <Hint content="Chế độ giấy không cần key; giao dịch thật sẽ cần.">
                      <span>
                        <Pill tone="warn">Chưa có key</Pill>
                      </span>
                    </Hint>
                  )
                ) : null}
                {a.usedBy.length ? (
                  <span className="truncate text-caption text-muted-fg">
                    dùng ở {a.usedBy.join(', ')}
                  </span>
                ) : (
                  <span className="text-caption text-faint">chưa dùng</span>
                )}
              </span>
              {a.venue === 'csgoempire' ? (
                <EmpireLoginButton
                  accountId={a.id}
                  disabledReason={
                    !a.enabled
                      ? 'Tài khoản đang tắt'
                      : !a.hasSecret
                        ? 'Lưu tài khoản và mật khẩu trước'
                        : null
                  }
                />
              ) : null}
              <AccountCheckButton
                accountIds={[a.id]}
                disabledReason={
                  manage ??
                  (!a.enabled
                    ? 'Tài khoản đang tắt'
                    : a.venue === 'polymarket' && !a.hasSecret
                      ? 'Chưa lưu private key'
                      : null)
                }
              >
                Kiểm tra số dư
              </AccountCheckButton>
              <span className="ml-auto md:ml-0">
                <Menu
                  trigger={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Thao tác ${a.label}`}
                    >
                      <MoreHorizontal />
                    </Button>
                  }
                >
                  <MenuItem
                    icon={<ChartColumn />}
                    onSelect={() => setViewing(a.id)}
                  >
                    Chi tiết, số dư, lãi/lỗ
                  </MenuItem>
                  <MenuItem
                    icon={<Pencil />}
                    disabledReason={manage}
                    onSelect={() => setEditing(a)}
                  >
                    Sửa
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    icon={<Trash2 />}
                    danger
                    disabledReason={
                      manage ??
                      (a.usedBy.length ? 'Đang dùng trong profile' : null)
                    }
                    onSelect={() => setRemoving(a)}
                  >
                    Xóa
                  </MenuItem>
                </Menu>
              </span>
              <AccountCheckLine
                accountId={a.id}
                venue={a.venue}
                className="w-full pl-5"
              />
            </li>
          ))}
        </ul>
      ) : null}

      <AccountDetail
        account={accounts.data?.find((a) => a.id === viewing) ?? null}
        onClose={() => setViewing(null)}
      />
      <AccountForm
        value={editing}
        secretKeyConfigured={secretKeyConfigured}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void accounts.reload();
        }}
      />
      <Confirm
        open={!!removing}
        onOpenChange={(v) => !v && setRemoving(null)}
        tone="danger"
        title={`Xóa tài khoản ${removing?.label ?? ''}?`}
        description="Cấu hình và private key đã mã hóa bị xóa khỏi database."
        confirmLabel="Xóa tài khoản"
        loading={busy}
        onConfirm={async () => {
          if (!removing) return;
          setBusy(true);
          const r = await mutate(
            `trading/accounts/${encodeURIComponent(removing.id)}`,
            { method: 'DELETE' },
            `Đã xóa ${removing.label}`,
          );
          setBusy(false);
          if (r !== null) {
            setRemoving(null);
            void accounts.reload();
          }
        }}
      />
    </Section>
  );
}

function AccountForm({
  value,
  secretKeyConfigured,
  onClose,
  onSaved,
}: {
  value: TradingAccountView | TradingVenue | null;
  secretKeyConfigured: boolean | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const mutate = useMutate();
  const editing = value && typeof value === 'object' ? value : null;
  const [venue, setVenue] = useState<TradingVenue>('polymarket');
  const [label, setLabel] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [browserProfile, setBrowserProfile] = useState('');
  const [walletAddress, setWalletAddress] = useState('');
  const [funderAddress, setFunderAddress] = useState('');
  const [depositAddress, setDepositAddress] = useState('');
  const [relayerKey, setRelayerKey] = useState('');
  const [relayerAddress, setRelayerAddress] = useState('');
  const [fetchingDeposit, setFetchingDeposit] = useState(false);
  const [privateKey, setPrivateKey] = useState('');
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!value) {
      setLoginUsername('');
      setLoginPassword('');
      setPrivateKey('');
      return;
    }
    const e = typeof value === 'object' ? value : null;
    setVenue(e?.venue ?? (value as TradingVenue));
    setLabel(e?.label ?? '');
    setEnabled(e?.enabled ?? true);
    setBrowserProfile(
      e?.config.venue === 'csgoempire' ? e.config.browserProfile : '',
    );
    setWalletAddress(
      e?.config.venue === 'polymarket' ? e.config.walletAddress : '',
    );
    setFunderAddress(
      e?.config.venue === 'polymarket' ? (e.config.funderAddress ?? '') : '',
    );
    setDepositAddress(e?.config.usdtDepositAddress ?? '');
    setRelayerKey('');
    setRelayerAddress(
      e?.config.venue === 'polymarket' ? (e.config.relayerApiKeyAddress ?? '') : '',
    );
    setPrivateKey('');
    setLoginUsername('');
    setLoginPassword('');
  }, [value]);

  // chấp nhận thiếu tiền tố 0x
  const addr = (s: string) => {
    const t = s.trim();
    return /^[0-9a-fA-F]{40}$/.test(t) ? `0x${t}` : t;
  };
  const evm = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(addr(s));
  const walletErr =
    walletAddress.trim() && !evm(walletAddress)
      ? `Cần 0x + 40 ký tự hex (đang có ${walletAddress.trim().replace(/^0x/i, '').length} ký tự).`
      : undefined;
  const funderErr =
    funderAddress.trim() && !evm(funderAddress)
      ? 'Cần 0x + 40 ký tự hex, hoặc để trống.'
      : undefined;
  const depositErr =
    depositAddress.trim() && !evm(depositAddress)
      ? 'Cần 0x + 40 ký tự hex, hoặc để trống.'
      : venue === 'polymarket' &&
          depositAddress.trim() &&
          [walletAddress, funderAddress].some(
            (w) => w.trim() && addr(w).toLowerCase() === addr(depositAddress).toLowerCase(),
          )
        ? 'Đây là ví ký / ví proxy, không phải địa chỉ nạp. Lấy địa chỉ ở Polymarket → Deposit → Crypto → USDT (Polygon).'
        : undefined;
  const relayerErr =
    relayerAddress.trim() && !evm(relayerAddress)
      ? 'Cần 0x + 40 ký tự hex, hoặc để trống.'
      : relayerKey.trim() && !relayerAddress.trim()
        ? 'Nhập cả Signer Address hiện cùng key.'
        : undefined;
  const fetchEmpireDeposit = async () => {
    if (!editing) return;
    setFetchingDeposit(true);
    const r = await mutate<{ address: string }>(
      `trading/accounts/${encodeURIComponent(editing.id)}/empire-deposit-address`,
      { method: 'GET' },
    );
    setFetchingDeposit(false);
    if (r) setDepositAddress(r.address);
  };
  const keyOk =
    venue !== 'polymarket' ||
    !privateKey.trim() ||
    /^(0x)?[0-9a-fA-F]{64}$/.test(privateKey.trim());
  const missing =
    !label.trim() ||
    (venue === 'csgoempire'
      ? !/^[\w.-]{1,64}$/.test(browserProfile.trim()) ||
        !!loginUsername.trim() !== !!loginPassword ||
        (!!loginPassword && secretKeyConfigured === false) ||
        !!depositErr
      : !!depositErr ||
        !!relayerErr ||
        !evm(walletAddress) ||
        (!!funderAddress.trim() && !evm(funderAddress)) ||
        !keyOk);

  const submit = async () => {
    const config =
      venue === 'csgoempire'
        ? {
            venue,
            browserProfile: browserProfile.trim(),
            usdtDepositAddress: depositAddress.trim() ? addr(depositAddress) : null,
          }
        : {
            venue,
            walletAddress: addr(walletAddress),
            funderAddress: funderAddress.trim() ? addr(funderAddress) : null,
            usdtDepositAddress: depositAddress.trim() ? addr(depositAddress) : null,
            relayerApiKeyAddress: relayerAddress.trim() ? addr(relayerAddress) : null,
          };
    setBusy(true);
    const r = await mutate(
      editing
        ? `trading/accounts/${encodeURIComponent(editing.id)}`
        : 'trading/accounts',
      {
        method: editing ? 'PUT' : 'POST',
        // key chỉ dành cho ví polymarket (đổi nền tảng sau khi gõ key → không gửi)
        body: {
          label: label.trim(),
          enabled,
          config,
          ...(venue === 'polymarket' && privateKey.trim()
            ? { privateKey: privateKey.trim() }
            : {}),
          ...(venue === 'polymarket' && relayerKey.trim()
            ? { relayerApiKey: relayerKey.trim() }
            : {}),
          ...(venue === 'csgoempire' && loginUsername.trim() && loginPassword
            ? { loginUsername: loginUsername.trim(), loginPassword }
            : {}),
        },
      },
      editing ? `Đã lưu ${label.trim()}` : `Đã thêm ${label.trim()}`,
    );
    setBusy(false);
    if (r !== null) {
      setPrivateKey('');
      setLoginUsername('');
      setLoginPassword('');
      onSaved();
    }
  };

  return (
    <Panel
      open={!!value}
      onOpenChange={(v) => !v && onClose()}
      title={
        editing
          ? `Sửa ${editing.label}`
          : venue === 'polymarket'
            ? 'Thêm ví Polymarket'
            : 'Thêm tài khoản csgoempire'
      }
      description="Lưu vào database. Profile đang dùng tài khoản nhận cấu hình mới ngay."
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
            {editing ? 'Lưu' : 'Thêm tài khoản'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        {!editing ? (
          <Field label="Nền tảng" htmlFor="ac-venue">
            <Select
              id="ac-venue"
              value={venue}
              onChange={(e) => {
                setVenue(e.target.value as TradingVenue);
                setPrivateKey('');
                setLoginUsername('');
                setLoginPassword('');
              }}
            >
              <option value="csgoempire">csgoempire (odds sptpub)</option>
              <option value="polymarket">Polymarket</option>
            </Select>
          </Field>
        ) : null}
        <Field
          label="Tên"
          htmlFor="ac-label"
          help="Tên hiển thị, không trùng trong cùng nền tảng, vd “Empire #1”."
        >
          <Input
            id="ac-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={80}
          />
        </Field>
        {venue === 'csgoempire' ? (
          <>
            <Field
              label="Hồ sơ trình duyệt"
              htmlFor="ac-profile"
              help="Thư mục riêng giữ phiên Chromium của tài khoản này. App dùng lại phiên hoặc tự đăng nhập để lấy JWT."
            >
              <Input
                id="ac-profile"
                className="num"
                value={browserProfile}
                onChange={(e) => setBrowserProfile(e.target.value)}
                placeholder="empire-1"
                maxLength={64}
              />
            </Field>
            <Field
              label="Email đăng nhập"
              htmlFor="ac-login-user"
              help={
                editing?.hasSecret
                  ? 'Đã lưu thông tin mã hóa. Để trống cả hai ô để giữ; nhập cả hai để thay.'
                  : 'Nhập tài khoản/email dùng cho form đăng nhập csgoempire.'
              }
            >
              <Input
                id="ac-login-user"
                value={loginUsername}
                onChange={(e) => setLoginUsername(e.target.value)}
                autoComplete="off"
                maxLength={200}
              />
            </Field>
            <Field
              label="Mật khẩu đăng nhập"
              htmlFor="ac-login-password"
              help="Mã hóa AES-256-GCM bằng TRADING_SECRET_KEY trước khi lưu. App gõ vào Chromium khi cần đăng nhập."
              error={
                secretKeyConfigured === false && loginPassword
                  ? 'Backend chưa đặt TRADING_SECRET_KEY.'
                  : undefined
              }
            >
              <Input
                id="ac-login-password"
                type="password"
                autoComplete="new-password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                maxLength={500}
              />
            </Field>
            <Field
              label="Địa chỉ nạp USDT Polygon (tự chuyển tiền)"
              htmlFor="ac-deposit"
              error={depositErr}
              help="Địa chỉ csgoempire cấp ở Deposit → USDT (Polygon). Bấm “Lấy từ csgoempire” rồi ĐỐI CHIẾU với trang csgoempire trước khi lưu. Tự chuyển Polymarket → csgoempire chỉ gửi tới địa chỉ này, và dừng nếu trang csgoempire trả địa chỉ khác. Trống = không tự chuyển chiều này."
            >
              <div className="flex gap-2">
                <Input
                  id="ac-deposit"
                  name="usdt-deposit-address"
                  autoComplete="off"
                  spellCheck={false}
                  data-1p-ignore
                  data-lpignore="true"
                  className="num"
                  value={depositAddress}
                  onChange={(e) => setDepositAddress(e.target.value)}
                  placeholder="0x…"
                />
                {editing ? (
                  <Button
                    variant="secondary"
                    loading={fetchingDeposit}
                    onClick={fetchEmpireDeposit}
                  >
                    Lấy từ csgoempire
                  </Button>
                ) : null}
              </div>
            </Field>
          </>
        ) : (
          <>
            <Field
              label="Địa chỉ ví"
              htmlFor="ac-wallet"
              error={walletErr}
              help="0x + 40 ký tự hex (thiếu 0x sẽ tự thêm)."
            >
              <Input
                id="ac-wallet"
                className="num"
                value={walletAddress}
                onChange={(e) => setWalletAddress(e.target.value)}
                placeholder="0x…"
              />
            </Field>
            <Field
              label="Ví funder (tùy chọn)"
              htmlFor="ac-funder"
              error={funderErr}
              help="Ví proxy Polymarket nếu tài khoản đăng nhập bằng email/ví Polymarket; trống = trả bằng chính ví trên."
            >
              <Input
                id="ac-funder"
                className="num"
                value={funderAddress}
                onChange={(e) => setFunderAddress(e.target.value)}
                placeholder="0x…"
              />
            </Field>
            <Field
              label="Địa chỉ nạp USDT Polygon của Polymarket (tự chuyển tiền)"
              htmlFor="ac-deposit"
              error={depositErr}
              help="Polymarket → Deposit → Crypto → chọn USDT, mạng Polygon → chép địa chỉ. Polymarket tự đổi USDT nhận được thành tiền giao dịch và đưa vào ví. Tự rút csgoempire → Polymarket chỉ rút về địa chỉ này. KHÔNG dùng địa chỉ ví ký / ví proxy. Trống = không tự chuyển chiều này."
            >
              <Input
                id="ac-deposit"
                name="usdt-deposit-address"
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                className="num"
                value={depositAddress}
                onChange={(e) => setDepositAddress(e.target.value)}
                placeholder="0x…"
              />
            </Field>
            <Field
              label="Relayer API Key (tự chuyển tiền)"
              htmlFor="ac-relayer-key"
              help={
                editing?.hasRelayerKey
                  ? 'Đang có key đã mã hóa. Bỏ trống để giữ; nhập key mới để thay.'
                  : 'Cần để app tự chuyển tiền RA khỏi Polymarket (giao dịch gasless). Tạo ở polymarket.com → Settings → API Keys → Relayer API Keys, chép "API Key" vào đây và "Signer Address" vào ô dưới. Mã hóa bằng TRADING_SECRET_KEY, không bao giờ được trả lại.'
              }
            >
              <Input
                id="ac-relayer-key"
                name="polymarket-relayer-key"
                type="password"
                autoComplete="new-password"
                data-1p-ignore
                data-lpignore="true"
                className="num"
                value={relayerKey}
                onChange={(e) => setRelayerKey(e.target.value)}
                placeholder={editing?.hasRelayerKey ? '•••••• (đang lưu)' : undefined}
              />
            </Field>
            <Field
              label="Signer Address của Relayer key"
              htmlFor="ac-relayer-address"
              error={relayerErr}
              help="Địa chỉ hiện cùng API Key khi tạo Relayer API Key."
            >
              <Input
                id="ac-relayer-address"
                name="polymarket-relayer-address"
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                className="num"
                value={relayerAddress}
                onChange={(e) => setRelayerAddress(e.target.value)}
                placeholder="0x…"
              />
            </Field>
            <Field
              label="Private key"
              htmlFor="ac-key"
              error={
                !keyOk
                  ? `Cần đúng 64 ký tự hex, có hoặc không 0x (đang có ${privateKey.trim().replace(/^0x/i, '').length} ký tự). Chạy giấy thì để trống.`
                  : secretKeyConfigured === false && privateKey.trim()
                    ? 'Backend chưa đặt TRADING_SECRET_KEY nên sẽ từ chối lưu key.'
                    : undefined
              }
              help={
                editing?.hasSecret
                  ? 'Đang có key đã mã hóa. Bỏ trống để giữ; nhập key mới để thay.'
                  : 'Mã hóa AES-256-GCM bằng khóa chủ TRADING_SECRET_KEY trước khi lưu, không bao giờ được trả lại. Chế độ giấy chưa cần key.'
              }
            >
              <Input
                id="ac-key"
                name="polymarket-private-key"
                type="password"
                // "off" bị Chrome bỏ qua với ô mật khẩu: new-password để trình duyệt không tự điền mật khẩu đã lưu
                autoComplete="new-password"
                data-1p-ignore
                data-lpignore="true"
                className="num"
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder={
                  editing?.hasSecret ? '•••••• (đang lưu)' : undefined
                }
              />
            </Field>
          </>
        )}
        <Field
          label="Bật tài khoản"
          htmlFor="ac-on"
          help="Tắt = profile dùng tài khoản này đứng yên (ghi lý do vào lệnh)."
        >
          <Switch
            id="ac-on"
            checked={enabled}
            onCheckedChange={setEnabled}
            label="Bật tài khoản"
          />
        </Field>
      </div>
    </Panel>
  );
}
