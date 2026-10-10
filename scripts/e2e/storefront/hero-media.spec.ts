import { expect, test } from '@playwright/test';
import type { Feed, ProductSummary } from '../../../packages/shared-types/src';

// Error-boundary regression: inject malformed metadata, never replace image
// responses or pretend a supplier image has been synchronized to Oxy.
test('hero withholds URL-valued file IDs and legacy supplier URLs while preserving product links', async ({ page, request }) => {
  const response = await request.get('http://localhost:4160/feed');
  expect(response.ok()).toBe(true);
  const body: { success: boolean; data: Feed } = await response.json();
  const products: ProductSummary[] = body.data.sections.flatMap(section => section.kind === 'products' ? section.products : []);
  expect(products.length).toBeGreaterThan(1);
  const supplierOrigin = 'https://legacy-supplier.example.test';
  const first = products[0];
  for (const [index, product] of products.entries()) {
    product.imageUrl = `${supplierOrigin}/${product.id}.jpg`;
    if (index % 2) product.imageFileId = product.imageUrl;
    else delete product.imageFileId;
  }
  for (const section of body.data.sections) {
    if (section.kind !== 'merchants') continue;
    for (const store of section.merchants) {
      store.logoFileId = `${supplierOrigin}/logo.jpg`;
      store.coverFileId = `${supplierOrigin}/cover.jpg`;
      store.logoUrl = store.logoFileId;
      store.coverImageUrl = store.coverFileId;
      for (const thumbnail of store.products) {
        delete thumbnail.imageFileId;
        thumbnail.imageUrl = `${supplierOrigin}/thumbnail.jpg`;
      }
    }
  }
  let injected = false;
  await page.route(/\/feed(?:\?.*)?$/, route => {
    injected = true;
    return route.fulfill({ json: body });
  });
  await page.addInitScript(() => {
    localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
    localStorage.setItem('mercaria.bloom.theme', JSON.stringify({ mode: 'light', colorPreset: 'mono' }));
  });
  const requests: string[] = [];
  page.on('request', request => {
    if (request.url().startsWith(supplierOrigin)) requests.push(request.url());
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const hero = page.getByTestId('home-hero');
  const card = hero.getByTestId('hero-card-0');
  await expect(card.getByRole('link', { name: first.title, exact: true })).toBeVisible();
  await expect(hero.locator('img')).toHaveCount(0);
  await expect(card.getByText('No image', { exact: true })).toBeVisible();
  await card.getByRole('link', { name: first.title, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/products/${first.id}$`));
  await expect(page.getByText(first.title, { exact: true }).first()).toBeVisible();
  expect(injected).toBe(true);
  expect(requests).toEqual([]);
});
