import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

for (const [width, locale, mode] of [[1440, 'en', 'light'], [390, 'en', 'light'], [390, 'ar', 'light'], [390, 'en', 'dark']] as const) {
  test(`product edits preserve remote fields and local drafts at ${width}px ${locale} ${mode}`, async ({ page }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode); await page.setViewportSize({ width, height: 1100 });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const product = { id: 'draft-product', title: 'Original title', description: 'Original description', category: 'clothing', status: 'draft',
      vendor: 'Original maker', tags: [], images: [], variants: [], options: [], quantity: 0, overriddenFields: [], price: { amount: 4900, currency: 'EUR' } };
    const other = { ...product, id: 'other-product', title: 'Other product', description: 'Other description' };
    let failRead = false; let failWrite = false;
    let release: (() => void) | undefined; let pending: Promise<void> | undefined;
    const writes: Record<string, unknown>[] = [];
    await page.route('**/admin/stores/*/products/draft-product', async route => {
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON(); writes.push(body);
        if (pending) await pending;
        if (failWrite) return route.fulfill({ status: 503, json: { success: false, message: 'Fixture save failed' } });
        Object.assign(product, body);
      } else if (failRead) return route.fulfill({ status: 502, json: { success: false, message: 'Fixture read failed' } });
      return route.fulfill({ json: { success: true, data: product } });
    });
    await page.route('**/admin/stores/*/products/other-product', route => route.fulfill({ json: { success: true, data: other } }));
    await page.route('**/admin/stores/*/products?**', route => route.fulfill({ json: { success: true, data: [product, other], pagination: { page: 1, total: 2, limit: 20, pages: 1 } } }));
    await page.goto('/products/draft-product');
    const detail = page.getByTestId('merchant-product-detail');
    const title = detail.getByRole('textbox', { name: copy.common.title, exact: true });
    const description = detail.getByRole('textbox', { name: copy.common.description, exact: true });
    const vendor = detail.getByRole('textbox', { name: copy.products.new.vendorLabel, exact: true });
    const save = detail.getByRole('button', { name: copy.products.detail.saveChanges, exact: true });
    const status = (name: string) => detail.getByRole('radio', { name, exact: true });
    const retry = detail.getByRole('button', { name: copy.common.retry, exact: true });
    await expect(title).toHaveValue('Original title'); await expect(save).toBeDisabled();
    // The server changes untouched base fields while the merchant edits only vendor.
    product.title = 'Remote title'; product.description = 'Remote description'; product.status = 'active';
    await vendor.fill('Edited maker'); await save.click(); await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toEqual({ vendor: 'Edited maker' });
    await expect(title).toHaveValue('Remote title'); await expect(description).toHaveValue('Remote description');
    await expect(status(copy.products.status.active)).toBeChecked(); await expect(save).toBeDisabled();
    // A failed post-save refresh keeps the saved DTO and enables an explicit retry.
    await vendor.fill('Second maker'); failRead = true; await save.click();
    await expect(detail.getByText(copy.products.detail.loadFailed, { exact: true })).toBeVisible();
    await title.fill('  Local title  '); await status(copy.products.status.archived).click();
    const node = await title.elementHandle();
    product.title = 'Later remote title'; product.description = 'Later remote description'; product.status = 'draft'; failRead = false;
    await retry.click(); await expect(detail.getByText(copy.products.detail.loadFailed, { exact: true })).toHaveCount(0);
    await expect(title).toHaveValue('  Local title  '); await expect(description).toHaveValue('Later remote description');
    await expect(status(copy.products.status.archived)).toBeChecked(); expect(await node!.evaluate(element => element.isConnected)).toBe(true);
    failWrite = true; await save.click(); await expect.poll(() => writes.length).toBe(3);
    await expect(page.getByText(copy.products.detail.saveFailed, { exact: true })).toBeVisible();
    expect(writes[2]).toEqual({ title: 'Local title', status: 'archived' });
    await expect(title).toHaveValue('  Local title  '); await expect(status(copy.products.status.archived)).toBeChecked();
    failWrite = false; pending = new Promise<void>(resolve => { release = resolve; });
    await save.click(); await expect.poll(() => writes.length).toBe(4);
    await expect(title).toBeDisabled(); await expect(description).toBeDisabled(); await expect(status(copy.products.status.active)).toBeDisabled(); await expect(save).toBeDisabled();
    release!(); pending = undefined;
    await expect(title).toHaveValue('Local title'); await expect(save).toBeDisabled();
    // Successful save releases dirty flags, so a later server update can be displayed.
    await vendor.fill('Third maker'); failRead = true; await save.click();
    await expect(detail.getByText(copy.products.detail.loadFailed, { exact: true })).toBeVisible();
    product.title = 'Final remote title'; product.status = 'active'; failRead = false;
    await retry.click(); await expect(title).toHaveValue('Final remote title'); await expect(status(copy.products.status.active)).toBeChecked();
    await description.fill(''); await save.click(); await expect.poll(() => writes.length).toBe(6);
    expect(writes[5]).toEqual({ description: '' }); await expect(save).toBeDisabled();
    // Normal client-side navigation to another product cannot carry this draft.
    await title.fill('Unsaved first product');
    await page.getByRole('button', { name: copy.common.back, exact: true }).click();
    await page.getByRole('link', { name: 'Other product', exact: true }).click();
    await expect(page).toHaveURL(/\/products\/other-product$/);
    await expect(title).toHaveValue('Other product'); await expect(description).toHaveValue('Other description'); await expect(save).toBeDisabled();
    expect(errors).toEqual([]);
  });
}
