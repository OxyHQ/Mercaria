import { expect, test } from '@playwright/test';
import type {
  Cart,
  CommercialPresentation,
  ProductSummary,
} from '../../../packages/shared-types/src';

for (const width of [390, 1440]) {
  test(`cart vendor links preserve seller identity and missing destinations at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(() =>
      localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 })),
    );
    const feed = await (await request.get('http://localhost:4160/feed')).json();
    const product = feed.data.sections
      .flatMap((section: { products?: ProductSummary[] }) => section.products ?? [])
      .find((entry: ProductSummary) => entry.title === 'Brilliant Eye Brightener');
    expect(product, 'Requires the real local storefront seed').toBeTruthy();
    await page.goto(`/products/${product.id}`);
    await page.getByRole('button', { name: 'Shade: Stella', exact: true }).click();
    const added = page.waitForResponse(
      (response) =>
        response.url().endsWith('/cart/items') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
    const original: Cart = (await (await added).json()).data;
    let cart = structuredClone(original);
    // Vary only the public seller projection. Cart creation and Oxy media remain real.
    await page.route('http://localhost:4160/cart', (route) =>
      route.fulfill({ json: { success: true, data: cart } }),
    );
    const retail: CommercialPresentation = {
      mode: 'mercaria_retail',
      sellerLegalEntityName: 'Test retail seller',
      sellerLegalEntityCountry: 'ES',
      supplierFulfilmentDisclosureKey: 'fulfilled_by_approved_partner',
      supplierFulfilmentDisclosureVersion: 1,
      rights: {
        termsVersion: 'test-v1',
        cancellationWindowHours: 24,
        withdrawalWindowDays: 14,
        returnWindowDays: 30,
        warrantyMonths: 24,
      },
      disclosures: ['sold_by_mercaria', 'fulfilled_by_approved_partner'],
    };
    cart.groups[0].commercial = retail;
    await page.goto('/');
    const card = page.getByTestId('merchant-cart-card').first();
    await expect(card.getByText(retail.sellerLegalEntityName, { exact: true })).toBeVisible();
    await expect(card.getByRole('link')).toHaveCount(1); // Catalogue logo, never the seller's name.
    await expect(card.getByRole('link')).toHaveAttribute(
      'href',
      `/stores/${original.groups[0].vendor.handle}`,
    );
    expect(
      await card
        .getByText(retail.sellerLegalEntityName, { exact: true })
        .evaluate((node) => node.closest('a')),
    ).toBeNull();
    await page.goto('/cart');
    await expect(
      page.getByRole('link', { name: `Visit ${retail.sellerLegalEntityName}`, exact: true }),
    ).toHaveCount(0);

    cart = structuredClone(original);
    delete cart.groups[0].vendor.handle;
    await page.goto('/');
    await expect(card).toBeVisible();
    await expect(card.getByRole('link')).toHaveCount(0);
    await page.goto('/cart');
    await expect(
      page.getByRole('link', { name: `Visit ${original.groups[0].vendor.name}`, exact: true }),
    ).toHaveCount(0);

    cart = structuredClone(original);
    const group = cart.groups[0];
    group.vendor = {
      ...group.vendor,
      kind: 'user',
      id: 'cart-seller-identity',
      name: 'Cart seller',
      handle: undefined,
    };
    group.commercial = {
      mode: 'connected_marketplace',
      sellerKind: 'user',
      sellerLabel: group.vendor.name,
      sellerRole: 'direct',
      disclosures: [],
    };
    await page.goto('/');
    await expect(card.getByRole('link')).toHaveCount(2);
    for (const link of await card.getByRole('link').all())
      await expect(link).toHaveAttribute('href', '/sellers/cart-seller-identity');
    await page.goto('/cart');
    await expect(
      page.getByRole('link', { name: 'Visit Cart seller', exact: true }),
    ).toHaveAttribute('href', '/sellers/cart-seller-identity');
  });
}
