import { expect, test } from '@playwright/test';
import type { Listing } from '../../../packages/shared-types/src';
import en from '../../../packages/ui/src/i18n/locales/en.json';
import ar from '../../../packages/ui/src/i18n/locales/ar.json';
import appEn from '../../../packages/frontend/lib/i18n/locales/en.json';
import appAr from '../../../packages/frontend/lib/i18n/locales/ar.json';

for (const { width, locale } of [{ width: 1440, locale: 'en' }, { width: 390, locale: 'ar' }]) {
  test(`review summary distinguishes failed reads and keeps cached ratings at ${width}px ${locale}`, async ({ page, context, request }) => {
    const feed = (await (await request.get('http://localhost:4160/listings?limit=100')).json()).data as Listing[];
    const listing = feed.find(item => item.title === 'Brilliant Eye Brightener');
    expect(listing).toBeTruthy();
    const endpoint = `/listings/${listing!.id}/reviews`;
    const original = await (await request.get(`http://localhost:4160${endpoint}?limit=12`)).json();
    expect(original.data.length).toBeGreaterThan(0);
    const copy = (locale === 'ar' ? ar : en).ui.review;
    const app = locale === 'ar' ? appAr : appEn;
    const empty = copy.empty.replace('%{subject}', app.reviews.scopeHeading.p2pListing);
    await page.addInitScript(locale => localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale }, version: 0 })), locale);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 1000 });
    let failing = true;
    let release: (() => void) | undefined;
    let gate: Promise<void> | undefined;
    await page.route(`**${endpoint}?*`, async route => {
      if (gate) await gate;
      if (failing) return route.fulfill({ status: 503, json: { success: false, error: 'Temporary test outage' } });
      return route.continue();
    });
    await page.goto(`/products/${listing!.id}`);
    const section = page.getByTestId('product-sections');
    const error = section.getByTestId('review-summary-error');
    await expect(error.getByRole('alert')).toHaveText(copy.loadError);
    await expect(section.getByText(empty, { exact: true })).toHaveCount(0);
    await error.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/mercaria-review-summary-error-${width}-${locale}.png` });
    const gallery = await page.getByTestId('product-gallery').elementHandle();
    failing = false;
    gate = new Promise<void>(resolve => { release = resolve; });
    try {
      await error.getByRole('button', { name: copy.retry, exact: true }).click();
      await expect(section.getByTestId('review-summary-loading')).toHaveText(copy.loading);
      await expect(section.getByText(empty, { exact: true })).toHaveCount(0);
    } finally { release?.(); }
    gate = undefined;
    await expect(error).toHaveCount(0);
    const average = section.getByTestId('review-rating-average');
    await expect(average).toBeVisible();
    const averageText = await average.textContent();
    const summaryNode = await average.elementHandle();
    // Make the two-minute query stale, then reconnect through the browser network state.
    // Only time and failed transport vary; retry reads the actual review records.
    failing = true;
    await page.clock.setFixedTime(new Date(Date.now() + 121_000));
    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await context.setOffline(false);
    await expect(error.getByRole('alert')).toHaveText(copy.loadError);
    await expect(average).toHaveText(averageText!);
    expect(await summaryNode!.evaluate(node => node.isConnected)).toBe(true);
    failing = false;
    await error.getByRole('button').click();
    await expect(error).toHaveCount(0);
    await expect(average).toHaveText(averageText!);
    expect(await summaryNode!.evaluate(node => node.isConnected)).toBe(true);
    expect(await gallery!.evaluate(node => node.isConnected)).toBe(true);
    await page.screenshot({ path: `/tmp/mercaria-review-summary-${width}-${locale}.png` });
  });
}

test('a canonical product keeps failed product and listing review scopes separate', async ({ page, request }) => {
  const handle = 'smartphone-kaido-vero-5';
  const catalog = (await (await request.get(`http://localhost:4160/product-page/${handle}`)).json()).data;
  const feed = (await (await request.get('http://localhost:4160/listings?limit=100')).json()).data as Listing[];
  const summary = feed.find(item => item.title === 'Brilliant Eye Brightener')!;
  const listing: Listing = (await (await request.get(`http://localhost:4160/listings/${summary.id}`)).json()).data;
  listing.canonicalProductId = catalog.product.id;
  await page.route(`**/listings/${listing.id}`, route => route.fulfill({ json: { success: true, data: listing } }));
  let productFailed = true;
  let listingFailed = true;
  await page.route(`**/reviews/product/${catalog.product.id}?*`, route => productFailed
    ? route.fulfill({ status: 503, json: { success: false } }) : route.continue());
  await page.route(`**/listings/${listing.id}/reviews?*`, route => listingFailed
    ? route.fulfill({ status: 503, json: { success: false } }) : route.continue());
  await page.addInitScript(() => localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 })));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/products/${listing.id}`);
  const section = page.getByTestId('product-sections');
  const errors = section.getByTestId('review-summary-error');
  await expect(errors).toHaveCount(2);
  productFailed = false;
  await errors.first().getByRole('button').click();
  await expect(errors).toHaveCount(1);
  // Product recovery must not imply that this listing's own feedback recovered.
  await expect(errors.getByRole('alert')).toHaveText(en.ui.review.loadError);
  listingFailed = false;
  await errors.getByRole('button').click();
  await expect(errors).toHaveCount(0);
  await expect(section.getByTestId('review-preview-carousel').first()).toBeVisible();
  productFailed = true;
  await page.goto(`/p/${handle}`);
  await expect(page.getByTestId('review-summary-error')).toBeVisible();
  productFailed = false;
  await page.getByTestId('review-summary-error').getByRole('button').click();
  await expect(page.getByTestId('review-summary-error')).toHaveCount(0);
});
