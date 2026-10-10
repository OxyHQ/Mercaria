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

test('failed Oxy images keep product cards usable and retry a new source when the hero rotates', async ({ page, request }) => {
  const response = await request.get('http://localhost:4160/feed');
  expect(response.ok()).toBe(true);
  const body: { success: boolean; data: Feed } = await response.json();
  const products = [...new Map(body.data.sections.flatMap(section => section.kind === 'products' ? section.products : [])
    .map(product => [product.id, product])).values()].slice(0, 8);
  expect(products).toHaveLength(8);
  products.forEach((product, index) => {
    product.imageFileId = `unavailable-hero-media-test-${index}`;
    delete product.imageUrl;
  });
  const shelf = body.data.sections.find(section => section.kind === 'products');
  if (!shelf || shelf.kind !== 'products') throw new Error('The local feed needs a product shelf');
  body.data.sections = [{ ...shelf, products }];
  await page.route(/\/feed(?:\?.*)?$/, route => route.fulfill({ json: body }));
  // Missing-file boundary only. No successful images or persisted pretend IDs.
  const imageRequests: string[] = [];
  await page.route('https://cloud.oxy.so/unavailable-hero-media-test-*', route => {
    imageRequests.push(route.request().url());
    return route.fulfill({ status: 404 });
  });
  await page.addInitScript(() => {
    localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  const hero = page.getByTestId('home-hero');
  const card = hero.getByTestId('hero-card-0');
  await expect(card.getByRole('link', { name: products[0].title, exact: true })).toBeVisible();
  await expect(card.getByText('No image', { exact: true })).toBeVisible();
  const mountedCard = await card.elementHandle();
  await expect(card.getByRole('link', { name: products[4].title, exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText('No image', { exact: true })).toBeVisible();
  expect(await mountedCard!.evaluate(node => node.isConnected)).toBe(true);
  // It was requested once for the shelf, and again for the new hero source.
  expect(imageRequests.filter(url => url.endsWith('/unavailable-hero-media-test-4')).length).toBeGreaterThanOrEqual(2);
  const target = card.getByRole('link', { name: products[4].title, exact: true });
  const bounds = (await target.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await target.click();
  await expect(page).toHaveURL(new RegExp(`/products/${products[4].id}$`));
});

test('keyboard focus keeps the selected hero product stable after the pointer leaves', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  const card = page.getByTestId('hero-card-0');
  const link = card.getByRole('link');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', /^\/products\//);
  const bounds = (await link.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await link.focus();
  const title = await link.getAttribute('aria-label');
  await page.mouse.move(0, 0);
  // Cross a whole 7s cycle while keyboard focus still owns the selected item.
  // Poll every second so a transient wrong product cannot pass unnoticed.
  for (let second = 0; second < 8; second++) {
    await page.waitForTimeout(1000);
    await expect(link).toBeFocused();
    await expect(link).toHaveAttribute('aria-label', title!);
  }
  await link.press('Enter');
  await expect(page).toHaveURL(/\/products\/[^/]+$/);
  await expect(page.getByText(title!, { exact: true }).first()).toBeVisible();
});
