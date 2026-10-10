import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import { fixture } from './fixture';

for (const width of [390, 1440]) {
  test(`hovered error toast does not consume the first outside click at ${width}px`, async ({ page }) => {
    await fixture(page, 'en', 'light');
    await page.setViewportSize({ width, height: 1100 });
    const product = {
      id: 'toast-product', title: 'Toast interaction fixture', description: '',
      category: 'clothing', status: 'draft', tags: [], images: [], options: [],
      quantity: 3, overriddenFields: [], price: { amount: 1200, currency: 'EUR' },
      variants: [{ id: 'toast-variant', title: 'Natural', available: 3, inStock: true,
        price: { amount: 1200, currency: 'EUR' }, optionValues: [] }],
    };
    await page.route('**/admin/stores/*/products/toast-product', route => route.request().method() === 'PATCH'
      ? route.fulfill({ status: 503, json: { success: false, error: 'Temporary test outage' } })
      : route.fulfill({ json: { success: true, data: product } }));
    await page.route('**/variants/toast-variant/levels', route => route.fulfill({ json: { success: true, data: [] } }));
    await page.goto('/products/toast-product');
    await page.getByRole('button', { name: en.products.detail.saveChanges, exact: true }).click();
    const toast = page.locator('#bloom-portal-root [aria-live]').filter({ hasText: en.products.detail.saveFailed });
    await expect(toast).toBeVisible();
    const target = page.getByRole('button', { name: en.products.variants.inventory.manage, exact: true });
    await target.scrollIntoViewIfNeeded();
    const rect = await target.boundingBox();
    expect(rect).not.toBeNull();
    await toast.hover();
    // One physical click: locator.click retries interception and would mask
    // the lost first click that users experienced with Bloom's old backdrop.
    await page.mouse.click(rect!.x + rect!.width / 2, rect!.y + rect!.height / 2);
    await expect(target).toHaveAttribute('aria-expanded', 'true', { timeout: 2000 });
    await expect(page.getByTestId('merchant-variant-inventory')).toContainText(en.products.variants.inventory.empty);
  });
}
