import { expect, test } from '@playwright/test';
import type { StoreSummary } from '../../../packages/shared-types/src';

for (const { width, locale } of [
  { width: 1440, locale: 'en' },
  { width: 390, locale: 'ar' },
]) {
  test(`merchant cards preserve Shop geometry, motion and distinct links at ${width}px ${locale}`, async ({
    page,
    request,
    context,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.addInitScript(
      (locale) =>
        localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale }, version: 0 })),
      locale,
    );
    const feed = await (await request.get('http://localhost:4160/feed')).json();
    const merchant: StoreSummary = feed.data.sections
      .flatMap((section: { merchants?: StoreSummary[] }) => section.merchants ?? [])
      .find(
        (store: StoreSummary) =>
          store.coverFileId && store.logoFileId && store.products.length === 3,
      );
    expect(merchant).toBeTruthy();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    const card = page.getByTestId('merchant-card').filter({
      has: page
        .getByTestId('merchant-card-store-link')
        .filter({ has: page.locator(`img[src*="${merchant.logoFileId}"]`) }),
    });
    await card.scrollIntoViewIfNeeded();
    const bounds = (await card.boundingBox())!;
    expect(bounds.width).toBe(330);
    expect(bounds.height).toBe(397);
    await expect(card).toHaveCSS('border-radius', '28px');
    await expect(card.getByTestId('merchant-card-heading')).toHaveCount(0);
    const storeLink = card.getByTestId('merchant-card-store-link');
    await expect(storeLink).toHaveAttribute('href', `/stores/${merchant.handle}`);
    await expect(storeLink.locator('a')).toHaveCount(0);
    const products = card.getByTestId('merchant-card-product-link');
    await expect(products).toHaveCount(3);
    for (let index = 0; index < 3; index++) {
      await expect(products.nth(index)).toHaveAttribute(
        'href',
        `/products/${merchant.products[index].id}`,
      );
      const box = (await products.nth(index).boundingBox())!;
      expect(box.width).toBe(98);
      expect(box.height).toBe(98);
      await expect(products.nth(index)).toHaveCSS('border-radius', '20px');
      expect(bounds.y + bounds.height - box.y - box.height).toBe(12);
    }
    const cover = card.getByTestId('merchant-card-cover');
    const branding = card.getByTestId('merchant-card-branding');
    await storeLink.hover();
    await expect(cover).toHaveCSS('scale', '1.05');
    await expect(cover).toHaveCSS('transition-duration', '0.5s');
    await expect(branding).toHaveCSS('scale', '1.1');
    await expect(branding).toHaveCSS('transition-duration', '0.15s');
    await products.first().hover();
    await expect(products.first().getByTestId('merchant-card-product-image')).toHaveCSS(
      'scale',
      '1.1',
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const image of [
      cover,
      branding,
      products.first().getByTestId('merchant-card-product-image'),
    ]) {
      await expect(image).toHaveCSS('scale', 'none');
      await expect(image).toHaveCSS('transition-property', 'none');
    }
    await page.screenshot({ path: `/tmp/mercaria-merchant-card-${width}-${locale}.png` });
    const popupPromise = context.waitForEvent('page');
    await products.first().click({ modifiers: ['ControlOrMeta'] });
    const popup = await popupPromise;
    await expect(popup).toHaveURL(new RegExp(`/products/${merchant.products[0].id}$`));
    await popup.close();
    await storeLink.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/stores/${merchant.handle}$`));
    await page.goto('/explore');
    const discovery = page.getByTestId('merchant-card').first();
    await expect(discovery.getByTestId('merchant-card-heading')).toBeVisible();
    const headingBox = (await discovery.getByTestId('merchant-card-heading').boundingBox())!;
    const discoveryBox = (await discovery.boundingBox())!;
    expect(headingBox.y - discoveryBox.y).toBe(12);
    await expect(discovery.getByTestId('merchant-card-store-link')).toHaveAttribute(
      'href',
      /\/stores\//,
    );
    expect(errors).toEqual([]);
  });
}

test('merchant cards bound featured products and retain solid themes and empty states', async ({
  page,
  request,
}) => {
  const response = await (await request.get('http://localhost:4160/feed')).json();
  const shelf = response.data.sections.find(
    (section: { kind: string }) => section.kind === 'merchants',
  );
  const all: StoreSummary[] = shelf.merchants;
  const store = structuredClone(all.find((store) => store.logoFileId && !store.coverFileId)!);
  expect(store).toBeTruthy();
  const products = all
    .flatMap((store) => store.products)
    .filter((product, index, list) => list.findIndex((item) => item.id === product.id) === index);
  store.products = products.slice(0, 5);
  shelf.merchants = [store];
  // Only the public feed composition changes. Product images still use real Oxy assets.
  await page.route('http://localhost:4160/feed', (route) => route.fulfill({ json: response }));
  await page.goto('/');
  const card = page.getByTestId('merchant-card');
  await expect(card.getByTestId('merchant-card-product-link')).toHaveCount(3);
  await expect(card.getByTestId('merchant-card-cover')).toHaveCount(0);
  expect(
    await card.locator('[style]').evaluateAll((nodes) =>
      nodes.some((node) => {
        const style = getComputedStyle(node);
        return (
          style.backgroundImage.includes('linear-gradient') ||
          style.backgroundColor === 'rgba(0, 0, 0, 0.2)'
        );
      }),
    ),
  ).toBe(false);
  for (const count of [2, 1, 0]) {
    store.products = products.slice(0, count);
    store.logoFileId = undefined;
    store.logoUrl = undefined;
    store.rating = 0;
    store.reviewCount = 0;
    await page.reload();
    await expect(card.getByTestId('merchant-card-product-link')).toHaveCount(count);
    await expect(card.getByTestId('merchant-card-heading')).toHaveText(store.name);
    if (count) {
      const box = (await card.getByTestId('merchant-card-product-link').first().boundingBox())!;
      expect(box.width).toBe(150);
      expect(box.height).toBe(150);
    } else {
      await expect(card.getByTestId('merchant-card-products')).toHaveCount(0);
    }
  }
});
