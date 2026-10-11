import { expect, test } from '@playwright/test';
import { fixture } from './fixture';

for (const [width, locale] of [
  [390, 'en'],
  [390, 'ar'],
  [1440, 'en'],
] as const) {
  test(`long variant titles preserve the mobile viewport at ${width}px ${locale}`, async ({
    page,
  }) => {
    await fixture(page, locale, 'light');
    await page.setViewportSize({ width, height: 1100 });
    const variant = {
      id: 'layout-variant',
      title:
        'Natural unbleached linen / Extra large tailored fit / Limited edition embroidered finish',
      available: 5,
      inStock: true,
      price: { amount: 4900, currency: 'EUR' },
      optionValues: [],
    };
    const product = {
      id: 'layout-product',
      title: 'Linen studio shirt',
      description: 'A linen shirt.',
      category: 'clothing',
      status: 'active',
      tags: [],
      images: [],
      variants: [
        variant,
        {
          ...variant,
          id: 'unbroken',
          title: 'NaturalUnbleachedLinenExtraLargeTailoredFitLimitedEditionEmbroideredFinish',
        },
      ],
      options: [],
      quantity: 10,
      overriddenFields: [],
      price: variant.price,
    };
    let writes = 0;
    await page.route('**/admin/stores/*/products/layout-product', (route) => {
      if (route.request().method() !== 'GET') writes++;
      return route.fulfill({ json: { success: true, data: product } });
    });
    await page.goto('/products/layout-product');
    for (const item of product.variants) {
      const title = page.getByText(item.title, { exact: true });
      await expect(title).toBeVisible();
      const heading = page.getByTestId('merchant-variant-heading').filter({ has: title });
      const dimensions = await heading.evaluate((el) => {
        const title = el.firstElementChild!.lastElementChild!;
        const price = el.lastElementChild!;
        return {
          title: title.getBoundingClientRect().toJSON(),
          price: price.getBoundingClientRect().toJSON(),
          priceText: price.textContent,
          textStyle: getComputedStyle(title).textOverflow,
          viewport: innerWidth,
          documentWidth: document.documentElement.scrollWidth,
        };
      });
      expect(dimensions.documentWidth).toBe(width);
      expect(dimensions.title.left).toBeGreaterThanOrEqual(0);
      expect(dimensions.title.right).toBeLessThanOrEqual(width);
      expect(dimensions.price.left).toBeGreaterThanOrEqual(0);
      expect(dimensions.price.right).toBeLessThanOrEqual(width);
      expect(dimensions.priceText).toBeTruthy();
      expect(dimensions.textStyle).not.toBe('ellipsis');
      if (width === 390) {
        expect(dimensions.title.height).toBeGreaterThan(20);
        expect(dimensions.price.top).toBeGreaterThanOrEqual(dimensions.title.bottom);
      }
    }
    await page
      .getByTestId('merchant-variant-heading')
      .first()
      .evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: `/tmp/wholesale-variant-layout-${width}-${locale}.png` });
    expect(writes).toBe(0);
  });
}
