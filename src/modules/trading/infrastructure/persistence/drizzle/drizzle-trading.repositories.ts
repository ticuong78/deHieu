import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { TransactionContext } from '../../../../../shared/infrastructure/database/transaction-context.js';
import {
  DEFAULT_STAKE_PLAN,
  type StakePlan,
} from '../../../domain/stake-plan.js';
import type {
  TradingAccount,
  TradingAccountConfig,
} from '../../../domain/trading-account.js';
import {
  DEFAULT_RISK_LIMITS,
  DEFAULT_STRATEGY,
  type RiskLimits,
  type StrategyRef,
  type TraderMode,
  type TraderProfile,
} from '../../../domain/trader-profile.js';
import {
  DEFAULT_REBALANCE_SETTINGS,
  DEFAULT_TRADING_SETTINGS,
  type TradingSettings,
} from '../../../domain/trading-settings.js';
import type {
  TradeAttempt,
  TradeAttemptQuery,
  TradeSource,
  TradeStatsQuery,
  TradeLeg,
  TradeLegStatus,
  TradePurgeFilter,
  TradeStats,
  TradeStatus,
} from '../../../application/trade-attempt.js';
import {
  SETTLEABLE_STATUSES,
  type SettleWinner,
  type LegResult,
  type SettleSource,
  type TradeSettlement,
  type TradeSettlementRepository,
} from '../../../application/trade-settlement.js';
import type {
  TradeAttemptRepository,
  TraderProfileRepository,
  TradingAccountRepository,
  TradingSettingsStore,
} from '../../../application/trading.ports.js';
import {
  drizzleTradeAttemptsTable as trades,
  drizzleTradeLegsTable as legs,
  drizzleTradeSettlementsTable as settlements,
  drizzleTraderProfilesTable as profiles,
  drizzleTradingAccountsTable as accounts,
  drizzleTradingSettingsTable as settings,
} from './drizzle-trading.schema.js';

type AccountRow = typeof accounts.$inferSelect;
type ProfileRow = typeof profiles.$inferSelect;
type TradeRow = typeof trades.$inferSelect;
type LegRow = typeof legs.$inferSelect;

const ms = (d: Date | null) => (d ? d.getTime() : null);
const date = (n: number | null) => (n === null ? null : new Date(n));

const str = (v: unknown) => (typeof v === 'string' ? v : '');

const toAccount = (r: AccountRow): TradingAccount | null => {
  const c = r.config;
  let config: TradingAccountConfig;
  if (r.venue === 'csgoempire')
    config = {
      venue: 'csgoempire',
      browserProfile: str(c.browserProfile),
      usdtDepositAddress:
        typeof c.usdtDepositAddress === 'string' ? c.usdtDepositAddress : null,
    };
  else if (r.venue === 'polymarket')
    config = {
      venue: 'polymarket',
      walletAddress: str(c.walletAddress),
      funderAddress:
        typeof c.funderAddress === 'string' ? c.funderAddress : null,
      usdtDepositAddress:
        typeof c.usdtDepositAddress === 'string' ? c.usdtDepositAddress : null,
    };
  else return null; // nền tảng không còn hỗ trợ: bỏ qua thay vì làm hỏng cả danh sách
  return {
    id: r.id,
    label: r.label,
    enabled: r.enabled,
    config,
    secretCipher: r.secretCipher,
  };
};

export class DrizzleTradingAccountRepository implements TradingAccountRepository {
  constructor(private readonly _tx: TransactionContext) {}

  async list(): Promise<TradingAccount[]> {
    const rows = await this._tx.executor
      .select()
      .from(accounts)
      .orderBy(asc(accounts.venue), asc(accounts.createdAt));
    return rows.flatMap((r) => toAccount(r) ?? []);
  }

  async get(id: string): Promise<TradingAccount | null> {
    const [r] = await this._tx.executor
      .select()
      .from(accounts)
      .where(eq(accounts.id, id));
    return r ? toAccount(r) : null;
  }

  async save(a: TradingAccount): Promise<void> {
    const { venue, ...config } = a.config;
    const values = {
      id: a.id,
      venue,
      label: a.label,
      enabled: a.enabled,
      config: config as Record<string, unknown>,
      secretCipher: a.secretCipher,
    };
    await this._tx.executor
      .insert(accounts)
      .values(values)
      .onConflictDoUpdate({
        target: accounts.id,
        set: { ...values, updatedAt: new Date() },
      });
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this._tx.executor
      .delete(accounts)
      .where(eq(accounts.id, id))
      .returning({ id: accounts.id });
    return rows.length > 0;
  }
}

// trường mới thêm sau này: bản ghi cũ lấy mặc định
const toProfile = (r: ProfileRow): TraderProfile => ({
  id: r.id,
  name: r.name,
  enabled: r.enabled,
  mode: r.mode as TraderMode,
  csgoempireAccountId: r.csgoempireAccountId,
  polymarketAccountId: r.polymarketAccountId,
  stakePlan: { ...DEFAULT_STAKE_PLAN, ...(r.stakePlan as Partial<StakePlan>) },
  strategy: { ...DEFAULT_STRATEGY, ...(r.strategy as Partial<StrategyRef>) },
  risk: { ...DEFAULT_RISK_LIMITS, ...(r.risk as Partial<RiskLimits>) },
});

export class DrizzleTraderProfileRepository implements TraderProfileRepository {
  constructor(private readonly _tx: TransactionContext) {}

  async list(): Promise<TraderProfile[]> {
    const rows = await this._tx.executor
      .select()
      .from(profiles)
      .orderBy(asc(profiles.createdAt));
    return rows.map(toProfile);
  }

  async get(id: string): Promise<TraderProfile | null> {
    const [r] = await this._tx.executor
      .select()
      .from(profiles)
      .where(eq(profiles.id, id));
    return r ? toProfile(r) : null;
  }

  async save(p: TraderProfile): Promise<void> {
    const values = {
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      mode: p.mode,
      csgoempireAccountId: p.csgoempireAccountId,
      polymarketAccountId: p.polymarketAccountId,
      stakePlan: p.stakePlan as unknown as Record<string, unknown>,
      strategy: p.strategy as unknown as Record<string, unknown>,
      risk: p.risk as unknown as Record<string, unknown>,
    };
    await this._tx.executor
      .insert(profiles)
      .values(values)
      .onConflictDoUpdate({
        target: profiles.id,
        set: { ...values, updatedAt: new Date() },
      });
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this._tx.executor
      .delete(profiles)
      .where(eq(profiles.id, id))
      .returning({ id: profiles.id });
    return rows.length > 0;
  }
}

const toLeg = (r: LegRow): TradeLeg => ({
  venue: r.venue,
  accountId: r.accountId,
  side: r.side,
  pick: r.pick,
  signalPrice: r.signalPrice,
  requestedPrice: r.requestedPrice,
  requestedAmount: r.requestedAmount,
  filledAmount: r.filledAmount,
  avgPrice: r.avgPrice,
  fee: r.fee,
  cost: r.cost,
  status: r.status as TradeLegStatus,
  marketRef: r.marketRef,
  orderRef: r.orderRef,
  sentAt: ms(r.sentAt),
  ackedAt: ms(r.ackedAt),
  filledAt: ms(r.filledAt),
  error: r.error,
  raw: r.raw,
});

const toTrade = (r: TradeRow, legRows: readonly LegRow[]): TradeAttempt => ({
  id: r.id,
  profileId: r.profileId,
  mode: r.mode,
  signalId: r.signalId,
  room: r.room,
  sport: r.sport,
  market: r.market,
  teams: r.teams,
  phase: r.phase,
  comboId: r.comboId,
  status: r.status as TradeStatus,
  reason: r.reason,
  signalMargin: r.signalMargin,
  tierName: r.tierName,
  book: r.book as TradeAttempt['book'],
  polymarket: r.polymarket as TradeAttempt['polymarket'],
  totalCost: r.totalCost,
  payout: r.payout,
  profit: r.profit,
  netMargin: r.netMargin,
  latencyMs: r.latencyMs,
  detail: r.detail,
  createdAt: r.createdAt.getTime(),
  csgoempireAccountId: r.csgoempireAccountId,
  polymarketAccountId: r.polymarketAccountId,
  timing:
    r.signalIssuedAt && r.receivedAt && r.decidedAt
      ? {
          signalIssuedAt: r.signalIssuedAt.getTime(),
          receivedAt: r.receivedAt.getTime(),
          marketDataAt: ms(r.marketDataAt),
          decidedAt: r.decidedAt.getTime(),
        }
      : null,
  legs: legRows.map(toLeg),
});

/** Lệnh người vào tay ở On click mang detail.manual; còn lại là bot. */
const sourceIs = (s: TradeSource): SQL =>
  s === 'manual'
    ? sql`(${trades.detail} -> 'manual') is not null`
    : sql`(${trades.detail} -> 'manual') is null`;

type SettlementRow = typeof settlements.$inferSelect;
const toSettlement = (r: SettlementRow): TradeSettlement => ({
  attemptId: r.attemptId,
  profileId: r.profileId,
  mode: r.mode,
  winner: r.winner as SettleWinner,
  polyPrice: r.polyPrice,
  bookResult: r.bookResult as LegResult,
  bookPnl: r.bookPnl,
  polyPnl: r.polyPnl,
  pnl: r.pnl,
  source: r.source as SettleSource,
  by: r.by,
  resolvedAt: r.resolvedAt.getTime(),
});

/** Bản giấy đối chiếu của lệnh thật: chỉ dùng cho báo cáo thật ↔ giấy, không vào sổ lệnh thường. */
const notShadow = ne(trades.mode, 'shadow');
/** Chỉ hỏi kết quả lệnh trong chừng này (market không bao giờ resolve không nghẽn hàng đợi). */
const SETTLE_WINDOW_MS = 60 * 24 * 3_600_000;

export class DrizzleTradeAttemptRepository
  implements TradeAttemptRepository, TradeSettlementRepository
{
  constructor(private readonly _tx: TransactionContext) {}

  /** Lệnh + các chân trong MỘT transaction; trùng id (worker gửi lại) = bỏ qua cả hai. */
  record(t: TradeAttempt): Promise<void> {
    return this._tx.run(async () => {
      const { legs: legList, timing, ...rest } = t;
      const inserted = await this._tx.executor
        .insert(trades)
        .values({
          ...rest,
          teams: [...t.teams] as [string, string],
          book: t.book as Record<string, unknown> | null,
          polymarket: t.polymarket as Record<string, unknown> | null,
          signalIssuedAt: date(timing?.signalIssuedAt ?? null),
          receivedAt: date(timing?.receivedAt ?? null),
          marketDataAt: date(timing?.marketDataAt ?? null),
          decidedAt: date(timing?.decidedAt ?? null),
          createdAt: new Date(t.createdAt),
        })
        .onConflictDoNothing({ target: trades.id })
        .returning({ id: trades.id });
      if (!inserted.length || !legList.length) return;
      await this._tx.executor.insert(legs).values(
        legList.map((l) => ({
          ...l,
          id: `${t.id}:${l.venue}`,
          attemptId: t.id,
          profileId: t.profileId,
          mode: t.mode,
          sentAt: date(l.sentAt),
          ackedAt: date(l.ackedAt),
          filledAt: date(l.filledAt),
          createdAt: new Date(t.createdAt),
        })),
      );
    });
  }

  async get(id: string): Promise<TradeAttempt | null> {
    const [r] = await this._tx.executor
      .select()
      .from(trades)
      .where(eq(trades.id, id));
    return r ? (await this._withLegs([r]))[0] : null;
  }

  private async _withLegs(rows: readonly TradeRow[]): Promise<TradeAttempt[]> {
    const ids = rows.map((r) => r.id);
    const legRows = ids.length
      ? await this._tx.executor
          .select()
          .from(legs)
          .where(inArray(legs.attemptId, ids))
          .orderBy(asc(legs.venue))
      : [];
    return rows.map((r) =>
      toTrade(
        r,
        legRows.filter((l) => l.attemptId === r.id),
      ),
    );
  }

  async list(q: TradeAttemptQuery): Promise<TradeAttempt[]> {
    const where: SQL[] = [notShadow];
    if (q.profileId) where.push(eq(trades.profileId, q.profileId));
    if (q.status) where.push(eq(trades.status, q.status));
    if (q.source) where.push(sourceIs(q.source));
    if (q.before) where.push(lt(trades.createdAt, new Date(q.before)));
    const rows = await this._tx.executor
      .select()
      .from(trades)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(trades.createdAt))
      .limit(q.limit);
    return this._withLegs(rows);
  }

  async stats(q: TradeStatsQuery): Promise<TradeStats> {
    const where: SQL[] = [notShadow];
    if (q.profileId) where.push(eq(trades.profileId, q.profileId));
    if (q.source) where.push(sourceIs(q.source));
    if (q.since) where.push(gte(trades.createdAt, new Date(q.since)));
    const rows = await this._tx.executor
      .select({
        status: trades.status,
        reason: trades.reason,
        n: sql<number>`count(*)::int`,
        cost: sql<number>`coalesce(sum(${trades.totalCost}), 0)::float8`,
        profit: sql<number>`coalesce(sum(${trades.profit}), 0)::float8`,
      })
      .from(trades)
      .where(where.length ? and(...where) : undefined)
      .groupBy(trades.status, trades.reason);
    const s = {
      attempts: 0,
      filled: 0,
      skipped: 0,
      cancelled: 0,
      errors: 0,
      totalCost: 0,
      profit: 0,
      skipReasons: {} as Record<string, number>,
    };
    for (const r of rows) {
      s.attempts += r.n;
      if (r.status === 'paper_filled' || r.status === 'filled') {
        s.filled += r.n;
        s.totalCost += r.cost;
        s.profit += r.profit;
      } else if (r.status === 'skipped') {
        s.skipped += r.n;
        // lý do dạng "CODE: chi tiết" → gộp theo CODE
        const code = (r.reason ?? 'unknown').split(':')[0];
        s.skipReasons[code] = (s.skipReasons[code] ?? 0) + r.n;
      } else if (r.status === 'cancelled') s.cancelled += r.n;
      else s.errors += r.n;
    }
    return s;
  }

  private _purgeWhere(f: TradePurgeFilter): SQL | undefined {
    const where: SQL[] = [];
    if (f.statuses?.length) where.push(inArray(trades.status, [...f.statuses]));
    if (f.profileId) where.push(eq(trades.profileId, f.profileId));
    if (f.before) where.push(lt(trades.createdAt, new Date(f.before)));
    return where.length ? and(...where) : undefined;
  }

  async count(f: TradePurgeFilter): Promise<number> {
    const [r] = await this._tx.executor
      .select({ n: sql<number>`count(*)::int` })
      .from(trades)
      .where(this._purgeWhere(f));
    return r?.n ?? 0;
  }

  /** Chân trước, lệnh sau, trong MỘT transaction (không có khóa ngoại cascade). */
  purge(f: TradePurgeFilter): Promise<number> {
    return this._tx.run(async () => {
      const where = this._purgeWhere(f);
      if (where) {
        const ids = this._tx.executor
          .select({ id: trades.id })
          .from(trades)
          .where(where);
        await this._tx.executor
          .delete(legs)
          .where(inArray(legs.attemptId, ids));
        await this._tx.executor
          .delete(settlements)
          .where(inArray(settlements.attemptId, ids));
      } else {
        await this._tx.executor.delete(legs);
        await this._tx.executor.delete(settlements);
      }
      const rows = await this._tx.executor
        .delete(trades)
        .where(where)
        .returning({ id: trades.id });
      return rows.length;
    });
  }

  /** Xóa lệnh kèm các chân, kết quả và bản giấy đối chiếu của nó. */
  delete(id: string): Promise<boolean> {
    return this._tx.run(async () => {
      const ids = [id, `${id}:shadow`];
      await this._tx.executor.delete(legs).where(inArray(legs.attemptId, ids));
      await this._tx.executor
        .delete(settlements)
        .where(inArray(settlements.attemptId, ids));
      await this._tx.executor
        .delete(trades)
        .where(eq(trades.id, `${id}:shadow`));
      const rows = await this._tx.executor
        .delete(trades)
        .where(eq(trades.id, id))
        .returning({ id: trades.id });
      return rows.length > 0;
    });
  }

  // ------------------------------------------------------------- kết quả lệnh

  async pendingSettlement(before: number, limit: number) {
    const rows = await this._tx.executor
      .select({ t: trades })
      .from(trades)
      .leftJoin(settlements, eq(settlements.attemptId, trades.id))
      .where(
        and(
          isNull(settlements.attemptId),
          inArray(trades.status, SETTLEABLE_STATUSES),
          lt(trades.createdAt, new Date(before)),
          gte(trades.createdAt, new Date(before - SETTLE_WINDOW_MS)),
          sql`coalesce(${trades.polymarket} ->> 'tokenId', '') <> ''`,
        ),
      )
      .orderBy(asc(trades.createdAt))
      .limit(limit);
    return this._withLegs(rows.map((r) => r.t));
  }

  async getSettlement(attemptId: string) {
    const [r] = await this._tx.executor
      .select()
      .from(settlements)
      .where(eq(settlements.attemptId, attemptId));
    return r ? toSettlement(r) : null;
  }

  async saveSettlement(st: TradeSettlement) {
    const row = { ...st, resolvedAt: new Date(st.resolvedAt) };
    const set: Partial<typeof row> = { ...row };
    delete set.attemptId;
    await this._tx.executor
      .insert(settlements)
      .values(row)
      .onConflictDoUpdate({
        target: settlements.attemptId,
        set: { ...set, updatedAt: new Date() },
      });
  }

  async deleteSettlement(attemptId: string) {
    const rows = await this._tx.executor
      .delete(settlements)
      .where(eq(settlements.attemptId, attemptId))
      .returning({ id: settlements.attemptId });
    return rows.length > 0;
  }

  async accountTrades(q: {
    readonly accountId: string;
    readonly since?: number;
    readonly limit: number;
  }) {
    const where: SQL[] = [
      or(
        eq(trades.csgoempireAccountId, q.accountId),
        eq(trades.polymarketAccountId, q.accountId),
      )!,
      inArray(trades.status, SETTLEABLE_STATUSES),
    ];
    if (q.since) where.push(gte(trades.createdAt, new Date(q.since)));
    const rows = await this._tx.executor
      .select({ t: trades, s: settlements })
      .from(trades)
      .leftJoin(settlements, eq(settlements.attemptId, trades.id))
      .where(and(...where))
      .orderBy(desc(trades.createdAt))
      .limit(q.limit);
    const withLegs = await this._withLegs(rows.map((r) => r.t));
    return withLegs.map((trade, i) => {
      const st = rows[i].s;
      return { trade, settlement: st ? toSettlement(st) : null };
    });
  }
}

const SETTINGS_KEY = 'trading';

export class DrizzleTradingSettingsStore implements TradingSettingsStore {
  constructor(private readonly _tx: TransactionContext) {}

  async get(): Promise<TradingSettings> {
    const [r] = await this._tx.executor
      .select()
      .from(settings)
      .where(eq(settings.key, SETTINGS_KEY));
    const v = (r?.value as Partial<TradingSettings> | undefined) ?? {};
    return {
      ...DEFAULT_TRADING_SETTINGS,
      ...v,
      // bản ghi cũ chưa có / thiếu trường → mặc định (tắt)
      rebalance: { ...DEFAULT_REBALANCE_SETTINGS, ...(v.rebalance ?? {}) },
    };
  }

  async save(s: TradingSettings): Promise<void> {
    await this._tx.executor
      .insert(settings)
      .values({ key: SETTINGS_KEY, value: s })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: s, updatedAt: new Date() },
      });
  }
}
