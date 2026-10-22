import { Redis } from 'ioredis';
import type {
  RebalanceTransfer,
  RebalanceTransferStore,
} from '../../application/rebalance-executor.js';

const NS = 'rebalance';
const HISTORY_MAX = 500;
const DAILY_TTL_S = 3 * 86_400;
const BLOCK_TTL_S = 30 * 86_400;

/**
 * Lưu bền ở Redis (sống qua restart app): khóa mỗi profile một lượt, tổng đã chuyển trong ngày, lịch sử
 * 500 lượt gần nhất, cờ chặn sau khi kết quả không rõ, mốc hạ nhiệt.
 */
export class RedisRebalanceTransferStore implements RebalanceTransferStore {
  private readonly _redis: Redis;
  constructor(url: string) {
    this._redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    });
  }

  async begin(profileId: string, ttlMs: number) {
    return (
      (await this._redis.set(
        `${NS}:lock:${profileId}`,
        '1',
        'PX',
        ttlMs,
        'NX',
      )) === 'OK'
    );
  }
  async end(profileId: string) {
    await this._redis.del(`${NS}:lock:${profileId}`);
  }
  async addDaily(profileId: string, day: string, usd: number) {
    const key = `${NS}:daily:${profileId}:${day}`;
    const v = await this._redis.incrbyfloat(key, usd);
    await this._redis.expire(key, DAILY_TTL_S);
    return Number(v);
  }
  async daily(profileId: string, day: string) {
    return (
      Number((await this._redis.get(`${NS}:daily:${profileId}:${day}`)) ?? 0) ||
      0
    );
  }
  async save(t: RebalanceTransfer) {
    await this._redis
      .multi()
      .hset(`${NS}:transfers`, t.id, JSON.stringify(t))
      .zadd(`${NS}:order`, t.createdAt, t.id)
      .exec();
    const extra = (await this._redis.zcard(`${NS}:order`)) - HISTORY_MAX;
    if (extra > 0) {
      const old = await this._redis.zrange(`${NS}:order`, 0, extra - 1);
      if (old.length)
        await this._redis
          .multi()
          .zrem(`${NS}:order`, ...old)
          .hdel(`${NS}:transfers`, ...old)
          .exec();
    }
  }
  async list(limit: number) {
    const ids = await this._redis.zrevrange(
      `${NS}:order`,
      0,
      Math.max(0, limit - 1),
    );
    if (!ids.length) return [];
    const rows = await this._redis.hmget(`${NS}:transfers`, ...ids);
    return rows.flatMap((r) => (r ? [JSON.parse(r) as RebalanceTransfer] : []));
  }
  async block(profileId: string, reason: string) {
    await this._redis.set(
      `${NS}:block:${profileId}`,
      reason.slice(0, 500),
      'EX',
      BLOCK_TTL_S,
    );
  }
  async blocked(profileId: string) {
    return this._redis.get(`${NS}:block:${profileId}`);
  }
  async unblock(profileId: string) {
    return (await this._redis.del(`${NS}:block:${profileId}`)) > 0;
  }
  async cooldown(profileId: string, ms: number) {
    await this._redis.set(
      `${NS}:cool:${profileId}`,
      '1',
      'PX',
      Math.max(1, ms),
    );
  }
  async coolingDown(profileId: string) {
    return (await this._redis.exists(`${NS}:cool:${profileId}`)) > 0;
  }
  close() {
    this._redis.disconnect();
  }
}

/** Không có Redis (dev / test): giữ trong bộ nhớ. */
export class InMemoryRebalanceTransferStore implements RebalanceTransferStore {
  private readonly _locks = new Map<string, number>();
  private readonly _daily = new Map<string, number>();
  private readonly _transfers = new Map<string, RebalanceTransfer>();
  private readonly _blocks = new Map<string, string>();
  private readonly _cool = new Map<string, number>();
  constructor(private readonly _now: () => number = Date.now) {}

  begin(profileId: string, ttlMs: number) {
    const until = this._locks.get(profileId) ?? 0;
    if (until > this._now()) return Promise.resolve(false);
    this._locks.set(profileId, this._now() + ttlMs);
    return Promise.resolve(true);
  }
  end(profileId: string) {
    this._locks.delete(profileId);
    return Promise.resolve();
  }
  addDaily(profileId: string, day: string, usd: number) {
    const k = `${profileId}:${day}`;
    const v = (this._daily.get(k) ?? 0) + usd;
    this._daily.set(k, v);
    return Promise.resolve(v);
  }
  daily(profileId: string, day: string) {
    return Promise.resolve(this._daily.get(`${profileId}:${day}`) ?? 0);
  }
  save(t: RebalanceTransfer) {
    this._transfers.set(t.id, t);
    return Promise.resolve();
  }
  list(limit: number) {
    return Promise.resolve(
      [...this._transfers.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit),
    );
  }
  block(profileId: string, reason: string) {
    this._blocks.set(profileId, reason);
    return Promise.resolve();
  }
  blocked(profileId: string) {
    return Promise.resolve(this._blocks.get(profileId) ?? null);
  }
  unblock(profileId: string) {
    return Promise.resolve(this._blocks.delete(profileId));
  }
  cooldown(profileId: string, ms: number) {
    this._cool.set(profileId, this._now() + ms);
    return Promise.resolve();
  }
  coolingDown(profileId: string) {
    return Promise.resolve((this._cool.get(profileId) ?? 0) > this._now());
  }
}
