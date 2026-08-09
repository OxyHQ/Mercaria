/**
 * The guest→Oxy cart merge (#104, ADR 0003 D2/D3 and diagram 3).
 *
 * ONE transaction, entered only from `POST /cart/merge`, which is the only
 * consumer of `OxyActor.presentedGuestSessionId` besides #109's claim. Nothing
 * merges implicitly: signing in does not silently absorb a cart, because a
 * person who signed in on a shared device may not want the basket that was on
 * it, and an implicit merge is unrefusable.
 *
 * ## Why the whole thing is one transaction
 *
 * #104 asks for two things that are the same requirement seen from two sides:
 * "mark the guest session converted only AFTER the cart merge commits" and "a
 * failed merge leaves both carts recoverable and the guest session active". A
 * multi-step merge satisfies neither — a crash between draining the guest cart
 * and stamping the conversion loses the items, and a crash the other way leaves
 * a revoked session holding a cart nobody can reach. Inside one transaction the
 * conversion stamp is the LAST statement and rolls back with everything else,
 * so both properties hold for the same structural reason.
 *
 * ## Exactly once, under concurrent retries — THREE mechanisms, measured
 *
 * `SELECT … FOR UPDATE` on the `guest_sessions` row is the stated
 * serialization point: the second attempt blocks there and, under READ
 * COMMITTED, re-evaluates against the winner's committed row when the lock is
 * granted — so it reads `converted_at` as SET and converges on the recorded
 * outcome instead of merging again. The same `FOR UPDATE` on the GUEST CART row
 * is the second, and `UNIQUE(cart_merges.guest_session_id)` the third.
 *
 * Worth stating precisely, because it was mutation-tested rather than assumed:
 * the two row locks are INDEPENDENTLY sufficient for the concurrent-merge case.
 * Removing only the session lock leaves `cart-merge.realdb.test.ts` green — the
 * loser then blocks on the guest cart instead, finds it deleted, and merges
 * nothing. Removing BOTH makes the race test fail with a doubled quantity (6
 * where 3 is correct), which is what says the test is not vacuous. Neither lock
 * is therefore redundant in the sense of being removable: the session lock is
 * the one that states the invariant at the level the invariant lives at ("one
 * merge per session"), and it is the only one that still holds when there is no
 * guest cart to lock at all.
 *
 * `insertCartMerge`'s `DO NOTHING` is what turns a lost race into convergence
 * rather than a 500 at a buyer who tapped twice.
 *
 * ## What this service deliberately does NOT touch
 *
 * No payment module, no order module, no referral module — and that is asserted
 * by `__tests__/cart-merge-isolation.test.ts` rather than left to good
 * intentions:
 *
 *  - **Payments (#104 merge requirement 14, conflict cases 8 and 12).** Signing
 *    in cannot replace an in-flight payment attempt because there is no code
 *    path from here to one. Guest CHECKOUT is #105–#107 and does not exist yet;
 *    when it does, an in-flight attempt is bound to its own
 *    `guest_checkouts`/`payments` rows keyed on a checkout group, not to the
 *    cart, so a merge cannot reach it then either.
 *  - **Inventory (idempotency requirement 5).** Nothing here reserves stock.
 *    Live availability is read to CLAMP a quantity and is never decremented;
 *    reservation remains checkout's, at checkout time.
 *  - **Discount redemption (idempotency requirement 4).** Codes are carried as
 *    INTENT — the same non-authoritative pending list the cart already had — and
 *    no usage counter is incremented. Checkout revalidates and is authoritative.
 *  - **Referral attribution (merge requirement 13, conflict case 11).** #141 and
 *    #143 own attribution entirely. The merge creates none, resolves none and
 *    extends no window; a guest's attribution conflicting with an account's is
 *    settled in that domain, and cart contents, prices and checkout authority
 *    are unaffected either way.
 */

import type {
  Cart as CartDTO,
  CartLineReviewReason,
  CartMergeReasonCode,
  CartMergeResult,
  CurrencyCode,
} from '@mercaria/shared-types';
import { CART_MERGE_REASON_CODES } from '@mercaria/shared-types';
import { config } from '../config/index.js';
import { getDb, type DatabaseOrTransaction } from '../db/postgres.js';
import {
  deleteCart,
  ensureCart,
  findCartByOwner,
  findCartByOwnerForUpdate,
  mergeCartItem,
  setPendingDiscountCodes,
  type CartItemRow,
  type CartOwner,
  type CartRecord,
} from '../db/buyers/cartRepository.js';
import {
  findCartMergeByGuestSession,
  insertCartMerge,
  type CartMergeRow,
} from '../db/guests/cartMergeRepository.js';
import {
  convertGuestSession,
  findGuestSessionByIdForUpdate,
} from '../db/guests/guestSessionRepository.js';
import { findListingsByIds, type ListingRecord } from '../db/catalog/listingRepository.js';
import { findVariantsByIds, type VariantRecord } from '../db/catalog/variantRepository.js';
import { log } from '../lib/logger.js';
import { discountCodeAppliesToCart, getCart, type CartView } from './cart.service.js';

/** The counts a merge accumulates, before they become a `cart_merges` row. */
interface MergeCounts {
  linesAdded: number;
  linesCombined: number;
  linesClamped: number;
  linesFlagged: number;
  discountCodesAdded: number;
  discountCodesDropped: number;
}

/** What the transaction decided, before the cart is hydrated for the response. */
interface MergeVerdict extends MergeCounts {
  merged: boolean;
  reasons: CartMergeReasonCode[];
}

/** The two clamp reasons, so a caller can ask "was this line clamped?" once. */
const CLAMP_REASONS: readonly CartLineReviewReason[] = [
  'quantity_clamped_to_stock',
  'quantity_clamped_to_limit',
];

/**
 * A `cart_merges` row read back as the verdict a retry converges on, plus
 * `already_converted` so the caller can tell convergence from a fresh merge in
 * the reason list as well as in the `merged` flag.
 */
function verdictFromRow(row: CartMergeRow): MergeVerdict {
  return {
    merged: false,
    linesAdded: row.linesAdded,
    linesCombined: row.linesCombined,
    linesClamped: row.linesClamped,
    linesFlagged: row.linesFlagged,
    discountCodesAdded: row.discountCodesAdded,
    discountCodesDropped: row.discountCodesDropped,
    reasons: dedupeReasons([...row.reasons.filter(isMergeReason), 'already_converted']),
  };
}

/**
 * Decide ONE guest line's fate against live catalogue state.
 *
 * The revalidation #104 merge requirement 5 asks for, in one place: listing
 * status, variant identity and current availability. Note what it does NOT do —
 * drop the line. Every branch produces a line that survives, flagged when it
 * could not survive unchanged, because "no item disappears silently during
 * merge" is an acceptance criterion and a dropped line is exactly that.
 */
function planLine(
  line: CartItemRow,
  variant: VariantRecord | undefined,
  listing: ListingRecord | undefined,
): {
  listingId: string;
  quantity: number;
  quantityCeiling: number;
  conflictReason: CartLineReviewReason;
  insertReason: CartLineReviewReason | null;
} | null {
  if (!variant || !listing) {
    // Both `cart_items.variant_id` and `cart_items.listing_id` cascade on
    // delete, so a stored line always has both rows. Reaching here means the
    // catalogue changed under this very transaction; skipping is the only
    // honest answer and is counted as an unavailable line by the caller.
    return null;
  }

  const cap = variant.inventoryTracked
    ? Math.min(config.cart.maxQuantityPerItem, variant.inventoryAvailable)
    : config.cart.maxQuantityPerItem;
  // Floored at one: a zero-quantity line is unrepresentable
  // (`cart_items_quantity_check`), so a zero ceiling would force the merge to
  // DROP an out-of-stock line. One unit flagged `listing_unavailable` is the
  // visible review state instead — hydration marks it `stale` against the live
  // stock and checkout refuses stale lines, so keeping it oversells nothing.
  const quantityCeiling = Math.max(1, cap);

  const unavailable = listing.status !== 'active' || cap <= 0;
  const remapped = variant.listingId !== line.listingId;

  // Precedence: "you cannot buy this" outranks "it moved", which outranks "you
  // got fewer than you asked for" — most actionable first, one reason per line.
  const lineCondition: CartLineReviewReason | null = unavailable
    ? 'listing_unavailable'
    : remapped
      ? 'listing_remapped'
      : null;
  const clampReason: CartLineReviewReason =
    variant.inventoryTracked && cap < config.cart.maxQuantityPerItem
      ? 'quantity_clamped_to_stock'
      : 'quantity_clamped_to_limit';

  const quantity = Math.min(line.quantity, quantityCeiling);
  return {
    // The variant's CURRENT owning listing, not the id the line recorded —
    // which is how a line whose listing was remapped follows the remap instead
    // of pointing at a listing that no longer sells it (conflict case 5).
    listingId: variant.listingId,
    quantity,
    quantityCeiling,
    // What to write if the SUM overflows in SQL: the line's own condition when
    // it has one, so an unavailable-AND-clamped line keeps the better reason.
    conflictReason: lineCondition ?? clampReason,
    insertReason: lineCondition ?? (quantity < line.quantity ? clampReason : null),
  };
}

/**
 * Merge the guest cart owned by `guestSessionId` into `oxyUserId`'s cart.
 *
 * The caller has already proven possession of the guest credential: the
 * resolver only surfaces `presentedGuestSessionId` for a credential that
 * RESOLVED, so this service never sees a session id a client merely named.
 *
 * @returns the verdict plus the resulting authenticated cart, hydrated after
 *   the transaction so the buyer sees live prices for what they now hold.
 */
export async function mergeGuestCart(input: {
  guestSessionId: string;
  oxyUserId: string;
  requestedCurrency?: CurrencyCode;
}): Promise<CartMergeResult> {
  const view: CartView = {
    owner: { kind: 'oxy_user', oxyUserId: input.oxyUserId },
    ...(input.requestedCurrency === undefined ? {} : { requestedCurrency: input.requestedCurrency }),
  };

  const verdict = await getDb().transaction((tx) => runMerge(tx, input));
  const cart: CartDTO = await getCart(view);

  log.guest.info(
    {
      guestSessionId: input.guestSessionId,
      merged: verdict.merged,
      linesAdded: verdict.linesAdded,
      linesCombined: verdict.linesCombined,
      linesClamped: verdict.linesClamped,
      linesFlagged: verdict.linesFlagged,
      discountCodesAdded: verdict.discountCodesAdded,
      discountCodesDropped: verdict.discountCodesDropped,
      reasons: verdict.reasons,
    },
    '[Guest] cart merge',
  );

  return {
    merged: verdict.merged,
    linesAdded: verdict.linesAdded,
    linesCombined: verdict.linesCombined,
    linesClamped: verdict.linesClamped,
    linesFlagged: verdict.linesFlagged,
    discountCodesAdded: verdict.discountCodesAdded,
    discountCodesDropped: verdict.discountCodesDropped,
    reasons: verdict.reasons,
    // True on both paths: the session is revoked by the merge that ran, and it
    // was already revoked when a retry converges. Either way the client must
    // discard its credential, so answering `false` on the retry would be the
    // one case where the instruction is wrong.
    guestCredentialRevoked: true,
    cart,
  };
}

/** The transaction body. Everything below commits together or not at all. */
async function runMerge(
  tx: DatabaseOrTransaction,
  input: { guestSessionId: string; oxyUserId: string },
): Promise<MergeVerdict> {
  // (1) Serialize on the session row. Every concurrent attempt for this session
  // queues here, which is what makes the conversion check below authoritative.
  const session = await findGuestSessionByIdForUpdate(tx, input.guestSessionId);
  if (!session) {
    // The resolver validated the credential moments ago; a row that has since
    // vanished can only be the retention sweep, and there is nothing to merge.
    return emptyVerdict(['no_guest_cart']);
  }

  if (session.convertedAt !== null) {
    // (2) Already merged — conflict case 9, and the retry path of diagram 3.
    // The recorded row IS the same result, which is what idempotency means
    // here. (A session converted by #109's CLAIM rather than by a merge has no
    // row; the empty verdict is then the truthful answer.)
    const existing = await findCartMergeByGuestSession(tx, input.guestSessionId);
    return existing ? verdictFromRow(existing) : emptyVerdict(['already_converted']);
  }

  // (3) Lock BOTH carts (#104 merge requirement 1). The guest cart first, then
  // the target: two merges into one authenticated cart hold different session
  // locks and queue on the target in turn, so there is no cycle to deadlock on.
  const guestCart = await findCartByOwnerForUpdate(
    { kind: 'guest_session', guestSessionId: input.guestSessionId },
    tx,
  );

  const targetOwner = { kind: 'oxy_user', oxyUserId: input.oxyUserId } as const;
  await ensureCart(targetOwner, tx);
  const targetCart = await findCartByOwnerForUpdate(targetOwner, tx);
  if (!targetCart) {
    throw new Error('mergeGuestCart could not lock the authenticated cart it just ensured');
  }

  const counts: MergeCounts = {
    linesAdded: 0,
    linesCombined: 0,
    linesClamped: 0,
    linesFlagged: 0,
    discountCodesAdded: 0,
    discountCodesDropped: 0,
  };
  const reasons: CartMergeReasonCode[] = [];

  if (!guestCart) {
    reasons.push('no_guest_cart');
  } else if (guestCart.items.length === 0) {
    reasons.push('guest_cart_empty');
  } else {
    await moveLines(tx, guestCart, targetCart.id, counts, reasons);
  }

  if (guestCart) {
    await carryDiscountCodes(tx, targetOwner, guestCart, targetCart, counts, reasons);
    // (4) The drained cart GOES, rather than being emptied: its owner is
    // revoked in this same transaction, and an empty cart still pointing at a
    // converted session is precisely the inconsistency the operator check hunts.
    await deleteCart(guestCart.id, tx);
  }

  // (5) The audit row, with FINAL counts — written once, never updated, so a
  // crashed merge leaves no half-counted row to reconcile.
  const recorded = await insertCartMerge(tx, {
    guestSessionId: input.guestSessionId,
    oxyUserId: input.oxyUserId,
    targetCartId: targetCart.id,
    ...counts,
    reasons: dedupeReasons(reasons),
  });
  if (!recorded) {
    // Unreachable while the session lock above is held; if a future refactor
    // drops it, converging on the recorded row is still the right answer.
    const existing = await findCartMergeByGuestSession(tx, input.guestSessionId);
    return existing ? verdictFromRow(existing) : emptyVerdict(['already_converted']);
  }

  // (6) LAST: the conversion stamp, which also revokes (ADR 0003 D3 — sign-in
  // revokes a guest session rather than upgrading it). It is last on purpose:
  // "converted only after the cart merge commits", and it rolls back with
  // everything above if anything here fails.
  await convertGuestSession(tx, {
    id: input.guestSessionId,
    oxyUserId: input.oxyUserId,
    now: new Date(),
  });

  return { merged: true, ...counts, reasons: dedupeReasons(reasons) };
}

/** Move every guest line into the target cart, revalidating each against the catalogue. */
async function moveLines(
  tx: DatabaseOrTransaction,
  guestCart: CartRecord,
  targetCartId: string,
  counts: MergeCounts,
  reasons: CartMergeReasonCode[],
): Promise<void> {
  const [variants, listings] = await Promise.all([
    findVariantsByIds(guestCart.items.map((i) => i.variantId)),
    findListingsByIds(guestCart.items.map((i) => i.listingId)),
  ]);
  const variantById = new Map(variants.map((v) => [v.id, v]));
  // Keyed by the VARIANT's current listing, not the line's stored one, so a
  // remapped line is validated against the listing that actually sells it.
  const listingById = new Map(listings.map((l) => [l.id, l]));
  const remappedListings = await findListingsByIds(
    variants.flatMap((v) => (listingById.has(v.listingId) ? [] : [v.listingId])),
  );
  for (const listing of remappedListings) {
    listingById.set(listing.id, listing);
  }

  for (const line of guestCart.items) {
    const variant = variantById.get(line.variantId);
    const plan = planLine(line, variant, variant ? listingById.get(variant.listingId) : undefined);
    if (!plan) {
      counts.linesFlagged += 1;
      reasons.push('listing_unavailable');
      continue;
    }

    const outcome = await mergeCartItem(
      targetCartId,
      {
        listingId: plan.listingId,
        variantId: line.variantId,
        quantity: plan.quantity,
        quantityCeiling: plan.quantityCeiling,
        conflictReason: plan.conflictReason,
        insertReason: plan.insertReason,
        addedAt: line.addedAt,
      },
      tx,
    );

    if (outcome.combined) {
      counts.linesCombined += 1;
    } else {
      counts.linesAdded += 1;
    }
    // The DATABASE's verdict, not a re-derivation: the clamp and the flag are
    // decided by one SQL expression, so reading the flag back is the only
    // account that survives a concurrent add from another device.
    if (outcome.reviewReason !== null) {
      counts.linesFlagged += 1;
      reasons.push(outcome.reviewReason);
      if (CLAMP_REASONS.includes(outcome.reviewReason)) {
        counts.linesClamped += 1;
      }
    }
  }
}

/**
 * Carry the guest cart's pending discount codes across CONSERVATIVELY.
 *
 * Conservative means three things, all of them refusals: the authenticated
 * cart's own codes are never displaced; a guest code is added only if it still
 * names an active, in-window discount for a store the MERGED cart actually buys
 * from; and nothing here increments a redemption counter, because a merge is
 * not a purchase. A code that does not survive is DROPPED with a reason rather
 * than carried and failed at the till.
 *
 * The result stays non-authoritative in any case — the cart preview says so and
 * checkout reprices from scratch (#104 preserved invariant 6).
 */
async function carryDiscountCodes(
  tx: DatabaseOrTransaction,
  targetOwner: CartOwner,
  guestCart: CartRecord,
  targetCart: CartRecord,
  counts: MergeCounts,
  reasons: CartMergeReasonCode[],
): Promise<void> {
  const incoming = guestCart.pendingDiscountCodes.filter(
    (code) => !targetCart.pendingDiscountCodes.includes(code),
  );
  if (incoming.length === 0) return;

  // Revalidated against the cart as it now stands — the target's lines plus
  // everything just merged in — which is the only set the codes will be priced
  // against. Read inside the transaction so it sees this merge's own writes.
  const merged = await findCartByOwner(targetOwner, tx);
  if (!merged) return;

  const kept: string[] = [];
  for (const code of incoming) {
    const applies = await discountCodeAppliesToCart(merged, code);
    if (applies === true) {
      kept.push(code);
    } else {
      counts.discountCodesDropped += 1;
      reasons.push('discount_code_dropped');
    }
  }

  if (kept.length > 0) {
    counts.discountCodesAdded = kept.length;
    await setPendingDiscountCodes(
      targetCart.id,
      [...targetCart.pendingDiscountCodes, ...kept],
      tx,
    );
  }
}

/** A verdict that changed nothing, carrying only why. */
function emptyVerdict(reasons: CartMergeReasonCode[]): MergeVerdict {
  return {
    merged: false,
    linesAdded: 0,
    linesCombined: 0,
    linesClamped: 0,
    linesFlagged: 0,
    discountCodesAdded: 0,
    discountCodesDropped: 0,
    reasons,
  };
}

/**
 * Narrow a stored reason string to the closed vocabulary.
 *
 * `cart_merges_reasons_check` constrains the column to this exact tuple, so the
 * filter never drops anything in practice — it is what makes the column's
 * `string[]` the union for the COMPILER too, without a cast that would let a
 * future vocabulary change go unnoticed.
 */
function isMergeReason(value: string): value is CartMergeReasonCode {
  return (CART_MERGE_REASON_CODES as readonly string[]).includes(value);
}

/** Deduplicate and sort, so two identical merges answer identically. */
function dedupeReasons(reasons: readonly CartMergeReasonCode[]): CartMergeReasonCode[] {
  return [...new Set(reasons)].sort();
}
