import { describe, expect, it } from 'vitest';
import { createStorefrontGoWayClient, goWayPlaceUrl } from '../goway-client';

describe('goWayPlaceUrl', () => {
  it('links to the place page on the canonical GoWay origin', () => {
    expect(goWayPlaceUrl('plc_123')).toBe('https://goway.to/place/plc_123');
  });

  it('encodes the opaque id rather than trusting it to be path-safe', () => {
    // An id is GoWay's and never parsed here; one carrying a slash or a query
    // character must not reach a different page.
    expect(goWayPlaceUrl('a/b?c#d')).toBe('https://goway.to/place/a%2Fb%3Fc%23d');
  });

  it('builds against another origin when one is configured', () => {
    const staging = createStorefrontGoWayClient({ webBaseUrl: 'https://staging.goway.to' });
    expect(staging.links.place('x')).toBe('https://staging.goway.to/place/x');
  });
});
