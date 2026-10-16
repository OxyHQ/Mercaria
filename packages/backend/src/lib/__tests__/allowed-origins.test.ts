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
 * The list is `allowedOriginsFor(process.env)`, computed once at module load,
 * so each case asks `allowedOriginsFor` about the environment it is about
 * rather than re-importing the module under a stubbed one — a module-registry
 * reset that `bun test` (scripts/test-bun.ts) does not implement.
 */

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ORIGINS,
  allowedOriginsFor,
  DEV_ORIGINS,
  isAllowedBrowserOrigin,
} from '../allowed-origins.js';

describe('ALLOWED_ORIGINS (M8-05, ADR 0003 D10)', () => {
  it('excludes every development origin in production', () => {
    const origins = allowedOriginsFor({ NODE_ENV: 'production' });
    expect(DEV_ORIGINS.length).toBeGreaterThanOrEqual(10);
    for (const origin of DEV_ORIGINS) {
      expect(origins, origin).not.toContain(origin);
    }
    // Positive control: production origins are still admitted.
    expect(origins).toContain('https://mercaria.co');
    expect(origins).toContain('https://dashboard.mercaria.co');
    expect(origins).toContain('https://pos.mercaria.co');
  });

  it('admits them outside production, where local apps need them', () => {
    const origins = allowedOriginsFor({ NODE_ENV: 'development' });
    for (const origin of DEV_ORIGINS) {
      expect(origins, origin).toContain(origin);
    }
  });

  it('a production deployment that needs one more origin names it in WEB_URL', () => {
    const origins = allowedOriginsFor({
      NODE_ENV: 'production',
      WEB_URL: 'https://staging.example.test',
    });
    expect(origins).toContain('https://staging.example.test');
    expect(origins).not.toContain('http://localhost:5173');
  });

  it('is frozen, so no consumer can widen CORS and CSRF at once', () => {
    expect(Object.isFrozen(allowedOriginsFor({ NODE_ENV: 'production' }))).toBe(true);
  });

  it('the exported list and the shared predicate are this process’s environment applied', () => {
    expect(ALLOWED_ORIGINS).toEqual(
      allowedOriginsFor({ NODE_ENV: process.env.NODE_ENV, WEB_URL: process.env.WEB_URL }),
    );
    for (const origin of [...DEV_ORIGINS, 'https://mercaria.co', 'https://evil.example']) {
      expect(isAllowedBrowserOrigin(origin), origin).toBe(ALLOWED_ORIGINS.includes(origin));
    }
    expect(isAllowedBrowserOrigin(undefined)).toBe(false);
  });
});
