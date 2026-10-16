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
  test(`inventory edits the selected location exactly at ${width}px ${locale} ${mode}`, async ({
    page,
  }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode);
    await page.setViewportSize({ width, height: 1100 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let canInventory = true;
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
              access: {
                permissions: ['products:read', ...(canInventory ? ['inventory:write'] : [])],
              },
            },
          ],
        },
      }),
    );
    const levels = [
      { locationId: 'warehouse-a', locationName: 'Warehouse A', available: 5 },
      { locationId: 'warehouse-b', locationName: 'Warehouse B', available: 7 },
    ];
    const variant = {
      id: 'variant-inventory',
      title: 'Natural / Medium',
      available: 12,
      inStock: true,
      price: { amount: 4900, currency: 'EUR' },
      optionValues: [],
    };
    const product = {
      id: 'inventory-product',
      title: 'Linen studio shirt',
      description: 'A linen shirt.',
      category: 'clothing',
      status: 'draft',
      tags: [],
      images: [],
      variants: [variant],
      options: [],
      quantity: 12,
      overriddenFields: [],
      price: variant.price,
    };
    await page.route('**/admin/stores/*/products/inventory-product', (route) =>
      route.fulfill({ json: { success: true, data: product } }),
    );
    let readError = true;
    let writeError = true;
    let releaseWrite: (() => void) | undefined;
    let pendingWrite: Promise<void> | undefined;
    const writes: { location: string; body: unknown }[] = [];
    const legacyWrites: string[] = [];
    await page.route('**/variants/variant-inventory/inventory', (route) => {
      legacyWrites.push(route.request().url());
      return route.fulfill({ status: 500 });
    });
    await page.route('**/variants/variant-inventory/levels', (route) =>
      readError
        ? route.fulfill({
            status: 502,
            json: { success: false, message: 'Fixture inventory read failure' },
          })
        : route.fulfill({ json: { success: true, data: levels } }),
    );
    await page.route('**/variants/variant-inventory/levels/*', async (route) => {
      const location = new URL(route.request().url()).pathname.split('/').at(-1)!;
      const body = route.request().postDataJSON();
      writes.push({ location, body });
      if (pendingWrite) await pendingWrite;
      if (writeError)
        return route.fulfill({
          status: 503,
          json: { success: false, message: 'Fixture inventory write failure' },
        });
      const level = levels.find((item) => item.locationId === location)!;
      level.available = body.available;
      variant.available = levels.reduce((total, item) => total + item.available, 0);
      product.quantity = variant.available;
      return route.fulfill({ json: { success: true, data: levels } });
    });
    await page.goto('/products/inventory-product');
    const inventory = page.getByTestId('merchant-variant-inventory');
    const manage = inventory.getByRole('button', {
      name: copy.products.variants.inventory.manage,
      exact: true,
    });
    await manage.click();
    await expect(
      inventory.getByText(copy.products.variants.inventory.loadFailed, { exact: true }),
    ).toBeVisible();
    readError = false;
    await inventory.getByRole('button', { name: copy.common.retry, exact: true }).click();
    const rows = inventory.getByTestId('merchant-inventory-level');
    await expect(rows).toHaveCount(2);
    const first = rows
      .nth(0)
      .getByRole('textbox', { name: copy.products.variants.available, exact: true });
    const second = rows
      .nth(1)
      .getByRole('textbox', { name: copy.products.variants.available, exact: true });
    const set = rows.nth(1).getByRole('button', { name: copy.products.variants.set, exact: true });
    await expect(first).toHaveValue('5');
    await expect(second).toHaveValue('7');
    for (const invalid of ['2.5', 'stock', '-1', '']) {
      await second.fill(invalid);
      await expect(set).toBeDisabled();
      await expect(
        rows.nth(1).getByText(copy.products.variants.inventory.invalid, { exact: true }),
      ).toBeVisible();
    }
    expect(writes).toEqual([]);
    // Collapsing hides the controls without discarding either location's draft.
    await first.fill('8');
    await second.fill('3');
    await manage.click();
    const panel = inventory.getByTestId('merchant-inventory-panel');
    await expect(manage).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toHaveAttribute('aria-hidden', 'true');
    await expect(panel).toHaveAttribute('inert');
    await expect(panel.locator('input')).toHaveCount(2);
    await expect(panel.getByRole('textbox')).toHaveCount(0);
    await manage.focus();
    await page.keyboard.press('Tab');
    expect(await panel.evaluate((element) => element.contains(document.activeElement))).toBe(false);
    await manage.click();
    await expect(first).toHaveValue('8');
    await expect(second).toHaveValue('3');
    await rows.nth(0).getByRole('button', { name: copy.common.cancel, exact: true }).click();
    await expect(first).toHaveValue('5');
    await expect(second).toHaveValue('3');
    pendingWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    await set.click();
    await expect.poll(() => writes.length).toBe(1);
    await expect(
      rows.nth(1).getByRole('button', { name: copy.common.cancel, exact: true }),
    ).toBeDisabled();
    // Closing and reopening a pending request must not unlock or replace its draft.
    await manage.click();
    await expect(panel).toHaveAttribute('inert');
    await manage.click();
    await expect(second).toHaveValue('3');
    await expect(second).toBeDisabled();
    await expect(set).toBeDisabled();
    releaseWrite!();
    pendingWrite = undefined;
    await expect(
      page.getByText(copy.products.variants.inventoryUpdateFailed, { exact: true }),
    ).toBeVisible();
    await expect(second).toHaveValue('3');
    await expect(first).toHaveValue('5');
    writeError = false;
    readError = true;
    await set.click();
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[1]).toEqual({ location: 'warehouse-b', body: { available: 3 } });
    await expect(
      inventory.getByText(copy.products.variants.inventory.loadFailed, { exact: true }),
    ).toBeVisible();
    await expect(first).toHaveValue('5');
    await expect(second).toHaveValue('3');
    await expect(set).toBeDisabled();
    readError = false;
    levels[0].available = 9;
    await inventory.getByRole('button', { name: copy.common.retry, exact: true }).click();
    await expect(first).toHaveValue('9');
    await expect(second).toHaveValue('3');
    await first.fill('11');
    await second.fill('4');
    await rows.nth(0).getByRole('button', { name: copy.common.cancel, exact: true }).click();
    await expect(first).toHaveValue('9');
    await expect(second).toHaveValue('4');
    await rows.nth(1).getByRole('button', { name: copy.common.cancel, exact: true }).click();
    await expect(second).toHaveValue('3');
    expect(writes).toHaveLength(2);
    await second.fill('0');
    await set.click();
    await expect.poll(() => writes.length).toBe(3);
    expect(writes[2]).toEqual({ location: 'warehouse-b', body: { available: 0 } });
    await expect(set).toBeDisabled();
    expect(levels[0].available).toBe(9);
    expect(legacyWrites).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await inventory.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `/tmp/mercaria-variant-inventory-${width}-${locale}-${mode}.png`,
      fullPage: true,
    });
    canInventory = false;
    await page.reload();
    await inventory
      .getByRole('button', { name: copy.products.variants.inventory.manage, exact: true })
      .click();
    await expect(first).toBeDisabled();
    await expect(second).toBeDisabled();
    await expect(
      inventory.getByRole('button', { name: copy.products.variants.set, exact: true }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
