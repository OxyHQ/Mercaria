import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

// Isolated inventory transport only; no actual stock is modified.
for (const [width, locale, mode] of [[1440, 'en', 'light'], [390, 'ar', 'dark']] as const) {
  test(`late inventory read cannot undo confirmed stock in a folded panel ${width} ${locale}`, async ({ page, context }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode); await page.clock.install();
    await page.setViewportSize({ width, height: 1100 });
    await page.route('**/admin/stores', route => route.fulfill({ json: { success: true, data: [{ id: 'store-preview', name: 'Demo Atelier', handle: 'demo-atelier', defaultCurrency: 'EUR', access: { permissions: ['products:read', 'inventory:write'] } }] } }));
    const levels = [{ locationId: 'warehouse-a', locationName: 'Warehouse A', available: 5 }, { locationId: 'warehouse-b', locationName: 'Warehouse B', available: 7 }];
    const variant = { id: 'variant-inventory', title: 'Natural / Medium', available: 12, inStock: true, price: { amount: 4900, currency: 'EUR' }, optionValues: [] };
    const product = { id: 'inventory-product', title: 'Linen shirt', description: '', status: 'draft', images: [], variants: [variant], options: [], quantity: 12, overriddenFields: [], price: variant.price };
    await page.route('**/admin/stores/*/products/inventory-product', route => route.fulfill({ json: { success: true, data: product } }));
    let holdRead = false; let releaseRead!: () => void; let releaseWrite!: () => void; let reads = 0;
    const writes: { location: string; body: unknown }[] = [];
    await page.route('**/variants/variant-inventory/levels', async route => {
      reads++;
      const snapshot = levels.map(level => ({ ...level }));
      if (holdRead) await new Promise<void>(resolve => { releaseRead = resolve; });
      return route.fulfill({ json: { success: true, data: snapshot } });
    });
    await page.route('**/variants/variant-inventory/levels/*', async route => {
      const body = route.request().postDataJSON();
      writes.push({ location: new URL(route.request().url()).pathname.split('/').at(-1)!, body });
      await new Promise<void>(resolve => { releaseWrite = resolve; });
      levels[1].available = body.available; variant.available = 5 + body.available; product.quantity = variant.available;
      return route.fulfill({ json: { success: true, data: levels } });
    });
    await page.goto('/products/inventory-product');
    const inventory = page.getByTestId('merchant-variant-inventory');
    const manage = inventory.getByRole('button', { name: copy.products.variants.inventory.manage, exact: true });
    await manage.click();
    const rows = inventory.getByTestId('merchant-inventory-level');
    const first = rows.nth(0).locator('input'); const second = rows.nth(1).locator('input');
    await expect(second).toHaveValue('7'); await first.fill('8'); await second.fill('3');
    await rows.nth(1).getByRole('button', { name: copy.products.variants.set, exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    holdRead = true;
    // Age the query without firing the pending PATCH's network timeout.
    await page.clock.setSystemTime(new Date(Date.now() + 301_000));
    await context.setOffline(true); await context.setOffline(false);
    await expect.poll(() => Boolean(releaseRead)).toBe(true);
    await manage.click(); await expect(manage).toHaveAttribute('aria-expanded', 'false');
    releaseWrite();
    await expect(inventory.getByText(copy.products.variants.inventoryUpdated, { exact: true })).toHaveCount(1);
    const oldResponse = page.waitForResponse(response => response.request().method() === "GET" && response.url().endsWith("/variants/variant-inventory/levels"));
    releaseRead(); holdRead = false;
    await (await oldResponse).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // Hidden DOM is intentionally still mounted by Bloom Collapsible.
    await expect(second).toHaveValue('3'); await expect(first).toHaveValue('8');
    await expect(manage).toHaveAttribute('aria-expanded', 'false');
    await manage.click(); await expect(second).toBeEnabled();
    await expect(second).toHaveValue('3'); await expect(first).toHaveValue('8');
    expect(writes).toEqual([{ location: 'warehouse-b', body: { available: 3 } }]);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await inventory.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/mercaria-merchant-inventory-cache-${width}-${locale}.png`, fullPage: true });
  });
}
