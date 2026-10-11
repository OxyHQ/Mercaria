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
  test(`merchant details retain edits and retry at ${width}px ${locale} ${mode}`, async ({
    page,
  }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode);
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    const externalImages: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (request.url().includes('untrusted.example.test')) externalImages.push(request.url());
    });
    let productError = 403;
    let release!: () => void;
    let pending: Promise<void> | undefined = new Promise((resolve) => {
      release = resolve;
    });
    let mutations = 0;
    const product = {
      id: 'detail-product',
      title: 'Linen studio shirt',
      description: 'A lightweight linen shirt.',
      status: 'draft',
      images: [],
      variants: [],
      options: [],
      quantity: 8,
      overriddenFields: [],
      price: { amount: 4900, currency: 'EUR' },
    };
    await page.route('**/admin/stores/*/products/detail-product', async (route) => {
      if (route.request().method() === 'PATCH') {
        mutations++;
        return route.fulfill({
          json: { success: true, data: { ...product, ...route.request().postDataJSON() } },
        });
      }
      if (pending) await pending;
      if (productError)
        return route.fulfill({
          status: productError,
          json: { success: false, message: 'Fixture read failure' },
        });
      return route.fulfill({ json: { success: true, data: product } });
    });
    await page.goto('/products/detail-product');
    const detail = page.getByTestId('merchant-product-detail');
    await expect(detail.getByTestId('merchant-detail-skeleton')).toBeVisible();
    const frame = await detail.elementHandle();
    const loadingSize = await detail.boundingBox();
    release();
    pending = undefined;
    await expect(detail.getByText(copy.products.detail.loadFailed, { exact: true })).toBeVisible();
    expect(await frame!.evaluate((node) => node.isConnected)).toBe(true);
    expect((await detail.boundingBox())!.height).toBe(loadingSize!.height);
    productError = 0;
    await detail.getByRole('button', { name: copy.common.retry, exact: true }).click();
    const title = detail.getByRole('textbox', { name: copy.common.title, exact: true });
    await expect(title).toHaveValue(product.title);
    await title.fill('Saved edit');
    const originalInput = await title.elementHandle();
    productError = 502;
    pending = new Promise((resolve) => {
      release = resolve;
    });
    await detail
      .getByRole('button', { name: copy.products.detail.saveChanges, exact: true })
      .click();
    await expect.poll(() => mutations).toBe(1);
    await expect(
      detail.getByRole('progressbar', { name: copy.common.loading, exact: true }),
    ).toBeVisible();
    await title.fill('Unsaved edit during refresh');
    release();
    pending = undefined;
    await expect(detail.getByText(copy.products.detail.loadFailed, { exact: true })).toBeVisible();
    await expect(title).toHaveValue('Unsaved edit during refresh');
    expect(await originalInput!.evaluate((node) => node.isConnected)).toBe(true);
    productError = 0;
    await detail.getByRole('button', { name: copy.common.retry, exact: true }).click();
    await expect(detail.getByText(copy.products.detail.loadFailed, { exact: true })).toHaveCount(0);
    await expect(title).toHaveValue('Unsaved edit during refresh');
    await page.screenshot({
      path: `/tmp/mercaria-product-detail-${width}-${locale}-${mode}.png`,
      fullPage: true,
    });
    productError = 403;
    await detail
      .getByRole('button', { name: copy.products.detail.saveChanges, exact: true })
      .click();
    await expect.poll(() => mutations).toBe(2);
    await expect(title).toHaveCount(0);
    await expect(detail.getByText(copy.products.detail.loadFailed, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: copy.common.back, exact: true }).click();
    await expect(page).toHaveURL(/\/products$/);

    let orderError = true;
    const money = (amount: number) => ({
      shop: { amount, currency: 'EUR' },
      presentment: { amount, currency: 'EUR' },
    });
    const note =
      'The customer requested careful packaging and confirmed the order details. This complete note must remain readable on a narrow screen.';
    const order = {
      id: 'detail-order',
      orderNumber: '#1002',
      status: 'paid',
      createdAt: '2026-10-08T12:00:00Z',
      buyer: { displayLabel: 'Jordan Smith' },
      items: [
        {
          listingId: 'detail-product',
          variantId: 'variant-1',
          title: 'Linen studio shirt with a relaxed fit and long sleeves',
          variantTitle: 'Natural / Medium',
          quantity: 2,
          optionValues: [],
          imageUrl: 'https://untrusted.example.test/coat.png',
          unitPrice: money(4900),
          lineTotal: money(9800),
        },
      ],
      totals: {
        subtotal: money(9800),
        discountTotal: money(0),
        tax: money(0),
        shipping: money(0),
        grandTotal: money(9800),
      },
      shipping: {},
      shippingAddress: {
        recipientName: 'Jordan Smith',
        line1: '24 Market Street',
        city: 'London',
        postalCode: 'SW1A 1AA',
        country: 'GB',
      },
      statusHistory: [{ status: 'paid', at: '2026-10-08T12:00:00Z', note }],
    };
    await page.route('**/admin/stores/*/orders/detail-order', (route) =>
      orderError
        ? route.fulfill({ status: 403, json: { success: false, message: 'Fixture failure' } })
        : route.fulfill({ json: { success: true, data: order } }),
    );
    await page.route('**/orders/detail-order/refunds', (route) =>
      route.fulfill({ json: { success: true, data: [] } }),
    );
    await page.goto('/orders/detail-order');
    const orderDetail = page.getByTestId('merchant-order-detail');
    await expect(
      orderDetail.getByText(copy.orders.detail.loadFailed, { exact: true }),
    ).toBeVisible();
    orderError = false;
    await orderDetail.getByRole('button', { name: copy.common.retry, exact: true }).click();
    const customer = orderDetail.getByTestId('merchant-order-customer');
    await expect(customer.getByText('Jordan Smith', { exact: true }).first()).toBeVisible();
    await expect(orderDetail.getByTestId('merchant-order-item')).toContainText(
      order.items[0].title,
    );
    await expect(orderDetail.getByText(note, { exact: true })).toBeVisible();
    expect(
      await orderDetail
        .getByText(note, { exact: true })
        .evaluate((node) => node.scrollHeight <= node.clientHeight),
    ).toBe(true);
    const mainBox = await orderDetail.getByTestId('merchant-order-main').boundingBox();
    const buyerBox = await customer.boundingBox();
    if (width >= 1024) expect(buyerBox!.x).toBeGreaterThan(mainBox!.x + mainBox!.width);
    else expect(buyerBox!.y).toBeGreaterThanOrEqual(mainBox!.y + mainBox!.height);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/mercaria-order-detail-${width}-${locale}-${mode}.png`,
      fullPage: true,
    });
    await page.getByRole('button', { name: copy.common.back, exact: true }).click();
    await expect(page).toHaveURL(/\/orders$/);
    expect(externalImages).toEqual([]);
    expect(errors).toEqual([]);
  });
}
