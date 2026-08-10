/**
 * The unified offer model — issue #57, bound by ADR 0002 D7, D8 and D18.
 *
 * An **offer** is one seller/channel offering one exact canonical variant under
 * specific commercial terms at a point in time. Everything volatile — price,
 * availability, condition, destination — is offer state; nothing volatile lives
 * on a canonical variant, and nothing here re-states a fact the graph already
 * holds somewhere else.
 *
 * ## The four distinctions this file exists to hold
 *
 * 1. **Native and external offers share a COMPARISON model and share no
 *    checkout semantics.** Both fill the same columns a product page reads
 *    (variant, seller, price, availability, condition, freshness). Only a
 *    `native` offer carries a `productVariantId`, because only a native offer
 *    joins to a row cart and checkout already operate on — so "an external
 *    offer cannot enter the cart" is a shape, not a rule somebody enforces.
 * 2. **Marketplace-ness is DERIVED, never stored** (ADR D8). An offer names its
 *    seller of record and the channel it is sold on; a marketplace offer is one
 *    whose channel is operated by a DIFFERENT merchant.
 *    {@link deriveOfferSellerRole} is that comparison, and there is no
 *    `isMarketplace` field for it to disagree with.
 * 3. **Unknown is not zero, and unknown is not absent.** An unknown delivery
 *    cost is a MISSING `Money`, and {@link deriveOfferDelivery} returns a
 *    discriminated union so a consumer cannot read it as free shipping without
 *    writing that coercion out loud. Unknown pickup is its own
 *    {@link OfferPickupState} member rather than `false`, and an unsupplied
 *    quantity is `undefined` rather than `0`.
 * 4. **Native checkout eligibility is a DERIVATION, never a column.** It is a
 *    conjunction over the LIVE listing, the LIVE variant and the seller's
 *    payment readiness — three facts this domain does not own — so a stored
 *    copy could say "buyable" about a listing a jury restricted a second ago.
 *    {@link deriveNativeCheckoutEligibility} is the one derivation, and it
 *    follows the two precedents already in this codebase: `merchants`' native
 *    checkout eligibility and `procurement-eligibility`'s supplier verdict.
 *
 * The tuples below are the closed value sets the schema's CHECK constraints are
 * rendered from (`text` + CHECK, never a pg enum — see
 * `db/schema/CONVENTIONS.md`). Widening one is a code change plus an additive
 * migration in the same PR.
 */

import { CONDITION_KEY_GROUP } from './condition';
import type {
  ConditionGroup,
  ConditionMappingState,
  OfferConditionDTO,
  OfferConditionKey,
} from './condition';
// TYPE-ONLY, deliberately: `./offer-freshness` imports `OfferAvailability` and
// `OfferMoney` back from here, and a value import in either direction would
// make that a real module cycle. Type imports are erased, so the two files can
// describe each other without either having to be loaded first.
import type { OfferFreshnessAssessment } from './offer-freshness';

/**
 * An offer's own money.
 *
 * Deliberately NOT `Money`, and this is the one place in Mercaria where that is
 * the honest type. `Money.currency` is `CurrencyCode` — Mercaria's PRESENTMENT
 * set — and an external platform reports whatever currency it trades in, which
 * may be outside it (ADR 0002 D18 names `offers.price_currency` as the
 * documented CHECK exception, the `connections.shop_currency` /
 * `storefronts.currency` class). Declaring this `Money` would make the type
 * system assert something the column deliberately does not enforce, and the
 * first RON offer would be a lie `tsc` had helped nobody catch.
 *
 * Nothing prices against it: display converts through `FxContext`, which fails
 * closed on a pair it cannot resolve rather than guessing a rate.
 */
export interface OfferMoney {
  /** Integer minor units, in `currency`'s own precision. */
  amount: number;
  /** An ISO-4217-style code as the SOURCE published it. Shape-checked, not enumerated. */
  currency: string;
}

/**
 * What kind of offer this is (ADR 0002 D18).
 *
 * The issue names three — native, external referral, informational — and the
 * ADR splits the middle one, which is the binding version: an `external` offer
 * points at a retailer's own page, an `affiliate` offer points at a tracked
 * destination the outbound service (#37) will route through. They differ in
 * what the destination URL MEANS and therefore in what may be done with it, and
 * a single value would make an untracked destination indistinguishable from a
 * monetised one at the moment somebody adds tracking to it.
 *
 * `mercaria_retail` is deliberately ABSENT. ADR D18 reserves its semantics —
 * Mercaria as seller of record, native checkout, supplier-fulfilled — and binds
 * its arrival to epic #116's own migration, exactly as the `stripe` provider id
 * landed with the code that could write it rather than in advance.
 */
export type OfferKind = 'native' | 'external' | 'affiliate' | 'informational';

export const OFFER_KINDS: readonly OfferKind[] = [
  'native',
  'external',
  'affiliate',
  'informational',
];

/**
 * The lifecycle of an offer row (ADR 0002 D18).
 *
 * TWO values, and "stale" is deliberately not a third: staleness is
 * `status = 'active' AND staleAt <= now`, derived from a deadline the source
 * set, so a sweep that has not run yet cannot make a stale offer read as fresh.
 * A third status would be a second representation of the same deadline, and the
 * two could disagree in exactly the window where it matters.
 */
export type OfferStatus = 'active' | 'retired';

export const OFFER_STATUSES: readonly OfferStatus[] = ['active', 'retired'];

/**
 * Why an offer stopped being current.
 *
 * Retirement is a status transition and never a DELETE: the row, its source
 * record and its observation history all survive it (issue external rule 4).
 * The reason is what tells a source that vanished apart from a listing its
 * seller unpublished, which are different facts about different systems.
 */
export type OfferRetirementReason =
  /** The source stopped listing it — a feed delta or a 404 on refresh. */
  | 'source_disappeared'
  /** The source's own validity window closed and no refresh renewed it. */
  | 'source_expired'
  /** The native listing left `active` (draft, sold, archived, restricted). */
  | 'listing_unpublished'
  /** The native variant is gone; the listing may still exist. */
  | 'variant_removed'
  /** A newer offer took this one's active source mapping. */
  | 'superseded'
  /** A catalog operator retired it by hand, with a reason recorded beside it. */
  | 'operator'
  /**
   * The source EXPLICITLY declared the object gone (#68).
   *
   * Distinct from `source_disappeared`, which is inferred from an object's
   * ABSENCE in a complete snapshot, and that distinction is the whole of #68
   * acceptance 2 versus 3: an omission is only evidence when the enumeration
   * was complete, while a positive statement is evidence from any run at all.
   * It is also a different obligation — eBay's licence requires deleting
   * content once a listing is no longer publicly available, so the two must not
   * be collapsed into one reason an operator cannot tell apart afterwards.
   */
  | 'source_unavailable';

export const OFFER_RETIREMENT_REASONS: readonly OfferRetirementReason[] = [
  'source_disappeared',
  'source_expired',
  'listing_unpublished',
  'variant_removed',
  'superseded',
  'operator',
  'source_unavailable',
];

/**
 * Whether the thing can be had right now (ADR 0002 D18).
 *
 * `unknown` is the DEFAULT and is a real answer: most feeds do not publish
 * availability, and inventing `in_stock` for them is how a comparison surface
 * starts sending buyers to pages that cannot sell them anything.
 */
export type OfferAvailability =
  | 'in_stock'
  | 'out_of_stock'
  | 'preorder'
  | 'unavailable'
  | 'unknown';

export const OFFER_AVAILABILITY_STATES: readonly OfferAvailability[] = [
  'in_stock',
  'out_of_stock',
  'preorder',
  'unavailable',
  'unknown',
];

/**
 * NOTE ON CONDITION — the local `OfferCondition` union that lived here is GONE.
 *
 * It existed so that a widening of the listing taxonomy could not silently widen
 * the `offers_condition_check` CHECK without a migration. #90 took ownership of
 * the taxonomy and landed exactly that migration, so the vocabulary now lives in
 * `./condition` as `OfferConditionKey` / `OFFER_CONDITION_KEYS` — the nine
 * stable keys plus `unknown` — and BOTH the column type and the CHECK are
 * rendered from that one tuple. The rule survives, in one place instead of two:
 * widening the taxonomy is a code change PLUS a migration, in the same PR.
 *
 * An offer's condition is more than a key. {@link OfferConditionDTO} carries how
 * it was arrived at, and a source mapping that did not clear
 * `CONDITION_MAPPING_CONFIDENCE_FLOOR` cannot sit beside anything but `unknown`
 * (#90 evidence rule 6, enforced by CHECK rather than by the mapper).
 */

/**
 * Whether collection in person is possible (issue commercial fact 7).
 *
 * Three states rather than a nullable boolean, because "the source did not say"
 * and "the source said no" are different facts and a `boolean | null` invites
 * `?? false`, which silently turns the first into the second. The same reasoning
 * keeps the delivery cost a missing `Money` rather than a zero.
 */
export type OfferPickupState = 'unknown' | 'available' | 'unavailable';

export const OFFER_PICKUP_STATES: readonly OfferPickupState[] = [
  'unknown',
  'available',
  'unavailable',
];

/**
 * Who may take this offer up (issue commercial fact 6).
 *
 * `unknown` is the default. An offer restricted to trade buyers shown to a
 * consumer as if it were open is a worse comparison than no offer at all, so
 * the absence of a statement is recorded as an absence.
 */
export type OfferCustomerEligibility =
  | 'unknown'
  | 'anyone'
  | 'members_only'
  | 'business_only'
  | 'age_restricted';

export const OFFER_CUSTOMER_ELIGIBILITIES: readonly OfferCustomerEligibility[] = [
  'unknown',
  'anyone',
  'members_only',
  'business_only',
  'age_restricted',
];

/**
 * Quality signals a ranking or an explanation surface may read (issue
 * commercial fact 9).
 *
 * A CLOSED set of reason codes in a `text[]`, never free text and never a
 * numeric score: #74 owns ranking, and a score computed here would be a second
 * ranking input nothing could explain. Each member names a fact about the
 * OBSERVATION, so an offer can carry several at once.
 */
export type OfferQualitySignal =
  /** No price at all — an `informational` record, or a feed that omits it. */
  | 'missing_price'
  /** The source published no availability, so `availability` is `unknown`. */
  | 'missing_availability'
  /** The source's condition wording did not map onto the taxonomy. */
  | 'unmapped_condition'
  /** No delivery facts at all. NOT the same as free delivery. */
  | 'unknown_delivery'
  /** The offer's own TTL has passed and no refresh has renewed it. */
  | 'stale_observation'
  /** The canonical attachment came from a heuristic match, not an identifier. */
  | 'heuristic_match'
  /** The seller merchant is unclaimed, so nobody has vouched for the channel. */
  | 'unclaimed_merchant';

export const OFFER_QUALITY_SIGNALS: readonly OfferQualitySignal[] = [
  'missing_price',
  'missing_availability',
  'unmapped_condition',
  'unknown_delivery',
  'stale_observation',
  'heuristic_match',
  'unclaimed_merchant',
];

/**
 * NOTE ON FRESHNESS — the local `fresh | aging | stale` union that lived here
 * is GONE, a clean cut taken by #68.
 *
 * It derived one state from `observedAt` and `staleAt` alone, which cannot
 * express any of the things a source contract actually says: eBay's obligation
 * to delete content once a listing is no longer publicly available, a
 * contractual cache cap that must SHORTEN a lifetime somebody configured, or
 * the difference between "the source has not answered for an hour" and "the
 * source said this is gone". It also ran the clock from the last CHANGE rather
 * than the last CHECK, which expires every stable price on a feed that
 * republishes the same number daily.
 *
 * The vocabulary now lives in `./offer-freshness` as
 * {@link OfferFreshnessAssessment}, derived against a per-source
 * {@link SourceFreshnessPolicy} that names the source it was resolved for —
 * see that module's docblock for why a global TTL is unrepresentable.
 */

/**
 * The seller's relationship to the channel (ADR 0002 D8) — DERIVED from two
 * foreign keys, never stored.
 *
 * `direct` — the channel's operator IS the seller of record (Amazon selling on
 * `amazon.es`). `marketplace` — a different merchant sells on somebody else's
 * channel (Seller Y on `amazon.es`), and Seller Y is who a buyer's warranty is
 * with. `unknown` — the offer names no channel, or the channel's operator was
 * not resolved for this read.
 */
export type OfferSellerRole = 'direct' | 'marketplace' | 'unknown';

/**
 * How a native `product_variants` row was attached to a canonical variant
 * (ADR 0002 D6).
 *
 * There is deliberately NO `name_match` member — the `native_store_links` and
 * `commerce_relationships` device. "Attached because the titles looked alike"
 * has no value to be stored as, so a matcher that wants to act on a title
 * similarity must record `matcher` and carry a confidence and a rule id that
 * #59 can review.
 */
export type NativeListingLinkMethod =
  /** A GTIN on the native variant's barcode resolved to exactly one canonical variant. */
  | 'barcode_gtin'
  /** The connector declared the mapping — the platform's own product identity. */
  | 'connector_declared'
  /** A catalog operator decided it. */
  | 'operator'
  /** #58's matcher proposed it, with a rule id and a confidence. */
  | 'matcher'
  /**
   * #60's backfill attached a native variant to a canonical variant IT MINTED
   * from that same variant, in one transaction (ADR 0002 D23 phase 1).
   *
   * Its own member rather than `connector_declared`, which is what #58's
   * `linkMethodForStage` originally anticipated: no connector declared this, and
   * an attachment whose canonical side was created from the native side is a
   * genuinely different provenance from a platform asserting its own product
   * identity. #59's review tooling has to be able to tell "the migration minted
   * this" from "Shopify said so" — one value meaning both would make that
   * question unanswerable, which is the two-representations rule applied to a
   * vocabulary instead of a column.
   *
   * Like every non-`matcher` method it carries NULL confidence: the mapping is
   * certain by construction, because the backfill created both ends of it.
   */
  | 'backfill'
  /**
   * The SELLER said so, in #91's "Sell yours" flow, and #58's deterministic
   * blockers did not refuse it.
   *
   * Its own member rather than `operator` or `matcher`, and the distinction is
   * the one #59's tooling most needs: a catalogue operator deciding an
   * attachment and the person who owns the item deciding it are different kinds
   * of evidence with different remedies. An operator's mistake is corrected by
   * another operator; a seller's is corrected by asking the seller, or by a
   * `wrong_product_match` report.
   *
   * It carries NULL confidence like every non-`matcher` method, for the same
   * reason: a person saying "this is the phone I am selling" has no score, and a
   * number beside it could only be read as doubt about a fact nobody scored.
   * What makes it trustworthy is not a threshold — it is that
   * `services/sell-yours/match-gate.ts` refused to write it if a valid
   * identifier, the brand, the pack count, the category, a bundle relation or an
   * operator's own rejection disagreed.
   */
  | 'seller_declared';

export const NATIVE_LISTING_LINK_METHODS: readonly NativeListingLinkMethod[] = [
  'barcode_gtin',
  'connector_declared',
  'operator',
  'matcher',
  'backfill',
  'seller_declared',
];

/** The lifecycle of one native-variant → canonical-variant attachment. */
export type NativeListingLinkStatus = 'active' | 'superseded' | 'revoked';

export const NATIVE_LISTING_LINK_STATUSES: readonly NativeListingLinkStatus[] = [
  'active',
  'superseded',
  'revoked',
];

/**
 * Why a native offer may not be checked out (issue native rules 2 and 5).
 *
 * Every member names a fact read LIVE at the moment of the derivation, which is
 * what makes the list exhaustive rather than a guess: there is no fourth thing
 * the gate consults.
 */
export type NativeCheckoutBlockReason =
  /** The offer is not `native`; external offers have no checkout path at all. */
  | 'not_native'
  /** The offer row itself has been retired. */
  | 'offer_retired'
  /** The listing is not `active` — draft, sold or archived. */
  | 'listing_not_active'
  /** A jury restricted the listing. Distinguished from the above deliberately. */
  | 'listing_restricted'
  /** The native variant is gone. */
  | 'variant_missing'
  /** The variant tracks inventory and has none available. */
  | 'out_of_stock'
  /** The seller cannot be paid on the native rail (ADR 0001 D9). */
  | 'seller_not_payment_ready';

export const NATIVE_CHECKOUT_BLOCK_REASONS: readonly NativeCheckoutBlockReason[] = [
  'not_native',
  'offer_retired',
  'listing_not_active',
  'listing_restricted',
  'variant_missing',
  'out_of_stock',
  'seller_not_payment_ready',
];

/**
 * Where an offer's facts came from and how far they may be trusted (issue
 * acceptance 7).
 *
 * A native offer has no source record: it is a projection of a listing Mercaria
 * already holds, so `sourceRecordId` is absent and `provider` names nothing.
 */
export interface OfferProvenance {
  /** The observation this offer's terms came from; absent for native offers. */
  sourceRecordId?: string;
  /** The adapter or platform id, as the ingesting source names itself. */
  provider?: string;
  /** Which account at that provider observed it — a feed, a shop, a network seat. */
  sourceAccountRef?: string;
  /** The provider's own id for this offer. Never a Mercaria key (ADR 0002 D20). */
  externalOfferId?: string;
  /** 0–1, present only on machine-ingested rows. Never a form of verification. */
  confidence?: number;
  /** Whether the source's agreement permits showing its facts to a buyer. */
  mayDisplay?: boolean;
  /** Whether showing them requires naming the source. */
  attributionRequired?: boolean;
}

/**
 * What is known about getting the goods (issue commercial fact 7).
 *
 * A DISCRIMINATED UNION rather than an optional `Money`, and that is the whole
 * point: `known: false` has no `cost` property at all, so `offer.delivery.cost`
 * does not type-check on the unknown branch and a ranking cannot treat silence
 * as free delivery by forgetting a check.
 */
export type OfferDelivery =
  | {
      known: false;
      pickup: OfferPickupState;
    }
  | {
      known: true;
      /** Zero here means FREE, and it means free because a source said so. */
      cost: OfferMoney;
      /** The basket value above which delivery is free, when the source states one. */
      freeOver?: OfferMoney;
      /** Quoted delivery window in days, when the source states one. */
      minDays?: number;
      maxDays?: number;
      pickup: OfferPickupState;
    };

/**
 * Whether this offer can be bought through Mercaria right now — the DERIVED
 * verdict (issue commercial fact 10, native rules 2 and 5).
 *
 * The eligible branch carries the ids checkout needs, so a caller that has the
 * verdict cannot then look them up from an offer that failed the gate.
 *
 * ## Narrow it with `if (!verdict.eligible)`, or with an explicit `=== true`
 *
 * `@mercaria/backend` compiles with `strict: false`, and under
 * `strictNullChecks: false` TypeScript does not narrow a BOOLEAN-literal
 * discriminant from a bare truthiness test: `if (verdict.eligible) throw` leaves
 * `verdict.reasons` a type error afterwards. Measured, not assumed — the same
 * program compiles clean under `strict`, and both `if (!verdict.eligible)` and
 * `if (verdict.eligible === true)` narrow under BOTH configurations. The natural
 * reading (`if (!offer.checkout.eligible) explain(offer.checkout.reasons)`) is
 * one of the two that work; the guard-and-throw shape a test reaches for is not,
 * which is why it is written out here rather than rediscovered.
 */
export type NativeCheckoutEligibility =
  | {
      eligible: true;
      listingId: string;
      productVariantId: string;
    }
  | {
      eligible: false;
      /** Every reason that applies, in the fixed order the gate evaluates them. */
      reasons: readonly NativeCheckoutBlockReason[];
    };

/**
 * One offer, as every read surface sees it.
 *
 * `sellerRole` and `checkout` are derived at projection time and stored
 * nowhere; `freshness` and `delivery` are derived from columns that are stored.
 * Nothing in this shape carries a canonical PRODUCT id: an offer attaches at the
 * variant grain (ADR 0002 D13/D18) and the product is one hop through the
 * variant, where it cannot disagree.
 */
export interface Offer {
  id: string;
  kind: OfferKind;
  status: OfferStatus;
  retirementReason?: OfferRetirementReason;

  /** The exact configuration this offer prices. Always present (ADR 0002 D18). */
  canonicalVariantId: string;

  /** The seller of record, when it is a canonical merchant. Absent on native offers. */
  merchantId?: string;
  /** The channel it is published on. Absent on native offers (ADR 0002 D18). */
  storefrontId?: string;
  /** The channel's operating merchant, resolved for {@link OfferSellerRole}. */
  storefrontOperatorMerchantId?: string;
  sellerRole: OfferSellerRole;

  /** The native listing this offer projects. Present iff `kind === 'native'`. */
  listingId?: string;
  /** The native variant. Present iff `kind === 'native'`. */
  productVariantId?: string;

  /** The seller's own price, in the seller's own currency. Absent when unpriced. */
  price?: OfferMoney;
  /** A "was" price the seller published beside it. */
  compareAtPrice?: OfferMoney;
  availability: OfferAvailability;
  /** Present only when the source actually supplies it (issue commercial fact 3). */
  availableQuantity?: number;
  /**
   * The condition, its segment and how it was arrived at (#90).
   *
   * The source's own wording is preserved verbatim beside the normalized key,
   * so a shopper can see that "Ricondizionato — Grado B" became
   * `refurbished_seller`, and an operator can correct the RULE without
   * rewriting the observation that ran under the old one.
   */
  condition: OfferConditionDTO;

  /** The seller's own stock keeping unit — source-scoped, never a product identifier. */
  sellerSku?: string;
  /** The merchant's own words for the product. */
  merchantTitle?: string;
  /** The merchant's own words for the configuration ("256GB / Negro"). */
  merchantVariantText?: string;

  /**
   * Where the offer lives, exactly as the source gave it.
   *
   * This is the ORIGINAL destination and is never rewritten. Affiliate routing
   * is separate metadata (#37 composes the tracked URL from it at redirect
   * time), so the untracked destination survives a network changing its
   * template, and a routing bug degrades to the plain link rather than to a
   * dead one.
   */
  destinationUrl?: string;
  affiliate?: OfferAffiliateRouting;

  /** ISO 3166-1 alpha-2 market this offer is published for. */
  country?: string;
  /** A sub-national region, when the source scopes to one. */
  region?: string;
  /** BCP-47 tag of the offer's own text. */
  language?: string;
  customerEligibility: OfferCustomerEligibility;

  delivery: OfferDelivery;
  returnPolicy?: OfferReturnPolicy;

  provenance: OfferProvenance;
  freshness: OfferFreshnessAssessment;
  qualitySignals: readonly OfferQualitySignal[];

  /** The derived checkout verdict. Always present, and `eligible: false` for every non-native offer. */
  checkout: NativeCheckoutEligibility;
}

/**
 * How an outbound click would be routed (issue commercial fact 5).
 *
 * Metadata only — this domain models the routing and #37 performs it. There is
 * deliberately no composed affiliate URL column: one stored URL beside the
 * original destination is two addresses for one page, and the tracked one goes
 * out of date the moment a network changes its parameters.
 */
export interface OfferAffiliateRouting {
  /** The network that would be credited (`awin`, `impact`, …). */
  network: string;
  /** The programme or advertiser id within that network. */
  programRef?: string;
  /** The publisher/site id Mercaria is paid under. */
  publisherRef?: string;
  /** A template with a `{destination}` placeholder, when the network needs one. */
  trackingTemplate?: string;
}

/** The seller's stated returns terms, when they supply any (issue commercial fact 8). */
export interface OfferReturnPolicy {
  /** Where the policy is published. */
  url?: string;
  /** The stated return window in days. */
  windowDays?: number;
  /** The source's own identifier for the policy, when it has one. */
  policyRef?: string;
}

/** A page of offers for one canonical variant or product, newest observation first. */
export interface OfferPage {
  offers: Offer[];
  /** Opaque keyset cursor; absent when the page is the last one. */
  nextCursor?: string;
}

/**
 * Compare an offer's seller of record with the operator of the channel it is
 * sold on (ADR 0002 D8).
 *
 * Both arguments come from foreign keys, so this is the whole of "is this a
 * marketplace offer" — there is no column to disagree with it and no way to
 * label an offer marketplace without two distinct merchants existing.
 */
export function deriveOfferSellerRole(
  sellerMerchantId: string | null | undefined,
  storefrontOperatorMerchantId: string | null | undefined,
): OfferSellerRole {
  if (!sellerMerchantId || !storefrontOperatorMerchantId) return 'unknown';
  return sellerMerchantId === storefrontOperatorMerchantId ? 'direct' : 'marketplace';
}

/**
 * Derive the delivery facts, refusing to invent the ones the source withheld
 * (issue commercial fact 7, acceptance 4).
 *
 * The cost is KNOWN only when both halves of its `Money` are present. Days and
 * a free-over threshold without a cost do not make it known: "arrives in 2–4
 * days" says nothing about what it costs, and a ranking that read that as free
 * delivery would put an unpriced offer above a genuinely free one.
 */
export function deriveOfferDelivery(input: {
  costAmount?: number | null;
  costCurrency?: string | null;
  freeOverAmount?: number | null;
  freeOverCurrency?: string | null;
  minDays?: number | null;
  maxDays?: number | null;
  pickup: OfferPickupState;
}): OfferDelivery {
  if (
    input.costAmount === null ||
    input.costAmount === undefined ||
    !input.costCurrency
  ) {
    return { known: false, pickup: input.pickup };
  }

  const freeOver =
    input.freeOverAmount !== null &&
    input.freeOverAmount !== undefined &&
    input.freeOverCurrency
      ? { amount: input.freeOverAmount, currency: input.freeOverCurrency }
      : undefined;

  return {
    known: true,
    cost: { amount: input.costAmount, currency: input.costCurrency },
    ...(freeOver ? { freeOver } : {}),
    ...(input.minDays === null || input.minDays === undefined ? {} : { minDays: input.minDays }),
    ...(input.maxDays === null || input.maxDays === undefined ? {} : { maxDays: input.maxDays }),
    pickup: input.pickup,
  };
}

/**
 * Derive an offer's condition projection from its stored columns (#90).
 *
 * `group` is present EXACTLY when the key is known. That biconditional is the
 * whole reason this is a function rather than a spread: a comparison surface
 * bucketing offers by `condition.group` silently drops the unknown ones, which
 * is correct, whereas defaulting them into `new` — the shape a `?? 'new'` would
 * produce — would tell a shopper an unlabelled feed item is factory-sealed.
 *
 * It converts nothing and upgrades nothing: the key comes out exactly as the
 * column holds it, and the CHECKs upstream are what guarantee an unmapped or
 * sub-floor row holds `unknown` in the first place.
 */
export function deriveOfferCondition(input: {
  condition: OfferConditionKey;
  mappingState: ConditionMappingState;
  sourceLabel?: string | null;
  mappingRulesetVersion?: number | null;
}): OfferConditionDTO {
  const group: ConditionGroup | undefined =
    input.condition === 'unknown' ? undefined : CONDITION_KEY_GROUP[input.condition];

  return {
    key: input.condition,
    ...(group ? { group } : {}),
    mappingState: input.mappingState,
    ...(input.sourceLabel ? { sourceLabel: input.sourceLabel } : {}),
    ...(input.mappingRulesetVersion === null || input.mappingRulesetVersion === undefined
      ? {}
      : { mappingRulesetVersion: input.mappingRulesetVersion }),
  };
}

/** The live facts the native checkout gate reads. Every one belongs to another domain. */
export interface NativeCheckoutFacts {
  kind: OfferKind;
  status: OfferStatus;
  listingId?: string | null;
  productVariantId?: string | null;
  /** The listing's status RIGHT NOW, not a copy taken when the offer was written. */
  listingStatus?: string | null;
  /** Whether the variant tracks stock at all; an untracked variant is never out of stock. */
  inventoryTracked?: boolean | null;
  inventoryAvailable?: number | null;
  /** ADR 0001 D9's one stored verdict, read live from `provider_accounts`. */
  sellerPaymentReady: boolean;
}

/**
 * Decide whether a native offer can be checked out — the ONE derivation
 * (issue commercial fact 10, native rules 2 and 5, acceptance 6).
 *
 * Every reason that applies is returned, not just the first: a seller looking at
 * why their offer is not buyable needs the whole list, and an operator trace
 * that reported one cause at a time would take four round trips to explain a
 * listing that is restricted, unstocked and unpayable at once.
 *
 * There is no stored counterpart. A `checkout_eligible` column would be a second
 * authority over three facts this domain does not own, and it would be wrong for
 * exactly as long as it took a converger to notice — which is the window in
 * which a restricted listing must not be buyable.
 */
export function deriveNativeCheckoutEligibility(
  facts: NativeCheckoutFacts,
): NativeCheckoutEligibility {
  const reasons: NativeCheckoutBlockReason[] = [];

  if (facts.kind !== 'native') reasons.push('not_native');
  if (facts.status !== 'active') reasons.push('offer_retired');

  if (facts.listingStatus === 'restricted') {
    reasons.push('listing_restricted');
  } else if (facts.listingStatus !== 'active') {
    // An absent listing status reads as not-active, which is the fail-closed
    // direction: a caller that could not resolve the listing must not be handed
    // a buyable verdict about it.
    reasons.push('listing_not_active');
  }

  if (!facts.productVariantId || !facts.listingId) reasons.push('variant_missing');

  // An untracked variant has unlimited stock by the catalogue's own rule
  // (`hasInventory` treats it as available), so only a TRACKED variant can be
  // out of stock. Reading `inventoryAvailable` without that guard would refuse
  // every untracked P2P listing, which sell fine today.
  if (facts.inventoryTracked !== false && (facts.inventoryAvailable ?? 0) <= 0) {
    reasons.push('out_of_stock');
  }

  if (!facts.sellerPaymentReady) reasons.push('seller_not_payment_ready');

  if (reasons.length > 0) return { eligible: false, reasons };

  // Both ids are non-null here — `variant_missing` above is what proves it — but
  // the compiler cannot see through the array, and a non-null assertion is
  // forbidden, so they are re-read through a guard that can only be reached when
  // the list is empty.
  const listingId = facts.listingId;
  const productVariantId = facts.productVariantId;
  if (!listingId || !productVariantId) {
    return { eligible: false, reasons: ['variant_missing'] };
  }

  return { eligible: true, listingId, productVariantId };
}
