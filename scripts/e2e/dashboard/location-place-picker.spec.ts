import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

// SDK transport fixtures only: no real places, claims or publications are written.
for (const [width, locale] of [
  [1440, 'en'],
  [390, 'ar'],
] as const) {
  test(`GoWay business address selection and creation at ${width}px ${locale}`, async ({
    page,
  }) => {
    const copy = locale === 'ar' ? ar : en;
    const labels = copy.settings.locations.editor;
    await fixture(page, locale, 'light');
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
    let mercariaWrites = 0;
    await page.route('**/admin/stores/*/locations**', async (route) => {
      if (route.request().method() !== 'GET') mercariaWrites++;
      const url = new URL(route.request().url());
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
            },
          ],
        },
      });
    });
    const result = (street: string, latitude: number) => ({
      id: street,
      displayName: `${street} 43, Barcelona`,
      kind: 'address',
      source: 'photon',
      coordinate: { latitude, longitude: 2.16 },
      address: {
        street,
        houseNumber: '43',
        city: 'Barcelona',
        postalCode: '08007',
        countryCode: 'ES',
      },
    });
    let failSearch = true;
    let failLookup = true;
    let releaseLookup: (() => void) | undefined;
    let releaseCreate: (() => void) | undefined;
    const creates: Record<string, unknown>[] = [];
    const lookups: URL[] = [];
    const createdPlace = {
      id: 'gw_created_business',
      name: 'Public Atelier',
      location: { latitude: 41.4, longitude: 2.16 },
      categories: [],
      address: result('Reviewed Street', 41.4).address,
      status: 'active',
      verification: { state: 'unverified' },
      sources: [],
      capabilities: [],
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    };
    await page.route('https://api.goway.to/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/search'))
        return route.fulfill(
          failSearch
            ? {
                status: 503,
                json: { error: { code: 'service_unavailable', message: 'Unavailable' } },
              }
            : {
                json: {
                  items: [result('Original Street', 41.3)],
                  providers: ['photon'],
                  nextCursor: null,
                },
              },
        );
      if (url.pathname.endsWith('/geocode/structured')) {
        lookups.push(url);
        if (failLookup)
          return route.fulfill({
            status: 503,
            json: { error: { code: 'service_unavailable', message: 'Unavailable' } },
          });
        if (url.searchParams.get('street') === 'Stale Street')
          await new Promise<void>((resolve) => {
            releaseLookup = resolve;
          });
        return route.fulfill({
          json: {
            items: [result(url.searchParams.get('street')!, 41.4)],
            providers: ['photon'],
            nextCursor: null,
          },
        });
      }
      if (url.pathname.endsWith('/places') && route.request().method() === 'POST') {
        creates.push(route.request().postDataJSON());
        expect(route.request().headers().authorization).toMatch(/^Bearer /);
        if (creates.length === 1) {
          await new Promise<void>((resolve) => {
            releaseCreate = resolve;
          });
          return route.fulfill({
            status: 403,
            json: { error: { code: 'forbidden', message: 'Not permitted' } },
          });
        }
        return route.fulfill({ status: 201, json: createdPlace });
      }
      if (url.pathname.endsWith('/places/gw_created_business'))
        return route.fulfill({ json: createdPlace });
      if (url.pathname.endsWith('/claims') || url.pathname.endsWith('/hours-exceptions'))
        return route.fulfill({ json: { items: [], nextCursor: null } });
      return route.fulfill({
        status: 404,
        json: { error: { code: 'not_found', message: 'Fixture not found' } },
      });
    });
    await page.goto('/settings/locations/local-one');
    const identity = page.getByRole('radiogroup', {
      name: labels.publication.identity,
      exact: true,
    });
    await identity.getByRole('radio').first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(identity.getByRole('radio').nth(1)).toBeChecked();
    const search = page.getByRole('textbox', { name: labels.picker.searchLabel, exact: true });
    await search.fill('Public Atelier');
    await expect(page.getByText(labels.errors.gowayUnavailable, { exact: true })).toBeVisible();
    failSearch = false;
    await page.getByRole('button', { name: copy.common.retry, exact: true }).click();
    const found = page.getByRole('button', { name: 'Original Street 43, Barcelona', exact: true });
    await found.focus();
    await page.keyboard.press('Enter');
    const submit = page.getByRole('button', { name: labels.create.submit, exact: true });
    const street = page.getByRole('textbox', { name: labels.create.street, exact: true });
    await expect(street).toHaveValue('Original Street');
    await expect(submit).toBeEnabled();
    await street.fill('Stale Street');
    await expect(submit).toBeDisabled();
    const lookup = page.getByRole('button', { name: labels.create.findAddress, exact: true });
    await lookup.click();
    await expect(page.getByText(labels.errors.gowayUnavailable, { exact: true })).toBeVisible();
    await expect(street).toHaveValue('Stale Street');
    failLookup = false;
    await lookup.click();
    await expect.poll(() => Boolean(releaseLookup)).toBe(true);
    await street.fill('Reviewed Street');
    releaseLookup!();
    await expect(
      page.getByRole('button', { name: 'Stale Street 43, Barcelona', exact: true }),
    ).toHaveCount(0);
    await lookup.click();
    const reviewed = page.getByRole('button', {
      name: 'Reviewed Street 43, Barcelona',
      exact: true,
    });
    await reviewed.focus();
    await page.keyboard.press('Enter');
    expect(lookups.at(-1)!.searchParams.get('countryCode')).toBe('ES');
    expect(lookups.at(-1)!.searchParams.get('city')).toBe('Barcelona');
    await expect(page.getByText(labels.create.positionSelected, { exact: true })).toBeVisible();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect.poll(() => creates.length).toBe(1);
    await expect(street).toBeDisabled();
    await expect(search).toBeDisabled();
    await expect(
      page.getByRole('button', { name: copy.common.cancel, exact: true }),
    ).toBeDisabled();
    expect(creates[0]).toMatchObject({
      name: 'Public Atelier',
      location: { latitude: 41.4, longitude: 2.16 },
      address: { street: 'Reviewed Street', countryCode: 'ES' },
    });
    releaseCreate!();
    await expect(page.getByText(labels.errors.gowayForbidden, { exact: true })).toBeVisible();
    await expect(street).toHaveValue('Reviewed Street');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `/tmp/wholesale-place-draft-${width}-${locale}.png`,
      fullPage: true,
    });
    await submit.click();
    await expect.poll(() => creates.length).toBe(2);
    expect(creates[1]).toEqual(creates[0]);
    await expect(page.getByText(labels.place.chosenNotSaved, { exact: true })).toBeVisible();
    expect(mercariaWrites).toBe(0); // Selection/create never publish or assert a business claim.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `/tmp/wholesale-place-picker-${width}-${locale}.png`,
      fullPage: true,
    });
  });
}
