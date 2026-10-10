import { expect, test } from '@playwright/test';
import type { CommercialPresentation, Listing } from '../../../packages/shared-types/src';

for (const width of [390, 1440]) {
  test(`merchant return policy opens a readable Bloom sheet at ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(() => localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 })));
    const feed = await (await request.get('http://localhost:4160/feed')).json();
    const product = feed.data.sections.flatMap((section: { products?: { id: string; title: string }[] }) => section.products ?? []).find((item: { title: string }) => item.title === 'Brilliant Eye Brightener');
    expect(product, 'Requires the real local storefront seed').toBeTruthy();
    let sellerKind: 'store' | 'user' = 'store';
    let mode = 'connected_marketplace';
    // Policy metadata varies; catalog images and their Oxy delivery stay real.
    await page.route(`**/listings/${product.id}`, async route => {
      const response = await route.fetch();
      const body = await response.json();
      body.data.store.refundPolicy = '<h2>Return conditions</h2><p>Contact the shop before sending your item.</p><ul><li>Keep your proof of purchase.</li><li>Include the original packaging.</li></ul><p>Read our <a href="https://example.com/returns">return instructions</a>.</p><script>document.body.dataset.executed="yes"</script>';
      const commercial: CommercialPresentation = mode === 'mercaria_retail' ? {
        mode: 'mercaria_retail', sellerLegalEntityName: 'Test retail seller', sellerLegalEntityCountry: 'ES',
        supplierFulfilmentDisclosureKey: 'fulfilled_by_approved_partner', supplierFulfilmentDisclosureVersion: 1,
        rights: { termsVersion: 'test-v1', cancellationWindowHours: 24, withdrawalWindowDays: 14, returnWindowDays: 30, warrantyMonths: 24 },
        disclosures: ['sold_by_mercaria', 'fulfilled_by_approved_partner'],
      } : { mode: 'connected_marketplace', sellerKind, sellerLabel: body.data.store.name, sellerRole: 'direct', disclosures: ['sold_by_merchant'] };
      for (const variant of (body.data as Listing).variants) variant.commercial = commercial;
      await route.fulfill({ response, json: body });
    });
    await page.goto(`/products/${product.id}`);
    const trigger = page.getByTestId('structured-policies-return-policy');
    await expect(trigger).toHaveCSS('min-height', '40px');
    await expect(page.getByText('Return conditions', { exact: true })).toHaveCount(0);
    await trigger.focus();
    await page.keyboard.press('Enter');
    const sheet = page.getByTestId('product-return-policy-dialog');
    await expect(sheet).toHaveCSS('opacity', '1');
    await expect.poll(async () => {
      const bounds = await sheet.boundingBox();
      return bounds && Math.round(bounds.x);
    }).toBe(width >= 976 ? width - 516 : 0);
    const themeBackground = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--background)';
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    // Opaque means the actual Bloom surface, in the active recipe and mode.
    await expect(sheet).toHaveCSS('background-color', themeBackground);
    expect(themeBackground).toMatch(/^rgb\(/);
    await expect(sheet.getByRole('heading', { name: 'Return conditions', exact: true })).toBeVisible();
    await expect(sheet.locator('li')).toHaveCount(2);
    await expect(sheet.getByRole('link', { name: 'return instructions' })).toHaveAttribute('href', 'https://example.com/returns');
    await expect(sheet).not.toContainText('<h2>');
    await expect(sheet.locator('script')).toHaveCount(0);
    await expect(page.locator('body')).not.toHaveAttribute('data-executed');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/mercaria-return-policy-${width}.png` });
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toBeFocused();
    // A store object alone never grants a store's policy to a person or a
    // Mercaria retail offer whose transaction has a different responsible seller.
    sellerKind = 'user';
    await page.reload();
    await expect(page.getByTestId('product-sections')).toBeVisible();
    await expect(trigger).toHaveCount(0);
    sellerKind = 'store'; mode = 'mercaria_retail';
    await page.reload();
    await expect(page.getByTestId('product-sections')).toBeVisible();
    await expect(trigger).toHaveCount(0);
  });
}
