import { describeMarket } from './market-type.js';
import type { MatchKey, Side } from './match-key.js';

const signed = (n: number): string => (n > 0 ? `+${n}` : `${n}`);

/**
 * Cửa được chọn ở `side` của room, dạng chữ để hiển thị:
 *   game-winner        → "alliance"
 *   map-handicap-p1.5  → "alliance +1.5" / "sinners -1.5"
 *   total-maps-2.5     → "over 2.5" / "under 2.5"
 *   map-1-winner       → "alliance (map 1)"
 * Bot đặt lệnh theo ref + side, không theo chuỗi này.
 */
export const pickOf = (key: MatchKey, side: Side): string => {
  const shape = describeMarket(key.market);
  switch (shape.kind) {
    case 'winner':
      return key.teams[side];
    case 'map-handicap':
      return `${key.teams[side]} ${signed(side === 0 ? shape.line : -shape.line)}`;
    case 'total-maps':
      return `${side === 0 ? 'over' : 'under'} ${shape.total}`;
    case 'total-goals':
      return `${side === 0 ? 'over' : 'under'} ${shape.total} goals`;
    case 'both-teams-score':
      return side === 0 ? 'both teams score: yes' : 'both teams score: no';
    case 'map-winner':
      return `${key.teams[side]} (map ${shape.map})`;
  }
};
