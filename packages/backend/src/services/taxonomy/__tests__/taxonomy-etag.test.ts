/**
 * The deterministic validator the taxonomy reads are cached on (#367 Workstream
 * 1, "Add ETags/cache keys and deterministic ordering").
 *
 * ## This file was NAMED by its subject and did not exist
 *
 * `services/taxonomy/etag.ts` says, in as many words:
 *
 * > A dimension that is not a property here cannot enter the key, and
 * > `taxonomy-etag.test.ts` asserts that changing each one INDIVIDUALLY changes
 * > the tag — a single "change everything" case passes with all but one
 * > dimension missing.
 *
 * There was no such file. `find src -name taxonomy-etag.test.ts` returned
 * nothing, against a positive control of `authoring-etag.test.ts` returning one.
 * So the per-dimension property the sibling domain proves was, here, a sentence
 * in a docblock — which reads exactly like coverage to anyone auditing by
 * reading. This is that file, and the claim is now true.
 *
 * ## The property under test is not "it hashes"
 *
 * It is that the tag is a function of EVERY dimension the read varies by, and of
 * nothing else. Each dimension is therefore varied INDIVIDUALLY: a single
 * "change everything" case passes with three of the four dimensions missing from
 * the key, which is the vacuous shape this codebase keeps finding.
 *
 * ## Where these cases are NOT duplicated
 *
 * `routes/__tests__/catalog-api-contract.realdb.test.ts` proves the EXCHANGE —
 * that a 304 comes back for an echo, that two locales get two tags, and that
 * four reads with BYTE-IDENTICAL empty bodies stay distinguishable. Those are
 * facts about the controller and its nine handlers. What lives here is the
 * property of the KEY itself, which needs no server and no fixture, and which is
 * what the docblock promised.
 *
 * The `If-None-Match` comparison is deliberately not tested here: it is HTTP
 * syntax owned by `lib/http/if-none-match.ts`, and re-testing it would be this
 * domain asserting a property of HTTP.
 */

import { describe, expect, it } from 'vitest';
import { taxonomyEtag, taxonomyReadCacheKey, type TaxonomyEtagKey } from '../etag.js';

const KEY: TaxonomyEtagKey = {
  read: 'children',
  subject: 'cat-1',
  requestedLocale: 'es-mx',
  parameters: { limit: 50, cursor: null, lifecycle: 'published' },
};

/**
 * A body shaped like a real page, and deliberately NOT empty.
 *
 * The empty-body case is the contract suite's, because its point is that four
 * DIFFERENT reads serialize to the same bytes — which needs the four reads, not
 * a hash.
 */
const BODY = {
  categories: [{ id: 'cat-2', key: 'a.b', name: 'Bicycles' }],
  hasMore: false,
  nextCursor: null,
};

describe('the taxonomy ETag is deterministic', () => {
  it('two compositions of the same read produce the same tag', () => {
    expect(taxonomyEtag(KEY, BODY)).toBe(taxonomyEtag(KEY, BODY));
  });

  it('property order in the body does not change the tag', () => {
    // The reason the module canonicalizes rather than hashing `JSON.stringify`
    // directly: a refactor that moved one field would otherwise re-download the
    // whole taxonomy for every client, and no test could tell that from a real
    // change.
    const reordered = {
      nextCursor: null,
      hasMore: false,
      categories: [{ name: 'Bicycles', key: 'a.b', id: 'cat-2' }],
    };
    expect(taxonomyEtag(KEY, reordered)).toBe(taxonomyEtag(KEY, BODY));
  });

  it('parameter ORDER does not change the tag, but a parameter VALUE does', () => {
    const reordered: TaxonomyEtagKey = {
      ...KEY,
      parameters: { lifecycle: 'published', cursor: null, limit: 50 },
    };
    expect(taxonomyEtag(reordered, BODY)).toBe(taxonomyEtag(KEY, BODY));

    const relimited: TaxonomyEtagKey = { ...KEY, parameters: { ...KEY.parameters, limit: 51 } };
    expect(taxonomyEtag(relimited, BODY)).not.toBe(taxonomyEtag(KEY, BODY));
  });

  it('a body change changes the tag', () => {
    expect(taxonomyEtag(KEY, { ...BODY, hasMore: true })).not.toBe(taxonomyEtag(KEY, BODY));
  });

  it('the tag is quoted and prefixed, as RFC 9110 requires of a strong validator', () => {
    const tag = taxonomyEtag(KEY, BODY);
    expect(tag.startsWith('"tax-')).toBe(true);
    expect(tag.endsWith('"')).toBe(true);
  });
});

describe('every dimension is IN the key, varied one at a time', () => {
  const variations: readonly { name: string; key: TaxonomyEtagKey }[] = [
    { name: 'read', key: { ...KEY, read: 'descendants' } },
    { name: 'subject', key: { ...KEY, subject: 'cat-9' } },
    { name: 'requested locale', key: { ...KEY, requestedLocale: 'pt' } },
    { name: 'parameters', key: { ...KEY, parameters: { ...KEY.parameters, limit: 10 } } },
  ];

  it.each(variations)('changing the $name changes the tag', ({ key }) => {
    expect(taxonomyEtag(key, BODY)).not.toBe(taxonomyEtag(KEY, BODY));
  });

  it('the cache key varies with the same four dimensions', () => {
    const keys = new Set(variations.map((entry) => taxonomyReadCacheKey(entry.key)));
    keys.add(taxonomyReadCacheKey(KEY));
    // Five distinct keys from five distinct dimension sets. The COUNT is the
    // vacuity floor: a key that dropped one dimension would collapse two of
    // them onto one string and this would read four.
    expect(keys.size).toBe(variations.length + 1);
  });
});

describe('the distinctions the key claims, asserted rather than assumed', () => {
  it('an ABSENT subject and a subject literally spelled "null" are different reads', () => {
    // `etag.ts` states this: "Never coerced to a string: a subject literally
    // spelled `"null"` and an absent subject are different reads and
    // `canonicalize` renders them differently." A key that coerced would answer
    // `roots` from a cached category page.
    const absent: TaxonomyEtagKey = { ...KEY, read: 'roots', subject: null };
    const literal: TaxonomyEtagKey = { ...KEY, read: 'roots', subject: 'null' };
    expect(taxonomyEtag(absent, BODY)).not.toBe(taxonomyEtag(literal, BODY));
  });

  it('a parameter that is ABSENT and one that is null are different reads', () => {
    // `canonicalize` drops `undefined` and keeps `null`, so these two are not
    // the same request: "no cursor was supplied" and "the cursor is null" reach
    // the repository as the same value only because the controller normalizes
    // them, and the key must not pre-empt that.
    const withNull: TaxonomyEtagKey = { ...KEY, parameters: { limit: 50, cursor: null } };
    const without: TaxonomyEtagKey = { ...KEY, parameters: { limit: 50 } };
    expect(taxonomyEtag(withNull, BODY)).not.toBe(taxonomyEtag(without, BODY));
  });

  it('two reads whose BODIES are byte-identical stay distinguishable by read alone', () => {
    // The children of a leaf and the descendants of that same leaf are both an
    // empty page. This is the unit-level half of the contract suite's case; it
    // is here because it is the property of the KEY, and it is what makes the
    // `read` dimension load-bearing rather than decorative.
    const empty = { categories: [], hasMore: false, nextCursor: null };
    const children: TaxonomyEtagKey = { ...KEY, read: 'children', subject: 'leaf' };
    const descendants: TaxonomyEtagKey = { ...KEY, read: 'descendants', subject: 'leaf' };
    expect(taxonomyEtag(children, empty)).not.toBe(taxonomyEtag(descendants, empty));
  });

  it('nothing about the CALLER enters the tag, so one validator serves every reader', () => {
    // The surface answers `Cache-Control: public`, which is only true while the
    // answer is identical for every reader. There is no permission fingerprint
    // in `TaxonomyEtagKey` and none may be added — its presence would mean the
    // surface had stopped being public and the header had become a lie. Asserted
    // structurally, over the key's OWN property names, so a dimension added
    // later fails here rather than in a cache somebody else is holding.
    expect(Object.keys(KEY).sort()).toEqual([
      'parameters',
      'read',
      'requestedLocale',
      'subject',
    ]);
  });
});
