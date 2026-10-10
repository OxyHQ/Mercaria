import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

for (const [width, locale, mode] of [[1440, 'en', 'light'], [390, 'en', 'light'], [390, 'ar', 'light'], [390, 'en', 'dark']] as const) {
  test(`collection deletion is confirmed, keyboard accessible and recoverable at ${width}px ${locale} ${mode}`, async ({ page }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode); await page.setViewportSize({ width, height: 1100 });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    let writable = true;
    await page.route('**/admin/stores', route => route.fulfill({ json: { success: true, data: [{ id: 'store-preview', name: 'Demo Atelier', handle: 'demo-atelier', defaultCurrency: 'EUR',
      access: { permissions: writable ? ['collections:write'] : ['products:read'] } }] } }));
    const collection = { id: 'summer-collection', storeId: 'store-preview', title: 'Summer essentials', handle: 'summer', type: 'manual', isPublished: false, productIds: ['product-one'], sortOrder: 'manual' };
    const other = { ...collection, id: 'winter-collection', title: 'Winter essentials', handle: 'winter' };
    let collections = [collection, other]; let reads = 0; let readError = false;
    await page.route('**/admin/stores/*/collections', route => {
      reads++;
      return readError ? route.fulfill({ status: 502, json: { success: false, message: 'Fixture read failure' } })
        : route.fulfill({ json: { success: true, data: collections } });
    });
    let fail = true; let release: (() => void) | undefined;
    const writes: { path: string; method: string }[] = [];
    await page.route('**/admin/stores/*/collections/*', async route => {
      const path = new URL(route.request().url()).pathname;
      writes.push({ path, method: route.request().method() });
      if (fail) return route.fulfill({ status: 503, json: { success: false, message: 'Fixture delete failure' } });
      await new Promise<void>(resolve => { release = resolve; });
      collections = [other];
      return route.fulfill({ json: { success: true, data: { id: collection.id, deleted: true } } });
    });
    await page.goto('/collections');
    const trigger = page.getByRole('button', { name: copy.collections.remove.action.replace('%{title}', collection.title), exact: true });
    const dialog = page.getByTestId('merchant-remove-collection');
    const confirm = dialog.getByRole('button', { name: copy.collections.remove.title, exact: true });
    const cancel = dialog.getByRole('button', { name: copy.common.cancel, exact: true });
    await expect(trigger).toBeVisible(); await trigger.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    await expect(trigger).toBeFocused(); await page.keyboard.press('Enter');
    await expect(dialog).toContainText(collection.title); expect(writes).toEqual([]);
    await cancel.focus(); await page.keyboard.press('Enter'); await expect(dialog).toHaveCount(0); expect(writes).toEqual([]);
    await trigger.click(); await expect(dialog).toBeVisible(); await expect(cancel).toBeFocused(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); expect(writes).toEqual([]);
    await trigger.click(); await confirm.focus(); await page.keyboard.press('Enter');
    await expect(dialog.getByText(copy.collections.deleteError, { exact: true })).toBeVisible();
    const expected = { path: '/admin/stores/store-preview/collections/summer-collection', method: 'DELETE' };
    expect(writes).toEqual([expected]); await expect(dialog).toContainText(collection.title);
    await page.screenshot({ path: `/tmp/mercaria-collection-delete-${width}-${locale}-${mode}.png`, fullPage: true });
    fail = false; await confirm.click(); await expect.poll(() => writes.length).toBe(2);
    await expect(confirm).toBeDisabled(); await expect(cancel).toBeDisabled(); await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
    readError = true; release!(); await expect(dialog).toHaveCount(0);
    await expect(page.getByText(copy.collections.loadError, { exact: true })).toBeVisible();
    await expect(page.getByText(collection.title, { exact: true })).toHaveCount(0);
    await expect(page.getByText(other.title, { exact: true })).toBeVisible(); expect(writes).toEqual([expected, expected]);
    readError = false; await page.getByRole('button', { name: copy.common.retry, exact: true }).click();
    await expect(page.getByText(copy.collections.loadError, { exact: true })).toHaveCount(0);
    await expect(page.getByText(other.title, { exact: true })).toBeVisible();
    writable = false; const previousReads = reads; await page.reload();
    await expect(page.getByText(copy.common.noAccess, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: copy.collections.remove.action.replace('%{title}', other.title), exact: true })).toHaveCount(0);
    expect(reads).toBe(previousReads); expect(writes).toHaveLength(2); expect(errors).toEqual([]);
  });
}
