import { expect, test } from '@playwright/test';
import type { OrderSummary } from '@mercaria/shared-types';

for (const width of [390, 1440]) {
  test(`buyer history tabs preserve server pagination and deep links at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const userId = 'oxy-orders-browser-fixture';
    const token = ['e30', Buffer.from(JSON.stringify({ sub: userId, userId,
      exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'test-only'].join('.');
    await page.addInitScript(({ userId, token }) => {
      localStorage.setItem('i18n-storage', JSON.stringify({ state: { locale: 'en' }, version: 0 }));
      localStorage.setItem('mercaria.bloom.theme', JSON.stringify({ mode: 'light', colorPreset: 'mono' }));
      localStorage.setItem('oxy.auth.v1', JSON.stringify({ userId, sessionId: 'fixture-session',
        accessToken: token, expiresAt: new Date(Date.now() + 3600000).toISOString() }));
    }, { userId, token });
    await page.route('https://order-images.example.invalid/**', route => {
      if (route.request().url().endsWith('/missing.svg')) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#d0a88f"/></svg>' });
    });
    // Exercise the actual Oxy provider and query hooks with HTTP fixtures. No
    // synthetic credential leaves the browser; persistence/ownership is realdb-tested.
    await page.route('https://api.oxy.so/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/auth/oauth/client/')) return route.fulfill({ json: { application: {
        id: 'fixture', name: 'Mercaria fixture', type: 'first_party', isOfficial: true, isInternal: false, scopes: [],
      } } });
      if (path === '/users/me') return route.fulfill({ json: { id: userId, username: 'order-fixture',
        name: { displayName: 'Order fixture' }, email: 'order@example.invalid' } });
      return route.fulfill({ status: 404, json: { error: 'Unused fixture endpoint' } });
    });
    let releasePast: (() => void) | undefined;
    let holdPast = true;
    const requests: { view: string | null; page: number }[] = [];
    await page.route('http://localhost:4160/**', async route => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.pathname === '/orders') {
        const view = url.searchParams.get('view');
        const currentPage = Number(url.searchParams.get('page') ?? 1);
        requests.push({ view, page: currentPage });
        if (view === 'past' && holdPast) await new Promise<void>(resolve => { releasePast = resolve; });
        const order: OrderSummary = {
          id: `order-${view}-${currentPage}`, orderNumber: `MRC-${view}-${currentPage}`,
          status: view === 'past' ? 'delivered' : 'processing',
          grandTotal: { shop: { amount: 2400, currency: 'EUR' }, presentment: { amount: 2400, currency: 'EUR' } },
          itemCount: 1, sellerType: 'user', createdAt: new Date().toISOString(),
          images: view === 'past' ? undefined : ['missing', 'first', 'second', 'third'].map(name => ({
            url: `https://order-images.example.invalid/${name}.svg`, alt: `Purchased ${name}`,
          })),
          commercial: { mode: 'connected_marketplace', sellerKind: 'user', sellerLabel: 'Fixture seller',
            sellerRole: 'direct', disclosures: ['sold_by_merchant'] },
        };
        return route.fulfill({ json: { success: true, data: [order], pagination: {
          page: currentPage, limit: 1, total: view === 'past' ? 1 : 2, pages: view === 'past' ? 1 : 2,
          hasNextPage: view !== 'past' && currentPage === 1, hasPreviousPage: currentPage > 1,
        } } });
      }
      if (url.pathname === '/reviews/eligibilities') return route.fulfill({ json: { success: true, data: [] } });
      if (req.method() !== 'GET') return route.fulfill({ status: 403, json: { success: false } });
      const headers = req.headers();
      delete headers.authorization;
      return route.continue({ headers });
    });
    await page.goto('/orders');
    const orders = page.getByTestId('shopping-orders');
    const active = orders.getByRole('link', { name: 'Active', exact: true });
    const past = orders.getByRole('link', { name: 'Past', exact: true });
    await expect(active).toHaveAttribute('aria-current', 'page');
    await expect(orders.getByRole('link', { name: 'Open order MRC-active-1', exact: true })).toBeVisible();
    await expect(orders.getByRole('link', { name: 'Open order MRC-active-1', exact: true })).toHaveAttribute('href', '/orders/order-active-1');
    const images = orders.getByTestId('order-card-images');
    await expect(images.getByRole('img')).toHaveCount(2);
    await expect(images.getByRole('img', { name: 'Purchased first' })).toBeVisible();
    await expect(images.getByRole('img', { name: 'Purchased second' })).toBeVisible();
    await expect.poll(() => images.locator('img').evaluateAll(nodes => nodes.every(node => node.complete && node.naturalWidth > 0))).toBe(true);
    await expect(images.getByText(/^\+/)).toHaveText('+\u20681\u2069');
    expect(Math.round((await images.getByRole('img').first().boundingBox())!.width)).toBe(30);
    await orders.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(orders.getByRole('link', { name: 'Open order MRC-active-2', exact: true })).toBeVisible();
    await expect(orders.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
    await past.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/orders\/past$/);
    await expect(past).toHaveAttribute('aria-current', 'page');
    await expect.poll(() => Boolean(releasePast)).toBe(true);
    await expect(orders.getByRole('link', { name: 'Open order MRC-active-2', exact: true })).toHaveCount(0);
    holdPast = false;
    releasePast!();
    await expect(orders.getByRole('link', { name: 'Open order MRC-past-1', exact: true })).toBeVisible();
    await expect(images).toHaveCount(0);
    await expect(orders.getByRole('button', { name: 'Next', exact: true })).toHaveCount(0);
    await page.reload();
    await expect(past).toHaveAttribute('aria-current', 'page');
    await expect(orders.getByRole('link', { name: 'Open order MRC-past-1', exact: true })).toBeVisible();
    await active.click();
    await expect(page).toHaveURL(/\/orders$/);
    await expect(orders.getByRole('link', { name: 'Open order MRC-active-1', exact: true })).toBeVisible();
    expect(requests).toContainEqual({ view: 'active', page: 2 });
    expect(requests.filter(request => request.view === 'past').every(request => request.page === 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await expect.poll(() => orders.evaluate(element => {
      for (let node: Element | null = element; node; node = node.parentElement) {
        if (Number(getComputedStyle(node).opacity) < 1) return false;
      }
      return true;
    })).toBe(true);
    if (width < 976) await expect(page.getByTestId('storefront-bottom-bar')).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: `/tmp/mercaria-order-views-${width}.png` });
  });
}
