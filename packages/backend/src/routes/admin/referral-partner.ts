/**
 * `/admin/stores/:storeId/referral-partner/*` — a STORE's referral partner
 * record (#146 increment 2).
 *
 * The `store` half of the two-mount split, and the whole of how this domain
 * answers "which Oxy account may act for this store": it does not.
 * `loadStore` has already read the store and the caller's membership, and
 * `requireStorePermission('store:manage')` has already refused anybody without
 * it, before a referral module runs. `req.store.id` is that answer, handed to
 * the shared partner router as its owner.
 *
 * That is what closes increment 1's stated reason for leaving the tax
 * questionnaire unmounted — "which Oxy account may declare for a `store`
 * partner is the `store:manage` question #85 answers, and answering it here
 * would be a second answer". Taking #85's own two-mount shape means the
 * question is answered in NEITHER half of the referral domain, by the
 * middleware every other `/admin/stores/:storeId` surface already uses.
 *
 * `store:manage` rather than `settings:write`, for the reason payment
 * onboarding (#46), the fee schedule (#88) and activation (#85) all use it:
 * it is the one permission an `admin` does not hold, and binding a business
 * into a commercial arrangement that will pay it money is that kind of act.
 * A referral partner record is also PUBLIC-facing — the display name appears on
 * disclosure surfaces — so it is not a settings toggle.
 */

import { Router } from 'express';
import { makeRateLimiter } from '../../lib/rate-limit.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import { makeReferralPartnerRouter } from '../../controllers/referral-partner.controller.js';
import { notFound } from '../../lib/errors/error-codes.js';

const router = Router({ mergeParams: true });

// The SAME bucket the self mount uses: one partner enrollment surface, one
// budget, whichever door it is reached through.
router.use(
  makeRateLimiter('referral-partner', { authenticatedMax: 300 }),
  requireStorePermission('store:manage'),
);

router.use(
  '/',
  makeReferralPartnerRouter((req) => {
    const store = req.store;
    // `loadStore` runs above this in `routes/admin/stores.ts` and 404s a store
    // that does not exist, so reaching here without one is a mount that skipped
    // it. Refusing is the only safe reading — the alternative is a handler
    // guessing an owner id.
    if (!store) throw notFound('Store not loaded');
    return { ownerType: 'store', ownerId: store.id };
  }),
);

export default router;
