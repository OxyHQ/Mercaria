import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Listing } from '../../../packages/shared-types/src';

async function listingFixture(request: APIRequestContext): Promise<Listing> {
  const feed = await (await request.get('http://localhost:4160/listings?limit=100')).json();
  const listing = feed.data.find((entry: Listing) => entry.title === 'Brilliant Eye Brightener');
  expect(listing).toBeTruthy();
  return (await (await request.get(`http://localhost:4160/listings/${listing.id}`)).json()).data;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
    localStorage.setItem(
      'mercaria.bloom.theme',
      JSON.stringify({ mode: 'light', colorPreset: 'mono' }),
    );
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

for (const width of [390, 1440]) {
  test(`product store links support keyboard and new tabs at ${width}px`, async ({
    page,
    request,
    context,
  }) => {
    const listing = await listingFixture(request);
    expect(listing.store).toBeTruthy();
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/products/${listing.id}`);
    const links = page.getByRole('link', { name: `Visit ${listing.store!.name}`, exact: true });
    await expect(links).toHaveCount(width === 390 ? 3 : 2);
    const path = `/stores/${listing.store!.handle}`;
    for (const link of await links.all()) await expect(link).toHaveAttribute('href', path);
    const popupPromise = context.waitForEvent('page');
    await links.first().click({ modifiers: ['ControlOrMeta'] });
    const popup = await popupPromise;
    await expect(popup).toHaveURL(new RegExp(`${path}$`));
    await expect(page).toHaveURL(new RegExp(`/products/${listing.id}$`));
    await popup.close();
    await links.first().focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await page.goBack();
    await links.last().focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${path}$`));
  });

  test(`product person links keep Oxy identity and refuse external avatars at ${width}px`, async ({
    page,
    request,
    context,
  }) => {
    const listing = await listingFixture(request);
    const seller = {
      id: 'keyboard-profile',
      oxyUserId: 'keyboard-seller',
      username: 'renamed-person',
      displayName: 'Keyboard seller',
      avatar: 'unavailable-person-avatar',
      isVerified: false,
    };
    const person: Listing = {
      ...listing,
      ownerType: 'user',
      oxyUserId: seller.oxyUserId,
      storeId: undefined,
      store: undefined,
      seller,
      variants: listing.variants.map((variant) => ({
        ...variant,
        commercial: {
          mode: 'connected_marketplace',
          sellerKind: 'user',
          sellerLabel: seller.displayName,
          sellerRole: 'direct',
          disclosures: [],
        },
      })),
    };
    await context.route(`http://localhost:4160/listings/${listing.id}`, (route) =>
      route.fulfill({ json: { success: true, data: person } }),
    );
    await context.route(`http://localhost:4160/sellers/${seller.oxyUserId}`, (route) =>
      route.fulfill({
        json: {
          success: true,
          data: {
            visibility: 'visible',
            indexable: false,
            identity: {
              oxyUserId: seller.oxyUserId,
              handle: seller.username,
              displayName: seller.displayName,
              avatar: seller.avatar,
              followTargetUri: `https://oxy.so/users/${seller.oxyUserId}`,
            },
            marketplace: { activeListingCount: 0, salesCount: 0, isVerified: false },
          },
        },
      }),
    );
    await context.route(`http://localhost:4160/sellers/${seller.oxyUserId}/listings*`, (route) =>
      route.fulfill({
        json: {
          success: true,
          data: { listings: [], visibility: 'visible' },
        },
      }),
    );
    // Deliberately missing media only: no successful image or upload substitute.
    await context.route('https://cloud.oxy.so/unavailable-person-avatar*', (route) =>
      route.fulfill({ status: 404, body: '' }),
    );
    const mediaRequests: string[] = [];
    context.on('request', (request) => {
      if (
        request.url().includes('unavailable-person-avatar') ||
        request.url().includes('supplier-avatar.example')
      )
        mediaRequests.push(request.url());
    });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/products/${listing.id}`);
    const header = page.getByRole('link', { name: `Visit ${seller.displayName}`, exact: true });
    await expect(header).toHaveCount(width === 390 ? 2 : 1);
    const path = `/sellers/${seller.oxyUserId}`;
    for (const link of await header.all()) await expect(link).toHaveAttribute('href', path);
    if (width === 390) await expect(header.last()).toHaveText('Visit profile');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({ path: `/tmp/mercaria-person-product-${width}.png` });
    await expect.poll(() => mediaRequests.length).toBeGreaterThan(0);
    await header.first().focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByText(seller.displayName, { exact: true })).toBeVisible();
    await page.goBack();
    const card = page.getByRole('link', {
      name: `View ${seller.displayName}'s profile`,
      exact: true,
    });
    await expect(card).toHaveAttribute('href', path);
    const popupPromise = context.waitForEvent('page');
    await card.click({ modifiers: ['ControlOrMeta'] });
    const popup = await popupPromise;
    await expect(popup).toHaveURL(new RegExp(`${path}$`));
    await popup.close();
    // Old cached DTOs carried an already-resolved Oxy URL. Keep that rendition,
    // rather than URL-encoding a whole URL into a second file ID.
    seller.avatar = 'https://cloud.oxy.so/unavailable-person-avatar?variant=thumb';
    mediaRequests.length = 0;
    await page.reload();
    await expect(card).toBeVisible();
    await expect.poll(() => mediaRequests.length).toBeGreaterThan(0);
    expect(
      mediaRequests.every((url) => new URL(url).pathname === '/unavailable-person-avatar'),
    ).toBe(true);
    seller.avatar = 'https://supplier-avatar.example/avatar.jpg';
    mediaRequests.length = 0;
    await page.reload();
    await expect(card).toBeVisible();
    await expect(card.locator('img')).toHaveCount(0);
    await expect(card.getByText('K', { exact: true })).toBeVisible();
    await card.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByText(seller.displayName, { exact: true })).toBeVisible();
    expect(mediaRequests).toEqual([]);
  });
}
