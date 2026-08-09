/**
 * The check #37's outbound redirect runs before sending anybody anywhere
 * (#68 scheduler 7, public behaviour 6).
 *
 * ## Why the gate lives HERE and the redirect lives in #37
 *
 * "Recheck destination and affiliate eligibility before outbound redirect" is
 * two different jobs. Deciding whether an offer is still current is a freshness
 * question and belongs to this domain, which owns the policy; composing a
 * tracked URL, following it and recording the click is #37's. Splitting them
 * that way means the redirect cannot be built WITHOUT consulting the gate — it
 * has nothing else that answers "is this offer still real" — and this domain
 * never learns how to send a browser somewhere.
 *
 * `offer-freshness-isolation.test.ts` holds the second half: no module here may
 * compose an affiliate URL or import a redirect service.
 *
 * ## The refusal is a REASON, not a boolean
 *
 * A redirect refused because the offer expired, because the source withdrew its
 * outbound-link right and because the merchant delisted the item are three
 * different things to tell a buyer and three different things to alert on. A
 * boolean would collapse them at exactly the moment somebody is debugging why a
 * click went nowhere.
 */

import {
  assessOfferFreshness,
  mayAppearInComparison,
  type OfferFreshnessAssessment,
} from '@mercaria/shared-types';
import { eq } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { findOfferById } from '../../db/offers/offerRepository.js';
import { catalogSources, sourceRecords } from '../../db/schema/provenance.js';
import { resolveSourceFreshnessPolicy } from './policy.js';

/** Why an outbound click may not proceed. */
export type OutboundRefusalReason =
  /** No such offer. */
  | 'offer_not_found'
  /** The offer has been retired — the source stopped publishing it, or it lapsed. */
  | 'offer_retired'
  /** The live freshness verdict refuses it: expired, unavailable or unknown. */
  | 'offer_not_current'
  /** The offer names no destination — an `informational` record. */
  | 'no_destination'
  /** The source's rights no longer permit sending anybody to it. */
  | 'outbound_not_permitted';

export const OUTBOUND_REFUSAL_REASONS: readonly OutboundRefusalReason[] = [
  'offer_not_found',
  'offer_retired',
  'offer_not_current',
  'no_destination',
  'outbound_not_permitted',
];

/**
 * The verdict, as a discriminated union.
 *
 * The refused branch has NO `destinationUrl` property, so a redirect handler
 * cannot reach for one without switching first — the `deriveOfferDelivery`
 * device, applied to the one place where forgetting a check sends a real person
 * to a dead page.
 *
 * The discriminant is a STRING and not a boolean, for the reason
 * `SourceRefreshLeaseClaim` states: this package compiles with `strict: false`,
 * and without `strictNullChecks` TypeScript does not narrow a union on the
 * TRUTHINESS of a boolean-literal discriminant. `if (!verdict.permitted)` would
 * leave #37 holding the whole union, unable to read the reason it must act on —
 * and a redirect handler that cannot tell "the offer expired" from "the source
 * withdrew its outbound right" is one that logs neither.
 */
export type OutboundEligibility =
  | {
      readonly outcome: 'permitted';
      /** The ORIGINAL destination. #37 composes any tracking from the routing columns. */
      readonly destinationUrl: string;
      readonly freshness: OfferFreshnessAssessment;
    }
  | { readonly outcome: 'refused'; readonly reason: OutboundRefusalReason };

/**
 * May a click on this offer be followed right now?
 *
 * The freshness verdict is RE-DERIVED here rather than trusted from whatever
 * the page that rendered the link believed. A buyer can leave a product page
 * open for an hour, and an offer that was current when the page rendered is
 * exactly the one that is not current when they finally click — which is the
 * whole reason #68 asks for a re-check at redirect time rather than a filter at
 * render time.
 */
export async function assertOfferOutboundEligible(
  offerId: string,
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<OutboundEligibility> {
  const offer = await findOfferById(db, offerId);
  if (offer === undefined) return { outcome: 'refused', reason: 'offer_not_found' };
  if (offer.status !== 'active') return { outcome: 'refused', reason: 'offer_retired' };
  if (!offer.destinationUrl) return { outcome: 'refused', reason: 'no_destination' };

  // The rights come from the REGISTRY, one join from the observation — never
  // from a copy on the offer, which could disagree with a policy version
  // somebody published this morning (#62's projection rule).
  const rights =
    offer.sourceRecordId === null
      ? []
      : await db
          .select({ sourceId: sourceRecords.sourceId, mayDisplay: catalogSources.mayDisplay })
          .from(sourceRecords)
          .innerJoin(catalogSources, eq(catalogSources.id, sourceRecords.sourceId))
          .where(eq(sourceRecords.id, offer.sourceRecordId))
          .limit(1);
  const source = rights[0];
  if (source === undefined || !source.mayDisplay) {
    return { outcome: 'refused', reason: 'outbound_not_permitted' };
  }

  const resolved = await resolveSourceFreshnessPolicy(source.sourceId, db);
  const freshness = assessOfferFreshness(
    {
      sourceId: source.sourceId,
      observedAt: offer.observedAt,
      firstSeenAt: offer.firstSeenAt,
      lastSeenAt: offer.lastSeenAt,
      lastConfirmedAt: offer.lastConfirmedAt,
      declaredUnavailableAt: offer.declaredUnavailableAt,
      storedExpiresAt: offer.staleAt,
    },
    resolved?.policy ?? null,
    now,
  );
  if (!mayAppearInComparison(freshness)) {
    return { outcome: 'refused', reason: 'offer_not_current' };
  }

  return { outcome: 'permitted', destinationUrl: offer.destinationUrl, freshness };
}
