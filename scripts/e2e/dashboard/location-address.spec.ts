import { expect, test } from '@playwright/test';
import type { Place, StructuredAddress } from '@goway.to/sdk';
import { fixture } from './fixture';

// Exact address returned by the public GoWay SDK for Casa Batlló on 2026-10-10.
// Merchant session/location are isolated fixtures; no places or commerce data are written.
const observedAddress: StructuredAddress = {
  houseNumber: '43',
  street: 'Passeig de Gràcia',
  city: 'Barcelona',
};
for (const [width, locale, mode] of [
  [1440, 'en', 'light'],
  [390, 'ar', 'dark'],
] as const) {
  test(`GoWay structured address remains visible without formatted at ${width}px ${locale}`, async ({
    page,
    context,
  }) => {
    await fixture(page, locale, mode);
    await page.clock.install();
    await page.setViewportSize({ width, height: 1100 });
    await page.route('**/admin/stores', (route) =>
      route.fulfill({
        json: {
          success: true,
          data: [
            {
              id: 'store-preview',
              oxyAccountId: 'store-owner',
              name: 'Demo Atelier',
              handle: 'demo-atelier',
              defaultCurrency: 'EUR',
              access: { permissions: ['locations:write'] },
            },
          ],
        },
      }),
    );
    const place: Place = {
      id: '01a0c1f9-256c-7775-8c92-c6deac537ad1',
      name: 'Casa Batlló',
      address: observedAddress,
      location: { latitude: 41.3917, longitude: 2.1649 },
      categories: [],
      status: 'active',
      verification: { state: 'unverified' },
      sources: [],
      capabilities: [],
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    };
    let writes = 0;
    await page.route('https://api.goway.to/**', (route) => {
      if (route.request().method() !== 'GET') {
        writes++;
        return route.abort();
      }
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(`/places/${place.id}`)) return route.fulfill({ json: place });
      if (url.pathname.endsWith('/claims') || url.pathname.endsWith('/hours-exceptions'))
        return route.fulfill({ json: { items: [], nextCursor: null } });
      return route.fulfill({
        status: 404,
        json: { error: { code: 'not_found', message: 'Fixture not found' } },
      });
    });
    await page.route('**/admin/stores/*/locations**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/place-link/verify'))
        return route.fulfill({
          json: {
            success: true,
            data: {
              link: {
                locationId: 'local-one',
                goWayPlaceId: place.id,
                verdict: 'unlinked',
                missing: ['store_link_missing'],
              },
            },
          },
        });
      if (route.request().method() !== 'GET') {
        writes++;
        return route.abort();
      }
      if (url.pathname.endsWith('/publication'))
        return route.fulfill({ status: 404, json: { success: false, message: 'No publication' } });
      return route.fulfill({
        json: {
          success: true,
          data: [
            {
              id: 'local-one',
              storeId: 'store-preview',
              name: 'Public Atelier',
              type: 'retail',
              isDefault: true,
              isActive: true,
              goWayPlaceId: place.id,
            },
          ],
        },
      });
    });
    await page.goto('/settings/locations/local-one');
    const address = page.getByText('Passeig de Gràcia 43, Barcelona', { exact: true });
    await expect(address).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `/tmp/wholesale-location-address-${width}-${locale}.png`,
      fullPage: true,
    });
    const reconnect = async () => {
      await page.clock.fastForward(301_000);
      await context.setOffline(true);
      await context.setOffline(false);
    };
    place.address = { formatted: 'GoWay formatted address', street: 'Ignored structured street' };
    await reconnect();
    await expect(page.getByText('GoWay formatted address', { exact: true })).toBeVisible();
    await expect(address).toHaveCount(0);
    place.address = {};
    await reconnect();
    await expect(page.getByText('GoWay formatted address', { exact: true })).toHaveCount(0);
    await expect(page.getByText(place.name, { exact: true })).toBeVisible();
    expect(writes).toBe(0);
  });
}
