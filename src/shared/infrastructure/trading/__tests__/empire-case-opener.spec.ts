import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { EmpireCaseOpener } from '../empire-case-opener.js';

describe('EmpireCaseOpener', () => {
  it('chỉ bấm Daily Medium và Bonus có key, đang mở được', async () => {
    const clicks: string[] = [];
    const makeCard = (name: string, text: string, ready: boolean) => ({
      innerText: () => Promise.resolve(text),
      getByRole: () => ({
        first: () => ({
          isVisible: () => Promise.resolve(true),
          isEnabled: () => Promise.resolve(ready),
          click: () => {
            clicks.push(name);
            return Promise.resolve();
          },
        }),
      }),
      page: () => ({ waitForTimeout: () => Promise.resolve() }),
    });
    const cards = new Map([
      ['Daily Case', makeCard('Daily Case', 'Daily Case\nRisk level\nMEDIUM\nOpen', true)],
      ['Rust Case', makeCard('Rust Case', 'Rust Case\n2\nOpen Case', true)],
      ['Bronze Case', makeCard('Bronze Case', 'Bronze Case\n0\nOpen Case', true)],
      ['Silver Case', makeCard('Silver Case', 'Silver Case\n1\nOpen in 2:00', false)],
    ]);
    const page = {
      goto: vi.fn(() => Promise.resolve()),
      getByText: (name: string) => name === 'Choose your daily case'
        ? { waitFor: () => Promise.resolve() }
        : {
            first: () => ({
              isVisible: () => Promise.resolve(cards.has(name)),
              locator: () => cards.get(name),
            }),
          },
      locator: () => ({ click: () => Promise.resolve() }),
    } as unknown as Page;
    const opened = await new EmpireCaseOpener().open(page, { daily: true, bonus: true });
    expect(opened).toEqual(['Daily Case (Medium)', 'Rust Case']);
    expect(clicks).toEqual(['Daily Case', 'Rust Case']);
  });

});
