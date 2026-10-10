import { expect, test } from '@playwright/test';
import type { Listing, ListingBundleRecommendation } from '../../../packages/shared-types/src';
import english from '../../../packages/ui/src/i18n/locales/en.json';
import german from '../../../packages/ui/src/i18n/locales/de.json';

for (const width of [320, 390, 1440]) {
  const locale = width === 320 ? 'de' : 'en';
  const copy = (locale === 'de' ? german : english).ui;
  test(`bundle recommendations use exact variants, keep failed adds retryable and open configurable packs at ${width}px`, async ({ page, request }) => {
    const feed = await (await request.get('http://localhost:4160/feed')).json();
    const summary = feed.data.sections.flatMap((section: { products?: Listing[] }) => section.products ?? [])
      .find((listing: Listing) => listing.title === 'Brilliant Eye Brightener');
    expect(summary, 'Requires the local storefront seed').toBeTruthy();
    const listing: Listing = (await (await request.get(`http://localhost:4160/listings/${summary.id}`)).json()).data;
    const [source, alternate, singleVariant, configurableVariant] = listing.variants;
    const single: ListingBundleRecommendation = {
      listingId: listing.id, variantId: singleVariant.id, title: 'Complete brightener set',
      image: listing.images[0], price: { amount: 4200, currency: 'EUR' },
      compareAtPrice: { amount: 4800, currency: 'EUR' }, action: 'add_to_cart',
    };
    const configurable: ListingBundleRecommendation = {
      listingId: listing.id, variantId: configurableVariant.id, title: 'Choose your brightener set',
      image: listing.images[1], price: { amount: 6000, currency: 'EUR' }, action: 'view_bundle',
    };
    listing.bundlesByVariant = { [source.id]: [single, configurable], [alternate.id]: [configurable] };
    await page.route(`**/listings/${listing.id}`, route => route.fulfill({ json: { success: true, data: listing } }));
    const cart = (await (await request.get('http://localhost:4160/cart')).json()).data;
    const writes: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/cart/items', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      writes.push(route.request().postDataJSON());
      if (writes.length === 1) {
        await gate;
        await route.fulfill({ status: 409, json: { success: false, message: 'Stock changed' } });
      } else await route.fulfill({ json: { success: true, data: cart } });
    });
    await page.addInitScript(locale => localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale }, version: 0 })), locale);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/products/${listing.id}?variantId=${source.id}`);
    const shelf = page.getByTestId('bundle-recommendations');
    await expect(shelf.getByRole('heading', { name: copy.bundle.andSave })).toBeVisible();
    const first = shelf.getByTestId('bundle-recommendation-card').first();
    await first.scrollIntoViewIfNeeded();
    if (width === 320) {
      await expect(first).toHaveCSS('width', '288px');
      expect(await first.getByRole('button').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    }
    await first.getByRole('button', { name: copy.purchase.addToCart, exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    await expect(first.getByRole('button')).toBeDisabled();
    expect(writes[0]).toEqual({ listingId: single.listingId, variantId: single.variantId, quantity: 1 });
    release();
    await expect(first.getByRole('alert')).toHaveText(copy.bundle.addFailed);
    await expect(first.getByRole('button', { name: copy.purchase.addToCart, exact: true })).toBeEnabled();
    await first.getByRole('button').click();
    await expect(first.getByRole('button', { name: copy.purchase.added, exact: true })).toBeVisible();
    expect(writes).toHaveLength(2);
    await expect(first.getByRole('alert')).toHaveCount(0);
    await page.getByRole('button', { name: `Shade: ${alternate.title}`, exact: true }).click();
    await expect(shelf.getByTestId('bundle-recommendation-card')).toHaveCount(1);
    await expect(shelf.getByRole('heading', { name: copy.bundle.together })).toBeVisible();
    await shelf.getByRole('button', { name: copy.bundle.view, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`variantId=${configurable.variantId}$`));
    await expect(shelf).toHaveCount(0);
    expect(writes).toHaveLength(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}
