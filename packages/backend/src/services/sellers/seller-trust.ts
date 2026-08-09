/**
 * Oxy Trust, read through the canonical service and NEVER recomputed (#92
 * reputation rules 3 and 4).
 *
 * There is no Mercaria trust score and none may be built. A listing count, a
 * follower count and a sales count are activity, not trustworthiness, and a
 * number derived from them wearing the word "trust" would be Mercaria asserting
 * something about a person that nobody measured. Oxy Trust owns reputation
 * ecosystem-wide; this module reads its verdict and passes it through.
 *
 * ## Two fields, because two fields are what a third party is served
 *
 * `GET /reputation/:userId/balance` answers a third-party caller with
 * `ReputationBalanceSummary` — `userId`, `total`, `trustTier` — and answers the
 * SUBJECT with the full balance (breakdown, influence, reliability,
 * timestamps). Mercaria is always a third party here, so it takes the summary
 * and would refuse the rest anyway: `reliability.abuseScore` is Oxy's internal
 * judgement of a person and has no business on a public shop page.
 *
 * The SDK returns the union and `isFullReputationBalance` narrows it; this
 * module reads only the two summary fields, which are present on both arms, so
 * no narrowing is needed and none is done — reaching for the full shape is what
 * would need justifying.
 */

import type { PublicSellerTrust } from '@mercaria/shared-types';
import { oxyClient } from '../../middleware/auth.js';
import { log } from '../../lib/logger.js';

/**
 * Read a seller's public Oxy Trust summary.
 *
 * `null` on any failure, and `null` is a REAL answer the caller must keep
 * distinguishable from a tier of `new`: an account Oxy Trust has never scored
 * and a read that did not complete both land here, and neither is evidence
 * about the person. `seller-visibility.ts` is where that matters — an absent
 * signal restricts nothing.
 *
 * Read with the SHARED anonymous client on purpose. The public summary is the
 * same for every caller, so a viewer-scoped read would buy nothing and would
 * discard the SDK's response cache on the one field of a seller page that
 * changes least.
 */
export async function readSellerTrust(oxyUserId: string): Promise<PublicSellerTrust | null> {
  try {
    const balance = await oxyClient.getReputationBalance(oxyUserId);
    return { tier: balance.trustTier, total: balance.total };
  } catch (err) {
    log.general.warn(
      { err, oxyUserId },
      '[Sellers] Oxy Trust unavailable — seller profile renders without it',
    );
    return null;
  }
}
