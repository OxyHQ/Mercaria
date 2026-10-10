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
  test(`merchant media uses Oxy IDs and preserves saved media at ${width}px ${locale} ${mode}`, async ({
    page,
  }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode);
    await page.setViewportSize({ width, height: 1000 });
    const external: string[] = [];
    const mediaRequests: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (request.url().includes('untrusted.example.test')) external.push(request.url());
    });
    await page.route(/https:\/\/[^/]+\/media-(first|second)(?:\?.*)?$/, (route) => {
      const url = new URL(route.request().url());
      mediaRequests.push(url.href);
      if (url.pathname.endsWith('media-first') && url.searchParams.get('variant') === 'thumb')
        return route.fulfill({ status: 404, body: '' });
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="${url.pathname.endsWith('media-first') ? '#e5dac9' : '#c5d8d4'}"/><path d="M45 24 25 48 42 62 42 120 102 120 102 62 119 48 99 24 84 30 60 30Z" fill="#fdfaf4"/></svg>`,
      });
    });
    const product = {
      id: 'media-product',
      title: 'Linen studio shirt',
      description: 'A lightweight linen shirt.',
      status: 'draft',
      images: [
        { fileId: 'media-first', alt: 'Front photograph', position: 0 },
        { fileId: 'media-second', alt: 'Back photograph', position: 1 },
        { fileId: 'https://untrusted.example.test/forbidden.png', alt: 'Legacy URL', position: 2 },
        { fileId: 'data:image/png;base64,invalid', position: 3 },
      ],
      variants: [],
      options: [],
      quantity: 8,
      overriddenFields: [],
      price: { amount: 4900, currency: 'EUR' },
    };
    const patches: Record<string, unknown>[] = [];
    await page.route('**/admin/stores/*/products/media-product', (route) => {
      if (route.request().method() === 'PATCH') {
        const patch = route.request().postDataJSON();
        patches.push(patch);
        Object.assign(product, patch);
      }
      return route.fulfill({ json: { success: true, data: product } });
    });
    await page.goto('/products/media-product');
    const gallery = page.getByTestId('merchant-product-media');
    const tiles = gallery.getByTestId('merchant-product-media-tile');
    await expect(tiles).toHaveCount(4);
    await expect(tiles.nth(2)).toBeDisabled();
    await expect(tiles.nth(3)).toBeDisabled();
    await expect
      .poll(() =>
        mediaRequests.some(
          (url) => new URL(url).pathname.endsWith('media-first') && !new URL(url).search,
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        tiles
          .nth(0)
          .locator('img')
          .evaluateAll((images) =>
            images.some((image) => image.complete && image.naturalWidth > 0),
          ),
      )
      .toBe(true);
    const bounds = await tiles.nth(0).boundingBox();
    expect(bounds!.width).toBe(width < 768 ? 112 : 144);
    expect(bounds!.height).toBe(bounds!.width);
    await tiles.nth(1).focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('button', { name: /Close|إغلاق/, exact: true }).first(),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /Close|إغلاق/, exact: true })).toHaveCount(0);
    const detail = page.getByTestId('merchant-product-detail');
    await detail
      .getByRole('textbox', { name: copy.common.title, exact: true })
      .fill('Edited linen shirt');
    await detail
      .getByRole('button', { name: copy.products.detail.saveChanges, exact: true })
      .click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).not.toHaveProperty('images');
    expect(patches[0]).not.toHaveProperty('imageFileIds');
    await expect(tiles).toHaveCount(4);
    await expect(tiles.nth(0).locator('img')).toHaveAttribute('src', /\/media-first$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `/tmp/mercaria-product-media-${width}-${locale}-${mode}.png`,
      fullPage: true,
    });
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
  });
}
