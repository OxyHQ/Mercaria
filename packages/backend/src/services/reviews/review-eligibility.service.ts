/**
 * Review eligibility (#76) — turning a completed purchase into the right to
 * write reviews, and refusing to turn anything else into it.
 *
 * ## The ONE input
 *
 * {@link grantEligibilitiesForOrder} reads an ORDER and its LINES and grants
 * from those. It takes no email, no phone, no payment id, no session, no
 * referral touch and no claim it did not verify. That is not a policy this file
 * follows — it is the whole surface it exposes:
 *
 *  - `grantEligibilitiesForOrder(orderId)` — the authenticated path. Resolves
 *    the Oxy owner from `orders.buyer_oxy_user_id`, which the order service is
 *    the only writer of.
 *  - {@link grantEligibilitiesForClaimedGuestOrder} — the guest path. Requires a
 *    {@link GuestOrderClaimEvidence} it cannot synthesise, and FAILS CLOSED
 *    until #109 supplies one.
 *
 * There is no third function, and `review-eligibility-isolation.test.ts` fails
 * the build if this module or the review service ever imports the payment, the
 * referral or the guest-session domain.
 *
 * ## Which scopes one line unlocks, and why some are silently absent
 *
 * A completed line unlocks `native_transaction` always (the line IS the target),
 * plus whichever of `product`, `merchant`, `p2p_listing` and `p2p_seller` the
 * line RESOLVES to. A line whose listing has no canonical product grants no
 * product eligibility — silently, because "we do not know which product this is"
 * is not the buyer's problem and refusing the whole grant over it would cost
 * them the transaction review they can definitely write. The canonical link
 * arrives later and a re-run picks it up: every grant converges.
 *
 * ## Idempotency
 *
 * Every write goes through `insertEligibility`, whose `ON CONFLICT DO NOTHING`
 * sits on `UNIQUE(order_item_id, oxy_user_id, scope)` — #76 verification rule 11.
 * So a claim retry, a migration replay, a `paid` transition delivered twice and
 * two concurrent grants all end at exactly one row per (line, author, scope).
 */

import {
  REVIEW_ELIGIBILITY_POLICY_VERSION,
  type ReviewEligibility as ReviewEligibilityDTO,
  type ReviewEvidenceType,
  type ReviewScope,
} from '@mercaria/shared-types';
import {
  findEligibilitiesForOrder,
  findEligibilityById,
  findOpenEligibilitiesForTarget,
  findOpenEligibilitiesForUser,
  insertEligibility,
  type ReviewEligibilityRecord,
} from '../../db/reviews/reviewEligibilityRepository.js';
import {
  findOrderById,
  type OrderItemRecord,
  type OrderRecord,
} from '../../db/orders/orderRepository.js';
import { findListingsByIds } from '../../db/catalog/listingRepository.js';
import {
  findCanonicalProductIdForVariant,
  findMerchantIdForStore,
} from '../../db/reviews/reviewTargetResolver.js';
import { assertNotForbiddenEvidenceSource, scopedTarget } from './review-scope.js';
import { forbidden, notFound, validationError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';

/**
 * Order statuses that count as a completed purchase.
 *
 * The same set `review.service` has always gated on, kept here because the
 * eligibility is now the thing that carries the verdict — and because "which
 * statuses mean the goods changed hands" is one decision that must not be made
 * in two places with two different lists.
 */
const PURCHASED_STATUSES: readonly OrderRecord['status'][] = [
  'paid',
  'processing',
  'shipped',
  'delivered',
];

/**
 * What #109 must hand this module to create a guest-origin eligibility.
 *
 * This is the CONTRACT, published now so #109 implements against something
 * rather than inventing one. Every field is a fact #109's claim service already
 * establishes (ADR 0003 D14) and none of them is a contact detail:
 *
 *  - `claimId` — the durable claim record. Its existence is the proof.
 *  - `checkoutGroupId` — a claim is group-atomic, so the grant is too.
 *  - `claimedByOxyUserId` — the Oxy account the claim moved the order INTO.
 *  - `bothSidesProven` — #109's own verdict that possession of the order AND a
 *    verified Oxy session were both established in ONE request (D14). It is a
 *    boolean and not an inference, because the only party that can answer it is
 *    the claim service, and a `false` here must fail the grant rather than
 *    prompt this module to look for another way to be convinced.
 *
 * There is deliberately no email field, no portal-token field and no
 * guest-session field. #76 verification rule 9 says a matching email cannot
 * create eligibility; the way to guarantee that is for the function that creates
 * eligibility to have no parameter it could arrive in.
 */
export interface GuestOrderClaimEvidence {
  claimId: string;
  checkoutGroupId: string;
  claimedByOxyUserId: string;
  bothSidesProven: boolean;
}

/** What one grant run did, per scope. */
export interface EligibilityGrantReport {
  /** Rows this run created. A replay reports zero and is not an error. */
  granted: ReviewEligibilityRecord[];
  /** Scopes this run could not resolve a target for, and why. */
  skipped: { scope: ReviewScope; reason: string }[];
}

/** Serialize an eligibility for the wire — verification status, never evidence detail. */
export function toEligibilityDTO(row: ReviewEligibilityRecord): ReviewEligibilityDTO {
  const targetId =
    row.canonicalProductId ??
    row.merchantId ??
    row.targetOrderItemId ??
    row.listingId ??
    row.storeId ??
    row.sellerOxyUserId ??
    '';

  const dto: ReviewEligibilityDTO = {
    id: row.id,
    oxyUserId: row.oxyUserId,
    orderId: row.orderId,
    orderItemId: row.orderItemId,
    scope: row.scope,
    targetType: row.targetType,
    targetId,
    evidenceType: row.evidenceType,
    state: row.state,
    policyVersion: row.policyVersion,
    createdAt: row.createdAt.toISOString(),
  };
  if (row.claimId) dto.claimId = row.claimId;
  if (row.consumedAt) dto.consumedAt = row.consumedAt.toISOString();
  if (row.revokedAt) dto.revokedAt = row.revokedAt.toISOString();
  if (row.revokedReason) dto.revokedReason = row.revokedReason;
  if (row.disputedAt) dto.disputedAt = row.disputedAt.toISOString();
  return dto;
}

/** Every scope one order line resolves to, with the target each names. */
async function resolveScopesForLine(
  order: OrderRecord,
  item: OrderItemRecord,
): Promise<{
  resolved: { scope: ReviewScope; targetId: string }[];
  skipped: EligibilityGrantReport['skipped'];
}> {
  const resolved: { scope: ReviewScope; targetId: string }[] = [];
  const skipped: EligibilityGrantReport['skipped'] = [];

  // The line is always its own transaction target. Nothing to resolve.
  resolved.push({ scope: 'native_transaction', targetId: item.id });

  // The VARIANT and not the listing: a barcode identifies one exact purchasable
  // configuration, and the line already names the one that was bought.
  const canonicalProductId = await findCanonicalProductIdForVariant(item.variantId);
  if (canonicalProductId) {
    resolved.push({ scope: 'product', targetId: canonicalProductId });
  } else {
    skipped.push({
      scope: 'product',
      reason: 'the purchased variant resolves to no canonical product',
    });
  }

  if (order.sellerType === 'store' && order.storeId) {
    const merchantId = await findMerchantIdForStore(order.storeId);
    if (merchantId) {
      resolved.push({ scope: 'merchant', targetId: merchantId });
    } else {
      skipped.push({
        scope: 'merchant',
        reason: 'the selling store resolves to no canonical merchant',
      });
    }
  } else if (order.sellerType === 'user' && order.sellerOxyUserId) {
    // A P2P purchase: the person is reviewable as a seller, and the listing as
    // a used item. Those are two different questions about the same purchase,
    // which is exactly why they are two scopes.
    resolved.push({ scope: 'p2p_seller', targetId: order.sellerOxyUserId });
    const [listing] = await findListingsByIds([item.listingId]);
    if (listing) {
      resolved.push({ scope: 'p2p_listing', targetId: listing.id });
    } else {
      skipped.push({ scope: 'p2p_listing', reason: 'the purchased listing no longer exists' });
    }
  }

  return { resolved, skipped };
}

/** The shared body of both grant paths. */
async function grantForOrder(
  order: OrderRecord,
  oxyUserId: string,
  evidenceType: ReviewEvidenceType,
  claimId: string | undefined,
): Promise<EligibilityGrantReport> {
  assertNotForbiddenEvidenceSource(evidenceType);

  if (!(PURCHASED_STATUSES as readonly string[]).includes(order.status)) {
    throw forbidden('That order is not a completed purchase');
  }

  const granted: ReviewEligibilityRecord[] = [];
  const skipped: EligibilityGrantReport['skipped'] = [];

  for (const item of order.items) {
    const perLine = await resolveScopesForLine(order, item);
    skipped.push(...perLine.skipped);

    for (const { scope, targetId } of perLine.resolved) {
      const target = scopedTarget(scope, targetId);
      const row = await insertEligibility({
        oxyUserId,
        orderId: order.id,
        orderItemId: item.id,
        scope: target.scope,
        targetType: target.targetType,
        targetId: target.targetId,
        evidenceType,
        ...(claimId ? { claimId } : {}),
        policyVersion: REVIEW_ELIGIBILITY_POLICY_VERSION,
      });
      // `null` is a REPLAY, not a failure: the grant already existed and the
      // unique index converged. Rule 11 is satisfied by that being unremarkable.
      if (row) granted.push(row);
    }
  }

  return { granted, skipped };
}

/**
 * Grant every eligibility a completed AUTHENTICATED order earns.
 *
 * The author is read off the ORDER (`buyer_oxy_user_id`) and never passed in:
 * a caller-supplied author is an attribution forgery, and the order service is
 * the only writer of that column.
 *
 * Idempotent and safe to call from the `paid` transition, from a backfill and
 * from an operator repair — all three converge on the same rows.
 */
export async function grantEligibilitiesForOrder(
  orderId: string,
): Promise<EligibilityGrantReport> {
  const order = await findOrderById(orderId);
  if (!order) throw notFound('Order not found');

  if (!order.buyerOxyUserId || order.buyerOxyUserId.startsWith('ext:')) {
    // A connector-imported order carries an external buyer reference in that
    // column, not an Oxy account. There is nobody to grant to, and inventing
    // somebody is the failure mode this whole domain exists to prevent.
    return { granted: [], skipped: [] };
  }

  return grantForOrder(order, order.buyerOxyUserId, 'authenticated_purchase', undefined);
}

/**
 * Grant eligibility for a guest order a #109 claim moved into an Oxy account.
 *
 * ## This FAILS CLOSED and is meant to
 *
 * #109 is not implemented. Until it is, there is no `guest_order_claims` table,
 * no claim service and therefore no way to obtain a {@link GuestOrderClaimEvidence}
 * whose `bothSidesProven` this module did not fabricate — and this module
 * fabricates nothing. Every guard below refuses, in order, and the last of them
 * refuses unconditionally:
 *
 *  1. `bothSidesProven` must be true. #109's claim service is the only thing
 *     that can set it, because it is the only thing that sees both proofs in one
 *     request (ADR 0003 D14).
 *  2. The claim id must be non-empty and the order must actually belong to the
 *     claimed checkout group.
 *  3. The order must carry a guest origin. It cannot today — `orders` has no
 *     `buyer_origin` column until #105/#106 add it — so the check reads the
 *     absence honestly and refuses rather than assuming an order with a NULL
 *     buyer is a guest's.
 *
 * `review-eligibility.test.ts` pins that an unclaimed guest order produces
 * ZERO eligibilities through EVERY exported path, and that this one refuses even
 * when handed a well-formed-looking evidence object.
 */
export async function grantEligibilitiesForClaimedGuestOrder(
  orderId: string,
  evidence: GuestOrderClaimEvidence,
): Promise<EligibilityGrantReport> {
  if (!evidence.bothSidesProven) {
    throw forbidden(
      'A guest-origin review eligibility requires BOTH order possession and a verified Oxy ' +
        'session proven in one request (ADR 0003 D14). Neither an email match nor possession ' +
        'of a portal link is sufficient on its own.',
    );
  }
  if (!evidence.claimId.trim() || !evidence.claimedByOxyUserId.trim()) {
    throw validationError('A guest-origin eligibility requires a claim id and a claiming Oxy account');
  }

  const order = await findOrderById(orderId);
  if (!order) throw notFound('Order not found');
  if (order.checkoutGroupId !== evidence.checkoutGroupId) {
    throw forbidden('That order does not belong to the claimed checkout group');
  }

  /**
   * The seam, stated as a refusal rather than as a comment.
   *
   * `orders` has no `buyer_origin` column and no `claimed_by_oxy_user_id`
   * column: #105/#106 add the first and #109 writes the second. Until both
   * exist this module cannot tell a guest-origin order from any other, and
   * granting on an unverifiable premise is precisely the failure #76 acceptance
   * criteria 8 and 9 describe. So it refuses — loudly, naming the issue that
   * closes it — and no code path can reach `insertEligibility` with
   * `evidence_type = 'claimed_guest_purchase'`.
   */
  log.general.warn(
    { orderId, claimId: evidence.claimId },
    'Guest-origin review eligibility requested before #109 landed; refusing (fail closed)',
  );
  throw forbidden(
    'Guest-origin review eligibility is not available yet. It requires the guest order-claim ' +
      'record (#109) and the order buyer-origin columns (#106); until both exist Mercaria ' +
      'cannot verify that this order began as a guest purchase, and it will not guess.',
  );
}

/**
 * The eligibility a review is about to spend: either the one the client named,
 * or the author's oldest OPEN grant for this scope and target.
 *
 * A named eligibility is checked to belong to the author AND to match the scope
 * and target — otherwise "spend eligibility X" would be a way to write a review
 * of something else entirely with somebody else's purchase behind it.
 */
export async function resolveEligibilityToSpend(
  authorOxyUserId: string,
  scope: ReviewScope,
  targetType: ReviewEligibilityDTO['targetType'],
  targetId: string,
  eligibilityId: string | undefined,
): Promise<ReviewEligibilityRecord | null> {
  if (eligibilityId) {
    const row = await findEligibilityById(eligibilityId);
    if (
      !row ||
      row.oxyUserId !== authorOxyUserId ||
      row.scope !== scope ||
      row.targetType !== targetType ||
      row.state !== 'open'
    ) {
      throw forbidden('That review eligibility is not available');
    }
    const rowTargetId =
      row.canonicalProductId ??
      row.merchantId ??
      row.targetOrderItemId ??
      row.listingId ??
      row.storeId ??
      row.sellerOxyUserId;
    if (rowTargetId !== targetId) {
      throw forbidden('That review eligibility is for a different target');
    }
    return row;
  }

  const [oldest] = await findOpenEligibilitiesForTarget(
    authorOxyUserId,
    scope,
    targetType,
    targetId,
  );
  return oldest ?? null;
}

/** Everything this account may still review — the order-history surface's read. */
export async function listOpenEligibilities(
  oxyUserId: string,
  limit: number,
): Promise<ReviewEligibilityDTO[]> {
  const rows = await findOpenEligibilitiesForUser(oxyUserId, limit);
  return rows.map(toEligibilityDTO);
}

/**
 * Every eligibility one order produced — the evidence API.
 *
 * It exposes VERIFICATION STATUS and nothing else (#76 privacy rule 3):
 * {@link toEligibilityDTO} carries the scope, the target, the evidence TYPE and
 * the state. It carries no email, no phone, no payment identifier and no portal
 * token, because no such column exists to serialize.
 */
export async function listEligibilitiesForOrder(
  orderId: string,
  requesterOxyUserId: string,
): Promise<ReviewEligibilityDTO[]> {
  const order = await findOrderById(orderId);
  if (!order) throw notFound('Order not found');
  if (order.buyerOxyUserId !== requesterOxyUserId) {
    throw forbidden('That order is not yours');
  }
  const rows = await findEligibilitiesForOrder(orderId);
  return rows.map(toEligibilityDTO);
}
