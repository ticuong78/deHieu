import { describe, expect, it, vi } from 'vitest';
import type { TaskDataMessage } from '../../../tasks/application/task-protocol.js';
import { ArbitrageEvaluator } from '../../application/arbitrage-evaluator.js';
import { CreateTeamAliasHandler } from '../../application/commands/create-team-alias.command.js';
import { DeleteTeamAliasHandler } from '../../application/commands/delete-team-alias.command.js';
import { ExpireFinishedMatchesHandler } from '../../application/commands/expire-finished-matches.command.js';
import { IngestTaskDataHandler } from '../../application/commands/ingest-task-data.command.js';
import { ReindexTeamAliasesHandler } from '../../application/commands/reindex-team-aliases.command.js';
import { ReleaseTaskOddsHandler } from '../../application/commands/release-task-odds.command.js';
import { LaneDispatcher } from '../../application/lane-dispatcher.js';
import { OddsLineApplier } from '../../application/odds-line-applier.js';
import { GetMatchHandler } from '../../application/queries/get-match.query.js';
import { ListMatchesHandler } from '../../application/queries/list-matches.query.js';
import { TeamNameResolver } from '../../application/team-name.resolver.js';
import { TranslatorRouter } from '../../application/translator-router.js';
import { MatchKey } from '../../domain/match-key.js';
import type { TeamAliasRepository } from '../../domain/team-alias.repository.js';
import type { TeamAlias } from '../../domain/team-alias.js';
import {
  PolymarketOddsTranslator,
  type SyncAssets,
} from '../acl/polymarket/polymarket-odds.translator.js';
import { SptPubOddsTranslator } from '../acl/sptpub/sptpub-odds.translator.js';
import { InMemoryEventPublisher } from '../messaging/in-memory.event-publisher.js';
import { InMemoryOddsRoomStore } from '../persistence/in-memory/in-memory-odds-room.store.js';
import { InMemorySignalStateStore } from '../persistence/in-memory/in-memory-signal-state.store.js';
import { InMemoryArbitrageSettingsStore } from '../settings/in-memory-arbitrage-settings.store.js';

const NOW = Date.parse('2026-10-13T10:00:00Z');
const PRICE_AT = NOW - 65_000;
const START = NOW + 60_000;
const message = (
  kind: string,
  payload: unknown,
  sentAt = PRICE_AT,
): TaskDataMessage => ({
  taskId: kind,
  kind,
  tenant: kind.split('.')[0],
  seq: 1,
  sentAt,
  receivedAt: sentAt,
  payload,
});

const sptpub = (first = 'Alpha', second = 'Beta') => ({
  version: 1,
  sports: { '109': { slug: 'counter-strike' } },
  categories: { c: { slug: 'counter-strike' } },
  tournaments: { t: { slug: 'source-league' } },
  events: {
    E: {
      desc: {
        scheduled: START / 1000,
        type: 'match',
        sport: '109',
        category: 'c',
        tournament: 't',
        slug: 'source-alpha-beta',
        competitors: [
          { id: 'a', name: first },
          { id: 'b', name: second },
        ],
      },
      markets: {
        '186': { '': { '4': { k: '1.5' }, '5': { k: '2.5' } } },
        '330': { 'mapnr=1': { '4': { k: '1.6' }, '5': { k: '2.4' } } },
        '327': { 'hcp=-1.5': { '1714': { k: '2.8' }, '1715': { k: '1.6' } } },
        '328': { 'total=2.5': { '12': { k: '2.4' }, '13': { k: '1.7' } } },
      },
    },
  },
});

const polymarket = (first = 'Zulu', second = 'Beta', start = START) => [
  {
    id: 'P',
    slug: 'original-event-slug',
    schedule: { startTime: new Date(start).toISOString() },
    sports: { sport: { sport: 'cs2' } },
    markets: ['moneyline', 'child_moneyline', 'map_handicap', 'totals'].map(
      (type, index) => ({
        conditionId: `C${index}`,
        slug: `original-market-${index}`,
        groupItemTitle: type === 'child_moneyline' ? 'Map 1 Winner' : null,
        state: { closed: false, acceptingOrders: true },
        outcomes: {
          yes: {
            label: type === 'totals' ? 'Over' : first,
            tokenId: `yes${index}`,
          },
          no: {
            label: type === 'totals' ? 'Under' : second,
            tokenId: `no${index}`,
          },
        },
        prices: { bestAsk: 0.4, bestBid: 0.5 },
        sports: {
          sportsMarketType: type,
          line: type === 'totals' ? 2.5 : -1.5,
        },
      }),
    ),
  },
];

async function setup(sync?: SyncAssets) {
  const aliases = new Map<string, TeamAlias>();
  const repo: TeamAliasRepository = {
    findAll: () =>
      Promise.resolve({ status: 'SUCEED', data: [...aliases.values()] }),
    findById: (id) =>
      Promise.resolve(
        aliases.has(id)
          ? { status: 'SUCEED', data: aliases.get(id)! }
          : { status: 'NOT_FOUND' },
      ),
    save: (alias) => {
      for (const [id, old] of aliases)
        if (old.props.alias === alias.props.alias) aliases.delete(id);
      aliases.set(alias.props.id, alias);
      return Promise.resolve({ status: 'SUCEED', data: alias });
    },
    delete: (id) => {
      aliases.delete(id);
      return Promise.resolve({ status: 'SUCEED', data: true });
    },
  };
  const teams = new TeamNameResolver(repo);
  await teams.reload();
  const rooms = new InMemoryOddsRoomStore();
  const signals = new InMemorySignalStateStore();
  const settings = new InMemoryArbitrageSettingsStore();
  const evaluator = new ArbitrageEvaluator(
    rooms,
    signals,
    settings,
    new InMemoryEventPublisher(),
    () => NOW,
  );
  const lanes = new LaneDispatcher(new OddsLineApplier(rooms, evaluator));
  const router = new TranslatorRouter([
    new SptPubOddsTranslator(teams),
    new PolymarketOddsTranslator(teams, sync),
  ]);
  const reindex = new ReindexTeamAliasesHandler(
    router,
    lanes,
    8 * 3_600_000,
    () => NOW,
  );
  const ingest = new IngestTaskDataHandler(router, lanes);
  const create = new CreateTeamAliasHandler(repo, teams, reindex);
  const remove = new DeleteTeamAliasHandler(repo, teams, reindex);
  const release = new ReleaseTaskOddsHandler(router, lanes);
  const list = new ListMatchesHandler(rooms, settings, teams);
  const detail = new GetMatchHandler(rooms, settings, () => NOW);
  const expire = new ExpireFinishedMatchesHandler(rooms, lanes, () => NOW);
  return {
    rooms,
    signals,
    settings,
    ingest,
    create,
    remove,
    release,
    list,
    detail,
    evaluator,
    teams,
    expire,
    repo,
  };
}

async function seed(
  s: Awaited<ReturnType<typeof setup>>,
  pubFirst = 'Alpha',
  polyFirst = 'Zulu',
) {
  await s.ingest.execute(message('sptpub.prematch', sptpub(pubFirst)));
  await s.ingest.execute(
    message('polymarket.descriptor', polymarket(polyFirst)),
  );
}

const key = (market = 'game-winner') =>
  MatchKey.parse(`room:cs2:beta~zulu:${market}`)!;

describe('aliases applied to running feeds', () => {
  it('reports reload failures instead of confirming aliases that were not applied', async () => {
    const s = await setup();
    await seed(s);
    s.repo.findAll = () =>
      Promise.resolve({ status: 'FAILED', reason: 'database unavailable' });
    await expect(
      s.create.execute({ alias: 'Alpha', canonical: 'Zulu' }),
    ).rejects.toThrow('Cannot reload team aliases');
    expect((await s.list.execute({ limit: 50, offset: 0 })).total).toBe(2);
  });

  it('does not reindex data when saving the alias fails', async () => {
    const s = await setup();
    await seed(s);
    s.repo.save = () =>
      Promise.resolve({ status: 'FAILED', reason: 'database unavailable' });
    expect(
      await s.create.execute({ alias: 'Alpha', canonical: 'Zulu' }),
    ).toMatchObject({ status: 'FAILED' });
    expect((await s.list.execute({ limit: 50, offset: 0 })).total).toBe(2);
  });

  it('immediately merges every market and evaluates signals without another snapshot', async () => {
    const s = await setup();
    await seed(s);
    expect((await s.list.execute({ limit: 50, offset: 0 })).total).toBe(2);
    const old = (await s.detail.execute({ match: 'cs2:alpha~beta' }))!;
    await s.create.execute({ alias: 'Alpha', canonical: 'Zulu' });
    const merged = (await s.list.execute({ limit: 50, offset: 0 })).items;
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      match: 'cs2:beta~zulu',
      matchedMarkets: 4,
    });
    expect(await s.detail.execute({ match: 'cs2:alpha~beta' })).toBeNull();
    const row = (await s.rooms.get(key())).lines.get('sptpub')!;
    expect(row.props.odds).toEqual([2.5, 1.5]);
    expect(row.props.ref).toMatchObject({ o0: '5', o1: '4' });
    expect(row.props.ref.url).toBe(old.markets[0].lines.sptpub.ref.url);
    expect(row.props.updatedAt).toBe(PRICE_AT);
    expect(
      (await s.detail.execute({ match: 'cs2:beta~zulu' }))!.markets[0].lines
        .sptpub.ageMs,
    ).toBe(65_000);
    expect(
      (await s.rooms.get(key('map-handicap-p1.5'))).lines.get('sptpub')!.props,
    ).toMatchObject({
      odds: [1.6, 2.8],
      ref: { o0: '1715', o1: '1714', s: 'hcp=-1.5' },
    });
    expect(
      (await s.rooms.get(key('total-maps-2.5'))).lines.get('sptpub')!.props
        .odds,
    ).toEqual([2.4, 1.7]);
    expect(s.evaluator.stats().issued).toBeGreaterThan(0);
    await s.ingest.execute(
      message(
        'sptpub.prematch',
        {
          version: 2,
          events: { E: { markets: { '186': { '': { '4': { k: '1.8' } } } } } },
        },
        NOW,
      ),
    );
    expect((await s.rooms.get(key())).lines.get('sptpub')!.props.odds).toEqual([
      2.5, 1.8,
    ]);
    expect(await s.detail.execute({ match: 'cs2:alpha~beta' })).toBeNull();
  });

  it('một bí danh ghép đúng hai trận của cùng đội với hai đối thủ khác nhau', async () => {
    const s = await setup();
    const first = sptpub('Bodo Glimt', 'Molde');
    const second = sptpub('Bodo Glimt', 'LASK Linz');
    await s.ingest.execute(
      message('sptpub.prematch', {
        ...first,
        events: { E: first.events.E, F: second.events.E },
      }),
    );
    const polyFirst = polymarket('FK Bodo Glimt', 'Molde')[0];
    const polySecond = polymarket('FK Bodo Glimt', 'LASK Linz')[0];
    polySecond.id = 'Q';
    polySecond.markets.forEach((market, index) => {
      market.conditionId = `D${index}`;
      market.slug = `second-market-${index}`;
    });
    await s.ingest.execute(
      message('polymarket.descriptor', [polyFirst, polySecond]),
    );
    expect((await s.list.execute({ limit: 50, offset: 0 })).total).toBe(4);
    const saved = await s.create.execute({
      alias: 'Bodo Glimt',
      canonical: 'FK Bodo Glimt',
    });
    expect(saved.status).toBe('SUCEED');
    const after = (await s.list.execute({ limit: 50, offset: 0 })).items;
    expect(after).toHaveLength(2);
    expect(after.every((match) => match.matchedMarkets === 4)).toBe(true);
    expect(await s.list.candidates({ limit: 50, minScore: 0.8 })).toEqual([]);
  });

  it('rekeys Polymarket prices and token sides, including later stream and descriptor messages', async () => {
    const s = await setup();
    await seed(s, 'Zulu', 'Alpha');
    await s.ingest.execute(
      message(
        'polymarket.stream',
        {
          type: 'best_bid_ask',
          payload: { assetId: 'yes0', bestAsk: 0.25 },
        },
        NOW - 1_000,
      ),
    );
    await s.create.execute({ alias: 'Alpha', canonical: 'Zulu' });
    const line = (await s.rooms.get(key())).lines.get('polymarket')!;
    expect(line.props).toMatchObject({
      odds: [2, 4],
      updatedAt: NOW - 1_000,
      ref: {
        t0: 'no0',
        t1: 'yes0',
        url: 'https://polymarket.com/event/original-event-slug',
      },
    });
    expect(
      (await s.rooms.get(key('map-handicap-p1.5'))).lines.get('polymarket')!
        .props.ref.t0,
    ).toBe('no2');
    expect(
      (await s.rooms.get(key('total-maps-2.5'))).lines.get('polymarket')!.props
        .ref.t0,
    ).toBe('yes3');
    await s.ingest.execute(
      message(
        'polymarket.stream',
        {
          type: 'best_bid_ask',
          payload: { assetId: 'yes0', bestAsk: 0.2 },
        },
        NOW,
      ),
    );
    expect(
      (await s.rooms.get(key())).lines.get('polymarket')!.props.odds,
    ).toEqual([2, 5]);
    await s.ingest.execute(
      message('polymarket.descriptor', polymarket('Alpha'), NOW),
    );
    expect(
      (await s.rooms.get(key())).lines.get('polymarket')!.props.odds,
    ).toEqual([2, 5]);
    expect(await s.detail.execute({ match: 'cs2:alpha~beta' })).toBeNull();
  });

  it('deleting an alias restores original rooms and cancels signals for the merged identity', async () => {
    const s = await setup();
    await seed(s);
    const result = await s.create.execute({
      alias: 'Alpha',
      canonical: 'Zulu',
    });
    if (result.status !== 'SUCEED') throw new Error('alias save failed');
    await s.remove.execute({ id: result.data.props.id });
    const items = (await s.list.execute({ limit: 50, offset: 0 })).items;
    expect(items).toHaveLength(2);
    expect(items.every((m) => m.matchedMarkets === 0)).toBe(true);
    const original = (await s.detail.execute({ match: 'cs2:alpha~beta' }))!;
    expect(
      original.markets.find((m) => m.market === 'game-winner')!.lines.sptpub
        .odds,
    ).toEqual([1.5, 2.5]);
    expect((await s.rooms.get(key())).lines.has('sptpub')).toBe(false);
    expect((await s.signals.getCombos(key().toString())).size).toBe(0);
    expect(s.evaluator.stats().cancelled).toBeGreaterThan(0);
  });

  it('updates an existing alias from the original source name, without leaving old rooms', async () => {
    const s = await setup();
    await seed(s);
    await s.create.execute({ alias: 'Alpha', canonical: 'Zulu' });
    await s.create.execute({ alias: 'Alpha', canonical: 'Omega' });
    expect((await s.rooms.get(key())).lines.has('sptpub')).toBe(false);
    const changed = (await s.detail.execute({ match: 'cs2:beta~omega' }))!;
    expect(changed.markets).toHaveLength(4);
    expect(changed.markets[0].lines.sptpub.updatedAt).toBe(PRICE_AT);
    expect((await s.list.execute({ limit: 50, offset: 0 })).total).toBe(2);
  });

  it('needs aliases for both mismatched teams, not just one', async () => {
    const s = await setup();
    await s.ingest.execute(message('sptpub.prematch', sptpub('Alpha', 'Beta')));
    await s.ingest.execute(
      message('polymarket.descriptor', polymarket('Zulu', 'Gamma')),
    );
    await s.create.execute({ alias: 'Alpha', canonical: 'Zulu' });
    expect((await s.list.execute({ limit: 50, offset: 0 })).total).toBe(2);
    await s.create.execute({ alias: 'Beta', canonical: 'Gamma' });
    expect(
      (await s.list.execute({ limit: 50, offset: 0 })).items,
    ).toMatchObject([{ match: 'cs2:gamma~zulu', matchedMarkets: 4 }]);
  });

  it('does not issue signals when match start times exceed the allowed drift', async () => {
    const s = await setup();
    await s.ingest.execute(message('sptpub.prematch', sptpub()));
    await s.ingest.execute(
      message(
        'polymarket.descriptor',
        polymarket('Zulu', 'Beta', START + 86_400_000),
      ),
    );
    await s.create.execute({ alias: 'Alpha', canonical: 'Zulu' });
    expect((await s.rooms.get(key())).lines.size).toBe(2);
    expect(
      (await s.rooms.get(key())).combinations(
        (await s.settings.get()).maxStartDriftMs,
      ),
    ).toEqual([]);
    expect(s.evaluator.stats().issued).toBe(0);
  });

  it('does not crash or publish self-matches when aliases collapse both teams', async () => {
    const s = await setup();
    await seed(s, 'Alpha', 'Alpha');
    const result = await s.create.execute({
      alias: 'Alpha',
      canonical: 'Beta',
    });
    if (result.status !== 'SUCEED') throw new Error('alias save failed');
    expect((await s.list.execute({ limit: 50, offset: 0 })).total).toBe(0);
    await s.remove.execute({ id: result.data.props.id });
    expect(
      (await s.list.execute({ limit: 50, offset: 0 })).items[0].matchedMarkets,
    ).toBe(4);
  });

  it('does not resurrect released publisher data after changing aliases', async () => {
    const s = await setup();
    await seed(s);
    const result = await s.create.execute({
      alias: 'Alpha',
      canonical: 'Zulu',
    });
    if (result.status !== 'SUCEED') throw new Error('alias save failed');
    await s.release.execute({
      taskId: 'sptpub.prematch',
      kind: 'sptpub.prematch',
    });
    await s.remove.execute({ id: result.data.props.id });
    expect(await s.detail.execute({ match: 'cs2:alpha~beta' })).toBeNull();
    expect((await s.rooms.get(key())).lines.has('sptpub')).toBe(false);
  });

  it('does not resurrect finished matches from translator caches', async () => {
    const s = await setup();
    const oldStart = NOW - 24 * 3_600_000;
    const feed = sptpub();
    feed.events.E.desc.scheduled = oldStart / 1000;
    await s.ingest.execute(message('sptpub.prematch', feed));
    await s.ingest.execute(
      message('polymarket.descriptor', polymarket('Zulu', 'Beta', oldStart)),
    );
    await s.expire.execute({ maxMatchDurationMs: 8 * 3_600_000 });
    expect((await s.list.execute({ limit: 50, offset: 0 })).total).toBe(0);
    await s.create.execute({ alias: 'Alpha', canonical: 'Zulu' });
    expect((await s.list.execute({ limit: 50, offset: 0 })).total).toBe(0);
  });

  it('orders reindexing after an in-flight descriptor so old room writes cannot return', async () => {
    let unblock!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const s = await setup(async () => {
      entered();
      await blocked;
    });
    await s.ingest.execute(message('sptpub.prematch', sptpub('Zulu')));
    const descriptor = s.ingest.execute(
      message('polymarket.descriptor', polymarket('Alpha')),
    );
    await ready;
    const alias = s.create.execute({ alias: 'Alpha', canonical: 'Zulu' });
    await vi.waitFor(() => expect(s.teams.resolve('Alpha')).toBe('zulu'));
    unblock();
    await Promise.all([descriptor, alias]);
    expect((await s.list.execute({ limit: 50, offset: 0 })).total).toBe(1);
    expect((await s.rooms.get(key())).lines.size).toBe(2);
    expect(await s.detail.execute({ match: 'cs2:alpha~beta' })).toBeNull();
  });
});
