import { test, expect, type Page } from '@playwright/test';

const address = {
  id: 'oxy-address',
  recipientName: 'Alex Example',
  line1: '10 Example Street',
  city: 'Wilmington',
  region: 'DE',
  postalCode: '19802',
  country: 'US',
  isDefault: true,
};
const group = {
  vendor: { kind: 'store', id: 'shop', name: 'Fixture shop' },
  sellerKey: 'store:shop',
  commercial: {
    mode: 'connected_marketplace',
    sellerKind: 'store',
    sellerLabel: 'Fixture shop',
    sellerRole: 'direct',
    disclosures: [],
  },
  items: [
    {
      listingId: 'listing',
      variantId: 'variant',
      title: 'Fixture sweater',
      variantTitle: 'Medium',
      quantity: 1,
      available: 5,
      delivery: 'shipped',
      unitPrice: { amount: 3000, currency: 'USD' },
      lineTotal: { amount: 3000, currency: 'USD' },
    },
  ],
  subtotal: { amount: 3000, currency: 'USD' },
};
async function fixture(page: Page, signedIn: boolean) {
  const requests: { key: string | undefined; body: unknown }[] = [];
  await page.addInitScript(
    ({ signedIn }) => {
      localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
      if (signedIn)
        localStorage.setItem(
          'oxy.auth.v1',
          JSON.stringify({
            userId: 'checkout-fixture',
            sessionId: 'fixture-session',
            accessToken: [
              'e30',
              btoa(
                JSON.stringify({
                  sub: 'checkout-fixture',
                  userId: 'checkout-fixture',
                  exp: Math.floor(Date.now() / 1000) + 3600,
                }),
              ),
              'fixture',
            ].join('.'),
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          }),
        );
    },
    { signedIn },
  );
  await page.route('https://api.oxy.so/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/auth/oauth/client/'))
      return route.fulfill({
        json: {
          application: {
            id: 'fixture',
            name: 'Mercaria',
            type: 'first_party',
            isOfficial: true,
            isInternal: false,
            scopes: [],
          },
        },
      });
    if (path === '/users/me')
      return route.fulfill({
        json: {
          id: 'checkout-fixture',
          username: 'alex',
          email: 'alex@example.test',
          name: { displayName: 'Alex Example' },
        },
      });
    if (path === '/addresses') return route.fulfill({ json: [address] });
    return route.fulfill({ status: 404, json: { error: 'Unused fixture' } });
  });
  await page.route('http://localhost:4160/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/cart')
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
    if (path === '/addresses') return route.fulfill({ json: { success: true, data: [] } });
    if (path === '/checkout') {
      requests.push({
        key: route.request().headers()['idempotency-key'],
        body: route.request().postDataJSON(),
      });
      return route.fulfill({
        status: 503,
        json: { success: false, message: 'Please retry this same payment.' },
      });
    }
    return route.fulfill({ status: 404, json: { success: false, error: 'Unused fixture' } });
  });
  // No request in this test may reach a payment provider or a live gateway.
  await page.route('https://api.peable.to/**', (route) => route.abort());
  return requests;
}
for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`account destination inside the canonical sheet; frozen retry (${viewport.width})`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const requests = await fixture(page, true);
    await page.goto('/checkout');
    await page.getByRole('button', { name: 'Pay now', exact: true }).click();
    await expect(page.getByTestId('bloom-checkout-step')).toBeVisible();
    expect(requests).toHaveLength(0);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText('10 Example Street', { exact: false })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Email', exact: true })).toHaveCount(0);
    expect(requests).toHaveLength(0);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText('Please retry this same payment.')).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toMatchObject({
      destination: {
        type: 'inline_shipping_address',
        address: { recipientName: address.recipientName, line1: address.line1 },
      },
      contact: { email: 'alex@example.test' },
    });
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]).toEqual(requests[0]);
    await page.screenshot({ path: `/tmp/mercaria-peable-${viewport.width}.png` });
  });
}
