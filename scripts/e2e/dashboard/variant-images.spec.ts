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
  test(`variant gallery selection is ordered and honest about missing media at ${width}px ${locale} ${mode}`, async ({
    page,
  }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode);
    await page.setViewportSize({ width, height: 1100 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const external: string[] = [];
    const failedMedia: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('untrusted.example.test')) external.push(request.url());
    });
    // The local catalogue has no verified imported photos. Exercise failure
    // explicitly; never fulfill an image with invented successful image bytes.
    await page.route(/https:\/\/[^/]+\/unavailable-variant-(front|back)(?:\?.*)?$/, (route) => {
      failedMedia.push(route.request().url());
      return route.abort('failed');
    });
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
    const gallery = [
      { fileId: 'unavailable-variant-front', alt: 'Front photograph', position: 0 },
      { fileId: 'unavailable-variant-back', alt: 'Back photograph', position: 1 },
      {
        fileId: 'https://untrusted.example.test/forbidden.png',
        alt: 'Legacy external photograph',
        position: 2,
      },
    ];
    const variant = {
      id: 'gallery-variant',
      title: 'Natural / Medium',
      available: 5,
      inStock: true,
      price: { amount: 4900, currency: 'EUR' },
      optionValues: [],
      images: { source: 'listing_fallback', images: gallery },
    };
    const product = {
      id: 'gallery-product',
      title: 'Linen studio shirt',
      description: 'A linen shirt.',
      category: 'clothing',
      status: 'draft',
      tags: [],
      images: gallery,
      variants: [variant],
      options: [],
      quantity: 5,
      overriddenFields: [],
      price: variant.price,
    };
    let productReadError = false;
    await page.route('**/admin/stores/*/products/gallery-product', (route) =>
      productReadError
        ? route.fulfill({ status: 502, json: { success: false, message: 'Fixture read failure' } })
        : route.fulfill({ json: { success: true, data: product } }),
    );
    let readError = true;
    let fail = true;
    let hold = true;
    let selections: typeof gallery = [];
    let release: (() => void) | undefined;
    const writes: { id: string; method: string; body: unknown }[] = [];
    let reads = 0;
    await page.route('**/products/gallery-product/variants/*/images', async (route) => {
      if (route.request().method() === 'GET') {
        reads++;
        return readError
          ? route.fulfill({
              status: 502,
              json: { success: false, message: 'Fixture selection read failure' },
            })
          : route.fulfill({ json: { success: true, data: selections } });
      }
      const body = route.request().postDataJSON();
      writes.push({
        id: route.request().url().split('/').at(-2)!,
        method: route.request().method(),
        body,
      });
      if (fail)
        return route.fulfill({
          status: 409,
          json: { success: false, message: 'Fixture conflict' },
        });
      if (hold)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      selections = body.fileIds.map((id: string, position: number) => ({
        ...gallery.find((image) => image.fileId === id)!,
        position,
      }));
      variant.images = {
        source: selections.length ? 'variant' : 'listing_fallback',
        images: selections.length ? selections : product.images,
      };
      return route.fulfill({ json: { success: true, data: selections } });
    });
    await page.goto('/products/gallery-product');
    const editor = page.getByTestId('merchant-variant-images');
    const manage = editor.getByRole('button', {
      name: copy.products.variants.media.manage,
      exact: true,
    });
    await expect(
      editor.getByText(copy.products.variants.media.fallback, { exact: true }).first(),
    ).toBeVisible();
    await expect(editor.getByTestId('merchant-variant-image-picker')).toHaveCount(0);
    expect(reads).toBe(0);
    await manage.click();
    const picker = page.getByTestId('merchant-variant-image-picker');
    const save = picker.getByRole('button', { name: copy.common.save, exact: true });
    const cancel = picker.getByRole('button', { name: copy.common.cancel, exact: true });
    const choices = picker.getByTestId('merchant-variant-image-choice');
    await expect(
      picker.getByText(copy.products.variants.media.loadFailed, { exact: true }),
    ).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(
      picker.getByRole('checkbox', { name: 'Front photograph', exact: true }),
    ).toBeDisabled();
    readError = false;
    await picker.getByRole('button', { name: copy.common.retry, exact: true }).click();
    await expect(
      picker.getByRole('checkbox', { name: 'Front photograph', exact: true }),
    ).toBeEnabled();
    await expect(choices).toHaveCount(2);
    await picker.getByRole('checkbox', { name: 'Front photograph', exact: true }).check();
    await picker.getByRole('checkbox', { name: 'Back photograph', exact: true }).check();
    await choices
      .first()
      .getByRole('button', { name: copy.products.variants.media.later, exact: true })
      .click();
    await expect(choices.first().getByRole('checkbox')).toHaveAccessibleName('Back photograph');
    // Folding is navigation, not cancellation: retain ordering and selection,
    // while Bloom excludes hidden controls from keyboard/accessibility access.
    await manage.click();
    await expect(picker).toHaveAttribute('inert');
    await expect(picker).toHaveAttribute('aria-hidden', 'true');
    await expect(choices).toHaveCount(2);
    await expect(picker.getByRole('checkbox')).toHaveCount(0);
    await manage.focus();
    await page.keyboard.press('Tab');
    expect(await picker.evaluate((element) => element.contains(document.activeElement))).toBe(
      false,
    );
    await manage.click();
    await expect(choices.first().getByRole('checkbox')).toHaveAccessibleName('Back photograph');
    await expect(
      picker.getByRole('checkbox', { name: 'Front photograph', exact: true }),
    ).toBeChecked();
    await expect(
      picker.getByRole('checkbox', { name: 'Back photograph', exact: true }),
    ).toBeChecked();
    expect(writes).toEqual([]);
    // Only explicit Cancel discards the draft without writing; reopening follows
    // the latest server selection, including a change made while folded.
    await cancel.click();
    await expect(picker).toHaveAttribute('inert');
    selections = [gallery[0]];
    await manage.click();
    await expect(
      picker.getByRole('checkbox', { name: 'Front photograph', exact: true }),
    ).toBeChecked();
    await expect(
      picker.getByRole('checkbox', { name: 'Back photograph', exact: true }),
    ).not.toBeChecked();
    await expect(save).toBeDisabled();
    expect(writes).toEqual([]);
    await picker.getByRole('checkbox', { name: 'Back photograph', exact: true }).check();
    await choices
      .first()
      .getByRole('button', { name: copy.products.variants.media.later, exact: true })
      .click();
    await save.click();
    await expect(
      picker.getByText(copy.products.variants.media.saveFailed, { exact: true }),
    ).toBeVisible();
    const expected = {
      id: 'gallery-variant',
      method: 'PUT',
      body: { fileIds: ['unavailable-variant-back', 'unavailable-variant-front'] },
    };
    expect(writes).toEqual([expected]);
    await expect(choices.first().getByRole('checkbox')).toBeChecked();
    await manage.click();
    await expect(picker).toHaveAttribute('inert');
    await manage.click();
    await expect(
      picker.getByText(copy.products.variants.media.saveFailed, { exact: true }),
    ).toBeVisible();
    await expect(choices.first().getByRole('checkbox')).toHaveAccessibleName('Back photograph');
    await expect(choices.first().getByRole('checkbox')).toBeChecked();
    await expect
      .poll(() =>
        failedMedia.some(
          (url) => url.includes('unavailable-variant-front') && !new URL(url).search,
        ),
      )
      .toBe(true);
    await expect.poll(() => choices.locator('img').count()).toBe(0); // Failed originals become stable placeholders, not fabricated images.
    await picker.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `/tmp/mercaria-variant-images-${width}-${locale}-${mode}.png`,
      fullPage: true,
    });
    fail = false;
    await save.click();
    await expect.poll(() => writes.length).toBe(2);
    await expect(save).toBeDisabled();
    await expect(cancel).toBeDisabled();
    await expect(manage).toBeEnabled();
    await manage.click();
    await expect(picker).toHaveAttribute('inert');
    await manage.click();
    await expect(save).toBeDisabled();
    await expect(cancel).toBeDisabled();
    await expect(choices.first().getByRole('checkbox')).toHaveAccessibleName('Back photograph');
    await expect(choices.first().getByRole('checkbox')).toBeDisabled();
    readError = true;
    productReadError = true;
    release!();
    await expect(picker).toHaveAttribute('inert');
    await expect(
      editor.getByText(copy.products.variants.media.selected.replace('%{count}', '2'), {
        exact: true,
      }),
    ).toBeVisible();
    await manage.click();
    await expect(
      picker.getByText(copy.products.variants.media.loadFailed, { exact: true }),
    ).toBeVisible();
    await expect(save).toBeDisabled();
    readError = false;
    await picker.getByRole('button', { name: copy.common.retry, exact: true }).click();
    await expect(choices.first().getByRole('checkbox')).toHaveAccessibleName('Back photograph');
    await expect(choices.first().getByRole('checkbox')).toBeChecked();
    await picker
      .getByRole('button', { name: copy.products.variants.media.useGallery, exact: true })
      .click();
    hold = false;
    await save.click();
    await expect(picker).toHaveAttribute('inert');
    await expect(
      editor.getByText(copy.products.variants.media.fallback, { exact: true }).first(),
    ).toBeVisible();
    expect(writes).toEqual([
      expected,
      expected,
      { id: 'gallery-variant', method: 'PUT', body: { fileIds: [] } },
    ]);
    productReadError = false;
    writable = false;
    const priorReads = reads;
    await page.reload();
    await expect(
      editor.getByText(copy.products.variants.media.fallback, { exact: true }).first(),
    ).toBeVisible();
    await expect(manage).toHaveCount(0);
    expect(reads).toBe(priorReads);
    writable = true;
    product.images = [];
    variant.images = { source: 'listing_fallback', images: [] };
    await page.reload();
    await manage.click();
    await expect(
      picker.getByText(copy.products.variants.media.empty, { exact: true }),
    ).toBeVisible();
    await expect(choices).toHaveCount(0);
    await expect(save).toBeDisabled();
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
    expect(writes).toHaveLength(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
