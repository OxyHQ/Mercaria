import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

for (const [width, locale, mode] of [[1440, 'en', 'light'], [390, 'en', 'light'], [390, 'ar', 'light'], [390, 'en', 'dark']] as const) {
  test(`variant price follows the server without losing edits at ${width}px ${locale} ${mode}`, async ({ page }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode);
    await page.setViewportSize({ width, height: 1100 });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    let writable = true;
    await page.route('**/admin/stores', route => route.fulfill({ json: { success: true, data: [{ id: 'store-preview', name: 'Demo Atelier', handle: 'demo-atelier', defaultCurrency: 'EUR',
      access: { permissions: ['products:read', ...(writable ? ['products:write'] : [])] } }] } }));
    const variant = { id: 'price-variant', title: 'Natural / Medium', available: 5, inStock: true, price: { amount: 4900, currency: 'EUR' }, optionValues: [] };
    const product = { id: 'price-product', title: 'Linen studio shirt', description: 'A linen shirt.', category: 'clothing', status: 'draft', tags: [], images: [],
      variants: [variant], options: [], quantity: 5, overriddenFields: [], price: variant.price };
    let readError = false;
    await page.route('**/admin/stores/*/products/price-product', route => route.request().method() === 'GET' && readError
      ? route.fulfill({ status: 502, json: { success: false, message: 'Fixture read failure' } })
      : route.fulfill({ json: { success: true, data: product } }));
    let fail = true;
    let release: (() => void) | undefined;
    const writes: unknown[] = [];
    await page.route('**/products/price-product/variants/*', async route => {
      const body = route.request().postDataJSON(); writes.push({ id: route.request().url().split('/').at(-1), body });
      if (fail) return route.fulfill({ status: 503, json: { success: false, message: 'Fixture write failure' } });
      await new Promise<void>(resolve => { release = resolve; });
      variant.price = body.price; product.price = variant.price;
      return route.fulfill({ json: { success: true, data: product } });
    });
    await page.goto('/products/price-product');
    const editor = page.getByTestId('merchant-variant-price');
    const input = editor.getByRole('textbox');
    const save = editor.getByRole('button', { name: copy.common.save, exact: true });
    const saveProduct = page.getByRole('button', { name: copy.products.detail.saveChanges, exact: true });
    const retry = page.getByRole('button', { name: copy.common.retry, exact: true });
    await expect(input).toHaveValue('49'); await expect(save).toBeDisabled();
    // A normal product save invalidates the detail. The fixture now returns a
    // price changed by another editor; the untouched variant input must follow.
    variant.price.amount = 5500;
    await saveProduct.click(); await expect(input).toHaveValue('55');
    const node = await input.elementHandle();
    await input.fill('12.34'); variant.price.amount = 6000;
    await saveProduct.click(); await expect(input).toHaveValue('12.34');
    expect(await node!.evaluate(element => element.isConnected)).toBe(true);
    await input.fill('1e300'); await expect(save).toBeDisabled();
    await input.fill('12.34'); await save.click();
    await expect(editor.getByText(copy.products.variants.updateFailed, { exact: true })).toBeVisible();
    await expect(input).toHaveValue('12.34');
    expect(writes).toEqual([{ id: 'price-variant', body: { price: { amount: 1234, currency: 'EUR' } } }]);
    fail = false; await save.click(); await expect.poll(() => writes.length).toBe(2);
    await expect(input).toBeDisabled(); await expect(save).toBeDisabled();
    await expect(editor.getByRole('button', { name: copy.common.cancel, exact: true })).toBeDisabled();
    readError = true; release!();
    await expect(page.getByText(copy.products.detail.loadFailed, { exact: true })).toBeVisible();
    await expect(input).toHaveValue('12.34'); await expect(save).toBeDisabled();
    readError = false; variant.price.amount = 7000;
    await retry.click(); await expect(input).toHaveValue('70');
    // An unsaved amount remains denominated in its original currency if a
    // remote editor changes currency; there must be no accidental conversion.
    await input.fill('80'); readError = true; await saveProduct.click();
    await expect(page.getByText(copy.products.detail.loadFailed, { exact: true })).toBeVisible();
    variant.price = { amount: 123456789, currency: 'FAIR' }; product.price = variant.price; readError = false;
    await retry.click();
    await expect(input).toHaveValue('80'); await expect(input).toHaveAccessibleName(`${copy.resourceList.price} (EUR)`);
    await expect(editor.getByText(copy.products.variants.currencyChanged, { exact: true })).toBeVisible();
    await expect(save).toBeDisabled();
    await editor.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/mercaria-variant-price-${width}-${locale}-${mode}.png`, fullPage: true });
    await editor.getByRole('button', { name: copy.common.cancel, exact: true }).click();
    await expect(input).toHaveValue('1.23456789'); await expect(input).toHaveAccessibleName(`${copy.resourceList.price} (FAIR)`);
    expect(writes).toHaveLength(2);
    writable = false; await page.reload(); await expect(input).toBeDisabled(); await expect(save).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
