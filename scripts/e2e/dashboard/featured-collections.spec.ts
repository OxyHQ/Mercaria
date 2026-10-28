import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

for (const [width, locale] of [
  [1440, 'en'],
  [390, 'ar'],
] as const) {
  test(`seller curates ordered featured collections with failure recovery at ${width}px ${locale}`, async ({
    page,
  }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, 'light');
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
    const collection = (id: string, type = 'manual', isPublished = true) => ({
      id,
      storeId: 'store-preview',
      title: id,
      handle: id,
      description: '',
      type,
      productIds: [],
      sortOrder: 'manual',
      isPublished,
    });
    const collections = [
      collection('one'),
      collection('two'),
      collection('draft', 'manual', false),
      collection('automated', 'automated'),
    ];
    await page.route('**/admin/stores/*/collections', (route) =>
      route.fulfill({ json: { success: true, data: collections } }),
    );
    let ids = ['one'];
    let refuse = true;
    let release: (() => void) | undefined;
    const writes: string[][] = [];
    await page.route('**/admin/stores/*/collections/featured', async (route) => {
      if (route.request().method() === 'PUT') {
        const next = route.request().postDataJSON().collectionIds;
        writes.push(next);
        if (refuse)
          return route.fulfill({
            status: 400,
            json: { success: false, message: 'Invalid selection fixture' },
          });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        ids = next;
      }
      return route.fulfill({ json: { success: true, data: { collectionIds: ids } } });
    });
    await page.goto('/collections');
    await expect(
      page.getByRole('heading', { name: copy.collections.featured.title, exact: true }),
    ).toBeVisible();
    await page.getByLabel(copy.collections.featured.add, { exact: true }).click();
    await expect(page.getByRole('option', { name: 'draft', exact: true })).toHaveCount(0);
    await expect(page.getByRole('option', { name: 'automated', exact: true })).toHaveCount(0);
    await page.getByRole('option', { name: 'two', exact: true }).click();
    await page
      .getByRole('button', {
        name: copy.collections.editor.earlier.replace('%{title}', 'two'),
        exact: true,
      })
      .click();
    const save = page.getByRole('button', { name: copy.common.save, exact: true });
    await save.click();
    await expect(page.getByText(copy.collections.featured.failed, { exact: true })).toBeVisible();
    expect(writes[0]).toEqual(['two', 'one']);
    await page
      .getByRole('button', {
        name: copy.collections.editor.remove.replace('%{title}', 'one'),
        exact: true,
      })
      .click();
    refuse = false;
    await save.click();
    await expect.poll(() => writes.length).toBe(2);
    await expect(save).toBeDisabled();
    await expect(
      page.getByRole('button', {
        name: copy.collections.editor.remove.replace('%{title}', 'two'),
        exact: true,
      }),
    ).toBeDisabled();
    release?.();
    await expect(page.getByText(copy.collections.featured.saved, { exact: true })).toBeVisible();
    expect(writes[1]).toEqual(['two']);
    await page.reload();
    await expect(
      page.getByRole('button', {
        name: copy.collections.editor.remove.replace('%{title}', 'two'),
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: copy.collections.editor.remove.replace('%{title}', 'one'),
        exact: true,
      }),
    ).toHaveCount(0);
    canWrite = false;
    await page.reload();
    await expect(page.getByRole('link', { name: 'two', exact: true })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: copy.collections.featured.title, exact: true }),
    ).toHaveCount(0);
  });
}
