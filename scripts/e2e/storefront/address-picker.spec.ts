import { expect, test, type Page } from '@playwright/test';
import type { SearchResult } from '@goway.to/sdk';
import type { Cart } from '../../../packages/shared-types/src';
import en from '../../../packages/frontend/lib/i18n/locales/en.json';
import ar from '../../../packages/frontend/lib/i18n/locales/ar.json';

const candidate: SearchResult = {
  id: 'address-test', source: 'goway', kind: 'address',
  displayName: 'Carrer de Mallorca 401, Barcelona, Catalunya, España',
  coordinate: { latitude: 41.4036, longitude: 2.1744 },
  address: { street: 'Carrer de Mallorca', houseNumber: '401', city: 'Barcelona', region: 'Catalunya', postalCode: '08013', countryCode: 'ES' },
};
async function checkout(page: Page, locale: 'en' | 'ar' = 'en') {
  // An isolated cart read fixture opens the actual checkout form. Never place an order.
  const cart: Cart = {
    id: 'address-ui-test', currency: 'EUR', items: [], subtotal: { amount: 1000, currency: 'EUR' },
    groups: [{ vendor: { kind: 'store', id: 'address-ui-store', name: 'Address UI store' },
      sellerKey: 'store:address-ui-store', items: [], subtotal: { amount: 1000, currency: 'EUR' },
      commercial: { mode: 'connected_marketplace', sellerKind: 'store', sellerLabel: 'Address UI store', sellerRole: 'direct', disclosures: ['sold_by_merchant'] },
    }],
  };
  await page.route(url => url.pathname === '/cart', route => route.fulfill({ json: { success: true, data: cart } }));
  await page.addInitScript(locale => localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale }, version: 0 })), locale);
  await page.goto('/checkout');
  await expect(page.getByTestId('address-picker')).toBeVisible();
}
for (const [width, locale] of [[1440, 'en'], [390, 'ar']] as const) {
  test(`GoWay selection fills checkout without storing search history at ${width}px ${locale}`, async ({ page }) => {
    const copy = locale === 'ar' ? ar : en;
    await page.setViewportSize({ width, height: 1000 });
    const queries: string[] = [];
    await page.route('https://api.goway.to/api/v1/geocode?*', route => {
      const url = new URL(route.request().url());
      queries.push(url.searchParams.get('q') ?? '');
      return route.fulfill({ json: { items: [candidate], nextCursor: null, providers: ['goway'] } });
    });
    await checkout(page, locale);
    const picker = page.getByTestId('address-picker');
    await page.getByRole('textbox', { name: copy.checkout.form.recipientLabel, exact: true }).fill('Private recipient');
    const search = picker.getByRole('search', { name: copy.address.picker.search, exact: true });
    await search.fill('Mallorca Barcelona');
    const result = picker.getByRole('button', { name: candidate.displayName, exact: true });
    await expect(result).toBeVisible();
    await result.focus();
    await result.press('Enter');
    await expect(picker.getByTestId('selected-postal-address')).toContainText('08013 Barcelona');
    await expect(page.getByRole('textbox', { name: copy.checkout.form.recipientLabel, exact: true })).toHaveValue('Private recipient');
    const review = picker.getByRole('button', { name: copy.address.picker.review, exact: true });
    await expect(review).toBeFocused();
    await expect(review).toHaveAttribute('aria-expanded', 'false');
    await review.click();
    await expect.poll(() => picker.getByTestId('address-postal-details').evaluate(element => Math.abs(element.getBoundingClientRect().height - element.scrollHeight) < 2)).toBe(true);
    await expect(page.getByRole('textbox', { name: copy.checkout.form.line1Label, exact: true })).toHaveValue('Carrer de Mallorca 401');
    await expect(page.getByRole('textbox', { name: copy.checkout.form.countryLabel, exact: true })).toHaveValue('ES');
    expect(queries).toEqual(['Mallorca Barcelona']);
    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    expect(storage).not.toMatch(/Mallorca|Private recipient|08013/);
    expect(page.url()).not.toContain('Mallorca');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/mercaria-address-${width}-${locale}.png`, fullPage: true });
  });
}

test('address search ignores superseded results, offers retry, and exposes incomplete fields', async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  await page.route('https://api.goway.to/api/v1/geocode?*', async route => {
    const query = new URL(route.request().url()).searchParams.get('q');
    if (query === 'Old address') { await delayed; return route.fulfill({ json: { items: [candidate], nextCursor: null, providers: ['goway'] } }); }
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: { code: 'provider_unavailable', message: 'Unavailable' } } });
    return route.fulfill({ json: { items: [{ ...candidate, id: 'incomplete', displayName: 'New incomplete address', address: { street: 'New street', countryCode: 'ES' } }], nextCursor: null, providers: ['goway'], degradedProviders: ['photon'] } });
  });
  await checkout(page);
  const picker = page.getByTestId('address-picker');
  const search = picker.getByRole('search', { name: en.address.picker.search });
  const started = page.waitForRequest(r => r.url().includes('geocode?'));
  await search.fill('Old address');
  await started;
  await search.fill('New address');
  release();
  await expect(picker.getByText(en.address.picker.error)).toBeVisible();
  await expect(picker.getByRole('button', { name: candidate.displayName })).toHaveCount(0);
  await picker.getByRole('button', { name: en.common.tryAgain, exact: true }).click();
  await expect(picker.getByText(en.address.picker.partial)).toBeVisible();
  await picker.getByRole('button', { name: 'New incomplete address', exact: true }).click();
  await expect(page.getByRole('textbox', { name: en.checkout.form.line1Label, exact: true })).toHaveValue('New street');
  await expect(page.getByRole('textbox', { name: en.checkout.form.postalLabel, exact: true })).toHaveValue('');
});

test('public GoWay SDK geocoding works from the actual browser origin', async ({ page }) => {
  await checkout(page);
  const picker = page.getByTestId('address-picker');
  const response = page.waitForResponse(r => r.url().startsWith('https://api.goway.to/api/v1/geocode?'));
  await picker.getByRole('search', { name: en.address.picker.search }).fill('Carrer de Mallorca 401 Barcelona');
  const actual = await response;
  expect(actual.ok()).toBe(true);
  const payload = await actual.json();
  expect(payload.items.length).toBeGreaterThan(0);
  const first = picker.getByRole('button', { name: payload.items[0].displayName, exact: true });
  await expect(first).toBeVisible();
  await first.click();
  await expect(picker.getByTestId('selected-postal-address')).toBeVisible();
});

test('saved-address form submits reviewed GoWay fields through the existing address API', async ({ page }) => {
  // Isolated auth/address transport fixtures; this verifies form composition, not a real account write.
  const userId = 'address-browser-fixture';
  const token = ['e30', Buffer.from(JSON.stringify({ sub: userId, userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'test-only'].join('.');
  await page.addInitScript(({ userId, token }) => {
    localStorage.setItem('oxy.auth.v1', JSON.stringify({ userId, sessionId: 'fixture-session', accessToken: token, expiresAt: new Date(Date.now() + 3600000).toISOString() }));
    localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
  }, { userId, token });
  await page.route('https://api.oxy.so/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/auth/oauth/client/')) return route.fulfill({ json: { application: { id: 'fixture', name: 'Mercaria fixture', type: 'first_party', isOfficial: true, isInternal: false, scopes: [] } } });
    if (path === '/users/me') return route.fulfill({ json: { id: userId, username: 'address-fixture', name: { displayName: 'Address fixture' }, email: 'address@example.invalid' } });
    return route.fulfill({ status: 404, json: { error: 'Unused browser-fixture endpoint' } });
  });
  const writes: unknown[] = [];
  await page.route('http://localhost:4160/**', route => {
    const req = route.request();
    if (new URL(req.url()).pathname === '/addresses') {
      if (req.method() === 'GET') return route.fulfill({ json: { success: true, data: [] } });
      writes.push(req.postDataJSON());
      return route.fulfill({ json: { success: true, data: { ...req.postDataJSON(), id: 'saved-fixture', isDefault: true } } });
    }
    if (req.method() !== 'GET') return route.fulfill({ status: 403, json: { success: false } });
    const headers = req.headers(); delete headers.authorization;
    return route.continue({ headers });
  });
  await page.route('https://api.goway.to/api/v1/geocode?*', route => route.fulfill({ json: { items: [candidate], nextCursor: null, providers: ['goway'] } }));
  await page.goto('/settings/addresses');
  await page.getByRole('button', { name: en.address.list.addAddress, exact: true }).click();
  await page.getByRole('textbox', { name: en.address.form.recipientNameLabel, exact: true }).fill('Address recipient');
  const picker = page.getByTestId('address-picker');
  await picker.getByRole('search', { name: en.address.picker.search }).fill('Mallorca Barcelona');
  await picker.getByRole('button', { name: candidate.displayName, exact: true }).click();
  await page.getByRole('textbox', { name: en.address.form.line2Label, exact: true }).fill('Apartment 4');
  await page.getByRole('button', { name: en.address.form.submit, exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ recipientName: 'Address recipient', line1: 'Carrer de Mallorca 401', line2: 'Apartment 4', city: 'Barcelona', region: 'Catalunya', postalCode: '08013', country: 'ES' });
});
