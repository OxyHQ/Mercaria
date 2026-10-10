import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

for (const [width, locale, mode] of [[1440, 'en', 'light'], [390, 'en', 'light'], [390, 'ar', 'light'], [390, 'en', 'dark']] as const) {
  test(`variant creation preserves every option at ${width}px ${locale} ${mode}`, async ({ page }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode);
    await page.setViewportSize({ width, height: 1100 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let writable = true;
    await page.route('**/admin/stores', route => route.fulfill({ json: { success: true, data: [{ id: 'store-preview', name: 'Demo Atelier', handle: 'demo-atelier', defaultCurrency: 'EUR',
      access: { permissions: ['products:read', ...(writable ? ['products:write'] : [])] } }] } }));
    const existing = { id: 'existing-variant', title: 'Red / M / Linen', available: 5, inStock: true, price: { amount: 4900, currency: 'EUR' },
      optionValues: [{ name: 'Color', value: 'Red' }, { name: 'Size', value: 'M' }, { name: 'Material', value: 'Linen' }] };
    const product = { id: 'variant-product', title: 'Linen studio shirt', description: 'A linen shirt.', category: 'clothing', status: 'draft', tags: [], images: [],
      variants: [existing], options: [{ name: 'Color', values: ['Red', 'Blue'] }, { name: 'Size', values: ['M', 'L'] }, { name: 'Material', values: ['Linen', 'Cotton'] }],
      quantity: 5, overriddenFields: [], price: existing.price };
    let readError = false;
    await page.route('**/admin/stores/*/products/variant-product', route => readError
      ? route.fulfill({ status: 502, json: { success: false, message: 'Fixture read failure' } })
      : route.fulfill({ json: { success: true, data: product } }));
    const writes: unknown[] = [];
    let fail = true;
    let release: (() => void) | undefined;
    await page.route('**/products/variant-product/variants', async route => {
      const body = route.request().postDataJSON(); writes.push(body);
      if (fail) return route.fulfill({ status: 503, json: { success: false, message: 'Fixture write failure' } });
      await new Promise<void>(resolve => { release = resolve; });
      product.variants.push({ id: 'created-variant', title: body.optionValues.map((v: { value: string }) => v.value).join(' / '),
        available: body.inventory.available, inStock: true, price: body.price, optionValues: body.optionValues });
      return route.fulfill({ json: { success: true, data: product } });
    });
    await page.goto('/products/variant-product');
    await page.getByRole('button', { name: copy.products.variants.add, exact: true }).click();
    const form = page.getByTestId('merchant-create-variant');
    const color = form.getByRole('textbox', { name: 'Color', exact: true });
    const size = form.getByRole('textbox', { name: 'Size', exact: true });
    const material = form.getByRole('textbox', { name: 'Material', exact: true });
    const price = form.getByRole('textbox', { name: `${copy.resourceList.price} (EUR)`, exact: true });
    const stock = form.getByRole('textbox', { name: copy.products.stockLabel, exact: true });
    const save = form.getByRole('button', { name: copy.products.variants.saveVariant, exact: true });
    await color.fill('Blue'); await price.fill('12.34');
    await save.click();
    await expect(form.getByText(copy.products.variants.optionRequired, { exact: true })).toHaveCount(2);
    expect(writes).toEqual([]);
    await size.fill('L'); await material.fill('Linen'); await stock.fill('2.5');
    await save.click(); await expect(form.getByText(copy.products.variants.inventory.invalid, { exact: true })).toBeVisible();
    expect(writes).toEqual([]);
    await color.fill('Red'); await size.fill('M'); await stock.fill('3');
    await expect(save).toBeDisabled();
    await expect(form.getByText(copy.products.variants.duplicateCombination, { exact: true })).toBeVisible();
    // Case remains exact, matching the API; the UI must not silently fold values.
    await color.fill('red'); await expect(save).toBeEnabled();
    await price.fill('1e300'); await save.click();
    await expect(form.getByText(copy.products.variants.priceInvalid, { exact: true })).toBeVisible();
    expect(writes).toEqual([]);
    await price.fill('12.34');
    await color.fill(' Blue '); await size.fill('L'); await save.click();
    await expect(form.getByText(copy.products.variants.addFailed, { exact: true })).toBeVisible();
    expect(writes).toEqual([{ optionValues: [{ name: 'Color', value: 'Blue' }, { name: 'Size', value: 'L' }, { name: 'Material', value: 'Linen' }], price: { amount: 1234, currency: 'EUR' }, inventory: { available: 3 } }]);
    await expect(color).toHaveValue(' Blue '); await expect(size).toHaveValue('L'); await expect(material).toHaveValue('Linen');
    await expect(price).toHaveValue('12.34'); await expect(stock).toHaveValue('3');
    await form.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/mercaria-create-variant-${width}-${locale}-${mode}.png`, fullPage: true });
    fail = false;
    await save.click(); await expect.poll(() => writes.length).toBe(2);
    await expect(save).toBeDisabled(); await expect(color).toBeDisabled(); await expect(size).toBeDisabled(); await expect(material).toBeDisabled();
    await expect(form.getByRole('button', { name: copy.common.cancel, exact: true })).toBeDisabled();
    readError = true; release!();
    await expect(form).toHaveCount(0);
    await expect(page.getByText('Blue / L / Linen', { exact: true })).toBeVisible();
    // A failed refresh cannot erase the successfully returned new variant.
    await expect(page.getByText(copy.products.detail.loadFailed, { exact: true })).toBeVisible();
    readError = false;
    await page.getByRole('button', { name: copy.common.retry, exact: true }).click();
    await page.getByRole('button', { name: copy.products.variants.add, exact: true }).click();
    await expect(color).toHaveValue('');
    await color.fill('Blue'); await size.fill('L'); await material.fill('Linen');
    await expect(save).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await form.getByRole('button', { name: copy.common.cancel, exact: true }).click();
    writable = false; await page.reload();
    await expect(page.getByText('Blue / L / Linen', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: copy.products.variants.add, exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
