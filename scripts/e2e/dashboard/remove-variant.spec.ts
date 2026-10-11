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
  test(`variant removal requires confirmation and retains the server result at ${width}px ${locale} ${mode}`, async ({
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
      id: 'remove-variant',
      title: 'Natural / Medium',
      available: 5,
      inStock: true,
      price: { amount: 4900, currency: 'EUR' },
      optionValues: [],
    };
    const other = { ...variant, id: 'keep-variant', title: 'Natural / Large' };
    const product = {
      id: 'remove-product',
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
    await page.route('**/admin/stores/*/products/remove-product', (route) =>
      readError
        ? route.fulfill({ status: 502, json: { success: false, message: 'Fixture read failure' } })
        : route.fulfill({ json: { success: true, data: product } }),
    );
    let fail = true;
    let release: (() => void) | undefined;
    const writes: { id: string; method: string }[] = [];
    await page.route('**/products/remove-product/variants/*', async (route) => {
      const id = route.request().url().split('/').at(-1)!;
      writes.push({ id, method: route.request().method() });
      if (fail)
        return route.fulfill({
          status: 409,
          json: { success: false, message: 'Fixture conflict' },
        });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      product.variants = product.variants.filter((item) => item.id !== id);
      return route.fulfill({ json: { success: true, data: product } });
    });
    await page.goto('/products/remove-product');
    const buttons = page.getByRole('button', {
      name: copy.products.variants.removeVariant,
      exact: true,
    });
    await expect(buttons).toHaveCount(2);
    await buttons.first().click();
    const dialog = page.getByTestId('merchant-remove-variant');
    const confirm = dialog.getByRole('button', {
      name: copy.products.variants.removeVariant,
      exact: true,
    });
    const cancel = dialog.getByRole('button', { name: copy.common.cancel, exact: true });
    await expect(dialog).toContainText(variant.title);
    expect(writes).toEqual([]);
    await cancel.click();
    await expect(dialog).toHaveCount(0);
    expect(writes).toEqual([]);
    await buttons.first().click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(writes).toEqual([]);
    await buttons.first().click();
    await confirm.click();
    await expect(
      dialog.getByText(copy.products.variants.removeFailed, { exact: true }),
    ).toBeVisible();
    expect(writes).toEqual([{ id: 'remove-variant', method: 'DELETE' }]);
    await expect(dialog).toContainText(variant.title);
    await page.screenshot({
      path: `/tmp/mercaria-remove-variant-${width}-${locale}-${mode}.png`,
      fullPage: true,
    });
    fail = false;
    await confirm.click();
    await expect.poll(() => writes.length).toBe(2);
    await expect(cancel).toBeDisabled();
    await expect(confirm).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    readError = true;
    release!();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(copy.products.detail.loadFailed, { exact: true })).toBeVisible();
    await expect(page.getByText(variant.title, { exact: true })).toHaveCount(0);
    await expect(page.getByText(other.title, { exact: true })).toBeVisible();
    await expect(buttons).toHaveCount(0); // The sole remaining variant cannot be removed.
    readError = false;
    await page.getByRole('button', { name: copy.common.retry, exact: true }).click();
    await expect(page.getByText(other.title, { exact: true })).toBeVisible();
    product.variants = [variant, other];
    writable = false;
    await page.reload();
    await expect(page.getByText(variant.title, { exact: true })).toBeVisible();
    await expect(buttons).toHaveCount(0);
    expect(writes).toHaveLength(2);
    expect(errors).toEqual([]);
  });
}
