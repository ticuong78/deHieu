import { z } from 'zod';

/**
 * Cấu hình task trader nhận qua lệnh 'config' (do module trading tính sẵn: bảng vốn theo hạng,
 * giới hạn rủi ro, giới hạn tổng theo trận). Đây là hợp đồng giữa app và worker: worker kiểm tra
 * chặt, sai dạng = từ chối lệnh (giữ cấu hình cũ).
 */
const nonNeg = z.number().finite().min(0);

export const TraderConfigSchema = z.object({
  v: z.literal(1),
  profileId: z.string().min(1),
  profileName: z.string(),
  active: z.boolean(),
  inactiveReason: z.string().nullable(),
  mode: z.enum(['paper', 'live']),
  execution: z
    .object({
      empire: z.object({
        browserProfile: z.string().min(1),
        token: z.string().min(1),
        expiresAt: nonNeg,
        apiUrl: z.literal('https://api-h-c7818b61-608.sptpub.com'),
        brandId: z.literal('2432911154364948480'),
        sessionId: z.string(),
        minBet: nonNeg,
        cookie: z.string().optional(),
        userAgent: z.string().optional(),
      }),
      polymarket: z.object({
        walletAddress: z.string(),
        funderAddress: z.string().nullable(),
        secretCipher: z.string().min(1),
      }),
    })
    .optional(),
  accounts: z.object({
    csgoempire: z.object({ id: z.string(), label: z.string() }).nullable(),
    polymarket: z.object({ id: z.string(), label: z.string() }).nullable(),
  }),
  stakeTable: z.array(
    z.object({
      tierId: z.string(),
      tierName: z.string(),
      minMargin: z.number().finite(),
      maxMargin: z.number().finite().nullable(),
      stake: nonNeg,
      minStake: nonNeg,
      maxStake: nonNeg,
      scaleWithinTier: z.boolean(),
      // app cũ không gửi → vào hạng
      enabled: z.boolean().default(true),
      // null = theo risk.maxEntriesPerTier; 0 = không giới hạn
      maxEntries: z.number().int().min(0).nullable().default(null),
      // null = theo risk.minDailyMargin (app cũ không gửi)
      minDailyMargin: z.number().min(0).max(10).nullable().default(null),
    }),
  ),
  strategy: z.object({
    id: z.string(),
    params: z.record(z.string(), z.unknown()),
  }),
  risk: z.object({
    minNetMargin: z.number().finite().min(0).max(1),
    matchCapUsd: nonNeg,
    maxSignalAgeMs: nonNeg,
    // 0 = không giới hạn số lệnh mỗi cửa mỗi hạng
    maxEntriesPerTier: z.number().int().min(0).default(1),
    ignoreCancelReasons: z.array(z.string()).default([]),
    // null = mọi market (app cũ không gửi)
    markets: z.array(z.string()).nullable().default(null),
    // giá bán thấp nhất Polymarket ≥ số này → không tự vào, chuyển On click; 0 = tắt (app cũ không gửi)
    oneClickMinPrice: z.number().min(0).max(1).default(0),
    // margin kèo / lãi ròng vượt số này → nghi giá cũ, bỏ qua; 0 = tắt (app cũ không gửi)
    maxNetMargin: z.number().min(0).max(10).default(0),
    // lãi tối thiểu mỗi ngày khóa vốn; 0 = tắt (app cũ không gửi)
    minDailyMargin: z.number().min(0).max(10).default(0),
  }),
  matchExposureCapUsd: nonNeg,
});

export type TraderConfig = z.infer<typeof TraderConfigSchema>;
