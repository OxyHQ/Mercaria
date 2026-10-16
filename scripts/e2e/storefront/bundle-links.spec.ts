import { expect, test } from '@playwright/test';
import type { CanonicalProductPage, Listing } from '../../../packages/shared-types/src';

for (const width of [390, 1440]) {
  test(`bundle destinations support keyboard and new tabs at ${width}px`, async ({
    page,
    context,
    request,
  }) => {
    const feed = (await (await request.get('http://localhost:4160/listings?limit=100')).json())
      .data as Listing[];
    const summary = feed.find((item) => item.title === 'Brilliant Eye Brightener');
    expect(summary).toBeTruthy();
    const listing: Listing = (
      await (await request.get(`http://localhost:4160/listings/${summary!.id}`)).json()
    ).data;
    const handle = 'smartphone-kaido-vero-5';
    const canonical: CanonicalProductPage = (
      await (await request.get(`http://localhost:4160/product-page/${handle}`)).json()
    ).data;
    const [source, target] = listing.variants;
    const [componentVariant, alternateComponent] = canonical.variants;
    const component = {
      productId: canonical.product.id,
      productSlug: handle,
      variantId: componentVariant.id,
      name: canonical.product.name,
      quantity: 1,
    };
    listing.bundleContentsByVariant = {
      [source.id]: { status: 'available', variantId: source.id, components: [component] },
    };
    listing.bundlesByVariant = {
      [source.id]: [
        {
          listingId: listing.id,
          variantId: target.id,
          title: 'Choose your brightener set',
          image: listing.images[0],
          price: target.price,
          action: 'view_bundle',
        },
      ],
    };
    // Only public bundle relations vary; all media uses the real Oxy delivery path.
    await context.route(`http://localhost:4160/listings/${listing.id}`, (route) =>
      route.fulfill({ json: { success: true, data: listing } }),
    );
    await context.route(`**/product-page/${handle}?*`, (route) => {
      const selected = new URL(route.request().url()).searchParams.get('canonicalVariantId');
      return route.fulfill({
        json: {
          success: true,
          data: {
            ...canonical,
            selectedVariantId: selected ?? undefined,
            bundleContents: {
              status: 'available',
              variantId: selected ?? componentVariant.id,
              components: [{ ...component, variantId: alternateComponent.id }],
            },
          },
        },
      });
    });
    await page.addInitScript(() => {
      localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 1000 });
    const original = `/products/${listing.id}?variantId=${source.id}`;
    const destination = `/products/${listing.id}?variantId=${target.id}`;
    await page.goto(original);
    const shelf = page.getByTestId('bundle-recommendations');
    await expect(shelf.locator('a')).toHaveCount(3);
    for (const anchor of await shelf.locator('a').all())
      await expect(anchor).toHaveAttribute('href', destination);
    const popupEvent = context.waitForEvent('page');
    await shelf
      .getByRole('link', { name: 'View bundle', exact: true })
      .click({ modifiers: ['ControlOrMeta'] });
    const popup = await popupEvent;
    await expect(popup).toHaveURL(new RegExp(`${destination}$`.replace('?', '\\?')));
    await expect(page).toHaveURL(new RegExp(`${original}$`.replace('?', '\\?')));
    await popup.close();
    await shelf.getByTestId('bundle-recommendation-image').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${destination}$`.replace('?', '\\?')));
    await page.goto(original);
    const included = page.getByTestId('bundled-product-card');
    const componentPath = `/p/${handle}?variant=${componentVariant.id}`;
    await expect(included).toHaveAttribute('href', componentPath);
    const componentPopupEvent = context.waitForEvent('page');
    await included.click({ modifiers: ['ControlOrMeta'] });
    const componentPopup = await componentPopupEvent;
    await expect(componentPopup).toHaveURL(new RegExp(`${componentPath}$`.replace('?', '\\?')));
    await componentPopup.close();
    await included.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${componentPath}$`.replace('?', '\\?')));
    // The canonical product exposes the same shared component through its own route builder.
    const canonicalCard = page.getByTestId('bundled-product-card');
    await expect(canonicalCard).toHaveAttribute(
      'href',
      new RegExp(`^/p/${handle}\\?variant=${alternateComponent.id}(&|$)`),
    );
    await canonicalCard.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`variant=${alternateComponent.id}(&|$)`));
  });
}
