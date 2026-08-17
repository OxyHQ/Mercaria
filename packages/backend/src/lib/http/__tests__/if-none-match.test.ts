/**
 * `If-None-Match` comparison, tested where it is now OWNED.
 *
 * These cases used to exist twice — once in
 * `services/catalog-authoring/__tests__/authoring-etag.test.ts` and once in
 * `services/navigation/__tests__/navigation-projection.test.ts` — because the
 * function did. Both copies are gone with the function, and the cases are here
 * rather than duplicated a third time for `/taxonomy`.
 *
 * The tags below are OPAQUE literals rather than real composed ETags. That is
 * the point of moving: the comparison is HTTP syntax and knows nothing about a
 * schema, a menu or a taxonomy, so a test of it that had to compose one would be
 * asserting a dependency the module does not have.
 */

import { describe, expect, it } from 'vitest';
import { ifNoneMatchMatches } from '../if-none-match.js';

const TAG = '"authschema-0123456789abcdef0123456789abcdef"';
const OTHER = '"nav-fedcba9876543210fedcba9876543210"';

describe('ifNoneMatchMatches', () => {
  it('matches an exact echo', () => {
    expect(ifNoneMatchMatches(TAG, TAG)).toBe(true);
  });

  it('matches inside a list, in either position', () => {
    expect(ifNoneMatchMatches(`${OTHER}, ${TAG}`, TAG)).toBe(true);
    expect(ifNoneMatchMatches(`${TAG}, ${OTHER}`, TAG)).toBe(true);
  });

  it('matches a weakly-prefixed echo of a strong tag', () => {
    // The case with a real consequence: a client that received a strong tag and
    // echoes it weakly still holds this exact content, and answering 200 resends
    // the whole payload on every revalidation — a cache that has stopped working
    // while reporting success.
    expect(ifNoneMatchMatches(`W/${TAG}`, TAG)).toBe(true);
  });

  it('matches a weak candidate against a weak tag', () => {
    expect(ifNoneMatchMatches(`W/${TAG}`, `W/${TAG}`)).toBe(true);
  });

  it('matches `*`, including inside a list', () => {
    expect(ifNoneMatchMatches('*', TAG)).toBe(true);
    expect(ifNoneMatchMatches(`${OTHER}, *`, TAG)).toBe(true);
  });

  it('does not match an absent header', () => {
    // A request with no validator is asking for the content. Answering 304 to it
    // would send an empty body to a client holding nothing.
    expect(ifNoneMatchMatches(undefined, TAG)).toBe(false);
  });

  it('does not match a different tag, an empty header or a prefix of the tag', () => {
    expect(ifNoneMatchMatches(OTHER, TAG)).toBe(false);
    expect(ifNoneMatchMatches('', TAG)).toBe(false);
    expect(ifNoneMatchMatches(TAG.slice(0, -4) + '"', TAG)).toBe(false);
  });

  it('is not fooled by surrounding whitespace, which a real proxy adds', () => {
    expect(ifNoneMatchMatches(`  ${OTHER} ,  ${TAG}  `, TAG)).toBe(true);
  });

  it('exports the comparison and nothing else', async () => {
    // The module is HTTP syntax. A digest, a key type or a prefix appearing here
    // would mean a domain fact had migrated into it — which is the thing that
    // made two copies defensible in the first place.
    const module = await import('../if-none-match.js');
    expect(Object.keys(module).sort()).toEqual(['ifNoneMatchMatches']);
  });
});
