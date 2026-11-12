import type { QueryHandler } from '../../../../shared/application/cqrs.js';
import type { OddsRoom } from '../../domain/odds-room.js';
import type { Phase } from '../../domain/phase.js';
import {
  findMatchCandidates,
  type MatchCandidate,
  type MatchSummary,
} from '../../domain/match-candidates.js';
import type { ArbitrageSettingsStore } from '../arbitrage-settings.js';
import type { OddsRoomStore } from '../odds-room.store.js';
import type { TeamNameResolver } from '../team-name.resolver.js';

export interface ListMatchesQuery {
  readonly q?: string;
  readonly sport?: string;
  readonly tenant?: string;
  readonly phase?: Phase;
  /** true = trận có ít nhất một market ≥ 2 tenant. */
  readonly matched?: boolean;
  readonly limit: number;
  readonly offset: number;
}

/** Một trận = mọi room cùng sport + cặp đội (khác market). */
export interface MatchListItem {
  /** Id: GET /arbitrage/matches/{match}, topic stream `match:{match}`. */
  readonly match: string;
  readonly sport: string;
  readonly teams: readonly [string, string];
  readonly tenants: readonly string[];
  /** Số market (room) đang có của trận. */
  readonly markets: number;
  /** Số market có ≥ 2 tenant. */
  readonly matchedMarkets: number;
  /** tenant → số market tenant đó có. */
  readonly coverage: Readonly<Record<string, number>>;
  readonly phases: readonly Phase[];
  /** Margin tốt nhất trên mọi market; null = chưa có tổ hợp nào. */
  readonly bestMargin: number | null;
  readonly aboveMinMargin: boolean;
  readonly startsAt: number;
  readonly lastUpdatedAt: number;
}

export interface ListMatchesResult {
  readonly total: number;
  readonly items: readonly MatchListItem[];
}

export interface MatchCandidatesQuery {
  readonly sport?: string;
  readonly minScore?: number;
  readonly limit: number;
}

/** Gom room theo trận; đồng thời là nguồn cho phát hiện ghép trượt. */
export class ListMatchesHandler implements QueryHandler<
  ListMatchesQuery,
  ListMatchesResult
> {
  constructor(
    private readonly _rooms: OddsRoomStore,
    private readonly _settings: ArbitrageSettingsStore,
    private readonly _teams: TeamNameResolver,
  ) {}

  async execute(q: ListMatchesQuery): Promise<ListMatchesResult> {
    const settings = await this._settings.get();
    const needle = q.q?.toLowerCase();
    const items = groupByMatch(
      await this._rooms.list(),
      settings.maxStartDriftMs,
      settings.minMargin,
    )
      .filter(
        (m) =>
          (!q.sport || m.sport === q.sport) &&
          (!q.tenant || m.tenants.includes(q.tenant)) &&
          (!q.phase || m.phases.includes(q.phase)) &&
          (q.matched === undefined || q.matched === m.matchedMarkets > 0) &&
          (!needle || m.teams.some((t) => t.includes(needle))),
      )
      .sort(
        (a, b) =>
          (b.bestMargin ?? -Infinity) - (a.bestMargin ?? -Infinity) ||
          a.startsAt - b.startsAt ||
          a.match.localeCompare(b.match),
      );
    return {
      total: items.length,
      items: items.slice(q.offset, q.offset + q.limit),
    };
  }

  /** Cặp trận có thể là một (tên đội lệch) kèm gợi ý bí danh. */
  async candidates(q: MatchCandidatesQuery): Promise<MatchCandidate[]> {
    const settings = await this._settings.get();
    const summaries: MatchSummary[] = groupByMatch(
      await this._rooms.list(),
      settings.maxStartDriftMs,
      settings.minMargin,
    )
      .filter((m) => !q.sport || m.sport === q.sport)
      .map(({ match, sport, teams, tenants, startsAt }) => ({
        match,
        sport,
        teams,
        tenants,
        startsAt,
      }));
    return findMatchCandidates(summaries, {
      maxStartDriftMs: settings.maxStartDriftMs,
      minScore: q.minScore,
    })
      .map((candidate) => ({
        ...candidate,
        aliases: candidate.aliases.filter(
          (suggestion) => !this._teams.hasAlias(suggestion.alias),
        ),
      }))
      .filter((candidate) => candidate.aliases.length > 0)
      .slice(0, q.limit);
  }
}

function groupByMatch(
  rooms: readonly OddsRoom[],
  maxDrift: number,
  minMargin: number,
): MatchListItem[] {
  const by = new Map<string, OddsRoom[]>();
  for (const r of rooms) {
    if (!r.lines.size) continue;
    const id = r.key.matchId();
    const list = by.get(id);
    if (list) list.push(r);
    else by.set(id, [r]);
  }
  return [...by.entries()].map(([match, list]) => {
    const coverage: Record<string, number> = {};
    const phases = new Set<Phase>();
    let best: number | null = null;
    let matchedMarkets = 0;
    let startsAt = Infinity;
    let lastUpdatedAt = 0;
    for (const r of list) {
      if (r.lines.size >= 2) matchedMarkets++;
      for (const [tenant, l] of r.lines) {
        coverage[tenant] = (coverage[tenant] ?? 0) + 1;
        phases.add(l.props.phase);
        startsAt = Math.min(startsAt, l.props.startsAt);
        lastUpdatedAt = Math.max(lastUpdatedAt, l.props.updatedAt);
      }
      for (const c of r.combinations(maxDrift))
        if (best === null || c.margin > best) best = c.margin;
    }
    const key = list[0].key;
    return {
      match,
      sport: key.sport,
      teams: key.teams,
      tenants: Object.keys(coverage).sort(),
      markets: list.length,
      matchedMarkets,
      coverage,
      phases: [...phases],
      bestMargin: best,
      aboveMinMargin: best !== null && best >= minMargin,
      startsAt,
      lastUpdatedAt,
    };
  });
}
