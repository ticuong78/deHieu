import { IngestStats } from '../ingest-stats.js';
import { IngestTaskDataHandler } from '../commands/ingest-task-data.command.js';
import { TranslatorRouter } from '../translator-router.js';
import type { LaneDispatcher } from '../lane-dispatcher.js';
import type { TaskDataMessage } from '../../../tasks/application/task-protocol.js';
import { TeamNameResolver } from '../team-name.resolver.js';
import type { TeamAliasRepository } from '../../domain/team-alias.repository.js';
import { TeamAlias } from '../../domain/team-alias.js';
import { SptPubOddsTranslator } from '../../infrastructure/acl/sptpub/sptpub-odds.translator.js';
import { InMemoryOddsRoomStore } from '../../infrastructure/persistence/in-memory/in-memory-odds-room.store.js';
import { InMemoryArbitrageSettingsStore } from '../../infrastructure/settings/in-memory-arbitrage-settings.store.js';
import { ListMatchesHandler } from '../queries/list-matches.query.js';
import { GetMatchHandler } from '../queries/get-match.query.js';
import { MatchKey } from '../../domain/match-key.js';
import { OddsLine } from '../../domain/odds-line.js';
import type { MarketType } from '../../domain/market-type.js';

const repo: TeamAliasRepository = {
  findAll: () => Promise.resolve({ status: 'SUCEED', data: [] }),
  findById: () => Promise.resolve({ status: 'NOT_FOUND' }),
  save: (a) => Promise.resolve({ status: 'SUCEED', data: a }),
  delete: () => Promise.resolve({ status: 'SUCEED', data: true }),
};
const teams = new TeamNameResolver(repo);

const msg = (payload: unknown): TaskDataMessage => ({
  taskId: 'sptpub-live',
  tenant: 'sptpub',
  kind: 'sptpub.live',
  seq: 1,
  sentAt: 1,
  receivedAt: 1,
  channel: 'delta',
  payload,
});

describe('IngestStats + IngestTaskDataHandler', () => {
  it('đếm nhận / thay đổi / bỏ qua theo lý do', async () => {
    const stats = new IngestStats(() => 100);
    const submitted: unknown[] = [];
    const lanes = {
      submit: (c: unknown[]) => {
        submitted.push(...c);
        return Promise.resolve();
      },
    } as unknown as LaneDispatcher;
    const h = new IngestTaskDataHandler(
      new TranslatorRouter([
        new SptPubOddsTranslator(teams, stats.reporter('sptpub')),
      ]),
      lanes,
      stats,
    );

    await h.execute(
      msg({
        version: 1,
        events: {
          E: {
            desc: {
              scheduled: 1790326800,
              type: 'match',
              sport: '109',
              competitors: [
                { id: 'a', name: 'Alliance' },
                { id: 'b', name: 'Sinners' },
              ],
            },
            markets: {
              '186': { '': { '4': { k: '1.5' }, '5': { k: '2.5' } } },
              '327': {
                'hcp=-3.5': { '1714': { k: '5' }, '1715': { k: '1.1' } },
              },
              '999': { '': { '1': { k: '2' } } },
            },
          },
          F: {
            desc: {
              scheduled: 1,
              type: 'match',
              sport: '999999', // môn không hỗ trợ
              competitors: [
                { id: 'a', name: 'X' },
                { id: 'b', name: 'Y' },
              ],
            },
          },
        },
      }),
    );
    await h.execute(msg('rác'));

    const [c] = stats.snapshot().items;
    expect(c).toMatchObject({
      tenant: 'sptpub',
      kind: 'sptpub.live',
      received: 2,
      set: 1,
      remove: 0,
      failed: 0,
      skipped: {
        unsupported_line: 1,
        unsupported_market: 1,
        unsupported_sport: 1,
        parse_failed: 1,
      },
      lastReceivedAt: 100,
      lastChangeAt: 100,
    });
    expect(submitted).toHaveLength(1);
  });
});

describe('ListMatchesHandler / GetMatchHandler', () => {
  const line = (tenant: string, odds: [number, number], startsAt = 0) =>
    OddsLine.create({
      tenant,
      odds,
      status: 'open',
      phase: 'prematch',
      updatedAt: 1,
      startsAt,
      ref: {},
    });
  const key = (a: string, b: string, market: MarketType) =>
    MatchKey.of({ sport: 'cs2', teamX: a, teamY: b, market });

  const setup = async () => {
    const rooms = new InMemoryOddsRoomStore();
    const settings = new InMemoryArbitrageSettingsStore();
    await rooms.setLine(
      key('alliance', 'sinners', 'game-winner'),
      line('sptpub', [2.2, 2.2]),
    );
    await rooms.setLine(
      key('alliance', 'sinners', 'game-winner'),
      line('polymarket', [2.1, 2.1]),
    );
    await rooms.setLine(
      key('alliance', 'sinners', 'total-maps-2.5'),
      line('sptpub', [1.9, 1.9]),
    );
    await rooms.setLine(
      key('aaa', 'infurity', 'game-winner'),
      line('sptpub', [1.5, 2.5]),
    );
    await rooms.setLine(
      key('aaa', 'inf', 'game-winner'),
      line('polymarket', [1.6, 2.4], 60_000),
    );
    return {
      list: new ListMatchesHandler(rooms, settings, teams),
      get: new GetMatchHandler(rooms, settings, () => 10),
    };
  };

  it('gom room theo trận, coverage và margin tốt nhất', async () => {
    const { list } = await setup();
    const r = await list.execute({ limit: 50, offset: 0 });
    expect(r.total).toBe(3);
    const top = r.items[0];
    expect(top).toMatchObject({
      match: 'cs2:alliance~sinners',
      markets: 2,
      matchedMarkets: 1,
      coverage: { sptpub: 2, polymarket: 1 },
      tenants: ['polymarket', 'sptpub'],
    });
    expect(top?.bestMargin).toBeCloseTo(1 / (1 / 2.2 + 1 / 2.1) - 1);
    expect(
      (await list.execute({ matched: true, limit: 50, offset: 0 })).total,
    ).toBe(1);
  });

  it('chi tiết trận: ma trận market × tenant theo thứ tự MARKET_TYPES', async () => {
    const { get } = await setup();
    const v = await get.execute({ match: 'cs2:alliance~sinners' });
    expect(v?.markets.map((m) => m.market)).toEqual([
      'game-winner',
      'total-maps-2.5',
    ]);
    expect(v?.markets[1]?.picks).toEqual(['over 2.5', 'under 2.5']);
    expect(Object.keys(v?.markets[0]?.lines ?? {}).sort()).toEqual([
      'polymarket',
      'sptpub',
    ]);
    expect(await get.execute({ match: 'cs2:nope~zzz' })).toBeNull();
    expect(await get.execute({ match: 'sai-dạng' })).toBeNull();
    expect(get.matchOfRoom('room:cs2:alliance~sinners:map-1-winner')).toBe(
      'cs2:alliance~sinners',
    );
  });

  it('candidates: inf ↔ infurity', async () => {
    const { list } = await setup();
    const [c] = await list.candidates({ limit: 10 });
    expect(c?.aliases).toEqual([
      { alias: 'inf', canonical: 'infurity', similarity: 0.8 },
    ]);
  });

  it('một bí danh đã lưu biến mất ở cả hai trận có đối thủ khác nhau', async () => {
    const rooms = new InMemoryOddsRoomStore();
    const settings = new InMemoryArbitrageSettingsStore();
    const saved = [
      TeamAlias.create({
        id: 'bodo',
        alias: 'bodoeglimt',
        canonical: 'fkbodoglimt',
      }),
    ];
    let active = false;
    const aliases = new TeamNameResolver({
      ...repo,
      findAll: () =>
        Promise.resolve({ status: 'SUCEED', data: active ? saved : [] }),
    });
    await aliases.reload();
    for (const opponent of ['molde', 'lasklinz']) {
      await rooms.setLine(
        key('bodoeglimt', opponent, 'game-winner'),
        line('sptpub', [2, 2]),
      );
      await rooms.setLine(
        key('fkbodoglimt', opponent, 'game-winner'),
        line('polymarket', [2, 2]),
      );
    }
    const list = new ListMatchesHandler(rooms, settings, aliases);
    const query = { limit: 50, minScore: 0.8 };
    const before = await list.candidates(query);
    expect(before).toHaveLength(2);
    expect(before.every((c) => c.aliases[0]?.alias === 'bodoeglimt')).toBe(
      true,
    );
    active = true;
    await aliases.reload();
    expect(await list.candidates(query)).toEqual([]);
  });
});
