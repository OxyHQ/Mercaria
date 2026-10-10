import { expect, test } from '@playwright/test';
import en from '../../../packages/frontend/lib/i18n/locales/en.json';
import ar from '../../../packages/frontend/lib/i18n/locales/ar.json';

for (const [width, locale] of [[1440, 'en'], [390, 'ar']] as const) {
  test(`store policies preserve safe authored content at ${width}px ${locale}`, async ({ page, request }) => {
    const copy = locale === 'ar' ? ar : en;
    const appMode = locale === 'ar' ? 'dark' : 'light';
    const brandColor = locale === 'ar' ? '#f6e3c5' : '#123456';
    const textTone = locale === 'ar' ? 'dark' : 'light';
    const foreground = textTone === 'light' ? 'rgb(255, 255, 255)' : 'rgb(17, 17, 17)';
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(locale => localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale }, version: 0 })), locale);
    await page.addInitScript(mode => localStorage.setItem('mercaria.bloom.theme', JSON.stringify({ mode, colorPreset: 'blue' })), appMode);
    const feed = await (await request.get('http://localhost:4160/feed')).json();
    const product = feed.data.sections.flatMap((section: { products?: { id: string; title: string }[] }) => section.products ?? [])
      .find((item: { title: string }) => item.title === 'Brilliant Eye Brightener');
    expect(product, 'Requires the documented local storefront seed').toBeTruthy();
    const { store } = (await (await request.get(`http://localhost:4160/listings/${product.id}`)).json()).data;
    // Isolate authored content only. No catalog/image response or persistence is replaced.
    const policy = '<h2>Privacy details</h2><p>We retain <strong>only necessary data</strong>.</p><ol start="3"><li>Request a copy</li><li>Request deletion</li></ol><p><a href="mailto:privacy@example.com">Contact privacy team</a></p><script>window.policyExecuted=true</script><style>body{display:none}</style><a href="javascript:alert(1)">Unsafe link</a><img src="https://example.com/unimported-policy-image.png" alt="Unimported policy image">';
    const returns = 'Return instructions\nKeep the original packaging.';
    await page.route(new RegExp(`^http://localhost:4160/stores/${store.handle}(?:\\?.*)?$`), async route => {
      const response = await route.fetch();
      const body = await response.json();
      body.data.store.privacyPolicy = policy;
      body.data.store.refundPolicy = returns;
      body.data.store.brandColor = brandColor;
      body.data.store.textTone = textTone;
      await route.fulfill({ response, json: body });
    });
    const externalImages: string[] = [];
    page.on('request', request => { if (request.url().includes('unimported-policy-image')) externalImages.push(request.url()); });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`/stores/${store.handle}`);
    const open = page.getByRole('button', { name: copy.store.menu.openLabel.replace('%{store}', store.name), exact: true });
    await expect(open).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(appMode === 'dark');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--background'))).not.toBe('');
    const globalTheme = await page.evaluate(() => ({
      className: document.documentElement.className,
      background: getComputedStyle(document.documentElement).getPropertyValue('--background'),
      saved: localStorage.getItem('mercaria.bloom.theme'),
    }));
    await open.click();
    await page.getByRole('button', { name: copy.store.policies.privacy, exact: true }).click();
    const panel = page.getByTestId('store-menu-page');
    await expect(panel.getByRole('heading', { name: 'Privacy details', exact: true })).toBeVisible();
    await expect(panel.locator('strong')).toHaveText('only necessary data');
    await expect(panel.locator('ol')).toHaveAttribute('start', '3');
    await expect(panel.getByRole('listitem')).toHaveCount(2);
    await expect(panel.getByRole('link', { name: 'Contact privacy team' })).toHaveAttribute('href', 'mailto:privacy@example.com');
    await expect(panel.getByRole('link', { name: 'Unsafe link' })).toHaveCount(0);
    await expect(panel.locator('script, style, img')).toHaveCount(0);
    await expect(panel).toContainText('Unimported policy image');
    const heading = panel.getByRole('heading', { name: copy.store.policies.privacy, exact: true });
    await expect(heading).toHaveCSS('font-size', '36px');
    await expect(heading).toHaveCSS('line-height', '42px');
    await expect(heading).toHaveCSS('font-weight', '600');
    await expect(heading).toHaveCSS('color', foreground);
    await expect(panel.locator('strong')).toHaveCSS('color', foreground);
    await expect(panel.getByRole('link', { name: 'Contact privacy team' })).toHaveCSS('color', foreground);
    expect(externalImages).toEqual([]);
    expect(await page.evaluate(() => Object.hasOwn(window, 'policyExecuted'))).toBe(false);
    await page.screenshot({ path: `/tmp/mercaria-store-policy-${width}-${locale}.png` });
    await page.getByRole('button', { name: copy.common.back, exact: true }).click();
    await page.getByRole('button', { name: copy.store.policies.returns, exact: true }).click();
    await expect(panel.getByText(returns, { exact: true })).toBeVisible();
    expect(await panel.getByText(returns, { exact: true }).textContent()).toBe(returns);
    await expect(panel.getByText(returns, { exact: true })).toHaveCSS('color', foreground);
    await page.keyboard.press('Escape');
    await expect(open).toBeFocused();
    expect(await page.evaluate(() => ({
      className: document.documentElement.className,
      background: getComputedStyle(document.documentElement).getPropertyValue('--background'),
      saved: localStorage.getItem('mercaria.bloom.theme'),
    }))).toEqual(globalTheme);
    expect(errors).toEqual([]);
  });
}
