import {
  mapHandicapMarket,
  mapWinnerMarket,
  totalMapsMarket,
  totalGoalsMarket,
  type MarketType,
} from '../../../domain/market-type.js';

/** sport id của sptpub → sport của domain. Mở rộng khi cần. */
export const SPTPUB_SPORTS: Readonly<Record<string, string>> = {
  '109': 'cs2', // Counter-Strike
  '110': 'lol',
  '111': 'dota2',
  '194': 'valorant',
  '1': 'soccer',
  '2': 'basketball',
  '3': 'baseball',
  '4': 'ice-hockey',
  '5': 'tennis',
  '16': 'american-football',
  '117': 'mma',
};

export interface SptPubMarketMapping {
  /**
   * Hai outcomeId của market.
   * - outcomesBy 'competitor': [competitor1, competitor2] → translator đảo theo thứ tự đội của room.
   * - outcomesBy 'side': [side 0, side 1] của room, giữ nguyên (vd [over, under]).
   */
  readonly outcomes: readonly [string, string];
  readonly outcomesBy: 'competitor' | 'side';
  /**
   * specifier → market domain. `c1First` = competitor1 là teams[0] của MatchKey
   * (để quy mức chấp về teams[0]). null = bỏ qua specifier này.
   */
  toMarket(
    specifier: string,
    c1First: boolean,
    sport: string,
  ): MarketType | null;
}

/** "hcp=-1.5" / "total=2.5" / "mapnr=1" → số; dạng khác (kể cả nhiều specifier) → null. */
const parseSpec = (name: string, specifier: string): number | null => {
  const m = new RegExp(`^${name}=([+-]?\\d+(?:\\.\\d+)?)$`).exec(specifier);
  return m ? Number(m[1]) : null;
};

/** market id → cách đọc market đó (theo descriptor /api/v3/descriptions/.../markets). */
export const SPTPUB_MARKETS: Readonly<Record<string, SptPubMarketMapping>> = {
  // "Winner"
  '186': {
    outcomes: ['4', '5'],
    outcomesBy: 'competitor',
    toMarket: (s, _first, sport) =>
      s === '' &&
      ['cs2', 'lol', 'dota2', 'valorant', 'tennis', 'mma'].includes(sport)
        ? 'game-winner'
        : null,
  },
  // "Map handicap" (cs2/lol): 1714 = {$competitor1} ({+hcp}), 1715 = {$competitor2} ({-hcp}).
  // KHÔNG nhầm với 187 "Game handicap" (tennis...).
  '327': {
    outcomes: ['1714', '1715'],
    outcomesBy: 'competitor',
    toMarket: (s, c1First, sport) => {
      if (!['cs2', 'lol', 'dota2', 'valorant'].includes(sport)) return null;
      const hcp = parseSpec('hcp', s);
      return hcp === null ? null : mapHandicapMarket(c1First ? hcp : -hcp);
    },
  },
  // "{!mapnr} map - winner": 4 = competitor1, 5 = competitor2 (giống 186, theo từng map).
  // KHÔNG nhầm với 338 (thắng round), 736 (thắng hiệp 1), 50338 (kèo kết hợp).
  '330': {
    outcomes: ['4', '5'],
    outcomesBy: 'competitor',
    toMarket: (s, _first, sport) => {
      if (!['cs2', 'lol', 'dota2', 'valorant'].includes(sport)) return null;
      const map = parseSpec('mapnr', s);
      return map === null ? null : mapWinnerMarket(map);
    },
  },
  // "Total maps": 12 = over {total}, 13 = under {total}.
  // KHÔNG nhầm với 50755 "Match winner & total maps" (kèo kết hợp 4 cửa).
  '328': {
    outcomes: ['12', '13'],
    outcomesBy: 'side',
    toMarket: (s, _first, sport) => {
      if (!['cs2', 'lol', 'dota2', 'valorant'].includes(sport)) return null;
      const total = parseSpec('total', s);
      return total === null ? null : totalMapsMarket(total);
    },
  },
  // 90 phút + bù giờ, không gồm hiệp phụ: hai cửa Over/Under cùng mốc bàn thắng.
  '18': {
    outcomes: ['12', '13'],
    outcomesBy: 'side',
    toMarket: (s, _first, sport) => {
      if (sport !== 'soccer') return null;
      const total = parseSpec('total', s);
      return total === null ? null : totalGoalsMarket(total);
    },
  },
  '29': {
    outcomes: ['74', '76'],
    outcomesBy: 'side',
    toMarket: (s, _first, sport) =>
      sport === 'soccer' && s === '' ? 'both-teams-score' : null,
  },
  // Hai cửa thắng trận bao gồm thời gian thi đấu bổ sung tương ứng với từng môn.
  '219': {
    outcomes: ['4', '5'],
    outcomesBy: 'competitor',
    toMarket: (s, _first, sport) =>
      s === '' && ['basketball', 'american-football'].includes(sport)
        ? 'game-winner'
        : null,
  },
  '406': {
    outcomes: ['4', '5'],
    outcomesBy: 'competitor',
    toMarket: (s, _first, sport) =>
      sport === 'ice-hockey' && s === '' ? 'game-winner' : null,
  },
  '251': {
    outcomes: ['4', '5'],
    outcomesBy: 'competitor',
    toMarket: (s, _first, sport) =>
      sport === 'baseball' && s === '' ? 'game-winner' : null,
  },
};
