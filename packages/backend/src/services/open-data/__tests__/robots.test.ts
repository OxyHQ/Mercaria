import { describe, expect, it } from 'vitest';
import { robotsAllows } from '../robots.js';

const SHOPIFY = [
  'User-agent: *',
  'Disallow: /admin',
  'Disallow: /cart',
  'Disallow: /collections/*sort_by*',
  'Disallow: /*?*oseid=*',
  'Allow: /collections/checkout',
  '',
  'User-agent: AhrefsBot',
  'Disallow: /',
].join('\n');

describe('robotsAllows (RFC 9309)', () => {
  it('allows everything without a robots file, or without a matching group', () => {
    expect(robotsAllows(null, 'Mercaria', '/anything')).toBe(true);
    expect(robotsAllows('User-agent: Googlebot\nDisallow: /', 'Mercaria', '/products.json')).toBe(
      true,
    );
  });

  it('applies the * group, with prefixes and wildcards', () => {
    expect(robotsAllows(SHOPIFY, 'Mercaria', '/products.json')).toBe(true);
    expect(robotsAllows(SHOPIFY, 'Mercaria', '/meta.json')).toBe(true);
    expect(robotsAllows(SHOPIFY, 'Mercaria', '/cart.js')).toBe(false);
    expect(robotsAllows(SHOPIFY, 'Mercaria', '/collections/all?sort_by=price')).toBe(false);
    expect(robotsAllows(SHOPIFY, 'Mercaria', '/x?a=1&oseid=2')).toBe(false);
  });

  it('prefers the group naming the crawler, and the longest rule, with allow winning a tie', () => {
    expect(robotsAllows(SHOPIFY, 'AhrefsBot', '/products.json')).toBe(false);
    expect(
      robotsAllows(
        'User-agent: *\nDisallow: /collections\nAllow: /collections/checkout',
        'Mercaria',
        '/collections/checkout',
      ),
    ).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /a\nAllow: /a', 'Mercaria', '/a')).toBe(true);
  });

  it('honours the $ anchor and ignores comments and an empty disallow', () => {
    expect(robotsAllows('User-agent: *\nDisallow: /*.json$', 'Mercaria', '/products.json')).toBe(
      false,
    );
    expect(
      robotsAllows('User-agent: *\nDisallow: /*.json$', 'Mercaria', '/products.json?page=2'),
    ).toBe(true);
    expect(robotsAllows('User-agent: * # everyone\nDisallow:', 'Mercaria', '/anything')).toBe(true);
  });
});
