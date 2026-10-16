import { expect, test } from '@playwright/test';
import en from '../../../packages/dashboard/lib/i18n/locales/en.json';
import ar from '../../../packages/dashboard/lib/i18n/locales/ar.json';
import { fixture } from './fixture';

// Isolated official SDK/API transports. No real places, claims or publications are written.
for (const [width, locale, mode] of [
  [1440, 'en', 'light'],
  [390, 'ar', 'dark'],
] as const) {
  test(`location drafts survive refetch and in-flight edits at ${width}px ${locale}`, async ({
    page,
    context,
  }) => {
    const copy = locale === 'ar' ? ar : en;
    const labels = copy.settings.locations.editor;
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
    const place = {
      id: 'gw_business',
      name: 'Public Atelier',
      location: { latitude: 41.4, longitude: 2.16 },
      categories: [],
      status: 'active',
      verification: { state: 'unverified' },
      sources: [],
      capabilities: [],
      contact: { phone: '+34930000001', email: 'old@example.test' },
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-01T00:00:00Z',
    };
    const contactWrites: { contact: Record<string, string | null> }[] = [];
    let releaseContact: (() => void) | undefined;
    let contactError = true;
    let holdContact = true;
    await page.route('https://api.goway.to/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/places/gw_business')) {
        if (route.request().method() === 'PATCH') {
          const body = route.request().postDataJSON();
          contactWrites.push(body);
          expect(route.request().headers().authorization).toMatch(/^Bearer /);
          if (holdContact)
            await new Promise<void>((resolve) => {
              releaseContact = resolve;
            });
          if (contactError)
            return route.fulfill({
              status: 503,
              json: { error: { code: 'service_unavailable', message: 'Fixture failure' } },
            });
          for (const [key, value] of Object.entries(body.contact)) {
            const contact = place.contact as Record<string, unknown>;
            if (value === null) delete contact[key];
            else contact[key] = value;
          }
        }
        return route.fulfill({ json: place });
      }
      if (url.pathname.endsWith('/claims') || url.pathname.endsWith('/hours-exceptions'))
        return route.fulfill({ json: { items: [], nextCursor: null } });
      return route.fulfill({
        status: 404,
        json: { error: { code: 'not_found', message: 'Fixture not found' } },
      });
    });
    let publication: Record<string, unknown> | null = null;
    const publicationWrites: Record<string, unknown>[] = [];
    let releasePublication: (() => void) | undefined;
    let publicationReadError = false;
    let publicationWriteError = false;
    let holdPublication = true;
    await page.route('**/admin/stores/*/locations**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/publication')) {
        if (route.request().method() === 'PUT') {
          const body = route.request().postDataJSON();
          publicationWrites.push(body);
          if (holdPublication)
            await new Promise<void>((resolve) => {
              releasePublication = resolve;
            });
          if (publicationWriteError)
            return route.fulfill({
              status: 503,
              json: { success: false, message: 'Fixture save failure' },
            });
          publication = {
            ...body,
            id: 'first-publication',
            locationId: 'local-one',
            publicationState: 'draft',
            paymentRequirement: 'prepaid',
            restricted: false,
            updatedAt: '2026-10-01T00:00:00Z',
          };
          return route.fulfill({ json: { success: true, data: { publication } } });
        }
        if (publicationReadError)
          return route.fulfill({
            status: 503,
            json: { success: false, message: 'Fixture read failure' },
          });
        return route.fulfill(
          publication
            ? { json: { success: true, data: { publication } } }
            : { status: 404, json: { success: false, message: 'No publication' } },
        );
      }
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
    const phone = page.getByRole('textbox', { name: labels.contact.phone, exact: true });
    const email = page.getByRole('textbox', { name: labels.contact.email, exact: true });
    const contactSave = page.getByRole('button', { name: labels.contact.save, exact: true });
    await expect(phone).toHaveValue('+34930000001');
    await expect(contactSave).toBeDisabled();
    await email.fill('first@example.test');
    place.contact.phone = '+34930000002';
    const reconnect = async () => {
      await page.clock.fastForward(301_000);
      await context.setOffline(true);
      await context.setOffline(false);
    };
    await reconnect();
    await expect(phone).toHaveValue('+34930000002');
    await expect(email).toHaveValue('first@example.test');
    await contactSave.click();
    await expect.poll(() => contactWrites.length).toBe(1);
    expect(contactWrites[0]).toEqual({ contact: { email: 'first@example.test' } });
    await email.fill('retry@example.test');
    releaseContact!();
    await expect(contactSave).toBeEnabled();
    await expect(email).toHaveValue('retry@example.test');
    contactError = false;
    releaseContact = undefined;
    await contactSave.click();
    await expect.poll(() => Boolean(releaseContact)).toBe(true);
    await email.fill('later@example.test');
    releaseContact!();
    await expect(contactSave).toBeEnabled();
    await expect(email).toHaveValue('later@example.test');
    await expect(phone).toHaveValue('+34930000002');
    holdContact = false;
    await phone.fill('');
    await contactSave.click();
    await expect.poll(() => contactWrites.length).toBe(3);
    expect(contactWrites[2]).toEqual({ contact: { email: 'later@example.test', phone: null } });
    await expect(contactSave).toBeDisabled();
    place.contact.email = 'remote@example.test';
    await reconnect();
    await expect(email).toHaveValue('remote@example.test');

    const interval = page.getByRole('textbox', { name: labels.publication.interval, exact: true });
    const instructions = page.getByRole('textbox', {
      name: labels.publication.instructions,
      exact: true,
    });
    const threshold = page.getByRole('textbox', { name: labels.publication.lowStock, exact: true });
    const publicationSave = page.getByRole('button', {
      name: labels.publication.save,
      exact: true,
    });
    await interval.fill('15');
    await instructions.fill('First instructions');
    const originalInput = await instructions.elementHandle();
    await publicationSave.click();
    await expect.poll(() => publicationWrites.length).toBe(1);
    await expect(publicationSave).toBeDisabled();
    await instructions.fill('Edits during first save');
    await threshold.fill('7');
    releasePublication!();
    await expect(publicationSave).toBeEnabled();
    await expect(
      page.getByRole('button', { name: labels.publication.publish, exact: true }),
    ).toBeVisible();
    await expect(instructions).toHaveValue('Edits during first save');
    await expect(threshold).toHaveValue('7');
    expect(await originalInput!.evaluate((node) => node.isConnected)).toBe(true);
    expect(publicationWrites[0]).toMatchObject({
      pickupInstructions: 'First instructions',
      lowStockThreshold: 3,
      stockConfirmationIntervalSeconds: 900,
    });
    publicationReadError = true;
    await reconnect();
    await expect(page.getByText(labels.loadFailed, { exact: true })).toBeVisible();
    await expect(instructions).toHaveValue('Edits during first save');
    expect(await originalInput!.evaluate((node) => node.isConnected)).toBe(true);
    publicationReadError = false;
    (publication as unknown as Record<string, unknown>).stockConfirmationIntervalSeconds = 1800;
    await page.getByRole('button', { name: copy.common.retry, exact: true }).click();
    await expect(interval).toHaveValue('30');
    await expect(instructions).toHaveValue('Edits during first save');
    holdPublication = false;
    publicationWriteError = true;
    await publicationSave.click();
    await expect.poll(() => publicationWrites.length).toBe(2);
    await expect(publicationSave).toBeEnabled();
    await expect(threshold).toHaveValue('7');
    publicationWriteError = false;
    await publicationSave.click();
    await expect.poll(() => publicationWrites.length).toBe(3);
    expect(publicationWrites[2]).toEqual(publicationWrites[1]);
    expect(publicationWrites[2]).toMatchObject({
      pickupInstructions: 'Edits during first save',
      lowStockThreshold: 7,
      stockConfirmationIntervalSeconds: 1800,
    });
    await expect(publicationSave).toBeEnabled();
    (publication as unknown as Record<string, unknown>).pickupInstructions = 'Remote after save';
    await reconnect();
    await expect(instructions).toHaveValue('Remote after save');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `/tmp/wholesale-location-drafts-${width}-${locale}.png`,
      fullPage: true,
    });
  });
}
