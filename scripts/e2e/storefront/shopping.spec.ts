import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
    localStorage.setItem('mercaria.bloom.theme', JSON.stringify({ mode: 'light', colorPreset: 'mono' }));
  });
});

test('composer opens a shopping thread from text and catalog suggestions', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const input = page.locator('[data-testid="shopping-composer"]:visible').getByRole('textbox');
  await input.fill('linen');
  await input.press('Enter');
  await expect(page).toHaveURL(/\/thread\?q=linen$/);
  await expect(page.getByTestId('shopping-thread')).toContainText('linen');
  await expect(page.getByText('The shopping assistant is not available yet. You can still search the catalogue.')).toBeVisible();

  await page.goto('/');
  await input.click();
  const suggestion = page.getByRole('option').first();
  await expect(suggestion).toBeVisible();
  const label = await suggestion.innerText();
  await suggestion.click();
  await expect(page).toHaveURL(new RegExp(`/thread\\?q=${encodeURIComponent(label)}$`));

  await page.goto('/');
  await input.click();
  await expect(suggestion).toBeVisible();
  await input.press('ArrowDown');
  const keyboardChoice = await page.getByRole('option', { selected: true }).innerText();
  await input.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/thread\\?q=${encodeURIComponent(keyboardChoice)}$`));
  expect(errors).toEqual([]);
});

test('Bloom rail navigates and composer dismisses suggestions outside its bounds', async ({ page }) => {
  await page.goto('/');
  const input = page.locator('[data-testid="shopping-composer"]:visible').getByRole('textbox');
  await input.click();
  await expect(page.getByRole('option').first()).toBeVisible();
  await input.press('Escape');
  await expect(page.getByRole('option')).toHaveCount(0);
  await page.getByRole('button', { name: 'Explore', exact: true }).click();
  await expect(page).toHaveURL(/\/explore$/);
  await expect(input).toBeVisible();
  await page.getByRole('button', { name: 'Cart', exact: true }).click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.locator('[data-testid="shopping-composer"]:visible')).toHaveCount(0);
  await expect(page.getByText('Your cart is empty', { exact: true })).toBeVisible();
});

test('mobile composer remains inside viewport above navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const composer = page.locator('[data-testid="shopping-composer"]:visible');
  await expect(composer).toBeVisible();
  const box = await composer.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y + box!.height).toBeLessThan(800);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await composer.getByRole('textbox').fill('beauty');
  await composer.getByRole('textbox').press('Enter');
  await expect(page).toHaveURL(/\/thread\?q=beauty$/);
});

test('dark Arabic layout and reduced motion retain a usable composer', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.addInitScript(() => {
    localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'ar' }, version: 0 }));
    localStorage.setItem('mercaria.bloom.theme', JSON.stringify({ mode: 'dark', colorPreset: 'mono' }));
  });
  await page.goto('/');
  const composer = page.locator('[data-testid="shopping-composer"]:visible');
  await expect(composer).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveClass(/dark/);
  await composer.getByRole('textbox').fill('قميص');
  await composer.getByRole('textbox').press('Enter');
  await expect(page).toHaveURL(/\/thread\?q=/);
  await expect(page.getByTestId('shopping-thread')).toContainText('قميص');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
});

test('seeded product variants and guest cart work through the real API', async ({ page, request }) => {
  const response = await request.get('http://localhost:4160/feed');
  expect(response.ok()).toBeTruthy();
  const feed = await response.json();
  const product = feed.data.sections
    .filter((section: { kind: string }) => section.kind === 'products')
    .flatMap((section: { products: { id: string; title: string }[] }) => section.products)
    .find((item: { title: string }) => item.title === 'Brilliant Eye Brightener');
  expect(product, 'Run the documented local development seed first').toBeTruthy();
  await page.goto(`/products/${product.id}`);
  await page.getByRole('button', { name: 'Shade: Stella', exact: true }).click();
  const added = page.waitForResponse(response => response.url().endsWith('/cart/items')
    && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  expect((await added).ok(), 'Local API needs GUEST_COMMERCE_ENABLED and its two configured keys').toBeTruthy();
  await page.getByRole('button', { name: 'Cart', exact: true }).click();
  await expect(page.getByText('Stella', { exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="shopping-composer"]:visible')).toHaveCount(0);
  await page.getByRole('button', { name: 'Increase quantity', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Decrease quantity', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Decrease quantity', exact: true }).click();
  await page.getByRole('button', { name: 'Remove item', exact: true }).click();
  await expect(page.getByText('Your cart is empty', { exact: true })).toBeVisible();
});


test('document footer stays in the content column after scroll and resize', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('New arrivals', { exact: true })).toBeVisible();
  await page.getByTestId('shopping-composer').getByRole('textbox').fill('linen jacket');
  await page.getByTestId('shopping-composer').getByRole('textbox').press('Escape');
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const footer = page.getByTestId('shopping-composer-footer');
  await expect(footer).toBeVisible();
  const composer = footer.getByTestId('shopping-composer');
  await expect(composer).toHaveCount(1);
  await expect(composer.getByRole('textbox')).toHaveValue('linen jacket');
  let box = await composer.boundingBox();
  expect(box!.y + box!.height).toBeGreaterThan(900);
  expect(box!.y + box!.height).toBeLessThan(1000);
  expect(box!.x).toBeGreaterThan(76);
  await page.setViewportSize({ width: 1050, height: 780 });
  await expect.poll(async () => (await composer.boundingBox())!.y + (await composer.boundingBox())!.height).toBeLessThan(780);
  box = await composer.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(1050);
  await composer.getByRole('textbox').fill('');
  await expect(page.getByRole('option').first()).toBeVisible();
  await page.mouse.click(200, 100);
  await expect(page.getByRole('option')).toHaveCount(0);
});

test('explicit local thread preview supports follow-ups, cancellation and a new conversation', async ({ page }) => {
  const inference: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/shopping-thread')) inference.push(request.url()); });
  await page.goto('/thread?q=linen&preview=1');
  await expect(page.getByText('Preview · Example responses, no AI connected')).toBeVisible();
  await expect(page.getByTestId('thread-preview-products')).toHaveCount(1);
  const input = page.locator('[data-testid="shopping-composer"]:visible').getByRole('textbox');
  await input.fill('Something lighter');
  await input.press('Enter');
  await expect(page.getByTestId('thread-preview-products')).toHaveCount(2);
  await input.fill('Cancel this turn');
  await input.press('Enter');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(input).toBeEnabled();
  await input.fill('An unsent draft');
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(page.getByTestId('thread-preview-products')).toHaveCount(0);
  await expect(page.getByTestId('shopping-thread')).not.toContainText('linen');
  expect(inference).toEqual([]);
});


test('compact hero animates, responds to the pointer and opens the visible product', async ({ page }) => {
  await page.goto('/');
  const hero = page.getByTestId('home-hero');
  const card = page.getByTestId('hero-card-0');
  await expect(card.getByRole('link')).toBeVisible();
  expect((await hero.boundingBox())!.height).toBeLessThan(650);
  const first = await card.evaluate(element => getComputedStyle(element).transform);
  await expect.poll(() => card.evaluate(element => getComputedStyle(element).transform)).not.toBe(first);
  const target = await card.boundingBox();
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2);
  const label = await card.getByRole('link').getAttribute('aria-label');
  await card.getByRole('link').click();
  await expect(page).toHaveURL(/\/products\/[^/]+$/);
  await expect(page.getByText(label!, { exact: true }).first()).toBeVisible();
});

test('Explore owns 3D and editorial cards open their product collections', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '3D', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Explore', exact: true }).click();
  await expect(page).toHaveURL(/\/explore$/);
  await page.getByRole('link', { name: '3D', exact: true }).click();
  await expect(page).toHaveURL(/\/3d$/);
  await page.getByRole('button', { name: 'Explore', exact: true }).click();
  await page.getByTestId('curation-highlights').getByRole('link', { name: 'Everyday finds' }).click();
  await expect(page).toHaveURL(/\/curations\/everyday-finds$/);
  await expect(page.getByTestId('curation-header')).toContainText('Everyday finds');
  const product = page.getByTestId('curation-products').getByRole('link').first();
  const name = await product.getAttribute('aria-label');
  await product.click();
  await expect(page).toHaveURL(/\/products\/[^/]+$/);
  await expect(page.getByText(name!, { exact: true }).first()).toBeVisible();
});

test('Profile is reachable on desktop and mobile and owns Saved', async ({ page }) => {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.getByRole(viewport.width < 768 ? 'tab' : 'button', { name: 'Profile', exact: true }).click();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByTestId('shopping-profile')).toContainText('Your saved finds');
    await expect(page.getByTestId('shopping-composer')).toHaveCount(0);
    await page.getByTestId('shopping-profile').getByRole('button', { name: 'Saved', exact: true }).click();
    await expect(page).toHaveURL(/\/saved$/);
    await expect(page.getByText('Sign in to save things', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
  }
});

test('saving a product as a guest opens sign-in without pretending it was saved', async ({ page }) => {
  await page.goto('/curations/everyday-finds');
  const save = page.getByTestId('curation-products').getByRole('button', { name: 'Add to saved items', exact: true }).first();
  await expect(save).toHaveAttribute('aria-pressed', 'false');
  await save.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(save).toHaveAttribute('aria-pressed', 'false');
});

test('thread composer measures its real width and shrinks after clearing multiline input', async ({ page }) => {
  await page.goto('/thread?preview=1');
  const composer = page.getByTestId('shopping-composer');
  const input = composer.getByRole('textbox');
  await expect.poll(async () => (await composer.boundingBox())?.height).toBe(64);
  await input.fill('A jacket\nFor rainy days\nIn blue\nUnder 100');
  await expect.poll(async () => (await input.boundingBox())?.height).toBe(96);
  await page.setViewportSize({ width: 390, height: 844 });
  await input.fill('');
  await expect.poll(async () => (await composer.boundingBox())?.height).toBe(64);
  const box = await composer.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});
