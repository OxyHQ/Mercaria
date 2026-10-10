import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import uiEn from '../../../packages/ui/src/i18n/locales/en.json';
import uiAr from '../../../packages/ui/src/i18n/locales/ar.json';
import { fixture } from './fixture';

for (const [width, locale, mode] of [[1440, 'en', 'light'], [390, 'en', 'light'], [390, 'ar', 'light'], [390, 'en', 'dark']] as const) {
  test(`merchant media rejects external sources and preserves missing-file placeholders at ${width}px ${locale} ${mode}`, async ({ page }) => {
    const copy = locale === 'ar' ? ar : en;
    const uiCopy = locale === 'ar' ? uiAr.ui : uiEn.ui;
    await fixture(page, locale, mode);
    await page.setViewportSize({ width, height: 1000 });
    const external: string[] = [];
    const mediaRequests: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().includes('untrusted.example.test')) external.push(request.url()); });
    await page.route(/https:\/\/[^/]+\/media-(first|second)(?:\?.*)?$/, route => {
      const url = new URL(route.request().url());
      mediaRequests.push(url.href);
      // Deliberately unavailable IDs: this tests failure handling, never successful Oxy import.
      return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Missing test file' });
    });
    const product = { id: 'media-product', title: 'Linen studio shirt', description: 'A lightweight linen shirt.', status: 'draft',
      images: [{ fileId: 'media-first', alt: 'Front photograph', position: 0 }, { fileId: 'media-second', alt: 'Back photograph', position: 1 },
        { fileId: 'https://untrusted.example.test/forbidden.png', alt: 'Legacy URL', position: 2 }, { fileId: 'data:image/png;base64,invalid', position: 3 }],
      variants: [], options: [], quantity: 8, overriddenFields: [], price: { amount: 4900, currency: 'EUR' } };
    const patches: Record<string, unknown>[] = [];
    await page.route('**/admin/stores/*/products/media-product', route => {
      if (route.request().method() === 'PATCH') {
        const patch = route.request().postDataJSON(); patches.push(patch); Object.assign(product, patch);
      }
      return route.fulfill({ json: { success: true, data: product } });
    });
    await page.goto('/products/media-product');
    const gallery = page.getByTestId('merchant-product-media');
    const tiles = gallery.getByTestId('merchant-product-media-tile');
    await expect(tiles).toHaveCount(4);
    await expect(tiles.nth(2)).toBeDisabled();
    await expect(tiles.nth(3)).toBeDisabled();
    await expect.poll(() => mediaRequests.some(url => new URL(url).pathname.endsWith('media-first') && !new URL(url).search)).toBe(true);
    await expect.poll(() => mediaRequests.some(url => new URL(url).pathname.endsWith('media-second') && !new URL(url).search)).toBe(true);
    await expect(gallery.getByRole('img', { name: uiCopy.marketplace.noImage, exact: true })).toHaveCount(4);
    await expect(gallery.locator('img')).toHaveCount(0);
    const bounds = await tiles.nth(0).boundingBox();
    expect(bounds!.width).toBe(width < 768 ? 112 : 144);
    expect(bounds!.height).toBe(bounds!.width);
    await tiles.nth(1).focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: /Close|إغلاق/, exact: true }).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /Close|إغلاق/, exact: true })).toHaveCount(0);
    const detail = page.getByTestId('merchant-product-detail');
    await detail.getByRole('textbox', { name: copy.common.title, exact: true }).fill('Edited linen shirt');
    await detail.getByRole('button', { name: copy.products.detail.saveChanges, exact: true }).click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).not.toHaveProperty('images');
    expect(patches[0]).not.toHaveProperty('imageFileIds');
    await expect(tiles).toHaveCount(4);
    await expect(gallery.getByRole('img', { name: uiCopy.marketplace.noImage, exact: true })).toHaveCount(4);
    await expect(gallery.locator('img')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/mercaria-product-media-${width}-${locale}-${mode}.png`, fullPage: true });
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
  });
}
