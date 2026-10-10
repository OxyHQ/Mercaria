import { expect, test, type Locator } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

for (const [width, locale, mode] of [[1440, 'en', 'light'], [390, 'en', 'light'], [390, 'ar', 'light'], [390, 'en', 'dark']] as const) {
  test(`customer order history opens with keyboard and browser links at ${width}px ${locale} ${mode}`, async ({ page }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode); await page.setViewportSize({ width, height: 1100 });
    let orderAccess = true;
    await page.route('**/admin/stores', route => route.fulfill({ json: { success: true, data: [{ id: 'store-preview', name: 'Demo Atelier', handle: 'demo-atelier', defaultCurrency: 'EUR',
      access: { permissions: ['customers:read', ...(orderAccess ? ['orders:read'] : [])] } }] } }));
    const customer = { id: 'keyboard-customer', storeId: 'store-preview', displayName: 'Jordan Smith', isWalkIn: false, tags: [], groupTags: [],
      stats: { orderCount: 1, totalSpent: { amount: 9800, currency: 'EUR' } }, createdAt: '2026-10-08T12:00:00Z', updatedAt: '2026-10-08T12:00:00Z' };
    const secondCustomer = { ...customer, id: 'second-customer', displayName: 'Taylor Parker' };
    const order = { id: 'keyboard-order', orderNumber: '#1042', status: 'paid', createdAt: '2026-10-08T12:00:00Z',
      grandTotal: { shop: { amount: 9800, currency: 'EUR' }, presentment: { amount: 9800, currency: 'EUR' } } };
    let release: (() => void) | undefined;
    await page.route('**/admin/stores/*/customers?**', async route => {
      const current = Number(new URL(route.request().url()).searchParams.get('page'));
      if (current === 2) await new Promise<void>(resolve => { release = resolve; });
      return route.fulfill({ json: { success: true, data: [current === 2 ? secondCustomer : customer], pagination: { total: 21, page: current, limit: 20, pages: 2 } } });
    });
    await page.route('**/admin/stores/*/customers/keyboard-customer', route => route.fulfill({ json: { success: true, data: customer } }));
    await page.route('**/admin/stores/*/customers/keyboard-customer/orders', route => route.fulfill({ json: { success: true, data: [order] } }));
    const enter = async (link: Locator, href: string) => {
      await expect(link).toHaveAttribute('href', href);
      await link.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab'); await expect(link).toBeFocused();
      await page.keyboard.press('Enter'); await expect(page).toHaveURL(new RegExp(`${href}$`));
    };
    const newTab = async (link: Locator, href: string) => {
      const initial = page.url();
      const opened = page.context().waitForEvent('page'); await link.click({ modifiers: ['Control'] });
      const tab = await opened; await expect(tab).toHaveURL(new RegExp(`${href}$`)); await tab.close();
      await expect(page).toHaveURL(initial);
    };
    await page.goto('/customers');
    const customerLink = page.getByRole('link', { name: customer.displayName, exact: true });
    await newTab(customerLink, '/customers/keyboard-customer');
    await enter(customerLink, '/customers/keyboard-customer');
    const orderLink = page.getByRole('link', { name: order.orderNumber, exact: true });
    await newTab(orderLink, '/orders/keyboard-order');
    await enter(orderLink, '/orders/keyboard-order');
    await page.goBack(); await expect(orderLink).toBeVisible();
    const back = page.getByRole('button', { name: copy.common.back, exact: true });
    await back.focus(); await page.keyboard.press('Enter'); await expect(page).toHaveURL(/\/customers$/);
    const next = page.getByRole('button', { name: copy.resourceList.next, exact: true });
    await next.focus(); await page.keyboard.press('Enter'); await expect.poll(() => Boolean(release)).toBe(true);
    // Preserved rows are only placeholders until the requested page arrives.
    await expect(customerLink).toHaveCount(0);
    const placeholder = page.getByLabel(customer.displayName, { exact: true });
    await expect(placeholder).not.toHaveAttribute('href'); await expect(placeholder).toHaveAttribute('aria-disabled', 'true');
    await expect(next).toBeDisabled(); await expect(page.getByRole('button', { name: copy.resourceList.previous, exact: true })).toBeDisabled();
    release!();
    await expect(page.getByRole('link', { name: secondCustomer.displayName, exact: true })).toHaveAttribute('href', '/customers/second-customer');
    await page.screenshot({ path: `/tmp/mercaria-customer-links-${width}-${locale}-${mode}.png`, fullPage: true });
    orderAccess = false; await page.goto('/customers/keyboard-customer');
    await expect(page.getByText(order.orderNumber, { exact: true })).toBeVisible();
    await expect(orderLink).toHaveCount(0);
    await expect(page.getByLabel(order.orderNumber, { exact: true })).not.toHaveAttribute('href');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
