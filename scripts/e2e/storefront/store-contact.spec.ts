import { expect, test } from '@playwright/test';
import en from '../../../packages/frontend/lib/i18n/locales/en.json';
import ar from '../../../packages/frontend/lib/i18n/locales/ar.json';

// Vary only public location/GoWay metadata to exercise outage and ownership
// changes. Product data and image delivery use the real running local catalog.
for (const [width, locale] of [[1440, 'en'], [390, 'ar']] as const) {
  test(`public shop contact, clipboard and fresh backlink at ${width}px ${locale}`, async ({ page, context, request }) => {
    const copy = locale === 'ar' ? ar : en;
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(locale => localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale }, version: 0 })), locale);
    const feed = await (await request.get('http://localhost:4160/feed')).json();
    const product = feed.data.sections.flatMap((section: { products?: { id: string; title: string }[] }) => section.products ?? []).find((item: { title: string }) => item.title === 'Brilliant Eye Brightener');
    expect(product, 'Requires the documented local storefront seed').toBeTruthy();
    const listing = (await (await request.get(`http://localhost:4160/listings/${product.id}`)).json()).data;
    const store = listing.store;
    expect(store?.id).toBeTruthy();
    const place = {
      id: 'contact-place', name: store.name, location: { latitude: 41, longitude: 2 }, categories: [], sources: [],
      status: 'active', verification: { state: 'owner_verified' },
      capabilities: [{ namespace: 'commerce', capability: 'mercaria.store', key: 'commerce.mercaria.store', value: 'contact-location', verification: 'business_asserted', observedAt: '2026-10-10T00:00:00Z' }],
      createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z',
      contact: { phone: '+34 931 000 000', email: 'support+shop@example.com', website: 'https://example.com/contact' },
      address: { formatted: 'Carrer de Mallorca 401, 08013 Barcelona, Spain', country: 'ES' },
    };
    const location = {
      ref: { kind: 'location', id: 'contact-location' }, goWayPlaceId: place.id,
      store: { ref: { kind: 'store', id: store.id }, handle: store.handle ?? 'contact-store', name: store.name, logoUrl: null },
      pickup: null, discoverable: false, url: `https://mercaria.co/stores/${store.id}`,
    };
    let fail = false; let published = true; let reads = 0;
    const writes: string[] = []; const leakedHeaders: string[] = []; const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (/\/public\/v1\/stores\/.*\/locations|api.goway.to/.test(request.url())) {
        if (request.method() !== 'GET' && request.method() !== 'OPTIONS') writes.push(request.url());
        if (request.headers().authorization || request.headers().cookie) leakedHeaders.push(request.url());
      }
    });
    await page.route(`**/public/v1/stores/${store.id}/locations?*`, route => route.fulfill({ json: { items: published ? [location] : [], nextCursor: null } }));
    await page.route('https://api.goway.to/api/v1/places/contact-place?*', route => {
      reads++;
      return fail ? route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Fixture unavailable' } } }) : route.fulfill({ json: place });
    });
    await page.goto(`/products/${product.id}`);
    const trigger = page.getByRole('button', { name: copy.product.moreActions, exact: true });
    const title = copy.store.contact.title.replace('%{store}', store.name);
    const dialog = page.getByTestId('store-contact-dialog');
    async function open() {
      await trigger.focus(); await page.keyboard.press('Enter');
      await page.getByRole('menuitem', { name: title, exact: true }).click();
      await expect(dialog).toBeVisible();
    }
    await open();
    await expect(dialog.getByRole('link', { name: place.contact.phone, exact: true })).toHaveAttribute('href', 'tel:%2B34%20931%20000%20000');
    await expect(dialog.getByRole('link', { name: place.contact.email, exact: true })).toHaveAttribute('href', 'mailto:support%2Bshop%40example.com');
    await expect(dialog.getByRole('link', { name: copy.store.contact.website, exact: true })).toHaveAttribute('href', place.contact.website);
    await expect(dialog.getByText(place.address.formatted, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: copy.store.contact.copy.replace('%{value}', place.address.formatted), exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(place.address.formatted);
    await expect(dialog.getByText(copy.store.contact.copied, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/mercaria-store-contact-${width}-${locale}.png` });
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();

    fail = true; await open();
    await expect(dialog.getByText(copy.store.contact.unavailable, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('link')).toHaveCount(0);
    fail = false;
    await dialog.getByRole('button', { name: copy.common.tryAgain, exact: true }).click();
    await expect(dialog.getByRole('link', { name: place.contact.phone, exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);

    // A previously valid location is not enough once GoWay revokes its backlink.
    place.capabilities[0].value = 'another-location';
    await open(); await expect(dialog.getByText(copy.store.contact.empty, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('link')).toHaveCount(0);
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    published = false; await page.reload();
    await trigger.click(); await expect(page.getByRole('menuitem', { name: title, exact: true })).toHaveCount(0);
    expect(reads).toBeGreaterThanOrEqual(4); expect(reads).toBeLessThan(12);
    expect(writes).toEqual([]); expect(leakedHeaders).toEqual([]); expect(errors).toEqual([]);
  });
}
