import { test, expect } from '@playwright/test';
import { fixture, group } from './peable-fixture';

const product = {
  id: 'listing',
  ownerType: 'store',
  title: 'Fixture sweater',
  description: 'A fixture sweater.',
  price: group.subtotal,
  condition: 'new',
  itemCondition: { key: 'new', segment: 'new', source: 'merchant' },
  status: 'active',
  category: 'clothing',
  images: [],
  tags: [],
  quantity: 5,
  store: { id: 'shop', name: 'Fixture shop', handle: 'fixture-shop' },
  options: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  variants: [
    {
      id: 'variant',
      title: 'Medium',
      optionValues: [],
      price: group.subtotal,
      available: 5,
      inStock: true,
      commercial: group.commercial,
    },
  ],
};

for (const width of [1440, 390]) {
  test(`Buy now opens Peable over the selected product (${width})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const checkoutRequests = await fixture(page, true);
    await page.route('**/listings/listing', (route) =>
      route.fulfill({ json: { success: true, data: product } }),
    );
    const additions: unknown[] = [];
    await page.route('**/cart/items', (route) => {
      additions.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          success: true,
          data: {
            id: 'cart',
            currency: 'USD',
            items: group.items,
            groups: [group],
            subtotal: group.subtotal,
          },
        },
      });
    });
    await page.goto('/products/listing?variantId=variant');
    await page.getByRole('button', { name: 'Buy now', exact: true }).click();
    await expect(page.getByTestId('bloom-checkout-step')).toBeVisible();
    await expect(page).toHaveURL(/\/products\/listing\?variantId=variant$/);
    expect(additions).toEqual([{ listingId: 'listing', variantId: 'variant', quantity: 1 }]);
    expect(checkoutRequests).toHaveLength(0);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText('10 Example Street', { exact: false })).toBeVisible();
    await expect(page).toHaveURL(/\/products\/listing\?variantId=variant$/);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText('Please retry this same payment.')).toBeVisible();
    expect(checkoutRequests).toHaveLength(1);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('bloom-checkout-step')).toHaveCount(0);
    await page.getByRole('button', { name: 'Buy now', exact: true }).click();
    await expect(page.getByTestId('bloom-checkout-step')).toBeVisible();
    expect(additions).toHaveLength(1);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.poll(() => checkoutRequests.length).toBe(2);
    expect(checkoutRequests[1]).toEqual(checkoutRequests[0]);
  });

  test(`home cart shelf opens Peable without leaving home (${width})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const requests = await fixture(page, true);
    await page.goto('/');
    await page.getByRole('button', { name: 'Continue to checkout', exact: true }).click();
    await expect(page.getByTestId('bloom-checkout-step')).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    expect(requests).toHaveLength(0);
  });

  test(`saved pickup entry opens the same sheet and preserves pickup destination (${width})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const requests = await fixture(page, true);
    await page.goto('/checkout?seller=store%3Ashop&pickup=pickup-fixture');
    await expect(page.getByTestId('bloom-checkout-step')).toBeVisible();
    await expect(page).toHaveURL(/\/cart(?:\?|$)/);
    const sheet = page.locator('[role="dialog"]:visible').last();
    await expect(sheet.getByText('Alex Example', { exact: true })).toBeVisible();
    await sheet.evaluate((element) => element.setAttribute('data-pickup-mount', 'original'));
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(sheet).toHaveAttribute('data-pickup-mount', 'original');
    const email = page.getByRole('textbox', {
      name: 'Email',
      exact: true,
    });
    await expect(email).toBeVisible();
    await email.fill('collector@example.test');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].body).toMatchObject({
      destination: {
        type: 'pickup',
        locationId: 'pickup-fixture',
        pickupContact: { email: 'collector@example.test' },
      },
    });
    await expect(page).toHaveURL(/\/cart(?:\?|$)/);
  });
}
