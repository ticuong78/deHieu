import {
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../shared/infrastructure/config/env.schema.js';
import { TransactionContext } from '../../shared/infrastructure/database/transaction-context.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { TaskSupervisor } from '../tasks/application/task-supervisor.js';
import { OddsModule } from '../odds/odds.module.js';
import { NotifyAdmin } from '../odds/application/notify/notify-admin.js';
// application
import {
  SECRET_CIPHER,
  STAKE_TIER_SOURCE,
  TRADE_ATTEMPT_REPOSITORY,
  TRADER_PROFILE_REPOSITORY,
  TRADER_TASK_GATEWAY,
  TRADING_ACCOUNT_REPOSITORY,
  TRADING_SETTINGS_STORE,
  EMPIRE_BROWSER_GATEWAY,
  TRADING_ACCOUNT_CHECKER,
  type TradingAccountChecker,
  TRADING_HALT_CONTROL,
  type TradingHaltControl,
  type SecretCipher,
  type StakeTierSource,
  type TradeAttemptRepository,
  type TraderProfileRepository,
  type TraderTaskGateway,
  type TradingAccountRepository,
  type TradingSettingsStore,
} from './application/trading.ports.js';
import { TraderConfigSync } from './application/trader-config.sync.js';
import { TradingAdmin } from './application/trading-admin.js';
import { TraderDataHandler } from './application/trader-data.handler.js';
// infrastructure
import {
  DrizzleTradeAttemptRepository,
  DrizzleTraderProfileRepository,
  DrizzleTradingAccountRepository,
  DrizzleTradingSettingsStore,
} from './infrastructure/persistence/drizzle/drizzle-trading.repositories.js';
import { AesGcmSecretCipher } from './infrastructure/security/aes-gcm.secret-cipher.js';
import { SupervisorTraderTaskGateway } from './infrastructure/runtime/supervisor-trader-task.gateway.js';
import { LiveConfigProvider } from './infrastructure/runtime/live-config.provider.js';
import { EmpireLoginAdmin } from './application/empire-login-admin.js';
import { AccountCheckAdmin } from './application/account-check-admin.js';
import { ReconcileAdmin } from './application/reconcile-admin.js';
import { ReconcileAlerts } from './application/reconcile-alerts.js';
import { RebalanceAdvisor } from './application/rebalance-advisor.js';
import { RebalanceExecutor } from './application/rebalance-executor.js';
import {
  InMemoryRebalanceTransferStore,
  RedisRebalanceTransferStore,
} from './infrastructure/rebalance/rebalance-transfer.store.js';
import {
  OPS_EVENT_BUS,
  type OpsEventBus,
} from '../../shared/application/ops-event-bus.js';
import { AccountReportAdmin } from './application/account-report-admin.js';
import {
  POLYMARKET_RESOLUTION_SOURCE,
  SettlementAdmin,
  TRADE_SETTLEMENT_REPOSITORY,
  type PolymarketResolutionSource,
  type TradeSettlementRepository,
} from './application/trade-settlement.js';
import { GammaPolymarketResolutions } from './infrastructure/settlement/gamma-polymarket-resolutions.js';
import type { EmpireBrowserGateway } from './application/trading.ports.js';
// presentation
import { TradingController } from './presentation/trading.controller.js';
import { ExposureAdmin } from './application/exposure-admin.js';
import { OneClickBoard } from './application/one-click-board.js';
import { OneClickAdmin } from './application/one-click-admin.js';
import {
  ONE_CLICK_HISTORY_REPOSITORY,
  OneClickHistoryRecorder,
  type OneClickHistoryRepository,
} from './application/one-click-history.js';
import { DrizzleOneClickHistoryRepository } from './infrastructure/persistence/drizzle/drizzle-one-click-history.repository.js';
import {
  OneClickNotifier,
  PUSH_SENDER,
  type PushSender,
} from './application/one-click-notifier.js';
import { OneSignalPushSender } from './infrastructure/push/onesignal-push.sender.js';
import {
  EXPOSURE_LEDGER_READER,
  type ExposureLedgerReader,
} from './application/exposure.ports.js';
import { RedisExposureLedgerReader } from './infrastructure/exposure/redis-exposure-ledger.reader.js';
import { REDIS_CLIENT } from '../../shared/infrastructure/redis/redis.types.js';
import type { Redis } from 'ioredis';

/** Đối chiếu định kỳ cấu hình các task trader (bắt cả thay đổi hạng kèo ở module odds). */
const CONFIG_RECONCILE_MS = 30_000;
/** Nhịp đối soát kết quả lệnh với market Polymarket đã resolve. */
const SETTLEMENT_MS = 10 * 60_000;
/** Nhịp gỡ kèo On click đã hết hạn (ghi lịch sử). */
const ONE_CLICK_SWEEP_MS = 10_000;

/**
 * Auto trade. Worker trader (task `trader.arbitrage`) là một consumer của ConsumerHub;
 * module này chỉ quản trị cấu hình, gửi cấu hình đã tính sẵn cho worker và ghi kết quả worker gửi về.
 */
@Module({
  imports: [TasksModule, OddsModule],
  controllers: [TradingController],
  providers: [
    LiveConfigProvider,
    { provide: EMPIRE_BROWSER_GATEWAY, useExisting: LiveConfigProvider },
    { provide: TRADING_ACCOUNT_CHECKER, useExisting: LiveConfigProvider },
    { provide: TRADING_HALT_CONTROL, useExisting: LiveConfigProvider },
    {
      provide: ReconcileAdmin,
      inject: [
        TRADER_PROFILE_REPOSITORY,
        TRADING_ACCOUNT_REPOSITORY,
        TRADING_HALT_CONTROL,
        TraderConfigSync,
        ReconcileAlerts,
      ],
      useFactory: (
        profiles: TraderProfileRepository,
        accounts: TradingAccountRepository,
        halts: TradingHaltControl,
        sync: TraderConfigSync,
        alerts: ReconcileAlerts,
      ) => new ReconcileAdmin(profiles, accounts, halts, sync, alerts),
    },
    {
      provide: ReconcileAlerts,
      inject: [
        OPS_EVENT_BUS,
        PUSH_SENDER,
        TRADER_PROFILE_REPOSITORY,
        ConfigService,
      ],
      useFactory: (
        ops: OpsEventBus,
        sender: PushSender | null,
        profiles: TraderProfileRepository,
        cfg: ConfigService<Env, true>,
      ) => {
        const log = new Logger('ReconcileAlerts');
        return new ReconcileAlerts(
          ops,
          sender,
          async (id) => (await profiles.get(id))?.name ?? null,
          cfg.get('WEB_APP_URL', { infer: true }) ?? null,
          (e) => log.warn(`báo cần đối soát lỗi: ${String(e)}`),
        );
      },
    },
    {
      provide: RebalanceAdvisor,
      inject: [
        OPS_EVENT_BUS,
        PUSH_SENDER,
        TRADER_PROFILE_REPOSITORY,
        ConfigService,
      ],
      useFactory: (
        ops: OpsEventBus,
        sender: PushSender | null,
        profiles: TraderProfileRepository,
        cfg: ConfigService<Env, true>,
      ) => {
        const log = new Logger('RebalanceAdvisor');
        return new RebalanceAdvisor(
          ops,
          sender,
          async (id) => (await profiles.get(id))?.name ?? null,
          cfg.get('WEB_APP_URL', { infer: true }) ?? null,
          (e) => log.warn(`đề xuất cân bằng tiền lỗi: ${String(e)}`),
        );
      },
    },
    {
      provide: RebalanceExecutor,
      inject: [
        LiveConfigProvider,
        TRADING_SETTINGS_STORE,
        TRADER_PROFILE_REPOSITORY,
        TRADING_ACCOUNT_REPOSITORY,
        RebalanceAdvisor,
        OPS_EVENT_BUS,
        PUSH_SENDER,
      ],
      useFactory: (
        gateway: LiveConfigProvider,
        settings: TradingSettingsStore,
        profiles: TraderProfileRepository,
        accounts: TradingAccountRepository,
        advisor: RebalanceAdvisor,
        ops: OpsEventBus,
        sender: PushSender | null,
      ) => {
        const log = new Logger('RebalanceExecutor');
        const url = process.env.REDIS_URL;
        const executor = new RebalanceExecutor(
          gateway,
          url
            ? new RedisRebalanceTransferStore(url)
            : new InMemoryRebalanceTransferStore(),
          settings,
          profiles,
          accounts,
          advisor,
          ops,
          sender,
          (e) => log.warn(`tự chuyển tiền: ${String(e)}`),
        );
        // lệnh thật hủy vì hết tiền → tự chuyển (nếu bật ở Giới hạn chung)
        advisor.onShortage((profileId) => executor.auto(profileId));
        return executor;
      },
    },
    {
      provide: AccountCheckAdmin,
      inject: [TRADING_ACCOUNT_REPOSITORY, TRADING_ACCOUNT_CHECKER],
      useFactory: (
        accounts: TradingAccountRepository,
        checker: TradingAccountChecker,
      ) => new AccountCheckAdmin(accounts, checker),
    },
    {
      provide: EmpireLoginAdmin,
      inject: [TRADING_ACCOUNT_REPOSITORY, EMPIRE_BROWSER_GATEWAY],
      useFactory: (
        accounts: TradingAccountRepository,
        browser: EmpireBrowserGateway,
      ) => new EmpireLoginAdmin(accounts, browser),
    },
    {
      provide: TRADING_ACCOUNT_REPOSITORY,
      inject: [TransactionContext],
      useFactory: (tx: TransactionContext) =>
        new DrizzleTradingAccountRepository(tx),
    },
    {
      provide: TRADER_PROFILE_REPOSITORY,
      inject: [TransactionContext],
      useFactory: (tx: TransactionContext) =>
        new DrizzleTraderProfileRepository(tx),
    },
    {
      provide: TRADE_ATTEMPT_REPOSITORY,
      inject: [TransactionContext],
      useFactory: (tx: TransactionContext) =>
        new DrizzleTradeAttemptRepository(tx),
    },
    {
      provide: TRADE_SETTLEMENT_REPOSITORY,
      useExisting: TRADE_ATTEMPT_REPOSITORY,
    },
    {
      provide: POLYMARKET_RESOLUTION_SOURCE,
      useFactory: () => new GammaPolymarketResolutions(),
    },
    {
      provide: SettlementAdmin,
      inject: [
        TRADE_SETTLEMENT_REPOSITORY,
        TRADE_ATTEMPT_REPOSITORY,
        POLYMARKET_RESOLUTION_SOURCE,
      ],
      useFactory: (
        r: TradeSettlementRepository,
        t: TradeAttemptRepository,
        src: PolymarketResolutionSource,
      ) => new SettlementAdmin(r, t, src),
    },
    {
      provide: AccountReportAdmin,
      inject: [TRADING_ACCOUNT_REPOSITORY, TRADE_SETTLEMENT_REPOSITORY],
      useFactory: (a: TradingAccountRepository, r: TradeSettlementRepository) =>
        new AccountReportAdmin(a, r),
    },
    {
      provide: TRADING_SETTINGS_STORE,
      inject: [TransactionContext],
      useFactory: (tx: TransactionContext) =>
        new DrizzleTradingSettingsStore(tx),
    },
    {
      provide: SECRET_CIPHER,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService<Env, true>) =>
        new AesGcmSecretCipher(cfg.get('TRADING_SECRET_KEY', { infer: true })),
    },
    {
      // hạng kèo dùng chung với kênh thông báo (module odds, lớp application)
      provide: STAKE_TIER_SOURCE,
      inject: [NotifyAdmin],
      useFactory: (n: NotifyAdmin): StakeTierSource => ({
        listTiers: () => n.listTiers(),
      }),
    },
    {
      provide: TRADER_TASK_GATEWAY,
      inject: [TaskSupervisor],
      useFactory: (s: TaskSupervisor) => new SupervisorTraderTaskGateway(s),
    },
    {
      provide: TraderConfigSync,
      inject: [
        TRADING_ACCOUNT_REPOSITORY,
        TRADER_PROFILE_REPOSITORY,
        TRADING_SETTINGS_STORE,
        STAKE_TIER_SOURCE,
        TRADER_TASK_GATEWAY,
        LiveConfigProvider,
      ],
      useFactory: (
        a: TradingAccountRepository,
        p: TraderProfileRepository,
        s: TradingSettingsStore,
        t: StakeTierSource,
        g: TraderTaskGateway,
        execution: LiveConfigProvider,
      ) => {
        const logger = new Logger('TraderConfig');
        return new TraderConfigSync(
          a,
          p,
          s,
          t,
          g,
          (e) => logger.warn(`không gửi được cấu hình: ${String(e)}`),
          execution,
        );
      },
    },
    {
      provide: TradingAdmin,
      inject: [
        TRADING_ACCOUNT_REPOSITORY,
        TRADER_PROFILE_REPOSITORY,
        TRADE_ATTEMPT_REPOSITORY,
        TRADING_SETTINGS_STORE,
        STAKE_TIER_SOURCE,
        SECRET_CIPHER,
        TraderConfigSync,
      ],
      useFactory: (
        a: TradingAccountRepository,
        p: TraderProfileRepository,
        tr: TradeAttemptRepository,
        s: TradingSettingsStore,
        t: StakeTierSource,
        c: SecretCipher,
        sync: TraderConfigSync,
      ) => new TradingAdmin(a, p, tr, s, t, c, sync),
    },
    {
      provide: EXPOSURE_LEDGER_READER,
      inject: [REDIS_CLIENT],
      useFactory: (r: Redis) => new RedisExposureLedgerReader(r),
    },
    {
      provide: ExposureAdmin,
      inject: [
        EXPOSURE_LEDGER_READER,
        TRADER_PROFILE_REPOSITORY,
        STAKE_TIER_SOURCE,
        TRADING_SETTINGS_STORE,
        TraderConfigSync,
      ],
      useFactory: (
        r: ExposureLedgerReader,
        p: TraderProfileRepository,
        t: StakeTierSource,
        s: TradingSettingsStore,
        sync: TraderConfigSync,
      ) => new ExposureAdmin(r, p, t, s, sync),
    },
    { provide: OneClickBoard, useValue: new OneClickBoard() },
    {
      provide: ONE_CLICK_HISTORY_REPOSITORY,
      inject: [TransactionContext],
      useFactory: (tx: TransactionContext) =>
        new DrizzleOneClickHistoryRepository(tx),
    },
    {
      provide: PUSH_SENDER,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService<Env, true>): PushSender | null => {
        const appId = cfg.get('ONESIGNAL_APP_ID', { infer: true });
        const apiKey = cfg.get('ONESIGNAL_REST_API_KEY', { infer: true });
        return appId && apiKey
          ? new OneSignalPushSender({ appId, apiKey })
          : null;
      },
    },
    {
      provide: OneClickNotifier,
      inject: [PUSH_SENDER, TRADER_PROFILE_REPOSITORY, ConfigService],
      useFactory: (
        sender: PushSender | null,
        profiles: TraderProfileRepository,
        cfg: ConfigService<Env, true>,
      ) =>
        new OneClickNotifier(
          sender,
          async (id) => (await profiles.get(id))?.name ?? null,
          cfg.get('WEB_APP_URL', { infer: true }) ?? null,
        ),
    },
    {
      provide: OneClickHistoryRecorder,
      inject: [ONE_CLICK_HISTORY_REPOSITORY],
      useFactory: (r: OneClickHistoryRepository) =>
        new OneClickHistoryRecorder(r),
    },
    {
      provide: OneClickAdmin,
      inject: [OneClickBoard, TraderConfigSync],
      useFactory: (b: OneClickBoard, s: TraderConfigSync) =>
        new OneClickAdmin(b, s),
    },
    {
      provide: TraderDataHandler,
      inject: [
        TRADE_ATTEMPT_REPOSITORY,
        TraderConfigSync,
        OneClickBoard,
        OneClickHistoryRecorder,
        OneClickNotifier,
        ReconcileAlerts,
        RebalanceAdvisor,
      ],
      useFactory: (
        r: TradeAttemptRepository,
        s: TraderConfigSync,
        b: OneClickBoard,
        h: OneClickHistoryRecorder,
        n: OneClickNotifier,
        a: ReconcileAlerts,
        rb: RebalanceAdvisor,
      ) => {
        const log = new Logger('OneClickPush');
        if (!n.enabled)
          log.log(
            'chưa đặt ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY: không báo kèo On click về điện thoại',
          );
        return new TraderDataHandler(
          r,
          s,
          undefined,
          b,
          h,
          n,
          (e) => log.warn(`gửi thông báo On click lỗi: ${String(e)}`),
          // lệnh cần đối soát → báo; lệnh hủy vì hết tiền → đề xuất cân bằng 35/65 (cả hai tự nuốt lỗi)
          {
            trade: async (t) => {
              await Promise.all([a.trade(t), rb.trade(t)]);
            },
          },
        );
      },
    },
  ],
})
export class TradingModule implements OnModuleInit, OnApplicationShutdown {
  private readonly _logger = new Logger('Trading');
  private _reconcile: ReturnType<typeof setInterval> | null = null;
  private _sweep: ReturnType<typeof setInterval> | null = null;
  private _settle: ReturnType<typeof setInterval> | null = null;
  /** Lượt đối chiếu cấu hình đang chạy (lượt chậm vì mở Chrome thì nhịp sau bỏ qua, không chồng lên). */
  private _reconciling: Promise<unknown> | null = null;

  constructor(
    @Inject(TaskSupervisor) private readonly _supervisor: TaskSupervisor,
    @Inject(TraderDataHandler) private readonly _data: TraderDataHandler,
    @Inject(TraderConfigSync) private readonly _sync: TraderConfigSync,
    @Inject(OneClickBoard) private readonly _board: OneClickBoard,
    @Inject(OneClickHistoryRecorder)
    private readonly _ocHistory: OneClickHistoryRecorder,
    @Inject(SettlementAdmin) private readonly _settlement: SettlementAdmin,
    @Inject(LiveConfigProvider) private readonly _live: LiveConfigProvider,
    @Inject(ReconcileAlerts) private readonly _alerts: ReconcileAlerts,
  ) {}

  async onModuleInit() {
    // tự lấy phiên csgoempire bỏ cuộc → báo bấm Đăng nhập; lấy lại được → đóng báo
    this._live.onSessionHealth((profile, event) => {
      if (event.type === 'gave_up')
        void this._alerts.sessionLost(profile, event.error, event.attempts);
      else this._alerts.sessionRestored(profile);
    });
    // bảng On click nằm trong bộ nhớ: app khởi động lại → kèo đang mở trong lịch sử coi như rời bảng
    // (trader gửi lại kèo còn sống → dòng được mở lại)
    try {
      await this._ocHistory.closeOpen('app_restart');
    } catch (e: unknown) {
      this._logger.warn(`lịch sử On click: ${String(e)}`);
    }
    // kèo hết hạn không được làm mới → rời bảng, ghi lịch sử
    this._sweep = setInterval(() => {
      for (const ev of this._board.sweep())
        this._ocHistory
          .record(ev)
          .catch((e: unknown) => this._logger.warn(String(e)));
    }, ONE_CLICK_SWEEP_MS);
    // adapter đầu vào: dữ liệu task trader (hỏi cấu hình, kết quả lệnh)
    this._supervisor.onData(async (msg) => {
      try {
        await this._data.execute(msg);
      } catch (e: unknown) {
        const c = e instanceof Error ? e.cause : undefined;
        this._logger.error(
          `trader ${msg.taskId} (${msg.channel ?? '-'}) lỗi: ${String(e)}${c instanceof Error ? ` — ${c.message}` : ''}`,
        );
      }
    });
    const settle = () =>
      this._settlement
        .run()
        .then((r) => {
          if (r.settled)
            this._logger.log(
              `đối soát: ${r.settled}/${r.checked} lệnh có kết quả`,
            );
        })
        .catch((e: unknown) => {
          // drizzle gói lỗi Postgres thật (vd thiếu bảng) vào `cause`: in lý do, không in cả câu SQL
          const cause = e instanceof Error ? e.cause : undefined;
          const why =
            cause instanceof Error
              ? cause.message
              : e instanceof Error
                ? e.message.split('\n')[0]
                : String(e);
          this._logger.warn(
            `đối soát kết quả lệnh lỗi: ${why}${/trade_settlements/.test(why) ? ' — chưa chạy migration? Chạy: pnpm db:migrate' : ''}`,
          );
        });
    this._settle = setInterval(() => void settle(), SETTLEMENT_MS);
    this._settle.unref();
    setTimeout(() => void settle(), 60_000).unref();
    this._reconcile = setInterval(() => {
      if (this._reconciling) return;
      this._reconciling = this._sync
        .pushAll()
        .catch((e: unknown) => this._logger.warn(String(e)))
        .finally(() => {
          this._reconciling = null;
        });
    }, CONFIG_RECONCILE_MS);
  }

  onApplicationShutdown() {
    if (this._reconcile) clearInterval(this._reconcile);
    if (this._sweep) clearInterval(this._sweep);
    if (this._settle) clearInterval(this._settle);
  }
}
