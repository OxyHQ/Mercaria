import { test, expect } from '@playwright/test';
import { fixture, address } from './peable-fixture';

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`account destination inside the canonical sheet; frozen retry (${viewport.width})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const requests = await fixture(page, true);
    await page.goto('/cart');
    await page
      .getByRole('button', { name: 'Continue to checkout with Fixture shop', exact: true })
      .click();
    await expect(page).toHaveURL(/\/cart$/);
    await expect(page.getByTestId('bloom-checkout-step')).toBeVisible();
    expect(requests).toHaveLength(0);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText('10 Example Street', { exact: false })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Email address', exact: true })).toHaveCount(0);
    expect(requests).toHaveLength(0);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText('Please retry this same payment.')).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toMatchObject({
      destination: {
        type: 'inline_shipping_address',
        address: { recipientName: address.recipientName, line1: address.line1 },
      },
    });
    expect(requests[0].body).not.toHaveProperty('contact');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]).toEqual(requests[0]);
    await page.screenshot({ path: `/tmp/mercaria-peable-${viewport.width}.png` });
  });
}

test('authoritative repricing and cart invalidation retain the same sheet before Pay', async ({
  page,
}) => {
  const payerUpdates: unknown[] = [];
  const cartResponses: number[] = [];
  const requests = await fixture(page, true, true, { payerUpdates, noEmail: true, cartResponses });
  await page.goto('/cart');
  await page
    .getByRole('button', { name: 'Continue to checkout with Fixture shop', exact: true })
    .click();
  await expect(page).toHaveURL(/\/cart$/);
  const artwork = page.getByRole('img', { name: 'Fixture sweater', exact: true });
  await expect(artwork).toBeVisible();
  await expect(artwork.locator('clipPath path')).toHaveAttribute('d', /.+/);
  const frame = page.getByTestId('bloom-checkout-step');
  const sheet = page.locator('[role="dialog"]:visible').last();
  await sheet.evaluate((element) => element.setAttribute('data-mount-probe', 'same'));
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByText('10 Example Street', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(frame.getByText('$35.00', { exact: true }).first()).toBeVisible();
  await expect(sheet).toHaveAttribute('data-mount-probe', 'same');
  expect(payerUpdates).toHaveLength(0);
  await expect.poll(() => cartResponses.includes(0)).toBe(true);
  await expect(frame).toBeVisible();
  expect(requests).toHaveLength(1);
  await expect(page.getByRole('textbox', { name: 'Email address', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(frame).not.toBeVisible();
  await page.getByRole('button', { name: 'Pay now', exact: true }).click();
  await expect(frame.getByText('$35.00', { exact: true }).first()).toBeVisible();
  expect(requests).toHaveLength(1);
});

test('a guest opens the same sheet and supplies contact inside it', async ({ page }) => {
  const requests = await fixture(page, false);
  await page.goto('/cart');
  await page
    .getByRole('button', { name: 'Continue to checkout with Fixture shop', exact: true })
    .click();
  await expect(page).toHaveURL(/\/cart$/);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Email address', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled();
  expect(requests).toHaveLength(0);
});

test('a structured profile place requires recipient review and an explicit private save', async ({
  page,
}) => {
  const saved: unknown[] = [];
  const requests = await fixture(page, true, false, { profileOnly: true, saved });
  await page.goto('/cart');
  await page
    .getByRole('button', { name: 'Continue to checkout with Fixture shop', exact: true })
    .click();
  await expect(page).toHaveURL(/\/cart$/);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'Full name', exact: true });
  await expect(name).toHaveValue('');
  await page.getByText('Home', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Street address', exact: true })).toHaveValue(
    '10 Example Street',
  );
  await expect(name).toHaveValue('');
  expect(saved).toHaveLength(0);
  expect(requests).toHaveLength(0);
  await name.fill('Delivery Recipient');
  await page.getByRole('button', { name: 'Save Delivery Recipient to Oxy', exact: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]).toMatchObject({
    recipientName: 'Delivery Recipient',
    line1: '10 Example Street',
    country: 'US',
  });
  expect(requests).toHaveLength(0);
});

test('guest receipt email flows through the payer API once without a second contact prompt', async ({
  page,
}) => {
  const payerUpdates: unknown[] = [];
  const requests = await fixture(page, false, true, { payerUpdates });
  await page.goto('/cart');
  await page
    .getByRole('button', { name: 'Continue to checkout with Fixture shop', exact: true })
    .click();
  await expect(page).toHaveURL(/\/cart$/);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Email address', exact: true })
    .fill('guest@example.test');
  await page.getByRole('textbox', { name: 'Full name', exact: true }).fill('Guest Recipient');
  await page
    .getByRole('textbox', { name: 'Street address', exact: true })
    .fill('10 Example Street');
  await page.getByRole('textbox', { name: 'City', exact: true }).fill('Wilmington');
  await page.getByRole('textbox', { name: 'Postal code', exact: true }).fill('19802');
  await page.getByRole('button', { name: 'Country', exact: true }).click();
  await page.getByText('United States', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(
    page.getByTestId('bloom-checkout-step').getByText('$35.00', { exact: true }).first(),
  ).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(payerUpdates).toEqual([{ customer_details: { email: 'guest@example.test' } }]);
  await expect(page.getByRole('textbox', { name: 'Email address', exact: true })).toHaveCount(0);
});

test('legacy checkout links open the same sheet over the cart without another pay button', async ({
  page,
}) => {
  const requests = await fixture(page, true);
  await page.goto('/checkout?seller=store%3Ashop');
  await expect(page.getByTestId('bloom-checkout-step')).toBeVisible();
  await expect(page).toHaveURL(/\/cart$/);
  expect(requests).toHaveLength(0);
});

test('a definitive seller refusal allows choosing another seller; closing an unknown attempt keeps its key', async ({
  page,
}) => {
  const requests = await fixture(page, true, false, { refuseSeller: true });
  await page.goto('/cart');
  await page
    .getByRole('button', { name: 'Continue to checkout with Fixture shop', exact: true })
    .click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByText(/Fixture shop isn't accepting/).last()).toBeVisible();
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: 'Continue to checkout with Other shop', exact: true })
    .click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].key).not.toBe(requests[0].key);
  expect(requests[1].body).toMatchObject({ sellerKeys: ['store:other'] });
  await expect(page.getByText('Please retry this same payment.')).toBeVisible();
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: 'Continue to checkout with Fixture shop', exact: true })
    .click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests[2]).toEqual(requests[1]);
});

test('a named refusal after an uncertain request never unlocks a different order', async ({
  page,
}) => {
  await fixture(page, true);
  const attempts: { key: string | undefined; body: unknown }[] = [];
  await page.route(
    (url) => url.origin === 'http://localhost:4160' && url.pathname === '/checkout',
    (route) => {
      attempts.push({
        key: route.request().headers()['idempotency-key'],
        body: route.request().postDataJSON(),
      });
      return route.fulfill(
        attempts.length === 1
          ? { status: 503, json: { success: false, message: 'Uncertain response' } }
          : {
              status: 409,
              json: {
                success: false,
                message: 'Seller unavailable',
                details: {
                  reason: 'seller_not_activated',
                  sellers: [{ sellerKey: 'store:shop', name: 'Fixture shop' }],
                },
              },
            },
      );
    },
  );
  await page.goto('/cart');
  await page
    .getByRole('button', { name: 'Continue to checkout with Fixture shop', exact: true })
    .click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByText('Uncertain response')).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByText(/Fixture shop isn't accepting/).last()).toBeVisible();
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: 'Continue to checkout with Fixture shop', exact: true })
    .click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => attempts.length).toBe(3);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[2]).toEqual(attempts[0]);
});

test('clearing guest authority discards private draft and the pending resume control', async ({
  page,
}) => {
  await fixture(page, false);
  await page.addInitScript(() =>
    localStorage.setItem('mercaria.guest.token', 'old-fixture-authority'),
  );
  await page.goto('/cart');
  await page
    .getByRole('button', { name: 'Continue to checkout with Fixture shop', exact: true })
    .click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Email address', exact: true })
    .fill('private@example.test');
  await page.evaluate(() => {
    const key = 'mercaria.guest.token';
    const oldValue = localStorage.getItem(key);
    localStorage.removeItem(key);
    window.dispatchEvent(
      new StorageEvent('storage', { key, oldValue, newValue: null, storageArea: localStorage }),
    );
  });
  await expect(page.getByTestId('bloom-checkout-step')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pay now', exact: true })).toHaveCount(0);
  // The existing shared commerce-query boundary remounts routes on authority change.
  await page.getByRole('button', { name: 'Cart', exact: true }).first().click();
  await page
    .getByRole('button', { name: 'Continue to checkout with Fixture shop', exact: true })
    .click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Email address', exact: true })).toHaveValue('');
});

test('a late placement response cannot reopen a payment after guest authority is cleared', async ({
  page,
}) => {
  await fixture(page, false);
  await page.addInitScript(() =>
    localStorage.setItem('mercaria.guest.token', 'old-fixture-authority'),
  );
  let release = () => {};
  let received = false;
  let replied = false;
  await page.route(
    (url) => url.origin === 'http://localhost:4160' && url.pathname === '/checkout',
    async (route) => {
      received = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({
        json: {
          success: true,
          data: {
            checkoutGroupId: 'old-authority-order',
            orders: [{ id: 'old-order', orderNumber: 'OLD-1' }],
          },
        },
      });
      replied = true;
    },
  );
  await page.goto('/cart');
  await page
    .getByRole('button', { name: 'Continue to checkout with Fixture shop', exact: true })
    .click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('textbox', { name: 'Email address', exact: true }).fill('old@example.test');
  await page.getByRole('textbox', { name: 'Full name', exact: true }).fill('Old Recipient');
  await page
    .getByRole('textbox', { name: 'Street address', exact: true })
    .fill('10 Example Street');
  await page.getByRole('textbox', { name: 'City', exact: true }).fill('Wilmington');
  await page.getByRole('textbox', { name: 'Postal code', exact: true }).fill('19802');
  await page.getByRole('button', { name: 'Country', exact: true }).click();
  await page.getByText('United States', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(() => received).toBe(true);
  await page.evaluate(() => {
    const key = 'mercaria.guest.token';
    const oldValue = localStorage.getItem(key);
    localStorage.removeItem(key);
    window.dispatchEvent(
      new StorageEvent('storage', { key, oldValue, newValue: null, storageArea: localStorage }),
    );
  });
  await expect(page.getByTestId('bloom-checkout-step')).toHaveCount(0);
  release();
  await expect.poll(() => replied).toBe(true);
  await page.getByRole('button', { name: 'Cart', exact: true }).first().click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByRole('button', { name: 'Pay now', exact: true })).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Continue to checkout with Fixture shop', exact: true })
    .click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Email address', exact: true })).toHaveValue('');
});
