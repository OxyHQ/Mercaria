import { expect, test, type Page } from '@playwright/test';
import en from '../../../packages/frontend/lib/i18n/locales/en.json';

// A followed referral link stores NOTHING on the device until the buyer allows
// it (ePrivacy Art. 5(3)): the API redirect puts the click's signed carrier in
// the URL fragment, the storefront takes it into memory, strips it from the
// address bar and asks. Only "Allow" sends it — on a request header — and only
// then does anything bind. The Mercaria API is fixtured: these tests pin the
// CLIENT's half, and the server's half has its own realdb suites.
const TERMS = 'Fixture programme terms, rendered verbatim.';
const CARRIER = 'mrf_eyJ2IjoyLCJrIjoidSJ9.Zml4dHVyZS1zaWduYXR1cmU';

interface Calls {
  binds: string[];
  consents: { consent: string; carrier: string | null; authorization: string }[];
  stateReads: number;
}

function newCalls(): Calls {
  return { binds: [], consents: [], stateReads: 0 };
}

async function mockApi(
  page: Page,
  calls: Calls,
  options: {
    state?: 'pending' | 'none';
    cart?: object;
    consentAnswer?: object;
  } = {},
) {
  await page.route('http://localhost:4160/**', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/referrals/state') {
      calls.stateReads += 1;
      return route.fulfill({
        json: {
          success: true,
          data:
            options.state === 'pending'
              ? { state: 'pending', disclosureRequired: true }
              : { state: 'none', disclosureRequired: false },
        },
      });
    }
    if (path === '/cart' && options.cart) {
      return route.fulfill({ json: { success: true, data: options.cart } });
    }
    if (path === '/referrals/consent') {
      const headers = request.headers();
      const body = request.postDataJSON() as { consent: string };
      calls.consents.push({
        consent: body.consent,
        carrier: headers['x-mercaria-referral-state'] ?? null,
        authorization: headers.authorization ?? 'anonymous',
      });
      return route.fulfill({
        json: {
          success: true,
          data:
            body.consent === 'denied'
              ? { state: 'none', disclosureRequired: false }
              : (options.consentAnswer ?? {
                  state: 'pending',
                  reason: 'no_subject',
                  disclosureRequired: true,
                }),
        },
      });
    }
    if (path === '/referrals/bind') {
      calls.binds.push(request.headers().authorization ?? 'anonymous');
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

async function englishLocale(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
  });
}

/** A signed-in session the Oxy client restores from storage. */
async function signedIn(page: Page): Promise<string> {
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
  return token;
}

/** Nothing the page can reach on the device holds the carrier. */
async function expectCarrierNotStored(page: Page) {
  const stored = await page.evaluate(() => {
    const values: string[] = [document.cookie];
    for (const storage of [localStorage, sessionStorage]) {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key) values.push(key, storage.getItem(key) ?? '');
      }
    }
    return values.join('\n');
  });
  expect(stored).not.toContain('mrf_');
  const cookies = await page.context().cookies();
  expect(cookies.map((cookie) => cookie.value).join('\n')).not.toContain('mrf_');
}

test('a followed link: the carrier is read from the fragment, stripped, and the buyer is asked', async ({
  page,
}) => {
  const calls = newCalls();
  await englishLocale(page);
  await oxyFixture(page);
  await mockApi(page, calls);

  await page.goto(`/?from=partner#mercaria_ref=${CARRIER}`);
  const notice = page.getByRole('note');
  await expect(notice.getByText(en.referral.disclosure.title, { exact: true })).toBeVisible();
  await expect(notice.getByText(en.referral.disclosure.body, { exact: true })).toBeVisible();
  await expect(notice.getByText(en.referral.consent.body, { exact: true })).toBeVisible();
  await expect(notice.getByRole('button', { name: en.referral.consent.allow })).toBeVisible();
  await expect(notice.getByRole('button', { name: en.referral.consent.decline })).toBeVisible();

  // Out of the address bar — including the router's own copy, which it writes
  // back on mount — with the query kept; and in memory only.
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  expect(new URL(page.url()).search).toBe('?from=partner');
  await expectCarrierNotStored(page);

  // Undecided: nothing has been sent anywhere — no consent, no bind, and no
  // state read either (the fresh carrier is not the server's to know yet).
  await page.waitForTimeout(1_000);
  expect(calls).toEqual(newCalls());
  expect(page.url()).not.toContain('mrf_');
});

test('undecided while SIGNED IN: nothing is bound, whoever the buyer is', async ({ page }) => {
  const calls = newCalls();
  await englishLocale(page);
  await signedIn(page);
  await mockApi(page, calls, { state: 'pending' });

  await page.goto(`/#mercaria_ref=${CARRIER}`);
  await expect(
    page.getByRole('note').getByRole('button', { name: en.referral.consent.allow }),
  ).toBeVisible();
  await page.waitForTimeout(1_500);
  expect(calls.binds).toEqual([]);
  expect(calls.consents).toEqual([]);
  expect(calls.stateReads).toBe(0);
});

test('Allow while signed out: the carrier goes on the header, then the plain disclosure', async ({
  page,
}) => {
  const calls = newCalls();
  await englishLocale(page);
  await oxyFixture(page);
  await mockApi(page, calls);

  await page.goto(`/#mercaria_ref=${CARRIER}`);
  const notice = page.getByRole('note');
  await notice.getByRole('button', { name: en.referral.consent.allow }).click();

  await expect(notice.getByRole('button', { name: en.referral.disclosure.dismiss })).toBeVisible();
  await expect(notice.getByText(en.referral.consent.body, { exact: true })).toBeHidden();
  expect(calls.consents).toEqual([
    { consent: 'granted', carrier: CARRIER, authorization: 'anonymous' },
  ]);
  // `pending`: no subject yet (empty cart, signed out), so nothing to bind.
  expect(calls.binds).toEqual([]);
});

test('Allow while signed in: attributed at once, terms shown verbatim, no separate bind', async ({
  page,
}) => {
  const calls = newCalls();
  await englishLocale(page);
  const token = await signedIn(page);
  await mockApi(page, calls, {
    consentAnswer: { state: 'attributed', disclosureRequired: true, publicTermsSummary: TERMS },
  });

  await page.goto(`/#mercaria_ref=${CARRIER}`);
  const notice = page.getByRole('note');
  await notice.getByRole('button', { name: en.referral.consent.allow }).click();

  await expect(notice.getByText(TERMS, { exact: true })).toBeVisible();
  expect(calls.consents).toEqual([
    { consent: 'granted', carrier: CARRIER, authorization: `Bearer ${token}` },
  ]);
  expect(calls.binds).toEqual([]);
});

test('No thanks: a `denied` call with no carrier, the prompt goes, and nothing binds', async ({
  page,
}) => {
  const calls = newCalls();
  await englishLocale(page);
  await signedIn(page);
  await mockApi(page, calls);

  await page.goto(`/#mercaria_ref=${CARRIER}`);
  const notice = page.getByRole('note');
  await notice.getByRole('button', { name: en.referral.consent.decline }).click();

  await expect(page.getByRole('note')).toBeHidden();
  await expect.poll(() => calls.consents.length).toBe(1);
  expect(calls.consents).toEqual([
    { consent: 'denied', carrier: null, authorization: expect.any(String) },
  ]);
  await page.waitForTimeout(1_000);
  expect(calls.binds).toEqual([]);
  await expectCarrierNotStored(page);
});

test('an EARLIER consented click, signed out with a cart: the guest session is bound', async ({
  page,
}) => {
  const calls = newCalls();
  await englishLocale(page);
  await oxyFixture(page);
  // A non-empty cart for an anonymous caller exists only because a cart write
  // created the guest session — the one sign of it this client can see.
  await mockApi(page, calls, {
    state: 'pending',
    cart: {
      id: 'cart-fixture',
      items: [{ id: 'line-fixture', quantity: 1 }],
      groups: [],
      currency: 'EUR',
      subtotal: { amount: 1000, currency: 'EUR' },
    },
  });

  await page.goto('/');
  await expect(page.getByRole('note').getByText(TERMS, { exact: true })).toBeVisible();
  expect(calls.binds).toEqual(['anonymous']);
  expect(calls.consents).toEqual([]);
});

test('an EARLIER consented click, signed out with no cart: the plain disclosure, nothing bound', async ({
  page,
}) => {
  const calls = newCalls();
  await englishLocale(page);
  await oxyFixture(page);
  await mockApi(page, calls, { state: 'pending' });

  await page.goto('/');
  const notice = page.getByRole('note');
  await expect(notice.getByText(en.referral.disclosure.body, { exact: true })).toBeVisible();
  await expect(notice.getByText(en.referral.consent.body, { exact: true })).toBeHidden();
  expect(calls.binds).toEqual([]);

  await notice.getByRole('button', { name: en.referral.disclosure.dismiss, exact: true }).click();
  await expect(notice).toBeHidden();
});

test('an EARLIER consented click, signed in: bound to the account once, terms verbatim', async ({
  page,
}) => {
  const calls = newCalls();
  await englishLocale(page);
  const token = await signedIn(page);
  await mockApi(page, calls, { state: 'pending' });

  await page.goto('/');
  await expect(page.getByRole('note').getByText(TERMS, { exact: true })).toBeVisible();
  expect(calls.binds).toEqual([`Bearer ${token}`]);
});
