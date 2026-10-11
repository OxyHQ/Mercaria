import { expect, test } from '@playwright/test';
import type { Place, PlaceCapability } from '@goway.to/sdk';
import en from '../lib/i18n/locales/en.json';
import ar from '../lib/i18n/locales/ar.json';
import { fixture } from '../../../scripts/e2e/dashboard/fixture';

// Only isolated SDK/API transport fixtures; no real capability or merchant writes.
const capability = (
  key: string,
  value: boolean | string,
  verification: PlaceCapability['verification'] = 'business_asserted',
): PlaceCapability => ({
  namespace: 'accessibility',
  capability: key.split('.')[1],
  key,
  value,
  verification,
  observedAt: '2026-10-01T00:00:00Z',
});
for (const [width, locale, mode] of [
  [1440, 'en', 'light'],
  [390, 'ar', 'dark'],
] as const) {
  test(`accessibility preserves remote facts and edits during save at ${width}px ${locale}`, async ({
    page,
    context,
  }) => {
    const copy = locale === 'ar' ? ar : en;
    const labels = copy.settings.locations.editor.accessibility;
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
    const step = 'accessibility.step_free_entrance';
    const hearing = 'accessibility.hearing_loop';
    const parking = 'accessibility.parking_accessible';
    const place: Place = {
      id: 'gw_business',
      name: 'Public Atelier',
      location: { latitude: 41.4, longitude: 2.16 },
      categories: [],
      status: 'active',
      verification: { state: 'unverified' },
      sources: [],
      capabilities: [capability(step, false), capability(hearing, false)],
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    };
    const writes: { method: string; key: string; body: unknown }[] = [];
    let failWrite = true;
    let failRead = false;
    let hold = true;
    let release: (() => void) | undefined;
    await page.route('https://api.goway.to/**', async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      if (url.pathname.includes('/capabilities/')) {
        const key = decodeURIComponent(url.pathname.split('/').at(-1)!);
        writes.push({
          method,
          key,
          body: method === 'PUT' ? route.request().postDataJSON() : null,
        });
        if (hold)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        if (failWrite)
          return route.fulfill({
            status: 503,
            json: {
              error: {
                code: 'service_unavailable',
                message: copy.settings.locations.editor.errors.gowayUnavailable,
              },
            },
          });
        place.capabilities = place.capabilities.filter((item) => item.key !== key);
        if (method === 'PUT')
          place.capabilities.push(capability(key, route.request().postDataJSON().value));
        else place.capabilities.push(capability(key, false, 'community_reported'));
        return method === 'DELETE'
          ? route.fulfill({ status: 204 })
          : route.fulfill({ json: place });
      }
      if (url.pathname.endsWith('/places/gw_business'))
        return failRead
          ? route.fulfill({
              status: 503,
              json: {
                error: {
                  code: 'service_unavailable',
                  message: copy.settings.locations.editor.errors.gowayUnavailable,
                },
              },
            })
          : route.fulfill({ json: place });
      if (url.pathname.endsWith('/claims') || url.pathname.endsWith('/hours-exceptions'))
        return route.fulfill({ json: { items: [], nextCursor: null } });
      return route.fulfill({
        status: 404,
        json: { error: { code: 'not_found', message: copy.common.somethingWentWrong } },
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
      if (url.pathname.endsWith('/publication'))
        return route.fulfill({
          status: 404,
          json: { success: false, message: copy.common.somethingWentWrong },
        });
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
    const save = page.getByRole('button', { name: labels.save, exact: true });
    // Form order: wheelchair, entrance, toilets, parking, hearing loop.
    const groups = page
      .getByRole('radiogroup')
      .filter({ has: page.getByRole('radio', { name: labels.unset, exact: true }) });
    const entrance = groups.nth(1);
    const parkingGroup = groups.nth(3);
    const hearingGroup = groups.nth(4);
    await expect(groups).toHaveCount(5);
    await expect(save).toBeDisabled();
    await hearingGroup.getByRole('radio', { name: labels.yes, exact: true }).click();
    place.capabilities[0] = capability(step, true);
    const reconnect = async () => {
      await page.clock.fastForward(301_000);
      await context.setOffline(true);
      await context.setOffline(false);
    };
    await reconnect();
    await expect(entrance.getByRole('radio', { name: labels.yes, exact: true })).toBeChecked();
    await expect(hearingGroup.getByRole('radio', { name: labels.yes, exact: true })).toBeChecked();
    await save.click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toEqual({ method: 'PUT', key: hearing, body: { value: true } });
    await expect(save).toBeDisabled();
    await hearingGroup.getByRole('radio', { name: labels.no, exact: true }).click();
    release!();
    await expect(save).toBeEnabled();
    await expect(hearingGroup.getByRole('radio', { name: labels.no, exact: true })).toBeChecked();
    failWrite = false;
    release = undefined;
    await hearingGroup.getByRole('radio', { name: labels.yes, exact: true }).click();
    await save.click();
    await expect.poll(() => Boolean(release)).toBe(true);
    await hearingGroup.getByRole('radio', { name: labels.unset, exact: true }).click();
    release!();
    await expect(save).toBeEnabled();
    await expect(
      hearingGroup.getByRole('radio', { name: labels.unset, exact: true }),
    ).toBeChecked();
    hold = false;
    await save.click();
    await expect(save).toBeDisabled();
    expect(writes.at(-1)).toEqual({ method: 'DELETE', key: hearing, body: null });
    await expect(hearingGroup.getByRole('radio', { name: labels.no, exact: true })).toBeChecked();
    expect(writes.every((write) => write.key === hearing)).toBe(true);
    // Confirmed PUT followed by failed read retains the draft. Once reread, Save
    // acknowledges the equal value locally instead of sending another assertion.
    await parkingGroup.getByRole('radio', { name: labels.yes, exact: true }).click();
    failRead = true;
    await save.click();
    await expect.poll(() => writes.length).toBe(4);
    await expect(save).toBeEnabled();
    await expect(parkingGroup.getByRole('radio', { name: labels.yes, exact: true })).toBeChecked();
    failRead = false;
    await reconnect();
    // The place summary is restored only after the authoritative read succeeds.
    await expect(page.getByText(place.name, { exact: true })).toHaveCount(2);
    await save.click();
    await expect(save).toBeDisabled();
    expect(writes).toHaveLength(4);
    place.capabilities = place.capabilities.map((item) =>
      item.key === parking ? capability(parking, false) : item,
    );
    await reconnect();
    await expect(parkingGroup.getByRole('radio', { name: labels.no, exact: true })).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await save.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/wholesale-accessibility-${width}-${locale}.png` });
  });
}
