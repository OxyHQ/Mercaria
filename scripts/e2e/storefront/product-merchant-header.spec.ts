import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Listing } from '../../../packages/shared-types/src';

async function product(request: APIRequestContext): Promise<Listing> {
  const response = await request.get('http://localhost:4160/listings?limit=100');
  const listing = (await response.json()).data.find((entry: Listing) => entry.title === 'Brilliant Eye Brightener');
  expect(listing).toBeTruthy();
  const detail = (await (await request.get(`http://localhost:4160/listings/${listing.id}`)).json()).data;
  expect(detail.store?.handle).toBeTruthy();
  return detail;
}

for (const { width, locale } of [{ width: 390, locale: 'en' }, { width: 390, locale: 'ar' }, { width: 820, locale: 'en' }]) {
  test(`merchant header stays usable while the product scrolls at ${width}px ${locale}`, async ({ page, request }) => {
    const listing = await product(request);
    await page.addInitScript(locale => {
      localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale }, version: 0 }));
      localStorage.setItem('mercaria.bloom.theme', JSON.stringify({ mode: 'light', colorPreset: 'blue' }));
    }, locale);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/products/${listing.id}`);
    const header = page.getByTestId('product-merchant-header');
    await expect(header).toBeVisible();
    const initial = await header.boundingBox();
    expect(initial).not.toBeNull();
    await page.mouse.move(width / 2, 600);
    await page.mouse.wheel(0, 1500);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(800);
    const scrolled = await header.boundingBox();
    expect(scrolled).not.toBeNull();
    expect(scrolled!.y).toBeGreaterThanOrEqual(0);
    expect(scrolled!.y).toBeLessThanOrEqual(initial!.y + 1);
    const link = header.locator('a').last();
    const destination = `/stores/${listing.store!.handle}`;
    await expect(link).toHaveAttribute('href', destination);
    expect(await link.evaluate(element => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return hit !== null && element.contains(hit);
    })).toBe(true);
    await page.screenshot({ path: `/tmp/mercaria-product-sticky-${width}-${locale}.png` });
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${destination}$`));
  });
}

test('switching between desktop and mobile headers preserves the selected variant and gallery', async ({ page, request }) => {
  const listing = await product(request);
  const selected = listing.variants[1];
  expect(selected).toBeTruthy();
  await page.addInitScript(() => {
    localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/products/${listing.id}?variantId=${selected.id}`);
  await expect(page.getByTestId('product-merchant-header')).toHaveCount(0);
  const gallery = await page.getByTestId('product-gallery').elementHandle();
  expect(gallery).not.toBeNull();
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.getByTestId('product-merchant-header')).toHaveCount(width === 390 ? 1 : 0);
    await expect(page).toHaveURL(new RegExp(`variantId=${selected.id}$`));
    expect(await gallery!.evaluate(element => element.isConnected && element === document.querySelector('[data-testid="product-gallery"]'))).toBe(true);
  }
});
