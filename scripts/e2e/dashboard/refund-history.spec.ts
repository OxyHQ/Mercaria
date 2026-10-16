import { expect, test } from '@playwright/test';
import type { DualMoney, MerchantOrder } from '@mercaria/shared-types';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

for (const [width, locale, mode] of [
  [1440, 'en', 'light'],
  [390, 'ar', 'dark'],
] as const) {
  test(`refund history distinguishes empty, denied and transient errors at ${width}px ${locale}`, async ({
    page,
    context,
  }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode);
    await page.clock.install();
    await page.setViewportSize({ width, height: 1100 });
    const money = (amount: number): DualMoney => ({
      shop: { amount, currency: 'EUR' },
      presentment: { amount, currency: 'EUR' },
    });
    const order: MerchantOrder = {
      id: 'history-order',
      orderNumber: '#1003',
      status: 'partially_refunded',
      payment: { status: 'paid' },
      createdAt: '2026-10-08T12:00:00Z',
      updatedAt: '2026-10-08T12:00:00Z',
      sellerType: 'store',
      storeId: 'store-preview',
      sourceChannel: 'storefront',
      checkoutGroupId: 'history-checkout',
      commercial: {
        mode: 'connected_marketplace',
        sellerKind: 'store',
        sellerLabel: 'Demo Atelier',
        sellerRole: 'direct',
        disclosures: [],
      },
      buyer: { displayLabel: 'Jordan Smith' },
      items: [
        {
          listingId: 'shirt',
          variantId: 'shirt-variant',
          title: 'Linen studio shirt',
          variantTitle: 'Natural / Medium',
          quantity: 5,
          condition: { recorded: false },
          optionValues: [],
          unitPrice: money(1000),
          lineTotal: money(5000),
        },
      ],
      totals: {
        subtotal: money(5000),
        discountTotal: money(0),
        tax: money(0),
        shipping: money(0),
        grandTotal: money(5000),
      },
      shipping: { method: 'standard', label: 'Standard', cost: money(0) },
      shippingAddress: {
        recipientName: 'Jordan Smith',
        line1: '43 Example Street',
        city: 'Barcelona',
        postalCode: '08007',
        country: 'ES',
      },
      statusHistory: [],
    };
    await page.route('**/admin/stores/*/orders/history-order', (route) =>
      route.fulfill({ json: { success: true, data: order } }),
    );
    let status = 503;
    let hold = false;
    let release: (() => void) | undefined;
    let writes = 0;
    let refunds = [
      {
        id: 'prior-refund',
        orderId: order.id,
        status: 'refunded',
        rmaNumber: 'RMA-1042',
        createdAt: '2026-10-09T10:00:00Z',
        totalRefunded: money(1000),
        lineItems: [{ variantId: 'shirt-variant', quantity: 1, restock: false }],
      },
    ];
    await page.route('**/orders/history-order/refunds', async (route) => {
      if (route.request().method() !== 'GET') writes++;
      if (hold)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return route.fulfill(
        status
          ? { status, json: { success: false, message: 'Fixture read failed' } }
          : { json: { success: true, data: refunds } },
      );
    });
    await page.goto('/orders/history-order');
    await expect(page.getByText(copy.orders.detail.shipToNone, { exact: true })).toHaveCount(0);
    await expect(page.getByText(order.shippingAddress!.line1, { exact: true })).toBeVisible();
    const history = page.getByTestId('merchant-refund-history');
    const state = page.getByTestId('merchant-refund-history-status');
    const retry = state.getByRole('button', { name: copy.common.retry, exact: true });
    const error = state.getByText(copy.orders.detail.refundsLoadFailed, { exact: true });
    await expect(error).toBeVisible();
    await expect(history).toBeEmpty();
    // Buyer label and the immutable recipient both remain visible.
    const buyerAndRecipient = page.getByText(order.buyer.displayLabel, { exact: true });
    await expect(buyerAndRecipient).toHaveCount(2);
    await expect(buyerAndRecipient.first()).toBeVisible();
    await expect(buyerAndRecipient.last()).toBeVisible();
    status = 0;
    hold = true;
    await retry.click();
    await expect.poll(() => Boolean(release)).toBe(true);
    await expect(
      state.getByRole('progressbar', { name: copy.common.loading, exact: true }),
    ).toBeVisible();
    hold = false;
    release!();
    await expect(history).toContainText('RMA-1042');
    const original = await history.elementHandle();
    const reconnect = async () => {
      await page.clock.fastForward(301_000);
      await context.setOffline(true);
      await context.setOffline(false);
    };
    status = 503;
    await reconnect();
    await expect(error).toBeVisible();
    await expect(history).toContainText('RMA-1042');
    expect(await original!.evaluate((node) => node.isConnected)).toBe(true);
    status = 403;
    await retry.click();
    await expect(error).toBeVisible();
    await expect(history).toBeEmpty();
    status = 0;
    await retry.click();
    await expect(history).toContainText('RMA-1042');
    await page.screenshot({
      path: `/tmp/wholesale-refund-history-${width}-${locale}.png`,
      fullPage: true,
    });
    refunds = [];
    await reconnect();
    await expect(history).toHaveCount(0);
    await expect(error).toHaveCount(0);
    // A confirmed empty cache stays absent during a background refresh.
    hold = true;
    release = undefined;
    await reconnect();
    await expect.poll(() => Boolean(release)).toBe(true);
    await expect(history).toHaveCount(0);
    await expect(state).toHaveCount(0);
    hold = false;
    release!();
    await expect(history).toHaveCount(0);
    expect(writes).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
