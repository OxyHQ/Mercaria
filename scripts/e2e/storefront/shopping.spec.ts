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
  const cartNavigation = page.getByRole('button', { name: 'Cart', exact: true });
  const badge = cartNavigation.getByText(/^\d+$/);
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('1');
  await page.getByRole('button', { name: 'Cart', exact: true }).click();
  await expect(page.getByText('Stella', { exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="shopping-composer"]:visible')).toHaveCount(0);
  await page.getByRole('button', { name: 'Increase quantity', exact: true }).click();
  await expect(badge).toHaveText('2');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('tab', { name: 'Cart', exact: true })).toContainText('2');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByRole('button', { name: 'Decrease quantity', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Decrease quantity', exact: true }).click();
  await page.getByRole('button', { name: 'Remove item', exact: true }).click();
  await expect(page.getByText('Your cart is empty', { exact: true })).toBeVisible();
  await expect(badge).toHaveCount(0);
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
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
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
  // NativeWind's viewport subscription and the input's content-size update
  // settle independently. A collapsed height does not yet imply mobile width.
  await expect.poll(async () => (await composer.boundingBox())?.x).toBeGreaterThanOrEqual(0);
  await expect.poll(async () => {
    const box = await composer.boundingBox();
    return box ? box.x + box.width : Infinity;
  }).toBeLessThanOrEqual(390);
});

test('editorial curation matches the reference cover, reading column and mobile composition', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/curations/01a0e9b7-5414-7e69-a529-85a3f6c3dc47');
  const cover = page.getByTestId('editorial-cover');
  await expect(cover).toBeVisible();
  await expect(page.getByTestId('curation-header')).toContainText('The Courtney Grow Edit');
  await expect.poll(async () => (await cover.boundingBox())!.width).toBe(1140);
  let box = (await cover.boundingBox())!;
  expect(box.height).toBeCloseTo(1140 * 9 / 16, 1);
  expect(box.x).toBeCloseTo(184, 0);
  expect(box.y).toBeCloseTo(316, 0);
  const grid = page.getByTestId('editorial-product-grid').first();
  expect((await grid.boundingBox())!.width).toBe(565);
  await expect(page.getByTestId('editorial-story')).toHaveCount(6);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await cover.boundingBox())!.width).toBe(390);
  box = (await cover.boundingBox())!;
  expect(box.height).toBe(520);
  expect(box.x).toBe(0);
  expect(box.y).toBe(0);
  const title = (await page.getByTestId('editorial-heading').boundingBox())!;
  expect(title.y).toBeGreaterThan(300);
  expect(title.y + title.height).toBeLessThanOrEqual(520);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('editorial scroll fades the pinned title and scales the cover', async ({ page }) => {
  await page.goto('/curations/courtney-grow');
  const cover = page.getByTestId('editorial-cover');
  await expect(cover).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect.poll(() => page.getByTestId('editorial-heading').evaluate(e => Number(getComputedStyle(e).opacity))).toBeLessThan(0.02);
  await expect.poll(() => cover.evaluate(e => getComputedStyle(e).transform)).toMatch(/matrix\(0\.95/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => cover.evaluate(e => getComputedStyle(e).transform)).toBe('none');
});

test('Orders opens from the rail and mobile profile and offers real sign-in', async ({ page }) => {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto(viewport.width < 768 ? '/profile' : '/');
    await page.getByRole('button', { name: 'Orders', exact: true }).click();
    await expect(page).toHaveURL(/\/orders$/);
    const orders = page.getByTestId('shopping-orders');
    await expect(orders).toContainText('Your orders');
    await expect(orders).toContainText('Sign in to see your order history.');
    expect((await orders.boundingBox())!.width).toBe(viewport.width < 768 ? 358 : 640);
    await orders.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Use your Oxy account', { exact: true })).toBeVisible();
    await expect(page.getByTestId('app-content-boundary')).toHaveAttribute('inert', '');
    await expect(page.getByTestId('app-content-boundary')).toHaveAttribute('aria-hidden', 'true');
    expect(await page.getByText('Use your Oxy account', { exact: true }).evaluate(node => node.closest('[inert]'))).toBeNull();
  }
});

test('editorial body inherits the panel surface in both themes', async ({ page }) => {
  for (const mode of ['light', 'dark']) {
    await page.addInitScript((mode) => {
      localStorage.setItem('mercaria.bloom.theme', JSON.stringify({ mode, colorPreset: 'mono' }));
    }, mode);
    await page.goto('/curations/courtney-grow');
    const body = page.getByTestId('curation-products');
    await expect(body).toBeVisible();
    await expect(body).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  }
});

test('home cart shelf matches the merchant layout and checks out only its group', async ({ page, request }) => {
  const feed = await (await request.get('http://localhost:4160/feed')).json();
  const product = feed.data.sections.filter((s: { kind: string }) => s.kind === 'products').flatMap((s: { products: { id: string; title: string }[] }) => s.products).find((p: { title: string }) => p.title === 'Brilliant Eye Brightener');
  await page.goto(`/products/${product.id}`);
  await page.getByRole('button', { name: 'Shade: Stella', exact: true }).click();
  const response = page.waitForResponse(r => r.url().endsWith('/cart/items') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Add to cart', exact: true }).click();
  const payload = await (await response).json();
  const group = payload.data.groups[0];
  await page.goto('/');
  const shelf = page.getByTestId('cart-shelf');
  const card = shelf.getByTestId('merchant-cart-card').first();
  await expect(card).toBeVisible();
  expect((await card.boundingBox())!.width).toBe(330);
  await expect(card).toHaveCSS('border-radius', '28px');
  expect((await card.getByTestId('cart-card-thumbnail-column').boundingBox())!.width).toBe(72);
  await expect(card.getByTestId('cart-card-count')).toHaveText('1');
  await shelf.getByRole('link', { name: 'In your cart', exact: true }).click();
  await expect(page).toHaveURL(/\/cart$/);
  await page.goto('/');
  await card.getByRole('button', { name: 'Continue to checkout', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/checkout\\?seller=${encodeURIComponent(group.sellerKey)}$`));
});

test('Keep shopping resumes a persisted conversation including its follow-up', async ({ page }) => {
  await page.goto('/thread?q=Dinner%20party%20gifts&preview=1');
  await expect(page.getByTestId('thread-preview-products')).toHaveCount(1);
  const composer = page.getByTestId('shopping-composer').getByRole('textbox');
  await composer.fill('Something under 50');
  await composer.press('Enter');
  await expect(page.getByTestId('thread-preview-products')).toHaveCount(2);
  await page.getByTestId('thread-header').getByRole('button', { name: 'Home', exact: true }).click();
  const card = page.getByTestId('thread-shelf').getByRole('link', { name: 'Dinner party gifts', exact: true });
  await expect(card).toBeVisible();
  expect((await card.boundingBox())!.width).toBe(289);
  expect((await card.boundingBox())!.height).toBe(56);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await card.boundingBox())!.width).toBe(239);
  await card.click();
  await expect(page).toHaveURL(/\/thread\?conversationId=/);
  await expect(page.getByTestId('shopping-thread')).toContainText('Something under 50');
  await expect(page.getByTestId('thread-preview-products')).toHaveCount(2);
  await page.reload();
  await expect(page.getByTestId('thread-preview-products')).toHaveCount(2);
});

test('Recently viewed keeps one image-only card per product and opens its full history', async ({ page, request }) => {
  const feed = await (await request.get('http://localhost:4160/feed')).json();
  const product = feed.data.sections.filter((s: { kind: string }) => s.kind === 'products').flatMap((s: { products: { id: string; title: string }[] }) => s.products)[0];
  await page.goto(`/products/${product.id}`);
  await expect(page.getByText(product.title, { exact: true }).first()).toBeVisible();
  await page.goto('/');
  const shelf = page.getByTestId('recently-viewed-shelf');
  const link = shelf.getByRole('link', { name: product.title, exact: true });
  await expect(link).toHaveCount(1);
  expect((await link.boundingBox())!.width).toBe(192);
  expect((await link.boundingBox())!.height).toBe(192);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/products/${product.id}$`));
  await page.goto('/');
  await expect(link).toHaveCount(1);
  await shelf.getByRole('link', { name: 'Recently viewed', exact: true }).click();
  await expect(page).toHaveURL(/\/recently-viewed$/);
  await expect(page.getByTestId('recently-viewed-products')).toContainText(product.title);
});

test('category mosaics show four independently navigable published categories', async ({ page }) => {
  await page.goto('/');
  const chips = page.getByTestId('category-pills');
  await expect(chips).toBeVisible();
  const heroBox = (await page.getByTestId('home-hero').boundingBox())!;
  const chipsBox = (await chips.boundingBox())!;
  expect(chipsBox.y).toBeGreaterThanOrEqual(heroBox.y + heroBox.height);
  expect(chipsBox.y - heroBox.y - heroBox.height).toBeLessThan(32);
  await expect(chips.getByRole('link').first()).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const chipCount = await chips.getByRole('link').count();
  await expect(chips.getByTestId('category-pill-image')).toHaveCount(chipCount);
  await expect.poll(() => chips.locator('img').evaluateAll(images => images.filter(image => image.complete && image.naturalWidth > 0).length)).toBe(chipCount);
  expect(await chips.locator('img').evaluateAll(images => images.every(image => new URL(image.src).origin === location.origin))).toBe(true);
  const shelf = page.getByTestId('category-mosaic-shelf');
  const first = shelf.getByTestId('category-mosaic').first();
  await expect(first).toBeVisible();
  expect((await first.boundingBox())!.width).toBe(330);
  await expect(first.getByRole('link')).toHaveCount(4);
  await first.getByRole('link', { name: 'Dresses', exact: true }).click();
  await expect(page).toHaveURL(/\/categories\/dresses$/);
});

test('category chips retain a visible fallback and navigation when an image fails', async ({ page }) => {
  await page.route('**/automotive.jpg*', route => route.abort());
  await page.goto('/');
  const automotive = page.getByTestId('category-pills').getByRole('link', { name: 'Automotive', exact: true });
  await expect(automotive.getByTestId('category-pill-image-fallback')).toBeVisible();
  await automotive.click();
  await expect(page).toHaveURL(/\/categories\/brake-pad-automotive$/);
});

test('category arrows overlay the track, scroll both ways and disappear on mobile', async ({ page }) => {
  await page.goto('/');
  const carousel = page.getByTestId('home-category-carousel');
  await carousel.scrollIntoViewIfNeeded();
  const track = carousel.locator('[data-bloom-carousel-track]');
  const frame = page.getByTestId('home-category-carousel-track-frame');
  const next = carousel.getByRole('button', { name: 'Go to the next item', exact: true });
  const previous = carousel.getByRole('button', { name: 'Go to the previous item', exact: true });
  await expect(next).toBeEnabled();
  const frameBox = (await frame.boundingBox())!;
  const arrowBox = (await next.boundingBox())!;
  expect(Math.abs(arrowBox.y + arrowBox.height / 2 - frameBox.y - frameBox.height / 2)).toBeLessThan(2);
  await next.click();
  await expect.poll(() => track.evaluate(element => element.scrollLeft)).toBeGreaterThan(300);
  await expect(previous).toBeEnabled();
  await previous.click();
  await expect.poll(() => track.evaluate(element => element.scrollLeft)).toBeLessThan(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('home-category-carousel-overlay-arrows')).toHaveCount(0);
  await expect(carousel.getByTestId('category-mosaic').first()).toBeVisible();
});

test('local shopping history never exposes a different account conversation to a guest', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('mercaria.shopping-history', JSON.stringify({ version: 0, state: { products: [], threads: [{ id: 'private-thread', owner: 'another-oxy-account', title: 'Private shopping question', updatedAt: new Date().toISOString(), preview: true, messages: [{ role: 'user', content: 'Private shopping question' }] }] } }));
  });
  await page.goto('/');
  await expect(page.getByTestId('home-hero')).toBeVisible();
  await expect(page.getByTestId('thread-shelf')).toHaveCount(0);
  await page.goto('/thread?conversationId=private-thread');
  await expect(page.getByTestId('shopping-thread')).toBeVisible();
  await expect(page.getByText('Private shopping question')).toHaveCount(0);
});

test('store offer headers show fixed savings with their qualifying subtotal and navigate to the store', async ({ page }) => {
  await page.route('**/discovery/feed?*', async route => {
    const response = await route.fetch();
    if (new URL(route.request().url()).searchParams.get('scope') !== 'deals') {
      await route.fulfill({ response });
      return;
    }
    const body = await response.json();
    const section = body.data.sections.find((item: { kind: string }) => item.kind === 'store-offer');
    expect(section).toBeTruthy();
    section.discount = {
      id: 'visual-fixed-offer', amountOff: { amount: 1500, currency: 'USD' },
      minimumSubtotal: { amount: 7500, currency: 'USD' }, exclusive: false,
    };
    body.data.sections = [section];
    await route.fulfill({ response, json: body });
  });
  await page.goto('/deals');
  const header = page.getByTestId('store-offer-header');
  await expect(header).toContainText('$15.00');
  await expect(header).toContainText('on orders of');
  await expect(header).toContainText('$75.00');
  await expect(header).not.toContainText('% off');
  await expect(header.getByText('Visit store', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Go to the next item', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await expect(page.getByRole('button', { name: 'Go to the next item', exact: true })).toHaveCount(0);
  await header.click();
  await expect(page).toHaveURL(/\/stores\/[^/]+$/);
});

for (const rate of [20, 20.25]) {
test(`percentage offer headers preserve a ${rate}% rate and its qualifying subtotal`, async ({ page }) => {
  await page.route('**/discovery/feed?*', async route => {
    const response = await route.fetch();
    if (new URL(route.request().url()).searchParams.get('scope') !== 'deals') {
      await route.fulfill({ response });
      return;
    }
    const body = await response.json();
    const section = body.data.sections.find((item: { kind: string }) => item.kind === 'store-offer');
    expect(section).toBeTruthy();
    section.discount = {
      id: 'visual-percent-offer', percentOff: rate,
      minimumSubtotal: { amount: 5000, currency: 'USD' }, exclusive: true,
    };
    body.data.sections = [section];
    await route.fulfill({ response, json: body });
  });
  await page.goto('/deals');
  const header = page.getByTestId('store-offer-header');
  await expect(header).toContainText(`${rate}%`);
  await expect(header).toContainText('off');
  await expect(header).toContainText('$50.00');
  await expect(header).toContainText('on orders of');
});
}
