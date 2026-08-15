/**
 * What Mercaria can actually observe about one P2P listing and its seller
 * (#112) — the impure half, kept away from the derivation.
 *
 * `eligibility.ts` decides; this reads. The split is the same one
 * `services/ranking/facts.ts` and `services/sellers/seller-visibility.ts` make,
 * and the reason is the same: every criterion becomes a table row in a unit
 * test, and the one module that could accidentally give a policy a database is
 * the one a scanned gate watches.
 *
 * ## Every absent input is named, never defaulted
 *
 * A rail that is off, an Oxy Trust tier nobody scored, a connected account that
 * does not exist yet: each becomes {@link unknown} with the party who would
 * supply it, and the derivation blocks on it. There is no `?? false`, no `?? 0`
 * and no `?? 'ES'` anywhere in this file — that is the whole discipline, and
 * `guest-p2p-isolation.test.ts` scans for the coalescing spellings that would
 * break it.
 *
 * ## Nothing here reads a buyer
 *
 * No session, no contact, no email, no hash, no order of the person asking. The
 * only inputs are a listing, its seller, and the checkout context the caller
 * states. #112's identity rules are held by the SIGNATURE: there is no buyer
 * parameter to misuse.
 */

import { config } from '../../config/index.js';
import { findListingById } from '../../db/catalog/listingRepository.js';
import { findVariantsByListing, type VariantRecord } from '../../db/catalog/variantRepository.js';
import { findSellerProfilesByUserIds } from '../../db/buyers/sellerProfileRepository.js';
import {
  countEvidentialConditionPhotos,
  findConditionDetails,
} from '../../db/condition/conditionRepository.js';
import { getDb } from '../../db/postgres.js';
import { UNREFINED_CONDITION_ASSERTIONS } from '@mercaria/shared-types';
import {
  findSellerAccount,
  readSellerPaymentReadiness,
} from '../payments/provider-account.service.js';
import { readSellerTrust } from '../sellers/seller-trust.js';
import { readSellerOxyUser } from '../sellers/viewer-oxy-client.js';
import { deriveSellerVisibility } from '../sellers/seller-visibility.js';
import { MERCHANT_ACTIVATION_POLICIES } from '@mercaria/shared-types';
import { findPolicyAcceptance } from '../../db/merchantActivation/policyAcceptanceRepository.js';
import { GUEST_P2P_BOUNDED_SCOPE } from './policy.js';
import { known, unknown, type GuestP2PCheckoutContext, type GuestP2PFacts } from './eligibility.js';

/**
 * The most permissive context the bounded scope allows, for a trace that has no
 * checkout behind it.
 *
 * NAMED and echoed back by the operator surface rather than defaulted silently:
 * an operator asking "what would it take for this listing" is asking a
 * hypothetical, and the hypothetical has to be visible or the answer reads as a
 * fact about a purchase somebody made. A real checkout always supplies its own.
 */
export const GUEST_P2P_BEST_CASE_CONTEXT: GuestP2PCheckoutContext = {
  quantity: 1,
  destinationCountry: GUEST_P2P_BOUNDED_SCOPE.markets[0],
  presentmentCurrency: GUEST_P2P_BOUNDED_SCOPE.currencies[0],
  fulfilment: 'shipping',
  shippingMethod: GUEST_P2P_BOUNDED_SCOPE.fulfilmentMethods[0],
  checkoutContainsNonP2PSeller: false,
};

/**
 * Read everything the policy needs about one listing.
 *
 * `null` when the listing does not exist or is not owned by a person — a store
 * listing has no guest-P2P eligibility to derive, and answering one would be
 * inventing a subject. The caller turns that into a 404.
 */
export async function readGuestP2PFacts(input: {
  listingId: string;
  context: GuestP2PCheckoutContext;
}): Promise<GuestP2PFacts | null> {
  const listing = await findListingById(input.listingId);
  if (!listing || listing.ownerType !== 'user' || listing.oxyUserId === null) return null;

  const sellerOxyUserId = listing.oxyUserId;
  const sellerKey = `user:${sellerOxyUserId}`;

  const [readiness, account, variants, details, photoCount, profiles, oxyUser, trust, policyAcceptance] =
    await Promise.all([
      readSellerPaymentReadiness([sellerKey]),
      findSellerAccount({ ownerType: 'user', ownerId: sellerOxyUserId }),
      findVariantsByListing(input.listingId),
      findConditionDetails(input.listingId),
      countEvidentialConditionPhotos(getDb(), input.listingId),
      findSellerProfilesByUserIds([sellerOxyUserId]),
      // The ANONYMOUS read: this is a policy question about the seller, not a
      // page somebody is looking at, so there is no viewer whose block graph or
      // bearer belongs in it (#92 keeps viewer-scoped reads for viewer-scoped
      // questions).
      readSellerOxyUser(sellerOxyUserId, null),
      readSellerTrust(sellerOxyUserId),
      // #85's P2P acceptance surface, which closes the one criterion #112 could
      // not evaluate. The CURRENT published version and no other: accepting v1
      // of a policy Mercaria has since replaced is not consent to v2, and a
      // lookup that ignored the version would read it as though it were.
      findPolicyAcceptance(getDb(), {
        policyKey: 'p2p_returns_cancellation_dispute',
        policyVersion: MERCHANT_ACTIVATION_POLICIES.p2p_returns_cancellation_dispute.version,
        ownerType: 'user',
        ownerId: sellerOxyUserId,
      }),
    ]);

  return {
    sellerKey,
    listingId: listing.id,
    // ADR 0001 D9's ONE stored verdict. With the rail off the map is empty for
    // every key and the question is not merely unanswered but meaningless —
    // `deployment`, not a refusal against a seller who has done nothing wrong.
    payoutReady: config.payments.stripe.enabled
      ? known(readiness.get(sellerKey) === true)
      : unknown('deployment'),
    // An unresolvable Oxy profile is Oxy's silence, not a verdict: #92's own
    // read treats it as absent and answers 404, and here it blocks.
    sellerVisibility: oxyUser
      ? known(deriveSellerVisibility(oxyUser, trust).visibility)
      : unknown('oxy'),
    trustTier: trust ? known(trust.tier) : unknown('oxy'),
    // No `seller_profiles` row means this person has never used the seller
    // surface. Reading that as zero sales would be an inference dressed as a
    // count, and the owner of the gap is the seller rather than the platform.
    completedSales: profiles.length > 0 ? known(profiles[0].salesCount) : unknown('seller'),
    // The connected account's country is the only market fact Mercaria holds
    // about a person. No account yet ⇒ nothing to read, and the seller supplies
    // it by onboarding — which `stripe_payout_ready` already reports on.
    sellerPayoutCountry: account ? known(account.country) : unknown('seller'),
    // A missing acceptance is a KNOWN false rather than an unknown: the policy
    // is published, the surface exists and the seller has not used it. Reporting
    // it `unknown` would name a party who owes an input when the party who owes
    // one is the seller, and the criterion already blocks either way.
    sellerPoliciesAccepted: known(policyAcceptance !== undefined),
    listingActive: listing.status === 'active',
    listingRestricted: listing.status === 'restricted',
    categorySlugs: listing.categorySlugs,
    conditionRefined: isRefinedCondition(listing.conditionAssertion),
    conditionAcknowledged: listing.conditionAcknowledgedAt !== null,
    conditionDetailCount: details.length,
    evidentialPhotoCount: photoCount,
    unitPrice: dearestVariantPrice(variants),
    context: input.context,
  };
}

/** Whether a #90 assertion is one somebody actually chose. */
function isRefinedCondition(assertion: string): boolean {
  return !(UNREFINED_CONDITION_ASSERTIONS as readonly string[]).includes(assertion);
}

/**
 * The DEAREST priced variant, which is the conservative reading of a value cap.
 *
 * A listing is one subject with several configurations, and the ceiling has to
 * hold for whichever one the buyer picks. Taking the cheapest would admit a
 * listing whose expensive variant is outside the cohort, which is the failure
 * direction that matters. A listing with no priced variant at all is
 * `unevaluable` — the same thing `nativeUnitPrice` refuses at checkout, for the
 * same reason.
 */
function dearestVariantPrice(variants: readonly VariantRecord[]): GuestP2PFacts['unitPrice'] {
  const priced = variants.flatMap((variant) =>
    variant.priceAmount === null || variant.priceCurrency === null
      ? []
      : [{ amount: variant.priceAmount, currency: String(variant.priceCurrency) }],
  );
  const dearest = priced.reduce<{ amount: number; currency: string } | null>(
    (best, candidate) => (best === null || candidate.amount > best.amount ? candidate : best),
    null,
  );
  return dearest === null ? unknown('seller') : known(dearest);
}
