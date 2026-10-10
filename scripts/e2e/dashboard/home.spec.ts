import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import { fixture } from './fixture';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';

for (const [width, locale, mode] of [[1440, 'en', 'light'], [390, 'en', 'light'], [390, 'ar', 'light'], [390, 'en', 'dark']] as const) {
  test(`merchant home and navigation at ${width}px in ${locale} ${mode}`, async ({ page }) => {
    const copy = locale === 'ar' ? ar : en;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const requests = await fixture(page, locale, mode);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    const chart = page.getByTestId('merchant-sales-chart');
    await expect(chart).toBeVisible();
    await expect(page.getByText(copy.home.allTime, { exact: true })).toBeVisible();
    await expect(chart.getByTestId('merchant-sales-day')).toHaveCount(30);
    await expect(chart.getByTestId('merchant-sales-day').first().locator('div').last()).not.toHaveCSS('height', '0px');
    const originalChart = await chart.elementHandle();
    const before = await chart.boundingBox();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/reports/sales?**', async route => { await pending; await route.fallback(); });
    await page.getByRole('button', { name: copy.home.lastDays.replace('%{days}', '7'), exact: true }).click();
    await expect(chart.getByText(copy.common.loading, { exact: true })).toBeVisible();
    expect(await originalChart!.evaluate(node => node.isConnected)).toBe(true);
    expect((await chart.boundingBox())!.height).toBe(before!.height);
    release();
    await expect(chart.getByTestId('merchant-sales-day')).toHaveCount(7);
    await chart.getByTestId('merchant-sales-day').first().click();
    await expect(chart.getByTestId('merchant-sales-day').first()).toHaveAttribute('aria-pressed', 'true');
    const sales = requests.filter(url => url.pathname.endsWith('/reports/sales')).at(-1)!;
    const top = requests.filter(url => url.pathname.endsWith('/reports/top-products')).at(-1)!;
    expect(sales.searchParams.get('from')).toEqual(top.searchParams.get('from'));
    expect(sales.searchParams.get('to')).toEqual(top.searchParams.get('to'));
    if (width < 768) await page.getByRole('button', { name: copy.nav.openNavigation, exact: true }).click();
    await page.getByRole('button', { name: copy.nav.searchNavigation, exact: true }).click();
    const search = page.getByRole('textbox', { name: copy.nav.searchNavigation });
    await search.fill(copy.nav.orders);
    await expect(page.getByText(copy.nav.orders, { exact: true }).first()).toBeVisible();
    await search.fill('not-a-page');
    await expect(page.getByText(copy.nav.noResults, { exact: true })).toBeVisible();
    await search.press('Escape');
    await expect(search).not.toBeVisible();
    if (width < 768) {
      const drawer = page.getByTestId('merchant-shell-navigation-drawer');
      await expect(drawer).toBeVisible();
      expect(await drawer.getByTestId('merchant-sidebar').evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
      await page.screenshot({ path: `/tmp/mercaria-merchant-drawer-${locale}-${mode}.png` });
      await page.getByRole('button', { name: copy.nav.closeNavigation, exact: true }).click({ position: { x: locale === 'ar' ? 10 : width - 10, y: 100 } });
      await expect(drawer).toHaveCount(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (width < 768) {
      const status = await page.getByText(copy.home.statusBreakdown.title, { exact: true }).locator('..').boundingBox();
      const products = await page.getByText(copy.home.topProducts.title, { exact: true }).locator('..').boundingBox();
      expect(products!.y).toBeGreaterThanOrEqual(status!.y + status!.height);
    }
    await page.screenshot({ path: `/tmp/mercaria-merchant-${width}-${locale}${mode === 'dark' ? '-dark' : ''}.png`, fullPage: true });
    await page.getByRole('button', { name: copy.stores.switch, exact: true }).click();
    await page.getByText('Second Atelier', { exact: true }).click();
    await expect(chart).toBeVisible();
    await expect.poll(() => requests.some(url => url.pathname === '/admin/stores/second-store/reports/summary')).toBe(true);
    await expect(page.getByRole('button', { name: copy.stores.switch, exact: true })).toContainText('Second Atelier');
    await page.getByText('Linen studio shirt', { exact: true }).click();
    await expect(page).toHaveURL(/\/products\/best-product$/);
    expect(errors).toEqual([]);
  });
}
