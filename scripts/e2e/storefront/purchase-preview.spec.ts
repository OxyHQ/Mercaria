import { expect, test } from '@playwright/test';
import type { Feed } from '../../../packages/shared-types/src';

// Development-only, visibly labelled purchase previews. Real commerce is never called.
const cases = [
  ['subscription', 390, 'en', 'light', 'no-preference'],
  ['subscription', 1440, 'en', 'light', 'reduce'],
  ['required', 390, 'en', 'light', 'reduce'],
  ['prepaid', 390, 'en', 'light', 'reduce'],
  ['introductory', 1440, 'en', 'dark', 'reduce'],
  ['unavailable', 390, 'en', 'light', 'reduce'],
  ['subscription', 390, 'ar', 'light', 'reduce'],
  ['subscription', 320, 'de', 'light', 'reduce'],
] as const;
for (const [scenario, width, locale, mode, reducedMotion] of cases) {
  test(`purchase preview ${scenario} uses Bloom controls at ${width}px ${locale} ${mode}`, async ({ page, request }) => {
    const response = await request.get('http://localhost:4160/feed');
    expect(response.ok()).toBe(true);
    const { data }: { data: Feed } = await response.json();
    const product = data.sections.flatMap(section => section.kind === 'products' ? section.products : [])[0];
    expect(product).toBeDefined();
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion });
    await page.addInitScript(({ locale, mode }) => {
      localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale }, version: 0 }));
      localStorage.setItem('mercaria.bloom.theme', JSON.stringify({ mode, colorPreset: 'mono' }));
    }, { locale, mode });
    const errors: string[] = [], writes: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.method() !== 'GET' && /\/(cart|checkout|orders)(\/|\?|$)/.test(new URL(request.url()).pathname)) writes.push(request.url());
    });
    await page.goto(`/products/${product.id}?purchasePreview=${scenario}`);
    const preview = page.getByTestId('purchase-plan-preview');
    await expect(preview).toBeVisible({ timeout: 60000 });
    const picker = page.getByTestId(scenario === 'required' ? 'purchase-plan-required' : 'purchase-plan-picker');
    await picker.evaluate(element => element.scrollIntoView({ block: 'center' }));
    if (scenario !== 'required') {
      const group = picker.getByRole('radiogroup');
      const radios = group.getByRole('radio');
      await expect(radios).toHaveCount(2);
      await expect(radios.nth(0)).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('purchase-plan-body-subscription')).toHaveAttribute('inert', '');
      await expect.poll(async () => (await page.getByTestId('purchase-plan-body-subscription').boundingBox())!.height).toBe(0);
      await radios.nth(0).focus();
      await page.keyboard.press('ArrowDown');
      await expect(radios.nth(1)).toHaveAttribute('aria-checked', 'true');
      await expect(radios.nth(1)).toBeFocused();
      if (scenario === 'subscription' || scenario === 'unavailable') {
        const frequency = page.getByTestId('purchase-plan-frequency');
        await expect(frequency).toBeVisible();
        await frequency.click();
        const menu = page.getByRole('menu');
        await expect(menu).toBeVisible();
        const last = menu.getByRole('radio').last();
        const frequencyLabel = await last.getAttribute('aria-label');
        await last.click();
        await expect(menu).not.toBeVisible();
        await radios.nth(0).click();
        await expect(page.getByTestId('purchase-plan-body-subscription')).toHaveAttribute('inert', '');
        await expect.poll(async () => (await page.getByTestId('purchase-plan-body-subscription').boundingBox())!.height).toBe(0);
        await radios.nth(1).click();
        await expect(frequency).toContainText(frequencyLabel!);
      }
    } else {
      await expect(picker.getByRole('radio')).toHaveCount(0);
      await expect(page.getByTestId('purchase-plan-frequency')).toHaveCount(0);
    }
    if (locale === 'en') {
      if (scenario === 'unavailable') {
        await expect(picker.getByRole('button', { name: 'Sold out', exact: true })).toBeDisabled();
        await expect(picker.getByRole('button', { name: 'Subscribe now', exact: true })).not.toBeVisible();
      } else {
        const add = picker.getByRole('button', { name: 'Add to cart', exact: true });
        await add.click();
        await expect(preview.getByTestId('purchase-preview-result')).toContainText('Simulated: added');
        await picker.getByRole('button', { name: 'Subscribe now', exact: true }).click();
        await expect(preview.getByTestId('purchase-preview-result')).toContainText('Simulated checkout complete');
      }
      if (scenario === 'prepaid') await expect(picker).toContainText('Three deliveries paid in advance.');
      if (scenario === 'introductory') await expect(picker).toContainText('Introductory price for the first delivery');
    }
    const geometry = await picker.evaluate(element => ({ width: element.getBoundingClientRect().width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });
}
