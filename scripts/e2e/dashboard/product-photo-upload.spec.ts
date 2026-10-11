import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

// Isolated API metadata/failure coverage only. IDs have no uploaded image;
// image transport returns 404, never fabricated successful pixels.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=',
  'base64',
);
for (const [width, locale] of [
  [1440, 'en'],
  [390, 'ar'],
] as const) {
  test(`isolated photo upload keeps gallery drafts and retries at ${width}px ${locale}`, async ({
    page,
  }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, 'light');
    await page.setViewportSize({ width, height: 1100 });
    await page.route(/https:\/\/[^/]+\/photo-(old|new)(?:\?.*)?$/, (route) =>
      route.fulfill({ status: 404, body: 'Missing isolated file' }),
    );
    const product = {
      id: 'photo-product',
      title: 'Product with gallery',
      description: '',
      status: 'draft',
      images: [{ fileId: 'photo-old', position: 0 }],
      variants: [],
      options: [],
      overriddenFields: [],
      quantity: 0,
      price: { amount: 1000, currency: 'EUR' },
    };
    let patchFails = true;
    const patches: object[] = [];
    const uploads: Buffer[] = [];
    let attempts = 0;
    let release: (() => void) | undefined;
    await page.route('**/admin/stores/*/products/media', async (route) => {
      attempts += 1;
      uploads.push(route.request().postDataBuffer()!);
      expect(route.request().headers()['content-type']).toBe('image/png');
      expect(route.request().headers()['x-owner-user-id']).toBeUndefined();
      if (attempts === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return route.fulfill({ status: 502, json: { success: false } });
      }
      return route.fulfill({
        json: {
          success: true,
          data: {
            kind: 'image',
            fileId: attempts === 2 ? 'https://external.test/not-an-id.jpg' : 'photo-new',
          },
        },
      });
    });
    await page.route('**/admin/stores/*/products/photo-product', (route) => {
      if (route.request().method() === 'PATCH') {
        const patch = route.request().postDataJSON();
        patches.push(patch);
        if (patchFails) return route.fulfill({ status: 503, json: { success: false } });
        if (patch.mediaFileIds)
          product.images = patch.mediaFileIds.map((fileId: string, position: number) => ({
            fileId,
            position,
          }));
      }
      return route.fulfill({ json: { success: true, data: product } });
    });
    await page.goto('/products/photo-product');
    const editor = page.getByTestId('merchant-product-photo-editor');
    const save = page.getByRole('button', { name: copy.products.detail.saveChanges, exact: true });
    await editor
      .locator('input[type=file]')
      .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });
    await expect.poll(() => attempts).toBe(1);
    await expect(save).toBeDisabled();
    release!();
    await expect(editor.getByRole('alert')).toHaveText(copy.products.media.failed);
    await expect(editor.getByTestId('merchant-product-media-tile')).toHaveCount(1);
    await editor.getByRole('button', { name: copy.common.retry, exact: true }).click();
    await expect.poll(() => attempts).toBe(2);
    await expect(editor.getByRole('alert')).toBeVisible();
    await editor.getByRole('button', { name: copy.common.retry, exact: true }).click();
    await expect(editor.getByTestId('merchant-product-media-tile')).toHaveCount(2);
    expect(uploads).toEqual([png, png, png]);
    await editor
      .getByRole('button', { name: copy.products.variants.media.earlier, exact: true })
      .nth(1)
      .click();
    await save.click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ mediaFileIds: ['photo-new', 'photo-old'] });
    await expect(editor.getByTestId('merchant-product-media-tile')).toHaveCount(2);
    patchFails = false;
    await save.click();
    await expect.poll(() => patches.length).toBe(2);
    await expect(save).toBeDisabled();
    await editor
      .getByRole('button', {
        name: copy.products.media.remove.replace('%{position}', '2'),
        exact: true,
      })
      .click();
    await save.click();
    await expect.poll(() => patches.length).toBe(3);
    expect(patches[2]).toEqual({ mediaFileIds: ['photo-new'] });
    await expect(editor.locator('img')).toHaveCount(0);
    await page.screenshot({
      path: `/tmp/mercaria-product-upload-${width}-${locale}.png`,
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
  test(`isolated new product persists uploaded IDs at ${width}px ${locale}`, async ({ page }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, 'light');
    await page.setViewportSize({ width, height: 1100 });
    await page.route(/https:\/\/[^/]+\/photo-new(?:\?.*)?$/, (route) =>
      route.fulfill({ status: 404, body: 'Missing isolated file' }),
    );
    await page.route('**/admin/stores/*/products/media', (route) =>
      route.fulfill({ json: { success: true, data: { fileId: 'photo-new', kind: 'image' } } }),
    );
    let created: { mediaFileIds?: string[] } | undefined;
    await page.route('**/admin/stores/*/products', (route) => {
      created = route.request().postDataJSON();
      return route.fulfill({ status: 503, json: { success: false } });
    });
    await page.goto('/products/new');
    await page
      .getByRole('textbox', { name: copy.common.title, exact: true })
      .fill('New photographed product');
    await page
      .getByRole('textbox', { name: copy.products.new.categoryLabel, exact: true })
      .fill('clothing');
    await page.getByRole('textbox', { name: copy.products.priceLabel, exact: true }).fill('12');
    const editor = page.getByTestId('merchant-product-photo-editor');
    await editor
      .locator('input[type=file]')
      .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });
    await expect(editor.getByTestId('merchant-product-media-tile')).toHaveCount(1);
    await page.getByRole('button', { name: copy.products.new.submit, exact: true }).click();
    await expect.poll(() => created?.mediaFileIds).toEqual(['photo-new']);
    await expect(editor.getByTestId('merchant-product-media-tile')).toHaveCount(1);
    await expect(page.getByRole('textbox', { name: copy.common.title, exact: true })).toHaveValue(
      'New photographed product',
    );
  });
}

test('wizard keeps upload mounted across steps and autosaves only explicit image edits', async ({
  page,
}) => {
  await fixture(page, 'en', 'light');
  await page.route(/https:\/\/[^/]+\/photo-new(?:\?.*)?$/, (route) =>
    route.fulfill({ status: 404, body: 'Missing isolated file' }),
  );
  const draft = {
    id: 'photo-draft',
    version: 1,
    status: 'open',
    categoryId: 'category-one',
    productType: { key: 'photo-type', version: 1 },
    market: 'ES',
    locale: 'en',
    title: 'Draft product',
    description: '',
    tags: [],
    selectedCanonicalProductId: null,
    values: [],
    variants: [],
    imageFileIds: [] as string[],
  };
  const schema = {
    contractVersion: 1,
    productType: {
      definitionId: 'type-one',
      key: 'photo-type',
      version: 1,
      lifecycle: 'published',
      pendingProposalPolicy: 'block',
    },
    categoryId: 'category-one',
    flow: 'guided',
    market: 'ES',
    locale: { requested: 'en', resolved: 'en', fallbackChain: ['en'] },
    permissions: {
      canEditDraft: true,
      canPublish: true,
      canProposeValues: false,
      canSelectCanonicalEntity: false,
    },
    steps: [],
    groups: [],
    fields: [],
    text: { groups: {}, fields: {}, values: {} },
    etag: 'fixture-schema',
  };
  await page.route('**/catalog-authoring/schemas/photo-type?**', (route) =>
    route.fulfill({ json: { success: true, data: { schema } } }),
  );
  const patches: { version: number; imageFileIds?: string[] }[] = [];
  await page.route('**/stores/*/product-drafts/photo-draft', (route) => {
    if (route.request().method() === 'PATCH') {
      const patch = route.request().postDataJSON();
      patches.push(patch);
      draft.version += 1;
      if (patch.imageFileIds) draft.imageFileIds = patch.imageFileIds;
    }
    return route.fulfill({ json: { success: true, data: { draft } } });
  });
  let release: (() => void) | undefined;
  await page.route('**/admin/stores/*/products/media', async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return route.fulfill({ json: { success: true, data: { fileId: 'photo-new' } } });
  });
  await page.goto('/products/wizard/photo-draft');
  const editor = page.getByTestId('merchant-product-photo-editor');
  await page.getByRole('tab', { name: en.products.wizard.steps.listing, exact: true }).click();
  await editor
    .locator('input[type=file]')
    .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByRole('tab', { name: en.products.wizard.steps.review, exact: true }).click();
  const listingPanel = page.getByTestId('merchant-wizard-listing-panel');
  await expect(listingPanel).toHaveAttribute('inert');
  await expect(listingPanel).toHaveAttribute('aria-hidden', 'true');
  await expect(listingPanel.getByRole('textbox')).toHaveCount(0);
  await page.keyboard.press('Tab');
  expect(await listingPanel.evaluate((element) => element.contains(document.activeElement))).toBe(
    false,
  );
  await expect(
    page.getByRole('button', { name: en.products.wizard.publish.publish, exact: true }),
  ).toBeDisabled();
  expect(patches).toEqual([]);
  release!();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toMatchObject({ version: 1, imageFileIds: ['photo-new'] });
  await expect(
    page.getByTestId('merchant-wizard-review').getByTestId('merchant-product-media-tile'),
  ).toHaveCount(1);
  await page.getByRole('tab', { name: en.products.wizard.steps.listing, exact: true }).click();
  await expect(editor.getByTestId('merchant-product-media-tile')).toHaveCount(1);
  await editor
    .getByRole('button', {
      name: en.products.photos.remove.replace('%{position}', '1'),
      exact: true,
    })
    .click();
  await expect.poll(() => patches.length).toBe(2);
  expect(patches[1]).toMatchObject({ version: 2, imageFileIds: [] });
});
