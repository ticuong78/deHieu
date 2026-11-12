import { normalizeTeamName } from '../team-name.js';

describe('normalizeTeamName', () => {
  it.each([
    ['Sinners Esports', 'Sinners'],
    ['Team QUAZAR', 'QUAZAR'],
    ['HAVU Gaming', 'HAVU'],
    ['BBL Esports', 'BBL'],
    ['Team Abyssal', 'Abyssal'],
    ['magic', 'Magic'],
    ['ex-RUBY', 'Ex-RUBY'],
    ['Arsenal FC', 'Arsenal'],
    ['Inter Miami CF', 'Inter Miami'],
  ])('"%s" và "%s" cho cùng một khóa', (x, y) => {
    expect(normalizeTeamName(x)).toBe(normalizeTeamName(y));
  });

  it('bỏ dấu tiếng Bồ/Việt và hậu tố .gg', () => {
    expect(normalizeTeamName('Grêmio Esports')).toBe('gremio');
    expect(normalizeTeamName('KUUSAMO.gg')).toBe('kuusamo');
  });

  it('giữ "academy" vì đó là đội khác', () => {
    expect(normalizeTeamName('Team Spirit Academy')).not.toBe(
      normalizeTeamName('Team Spirit'),
    );
  });
});
