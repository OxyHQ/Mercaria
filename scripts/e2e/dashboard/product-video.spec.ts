import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

// State and negative-transport coverage: IDs are metadata fixtures, not uploaded
// clips. Successful video/image transport is never simulated.
for (const [width, locale] of [[1440, 'en'], [390, 'ar']] as const) {
  test(`mixed gallery retains video drafts and fails honestly ${width} ${locale}`, async ({ page }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, 'light'); await page.setViewportSize({ width, height: 1100 });
    await page.route(/https:\/\/[^/]+\/(photo-fixture|video-fixture)(?:[/?].*)?$/, route => route.fulfill({ status: 404, body: 'Missing isolated media' }));
    const product = { id: 'mixed-product', title: 'Mixed gallery', description: '', status: 'draft', images: [{ fileId: 'photo-fixture', position: 0 }], media: [{ kind: 'image', fileId: 'photo-fixture', position: 0 }, { kind: 'video', fileId: 'video-fixture', position: 1 }], variants: [], options: [], overriddenFields: [], quantity: 0, price: { amount: 1000, currency: 'EUR' } };
    const patches: unknown[] = []; let fail = true;
    await page.route('**/admin/stores/*/products/mixed-product', route => {
      if (route.request().method() === 'PATCH') {
        const patch = route.request().postDataJSON(); patches.push(patch);
        if (fail) return route.fulfill({ status: 503, json: { success: false } });
        product.media = patch.mediaFileIds.map((id: string, position: number) => ({ ...product.media.find(item => item.fileId === id)!, position }));
        product.images = product.media.filter(item => item.kind === 'image');
      }
      return route.fulfill({ json: { success: true, data: product } });
    });
    await page.goto('/products/mixed-product');
    const editor = page.getByTestId('merchant-product-photo-editor');
    await expect(editor.getByTestId('merchant-product-media-tile')).toHaveCount(2);
    await editor.getByRole('button', { name: copy.products.media.viewVideo.replace('%{position}', '2'), exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('alert')).toHaveText(copy.products.media.unavailable);
    await expect(dialog.getByRole('button', { name: copy.common.retry, exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
    await expect(page.locator('video')).toHaveCount(0);
    await editor.getByRole('button', { name: copy.products.variants.media.earlier, exact: true }).nth(1).click();
    const save = page.getByRole('button', { name: copy.products.detail.saveChanges, exact: true });
    await save.click(); await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ mediaFileIds: ['video-fixture', 'photo-fixture'] });
    await expect(editor.getByTestId('merchant-product-media-tile')).toHaveCount(2);
    fail = false; await save.click(); await expect(save).toBeDisabled();
    await editor.getByRole('button', { name: copy.products.media.remove.replace('%{position}', '1'), exact: true }).click();
    await save.click(); await expect.poll(() => patches.length).toBe(3);
    expect(patches[2]).toEqual({ mediaFileIds: ['photo-fixture'] });
    await expect(editor.getByTestId('merchant-product-media-tile')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/mercaria-mixed-media-${width}-${locale}.png`, fullPage: true });
  });
}
