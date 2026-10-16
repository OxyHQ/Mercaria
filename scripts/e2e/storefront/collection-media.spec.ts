import { expect, test } from '@playwright/test';

for (const width of [390, 1440]) {
  test(`store collections resolve Oxy IDs in chips, tiles and menu at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(() =>
      localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 })),
    );
    const feed = await (await request.get('http://localhost:4160/feed')).json();
    const product = feed.data.sections
      .flatMap((section: { products?: { id: string; title: string }[] }) => section.products ?? [])
      .find((item: { title: string }) => item.title === 'Brilliant Eye Brightener');
    expect(product, 'Requires the real local media seed').toBeTruthy();
    const listing = (
      await (await request.get(`http://localhost:4160/listings/${product.id}`)).json()
    ).data;
    const imageFileId = listing.images[0].fileId;
    await page.goto(`/products/${product.id}`);
    const realImage = page.locator(`img[src*="${imageFileId}"]`).first();
    await expect
      .poll(() =>
        realImage.evaluate(
          (node) => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0,
        ),
      )
      .toBe(true);
    const imageUrl = await realImage.getAttribute('src');
    const supplier = 'https://supplier.example/collection.jpg';
    const external: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith('https://supplier.example/')) external.push(request.url());
    });
    const base = {
      storeId: listing.store.id,
      type: 'manual',
      productIds: [],
      sortOrder: 'manual',
      isPublished: true,
      createdAt: '2026-10-10T00:00:00Z',
      updatedAt: '2026-10-10T00:00:00Z',
    };
    // Only collection metadata is varied. Actual Oxy image requests/bytes are
    // never intercepted; an invalid present ID must not fall back to a URL.
    await page.route(`**/stores/${listing.store.handle}/collections`, (route) =>
      route.fulfill({
        json: {
          success: true,
          data: [
            {
              ...base,
              id: 'image-collection',
              handle: 'image-collection',
              title: 'Oxy collection',
              imageFileId,
              imageUrl: supplier,
            },
            {
              ...base,
              id: 'invalid-collection',
              handle: 'invalid-collection',
              title: 'Invalid URL collection',
              imageFileId: supplier,
              imageUrl,
            },
            {
              ...base,
              id: 'legacy-collection',
              handle: 'legacy-collection',
              title: 'Legacy Oxy collection',
              imageUrl,
            },
          ],
        },
      }),
    );
    await page.goto(`/stores/${listing.store.handle}`);
    async function assertImages(title: string, count: number) {
      const images = page.getByRole('button', { name: title, exact: true }).locator('img');
      await expect(images).toHaveCount(count);
      for (const image of await images.all()) {
        await image.scrollIntoViewIfNeeded();
        await expect
          .poll(() =>
            image.evaluate(
              (node) => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0,
            ),
          )
          .toBe(true);
        await expect(image).toHaveAttribute('src', new RegExp(imageFileId));
      }
    }
    await assertImages('Oxy collection', 2);
    await assertImages('Legacy Oxy collection', 2);
    await assertImages('Invalid URL collection', 0);
    await page
      .getByRole('button', { name: `Open ${listing.store.name} menu`, exact: true })
      .click();
    await assertImages('Oxy collection', 1);
    await assertImages('Legacy Oxy collection', 1);
    await assertImages('Invalid URL collection', 0);
    expect(external).toEqual([]);
  });
}
