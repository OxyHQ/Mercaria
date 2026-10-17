import { expect, test } from '@playwright/test';
import type { ProductSummary } from '../../../packages/shared-types/src';

for (const width of [390, 1440]) {
  test(`persisted history keeps navigation without requesting old supplier images at ${width}px`, async ({
    page,
    request,
  }) => {
    const feed = await (await request.get('http://localhost:4160/feed')).json();
    const product: ProductSummary = feed.data.sections
      .filter((section: { kind: string }) => section.kind === 'products')
      .flatMap((section: { products: ProductSummary[] }) => section.products)[0];
    expect(product).toBeTruthy();
    const supplierOrigin = 'https://legacy-supplier.example.test';
    const title = 'Persisted shopping conversation';
    // Exercise real persisted pre-migration DTOs. No image or API interception.
    await page.addInitScript(
      ({ product, supplierOrigin, title }) => {
        localStorage.setItem(
          'i18n-storage',
          JSON.stringify({ state: { locale: 'en' }, version: 0 }),
        );
        localStorage.setItem(
          'mercaria.bloom.theme',
          JSON.stringify({ mode: 'light', colorPreset: 'mono' }),
        );
        localStorage.setItem(
          'mercaria.shopping-history',
          JSON.stringify({
            version: 0,
            state: {
              products: [
                {
                  owner: 'guest',
                  product: {
                    ...product,
                    imageFileId: undefined,
                    imageUrl: `${supplierOrigin}/recent-product.jpg`,
                  },
                },
              ],
              threads: [
                {
                  id: 'legacy-history',
                  owner: 'guest',
                  title,
                  preview: false,
                  updatedAt: new Date().toISOString(),
                  messages: [
                    { role: 'user', content: title },
                    {
                      role: 'assistant',
                      content: 'Your previous results',
                      examples: [
                        {
                          ...product,
                          imageFileId: undefined,
                          imageUrl: `${supplierOrigin}/thread-product.jpg`,
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          }),
        );
      },
      { product, supplierOrigin, title },
    );
    const supplierRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().startsWith(supplierOrigin)) supplierRequests.push(req.url());
    });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    const recent = page.getByTestId('recently-viewed-shelf');
    await expect(recent.getByRole('link', { name: product.title, exact: true })).toBeVisible();
    await expect(recent.locator('img')).toHaveCount(0);
    // A conversation a device stored before conversations moved to Alia is
    // dropped by the store's migration, never shown: "Keep shopping" is the
    // person's Alia conversations started in Mercaria.
    await expect(page.getByTestId('feed-thread-card').filter({ hasText: title })).toHaveCount(0);
    await recent.getByRole('link', { name: product.title, exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`/products/${product.id}$`));
    await expect(page.getByText(product.title, { exact: true }).first()).toBeVisible();
    expect(supplierRequests).toEqual([]);
  });
}
