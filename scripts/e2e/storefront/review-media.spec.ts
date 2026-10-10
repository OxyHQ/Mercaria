import { expect, test } from '@playwright/test';
import type { Review, ReviewMediaItem } from '../../../packages/shared-types/src';

for (const { width, height } of [{ width: 390, height: 1000 }, { width: 1440, height: 1000 }, { width: 1440, height: 600 }]) {
  test(`review media failure preserves review, navigation, pagination and parent sheet at ${width}x${height}`, async ({ page, request }) => {
    const listings = await (await request.get('http://localhost:4160/listings?limit=100')).json();
    const product = listings.data.find((item: { title: string }) => item.title === 'Brilliant Eye Brightener');
    expect(product).toBeTruthy();
    const endpoint = `/listings/${product.id}/reviews`;
    const original = await (await request.get(`http://localhost:4160${endpoint}?limit=12`)).json();
    const review: Review = original.data[0];
    expect(review).toBeTruthy();
    expect(original.data[1]).toBeTruthy();
    const externalImages: string[] = [];
    page.on('request', request => { if (request.url().startsWith('https://supplier-images.invalid/')) externalImages.push(request.url()); });
    const entries: ReviewMediaItem[] = [0, 1, 2].map(index => {
      const media = { id: `missing-attachment-${index}`, fileId: `unavailable-review-media-test-${index}`, kind: index === 2 ? 'video' as const : 'image' as const, position: index };
      const source = original.data[index % 2];
      return { media, review: { ...source, author: { ...source.author, avatar: 'https://supplier-images.invalid/old-avatar.jpg' }, media: [media] } };
    });
    // A controlled missing-file/transport test, NOT a successful upload test.
    // Never substitute image bytes or use these IDs in persisted catalog data.
    await page.route('https://cloud.oxy.so/unavailable-review-media-test-*', route => route.fulfill({ status: 404 }));
    let secondPageRequests = 0;
    let failMore = true;
    await page.route(new RegExp(`${endpoint}/media(?:\\?.*)?$`), route => {
      const secondPage = new URL(route.request().url()).searchParams.get('page') === '2';
      if (secondPage) {
        secondPageRequests++;
        if (failMore) return route.fulfill({ status: 503, json: { success: false, error: 'Temporary test outage' } });
      }
      return route.fulfill({ json: { success: true, data: secondPage ? entries.slice(2) : entries.slice(0, 2),
        pagination: { page: secondPage ? 2 : 1, limit: 10, total: 3, totalPages: 2, hasNextPage: !secondPage, hasPrevPage: secondPage } } });
    });
    await page.addInitScript(() => {
      localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
      localStorage.setItem('mercaria.bloom.theme', JSON.stringify({ mode: 'light', colorPreset: 'mono' }));
    });
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/products/${product.id}`);
    await page.getByTestId('product-sections').getByRole('button', { name: 'Read more reviews', exact: true }).click();
    const sheet = page.getByTestId('product-reviews-dialog');
    const open = sheet.getByRole('button', { name: 'View review photo 1', exact: true });
    await expect(open).toBeVisible();
    await open.click();
    const viewer = page.getByTestId('review-media-viewer');
    await expect(viewer).toBeVisible();
    const close = viewer.getByRole('button', { name: 'Close', exact: true });
    expect((await close.boundingBox())!.width).toBe(44);
    if (width >= 976) expect(await viewer.evaluate(node => getComputedStyle(node).borderTopLeftRadius)).toBe('40px');
    await expect(viewer.getByTestId(`review-${review.id}`)).toBeVisible();
    await expect(viewer.getByTestId('review-media-stage').getByText('This media could not be loaded.').first()).toBeVisible();
    await viewer.getByTestId('review-media-thumbnails').getByRole('button', { name: 'View review photo 2', exact: true }).click();
    await expect(viewer.getByTestId('review-media-thumbnails').getByRole('button', { name: 'View review photo 2', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const detail = viewer.getByTestId('review-media-associated-review');
    await expect(detail.getByTestId(`review-${original.data[1].id}`)).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
    failMore = false;
    await detail.getByRole('button', { name: 'Try again', exact: true }).click();
    const third = viewer.getByTestId('review-media-thumbnails').getByRole('button', { name: 'View review video 3', exact: true });
    await expect(third).toBeVisible();
    await third.click();
    await expect(third).toHaveAttribute('aria-pressed', 'true');
    expect(secondPageRequests).toBeGreaterThan(1);
    await expect(viewer.getByRole('button', { name: 'Go to the next item', exact: true })).toBeHidden();
    await expect(detail.getByTestId(`review-${review.id}`)).toBeVisible();
    await expect(viewer.getByTestId('review-media-stage').getByRole('alert').last()).toHaveText('This media could not be loaded.');
    await page.screenshot({ path: `/tmp/mercaria-review-media-failure-${width}-${height}.png` });
    await viewer.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(viewer).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await expect(open).toBeFocused();
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(sheet).toHaveCount(0);
    expect(externalImages).toEqual([]);
  });
}
