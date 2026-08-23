import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SEO may only reach a canonical product through a reader that applies the
 * shopper-visibility filter (#888).
 *
 * ## Why this is a gate and not a comment
 *
 * `getPublicCanonicalProduct` refuses a product outside
 * `SHOPPER_VISIBLE_CATALOG_STATUSES`, and a realdb case drives that. This file
 * covers the OTHER direction: that `seo.service.ts` still goes through it.
 *
 * SEO is the consumer where being wrong is unrecoverable. The other four
 * surfaces SERVE a suppressed product and can stop the moment somebody notices;
 * this one PUBLISHES it — `readProductSlug` decides a legacy listing's
 * `rel=canonical`, so a withdrawn product's URL is handed to a crawler and
 * outlives the suppression by however long the index takes to forget. A future
 * change that reads the row directly — for a name, an image, a slug — would
 * reintroduce exactly that, pass every behavioural test in this domain, and
 * look like an optimisation.
 *
 * The scan is over the module's IMPORTS rather than its call sites, because
 * that is where the capability is granted: a repository function it cannot
 * import is one it cannot call, whatever a later refactor does inside.
 */

const SEO_SERVICE = join(__dirname, '..', 'seo.service.ts');

/** Readers that apply the visibility filter, so SEO may hold them. */
const FILTERED_READERS = ['getPublicCanonicalProduct', 'readCanonicalProductPage'];

/**
 * Repository modules that return a canonical product ROW, filter-free.
 *
 * Named rather than derived from a glob: the point is that each of these was
 * checked and found to expose an unfiltered row read, not that anything with
 * `canonical` in its path is forbidden.
 */
const UNFILTERED_ROW_SOURCES = [
  'db/canonical/canonicalProductRepository',
  'db/canonical/canonicalVariantRepository',
];

describe('#888 — SEO cannot bypass the canonical visibility filter', () => {
  const source = readFileSync(SEO_SERVICE, 'utf8');

  it('the scan has a subject at all', () => {
    // The vacuity floor. A moved or renamed file makes every assertion below
    // pass against an empty string, which is the shape this repository's own
    // gate-writing rules exist to refuse.
    expect(source.length, 'seo.service.ts is missing or empty').toBeGreaterThan(2_000);
    expect(source, 'seo.service.ts no longer imports anything').toContain('import ');
  });

  it('imports at least one FILTERED canonical reader — the positive control', () => {
    // Without this, "imports no unfiltered repository" is satisfied by a module
    // that reads no canonical product at all, and the gate would keep passing
    // after the code it guards was deleted.
    const held = FILTERED_READERS.filter((reader) =>
      new RegExp(`(?<![A-Za-z0-9_])${reader}(?![A-Za-z0-9_])`, 'u').test(source),
    );
    expect(held, 'seo.service.ts reaches no filtered canonical reader').not.toHaveLength(0);
  });

  it('imports NO unfiltered canonical row repository', () => {
    for (const module of UNFILTERED_ROW_SOURCES) {
      expect(
        source.includes(module),
        `seo.service.ts imports ${module}, which returns an unfiltered row — `
          + 'a suppressed product would reach a rel=canonical again',
      ).toBe(false);
    }
  });

  it('the detector can actually fire — the mutation self-test', () => {
    // Every assertion above is an absence, and an absence check that cannot
    // match anything reports the same clean pass forever.
    const mutated = `${source}\nimport { findCanonicalProductById } from '../../db/canonical/canonicalProductRepository.js';`;
    expect(
      UNFILTERED_ROW_SOURCES.some((module) => mutated.includes(module)),
      'the detector does not match its own quarry',
    ).toBe(true);
  });
});
