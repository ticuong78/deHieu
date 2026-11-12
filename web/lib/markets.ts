/**
 * Market chuẩn của hệ thống — giữ khớp với MARKET_TYPES ở backend
 * (src/modules/odds/domain/market-type.ts).
 */
export const MARKET_TYPES = [
  'game-winner',
  'map-handicap-m2.5',
  'map-handicap-m1.5',
  'map-handicap-p1.5',
  'map-handicap-p2.5',
  'total-maps-2.5',
  'total-maps-3.5',
  'total-maps-4.5',
  'map-1-winner',
  'map-2-winner',
  'map-3-winner',
  'map-4-winner',
  'map-5-winner',
  'total-goals-0.5',
  'total-goals-1.5',
  'total-goals-2.5',
  'total-goals-3.5',
  'total-goals-4.5',
  'total-goals-5.5',
  'total-goals-6.5',
  'both-teams-score',
] as const;

/** Nhóm market cho ma trận Chi tiết trận (thứ tự hiển thị cố định). */
export interface MarketGroup {
  id: 'winner' | 'map-winner' | 'handicap' | 'total' | 'other';
  label: string;
}

export const MARKET_GROUPS: MarketGroup[] = [
  { id: 'winner', label: 'Thắng trận' },
  { id: 'map-winner', label: 'Thắng từng map' },
  { id: 'handicap', label: 'Chấp map' },
  { id: 'total', label: 'Tổng' },
  { id: 'other', label: 'Khác' },
];

export function marketGroup(market: string): MarketGroup['id'] {
  if (market === 'game-winner') return 'winner';
  if (/^map-\d-winner$/.test(market)) return 'map-winner';
  if (market.startsWith('map-handicap-')) return 'handicap';
  if (market.startsWith('total-maps-') || market.startsWith('total-goals-'))
    return 'total';
  return 'other';
}

/** Thứ tự trong nhóm: map-1..5; chấp m2.5, m1.5, p1.5, p2.5; tổng 2.5 → 4.5. */
export function marketOrder(market: string): number {
  const map = /^map-(\d)-winner$/.exec(market);
  if (map) return Number(map[1]);
  const hcp = /^map-handicap-([mp])(\d\.5)$/.exec(market);
  if (hcp) return (hcp[1] === 'm' ? -1 : 1) * Number(hcp[2]);
  const tot = /^total-maps-(\d\.5)$/.exec(market);
  if (tot) return Number(tot[1]);
  const goals = /^total-goals-(\d\.5)$/.exec(market);
  if (goals) return Number(goals[1]);
  return 0;
}

/** Tên hiển thị ngắn gọn của market. */
export function marketLabel(market: string): string {
  if (market === 'game-winner') return 'Thắng trận';
  if (market === 'both-teams-score') return 'Hai đội cùng ghi bàn';
  const map = /^map-(\d)-winner$/.exec(market);
  if (map) return `Map ${map[1]}`;
  const hcp = /^map-handicap-([mp])(\d\.5)$/.exec(market);
  if (hcp) return `Chấp ${hcp[1] === 'm' ? '−' : '+'}${hcp[2]}`;
  const tot = /^total-maps-(\d\.5)$/.exec(market);
  if (tot) return `Tổng ${tot[1]} map`;
  const goals = /^total-goals-(\d\.5)$/.exec(market);
  if (goals) return `Tổng ${goals[1]} bàn`;
  return market;
}

/** 'cs2:alliance~sinners' → { sport, teams }. */
export function parseMatchId(match: string): {
  sport: string;
  teams: [string, string];
} {
  const [sport = '', pair = ''] = match.split(':');
  const [a = '', b = ''] = pair.split('~');
  return { sport, teams: [a, b] };
}

export const SPORT_LABEL: Record<string, string> = {
  cs2: 'CS2',
  lol: 'LoL',
  dota2: 'Dota 2',
  valorant: 'Valorant',
  soccer: 'Bóng đá',
  basketball: 'Bóng rổ',
  tennis: 'Tennis',
  'ice-hockey': 'Khúc côn cầu trên băng',
  'american-football': 'Bóng bầu dục Mỹ',
  baseball: 'Bóng chày',
  mma: 'MMA / UFC',
};
