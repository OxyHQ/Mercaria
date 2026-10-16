/**
 * The browser-origin allow-list in production (M8-05).
 *
 * `ALLOWED_ORIGINS` is BOTH the credentialed CORS allow-list and the guest CSRF
 * gate's Origin check (ADR 0003 D10). The M8 review found the eleven
 * development origins included unconditionally, so `http://localhost:5173`
 * could make credentialed requests to the live API and pass the CSRF gate,
 * with only `SameSite=Lax` standing between it and a guest's cookie — the
 * defence-in-depth layer carrying the load the control was meant to.
 *
 * The list is computed at module load from the environment, so each case
 * re-imports it under the `NODE_ENV` it is about.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadUnder(nodeEnv: string, webUrl?: string) {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', nodeEnv);
  vi.stubEnv('WEB_URL', webUrl ?? '');
  return import('../allowed-origins.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('ALLOWED_ORIGINS (M8-05, ADR 0003 D10)', () => {
  it('excludes every development origin in production', async () => {
    const origins = await loadUnder('production');
    expect(origins.DEV_ORIGINS.length).toBeGreaterThanOrEqual(10);
    for (const origin of origins.DEV_ORIGINS) {
      expect(origins.ALLOWED_ORIGINS, origin).not.toContain(origin);
      expect(origins.isAllowedBrowserOrigin(origin), origin).toBe(false);
    }
    // Positive control: production origins are still admitted.
    expect(origins.isAllowedBrowserOrigin('https://mercaria.co')).toBe(true);
    expect(origins.isAllowedBrowserOrigin('https://dashboard.mercaria.co')).toBe(true);
    expect(origins.isAllowedBrowserOrigin('https://pos.mercaria.co')).toBe(true);
  });

  it('admits them outside production, where local apps need them', async () => {
    const origins = await loadUnder('development');
    expect(origins.isAllowedBrowserOrigin('http://localhost:8160')).toBe(true);
  });

  it('a production deployment that needs one more origin names it in WEB_URL', async () => {
    const origins = await loadUnder('production', 'https://staging.example.test');
    expect(origins.isAllowedBrowserOrigin('https://staging.example.test')).toBe(true);
    expect(origins.isAllowedBrowserOrigin('http://localhost:5173')).toBe(false);
  });
});
