import { expect, test } from '@playwright/test';
import type { Place, PlaceClaim } from '@goway.to/sdk';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

// Isolated official SDK transport: no claims, places or commerce records are written.
for (const [width, locale, mode] of [[1440, 'en', 'light'], [390, 'ar', 'dark']] as const) {
  test(`claim lookup never presents loading or failure as no claim ${width} ${locale}`, async ({ page, context }) => {
    await fixture(page, locale, mode); await page.clock.install();
    await page.setViewportSize({ width, height: 1100 });
    const copy = locale === 'ar' ? ar : en;
    const labels = copy.settings.locations.editor.claim;
    const place: Place = { id: '01a0c1f9-256c-7775-8c92-c6deac537ad1', name: 'Claimed Atelier', address: { countryCode: 'ES' },
      location: { latitude: 41.3917, longitude: 2.1649 }, categories: [], status: 'active', verification: { state: 'unverified' }, sources: [], capabilities: [],
      createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
    let claims: PlaceClaim[] = [{ id: 'approved-claim', placeId: place.id, role: 'owner', state: 'approved', oxyAccountId: 'store-owner', claimedAt: '2026-10-01T00:00:00Z' }];
    await page.route('**/admin/stores', route => route.fulfill({ json: { success: true, data: [{ id: 'store-preview', oxyAccountId: 'store-owner', name: 'Demo Atelier', handle: 'demo-atelier', defaultCurrency: 'EUR', access: { permissions: ['locations:write'] } }] } }));
    let failRead = true; let holdRead = true; let release!: () => void; let writes = 0;
    await page.route('https://api.goway.to/**', async route => {
      if (route.request().method() !== 'GET') { writes++; return route.abort(); }
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(`/places/${place.id}`)) return route.fulfill({ json: place });
      if (url.pathname.endsWith('/claims')) {
        expect(url.searchParams.get('oxyAccountId')).toBe('store-owner');
        expect(url.searchParams.get('placeId')).toBe(place.id);
        if (holdRead) await new Promise<void>(resolve => { release = resolve; });
        return failRead ? route.fulfill({ status: 503, json: { error: { code: 'service_unavailable', message: 'Isolated outage' } } })
          : route.fulfill({ json: { items: claims, nextCursor: null } });
      }
      if (url.pathname.endsWith('/hours-exceptions')) return route.fulfill({ json: { items: [], nextCursor: null } });
      return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Fixture not found' } } });
    });
    await page.route('**/admin/stores/*/locations**', route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/place-link/verify')) return route.fulfill({ json: { success: true, data: { link: { locationId: 'local-one', goWayPlaceId: place.id, verdict: 'unlinked', missing: ['store_link_missing'] } } } });
      if (url.pathname.endsWith('/publication')) return route.fulfill({ status: 404, json: { success: false, message: 'No publication' } });
      return route.fulfill({ json: { success: true, data: [{ id: 'local-one', storeId: 'store-preview', name: 'Public Atelier', type: 'retail', isDefault: true, isActive: true, goWayPlaceId: place.id }] } });
    });
    await page.goto('/settings/locations/local-one');
    const section = page.getByText(labels.title, { exact: true }).locator('../..');
    const create = section.getByRole('button', { name: labels.file, exact: true });
    await expect(section).toBeVisible(); await expect.poll(() => Boolean(release)).toBe(true);
    await expect(create).toHaveCount(0); await expect(section.getByRole('radiogroup')).toHaveCount(0);
    holdRead = false; release();
    await expect(section.getByText(labels.unreadable, { exact: true })).toBeVisible();
    await expect(create).toHaveCount(0);
    failRead = false; await section.getByRole('button', { name: copy.common.retry, exact: true }).click();
    await expect(section.getByText(labels.state.approved, { exact: true })).toBeVisible(); await expect(create).toHaveCount(0);
    failRead = true;
    await page.clock.fastForward(301_000); await context.setOffline(true); await context.setOffline(false);
    await expect(section.getByText(labels.unreadable, { exact: true })).toBeVisible();
    await expect(section.getByText(labels.state.approved, { exact: true })).toBeVisible(); await expect(create).toHaveCount(0);
    claims = []; failRead = false;
    await section.getByRole('button', { name: copy.common.retry, exact: true }).click();
    await expect(create).toBeEnabled(); await expect(section.getByRole('radiogroup')).toBeVisible();
    await expect(section.getByText(labels.state.approved, { exact: true })).toHaveCount(0);
    expect(writes).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/mercaria-merchant-claims-${width}-${locale}.png`, fullPage: true });
  });
}
