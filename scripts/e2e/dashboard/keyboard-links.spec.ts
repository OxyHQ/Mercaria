import { expect, test, type Locator } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

for (const [width, locale, mode] of [
  [1440, 'en', 'light'],
  [390, 'en', 'light'],
  [390, 'ar', 'light'],
  [390, 'en', 'dark'],
] as const) {
  test(`merchant destinations expose real keyboard links at ${width}px ${locale} ${mode}`, async ({
    page,
  }) => {
    const copy = locale === 'ar' ? ar : en;
    await fixture(page, locale, mode);
    await page.setViewportSize({ width, height: 1100 });
    let productAccess = true;
    await page.route('**/admin/stores', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: [
            {
              id: 'store-preview',
              name: 'Demo Atelier',
              handle: 'demo-atelier',
              defaultCurrency: 'EUR',
              access: {
                permissions: [
                  'stats:read',
                  'products:write',
                  'orders:read',
                  'locations:write',
                  ...(productAccess ? ['products:read'] : []),
                ],
              },
            },
          ],
        },
      }),
    );
    const product = {
      id: 'keyboard-product',
      title: 'Keyboard product',
      status: 'draft',
      images: [],
      variants: [],
      quantity: 0,
      price: { amount: 4900, currency: 'EUR' },
    };
    await page.route('**/admin/stores/*/products?**', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: [product],
          pagination: { total: 1, page: 1, limit: 20, pages: 1 },
        },
      }),
    );
    await page.route('**/admin/stores/*/orders?**', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: [
            {
              id: 'keyboard-order',
              orderNumber: '#1042',
              status: 'paid',
              createdAt: '2026-10-08T12:00:00Z',
              itemCount: 2,
              buyer: { displayLabel: 'Jordan Smith' },
              grandTotal: {
                shop: { amount: 9800, currency: 'EUR' },
                presentment: { amount: 9800, currency: 'EUR' },
              },
            },
          ],
          pagination: { total: 1, page: 1, limit: 20, pages: 1 },
        },
      }),
    );
    await page.route('**/catalog-authoring/categories?**', (route) =>
      route.fulfill({ json: { success: true, data: { categories: [] } } }),
    );
    await page.route('**/stores/*/product-drafts?**', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: { drafts: [{ id: 'keyboard-draft', title: 'Keyboard draft' }] },
        },
      }),
    );
    let locations = [
      {
        id: 'keyboard-location',
        name: 'Keyboard warehouse',
        type: 'warehouse',
        isDefault: false,
        isActive: true,
      },
    ];
    await page.route('**/admin/stores/*/locations', (route) =>
      route.fulfill({ json: { success: true, data: locations } }),
    );
    const deletes: string[] = [];
    await page.route('**/admin/stores/*/locations/keyboard-location', (route) => {
      if (route.request().method() === 'DELETE') {
        deletes.push(route.request().url());
        locations = [];
        return route.fulfill({
          json: { success: true, data: { id: 'keyboard-location', deleted: true } },
        });
      }
      return route.fulfill({
        status: 404,
        json: { success: false, message: 'Fixture detail not provided' },
      });
    });
    const enter = async (link: Locator, href: string) => {
      await expect(link).toHaveAttribute('href', href);
      await link.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(link).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`${href}$`));
    };
    await page.goto('/products');
    const productLink = page.getByRole('link', { name: product.title, exact: true });
    await expect(productLink).toHaveAttribute('href', '/products/keyboard-product');
    // Modified click must keep the list and allow the browser to open a tab.
    const popupPromise = page.context().waitForEvent('page');
    await productLink.click({ modifiers: ['Control'] });
    const popup = await popupPromise;
    await expect(popup).toHaveURL(/\/products\/keyboard-product$/);
    await popup.close();
    await expect(page).toHaveURL(/\/products$/);
    await enter(productLink, '/products/keyboard-product');
    await page.goto('/orders');
    await enter(page.getByRole('link', { name: '#1042', exact: true }), '/orders/keyboard-order');
    await page.goto('/');
    await enter(
      page.getByRole('link', { name: 'Linen studio shirt', exact: true }),
      '/products/best-product',
    );
    productAccess = false;
    await page.goto('/');
    await expect(page.getByText('Linen studio shirt', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Linen studio shirt', exact: true })).toHaveCount(
      0,
    );
    productAccess = true;
    await page.goto('/products/wizard');
    await enter(
      page.getByRole('link', { name: 'Keyboard draft', exact: true }),
      '/products/wizard/keyboard-draft',
    );
    await page.goto('/settings/locations');
    await enter(
      page.getByRole('link', { name: 'Keyboard warehouse', exact: true }),
      '/settings/locations/keyboard-location',
    );
    await page.goto('/settings/locations');
    const remove = page.getByRole('button', {
      name: copy.settings.locations.deleteAction.replace('%{name}', 'Keyboard warehouse'),
      exact: true,
    });
    expect(await remove.evaluate((element) => element.closest('a'))).toBeNull();
    await remove.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => deletes.length).toBe(1);
    await expect(page).toHaveURL(/\/settings\/locations$/);
    await expect(page.getByRole('link', { name: 'Keyboard warehouse', exact: true })).toHaveCount(
      0,
    );
  });
}
