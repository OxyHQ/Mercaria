import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

for (const [width, locale, mode] of [
  [1440, 'en', 'light'],
  [390, 'en', 'light'],
  [390, 'ar', 'light'],
  [390, 'en', 'dark'],
] as const) {
  test(`merchant lists at ${width}px ${locale} ${mode}`, async ({ page }) => {
    const copy = locale === 'ar' ? ar : en;
    const requests = await fixture(page, locale, mode);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    let release: (() => void) | undefined;
    let pending: Promise<void> | undefined;
    let fail = false;
    await page.route('**/admin/stores/*/products?**', async (route) => {
      const url = new URL(route.request().url());
      requests.push(url);
      if (pending) await pending;
      if (fail)
        return route.fulfill({ status: 403, json: { success: false, message: 'Fixture failure' } });
      const search = url.searchParams.get('search');
      const active = url.searchParams.get('status') === 'active';
      const next = url.searchParams.get('page') === '2';
      const empty = search === 'nothing';
      const product = {
        id: next ? 'page-two' : 'linen-shirt',
        title: next ? 'Second page product' : search ? 'Alpine jacket' : 'Linen studio shirt',
        status: active ? 'active' : 'draft',
        images: [{ fileId: 'fixture-product-file', alt: 'Linen shirt', position: 0 }],
        variants: [{ id: 'variant-1' }],
        quantity: 8,
        price: { amount: 4900, currency: 'EUR' },
      };
      return route.fulfill({
        json: {
          success: true,
          data: empty ? [] : [product],
          pagination: {
            total: empty ? 0 : search || active ? 1 : 21,
            page: next ? 2 : 1,
            limit: 20,
            pages: empty ? 0 : search || active ? 1 : 2,
          },
        },
      });
    });
    await page.route('**/fixture-product-file**', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#ddd6c9"/><path d="M25 12h30l15 18-12 10-5-7v35H27V33l-5 7-12-10z" fill="#f8f6ef"/></svg>',
      }),
    );
    await page.route('**/admin/stores/*/orders?**', async (route) => {
      const url = new URL(route.request().url());
      requests.push(url);
      if (pending) await pending;
      const status = url.searchParams.get('status') || 'paid';
      const empty = status === 'cancelled';
      return route.fulfill({
        json: {
          success: true,
          data: empty
            ? []
            : [
                {
                  id: 'order-preview',
                  orderNumber: '#1001',
                  status,
                  createdAt: '2026-10-08T12:00:00Z',
                  itemCount: 2,
                  buyer: { displayLabel: 'Jordan Smith' },
                  grandTotal: {
                    shop: { amount: 9800, currency: 'EUR' },
                    presentment: { amount: 9800, currency: 'EUR' },
                  },
                },
              ],
          pagination: { total: empty ? 0 : 1, page: 1, limit: 20, pages: empty ? 0 : 1 },
        },
      });
    });
    await page.goto('/products');
    const products = page.getByTestId('merchant-products-list');
    await expect(
      products.getByRole('button', { name: 'Linen studio shirt', exact: true }),
    ).toBeVisible();
    await expect(products.getByRole('img', { name: 'Linen shirt' })).toBeVisible();
    await page.screenshot({
      path: `/tmp/mercaria-products-${width}-${locale}-${mode}.png`,
      fullPage: true,
    });
    const before = await products.boundingBox();
    pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await products.getByRole('button', { name: copy.resourceList.next, exact: true }).click();
    await expect(
      products.getByRole('button', { name: copy.resourceList.next, exact: true }),
    ).toBeDisabled();
    await expect(
      products.getByRole('button', { name: 'Linen studio shirt', exact: true }),
    ).toBeDisabled();
    expect((await products.boundingBox())!.height).toBe(before!.height);
    release!();
    pending = undefined;
    await expect(
      products.getByRole('button', { name: 'Second page product', exact: true }),
    ).toBeVisible();
    const search = products.getByRole('textbox', { name: copy.products.searchPlaceholder });
    await search.fill('Alpine');
    await expect(
      products.getByRole('button', { name: 'Alpine jacket', exact: true }),
    ).toBeVisible();
    expect(
      requests
        .filter((url) => url.pathname.endsWith('/products'))
        .at(-1)!
        .searchParams.get('page'),
    ).toBe('1');
    await products.getByRole('button', { name: copy.common.status, exact: true }).click();
    await expect(page.getByRole('menu', { name: copy.common.status, exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('menu', { name: copy.common.status, exact: true }),
    ).not.toBeVisible();
    await products.getByRole('button', { name: copy.common.status, exact: true }).press('Enter');
    await page.getByRole('radio', { name: copy.products.status.active, exact: true }).click();
    await expect
      .poll(() =>
        requests.some(
          (url) =>
            url.searchParams.get('search') === 'Alpine' &&
            url.searchParams.get('status') === 'active',
        ),
      )
      .toBe(true);
    await search.fill('nothing');
    await expect(products.getByText(copy.resourceList.noResults, { exact: true })).toBeVisible();
    await expect(products.getByText(copy.products.empty.title, { exact: true })).toHaveCount(0);
    await products
      .getByRole('button', { name: copy.resourceList.clearFilters, exact: true })
      .click();
    await expect(
      products.getByRole('button', { name: 'Linen studio shirt', exact: true }),
    ).toBeVisible();
    fail = true;
    await search.fill('failure');
    await expect(products.getByText(copy.products.loadFailed, { exact: true })).toBeVisible();
    fail = false;
    await products.getByRole('button', { name: copy.common.retry, exact: true }).click();
    await expect(
      products.getByRole('button', { name: 'Alpine jacket', exact: true }),
    ).toBeVisible();
    await products.getByRole('button', { name: 'Alpine jacket', exact: true }).click();
    await expect(page).toHaveURL(/\/products\/linen-shirt$/);
    await page.goto('/orders');
    const orders = page.getByTestId('merchant-orders-list');
    await expect(orders.getByText('Jordan Smith', { exact: true })).toBeVisible();
    await expect(orders.getByRole('button', { name: '#1001', exact: true })).toBeVisible();
    await page.screenshot({
      path: `/tmp/mercaria-orders-${width}-${locale}-${mode}.png`,
      fullPage: true,
    });
    pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await orders.getByRole('button', { name: copy.common.status, exact: true }).click();
    await page.getByRole('radio', { name: copy.orders.status.refunded, exact: true }).click();
    await expect(orders.getByText('Jordan Smith', { exact: true })).toHaveCount(0);
    release!();
    pending = undefined;
    await expect(orders.getByText('Jordan Smith', { exact: true })).toBeVisible();
    await orders.getByRole('button', { name: copy.common.status, exact: true }).click();
    await page.getByRole('radio', { name: copy.orders.status.cancelled, exact: true }).click();
    await expect(orders.getByText(copy.resourceList.noResults, { exact: true })).toBeVisible();
    await orders.getByRole('button', { name: copy.resourceList.clearFilters, exact: true }).click();
    await expect(orders.getByText('Jordan Smith', { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await orders.getByRole('button', { name: '#1001', exact: true }).click();
    await expect(page).toHaveURL(/\/orders\/order-preview$/);
    expect(errors).toEqual([]);
  });
}
