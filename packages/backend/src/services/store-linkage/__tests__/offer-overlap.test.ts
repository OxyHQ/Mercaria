/**
 * The deterministic offer-overlap rule (#84 catalog rule 4, acceptance 3).
 *
 * Two things are under test and only the first is obvious:
 *
 *  1. each rule fires on the case it exists for, in precedence order;
 *  2. the order is TOTAL — the same set of rows produces the same primary
 *     whatever order the caller hands them in, including when every
 *     discriminating field ties. "Deterministic" that holds only when the input
 *     happens to be sorted is not deterministic, and a batch import stamping two
 *     rows with one `last_seen_at` is the ordinary case that finds out.
 */

import { describe, expect, it } from 'vitest';
import {
  reconcileMerchantOfferOverlaps,
  type OverlapCandidateOffer,
} from '../offer-overlap.js';

const T0 = new Date('2026-08-01T00:00:00.000Z');
const T1 = new Date('2026-08-02T00:00:00.000Z');

function offer(overrides: Partial<OverlapCandidateOffer> & { offerId: string }): OverlapCandidateOffer {
  return {
    canonicalVariantId: 'cv-1',
    kind: 'external',
    sellerIsChannelOperator: true,
    lastSeenAt: T0,
    ...overrides,
  };
}

describe('one offer on a variant is not an overlap', () => {
  it('produces no finding', () => {
    expect(reconcileMerchantOfferOverlaps([offer({ offerId: 'a' })])).toEqual([]);
  });

  it('and neither do two offers on DIFFERENT variants', () => {
    // The grain is the canonical variant: two rows describing two different
    // purchasable things are not two representations of one sale.
    expect(
      reconcileMerchantOfferOverlaps([
        offer({ offerId: 'a', canonicalVariantId: 'cv-1' }),
        offer({ offerId: 'b', canonicalVariantId: 'cv-2' }),
      ]),
    ).toEqual([]);
  });
});

describe('rule 1 — a native offer supersedes an external one', () => {
  it('names the native offer primary, whichever order they arrive in', () => {
    const native = offer({ offerId: 'z-native', kind: 'native' });
    const external = offer({ offerId: 'a-external', kind: 'external' });

    // The native offer has the LATER id here, so an implementation that fell
    // back to `lowest_offer_id` would pick the external one and this would fail.
    for (const input of [
      [native, external],
      [external, native],
    ]) {
      const [finding, ...rest] = reconcileMerchantOfferOverlaps(input);
      expect(rest).toEqual([]);
      expect(finding?.primaryOfferId).toBe('z-native');
      expect(finding?.duplicateOfferId).toBe('a-external');
      expect(finding?.rule).toBe('native_supersedes_external');
    }
  });

  it('outranks freshness — a stale native offer still wins', () => {
    // Deliberate: the native offer is the merchant's own live catalogue, read
    // from the variant they edit. A crawl seen ten minutes ago is still a copy.
    const [finding] = reconcileMerchantOfferOverlaps([
      offer({ offerId: 'a', kind: 'native', lastSeenAt: T0 }),
      offer({ offerId: 'b', kind: 'external', lastSeenAt: T1 }),
    ]);
    expect(finding?.primaryOfferId).toBe('a');
    expect(finding?.rule).toBe('native_supersedes_external');
  });
});

describe('rule 2 — the seller’s own channel supersedes a marketplace listing', () => {
  it('prefers the offer whose channel its seller operates (ADR 0002 D8)', () => {
    const own = offer({ offerId: 'z-own', sellerIsChannelOperator: true });
    const marketplace = offer({ offerId: 'a-marketplace', sellerIsChannelOperator: false });

    for (const input of [
      [own, marketplace],
      [marketplace, own],
    ]) {
      const [finding] = reconcileMerchantOfferOverlaps(input);
      expect(finding?.primaryOfferId).toBe('z-own');
      expect(finding?.rule).toBe('operated_channel_supersedes_marketplace');
    }
  });
});

describe('rule 3 — otherwise the fresher observation', () => {
  it('prefers the later last_seen_at', () => {
    const [finding] = reconcileMerchantOfferOverlaps([
      offer({ offerId: 'a', lastSeenAt: T0 }),
      offer({ offerId: 'b', lastSeenAt: T1 }),
    ]);
    expect(finding?.primaryOfferId).toBe('b');
    expect(finding?.rule).toBe('most_recently_seen');
  });
});

describe('rule 4 — the lower id, which is what makes the order TOTAL', () => {
  it('breaks a full tie the same way every time, in either input order', () => {
    // The case a three-rule set leaves to chance: two rows a batch import
    // stamped with one timestamp, same kind, same channel relationship.
    const a = offer({ offerId: 'aaa', lastSeenAt: T0 });
    const b = offer({ offerId: 'bbb', lastSeenAt: T0 });

    for (const input of [
      [a, b],
      [b, a],
    ]) {
      const [finding] = reconcileMerchantOfferOverlaps(input);
      expect(finding?.primaryOfferId).toBe('aaa');
      expect(finding?.duplicateOfferId).toBe('bbb');
      expect(finding?.rule).toBe('lowest_offer_id');
    }
  });
});

describe('determinism over a mixed set', () => {
  it('produces the identical findings for every permutation of the input', () => {
    const rows: OverlapCandidateOffer[] = [
      offer({ offerId: 'o1', kind: 'external', lastSeenAt: T1 }),
      offer({ offerId: 'o2', kind: 'native', lastSeenAt: T0 }),
      offer({ offerId: 'o3', kind: 'external', sellerIsChannelOperator: false, lastSeenAt: T1 }),
      offer({ offerId: 'o4', canonicalVariantId: 'cv-2', kind: 'external', lastSeenAt: T0 }),
      offer({ offerId: 'o5', canonicalVariantId: 'cv-2', kind: 'external', lastSeenAt: T0 }),
    ];

    const baseline = reconcileMerchantOfferOverlaps(rows);

    // Three findings: two on cv-1 (native o2 wins over o1 and o3) and one on
    // cv-2 (a full tie broken by id). Pinning the count is the vacuity floor —
    // an implementation returning nothing would satisfy every permutation.
    expect(baseline).toHaveLength(3);
    expect(baseline.filter((f) => f.canonicalVariantId === 'cv-1')).toHaveLength(2);
    expect(baseline.every((f) => f.primaryOfferId !== f.duplicateOfferId)).toBe(true);

    for (const permutation of permutations(rows)) {
      expect(reconcileMerchantOfferOverlaps(permutation)).toEqual(baseline);
    }
  });
});

describe('nothing is retired, deleted or re-priced (acceptance 3)', () => {
  it('every input row appears in the findings as primary or duplicate, and survives', () => {
    // The function is pure and returns FINDINGS, so "nothing is deleted" is a
    // property of its type as much as of its body — there is no offer row here
    // to delete. What this pins is the other half: both representations are
    // NAMED, so the caller records a relationship between two live rows rather
    // than a removal of one.
    const rows = [
      offer({ offerId: 'native-1', kind: 'native' }),
      offer({ offerId: 'external-1', kind: 'external' }),
    ];
    const [finding] = reconcileMerchantOfferOverlaps(rows);
    expect([finding?.primaryOfferId, finding?.duplicateOfferId].sort()).toEqual([
      'external-1',
      'native-1',
    ]);
  });
});

/** Every ordering of a small array — the determinism check's input generator. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const head = items[i];
    if (head === undefined) continue;
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) result.push([head, ...tail]);
  }
  return result;
}
