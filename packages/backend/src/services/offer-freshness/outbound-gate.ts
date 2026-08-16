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
import { catalogSourceConfigs } from '../../db/schema/ingestion.js';
import { findActiveSourcePolicy } from '../../db/ingestion/catalogSourcePolicyRepository.js';
import { resolveSourceRights } from '../ingestion/rights.js';
import { toPolicyRights } from '../ingestion/source.service.js';
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
      /** The ORIGINAL destination. #67's redirect prefers the provider's own
       *  attributed URL when there is one, and composes neither. */
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
          .select({
            sourceId: sourceRecords.sourceId,
            mayDisplay: catalogSources.mayDisplay,
            // LEFT-joined: a bare provenance registry row with no ingestion
            // config is a real state (#68's fourth freshness layer exists for
            // it), and an inner join would silently refuse every one of those
            // offers rather than falling through to the rights check below.
            configStatus: catalogSourceConfigs.status,
          })
          .from(sourceRecords)
          .innerJoin(catalogSources, eq(catalogSources.id, sourceRecords.sourceId))
          .leftJoin(catalogSourceConfigs, eq(catalogSourceConfigs.sourceId, sourceRecords.sourceId))
          .where(eq(sourceRecords.id, offer.sourceRecordId))
          .limit(1);
  const source = rights[0];
  if (source === undefined || !source.mayDisplay) {
    return { outcome: 'refused', reason: 'outbound_not_permitted' };
  }

  /*
   * The `outbound_link` RIGHT, read LIVE from the active policy version.
   *
   * `may_display` above is the coarse projection on `catalog_sources` and it is
   * the umbrella — it answers "may this offer be shown at all". It does NOT
   * answer "may Mercaria send somebody to it", which is a separate right #62
   * versions separately and which a source can withdraw on its own.
   *
   * The offer's KIND was derived from this right at INGESTION time
   * (`offerKindFor`: no `outbound_link` ⇒ `informational` ⇒ a CHECK refuses a
   * destination), so a source that never granted it produces nothing to
   * redirect to. What that leaves uncovered is exactly the case this read
   * closes: a source that GRANTED the right, produced `affiliate` offers with
   * destinations, and then published a new policy version WITHDRAWING it. Those
   * offer rows keep their kind and their destination until they are re-ingested,
   * and until #67 this gate would have handed a visitor to a merchant whose
   * contract with Mercaria no longer permits it.
   *
   * It lives HERE rather than in the redirect for the reason the whole gate
   * does: two authorities answering "may this link out" is precisely the shape
   * that ends with one of them stale. `outbound_not_permitted` already exists
   * for it and needed no new vocabulary.
   *
   * A source with NO ingestion config is deliberately left to `may_display`
   * alone. Such a row predates or sits outside #62's rights model — #60's
   * backfill and the hand-created operator source are the two that exist — so
   * there is no policy to consult and inventing a refusal would withdraw
   * offers from a surface that never had one, which is #62's own "a source
   * with no config is left alone". It is not a hole: those sources' offers
   * still have to clear the destination allow-list, which is what actually
   * decides where a visitor may be sent.
   */
  if (source.configStatus !== null) {
    const policy = await findActiveSourcePolicy(db, source.sourceId);
    const rights = resolveSourceRights(
      source.configStatus,
      policy === undefined ? null : toPolicyRights(policy),
    );
    if (!rights.outbound_link) {
      return { outcome: 'refused', reason: 'outbound_not_permitted' };
    }
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
