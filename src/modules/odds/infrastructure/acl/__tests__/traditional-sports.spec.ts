import type { TaskDataMessage } from '../../../../tasks/application/task-protocol.js';
import { TeamNameResolver } from '../../../application/team-name.resolver.js';
import type { TeamAliasRepository } from '../../../domain/team-alias.repository.js';
import { pickOf } from '../../../domain/pick.js';
import { PolymarketOddsTranslator } from '../polymarket/polymarket-odds.translator.js';
import { polymarketSportOf } from '../polymarket/polymarket-odds.mapping.js';
import { SptPubOddsTranslator } from '../sptpub/sptpub-odds.translator.js';

const aliases: TeamAliasRepository = {
  findAll: () => Promise.resolve({ status: 'SUCEED', data: [] }),
  findById: () => Promise.resolve({ status: 'NOT_FOUND' }),
  save: (a) => Promise.resolve({ status: 'SUCEED', data: a }),
  delete: () => Promise.resolve({ status: 'SUCEED', data: true }),
};
const teams = new TeamNameResolver(aliases);
const start = '2026-11-21T12:00:00Z';

const message = (
  kind: 'sptpub.prematch' | 'polymarket.descriptor',
  payload: unknown,
): TaskDataMessage => ({
  taskId: kind,
  tenant: kind.startsWith('sptpub') ? 'sptpub' : 'polymarket',
  kind,
  seq: 1,
  sentAt: Date.parse(start) - 60_000,
  receivedAt: Date.parse(start) - 60_000,
  payload,
});

const sptpub = (
  sport: string,
  market: string,
  spec: string,
  outcomes: Record<string, { k: string }>,
) => ({
  version: 1,
  events: {
    '123': {
      desc: {
        sport,
        type: 'match',
        scheduled: Date.parse(start) / 1000,
        competitors: [
          { id: 'a', name: 'Arsenal FC' },
          { id: 'b', name: 'Chelsea FC' },
        ],
      },
      markets: { [market]: { [spec]: outcomes } },
    },
  },
});

const polymarket = (
  sport: string,
  tags: string,
  marketType: string,
  labels: [string, string],
  line?: number,
) => [
  {
    id: '456',
    slug: 'match-arsenal-chelsea',
    schedule: { startTime: start },
    sports: {
      sport: { sport, tags },
      teams: [{ name: 'Arsenal FC' }, { name: 'Chelsea FC' }],
    },
    markets: [
      {
        conditionId: '0xabc',
        slug: 'market-arsenal-chelsea',
        state: { closed: false, acceptingOrders: true },
        outcomes: {
          yes: { label: labels[0], tokenId: 'yes-token' },
          no: { label: labels[1], tokenId: 'no-token' },
        },
        prices: { bestAsk: '0.45', bestBid: '0.40' },
        sports: { sportsMarketType: marketType, line },
      },
    ],
  },
];

describe('traditional sports odds', () => {
  it('resolves league codes through the sport tag instead of treating each league as a different sport', () => {
    expect(polymarketSportOf({ sport: 'epl', tags: '1,82,100350' })).toBe(
      'soccer',
    );
    expect(polymarketSportOf({ sport: 'lal', tags: '1,780,100350' })).toBe(
      'soccer',
    );
    expect(polymarketSportOf({ sport: 'itf', tags: '1,864' })).toBe('tennis');
    expect(
      polymarketSportOf({ sport: 'unknown', tags: '1,100639' }),
    ).toBeNull();
  });

  it('matches soccer total goals across the two feeds without using three-way moneyline', async () => {
    const book = new SptPubOddsTranslator(teams);
    const poly = new PolymarketOddsTranslator(teams);
    const [a] = await book.translate(
      message(
        'sptpub.prematch',
        sptpub('1', '18', 'total=2.5', {
          '12': { k: '2.10' },
          '13': { k: '1.80' },
        }),
      ),
    );
    const [b] = await poly.translate(
      message(
        'polymarket.descriptor',
        polymarket('epl', '1,82,100350', 'totals', ['Over', 'Under'], 2.5),
      ),
    );
    expect(a?.key.toString()).toBe(
      'room:soccer:arsenal~chelsea:total-goals-2.5',
    );
    expect(b?.key.toString()).toBe(a?.key.toString());
    expect(a?.type === 'set' && a.line.props.odds).toEqual([2.1, 1.8]);
    expect(b?.type === 'set' && b.line.props.ref).toMatchObject({
      t0: 'yes-token',
      t1: 'no-token',
    });
    if (a?.type !== 'set') throw new Error('expected soccer total-goals line');
    expect(pickOf(a.key, 0)).toBe('over 2.5 goals');
    expect(pickOf(a.key, 1)).toBe('under 2.5 goals');

    const threeWay = await new PolymarketOddsTranslator(teams).translate(
      message(
        'polymarket.descriptor',
        polymarket('epl', '1,82,100350', 'moneyline', ['Yes', 'No']),
      ),
    );
    expect(threeWay).toEqual([]);
  });

  it('matches soccer both-teams-score with yes/no outcomes', async () => {
    const book = new SptPubOddsTranslator(teams);
    const poly = new PolymarketOddsTranslator(teams);
    const [a] = await book.translate(
      message(
        'sptpub.prematch',
        sptpub('1', '29', '', {
          '74': { k: '1.95' },
          '76': { k: '1.90' },
        }),
      ),
    );
    const [b] = await poly.translate(
      message(
        'polymarket.descriptor',
        polymarket('epl', '1,82,100350', 'both_teams_to_score', ['Yes', 'No']),
      ),
    );
    expect(a?.key.toString()).toBe(
      'room:soccer:arsenal~chelsea:both-teams-score',
    );
    expect(b?.key.toString()).toBe(a?.key.toString());
  });

  it('matches two-way basketball winner including overtime', async () => {
    const book = new SptPubOddsTranslator(teams);
    const poly = new PolymarketOddsTranslator(teams);
    const [a] = await book.translate(
      message(
        'sptpub.prematch',
        sptpub('2', '219', '', {
          '4': { k: '2.05' },
          '5': { k: '1.85' },
        }),
      ),
    );
    const [b] = await poly.translate(
      message(
        'polymarket.descriptor',
        polymarket('nba', '1,28,745', 'moneyline', [
          'Arsenal FC',
          'Chelsea FC',
        ]),
      ),
    );
    expect(a?.key.toString()).toBe(
      'room:basketball:arsenal~chelsea:game-winner',
    );
    expect(b?.key.toString()).toBe(a?.key.toString());
  });

  it.each([
    ['5', '186', 'itf', '1,864', 'tennis'],
    ['16', '219', 'nfl', '1,450', 'american-football'],
    ['4', '406', 'nhl', '1,899', 'ice-hockey'],
    ['117', '186', 'ufc', '1,279', 'mma'],
    ['3', '251', 'mlb', '1,100381', 'baseball'],
  ])(
    'maps %s market %s to a two-way %s winner',
    async (sptSport, market, polySport, tags, canonical) => {
      const book = new SptPubOddsTranslator(teams);
      const poly = new PolymarketOddsTranslator(teams);
      const [a] = await book.translate(
        message(
          'sptpub.prematch',
          sptpub(sptSport, market, '', {
            '4': { k: '2.05' },
            '5': { k: '1.85' },
          }),
        ),
      );
      const [b] = await poly.translate(
        message(
          'polymarket.descriptor',
          polymarket(polySport, tags, 'moneyline', [
            'Arsenal FC',
            'Chelsea FC',
          ]),
        ),
      );
      expect(a?.key.toString()).toBe(
        `room:${canonical}:arsenal~chelsea:game-winner`,
      );
      expect(b?.key.toString()).toBe(a?.key.toString());
    },
  );
});
