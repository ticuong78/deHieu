import { targetStake } from '../../../../shared/domain/stake-table.js';
import { dailyReturn } from '../../../../shared/domain/daily-return.js';
import { createHash } from 'node:crypto';
import { AccountLock } from '../../../../shared/infrastructure/trading/account-lock.js';
import {
  LiveOrderExecutor,
  type LiveExecutor,
} from '../../../../shared/infrastructure/trading/live-executor.js';
import type { Task, TaskContext } from '../../application/task.js';
import { sleep } from '../shared/abortable.js';
import {
  polymarketRestUrls,
  type PolymarketEndpoints,
} from '../polymarket/polymarket-environment.js';
import {
  ConsumerHubClient,
  type HubCancel,
  type HubLeg,
  type HubSignal,
} from './consumer-hub.client.js';
import {
  InMemoryExposureLedger,
  RedisExposureLedger,
  type ExposureLedger,
} from './exposure-ledger.js';
import { PolymarketMarketData } from './polymarket-market-data.js';
import { TRADE_STRATEGIES } from './trade-strategies.js';
import {
  depthSummary,
  polymarketBuyShares,
  takerFeePerShare,
} from './arbitrage-sizing.js';
import {
  TraderConfigSchema,
  type TraderConfig,
} from './trader-config.schema.js';

export interface TraderArbitrageParams {
  readonly profileId: string;
  /** WS của ConsumerHub; mặc định ws://127.0.0.1:${CONSUMER_WS_PORT}. */
  readonly hubUrl?: string;
  /** Dùng Redis (REDIS_URL) để giới hạn tổng theo trận áp cho MỌI trader. Tắt = chỉ trong task này. */
  readonly sharedExposure: boolean;
  readonly endpoints?: PolymarketEndpoints;
}

/** Kênh dữ liệu gửi về app (module trading đọc). */
const CH_CONFIG_REQUEST = 'config_request';
const CH_TRADE = 'trade';
const CONFIG_RETRY_MS = 5_000;
/**
 * Nhịp báo sống (kênh 'status') khi đang nối hub. Trader chỉ gửi dữ liệu khi có kèo nên không có nhịp này
 * watchdog sẽ báo "nguồn im lặng" lúc vắng kèo; còn mất hub thì ngừng nhịp → watchdog báo đúng.
 */
const STATUS_EVERY_MS = 30_000;
const CH_STATUS = 'status';
/** Kèo chờ người vào lệnh (On click): phân tích mới nhất / gỡ khi kèo hết. */
const CH_ONECLICK = 'oneclick';
/**
 * Nhịp xét lại kèo còn sống bị bỏ vì SỔ LỆNH (hết lãi, sổ mỏng, dưới lệnh tối thiểu): sổ lệnh
 * Polymarket đổi liên tục mà publisher chỉ làm mới kèo theo thời hạn kèo (vd 5 phút).
 */
const BOOK_RECHECK_MS = 10_000;
/** Phơi nhiễm theo trận giữ tối đa ngần này (trận kết thúc / app không giải phóng). */
const EXPOSURE_TTL_MS = 12 * 3_600_000;

type Status =
  'paper_filled' | 'filled' | 'partial' | 'skipped' | 'cancelled' | 'error';

/**
 * Lý do bỏ qua phụ thuộc cấu hình profile → phần cấu hình quyết định lý do đó. Khi phần này đổi,
 * kèo còn sống từng bị bỏ qua vì lý do đó được xét lại MỘT lần (không chờ kèo phát mới).
 */
const CONFIG_SKIPS: Readonly<Record<string, (c: TraderConfig) => unknown>> = {
  INACTIVE: (c) => [c.active, c.inactiveReason],
  MARKET_NOT_SELECTED: (c) => c.risk.markets,
  TIER_NOT_SELECTED: (c) => c.stakeTable,
  NO_TIER: (c) => c.stakeTable,
  UNKNOWN_STRATEGY: (c) => c.strategy.id,
  ONE_CLICK: (c) => c.risk.oneClickMinPrice,
  // lãi tối thiểu / tiền tối thiểu của hạng đổi → tính lại trên sổ lệnh
  NO_EDGE: (c) => c.risk.minNetMargin,
  INSUFFICIENT_DEPTH: (c) => [c.risk.minNetMargin, c.stakeTable],
  BELOW_MIN_ORDER: (c) => [c.risk.minNetMargin, c.stakeTable],
  // nâng hạn mức trận (chung hoặc của profile) → kèo bị chặn vì hạn mức vào tiếp
  BUDGET_EXHAUSTED: (c) => [c.matchExposureCapUsd, c.risk.matchCapUsd],
  CAP_REACHED: (c) => [c.matchExposureCapUsd, c.risk.matchCapUsd],
  STALE_SIGNAL: (c) => c.risk.maxSignalAgeMs,
  SUSPICIOUS_MARGIN: (c) => c.risk.maxNetMargin,
  // hạ ngưỡng lãi/ngày (profile hoặc hạng) → kèo trận xa vào được
  LOW_DAILY_RETURN: (c) => [
    c.risk.minDailyMargin,
    c.stakeTable.map((r) => [r.tierId, r.minDailyMargin]),
  ],
  // tăng số lệnh mỗi hạng → cửa đang bị chặn được xét lại
  ALREADY_ENTERED: (c) => [
    c.risk.maxEntriesPerTier,
    c.stakeTable.map((r) => [r.tierId, r.maxEntries]),
  ],
};
const reasonCode = (r: string | null) => (r ?? '').split(':')[0].trim();
const configKey = (reason: string | null, c: TraderConfig): string | null => {
  const f = CONFIG_SKIPS[reasonCode(reason)];
  return f ? JSON.stringify(f(c)) : null;
};
/**
 * Bỏ qua TẠM THỜI: do lúc giao kèo, không do kèo/cấu hình (vd hub gửi lại bản lưu lúc làm mới
 * gần nhất sau khi trader nối lại → "quá cũ"). Lần hub giao kế tiếp (dữ liệu mới) xét lại.
 */
const TRANSIENT_SKIPS = new Set([
  'STALE_SIGNAL',
  'SIGNAL_EXPIRED',
  'HUB_PAUSED',
]);

/**
 * Bộ lọc của profile (market, hạng, profile đứng yên…): kèo bị lọc thì lần phát lại vẫn bị lọc,
 * chỉ xét lại khi phần cấu hình đó đổi — không ghi lại dòng bỏ qua mỗi lần làm mới.
 */
const FILTER_SKIPS = new Set([
  'INACTIVE',
  'MARKET_NOT_SELECTED',
  'TIER_NOT_SELECTED',
  'NO_TIER',
  'UNKNOWN_STRATEGY',
]);

/** Bỏ vì sổ lệnh lúc đó: xét lại theo nhịp BOOK_RECHECK_MS. */
const BOOK_SKIPS = new Set([
  'NO_EDGE',
  'INSUFFICIENT_DEPTH',
  'BELOW_MIN_ORDER',
  // market tạm không nhận lệnh có thể mở lại
  'MARKET_CLOSED',
]);
/** Bỏ vì sổ phơi nhiễm: xét lại khi admin trả lại hạn mức trận / đặt lại số lệnh của cửa. */
const EXPOSURE_SKIPS = new Set([
  'BUDGET_EXHAUSTED',
  'CAP_REACHED',
  'ALREADY_ENTERED',
]);

/** Người vào lệnh ở On click: ai bấm, tiền mục tiêu người nhập (bỏ trống = theo hạng của profile). */
interface ManualEntry {
  readonly by: string;
  readonly targetStake?: number;
}

/** Nguồn của một lần xử lý kèo. */
type Source =
  | 'hub'
  | 'config'
  | 'force'
  | 'recheck'
  | 'exposure'
  /** Hub giao lại kèo sau khi trader khởi động lại / nối lại hub (app restart, rớt mạng). */
  | 'restart'
  /** Admin resume consumer: kèo bị bỏ vì tạm dừng được xét lại. */
  | 'resume';

/**
 * Có xét lại kèo đã xử lý không:
 * - mỗi lần publisher phát kèo (mới hoặc làm mới, `fresh` = bản tin chưa xử lý) là MỘT lệnh:
 *   xét lại bất kể lần trước vào được hay bị bỏ (hết lãi, sổ mỏng, hạn mức…); giới hạn số lệnh
 *   mỗi hạng / hạn mức trận vẫn áp. Trừ kèo bị bộ lọc của profile loại;
 * - lần trước bị bỏ qua tạm thời và hub giao lại kèo (`delivered`);
 * - lần trước bị bỏ qua vì cấu hình mà phần cấu hình đó (hoặc logic) đã đổi.
 */
const needsRedo = (
  last: LiveSignal['last'],
  c: TraderConfig,
  source: Source,
  fresh: boolean,
): boolean => {
  if (!last) return false;
  const code = reasonCode(last.reason);
  if (source === 'recheck')
    // lỗi đọc sổ lệnh / API cũng đọc lại
    return (
      last.status === 'error' ||
      (last.status === 'skipped' && BOOK_SKIPS.has(code))
    );
  if (source === 'resume')
    return last.status === 'skipped' && code === 'HUB_PAUSED';
  if (source === 'exposure')
    return last.status === 'skipped' && EXPOSURE_SKIPS.has(code);
  const delivered = source === 'hub';
  return (
    (delivered && fresh && !FILTER_SKIPS.has(code)) ||
    (delivered && last.status === 'skipped' && TRANSIENT_SKIPS.has(code)) ||
    (last.configKey !== null && last.configKey !== configKey(last.reason, c))
  );
};

/** Kèo còn sống đã nhận từ hub (bản mới nhất) + kết quả lần xử lý gần nhất trong phiên task này. */
interface LiveSignal {
  signal: HubSignal;
  /** Số lần đã xử lý (để đặt id lệnh khác nhau khi xét lại). */
  attempts: number;
  /** issuedAt của bản tin (phát mới / làm mới) đã xử lý gần nhất: hub giao lại CÙNG bản tin không thành lệnh mới. */
  handledIssuedAt?: number;
  last: {
    status: Status;
    reason: string | null;
    configKey: string | null;
  } | null;
  /** Đang nằm trên bảng On click (đã gửi phân tích cho app). */
  oneClick?: boolean;
  /** Vừa nối lại hub: lần hub giao lại kèo này được xét lại (app restart / rớt mạng). */
  replayRedo?: boolean;
  /** Kèo đã xử lý ở phiên task trước (khởi động lại): id lệnh xét lại kèm mã phiên để không trùng. */
  restored?: boolean;
}

interface RunDeps {
  readonly ctx: TaskContext<TraderArbitrageParams>;
  readonly market: PolymarketMarketData;
  readonly ledger: ExposureLedger;
  readonly liveLedger: ExposureLedger;
  readonly hub: ConsumerHubClient;
}

/** `room:cs2:a~b:game-winner` → `cs2:a~b` (giới hạn theo TRẬN, gộp mọi market). */
export const matchOf = (room: string): string => {
  const parts = room.replace(/^room:/, '').split(':');
  return parts.length > 2 ? parts.slice(0, -1).join(':') : parts.join(':');
};

const bare = (l: HubLeg | undefined) =>
  l
    ? {
        tenant: l.tenant,
        side: l.side,
        pick: l.pick,
        odds: l.odds,
        // link trang trận trên sàn (để admin mở kiểm tra)
        url: l.ref.url ?? null,
        startsAt: typeof l.startsAt === 'number' ? l.startsAt : null,
        tournament: tournamentOf(l),
      }
    : null;

/** Thứ tự trận trong giải theo sàn của chân (ref tour/tno/tof do ACL gắn lúc nhận dữ liệu). */
const tournamentOf = (l: HubLeg) => {
  const no = Number(l.ref.tno);
  const of = Number(l.ref.tof);
  return no > 0 && of > 0 ? { name: l.ref.tour ?? null, no, of } : null;
};

/**
 * Trader arbitrage: consumer của ConsumerHub. Mỗi profile một task, mọi task nhận CÙNG một
 * kèo khi publisher phát một lần. Với mỗi kèo: chọn tiền theo bảng vốn của hạng → đọc sổ lệnh + phí
 * polymarket thật → chiến lược quyết định số share → giữ phơi nhiễm theo trận (Redis) → ghi kết quả.
 * Paper ghi mô phỏng; live kiểm tra Cash rồi gửi hai API trong khóa tài khoản.
 * Kèo bị hủy trước khi gửi → bỏ; đã gửi thì ghi nhận kết quả để đối soát.
 */
/** Mốc thời gian lệnh thật (ms). Polymarket gửi trước, BetBy chỉ gửi khi Polymarket khớp đủ. */
function executionTiming(
  issuedAt: number,
  e: {
    timing?: {
      startedAt: number;
      preparedAt: number;
      prepare?: Record<
        string,
        { totalMs: number; steps: Record<string, number> }
      >;
    };
    fills: { sentAt: number; ackedAt: number }[];
  },
) {
  const [book, poly] = e.fills;
  const leg = (f?: { sentAt: number; ackedAt: number }) =>
    f && f.sentAt > 0 ? f.ackedAt - f.sentAt : null;
  return {
    prepareMs: e.timing ? e.timing.preparedAt - e.timing.startedAt : null,
    /** Chuẩn bị từng sàn (chạy song song): tổng + từng bước, vd polymarket { client, cash, sign }. */
    prepare: e.timing?.prepare ?? null,
    /** Tuổi kèo (từ lúc publisher phát) khi lệnh Polymarket rời app. */
    fireAgeMs: poly && poly.sentAt > 0 ? poly.sentAt - issuedAt : null,
    polymarketMs: leg(poly),
    csgoempireMs: leg(book),
    /** Từ lúc Polymarket trả lời tới lúc gửi BetBy. */
    gapMs:
      poly && book && book.sentAt > 0 && poly.ackedAt > 0
        ? book.sentAt - poly.ackedAt
        : null,
  };
}

export class TraderArbitrageTask implements Task<TraderArbitrageParams> {
  private _executor: LiveExecutor | null = null;
  private _config: TraderConfig | null = null;
  private readonly _inflight = new Map<string, AbortController>();
  /** Lệnh hủy nhận được khi kèo đang tính (kể cả lý do được bỏ qua) → ghi vào lệnh. */
  private readonly _cancels = new Map<string, HubCancel>();
  private readonly _live = new Map<string, LiveSignal>();
  /** Kèo đang được xử lý (bất kỳ bước nào) — không xét lại chồng. */
  private readonly _handling = new Set<string>();
  private readonly _decisions = new Set<Promise<void>>();
  private _run: RunDeps | null = null;
  /** Mã phiên task: id lệnh xét lại kèo của phiên trước không trùng id đã ghi. */
  private readonly _session = Date.now().toString(36);

  /** Thay được sổ phơi nhiễm (vd test nhiều trader dùng chung một sổ) và nhịp xét lại sổ lệnh. */
  constructor(
    private readonly _deps: {
      readonly ledger?: ExposureLedger;
      readonly bookRecheckMs?: number;
      readonly executor?: LiveExecutor;
    } = {},
  ) {}

  async run(ctx: TaskContext<TraderArbitrageParams>): Promise<void> {
    const p = ctx.params;
    const token = process.env.CONSUMER_WS_TOKEN;
    if (!token) throw new Error('thiếu CONSUMER_WS_TOKEN trong env của worker');
    const hubUrl =
      p.hubUrl ?? `ws://127.0.0.1:${process.env.CONSUMER_WS_PORT ?? '3002'}`;
    const market = new PolymarketMarketData(polymarketRestUrls(p.endpoints));
    const redisUrl = process.env.REDIS_URL;
    this._executor =
      this._deps.executor ??
      (redisUrl ? new LiveOrderExecutor(new AccountLock(redisUrl)) : null);
    const ledger: ExposureLedger =
      this._deps.ledger ??
      (p.sharedExposure && redisUrl
        ? new RedisExposureLedger(redisUrl, 'trade:paper')
        : new InMemoryExposureLedger());
    const liveLedger =
      this._deps.ledger ??
      (redisUrl
        ? new RedisExposureLedger(redisUrl, 'trade:live')
        : new InMemoryExposureLedger());
    if (!this._deps.ledger && p.sharedExposure && !redisUrl)
      ctx.warn(
        'không có REDIS_URL: giới hạn tổng theo trận chỉ tính trong task này',
      );

    const configured = new AbortController();
    ctx.onCommand((name, data) => {
      // app đã xóa toàn bộ lệnh của profile → quên dấu "đã xử lý", xét lại mọi kèo còn sống
      if (name === 'reset_seen') {
        this._reevaluate('force');
        return;
      }
      // admin trả lại hạn mức trận / đặt lại số lệnh của cửa → kèo bị chặn vì đó vào tiếp
      if (name === 'exposure_freed') {
        this._reevaluate('exposure');
        return;
      }
      // người bấm "Vào lệnh" ở On click: đọc lại sổ lệnh rồi vào như bot (bỏ cổng giá On click)
      if (name === 'manual_enter') {
        const { signalId, by, targetStake } = (data ?? {}) as {
          signalId?: unknown;
          by?: unknown;
          targetStake?: unknown;
        };
        if (
          targetStake !== undefined &&
          !(
            typeof targetStake === 'number' &&
            targetStake > 0 &&
            targetStake <= 1e6
          )
        )
          throw new Error('TARGET_STAKE_INVALID: tiền mục tiêu phải > 0');
        const l =
          typeof signalId === 'string' ? this._live.get(signalId) : undefined;
        const run = this._run;
        if (!l || !run || l.signal.expiresAt <= Date.now())
          throw new Error('SIGNAL_NOT_LIVE: kèo đã hết hoặc trader chưa nhận');
        if (this._handling.has(l.signal.signalId))
          throw new Error('SIGNAL_BUSY: kèo đang được xử lý, thử lại');
        void this._handle(run.ctx, l.signal, run, 'force', {
          by: typeof by === 'string' ? by : 'unknown',
          ...(typeof targetStake === 'number' ? { targetStake } : {}),
        }).catch((e) => run.ctx.warn(e));
        return;
      }
      if (name !== 'config') throw new Error(`UNKNOWN_COMMAND: ${name}`);
      const cfg = TraderConfigSchema.parse(data);
      if (cfg.profileId !== p.profileId)
        throw new Error(`PROFILE_MISMATCH: ${cfg.profileId}`);
      this._config = cfg;
      configured.abort(); // đánh thức vòng chờ cấu hình
      // kèo bị bỏ qua vì cấu hình mà phần cấu hình đó vừa đổi → xét lại ngay
      // (kết quả lần trước đọc từ sổ nếu task mới khởi động lại)
      this._reevaluate('config');
    });

    try {
      // chưa có cấu hình thì chưa nối hub (hub gửi lại kèo còn hiệu lực ngay khi nối)
      while (!this._config && !ctx.signal.aborted) {
        ctx.emit({ profileId: p.profileId }, CH_CONFIG_REQUEST);
        await sleep(
          CONFIG_RETRY_MS,
          AbortSignal.any([ctx.signal, configured.signal]),
        );
      }
      if (ctx.signal.aborted) return;

      let connected = false;
      // sổ lệnh đổi liên tục: kèo bị bỏ vì sổ lệnh được xét lại đều, không chờ publisher làm mới
      const recheck = setInterval(() => {
        if (connected) this._reevaluate('recheck');
      }, this._deps.bookRecheckMs ?? BOOK_RECHECK_MS);
      const status = setInterval(() => {
        if (connected)
          ctx.emit(
            {
              profileId: p.profileId,
              hubPaused: hub.paused,
              inflight: this._inflight.size,
              active: this._config?.active ?? false,
            },
            CH_STATUS,
          );
      }, STATUS_EVERY_MS);
      const hub = new ConsumerHubClient(
        { url: hubUrl, token, consumerId: `trader:${p.profileId}` },
        {
          onSignal: (s) => {
            this._remember(s);
            void this._handle(ctx, s, {
              market,
              ledger,
              liveLedger,
              hub,
            }).catch((e) => ctx.warn(e));
          },
          onCancel: (c) => {
            if (this._live.get(c.signalId)?.oneClick)
              ctx.emit(
                {
                  profileId: p.profileId,
                  signalId: c.signalId,
                  removed: true,
                  reason: `cancelled:${c.reason}`,
                },
                CH_ONECLICK,
              );
            this._live.delete(c.signalId);
            if (this._inflight.has(c.signalId))
              this._cancels.set(c.signalId, c);
            // vd better_opportunity: kèo cũ vẫn còn lãi, publisher chỉ thay bằng kèo tốt hơn → cứ vào tiếp
            if (this._config?.risk.ignoreCancelReasons.includes(c.reason))
              return;
            this._inflight
              .get(c.signalId)
              ?.abort(`SIGNAL_CANCELLED: ${c.reason}`);
          },
          onState: (state, detail) => {
            if (state === 'connected') {
              connected = true;
              // nối lại hub (app restart / rớt mạng): hub gửi lại kèo còn sống → xét lại một lần
              for (const l of this._live.values()) l.replayRedo = true;
            }
            if (state === 'resumed') this._reevaluate('resume');
            if (state === 'disconnected') {
              connected = false;
              if (detail) ctx.warn(detail);
            }
          },
        },
      );
      this._run = { ctx, market, ledger, liveLedger, hub };
      try {
        await hub.run(ctx.signal);
      } finally {
        this._run = null;
        clearInterval(status);
        clearInterval(recheck);
      }
    } finally {
      for (const ac of this._inflight.values()) ac.abort('TASK_STOPPED');
      await Promise.allSettled(this._decisions);
      await ledger.close();
      if (liveLedger !== ledger) await liveLedger.close();
      this._executor?.close();
    }
  }

  /** Ghi bản mới nhất của kèo còn sống; bỏ kèo đã hết hạn. */
  private _remember(s: HubSignal) {
    const now = Date.now();
    for (const [id, l] of this._live)
      if (l.signal.expiresAt <= now) this._live.delete(id);
    const cur = this._live.get(s.signalId);
    if (cur) cur.signal = s;
    else this._live.set(s.signalId, { signal: s, attempts: 0, last: null });
  }

  /**
   * Xét lại các kèo còn sống. force = bỏ hẳn dấu "đã xử lý" (sau khi xóa toàn bộ lệnh);
   * không force = chỉ kèo bị bỏ qua vì cấu hình mà cấu hình/logic đã đổi (xem needsRedo).
   */
  private _reevaluate(source: Exclude<Source, 'hub'>): number {
    const run = this._run;
    if (!run) return 0;
    const now = Date.now();
    let n = 0;
    for (const [id, l] of this._live) {
      if (l.signal.expiresAt <= now) {
        this._live.delete(id);
        continue;
      }
      if (this._handling.has(id)) continue;
      n++;
      // lọc trước: nhịp xét lại không đụng kèo không liên quan
      if (
        source !== 'force' &&
        !needsRedo(l.last, this._config!, source, false)
      )
        continue;
      void this._handle(run.ctx, l.signal, run, source).catch((e) =>
        run.ctx.warn(e),
      );
    }
    return n;
  }

  private async _handle(
    ctx: TaskContext<TraderArbitrageParams>,
    s: HubSignal,
    deps: {
      market: PolymarketMarketData;
      ledger: ExposureLedger;
      liveLedger?: ExposureLedger;
      hub: ConsumerHubClient;
    },
    /** Xét lại kèo đã xử lý (đổi cấu hình / xóa lệnh): bỏ qua dấu "đã xử lý". */
    /**
     * hub = hub vừa giao kèo; config = xét lại sau khi đổi cấu hình; force = bỏ hẳn dấu "đã xử lý".
     */
    source: Source = 'hub',
    /** Người vào lệnh từ On click (không phải bot). */
    manual: ManualEntry | null = null,
  ): Promise<void> {
    const startedAt = Date.now();
    const cfg = this._config;
    if (!cfg) return;
    const profileId = ctx.params.profileId;
    const live = this._live.get(s.signalId);
    if (this._handling.has(s.signalId)) return;
    // hub giao "ít nhất một lần" và gửi lại kèo còn hiệu lực khi nối lại → mỗi kèo xử lý MỘT lần
    const ttl = Math.max(0, s.expiresAt - startedAt) + 3_600_000;
    if (
      source !== 'force' &&
      !(await (
        cfg.mode === 'live' ? (deps.liveLedger ?? deps.ledger) : deps.ledger
      ).claim(profileId, s.signalId, ttl))
    ) {
      // đã xử lý trước đó. Kết quả lần trước chỉ nhớ trong phiên task này (không lưu Redis):
      // bị bỏ qua vì cấu hình mà cấu hình đã đổi / bỏ qua tạm thời → xét lại, không thì thôi
      if (!live) return;
      // đã xử lý ở phiên trước (trader vừa khởi động lại, không còn kết quả) → xét lại một lần
      const restoredNow = live.last === null && live.attempts === 0;
      if (restoredNow) live.restored = true;
      live.attempts = Math.max(live.attempts, 1);
      const fresh = s.issuedAt > (live.handledIssuedAt ?? 0);
      // hub giao lại sau khi nối lại: xét lại kèo chưa vào được lệnh (đã vào thì chờ lần làm mới)
      const replay =
        source === 'hub' &&
        !!live.replayRedo &&
        live.last?.status !== 'paper_filled' &&
        live.last?.status !== 'filled' &&
        live.last?.status !== 'partial' &&
        !FILTER_SKIPS.has(reasonCode(live.last?.reason ?? null));
      if (source === 'hub') live.replayRedo = false;
      if (restoredNow || replay) source = 'restart';
      else if (
        !needsRedo(live.last, cfg, source, fresh) ||
        this._handling.has(s.signalId)
      )
        return;
      if (this._handling.has(s.signalId)) return;
    } else if (source === 'force' && live?.last === null && live.attempts === 0)
      live.restored = true;
    this._handling.add(s.signalId);
    try {
      const decision = this._decide(
        ctx,
        s,
        {
          ...deps,
          ledger:
            cfg.mode === 'live'
              ? (deps.liveLedger ?? deps.ledger)
              : deps.ledger,
        },
        cfg,
        startedAt,
        live,
        manual,
        source,
      );
      this._decisions.add(decision);
      try {
        await decision;
      } finally {
        this._decisions.delete(decision);
      }
    } finally {
      this._handling.delete(s.signalId);
    }
  }

  private async _decide(
    ctx: TaskContext<TraderArbitrageParams>,
    s: HubSignal,
    deps: {
      market: PolymarketMarketData;
      ledger: ExposureLedger;
      hub: ConsumerHubClient;
    },
    cfg: TraderConfig,
    startedAt: number,
    live: LiveSignal | undefined,
    manual: ManualEntry | null,
    source: Source = 'hub',
  ): Promise<void> {
    const profileId = ctx.params.profileId;
    /** Kết quả lần xử lý trước (để lần xét lại theo nhịp không ghi dòng trùng lý do). */
    const prev = live?.last ?? null;
    const attempt = live ? ++live.attempts : 1;
    if (live)
      live.handledIssuedAt = Math.max(live.handledIssuedAt ?? 0, s.issuedAt);

    const book = s.legs.find((l) => l.tenant === 'sptpub');
    const poly = s.legs.find((l) => l.tenant === 'polymarket');
    // lãi theo ngày khóa vốn: giờ bắt đầu MUỘN NHẤT giữa các chân (không đánh giá thấp thời gian chờ)
    const startsAt = s.legs.reduce<number | null>(
      (m, l) =>
        typeof l.startsAt === 'number' && l.startsAt > (m ?? 0)
          ? l.startsAt
          : m,
      null,
    );
    const daily = dailyReturn(s.margin, startsAt, startedAt);
    // chỉ chọn trong các hạng profile được vào: hạng không tick bị loại TRƯỚC khi chọn,
    // nên kèo khớp cả hạng tick lẫn hạng không tick (khoảng chồng nhau) vẫn vào theo hạng tick
    const tierPick = targetStake(
      cfg.stakeTable.filter((r) => r.enabled),
      s.margin,
    );
    // người nhập tiền mục tiêu ở On click: thay tiền của hạng; vẫn taker như bot (mức giá hết lãi thì
    // dừng → vào ít hơn). Tiền tối thiểu không vượt tiền người nhập.
    const manualStake = manual?.targetStake;
    const pick =
      tierPick && manualStake
        ? {
            ...tierPick,
            stake: manualStake,
            row: {
              ...tierPick.row,
              minStake: Math.min(tierPick.row.minStake, manualStake),
            },
          }
        : tierPick;
    // chỉ để ghi lý do: không có hạng tick nào khớp thì kèo thuộc hạng nào (nếu có)
    const other = pick ? null : targetStake(cfg.stakeTable, s.margin);
    const base = {
      // lần đầu giữ id cũ; xét lại → hậu tố số lần (id trùng sẽ bị DB bỏ qua)
      id:
        attempt > 1
          ? live?.restored
            ? `${profileId}:${s.signalId}:${this._session}.${attempt}`
            : `${profileId}:${s.signalId}:${attempt}`
          : `${profileId}:${s.signalId}`,
      profileId,
      mode: cfg.mode,
      signalId: s.signalId,
      room: s.room,
      sport: s.sport,
      market: s.market,
      teams: [s.teams[0], s.teams[1]] as [string, string],
      phase: s.phase,
      comboId: s.comboId,
      signalMargin: s.margin,
      tierName: pick?.row.tierName ?? other?.row.tierName ?? null,
    };
    let marketDataAt: number | null = null;
    /** Lúc tính xong lệnh (TRƯỚC khi chuẩn bị / gửi lệnh thật). null = chưa tới bước đó. */
    let decidedAt: number | null = null;
    /**
     * Gỡ kèo khỏi bảng On click (kết quả mới không còn là "chờ người vào"), kèm lý do cho lịch sử:
     * `manual:<status>[:<mã>]` = người bấm vào lệnh, `result:<status>[:<mã>]` = bot xét lại ra kết quả khác.
     */
    const leaveOneClick = (status: Status, reason: string | null) => {
      if (!live?.oneClick) return;
      live.oneClick = false;
      const code = reasonCode(reason);
      ctx.emit(
        {
          profileId,
          signalId: s.signalId,
          removed: true,
          reason: `${manual ? 'manual' : 'result'}:${status}${code ? `:${code}` : ''}`,
          ...(manual ? { by: manual.by } : {}),
        },
        CH_ONECLICK,
      );
    };
    const build = (
      status: Status,
      reason: string | null,
      r: Partial<{
        legs: Record<string, unknown>[];
        stake: number;
        tokenId: string;
        shares: number;
        avgPrice: number;
        fee: number;
        polyCost: number;
        totalCost: number;
        payout: number;
        profit: number;
        netMargin: number;
        detail: Record<string, unknown>;
      }> = {},
    ) => {
      const c = this._cancels.get(s.signalId);
      // kèo bị hủy khi đang tính: lý do + giờ bắt đầu từng chân lúc hủy (ignored = vẫn vào tiếp)
      const cancel = c
        ? {
            reason: c.reason,
            ignored: status !== 'cancelled',
            detail: c.detail ?? null,
          }
        : undefined;
      return {
        ...base,
        status,
        reason,
        book: book ? { ...bare(book)!, stake: r.stake ?? 0 } : null,
        polymarket: poly
          ? {
              ...bare(poly)!,
              tokenId: r.tokenId ?? '',
              shares: r.shares ?? 0,
              avgPrice: r.avgPrice ?? 0,
              fee: r.fee ?? 0,
              cost: r.polyCost ?? 0,
            }
          : null,
        totalCost: r.totalCost ?? 0,
        payout: r.payout ?? 0,
        profit: r.profit ?? 0,
        netMargin: r.netMargin ?? 0,
        latencyMs: Date.now() - startedAt,
        detail: {
          signalAgeMs: startedAt - s.issuedAt,
          targetStake: pick?.stake ?? null,
          ...(daily ? { daily } : {}),
          ...(cancel ? { cancel } : {}),
          ...(manual ? { manual } : {}),
          ...r.detail,
        },
        createdAt: Date.now(),
        csgoempireAccountId: cfg.accounts.csgoempire?.id ?? null,
        polymarketAccountId: cfg.accounts.polymarket?.id ?? null,
        timing: {
          signalIssuedAt: s.issuedAt,
          receivedAt: startedAt,
          marketDataAt,
          decidedAt: decidedAt ?? Date.now(),
        },
        legs: r.legs ?? [],
      };
    };
    type Result = Parameters<typeof build>[2];
    const emit = (status: Status, reason: string | null, r: Result = {}) => {
      // xét lại theo nhịp / sau khi trả hạn mức mà vẫn bỏ cùng lý do → không ghi thêm dòng.
      // Lãi/ngày thấp: kèo làm mới mỗi vài phút vẫn dưới ngưỡng → chỉ ghi lần đầu (lãi/ngày tăng dần khi
      // trận tới gần nên vẫn xét lại mỗi lần làm mới, không coi là bộ lọc)
      if (
        (source === 'recheck' ||
          source === 'exposure' ||
          reasonCode(reason) === 'LOW_DAILY_RETURN') &&
        prev &&
        status === prev.status &&
        (status === 'error' ||
          (status === 'skipped' &&
            reasonCode(prev.reason) === reasonCode(reason)))
      )
        return;
      if (live)
        live.last = { status, reason, configKey: configKey(reason, cfg) };
      leaveOneClick(status, reason);
      ctx.emit(build(status, reason, r), CH_TRADE);
    };
    /** Bỏ qua không ghi lệnh (chỉ nhớ kết quả để xét lại khi cấu hình liên quan đổi). */
    const quiet = (reason: string) => {
      leaveOneClick('skipped', reason);
      if (live)
        live.last = {
          status: 'skipped',
          reason,
          configKey: configKey(reason, cfg),
        };
    };

    if (!cfg.active) return emit('skipped', `INACTIVE: ${cfg.inactiveReason}`);
    if (cfg.mode === 'live' && (!cfg.execution || !this._executor))
      return emit('skipped', 'LIVE_EXECUTION_UNAVAILABLE');
    if (deps.hub.paused) return emit('skipped', 'HUB_PAUSED');
    if (s.expiresAt <= startedAt) return emit('skipped', 'SIGNAL_EXPIRED');
    // "quá cũ" chỉ áp cho bản tin hub vừa giao; xét lại kèo còn sống (publisher chưa hủy, odds chưa
    // lệch đủ bước) thì sổ lệnh được đọc mới nên không tính tuổi bản tin
    if (
      !manual &&
      source === 'hub' &&
      cfg.risk.maxSignalAgeMs > 0 &&
      startedAt - s.issuedAt > cfg.risk.maxSignalAgeMs
    )
      return emit(
        'skipped',
        `STALE_SIGNAL: ${startedAt - s.issuedAt}ms > ${cfg.risk.maxSignalAgeMs}ms`,
      );
    // margin quá đẹp = thường là giá cũ / sổ lệnh lỗi, biến mất trước khi lệnh tới sàn (kể cả vào tay)
    const maxMargin = cfg.risk.maxNetMargin;
    if (maxMargin > 0 && s.margin > maxMargin)
      return emit(
        'skipped',
        `SUSPICIOUS_MARGIN: margin kèo ${(s.margin * 100).toFixed(2)}% > ngưỡng ${(maxMargin * 100).toFixed(2)}% — nghi giá cũ`,
      );
    if (cfg.risk.markets && !cfg.risk.markets.includes(s.market))
      return emit(
        'skipped',
        `MARKET_NOT_SELECTED: market ${s.market} không nằm trong các market profile được vào`,
      );
    if (!book || !poly)
      return emit('skipped', `UNSUPPORTED_COMBO: ${s.comboId}`);
    const tokenId = poly.ref[`t${poly.side}`];
    const conditionId = poly.ref.c;
    if (!tokenId || !conditionId)
      return emit('skipped', 'MISSING_REF: thiếu token/conditionId polymarket');
    if (!pick)
      return emit(
        'skipped',
        other
          ? `TIER_NOT_SELECTED: margin ${(s.margin * 100).toFixed(2)}% chỉ khớp hạng không được chọn (${other.row.tierName})`
          : `NO_TIER: margin ${(s.margin * 100).toFixed(2)}%`,
      );
    // ưu tiên kèo lãi cao theo ngày khóa vốn: kèo lãi vài % mà trận còn xa nhiều ngày → bỏ qua để dành
    // tiền cho kèo trận gần lãi cao. Người bấm vào tay ở On click thì không chặn.
    const minDaily = pick.row.minDailyMargin ?? cfg.risk.minDailyMargin;
    if (!manual && minDaily > 0 && daily && daily.perDay + 1e-12 < minDaily)
      return emit(
        'skipped',
        `LOW_DAILY_RETURN: lãi ${(s.margin * 100).toFixed(2)}% ÷ ${daily.days.toFixed(1)} ngày = ${(daily.perDay * 100).toFixed(2)}%/ngày < ${(minDaily * 100).toFixed(2)}%/ngày`,
        { detail: { minDailyMargin: minDaily } },
      );
    // mỗi hạng kèo tính riêng: cùng cửa ở hạng này đã đủ số lệnh → bỏ qua (kèo phát lại = signalId mới, vẫn cửa cũ)
    // số lệnh mỗi cửa: riêng của hạng nếu có, không thì mặc định của profile; 0 = không giới hạn
    // (vẫn đếm trong sổ để xem ở Sổ phơi nhiễm)
    const maxEntries = pick.row.maxEntries ?? cfg.risk.maxEntriesPerTier;
    const max = maxEntries > 0 ? maxEntries : Number.MAX_SAFE_INTEGER;
    const entryKey = `entry:${profileId}:${s.room}:${s.comboId}:${pick.row.tierId}`;
    const entered = maxEntries > 0 ? await deps.ledger.count(entryKey) : 0;
    // đủ số lệnh của hạng → bỏ qua IM LẶNG (không ghi dòng); tăng số lệnh của hạng thì xét lại
    if (entered >= max) return quiet('ALREADY_ENTERED');
    const strategy = TRADE_STRATEGIES[cfg.strategy.id];
    if (!strategy)
      return emit('skipped', `UNKNOWN_STRATEGY: ${cfg.strategy.id}`);

    const ac = new AbortController();
    this._inflight.set(s.signalId, ac);
    const signal = AbortSignal.any([ac.signal, ctx.signal]);
    try {
      const [ob, info] = await Promise.all([
        deps.market.orderBook(tokenId, signal),
        deps.market.tradingInfo(conditionId, signal),
      ]);
      marketDataAt = Date.now();
      if (signal.aborted)
        return emit('cancelled', String(signal.reason), {
          tokenId,
          detail: { cancelledAfterMs: Date.now() - startedAt },
        });
      if (!info.acceptingOrders) return emit('skipped', 'MARKET_CLOSED');

      const match = matchOf(s.room);
      const caps = [
        { key: `match:${match}`, cap: cfg.matchExposureCapUsd },
        {
          key: `profile:${profileId}:match:${match}`,
          cap: cfg.risk.matchCapUsd,
        },
      ].filter((c) => c.cap > 0);
      const used = await deps.ledger.used(caps.map((c) => c.key));
      const budget = caps.length
        ? Math.max(0, Math.min(...caps.map((c, i) => c.cap - (used[i] ?? 0))))
        : Number.POSITIVE_INFINITY;

      let d = await strategy.decide({
        margin: s.margin,
        bookOdds: book.odds,
        book: ob,
        market: info,
        targetStake: pick.stake,
        minStake: pick.row.minStake,
        minNetMargin: cfg.risk.minNetMargin,
        budget,
        params: cfg.strategy.params,
      });
      if (signal.aborted)
        return emit('cancelled', String(signal.reason), {
          tokenId,
          detail: { cancelledAfterMs: Date.now() - startedAt },
        });
      const bestAsk = ob.asks[0]?.price ?? null;
      const depth = depthSummary({
        bookOdds: book.odds,
        asks: ob.asks,
        fee: info.fee,
        targetStake: pick.stake,
        minNetMargin: cfg.risk.minNetMargin,
      });
      const sizing = {
        targetStake: pick.stake,
        minStake: pick.row.minStake,
        minShares: Math.max(info.minShares, ob.minShares ?? 0),
        minNetMargin: cfg.risk.minNetMargin,
      };
      if (!d.ok)
        return emit('skipped', `${d.reason}: ${d.detail}`, {
          tokenId,
          detail: {
            bestAsk,
            budget: Number.isFinite(budget) ? budget : null,
            fee: info.fee,
            depth,
            sizing,
            bookAt: ob.at,
          },
        });

      // lãi ròng tính trên sổ lệnh thật cũng quá đẹp → cùng lý do
      if (maxMargin > 0 && d.netMargin > maxMargin)
        return emit(
          'skipped',
          `SUSPICIOUS_MARGIN: lãi ròng tính ra ${(d.netMargin * 100).toFixed(2)}% > ngưỡng ${(maxMargin * 100).toFixed(2)}% — nghi giá cũ`,
          { tokenId },
        );
      if (cfg.mode === 'live') {
        // Polymarket chỉ nhận lệnh mua có tiền (share × giá giới hạn) 2 số lẻ: làm tròn XUỐNG số share
        // tới mức hợp lệ, co tiền cược + chi phí theo cùng tỉ lệ để hai chân vẫn cân.
        const limitPrice = d.levels.at(-1)?.price ?? d.avgPrice;
        const shares = polymarketBuyShares(d.shares, limitPrice);
        const ratio = d.shares > 0 ? shares / d.shares : 0;
        const polyCost = d.polyCost * ratio;
        const stake = Math.floor((d.stake * ratio + 1e-9) * 100) / 100;
        const totalCost = stake + polyCost;
        const payout = Math.min(shares, stake * book.odds);
        const profit = payout - totalCost;
        const minShares = Math.max(info.minShares, ob.minShares ?? 0);
        if (
          shares <= 0 ||
          shares < minShares ||
          stake < pick.row.minStake ||
          profit / totalCost < cfg.risk.minNetMargin
        )
          return emit(
            'skipped',
            `LIVE_ROUNDING_LIMIT: làm tròn cho sàn (${+shares.toFixed(4)} share × ${limitPrice}, cược ${stake}$) không còn đạt cấu hình`,
            { tokenId },
          );
        d = {
          ...d,
          shares,
          polyCost,
          fee: d.fee * ratio,
          stake,
          totalCost,
          payout,
          profit,
          netMargin: profit / totalCost,
        };
      }
      decidedAt = Date.now();
      const filled: Result = {
        stake: d.stake,
        tokenId,
        shares: d.shares,
        avgPrice: d.avgPrice,
        fee: d.fee,
        polyCost: d.polyCost,
        totalCost: d.totalCost,
        payout: d.payout,
        profit: d.profit,
        netMargin: d.netMargin,
        // giấy: hai chân "khớp" đúng như tính toán; giao dịch thật sẽ ghi giá/thời điểm khớp thật
        legs: [
          {
            venue: 'csgoempire',
            accountId: cfg.accounts.csgoempire?.id ?? null,
            side: book.side,
            pick: book.pick,
            signalPrice: book.odds,
            requestedPrice: book.odds,
            requestedAmount: d.stake,
            filledAmount: d.stake,
            avgPrice: book.odds,
            fee: 0,
            cost: d.stake,
            status: 'simulated',
            marketRef: JSON.stringify(book.ref),
          },
          {
            venue: 'polymarket',
            accountId: cfg.accounts.polymarket?.id ?? null,
            side: poly.side,
            pick: poly.pick,
            signalPrice: poly.odds > 0 ? 1 / poly.odds : 0,
            // giá xa nhất đã ăn = giá giới hạn sẽ dùng cho lệnh FOK/FAK thật
            requestedPrice: d.levels.at(-1)?.price ?? d.avgPrice,
            requestedAmount: d.shares,
            filledAmount: d.shares,
            avgPrice: d.avgPrice,
            fee: d.fee,
            cost: d.polyCost,
            status: 'simulated',
            marketRef: tokenId,
          },
        ],
        detail: {
          bestAsk,
          levels: d.levels,
          limitedBy: d.limitedBy,
          fee: info.fee,
          budget: Number.isFinite(budget) ? budget : null,
          bookAt: ob.at,
          depth,
          sizing,
        },
      };

      // giá bán thấp nhất ≥ ngưỡng → bot không vào, gửi phân tích sang On click cho người vào
      const thr = cfg.risk.oneClickMinPrice;
      const minAsk = ob.asks.reduce(
        (m, l) => (l.size > 0 && l.price < m ? l.price : m),
        Number.POSITIVE_INFINITY,
      );
      if (!manual && thr > 0 && minAsk >= thr - 1e-9) {
        const reason = `ONE_CLICK: giá bán thấp nhất ${minAsk} ≥ ${thr} — chờ người vào lệnh ở On click`;
        const first = reasonCode(live?.last?.reason ?? null) !== 'ONE_CLICK';
        if (live) {
          live.last = {
            status: 'skipped',
            reason,
            configKey: configKey(reason, cfg),
          };
          live.oneClick = true;
        }
        const extra = { minAsk, oneClickMinPrice: thr };
        ctx.emit(
          {
            profileId,
            signalId: s.signalId,
            expiresAt: s.expiresAt,
            // "nếu vào bây giờ": cùng phân tích bot dùng để vào lệnh
            candidate: build('paper_filled', reason, {
              ...filled,
              detail: { ...filled.detail, ...extra },
            }),
          },
          CH_ONECLICK,
        );
        // Lệnh giấy chỉ ghi MỘT dòng khi kèo vừa chuyển sang On click
        if (first)
          ctx.emit(
            build('skipped', reason, {
              tokenId,
              detail: { ...filled.detail, ...extra },
            }),
            CH_TRADE,
          );
        return;
      }

      // lấy suất của hạng trước (nguyên tử) rồi mới giữ hạn mức: kèo trùng cửa đến cùng lúc không vượt số lệnh
      if (!(await deps.ledger.acquire(entryKey, max, EXPOSURE_TTL_MS)))
        return quiet('ALREADY_ENTERED');
      const polyLimit = d.levels.at(-1)?.price ?? d.avgPrice;
      const liveFee =
        Math.ceil(
          d.shares * takerFeePerShare(Math.min(0.5, polyLimit), info.fee) * 1e6,
        ) / 1e6;
      const reserveCost =
        cfg.mode === 'live'
          ? d.stake + d.shares * polyLimit + liveFee
          : d.totalCost;
      if (!(await deps.ledger.reserve(caps, reserveCost, EXPOSURE_TTL_MS))) {
        await deps.ledger.giveBack(entryKey);
        return emit(
          'skipped',
          'CAP_REACHED: giới hạn tổng theo trận vừa bị trader khác dùng hết',
          {
            tokenId,
          },
        );
      }
      if (cfg.mode === 'paper') return emit('paper_filled', null, filled);
      if (this._config !== cfg || !this._config.active) {
        await deps.ledger.release(
          caps.map((c) => c.key),
          reserveCost,
        );
        await deps.ledger.giveBack(entryKey);
        return emit(
          'cancelled',
          'CONFIG_CHANGED: cấu hình đã đổi khi đang chuẩn bị',
          { tokenId },
        );
      }
      // Bản "giấy đối chiếu" của lệnh thật: cùng phân tích lúc quyết định, ghi thành một sự kiện riêng
      // (mode 'shadow', không vào danh sách/thống kê lệnh) để cuối ngày so lãi thật ↔ giấy.
      ctx.emit(
        {
          ...build('paper_filled', null, {
            ...filled,
            detail: { ...filled.detail, shadowOf: base.id },
          }),
          id: `${base.id}:shadow`,
          mode: 'shadow',
        },
        CH_TRADE,
      );
      try {
        const execution = await this._executor!.execute(
          cfg.execution!,
          {
            // Same delivery always has the same durable key, including after reset_seen/restart.
            id: createHash('sha256')
              .update(`${profileId}:${s.signalId}:${s.issuedAt}`)
              .digest('hex'),
            bookRef: book.ref,
            bookSide: book.side,
            bookOdds: book.odds,
            stake: d.stake,
            tokenId,
            shares: d.shares,
            polyLimit,
            polyFee: liveFee,
            expiresAt: s.expiresAt,
          },
          signal,
        );
        if (
          !execution.submitted ||
          execution.fills.every((f) => f.status === 'rejected')
        ) {
          await deps.ledger.release(
            caps.map((c) => c.key),
            reserveCost,
          );
          await deps.ledger.giveBack(entryKey);
        }
        const [bf, pf] = execution.fills;
        const totalCost = (bf?.cost ?? 0) + (pf?.cost ?? 0);
        // Đặt bù BetBy (odds giảm → cược nhiều hơn dự kiến) có thể làm tổng tiền vượt phần đã giữ:
        // ghi thêm phần vượt vào sổ hạn mức trận (đã vào rồi nên không chặn, cap 0 = luôn ghi được).
        if (execution.submitted && totalCost > reserveCost + 0.005)
          await deps.ledger
            .reserve(
              caps.map((c) => ({ key: c.key, cap: 0 })),
              totalCost - reserveCost,
              EXPOSURE_TTL_MS,
            )
            .catch(() => false);
        const payout =
          execution.status === 'filled'
            ? Math.min(
                (bf?.filledAmount ?? 0) * (bf?.avgPrice ?? 0),
                pf?.filledAmount ?? 0,
              )
            : 0;
        if (reasonCode(execution.reason) === 'CSGOEMPIRE_SESSION_REJECTED') {
          // BetBy từ chối JWT còn hạn (thường: vừa làm mới phiên, JWT cũ bị vô hiệu). Không khóa:
          // báo backend JWT nào bị từ chối (chỉ dấu vân tay) để lấy phiên mới rồi gửi lại cấu hình.
          ctx.emit(
            {
              profileId,
              rejectedSession: {
                browserProfile: cfg.execution!.empire.browserProfile,
                tokenHash: createHash('sha256')
                  .update(cfg.execution!.empire.token)
                  .digest('hex')
                  .slice(0, 16),
              },
            },
            CH_CONFIG_REQUEST,
          );
        }
        if (execution.status === 'partial') {
          this._config = {
            ...cfg,
            active: false,
            inactiveReason: execution.reason,
          };
          ctx.warn(
            'LIVE_RECONCILIATION_REQUIRED: dừng giao dịch để đối soát hai chân',
          );
          ctx.emit({ profileId }, CH_CONFIG_REQUEST);
        }
        return emit(execution.status, execution.reason, {
          ...filled,
          stake: bf?.filledAmount ?? 0,
          shares: pf?.filledAmount ?? 0,
          avgPrice: pf?.avgPrice ?? 0,
          fee: pf?.fee ?? 0,
          polyCost: pf?.cost ?? 0,
          totalCost,
          payout,
          profit: execution.status === 'filled' ? payout - totalCost : 0,
          netMargin:
            execution.status === 'filled' && totalCost > 0
              ? payout / totalCost - 1
              : 0,
          legs: filled.legs?.map((leg, i) => ({
            ...leg,
            ...(execution.fills[i] ?? {
              status: 'cancelled',
              filledAmount: 0,
              avgPrice: 0,
              fee: 0,
              cost: 0,
              error: execution.reason,
            }),
          })),
          detail: {
            ...filled.detail,
            cash: execution.cash,
            // Tài khoản trong cấu hình (tên đặt trong app) để đối chiếu với tài khoản thật ở cash[].account.
            accounts: cfg.accounts,
            submitted: execution.submitted,
            feeEstimated: true,
            // Số liệu để chỉnh chiến lược (đua giá hay chờ): tuổi kèo lúc bắn Polymarket, thời gian
            // chuẩn bị, thời gian sàn phản hồi từng chân. null = chân không được gửi.
            execution: executionTiming(s.issuedAt, execution),
          },
        });
      } catch (e) {
        // Executor may have submitted before losing its lock/Redis connection. Retain exposure.
        const message = e instanceof Error ? e.message : 'LIVE_EXECUTION_ERROR';
        this._config = {
          ...cfg,
          active: false,
          inactiveReason: 'LIVE_EXECUTION_ERROR',
        };
        ctx.emit({ profileId }, CH_CONFIG_REQUEST);
        return emit(
          'error',
          message.startsWith('CSGOEMPIRE_SESSION')
            ? message
            : 'LIVE_EXECUTION_ERROR',
          { tokenId },
        );
      }
    } catch (e: unknown) {
      if (signal.aborted)
        return emit('cancelled', String(signal.reason), {
          tokenId,
          detail: { cancelledAfterMs: Date.now() - startedAt },
        });
      return emit('error', e instanceof Error ? e.message : String(e), {
        tokenId,
      });
    } finally {
      if (this._inflight.get(s.signalId) === ac) {
        this._inflight.delete(s.signalId);
        this._cancels.delete(s.signalId);
      }
    }
  }
}
