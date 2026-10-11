import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

for (const [width, locale, mode] of [
  [1440, 'en', 'light'],
  [390, 'en', 'light'],
  [390, 'ar', 'light'],
  [390, 'en', 'dark'],
] as const) {
  test(`variant identifiers preserve exact strings and unsaved edits at ${width}px ${locale} ${mode}`, async ({
    page,
  }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode);
    await page.setViewportSize({ width, height: 1100 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let writable = true;
    await page.route('**/admin/stores', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: [
            {
              id: 'store-preview',
              name: 'Demo Atelier',
              handle: 'demo-atelier',
              defaultCurrency: 'EUR',
              access: { permissions: ['products:read', ...(writable ? ['products:write'] : [])] },
            },
          ],
        },
      }),
    );
    const variant = {
      id: 'identifier-variant',
      title: 'Natural / Medium',
      sku: 'FIRST-SKU',
      barcode: '0000123',
      available: 5,
      inStock: true,
      price: { amount: 4900, currency: 'EUR' },
      optionValues: [],
    };
    // Seller SKUs and barcodes are not globally unique. The backend permits these duplicates.
    const other = {
      ...variant,
      id: 'other-variant',
      title: 'Natural / Large',
      sku: 'SAME-SKU',
      barcode: '0000000000001234',
    };
    const product = {
      id: 'identifier-product',
      title: 'Linen studio shirt',
      description: 'A linen shirt.',
      category: 'clothing',
      status: 'draft',
      tags: [],
      images: [],
      variants: [variant, other],
      options: [],
      quantity: 10,
      overriddenFields: [],
      price: variant.price,
    };
    let readError = false;
    await page.route('**/admin/stores/*/products/identifier-product', (route) => {
      if (route.request().method() === 'GET' && readError)
        return route.fulfill({
          status: 502,
          json: { success: false, message: 'Fixture read failure' },
        });
      if (route.request().method() === 'PATCH')
        Object.assign(product, route.request().postDataJSON());
      return route.fulfill({ json: { success: true, data: product } });
    });
    let fail = true;
    let release: (() => void) | undefined;
    const writes: unknown[] = [];
    await page.route('**/products/identifier-product/variants/*', async (route) => {
      const body = route.request().postDataJSON();
      writes.push({ id: route.request().url().split('/').at(-1), body });
      if (fail)
        return route.fulfill({
          status: 503,
          json: { success: false, message: 'Fixture write failure' },
        });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      Object.assign(variant, body);
      return route.fulfill({ json: { success: true, data: product } });
    });
    await page.goto('/products/identifier-product');
    const editor = page.getByTestId('merchant-variant-identifiers').first();
    const sku = editor.getByRole('textbox', {
      name: copy.products.variants.identifiers.sku,
      exact: true,
    });
    const barcode = editor.getByRole('textbox', {
      name: copy.products.variants.identifiers.barcode,
      exact: true,
    });
    const save = editor.getByRole('button', { name: copy.common.save, exact: true });
    const cancel = editor.getByRole('button', { name: copy.common.cancel, exact: true });
    const saveProduct = page.getByRole('button', {
      name: copy.products.detail.saveChanges,
      exact: true,
    });
    let productEdit = 0;
    const refreshProduct = async () => {
      await page
        .getByRole('textbox', { name: copy.common.title, exact: true })
        .fill(`Edited product ${++productEdit}`);
      await saveProduct.click();
    };
    const retry = page.getByRole('button', { name: copy.common.retry, exact: true });
    await expect(sku).toHaveValue('FIRST-SKU');
    await expect(barcode).toHaveValue('0000123');
    await expect(save).toBeDisabled();
    variant.sku = 'REMOTE-SKU';
    await refreshProduct();
    await expect(sku).toHaveValue('REMOTE-SKU');
    const node = await sku.elementHandle();
    await sku.fill('SAME-SKU');
    variant.barcode = '0000999';
    await refreshProduct();
    await expect(sku).toHaveValue('SAME-SKU');
    await expect(barcode).toHaveValue('0000999');
    expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
    await sku.fill('   ');
    await expect(save).toBeDisabled();
    await expect(
      editor.getByText(copy.products.variants.identifiers.cannotClear, { exact: true }),
    ).toBeVisible();
    expect(writes).toEqual([]);
    await sku.fill('SAME-SKU');
    await save.click();
    await expect(
      editor.getByText(copy.products.variants.updateFailed, { exact: true }),
    ).toBeVisible();
    expect(writes).toEqual([{ id: 'identifier-variant', body: { sku: 'SAME-SKU' } }]);
    await expect(sku).toHaveValue('SAME-SKU');
    await expect(barcode).toHaveValue('0000999');
    await barcode.fill(' 0000000000001234 ');
    fail = false;
    await save.click();
    await expect.poll(() => writes.length).toBe(2);
    await expect(save).toBeDisabled();
    await expect(sku).toBeDisabled();
    await expect(barcode).toBeDisabled();
    await expect(cancel).toBeDisabled();
    expect(writes[1]).toEqual({
      id: 'identifier-variant',
      body: { sku: 'SAME-SKU', barcode: '0000000000001234' },
    });
    readError = true;
    release!();
    await expect(page.getByText(copy.products.detail.loadFailed, { exact: true })).toBeVisible();
    await expect(sku).toHaveValue('SAME-SKU');
    await expect(barcode).toHaveValue('0000000000001234');
    await expect(save).toBeDisabled();
    readError = false;
    variant.sku = 'LATEST-SKU';
    await retry.click();
    await expect(sku).toHaveValue('LATEST-SKU');
    await barcode.fill('');
    await expect(save).toBeDisabled();
    await expect(
      editor.getByText(copy.products.variants.identifiers.cannotClear, { exact: true }),
    ).toBeVisible();
    await editor.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `/tmp/mercaria-variant-identifiers-${width}-${locale}-${mode}.png`,
      fullPage: true,
    });
    await cancel.click();
    await expect(barcode).toHaveValue('0000000000001234');
    await expect(save).toBeDisabled();
    writable = false;
    await page.reload();
    await expect(sku).toBeDisabled();
    await expect(barcode).toBeDisabled();
    await expect(save).toHaveCount(0);
    expect(writes).toHaveLength(2);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
