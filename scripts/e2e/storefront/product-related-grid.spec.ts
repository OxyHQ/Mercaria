import { expect, test } from '@playwright/test';
import type { ApiResponse, DiscoverySignalPage } from '../../../packages/shared-types/src';
import en from '../../../packages/frontend/lib/i18n/locales/en.json';
import ar from '../../../packages/frontend/lib/i18n/locales/ar.json';

for (const [width, locale] of [[1440, 'en'], [390, 'ar']] as const) {
  test(`real category recommendations and Oxy images at ${width}px ${locale}`, async ({ page, request }) => {
    const copy = locale === 'ar' ? ar : en;
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(locale => localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale }, version: 0 })), locale);
    const response: ApiResponse<DiscoverySignalPage> = await (await request.get('http://localhost:4160/discovery/signal?scope=category:shirts&signal=new&limit=24&offset=0')).json();
    const products = response.data!.products;
    expect(products.length).toBeGreaterThanOrEqual(3);
    const current = products[0];
    const related = products.filter(item => item.id !== current.id);
    const foreignImages: string[] = []; const errors: string[] = [];
    page.on('request', request => { if (/shopifycdn\.com|cdn\.shopify\.com/.test(request.url())) foreignImages.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`/products/${current.id}`);
    const grid = page.getByTestId('product-related-grid');
    await expect(grid.getByRole('heading', { name: copy.product.youMightAlsoLike, exact: true })).toBeVisible();
    await grid.scrollIntoViewIfNeeded();
    await expect(grid.locator(`a[href="/products/${current.id}"]`)).toHaveCount(0);
    for (const product of related) {
      const link = grid.getByRole('link', { name: product.title, exact: true }).first();
      await expect(link).toHaveAttribute('href', `/products/${product.id}`);
      const image = link.locator('img');
      await expect(image).toHaveAttribute('src', new RegExp(product.imageFileId!));
      await expect.poll(() => image.evaluate(node => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0)).toBe(true);
    }
    const first = grid.getByRole('link', { name: related[0].title, exact: true }).first();
    const second = grid.getByRole('link', { name: related[1].title, exact: true }).first();
    const a = (await first.boundingBox())!; const b = (await second.boundingBox())!;
    expect(Math.abs(a.y - b.y)).toBeLessThan(1);
    expect(Math.abs(Math.abs(a.x - b.x) - a.width - (width < 768 ? 16 : 32))).toBeLessThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/mercaria-related-grid-${width}-${locale}.png` });
    await first.click();
    await expect(page).toHaveURL(new RegExp(`/products/${related[0].id}$`));
    await expect(grid.locator(`a[href="/products/${related[0].id}"]`)).toHaveCount(0);
    await expect(grid.locator(`a[href="/products/${current.id}"]`).first()).toBeVisible();
    expect(foreignImages).toEqual([]); expect(errors).toEqual([]);
  });

  test(`category recommendation pagination recovers without losing cards at ${width}px ${locale}`, async ({ page, request }) => {
    const copy = locale === 'ar' ? ar : en;
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(locale => localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale }, version: 0 })), locale);
    const response: ApiResponse<DiscoverySignalPage> = await (await request.get('http://localhost:4160/discovery/signal?scope=category:shirts&signal=new&limit=24&offset=0')).json();
    const products = response.data!.products;
    expect(products.length).toBeGreaterThanOrEqual(3);
    const current = products[0]; const first = products[1]; const last = products[2];
    let fail = true;
    // Split actual discovery DTOs into pages; only the read transport is varied.
    // Catalog identities and image files remain real, and no writes are made.
    await page.route('**/discovery/signal?*', route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('scope') !== 'category:shirts') return route.continue();
      const offset = Number(url.searchParams.get('offset'));
      if (offset > 0 && fail) return route.fulfill({ status: 503, json: { success: false, error: 'Temporary read failure' } });
      return route.fulfill({ json: { ...response, data: { ...response.data, products: offset === 0 ? [current, first] : [last], hasMore: offset === 0 } } });
    });
    await page.goto(`/products/${current.id}`);
    const grid = page.getByTestId('product-related-grid');
    const firstLink = grid.getByRole('link', { name: first.title, exact: true }).first();
    await expect(firstLink).toBeVisible();
    const retained = await firstLink.elementHandle();
    await grid.getByRole('button', { name: copy.discovery.signal.loadMoreLabel, exact: true }).click();
    await expect(grid.getByRole('alert')).toHaveText(copy.discovery.signal.loadError);
    await expect(firstLink).toBeVisible();
    expect(await retained!.evaluate(node => node.isConnected)).toBe(true);
    fail = false;
    await grid.getByRole('button', { name: copy.common.tryAgain, exact: true }).click();
    await expect(grid.getByRole('link', { name: last.title, exact: true }).first()).toBeVisible();
    await expect(grid.getByRole('alert')).toHaveCount(0);
    await expect(grid.getByRole('button', { name: copy.discovery.signal.loadMoreLabel, exact: true })).toHaveCount(0);
    expect(await retained!.evaluate(node => node.isConnected)).toBe(true);
  });
}

// Exercise the auto-fit boundary with enough actual cards to fill a wide row.
// Only category membership is isolated here; card DTOs and image delivery are real.
test('recommendation grid fits full rows and responds to container resizing', async ({ page, request }) => {
  const response: ApiResponse<DiscoverySignalPage> = await (await request.get('http://localhost:4160/discovery/signal?scope=root&signal=new&limit=24&offset=0')).json();
  const products = response.data!.products;
  expect(products.length).toBeGreaterThanOrEqual(8);
  const current = products.find(product => product.title === 'Beni Top')!;
  expect(current).toBeTruthy();
  await page.addInitScript(() => localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 })));
  await page.route('**/discovery/signal?*', route => route.fulfill({ json: { ...response, data: { ...response.data, hasMore: false } } }));
  await page.goto(`/products/${current.id}`);
  const grid = page.getByTestId('product-related-grid');
  await expect(grid).toBeVisible();
  for (const width of [390, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => grid.evaluate(element => {
      const images = Array.from(element.querySelectorAll('a')).filter(link => link.querySelector('img'));
      const boxes = images.map(link => link.getBoundingClientRect());
      if (boxes.length < 8 || boxes[0].width <= 0) return false;
      const row = boxes.filter(box => Math.abs(box.y - boxes[0].y) < 1);
      const nextRow = boxes.find(box => box.y > boxes[0].y + 1);
      if (!nextRow) return false;
      const style = getComputedStyle(element);
      const available = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const gap = innerWidth < 768 ? 16 : 32;
      const count = innerWidth < 768 ? 2 : Math.floor((available + gap) / (220 + gap));
      return row.length === count && Math.abs(row.at(-1)!.right - row[0].left - available) < 1
        && (innerWidth < 768 || row.every(box => box.width >= 220))
        && document.documentElement.scrollWidth <= innerWidth;
    })).toBe(true);
  }
});
