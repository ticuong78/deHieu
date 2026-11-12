import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { EmpireCaseOpener } from '../empire-case-opener.js';

describe('EmpireCaseOpener', () => {
  it('chỉ ghi nhận Daily Medium khi nút chuyển sang cooldown', async () => {
    let opened = false;
    const daily = {
      innerText: () =>
        Promise.resolve(
          `Daily Case\nRisk level\nMEDIUM\n${opened ? 'Open in 23:59' : 'Open'}`,
        ),
      getByRole: () => ({
        first: () => ({
          isVisible: () => Promise.resolve(true),
          isEnabled: () => Promise.resolve(true),
          click: () => {
            opened = true;
            return Promise.resolve();
          },
        }),
      }),
    };
    const page = {
      goto: () => Promise.resolve(),
      getByText: (name: string) =>
        name === 'Choose your daily case'
          ? { waitFor: () => Promise.resolve() }
          : { first: () => ({ locator: () => daily }) },
      locator: () => ({ isVisible: () => Promise.resolve(false) }),
      waitForTimeout: () => Promise.resolve(),
    } as unknown as Page;
    expect(
      await new EmpireCaseOpener().open(page, { daily: true, bonus: false }),
    ).toEqual(['Daily Case (Medium)']);
  });

  it('mở mọi rương đang sẵn sàng, ưu tiên tier cao ở mỗi lượt và xác nhận key giảm', async () => {
    const keys = new Map([
      ['Bronze Case', 2],
      ['Rust Case', 3],
    ]);
    const ready = new Map([
      ['Bronze Case', true],
      ['Rust Case', true],
    ]);
    const confirmed: string[] = [];
    let modal: string | null = null;
    const card = (name: string) => ({
      innerText: () =>
        Promise.resolve(
          name === 'Daily Case'
            ? 'Daily Case\nRisk level\nMEDIUM\nOpen in 23:00'
            : `${name}\n${keys.get(name) ?? 0}\n${ready.get(name) ? 'Open Case' : 'Open in 01:00'}`,
        ),
      getByRole: () => ({
        first: () => ({
          isVisible: () => Promise.resolve(true),
          isEnabled: () => Promise.resolve(ready.get(name) === true),
          click: () => {
            modal = name;
            return Promise.resolve();
          },
        }),
      }),
    });
    const page = {
      goto: vi.fn(() => Promise.resolve()),
      getByText: (name: string) =>
        name === 'Choose your daily case'
          ? { waitFor: () => Promise.resolve() }
          : {
              first: () => ({
                isVisible: () =>
                  Promise.resolve(name === 'Daily Case' || keys.has(name)),
                locator: () => card(name),
              }),
            },
      getByRole: (_role: string, options: { name: string }) => ({
        waitFor: () => {
          if (modal !== options.name) throw new Error('wrong case opened');
          return Promise.resolve();
        },
      }),
      locator: () => ({
        waitFor: () => Promise.resolve(),
        isEnabled: () => Promise.resolve(true),
        click: () => {
          if (!modal) throw new Error('missing detail');
          confirmed.push(modal);
          keys.set(modal, (keys.get(modal) ?? 0) - 1);
          ready.set(
            modal,
            modal === 'Bronze Case' && (keys.get(modal) ?? 0) > 0,
          );
          modal = null;
          return Promise.resolve();
        },
      }),
      waitForTimeout: () => Promise.resolve(),
    } as unknown as Page;
    const opener = new EmpireCaseOpener();

    expect(await opener.open(page, { daily: false, bonus: true })).toEqual([
      'Bronze Case',
      'Rust Case',
      'Bronze Case',
    ]);
    expect(confirmed).toEqual(['Bronze Case', 'Rust Case', 'Bronze Case']);
    expect(keys.get('Rust Case')).toBe(2);

    // Không còn nút Open khả dụng, dù Rust vẫn còn key.
    expect(await opener.open(page, { daily: false, bonus: true })).toEqual([]);
    expect(confirmed).toEqual(['Bronze Case', 'Rust Case', 'Bronze Case']);

    ready.set('Rust Case', true);
    expect(await opener.open(page, { daily: false, bonus: true })).toEqual([
      'Rust Case',
    ]);
    expect(confirmed).toEqual([
      'Bronze Case',
      'Rust Case',
      'Bronze Case',
      'Rust Case',
    ]);
  });
});
