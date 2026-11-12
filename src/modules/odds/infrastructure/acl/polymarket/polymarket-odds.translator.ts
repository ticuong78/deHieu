import type { TaskDataMessage } from '../../../../tasks/application/task-protocol.js';
import type {
  OddsLineChange,
  RawOddsTranslator,
} from '../../../application/raw-odds.translator.js';
import type { TeamNameResolver } from '../../../application/team-name.resolver.js';
import {
  NO_SKIP_REPORTER,
  type SkipReporter,
} from '../../../application/ingest-stats.js';
import { MatchKey, type Side } from '../../../domain/match-key.js';
import { OddsLine } from '../../../domain/odds-line.js';
import type { Phase } from '../../../domain/phase.js';
import {
  PolymarketEventSchema,
  PolymarketEventsPayloadSchema,
  PolymarketMarketSchema,
  PolymarketStreamEventSchema,
  type PolymarketMarketDTO,
} from './polymarket.dto.js';
import {
  POLYMARKET_MARKETS,
  polymarketSportOf,
  supportsPolymarketMarket,
} from './polymarket-odds.mapping.js';
import { TournamentOrder } from '../tournament-order.js';

interface MarketRoute {
  key: MatchKey | null;
  sport: string;
  rawTeams: readonly [string, string];
  sourceMarket: PolymarketMarketDTO;
  updatedAt: number;
  startsAt: number;
  conditionId: string;
  slug: string;
  eventUrl: string;
  tokens: [string, string]; // token theo thứ tự đội của MatchKey
  asks: [number | null, number | null];
  /** Task 'polymarket.descriptor' đã khai báo market này. */
  taskId: string;
  /** Trận đang live hay chưa — cập nhật mỗi lần descriptor làm mới danh sách trận. */
  phase: Phase;
  /** Event (trận) chứa market này — để đếm thứ tự trận trong giải. */
  eventId: string;
  /** Tên giải (series) để hiển thị. */
  tourLabel: string | null;
}

/** Đồng bộ tập token cần theo dõi với task stream (module nối vào lệnh của task). */
export type SyncAssets = (
  op: 'subscribe' | 'unsubscribe',
  assetIds: string[],
) => Promise<void>;

/** Kết quả một vòng đối chiếu danh sách market của task descriptor. */
export interface CycleReport {
  readonly taskId: string;
  readonly known: number;
  readonly seen: number;
  readonly pending: number;
  readonly removed: number;
  readonly held: number;
  readonly ratio: number;
  readonly massive: boolean;
}

export interface ReconcileOptions {
  /** Vắng mặt ngần này vòng LIÊN TIẾP mới gỡ (chống lệch phân trang khi danh sách đang đổi). */
  readonly missingCycles: number;
  /** Tỉ lệ market đủ điều kiện gỡ / market đang sở hữu vượt ngưỡng này = bất thường. */
  readonly massiveRatio: number;
  /** Chỉ coi là bất thường khi task sở hữu ít nhất ngần này market. */
  readonly massiveMinKnown: number;
  /** Bất thường thì giữ lại (không gỡ) tối đa ngần này vòng, sau đó vẫn gỡ. */
  readonly maxHeldCycles: number;
}

export const DEFAULT_RECONCILE_OPTIONS: ReconcileOptions = {
  missingCycles: 2,
  massiveRatio: 0.3,
  massiveMinKnown: 10,
  maxHeldCycles: 5,
};

/**
 * ACL Polymarket. Mỗi đội là một token có ask riêng → odds = 1 / best_ask của token đội đó.
 * Giữ bảng định tuyến token → market (lấy từ task 'polymarket.descriptor'); live/prematch tách theo trạng thái trận.
 */
export class PolymarketOddsTranslator implements RawOddsTranslator {
  readonly tenant = 'polymarket';
  readonly kinds = ['polymarket.descriptor', 'polymarket.stream'] as const;
  private readonly _markets = new Map<string, MarketRoute>(); // conditionId → route
  private readonly _tokens = new Map<
    string,
    { conditionId: string; side: Side }
  >();

  constructor(
    private readonly _teams: TeamNameResolver,
    private readonly _sync: SyncAssets = () => Promise.resolve(),
    /** Báo dữ liệu bị bỏ qua (theo lý do) cho bộ đếm ingest. */
    private readonly _skip: SkipReporter = NO_SKIP_REPORTER,
    /** Báo kết quả mỗi vòng đối chiếu (admin: sự cố khi gỡ hàng loạt). */
    private readonly _onCycle: (r: CycleReport) => void = () => undefined,
    private readonly _reconcile: ReconcileOptions = DEFAULT_RECONCILE_OPTIONS,
  ) {}

  /** taskId → conditionId đã thấy trong vòng quét đang chạy. */
  private readonly _cycleSeen = new Map<string, Set<string>>();
  /** conditionId → số vòng liên tiếp vắng mặt. */
  private readonly _misses = new Map<string, number>();
  /** taskId → số vòng liên tiếp đã giữ lại vì gỡ hàng loạt bất thường. */
  private readonly _held = new Map<string, number>();
  /** Thứ tự trận trong giải (series của event), gắn vào ref của dòng kèo. */
  private readonly _order = new TournamentOrder();

  translate(msg: TaskDataMessage): Promise<OddsLineChange[]> {
    if (msg.kind === 'polymarket.descriptor') {
      if (msg.channel === 'cycle-start') {
        this._cycleSeen.set(msg.taskId, new Set());
        return Promise.resolve([]);
      }
      if (msg.channel === 'cycle-complete') return this._onCycleComplete(msg);
      return this._onEvents(msg);
    }
    if (msg.kind === 'polymarket.stream')
      return Promise.resolve(this._onStream(msg));
    return Promise.resolve([]);
  }

  private async _onEvents(msg: TaskDataMessage): Promise<OddsLineChange[]> {
    const page = PolymarketEventsPayloadSchema.safeParse(msg.payload);
    if (!page.success) {
      this._skip(msg.kind, 'parse_failed');
      return [];
    }
    const changes: OddsLineChange[] = [];
    const dropped: string[] = [];

    // đếm thứ tự trận trong giải cho CẢ trang trước, để dòng kèo đầu tiên cũng có tổng số đúng
    for (const raw of page.data) {
      const ev = PolymarketEventSchema.safeParse(raw);
      const sport =
        ev.success && ev.data.sports.sport
          ? polymarketSportOf(ev.data.sports.sport)
          : null;
      if (!ev.success || !sport) continue;
      const series = ev.data.series?.[0];
      const tourKey = series?.id
        ? `${sport}:s${series.id}`
        : ev.data.sports.seriesSlug
          ? `${sport}:${ev.data.sports.seriesSlug}`
          : null;
      const eventStart = Date.parse(ev.data.schedule.startTime ?? '');
      if (tourKey && Number.isFinite(eventStart))
        this._order.set(ev.data.id, tourKey, eventStart);
    }

    for (const raw of page.data) {
      const ev = PolymarketEventSchema.safeParse(raw);
      if (!ev.success) {
        this._skip(msg.kind, 'parse_failed');
        continue;
      }
      const sport = ev.data.sports.sport
        ? polymarketSportOf(ev.data.sports.sport)
        : null;
      if (!sport) {
        this._skip(msg.kind, 'unsupported_sport');
        continue;
      }
      const tourLabel = this._tourLabel(ev.data);
      // market có outcome không phải tên đội (vd totals: Over/Under) lấy cặp đội từ moneyline của event
      const eventTeams = this._eventTeams(ev.data, sport);

      for (const rawMarket of ev.data.markets) {
        const parsed = PolymarketMarketSchema.safeParse(rawMarket);
        if (!parsed.success) {
          this._skip(msg.kind, 'parse_failed');
          continue;
        }
        const m = parsed.data;
        const mapping = POLYMARKET_MARKETS[m.sports.sportsMarketType ?? ''];
        const startIso = m.sports.gameStartTime ?? ev.data.schedule.startTime;
        const { yes, no } = m.outcomes;
        if (!mapping) {
          this._skip(msg.kind, 'unsupported_market');
          continue;
        }
        if (!supportsPolymarketMarket(sport, m.sports.sportsMarketType ?? '')) {
          this._skip(msg.kind, 'unsupported_market');
          continue;
        }
        if (!m.conditionId || !startIso || !yes.tokenId || !no.tokenId) {
          this._skip(msg.kind, 'missing_fields');
          continue;
        }

        let names: [string, string];
        let rawTeams: [string, string];
        let yesFirst: boolean;
        if (mapping.outcomesBy === 'team') {
          rawTeams = [yes.label, no.label];
          names = [
            this._teams.resolve(yes.label),
            this._teams.resolve(no.label),
          ];
          if (!names[0] || !names[1] || names[0] === names[1]) {
            this._skip(msg.kind, 'same_team_names');
            continue;
          }
          // đội của outcome yes có phải teams[0] không: quyết định thứ tự token và dấu mức chấp
          yesFirst = MatchKey.isFirst(names[0], names[1]);
        } else {
          if (!eventTeams) {
            // không biết trận của đội nào → không ghép được
            this._skip(msg.kind, 'no_moneyline_teams');
            continue;
          }
          rawTeams = eventTeams;
          names = [
            this._teams.resolve(rawTeams[0]),
            this._teams.resolve(rawTeams[1]),
          ];
          if (!names[0] || !names[1] || names[0] === names[1]) {
            this._skip(msg.kind, 'same_team_names');
            continue;
          }
          yesFirst = true; // yes/no đã là side 0/side 1 (vd over/under), giữ nguyên
        }
        const market = mapping.toMarket(m, yesFirst, sport);
        if (!market) {
          this._skip(msg.kind, 'unsupported_line'); // mức/mốc/số map không hỗ trợ
          continue;
        }
        const key = MatchKey.of({
          sport,
          teamX: names[0],
          teamY: names[1],
          market,
        });

        if (m.state.closed || m.state.acceptingOrders === false) {
          const known = this._markets.get(m.conditionId);
          dropped.push(...this._dropMarket(m.conditionId));
          changes.push({
            type: 'remove',
            key: known?.key ?? key,
            tenant: this.tenant,
            phase: known?.phase ?? 'prematch',
          });
          continue;
        }

        const flip = !yesFirst;
        const tokens: [string, string] = flip
          ? [no.tokenId, yes.tokenId]
          : [yes.tokenId, no.tokenId];
        // seed từ snapshot: ask(yes) = bestAsk, ask(no) ≈ 1 - bestBid; stream sẽ cập nhật chính xác
        const seed: [number | null, number | null] = [
          validAsk(m.prices.bestAsk),
          validAsk(m.prices.bestBid != null ? 1 - m.prices.bestBid : null),
        ];

        const startsAt = Date.parse(startIso);
        this._cycleSeen.get(msg.taskId)?.add(m.conditionId);
        let route = this._markets.get(m.conditionId);
        // LIVE khi: Polymarket báo live, HOẶC đã quá giờ bắt đầu, HOẶC trước đó đã live. Cờ live của
        // Polymarket hay trễ (trận esports đang đánh mà trang vẫn chưa gắn live) — tin giờ bắt đầu, và
        // không bao giờ quay ngược live → prematch.
        const phase: Phase =
          ev.data.state?.live === true ||
          startsAt <= msg.sentAt ||
          route?.phase === 'live'
            ? 'live'
            : 'prematch';
        const eventUrl = ev.data.slug
          ? `https://polymarket.com/event/${encodeURIComponent(ev.data.slug)}`
          : '';
        if (route) {
          route.rawTeams = rawTeams;
          route.sourceMarket = m;
          route.startsAt = startsAt;
          route.eventId = ev.data.id;
          route.tourLabel = tourLabel;
          changes.push(...this._reindexRoute(route, false));
          route.phase = phase; // trận chuyển prematch → live
          if (eventUrl) route.eventUrl = eventUrl;
        } else {
          const created: MarketRoute = {
            key,
            sport,
            rawTeams,
            sourceMarket: m,
            updatedAt: msg.sentAt,
            startsAt,
            conditionId: m.conditionId,
            slug: m.slug ?? ev.data.slug ?? '',
            eventUrl,
            tokens,
            asks: flip ? [seed[1], seed[0]] : seed,
            taskId: msg.taskId,
            phase,
            eventId: ev.data.id,
            tourLabel,
          };
          route = created;
          this._markets.set(m.conditionId, created);
          tokens.forEach((t, i) =>
            this._tokens.set(t, {
              conditionId: created.conditionId,
              side: i as Side,
            }),
          );
        }
        const change = this._toChange(route, msg.sentAt);
        if (change) changes.push(change);
      }
    }

    // gửi TOÀN BỘ token đang biết: lệnh idempotent, đồng thời tự phục hồi khi task stream khởi động lại
    if (this._tokens.size)
      await this._sync('subscribe', [...this._tokens.keys()]);
    if (dropped.length) await this._sync('unsubscribe', dropped);
    return changes;
  }

  /**
   * Hết một vòng quét: market do task này khai báo mà vắng mặt `missingCycles` vòng liên tiếp → gỡ
   * (missing_from_listing). Nếu số market phải gỡ bất thường (API lỗi trả thiếu?) thì giữ lại tối đa
   * `maxHeldCycles` vòng và báo ra ngoài; vòng không có cycle-start hoặc 0 trang → không đối chiếu.
   */
  private async _onCycleComplete(
    msg: TaskDataMessage,
  ): Promise<OddsLineChange[]> {
    const seen = this._cycleSeen.get(msg.taskId);
    this._cycleSeen.delete(msg.taskId);
    const pages = (msg.payload as { pages?: unknown } | null)?.pages;
    if (!seen || typeof pages !== 'number' || pages === 0) return [];

    const opts = this._reconcile;
    const owned = [...this._markets.values()].filter(
      (r) => r.taskId === msg.taskId,
    );
    const due: MarketRoute[] = [];
    let pending = 0;
    for (const r of owned) {
      if (seen.has(r.conditionId)) {
        this._misses.delete(r.conditionId);
        continue;
      }
      const n = (this._misses.get(r.conditionId) ?? 0) + 1;
      this._misses.set(r.conditionId, n);
      if (n >= opts.missingCycles) due.push(r);
      else pending++;
    }

    const ratio = owned.length ? due.length / owned.length : 0;
    const massive =
      owned.length >= opts.massiveMinKnown && ratio > opts.massiveRatio;
    const heldCycles = this._held.get(msg.taskId) ?? 0;
    const hold = massive && heldCycles < opts.maxHeldCycles;
    if (hold) this._held.set(msg.taskId, heldCycles + 1);
    else this._held.delete(msg.taskId);

    const changes: OddsLineChange[] = [];
    const dropped: string[] = [];
    if (!hold)
      for (const r of due) {
        if (r.key)
          changes.push({
            type: 'remove',
            key: r.key,
            tenant: this.tenant,
            phase: r.phase,
            reason: 'missing_from_listing',
          });
        dropped.push(...this._dropMarket(r.conditionId));
      }
    if (dropped.length) await this._sync('unsubscribe', dropped);

    this._onCycle({
      taskId: msg.taskId,
      known: owned.length,
      seen: owned.length - due.length - pending,
      pending,
      removed: hold ? 0 : due.length,
      held: hold ? due.length : 0,
      ratio,
      massive,
    });
    return changes;
  }

  private _onStream(msg: TaskDataMessage): OddsLineChange[] {
    const ev = PolymarketStreamEventSchema.safeParse(msg.payload);
    if (!ev.success) {
      this._skip(msg.kind, 'parse_failed');
      return [];
    }
    const e = ev.data;
    if (
      e.type === 'last_trade_price' ||
      e.type === 'tick_size_change' ||
      e.type === 'new_market'
    ) {
      this._skip(msg.kind, 'unsupported_event');
      return [];
    }
    const touched = new Set<string>();
    const changes: OddsLineChange[] = [];

    if (e.type === 'price_change')
      e.payload.priceChanges.forEach((p) =>
        this._setAsk(p.assetId, p.bestAsk, touched, msg.kind),
      );
    else if (e.type === 'best_bid_ask')
      this._setAsk(e.payload.assetId, e.payload.bestAsk, touched, msg.kind);
    else if (e.type === 'book') {
      const best = Math.min(...e.payload.asks.map((a) => a.price));
      this._setAsk(
        e.payload.assetId,
        Number.isFinite(best) ? best : null,
        touched,
        msg.kind,
      );
    } else if (e.type === 'market_resolved') {
      for (const t of e.payload.assetIds ?? []) {
        const cid = this._tokens.get(t)?.conditionId;
        const route = cid ? this._markets.get(cid) : undefined;
        if (route) {
          if (route.key)
            changes.push({
              type: 'remove',
              key: route.key,
              tenant: this.tenant,
              phase: route.phase,
            });
          this._dropMarket(route.conditionId);
        }
      }
    }

    for (const cid of touched) {
      const route = this._markets.get(cid);
      const change = route && this._toChange(route, msg.sentAt);
      if (change) changes.push(change);
    }
    return changes;
  }

  async release(taskId: string, kind: string): Promise<OddsLineChange[]> {
    const changes: OddsLineChange[] = [];

    if (kind === 'polymarket.stream') {
      // mất nguồn giá: gỡ dòng, giữ bảng định tuyến; giá về lại khi có task stream mới
      for (const route of this._markets.values()) {
        route.asks = [null, null];
        if (route.key)
          changes.push({
            type: 'remove',
            key: route.key,
            tenant: this.tenant,
            phase: route.phase,
          });
      }
    } else if (kind === 'polymarket.descriptor') {
      this._cycleSeen.delete(taskId);
      this._held.delete(taskId);
      // mất nguồn danh sách trận: gỡ mọi market do task này khai báo
      const dropped: string[] = [];
      for (const route of [...this._markets.values()])
        if (route.taskId === taskId) {
          if (route.key)
            changes.push({
              type: 'remove',
              key: route.key,
              tenant: this.tenant,
              phase: route.phase,
            });
          dropped.push(...this._dropMarket(route.conditionId));
        }
      if (dropped.length) await this._sync('unsubscribe', dropped);
    }
    return changes;
  }

  reindexTeams(): OddsLineChange[] {
    const changes = [...this._markets.values()].flatMap((route) =>
      this._reindexRoute(route),
    );
    return [
      ...changes.filter((c) => c.type === 'remove'),
      ...changes.filter((c) => c.type === 'set'),
    ];
  }

  private _reindexRoute(route: MarketRoute, emit = true): OddsLineChange[] {
    const mapping =
      POLYMARKET_MARKETS[route.sourceMarket.sports.sportsMarketType ?? ''];
    const names = route.rawTeams.map((name) => this._teams.resolve(name));
    const valid = !!names[0] && !!names[1] && names[0] !== names[1];
    const yesFirst =
      mapping.outcomesBy === 'side' ||
      (valid && MatchKey.isFirst(names[0], names[1]));
    const market = mapping.toMarket(route.sourceMarket, yesFirst, route.sport);
    const key =
      valid && market
        ? MatchKey.of({
            sport: route.sport,
            teamX: names[0],
            teamY: names[1],
            market,
          })
        : null;
    if (key?.toString() === route.key?.toString()) return [];
    const changes: OddsLineChange[] = route.key
      ? [
          {
            type: 'remove',
            key: route.key,
            tenant: this.tenant,
            phase: route.phase,
          },
        ]
      : [];
    route.key = key;
    if (!key) return changes;

    // Prices belong to tokens, not alphabetic team positions; aliases can reverse them.
    const asks = new Map(
      route.tokens.map((token, i) => [token, route.asks[i]! as number | null]),
    );
    const { yes, no } = route.sourceMarket.outcomes;
    route.tokens = yesFirst
      ? [yes.tokenId!, no.tokenId!]
      : [no.tokenId!, yes.tokenId!];
    route.asks = [
      asks.get(route.tokens[0]) ?? null,
      asks.get(route.tokens[1]) ?? null,
    ];
    route.tokens.forEach((token, side) =>
      this._tokens.set(token, {
        conditionId: route.conditionId,
        side: side as Side,
      }),
    );
    const change = emit ? this._toChange(route, route.updatedAt) : null;
    if (change) changes.push(change);
    return changes;
  }

  private _setAsk(
    assetId: string,
    ask: number | null | undefined,
    touched: Set<string>,
    kind: string,
  ) {
    const t = this._tokens.get(assetId);
    const route = t && this._markets.get(t.conditionId);
    if (!t || !route) {
      this._skip(kind, 'unknown_asset');
      return;
    }
    route.asks[t.side] = validAsk(ask);
    touched.add(t.conditionId);
  }

  private _toChange(r: MarketRoute, at: number): OddsLineChange | null {
    if (!r.key) return null;
    r.updatedAt = at;
    const a = validAsk(r.asks[0]);
    const b = validAsk(r.asks[1]);
    const open = a !== null && b !== null;
    return {
      type: 'set',
      key: r.key,
      line: OddsLine.create({
        tenant: this.tenant,
        odds: open ? [1 / a, 1 / b] : [1.01, 1.01],
        status: open ? 'open' : 'suspended',
        phase: r.phase,
        updatedAt: at,
        startsAt: r.startsAt,
        ref: {
          c: r.conditionId,
          slug: r.slug,
          url: r.eventUrl,
          t0: r.tokens[0],
          t1: r.tokens[1],
          // trận thứ tno / tof trong giải `tour` (theo các trận Polymarket đang liệt kê)
          ...this._order.refFields(r.eventId, r.tourLabel),
        },
      }),
    };
  }

  /** Tên giải (series) để hiển thị. */
  private _tourLabel(e: {
    series?: { slug?: string | null; title?: string | null }[] | null;
    sports: { seriesSlug?: string | null };
  }): string | null {
    const s = e.series?.[0];
    return s?.title ?? s?.slug ?? e.sports.seriesSlug ?? null;
  }

  /** Original names from moneyline; retain them so aliases can also be deleted. */
  private _eventTeams(
    event: {
      markets: readonly unknown[];
      sports: { teams?: { name: string }[] | null };
    },
    sport: string,
  ): [string, string] | null {
    const teams = event.sports.teams;
    if (sport === 'soccer' && teams?.length === 2) {
      const [a, b] = teams.map((t) => t.name);
      if (a && b && a !== b) return [a, b];
    }
    for (const raw of event.markets) {
      const p = PolymarketMarketSchema.safeParse(raw);
      if (!p.success || p.data.sports.sportsMarketType !== 'moneyline')
        continue;
      const a = p.data.outcomes.yes.label;
      const b = p.data.outcomes.no.label;
      return a && b && a !== b ? [a, b] : null;
    }
    return null;
  }

  /** Trả về các token bị bỏ. */
  private _dropMarket(conditionId: string): string[] {
    const r = this._markets.get(conditionId);
    r?.tokens.forEach((t) => this._tokens.delete(t));
    this._markets.delete(conditionId);
    this._misses.delete(conditionId);
    // event không còn market nào → bỏ khỏi thứ tự giải
    if (r && ![...this._markets.values()].some((x) => x.eventId === r.eventId))
      this._order.delete(r.eventId);
    return r ? [...r.tokens] : [];
  }
}

/**
 * Giá (xác suất) dùng được để tính odds = 1/giá: phải nằm trong (0, 1).
 * Giá 1 (chắc thắng / market sắp đóng) hoặc 0 (không có lệnh) → coi như không có giá → dòng suspended.
 */
function validAsk(ask: number | null | undefined): number | null {
  return ask != null && Number.isFinite(ask) && ask > 0 && ask < 1 ? ask : null;
}
