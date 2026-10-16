import { expect, test } from '@playwright/test';
import type { DualMoney, MerchantOrder, OrderPickup } from '@mercaria/shared-types';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

for (const [width, locale, mode] of [
  [1440, 'en', 'light'],
  [390, 'ar', 'dark'],
] as const) {
  test(`pickup errors retain drafts and never enable stale handover at ${width}px ${locale}`, async ({
    page,
    context,
  }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode);
    await page.clock.install();
    await page.setViewportSize({ width, height: 1100 });
    let canFulfill = true;
    await page.route('**/admin/stores', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: [
            {
              id: 'store-preview',
              name: 'Demo Atelier',
              defaultCurrency: 'EUR',
              access: { permissions: ['orders:read', ...(canFulfill ? ['orders:fulfill'] : [])] },
            },
          ],
        },
      }),
    );
    const money = (amount: number): DualMoney => ({
      shop: { amount, currency: 'EUR' },
      presentment: { amount, currency: 'EUR' },
    });
    const order: MerchantOrder = {
      id: 'pickup-order',
      orderNumber: '#1003',
      status: 'paid',
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
      shipping: { method: 'pickup', label: 'Collection', cost: money(0) },
      shippingAddress: {
        recipientName: 'Jordan Smith',
        line1: '43 Example Street',
        city: 'Barcelona',
        postalCode: '08007',
        country: 'ES',
      },
      statusHistory: [],
    };
    await page.route('**/admin/stores/*/orders/pickup-order', (route) =>
      route.fulfill({ json: { success: true, data: order } }),
    );
    const pickup: OrderPickup = {
      orderId: order.id,
      locationId: 'counter',
      state: 'awaiting_preparation',
      displayName: 'Collection counter',
      address: {
        line1: '43 Example Street',
        city: 'Barcelona',
        postalCode: '08007',
        country: 'ES',
      },
      timezone: 'Europe/Madrid',
      identityRequirement: 'collection_code',
      paymentRequirement: 'prepaid',
    };
    let status = 503;
    let hold = false;
    let release: (() => void) | undefined;
    await page.route('**/orders/pickup-order/pickup', async (route) => {
      const response = status
        ? { status, json: { success: false, message: 'Fixture pickup read failure' } }
        : { json: { success: true, data: { pickup, events: [] } } };
      if (hold)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return route.fulfill(response);
    });
    const writes: unknown[] = [];
    let releaseWrite: (() => void) | undefined;
    await page.route('**/orders/pickup-order/pickup/*', async (route) => {
      writes.push(route.request().postDataJSON());
      await new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      return route.fulfill({
        status: 503,
        json: { success: false, message: 'Fixture handover failure' },
      });
    });
    await page.goto('/orders/pickup-order');
    const desk = page.getByTestId('merchant-pickup-desk');
    const error = desk.getByText(copy.orders.pickup.loadFailed, { exact: true });
    const retry = desk.getByRole('button', { name: copy.common.retry, exact: true });
    await expect(error).toBeVisible();
    await expect(desk.getByRole('textbox')).toHaveCount(0);
    status = 0;
    hold = true;
    await retry.click();
    await expect.poll(() => Boolean(release)).toBe(true);
    await expect(
      desk.getByRole('progressbar', { name: copy.common.loading, exact: true }),
    ).toBeVisible();
    hold = false;
    release!();
    const code = desk.getByRole('textbox', { name: copy.orders.pickup.codeLabel, exact: true });
    const collect = desk.getByRole('button', {
      name: copy.orders.pickup.checkCodeAndHandOver,
      exact: true,
    });
    await expect(code).toBeEnabled();
    await code.fill('ABCD234567');
    const node = await code.elementHandle();
    const reconnect = async () => {
      await page.clock.fastForward(301000);
      await context.setOffline(true);
      await context.setOffline(false);
    };
    status = 503;
    await reconnect();
    await expect(error).toBeVisible();
    await expect(code).toHaveValue('ABCD234567');
    await expect(code).toBeDisabled();
    await expect(collect).toBeDisabled();
    expect(await node!.evaluate((element) => element.isConnected)).toBe(true);
    status = 0;
    await retry.click();
    await expect(code).toBeEnabled();
    await expect(code).toHaveValue('ABCD234567');
    await collect.click();
    await expect.poll(() => writes.length).toBe(1);
    await expect(code).toBeDisabled();
    await expect(
      desk.getByRole('textbox', { name: copy.orders.pickup.rotateLabel, exact: true }),
    ).toBeDisabled();
    releaseWrite!();
    await expect(collect).toBeEnabled();
    await expect(code).toHaveValue('ABCD234567');
    expect(writes).toEqual([{ code: 'ABCD234567' }]);
    status = 403;
    await reconnect();
    await expect(error).toBeVisible();
    await expect(desk.getByText(pickup.displayName, { exact: true })).toHaveCount(0);
    await expect(code).toHaveCount(0);
    status = 0;
    await retry.click();
    await expect(code).toBeEnabled();
    await desk.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `/tmp/mercaria-merchant-pickup-${width}-${locale}.png`,
      fullPage: true,
    });
    status = 404;
    await reconnect();
    await expect(desk).toHaveCount(0);
    status = 0;
    canFulfill = false;
    await page.reload();
    await expect(desk.getByText(pickup.displayName, { exact: true })).toBeVisible();
    await expect(desk.getByRole('textbox')).toHaveCount(0);
    await expect(collect).toHaveCount(0);
    expect(writes).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
