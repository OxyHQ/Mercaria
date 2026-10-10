import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

for (const [width, locale, mode] of [[1440, 'en', 'light'], [390, 'en', 'light'], [390, 'ar', 'light'], [390, 'en', 'dark']] as const) {
  test(`bulk product status keeps partial failures at ${width}px ${locale} ${mode}`, async ({ page }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode); await page.setViewportSize({ width, height: 1100 });
    let canWrite = true;
    await page.route('**/admin/stores', route => route.fulfill({ json: { success: true, data: [{ id: 'store-preview', name: 'Demo Atelier', handle: 'demo-atelier', defaultCurrency: 'EUR',
      access: { permissions: ['products:read', ...(canWrite ? ['products:write'] : [])] } }] } }));
    const item = (id: string, title: string, status: string) => ({ id, title, status, images: [], variants: [], quantity: 1, price: { amount: 1200, currency: 'EUR' } });
    const a = item('bulk-a', 'First product', 'draft'); const b = item('bulk-b', 'Second product', 'draft');
    const c = item('bulk-c', 'Other product', 'active'); const restricted = item('bulk-r', 'Restricted product', 'restricted');
    let listFails = false; let secondFails = true; let holdFirst = true; let releaseFirst: (() => void) | undefined;
    const writes: { id: string; body: object }[] = [];
    await page.route('**/admin/stores/*/products?**', route => {
      const url = new URL(route.request().url()); const search = url.searchParams.get('search'); const next = url.searchParams.get('page') === '2';
      if (listFails) return route.fulfill({ status: 503, json: { success: false, message: 'Fixture read failure' } });
      return route.fulfill({ json: { success: true, data: search ? [c] : next ? [b] : [a, restricted], pagination: { page: search ? 1 : next ? 2 : 1, pages: search ? 1 : 2, limit: 20, total: search ? 1 : 21 } } });
    });
    await page.route('**/admin/stores/*/products/bulk-*', async route => {
      const id = route.request().url().split('/').at(-1)!; const product = [a, b, c, restricted].find(value => value.id === id)!;
      expect(route.request().method()).toBe('PATCH'); const body = route.request().postDataJSON(); writes.push({ id, body });
      if (id === a.id && holdFirst) await new Promise<void>(resolve => { releaseFirst = resolve; });
      if (id === b.id && secondFails) return route.fulfill({ status: 409, json: { success: false, message: 'Fixture conflict' } });
      Object.assign(product, body); return route.fulfill({ json: { success: true, data: product } });
    });
    await page.goto('/products');
    const list = page.getByTestId('merchant-products-list');
    const checkbox = (name: string) => list.getByRole('checkbox', { name: copy.products.bulk.select.replace('%{title}', name), exact: true });
    const pageCheckbox = list.getByRole('checkbox', { name: copy.products.bulk.selectPage, exact: true });
    await expect(checkbox(restricted.title)).toBeDisabled();
    await pageCheckbox.focus(); await page.keyboard.press('Space'); await expect(checkbox(a.title)).toBeChecked(); await expect(checkbox(restricted.title)).not.toBeChecked();
    await list.getByRole('button', { name: copy.resourceList.next, exact: true }).click();
    await checkbox(b.title).check();
    await list.getByRole('textbox', { name: copy.products.searchPlaceholder, exact: true }).fill('Other');
    await expect(checkbox(c.title)).toBeVisible(); await expect(checkbox(c.title)).not.toBeChecked();
    await expect(page.getByTestId('merchant-bulk-actions').getByText(copy.products.bulk.selected.replace('%{items}', '2'), { exact: true })).toBeVisible();
    await list.getByRole('button', { name: copy.products.bulk.activate, exact: true }).click();
    const dialog = page.getByRole('dialog'); const panel = page.getByTestId('merchant-bulk-confirmation');
    await expect(panel.getByText(a.title, { exact: true })).toBeVisible(); await expect(panel.getByText(b.title, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: copy.common.cancel, exact: true }).click(); expect(writes).toEqual([]);
    await list.getByRole('button', { name: copy.products.bulk.activate, exact: true }).click();
    await dialog.getByRole('button', { name: copy.products.bulk.confirm, exact: true }).click();
    await expect.poll(() => writes.length).toBe(1); await expect(dialog.getByRole('button', { name: copy.products.bulk.confirm, exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: copy.common.cancel, exact: true })).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
    expect(writes).toEqual([{ id: a.id, body: { status: 'active' } }]);
    listFails = true; releaseFirst!(); holdFirst = false;
    await expect(panel.getByText(copy.products.bulk.failed.replace('%{title}', b.title), { exact: true })).toBeVisible();
    await expect(panel.getByText(a.title, { exact: true })).toHaveCount(0);
    expect(writes).toEqual([{ id: a.id, body: { status: 'active' } }, { id: b.id, body: { status: 'active' } }]);
    secondFails = false; listFails = false;
    await dialog.getByRole('button', { name: copy.products.bulk.retry, exact: true }).click();
    await expect(panel.getByText(copy.products.bulk.selected.replace('%{items}', '0'), { exact: true })).toBeVisible();
    expect(writes[2]).toEqual({ id: b.id, body: { status: 'active' } }); expect(writes).toHaveLength(3);
    await dialog.getByRole('button', { name: copy.common.done, exact: true }).click();
    await expect(checkbox(c.title)).toBeVisible();
    for (const [action, status] of [[copy.products.bulk.archive, 'archived'], [copy.products.bulk.draft, 'draft']] as const) {
      await checkbox(c.title).check(); await list.getByRole('button', { name: action, exact: true }).click();
      await dialog.getByRole('button', { name: copy.products.bulk.confirm, exact: true }).click();
      await expect(panel.getByText(copy.products.bulk.selected.replace('%{items}', '0'), { exact: true })).toBeVisible();
      expect(writes.at(-1)).toEqual({ id: c.id, body: { status } });
      await dialog.getByRole('button', { name: copy.common.done, exact: true }).click();
      await expect(list.getByTestId('merchant-product-row').getByText(copy.products.status[status], { exact: true })).toBeVisible();
    }
    await expect(dialog).toBeHidden();
    await checkbox(c.title).check();
    await page.screenshot({ path: `/tmp/mercaria-product-bulk-${width}-${locale}-${mode}.png`, fullPage: true });
    await list.getByRole('button', { name: copy.products.bulk.clear, exact: true }).click(); await expect(checkbox(c.title)).not.toBeChecked();
    canWrite = false; await page.reload(); await expect(list.getByRole('checkbox')).toHaveCount(0); await expect(list.getByRole('button', { name: copy.products.bulk.activate, exact: true })).toHaveCount(0);
    expect(writes).toHaveLength(5); expect(writes.some(write => write.id === restricted.id)).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
