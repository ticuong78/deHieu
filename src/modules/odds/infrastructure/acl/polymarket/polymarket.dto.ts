import { z } from 'zod';

/**
 * Dạng dữ liệu đã được @polymarket/client chuẩn hóa (camelCase, nhóm theo state/prices/sports...).
 * SDK đổi định dạng → chỉ sửa file này + translator.
 */
const decimal = z
  .union([z.string(), z.number()])
  .transform(Number)
  .pipe(z.number());

const OutcomeSchema = z.looseObject({
  label: z.string(),
  tokenId: z.string().nullable(),
});

export const PolymarketMarketSchema = z.looseObject({
  conditionId: z.string().nullable(),
  slug: z.string().nullish(),
  /** vd "Map 1 Winner", "Game 1 Winner", "O/U 2.5 Games". */
  groupItemTitle: z.string().nullish(),
  state: z.looseObject({
    closed: z.boolean().nullish(),
    acceptingOrders: z.boolean().nullish(),
  }),
  outcomes: z.looseObject({ yes: OutcomeSchema, no: OutcomeSchema }),
  prices: z.looseObject({
    bestBid: decimal.nullish(),
    bestAsk: decimal.nullish(),
  }),
  sports: z.looseObject({
    sportsMarketType: z.string().nullish(),
    /** Mức chấp của outcome yes (vd map_handicap: yes=INFURITY, line=-1.5). */
    line: decimal.nullish(),
    gameStartTime: z.string().nullish(),
  }),
});

export const PolymarketEventSchema = z.looseObject({
  id: z.string(),
  slug: z.string().nullish(),
  schedule: z.looseObject({ startTime: z.string().nullish() }),
  state: z
    .looseObject({ live: z.boolean().nullish(), ended: z.boolean().nullish() })
    .nullish(),
  sports: z.looseObject({
    sport: z
      .looseObject({ sport: z.string(), tags: z.string().nullish() })
      .nullish(),
    teams: z.array(z.looseObject({ name: z.string() })).nullish(),
    seriesSlug: z.string().nullish(),
  }),
  /** Giải (series) của trận trên Polymarket. */
  series: z
    .array(
      z.looseObject({
        id: z.union([z.string(), z.number()]).transform(String),
        slug: z.string().nullish(),
        title: z.string().nullish(),
      }),
    )
    .nullish(),
  markets: z.array(z.unknown()).default([]),
});

/** Payload của task 'polymarket.descriptor': một trang Event[]. */
export const PolymarketEventsPayloadSchema = z.array(z.unknown());

const AskLevel = z.looseObject({ price: decimal });

/** Event của subscription 'market' (SDK): { topic, type, payload }. */
export const PolymarketStreamEventSchema = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('price_change'),
    payload: z.looseObject({
      priceChanges: z.array(
        z.looseObject({ assetId: z.string(), bestAsk: decimal.nullish() }),
      ),
    }),
  }),
  z.looseObject({
    type: z.literal('book'),
    payload: z.looseObject({ assetId: z.string(), asks: z.array(AskLevel) }),
  }),
  z.looseObject({
    type: z.literal('best_bid_ask'),
    payload: z.looseObject({ assetId: z.string(), bestAsk: decimal.nullish() }),
  }),
  z.looseObject({
    type: z.literal('market_resolved'),
    payload: z.looseObject({ assetIds: z.array(z.string()).nullish() }),
  }),
  z.looseObject({
    type: z.literal('last_trade_price'),
    payload: z.looseObject({
      assetId: z.string(),
      price: decimal,
      side: z.enum(['BUY', 'SELL']),
    }),
  }),
  z.looseObject({
    type: z.literal('tick_size_change'),
    payload: z.looseObject({
      assetId: z.string(),
      oldTickSize: decimal.nullish(),
      newTickSize: decimal,
    }),
  }),
  z.looseObject({
    type: z.literal('new_market'),
    payload: z.looseObject({ id: z.string(), market: z.string() }),
  }),
]);

export type PolymarketMarketDTO = z.infer<typeof PolymarketMarketSchema>;
export type PolymarketStreamEventDTO = z.infer<
  typeof PolymarketStreamEventSchema
>;
