/**
 * The deterministic validator, and the axis signature (#367 step 5, ADR 0007
 * D10/D6).
 *
 * The property under test is not "it hashes". It is that the tag is a function
 * of EVERY semantic dimension and of nothing else — so a `304` is safe across a
 * fleet, and a dimension somebody forgets to include fails HERE rather than as a
 * merchant seeing another market's form.
 *
 * Each dimension is varied INDIVIDUALLY. A single "change everything" case would
 * pass with five of the six dimensions missing from the key, which is exactly
 * the vacuous shape this codebase keeps finding.
 */

import { describe, expect, it } from 'vitest';
import {
  authoringEtag,
  authoringEtagMatches,
  authoringSchemaCacheKey,
  type AuthoringSchemaKey,
} from '../etag.js';
import {
  defaultTypedVariantSignature,
  typedVariantSignature,
} from '../../variant-axes/signature.js';

const KEY: AuthoringSchemaKey = {
  productTypeDefinitionId: 'ptd-1',
  categoryId: 'cat-1',
  flow: 'merchant',
  locale: 'es-mx',
  market: 'ES',
  permissionFingerprint: '1110',
  revisions: ['category:cat-1=3', 'attribute_values:attr-1=7'],
};

const BODY = { fields: [{ id: 'f1', key: 'color' }], groups: [] };

describe('the authoring ETag is deterministic', () => {
  it('two compositions of the same schema produce the same tag', () => {
    expect(authoringEtag(KEY, BODY)).toBe(authoringEtag(KEY, BODY));
  });

  it('property order in the body does not change the tag', () => {
    const reordered = { groups: [], fields: [{ key: 'color', id: 'f1' }] };
    expect(authoringEtag(KEY, reordered)).toBe(authoringEtag(KEY, BODY));
  });

  it('revision ORDER does not change the tag, but a revision VALUE does', () => {
    const shuffled: AuthoringSchemaKey = {
      ...KEY,
      revisions: ['attribute_values:attr-1=7', 'category:cat-1=3'],
    };
    expect(authoringEtag(shuffled, BODY)).toBe(authoringEtag(KEY, BODY));

    const bumped: AuthoringSchemaKey = {
      ...KEY,
      revisions: ['category:cat-1=4', 'attribute_values:attr-1=7'],
    };
    expect(authoringEtag(bumped, BODY)).not.toBe(authoringEtag(KEY, BODY));
  });

  it('a body change changes the tag', () => {
    expect(authoringEtag(KEY, { ...BODY, groups: [{ id: 'g1' }] })).not.toBe(
      authoringEtag(KEY, BODY),
    );
  });

  it('the tag is quoted, as RFC 9110 requires of a strong validator', () => {
    const tag = authoringEtag(KEY, BODY);
    expect(tag.startsWith('"')).toBe(true);
    expect(tag.endsWith('"')).toBe(true);
  });
});

describe('every semantic dimension is IN the key, varied one at a time', () => {
  // Each entry changes exactly ONE dimension. `ADR 0007 D10` lists product type
  // version, category, flow, policy, locale and market; `permissionFingerprint`
  // is the policy member.
  const variations: readonly { name: string; key: AuthoringSchemaKey }[] = [
    { name: 'product type version', key: { ...KEY, productTypeDefinitionId: 'ptd-2' } },
    { name: 'category', key: { ...KEY, categoryId: 'cat-2' } },
    { name: 'flow', key: { ...KEY, flow: 'p2p' } },
    { name: 'locale', key: { ...KEY, locale: 'es' } },
    { name: 'market', key: { ...KEY, market: 'MX' } },
    { name: 'permission policy', key: { ...KEY, permissionFingerprint: '1000' } },
  ];

  it.each(variations)('changing the $name changes the tag', ({ key }) => {
    expect(authoringEtag(key, BODY)).not.toBe(authoringEtag(KEY, BODY));
  });

  it('the cache key varies with the same six dimensions', () => {
    const keys = new Set(variations.map((entry) => authoringSchemaCacheKey(entry.key)));
    keys.add(authoringSchemaCacheKey(KEY));
    // Seven distinct keys from seven distinct dimension sets. A count is the
    // vacuity floor here: a key that dropped one dimension would collapse two of
    // them onto one string and this would read six.
    expect(keys.size).toBe(7);
  });

  it('two DIFFERENT requested locales that resolve identically stay distinguishable', () => {
    // The composed body carries the locale it RESOLVED in, so `es-cl` and `pt`
    // both falling back to `en` produce identical bodies. They must still have
    // different tags, because the next translation to land changes one and not
    // the other.
    const a = authoringEtag({ ...KEY, locale: 'es-cl' }, BODY);
    const b = authoringEtag({ ...KEY, locale: 'pt' }, BODY);
    expect(a).not.toBe(b);
  });
});

describe('If-None-Match', () => {
  const tag = authoringEtag(KEY, BODY);

  it('matches an exact echo', () => {
    expect(authoringEtagMatches(tag, tag)).toBe(true);
  });

  it('matches inside a list', () => {
    expect(authoringEtagMatches(`"other", ${tag}`, tag)).toBe(true);
  });

  it('matches a weakly-prefixed echo of a strong tag', () => {
    expect(authoringEtagMatches(`W/${tag}`, tag)).toBe(true);
  });

  it('matches `*`', () => {
    expect(authoringEtagMatches('*', tag)).toBe(true);
  });

  it('does not match an absent header or a different tag', () => {
    expect(authoringEtagMatches(undefined, tag)).toBe(false);
    expect(authoringEtagMatches('"nope"', tag)).toBe(false);
  });
});

describe('the axis digest is #367 step 4\'s, and this domain defines none', () => {
  // The order-independence PROPERTY is step 4's own
  // (`variant-axis-signature.test.ts`) and is deliberately not re-tested here —
  // a second suite over one function measures the same thing twice and drifts
  // the day one of them is updated. What IS this domain's to prove is that the
  // draft and the variant it publishes into share the digest, which they can
  // only do by sharing the function.
  const colour = { attributeDefinitionId: 'attr-colour', normalizedValue: 'black' };
  const size = { attributeDefinitionId: 'attr-size', normalizedValue: 'm' };

  it('the shared function is order-independent, which is what the draft relies on', () => {
    expect(typedVariantSignature([colour, size])).toBe(typedVariantSignature([size, colour]));
  });

  it('a zero-axis variant gets a real digest rather than a NULL', () => {
    // Two variants that vary along nothing are one variant. A NULL would let a
    // draft hold both and only discover it at publish, when step 4's
    // `native_variant_signatures_listing_signature_key` refuses the second with
    // a 23505 nothing can attribute to a row.
    expect(defaultTypedVariantSignature()).toMatch(/^[0-9a-f]{64}$/u);
    expect(defaultTypedVariantSignature()).toBe(typedVariantSignature([]));
  });

  it('the authoring module exports no digest of its own', async () => {
    const authoringEtagModule = await import('../etag.js');
    // A clean cut, not an alias: `variantAxisSignature` used to live here, and
    // keeping it would have meant a draft and its published variant disagreeing
    // about which two variants are the same thing.
    expect(Object.keys(authoringEtagModule)).not.toContain('variantAxisSignature');
    expect(Object.keys(authoringEtagModule).sort()).toEqual([
      'authoringEtag',
      'authoringEtagMatches',
      'authoringSchemaCacheKey',
    ]);
  });
});
