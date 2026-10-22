'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, BellOff, Siren, Waypoints, Zap } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtMargin, fmtOdds } from '@/lib/format';
import { loadPrefs } from '@/lib/push';
import type { ArbitrageSignal } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useNow } from '@/hooks/use-now';
import { fmtAge } from '@/lib/format';
import { useConsoleData } from '../console-data';
import { Empty } from '../ui/states';

export interface AppNotification {
  id: string;
  kind: 'critical' | 'warning' | 'signal' | 'data';
  title: string;
  body: string;
  at: number;
  href: string;
}

interface Ctx {
  items: AppNotification[];
  unread: number;
  isRead: (id: string) => boolean;
  markRead: (id: string) => void;
  markAllRead: () => void;
}

const NotifCtx = createContext<Ctx | null>(null);
export const useNotifications = () => {
  const v = useContext(NotifCtx);
  if (!v) throw new Error('useNotifications phải nằm trong <NotificationsProvider>');
  return v;
};

const KEY = 'arbops-read';

/**
 * Trung tâm thông báo trong app. Cùng nguồn và cùng mẫu nội dung với push OneSignal:
 * sự cố đang mở, kèo vượt ngưỡng người dùng đặt, dữ liệu bất thường (parse lỗi tăng).
 */
export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const { snapshot, tenants } = useConsoleData();
  const [signals, setSignals] = useState<ArbitrageSignal[]>([]);
  const [read, setRead] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      setRead(new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]));
    } catch {
      /* bỏ qua */
    }
    const load = () => api<ArbitrageSignal[]>('arbitrage/signals').then(setSignals).catch(() => undefined);
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  const items = useMemo<AppNotification[]>(() => {
    const prefs = typeof window === 'undefined' ? null : loadPrefs();
    const threshold = prefs?.signalThreshold ?? 0.03;
    const list: AppNotification[] = [];
    for (const i of snapshot?.incidents ?? []) {
      const taskId = i.key.startsWith('task.') ? i.key.split(':')[1] : null;
      list.push({
        id: `inc:${i.key}:${i.openedAt}`,
        kind: i.severity === 'critical' ? 'critical' : i.kind === 'odds.mass_removal' ? 'data' : 'warning',
        title: i.severity === 'critical' ? `🔴 ${i.title}` : i.title,
        body: i.kind === 'odds.mass_removal' ? 'Có thể do API lỗi — chạm để kiểm tra' : `${i.message} — chạm để xem`,
        at: i.openedAt,
        href:
          i.kind === 'odds.mass_removal'
            ? '/ingest?tenant=polymarket'
            : i.kind === 'trading.reconcile' || i.kind === 'trading.session' || i.kind.startsWith('trading.rebalance')
              ? '/giao-dich'
              : taskId
              ? `/publisher?task=${encodeURIComponent(taskId)}`
              : i.kind.startsWith('consumer')
                ? '/consumer'
                : `/su-co?hl=${encodeURIComponent(i.key)}`,
      });
    }
    for (const s of signals.filter((x) => x.margin >= threshold).slice(0, 6)) {
      const match = s.room.replace(/^room:/, '').replace(/:[^:]+$/, '');
      list.push({
        id: `sig:${s.signalId}`,
        kind: 'signal',
        title: `Kèo ${fmtMargin(s.margin)} · ${s.sport} ${s.teams[0]} vs ${s.teams[1]}`,
        body: `${s.market} · ${s.legs[0].tenant} ${s.legs[0].pick} @ ${fmtOdds(s.legs[0].odds)} | ${s.legs[1].tenant} ${s.legs[1].pick} @ ${fmtOdds(s.legs[1].odds)}`,
        at: s.issuedAt,
        href: `/tran-dau/${encodeURIComponent(match)}?market=${encodeURIComponent(s.market)}`,
      });
    }
    for (const [tenant, r] of Object.entries(tenants)) {
      if (r.parseFailRatio > 0.01 && r.parseFailed > 50)
        list.push({
          id: `data:parse:${tenant}`,
          kind: 'data',
          title: `${tenant}: bản tin sai định dạng tăng`,
          body: `${(r.parseFailRatio * 100).toFixed(1)}% bản tin parse_failed — có thể tenant đổi API`,
          at: r.lastReceivedAt ?? Date.now(),
          href: `/ingest?tenant=${tenant}`,
        });
    }
    return list.sort((a, b) => b.at - a.at);
  }, [snapshot, signals, tenants]);

  const persist = (s: Set<string>) => {
    try {
      localStorage.setItem(KEY, JSON.stringify([...s].slice(-300)));
    } catch {
      /* bỏ qua */
    }
  };
  const markRead = useCallback((id: string) => {
    setRead((old) => {
      const n = new Set(old).add(id);
      persist(n);
      return n;
    });
  }, []);
  const markAllRead = useCallback(() => {
    setRead((old) => {
      const n = new Set(old);
      items.forEach((i) => n.add(i.id));
      persist(n);
      return n;
    });
  }, [items]);

  const value = useMemo<Ctx>(
    () => ({
      items,
      unread: items.filter((i) => !read.has(i.id)).length,
      isRead: (id) => read.has(id),
      markRead,
      markAllRead,
    }),
    [items, read, markRead, markAllRead],
  );
  return <NotifCtx.Provider value={value}>{children}</NotifCtx.Provider>;
}

const ICON = { critical: Siren, warning: AlertTriangle, signal: Zap, data: Waypoints };
const ICON_TONE = { critical: 'text-critical', warning: 'text-warn', signal: 'text-ok', data: 'text-warn' };

/** Một mục thông báo: chấm chưa đọc, biểu tượng loại, tiêu đề, nội dung, tuổi. */
export function NotificationItem({ n, onOpen }: { n: AppNotification; onOpen?: () => void }) {
  const { isRead, markRead } = useNotifications();
  const now = useNow(5_000);
  const Icon = ICON[n.kind];
  const unread = !isRead(n.id);
  const sep = n.href.includes('?') ? '&' : '?';
  return (
    <Link
      href={`${n.href}${sep}from=notif`}
      onClick={() => {
        markRead(n.id);
        onOpen?.();
      }}
      className="group flex gap-3 border-b border-line px-1 py-3.5 last:border-b-0 hover:bg-hover/50 md:px-3"
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0 stroke-[1.5]', ICON_TONE[n.kind])} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cn('min-w-0 flex-1 truncate text-body', unread ? 'font-medium text-fg' : 'text-muted-fg')}>{n.title}</span>
          <span className="num shrink-0 text-micro text-faint">{fmtAge(now - n.at)}</span>
        </div>
        <p className="mt-0.5 line-clamp-2 text-caption text-muted-fg">{n.body}</p>
      </div>
      <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', unread ? 'bg-accent' : 'bg-transparent')} aria-label={unread ? 'Chưa đọc' : undefined} />
    </Link>
  );
}

export function NotificationList({ onOpen, max }: { onOpen?: () => void; max?: number }) {
  const { items } = useNotifications();
  if (!items.length) return <Empty icon={BellOff}>Chưa có thông báo. Sự cố và kèo vượt ngưỡng sẽ xuất hiện ở đây.</Empty>;
  return (
    <div>
      {items.slice(0, max).map((n) => (
        <NotificationItem key={n.id} n={n} onOpen={onOpen} />
      ))}
    </div>
  );
}
