import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

// Isolated transport fixtures: no actual catalog mutation or image download.
for (const [width, locale, mode] of [[1440, 'en', 'light'], [390, 'ar', 'dark']] as const) {
  test(`archive preserves drafts and serializes writes at ${width}px ${locale}`, async ({ page }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode); await page.setViewportSize({ width, height: 1100 });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    let writable = true;
    await page.route('**/admin/stores', route => route.fulfill({ json: { success: true, data: [{ id: 'store-preview', name: 'Demo Atelier', defaultCurrency: 'EUR', access: { permissions: ['products:read', ...(writable ? ['products:write'] : [])] } }] } }));
    const variant = { id: 'archive-variant', title: 'Natural / Medium', available: 5, inStock: true, price: { amount: 4900, currency: 'EUR' }, optionValues: [] };
    const product = { id: 'archive-product', title: 'Linen studio shirt', description: 'A linen shirt.', category: 'clothing', status: 'active', tags: [], images: [], variants: [variant], options: [], quantity: 5, overriddenFields: [], price: variant.price };
    let deletes = 0; let patches = 0; let fail = true;
    let releaseDelete: (() => void) | undefined; let releaseVariant: (() => void) | undefined;
    await page.route('**/admin/stores/*/products/archive-product', async route => {
      if (route.request().method() === 'DELETE') {
        deletes++;
        if (fail) return route.fulfill({ status: 503, json: { success: false, message: 'Fixture unavailable' } });
        await new Promise<void>(resolve => { releaseDelete = resolve; });
        product.status = 'archived';
        return route.fulfill({ json: { success: true, data: { id: product.id, status: product.status } } });
      }
      if (route.request().method() === 'PATCH') patches++;
      return route.fulfill({ json: { success: true, data: product } });
    });
    await page.route('**/products/archive-product/variants/archive-variant', async route => {
      patches++;
      expect(route.request().postDataJSON()).toEqual({ price: { amount: 5900, currency: 'EUR' } });
      await new Promise<void>(resolve => { releaseVariant = resolve; });
      variant.price.amount = 5900;
      return route.fulfill({ json: { success: true, data: product } });
    });
    await page.goto('/products/archive-product');
    const title = page.getByRole('textbox', { name: copy.common.title, exact: true });
    await title.fill('Unsaved product draft');
    const price = page.getByTestId('merchant-variant-price');
    await price.getByRole('textbox').fill('59.00');
    await price.getByRole('button', { name: copy.common.save, exact: true }).click();
    const trigger = page.getByRole('button', { name: copy.products.detail.archive, exact: true });
    await expect.poll(() => Boolean(releaseVariant)).toBe(true);
    await expect(trigger).toBeDisabled(); expect(deletes).toBe(0);
    releaseVariant!(); await expect(trigger).toBeEnabled();
    await price.getByRole('textbox').fill('69.00');
    await trigger.click();
    const dialog = page.getByTestId('merchant-archive-product');
    const cancel = dialog.getByRole('button', { name: copy.common.cancel, exact: true });
    const confirm = dialog.getByRole('button', { name: copy.products.detail.archive, exact: true });
    await expect(dialog).toContainText(product.title);
    await expect(dialog.getByText(copy.products.detail.archiveUnsaved, { exact: true })).toBeVisible();
    expect(deletes).toBe(0);
    await cancel.click(); await expect(dialog).toHaveCount(0);
    await expect(title).toHaveValue('Unsaved product draft'); await expect(price.getByRole('textbox')).toHaveValue('69.00');
    await trigger.click(); await expect(dialog).toBeVisible(); await cancel.focus(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); expect(deletes).toBe(0);
    await trigger.click(); await confirm.click();
    await expect(dialog.getByText(copy.products.detail.archiveFailed, { exact: true })).toBeVisible();
    expect(deletes).toBe(1); expect(patches).toBe(1);
    await cancel.click(); await expect(dialog).toHaveCount(0); await expect(title).toHaveValue('Unsaved product draft'); await expect(price.getByRole('textbox')).toHaveValue('69.00');
    await trigger.click(); fail = false; await confirm.click();
    await expect.poll(() => Boolean(releaseDelete)).toBe(true);
    await expect(confirm).toBeDisabled(); await expect(cancel).toBeDisabled();
    await expect(title).toHaveCount(0); // Modal removes editor from accessibility tree.
    await expect(price.getByRole('button')).toHaveCount(0);
    await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
    await page.keyboard.press('Tab');
    const retainedFocus = await page.getByRole('dialog').evaluate(el => el.contains(document.activeElement));
    expect(patches).toBe(1); expect(deletes).toBe(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/wholesale-archive-${width}-${locale}.png`, fullPage: true });
    releaseDelete!(); await expect(page).toHaveURL(/\/products$/);
    writable = false; await page.goto('/products/archive-product');
    await expect(title).toHaveValue(product.title); await expect(trigger).toHaveCount(0);
    expect(deletes).toBe(2); expect(errors).toEqual([]);
    expect(retainedFocus).toBe(true); // Upstream Bloom regression: pending-only dialogs retain focus.
  });
}
