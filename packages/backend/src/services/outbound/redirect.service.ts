/**
 * `GET /out/:token` — the decision, without the HTTP (#67 "Outbound redirect").
 *
 * ## The order of the checks is the design
 *
 * 1. **The token.** Anything unsigned or malformed stops here, so nothing
 *    unverified reaches a database read.
 * 2. **A native offer.** Requirement 6, checked BY NAME even though
 *    `offers_kind_shape_check` already forces `destination_url` NULL on a
 *    native offer and #68's gate would therefore answer `no_destination`. The
 *    explicit branch costs one comparison and buys an operator trace that says
 *    "somebody linked a native offer here" rather than "this offer has no
 *    destination", which are different bugs with different fixes.
 * 3. **#68's gate** — offer exists, still active, still current, its source may
 *    still display AND may still link out. CONSUMED, never re-derived: this
 *    domain owns no freshness rule and no TTL, and a scanned gate says so.
 * 4. **The destination admission** — the open-redirect defence, which is a
 *    pure function over the stored offer and the source's approved hosts.
 * 5. **The traffic classification**, which decides only whether the click
 *    COUNTS. It runs LAST because it must never be able to change where
 *    somebody is sent: a redirect that varies by user agent is cloaking.
 *
 * Every outcome that NAMES A REAL OFFER — including every refusal — writes a
 * click row. A refusal that stored nothing would make "why is this merchant's
 * button dead" unanswerable, which is the question an operator actually gets.
 *
 * The two exceptions are the two that have no offer to attribute a row to, and
 * `affiliate_outbound_clicks.offer_id` is NOT NULL: `token_invalid` (nothing
 * was verified, so there is no id) and `offer_not_found` (the id verified but
 * matches nothing). `offer_not_found` is therefore a value in
 * `OUTBOUND_REDIRECT_REFUSAL_REASONS` that no click row can ever carry — it is
 * reachable only as the decision this function returns and as #68's gate's own
 * answer.
 *
 * ## What this module cannot do
 *
 * It composes no URL. `selectOutboundUrl` returns a STORED string and the
 * admission returns that same string or a refusal with no `url` property at
 * all. #65 forbids composing or mutating an EPN link and #66 forbids composing
 * an Awin one; `outbound-isolation.test.ts` scans this directory for the
 * operations both name.
 */

import { eq } from 'drizzle-orm';
import type {
  OutboundClientSurface,
  OutboundDestinationKind,
  OutboundRedirectRefusalReason,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import { findOfferById, type OfferRow } from '../../db/offers/offerRepository.js';
import { sourceRecords } from '../../db/schema/provenance.js';
import { listApprovedOutboundHosts } from '../../db/affiliateOutbound/hostRepository.js';
import { insertAffiliateOutboundClick } from '../../db/affiliateOutbound/clickRepository.js';
import { assertOfferOutboundEligible } from '../offer-freshness/outbound-gate.js';
import {
  classifyReferralTraffic,
  type ReferralTrafficSignals,
} from '../referrals/traffic.js';
import { admitOutboundDestination, selectOutboundUrl } from './destination.js';
import { verifyAffiliateOutboundToken } from './token.js';

/**
 * What the caller must decide before this service is entered — the narrow slice
 * of a request it is allowed to see.
 *
 * There is no IP, no cookie and no header bag. `trafficSignals` is #143's own
 * input type, which reads a `User-Agent`, the four purpose headers and the
 * internal-traffic token and nothing else; `consentMode` is a client
 * DECLARATION recorded verbatim, exactly as the referral edge treats it.
 */
export interface OutboundRedirectRequest {
  readonly token: string;
  readonly trafficSignals: ReferralTrafficSignals;
  readonly clientSurface: OutboundClientSurface;
  readonly consentMode: 'granted' | 'denied' | 'unknown';
}

/** The answer. A STRING discriminant; the refusal branch carries no URL. */
export type OutboundRedirectDecision =
  | {
      readonly outcome: 'redirect';
      readonly url: string;
      readonly destinationHost: string;
      readonly destinationKind: OutboundDestinationKind;
      readonly clickId: string;
      readonly trafficClass: 'organic' | 'bot' | 'preview' | 'internal';
    }
  | {
      readonly outcome: 'refused';
      readonly reason: OutboundRedirectRefusalReason;
      /** Present only when a click row was written — a bad token writes none. */
      readonly clickId?: string;
    };

/** The offer's own source id, one hop from the observation it came from. */
async function resolveSourceId(
  offer: OfferRow,
  db: DatabaseOrTransaction,
): Promise<string | null> {
  if (offer.sourceRecordId === null) return null;
  const [row] = await db
    .select({ sourceId: sourceRecords.sourceId })
    .from(sourceRecords)
    .where(eq(sourceRecords.id, offer.sourceRecordId))
    .limit(1);
  return row?.sourceId ?? null;
}

function retentionDeadline(now: Date): Date {
  return new Date(now.getTime() + config.affiliateOutbound.clickRetentionDays * 86_400_000);
}

/**
 * Resolve one outbound click.
 *
 * @param now injected so the retention deadline and the click instant are one
 *   clock a test can hold still.
 */
export async function resolveOutboundRedirect(
  request: OutboundRedirectRequest,
  now: Date = new Date(),
  db: DatabaseOrTransaction = getDb(),
): Promise<OutboundRedirectDecision> {
  let offerId: string;
  try {
    offerId = verifyAffiliateOutboundToken(request.token).offerId;
  } catch {
    // Deliberately NOT recorded and deliberately not distinguished. There is no
    // offer to attribute the row to, and answering differently for "malformed"
    // than for "bad signature" tells somebody probing the route which half they
    // got right.
    return { outcome: 'refused', reason: 'token_invalid' };
  }

  const verdict = classifyReferralTraffic(
    request.trafficSignals,
    config.analytics.internalTrafficToken,
  );

  const offer = await findOfferById(db, offerId);
  if (offer === undefined) {
    return { outcome: 'refused', reason: 'offer_not_found' };
  }

  const sourceId = await resolveSourceId(offer, db);

  /** Write the click row every path shares, and answer. */
  const record = async (
    outcome:
      | { readonly kind: 'redirect'; readonly url: string; readonly host: string; readonly destinationKind: OutboundDestinationKind }
      | { readonly kind: 'refused'; readonly reason: OutboundRedirectRefusalReason },
  ): Promise<OutboundRedirectDecision> => {
    const click = await insertAffiliateOutboundClick(
      {
        offerId: offer.id,
        canonicalVariantId: offer.canonicalVariantId,
        merchantId: offer.merchantId,
        storefrontId: offer.storefrontId,
        catalogSourceId: sourceId,
        affiliateNetwork: offer.affiliateNetwork,
        affiliateProgramRef: offer.affiliateProgramRef,
        affiliatePublisherRef: offer.affiliatePublisherRef,
        destinationHost: outcome.kind === 'redirect' ? outcome.host : null,
        destinationKind: outcome.kind === 'redirect' ? outcome.destinationKind : null,
        // The market comes from the OFFER, never from the caller — a header a
        // client controls is not a fact about where the offer is sold.
        market: offer.country,
        clientSurface: request.clientSurface,
        trafficClass: verdict.trafficClass,
        trafficSignal: verdict.signal,
        consentMode: request.consentMode,
        disposition: outcome.kind === 'redirect' ? 'redirected' : 'refused',
        refusalReason: outcome.kind === 'refused' ? outcome.reason : null,
        occurredAt: now,
        retentionExpiresAt: retentionDeadline(now),
      },
      db,
    );
    if (outcome.kind === 'refused') {
      return { outcome: 'refused', reason: outcome.reason, clickId: click.id };
    }
    return {
      outcome: 'redirect',
      url: outcome.url,
      destinationHost: outcome.host,
      destinationKind: outcome.destinationKind,
      clickId: click.id,
      trafficClass: verdict.trafficClass,
    };
  };

  // Requirement 6. See the module docblock for why this is named rather than
  // left to the gate's `no_destination`.
  if (offer.kind === 'native') {
    return record({ kind: 'refused', reason: 'native_offer' });
  }

  const eligibility = await assertOfferOutboundEligible(offer.id, now, db);
  if (eligibility.outcome === 'refused') {
    return record({ kind: 'refused', reason: eligibility.reason });
  }

  const url = selectOutboundUrl(offer);
  if (url === undefined) {
    // Unreachable while the gate answers `no_destination` first; kept because
    // `selectOutboundUrl` returning nothing and the gate's own check are two
    // different questions, and a future gate change must not turn this into an
    // `undefined` handed to `new URL`.
    return record({ kind: 'refused', reason: 'no_destination' });
  }

  const approvedHosts =
    sourceId === null ? [] : await listApprovedOutboundHosts(sourceId, db);
  const admission = admitOutboundDestination({
    url,
    affiliateNetwork: offer.affiliateNetwork,
    approvedHosts,
  });
  if (admission.outcome === 'refused') {
    return record({ kind: 'refused', reason: admission.reason });
  }

  return record({
    kind: 'redirect',
    url: admission.url,
    host: admission.host,
    destinationKind: admission.kind,
  });
}
