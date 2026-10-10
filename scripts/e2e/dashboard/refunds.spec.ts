import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

for (const [width, locale, mode] of [[1440, 'en', 'light'], [390, 'en', 'light'], [390, 'ar', 'light'], [390, 'en', 'dark']] as const) {
  test(`refund quantities and retries stay exact at ${width}px ${locale} ${mode}`, async ({ page }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode);
    await page.setViewportSize({ width, height: 1100 });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    let writable = true;
    await page.route('**/admin/stores', route => route.fulfill({ json: { success: true, data: [{ id: 'store-preview', name: 'Demo Atelier', handle: 'demo-atelier', defaultCurrency: 'EUR',
      access: { permissions: ['orders:read', ...(writable ? ['refunds:write'] : [])] } }] } }));
    const money = (amount: number) => ({ shop: { amount, currency: 'EUR' }, presentment: { amount, currency: 'EUR' } });
    const order = { id: 'refund-order', orderNumber: '#1003', status: 'partially_refunded', payment: { status: 'paid' }, createdAt: '2026-10-08T12:00:00Z', buyer: { displayLabel: 'Jordan Smith' },
      items: [{ listingId: 'shirt', variantId: 'shirt-variant', title: 'Linen studio shirt', variantTitle: 'Natural / Medium', quantity: 5, optionValues: [], unitPrice: money(1000), lineTotal: money(5000) },
        { listingId: 'bag', variantId: 'bag-variant', title: 'Cotton bag', variantTitle: 'Natural', quantity: 1, optionValues: [], unitPrice: money(500), lineTotal: money(500) }],
      totals: { subtotal: money(5500), discountTotal: money(0), tax: money(0), shipping: money(0), grandTotal: money(5500) }, shipping: {}, statusHistory: [] };
    await page.route('**/admin/stores/*/orders/refund-order', route => route.fulfill({ json: { success: true, data: order } }));
    const refunds = [
      { id: 'prior-pending', orderId: order.id, status: 'refunded', providerState: 'pending', createdAt: '2026-10-09T10:00:00Z', totalRefunded: money(1000), lineItems: [{ variantId: 'shirt-variant', quantity: 1, restock: false }] },
      { id: 'prior-failed', orderId: order.id, status: 'refunded', providerState: 'failed', createdAt: '2026-10-09T11:00:00Z', totalRefunded: money(2500), lineItems: [{ variantId: 'shirt-variant', quantity: 2, restock: true }, { variantId: 'bag-variant', quantity: 1, restock: false }] },
    ];
    let readError = true;
    const writes: { lineItems: { variantId: string; quantity: number }[]; idempotencyKey: string; reason?: string }[] = [];
    const committed = new Map<string, typeof refunds[number]>();
    let writeMode: 'reject' | 'lost' | 'replay' = 'reject';
    let release: (() => void) | undefined;
    await page.route('**/orders/refund-order/refunds', async route => {
      if (route.request().method() === 'GET') return readError
        ? route.fulfill({ status: 502, json: { success: false, message: 'Fixture read failure' } })
        : route.fulfill({ json: { success: true, data: refunds } });
      const body = route.request().postDataJSON(); writes.push(body);
      if (writeMode === 'reject') return route.fulfill({ status: 409, json: { success: false, message: 'Fixture conflict' } });
      if (writeMode === 'lost') {
        const refund = { id: 'created-refund', orderId: order.id, status: 'refunded', providerState: 'pending', createdAt: '2026-10-09T12:00:00Z', totalRefunded: money(1000), lineItems: body.lineItems };
        committed.set(body.idempotencyKey, refund); refunds.push(refund);
        return route.abort('failed');
      }
      await new Promise<void>(resolve => { release = resolve; });
      return route.fulfill({ json: { success: true, data: committed.get(body.idempotencyKey) } });
    });
    await page.goto('/orders/refund-order');
    const open = page.getByRole('button', { name: copy.orders.detail.refund, exact: true });
    await open.click();
    const form = page.getByTestId('merchant-refund-form');
    const quantity = form.getByRole('textbox', { name: copy.orders.refund.quantityLabel.replace('%{item}', 'Linen studio shirt'), exact: true });
    const exhausted = form.getByRole('textbox', { name: copy.orders.refund.quantityLabel.replace('%{item}', 'Cotton bag'), exact: true });
    const reason = form.getByRole('textbox', { name: copy.orders.refund.reasonLabel, exact: true });
    const submit = form.getByRole('button', { name: copy.orders.refund.submit, exact: true });
    await expect(form.getByText(copy.orders.refund.loadFailed, { exact: true })).toBeVisible();
    await expect(submit).toBeDisabled(); await expect(quantity).toBeDisabled();
    readError = false; await form.getByRole('button', { name: copy.common.retry, exact: true }).click();
    await expect(quantity).toBeEnabled(); await expect(exhausted).toBeDisabled();
    await expect(form.getByText(copy.orders.refund.itemMax.replace('%{variant}', 'Natural / Medium').replace('%{quantity}', '2'), { exact: true })).toBeVisible();
    await submit.click(); await expect(form.getByText(copy.orders.refund.quantityRequired, { exact: true })).toBeVisible();
    for (const value of ['2.5', '2items', '-1', '3', '9007199254740992']) {
      await quantity.fill(value); await expect(submit).toBeDisabled();
      await expect(form.getByText(copy.orders.refund.quantityInvalid.replace('%{quantity}', '2'), { exact: true })).toBeVisible();
    }
    expect(writes).toEqual([]);
    await quantity.fill('1'); await reason.fill('Customer request'); await submit.click();
    await expect(form.getByText(copy.orders.refund.failed, { exact: true })).toBeVisible();
    await expect(quantity).toHaveValue('1'); await expect(reason).toHaveValue('Customer request');
    const firstKey = writes[0].idempotencyKey;
    writeMode = 'lost'; await quantity.fill('2'); await submit.click();
    await expect.poll(() => writes.length).toBe(2);
    await expect(submit).toBeEnabled(); await expect(form.getByText(copy.orders.refund.failed, { exact: true })).toBeVisible();
    expect(writes[1].idempotencyKey).not.toBe(firstKey);
    expect(writes[1].lineItems).toEqual([{ variantId: 'shirt-variant', quantity: 2 }]);
    // Closing/reopening refreshes the recorded refund and reduces remaining to
    // zero; its lost response must still be confirmable with the original key.
    await page.keyboard.press('Escape'); await expect(form).toHaveCount(0);
    await open.click();
    await expect(form.getByText(copy.orders.refund.itemMax.replace('%{variant}', 'Natural / Medium').replace('%{quantity}', '0'), { exact: true })).toBeVisible();
    await expect(quantity).toHaveValue('2'); await expect(submit).toBeEnabled();
    await reason.fill('A changed request'); await expect(submit).toBeDisabled();
    await reason.fill('Customer request'); await expect(submit).toBeEnabled();
    await page.screenshot({ path: `/tmp/mercaria-refund-${width}-${locale}-${mode}.png`, fullPage: true });
    writeMode = 'replay'; await submit.click(); await expect.poll(() => writes.length).toBe(3);
    expect(writes[2]).toEqual(writes[1]);
    await expect(quantity).toBeDisabled(); await expect(reason).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(form).toBeVisible();
    await expect(form.getByRole('button', { name: copy.common.cancel, exact: true })).toBeDisabled();
    release!(); await expect(form).toHaveCount(0); expect(committed.size).toBe(1);
    await open.click(); await expect(quantity).toBeDisabled();
    await expect(form.getByText(copy.orders.refund.itemMax.replace('%{variant}', 'Natural / Medium').replace('%{quantity}', '0'), { exact: true })).toBeVisible();
    await expect(quantity).toHaveValue('');
    await page.keyboard.press('Escape'); await expect(form).toHaveCount(0);
    order.payment.status = 'pending'; await page.reload(); await open.click();
    await expect(form.getByText(copy.orders.refund.unavailable, { exact: true })).toBeVisible();
    await expect(quantity).toBeDisabled(); await expect(submit).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(form).toHaveCount(0);
    writable = false; await page.reload(); await expect(open).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
