/**
 * What a buyer is told about WHO is selling, WHO is paid and WHAT rights come
 * with the purchase (#129, ADR 0004 D9.1/D9.3/D2.8, ADR 0002 D8).
 *
 * Mercaria has three genuinely different commercial relationships and one
 * non-commercial one, and #129's whole point is that a person can tell them
 * apart before every purchase action: Mercaria sending them to another
 * retailer, Mercaria processing a connected merchant's sale, and Mercaria
 * selling the item itself while a supplier fulfils it.
 *
 * ## The mode is READ, never re-inferred
 *
 * All four already exist as facts somewhere: #57's `OfferKind` says whether a
 * destination leaves Mercaria, `retail_offer_bindings` says which catalogue
 * variant Mercaria sells itself, and #123's `orders.commercial_role` — tied to
 * `seller_type = 'platform'` by a biconditional CHECK — says what a placed
 * order was. {@link deriveCommercialMode} maps those facts onto
 * {@link CommercialMode} and reads nothing else, so a screen can never reach a
 * different answer from the one checkout reached. A component that looked at a
 * seller's name, a logo, a price or a badge would be the false-attribution
 * failure #55 already refuses one layer down, arriving through the UI.
 *
 * ## Nothing here has a common field
 *
 * {@link CommercialPresentation} is a discriminated union on `mode` with NO
 * shared `sellerLabel`, `price` or `id`, which is the `CommerceActor` /
 * `OrderBuyer` / `CartOwner` device: every consumer must `switch`, so
 * "`Sold by Mercaria` never appears on an affiliate referral or a
 * connected-merchant offer" (acceptance 2) is a compile error rather than a
 * copy review. The seller label of a marketplace offer and the seller label of
 * a retail offer are different facts about different parties, and one field
 * holding both is how they get swapped.
 *
 * ## The prohibitions are a vocabulary, not a filter
 *
 * {@link COMMERCIAL_FORBIDDEN_DISCLOSURE_FACTS} names the eleven things that
 * may never reach a customer surface — the wholesale cost, the supplier's
 * identity and SKU, the carrier account, a provider's own rejection text, the
 * referring partner and their commission, and any margin figure. It is DISJOINT
 * from every field this module defines, the `RetailForbiddenComponentKind`
 * device, so the refusal names the exact fact instead of saying "unrecognized".
 *
 * ## String discriminants, deliberately
 *
 * The backend compiles with `strict: false`, and without `strictNullChecks`
 * TypeScript does not narrow a union on the TRUTHINESS of a boolean-literal
 * discriminant — the finding #68 and #110 both hit. Every union here is
 * discriminated on a string.
 */

import type { CommercialMode } from './fees';
import type { CurrencyCode, Money } from './money';
import type { RetailCostBlockReason, RetailPricePresentation } from './retail-pricing';
import type { RetailPriceFinality } from './retail-eligibility';

/**
 * The facts a commercial mode may be derived from, and NOTHING else.
 *
 * The type IS the prohibition (`SourcingCandidateFacts` and
 * `EntityRelevanceInput`, one domain over): there is no member for a margin, a
 * commission rate, a marketplace fee, a merchant plan, a referral code or a
 * payment-provider preference, so #129 ranking rule 3 and referral rule 2 hold
 * because the derivation cannot see them rather than because it ignores them.
 */
export interface CommercialModeFacts {
  /** #57's offer kind, or `native` for a listing surface that has no offer row. */
  offerKind: 'native' | 'external' | 'affiliate' | 'informational';
  /**
   * Whether this exact catalogue variant carries a LIVE `retail_offer_bindings`
   * row — the same authority `partitionRetailLines` reads at checkout.
   *
   * There is no `mercaria_retail` member of `OfferKind` (reserved for #116's
   * own migration), so this is what tells Mercaria's own sale apart from an
   * ordinary native listing, and reading the binding is what makes the product
   * page and the till agree by construction.
   */
  hasLiveRetailBinding: boolean;
}

/**
 * Which of the four relationships this is.
 *
 * `informational` and `external_referral` never produce a Mercaria order, so a
 * surface that reaches for one from an order is asking a question with no
 * answer — which is why {@link COMMERCIAL_MODE_NATIVE_CHECKOUT} is a table
 * rather than a branch.
 */
export function deriveCommercialMode(facts: CommercialModeFacts): CommercialMode {
  switch (facts.offerKind) {
    case 'native':
      return facts.hasLiveRetailBinding ? 'mercaria_retail' : 'connected_marketplace';
    case 'external':
    case 'affiliate':
      return 'external_referral';
    case 'informational':
      return 'informational';
  }
}

/**
 * Whether a mode may reach the native cart and the Stripe rail at all.
 *
 * A TABLE and not a predicate, so "external referral offers remain outside the
 * native cart and order history" (acceptance 4) is a value a reviewer can read
 * rather than a condition spread over a cart screen, a checkout screen and an
 * order screen. #57 already makes it structural — `offers_kind_shape_check`
 * leaves a non-native offer with no `product_variant_id` a cart line could
 * hold — and this states the same fact where the UI can see it.
 */
export const COMMERCIAL_MODE_NATIVE_CHECKOUT: Readonly<Record<CommercialMode, boolean>> = {
  mercaria_retail: true,
  connected_marketplace: true,
  external_referral: false,
  informational: false,
};

/**
 * The centralized legal-role copy KEYS (#129 §"Content and legal copy").
 *
 * The keys live here and the words live in `@mercaria/ui`
 * (`lib/commercial-copy.ts`), the `condition.ts` and `offer-labels.ts`
 * arrangement: a stored disclosure key on a placed order must keep resolving
 * after a copy correction, which it cannot if the sentence is the key. Which
 * keys a presentation REQUIRES is decided once, by
 * {@link commercialDisclosureKeys}, so no component decides a legal role for
 * itself.
 */
export const COMMERCIAL_DISCLOSURE_KEYS = [
  'sold_by_mercaria',
  'fulfilled_by_approved_partner',
  'sold_by_merchant',
  'external_checkout',
  'affiliate_disclosure',
  'referral_disclosure',
  'supply_confirmation_pending',
  'price_or_availability_changed',
  'procurement_failed_refund_pending',
  'returns_and_warranty',
  'tax_or_import_uncertainty',
  'product_recall_or_safety_notice',
] as const;

/** {@link COMMERCIAL_DISCLOSURE_KEYS} as a union. */
export type CommercialDisclosureKey = (typeof COMMERCIAL_DISCLOSURE_KEYS)[number];

/**
 * The facts that may never appear on a customer-facing commercial surface
 * (#129 retail rule 6, cart rule 9, order rule 6, referral rules 3 and 6,
 * analytics closing paragraph; #126 privacy).
 *
 * DISJOINT from every field any type in this module defines, and asserted so by
 * `commercial-presentation-isolation.test.ts`. Named as VALUES rather than
 * described in prose because a prohibition nothing can enumerate is one nobody
 * can test: the gate walks a really-emitted presentation for each of them.
 */
export const COMMERCIAL_FORBIDDEN_DISCLOSURE_FACTS = [
  'wholesale_cost',
  'supplier_identity',
  'supplier_sku',
  'supplier_account',
  'supplier_agreement',
  'procurement_offer',
  'carrier_account',
  'provider_rejection_text',
  'referral_partner_identity',
  'referral_commission',
  'mercaria_margin',
] as const;

/** {@link COMMERCIAL_FORBIDDEN_DISCLOSURE_FACTS} as a union. */
export type CommercialForbiddenDisclosureFact =
  (typeof COMMERCIAL_FORBIDDEN_DISCLOSURE_FACTS)[number];

/**
 * The four consumer-rights windows a Mercaria-retail purchase carries.
 *
 * Numbers rather than a version pointer alone, because #126 stores them as
 * numbers on the order's role snapshot for exactly the same reason: a version
 * is only as durable as the code that can still resolve it, and a buyer asking
 * what they agreed to is asking about the numbers.
 */
export interface RetailCustomerRights {
  /** The terms document version these four were read from. */
  termsVersion: string;
  cancellationWindowHours: number;
  withdrawalWindowDays: number;
  returnWindowDays: number;
  warrantyMonths: number;
}

/**
 * Mercaria is the seller and an approved partner fulfils (#129 §"Mercaria
 * retail", ADR 0004 D2.8).
 *
 * There is deliberately no supplier name, no supplier SKU, no wholesale figure
 * and no carrier here, and none may be added: the partner is disclosed by the
 * versioned DISCLOSURE KEY #117 selected and by nothing else, which is what
 * keeps "supplier fulfilment never causes the supplier to be mislabeled as
 * seller" (acceptance 3) true of a surface nobody has written yet.
 */
export interface MercariaRetailPresentation {
  mode: 'mercaria_retail';
  /** The selling legal entity, from `MERCARIA_RETAIL_SELLER_LEGAL_ENTITY`. */
  sellerLegalEntityName: string;
  /** ISO-3166-1 alpha-2 of the selling entity. Never defaulted. */
  sellerLegalEntityCountry: string;
  /** The #117 disclosure that applies, by key and version. */
  supplierFulfilmentDisclosureKey: string;
  supplierFulfilmentDisclosureVersion: number;
  rights: RetailCustomerRights;
  disclosures: readonly CommercialDisclosureKey[];
}

/**
 * A connected merchant or a P2P seller sells; Mercaria processes the payment
 * (#129 §"Connected marketplace").
 *
 * `sellerKind` mirrors the cart's and the order's own discriminant rather than
 * introducing a third: a store and a person are different sellers with
 * different pages, and one label field holding both is how a P2P seller ends up
 * described as a shop.
 */
export interface ConnectedMarketplacePresentation {
  mode: 'connected_marketplace';
  sellerKind: 'store' | 'user';
  /** The seller's public display name. Never a payout account or a contact. */
  sellerLabel: string;
  /**
   * Whether this offer's channel is operated by somebody OTHER than its seller
   * of record — ADR 0002 D8's marketplace derivation, read rather than stored.
   *
   * `unknown` is not a soft no: an offer whose channel operator Mercaria has
   * not resolved cannot be described either way, and describing it as a direct
   * sale would be the stronger claim.
   */
  sellerRole: 'direct' | 'marketplace' | 'unknown';
  disclosures: readonly CommercialDisclosureKey[];
}

/**
 * Mercaria is sending the buyer to another retailer (#129 §"External
 * referral").
 *
 * No price field, no returns field and no cart action: an external offer's
 * price is the retailer's to change between Mercaria observing it and the buyer
 * arriving, and Mercaria promises nothing about a purchase it does not process.
 * The observed price still travels on #57's own `Offer`, where it names its
 * freshness — this type is about what MERCARIA is telling the buyer, and the
 * distinction is what stops a comparison figure being read as a checkout total.
 */
export interface ExternalReferralPresentation {
  mode: 'external_referral';
  /** The destination retailer's public name, where Mercaria has resolved one. */
  destinationMerchantLabel?: string;
  /** The destination's hostname. Never the full tracked URL. */
  destinationHost?: string;
  /** Whether a paid-relationship disclosure is required for this destination. */
  affiliateDisclosureRequired: boolean;
  disclosures: readonly CommercialDisclosureKey[];
}

/**
 * Context with no purchase action at all (#129 §"Informational").
 *
 * Carries no price and no destination, so "no fabricated price or checkout" is
 * the absence of anything to fabricate one from.
 */
export interface InformationalPresentation {
  mode: 'informational';
  disclosures: readonly CommercialDisclosureKey[];
}

/** What a buyer is told, for one offer, cart group, order or listing variant. */
export type CommercialPresentation =
  | MercariaRetailPresentation
  | ConnectedMarketplacePresentation
  | ExternalReferralPresentation
  | InformationalPresentation;

/**
 * The disclosures a presentation REQUIRES, decided in one place.
 *
 * #129 §"Content and legal copy" is explicit that legal role logic must not be
 * scattered across individual components, so a screen renders this list and
 * never composes its own. The order is the order they must be read in.
 */
export function commercialDisclosureKeys(
  input:
    | { mode: 'mercaria_retail' }
    | { mode: 'connected_marketplace' }
    | { mode: 'external_referral'; affiliateDisclosureRequired: boolean }
    | { mode: 'informational' },
): readonly CommercialDisclosureKey[] {
  switch (input.mode) {
    case 'mercaria_retail':
      return ['sold_by_mercaria', 'fulfilled_by_approved_partner', 'returns_and_warranty'];
    case 'connected_marketplace':
      return ['sold_by_merchant'];
    case 'external_referral':
      return input.affiliateDisclosureRequired
        ? ['external_checkout', 'affiliate_disclosure']
        : ['external_checkout'];
    case 'informational':
      return [];
  }
}

/**
 * Why Mercaria can state no retail price at all — #129's own fourth state,
 * beside #120's three.
 *
 * #120's `RetailPricePresentation` always has a quote behind it; browsing does
 * not, and inventing a `RetailCostBlockReason` for "nobody has priced this"
 * would put a reason into a tuple whose CHECK is about a composed quote. So the
 * absence is its own value and stays out of #120's vocabulary.
 */
export const RETAIL_OFFER_UNQUOTED_REASONS = [
  'no_current_quote',
  'destination_not_supplied',
  'retail_not_enabled',
] as const;

/** {@link RETAIL_OFFER_UNQUOTED_REASONS} as a union. */
export type RetailOfferUnquotedReason = (typeof RETAIL_OFFER_UNQUOTED_REASONS)[number];

/**
 * What a surface may say about a Mercaria-retail price — #120's `presentation`
 * and `blockReasons`, rendered.
 *
 * Discriminated on `presentation`, whose three quoted values ARE
 * {@link RetailPricePresentation} verbatim, so there is one representation of
 * the verdict rather than a re-encoding of it. Money appears ONLY on the two
 * branches that may claim one: `not_purchasable` and `unquoted` have no amount
 * property at all, so "the UI must not display a total the domain refused to
 * certify" is a type error rather than a guideline, and an unknown cost can
 * never be rendered as zero.
 *
 * `starting_item_cost` carries `itemCostFrom` and NOT a total: #120's
 * `awaiting_destination` means shipping and tax are not yet knowable, and a
 * figure labelled as a total there is exactly the claim that value exists to
 * prevent.
 */
export type RetailOfferPriceStatement =
  | {
      presentation: 'exact_cost_only';
      /** What the buyer would pay, presentment side, for the quoted quantity. */
      buyerPayable: Money;
      currency: CurrencyCode;
      /** ISO-8601. After this the figure may not be charged against. */
      expiresAt: string;
      quotedAt: string;
      blockReasons: readonly RetailCostBlockReason[];
    }
  | {
      presentation: 'starting_item_cost';
      /** The item cost alone. Delivery and tax are not included and not known. */
      itemCostFrom: Money;
      currency: CurrencyCode;
      expiresAt: string;
      quotedAt: string;
      blockReasons: readonly RetailCostBlockReason[];
    }
  | {
      presentation: 'not_purchasable';
      expiresAt: string;
      quotedAt: string;
      /** Never empty on this branch — it is why nothing may be claimed. */
      blockReasons: readonly RetailCostBlockReason[];
    }
  | { presentation: 'unquoted'; reason: RetailOfferUnquotedReason };

/**
 * A Mercaria-retail offer as a buyer sees it (#129 §"Offer detail").
 *
 * `priceFinality` is #121's determination travelling verbatim — its own docblock
 * says `additional_charges_possible` does not block and is "#129's to render
 * from this value", so it is carried rather than folded into the price
 * statement, which would lose the distinction between a route that may attract
 * import charges and one whose price is simply unknown.
 */
export interface RetailOfferPresentation {
  canonicalVariantId: string;
  commercial: MercariaRetailPresentation;
  price: RetailOfferPriceStatement;
  /** Whether the displayed price may be claimed FINAL on this route. */
  priceFinality: RetailPriceFinality;
  /** The destination the answer was composed for, where the caller supplied one. */
  destinationCountry?: string;
}

/**
 * Where a retail order has got to, in the words a buyer reads (ADR 0004 D9.1).
 *
 * `confirming_availability` is the whole reason this vocabulary exists: between
 * the charge and every purchase order being accepted, the truthful state is
 * *"payment received — we are confirming availability with our fulfilment
 * partner"*, and the ADR says #129's UX must show exactly that and not
 * "confirmed". `confirmed` is therefore UNREACHABLE from a `paid` order — the
 * order's own status is what moves, and D9.2 already binds `processing` to
 * every purchase order being accepted, so this reads that one authority instead
 * of counting purchase orders a second time.
 *
 * There is deliberately NO `preparing` stage, and its absence is a statement
 * about what Mercaria can observe rather than an omission. #129 order rule 4
 * names preparation as a step, and #126 records `retail_fulfilment_intents`
 * for it — but the Moovo half that would report a package becoming ready is
 * #157/#159 and is unbuilt, so a `preparing` stage would sit in every buyer's
 * timeline and never advance. `confirmed` covers the window between supplier
 * acceptance and dispatch until there is something real to split it with.
 */
export const RETAIL_ORDER_PROGRESS_STAGES = [
  'awaiting_payment',
  'confirming_availability',
  'confirmed',
  'on_the_way',
  'delivered',
  'cancelled',
  'partially_refunded',
  'refunded',
] as const;

/** {@link RETAIL_ORDER_PROGRESS_STAGES} as a union. */
export type RetailOrderProgressStage = (typeof RETAIL_ORDER_PROGRESS_STAGES)[number];

/**
 * One delivery statement as a buyer reads it — #126's
 * `RetailDeliveryPromiseStatement`, projected.
 *
 * `sourceRef` is deliberately absent: it is a supplier quote or a Moovo
 * transport id and sits in `PROTECTED_COLUMNS`. `basis` travels because a
 * guaranteed promise and an advisory estimate are different commitments, and
 * showing an advisory one as a promise is the misrepresentation #126 rule 10
 * exists to prevent.
 */
export interface RetailDeliveryStatement {
  basis: 'guaranteed' | 'advisory';
  /** ISO-8601. Absent when the source gave only one end of the window. */
  earliestAt?: string;
  latestAt?: string;
  /** ISO-8601 — when the SOURCE observed it, never when Mercaria stored it. */
  observedAt: string;
  /** Derived against the reader's clock, never stored. */
  stale: boolean;
}

/**
 * What a buyer is told about a placed Mercaria-retail order.
 *
 * `accepted` and `current` are SEPARATE and neither substitutes for the other
 * (#126 rule 9): the accepted promise is what the buyer agreed to and is never
 * rewritten, the current estimate is what a source said since, and an absent
 * `current` means nothing has been observed since checkout rather than
 * "unchanged". `refreshFailing` is a third fact again — a surface showing only
 * the newest estimate would be confidently wrong about a figure whose refresh
 * has been failing for a day.
 */
export interface RetailOrderExperience {
  commercial: MercariaRetailPresentation;
  stage: RetailOrderProgressStage;
  /** The promise made at checkout. Immutable. */
  acceptedDelivery?: RetailDeliveryStatement;
  /** The newest observed estimate. Absent when nothing has been observed since. */
  currentDelivery?: RetailDeliveryStatement;
  /** True when the last refresh attempt failed. Carries no provider text. */
  refreshFailing: boolean;
}
