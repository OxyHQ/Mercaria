/**
 * `review-eligibility.service` — what can and cannot create the right to review.
 *
 * The isolation gate beside this file proves the domain cannot REACH a payment
 * or a referral. These tests prove the behaviour on the paths that do exist:
 * that a completed order grants the three scopes it resolves to, that a REPLAY
 * grants nothing new, that an unclaimed guest order grants NOTHING through any
 * exported path, and — since #109 landed — that the guest path grants only when
 * the ORDER ROW already carries the account the caller names.
 *
 * Acceptance criteria answered here: 3 (idempotent, tied to the right line),
 * 8 (an unclaimed guest purchase cannot publish or create an author), 9 (a
 * claim creates eligibility exactly once and never from an email match), 10
 * (Stripe identity, cart token and portal access alone create nothing).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const insertEligibility = vi.fn();
const findEligibilityById = vi.fn();
const findOpenEligibilitiesForTarget = vi.fn();
const findOpenEligibilitiesForUser = vi.fn();
const findEligibilitiesForOrder = vi.fn();
const findOrderById = vi.fn();
const findListingsByIds = vi.fn();
const findCanonicalProductIdForVariant = vi.fn();
const findMerchantIdForStore = vi.fn();

vi.mock('../../../db/reviews/reviewEligibilityRepository.js', () => ({
  insertEligibility: (...args: unknown[]) => insertEligibility(...args),
  findEligibilityById: (...args: unknown[]) => findEligibilityById(...args),
  findOpenEligibilitiesForTarget: (...args: unknown[]) => findOpenEligibilitiesForTarget(...args),
  findOpenEligibilitiesForUser: (...args: unknown[]) => findOpenEligibilitiesForUser(...args),
  findEligibilitiesForOrder: (...args: unknown[]) => findEligibilitiesForOrder(...args),
}));

vi.mock('../../../db/orders/orderRepository.js', () => ({
  findOrderById: (...args: unknown[]) => findOrderById(...args),
}));

vi.mock('../../../db/catalog/listingRepository.js', () => ({
  findListingsByIds: (...args: unknown[]) => findListingsByIds(...args),
}));

vi.mock('../../../db/reviews/reviewTargetResolver.js', () => ({
  findCanonicalProductIdForVariant: (...args: unknown[]) =>
    findCanonicalProductIdForVariant(...args),
  findMerchantIdForStore: (...args: unknown[]) => findMerchantIdForStore(...args),
}));

import {
  grantEligibilitiesForClaimedGuestOrder,
  grantEligibilitiesForOrder,
  listEligibilitiesForOrder,
  resolveEligibilityToSpend,
  toEligibilityDTO,
} from '../review-eligibility.service.js';
import { assertNotForbiddenEvidenceSource } from '../review-scope.js';
import type { ReviewEligibilityRecord } from '../../../db/reviews/reviewEligibilityRepository.js';
import { REVIEW_FORBIDDEN_EVIDENCE_SOURCES } from '@mercaria/shared-types';
import { isMercariaError } from '../../../lib/errors/error-codes.js';
import { ErrorCodes } from '../../../utils/api-response.js';

const AT = new Date('2026-01-01T00:00:00.000Z');

/** A paid STORE order with one line, as the repository returns it. */
function storeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    status: 'paid',
    // #106: the grant reads `buyer_origin`, not the shape of the buyer id.
    buyerOrigin: 'oxy',
    buyerOxyUserId: 'buyer-1',
    claimedByOxyUserId: null,
    sellerType: 'store',
    sellerOxyUserId: null,
    storeId: 'store-1',
    checkoutGroupId: 'group-1',
    items: [{ id: 'line-1', listingId: 'listing-1', variantId: 'variant-1' }],
    ...overrides,
  };
}

/** A paid P2P order with one line. */
function p2pOrder(overrides: Record<string, unknown> = {}) {
  return storeOrder({
    sellerType: 'user',
    sellerOxyUserId: 'seller-9',
    storeId: null,
    ...overrides,
  });
}

/** What `insertEligibility` returns for a row it created. */
function grantedRow(scope: string, targetId: string): ReviewEligibilityRecord {
  return {
    id: `elig-${scope}`,
    oxyUserId: 'buyer-1',
    orderId: 'order-1',
    orderItemId: 'line-1',
    scope: scope as ReviewEligibilityRecord['scope'],
    targetType: scope as ReviewEligibilityRecord['targetType'],
    listingId: null,
    storeId: null,
    sellerOxyUserId: null,
    canonicalProductId: null,
    merchantId: null,
    targetOrderItemId: targetId,
    evidenceType: 'authenticated_purchase' as const,
    claimId: null,
    state: 'open' as const,
    consumedAt: null,
    revokedAt: null,
    revokedReason: null,
    disputedAt: null,
    policyVersion: '2026-08-09.1',
    createdAt: AT,
    updatedAt: AT,
    targetKey: '',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  insertEligibility.mockImplementation((values: { scope: string; targetId: string }) =>
    Promise.resolve(grantedRow(values.scope, values.targetId)),
  );
  findCanonicalProductIdForVariant.mockResolvedValue(null);
  findMerchantIdForStore.mockResolvedValue(null);
  findListingsByIds.mockResolvedValue([]);
});

describe('grantEligibilitiesForOrder — a completed purchase, and nothing else', () => {
  it('grants product, merchant and transaction for a store order that resolves all three', async () => {
    // #76 verification rule 1: one completed native order verifies the
    // corresponding product, merchant AND transaction eligibility.
    findOrderById.mockResolvedValue(storeOrder());
    findCanonicalProductIdForVariant.mockResolvedValue('prod-1');
    findMerchantIdForStore.mockResolvedValue('merch-1');

    const report = await grantEligibilitiesForOrder('order-1');

    const scopes = insertEligibility.mock.calls.map((call) => call[0].scope).sort();
    expect(scopes).toEqual(['merchant', 'native_transaction', 'product']);
    expect(report.granted).toHaveLength(3);

    // Tied to the RIGHT line, every time (acceptance criterion 3).
    for (const call of insertEligibility.mock.calls) {
      expect(call[0].orderItemId).toBe('line-1');
      expect(call[0].orderId).toBe('order-1');
      expect(call[0].oxyUserId).toBe('buyer-1');
      expect(call[0].evidenceType).toBe('authenticated_purchase');
    }
  });

  it('grants the P2P pair for a person-to-person order', async () => {
    findOrderById.mockResolvedValue(p2pOrder());
    findListingsByIds.mockResolvedValue([{ id: 'listing-1' }]);

    await grantEligibilitiesForOrder('order-1');

    const scopes = insertEligibility.mock.calls.map((call) => call[0].scope).sort();
    // The seller and the used item are two different questions about one
    // purchase, which is exactly why they are two scopes.
    expect(scopes).toEqual(['native_transaction', 'p2p_listing', 'p2p_seller']);
  });

  it('SKIPS a scope it cannot resolve rather than failing the whole grant', async () => {
    // A line whose variant resolves to no canonical product still earns the
    // transaction review the buyer can definitely write. Refusing everything
    // over a missing catalogue link would cost them that for nothing.
    findOrderById.mockResolvedValue(storeOrder());
    findCanonicalProductIdForVariant.mockResolvedValue(null);
    findMerchantIdForStore.mockResolvedValue(null);

    const report = await grantEligibilitiesForOrder('order-1');

    expect(insertEligibility.mock.calls.map((call) => call[0].scope)).toEqual([
      'native_transaction',
    ]);
    expect(report.skipped.map((entry) => entry.scope).sort()).toEqual(['merchant', 'product']);
  });

  it('a REPLAY grants nothing new — the unique index converged', async () => {
    // #76 verification rule 11. `insertEligibility` returns null when the row
    // already existed, and that is not an error: the `paid` transition is
    // deliverable twice, a claim is retryable, and a migration replays.
    findOrderById.mockResolvedValue(storeOrder());
    insertEligibility.mockResolvedValue(null);

    const report = await grantEligibilitiesForOrder('order-1');

    expect(report.granted).toHaveLength(0);
    expect(insertEligibility).toHaveBeenCalled();
  });

  it('refuses an order that is not a completed purchase', async () => {
    findOrderById.mockResolvedValue(storeOrder({ status: 'pending_payment' }));

    await expect(grantEligibilitiesForOrder('order-1')).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.FORBIDDEN,
    );
    expect(insertEligibility).not.toHaveBeenCalled();
  });

  it('grants NOTHING for a connector-imported order — there is no Oxy account to grant to', async () => {
    // An imported order's origin is `external` and its buyer column carries the
    // legacy `ext:<provider>:<id>` provenance. Inventing an author from it is
    // the failure this whole domain exists to prevent, so the path returns
    // empty rather than guessing — and since #106 it reads the ORIGIN rather
    // than sniffing the prefix, so an import whose id lacked the prefix is
    // excluded too.
    findOrderById.mockResolvedValue(
      storeOrder({ buyerOrigin: 'external', buyerOxyUserId: 'ext:shopify:42' }),
    );

    const report = await grantEligibilitiesForOrder('order-1');

    expect(report.granted).toHaveLength(0);
    expect(insertEligibility).not.toHaveBeenCalled();
  });
});

describe('the guest seam — #109 is not implemented, and this FAILS CLOSED', () => {
  it('refuses a claim whose two sides were not both proven', async () => {
    await expect(
      grantEligibilitiesForClaimedGuestOrder('order-1', {
        claimId: 'claim-1',
        checkoutGroupId: 'group-1',
        claimedByOxyUserId: 'buyer-1',
        bothSidesProven: false,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMercariaError(err) &&
        err.code === ErrorCodes.FORBIDDEN &&
        err.message.includes('email match'),
    );
    expect(insertEligibility).not.toHaveBeenCalled();
  });

  it('refuses a claim against an order that was never placed as a guest', async () => {
    // #106 made this a REAL check: `buyer_origin` exists, so an `oxy` order is
    // refused by name rather than by the blanket seam refusal below. Before
    // #106 this case was indistinguishable from every other.
    findOrderById.mockResolvedValue(storeOrder());

    await expect(
      grantEligibilitiesForClaimedGuestOrder('order-1', {
        claimId: 'claim-1',
        checkoutGroupId: 'group-1',
        claimedByOxyUserId: 'buyer-1',
        bothSidesProven: true,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMercariaError(err) &&
        err.code === ErrorCodes.FORBIDDEN &&
        err.message.includes('not placed as a guest'),
    );
    expect(insertEligibility).not.toHaveBeenCalled();
  });

  it('refuses a WELL-FORMED claim on a guest order the DATABASE says nobody claimed', async () => {
    // The important one, and #109 sharpened rather than removed it. Everything
    // the CALLER supplies looks right — both sides proven, a claim id, the
    // correct checkout group, a genuinely guest-origin order — and it still
    // refuses, because `claimed_by_oxy_user_id` is NULL. The assertion is a
    // value a caller states; the column is the fact. Acceptance criteria 8
    // and 9.
    findOrderById.mockResolvedValue(
      storeOrder({
        buyerOrigin: 'guest',
        buyerOxyUserId: null,
        buyerGuestCheckoutId: 'gc-1',
        claimedByOxyUserId: null,
      }),
    );

    await expect(
      grantEligibilitiesForClaimedGuestOrder('order-1', {
        claimId: 'claim-1',
        checkoutGroupId: 'group-1',
        claimedByOxyUserId: 'buyer-1',
        bothSidesProven: true,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isMercariaError(err) &&
        err.code === ErrorCodes.FORBIDDEN &&
        err.message.includes('not claimed by the account'),
    );
    expect(insertEligibility).not.toHaveBeenCalled();
  });

  it('refuses a claim naming an account the order does NOT carry', async () => {
    // The forgery case, and it is the one the stored comparison exists for: the
    // order IS claimed, by somebody else, and a caller asserting their own id
    // gets nothing. Without the comparison this would be indistinguishable from
    // the happy path below.
    findOrderById.mockResolvedValue(
      storeOrder({
        buyerOrigin: 'guest',
        buyerOxyUserId: null,
        buyerGuestCheckoutId: 'gc-1',
        claimedByOxyUserId: 'the-real-claimant',
      }),
    );

    await expect(
      grantEligibilitiesForClaimedGuestOrder('order-1', {
        claimId: 'claim-1',
        checkoutGroupId: 'group-1',
        claimedByOxyUserId: 'an-impostor',
        bothSidesProven: true,
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.FORBIDDEN,
    );
    expect(insertEligibility).not.toHaveBeenCalled();
  });

  it('grants under the CLAIMED evidence type when the order carries that claimant', async () => {
    // The happy path #109 opened. Note the evidence TYPE and the claim id: a
    // claimed guest purchase must never be recorded as an authenticated one,
    // because that would lose the distinction the claim exists to record — and
    // `review_eligibilities`' own CHECK makes the type and the claim id
    // biconditional, so a grant of this type without a claim to cite is
    // unrepresentable.
    findOrderById.mockResolvedValue(
      storeOrder({
        buyerOrigin: 'guest',
        buyerOxyUserId: null,
        buyerGuestCheckoutId: 'gc-1',
        claimedByOxyUserId: 'claimant-7',
      }),
    );
    findCanonicalProductIdForVariant.mockResolvedValue(null);
    findMerchantIdForStore.mockResolvedValue(null);
    insertEligibility.mockResolvedValue(grantedRow('native_transaction', 'line-1'));

    const report = await grantEligibilitiesForClaimedGuestOrder('order-1', {
      claimId: 'claim-1',
      checkoutGroupId: 'group-1',
      claimedByOxyUserId: 'claimant-7',
      bothSidesProven: true,
    });

    expect(report.granted).toHaveLength(1);
    expect(insertEligibility).toHaveBeenCalledWith(
      expect.objectContaining({
        oxyUserId: 'claimant-7',
        evidenceType: 'claimed_guest_purchase',
        claimId: 'claim-1',
      }),
    );
  });

  it('refuses a claim for a different checkout group', async () => {
    findOrderById.mockResolvedValue(storeOrder({ checkoutGroupId: 'group-other' }));

    await expect(
      grantEligibilitiesForClaimedGuestOrder('order-1', {
        claimId: 'claim-1',
        checkoutGroupId: 'group-1',
        claimedByOxyUserId: 'buyer-1',
        bothSidesProven: true,
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.FORBIDDEN,
    );
  });

  it('NO exported path writes a claimed-guest eligibility', async () => {
    // The general statement behind the three cases above: run the ONLY other
    // grant path over a guest-shaped order and confirm nothing reaches the
    // repository with the guest evidence type. An unclaimed guest order creates
    // no author and no draft (acceptance criterion 8).
    findOrderById.mockResolvedValue(
      storeOrder({ buyerOrigin: 'guest', buyerOxyUserId: null, buyerGuestCheckoutId: 'gc-1' }),
    );

    const report = await grantEligibilitiesForOrder('order-1');

    expect(report.granted).toHaveLength(0);
    const guestWrites = insertEligibility.mock.calls.filter(
      (call) => call[0].evidenceType === 'claimed_guest_purchase',
    );
    expect(guestWrites).toHaveLength(0);
  });
});

describe('the forbidden evidence sources are refused BY NAME', () => {
  it.each([...REVIEW_FORBIDDEN_EVIDENCE_SOURCES])('refuses %s', (source) => {
    // Each one individually, so a list that lost an entry fails here rather than
    // silently stopping to refuse the thing it was written for.
    expect(() => assertNotForbiddenEvidenceSource(source)).toThrowError(
      new RegExp(`'${source}' cannot establish review eligibility`),
    );
  });

  it('does NOT refuse a real evidence type — the gate is not universal', () => {
    // Without this the assertions above pass against a function that throws on
    // everything, which would also break every legitimate grant.
    expect(() => assertNotForbiddenEvidenceSource('authenticated_purchase')).not.toThrow();
    expect(() => assertNotForbiddenEvidenceSource('claimed_guest_purchase')).not.toThrow();
  });
});

describe('resolveEligibilityToSpend — a named grant must be the caller`s own', () => {
  it('refuses an eligibility belonging to somebody else', async () => {
    findEligibilityById.mockResolvedValue({
      ...grantedRow('product', 'prod-1'),
      oxyUserId: 'someone-else',
      canonicalProductId: 'prod-1',
      targetType: 'canonical_product',
    });

    await expect(
      resolveEligibilityToSpend('buyer-1', 'product', 'canonical_product', 'prod-1', 'elig-x'),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.FORBIDDEN,
    );
  });

  it('refuses an eligibility for a different target', async () => {
    // "Spend eligibility X" must not become a way to review something else with
    // a purchase that was for something else.
    findEligibilityById.mockResolvedValue({
      ...grantedRow('product', 'prod-1'),
      canonicalProductId: 'prod-OTHER',
      targetType: 'canonical_product',
      scope: 'product',
    });

    await expect(
      resolveEligibilityToSpend('buyer-1', 'product', 'canonical_product', 'prod-1', 'elig-x'),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.FORBIDDEN,
    );
  });

  it('refuses an already-consumed eligibility', async () => {
    findEligibilityById.mockResolvedValue({
      ...grantedRow('product', 'prod-1'),
      canonicalProductId: 'prod-1',
      targetType: 'canonical_product',
      scope: 'product',
      state: 'consumed',
    });

    await expect(
      resolveEligibilityToSpend('buyer-1', 'product', 'canonical_product', 'prod-1', 'elig-x'),
    ).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.FORBIDDEN,
    );
  });

  it('picks the OLDEST open grant when the caller names none', async () => {
    findOpenEligibilitiesForTarget.mockResolvedValue([
      { ...grantedRow('product', 'prod-1'), id: 'older' },
      { ...grantedRow('product', 'prod-1'), id: 'newer' },
    ]);

    const chosen = await resolveEligibilityToSpend(
      'buyer-1',
      'product',
      'canonical_product',
      'prod-1',
      undefined,
    );

    expect(chosen?.id).toBe('older');
  });

  it('returns null when there is nothing to spend', async () => {
    findOpenEligibilitiesForTarget.mockResolvedValue([]);

    const chosen = await resolveEligibilityToSpend(
      'buyer-1',
      'product',
      'canonical_product',
      'prod-1',
      undefined,
    );

    // Not an error: the review is written UNVERIFIED and counted separately.
    expect(chosen).toBeNull();
  });
});

describe('the evidence API exposes verification status and nothing else', () => {
  it('serializes an eligibility with no contact or payment field', () => {
    // #76 privacy rule 3, at the serializer. The row has no such column, so this
    // asserts the DTO does not invent one either.
    const dto = toEligibilityDTO({
      ...grantedRow('product', 'prod-1'),
      canonicalProductId: 'prod-1',
      targetOrderItemId: null,
      targetType: 'canonical_product',
      scope: 'product',
    });

    expect(dto.evidenceType).toBe('authenticated_purchase');
    expect(dto.targetId).toBe('prod-1');
    const serialized = JSON.stringify(dto).toLowerCase();
    for (const forbidden of ['email', 'phone', 'token', 'card', 'stripe', 'wallet']) {
      expect(serialized, `the eligibility DTO leaked '${forbidden}'`).not.toContain(forbidden);
    }
  });

  it('refuses to list another buyer`s order eligibilities', async () => {
    findOrderById.mockResolvedValue(storeOrder({ buyerOxyUserId: 'someone-else' }));

    await expect(listEligibilitiesForOrder('order-1', 'buyer-1')).rejects.toSatisfy(
      (err: unknown) => isMercariaError(err) && err.code === ErrorCodes.FORBIDDEN,
    );
    expect(findEligibilitiesForOrder).not.toHaveBeenCalled();
  });
});
