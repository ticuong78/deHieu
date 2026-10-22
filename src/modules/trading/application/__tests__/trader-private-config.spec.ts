import { DEFAULT_TRADING_SETTINGS } from '../../domain/trading-settings.js';
import { describe, expect, it, vi } from 'vitest';
import { TraderConfigSync } from '../trader-config.sync.js';
import type { TraderRuntimeConfig } from '../trader-config.js';
import {
  DEFAULT_RISK_LIMITS,
  DEFAULT_STRATEGY,
  type TraderProfile,
} from '../../domain/trader-profile.js';
import { DEFAULT_STAKE_PLAN } from '../../domain/stake-plan.js';
import type { TradingAccount } from '../../domain/trading-account.js';

describe('private live worker configuration', () => {
  it('sends private credentials to workers and removes them from web runtime config', async () => {
    const profile: TraderProfile = {
      id: 'p',
      name: 'P',
      mode: 'live',
      enabled: true,
      csgoempireAccountId: 'e',
      polymarketAccountId: 'w',
      stakePlan: DEFAULT_STAKE_PLAN,
      risk: DEFAULT_RISK_LIMITS,
      strategy: DEFAULT_STRATEGY,
    };
    const accounts: TradingAccount[] = [
      {
        id: 'e',
        label: 'E',
        enabled: true,
        config: { venue: 'csgoempire', browserProfile: 'e' },
        secretCipher: null,
      },
      {
        id: 'w',
        label: 'W',
        enabled: true,
        config: {
          venue: 'polymarket',
          walletAddress: 'wallet',
          funderAddress: null,
        },
        secretCipher: 'encrypted-key',
      },
    ];
    const push = vi.fn((_task: string, _config: TraderRuntimeConfig) =>
      Promise.resolve(true),
    );
    const sync = new TraderConfigSync(
      {
        list: () => Promise.resolve(accounts),
        get: () => Promise.resolve(null),
        save: () => Promise.resolve(),
        delete: () => Promise.resolve(false),
      },
      {
        get: () => Promise.resolve(profile),
        list: () => Promise.resolve([profile]),
        save: () => Promise.resolve(),
        delete: () => Promise.resolve(false),
      },
      {
        get: () =>
          Promise.resolve({
            ...DEFAULT_TRADING_SETTINGS,
            matchExposureCapUsd: 100,
          }),
        save: () => Promise.resolve(),
      },
      {
        listTiers: () =>
          Promise.resolve([
            { id: 'std', name: 'Std', minMargin: 0, maxMargin: null },
          ]),
      },
      {
        push,
        command: () => Promise.resolve(true),
        listRunning: () => Promise.resolve([]),
      },
      () => undefined,
      {
        prepare: (config) =>
          Promise.resolve({
            ...config,
            execution: {
              empire: {
                browserProfile: 'e',
                token: 'private-jwt',
                cookie: 'private-cookie',
                apiUrl: 'api',
                brandId: 'brand',
                sessionId: 'session',
                expiresAt: 100,
                minBet: 0.1,
              },
              polymarket: {
                walletAddress: 'wallet',
                funderAddress: null,
                secretCipher: 'encrypted-key',
              },
            },
          }),
      },
    );
    expect((await sync.configFor('p')).execution).toBeUndefined();
    expect(JSON.stringify(await sync.configFor('p'))).not.toMatch(
      /private-jwt|private-cookie|encrypted-key/,
    );
    await sync.answer('worker', 'p');
    expect(push.mock.calls[0][0]).toBe('worker');
    expect(push.mock.calls[0][1].execution?.empire.token).toBe('private-jwt');
  });
});
