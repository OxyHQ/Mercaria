import { expect, test } from '@playwright/test';
import en from '../../../packages/frontend/lib/i18n/locales/en.json';

for (const width of [390, 1440]) {
  test(`listing specifications follow the exact option through loading and retry at ${width}px`, async ({ page, request }) => {
    const listings = await (await request.get('http://localhost:4160/listings?limit=100')).json();
    const listing = listings.data.find((item: { title: string }) => item.title === 'Brilliant Eye Brightener');
    expect(listing).toBeTruthy();
    const detail = await (await request.get(`http://localhost:4160/listings/${listing.id}`)).json();
    const variants = detail.data.variants.slice(0, 3);
    expect(variants).toHaveLength(3);
    await page.route(`**/listings/${listing.id}`, route => route.fulfill({ json: { ...detail, data: { ...detail.data,
      catalogIdentityByVariant: Object.fromEntries(variants.slice(0, 2).map((variant: { id: string }, index: number) => [variant.id, {
        productId: 'specification-product', variantId: `specification-option-${index}`, categoryId: 'specification-category',
      }])),
    } } }));
    const value = (key: string, label: string, displayValue: string) => ({ key, label, displayValue,
      valueType: 'text', position: 0, sourceBacked: true, verificationState: 'unverified' });
    const reads: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let fail = true;
    await page.route('**/catalog-attributes/**', async route => {
      const path = new URL(route.request().url()).pathname;
      reads.push(path);
      if (path.endsWith('/definitions')) return route.fulfill({ json: { success: true, data: { definitions: [] } } });
      let values = [value('material', 'Material', 'Cotton')];
      if (path.endsWith('specification-option-0')) values = [value('length', 'Length', '10 cm')];
      if (path.endsWith('specification-option-1')) {
        await pending;
        if (fail) return route.fulfill({ status: 503, json: { success: false, error: 'Temporary test outage' } });
        values = [value('length', 'Length', '20 cm')];
      }
      return route.fulfill({ json: { success: true, data: { values } } });
    });
    await page.addInitScript(() => {
      localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
      localStorage.setItem('mercaria.bloom.theme', JSON.stringify({ mode: 'light', colorPreset: 'mono' }));
    });
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/products/${listing.id}?variantId=${variants[0].id}`);
    const trigger = page.getByTestId('product-sections').getByRole('button', { name: en.catalog.specs.title, exact: true });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const specifications = page.getByTestId('listing-specifications');
    await expect(specifications).toContainText('Cotton');
    await expect(specifications).toContainText('10 cm');
    const gallery = await page.getByTestId('product-gallery').elementHandle();
    const choose = (index: number) => page.getByRole('button', { name: new RegExp(`^Shade: ${variants[index].title}(, Sold out)?$`) }).click();
    try {
      await choose(1);
      await expect(specifications).toContainText(en.common.loading);
      await expect(specifications).not.toContainText('10 cm');
      expect(await gallery!.evaluate(node => node.isConnected)).toBe(true);
      release();
      await expect(specifications.getByRole('alert')).toHaveText(en.catalog.specs.loadError);
      fail = false;
      await specifications.getByRole('button', { name: en.common.tryAgain, exact: true }).click();
      await expect(specifications).toContainText('20 cm');
      await expect(specifications).toContainText('Cotton');
      await expect(specifications).not.toContainText('10 cm');
      await choose(2);
      await expect(specifications).toHaveCount(0);
      await expect(page.getByTestId('product-sections').getByRole('button', { name: en.catalog.specs.title, exact: true })).toHaveCount(0);
      expect(reads.some(path => path.endsWith('undefined') || path.endsWith('/variant/'))).toBe(false);
      await choose(0);
      await expect(specifications).toContainText('10 cm');
      await expect(specifications).not.toContainText('20 cm');
      expect(await gallery!.evaluate(node => node.isConnected)).toBe(true);
      await specifications.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/tmp/mercaria-listing-specifications-${width}.png` });
    } finally { release(); }
  });
}
