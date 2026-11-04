import { expect, test, type Page } from '@playwright/test';
import en from '../../../packages/frontend/lib/i18n/locales/en.json';

// A followed referral link leaves a carrier the browser cannot read; the
// storefront asks what it holds, shows the disclosure, and binds the click once
// there is a subject. The Mercaria API is fixtured: these tests pin the CLIENT's
// half, and the server's half has its own realdb suites.
const TERMS = 'Fixture programme terms, rendered verbatim.';

async function mockApi(page: Page, binds: string[], cart?: object) {
  await page.route('http://localhost:4160/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/referrals/state') {
      return route.fulfill({
        json: { success: true, data: { state: 'pending', disclosureRequired: true } },
      });
    }
    if (path === '/cart' && cart) {
      return route.fulfill({ json: { success: true, data: cart } });
    }
    if (path === '/referrals/bind') {
      binds.push(request.headers().authorization ?? 'anonymous');
      return route.fulfill({
        json: {
          success: true,
          data: { state: 'attributed', disclosureRequired: true, publicTermsSummary: TERMS },
        },
      });
    }
    return route.fulfill({
      status: 404,
      json: { success: false, error: 'Unused fixture endpoint' },
    });
  });
}

async function oxyFixture(page: Page, userId?: string) {
  await page.route('https://api.oxy.so/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/auth/oauth/client/')) {
      return route.fulfill({
        json: {
          application: {
            id: 'fixture',
            name: 'Mercaria fixture',
            type: 'first_party',
            isOfficial: true,
            isInternal: false,
            scopes: [],
          },
        },
      });
    }
    if (userId && path === '/users/me') {
      return route.fulfill({
        json: {
          id: userId,
          username: 'referral-fixture',
          name: { displayName: 'Referral fixture' },
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'Unused fixture endpoint' } });
  });
}

test('signed out with an empty cart: the disclosure shows and nothing is bound yet', async ({
  page,
}) => {
  const binds: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
  });
  await oxyFixture(page);
  await mockApi(page, binds);

  await page.goto('/');
  const notice = page.getByRole('note');
  await expect(notice.getByText(en.referral.disclosure.title, { exact: true })).toBeVisible();
  await expect(notice.getByText(en.referral.disclosure.body, { exact: true })).toBeVisible();
  expect(binds).toEqual([]);

  await notice.getByRole('button', { name: en.referral.disclosure.dismiss, exact: true }).click();
  await expect(notice).toBeHidden();
});

test('signed out with a cart: the guest session is the subject, so the click is bound', async ({
  page,
}) => {
  const binds: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
  });
  await oxyFixture(page);
  // A non-empty cart for an anonymous caller exists only because a cart write
  // created the guest session — the one sign of it this client can see.
  await mockApi(page, binds, {
    id: 'cart-fixture',
    items: [{ id: 'line-fixture', quantity: 1 }],
    groups: [],
    currency: 'EUR',
    subtotal: { amount: 1000, currency: 'EUR' },
  });

  await page.goto('/');
  await expect(page.getByRole('note').getByText(TERMS, { exact: true })).toBeVisible();
  expect(binds).toEqual(['anonymous']);
});

test('signed in: the click is bound to the account once and the terms are shown verbatim', async ({
  page,
}) => {
  const binds: string[] = [];
  const userId = 'oxy-referral-browser-fixture';
  const token = [
    'e30',
    Buffer.from(
      JSON.stringify({ sub: userId, userId, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url'),
    'test-only',
  ].join('.');
  await page.addInitScript(
    ({ userId, token }) => {
      localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
      localStorage.setItem(
        'oxy.auth.v1',
        JSON.stringify({
          userId,
          sessionId: 'fixture-session',
          accessToken: token,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }),
      );
    },
    { userId, token },
  );
  await oxyFixture(page, userId);
  await mockApi(page, binds);

  await page.goto('/');
  const notice = page.getByRole('note');
  await expect(notice.getByText(TERMS, { exact: true })).toBeVisible();
  expect(binds).toEqual([`Bearer ${token}`]);
});
