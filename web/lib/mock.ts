import 'server-only';
import type {
  AdminSnapshot,
  ArbitrageSettings,
  ArbitrageSignal,
  AuditEntry,
  ConsumerView,
  Incident,
  IngestCounter,
  IngestSnapshot,
  ListResult,
  MatchCandidate,
  MatchDetail,
  MatchLine,
  MatchListItem,
  MatchMarketRow,
  NodeView,
  OddsTransition,
  Phase,
  RoomDetailView,
  RoomListItem,
  SignalHistoryItem,
  TaskKindInfo,
  SignalTier,
  NotifyChannelStatus,
  NotifyChannelView,
  TaskRecord,
  TeamAlias,
} from './types';
import type { BackendResponse } from './backend';
import { mockTrading } from './mock-trading';

/**
 * Dữ liệu mẫu (ARB_MOCK=true) — đủ cho mọi màn hình, có biến động theo thời gian
 * (odds nhảy, bộ đếm tăng, kèo xuất hiện/hủy) để thấy hiệu ứng realtime. Không gọi backend.
 * Trạng thái ghi (bí danh, cài đặt, task, consumer, xác nhận sự cố) giữ trong RAM của server.
 */
const BOOT = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const now = () => Date.now();

/** Băm chuỗi → số [0,1) ổn định. */
function rand(seed: string): number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995) >>> 0;
  return (h >>> 0) / 4294967296;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

// ============================================================ settings
let settings: ArbitrageSettings = {
  minMargin: 0.02,
  marginStep: 0.01,
  marginDropStep: 0.01,
  signalTtlMs: 300_000,
  maxStartDriftMs: 1_200_000,
  enabledPhases: ['live', 'prematch'],
};

// ============================================================ trận + odds
interface MarketSeed {
  market: string;
  /** odds gốc từng tenant: [side0, side1], status */
  lines: Record<string, { odds: [number, number]; status?: 'open' | 'suspended'; age?: number }>;
}
interface MatchSeed {
  sport: string;
  teams: [string, string];
  phase: Phase;
  startsIn: number; // ms, âm = đã bắt đầu
  markets: MarketSeed[];
  /** độ trễ khác nhau giữa các tenant khi lệch giờ */
  startsShift?: Record<string, number>;
}

/** Sinh odds hai phía từ xác suất p với biên nhà cái vig. */
const fair = (p: number, vig = 0.05): [number, number] => [
  round2(1 / (p * (1 + vig))),
  round2(1 / ((1 - p) * (1 + vig))),
];

function bo3(
  teams: [string, string],
  p: number,
  tenants: Record<string, number>, // tenant → vig
  overrides: Record<string, MarketSeed['lines']> = {},
  only?: Record<string, string[]>, // tenant → market subset
): MarketSeed[] {
  const list: { market: string; p: number }[] = [
    { market: 'game-winner', p },
    { market: 'map-1-winner', p: 0.5 + (p - 0.5) * 0.7 },
    { market: 'map-2-winner', p: 0.5 + (p - 0.5) * 0.6 },
    { market: 'map-3-winner', p: 0.5 + (p - 0.5) * 0.5 },
    { market: 'map-handicap-m1.5', p: Math.max(0.22, p - 0.26) },
    { market: 'map-handicap-p1.5', p: Math.min(0.9, p + 0.28) },
    { market: 'total-maps-2.5', p: 0.42 },
  ];
  return list.map(({ market, p: mp }) => {
    const lines: MarketSeed['lines'] = {};
    for (const [t, vig] of Object.entries(tenants)) {
      if (only?.[t] && !only[t]!.includes(market)) continue;
      const skew = (rand(`${teams.join()}${market}${t}`) - 0.5) * 0.06;
      lines[t] = { odds: fair(Math.min(0.94, Math.max(0.06, mp + skew)), vig) };
    }
    return { market, lines: { ...lines, ...overrides[market] } };
  });
}

const MATCHES: MatchSeed[] = [
  {
    sport: 'cs2',
    teams: ['alliance', 'sinners'],
    phase: 'prematch',
    startsIn: 34 * MIN,
    markets: bo3(
      ['alliance', 'sinners'],
      0.46,
      { sptpub: 0.045, polymarket: 0.025 },
      {
        'game-winner': { sptpub: { odds: [2.2, 1.78] }, polymarket: { odds: [2.02, 2.04] } },
        'map-handicap-p1.5': {
          sptpub: { odds: [1.75, 2.1] },
          polymarket: { odds: [1.62, 2.4] },
        },
        'map-handicap-m1.5': {
          sptpub: { odds: [4.1, 1.22] },
          polymarket: { odds: [3.8, 1.29], status: 'suspended', age: 45_000 },
        },
      },
      { polymarket: ['game-winner', 'map-1-winner', 'map-2-winner', 'map-handicap-m1.5', 'map-handicap-p1.5', 'total-maps-2.5'] },
    ),
  },
  {
    sport: 'cs2',
    teams: ['heroic', 'vitality'],
    phase: 'prematch',
    startsIn: 2 * HOUR + 10 * MIN,
    markets: bo3(
      ['heroic', 'vitality'],
      0.31,
      { sptpub: 0.05, polymarket: 0.02 },
      { 'game-winner': { sptpub: { odds: [3.45, 1.36] }, polymarket: { odds: [2.9, 1.42] } } },
    ),
  },
  {
    sport: 'cs2',
    teams: ['furia', 'mouz'],
    phase: 'live',
    startsIn: -38 * MIN,
    markets: bo3(
      ['furia', 'mouz'],
      0.55,
      { sptpub: 0.06, polymarket: 0.03 },
      {
        'map-handicap-m1.5': { sptpub: { odds: [3.1, 1.43] }, polymarket: { odds: [2.75, 1.47] } },
        'map-1-winner': { sptpub: { odds: [1.62, 2.25], status: 'suspended', age: 8_000 } },
      },
      { polymarket: ['game-winner', 'map-1-winner', 'map-2-winner', 'map-handicap-m1.5'] },
    ),
  },
  {
    sport: 'lol',
    teams: ['t1', 'geng'],
    phase: 'live',
    startsIn: -22 * MIN,
    markets: bo3(['t1', 'geng'], 0.58, { sptpub: 0.055, polymarket: 0.03 }, {}, {
      polymarket: ['game-winner', 'map-1-winner', 'map-2-winner'],
    }),
  },
  {
    sport: 'cs2',
    teams: ['natus-vincere', 'the-mongolz-esports-club'],
    phase: 'prematch',
    startsIn: 5 * HOUR,
    markets: bo3(['natus-vincere', 'the-mongolz-esports-club'], 0.52, { sptpub: 0.05, polymarket: 0.03 }, {}, {
      polymarket: ['game-winner', 'total-maps-2.5'],
    }),
  },
  {
    sport: 'lol',
    teams: ['fnatic', 'g2'],
    phase: 'prematch',
    startsIn: 7 * HOUR,
    markets: bo3(['fnatic', 'g2'], 0.41, { sptpub: 0.06, polymarket: 0.04 }),
  },
  {
    sport: 'cs2',
    teams: ['aaa', 'infurity'],
    phase: 'prematch',
    startsIn: 3 * HOUR,
    markets: bo3(['aaa', 'infurity'], 0.5, { sptpub: 0.05 }),
  },
  {
    sport: 'cs2',
    teams: ['aaa', 'inf'],
    phase: 'prematch',
    startsIn: 3 * HOUR + 5 * MIN,
    markets: bo3(['aaa', 'inf'], 0.5, { polymarket: 0.03 }, {}, { polymarket: ['game-winner', 'map-1-winner'] }),
  },
  {
    sport: 'cs2',
    teams: ['mouz', 'nip'],
    phase: 'prematch',
    startsIn: 9 * HOUR,
    markets: bo3(['mouz', 'nip'], 0.63, { sptpub: 0.05 }),
  },
  {
    sport: 'cs2',
    teams: ['mouz', 'ninjas-in-pyjamas'],
    phase: 'prematch',
    startsIn: 9 * HOUR + 15 * MIN,
    markets: bo3(['mouz', 'ninjas-in-pyjamas'], 0.63, { polymarket: 0.03 }, {}, { polymarket: ['game-winner'] }),
  },
  {
    sport: 'lol',
    teams: ['t1', 'gen-g'],
    phase: 'live',
    startsIn: -22 * MIN,
    markets: bo3(['t1', 'gen-g'], 0.58, { polymarket: 0.03 }, {}, { polymarket: ['map-3-winner'] }),
  },
];

const BOOT_SPORT_START = Math.floor(BOOT / MIN) * MIN;
const matchId = (m: MatchSeed) => `${m.sport}:${m.teams[0]}~${m.teams[1]}`;
const roomId = (m: MatchSeed, market: string) => `room:${matchId(m)}:${market}`;

function picksOf(teams: [string, string], market: string): [string, string] {
  const hcp = /^map-handicap-([mp])(\d\.5)$/.exec(market);
  if (hcp) {
    const v = hcp[2];
    return hcp[1] === 'm' ? [`${teams[0]} -${v}`, `${teams[1]} +${v}`] : [`${teams[0]} +${v}`, `${teams[1]} -${v}`];
  }
  const tot = /^total-maps-(\d\.5)$/.exec(market);
  if (tot) return [`over ${tot[1]}`, `under ${tot[1]}`];
  const map = /^map-(\d)-winner$/.exec(market);
  if (map) return [`${teams[0]} (map ${map[1]})`, `${teams[1]} (map ${map[1]})`];
  return [teams[0], teams[1]];
}

/** Odds nhảy nhẹ mỗi ~7s cho một phần market (để thấy highlight thay đổi). */
function liveOdds(seed: string, base: [number, number]): [number, number] {
  const tick = Math.floor(now() / 7_000);
  const r = rand(`${seed}:${tick}`);
  if (r < 0.55) return base;
  const d = round2((rand(`${seed}:${tick}:d`) - 0.5) * 0.12);
  return [round2(Math.max(1.01, base[0] + d)), round2(Math.max(1.01, base[1] - d))];
}

const startsOf = (m: MatchSeed) => BOOT_SPORT_START + m.startsIn;

function lineOf(m: MatchSeed, ms: MarketSeed, tenant: string): MatchLine {
  const l = ms.lines[tenant]!;
  const seed = `${roomId(m, ms.market)}:${tenant}`;
  const status = l.status ?? 'open';
  const ageBase = l.age ?? (tenant === 'polymarket' ? 4_000 : 1_000);
  return {
    odds: status === 'suspended' ? l.odds : liveOdds(seed, l.odds),
    status,
    phase: m.phase,
    ageMs: ageBase + Math.round(rand(`${seed}:${Math.floor(now() / 3000)}`) * 2_500),
    startsAt: startsOf(m),
    ref:
      tenant === 'sptpub'
        ? {
            e: String(2715093596264079406n + BigInt(Math.floor(rand(matchId(m)) * 1e6))),
            m: String(100 + Math.floor(rand(ms.market) * 400)),
            s: ms.market.includes('handicap') ? `hcp=${ms.market.endsWith('m1.5') ? '-1.5' : '1.5'}` : ms.market.includes('total') ? 'total=2.5' : '',
            o0: String(1700 + Math.floor(rand(seed) * 99)),
            o1: String(1700 + Math.floor(rand(seed + 'x') * 99)),
            url: `https://csgoempire.com/match-betting?${new URLSearchParams({ 'bt-path': `/counter-strike/counter-strike/league/${m.teams.join('-')}-${String(2715093596264079406n + BigInt(Math.floor(rand(matchId(m)) * 1e6)))}` })}`,
          }
        : {
            c: `0x${Math.floor(rand(seed) * 1e15).toString(16).padStart(13, '0')}…`,
            slug: `${m.sport}-${m.teams[0]}-${m.teams[1]}`,
            url: `https://polymarket.com/event/${m.sport}-${m.teams[0]}-${m.teams[1]}`,
            t0: `${Math.floor(rand(seed + '0') * 1e12)}…`,
            t1: `${Math.floor(rand(seed + '1') * 1e12)}…`,
          },
  };
}

/** margin = 1/(1/o0 + 1/o1) − 1 cho mọi cặp tenant khác nhau. */
function combosOf(lines: Record<string, MatchLine>) {
  const ts = Object.keys(lines);
  const out: { a: string; b: string; margin: number; open: boolean }[] = [];
  for (const a of ts)
    for (const b of ts) {
      if (a === b) continue;
      const la = lines[a]!;
      const lb = lines[b]!;
      const margin = 1 / (1 / la.odds[0] + 1 / lb.odds[1]) - 1;
      out.push({ a, b, margin, open: la.status === 'open' && lb.status === 'open' });
    }
  return out.sort((x, y) => y.margin - x.margin);
}

function marketRow(m: MatchSeed, ms: MarketSeed): MatchMarketRow {
  const lines: Record<string, MatchLine> = {};
  for (const t of Object.keys(ms.lines)) lines[t] = lineOf(m, ms, t);
  const combos = combosOf(lines);
  const best = combos[0]?.margin ?? null;
  const openBest = combos.find((c) => c.open);
  const active = openBest && openBest.margin >= settings.minMargin && settings.enabledPhases.includes(m.phase) ? 1 : 0;
  return {
    market: ms.market,
    room: roomId(m, ms.market),
    picks: picksOf(m.teams, ms.market),
    lines,
    combos: combos.length,
    bestMargin: best,
    aboveMinMargin: best !== null && best >= settings.minMargin,
    activeSignals: active,
  };
}

function matchDetail(id: string): MatchDetail | null {
  const m = MATCHES.find((x) => matchId(x) === id);
  if (!m) return null;
  const markets = m.markets.filter((x) => Object.keys(x.lines).length).map((ms) => marketRow(m, ms));
  return {
    match: id,
    sport: m.sport,
    teams: m.teams,
    tenants: [...new Set(markets.flatMap((r) => Object.keys(r.lines)))],
    startsAt: startsOf(m),
    minMargin: settings.minMargin,
    markets,
  };
}

function matchList(search: string): ListResult<MatchListItem> {
  const q = new URLSearchParams(search);
  const text = (q.get('q') ?? '').toLowerCase();
  const items = MATCHES.map((m): MatchListItem => {
    const d = matchDetail(matchId(m))!;
    const coverage: Record<string, number> = {};
    for (const r of d.markets) for (const t of Object.keys(r.lines)) coverage[t] = (coverage[t] ?? 0) + 1;
    const matched = d.markets.filter((r) => Object.keys(r.lines).length >= 2);
    const best = matched.reduce<number | null>((b, r) => (r.bestMargin !== null && (b === null || r.bestMargin > b) ? r.bestMargin : b), null);
    return {
      match: d.match,
      sport: d.sport,
      teams: d.teams,
      tenants: d.tenants,
      markets: d.markets.length,
      matchedMarkets: matched.length,
      coverage,
      phases: [m.phase],
      bestMargin: best,
      aboveMinMargin: best !== null && best >= settings.minMargin,
      startsAt: d.startsAt,
      lastUpdatedAt: now() - 1_500,
    };
  })
    .filter((m) => !text || m.match.includes(text))
    .filter((m) => !q.get('sport') || m.sport === q.get('sport'))
    .filter((m) => !q.get('tenant') || m.tenants.includes(q.get('tenant')!))
    .filter((m) => !q.get('phase') || m.phases.includes(q.get('phase') as Phase))
    .filter((m) => q.get('matched') !== 'true' || m.tenants.length >= 2)
    .sort((a, b) => (b.bestMargin ?? -1) - (a.bestMargin ?? -1));
  return { total: items.length, items };
}

function allRows(): { m: MatchSeed; row: MatchMarketRow }[] {
  return MATCHES.flatMap((m) => m.markets.map((ms) => ({ m, row: marketRow(m, ms) })));
}

function rooms(): RoomListItem[] {
  return allRows().map(({ m, row }) => ({
    room: row.room,
    sport: m.sport,
    market: row.market,
    teams: m.teams,
    picks: row.picks,
    tenants: Object.keys(row.lines),
    phases: [m.phase],
    bestMargin: Object.keys(row.lines).length >= 2 ? row.bestMargin : null,
    aboveMinMargin: row.aboveMinMargin,
    startsAt: startsOf(m),
    lastUpdatedAt: now() - 2_000,
  }));
}

function signalOf(m: MatchSeed, row: MatchMarketRow): ArbitrageSignal | null {
  const c = combosOf(row.lines).find((x) => x.open);
  if (!c || c.margin < settings.minMargin || !settings.enabledPhases.includes(m.phase)) return null;
  const ttl = settings.signalTtlMs;
  const offset = Math.floor(rand(row.room) * ttl);
  const issuedAt = Math.floor((now() + offset) / ttl) * ttl - offset;
  return {
    signalId: `sig-${Math.floor(rand(row.room + Math.floor(now() / 600_000)) * 1e8).toString(36)}`,
    room: row.room,
    sport: m.sport,
    market: row.market,
    teams: m.teams,
    comboId: `${c.a}>0|${c.b}>1`,
    phase: m.phase,
    margin: c.margin,
    legs: [
      { tenant: c.a, side: 0, pick: row.picks[0], odds: row.lines[c.a]!.odds[0], ref: row.lines[c.a]!.ref },
      { tenant: c.b, side: 1, pick: row.picks[1], odds: row.lines[c.b]!.odds[1], ref: row.lines[c.b]!.ref },
    ],
    issuedAt,
    expiresAt: issuedAt + ttl,
  };
}

const signals = (): ArbitrageSignal[] =>
  allRows()
    .map(({ m, row }) => signalOf(m, row))
    .filter((s): s is ArbitrageSignal => !!s)
    .sort((a, b) => b.issuedAt - a.issuedAt);

function roomDetail(id: string): RoomDetailView | null {
  const hit = allRows().find((x) => x.row.room === id);
  if (!hit) return null;
  const { m, row } = hit;
  const lines: RoomDetailView['lines'] = {};
  for (const [t, l] of Object.entries(row.lines))
    lines[t] = {
      ...l,
      updatedAt: now() - l.ageMs,
      raw: `${l.odds[0]}|${l.odds[1]}|${l.status === 'open' ? 'o' : 's'}|${l.phase === 'live' ? 'l' : 'p'}|${now() - l.ageMs}|${l.startsAt}|${Object.entries(l.ref)
        .map(([k, v]) => `${k}=${v}`)
        .join('&')}`,
    };
  return {
    room: row.room,
    sport: m.sport,
    market: row.market,
    teams: m.teams,
    lines,
    picks: row.picks,
    combos: combosOf(row.lines).map((c) => ({
      comboId: `${c.a}>0|${c.b}>1`,
      phase: m.phase,
      margin: c.margin,
      aboveMinMargin: c.margin >= settings.minMargin,
      legs: [
        { tenant: c.a, pick: row.picks[0], odds: row.lines[c.a]!.odds[0] },
        { tenant: c.b, pick: row.picks[1], odds: row.lines[c.b]!.odds[1] },
      ],
    })),
    minMargin: settings.minMargin,
    activeSignals: signals().filter((s) => s.room === row.room),
  };
}

// ============================================================ ghép trượt + bí danh
let aliases: TeamAlias[] = [
  ['navi', 'natus-vincere'],
  ['mongolz', 'the-mongolz-esports-club'],
  ['vita', 'vitality'],
  ['g2-esports', 'g2'],
  ['fnc', 'fnatic'],
  ['team-liquid', 'liquid'],
  ['faze-clan', 'faze'],
].map(([alias, canonical], i) => ({
  id: `al-${i + 1}`,
  alias: alias!,
  canonical: canonical!,
  createdAt: BOOT - (i + 1) * 26 * HOUR,
  createdBy: i % 2 ? 'thanh' : 'demo',
}));

function candidates(search: string): MatchCandidate[] {
  const q = new URLSearchParams(search);
  const min = Number(q.get('minScore') ?? 0);
  const side = (id: string) => {
    const d = matchDetail(id)!;
    return { match: id, teams: d.teams, tenants: d.tenants, startsAt: d.startsAt };
  };
  const list: MatchCandidate[] = [
    {
      score: 0.9,
      startsDiffMs: 5 * MIN,
      a: side('cs2:aaa~infurity'),
      b: side('cs2:aaa~inf'),
      pairs: [['aaa', 'aaa'], ['infurity', 'inf']],
      aliases: [{ alias: 'inf', canonical: 'infurity', similarity: 0.8 }],
    },
    {
      score: 0.95,
      startsDiffMs: 0,
      a: side('lol:t1~geng'),
      b: side('lol:t1~gen-g'),
      pairs: [['t1', 't1'], ['geng', 'gen-g']],
      aliases: [{ alias: 'gen-g', canonical: 'geng', similarity: 0.92 }],
    },
    {
      score: 0.71,
      startsDiffMs: 15 * MIN,
      a: side('cs2:mouz~nip'),
      b: side('cs2:mouz~ninjas-in-pyjamas'),
      pairs: [['mouz', 'mouz'], ['nip', 'ninjas-in-pyjamas']],
      aliases: [{ alias: 'nip', canonical: 'ninjas-in-pyjamas', similarity: 0.46 }],
    },
  ];
  const known = new Set(aliases.map((a) => a.alias));
  return list
    .filter((c) => c.score >= min)
    .filter((c) => !q.get('sport') || c.a.match.startsWith(`${q.get('sport')}:`))
    .map((c) => ({ ...c, aliases: c.aliases.filter((a) => !known.has(a.alias)) }))
    .filter((c) => c.aliases.length > 0)
    .sort((a, b) => b.score - a.score);
}

// ============================================================ publisher, node, consumer, sự cố
const createdTasks = new Map<string, TaskRecord>();
const stopped = new Set<string>();
const deleted = new Set<string>();

function task(
  taskId: string,
  kind: string,
  state: TaskRecord['state'],
  runtime: TaskRecord['spec']['runtime'],
  lastDataAgo: number | null,
  extra: Partial<TaskRecord> = {},
): TaskRecord {
  return {
    spec: { taskId, tenant: kind.split('.')[0]!, kind, params: KIND_DEFAULTS[kind] ?? {}, runtime },
    state,
    consecutiveFailures: 0,
    totalRestarts: 0,
    lastHeartbeatAt: state === 'STOPPED' ? null : now() - 1_500,
    lastDataAt: lastDataAgo === null ? null : now() - lastDataAgo,
    lastSeq: 18_234 + Math.floor((now() - BOOT) / 1000),
    lastError: null,
    updatedAt: now() - 20 * MIN,
    ...extra,
  };
}

const KIND_DEFAULTS: Record<string, Record<string, unknown>> = {
  'sptpub.descriptor': { baseUrl: 'https://api.sptpub.com', brandId: '2381', lang: 'en', intervalMs: 60_000 },
  'sptpub.live': { baseUrl: 'https://api.sptpub.com', brandId: '2381', lang: 'en', intervalMs: 1_000 },
  'sptpub.prematch': { baseUrl: 'https://api.sptpub.com', brandId: '2381', lang: 'en', intervalMs: 2_000 },
  'polymarket.descriptor': { tagIds: [100639], intervalMs: 30_000 },
  'polymarket.stream': { resubscribeDebounceMs: 500 },
};

function tasks(): TaskRecord[] {
  const base = [
    task('sptpub-descriptor', 'sptpub.descriptor', 'RUNNING', { type: 'remote', nodeId: 'node-01' }, 4 * MIN + 10_000),
    task('sptpub-live', 'sptpub.live', 'RUNNING', { type: 'remote', nodeId: 'node-01' }, 900),
    task('sptpub-prematch', 'sptpub.prematch', 'FAILED', { type: 'remote', nodeId: 'node-02' }, 6 * MIN, {
      consecutiveFailures: 6,
      totalRestarts: 11,
      lastError:
        'HTTP 503 Service Unavailable từ https://api.sptpub.com/api/v3/prematch/brand/2381/en/0 — upstream connect error or disconnect/reset before headers. reset reason: connection termination',
      updatedAt: now() - 3 * MIN,
    }),
    task('polymarket-descriptor', 'polymarket.descriptor', 'RUNNING', { type: 'worker' }, 12_000),
    task('polymarket-stream', 'polymarket.stream', 'RESTARTING', { type: 'remote', nodeId: 'node-03' }, 42_000, {
      consecutiveFailures: 3,
      totalRestarts: 7,
      lastError: 'socket hang up (wss://ws-subscriptions-clob.polymarket.com/ws/market)',
    }),
    task('sptpub-live-v1', 'sptpub.live', 'STOPPED', { type: 'remote', nodeId: 'node-01' }, 26 * HOUR, {
      updatedAt: now() - 26 * HOUR,
    }),
  ];
  const all = [...base, ...createdTasks.values()].filter((t) => !deleted.has(t.spec.taskId));
  return all.map((t) => {
    if (stopped.has(t.spec.taskId)) return { ...t, state: 'STOPPED' as const, lastHeartbeatAt: null };
    if (createdTasks.has(t.spec.taskId)) {
      const age = now() - t.updatedAt;
      const state: TaskRecord['state'] = age < 2_000 ? 'CREATED' : age < 4_000 ? 'STARTING' : 'RUNNING';
      return { ...t, state, lastDataAt: state === 'RUNNING' ? now() - 1_000 : null };
    }
    return t;
  });
}

const KINDS: TaskKindInfo[] = [
  {
    kind: 'trader.arbitrage',
    tenant: 'trader',
    multiInstance: true,
    params: [
      { name: 'profileId', type: 'string', required: true, hint: 'Id profile trader (trang Auto trade)' },
      { name: 'sharedExposure', type: 'boolean', required: false, default: true, hint: 'Giới hạn tổng theo trận dùng chung qua Redis' },
    ],
  },
  {
    kind: 'sptpub.descriptor',
    tenant: 'sptpub',
    concept: 'descriptor',
    params: [
      { name: 'baseUrl', type: 'string', required: true, hint: 'URL API của sptpub' },
      { name: 'brandId', type: 'string', required: true },
      { name: 'lang', type: 'string', required: true, default: 'en' },
      { name: 'intervalMs', type: 'number', required: false, default: 60_000, hint: 'Chu kỳ quét (ms)' },
    ],
  },
  {
    kind: 'sptpub.live',
    tenant: 'sptpub',
    concept: 'live',
    params: [
      { name: 'baseUrl', type: 'string', required: true },
      { name: 'brandId', type: 'string', required: true },
      { name: 'lang', type: 'string', required: true, default: 'en' },
      { name: 'intervalMs', type: 'number', required: false, default: 1_000 },
      { name: 'maxConsecutiveErrors', type: 'number', required: false, hint: 'Quá số lần lỗi liên tiếp → restart' },
    ],
  },
  {
    kind: 'sptpub.prematch',
    tenant: 'sptpub',
    concept: 'prematch',
    params: [
      { name: 'baseUrl', type: 'string', required: true },
      { name: 'brandId', type: 'string', required: true },
      { name: 'lang', type: 'string', required: true, default: 'en' },
      { name: 'intervalMs', type: 'number', required: false, default: 2_000 },
      { name: 'maxConsecutiveErrors', type: 'number', required: false },
    ],
  },
  {
    kind: 'polymarket.descriptor',
    tenant: 'polymarket',
    concept: 'descriptor',
    params: [
      { name: 'tagIds', type: 'number[]', required: true, default: [100639], hint: 'Danh sách tag, cách nhau bởi dấu phẩy' },
      { name: 'intervalMs', type: 'number', required: false, default: 30_000 },
      { name: 'live', type: 'boolean', required: false },
      { name: 'pageSize', type: 'number', required: false },
    ],
  },
  {
    kind: 'polymarket.stream',
    tenant: 'polymarket',
    concept: 'stream',
    params: [
      { name: 'assetIds', type: 'json', required: false, hint: 'Bỏ trống — app tự gửi token qua lệnh subscribe' },
      { name: 'resubscribeDebounceMs', type: 'number', required: false, default: 500 },
    ],
  },
];

/** Dạng backend thật: { kind, tenant, paramsSchema } (JSON Schema). */
function toBackendKind(k: TaskKindInfo) {
  const ty = (t: string) => (t === 'number[]' ? { type: 'array', items: { type: 'number' } } : t === 'json' ? {} : { type: t });
  return {
    kind: k.kind,
    tenant: k.tenant,
    multiInstance: k.concept === 'descriptor',
    paramsSchema: {
      type: 'object',
      properties: Object.fromEntries((k.params ?? []).map((p) => [p.name, { ...ty(p.type), ...(p.default !== undefined ? { default: p.default } : {}), ...(p.hint ? { description: p.hint } : {}) }])),
      required: (k.params ?? []).filter((p) => p.required).map((p) => p.name),
    },
  };
}

const nodes = (): NodeView[] => [
  { nodeId: 'node-01', connected: true, connectedAt: BOOT - 3 * HOUR, disconnectedAt: null, tasks: 3 },
  { nodeId: 'node-02', connected: true, connectedAt: BOOT - 3 * HOUR, disconnectedAt: null, tasks: 1 },
  { nodeId: 'node-03', connected: true, connectedAt: BOOT - 40 * MIN, disconnectedAt: BOOT - 41 * MIN, tasks: 1 },
  { nodeId: 'node-04', connected: false, connectedAt: BOOT - 30 * HOUR, disconnectedAt: BOOT - 12 * MIN, tasks: 0 },
];

const paused = new Set<string>(['trader-4']);

// ---------------------------------------------------------------- kênh thông báo + hạng kèo (mẫu)
let tiers: SignalTier[] = [
  { id: 'tier-vip', name: 'VIP', minMargin: 0.05, maxMargin: null },
  { id: 'tier-svip', name: 'Super VIP', minMargin: 0.1, maxMargin: null },
];
const emptyStatus = (): NotifyChannelStatus => ({ sent: 0, failed: 0, dropped: 0, queued: 0, lastSentAt: null, lastError: null, lastErrorAt: null });
let channels: NotifyChannelView[] = [
  { id: 'ch-1', name: 'Discord VIP', type: 'discord', enabled: true, tierIds: ['tier-vip'], target: 'https://discord.com/…x9a2', status: { ...emptyStatus(), sent: 42, lastSentAt: Date.now() - 95_000 } },
  { id: 'ch-2', name: 'Telegram Super VIP', type: 'telegram', enabled: true, tierIds: ['tier-svip'], target: 'chat -1001234567890 · bot …Qw3e', status: { ...emptyStatus(), sent: 7, lastSentAt: Date.now() - 600_000 } },
  { id: 'ch-3', name: 'Slack nội bộ', type: 'slack', enabled: false, tierIds: [], target: 'https://hooks.slack.com/…7f1c', status: emptyStatus() },
];
type ChannelBody = { name?: string; enabled?: boolean; tierIds?: string[]; config?: { type?: NotifyChannelView['type']; webhookUrl?: string; botToken?: string; chatId?: string } };
const channelFrom = (id: string, b: ChannelBody, old?: NotifyChannelView): NotifyChannelView | string => {
  const c = b.config ?? {};
  const type = c.type ?? old?.type ?? 'discord';
  if (!b.name?.trim()) return 'CHANNEL_NAME_REQUIRED';
  const keep = old?.type === type;
  if (type === 'telegram') {
    if (!c.chatId?.trim()) return 'CHAT_ID_REQUIRED';
    if (!c.botToken && !keep) return 'BOT_TOKEN_REQUIRED';
  } else if (!c.webhookUrl && !keep) return 'WEBHOOK_URL_REQUIRED';
  const target = type === 'telegram' ? `chat ${c.chatId} · bot …${(c.botToken ?? 'xxxx').slice(-4)}` : c.webhookUrl ? `${new URL(c.webhookUrl).origin}/…${c.webhookUrl.slice(-4)}` : (old?.target ?? '');
  return { id, name: b.name.trim(), type, enabled: b.enabled ?? true, tierIds: (b.tierIds ?? []).filter((t) => tiers.some((x) => x.id === t)), target, status: old?.status ?? emptyStatus() };
};
const consumers = (): ConsumerView[] =>
  [
    { consumerId: 'trader-1', role: 'trader', connected: true, pending: 0 },
    { consumerId: 'trader-2', role: 'trader', connected: true, pending: 2 },
    { consumerId: 'trader-3', role: 'trader', connected: true, pending: 57 },
    { consumerId: 'trader-4', role: 'trader', connected: true, pending: 0 },
    { consumerId: 'discord-alerts', role: 'discord', connected: true, pending: 0 },
    { consumerId: 'trader-eu-backup', role: 'trader', connected: false, pending: 0 },
  ].map((c, i) => ({
    ...c,
    paused: paused.has(c.consumerId),
    lastSeenAt: c.connected ? now() - 1_000 - i * 300 : BOOT - 2 * HOUR,
  }));

const acked = new Map<string, number>();

function incidentList(): Incident[] {
  const open: Omit<Incident, 'id' | 'details' | 'lastSeenAt' | 'resolvedAt' | 'resolution' | 'acknowledgedAt' | 'acknowledgedBy'>[] = [
    {
      key: 'task.failed:sptpub-prematch',
      kind: 'task.failed',
      severity: 'critical',
      title: 'Publisher sptpub-prematch FAILED',
      message: 'Lỗi liên tiếp 6 lần · node-02 · HTTP 503 từ feed',
      openedAt: BOOT - 3 * MIN,
    },
    {
      key: 'odds.mass_removal:polymarket',
      kind: 'odds.mass_removal',
      severity: 'warning',
      title: 'Polymarket gỡ 42% market trong một vòng quét',
      message: 'Đang giữ lại 118/281 market · vòng 2/5 — có thể do API lỗi',
      openedAt: BOOT - 6 * MIN,
    },
    {
      key: 'task.flapping:polymarket-stream',
      kind: 'task.flapping',
      severity: 'warning',
      title: 'polymarket-stream khởi động lại liên tục',
      message: '3 lần lỗi liên tiếp · socket hang up',
      openedAt: BOOT - 9 * MIN,
    },
    {
      key: 'consumer.backlog:trader-3',
      kind: 'consumer.backlog',
      severity: 'warning',
      title: 'trader-3 tồn 57 kèo chưa ack',
      message: 'Ngưỡng 50 · kiểm tra bot',
      openedAt: BOOT - 14 * MIN,
    },
  ];
  return open.map((i, n) => ({
    ...i,
    id: `inc-open-${n}`,
    details: { taskId: i.key.split(':')[1], node: 'node-02' },
    lastSeenAt: now() - 2_000,
    resolvedAt: null,
    resolution: null,
    acknowledgedAt: acked.get(i.key) ?? null,
    acknowledgedBy: acked.has(i.key) ? 'demo' : null,
  }));
}

function incidentHistory(): Incident[] {
  const kinds: [string, Incident['severity'], string, string][] = [
    ['node.down', 'critical', 'Node node-04 mất kết nối', 'node-04 · 0 task bị ảnh hưởng'],
    ['source.stale', 'critical', 'sptpub-live không có dữ liệu', 'RUNNING nhưng 45s không có bản tin'],
    ['lane.backlog', 'warning', 'Làn polymarket:live tồn 1 240 cập nhật', 'Ngưỡng 1000'],
    ['consumer.down', 'critical', 'trader-eu-backup mất kết nối', 'Mất kết nối > 30s'],
    ['infra.down', 'critical', 'Postgres không phản hồi', 'timeout 3s'],
    ['task.flapping', 'warning', 'sptpub-live khởi động lại liên tục', '3 lần lỗi liên tiếp'],
  ];
  const resolved: Incident[] = Array.from({ length: 22 }, (_, i) => {
    const [kind, severity, title, message] = kinds[i % kinds.length]!;
    const openedAt = BOOT - (i + 1) * 3.4 * HOUR - Math.floor(rand(`inc${i}`) * HOUR);
    const dur = (2 + Math.floor(rand(`dur${i}`) * 40)) * MIN;
    return {
      id: `inc-${i}`,
      key: `${kind}:${i}`,
      kind,
      severity,
      title,
      message,
      details: {},
      openedAt,
      lastSeenAt: openedAt + dur,
      resolvedAt: openedAt + dur,
      resolution: i % 7 === 3 ? 'app_restart' : 'recovered',
      acknowledgedAt: i % 3 ? openedAt + 2 * MIN : null,
      acknowledgedBy: i % 3 ? (i % 2 ? 'thanh' : 'demo') : null,
    };
  });
  return [...incidentList(), ...resolved];
}

// ============================================================ ingest
function ingest(): IngestSnapshot {
  const t = (now() - BOOT) / 1000;
  const wave = (base: number, k = 7) => base * (1 + 0.12 * Math.sin(t / k));
  const grow = (start: number, rate: number) => start + Math.round(wave(rate) * t);
  const sp = grow(18_234, 18);
  const pm = grow(8_914, 9.6);
  const pmPf = Math.round(64 + t * (0.4 + t / 900)); // parse_failed đang tăng
  const items: IngestCounter[] = [
    {
      tenant: 'sptpub',
      kind: 'sptpub.live',
      received: sp,
      failed: 0,
      set: grow(52_110, 3.1),
      remove: 340 + Math.round(t * 0.05),
      skipped: {
        unsupported_market: grow(120_400, 6.6),
        unsupported_line: grow(2_100, 0.12),
        unsupported_sport: grow(9_000, 0.5),
        parse_failed: 4,
      },
      lastReceivedAt: now() - 900,
      lastChangeAt: now() - 1_200,
    },
    {
      tenant: 'sptpub',
      kind: 'sptpub.prematch',
      received: 4_120,
      failed: 31,
      set: 61_880,
      remove: 1_208,
      skipped: { unsupported_market: 210_300, unsupported_line: 5_400, unsupported_sport: 18_200, invalid_event: 12 },
      lastReceivedAt: BOOT - 6 * MIN,
      lastChangeAt: BOOT - 6 * MIN,
    },
    {
      tenant: 'sptpub',
      kind: 'sptpub.descriptor',
      received: 182,
      failed: 0,
      set: 0,
      remove: 0,
      skipped: { unsupported_sport: 1_340, same_team_names: 2, no_moneyline_teams: 9 },
      lastReceivedAt: now() - 4 * MIN - 10_000,
      lastChangeAt: now() - 4 * MIN - 10_000,
    },
    {
      tenant: 'polymarket',
      kind: 'polymarket.stream',
      received: pm,
      failed: 0,
      set: grow(24_100, 7.2),
      remove: 340 + Math.round(t * 0.9),
      skipped: { parse_failed: pmPf, unknown_asset: grow(410, 0.3), missing_fields: 22 },
      lastReceivedAt: now() - 2_000,
      lastChangeAt: now() - 2_400,
    },
    {
      tenant: 'polymarket',
      kind: 'polymarket.descriptor',
      received: 640 + Math.floor(t / 30),
      failed: 2,
      set: 0,
      remove: 118,
      skipped: { unsupported_sport: 8_800, invalid_event: 41, no_moneyline_teams: 17 },
      lastReceivedAt: now() - 12_000,
      lastChangeAt: now() - 12_000,
    },
  ];
  return { since: BOOT - 2 * HOUR, at: now(), items };
}

// ============================================================ snapshot
function snapshot(): AdminSnapshot {
  const t = (now() - BOOT) / 1000;
  const rs = rooms();
  const sig = signals();
  const ts = tasks();
  return {
    at: now(),
    incidents: incidentList(),
    health: [
      { name: 'dragonfly', ok: true, latencyMs: 1, error: null, checkedAt: now() },
      { name: 'postgres', ok: true, latencyMs: 4, error: null, checkedAt: now() },
    ],
    tasks: ts,
    nodes: nodes(),
    consumers: consumers(),
    arbitrage: {
      activeSignals: sig.length,
      evaluator: {
        evaluations: 182_000 + Math.round(t * 300),
        roomsEvaluated: rs.length,
        lastEvaluatedAt: now(),
        issued: 412 + Math.floor(t / 20),
        refreshed: 3_120 + Math.floor(t / 4),
        cancelled: 388 + Math.floor(t / 25),
        cancelledByReason: { below_threshold: 301, leg_suspended: 70, leg_removed: 17 },
        errors: 0,
        lastError: null,
      },
      rooms: {
        total: rs.length,
        matched: rs.filter((r) => r.tenants.length >= 2).length,
        withCombos: rs.filter((r) => r.bestMargin !== null).length,
        aboveMinMargin: rs.filter((r) => r.aboveMinMargin).length,
        minMargin: settings.minMargin,
        byTenant: {
          sptpub: { lines: 14_102, open: 13_842, suspended: 260, newestAgeMs: 900 },
          polymarket: { lines: 9_350, open: 8_914, suspended: 436, newestAgeMs: 2_000 },
        },
      },
    },
    lanes: [
      { lane: 'sptpub:live', queued: 0, processed: 52_400 + Math.round(t * 3), coalesced: 1_200, busy: false, lastProcessedAt: now() },
      { lane: 'sptpub:prematch', queued: 0, processed: 61_880, coalesced: 300, busy: false, lastProcessedAt: BOOT - 6 * MIN },
      { lane: 'polymarket:live', queued: 180, processed: 24_100 + Math.round(t * 7), coalesced: 900, busy: true, lastProcessedAt: now() - 4_000 },
      { lane: 'polymarket:prematch', queued: 0, processed: 6_000, coalesced: 40, busy: false, lastProcessedAt: now() },
    ],
    settings,
    retention: null,
  };
}

// ============================================================ lịch sử kèo, audit, odds transitions
/** Kèo đã xóa tay khỏi lịch sử (mẫu). */
const removedHistory = new Set<string>();
function history(search: string): ListResult<SignalHistoryItem> {
  const q = new URLSearchParams(search);
  const reasons = ['below_threshold', 'leg_suspended', 'leg_removed', 'below_threshold', 'start_time_mismatch', 'match_expired'];
  const statuses: SignalHistoryItem['status'][] = ['cancelled', 'superseded', 'cancelled', 'cancelled', 'abandoned', 'superseded'];
  const rows = allRows().filter((r) => Object.keys(r.row.lines).length >= 2);
  const past: SignalHistoryItem[] = Array.from({ length: 64 }, (_, i) => {
    const { m, row } = rows[i % rows.length]!;
    const issuedAt = now() - (i + 1) * 7 * MIN - Math.floor(rand(`h${i}`) * 5 * MIN);
    const status = statuses[i % statuses.length]!;
    const ts = Object.keys(row.lines);
    const margin = 0.02 + rand(`hm${i}`) * 0.035;
    const statusReason = status === 'cancelled' ? reasons[i % reasons.length]! : status === 'abandoned' ? 'app_restart' : null;
    const start = Math.floor((issuedAt + 2 * 3_600_000) / (15 * MIN)) * 15 * MIN;
    return {
      signalId: `sig-h${i.toString(36)}`,
      room: row.room,
      sport: m.sport,
      market: row.market,
      teams: m.teams,
      comboId: `${ts[0]}>0|${ts[1]}>1`,
      phase: m.phase,
      margin,
      legs: [
        { tenant: ts[0]!, side: 0, pick: row.picks[0], odds: row.lines[ts[0]!]!.odds[0], ref: row.lines[ts[0]!]!.ref, startsAt: start },
        { tenant: ts[1]!, side: 1, pick: row.picks[1], odds: row.lines[ts[1]!]!.odds[1], ref: row.lines[ts[1]!]!.ref, startsAt: start },
      ],
      issuedAt,
      expiresAt: issuedAt + settings.signalTtlMs,
      status,
      statusReason,
      supersededBy: status === 'superseded' ? `sig-h${(i + 1).toString(36)}` : null,
      endedAt: issuedAt + Math.floor(rand(`he${i}`) * 4 * MIN) + 10_000,
      // mẫu: lệch giờ = chân đầu bị dời 45 phút
      closeDetail:
        statusReason === 'start_time_mismatch'
          ? {
              startTimes: [
                { tenant: ts[0]!, startsAt: start + 45 * MIN },
                { tenant: ts[1]!, startsAt: start },
              ],
              startDriftMs: 45 * MIN,
              maxStartDriftMs: settings.maxStartDriftMs,
            }
          : null,
    };
  });
  const active: SignalHistoryItem[] = signals().map((s) => ({ ...s, status: 'active', statusReason: null, supersededBy: null, endedAt: null }));
  const from = Number(q.get('from') ?? 0);
  const to = Number(q.get('to') ?? 0) || Infinity;
  const items = [...active, ...past]
    .filter((s) => !removedHistory.has(s.signalId))
    .filter((s) => !q.get('status') || s.status === q.get('status'))
    .filter((s) => !q.get('phase') || s.phase === q.get('phase'))
    .filter((s) => !q.get('room') || s.room === q.get('room'))
    .filter((s) => !q.get('sport') || s.sport === q.get('sport'))
    .filter((s) => !q.get('market') || s.market === q.get('market'))
    .filter((s) => {
      const t = (q.get('q') ?? '').trim().toLowerCase();
      return !t || s.signalId.toLowerCase().startsWith(t) || s.teams.join(' ').toLowerCase().includes(t) || s.room.toLowerCase().includes(t);
    })
    .filter((s) => s.issuedAt >= from && s.issuedAt <= to);
  const limit = Number(q.get('limit') ?? 50);
  const offset = Number(q.get('offset') ?? 0);
  return { total: items.length, items: items.slice(offset, offset + limit) };
}

const auditExtra: AuditEntry[] = [];
function audit(search: string): ListResult<AuditEntry> {
  const q = new URLSearchParams(search);
  const ops: [string, string, Record<string, unknown>, unknown, number][] = [
    ['POST', '/admin/incidents/:key/ack', { key: 'task.flapping:sptpub-live' }, null, 200],
    ['PATCH', '/arbitrage/settings', {}, { minMargin: 0.02 }, 200],
    ['POST', '/team-aliases', {}, { alias: 'navi', canonical: 'natus-vincere' }, 201],
    ['POST', '/tasks/:taskId/stop', { taskId: 'sptpub-live-v1' }, null, 200],
    ['POST', '/tasks', {}, { taskId: 'sptpub-live', kind: 'sptpub.live', runtime: { type: 'remote', nodeId: 'node-01' }, params: { baseUrl: 'https://api.sptpub.com', brandId: '2381', lang: 'en' } }, 201],
    ['POST', '/consumers/:id/pause', { id: 'trader-4' }, null, 200],
    ['POST', '/tasks/:taskId/commands', { taskId: 'polymarket-stream' }, { name: 'resubscribe' }, 403],
    ['DELETE', '/team-aliases/:id', { id: 'al-9' }, null, 200],
    ['POST', '/tasks', {}, { taskId: 'sptpub-live', kind: 'sptpub.live' }, 400],
  ];
  const base: AuditEntry[] = Array.from({ length: 40 }, (_, i) => {
    const [method, route, params, body, status] = ops[i % ops.length]!;
    return {
      id: `au-${i}`,
      at: now() - (i + 1) * 47 * MIN - Math.floor(rand(`a${i}`) * 30 * MIN),
      principalId: i % 3 === 0 ? 'thanh' : i % 3 === 1 ? 'demo' : 'ops-bot',
      method,
      route,
      params,
      body,
      status,
      ok: status < 400,
      durationMs: 4 + Math.floor(rand(`ad${i}`) * 80),
    };
  });
  const items = [...auditExtra, ...base]
    .filter((a) => !q.get('principalId') || a.principalId === q.get('principalId'))
    .filter((a) => !q.get('method') || a.method === q.get('method'))
    .filter((a) => !q.get('route') || a.route.includes(q.get('route')!))
    .filter((a) => !q.get('from') || a.at >= Number(q.get('from')));
  return { total: items.length, items: items.slice(0, Number(q.get('limit') ?? 100)) };
}

function record(method: string, route: string, params: Record<string, unknown>, body: unknown, status = 200) {
  auditExtra.unshift({
    id: `au-x${auditExtra.length}`,
    at: now(),
    principalId: 'demo',
    method,
    route,
    params,
    body,
    status,
    ok: status < 400,
    durationMs: 6,
  });
}

function transitions(search: string): ListResult<OddsTransition> {
  const q = new URLSearchParams(search);
  const rows = allRows();
  const reasons = ['missing_from_listing', 'match_expired', 'publisher_stopped', null];
  const list: OddsTransition[] = [];
  rows.forEach(({ row }, ri) => {
    const ts = Object.keys(row.lines);
    ts.forEach((tenant, ti) => {
      const seed = `${row.room}${tenant}`;
      const appeared = now() - (2 + Math.floor(rand(seed) * 20)) * HOUR;
      const l = row.lines[tenant]!;
      list.push({ id: `${ri}-${ti}-0`, at: appeared, room: row.room, tenant, from: null, to: 'open', reason: null, odds: l.odds });
      if (rand(seed + 's') > 0.4) {
        const at = appeared + Math.floor(rand(seed + 'a') * 60) * MIN;
        list.push({ id: `${ri}-${ti}-1`, at, room: row.room, tenant, from: 'open', to: 'suspended', reason: null, odds: l.odds });
        list.push({ id: `${ri}-${ti}-2`, at: at + 3 * MIN, room: row.room, tenant, from: 'suspended', to: 'open', reason: null, odds: l.odds });
      }
      if (l.status === 'suspended')
        list.push({ id: `${ri}-${ti}-3`, at: now() - l.ageMs, room: row.room, tenant, from: 'open', to: 'suspended', reason: null, odds: l.odds });
    });
    if (ri % 9 === 4)
      list.push({
        id: `${ri}-rm`,
        at: now() - (ri + 1) * 4 * MIN,
        room: row.room,
        tenant: 'polymarket',
        from: 'open',
        to: 'removed',
        reason: reasons[ri % reasons.length] ?? null,
        odds: null,
      });
  });
  const items = list
    .filter((x) => !q.get('room') || x.room === q.get('room'))
    .filter((x) => !q.get('tenant') || x.tenant === q.get('tenant'))
    .filter((x) => !q.get('to') || x.to === q.get('to'))
    .filter((x) => !q.get('from') || x.at >= Number(q.get('from')))
    .sort((a, b) => b.at - a.at);
  return { total: items.length, items: items.slice(0, Number(q.get('limit') ?? 200)) };
}

function listRooms(search: string): ListResult<RoomListItem> {
  const q = new URLSearchParams(search);
  const phase = q.get('phase');
  const limit = Number(q.get('limit') ?? 50);
  const items = rooms()
    .filter((r) => !phase || r.phases.includes(phase as Phase))
    .filter((r) => q.get('matched') !== 'true' || r.tenants.length >= 2)
    .filter((r) => !q.get('q') || r.room.includes(q.get('q')!))
    .sort((a, b) => (b.bestMargin ?? -1) - (a.bestMargin ?? -1));
  return { total: items.length, items: items.slice(0, limit) };
}

// ============================================================ router
export async function mockRequest(
  method: string,
  path: string,
  search: string,
  body?: unknown,
): Promise<BackendResponse> {
  await new Promise((r) => setTimeout(r, 90 + Math.random() * 80)); // giống độ trễ mạng
  const ok = (b: unknown, status = 200) => ({ status, body: b });
  const notFound = { status: 404, body: { message: 'Not Found' } };
  const seg = (prefix: string) => (path.startsWith(prefix) ? path.slice(prefix.length) : null);
  const trading = mockTrading(method, path, search, body, () => tiers);
  if (trading) return trading;

  if (method === 'GET') {
    if (path === 'admin/snapshot') return ok(snapshot());
    if (path === 'admin/incidents') {
      const q = new URLSearchParams(search);
      const list = q.get('open') === 'true' ? incidentList() : incidentHistory();
      return ok({ total: list.length, items: list.filter((i) => !q.get('kind') || i.kind === q.get('kind')) });
    }
    if (path === 'admin/audit') return ok(audit(search));
    if (path === 'admin/odds-transitions') return ok(transitions(search));
    if (path === 'arbitrage/ingest') return ok(ingest());
    if (path === 'arbitrage/signals') return ok(signals());
    if (path === 'arbitrage/settings') return ok(settings);
    if (path === 'arbitrage/lanes') return ok(snapshot().lanes);
    if (path === 'arbitrage/rooms') return ok(listRooms(search));
    if (path === 'arbitrage/matches') return ok(matchList(search));
    if (path === 'arbitrage/match-candidates') return ok(candidates(search));
    if (path === 'arbitrage/history') return ok(history(search));
    const h = seg('arbitrage/history/');
    if (h) return ok(history('limit=999').items.find((s) => s.signalId === h) ?? null);
    const r = seg('arbitrage/rooms/');
    if (r) return roomDetail(r) ? ok(roomDetail(r)) : notFound;
    const m = seg('arbitrage/matches/');
    if (m) return matchDetail(m) ? ok(matchDetail(m)) : notFound;
    if (path === 'team-aliases') return ok(aliases);
    if (path === 'consumers') return ok(consumers());
    if (path === 'notify/tiers') return ok([...tiers].sort((a, b) => a.minMargin - b.minMargin));
    if (path === 'notify/channels') return ok(channels);
    if (path === 'tasks') return ok(tasks());
    if (path === 'tasks/kinds') return ok(KINDS.map(toBackendKind));
    const t = seg('tasks/');
    if (t) return ok(tasks().find((x) => x.spec.taskId === t) ?? null);
  }

  if (method === 'POST' && path === 'arbitrage/history/purge') {
    const b = (body ?? {}) as { statuses?: string[]; olderThanDays?: number; all?: boolean; dryRun?: boolean };
    if (!b.all && !b.olderThanDays) return { status: 400, body: { message: 'PURGE_SCOPE_REQUIRED' } };
    const before = b.all ? Date.now() + 1 : Date.now() - (b.olderThanDays ?? 0) * 86_400_000;
    const hit = history('limit=100000').items.filter((s) => s.status !== 'active' && s.issuedAt < before && (!b.statuses?.length || b.statuses.includes(s.status)));
    if (!b.dryRun) for (const s of hit) removedHistory.add(s.signalId);
    return ok({ before, matched: hit.length, deleted: b.dryRun ? 0 : hit.length });
  }
  if (method === 'DELETE' && path.startsWith('arbitrage/history/')) {
    const id = decodeURIComponent(path.slice('arbitrage/history/'.length));
    const s = history('limit=100000').items.find((x) => x.signalId === id);
    if (!s) return { status: 404, body: { message: 'Not Found' } };
    if (s.status === 'active') return { status: 400, body: { message: 'SIGNAL_ACTIVE: kèo đang sống, chưa xóa được' } };
    removedHistory.add(id);
    return ok({ deleted: true });
  }
  if (method === 'POST') {
    // mẫu: dữ liệu sinh lại mỗi lần nên chỉ trả số đếm giả định, không thật sự xóa
    const purge = /^admin\/(audit|odds-transitions)\/purge$/.exec(path);
    if (purge) {
      const b = (body ?? {}) as { olderThanDays?: number; all?: boolean; dryRun?: boolean };
      if (!b.all && !b.olderThanDays) return { status: 400, body: { message: 'PURGE_SCOPE_REQUIRED' } };
      const matched = b.all ? 240 : Math.max(0, 200 - (b.olderThanDays ?? 0) * 6);
      return ok({ target: purge[1], before: Date.now() - (b.olderThanDays ?? 0) * 86_400_000, matched, deleted: b.dryRun ? 0 : matched });
    }
    const ack = /^admin\/incidents\/(.+)\/ack$/.exec(path);
    if (ack) {
      const key = decodeURIComponent(ack[1]!);
      acked.set(key, now());
      record('POST', '/admin/incidents/:key/ack', { key }, null);
      return ok(incidentList().find((i) => i.key === key) ?? null);
    }
    if (path === 'team-aliases/bulk') {
      const b = body as { aliases?: { alias: string; canonical: string }[] };
      const norm = (s = '') => s.trim().toLowerCase().replace(/\s+/g, '-');
      if (!b?.aliases?.length || b.aliases.length > 100) return ok({ message: 'Cần từ 1 đến 100 bí danh' }, 400);
      const incoming = new Map<string, string>();
      for (const item of b.aliases) {
        const alias = norm(item.alias);
        const canonical = norm(item.canonical);
        if (!alias || !canonical || alias === canonical) return ok({ message: `Bí danh không hợp lệ: ${item.alias}` }, 400);
        if (incoming.has(alias) && incoming.get(alias) !== canonical) return ok({ message: `Tên ${alias} có nhiều tên chuẩn` }, 409);
        const existing = aliases.find((a) => a.alias === alias);
        if (existing && existing.canonical !== canonical) return ok({ message: `Tên ${alias} đã trỏ tới ${existing.canonical}` }, 409);
        incoming.set(alias, canonical);
      }
      const created: TeamAlias[] = [];
      const unchanged: string[] = [];
      for (const [alias, canonical] of incoming) {
        if (aliases.some((a) => a.alias === alias)) unchanged.push(alias);
        else created.push({ id: `al-${Date.now()}-${created.length}`, alias, canonical, createdAt: now(), createdBy: 'demo' });
      }
      aliases = [...created, ...aliases];
      record('POST', '/team-aliases/bulk', {}, b, 201);
      return ok({ created, unchanged, failed: [] }, 201);
    }
    if (path === 'team-aliases') {
      const b = body as { alias?: string; canonical?: string };
      const norm = (s = '') => s.trim().toLowerCase().replace(/\s+/g, '-');
      if (!b?.alias || !b.canonical) return ok({ message: 'Thiếu alias hoặc canonical' }, 400);
      if (aliases.some((a) => a.alias === norm(b.alias))) return ok({ message: `Bí danh "${norm(b.alias)}" đã tồn tại` }, 409);
      const item: TeamAlias = { id: `al-${Date.now()}`, alias: norm(b.alias), canonical: norm(b.canonical), createdAt: now(), createdBy: 'demo' };
      aliases = [item, ...aliases];
      record('POST', '/team-aliases', {}, b, 201);
      return ok(item, 201);
    }
    const cp = /^consumers\/(.+)\/(pause|resume)$/.exec(path);
    if (cp) {
      const id = decodeURIComponent(cp[1]!);
      if (cp[2] === 'pause') paused.add(id);
      else paused.delete(id);
      record('POST', `/consumers/:id/${cp[2]}`, { id }, null);
      return ok(consumers().find((c) => c.consumerId === id) ?? null);
    }
    if (path === 'notify/tiers') {
      const b = body as Omit<SignalTier, 'id'>;
      if (tiers.some((t) => t.name.toLowerCase() === b.name?.trim().toLowerCase())) return ok({ message: `TIER_NAME_TAKEN: đã có hạng "${b.name}"` }, 400);
      const tier: SignalTier = { id: `tier-${Date.now()}`, name: b.name.trim(), minMargin: b.minMargin, maxMargin: b.maxMargin ?? null };
      tiers = [...tiers, tier];
      record('POST', '/notify/tiers', {}, b, 201);
      return ok(tier, 201);
    }
    if (path === 'notify/channels') {
      const ch = channelFrom(`ch-${Date.now()}`, body as ChannelBody);
      if (typeof ch === 'string') return ok({ message: ch }, 400);
      channels = [...channels, ch];
      record('POST', '/notify/channels', {}, { ...(body as object), config: '…' }, 201);
      return ok(ch, 201);
    }
    const nt = /^notify\/channels\/(.+)\/test$/.exec(path);
    if (nt) {
      const id = decodeURIComponent(nt[1]!);
      const ch = channels.find((c) => c.id === id);
      if (!ch) return notFound;
      ch.status = { ...ch.status, sent: ch.status.sent + 1, lastSentAt: Date.now() };
      record('POST', '/notify/channels/:id/test', { id }, null);
      return ok(true);
    }
    const rs = /^tasks\/(.+)\/start$/.exec(path);
    if (rs) {
      const id = decodeURIComponent(rs[1]!);
      if (!tasks().some((x) => x.spec.taskId === id)) return notFound;
      stopped.delete(id);
      record('POST', '/tasks/:taskId/start', { taskId: id }, null);
      return ok(tasks().find((x) => x.spec.taskId === id) ?? null);
    }
    if (path === 'tasks') {
      const b = body as { taskId?: string; kind?: string; runtime?: TaskRecord['spec']['runtime']; params?: Record<string, unknown>; persist?: boolean };
      if (!b?.taskId || !b.kind) return ok({ message: 'Thiếu taskId hoặc kind' }, 400);
      if (!KINDS.some((k) => k.kind === b.kind)) return ok({ message: 'UNKNOWN_KIND' }, 400);
      if (tasks().some((x) => x.spec.taskId === b.taskId)) return ok({ message: `taskId "${b.taskId}" đã tồn tại` }, 400);
      if (KINDS.find((k) => k.kind === b.kind)?.concept !== 'descriptor' && tasks().some((x) => x.spec.kind === b.kind && !['STOPPED', 'FAILED'].includes(x.state)))
        return ok({ message: `KIND_ALREADY_RUNNING — ${b.kind} đang chạy` }, 400);
      const rec = task(b.taskId, b.kind, 'CREATED', b.runtime ?? { type: 'worker' }, null, { updatedAt: now(), lastSeq: null });
      rec.spec.params = b.params ?? {};
      rec.spec.persist = b.persist ?? false;
      createdTasks.set(b.taskId, rec);
      record('POST', '/tasks', {}, b, 201);
      return ok(rec, 201);
    }
    const st = /^tasks\/(.+)\/stop$/.exec(path);
    if (st) {
      const id = decodeURIComponent(st[1]!);
      stopped.add(id);
      record('POST', '/tasks/:taskId/stop', { taskId: id }, null);
      return ok(tasks().find((x) => x.spec.taskId === id) ?? null);
    }
    const cmd = /^tasks\/(.+)\/commands$/.exec(path);
    if (cmd) {
      record('POST', '/tasks/:taskId/commands', { taskId: decodeURIComponent(cmd[1]!) }, body, 403);
      return ok({ message: 'Thiếu quyền tasks:command' }, 403);
    }
  }

  if (method === 'PUT') {
    const tt = seg('notify/tiers/');
    if (tt) {
      const b = body as Omit<SignalTier, 'id'>;
      if (!tiers.some((t) => t.id === tt)) return notFound;
      if (tiers.some((t) => t.id !== tt && t.name.toLowerCase() === b.name?.trim().toLowerCase())) return ok({ message: `TIER_NAME_TAKEN: đã có hạng "${b.name}"` }, 400);
      tiers = tiers.map((t) => (t.id === tt ? { id: tt, name: b.name.trim(), minMargin: b.minMargin, maxMargin: b.maxMargin ?? null } : t));
      record('PUT', '/notify/tiers/:id', { id: tt }, b);
      return ok(tiers.find((t) => t.id === tt));
    }
    const cc = seg('notify/channels/');
    if (cc) {
      const old = channels.find((c) => c.id === cc);
      if (!old) return notFound;
      const ch = channelFrom(cc, body as ChannelBody, old);
      if (typeof ch === 'string') return ok({ message: ch }, 400);
      channels = channels.map((c) => (c.id === cc ? ch : c));
      record('PUT', '/notify/channels/:id', { id: cc }, { ...(body as object), config: '…' });
      return ok(ch);
    }
  }

  if (method === 'PATCH' && path === 'arbitrage/settings') {
    settings = { ...settings, ...(body as Partial<ArbitrageSettings>) };
    record('PATCH', '/arbitrage/settings', {}, body);
    return ok(settings);
  }

  if (method === 'DELETE') {
    const dt = seg('notify/tiers/');
    if (dt) {
      tiers = tiers.filter((t) => t.id !== dt);
      channels = channels.map((c) => ({ ...c, tierIds: c.tierIds.filter((x) => x !== dt) }));
      record('DELETE', '/notify/tiers/:id', { id: dt }, null);
      return ok(true);
    }
    const dc = seg('notify/channels/');
    if (dc) {
      channels = channels.filter((c) => c.id !== dc);
      record('DELETE', '/notify/channels/:id', { id: dc }, null);
      return ok(true);
    }
    const a = seg('team-aliases/');
    if (a) {
      aliases = aliases.filter((x) => x.id !== a);
      record('DELETE', '/team-aliases/:id', { id: a }, null);
      return ok({ ok: true });
    }
    const t = seg('tasks/');
    if (t) {
      const rec = tasks().find((x) => x.spec.taskId === t);
      if (rec && !['STOPPED', 'FAILED'].includes(rec.state)) return ok({ message: 'Task đang chạy — dừng trước khi xóa' }, 400);
      deleted.add(t);
      record('DELETE', '/tasks/:taskId', { taskId: t }, null);
      return ok({ ok: true });
    }
  }
  return { status: 404, body: { message: `Chế độ mẫu chưa có ${method} /${path}` } };
}
