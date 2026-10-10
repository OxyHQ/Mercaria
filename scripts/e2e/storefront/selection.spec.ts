import { isOxyFileId } from "../../../packages/shared-types/src";
import { expect, test, type Page } from '@playwright/test';
import type { CanonicalProductPage, Listing } from '../../../packages/shared-types/src';

// Uses existing local storefront/vertical seeds; response overrides never write commerce data.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
    localStorage.setItem('mercaria.bloom.theme', JSON.stringify({ mode: 'light', colorPreset: 'mono' }));
  });
});

async function observeGallery(page: Page) {
  await page.waitForTimeout(300); // The initial page-arrival animation has finished.
  return page.getByTestId('product-gallery').evaluateHandle(gallery => {
    const audit = { frames: 0, missing: 0, replaced: 0, faded: 0, running: true };
    function sample() {
      if (!audit.running) return;
      audit.frames++;
      const current = document.querySelector('[data-testid="product-gallery"]');
      if (!current) audit.missing++;
      if (current !== gallery) audit.replaced++;
      let ancestor = current;
      while (ancestor) {
        if (Number(getComputedStyle(ancestor).opacity) < 0.98) { audit.faded++; break; }
        ancestor = ancestor.parentElement;
      }
      requestAnimationFrame(sample);
    }
    sample();
    return audit;
  });
}

test('initial service failures are retryable and a removed product discards stale identity', async ({ page, request }) => {
  const handle = 'smartphone-kaido-vero-5';
  const response = await request.get(`http://localhost:4160/product-page/${handle}`);
  expect(response.ok()).toBe(true);
  const fixture: CanonicalProductPage = (await response.json()).data;
  const [first, second] = fixture.variants;
  let status = 503;
  await page.route(`**/product-page/${handle}?*`, async route => {
    if (status !== 200) {
      await route.fulfill({ status, json: { success: false } });
      return;
    }
    const data = structuredClone(fixture);
    data.product.variantDefiningAttributeKeys = [];
    data.variants = [first, second].map((variant, index) => ({ ...variant, name: `Configuration ${index + 1}`, options: [] }));
    await route.fulfill({ json: { success: true, data } });
  });
  await page.goto(`/p/${handle}?variant=${first.id}`);
  await expect(page.getByRole('button', { name: 'Try Again', exact: true })).toBeVisible();
  await expect(page.getByText("We couldn't find this product.", { exact: true })).toHaveCount(0);
  status = 200;
  await page.getByRole('button', { name: 'Try Again', exact: true }).click();
  await expect(page.getByTestId('product-gallery')).toBeVisible();
  status = 404;
  await page.getByRole('radio', { name: /Configuration 2,/ }).click();
  await expect(page.getByText("We couldn't find this product.", { exact: true })).toBeVisible();
  await expect(page.getByTestId('product-gallery')).toHaveCount(0);
  await expect(page.getByTestId('product-offers')).toHaveCount(0);
});

for (const width of [390, 1440]) {
  test(`failed configuration updates preserve identity and can retry at ${width}px`, async ({ page, request }) => {
    const handle = 'smartphone-kaido-vero-5';
    const response = await request.get(`http://localhost:4160/product-page/${handle}`);
    expect(response.ok()).toBe(true);
    const fixture: CanonicalProductPage = (await response.json()).data;
    const [first, second] = fixture.variants;
    let failing = true;
    await page.route(`**/product-page/${handle}?*`, async route => {
      const selected = new URL(route.request().url()).searchParams.get('canonicalVariantId');
      if (selected === second.id && failing) {
        await route.fulfill({ status: 503, json: { success: false, error: 'Temporarily unavailable' } });
        return;
      }
      const data = structuredClone(fixture);
      data.product.variantDefiningAttributeKeys = [];
      data.variants = [first, second].map((variant, index) => ({ ...variant, name: `Configuration ${index + 1}`, options: [] }));
      data.selectedVariantId = selected ?? undefined;
      data.bundleContents = { status: 'available', variantId: selected ?? first.id, components: [{
        productId: data.product.id, productSlug: data.product.slug, variantId: first.id,
        name: data.product.name, quantity: selected === second.id ? 2 : 1,
      }] };
      await route.fulfill({ json: { success: true, data } });
    });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/p/${handle}?variant=${first.id}`);
    await expect(page.getByTestId('bundled-product-card')).toHaveCount(1);
    const audit = await observeGallery(page);
    await page.getByRole('radio', { name: /Configuration 2,/ }).click();
    await expect(page.getByTestId('product-update-error')).toBeVisible();
    await expect(page.getByTestId('bundled-product-card')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('product-offers')).not.toHaveAttribute('aria-busy', 'true');
    failing = false;
    await page.getByTestId('product-update-error').getByRole('button').click();
    await expect(page.getByTestId('bundle-quantity')).toHaveText('×2');
    await expect(page.getByTestId('product-update-error')).toHaveCount(0);
    await expect(page.getByTestId('bundled-product-card')).not.toHaveAttribute('aria-disabled', 'true');
    const result = await audit.evaluate(value => { value.running = false; return value; });
    expect(result).toMatchObject({ missing: 0, replaced: 0, faded: 0 });
  });

  test(`slow configuration changes preserve the page and suspend stale actions at ${width}px`, async ({ page, request }) => {
    const handle = 'smartphone-kaido-vero-5';
    const response = await request.get(`http://localhost:4160/product-page/${handle}`);
    expect(response.ok(), 'Requires the local vertical catalog seed').toBe(true);
    const fixture: CanonicalProductPage = (await response.json()).data;
    const [first, second] = fixture.variants;
    expect(second).toBeTruthy();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started = false;
    await page.route(`**/product-page/${handle}?*`, async route => {
      const selected = new URL(route.request().url()).searchParams.get('canonicalVariantId');
      const data = structuredClone(fixture);
      data.product.variantDefiningAttributeKeys = [];
      const body = { ...data, variants: [first, second].map((variant, index) => ({ ...variant, name: `Configuration ${index + 1}`, options: [] })),
        selectedVariantId: selected ?? undefined,
        bundleContents: { status: 'available', variantId: selected ?? first.id, components: [{
          productId: data.product.id, productSlug: data.product.slug, variantId: first.id,
          name: data.product.name, quantity: selected === second.id ? 2 : 1,
        }] },
      };
      if (selected === second.id) { started = true; await gate; }
      await route.fulfill({ json: { success: true, data: body } });
    });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/p/${handle}?variant=${first.id}`);
    await expect(page.getByTestId('bundled-product-card')).toHaveCount(1);
    const audit = await observeGallery(page);
    await page.getByRole('radio', { name: /Configuration 2,/ }).click();
    await expect.poll(() => started).toBe(true);
    await expect(page.getByTestId('product-offers')).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByTestId('bundled-product-card')).toHaveAttribute('aria-disabled', 'true');
    await page.waitForTimeout(1200);
    release();
    await expect(page.getByTestId('bundle-quantity')).toHaveText('×2');
    await expect(page.getByTestId('product-offers')).not.toHaveAttribute('aria-busy', 'true');
    await page.waitForTimeout(200);
    const result = await audit.evaluate(value => { value.running = false; return value; });
    expect(result.frames).toBeGreaterThan(20);
    expect(result).toMatchObject({ missing: 0, replaced: 0, faded: 0 });
  });

  test(`listing swatches update bundle contents and media without remounting the gallery at ${width}px`, async ({ page, request }) => {
    const feed = await (await request.get('http://localhost:4160/feed')).json();
    const summary = feed.data.sections.flatMap((section: { products?: Listing[] }) => section.products ?? [])
      .find((listing: Listing) => listing.title === 'Brilliant Eye Brightener');
    expect(summary, 'Requires the local storefront seed').toBeTruthy();
    const listing: Listing = (await (await request.get(`http://localhost:4160/listings/${summary.id}`)).json()).data;
    expect(listing.images.length, "Requires real synchronized catalog images").toBeGreaterThan(0);
    expect(listing.images.every(image => isOxyFileId(image.fileId)), "Import the seed images through the backend before this integration test").toBe(true);
    const [first, second] = listing.variants;
    second.images = { source: 'variant', images: [listing.images[1]] };
    listing.bundleContentsByVariant = Object.fromEntries([first, second].map((variant, index) => [variant.id, {
      status: 'available' as const, variantId: variant.id,
      components: [{ productId: listing.id, productSlug: 'bundle-component-preview', variantId: first.id,
        name: listing.title, quantity: index + 1, image: { fileId: listing.images[0].fileId } }],
    }]));
    await page.route(`**/listings/${listing.id}`, route => route.fulfill({ json: { success: true, data: listing } }));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/products/${listing.id}?variantId=${first.id}`);
    await expect(page.getByRole('button', { name: `Shade: ${second.title}`, exact: true })).toBeVisible();
    await expect(page.getByTestId('bundled-product-card')).toHaveCount(1);
    await expect(page.getByTestId('bundle-quantity')).toHaveCount(0);
    const audit = await observeGallery(page);
    if (width >= 768) await page.getByRole('button', { name: 'View image 3', exact: true }).click();
    await page.getByRole('button', { name: `Shade: ${second.title}`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`variantId=${second.id}`));
    await expect(page.getByTestId('bundle-quantity')).toHaveText('×2');
    await expect(page.getByTestId('product-gallery-carousel').locator('img')).toHaveCount(1);
    await expect(page.getByTestId('product-gallery-carousel').locator('img')).toHaveAttribute('src', `https://cloud.oxy.so/${listing.images[1].fileId}`);
    await page.waitForTimeout(300);
    const result = await audit.evaluate(value => { value.running = false; return value; });
    expect(result).toMatchObject({ missing: 0, replaced: 0, faded: 0 });
  });
}
