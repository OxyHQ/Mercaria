/**
 * Conflict detection for mutually inconsistent active claims (#55, operator
 * workflow 4), table-tested.
 *
 * `detectConflicts` is pure, so this file can enumerate the matrix without a
 * database — and the cases that need one (the two conflicts an index refuses at
 * write time) are covered in `relationships.realdb.test.ts` instead.
 *
 * Each positive case is paired with its NEAR MISS: the same shape with one field
 * changed so the conflict should NOT fire. Without the pairs, a detector that
 * returns every kind for every input would pass the positives.
 */

import { describe, expect, it } from 'vitest';
import {
  detectConflicts,
  overlappingTerritories,
  type ConflictCandidateRow,
} from '../relationship-conflicts.js';

const NOW = new Date('2026-08-09T12:00:00Z');
const YESTERDAY = new Date('2026-08-08T12:00:00Z');
const LAST_YEAR = new Date('2025-08-09T12:00:00Z');

function row(overrides: Partial<ConflictCandidateRow> & { id: string }): ConflictCandidateRow {
  return {
    kind: 'merchant_official_channel_for_brand',
    organizationId: null,
    brandId: null,
    merchantId: null,
    productFamilyId: null,
    relatedBrandId: null,
    storefrontId: null,
    territories: [],
    status: 'verified',
    validFrom: LAST_YEAR,
    validTo: null,
    ...overrides,
  };
}

function kindsOf(conflicts: { kind: string }[]): string[] {
  return conflicts.map((conflict) => conflict.kind).sort();
}

describe('territory overlap treats an empty list as WORLDWIDE', () => {
  it('intersects everything against a worldwide claim', () => {
    expect(overlappingTerritories([], ['ES', 'FR'])).toEqual(['ES', 'FR']);
    expect(overlappingTerritories(['ES'], [])).toEqual(['ES']);
    expect(overlappingTerritories([], [])).toEqual(['*']);
  });

  it('intersects two scoped claims properly', () => {
    expect(overlappingTerritories(['ES', 'FR'], ['FR', 'DE'])).toEqual(['FR']);
    expect(overlappingTerritories(['ES'], ['DE'])).toEqual([]);
  });
});

describe('contested brand ownership', () => {
  const subject = row({
    id: 'own-a',
    kind: 'organization_owns_brand',
    organizationId: 'org-a',
    brandId: 'brand-1',
    status: 'candidate',
  });

  it('flags two live organizations claiming one brand', () => {
    const rival = row({
      id: 'own-b',
      kind: 'organization_owns_brand',
      organizationId: 'org-b',
      brandId: 'brand-1',
      status: 'candidate',
    });
    expect(
      kindsOf(detectConflicts({ subject, related: [subject, rival], evidence: [], at: NOW })),
    ).toEqual(['contested_brand_ownership']);
  });

  it('does NOT flag the same organization claiming its own brand twice over time', () => {
    const historical = row({
      id: 'own-old',
      kind: 'organization_owns_brand',
      organizationId: 'org-a',
      brandId: 'brand-1',
      status: 'expired',
      validTo: YESTERDAY,
    });
    expect(
      kindsOf(detectConflicts({ subject, related: [subject, historical], evidence: [], at: NOW })),
    ).toEqual([]);
  });

  it('does NOT flag a rival claim that has already been rejected', () => {
    const rejected = row({
      id: 'own-b',
      kind: 'organization_owns_brand',
      organizationId: 'org-b',
      brandId: 'brand-1',
      status: 'rejected',
    });
    expect(
      kindsOf(detectConflicts({ subject, related: [subject, rejected], evidence: [], at: NOW })),
    ).toEqual([]);
  });
});

describe('a merchant cannot be both a brand’s own store and its reseller in one market', () => {
  const official = row({
    id: 'chan',
    kind: 'merchant_official_channel_for_brand',
    merchantId: 'merch-1',
    brandId: 'brand-1',
    territories: ['ES', 'FR'],
  });

  it('flags an overlapping reseller claim', () => {
    const reseller = row({
      id: 'resell',
      kind: 'merchant_authorized_reseller_for_brand',
      merchantId: 'merch-1',
      brandId: 'brand-1',
      territories: ['FR', 'DE'],
    });
    const conflicts = detectConflicts({
      subject: official,
      related: [official, reseller],
      evidence: [],
      at: NOW,
    });
    expect(kindsOf(conflicts)).toEqual(['channel_and_reseller_overlap']);
    expect(conflicts[0]?.overlappingTerritories).toEqual(['FR']);
  });

  it('does NOT flag the two claims in DISJOINT markets', () => {
    // The near miss that makes the positive meaningful: Apple Store is Apple's
    // own channel in Spain while a different arrangement holds in Japan is an
    // ordinary, non-contradictory pair.
    const reseller = row({
      id: 'resell',
      kind: 'merchant_authorized_reseller_for_brand',
      merchantId: 'merch-1',
      brandId: 'brand-1',
      territories: ['JP'],
    });
    expect(
      kindsOf(detectConflicts({ subject: official, related: [official, reseller], evidence: [], at: NOW })),
    ).toEqual([]);
  });

  it('does NOT flag a DIFFERENT merchant reselling the same brand', () => {
    const other = row({
      id: 'resell',
      kind: 'merchant_authorized_reseller_for_brand',
      merchantId: 'merch-2',
      brandId: 'brand-1',
      territories: ['ES'],
    });
    expect(
      kindsOf(detectConflicts({ subject: official, related: [official, other], evidence: [], at: NOW })),
    ).toEqual([]);
  });
});

describe('succession cycles', () => {
  it('flags A succeeds B while B succeeds A', () => {
    const forward = row({
      id: 'succ-1',
      kind: 'brand_succeeds_brand',
      brandId: 'brand-new',
      relatedBrandId: 'brand-old',
    });
    const backward = row({
      id: 'succ-2',
      kind: 'brand_succeeds_brand',
      brandId: 'brand-old',
      relatedBrandId: 'brand-new',
    });
    expect(
      kindsOf(detectConflicts({ subject: forward, related: [forward, backward], evidence: [], at: NOW })),
    ).toEqual(['succession_cycle']);
  });

  it('does NOT flag a CHAIN — C succeeds B succeeds A is a sequence, not a cycle', () => {
    const first = row({
      id: 'succ-1',
      kind: 'brand_succeeds_brand',
      brandId: 'brand-b',
      relatedBrandId: 'brand-a',
    });
    const second = row({
      id: 'succ-2',
      kind: 'brand_succeeds_brand',
      brandId: 'brand-c',
      relatedBrandId: 'brand-b',
    });
    expect(
      kindsOf(detectConflicts({ subject: first, related: [first, second], evidence: [], at: NOW })),
    ).toEqual([]);
  });
});

describe('a verified claim whose proof has lapsed', () => {
  const subject = row({ id: 'rel-1', merchantId: 'merch-1', brandId: 'brand-1' });

  it('flags a verified row whose every evidence row is revoked or expired', () => {
    expect(
      kindsOf(
        detectConflicts({
          subject,
          related: [subject],
          evidence: [
            { relationshipId: 'rel-1', status: 'revoked' },
            { relationshipId: 'rel-1', status: 'expired' },
          ],
          at: NOW,
        }),
      ),
    ).toEqual(['verified_without_active_evidence']);
  });

  it('does NOT flag it while ONE active proof remains', () => {
    expect(
      kindsOf(
        detectConflicts({
          subject,
          related: [subject],
          evidence: [
            { relationshipId: 'rel-1', status: 'revoked' },
            { relationshipId: 'rel-1', status: 'active' },
          ],
          at: NOW,
        }),
      ),
    ).toEqual([]);
  });

  it('does NOT flag another relationship’s revoked evidence', () => {
    expect(
      kindsOf(
        detectConflicts({
          subject,
          related: [subject],
          evidence: [{ relationshipId: 'rel-2', status: 'revoked' }],
          at: NOW,
        }),
      ),
    ).toEqual([]);
  });
});

describe('a verified claim whose validity window has closed', () => {
  it('flags a row still marked verified after its window ended', () => {
    const lapsed = row({
      id: 'rel-1',
      merchantId: 'merch-1',
      brandId: 'brand-1',
      validTo: YESTERDAY,
    });
    expect(
      kindsOf(detectConflicts({ subject: lapsed, related: [lapsed], evidence: [], at: NOW })),
    ).toEqual(['verified_past_validity']);
  });

  it('does NOT flag one whose window is still open', () => {
    const live = row({
      id: 'rel-1',
      merchantId: 'merch-1',
      brandId: 'brand-1',
      validTo: new Date('2027-01-01T00:00:00Z'),
    });
    expect(
      kindsOf(detectConflicts({ subject: live, related: [live], evidence: [], at: NOW })),
    ).toEqual([]);
  });

  it('does NOT flag one that has not started yet', () => {
    // A future-dated claim is not lapsed. Getting this backwards would fill the
    // queue with every scheduled relationship.
    const future = row({
      id: 'rel-1',
      merchantId: 'merch-1',
      brandId: 'brand-1',
      status: 'candidate',
      validFrom: new Date('2027-01-01T00:00:00Z'),
    });
    expect(
      kindsOf(detectConflicts({ subject: future, related: [future], evidence: [], at: NOW })),
    ).toEqual([]);
  });
});

describe('duplicate open claims', () => {
  it('flags a second open row with identical endpoints and scope', () => {
    const first = row({ id: 'a', merchantId: 'm', brandId: 'b', status: 'candidate' });
    const second = row({ id: 'b', merchantId: 'm', brandId: 'b', status: 'candidate' });
    expect(
      kindsOf(detectConflicts({ subject: first, related: [first, second], evidence: [], at: NOW })),
    ).toEqual(['duplicate_open_claim']);
  });

  it('does NOT flag one narrowed to a specific storefront', () => {
    // Storefront scope is part of the claim's identity: "official channel via
    // this storefront" and "official channel across every channel" are two
    // different assertions and must be able to coexist.
    const wide = row({ id: 'a', merchantId: 'm', brandId: 'b', status: 'candidate' });
    const narrow = row({
      id: 'b',
      merchantId: 'm',
      brandId: 'b',
      storefrontId: 'sf-1',
      status: 'candidate',
    });
    expect(
      kindsOf(detectConflicts({ subject: wide, related: [wide, narrow], evidence: [], at: NOW })),
    ).toEqual([]);
  });

  it('does NOT flag a CLOSED historical row with the same endpoints', () => {
    const open = row({ id: 'a', merchantId: 'm', brandId: 'b', status: 'candidate' });
    const closed = row({
      id: 'b',
      merchantId: 'm',
      brandId: 'b',
      status: 'revoked',
      validTo: YESTERDAY,
    });
    expect(
      kindsOf(detectConflicts({ subject: open, related: [open, closed], evidence: [], at: NOW })),
    ).toEqual([]);
  });
});
