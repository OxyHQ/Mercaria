import { expect, test } from '@playwright/test';
import type { Place, PlaceHoursException } from '@goway.to/sdk';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

// Isolated SDK transport/session fixtures only: no GoWay places or hours are written.
for (const [width, locale, mode] of [
  [1440, 'en', 'light'],
  [390, 'ar', 'dark'],
] as const) {
  test(`dated hours preserve failed drafts, serialize writes and retry reads ${width} ${locale}`, async ({
    page,
    context,
  }) => {
    await fixture(page, locale, mode);
    await page.clock.install();
    await page.setViewportSize({ width, height: 1100 });
    const copy = locale === 'ar' ? ar : en;
    const labels = copy.settings.locations.editor.exceptions;
    const first = '01a0c1f9-256c-7775-8c92-c6deac537ad1';
    const second = '01a0c1f9-256c-7775-8c92-c6deac537ad2';
    let placeId = first;
    const place = (id: string): Place => ({
      id,
      name: id === first ? 'First Atelier' : 'Second Atelier',
      location: { latitude: 41.3917, longitude: 2.1649 },
      address: { countryCode: 'ES' },
      categories: [],
      status: 'active',
      verification: { state: 'unverified' },
      sources: [],
      capabilities: [],
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    });
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
    await page.route('**/admin/stores/*/locations**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/place-link/verify'))
        return route.fulfill({
          json: {
            success: true,
            data: {
              link: {
                locationId: 'local-one',
                goWayPlaceId: placeId,
                verdict: 'unlinked',
                missing: ['store_link_missing'],
              },
            },
          },
        });
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
              goWayPlaceId: placeId,
            },
          ],
        },
      });
    });
    let failRead = true;
    let failPost = true;
    let failDelete = true;
    let releasePost!: () => void;
    let releaseDelete!: () => void;
    const posts: unknown[] = [];
    const deletes: string[] = [];
    let rows: PlaceHoursException[] = [];
    await page.route('https://api.goway.to/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.includes('/hours-exceptions')) {
        if (request.method() === 'POST') {
          posts.push(request.postDataJSON());
          await new Promise<void>((resolve) => {
            releasePost = resolve;
          });
          if (failPost)
            return route.fulfill({
              status: 503,
              json: { error: { code: 'upstream_unavailable', message: 'Isolated outage' } },
            });
          const row: PlaceHoursException = {
            ...request.postDataJSON(),
            id: 'exception-one',
            placeId: first,
            intervals: [],
            source: 'business',
            verification: 'business_asserted',
            observedAt: '2026-10-10T00:00:00Z',
          };
          rows = [row];
          return route.fulfill({ status: 201, json: row });
        }
        if (request.method() === 'DELETE') {
          deletes.push(url.pathname);
          await new Promise<void>((resolve) => {
            releaseDelete = resolve;
          });
          if (failDelete)
            return route.fulfill({
              status: 503,
              json: { error: { code: 'upstream_unavailable', message: 'Isolated outage' } },
            });
          rows = [];
          return route.fulfill({ status: 204 });
        }
        return failRead
          ? route.fulfill({
              status: 503,
              json: { error: { code: 'upstream_unavailable', message: 'Isolated outage' } },
            })
          : route.fulfill({ json: { items: rows, nextCursor: null } });
      }
      if (url.pathname.endsWith('/claims'))
        return route.fulfill({ json: { items: [], nextCursor: null } });
      return route.fulfill({ json: place(url.pathname.split('/').at(-1)!) });
    });
    await page.goto('/settings/locations/local-one');
    const section = page.getByText(labels.title, { exact: true }).locator('../..');
    await expect(section.getByText(labels.none, { exact: true })).toHaveCount(0);
    await expect(
      section.getByRole('button', { name: copy.common.retry, exact: true }),
    ).toBeVisible();
    failRead = false;
    await section.getByRole('button', { name: copy.common.retry, exact: true }).click();
    await expect(section.getByText(labels.none, { exact: true })).toBeVisible();
    const starts = section.getByRole('textbox', { name: labels.startsOn, exact: true });
    const note = section.getByRole('textbox', { name: labels.note, exact: true });
    const add = section.getByRole('button', { name: labels.add, exact: true });
    await starts.fill('2026-12-20');
    await note.fill('Shop holiday');
    await add.click();
    await expect.poll(() => posts.length).toBe(1);
    await expect(starts).toBeDisabled();
    await expect(note).toBeDisabled();
    await expect(section.getByRole('switch')).toBeDisabled();
    releasePost();
    await expect(add).toBeEnabled();
    await expect(starts).toHaveValue('2026-12-20');
    await expect(note).toHaveValue('Shop holiday');
    failPost = false;
    await add.click();
    await expect.poll(() => posts.length).toBe(2);
    releasePost();
    await expect(starts).toHaveValue('');
    await expect(note).toHaveValue('');
    expect(posts).toEqual(
      Array(2).fill({
        startsOn: '2026-12-20',
        endsOn: '2026-12-20',
        closed: true,
        note: 'Shop holiday',
      }),
    );
    const remove = section.getByRole('button', { name: labels.remove, exact: true });
    await remove.click();
    await expect.poll(() => deletes.length).toBe(1);
    await expect(remove).toBeDisabled();
    await expect(add).toBeDisabled();
    releaseDelete();
    await expect(remove).toBeEnabled();
    failDelete = false;
    await remove.click();
    await expect.poll(() => deletes.length).toBe(2);
    releaseDelete();
    await expect(remove).toHaveCount(0);
    await expect(add).toBeEnabled();
    await starts.fill('2026-12-24');
    await note.fill('Only the first place');
    placeId = second;
    await page.clock.fastForward(301_000);
    await context.setOffline(true);
    await context.setOffline(false);
    await expect(page.getByText('Second Atelier', { exact: true })).toBeVisible();
    await expect(starts).toHaveValue('');
    await expect(note).toHaveValue('');
    // First place is cached: changing identity must still replace the editor,
    // rather than relying on an intermediate loading/unmount to clear its draft.
    await starts.fill('2026-12-31');
    await note.fill('Only the second place');
    placeId = first;
    await page.clock.fastForward(301_000);
    await context.setOffline(true);
    await context.setOffline(false);
    await expect(page.getByText('First Atelier', { exact: true })).toBeVisible();
    await expect(starts).toHaveValue('');
    await expect(note).toHaveValue('');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `/tmp/mercaria-merchant-exceptions-${width}-${locale}.png`,
      fullPage: true,
    });
  });
}
