import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  balanceFields,
  browserSlotUsage,
  closeAllProfiles,
  closeProfile,
  describeCause,
  EmpireSessions,
  launchProfile,
  tokenFingerprint,
} from '../empire-session.js';
import type { AccountLock } from '../account-lock.js';
import type { Response as BrowserResponse } from 'playwright';
import { createHash } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  nativeLaunch: vi.fn(),
  revision: vi.fn(() => Promise.resolve('revision-1')),
  selectUsd: vi.fn(),
}));
vi.mock('playwright', () => ({
  chromium: { launchPersistentContext: mocks.nativeLaunch },
}));
vi.mock('../selenium-browser.js', () => ({
  launchSeleniumContext: mocks.launch,
}));
vi.mock('../empire-currency.js', () => ({
  selectUsdSession: mocks.selectUsd,
}));
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  readFile: mocks.revision,
  writeFile: vi.fn(),
}));

function setup(lifetimeMinutes = 30) {
  let sequence = 0;
  const close = vi.fn(() => Promise.resolve());
  const clearCookies = vi.fn((_filter?: unknown) => Promise.resolve());
  const absent = {
    first: () => absent,
    filter: () => absent,
    isVisible: () => Promise.resolve(false),
  };
  const page = {
    on: vi.fn(),
    off: vi.fn(),
    close: vi.fn(() => Promise.resolve()),
    isClosed: () => false,
    getByRole: (_role: string) => absent,
    getByText: (_text: RegExp) => absent,
    locator: (_selector: string) => absent,
    goto: vi.fn(() => Promise.resolve()),
    waitForResponse: vi.fn(
      (
        _predicate: (response: BrowserResponse) => boolean | Promise<boolean>,
      ) => {
        const iat = Math.floor(Date.now() / 1000);
        const body = Buffer.from(
          JSON.stringify({
            iat,
            exp: iat + lifetimeMinutes * 60,
            currency: 'USD',
          }),
        ).toString('base64url');
        const token = `test.${body}.signature-${++sequence}`;
        return Promise.resolve({
          ok: () => true,
          status: () => 200,
          json: () =>
            Promise.resolve({
              success: true,
              data: { token },
            }),
        });
      },
    ),
  };
  mocks.launch.mockImplementation(() =>
    Promise.resolve({
      pages: () => [page],
      newPage: () => Promise.resolve(page),
      cookies: () => Promise.resolve([{ name: 'unit-session', value: 'test' }]),
      clearCookies,
      close,
      once: vi.fn(),
    }),
  );
  const identify = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    () => Promise.resolve(Response.json({ currency: 'USD' })),
  );
  vi.stubGlobal('fetch', identify);
  const locks = {
    with: vi.fn((_keys: readonly string[], run: () => Promise<unknown>) =>
      run(),
    ),
  };
  return {
    sessions: new EmpireSessions(locks as unknown as AccountLock),
    locks,
    close,
    clearCookies,
    identify,
    page,
  };
}

beforeEach(() => {
  vi.stubEnv('TRADING_BROWSER_ENGINE', 'seleniumbase');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('browser profile lifecycle', () => {
  it('starts SeleniumBase only on demand and closes the same profile once', async () => {
    const s = setup();
    const context = await launchProfile('lifecycle');
    expect(mocks.launch).toHaveBeenCalledWith(
      expect.stringContaining('lifecycle'),
      expect.objectContaining({
        headless: true,
        signal: expect.any(AbortSignal) as unknown,
      }),
    );
    expect(() => launchProfile('lifecycle')).toThrow('BROWSER_PROFILE_IN_USE');
    await Promise.all([context.close(), closeProfile('lifecycle')]);
    expect(s.close).toHaveBeenCalledOnce();
    await closeProfile('lifecycle');
    mocks.revision.mockResolvedValueOnce('{}');
    const reopened = await launchProfile('lifecycle', {
      login: true,
      port: 9222,
    });
    expect(mocks.launch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ headless: false, port: 9222 }),
    );
    await reopened.close();
    expect(s.close).toHaveBeenCalledTimes(2);
  });

  it('cancels startup and releases the profile for another launch', async () => {
    const s = setup();
    let entered: () => void = () => undefined;
    const launching = new Promise<void>((resolve) => {
      entered = resolve;
    });
    mocks.launch.mockImplementationOnce(
      (_path: string, { signal }: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true },
          );
          entered();
        }),
    );
    const starting = launchProfile('startup-cancel');
    const rejected = expect(starting).rejects.toThrow('cancelled');
    await launching;
    await closeProfile('startup-cancel');
    await rejected;
    await (await launchProfile('startup-cancel')).close();
    expect(s.close).toHaveBeenCalledOnce();
  });

  it('closes all active profiles without keeping browsers idle', async () => {
    const s = setup();
    await Promise.all([launchProfile('all-a'), launchProfile('all-b')]);
    await closeAllProfiles();
    await closeAllProfiles();
    expect(s.close).toHaveBeenCalledTimes(2);
  });

  it('keeps native Playwright for HAR capture', async () => {
    setup();
    mocks.nativeLaunch.mockImplementation(
      mocks.launch.getMockImplementation()!,
    );
    const context = await launchProfile('har-profile', { har: 'unit.har' });
    expect(mocks.nativeLaunch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        recordHar: { path: 'unit.har', mode: 'full' },
      }),
    );
    expect(mocks.launch).not.toHaveBeenCalled();
    await context.close();
  });
});

describe('csgoempire session refresh', () => {
  it.each(['EMP', 'EUR', 'GBP'])(
    'switches %s through the site UI and identifies only the replacement USD token',
    async (currency) => {
      const s = setup();
      const normal = s.page.waitForResponse.getMockImplementation()!;
      const usd = await normal(() => true);
      const initialToken = `test.${Buffer.from(
        JSON.stringify({
          exp: 4_000_000_000,
          currency,
        }),
      ).toString('base64url')}.old`;
      s.page.waitForResponse.mockResolvedValueOnce({
        ok: () => true,
        status: () => 200,
        json: () =>
          Promise.resolve({ success: true, data: { token: initialToken } }),
      });
      mocks.selectUsd.mockResolvedValueOnce(usd);
      const diagnostic = vi.fn();
      const session = await s.sessions.get('switch-currency', {
        onDiagnostic: diagnostic,
      });
      expect(mocks.selectUsd).toHaveBeenCalledOnce();
      expect(diagnostic).toHaveBeenCalledWith({ step: 'currency' });
      expect(session.token).toBe((await usd.json()).data.token);
      expect(s.identify.mock.lastCall?.[1].headers).toMatchObject({
        Authorization: `Bearer ${session.token}`,
      });
      expect(s.close).toHaveBeenCalledOnce();
    },
  );

  it('does not reopen the currency picker when the saved profile already returns USD', async () => {
    const s = setup();
    await s.sessions.get('already-usd');
    expect(mocks.selectUsd).not.toHaveBeenCalled();
  });

  it('still rejects a non-USD token after the currency switch', async () => {
    const s = setup();
    const token = `test.${Buffer.from(
      JSON.stringify({
        exp: 4_000_000_000,
        currency: 'EMP',
      }),
    ).toString('base64url')}.old`;
    const response = {
      ok: () => true as const,
      status: () => 200 as const,
      json: () => Promise.resolve({ success: true, data: { token } }),
    };
    s.page.waitForResponse.mockResolvedValueOnce(response);
    mocks.selectUsd.mockResolvedValueOnce(response);
    await expect(s.sessions.get('still-emp')).rejects.toThrow(
      'CSGOEMPIRE_SESSION_INVALID',
    );
    expect(mocks.selectUsd).toHaveBeenCalledOnce();
    expect(s.identify).not.toHaveBeenCalled();
    expect(s.close).toHaveBeenCalledOnce();
  });

  it.each([
    { currency: 'USD', issue: 'expiry_invalid' },
    { currency: 'USD', exp: 'invalid', issue: 'expiry_invalid' },
    { currency: 'USD', exp: 1, issue: 'expiry_too_short' },
    { exp: 4_000_000_000, issue: 'currency_missing' },
    { exp: 4_000_000_000, currency: 'JPY', issue: 'currency_unsupported' },
  ])(
    'explains a rejected JWT as $issue without exposing the token',
    async ({ issue, ...claims }) => {
      const s = setup();
      const token = `test.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.private-signature`;
      s.page.waitForResponse.mockResolvedValueOnce({
        ok: () => true,
        status: () => 200,
        json: () => Promise.resolve({ success: true, data: { token } }),
      });
      const diagnostic = vi.fn();
      await expect(
        s.sessions.get('invalid-claims', { onDiagnostic: diagnostic }),
      ).rejects.toThrow('CSGOEMPIRE_SESSION_INVALID');
      expect(diagnostic).toHaveBeenLastCalledWith({
        step: 'jwt',
        httpStatus: 200,
        sessionIssue: issue,
      });
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(
        'private-signature',
      );
      expect(s.identify).not.toHaveBeenCalled();
      expect(s.close).toHaveBeenCalledOnce();
    },
  );

  it('reports malformed token payloads as session validation errors', async () => {
    const s = setup();
    s.page.waitForResponse.mockResolvedValueOnce({
      ok: () => true,
      status: () => 200,
      json: () =>
        Promise.resolve({ success: true, data: { token: 'not-a-jwt' } }),
    });
    const diagnostic = vi.fn();
    await expect(
      s.sessions.get('malformed-claims', { onDiagnostic: diagnostic }),
    ).rejects.toThrow('CSGOEMPIRE_SESSION_INVALID');
    expect(diagnostic).toHaveBeenLastCalledWith({
      step: 'jwt',
      httpStatus: 200,
      sessionIssue: 'token_malformed',
    });
    expect(s.close).toHaveBeenCalledOnce();
  });

  it('distinguishes identify currency errors from JWT claim errors', async () => {
    const s = setup();
    s.identify.mockResolvedValueOnce(Response.json({ currency: 'EUR' }));
    const diagnostic = vi.fn();
    await expect(
      s.sessions.get('identify-currency', { onDiagnostic: diagnostic }),
    ).rejects.toThrow('CSGOEMPIRE_SESSION_INVALID');
    expect(diagnostic).toHaveBeenLastCalledWith({
      step: 'identify',
      httpStatus: 200,
      sessionIssue: 'identify_currency_unsupported',
    });
    expect(s.close).toHaveBeenCalledOnce();
  });
  it('starts the JWT timeout after slow navigation, then closes the browser and clears timers', async () => {
    const s = setup();
    s.page.goto.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 40_000)),
    );
    s.page.waitForResponse.mockImplementation(
      () => new Promise(() => undefined),
    );
    const diagnostic = vi.fn();
    const session = s.sessions.get('jwt-timeout', { onDiagnostic: diagnostic });
    const rejected = expect(session).rejects.toThrow(
      'CSGOEMPIRE_SESSION_RESPONSE_FAILED',
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(diagnostic).toHaveBeenLastCalledWith({ step: 'page' });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(diagnostic).toHaveBeenLastCalledWith({ step: 'jwt' });
    expect(s.page.waitForResponse).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 0,
    });
    await vi.advanceTimersByTimeAsync(44_999);
    expect(s.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(s.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reuses the in-memory JWT, then refreshes with 10 minutes left and identifies the new token', async () => {
    const s = setup();
    const start = Date.now();
    const first = await s.sessions.get('empire-test');
    vi.setSystemTime(start + 20 * 60_000 - 1);
    expect(await s.sessions.get('empire-test')).toBe(first);
    expect(mocks.launch).toHaveBeenCalledOnce();

    vi.setSystemTime(start + 20 * 60_000);
    const next = await s.sessions.get('empire-test');
    expect(next.token).not.toBe(first.token);
    expect(next.expiresAt).toBe(start + 50 * 60_000);
    expect(s.identify.mock.lastCall?.[0]).toContain('/identify');
    expect(s.identify.mock.lastCall?.[1].headers).toMatchObject({
      Authorization: `Bearer ${next.token}`,
    });
    expect(mocks.launch).toHaveBeenCalledTimes(2);
    expect(s.close).toHaveBeenCalledTimes(2);
    expect(await s.sessions.get('empire-test')).toBe(next);
  });

  it('BetBy từ chối JWT đang giữ (worker báo dấu vân tay): lần get kế tiếp lấy JWT mới; JWT khác / báo dồn trong 1 phút thì bỏ qua', async () => {
    const s = setup();
    const first = await s.sessions.get('empire-test');
    expect(s.sessions.invalidate('empire-test', 'khong-khop')).toBe(false);
    expect(
      s.sessions.invalidate('empire-test', tokenFingerprint(first.token)),
    ).toBe(true);
    // nhiều lệnh cùng bị 401: chỉ ép làm mới một lần
    expect(
      s.sessions.invalidate('empire-test', tokenFingerprint(first.token)),
    ).toBe(false);
    const next = await s.sessions.get('empire-test');
    expect(next.token).not.toBe(first.token);
    expect(mocks.launch).toHaveBeenCalledTimes(2);
    // JWT mới chưa bị từ chối: dùng lại, không mở Chrome nữa
    expect(await s.sessions.get('empire-test')).toBe(next);
    expect(mocks.launch).toHaveBeenCalledTimes(2);
  });

  it('does not open Chromium on every poll for tokens with a lifetime below 10 minutes', async () => {
    const s = setup(5);
    const start = Date.now();
    const first = await s.sessions.get('empire-short');
    vi.setSystemTime(start + 4 * 60_000 - 1);
    expect(await s.sessions.get('empire-short')).toBe(first);
    vi.setSystemTime(start + 4 * 60_000);
    expect((await s.sessions.get('empire-short')).token).not.toBe(first.token);
    expect(mocks.launch).toHaveBeenCalledTimes(2);
  });

  it('reuses the saved browser profile after a backend restart but obtains a fresh JWT', async () => {
    const s = setup();
    const first = await s.sessions.get('empire-test');
    const restarted = new EmpireSessions(s.locks as unknown as AccountLock);
    const next = await restarted.get('empire-test');
    expect(next.token).not.toBe(first.token);
    expect(next).not.toHaveProperty('cookie');
    expect(mocks.launch).toHaveBeenCalledTimes(2);
  });

  it('reports navigation failures instead of claiming that the login expired', async () => {
    const s = setup();
    s.page.goto.mockRejectedValue(new Error('net::ERR_CONNECTION_RESET'));
    const diagnostic = vi.fn();
    await expect(
      s.sessions.get('empire-test', { onDiagnostic: diagnostic }),
    ).rejects.toThrow('CSGOEMPIRE_PAGE_NAVIGATION_FAILED');
    // lý do thật được giữ lại để web / log hiện, không chỉ mã lỗi chung
    expect(diagnostic).toHaveBeenLastCalledWith({
      step: 'page',
      cause: 'net::ERR_CONNECTION_RESET',
    });
    expect(s.close).toHaveBeenCalledOnce();
  });

  it('tự lấy phiên hỏng: thử lại sau 1, 2, 5 phút (không mở Chrome mỗi nhịp); hết lượt thì bỏ cuộc + báo; đăng nhập tay xong thì báo đã ổn', async () => {
    const s = setup();
    s.identify.mockResolvedValue(Response.json({}, { status: 403 }));
    const health = vi.fn();
    const sessions = new EmpireSessions(
      s.locks as unknown as AccountLock,
      undefined,
      undefined,
      undefined,
      health,
    );
    const fail = () =>
      expect(sessions.get('empire-test')).rejects.toThrow(
        'CSGOEMPIRE_SESSION_IDENTIFY_FAILED',
      );
    await fail();
    expect(mocks.launch).toHaveBeenCalledTimes(1);
    await fail(); // chưa tới lượt: không mở Chrome
    expect(mocks.launch).toHaveBeenCalledTimes(1);
    for (const [wait, launches] of [
      [60_000, 2],
      [120_000, 3],
      [300_000, 4],
    ] as const) {
      vi.setSystemTime(Date.now() + wait);
      await fail();
      expect(mocks.launch).toHaveBeenCalledTimes(launches);
    }
    expect(health).toHaveBeenCalledOnce();
    expect(health).toHaveBeenCalledWith(
      'empire-test',
      expect.objectContaining({ type: 'gave_up', attempts: 4 }) as unknown,
    );
    // bỏ cuộc: không tự thử nữa, nói rõ phải bấm Đăng nhập
    vi.setSystemTime(Date.now() + 3_600_000);
    await expect(sessions.get('empire-test')).rejects.toThrow(
      'CSGOEMPIRE_SESSION_GAVE_UP',
    );
    expect(mocks.launch).toHaveBeenCalledTimes(4);
    // người bấm Đăng nhập (force) thành công → báo đã ổn, dùng phiên mới
    s.identify.mockResolvedValue(Response.json({ currency: 'USD' }));
    const session = await sessions.get('empire-test', { force: true });
    expect(health).toHaveBeenLastCalledWith('empire-test', {
      type: 'recovered',
    });
    expect(await sessions.get('empire-test')).toBe(session);
  });

  it('distinguishes an identify rejection from an expired login and exposes only the HTTP status', async () => {
    const s = setup();
    s.identify.mockResolvedValue(Response.json({}, { status: 403 }));
    const diagnostic = vi.fn();
    await expect(
      s.sessions.get('empire-test', { onDiagnostic: diagnostic }),
    ).rejects.toThrow('CSGOEMPIRE_SESSION_IDENTIFY_FAILED');
    expect(diagnostic).toHaveBeenLastCalledWith({
      step: 'identify',
      httpStatus: 403,
    });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(
      /signature|Bearer|unit-session/,
    );
  });

  it('reports a real HTTP 401 as an expired session', async () => {
    const s = setup();
    s.identify.mockResolvedValue(Response.json({}, { status: 401 }));
    await expect(s.sessions.get('empire-test')).rejects.toThrow(
      'CSGOEMPIRE_SESSION_EXPIRED',
    );
  });

  it('does not call an access restriction an expired token', async () => {
    const s = setup();
    s.identify.mockResolvedValue(
      Response.json({ currency: 'USD', geo: { blocked: true } }),
    );
    await expect(s.sessions.get('empire-test')).rejects.toThrow(
      'CSGOEMPIRE_SESSION_ACCESS_BLOCKED',
    );
  });

  it.each(['', '   ', null, undefined])(
    'ignores HTTP 200 guest responses with token %s and waits for a real JWT',
    async (guestToken) => {
      const s = setup();
      const normalResponse = s.page.waitForResponse.getMockImplementation()!;
      s.page.waitForResponse.mockImplementation(async (predicate) => {
        const guest = {
          url: () =>
            'https://csgoempire.com/api/v2/match-betting/betby/user-session/en/USD/EMP',
          ok: () => true,
          json: () =>
            Promise.resolve({ success: true, data: { token: guestToken } }),
        };
        expect(await predicate(guest as unknown as BrowserResponse)).toBe(
          false,
        );
        const response = await normalResponse(predicate);
        const loggedIn = {
          ...response,
          url: guest.url,
        };
        expect(await predicate(loggedIn as unknown as BrowserResponse)).toBe(
          true,
        );
        return loggedIn;
      });
      expect((await s.sessions.get('empire-test')).token).toMatch(/^test\./);
      expect(s.identify).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [
      'đọc được tài khoản',
      {
        status: 200,
        body: { success: true, email: 'unit@example.test' },
        html: false,
        challenge: false,
        userAgent: 'UnitChrome/155',
        detail: null,
      },
    ],
    [
      'sàn trả 403 khi đọc tài khoản — vừa gõ đúng email đã lưu nên vẫn xác nhận được',
      {
        status: 403,
        body: null,
        html: true,
        challenge: false,
        userAgent: 'UnitChrome/155',
        detail: 'HTTP 403, text/html',
      },
    ],
  ])(
    'keeps typing and submitting after a guest response, then verifies the actual authenticated JWT (%s)',
    async (_case, accountRead) => {
      const s = setup();
      const normalResponse = s.page.waitForResponse.getMockImplementation()!;
      type StubResponse = Awaited<ReturnType<typeof normalResponse>>;
      let match: (
        response: BrowserResponse,
      ) => boolean | Promise<boolean> = () => false;
      let received: (response: StubResponse) => void = () => {
        throw new Error('Session response listener was not installed');
      };
      s.page.waitForResponse.mockImplementation((predicate) => {
        match = predicate;
        return new Promise<StubResponse>((resolve) => {
          received = resolve;
        });
      });
      const sessionUrl = () =>
        'https://csgoempire.com/api/v2/match-betting/betby/user-session/en/USD/EMP';
      s.page.goto.mockImplementation(async () => {
        const guest = {
          url: sessionUrl,
          ok: () => true,
          json: () => Promise.resolve({ success: true, data: { token: '' } }),
        };
        expect(await match(guest as unknown as BrowserResponse)).toBe(false);
      });
      const element = (visible: boolean) => {
        let value = '';
        const locator = {
          first: () => locator,
          or: () => locator,
          filter: () => locator,
          isVisible: () => Promise.resolve(visible),
          fill: vi.fn((text: string) => {
            value = text;
            return Promise.resolve();
          }),
          pressSequentially: vi.fn(
            (text: string, _options: { delay: number }) => {
              value += text;
              return Promise.resolve();
            },
          ),
          inputValue: vi.fn((_o?: unknown) => Promise.resolve(value)),
          count: () => Promise.resolve(1),
          click: vi.fn(() => Promise.resolve()),
          isEnabled: vi.fn((_o?: unknown) => Promise.resolve(true)),
        };
        return locator;
      };
      const username = element(true);
      const password = element(true);
      const absent = element(false);
      const submit = element(true);
      submit.click.mockImplementation(async () => {
        const response = await normalResponse(match);
        const authenticated = { ...response, url: sessionUrl };
        expect(await match(authenticated as unknown as BrowserResponse)).toBe(
          true,
        );
        received(authenticated);
      });
      const page = {
        ...s.page,
        url: () => 'https://csgoempire.com/match-betting',
        isClosed: () => false,
        getByText: () => absent,
        getByRole: (role: string) => (role === 'textbox' ? username : absent),
        locator: (selector: string) =>
          selector === '#auth-login-submit:visible'
            ? submit
            : selector.includes('input[type="password"]')
              ? password
              : absent,
        waitForTimeout: () => Promise.resolve(),
        // GET /api/v2/user chạy TRONG Chromium (cùng cookie / User-Agent với trình duyệt)
        evaluate: vi.fn(() => Promise.resolve(accountRead)),
      };
      mocks.launch.mockResolvedValue({
        pages: () => [page],
        newPage: () => Promise.resolve(page),
        cookies: () =>
          Promise.resolve([{ name: 'unit-session', value: 'test' }]),
        close: s.close,
        once: vi.fn(),
      });
      s.identify.mockImplementation((url) =>
        Promise.resolve(
          Response.json(
            url.endsWith('/identify')
              ? { currency: 'USD' }
              : { success: true, email: 'unit@example.test' },
          ),
        ),
      );
      const result = await s.sessions.get('empire-test', {
        credentials: {
          username: 'unit@example.test',
          password: 'unit-password',
        },
      });
      expect(username.pressSequentially).toHaveBeenCalledWith(
        'unit@example.test',
        { delay: 70 },
      );
      expect(password.pressSequentially).toHaveBeenCalledWith('unit-password', {
        delay: 70,
      });
      expect(submit.click).toHaveBeenCalledOnce();
      expect(result.token).toMatch(/^test\./);
      expect(result.userAgent).toBe('UnitChrome/155');
      // Node chỉ gọi identify (BetBy); tài khoản csgoempire đọc trong trình duyệt
      expect(s.identify).toHaveBeenCalledOnce();
      expect(page.evaluate).toHaveBeenCalledOnce();
      expect(s.close).toHaveBeenCalledOnce();
    },
  );
});

describe('nhiều tài khoản / nhiều lời gọi cùng lúc', () => {
  it('hai lời gọi trùng một hồ sơ dùng chung MỘT lần làm mới (một Chrome)', async () => {
    const s = setup();
    const [a, b] = await Promise.all([
      s.sessions.get('same-profile'),
      s.sessions.get('same-profile'),
    ]);
    expect(a).toBe(b);
    expect(mocks.launch).toHaveBeenCalledOnce();
    expect(s.locks.with).toHaveBeenCalledOnce();
  });

  it('hai tài khoản khác nhau: mỗi cái một Chrome, một hồ sơ, một khóa riêng', async () => {
    const s = setup();
    const [a, b] = await Promise.all([
      s.sessions.get('empire-a'),
      s.sessions.get('empire-b'),
    ]);
    expect(a.browserProfile).toBe('empire-a');
    expect(b.browserProfile).toBe('empire-b');
    expect(a.token).not.toBe(b.token);
    const dirs = mocks.launch.mock.calls.map((c) => String(c[0]));
    expect(dirs).toHaveLength(2);
    expect(new Set(dirs).size).toBe(2);
    const keys = s.locks.with.mock.calls.map((c) => c[0][0]);
    expect(new Set(keys).size).toBe(2);
    expect(browserSlotUsage().inUse).toBe(0);
  });

  it('giới hạn số Chrome: hồ sơ thứ hai chờ chỗ, hết hạn chờ thì báo BROWSER_SLOTS_BUSY', async () => {
    const s = setup();
    vi.stubEnv('TRADING_MAX_BROWSERS', '1');
    const first = await launchProfile('cap-a');
    expect(browserSlotUsage()).toMatchObject({ max: 1, inUse: 1 });
    const timedOut = expect(
      launchProfile('cap-b', { slotWaitMs: 1_000 }),
    ).rejects.toThrow('BROWSER_SLOTS_BUSY');
    const waiting = launchProfile('cap-c');
    await vi.advanceTimersByTimeAsync(1_000);
    await timedOut;
    expect(mocks.launch).toHaveBeenCalledOnce();
    await first.close();
    const third = await waiting;
    expect(mocks.launch).toHaveBeenCalledTimes(2);
    await third.close();
    expect(browserSlotUsage()).toMatchObject({ inUse: 0, waiting: 0 });
    expect(s.close).toHaveBeenCalledTimes(2);
  });

  it('làm mới lỗi tạm thời mà token cũ còn hạn: dùng tiếp token cũ, thử lại sau 1 phút', async () => {
    const s = setup();
    const stale = vi.fn();
    const sessions = new EmpireSessions(
      s.locks as unknown as AccountLock,
      stale,
    );
    const start = Date.now();
    const first = await sessions.get('flaky');
    vi.setSystemTime(start + 20 * 60_000);
    s.page.goto.mockRejectedValue(new Error('net::ERR_CONNECTION_RESET'));
    expect(await sessions.get('flaky')).toBe(first);
    expect(stale).toHaveBeenCalledWith(
      'flaky',
      'CSGOEMPIRE_PAGE_NAVIGATION_FAILED',
    );
    // trong 1 phút: không mở Chrome lại
    expect(await sessions.get('flaky')).toBe(first);
    expect(mocks.launch).toHaveBeenCalledTimes(2);
    // sau 1 phút: thử lại, mạng đã ổn → token mới
    s.page.goto.mockResolvedValue(undefined);
    vi.setSystemTime(start + 21 * 60_000);
    const next = await sessions.get('flaky');
    expect(next.token).not.toBe(first.token);
    expect(mocks.launch).toHaveBeenCalledTimes(3);
  });

  it('tài khoản đang bận (khóa) khi làm mới: dùng tiếp token cũ thay vì đứng yên', async () => {
    const s = setup();
    const start = Date.now();
    const first = await s.sessions.get('busy');
    vi.setSystemTime(start + 20 * 60_000);
    s.locks.with.mockRejectedValueOnce(new Error('ACCOUNT_BUSY: bận'));
    expect(await s.sessions.get('busy')).toBe(first);
  });

  it('không dùng token cũ khi lỗi là lâu dài (phiên hết hạn) hoặc token sắp hết', async () => {
    const s = setup();
    const start = Date.now();
    await s.sessions.get('expired');
    await s.sessions.get('ending');
    vi.setSystemTime(start + 20 * 60_000);
    s.identify.mockResolvedValue(Response.json({}, { status: 401 }));
    await expect(s.sessions.get('expired')).rejects.toThrow(
      'CSGOEMPIRE_SESSION_EXPIRED',
    );

    s.identify.mockResolvedValue(Response.json({ currency: 'USD' }));
    // còn dưới 2 phút: không đủ an toàn để vào lệnh bằng token cũ
    vi.setSystemTime(start + 29 * 60_000);
    s.page.goto.mockRejectedValue(new Error('net::ERR_CONNECTION_RESET'));
    await expect(s.sessions.get('ending')).rejects.toThrow(
      'CSGOEMPIRE_PAGE_NAVIGATION_FAILED',
    );
  });

  it('đăng nhập tay (force) chờ lần làm mới nền xong rồi mới mở Chrome của mình', async () => {
    const s = setup();
    let open = 0;
    let maxOpen = 0;
    const impl = mocks.launch.getMockImplementation()!;
    mocks.launch.mockImplementation((...args: unknown[]) => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      return (
        impl as (...a: unknown[]) => Promise<{ close: () => Promise<void> }>
      )(...args).then((ctx) => ({
        ...ctx,
        close: () => {
          open--;
          return ctx.close();
        },
      }));
    });
    const [bg, manual] = await Promise.all([
      s.sessions.get('ordered'),
      s.sessions.get('ordered', { force: true }),
    ]);
    expect(manual.token).not.toBe(bg.token);
    expect(mocks.launch).toHaveBeenCalledTimes(2);
    expect(maxOpen).toBe(1);
  });

  it('hủy lần lấy phiên với mật khẩu cũ trước khi mở Chrome cho mật khẩu mới', async () => {
    const s = setup();
    const launch = mocks.launch.getMockImplementation()!;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    mocks.launch.mockImplementationOnce(
      (_path: string, { signal }: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('cancelled')),
            { once: true },
          );
          entered();
        }),
    );
    mocks.launch.mockImplementation((...args: unknown[]) =>
      (launch as (...a: unknown[]) => Promise<unknown>)(...args),
    );
    const old = s.sessions.get('changed-password', {
      credentialsVersion: 'old',
    });
    const cancelled = expect(old).rejects.toThrow('CSGOEMPIRE_LOGIN_CANCELLED');
    await started;
    const fresh = await s.sessions.get('changed-password', {
      credentialsVersion: 'new',
    });
    await cancelled;
    expect(fresh.token).toMatch(/^test\./);
    expect(mocks.launch).toHaveBeenCalledTimes(2);
    expect(s.sessions.sessionFailures('changed-password')).toBeNull();
  });

  it('đóng các tab được Chrome khôi phục trước khi đọc phiên', async () => {
    const s = setup();
    const launch = mocks.launch.getMockImplementation()!;
    const oldTabs = [
      { close: vi.fn(() => Promise.resolve()) },
      { close: vi.fn(() => Promise.resolve()) },
    ];
    mocks.launch.mockImplementation((...args: unknown[]) =>
      (launch as (...a: unknown[]) => Promise<Record<string, unknown>>)(
        ...args,
      ).then((context) => ({ ...context, pages: () => oldTabs })),
    );
    await s.sessions.get('restored-tabs');
    expect(oldTabs[0].close).toHaveBeenCalledOnce();
    expect(oldTabs[1].close).toHaveBeenCalledOnce();
  });
});

describe('xác nhận tài khoản trong Chromium (đã / chưa đăng nhập)', () => {
  const login = { username: 'me@example.test', password: 'pw-secret' };
  const ok = { status: 200, body: { success: true, email: 'me@example.test' } };
  const notLogged = { status: 200, body: { success: false } };
  const other = {
    status: 200,
    body: { success: true, email: 'x@example.test' },
  };
  /** Hồ sơ có sẵn phiên (trang tự trả JWT) + lần lượt các kết quả GET /api/v2/user trong trang. */
  const profile = (
    s: ReturnType<typeof setup>,
    ...results: Record<string, unknown>[]
  ) => {
    const issue = s.page.waitForResponse.getMockImplementation()!;
    let ready: Promise<unknown> = Promise.resolve();
    s.page.waitForResponse.mockImplementation((predicate) => {
      const p = (async () => {
        const res = Object.assign(await issue(predicate), {
          url: () =>
            'https://csgoempire.com/api/v2/match-betting/betby/user-session/en/USD/USD',
        });
        await predicate(res as unknown as BrowserResponse);
        return res;
      })();
      ready = p;
      return p;
    });
    s.page.goto.mockImplementation(async () => {
      await ready;
    });
    const evaluate = vi.fn();
    for (const r of results)
      evaluate.mockResolvedValueOnce({
        html: false,
        challenge: false,
        userAgent: 'UnitChrome/155',
        detail: null,
        body: null,
        ...r,
      });
    Object.assign(s.page, {
      evaluate,
      url: () => 'https://csgoempire.com/match-betting',
      isClosed: () => false,
      waitForTimeout: vi.fn(() => Promise.resolve()),
    });
    return evaluate;
  };

  it('đã đăng nhập đúng tài khoản: đọc trong Chromium, không xóa phiên', async () => {
    const s = setup();
    profile(s, ok);
    const session = await s.sessions.get('a1', { credentials: login });
    expect(session.userAgent).toBe('UnitChrome/155');
    expect(s.clearCookies).not.toHaveBeenCalled();
    expect(mocks.launch).toHaveBeenCalledOnce();
  });

  it('vừa đăng nhập, cookie chưa kịp có hiệu lực: đọc lại rồi qua, không đăng nhập lại', async () => {
    const s = setup();
    const evaluate = profile(s, notLogged, notLogged, ok);
    await s.sessions.get('a2', { credentials: login });
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(s.clearCookies).not.toHaveBeenCalled();
  });

  it('phiên trong hồ sơ đã cũ: xóa cookie csgoempire, mở lại và đăng nhập từ đầu', async () => {
    const s = setup();
    profile(s, notLogged, notLogged, notLogged, notLogged, ok);
    const session = await s.sessions.get('a3', { credentials: login });
    expect(session.token).toMatch(/^test\./);
    expect(s.clearCookies).toHaveBeenCalledOnce();
    expect(s.clearCookies.mock.calls[0][0]).toMatchObject({
      domain: expect.any(RegExp) as unknown,
    });
    expect(mocks.launch).toHaveBeenCalledTimes(2);
  });

  it('hồ sơ đang đăng nhập tài khoản KHÁC: đăng xuất (xóa cookie) rồi đăng nhập đúng tài khoản', async () => {
    const s = setup();
    profile(s, other, ok);
    await s.sessions.get('a4', { credentials: login });
    expect(s.clearCookies).toHaveBeenCalledOnce();
    expect(mocks.launch).toHaveBeenCalledTimes(2);
  });

  it('đăng nhập lại vẫn sai tài khoản / vẫn bị từ chối: dừng, báo rõ (không lặp vô hạn)', async () => {
    const s = setup();
    profile(s, other, other);
    await expect(s.sessions.get('a5', { credentials: login })).rejects.toThrow(
      'CSGOEMPIRE_LOGIN_ACCOUNT_MISMATCH',
    );
    const t = setup();
    profile(t, { status: 401 }, { status: 401 });
    await expect(t.sessions.get('a6', { credentials: login })).rejects.toThrow(
      'CSGOEMPIRE_SESSION_EXPIRED',
    );
    expect(mocks.launch).toHaveBeenCalledTimes(4);
  });

  it.each([
    [
      {
        status: 403,
        challenge: true,
        html: true,
        detail: 'HTTP 403, text/html',
      },
      'challenge',
    ],
    [{ status: 200, html: true, detail: 'HTTP 200, text/html' }, 'not_json'],
    [{ status: 403, html: true, detail: 'HTTP 403, text/html' }, 'http_error'],
    [
      { status: 0, detail: 'fetch trong trình duyệt lỗi: TypeError' },
      'network',
    ],
  ])(
    'phiên có sẵn mà sàn không cho đọc tài khoản: đăng nhập lại một lần để xác nhận; vẫn không được thì báo rõ (%#)',
    async (result, issue) => {
      const s = setup();
      // cả hai lần đều không đọc được, và trang tự cấp phiên (không hiện form để gõ)
      profile(s, result, result);
      const diagnostic = vi.fn();
      await expect(
        s.sessions.get('acc', { credentials: login, onDiagnostic: diagnostic }),
      ).rejects.toThrow('CSGOEMPIRE_SESSION_ACCOUNT_FAILED');
      expect(s.clearCookies).toHaveBeenCalledOnce();
      const last = diagnostic.mock.lastCall?.[0] as {
        step: string;
        accountIssue?: string;
        cause?: string;
      };
      expect(last).toMatchObject({ step: 'account', accountIssue: issue });
      expect(last.cause).toContain('API trang đã gọi');
    },
  );

  it('sàn trả người dùng nhưng KHÔNG có email/username để so: không tự nhận là đúng — đăng nhập lại để xác nhận', async () => {
    const s = setup();
    const noIdentity = { status: 200, body: { success: true, id: 1 } };
    profile(s, noIdentity, noIdentity);
    const diagnostic = vi.fn();
    await expect(
      s.sessions.get('noid', { credentials: login, onDiagnostic: diagnostic }),
    ).rejects.toThrow('CSGOEMPIRE_SESSION_ACCOUNT_FAILED');
    expect(s.clearCookies).toHaveBeenCalledOnce();
    expect(
      String((diagnostic.mock.lastCall?.[0] as { cause?: string }).cause),
    ).toContain('không trả email');
  });

  it('phiên có sẵn đã được xác nhận ở lần trước: sàn không cho đọc tài khoản vẫn dùng tiếp, không đăng nhập lại', async () => {
    const s = setup();
    const hash = createHash('sha256').update('me@example.test').digest('hex');
    mocks.revision.mockImplementation(((path: string) =>
      Promise.resolve(
        String(path).endsWith('.verified-account')
          ? `${hash}:revision-1`
          : 'revision-1',
      )) as never);
    profile(s, { status: 403, html: true, detail: 'HTTP 403, text/html' });
    const session = await s.sessions.get('verified', { credentials: login });
    expect(session.token).toMatch(/^test\./);
    expect(s.clearCookies).not.toHaveBeenCalled();
    expect(mocks.launch).toHaveBeenCalledOnce();
    mocks.revision.mockImplementation(() => Promise.resolve('revision-1'));
  });
});

describe('describeCause', () => {
  it('lấy lý do thật trong call log của Playwright', () => {
    const e = Object.assign(
      new Error(
        "locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('#auth-login-submit:visible')\n  - element is not enabled\n  - retrying click action",
      ),
      { name: 'TimeoutError' },
    );
    expect(describeCause(e)).toBe(
      'TimeoutError: locator.click: Timeout 10000ms exceeded. — element is not enabled',
    );
  });

  it('chỉ dòng đầu, cắt ngắn, che tài khoản/mật khẩu', () => {
    const e = new Error(
      'locator.fill: typing "pw-secret" for me@example.test\ncall log: ...',
    );
    expect(
      describeCause(e, { username: 'me@example.test', password: 'pw-secret' }),
    ).toBe('locator.fill: typing "***" for ***');
  });
});

describe('thăm dò nguồn số dư', () => {
  it('chỉ lấy VỊ TRÍ + kiểu của trường giống số dư, không lấy giá trị', () => {
    const body = {
      data: { balance: 1234.5, user: { id: 7 } },
      wallets: [{ available_balance: '3.10', currency: 'USD' }],
    };
    expect(balanceFields(body)).toEqual([
      'data.balance:number',
      'wallets.0.available_balance:string',
    ]);
    expect(JSON.stringify(balanceFields(body))).not.toMatch(/1234|3\.10/);
  });

  it('ghi log thăm dò sau khi lấy phiên xong', async () => {
    const s = setup();
    const probe = vi.fn();
    const sessions = new EmpireSessions(
      s.locks as unknown as AccountLock,
      undefined,
      probe,
    );
    // chỉ ghi khi đăng nhập tay (không ghi mỗi lần làm mới nền)
    await sessions.get('probe-bg');
    expect(probe).not.toHaveBeenCalled();
    // đăng nhập có giao diện đọc file Preferences của hồ sơ
    mocks.revision.mockImplementation(((path: string) =>
      Promise.resolve(
        String(path).endsWith('Preferences') ? '{}' : 'revision-1',
      )) as never);
    await sessions.get('probe-profile', { headed: true, force: true });
    mocks.revision.mockImplementation(() => Promise.resolve('revision-1'));
    expect(probe).toHaveBeenCalledWith(
      'probe-profile',
      expect.stringContaining('identify BetBy gồm: currency'),
    );
  });
});

describe('dùng chung hồ sơ với Chrome nền đọc số dư', () => {
  it('làm mới phiên: nhường hồ sơ (đóng Chrome nền) TRƯỚC khi mở Chrome, trả lại SAU khi đóng', async () => {
    const s = setup();
    const order: string[] = [];
    const impl = mocks.launch.getMockImplementation()!;
    mocks.launch.mockImplementation((...args: unknown[]) => {
      order.push('launch');
      return (impl as (...a: unknown[]) => Promise<unknown>)(...args);
    });
    s.close.mockImplementation(() => {
      order.push('close');
      return Promise.resolve();
    });
    const sessions = new EmpireSessions(
      s.locks as unknown as AccountLock,
      undefined,
      undefined,
      {
        acquire: (p) => {
          order.push(`acquire:${p}`);
          return Promise.resolve();
        },
        release: (p) => {
          order.push(`release:${p}`);
        },
      },
    );
    await sessions.get('shared');
    expect(order).toEqual([
      'acquire:shared',
      'launch',
      'close',
      'release:shared',
    ]);
  });

  it('bàn giao context/tab vừa lấy JWT thành công thay vì đóng rồi mở Chrome thứ hai', async () => {
    const s = setup();
    const adopt = vi.fn(() => Promise.resolve(true));
    const release = vi.fn();
    const sessions = new EmpireSessions(
      s.locks as unknown as AccountLock,
      undefined,
      undefined,
      {
        acquire: () => Promise.resolve(),
        adopt,
        release,
      },
    );
    await sessions.get('shared-handoff');
    expect(adopt).toHaveBeenCalledWith(
      'shared-handoff',
      expect.anything(),
      s.page,
      undefined,
      {},
    );
    expect(s.close).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith('shared-handoff');
    await closeProfile('shared-handoff');
    expect(s.close).toHaveBeenCalledOnce();
  });
});
