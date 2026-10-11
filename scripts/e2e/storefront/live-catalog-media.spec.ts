import { expect, test } from '@playwright/test';
import type { Feed } from '../../../packages/shared-types/src';

// Live acceptance: no route interception, image fixtures or invented file IDs.
// Requires the local catalog's real Oxy media import to have completed.
for (const width of [1440, 390]) {
  test(`synchronized catalog images load from Oxy at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 1000 });
    const feedResponse = await request.get('http://localhost:4160/feed');
    expect(feedResponse.ok()).toBe(true);
    const { data }: { data: Feed } = await feedResponse.json();
    const products = data.sections.flatMap((section) =>
      section.kind === 'products' ? section.products : [],
    );
    expect(products.length).toBeGreaterThan(0);
    for (const product of products) expect(product.imageFileId).toMatch(/^[A-Za-z0-9_-]+$/);
    const supplierRequests: string[] = [];
    page.on('request', (req) => {
      if (/shopifycdn\.com|cdn\.shopify\.com/.test(req.url())) supplierRequests.push(req.url());
    });
    await page.addInitScript(() => {
      localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const hero = page.getByTestId('home-hero');
    await expect(hero).toBeVisible();
    if (width >= 768) {
      await expect
        .poll(
          () =>
            hero
              .locator('img')
              .evaluateAll(
                (images) =>
                  images.filter(
                    (image) =>
                      image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
                  ).length,
              ),
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0);
      await expect(hero.getByText('No image', { exact: true })).toHaveCount(0);
    }
    const photo = page.locator(`img[src*="${products[0].imageFileId}"]`).first();
    await photo.scrollIntoViewIfNeeded();
    await expect
      .poll(
        () =>
          photo.evaluate(
            (image) =>
              image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    expect(supplierRequests).toEqual([]);
    await page.screenshot({ path: `/tmp/mercaria-live-media-${width}.png` });
  });
}
