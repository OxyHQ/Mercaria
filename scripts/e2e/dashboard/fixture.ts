import type { Page } from '@playwright/test';

/** All identity/admin replies are browser fixtures. No real credentials, writes or auth bypass. */
export async function fixture(page: Page, locale: string, mode: string) {
  const user = { id: 'merchant-preview', username: 'merchant', name: { first: 'Merchant', last: 'Preview' }, email: 'merchant@example.test' };
  const token = ['eyJhbGciOiJub25lIn0', Buffer.from(JSON.stringify({ sub: user.id, userId: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'fixture'].join('.');
  const state = { deviceId: 'preview-device', revision: 1, activeAccountId: user.id, updatedAt: Date.now(), accounts: [{ accountId: user.id, sessionId: 'preview-session', authuser: 0 }] };
  await page.addInitScript(({ token, locale, mode }) => {
    localStorage.setItem('mercaria.dashboard.bloom.theme', JSON.stringify({ mode, colorPreset: 'mono' }));
    localStorage.setItem('oxy.auth.v1', JSON.stringify({ sessionId: 'preview-session', userId: 'merchant-preview', deviceId: 'preview-device', deviceSecret: 'preview-fixture', accessToken: token, expiresAt: new Date(Date.now() + 3600000).toISOString() }));
    localStorage.setItem('mercaria.dashboard.active-store', JSON.stringify({ state: { activeStoreId: 'store-preview' }, version: 0 }));
    localStorage.setItem('mercaria-dashboard-i18n', JSON.stringify({ state: { locale }, version: 0 }));
  }, { token, locale, mode });
  await page.route('https://api.oxy.so/**', async route => {
    const url = new URL(route.request().url());
    let json: unknown = user;
    if (url.pathname.includes('/auth/oauth/client/')) json = { application: { id: 'app-preview', name: 'Mercaria Dashboard', type: 'first_party', isOfficial: true, isInternal: false, scopes: [] } };
    else if (url.pathname.includes('/session/device')) json = { state, activeToken: null };
    await route.fulfill({ json });
  });
  const requests: URL[] = [];
  const statuses = { pending_payment: 1, paid: 4, processing: 2, shipped: 1, delivered: 7, digitally_delivered: 1, cancelled: 0, refunded: 0, partially_refunded: 0 };
  const permissions = ['stats:read', 'products:read', 'products:write', 'orders:read', 'customers:read', 'discounts:write', 'collections:write', 'channels:write', 'settings:write'];
  const store = { id: 'store-preview', name: 'Demo Atelier', handle: 'demo-atelier', brandColor: '#303030', defaultCurrency: 'EUR', productCount: 12, access: { permissions } };
  await page.route('http://localhost:4160/**', async route => {
    const url = new URL(route.request().url()); requests.push(url);
    let data: unknown = null;
    if (url.pathname === '/admin/stores') data = [store, { ...store, id: 'second-store', name: 'Second Atelier', handle: 'second-atelier' }];
    else if (url.pathname.endsWith('/reports/summary')) data = { revenue: { amount: 123450, currency: 'EUR' }, averageOrderValue: { amount: 8230, currency: 'EUR' }, refundTotal: { amount: 5000, currency: 'EUR' }, paidOrderCount: 15, orderCount: 16, byStatus: statuses, bySourceChannel: { storefront: 15, pos: 0, draft: 0 } };
    else if (url.pathname.endsWith('/reports/sales')) {
      const start = Date.parse(url.searchParams.get('from')!);
      data = [0, 2, 4].map((offset, i) => ({ bucket: new Date(start + offset * 86400000).toISOString(), orders: i + 1, revenue: { amount: 1000 * (i + 1), currency: 'EUR' } }));
    } else if (url.pathname.endsWith('/reports/top-products')) data = [{ listingId: 'best-product', title: 'Linen studio shirt', unitsSold: 7, revenue: { amount: 7000, currency: 'EUR' } }];
    else if (url.pathname.endsWith('/orders/stats')) data = { counts: statuses, revenue: { amount: 123450, currency: 'EUR' }, lowStockVariantCount: 2 };
    else if (url.pathname === '/me/currency-preference') data = { preferredCurrency: 'EUR', secondaryCurrency: 'EUR', dualDisplayEnabled: false };
    else if (url.pathname === '/rates') data = { base: 'FAIR', rates: { EUR: 1, USD: 1 }, asOf: new Date().toISOString() };
    else if (url.pathname.endsWith('/orders')) return route.fulfill({ json: { success: true, data: [], pagination: { total: 0, page: 1, limit: 20, pages: 0 } } });
    else return route.fulfill({ status: 404, json: { success: false, message: 'Fixture not found' } });
    await route.fulfill({ json: { success: true, data } });
  });
  return requests;
}
