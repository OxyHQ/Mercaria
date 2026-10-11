import { expect, test } from '@playwright/test';
import type { CanonicalProductPage } from '../../../packages/shared-types/src';

// Metadata-only configuration fixtures. No image responses, purchases or writes.
for (const [width, locale] of [
  [1440, 'en'],
  [390, 'ar'],
] as const) {
  for (const kind of ['named', 'axis'] as const) {
    test(`${kind} configurations use one keyboard stop and retain the page at ${width}px ${locale}`, async ({
      page,
      request,
    }) => {
      const handle = 'smartphone-kaido-vero-5';
      const response = await request.get(`http://localhost:4160/product-page/${handle}`);
      expect(response.ok()).toBe(true);
      const fixture: CanonicalProductPage = (await response.json()).data;
      const variants = fixture.variants.slice(0, 3);
      expect(variants).toHaveLength(3);
      const names = ['Amber', 'Blue', 'Clay'];
      await page.route(
        (url) => url.pathname === `/product-page/${handle}`,
        async (route) => {
          const selected = new URL(route.request().url()).searchParams.get('canonicalVariantId');
          const data = structuredClone(fixture);
          data.product.images = [];
          data.product.variantDefiningAttributeKeys =
            kind === 'axis' ? ['smartphone_phone_color'] : [];
          data.variants = variants.map((variant, index) => ({
            ...variant,
            name: names[index],
            offerCount: kind === 'axis' && index === 1 ? 0 : 1,
            options:
              kind === 'axis'
                ? [
                    {
                      key: 'smartphone_phone_color',
                      displayValue: names[index],
                      normalizedValue: names[index].toLowerCase(),
                      position: 0,
                    },
                  ]
                : [],
          }));
          data.selectedVariantId = selected ?? undefined;
          await route.fulfill({ json: { success: true, data } });
        },
      );
      await page.addInitScript((locale) => {
        localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale }, version: 0 }));
        localStorage.setItem(
          'mercaria.bloom.theme',
          JSON.stringify({ mode: 'light', colorPreset: 'mono' }),
        );
      }, locale);
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`/p/${handle}?variant=${variants[0].id}`);
      const first = page.getByRole('radio', { name: /Amber/ });
      await expect(first).toBeVisible();
      const group = page.getByRole('radiogroup').filter({ has: first });
      await expect(group.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
      const gallery = await page.getByTestId('product-gallery').elementHandle();
      const historyLength = await page.evaluate(() => history.length);
      await first.focus();
      await page.keyboard.press(locale === 'ar' ? 'ArrowLeft' : 'ArrowRight');
      const next = kind === 'axis' ? 2 : 1;
      const selected = page.getByRole('radio', { name: new RegExp(names[next]) });
      await expect(selected).toBeFocused();
      await expect(selected).toHaveAttribute('aria-checked', 'true');
      await expect(page).toHaveURL(new RegExp(`variant=${variants[next].id}`));
      if (kind === 'axis') await expect(page.getByRole('radio', { name: /Blue/ })).toBeDisabled();
      await page.keyboard.press('End');
      await expect(page.getByRole('radio', { name: /Clay/ })).toBeFocused();
      await expect(page).toHaveURL(new RegExp(`variant=${variants[2].id}`));
      await page.keyboard.press('Home');
      const home = kind === 'named' ? group.getByRole('radio').first() : first;
      await expect(home).toBeFocused();
      await expect(home).toHaveAttribute('aria-checked', 'true');
      if (kind === 'named')
        await expect.poll(() => new URL(page.url()).searchParams.get('variant') ?? '').toBe('');
      else await expect(page).toHaveURL(new RegExp(`variant=${variants[0].id}`));
      await page.keyboard.press('Space');
      await expect(home).toHaveAttribute('aria-checked', 'true');
      await expect(group.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
      expect(await gallery!.evaluate((element) => element.isConnected)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    });
  }
}
