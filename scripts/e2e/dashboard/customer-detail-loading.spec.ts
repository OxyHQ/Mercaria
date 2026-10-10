import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

for (const [width, locale, mode] of [[1440, 'en', 'light'], [390, 'ar', 'dark']] as const) {
  test(`customer and order reads recover without false empty history at ${width}px ${locale}`, async ({ page, context }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode);
    await page.clock.install();
    await page.setViewportSize({ width, height: 1100 });
    const customer = { id: 'jordan', storeId: 'store-preview', displayName: 'Jordan Smith', isWalkIn: false, tags: [], groupTags: [],
      stats: { orderCount: 1, totalSpent: { amount: 9800, currency: 'EUR' } }, createdAt: '2026-10-08T12:00:00Z', updatedAt: '2026-10-08T12:00:00Z' };
    const other = { ...customer, id: 'taylor', displayName: 'Taylor Parker', stats: { orderCount: 0, totalSpent: { amount: 0, currency: 'EUR' } } };
    const order = { id: 'customer-order', orderNumber: '#1042', status: 'paid', createdAt: '2026-10-08T12:00:00Z',
      grandTotal: { shop: { amount: 9800, currency: 'EUR' }, presentment: { amount: 9800, currency: 'EUR' } } };
    let customerStatus = 0;
    let orderStatus = 503;
    let orders: typeof order[] = [order];
    let holdOrders = false;
    let releaseOrder: (() => void) | undefined;
    let releaseOther: (() => void) | undefined;
    await page.route('**/admin/stores/*/customers?**', route => route.fulfill({ json: { success: true, data: [customer, other], pagination: { page: 1, pages: 1, limit: 20, total: 2 } } }));
    await page.route('**/admin/stores/*/customers/jordan', route => route.fulfill(customerStatus
      ? { status: customerStatus, json: { success: false, message: 'Customer read failed' } }
      : { json: { success: true, data: customer } }));
    await page.route('**/admin/stores/*/customers/taylor', async route => {
      await new Promise<void>(resolve => { releaseOther = resolve; });
      await route.fulfill({ json: { success: true, data: other } });
    });
    await page.route('**/admin/stores/*/customers/*/orders', async route => {
      if (holdOrders) await new Promise<void>(resolve => { releaseOrder = resolve; });
      await route.fulfill(orderStatus ? { status: orderStatus, json: { success: false, message: 'Orders read failed' } } : { json: { success: true, data: orders } });
    });
    await page.goto('/customers');
    await page.getByRole('link', { name: customer.displayName, exact: true }).click();
    const detail = page.getByTestId('merchant-customer-detail');
    const card = page.getByTestId('merchant-customer-card');
    const history = page.getByTestId('merchant-customer-orders');
    const retry = history.getByRole('button', { name: copy.common.retry, exact: true });
    const empty = history.getByText(copy.customers.detail.noOrders, { exact: true });
    await expect(card).toContainText(customer.displayName);
    await expect(history.getByText(copy.orders.loadFailed, { exact: true })).toBeVisible();
    await expect(empty).toHaveCount(0);
    const originalCard = await card.elementHandle();
    orderStatus = 0; holdOrders = true;
    await retry.click(); await expect.poll(() => Boolean(releaseOrder)).toBe(true);
    await expect(history.getByRole("progressbar", { name: copy.common.loading, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: copy.common.back, exact: true })).toBeVisible();
    await expect(empty).toHaveCount(0);
    holdOrders = false; releaseOrder!();
    const link = history.getByRole('link', { name: order.orderNumber, exact: true });
    await expect(link).toBeVisible();
    // The real provider refetches stale queries on reconnect. Advance its five
    // minute freshness window, then exercise that browser transport event.
    const reconnect = async () => {
      await page.clock.fastForward(301_000);
      await context.setOffline(true); await context.setOffline(false);
    };
    customerStatus = 503; orderStatus = 503;
    await reconnect();
    await expect(detail.getByText(copy.customers.detail.loadError, { exact: true })).toBeVisible();
    await expect(history.getByText(copy.orders.loadFailed, { exact: true })).toBeVisible();
    await expect(link).toBeVisible(); await expect(empty).toHaveCount(0);
    expect(await originalCard!.evaluate(node => node.isConnected)).toBe(true);
    customerStatus = 0;
    await detail.getByRole('button', { name: copy.common.retry, exact: true }).first().click();
    await expect(detail.getByText(copy.customers.detail.loadError, { exact: true })).toHaveCount(0);
    orderStatus = 0; orders = [];
    await retry.click(); await expect(empty).toBeVisible(); await expect(link).toHaveCount(0);
    customerStatus = 403;
    await reconnect();
    await expect(detail.getByText(copy.customers.detail.loadError, { exact: true })).toBeVisible();
    await expect(card).toHaveCount(0); await expect(history).toHaveCount(0);
    customerStatus = 0;
    await detail.getByRole('button', { name: copy.common.retry, exact: true }).click();
    await expect(card).toContainText(customer.displayName);
    await page.getByRole('button', { name: copy.common.back, exact: true }).click();
    await page.getByRole('link', { name: other.displayName, exact: true }).click();
    await expect.poll(() => Boolean(releaseOther)).toBe(true);
    await expect(page.getByText(customer.displayName, { exact: true })).toHaveCount(0);
    await expect(card).toHaveCount(0);
    releaseOther!();
    await expect(card).toContainText(other.displayName);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/wholesale-customer-detail-${width}-${locale}.png`, fullPage: true });
  });
}
