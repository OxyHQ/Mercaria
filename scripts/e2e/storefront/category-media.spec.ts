import { expect, test } from '@playwright/test';

// Negative compatibility checks for older cached DTOs. Only API metadata is
// supplied; no image bytes or successful Oxy response is intercepted.
for (const width of [390, 1440]) {
  test(`old category URLs never become supplier image requests at ${width}px`, async ({ page, request }) => {
    const supplier = 'https://unsynced-supplier.invalid/category.jpg';
    const requested: string[] = [];
    page.on('request', req => { if (req.url().startsWith('https://unsynced-supplier.invalid/')) requested.push(req.url()); });
    // A regression must fail the request-count assertion, without contacting a supplier.
    await page.route('https://unsynced-supplier.invalid/**', route => route.abort());
    await page.addInitScript(() => {
      localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
      localStorage.setItem('mercaria.bloom.theme', JSON.stringify({ mode: 'light', colorPreset: 'mono' }));
    });
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const home = await (await request.get('http://localhost:4160/feed')).json();
    const pills = home.data.sections.find((section: { kind: string }) => section.kind === 'category-pills');
    expect(pills.pills.length).toBeGreaterThan(0);
    for (const pill of pills.pills) { delete pill.imageFileId; pill.imageUrl = supplier; }
    await page.route('http://localhost:4160/feed', route => route.fulfill({ json: home }));
    await page.goto('/');
    const chipRow = page.getByTestId('category-pills');
    await expect(chipRow.getByTestId('category-pill-image-fallback').first()).toBeVisible();
    await expect(chipRow.locator('img')).toHaveCount(0);
    expect(requested).toEqual([]);

    const discovery = await (await request.get('http://localhost:4160/discovery/feed?scope=root')).json();
    const tiles = discovery.data.sections.find((section: { kind: string }) => section.kind === 'category-tiles');
    expect(tiles.tiles.length).toBeGreaterThan(0);
    for (const tile of tiles.tiles) {
      delete tile.imageFileId; delete tile.sampleImageFileIds;
      tile.imageUrl = supplier; tile.sampleImageUrls = [supplier];
    }
    await page.route('http://localhost:4160/discovery/feed?scope=root', route => route.fulfill({ json: discovery }));
    await page.goto('/explore');
    const tile = page.getByRole('link', { name: tiles.tiles[0].name, exact: true }).first();
    await expect(tile).toBeVisible();
    await expect(tile.locator('img')).toHaveCount(0);
    await expect(tile).toContainText('No image');
    expect(requested).toEqual([]);
  });
}
