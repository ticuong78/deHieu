/** Các từ "trang trí" không giúp phân biệt đội (rút ra từ HAR sptpub/polymarket). */
const NOISE_WORDS = new Set([
  'team',
  'esports',
  'esport',
  'gaming',
  'gg',
  'fc',
  'cf',
]);

/**
 * Chuẩn hóa tên đội để so khớp giữa các tenant:
 *   "Sinners Esports" → "sinners", "Team QUAZAR" → "quazar", "KUUSAMO.gg" → "kuusamo",
 *   "Grêmio Esports" → "gremio". Giữ "academy", "ex" vì đó là đội khác.
 * Trường hợp quy tắc không giải được (NIP ↔ Ninjas in Pyjamas) → bảng bí danh.
 */
export const normalizeTeamName = (raw: string): string =>
  raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/\be-?sports?\b/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !NOISE_WORDS.has(w))
    .join('');
