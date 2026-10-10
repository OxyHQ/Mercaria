import { expect, test } from '@playwright/test';
import type { Listing } from '../../../packages/shared-types/src';

// Negative transport tests: the nonexistent clip returns 404. Existing photos
// are actual synchronized Oxy files. This does not claim successful playback.
for (const width of [390, 1440]) {
  test(`mixed product media never treats video as a photo and retries failed clips at ${width}px`, async ({ page, request }) => {
    const feed = await (await request.get('http://localhost:4160/feed')).json();
    const summary = feed.data.sections.flatMap((section: { products?: Listing[] }) => section.products ?? [])
      .find((listing: Listing) => listing.title === 'Brilliant Eye Brightener');
    expect(summary, 'Requires the local storefront seed').toBeTruthy();
    const listing: Listing = (await (await request.get(`http://localhost:4160/listings/${summary.id}`)).json()).data;
    expect(listing.images.length).toBeGreaterThan(1);
    const fileId = 'unavailable-catalog-video-contract';
    listing.media = [
      ...(width < 768 ? [] : [{ ...listing.images[0], kind: 'image' as const }]),
      { kind: 'video', fileId, position: width < 768 ? 0 : 1 },
      { ...listing.images[1], kind: 'image' },
    ];
    for (const variant of listing.variants) variant.images = { source: 'listing_fallback', images: listing.images };
    await page.addInitScript(() => {
      localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
    });
    await page.route(`**/listings/${listing.id}`, route => route.fulfill({ json: { success: true, data: listing } }));
    let attempts = 0;
    await page.route(`https://cloud.oxy.so/${fileId}**`, route => {
      attempts++;
      return route.fulfill({ status: 404, body: '' });
    });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/products/${listing.id}`);
    const gallery = page.getByTestId('product-gallery');
    await expect(gallery).toBeVisible();
    if (width >= 768) {
      await expect(gallery.getByRole('button', { name: 'View video 2', exact: true })).toBeVisible();
      expect(attempts, 'Offscreen video must not start a download').toBe(0);
      await gallery.getByRole('button', { name: 'View video 2', exact: true }).click();
    }
    await expect(gallery.getByRole('alert')).toHaveText('This media could not be loaded.');
    await expect(gallery.locator(`img[src*="${fileId}"]`)).toHaveCount(0);
    const before = attempts;
    await gallery.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect.poll(() => attempts).toBeGreaterThan(before);
    await expect(gallery.getByRole('alert')).toBeVisible();
    if (width >= 768) {
      await gallery.getByRole('button', { name: 'View image 3', exact: true }).click();
      await expect(gallery.locator('video')).toHaveJSProperty('paused', true);
    }
    expect(errors).toEqual([]);
  });
}

test('the Bloom viewer returns the same clip to its inline surface on close', async ({ page, request }) => {
  const feed = await (await request.get('http://localhost:4160/feed')).json();
  const summary = feed.data.sections.flatMap((section: { products?: Listing[] }) => section.products ?? [])
    .find((listing: Listing) => listing.title === 'Brilliant Eye Brightener');
  const listing: Listing = (await (await request.get(`http://localhost:4160/listings/${summary.id}`)).json()).data;
  const fileId = 'unavailable-catalog-video-lifecycle';
  listing.media = [{ kind: 'video', fileId, position: 0 }, { ...listing.images[0], kind: 'image', position: 1 }];
  for (const variant of listing.variants) variant.images = { source: 'listing_fallback', images: listing.images };
  await page.addInitScript(() => {
    localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
  });
  await page.route(`**/listings/${listing.id}`, route => route.fulfill({ json: { success: true, data: listing } }));
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  await page.route(`https://cloud.oxy.so/${fileId}**`, async route => {
    await pending;
    await route.fulfill({ status: 404, body: '' });
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`/products/${listing.id}`);
    const gallery = page.getByTestId('product-gallery');
    const inline = gallery.locator('video');
    await expect(inline).toHaveAttribute('src', `https://cloud.oxy.so/${fileId}`);
    await gallery.getByRole('button', { name: `Open video of ${listing.title}`, exact: true }).click();
    await expect(inline).not.toHaveAttribute('src');
    await expect(page.locator(`video[src="https://cloud.oxy.so/${fileId}"]`)).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(inline).toHaveAttribute('src', `https://cloud.oxy.so/${fileId}`);
    await expect(page.locator('video')).toHaveCount(1);
    finish();
    await expect(gallery.getByRole('alert')).toHaveText('This media could not be loaded.');
    expect(errors).toEqual([]);
  } finally { finish(); }
});

for (const width of [390, 1440]) {
  test(`a clip failing inside the open viewer offers a real retry at ${width}px`, async ({ page, request }) => {
    const feed = await (await request.get('http://localhost:4160/feed')).json();
    const summary = feed.data.sections.flatMap((section: { products?: Listing[] }) => section.products ?? [])
      .find((listing: Listing) => listing.title === 'Brilliant Eye Brightener');
    expect(summary, 'Requires the local storefront seed').toBeTruthy();
    const listing: Listing = (await (await request.get(`http://localhost:4160/listings/${summary.id}`)).json()).data;
    const fileId = 'unavailable-catalog-video-open-viewer';
    listing.media = [
      ...(width < 768 ? [] : [{ ...listing.images[0], kind: 'image' as const }]),
      { kind: 'video', fileId, position: width < 768 ? 0 : 1 },
      { ...listing.images[1], kind: 'image' },
    ];
    for (const variant of listing.variants) variant.images = { source: 'listing_fallback', images: listing.images };
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(() => {
      localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
    });
    await page.route(`**/listings/${listing.id}`, route => route.fulfill({ json: { success: true, data: listing } }));
    let finish!: () => void;
    let attempts = 0;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    await page.route(`https://cloud.oxy.so/${fileId}**`, async route => {
      attempts++;
      await pending;
      await route.fulfill({ status: 404, body: '' });
    });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(`/products/${listing.id}`);
      const gallery = page.getByTestId('product-gallery');
      if (width >= 768) await gallery.getByRole('button', { name: 'View video 2', exact: true }).click();
      const inline = gallery.locator('video');
      await expect(inline).toHaveAttribute('src', `https://cloud.oxy.so/${fileId}`);
      await gallery.getByRole('button', { name: `Open video of ${listing.title}`, exact: true }).click();
      await expect(inline).not.toHaveAttribute('src');
      finish();
      // The status belongs to the active fullscreen surface, not a duplicate
      // alert in the obscured inline gallery or an invisible failed video.
      await expect(page.getByRole('alert')).toHaveText('This media could not be loaded.');
      await expect(gallery.getByRole('alert')).toHaveCount(0);
      const before = attempts;
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      // A retry disposes the failed viewer session and returns to the same
      // inline slot. It does not pretend the new player is the old snapshot.
      await expect(inline).toHaveAttribute('src', `https://cloud.oxy.so/${fileId}`);
      await expect(page.locator('video')).toHaveCount(1);
      await expect.poll(() => attempts).toBeGreaterThan(before);
      await expect(gallery.getByRole('alert')).toHaveText('This media could not be loaded.');
      if (width >= 768) await expect(gallery.getByRole('button', { name: 'View video 2', exact: true })).toHaveAttribute('aria-pressed', 'true');
      expect(errors).toEqual([]);
    } finally { finish(); }
  });
}
