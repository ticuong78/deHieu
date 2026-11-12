import {
  mapHandicapMarket,
  mapWinnerMarket,
  totalMapsMarket,
  totalGoalsMarket,
  type MarketType,
} from '../../../domain/market-type.js';
import type { PolymarketMarketDTO } from './polymarket.dto.js';

export const POLYMARKET_SPORTS: Readonly<Record<string, string>> = {
  cs2: 'cs2',
  lol: 'lol',
  dota2: 'dota2',
  val: 'valorant',
  nba: 'basketball',
  wnba: 'basketball',
  nfl: 'american-football',
  nhl: 'ice-hockey',
  mlb: 'baseball',
  ufc: 'mma',
  atp: 'tennis',
  wta: 'tennis',
};

/** /sports trả league code; tag của metadata xác định môn khi có nhiều league. */
const SPORT_TAGS: Readonly<Record<number, string>> = {
  100350: 'soccer',
  28: 'basketball',
  864: 'tennis',
  450: 'american-football',
  899: 'ice-hockey',
  100381: 'baseball',
  279: 'mma',
};

export const polymarketSportOf = (metadata: {
  sport: string;
  tags?: string | null;
}): string | null => {
  const direct = POLYMARKET_SPORTS[metadata.sport];
  if (direct) return direct;
  const tags = new Set(
    (metadata.tags ?? '').split(',').map((s) => Number(s.trim())),
  );
  for (const [id, sport] of Object.entries(SPORT_TAGS))
    if (tags.has(Number(id))) return sport;
  return null;
};

const ESPORTS = new Set(['cs2', 'lol', 'dota2', 'valorant']);

/** Một tên market có thể có nghĩa khác nhau giữa các môn; chỉ nhận cặp đã ánh xạ. */
export const supportsPolymarketMarket = (
  sport: string,
  marketType: string,
): boolean => {
  if (ESPORTS.has(sport))
    return ['moneyline', 'child_moneyline', 'map_handicap', 'totals'].includes(
      marketType,
    );
  if (sport === 'soccer')
    return ['totals', 'both_teams_to_score'].includes(marketType);
  return marketType === 'moneyline';
};

export interface PolymarketMarketMapping {
  /**
   * - 'team': outcome yes/no là tên đội → cặp đội lấy từ outcome, token đảo theo thứ tự đội của room.
   * - 'side': outcome yes/no là side 0/side 1 của room (vd Over/Under) → cặp đội lấy từ
   *   market moneyline cùng event, token giữ nguyên.
   */
  readonly outcomesBy: 'team' | 'side';
  /**
   * market của polymarket → market domain. `yesFirst` = đội của outcome yes là teams[0]
   * của MatchKey (chỉ có nghĩa khi outcomesBy 'team'). null = bỏ qua market này.
   */
  toMarket(
    m: PolymarketMarketDTO,
    yesFirst: boolean,
    sport: string,
  ): MarketType | null;
}

/** Số map của child_moneyline: "Map 1 Winner" (cs2, valorant) / "Game 1 Winner" (lol, dota2), dự phòng slug "...-game1". */
const mapNumberOf = (m: PolymarketMarketDTO): number | null => {
  const t = /^(?:map|game) (\d+) winner$/i.exec(m.groupItemTitle?.trim() ?? '');
  const s = /-game(\d+)$/.exec(m.slug ?? '');
  const n = t?.[1] ?? s?.[1];
  return n ? Number(n) : null;
};

/** sportsMarketType → cách đọc market đó. */
export const POLYMARKET_MARKETS: Readonly<
  Record<string, PolymarketMarketMapping>
> = {
  moneyline: { outcomesBy: 'team', toMarket: () => 'game-winner' },
  // Thắng từng map: yes/no là tên đội, số map nằm ở groupItemTitle/slug.
  child_moneyline: {
    outcomesBy: 'team',
    toMarket: (m) => {
      const map = mapNumberOf(m);
      return map === null ? null : mapWinnerMarket(map);
    },
  },
  // line = mức chấp của outcome yes (vd yes=INFURITY, line=-1.5 ↔ "INF (-1.5) vs ... (+1.5)").
  // LoL cũng dùng map_handicap ("Game Handicap").
  map_handicap: {
    outcomesBy: 'team',
    toMarket: (m, yesFirst) => {
      const line = m.sports.line;
      return line == null ? null : mapHandicapMarket(yesFirst ? line : -line);
    },
  },
  // "Games Total: O/U 2.5": yes = Over, no = Under, line = mốc tổng số map của cả trận.
  totals: {
    outcomesBy: 'side',
    toMarket: (m, _first, sport) =>
      m.sports.line == null
        ? null
        : sport === 'soccer'
          ? m.outcomes.yes.label.toLowerCase() === 'over' &&
            m.outcomes.no.label.toLowerCase() === 'under'
            ? totalGoalsMarket(m.sports.line)
            : null
          : totalMapsMarket(m.sports.line),
  },
  both_teams_to_score: {
    outcomesBy: 'side',
    toMarket: (m) =>
      m.outcomes.yes.label.toLowerCase() === 'yes' &&
      m.outcomes.no.label.toLowerCase() === 'no'
        ? 'both-teams-score'
        : null,
  },
};
