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
  test(`manual collection editing preserves drafts and ordered membership at ${width}px ${locale} ${mode}`, async ({
    page,
  }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode);
    await page.setViewportSize({ width, height: 1100 });
    let canWrite = true;
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
                permissions: ['products:read', ...(canWrite ? ['collections:write'] : [])],
              },
            },
          ],
        },
      }),
    );
    const collection = {
      id: 'manual-collection',
      storeId: 'store-preview',
      title: 'Summer essentials',
      handle: 'summer',
      description: 'Original description',
      type: 'manual',
      productIds: ['product-a'],
      sortOrder: 'manual',
      isPublished: false,
    };
    const product = (id: string, title: string) => ({
      id,
      title,
      status: 'active',
      images: [],
      variants: [],
      quantity: 0,
      price: { amount: 4900, currency: 'EUR' },
    });
    const a = product('product-a', 'Linen shirt');
    const b = product('product-b', 'Canvas bag');
    const c = product('product-c', 'Travel mug');
    const catalogue = [a, b, c];
    let readError = false;
    let metadataFails = true;
    let productsFail = true;
    let releaseProducts: (() => void) | undefined;
    let releaseMetadata: (() => void) | undefined;
    let holdProducts = true;
    const metadataWrites: unknown[] = [];
    const membershipWrites: unknown[] = [];
    const searches: URL[] = [];
    await page.route('**/admin/stores/*/collections', (route) =>
      route.fulfill({ json: { success: true, data: [collection] } }),
    );
    await page.route('**/admin/stores/*/collections/manual-collection', async (route) => {
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON();
        metadataWrites.push(body);
        if (metadataFails)
          return route.fulfill({
            status: 503,
            json: { success: false, message: 'Fixture save failure' },
          });
        await new Promise<void>((resolve) => {
          releaseMetadata = resolve;
        });
        Object.assign(collection, body);
        return route.fulfill({ json: { success: true, data: collection } });
      }
      return readError
        ? route.fulfill({ status: 502, json: { success: false, message: 'Fixture read failure' } })
        : route.fulfill({ json: { success: true, data: collection } });
    });
    await page.route('**/admin/stores/*/collections/manual-collection/products', async (route) => {
      const body = route.request().postDataJSON();
      membershipWrites.push(body);
      expect(route.request().method()).toBe('POST');
      if (productsFail)
        return route.fulfill({
          status: 409,
          json: { success: false, message: 'Fixture membership conflict' },
        });
      if (holdProducts)
        await new Promise<void>((resolve) => {
          releaseProducts = resolve;
        });
      collection.productIds = body.productIds;
      collection.description = 'Remote description';
      return route.fulfill({ json: { success: true, data: collection } });
    });
    await page.route('**/admin/stores/*/products?**', (route) => {
      const url = new URL(route.request().url());
      searches.push(url);
      const current = Number(url.searchParams.get('page'));
      const searching = Boolean(url.searchParams.get('search'));
      return route.fulfill({
        json: {
          success: true,
          data: searching || current === 2 ? [c] : [a, b],
          pagination: {
            page: current,
            pages: searching ? 1 : 2,
            limit: 20,
            total: searching ? 1 : 21,
          },
        },
      });
    });
    await page.route('**/admin/stores/*/products/product-*', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: catalogue.find((item) => route.request().url().endsWith(item.id)),
        },
      }),
    );
    await page.goto('/collections');
    const link = page.getByRole('link', { name: collection.title, exact: true });
    await expect(link).toHaveAttribute('href', '/collections/manual-collection');
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/collections\/manual-collection$/);
    const editor = page.getByTestId('merchant-collection-editor');
    const membership = page.getByTestId('merchant-collection-products');
    const title = editor.getByRole('textbox', { name: copy.common.title, exact: true });
    const description = editor.getByRole('textbox', { name: copy.common.description, exact: true });
    const save = editor.getByRole('button', { name: copy.collections.editor.save, exact: true });
    const saveProducts = membership.getByRole('button', {
      name: copy.collections.editor.saveProducts,
      exact: true,
    });
    const selected = membership.getByTestId('merchant-collection-selected-product');
    await expect(save).toBeDisabled();
    await expect(saveProducts).toBeDisabled();
    await expect(selected.getByRole('link', { name: a.title, exact: true })).toHaveAttribute(
      'href',
      '/products/product-a',
    );
    await title.fill('Discard this draft');
    await editor.getByRole('button', { name: copy.common.cancel, exact: true }).click();
    await expect(title).toHaveValue(collection.title);
    await expect(save).toBeDisabled();
    await title.fill('Merchant draft');
    const browse = membership.getByRole('button', {
      name: copy.collections.editor.browse,
      exact: true,
    });
    await browse.click();
    const picker = membership.getByTestId('merchant-collection-picker');
    const selectB = picker.getByRole('checkbox', { name: b.title, exact: true });
    await selectB.focus();
    await page.keyboard.press('Space');
    await expect(selectB).toBeChecked();
    await membership.getByRole('button', { name: copy.common.cancel, exact: true }).click();
    await expect(selectB).not.toBeChecked();
    await expect(selected).toHaveCount(1);
    await expect(saveProducts).toBeDisabled();
    await selectB.check();
    await picker.getByRole('button', { name: copy.resourceList.next, exact: true }).click();
    await picker.getByRole('checkbox', { name: c.title, exact: true }).check();
    await picker
      .getByRole('textbox', { name: copy.products.searchPlaceholder, exact: true })
      .fill('Travel');
    await expect
      .poll(() =>
        searches.some(
          (url) =>
            url.searchParams.get('search') === 'Travel' && url.searchParams.get('page') === '1',
        ),
      )
      .toBe(true);
    await expect(picker.getByRole('checkbox', { name: c.title, exact: true })).toBeChecked();
    await browse.click();
    await expect(picker).toHaveAttribute('inert');
    await expect(picker.getByRole('checkbox')).toHaveCount(0);
    await browse.focus();
    await page.keyboard.press('Tab');
    expect(await picker.evaluate((element) => element.contains(document.activeElement))).toBe(
      false,
    );
    await membership
      .getByRole('button', {
        name: copy.collections.editor.remove.replace('%{title}', a.title),
        exact: true,
      })
      .click();
    await membership
      .getByRole('button', {
        name: copy.collections.editor.earlier.replace('%{title}', c.title),
        exact: true,
      })
      .click();
    await expect(selected.first().getByRole('link')).toHaveAccessibleName(c.title);
    await browse.click();
    await expect(picker.getByRole('checkbox', { name: c.title, exact: true })).toBeChecked();
    await expect(
      picker.getByRole('textbox', { name: copy.products.searchPlaceholder, exact: true }),
    ).toHaveValue('Travel');
    await saveProducts.click();
    await expect(
      membership.getByText(copy.collections.editor.productsFailed, { exact: true }),
    ).toBeVisible();
    expect(membershipWrites).toEqual([{ productIds: [c.id, b.id] }]);
    await expect(title).toHaveValue('Merchant draft');
    productsFail = false;
    await saveProducts.click();
    await expect.poll(() => membershipWrites.length).toBe(2);
    await expect(saveProducts).toBeDisabled();
    await expect(save).toBeDisabled();
    await expect(title).toBeDisabled();
    releaseProducts!();
    await expect(saveProducts).toBeDisabled();
    await expect(description).toHaveValue('Remote description');
    await expect(title).toHaveValue('Merchant draft');
    await save.click();
    await expect(
      editor.getByText(copy.collections.editor.saveFailed, { exact: true }),
    ).toBeVisible();
    expect(metadataWrites).toEqual([{ title: 'Merchant draft' }]);
    await expect(title).toHaveValue('Merchant draft');
    metadataFails = false;
    await save.click();
    await expect.poll(() => metadataWrites.length).toBe(2);
    await expect(title).toBeDisabled();
    readError = true;
    releaseMetadata!();
    await expect(page.getByText(copy.collections.loadError, { exact: true })).toBeVisible();
    await expect(title).toHaveValue('Merchant draft');
    await expect(selected.first().getByRole('link')).toHaveAccessibleName(c.title);
    collection.title = 'Remote title after save';
    collection.description = 'Latest description';
    collection.productIds = [a.id];
    readError = false;
    await page.getByRole('button', { name: copy.common.retry, exact: true }).click();
    await expect(title).toHaveValue(collection.title);
    await expect(description).toHaveValue(collection.description);
    await expect(save).toBeDisabled();
    await expect(selected).toHaveCount(1);
    await expect(selected.getByRole('link')).toHaveAccessibleName(a.title);
    await membership
      .getByRole('button', {
        name: copy.collections.editor.remove.replace('%{title}', a.title),
        exact: true,
      })
      .click();
    holdProducts = false;
    await saveProducts.click();
    await expect.poll(() => membershipWrites.length).toBe(3);
    expect(membershipWrites[2]).toEqual({ productIds: [] });
    await expect(selected).toHaveCount(0);
    await expect(
      membership.getByRole('button', { name: copy.common.cancel, exact: true }),
    ).toBeDisabled();
    const handle = editor.getByRole('textbox', {
      name: copy.collections.editor.handle,
      exact: true,
    });
    await handle.fill('summer-edited');
    await description.fill('');
    await editor
      .getByRole('checkbox', { name: copy.collections.editor.published, exact: true })
      .check();
    await editor.getByLabel(copy.collections.editor.sortLabel, { exact: true }).click();
    await page
      .getByRole('radio', { name: copy.collections.editor.sort.title, exact: true })
      .click();
    await save.click();
    await expect.poll(() => metadataWrites.length).toBe(3);
    expect(metadataWrites[2]).toEqual({
      handle: 'summer-edited',
      description: '',
      isPublished: true,
      sortOrder: 'title_asc',
    });
    releaseMetadata!();
    await expect(
      editor.getByRole('button', { name: copy.common.cancel, exact: true }),
    ).toBeDisabled();
    await page.screenshot({
      path: `/tmp/mercaria-collection-editor-${width}-${locale}-${mode}.png`,
      fullPage: true,
    });
    canWrite = false;
    await page.reload();
    await expect(title).toBeDisabled();
    await expect(save).toHaveCount(0);
    await expect(browse).toHaveCount(0);
    canWrite = true;
    collection.type = 'automated';
    await page.reload();
    await expect(page.getByText(copy.collections.editor.automated, { exact: true })).toBeVisible();
    await expect(membership).toBeVisible();
    await expect(browse).toHaveCount(0);
    expect(metadataWrites).toHaveLength(3);
    expect(membershipWrites).toHaveLength(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
