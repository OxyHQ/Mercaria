import { expect, test } from '@playwright/test';
import type { ProductSummary } from '../../../packages/shared-types/src';

// Navigation checks use the real local catalog. They neither supply image bytes
// nor imply successful media synchronization or successful authenticated saves.
for (const width of [390, 1440]) {
  test(`history shelf and product cards support keyboard and new tabs at ${width}px`, async ({ page, request, context }) => {
    const feed = await (await request.get('http://localhost:4160/feed')).json();
    const product: ProductSummary = feed.data.sections
      .filter((section: { kind: string }) => section.kind === 'products')
      .flatMap((section: { products: ProductSummary[] }) => section.products)[0];
    expect(product).toBeTruthy();
    await page.addInitScript(product => {
      localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
      localStorage.setItem('mercaria.bloom.theme', JSON.stringify({ mode: 'light', colorPreset: 'mono' }));
      localStorage.setItem('mercaria.shopping-history', JSON.stringify({ version: 0, state: {
        products: [{ owner: 'guest', product }], threads: [],
      } }));
    }, product);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    const shelf = page.getByTestId('recently-viewed-shelf');
    const image = shelf.getByRole('link', { name: product.title, exact: true });
    await expect(image).toHaveAttribute('href', `/products/${product.id}`);
    // The save control is beside the image link, never an interactive descendant.
    await expect(image.getByRole('button')).toHaveCount(0);
    await image.focus(); await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/products/${product.id}$`));
    await page.goBack();
    const heading = shelf.getByRole('link', { name: 'Recently viewed', exact: true });
    await expect(heading).toHaveAttribute('href', '/recently-viewed');
    await heading.focus(); await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/recently-viewed$/);
    const cards = page.getByTestId('recently-viewed-products');
    const links = cards.getByRole('link', { name: product.title, exact: true });
    await expect(links).toHaveCount(2);
    const popupPromise = context.waitForEvent('page');
    await links.last().click({ modifiers: ['ControlOrMeta'] });
    const popup = await popupPromise;
    await expect(popup).toHaveURL(new RegExp(`/products/${product.id}$`));
    await expect(page).toHaveURL(/\/recently-viewed$/);
    await popup.close();
    await links.last().focus(); await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/products/${product.id}$`));
  });

  test(`cart recommendations navigate while save remains independent at ${width}px`, async ({ page, context }) => {
    await page.addInitScript(() => {
      localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
      localStorage.setItem('mercaria.bloom.theme', JSON.stringify({ mode: 'dark', colorPreset: 'mono' }));
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/cart');
    const image = page.locator('a[href^="/products/"]').first();
    await expect(image).toBeVisible();
    const href = await image.getAttribute('href');
    expect(href).toMatch(/^\/products\/.+/);
    const popupPromise = context.waitForEvent('page');
    await image.click({ modifiers: ['ControlOrMeta'] });
    const popup = await popupPromise;
    await expect(popup).toHaveURL(new RegExp(`${href}$`));
    await expect(page).toHaveURL(/\/cart$/);
    await popup.close();
    await image.focus(); await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await page.goBack();
    const save = image.locator('..').getByRole('button', { includeHidden: true });
    await expect(save).toHaveAttribute('aria-pressed', 'false');
    await save.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog').first()).toBeVisible();
    await expect(page).toHaveURL(/\/cart$/);
    await expect(save).toHaveAttribute('aria-pressed', 'false');
    expect(await image.evaluate(element => element.tagName)).toBe('A');
    await expect(image.getByRole('button')).toHaveCount(0);
  });
}

for (const width of [390, 1440]) {
  test(`category headings and tiles keep keyboard destinations at ${width}px`, async ({ page, context }) => {
    await page.addInitScript(() => {
      localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
      localStorage.setItem('mercaria.bloom.theme', JSON.stringify({ mode: 'light', colorPreset: 'mono' }));
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    const shelf = page.getByTestId('category-mosaic-shelf');
    const heading = shelf.getByRole('link', { name: 'Women', exact: true });
    await expect(heading).toHaveAttribute('href', '/categories/women');
    await heading.focus(); await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/categories\/women$/);
    await page.goBack();
    const mosaic = shelf.getByTestId('category-mosaic').first();
    await expect(mosaic.getByRole('link')).toHaveCount(4);
    const dresses = mosaic.getByRole('link', { name: 'Dresses', exact: true });
    await expect(dresses).toHaveAttribute('href', '/categories/dresses');
    const popupPromise = context.waitForEvent('page');
    await dresses.click({ modifiers: ['ControlOrMeta'] });
    const popup = await popupPromise;
    await expect(popup).toHaveURL(/\/categories\/dresses$/);
    await popup.close();
    await dresses.focus(); await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/categories\/dresses$/);
  });
}
