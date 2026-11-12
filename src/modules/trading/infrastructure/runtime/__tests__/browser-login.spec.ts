import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveConfigProvider } from '../live-config.provider.js';
import { AesGcmSecretCipher } from '../../../../../shared/infrastructure/trading/secret-cipher.js';
import type { TradingAccount } from '../../../domain/trading-account.js';
import type {
  EmpireCredentials,
  EmpireLoginStage,
  EmpireLoginDiagnostic,
} from '../../../../../shared/application/empire-login.js';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  clearHalt: vi.fn(() => Promise.resolve()),
  closeAllProfiles: vi.fn(() => Promise.resolve()),
}));
vi.mock(
  '../../../../../shared/infrastructure/trading/empire-session.js',
  () => ({
    SESSION_EXPIRED: 'CSGOEMPIRE_SESSION_EXPIRED: Phiên csgoempire hết hạn',
    closeAllProfiles: mocks.closeAllProfiles,
    EmpireSessions: class {
      get = mocks.get;
    },
  }),
);
vi.mock('../../../../../shared/infrastructure/trading/account-lock.js', () => ({
  accountResource: (venue: string, identity: string) => `${venue}:${identity}`,
  AccountLock: class {
    clearHalt = mocks.clearHalt;
    close() {}
  },
}));
function setup() {
  vi.stubEnv('REDIS_URL', 'redis://unit-test');
  vi.stubEnv('TRADING_SECRET_KEY', 'test-master-key-for-browser-login');
  const account: TradingAccount = {
    id: 'e',
    label: 'E',
    enabled: true,
    config: { venue: 'csgoempire', browserProfile: 'empire-test' },
    secretCipher: new AesGcmSecretCipher(
      process.env.TRADING_SECRET_KEY,
    ).encrypt(
      JSON.stringify({
        username: 'user-test',
        password: 'secret-password-test',
      }),
    ),
  };
  return { account, provider: new LiveConfigProvider() };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});
describe('headed browser login jobs', () => {
  it('starts a visible login once, passes decrypted credentials only internally, and returns no secrets', async () => {
    const { account, provider } = setup();
    mocks.get.mockResolvedValue({
      token: 'private-token',
      cookie: 'private-cookie',
      expiresAt: 12345,
    });
    expect(provider.startLogin(account).stage).toBe('opening');
    provider.startLogin(account);
    await vi.waitFor(() =>
      expect(provider.loginStatus('empire-test')?.stage).toBe('ready'),
    );
    expect(mocks.get).toHaveBeenCalledOnce();
    const options = mocks.get.mock.calls[0][1] as {
      headed: boolean;
      credentials: EmpireCredentials;
    };
    expect(options.headed).toBe(true);
    expect(options.credentials).toEqual({
      username: 'user-test',
      password: 'secret-password-test',
    });
    expect(JSON.stringify(provider.loginStatus('empire-test'))).not.toMatch(
      /secret-password|private-token|private-cookie|user-test/,
    );
    expect(mocks.clearHalt).toHaveBeenCalledOnce();
    await provider.onApplicationShutdown();
    expect(mocks.closeAllProfiles).toHaveBeenCalledOnce();
  });
  it('reports verification without clearing an account halt or retrying login', async () => {
    const { account, provider } = setup();
    mocks.get.mockRejectedValue(new Error('CSGOEMPIRE_VERIFICATION_REQUIRED'));
    provider.startLogin(account);
    await vi.waitFor(() =>
      expect(provider.loginStatus('empire-test')?.stage).toBe(
        'verification_required',
      ),
    );
    expect(mocks.clearHalt).not.toHaveBeenCalled();
    expect(mocks.get).toHaveBeenCalledOnce();
    await provider.onApplicationShutdown();
  });
  it('cancels the running browser job', async () => {
    const { account, provider } = setup();
    mocks.get.mockImplementation(
      (
        _name: string,
        options: {
          signal: AbortSignal;
          onStage: (stage: EmpireLoginStage) => void;
        },
      ) =>
        new Promise((_, reject) => {
          options.onStage('signing_in');
          options.signal.addEventListener(
            'abort',
            () => reject(new Error('CSGOEMPIRE_LOGIN_CANCELLED')),
            { once: true },
          );
        }),
    );
    provider.startLogin(account);
    await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledOnce());
    expect((await provider.cancelLogin('empire-test'))?.stage).toBe(
      'cancelled',
    );
    expect(mocks.clearHalt).not.toHaveBeenCalled();
    await provider.onApplicationShutdown();
  });

  it('thay lần đăng nhập đang chạy khi tài khoản đổi mật khẩu', async () => {
    const { account, provider } = setup();
    mocks.get.mockImplementation(
      (
        _name: string,
        options: { signal: AbortSignal; credentials: EmpireCredentials },
      ) =>
        options.credentials.password === 'new-password'
          ? Promise.resolve({
              token: 'new-token',
              expiresAt: Date.now() + 60_000,
            })
          : new Promise((_, reject) => {
              options.signal.addEventListener(
                'abort',
                () => reject(new Error('CSGOEMPIRE_LOGIN_CANCELLED')),
                { once: true },
              );
            }),
    );
    const first = provider.startLogin(account);
    await vi.waitFor(() => expect(mocks.get).toHaveBeenCalledOnce());
    const changed = {
      ...account,
      secretCipher: new AesGcmSecretCipher(
        process.env.TRADING_SECRET_KEY,
      ).encrypt(
        JSON.stringify({ username: 'user-test', password: 'new-password' }),
      ),
    };
    const second = provider.startLogin(changed);
    expect(second.attemptId).not.toBe(first.attemptId);
    await vi.waitFor(() =>
      expect(provider.loginStatus('empire-test')?.stage).toBe('ready'),
    );
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(
      (mocks.get.mock.calls[0][1] as { signal: AbortSignal }).signal.aborted,
    ).toBe(true);
    expect(provider.takeJwtPreview('empire-test', first.attemptId!)).toBeNull();
    await provider.onApplicationShutdown();
  });

  it('only returns the JWT once through its matching login attempt, never through status polling', async () => {
    const { account, provider } = setup();
    const expiresAt = Date.now() + 30 * 60_000;
    mocks.get.mockResolvedValue({
      token: 'one-shot-jwt',
      cookie: 'private-cookie',
      expiresAt,
    });
    const started = provider.startLogin(account);
    await vi.waitFor(() =>
      expect(provider.loginStatus('empire-test')?.stage).toBe('ready'),
    );
    expect(provider.loginStatus('empire-test')?.jwtAvailable).toBe(true);
    expect(JSON.stringify(provider.loginStatus('empire-test'))).not.toMatch(
      /one-shot-jwt|private-cookie/,
    );
    expect(provider.takeJwtPreview('empire-test', 'wrong-attempt')).toBeNull();
    expect(provider.takeJwtPreview('empire-test', started.attemptId!)).toEqual({
      token: 'one-shot-jwt',
      expiresAt,
    });
    expect(
      provider.takeJwtPreview('empire-test', started.attemptId!),
    ).toBeNull();
    expect(provider.loginStatus('empire-test')?.jwtAvailable).toBe(false);
    await provider.onApplicationShutdown();
  });

  it('expires an unclaimed preview after five minutes', async () => {
    const { account, provider } = setup();
    const now = Date.now();
    mocks.get.mockResolvedValue({
      token: 'one-shot-jwt',
      expiresAt: now + 30 * 60_000,
    });
    const started = provider.startLogin(account);
    await vi.waitFor(() =>
      expect(provider.loginStatus('empire-test')?.stage).toBe('ready'),
    );
    vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60_000);
    expect(
      provider.takeJwtPreview('empire-test', started.attemptId!),
    ).toBeNull();
    expect(provider.loginStatus('empire-test')?.jwtAvailable).toBe(false);
    await provider.onApplicationShutdown();
  });

  it('a new manual login invalidates the previous attempt preview', async () => {
    const { account, provider } = setup();
    mocks.get.mockResolvedValue({
      token: 'first-token',
      expiresAt: Date.now() + 30 * 60_000,
    });
    const first = provider.startLogin(account);
    await vi.waitFor(() =>
      expect(provider.loginStatus('empire-test')?.stage).toBe('ready'),
    );
    mocks.get.mockResolvedValue({
      token: 'second-token',
      expiresAt: Date.now() + 30 * 60_000,
    });
    const second = provider.startLogin(account);
    await vi.waitFor(() =>
      expect(provider.loginStatus('empire-test')?.stage).toBe('ready'),
    );
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(provider.takeJwtPreview('empire-test', first.attemptId!)).toBeNull();
    expect(
      provider.takeJwtPreview('empire-test', second.attemptId!)?.token,
    ).toBe('second-token');
    await provider.onApplicationShutdown();
  });

  it('retains safe failure diagnostics without exposing a failed session token', async () => {
    const { account, provider } = setup();
    mocks.get.mockImplementation(
      (
        _profile: string,
        options: {
          onDiagnostic: (diagnostic: EmpireLoginDiagnostic) => void;
        },
      ) => {
        options.onDiagnostic({ step: 'identify', httpStatus: 403 });
        return Promise.reject(new Error('CSGOEMPIRE_SESSION_IDENTIFY_FAILED'));
      },
    );
    const started = provider.startLogin(account);
    await vi.waitFor(() =>
      expect(provider.loginStatus('empire-test')?.stage).toBe('error'),
    );
    expect(provider.loginStatus('empire-test')).toMatchObject({
      error: 'CSGOEMPIRE_SESSION_IDENTIFY_FAILED',
      diagnostic: { step: 'identify', httpStatus: 403 },
      jwtAvailable: false,
    });
    expect(
      provider.takeJwtPreview('empire-test', started.attemptId!),
    ).toBeNull();
    await provider.onApplicationShutdown();
  });
});

describe('mở rương theo tài khoản đã lưu', () => {
  it('chỉ mở khi metadata khớp tài khoản và không cần JWT BetBy', async () => {
    const { account, provider } = setup();
    const readNow = vi.fn().mockResolvedValue({
      username: 'other-user',
      email: null,
    });
    const open = vi.fn().mockResolvedValue(['Rust Case']);
    const withPage = vi.fn(
      (_profile: string, run: (page: object) => Promise<string[]>) => run({}),
    );
    Object.assign(provider, {
      locks: {
        with: vi.fn((_keys: string[], run: () => Promise<string[]>) => run()),
        close: vi.fn(),
      },
      balances: { readNow, withPage, closeAll: vi.fn() },
      caseOpener: { open },
    });
    const enabled: TradingAccount = {
      ...account,
      config: {
        venue: 'csgoempire',
        browserProfile: 'empire-test',
        autoBonusCases: true,
      },
    };
    await expect(provider.openRewardCases(enabled)).rejects.toThrow(
      'CSGOEMPIRE_CASE_ACCOUNT_UNVERIFIED',
    );
    expect(withPage).not.toHaveBeenCalled();
    readNow.mockResolvedValue({ username: 'user-test', email: null });
    await expect(provider.openRewardCases(enabled)).resolves.toEqual([
      'Rust Case',
    ]);
    expect(open).toHaveBeenCalledOnce();
    expect(mocks.get).not.toHaveBeenCalled();
    await provider.onApplicationShutdown();
  });
});
