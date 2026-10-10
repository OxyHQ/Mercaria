import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

// Auth/reports are isolated fixtures; the logo is the actual bundled Website asset.
for (const [width, locale, mode] of [[1440, 'en', 'light'], [390, 'ar', 'light'], [390, 'en', 'dark']] as const) {
  test(`Wholesale brand and official orange palette at ${width}px ${locale} ${mode}`, async ({ page }) => {
    const copy = locale === 'ar' ? ar : en;
    const requests = await fixture(page, locale, mode); // Existing automatic mono preference.
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await expect(page.getByTestId('merchant-sales-chart')).toBeVisible();
    await expect(page).toHaveTitle(/Wholesale by Mercaria/);
    const brand = width < 768 ? page.getByTestId('wholesale-mobile-brand') : page.getByTestId('merchant-sidebar');
    await expect(brand.getByText('Wholesale', { exact: true })).toBeVisible();
    await expect(brand.getByText('by Mercaria', { exact: true })).toBeVisible();
    const logo = brand.getByTestId('wholesale-logo');
    await expect(logo).toBeVisible();
    await expect.poll(() => logo.locator('img').evaluateAll(nodes => nodes.some(node => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth === 512))).toBe(true);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('mercaria.dashboard.bloom.theme')!))).toMatchObject({ mode, colorPreset: 'mono' });
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(mode);
    // Canonical orange primary values from the installed Bloom recipe; controlled
    // color changes rendering without rewriting a persisted preference.
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim())).toBe(mode === 'dark' ? 'rgb(255 123 4)' : 'rgb(170 79 0)');
    const asset = await page.request.get('/wholesale.svg');
    expect(asset.ok()).toBe(true);
    expect(createHash('sha256').update(await asset.body()).digest('hex')).toBe('500cc3459313f37a9d6d807742cce6b7c6f641448090ee61fbb4063a43e1955f');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/wholesale-${width}-${locale}-${mode}.png`, fullPage: true });
    if (width < 768) {
      await page.getByRole('button', { name: copy.nav.openNavigation, exact: true }).click();
      const sidebar = page.getByTestId('merchant-shell-navigation-drawer').getByTestId('merchant-sidebar');
      await expect(sidebar.getByText('Wholesale', { exact: true })).toBeVisible();
      await expect(sidebar.getByRole('button', { name: copy.stores.switch, exact: true })).toBeVisible();
      await page.screenshot({ path: `/tmp/wholesale-drawer-${locale}-${mode}.png` });
      await page.getByRole('button', { name: copy.nav.closeNavigation, exact: true }).click({ position: { x: locale === 'ar' ? 10 : width - 10, y: 100 } });
      await expect(page.getByTestId('merchant-shell-navigation-drawer')).toHaveCount(0);
    }
    await page.getByRole('button', { name: copy.stores.switch, exact: true }).click();
    await page.getByText('Second Atelier', { exact: true }).click();
    await expect.poll(() => requests.some(url => url.pathname === '/admin/stores/second-store/reports/summary')).toBe(true);
    await expect(page.getByRole('button', { name: copy.stores.switch, exact: true })).toContainText('Second Atelier');
  });
}

test('Wholesale sign-in displays the real brand without an authenticated fixture', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Wholesale by Mercaria', { exact: true })).toBeVisible();
  await expect(page).toHaveTitle('Wholesale by Mercaria');
  await expect(page.getByRole('button', { name: en.auth.signInAction, exact: true })).toBeVisible();
  await expect(page.getByTestId('wholesale-logo')).toBeVisible();
  await expect(page.getByTestId('merchant-sales-chart')).toHaveCount(0);
  await page.screenshot({ path: '/tmp/wholesale-sign-in.png', fullPage: true });
});
