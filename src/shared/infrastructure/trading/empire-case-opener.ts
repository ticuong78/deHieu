import type { Page } from 'playwright';

export const BONUS_CASES = [
  'Rust Case',
  'Bronze Case',
  'Silver Case',
  'Gold Case',
  'Diamond Case',
  'Uranium Case',
  'Unbreakable Case',
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
      if (await this.clickAvailableOpen(daily)) opened.push('Daily Case (Medium)');
    }
    if (options.bonus) {
      for (const name of BONUS_CASES) {
        const label = page.getByText(name, { exact: true }).first();
        if (!(await label.isVisible().catch(() => false))) continue;
        const card = label.locator('xpath=ancestor::*[.//button][1]');
        const text = await card.innerText();
        const keys = Number(text.match(/\bCase\s+(\d+)\b/)?.[1] ?? 0);
        if (keys < 1) continue;
        if (await this.clickAvailableOpen(card)) opened.push(name);
      }
    }
    return opened;
  }

  private async clickAvailableOpen(card: ReturnType<Page['locator']>) {
    const button = card.getByRole('button', { name: /^Open(?: Case)?$/i }).first();
    if (!(await button.isVisible().catch(() => false))) return false;
    if (!(await button.isEnabled())) return false;
    await button.click({ timeout: 10_000 });
    // Cho trang cập nhật cooldown trước khi kiểm tra rương kế tiếp.
    await card.page().waitForTimeout(1_000);
    return true;
  }
}
