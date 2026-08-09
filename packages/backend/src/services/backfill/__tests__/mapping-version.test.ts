/**
 * Subject keys, and the one property that makes the whole report table honest:
 * two different subjects can never render to one key (#60 job behaviour 1).
 *
 * `catalog_backfill_records` is keyed on `(mapping_version, mode, stage,
 * subject_key)`, so a collision is not a bug that surfaces as an error — it is
 * one subject's verdict silently overwriting another's, in the table an operator
 * reads to decide whether a migration went well.
 */

import { describe, expect, it } from 'vitest';
import {
  backfillSubjectKey,
  backfillSubjectKind,
  CATALOG_BACKFILL_MAPPING_VERSION,
  CATALOG_BACKFILL_RULE_ID,
  type BackfillSubject,
} from '../mapping-version.js';

const SUBJECTS: readonly BackfillSubject[] = [
  { kind: 'store', storeId: 'x' },
  { kind: 'listing', listingId: 'x' },
  { kind: 'product_variant', productVariantId: 'x' },
  { kind: 'canonical_product', canonicalProductId: 'x' },
  { kind: 'native_offer', offerId: 'x' },
  { kind: 'vendor_value', normalizedName: 'x' },
];

describe('backfillSubjectKey', () => {
  it('gives the SAME id under different kinds different keys', () => {
    // The failure this prevents: a store and a listing sharing an id (which two
    // uuid v7 spaces legitimately can, and which a fixture certainly can) would
    // otherwise collide, and the second verdict written would erase the first.
    const keys = SUBJECTS.map(backfillSubjectKey);
    expect(new Set(keys).size).toBe(SUBJECTS.length);
  });

  it('names its kind in the key, and reports the same kind for the column', () => {
    for (const subject of SUBJECTS) {
      expect(backfillSubjectKey(subject).startsWith(`${subject.kind}:`)).toBe(true);
      expect(backfillSubjectKind(subject)).toBe(subject.kind);
    }
  });

  it('gives an unnormalizable vendor group a real, addressable key', () => {
    // `extractVendorBrandCandidates` groups a value with no normalizable content
    // under the empty string. That is a real group with a real report row, not a
    // subject nobody can address.
    expect(backfillSubjectKey({ kind: 'vendor_value', normalizedName: '' })).toBe('vendor_value:');
  });

  it('carries the mapping version in the rule id it writes into other domains', () => {
    // An operator reading a `native_listing_links.match_rule` must be able to
    // tell which rule set produced it without joining back to a run.
    expect(CATALOG_BACKFILL_RULE_ID).toBe(`backfill:v${String(CATALOG_BACKFILL_MAPPING_VERSION)}`);
    expect(CATALOG_BACKFILL_MAPPING_VERSION).toBeGreaterThanOrEqual(1);
  });
});
