import type { Page } from '@playwright/test';

const SESSION_ID = 'cs_0123456789abcdef01234567';
const session = {
  id: SESSION_ID,
  object: 'checkout_session',
  livemode: false,
  mode: 'payment',
  status: 'open',
  payment_status: 'unpaid',
  ui_mode: 'embedded',
  locale: null,
  submit_type: 'auto',
  currency: 'USD',
  rail: 'card',
  network: null,
  line_items: [
    {
      id: 'li_fixture',
      object: 'item',
      description: 'Fixture sweater + delivery',
      price: null,
      product: null,
      images: [],
      quantity: 1,
      adjustable_quantity: { enabled: false },
      currency: 'USD',
      unit_amount: '3500',
      amount_subtotal: '3500',
      amount_discount: '0',
      amount_tax: '0',
      amount_total: '3500',
    },
  ],
  amount_subtotal: '3500',
  amount_total: '3500',
  total_details: { amount_discount: '0', amount_tax: '0', amount_shipping: '0' },
  discount: null,
  allow_promotion_codes: false,
  automatic_tax: { enabled: false, status: null },
  customer_details: {
    email: null,
    name: null,
    phone: null,
    address: null,
    tax_ids: [],
  },
  customer_email_locked: false,
  billing_address_collection: 'auto',
  shipping_address_collection: null,
  shipping_details: null,
  phone_number_collection: { enabled: false },
  tax_id_collection: { enabled: false },
  custom_fields: [],
  consent_collection: null,
  consent: null,
  terms_of_service_url: null,
  payment_intent: null,
  setup_intent: null,
  success_url: null,
  cancel_url: null,
  confirmation_message: null,
  merchant: { name: 'Mercaria', avatar_url: null, logo_url: null, description: null },
  branding: {
    icon_url: null,
    logo_url: null,
    primary_color: '#1f6feb',
    accent_color: '#0b1f33',
    font: 'system',
    border_style: 'rounded',
  },
  publishable_key: null,
  payment_method_types: ['card', 'faircoin'],
  faircoin: { available: false, unavailable_reason: 'faircoin_wallet_missing' },
  expires_at: 2000000000,
};
export const address = {
  id: 'oxy-address',
  recipientName: 'Alex Example',
  line1: '10 Example Street',
  city: 'Wilmington',
  region: 'DE',
  postalCode: '19802',
  country: 'US',
  isDefault: true,
};
export const group = {
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
      imageUrl: 'https://assets.oxy.so/fixture-sweater.png',
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
export async function fixture(
  page: Page,
  signedIn: boolean,
  success = false,
  options: {
    profileOnly?: boolean;
    saved?: unknown[];
    payerUpdates?: unknown[];
    noEmail?: boolean;
    cartResponses?: number[];
    refuseSeller?: boolean | number;
  } = {},
) {
  let placed = false;
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
  await page.route('https://assets.oxy.so/fixture-sweater.png', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#9ecf9b"/></svg>',
    }),
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
          ...(options.noEmail ? {} : { email: 'alex@example.test' }),
          name: { displayName: 'Alex Example' },
          ...(options.profileOnly
            ? {
                locations: [
                  {
                    id: 'home',
                    name: 'Home',
                    address: {
                      streetNumber: '10',
                      street: 'Example Street',
                      city: 'Wilmington',
                      state: 'DE',
                      postalCode: '19802',
                      country: 'United States',
                    },
                    metadata: { countryCode: 'US' },
                  },
                ],
              }
            : {}),
        },
      });
    if (path === '/addresses') {
      if (route.request().method() === 'POST') {
        options.saved?.push(route.request().postDataJSON());
        return route.fulfill({ json: address });
      }
      return route.fulfill({ json: options.profileOnly ? [] : [address] });
    }
    return route.fulfill({ status: 404, json: { error: 'Unused fixture' } });
  });
  await page.route('http://localhost:4160/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/cart') {
      options.cartResponses?.push(placed ? 0 : 1);
      return route.fulfill({
        json: {
          success: true,
          data: {
            id: 'cart',
            currency: 'USD',
            items: group.items,
            groups: placed
              ? []
              : options.refuseSeller
                ? [
                    group,
                    {
                      ...group,
                      sellerKey: 'store:other',
                      vendor: { ...group.vendor, id: 'other' },
                      commercial: { ...group.commercial, sellerLabel: 'Other shop' },
                    },
                  ]
                : [group],
            subtotal: group.subtotal,
          },
        },
      });
    }
    if (path === '/addresses') return route.fulfill({ json: { success: true, data: [] } });
    if (path === '/checkout') {
      requests.push({
        key: route.request().headers()['idempotency-key'],
        body: route.request().postDataJSON(),
      });
      if (
        options.refuseSeller &&
        requests.length <= (typeof options.refuseSeller === 'number' ? options.refuseSeller : 1)
      )
        return route.fulfill({
          status: 409,
          json: {
            success: false,
            message: 'Seller unavailable',
            details: {
              reason: 'seller_not_activated',
              sellers: [{ sellerKey: group.sellerKey, name: 'Fixture shop' }],
            },
          },
        });
      if (success) {
        placed = true;
        return route.fulfill({
          json: {
            success: true,
            data: {
              checkoutGroupId: 'group',
              orders: [{ id: 'order', orderNumber: 'FIX-1' }],
              payment: {
                paymentId: 'payment',
                provider: 'peable',
                checkoutSessionId: SESSION_ID,
                clientSecret: `${SESSION_ID}_secret_0123456789abcdef`,
                amount: { amount: 3500, currency: 'USD' },
                availableMethods: ['card'],
              },
            },
          },
        });
      }
      return route.fulfill({
        status: 503,
        json: { success: false, message: 'Please retry this same payment.' },
      });
    }
    return route.fulfill({ status: 404, json: { success: false, error: 'Unused fixture' } });
  });
  // No request in this test may reach a payment provider or a live gateway.
  let payerEmail: string | null = null;
  await page.route('https://api.peable.to/**', async (route) => {
    if (
      success &&
      new URL(route.request().url()).pathname === `/v1/checkout_sessions/${SESSION_ID}/public`
    ) {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        options.payerUpdates?.push(body);
        payerEmail = body.customer_details?.email ?? payerEmail;
      }
      return route.fulfill({
        json: {
          ...session,
          contact_collection: signedIn ? 'merchant_account' : 'email',
          customer_details: { ...session.customer_details, email: payerEmail },
        },
      });
    }
    // Creating/confirming a payment is forbidden in this synthetic suite.
    return route.abort();
  });
  return requests;
}
