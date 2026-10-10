import { expect, test } from '@playwright/test';
import en from '../../../packages/frontend/lib/i18n/locales/en.json';

for (const width of [390, 1440]) {
  test(`review search keeps its summary and controls mounted during latency and failure at ${width}px`, async ({ page, request }) => {
    const listings = await (await request.get('http://localhost:4160/listings?limit=100')).json();
    const product = listings.data.find((item: { title: string }) => item.title === 'Brilliant Eye Brightener');
    expect(product, 'Requires the local review seed').toBeTruthy();
    const endpoint = `/listings/${product.id}/reviews`;
    const original = await (await request.get(`http://localhost:4160${endpoint}?limit=12`)).json();
    expect(original.data.length).toBeGreaterThan(0);
    await page.addInitScript(() => {
      localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
      localStorage.setItem('mercaria.bloom.theme', JSON.stringify({ mode: 'light', colorPreset: 'mono' }));
    });
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/products/${product.id}`);
    await page.getByTestId('product-sections').getByRole('button', { name: 'Read more reviews', exact: true }).click();
    const dialog = page.getByTestId('product-reviews-dialog');
    const input = dialog.getByPlaceholder('Search reviews', { exact: true });
    const summary = dialog.getByTestId('review-rating-average');
    await expect(dialog.getByTestId(`review-${original.data[0].id}`)).toBeVisible();
    const average = await summary.textContent();
    const summaryNode = await summary.elementHandle();
    const inputY = (await input.boundingBox())!.y;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let fail = true;
    // Delay a real review request, then simulate a transport failure. No image
    // responses or review records are replaced. Retry reaches the real API.
    await page.route(`**${endpoint}?**`, async route => {
      if (new URL(route.request().url()).searchParams.get('query') !== 'glow') return route.continue();
      await held;
      if (fail) return route.fulfill({ status: 503, json: { success: false, error: 'Temporary test outage' } });
      return route.continue();
    });
    try {
      await input.fill('glow');
      await input.press('Enter');
      await expect(dialog.getByTestId('review-list-loading')).toBeVisible();
      await expect(summary).toHaveText(average!);
      expect(await summaryNode!.evaluate(node => node.isConnected)).toBe(true);
      expect(Math.abs((await input.boundingBox())!.y - inputY)).toBeLessThan(1);
      await expect(dialog.getByTestId(`review-${original.data[0].id}`)).toHaveCount(0);
      await page.screenshot({ path: `/tmp/mercaria-review-loading-pending-${width}.png` });
      release();
      const retry = dialog.getByRole('button', { name: en.common.tryAgain, exact: true });
      await expect(retry).toBeVisible();
      await expect(dialog.getByTestId('review-list-loading')).toHaveCount(0);
      await expect(summary).toHaveText(average!);
      expect(await summaryNode!.evaluate(node => node.isConnected)).toBe(true);
      fail = false;
      await retry.click();
      await expect(dialog.getByText(/^Search results:/)).toBeVisible();
      await expect(summary).toHaveText(average!);
      expect(await summaryNode!.evaluate(node => node.isConnected)).toBe(true);
      await page.screenshot({ path: `/tmp/mercaria-review-loading-${width}.png` });
    } finally {
      release();
    }
  });
}
