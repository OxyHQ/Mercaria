/**
 * The guest-commerce operator diagnostic (#104 idempotency requirements 7–8).
 *
 * Two reads, no writes, no mutation of any kind. Everything here is behind
 * `requireGuestOperator`, which is the whole of the authorization.
 *
 * ## What it deliberately cannot expose
 *
 * A guest credential, in any form. The token exists only in the client's
 * storage and in a `Set-Cookie`; the server keeps a SHA-256 that no query here
 * reads, `cart_merges` has no column that could hold one, and the two handles
 * this surface accepts — a guest session ROW id and an Oxy account id — are
 * audit handles that authorize nothing. Possession of a token is what
 * authorizes a guest, and there is no path from an id back to a token.
 *
 * Cart CONTENTS are equally absent. The merge audit records counts and bounded
 * reason codes, so an operator can answer "did this person's cart merge, and
 * what did it do to their lines" without learning what anyone is buying (#104
 * merge requirement 12).
 */

import type { Request, Response } from 'express';
import { config } from '../config/index.js';
import { countOwnerlessCarts } from '../db/buyers/cartRepository.js';
import { findCartMerges } from '../db/guests/cartMergeRepository.js';
import { findConvertedSessionsWithCarts } from '../db/guests/guestSessionRepository.js';
import { readBuyerIdentityConsistency } from '../db/orders/orderRepository.js';
import { getDb } from '../db/postgres.js';
import { log } from '../lib/logger.js';
import { sendError, sendSuccess, ErrorCodes } from '../utils/api-response.js';

/** Hard ceiling on rows a single diagnostic call returns. */
const MAX_ROWS = 100;

/** The inconsistency sample an operator sees; bounded so a bad day stays readable. */
const MAX_INCONSISTENCY_SAMPLE = 50;

/**
 * GET /internal/guest-commerce/cart-merges — the merges for ONE correlation id.
 *
 * Keyed by `guestSessionId` or `oxyUserId`; at least one is required, so this
 * is a trace and never a dump of everyone's merges.
 */
export async function listCartMergesHandler(req: Request, res: Response): Promise<void> {
  const guestSessionId = typeof req.query.guestSessionId === 'string' ? req.query.guestSessionId : undefined;
  const oxyUserId = typeof req.query.oxyUserId === 'string' ? req.query.oxyUserId : undefined;

  if (guestSessionId === undefined && oxyUserId === undefined) {
    sendError(
      res,
      ErrorCodes.VALIDATION_ERROR,
      'One of guestSessionId or oxyUserId is required',
      400,
    );
    return;
  }

  try {
    const rows = await findCartMerges(
      {
        ...(guestSessionId === undefined ? {} : { guestSessionId }),
        ...(oxyUserId === undefined ? {} : { oxyUserId }),
      },
      MAX_ROWS,
    );
    // The projection NAMES every field (the payment status-projection rule), so
    // a column added to `cart_merges` later cannot leak by being picked up
    // automatically.
    sendSuccess(
      res,
      rows.map((row) => ({
        id: row.id,
        guestSessionId: row.guestSessionId,
        oxyUserId: row.oxyUserId,
        targetCartId: row.targetCartId,
        linesAdded: row.linesAdded,
        linesCombined: row.linesCombined,
        linesClamped: row.linesClamped,
        linesFlagged: row.linesFlagged,
        discountCodesAdded: row.discountCodesAdded,
        discountCodesDropped: row.discountCodesDropped,
        reasons: row.reasons,
        createdAt: row.createdAt.toISOString(),
      })),
    );
  } catch (err) {
    log.guest.error({ err }, 'Failed to read cart merges');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to read cart merges', 500);
  }
}

/**
 * GET /internal/guest-commerce/consistency — the two ownership invariants that
 * no single CHECK can express, counted.
 *
 * Both should always answer zero, and both are worth asking precisely because
 * they span rows the database cannot compare in a constraint:
 *
 *  - **Converted sessions still owning a cart.** A merge deletes the guest cart
 *    in the same transaction that converts its session, so a hit means a
 *    conversion committed without draining — the one failure mode the
 *    all-or-nothing transaction is designed to make impossible.
 *  - **Ownerless carts.** `carts_owner_exclusivity_check` forbids them outright,
 *    so this is a cheap assertion that the constraint is present and validated
 *    rather than a check on the application.
 *  - **The four buyer-identity invariants** (#106). `orders_buyer_identity_check`
 *    sees ONE row, so it catches every illegal COMBINATION and none of these:
 *    a misclassified connector origin, a checkout group whose siblings disagree
 *    about their buyer, a PARTIALLY claimed group, and a guest contact with no
 *    order. See `readBuyerIdentityConsistency` for what each one means.
 *
 * Guest CART enablement is reported too: an operator reading a zero merge count
 * during an incident should be able to see whether the flag is simply off.
 */
export async function guestCommerceConsistencyHandler(_req: Request, res: Response): Promise<void> {
  try {
    const [convertedWithCarts, ownerlessCarts, buyerIdentity] = await Promise.all([
      findConvertedSessionsWithCarts(getDb(), MAX_INCONSISTENCY_SAMPLE),
      countOwnerlessCarts(),
      readBuyerIdentityConsistency(),
    ]);

    sendSuccess(res, {
      guestCommerceEnabled: config.guest.enabled,
      guestCartEnabled: config.guest.cartEnabled,
      guestSessionIssuanceEnabled: config.guest.issuanceEnabled,
      convertedSessionsWithCarts: convertedWithCarts.length,
      // Row IDS, never cart contents — enough to open a trace, nothing more.
      convertedSessionsWithCartsSample: convertedWithCarts,
      ownerlessCarts,
      /**
       * The four cross-row buyer invariants (#106 migration rule 10,
       * acceptance 9). All should read zero; each carries a bounded sample of
       * order ids or checkout group ids so an operator can open a trace.
       *
       * Order ids and checkout group ids only — no buyer id, no claimant, no
       * contact in any form. "Which orders are inconsistent" is answerable
       * without "who bought them", and this surface asks only the first.
       */
      buyerIdentity,
      sampleLimit: MAX_INCONSISTENCY_SAMPLE,
    });
  } catch (err) {
    log.guest.error({ err }, 'Failed to run the guest-commerce consistency check');
    sendError(res, ErrorCodes.INTERNAL_ERROR, 'Failed to run the consistency check', 500);
  }
}
