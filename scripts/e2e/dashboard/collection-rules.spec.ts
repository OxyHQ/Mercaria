import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

for (const [width, locale, mode] of [[1440, 'en', 'light'], [390, 'en', 'light'], [390, 'ar', 'light'], [390, 'en', 'dark']] as const) {
  test(`automatic collection rules preserve unsupported conditions at ${width}px ${locale} ${mode}`, async ({ page }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode); await page.setViewportSize({ width, height: 1100 });
    let canWrite = true;
    await page.route('**/admin/stores', route => route.fulfill({ json: { success: true, data: [{ id: 'store-preview', name: 'Demo Atelier', handle: 'demo-atelier', defaultCurrency: 'EUR',
      access: { permissions: ['products:read', ...(canWrite ? ['collections:write'] : [])] } }] } }));
    const historicalPrice = { field: 'price', operator: 'gt', value: '12500' };
    const historicalInventory = { field: 'inventory', operator: 'gt', value: '5' };
    const collection = { id: 'automatic-collection', storeId: 'store-preview', title: 'Seasonal collection', handle: 'seasonal', type: 'automated', productIds: ['product-a'], sortOrder: 'manual', isPublished: false,
      rules: { appliesDisjunctively: false, conditions: [{ field: 'title', operator: 'contains', value: 'Summer' }, historicalPrice, historicalInventory] } };
    let reads = 0;
    let fails = true; let readError = false; let held = true; let release: (() => void) | undefined;
    const writes: { rules: typeof collection.rules }[] = [];
    await page.route('**/admin/stores/*/collections', route => route.fulfill({ json: { success: true, data: [collection] } }));
    await page.route('**/admin/stores/*/collections/automatic-collection', async route => {
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON();
        if (!body.rules) {
          expect(body).toEqual({ handle: 'seasonal-edited' }); Object.assign(collection, body);
          return route.fulfill({ json: { success: true, data: collection } });
        }
        writes.push(body);
        if (fails) return route.fulfill({ status: 503, json: { success: false, message: 'Fixture save failure' } });
        if (held) await new Promise<void>(resolve => { release = resolve; });
        Object.assign(collection, body); collection.title = 'Remote title'; collection.productIds = [];
        return route.fulfill({ json: { success: true, data: collection } });
      }
      reads += 1;
      return readError ? route.fulfill({ status: 502, json: { success: false, message: 'Fixture read failure' } })
        : route.fulfill({ json: { success: true, data: collection } });
    });
    await page.route('**/admin/stores/*/products/product-a', route => route.fulfill({ json: { success: true, data: { id: 'product-a', title: 'Linen shirt', images: [], variants: [], status: 'active', price: { amount: 1000, currency: 'EUR' } } } }));
    await page.goto('/collections/automatic-collection');
    const editor = page.getByTestId('merchant-collection-editor'); const rules = page.getByTestId('merchant-collection-rules');
    const rows = rules.getByTestId('merchant-collection-condition');
    const save = rules.getByRole('button', { name: copy.collections.rules.save, exact: true });
    const add = rules.getByRole('button', { name: copy.collections.rules.add, exact: true });
    const title = editor.getByRole('textbox', { name: copy.common.title, exact: true });
    const firstValue = rows.first().getByRole('textbox', { name: copy.collections.rules.value, exact: true });
    const choose = async (scope: typeof rules, label: string, option: string) => {
      await scope.getByRole('button', { name: label, exact: true }).click();
      await page.getByRole('radio', { name: option, exact: true }).click();
    };
    await expect(rows).toHaveCount(3); await expect(save).toBeDisabled();
    await expect(rows.nth(1).getByRole('textbox')).toHaveCount(0); await expect(rows.nth(2).getByRole('textbox')).toHaveCount(0);
    await expect(rules.getByText(copy.collections.rules.retained, { exact: true })).toHaveCount(2);
    await expect(page.getByTestId('merchant-collection-products').getByRole('link', { name: 'Linen shirt', exact: true })).toHaveAttribute('href', '/products/product-a');
    await expect(page.getByRole('button', { name: copy.collections.editor.browse, exact: true })).toHaveCount(0);
    await firstValue.fill(''); await expect(save).toBeDisabled();
    await firstValue.fill('Winter');
    await choose(rules, copy.collections.rules.match, copy.collections.rules.any);
    const previousReads = reads;
    collection.rules = { appliesDisjunctively: false, conditions: [{ field: 'vendor', operator: 'equals', value: 'Background maker' }] };
    await editor.getByRole('textbox', { name: copy.collections.editor.handle, exact: true }).fill('seasonal-edited');
    await editor.getByRole('button', { name: copy.collections.editor.save, exact: true }).click();
    await expect.poll(() => reads).toBeGreaterThan(previousReads);
    await expect(firstValue).toHaveValue('Winter'); await expect(rows).toHaveCount(3);
    await title.fill('Metadata draft');
    await add.click(); await expect(save).toBeDisabled();
    await choose(rows.nth(3), copy.collections.rules.field, copy.collections.rules.availability);
    await choose(rows.nth(3), copy.collections.rules.value, copy.collections.rules.outOfStock);
    await add.click(); await choose(rows.nth(4), copy.collections.rules.field, copy.products.detail.organization.tags);
    await rows.nth(4).getByRole('button', { name: copy.collections.rules.operator, exact: true }).click();
    await expect(page.getByRole('radio')).toHaveCount(3);
    await page.getByRole('radio', { name: copy.collections.rules.operators.contains, exact: true }).click();
    await rows.nth(4).getByRole('textbox', { name: copy.collections.rules.value, exact: true }).fill('  Holiday  ');
    const expected = { rules: { appliesDisjunctively: true, conditions: [
      { field: 'title', operator: 'contains', value: 'Winter' }, historicalPrice, historicalInventory,
      { field: 'inventory', operator: 'equals', value: '0' }, { field: 'tag', operator: 'contains', value: 'Holiday' },
    ] } };
    await save.click(); await expect(rules.getByText(copy.collections.rules.failed, { exact: true })).toBeVisible();
    expect(writes).toEqual([expected]); await expect(title).toHaveValue('Metadata draft'); await expect(firstValue).toHaveValue('Winter');
    fails = false; await save.click(); await expect.poll(() => writes.length).toBe(2);
    await expect(save).toBeDisabled(); await expect(firstValue).toBeDisabled(); await expect(title).toBeDisabled();
    await expect(rules.getByRole('button', { name: copy.common.cancel, exact: true })).toBeDisabled();
    readError = true; release!(); await expect(page.getByText(copy.collections.loadError, { exact: true })).toBeVisible();
    await expect(firstValue).toHaveValue('Winter'); await expect(title).toHaveValue('Metadata draft');
    collection.rules = { appliesDisjunctively: false, conditions: [{ field: 'vendor', operator: 'equals', value: 'Remote maker' }, historicalPrice] };
    readError = false; await page.getByRole('button', { name: copy.common.retry, exact: true }).click();
    await expect(firstValue).toHaveValue('Remote maker'); await expect(rows).toHaveCount(2); await expect(save).toBeDisabled();
    await firstValue.fill('Discard me'); await rules.getByRole('button', { name: copy.common.cancel, exact: true }).click();
    await expect(firstValue).toHaveValue('Remote maker'); await expect(save).toBeDisabled();
    await rules.screenshot({ path: `/tmp/mercaria-collection-rules-config-${width}-${locale}-${mode}.png` });
    await rows.nth(1).getByRole('button', { name: copy.collections.rules.remove.replace('%{position}', '2'), exact: true }).click();
    await rows.first().getByRole('button', { name: copy.collections.rules.remove.replace('%{position}', '1'), exact: true }).click();
    await expect(rules.getByText(copy.collections.rules.empty, { exact: true })).toBeVisible();
    held = false; await save.click(); await expect.poll(() => writes.length).toBe(3);
    expect(writes[2]).toEqual({ rules: { appliesDisjunctively: false, conditions: [] } });
    await expect(rules.getByRole('button', { name: copy.common.cancel, exact: true })).toBeDisabled();
    await expect(title).toHaveValue('Metadata draft');
    await editor.getByRole('button', { name: copy.common.cancel, exact: true }).click(); await expect(title).toHaveValue('Remote title');
    await page.screenshot({ path: `/tmp/mercaria-collection-rules-${width}-${locale}-${mode}.png`, fullPage: true });
    canWrite = false; await page.reload(); await expect(rules).toBeVisible(); await expect(add).toHaveCount(0); await expect(save).toHaveCount(0);
    await expect(rules.getByRole('button', { name: copy.collections.rules.match, exact: true })).toBeDisabled();
    expect(writes.slice(0, 2)).toEqual([expected, expected]); expect(writes).toHaveLength(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
