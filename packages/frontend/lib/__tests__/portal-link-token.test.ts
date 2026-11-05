import { describe, expect, it } from 'vitest';
import { takeExchangeTokenFromUrl, type UrlCarrier } from '../portal-link-token';

const TOKEN = `mgx_${'A'.repeat(43)}`;

/** A browser URL, and every `replaceState` the helper made against it. */
function carrier(url: string): UrlCarrier & { replaced: string[] } {
  const parsed = new URL(url);
  const replaced: string[] = [];
  return {
    replaced,
    location: { hash: parsed.hash, pathname: parsed.pathname, search: parsed.search },
    history: {
      state: null,
      replaceState: (_state: unknown, _unused: string, next?: string | URL | null) => {
        replaced.push(String(next));
      },
    },
  };
}

describe('the portal takes an exchange token out of the URL (ADR 0003 T4, M8-11)', () => {
  it('reads the fragment and strips it', () => {
    const url = carrier(`https://mercaria.co/guest-orders/portal?group=g1#${TOKEN}`);
    expect(takeExchangeTokenFromUrl(url)).toBe(TOKEN);
    expect(url.replaced).toEqual(['/guest-orders/portal?group=g1']);
  });

  it('reads a ?token= query parameter AND strips it — the shape M8-11 found left in place', () => {
    const url = carrier(`https://mercaria.co/guest-orders/portal?token=${TOKEN}&group=g1`);
    expect(takeExchangeTokenFromUrl(url)).toBe(TOKEN);
    expect(url.replaced).toEqual(['/guest-orders/portal?group=g1']);
    expect(url.replaced.join('')).not.toContain('mgx_');
  });

  it('strips a query token even when it is not an exchange token, and returns nothing', () => {
    const url = carrier('https://mercaria.co/guest-orders/portal?token=mgp_secret');
    expect(takeExchangeTokenFromUrl(url)).toBeNull();
    expect(url.replaced).toEqual(['/guest-orders/portal']);
  });

  it('prefers the fragment and strips BOTH copies when both are present', () => {
    const url = carrier(`https://mercaria.co/guest-orders/portal?token=mgx_other#${TOKEN}`);
    expect(takeExchangeTokenFromUrl(url)).toBe(TOKEN);
    expect(url.replaced).toEqual(['/guest-orders/portal']);
  });

  it('touches nothing when the URL carries no token', () => {
    const url = carrier('https://mercaria.co/guest-orders/portal?group=g1#section');
    expect(takeExchangeTokenFromUrl(url)).toBeNull();
    expect(url.replaced).toEqual([]);
  });
});
