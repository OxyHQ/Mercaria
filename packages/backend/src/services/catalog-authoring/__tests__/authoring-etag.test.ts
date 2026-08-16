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
  variantAxisSignature,
  type AuthoringSchemaKey,
} from '../etag.js';

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

describe('the variant axis signature is ORDER-INDEPENDENT (ADR 0007 D6)', () => {
  const colour = { attributeDefinitionId: 'attr-colour', normalizedValue: 'v-black' };
  const size = { attributeDefinitionId: 'attr-size', normalizedValue: 'v-m' };

  it('two variants whose axes were entered in different orders collide', () => {
    expect(variantAxisSignature([colour, size])).toBe(variantAxisSignature([size, colour]));
  });

  it('a different VALUE on one axis produces a different signature', () => {
    expect(
      variantAxisSignature([colour, { ...size, normalizedValue: 'v-l' }]),
    ).not.toBe(variantAxisSignature([colour, size]));
  });

  it('a different ATTRIBUTE with the same value produces a different signature', () => {
    // The pair is joined with `=`, so this is what stops `a=bc` and `ab=c`
    // hashing alike — a real collision an unseparated concatenation would have.
    expect(
      variantAxisSignature([{ attributeDefinitionId: 'attr-tone', normalizedValue: 'v-black' }]),
    ).not.toBe(variantAxisSignature([colour]));
  });

  it('it is a 64-character lowercase hex digest, the shape `canonical_variants.signature` uses', () => {
    expect(variantAxisSignature([colour, size])).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('an empty axis set still produces a signature rather than throwing', () => {
    // A single-variant product declares no axes. The repository stores NULL for
    // that case; what matters here is that the function is total.
    expect(variantAxisSignature([])).toMatch(/^[0-9a-f]{64}$/u);
  });
});
