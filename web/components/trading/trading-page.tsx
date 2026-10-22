'use client';

import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import type { TradingSettings } from '@/lib/trading-types';
import { useApi } from '@/hooks/use-api';
import { useGuard, useMutate } from '../shell/shell-context';
import { Button } from '../ui/button';
import { Field, Segmented } from '../ui/controls';
import { PageHeader, Section } from '../ui/layout';
import { Pill } from '../ui/status';
import { ExposureLedger } from './exposure-ledger';
import { PaperTrades } from './paper-trades';
import { RebalancePanel, RebalanceSettingsSection } from './rebalance-panel';
import { NumInput } from './stake-plan-editor';
import { TraderProfiles } from './trader-profiles';
import { TradingAccounts } from './trading-accounts';

type Tab = 'trades' | 'profiles' | 'accounts' | 'settings';

export function TradingPage() {
  const [tab, setTab] = useState<Tab>('trades');
  const settings = useApi<TradingSettings>('trading/settings', 30_000);
  return (
    <div>
      <PageHeader
        title="Auto trade"
        description="Mỗi profile gồm một tài khoản csgoempire, một ví Polymarket và bảng vốn theo hạng kèo. Auto trade và On click dùng chung cấu hình; chọn chế độ giấy hoặc thật trong profile."
        meta={
          <>
            <Pill tone="muted">Theo cấu hình profile</Pill>
            {settings.data && !settings.data.secretKeyConfigured ? (
              <span className="flex items-center gap-1.5 text-caption text-warn">
                <ShieldAlert className="size-3.5" /> Chưa đặt TRADING_SECRET_KEY
              </span>
            ) : null}
          </>
        }
      />
      <RebalancePanel />
      <div className="mb-8">
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'trades', label: 'Lệnh giao dịch' },
            { value: 'profiles', label: 'Profile' },
            { value: 'accounts', label: 'Tài khoản' },
            { value: 'settings', label: 'Giới hạn chung' },
          ]}
        />
      </div>
      {tab === 'trades' ? <PaperTrades /> : null}
      {tab === 'profiles' ? <TraderProfiles /> : null}
      {tab === 'accounts' ? (
        <TradingAccounts
          secretKeyConfigured={settings.data?.secretKeyConfigured ?? null}
        />
      ) : null}
      {tab === 'settings' ? (
        <>
          <GlobalLimits
            settings={settings.data}
            onSaved={() => void settings.reload()}
          />
          <RebalanceSettingsSection
            settings={settings.data}
            onSaved={() => void settings.reload()}
          />
          <ExposureLedger />
        </>
      ) : null}
    </div>
  );
}

function GlobalLimits({
  settings,
  onSaved,
}: {
  settings: TradingSettings | null;
  onSaved: () => void;
}) {
  const manage = useGuard('trading:manage');
  const mutate = useMutate();
  const [cap, setCap] = useState(500);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (settings) setCap(settings.matchExposureCapUsd);
  }, [settings]);
  const dirty = !!settings && cap !== settings.matchExposureCapUsd;

  return (
    <Section
      title="Giới hạn chung"
      description="Áp cho MỌI profile và tài khoản cùng lúc (đếm chung qua Redis)."
    >
      <div className="max-w-md">
        <Field
          label="Tổng tiền tối đa mỗi trận ($)"
          htmlFor="cap"
          help={
            cap > 0
              ? `Mọi trader cộng lại không vào quá ${cap}$ (cả hai chân) cho một trận, gộp mọi market của trận. Đặt 0 để tắt.`
              : 'Đang tắt: không giới hạn tổng theo trận (mỗi profile vẫn có giới hạn riêng nếu đặt).'
          }
        >
          <NumInput
            id="cap"
            value={cap}
            onValue={(v) => v !== undefined && setCap(v)}
          />
        </Field>
        <div className="mt-6 flex gap-2">
          <Button
            variant="primary"
            disabled={!dirty}
            loading={busy}
            disabledReason={manage}
            onClick={async () => {
              setBusy(true);
              const r = await mutate(
                'trading/settings',
                { method: 'PUT', body: { matchExposureCapUsd: cap } },
                'Đã lưu giới hạn chung',
              );
              setBusy(false);
              if (r !== null) onSaved();
            }}
          >
            Lưu
          </Button>
          {dirty ? (
            <Button
              variant="ghost"
              onClick={() => settings && setCap(settings.matchExposureCapUsd)}
            >
              Hoàn tác
            </Button>
          ) : null}
        </div>
      </div>
    </Section>
  );
}
