import type { Page } from 'playwright';

export const BONUS_CASES = [
  'Unbreakable Case',
  'Uranium Case',
  'Diamond Case',
  'Gold Case',
  'Silver Case',
  'Bronze Case',
  'Rust Case',
] as const;

/**
 * Rewards không có endpoint mở rương trong API công khai. Dùng nút Open của trang
 * trên hồ sơ đã đăng nhập; nếu trang đổi bố cục hoặc chưa xác nhận Medium thì bỏ qua.
 * Không bấm Cash Out, mua key hay mở case trả phí.
 */
export class EmpireCaseOpener {
  async open(
    page: Page,
    options: { daily: boolean; bonus: boolean },
  ): Promise<string[]> {
    await page.goto('https://csgoempire.com/rewards', {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await page.getByText('Choose your daily case', { exact: true }).waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    const opened: string[] = [];
    if (options.daily) {
      const daily = page
        .getByText('Daily Case', { exact: true })
        .first()
        .locator('xpath=ancestor::*[.//button][1]');
      let text = await daily.innerText();
      if (/Risk level\s*Low\b/i.test(text))
        await page.locator('#wheel-slider-scroll-right').click();
      else if (/Risk level\s*High\b/i.test(text))
        await page.locator('#wheel-slider-scroll-left').click();
      text = await daily.innerText();
      if (!/Risk level\s*Medium\b/i.test(text))
        throw new Error('CSGOEMPIRE_DAILY_RISK_NOT_MEDIUM');
      if (await this.openDaily(page, daily)) opened.push('Daily Case (Medium)');
    }
    if (options.bonus) {
      for (const name of BONUS_CASES) {
        const label = page.getByText(name, { exact: true }).first();
        if (!(await label.isVisible().catch(() => false))) continue;
        const card = label.locator('xpath=ancestor::*[.//button][1]');
        const text = await card.innerText();
        const keys = Number(text.match(/\bCase\s+(\d+)\b/)?.[1] ?? 0);
        if (keys < 1) continue;
        // Giữ ưu tiên tier cao: còn key ở tier này thì chờ cooldown,
        // không chuyển xuống tier thấp trong cùng lượt.
        if (await this.openBonus(page, card, name, keys)) opened.push(name);
        break;
      }
    }
    return opened;
  }

  private async availableButton(card: ReturnType<Page['locator']>) {
    const button = card
      .getByRole('button', { name: /^Open(?: Case)?$/i })
      .first();
    if (!(await button.isVisible().catch(() => false))) return null;
    return (await button.isEnabled()) ? button : null;
  }

  private async openBonus(
    page: Page,
    card: ReturnType<Page['locator']>,
    name: string,
    keys: number,
  ): Promise<boolean> {
    const button = await this.availableButton(card);
    if (!button) return false;
    // Nút trên thẻ chỉ mở cửa sổ chi tiết; key chưa được dùng ở bước này.
    await button.click({ timeout: 10_000 });
    await page.getByRole('heading', { name, exact: true, level: 2 }).waitFor({
      state: 'visible',
      timeout: 10_000,
    });
    const confirm = page.locator('#rewards-open-case');
    await confirm.waitFor({ state: 'visible', timeout: 10_000 });
    if (!(await confirm.isEnabled()))
      throw new Error(`CSGOEMPIRE_CASE_NOT_READY: ${name}`);
    await confirm.click({ timeout: 10_000 });
    for (let attempt = 0; attempt < 20; attempt++) {
      const remaining = Number(
        (await card.innerText()).match(/\bCase\s+(\d+)\b/)?.[1] ?? keys,
      );
      if (remaining < keys) return true;
      await page.waitForTimeout(1_000);
    }
    throw new Error(`CSGOEMPIRE_CASE_OPEN_NOT_CONFIRMED: ${name}`);
  }

  private async openDaily(
    page: Page,
    card: ReturnType<Page['locator']>,
  ): Promise<boolean> {
    const button = await this.availableButton(card);
    if (!button) return false;
    await button.click({ timeout: 10_000 });
    // Daily có thể mở trực tiếp hoặc mở trang chi tiết trước khi xác nhận.
    await page.waitForTimeout(500);
    const confirm = page.locator('#rewards-open-case');
    if (await confirm.isVisible().catch(() => false)) {
      await page
        .getByRole('heading', { name: 'Daily Case', exact: true, level: 2 })
        .waitFor({
          state: 'visible',
          timeout: 10_000,
        });
      if (!(await confirm.isEnabled()))
        throw new Error('CSGOEMPIRE_DAILY_NOT_READY');
      await confirm.click({ timeout: 10_000 });
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      if (/Open in\s*\d/i.test(await card.innerText())) return true;
      await page.waitForTimeout(1_000);
    }
    throw new Error('CSGOEMPIRE_DAILY_OPEN_NOT_CONFIRMED');
  }
}
