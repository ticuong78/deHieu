import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Header,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import {
  ApiZodBody,
  ApiZodQuery,
} from '../../../shared/presentation/openapi.js';
import { queryDate } from '../../../shared/presentation/query-date.js';
import {
  CurrentPrincipal,
  RequirePermissions,
} from '../../auth/presentation/auth.decorators.js';
import { TradingAdmin } from '../application/trading-admin.js';
import { ExposureAdmin } from '../application/exposure-admin.js';
import { OneClickAdmin } from '../application/one-click-admin.js';
import {
  ONE_CLICK_OUTCOMES,
  OneClickHistoryRecorder,
} from '../application/one-click-history.js';
import { OneClickNotifier } from '../application/one-click-notifier.js';
import { TRADING_PERMISSIONS as P } from '../application/trading.permissions.js';
import { TRADE_SOURCES, TRADE_STATUSES } from '../application/trade-attempt.js';
import { STAKE_TRENDS } from '../domain/stake-plan.js';
import { TRADER_MODES } from '../domain/trader-profile.js';
import { REBALANCE_MODES } from '../domain/trading-settings.js';
import { unwrap } from './http-errors.js';
import { EmpireLoginAdmin } from '../application/empire-login-admin.js';
import { ReconcileAdmin } from '../application/reconcile-admin.js';
import { RebalanceAdvisor } from '../application/rebalance-advisor.js';
import { RebalanceExecutor } from '../application/rebalance-executor.js';
import { AccountCheckAdmin } from '../application/account-check-admin.js';
import { AccountReportAdmin } from '../application/account-report-admin.js';
import {
  SETTLE_WINNERS,
  SettlementAdmin,
} from '../application/trade-settlement.js';

const money = z.number().min(0).max(1_000_000);
const evmAddress = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'dạng 0x + 40 ký tự hex');

const AccountBody = z.object({
  loginUsername: z.string().trim().min(1).max(200).optional(),
  loginPassword: z.string().min(1).max(500).optional(),
  label: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  config: z.discriminatedUnion('venue', [
    z.object({
      venue: z.literal('csgoempire'),
      browserProfile: z.string().trim().min(1).max(64),
      /** Địa chỉ nạp USDT Polygon của csgoempire đã xác nhận (tự chuyển Polymarket → csgoempire). */
      usdtDepositAddress: evmAddress.nullish().transform((v) => v || null),
    }),
    z.object({
      venue: z.literal('polymarket'),
      walletAddress: z.string().trim(),
      funderAddress: z
        .string()
        .trim()
        .nullish()
        .transform((v) => v || null),
      /** Địa chỉ nạp USDT Polygon ở trang Deposit của Polymarket (tự rút csgoempire → Polymarket). */
      usdtDepositAddress: evmAddress.nullish().transform((v) => v || null),
      /** "Signer Address" của Relayer API Key (polymarket.com → Settings → API Keys). */
      relayerApiKeyAddress: evmAddress.nullish().transform((v) => v || null),
    }),
  ]),
  /** Chỉ polymarket. Bỏ trống khi sửa = giữ key cũ. Không bao giờ được trả lại. */
  privateKey: z.string().trim().max(200).optional(),
  /** Chỉ polymarket: Relayer API Key (chuyển tiền gasless). Bỏ trống khi sửa = giữ key cũ. Không bao giờ được trả lại. */
  relayerApiKey: z.string().trim().max(500).optional(),
});

const StakePlanBody = z.object({
  trend: z.enum(STAKE_TRENDS).default('flat'),
  baseStake: money.default(50),
  stepPct: z.number().min(0).max(10).default(0.5),
  minStakeRatio: z.number().min(0).max(1).default(0.5),
  maxStakeRatio: z.number().min(1).max(100).default(1),
  scaleWithinTier: z.boolean().default(false),
  overrides: z
    .record(
      z.string(),
      z.object({
        stake: money.optional(),
        minStake: money.optional(),
        maxStake: money.optional(),
        /** Số lệnh tối đa mỗi cửa ở hạng này (ghi đè risk.maxEntriesPerTier); 0 = không giới hạn. */
        maxEntries: z.number().int().min(0).max(100).optional(),
        /** Lãi tối thiểu mỗi ngày ở hạng này (ghi đè risk.minDailyMargin); 0 = tắt cho hạng này. */
        minDailyMargin: z.number().min(0).max(10).optional(),
      }),
    )
    .default({}),
  /** Hạng profile được vào; [] (mặc định) = chưa chọn → profile đứng yên; null = mọi hạng. */
  tierIds: z.array(z.string().min(1).max(100)).max(200).nullable().default([]),
});

const ProfileBody = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  mode: z.enum(TRADER_MODES).default('paper'),
  csgoempireAccountId: z.string().min(1),
  polymarketAccountId: z.string().min(1),
  stakePlan: StakePlanBody,
  strategy: z
    .object({
      id: z.string().trim().min(1).max(60),
      params: z.record(z.string(), z.unknown()).default({}),
    })
    .default({ id: 'arb-taker', params: {} }),
  risk: z
    .object({
      minNetMargin: z.number().min(0).max(0.99).default(0.01),
      matchCapUsd: money.default(0),
      maxSignalAgeMs: z.number().int().min(0).max(600_000).default(3_000),
      /** Số lệnh tối đa cho một cửa ở mỗi hạng kèo (mỗi hạng tính riêng); 0 = không giới hạn. */
      maxEntriesPerTier: z.number().int().min(0).max(100).default(1),
      /** Lý do hủy kèo mà trader vẫn vào tiếp lệnh đang tính. */
      ignoreCancelReasons: z
        .array(z.string().trim().min(1).max(60))
        .max(30)
        .default(['better_opportunity']),
      /** Market được vào; null = mọi market; [] = chưa chọn (profile đứng yên). */
      markets: z
        .array(z.string().regex(/^[a-z0-9.-]{1,60}$/))
        .max(100)
        .nullable()
        .default(null),
      /** Giá bán thấp nhất Polymarket ≥ số này → chuyển On click (bot không tự vào); 0 = tắt. */
      oneClickMinPrice: z.number().min(0).max(1).default(0.5),
      /** Margin / lãi ròng vượt số này → nghi giá cũ, bỏ qua (cả vào tay); 0 = tắt. */
      maxNetMargin: z.number().min(0).max(10).default(0.15),
      /** Lãi tối thiểu mỗi ngày khóa vốn (margin ÷ số ngày tới khi trận có kết quả); 0 = tắt. */
      minDailyMargin: z.number().min(0).max(10).default(0),
    })
    .default({
      minNetMargin: 0.01,
      matchCapUsd: 0,
      maxSignalAgeMs: 3_000,
      maxEntriesPerTier: 1,
      ignoreCancelReasons: ['better_opportunity'],
      markets: null,
      oneClickMinPrice: 0.5,
      maxNetMargin: 0.15,
      minDailyMargin: 0,
    }),
});

const SettingsBody = z.object({
  matchExposureCapUsd: money,
  /** Tự chuyển tiền cân bằng 35/65; bỏ trống = giữ cấu hình hiện tại. */
  rebalance: z
    .object({
      mode: z.enum(REBALANCE_MODES),
      maxPerTransferUsd: money,
      maxPerDayUsd: money,
      minTransferUsd: money,
    })
    .partial()
    .optional(),
});

const TradesQuery = z.object({
  profileId: z.string().optional(),
  status: z.enum(TRADE_STATUSES).optional(),
  /** bot = Auto trade, manual = người vào tay ở On click; bỏ trống = cả hai. */
  source: z.enum(TRADE_SOURCES).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const AccountReportQuery = z.object({
  /** live, shadow (giấy đối chiếu của lệnh thật), paper; phân tách bằng dấu phẩy. */
  modes: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        : undefined,
    ),
  tz: z.string().max(64).optional(),
  since: z.coerce.number().int().positive().optional(),
});
const SettlementBody = z.object({ winner: z.enum(SETTLE_WINNERS) });

const PurgeBody = z.object({
  /** Một hoặc nhiều trạng thái (OR). */
  statuses: z
    .array(z.enum(TRADE_STATUSES))
    .max(TRADE_STATUSES.length)
    .optional(),
  /** true = mọi trạng thái. Không dùng chung với statuses. */
  all: z.boolean().default(false),
  profileId: z.string().min(1).optional(),
  /** Chỉ xóa lệnh có createdAt < before (ms). */
  before: z.number().int().positive().optional(),
  /** true = chỉ đếm số lệnh sẽ xóa. */
  dryRun: z.boolean().default(false),
});

const ExposureResetBody = z.union([
  z.object({
    match: z.string().trim().min(1).max(300),
    mode: z.enum(TRADER_MODES).optional(),
  }),
  z.object({
    mode: z.enum(TRADER_MODES).optional(),
    entry: z.object({
      profileId: z.string().min(1).max(100),
      room: z.string().min(1).max(300),
      comboId: z.string().min(1).max(100),
      tierId: z.string().min(1).max(100),
    }),
  }),
]);

const OneClickQuery = z.object({ profileId: z.string().min(1) });
const OneClickHistoryQuery = z.object({
  profileId: z.string().min(1).optional(),
  q: z.string().trim().max(200).optional(),
  outcome: z.enum(ONE_CLICK_OUTCOMES).optional(),
  from: queryDate(),
  to: queryDate(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const PushTestBody = z.object({
  /** Mã đăng ký OneSignal của thiết bị đang bấm; bỏ trống = mọi thiết bị bật mục "Kèo". */
  subscriptionId: z.string().min(1).max(200).optional(),
});
const OneClickEnterBody = z.object({
  profileId: z.string().min(1),
  signalId: z.string().min(1),
  /** Tiền mục tiêu chân csgoempire người nhập; bỏ trống = theo hạng của profile. */
  targetStake: z.number().positive().max(1_000_000).optional(),
});

const StatsQuery = z.object({
  profileId: z.string().optional(),
  since: z.coerce.number().int().positive().optional(),
  source: z.enum(TRADE_SOURCES).optional(),
});

/**
 * Auto trade: tài khoản (nhiều tài khoản mỗi nền tảng), profile trader, cấu hình chung, lệnh giấy.
 * Task trader (kind `trader.arbitrage`, params {profileId}) tạo ở trang Publisher như task khác.
 */
@Controller('trading')
@ApiTags('Auto trade')
export class TradingController {
  constructor(
    @Inject(TradingAdmin) private readonly _admin: TradingAdmin,
    @Inject(ExposureAdmin) private readonly _exposure: ExposureAdmin,
    @Inject(OneClickAdmin) private readonly _oneClick: OneClickAdmin,
    @Inject(OneClickHistoryRecorder)
    private readonly _ocHistory: OneClickHistoryRecorder,
    @Inject(OneClickNotifier) private readonly _notifier: OneClickNotifier,
    @Inject(EmpireLoginAdmin) private readonly _empireLogin: EmpireLoginAdmin,
    @Inject(AccountCheckAdmin)
    private readonly _accountCheck: AccountCheckAdmin,
    @Inject(AccountReportAdmin)
    private readonly _accountReport: AccountReportAdmin,
    @Inject(SettlementAdmin) private readonly _settlement: SettlementAdmin,
    @Inject(ReconcileAdmin) private readonly _reconcile: ReconcileAdmin,
    @Inject(RebalanceAdvisor) private readonly _rebalance: RebalanceAdvisor,
    @Inject(RebalanceExecutor) private readonly _transfer: RebalanceExecutor,
  ) {}

  // ------------------------------------------------------------- tài khoản

  @Get('accounts')
  @RequirePermissions(P.READ)
  @ApiOperation({
    summary: 'Danh sách tài khoản giao dịch',
    description:
      'Quyền: trading:read. Không bao giờ trả private key; hasSecret cho biết đã lưu key hay chưa.',
  })
  accounts() {
    return this._admin.listAccounts();
  }

  @Post('accounts')
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Thêm tài khoản',
    description:
      'Quyền: trading:manage. csgoempire: hồ sơ Chromium, tùy chọn loginUsername/loginPassword mã hóa bằng TRADING_SECRET_KEY để tự đăng nhập. polymarket: địa chỉ ví + private key mã hóa. Không trả thông tin bí mật.',
  })
  @ApiZodBody(AccountBody, {
    csgoempire: {
      summary: 'Tài khoản csgoempire',
      value: {
        label: 'Empire #1',
        config: { venue: 'csgoempire', browserProfile: 'empire-1' },
      },
    },
    polymarket: {
      summary: 'Ví polymarket',
      value: {
        label: 'Poly #1',
        config: {
          venue: 'polymarket',
          walletAddress: '0x0000000000000000000000000000000000000001',
        },
        privateKey: '<64 ký tự hex>',
      },
    },
  })
  async createAccount(@Body() body: unknown) {
    return unwrap(await this._admin.saveAccount(null, AccountBody.parse(body)));
  }

  @Put('accounts/:id')
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Sửa tài khoản',
    description:
      'Quyền: trading:manage. Bỏ trống privateKey = giữ key cũ. Không đổi được nền tảng.',
  })
  @ApiZodBody(AccountBody)
  async updateAccount(@Param('id') id: string, @Body() body: unknown) {
    return unwrap(await this._admin.saveAccount(id, AccountBody.parse(body)));
  }

  @Delete('accounts/:id')
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Xóa tài khoản',
    description: 'Quyền: trading:manage. Đang dùng trong profile → 400.',
  })
  async deleteAccount(@Param('id') id: string) {
    return unwrap(await this._admin.deleteAccount(id));
  }

  // ------------------------------------------------------------- profile
  @Post('accounts/:id/browser-login')
  @HttpCode(202)
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Mở Chromium có giao diện, tự đăng nhập và lấy phiên',
  })
  async browserLogin(@Param('id') id: string) {
    return unwrap(await this._empireLogin.start(id));
  }

  @Post('accounts/:id/check')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Đọc tài khoản thật + Cash trên sàn bằng đúng phiên/khóa bot dùng',
    description:
      'Quyền: trading:manage. csgoempire: user id, tên Steam, Cash (USD) và có khớp email/username đã lưu không. polymarket: ví ký lệnh, ví giữ tiền, Cash USDC, allowance. Không trả bí mật.',
  })
  async checkAccount(@Param('id') id: string) {
    return unwrap(await this._accountCheck.check(id));
  }

  @Get('accounts/:id/report')
  @RequirePermissions(P.READ)
  @ApiOperation({
    summary:
      'Báo cáo tài khoản: lãi/lỗ theo ngày/tuần/tháng/quý/năm, từng lệnh, thật ↔ giấy',
    description:
      'Quyền: trading:read. Lãi/lỗ CHÂN của tài khoản và lãi CẢ CẶP tách riêng (lỗ một chân là bình thường). Chỉ lệnh có kết quả (đối soát từ Polymarket hoặc sửa tay) mới có lãi/lỗ thật.',
  })
  @ApiZodQuery(AccountReportQuery)
  async accountReport(@Param('id') id: string, @Query() q: unknown) {
    const b = AccountReportQuery.parse(q);
    return unwrap(
      await this._accountReport.report(id, {
        modes: b.modes,
        timeZone: b.tz,
        since: b.since,
      }),
    );
  }

  @Get('accounts/:id/browser-login')
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Trạng thái đăng nhập, không trả JWT hoặc thông tin đăng nhập',
  })
  async browserLoginStatus(@Param('id') id: string) {
    return unwrap(await this._empireLogin.status(id));
  }

  @Post('accounts/:id/browser-login/jwt')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @RequirePermissions(P.MANAGE)
  @ApiOperation({ summary: 'Nhận JWT đúng một lần của lần đăng nhập vừa tạo' })
  async takeBrowserJwt(@Param('id') id: string, @Body() body: unknown) {
    const { attemptId } = z.object({ attemptId: z.uuid() }).parse(body);
    return unwrap(await this._empireLogin.takeJwt(id, attemptId));
  }

  @Delete('accounts/:id/browser-login')
  @RequirePermissions(P.MANAGE)
  @ApiOperation({ summary: 'Dừng đăng nhập và đóng Chromium' })
  async cancelBrowserLogin(@Param('id') id: string) {
    return unwrap(await this._empireLogin.cancel(id));
  }

  @Get('profiles')
  @RequirePermissions(P.READ)
  @ApiOperation({
    summary: 'Danh sách profile trader',
    description: 'Quyền: trading:read',
  })
  profiles() {
    return this._admin.listProfiles();
  }

  @Get('profiles/:id')
  @RequirePermissions(P.READ)
  @ApiOperation({
    summary: 'Chi tiết profile',
    description: 'Quyền: trading:read',
  })
  async profile(@Param('id') id: string) {
    return unwrap(await this._admin.getProfile(id));
  }

  @Get('profiles/:id/runtime-config')
  @RequirePermissions(P.READ)
  @ApiOperation({
    summary: 'Cấu hình worker nhận',
    description:
      'Quyền: trading:read. Bảng vốn đã tính theo hạng hiện tại + giới hạn; active=false kèm lý do nếu trader sẽ đứng yên.',
  })
  runtimeConfig(@Param('id') id: string) {
    return this._admin.runtimeConfig(id);
  }

  @Post('profiles')
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Thêm profile trader',
    description:
      'Quyền: trading:manage. 1 tài khoản csgoempire + 1 ví polymarket + kế hoạch vốn theo hạng kèo + chiến lược + giới hạn rủi ro.',
  })
  @ApiZodBody(ProfileBody)
  async createProfile(@Body() body: unknown) {
    return unwrap(await this._admin.saveProfile(null, ProfileBody.parse(body)));
  }

  @Put('profiles/:id')
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Sửa profile trader',
    description: 'Quyền: trading:manage',
  })
  @ApiZodBody(ProfileBody)
  async updateProfile(@Param('id') id: string, @Body() body: unknown) {
    return unwrap(await this._admin.saveProfile(id, ProfileBody.parse(body)));
  }

  @Post('profiles/:id/reevaluate')
  @HttpCode(200)
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Xét lại kèo đang sống',
    description:
      'Quyền: trading:manage. Task trader đang chạy của profile bỏ dấu "đã xử lý" và xét lại ngay mọi kèo còn sống (không xóa lệnh). Cửa đã vào vẫn bị chặn bởi số lệnh mỗi hạng. Trả { tasks } = số task đã nhận lệnh.',
  })
  async reevaluateProfile(@Param('id') id: string) {
    return unwrap(await this._admin.reevaluateProfile(id));
  }

  @Post('profiles/:id/reconciled')
  @HttpCode(200)
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Đã đối soát — gỡ khóa vào lệnh của profile',
    description:
      'Quyền: trading:manage. Dùng SAU KHI đã kiểm tra hai chân trên sàn (và tự xử lý chân lẻ nếu có). Gỡ khóa "lệnh chưa rõ kết quả" (LIVE_RECONCILIATION_REQUIRED) trên cả hai tài khoản của profile rồi gửi lại cấu hình cho worker. Khóa phiên hết hạn không gỡ ở đây (bấm Đăng nhập). Trả { cleared } = lý do các khóa đã gỡ; không có khóa nào → 400 NO_RECONCILIATION_HALT.',
  })
  async reconciled(@Param('id') id: string) {
    return unwrap(await this._reconcile.resume(id));
  }

  @Get('rebalance')
  @RequirePermissions(P.READ)
  @ApiOperation({
    summary: 'Đề xuất cân bằng tiền đang chờ',
    description:
      'Quyền: trading:read. Lệnh thật bị hủy vì một bên thiếu Cash (INSUFFICIENT_CASH) → app tính kế hoạch chuyển tiền giữa hai tài khoản của profile về tỉ lệ csgoempire empireShare (0.35) / Polymarket phần còn lại, theo số dư đọc ngay trước khi gửi lệnh. Mỗi profile một đề xuất (mới nhất). App KHÔNG tự chuyển tiền. Đề xuất chỉ nằm trong bộ nhớ (restart app = mất; sự cố tương ứng vẫn lưu ở mục Sự cố).',
  })
  rebalance() {
    return {
      empireShare: this._rebalance.empireShare,
      suggestions: this._rebalance.list(),
    };
  }

  @Get('rebalance/transfers')
  @RequirePermissions(P.READ)
  @ApiOperation({
    summary: 'Lịch sử tự chuyển tiền',
    description:
      'Quyền: trading:read. 50 lượt gần nhất (Redis): dry_run (chạy thử), skipped (lý do), planned/submitted/sent, completed, failed, unconfirmed / unknown (tự chuyển của profile bị chặn tới khi gỡ). Kèm `blocked`: profileId → lý do chặn.',
  })
  async rebalanceTransfers() {
    const transfers = await this._transfer.list(50);
    const ids = [...new Set(transfers.map((t) => t.profileId))];
    const blocked = Object.fromEntries(
      (
        await Promise.all(
          ids.map(
            async (id) => [id, await this._transfer.blocked(id)] as const,
          ),
        )
      ).filter(([, r]) => r),
    );
    return { transfers, blocked };
  }

  @Post('rebalance/:profileId/execute')
  @HttpCode(200)
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Chuyển ngay (cân bằng 35/65)',
    description:
      'Quyền: trading:manage. Đọc số dư mới, tính số cần chuyển và chuyển theo chế độ ở Giới hạn chung (dry_run = chỉ ghi "sẽ chuyển", live = chuyển thật), trong hạn mức mỗi lần / mỗi ngày, chỉ tới địa chỉ nạp đã lưu. Trả kết quả nếu xong trong 15 giây, không thì { started: true } (xem lịch sử).',
  })
  async rebalanceExecute(@Param('profileId') profileId: string) {
    const run = this._transfer.run(profileId, 'manual');
    const done = await Promise.race([
      run,
      new Promise<null>((r) => setTimeout(() => r(null), 15_000)),
    ]);
    if (!done) {
      run.catch(() => undefined);
      return { started: true };
    }
    return unwrap(done);
  }

  @Post('rebalance/:profileId/unblock')
  @HttpCode(200)
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Gỡ chặn tự chuyển tiền',
    description:
      'Quyền: trading:manage. Dùng SAU KHI đã kiểm tra tiền trên hai sàn (lượt chuyển trước lỗi / chưa rõ kết quả). Đóng sự cố tương ứng.',
  })
  async rebalanceUnblock(
    @Param('profileId') profileId: string,
    @CurrentPrincipal() principal?: { id: string },
  ) {
    return unwrap(
      await this._transfer.unblock(profileId, principal?.id ?? 'unknown'),
    );
  }

  @Get('accounts/:id/empire-deposit-address')
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Địa chỉ nạp USDT Polygon csgoempire của tài khoản',
    description:
      'Quyền: trading:manage. Đọc bằng Chrome nền của hồ sơ (trang Deposit → USDT Polygon). Người vận hành đối chiếu rồi lưu vào tài khoản để bật tự chuyển Polymarket → csgoempire.',
  })
  async empireDepositAddress(@Param('id') id: string) {
    return unwrap(await this._transfer.empireDepositAddress(id));
  }

  @Post('rebalance/:profileId/done')
  @HttpCode(200)
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Đã chuyển tiền xong — đóng đề xuất cân bằng',
    description:
      'Quyền: trading:manage. Dùng SAU KHI đã tự chuyển tiền giữa hai tài khoản (hoặc quyết định bỏ qua). Xóa đề xuất của profile và đóng sự cố "Cần cân bằng tiền". Không có đề xuất → 404.',
  })
  rebalanceDone(
    @Param('profileId') profileId: string,
    @CurrentPrincipal() principal?: { id: string },
  ) {
    const r = this._rebalance.resolve(profileId, principal?.id ?? 'unknown');
    return unwrap(r ? { status: 'SUCEED', data: r } : { status: 'NOT_FOUND' });
  }

  @Delete('profiles/:id')
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Xóa profile trader',
    description:
      'Quyền: trading:manage. Task trader đang chạy với profile này sẽ đứng yên (PROFILE_NOT_FOUND).',
  })
  async deleteProfile(@Param('id') id: string) {
    return unwrap(await this._admin.deleteProfile(id));
  }

  @Post('stake-preview')
  @RequirePermissions(P.READ)
  @ApiOperation({
    summary: 'Xem trước bảng vốn',
    description:
      'Quyền: trading:read. Tính tiền / tối thiểu / tối đa cho từng hạng kèo hiện có từ kế hoạch vốn (không lưu).',
  })
  @ApiZodBody(StakePlanBody, {
    up: {
      summary: 'Tăng 50% mỗi hạng từ 50$',
      value: { trend: 'up', baseStake: 50, stepPct: 0.5 },
    },
  })
  async stakePreview(@Body() body: unknown) {
    return unwrap(
      await this._admin.previewStakeTable(StakePlanBody.parse(body)),
    );
  }

  // ------------------------------------------------------------- cấu hình chung

  @Get('settings')
  @RequirePermissions(P.READ)
  @ApiOperation({
    summary: 'Cấu hình auto trade',
    description:
      'Quyền: trading:read. matchExposureCapUsd: tổng tiền tối đa vào một trận cho mọi tài khoản (0 = tắt). secretKeyConfigured: đã đặt TRADING_SECRET_KEY chưa.',
  })
  async settings() {
    return {
      ...(await this._admin.getSettings()),
      secretKeyConfigured: this._admin.secretKeyConfigured(),
    };
  }

  @Put('settings')
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Sửa cấu hình auto trade',
    description: 'Quyền: trading:manage',
  })
  @ApiZodBody(SettingsBody, {
    on: { summary: 'Tối đa 500$/trận', value: { matchExposureCapUsd: 500 } },
    off: { summary: 'Tắt giới hạn', value: { matchExposureCapUsd: 0 } },
  })
  async saveSettings(@Body() body: unknown) {
    const b = SettingsBody.parse(body);
    const cur = await this._admin.getSettings();
    return unwrap(
      await this._admin.saveSettings({
        ...cur,
        matchExposureCapUsd: b.matchExposureCapUsd,
        rebalance: { ...cur.rebalance, ...(b.rebalance ?? {}) },
      }),
    );
  }

  // ------------------------------------------------------------- lệnh

  @Get('trades')
  @RequirePermissions(P.READ)
  @ApiOperation({
    summary: 'Lệnh (giấy) gần nhất',
    description:
      'Quyền: trading:read. Mới nhất trước; phân trang lùi bằng before = createdAt của dòng cuối.',
  })
  trades(@Query() q: unknown) {
    return this._admin.listTrades(TradesQuery.parse(q));
  }

  @Get('trades/stats')
  @RequirePermissions(P.READ)
  @ApiOperation({
    summary: 'Thống kê lệnh',
    description:
      'Quyền: trading:read. Số lần vào/bỏ qua/hủy, tổng tiền, lãi giả định, lý do bỏ qua. source = bot (Auto trade) | manual (người vào tay ở On click); bỏ trống = gộp cả hai.',
  })
  stats(@Query() q: unknown) {
    return this._admin.tradeStats(StatsQuery.parse(q));
  }

  // ------------------------------------------------------------- On click (người vào lệnh)

  @Get('oneclick')
  @RequirePermissions(P.READ)
  @ApiOperation({
    summary: 'Kèo chờ người vào lệnh (On click)',
    description:
      'Quyền: trading:read. Kèo trader của profile KHÔNG tự vào vì giá bán thấp nhất Polymarket ≥ oneClickMinPrice của profile. Mỗi mục: phân tích "nếu vào bây giờ" (giống lệnh bot: sổ lệnh, chia tiền, lãi), cập nhật mỗi lần kèo được làm mới. Trong bộ nhớ app.',
  })
  oneClick(@Query() q: unknown) {
    return this._oneClick.list(OneClickQuery.parse(q).profileId);
  }

  @Get('oneclick/history')
  @RequirePermissions(P.READ)
  @ApiOperation({
    summary: 'Lịch sử On click',
    description:
      'Quyền: trading:read. Mỗi profile × kèo một dòng: lên bảng lúc, số lần cập nhật, phân tích gần nhất, rời bảng lúc / vì sao (endReason: manual:<kết quả> | cancelled:<lý do hủy> | expired | result:<kết quả> | app_restart). outcome lọc: open | manual | cancelled | expired | auto | other. q = mã kèo (phần đầu) hoặc tên đội / room. Trả { total, items }.',
  })
  @ApiZodQuery(OneClickHistoryQuery)
  oneClickHistory(@Query() q: unknown) {
    return this._ocHistory.list(OneClickHistoryQuery.parse(q));
  }

  @Get('push/status')
  @RequirePermissions(P.READ)
  @ApiOperation({
    summary: 'Trạng thái gửi thông báo đẩy (OneSignal) của backend',
    description:
      'Quyền: trading:read. configured = đã đặt ONESIGNAL_APP_ID + ONESIGNAL_REST_API_KEY; webUrl = WEB_APP_URL (link mở khi bấm thông báo).',
  })
  pushStatus() {
    return {
      configured: this._notifier.enabled,
      webUrl: this._notifier.webUrl,
    };
  }

  @Post('push/test')
  @HttpCode(200)
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Gửi thử thông báo đẩy thật qua OneSignal',
    description:
      'Quyền: trading:manage. Cùng đường gửi với kèo On click. subscriptionId = chỉ thiết bị này; bỏ trống = mọi thiết bị bật mục "Kèo". Trả { id, errors } của OneSignal; 400 ONESIGNAL_NOT_CONFIGURED khi backend chưa có key; 400 ONESIGNAL_FAILED kèm lỗi HTTP.',
  })
  @ApiZodBody(PushTestBody)
  async pushTest(
    @Body() body: unknown,
    @CurrentPrincipal() principal?: { id: string },
  ) {
    const b = PushTestBody.parse(body);
    try {
      const r = await this._notifier.test(
        principal?.id ?? 'unknown',
        b.subscriptionId,
      );
      if (!r)
        throw new BadRequestException(
          'ONESIGNAL_NOT_CONFIGURED: backend chưa đặt ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY',
        );
      return r;
    } catch (e: unknown) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(`ONESIGNAL_FAILED: ${String(e)}`);
    }
  }

  @Post('oneclick/enter')
  @HttpCode(200)
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Người vào lệnh (giấy) một kèo On click',
    description:
      'Quyền: trading:manage. Task trader của profile đọc lại sổ lệnh và vào lệnh như bot (bảng tiền, số lệnh mỗi hạng, hạn mức trận), ghi kèm người vào (detail.manual.by). targetStake = tiền mục tiêu người nhập thay tiền của hạng; vẫn taker như bot (mức giá hết lãi thì dừng, vào ít hơn). Kết quả hiện ở Lệnh giấy. 404 = kèo không còn trên bảng.',
  })
  @ApiZodBody(OneClickEnterBody)
  async oneClickEnter(
    @Body() body: unknown,
    @CurrentPrincipal() principal?: { id: string },
  ) {
    const b = OneClickEnterBody.parse(body);
    return unwrap(
      await this._oneClick.enter(
        b.profileId,
        b.signalId,
        principal?.id ?? 'unknown',
        b.targetStake,
      ),
    );
  }

  // ------------------------------------------------------------- sổ phơi nhiễm (Redis)

  @Get('exposure')
  @RequirePermissions(P.READ)
  @ApiOperation({
    summary: 'Sổ phơi nhiễm thật (Redis)',
    description:
      'Quyền: trading:read. Số liệu trader dùng để quyết định, đọc thẳng từ Redis: tiền đã dùng theo trận (chung + riêng profile) và số lệnh đã vào mỗi cửa mỗi hạng, kèm TTL. Không phụ thuộc lịch sử lệnh trong DB (xóa lệnh không đổi sổ này). Chỉ có khi task trader bật sharedExposure (mặc định).',
  })
  exposure(@Query('mode') mode?: string) {
    return this._exposure.view(z.enum(TRADER_MODES).optional().parse(mode));
  }

  @Post('exposure/reset')
  @HttpCode(200)
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Đặt lại sổ phơi nhiễm',
    description:
      'Quyền: trading:manage. { match } = xóa tiền đã dùng của trận (chung + mọi profile); { entry: {profileId, room, comboId, tierId} } = xóa bộ đếm số lệnh của cửa + hạng đó. Trả { keys } = số khóa đã xóa.',
  })
  @ApiZodBody(ExposureResetBody, {
    match: {
      summary: 'Trả lại hạn mức trận',
      value: { match: 'cs2:aurora~ninjasinpyjamas' },
    },
  })
  async resetExposure(@Body() body: unknown) {
    const b = ExposureResetBody.parse(body);
    return unwrap(
      'match' in b
        ? await this._exposure.resetMatch(b.match, b.mode)
        : await this._exposure.resetEntry(b.entry, b.mode),
    );
  }

  @Post('trades/purge')
  @HttpCode(200)
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Xóa lệnh trong sổ',
    description:
      'Quyền: trading:manage. Xóa theo một/nhiều trạng thái (statuses, kết hợp OR) hoặc toàn bộ (all = true); có thể giới hạn thêm theo profileId và before. Xóa cả các chân lệnh. dryRun = true chỉ trả số lệnh sẽ xóa. Trả { matched, deleted }.',
  })
  @ApiZodBody(PurgeBody, {
    statuses: {
      summary: 'Xóa lệnh bỏ qua + lỗi',
      value: { statuses: ['skipped', 'error'] },
    },
    filled: {
      summary: 'Xóa lệnh đã vào của một profile',
      value: { statuses: ['paper_filled'], profileId: 'prof-1' },
    },
    all: { summary: 'Xóa toàn bộ', value: { all: true } },
    preview: {
      summary: 'Đếm trước khi xóa',
      value: { statuses: ['cancelled'], dryRun: true },
    },
  })
  async purgeTrades(@Body() body: unknown) {
    return unwrap(await this._admin.purgeTrades(PurgeBody.parse(body)));
  }

  @Delete('trades/:id')
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Xóa một lệnh',
    description: 'Quyền: trading:manage. Xóa lệnh kèm các chân.',
  })
  async deleteTrade(@Param('id') id: string) {
    return unwrap(await this._admin.deleteTrade(id));
  }

  @Post('settlements/run')
  @HttpCode(200)
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Đối soát kết quả ngay (đọc market đã resolve trên Polymarket)',
  })
  async runSettlement() {
    try {
      return await this._settlement.run();
    } catch (e) {
      throw new BadRequestException(
        e instanceof Error ? e.message : 'SETTLEMENT_FAILED',
      );
    }
  }

  @Put('trades/:id/settlement')
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Sửa tay kết quả lệnh (cửa thắng / hủy trận)',
    description:
      'Quyền: trading:manage. winner: polymarket | csgoempire | void. Ghi đè kết quả tự động.',
  })
  @ApiZodBody(SettlementBody)
  async setSettlement(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal?: { id: string },
  ) {
    const { winner } = SettlementBody.parse(body);
    return unwrap(
      await this._settlement.setManual(id, winner, principal?.id ?? 'unknown'),
    );
  }

  @Delete('trades/:id/settlement')
  @RequirePermissions(P.MANAGE)
  @ApiOperation({
    summary: 'Bỏ kết quả lệnh (lượt đối soát sau lấy lại từ Polymarket)',
  })
  async clearSettlement(@Param('id') id: string) {
    return unwrap(await this._settlement.clear(id));
  }

  @Get('trades/:id')
  @RequirePermissions(P.READ)
  @ApiOperation({
    summary: 'Chi tiết một lệnh',
    description:
      'Quyền: trading:read. Kèm từng chân (csgoempire / polymarket): giá lúc kèo phát, giá yêu cầu, giá khớp, mốc thời gian.',
  })
  async trade(@Param('id') id: string) {
    return unwrap(await this._admin.getTrade(id));
  }
}
