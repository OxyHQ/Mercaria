/**
 * Review DTOs for the Mercaria reviews + ratings flow.
 *
 * ## A rating answers ONE question (#76)
 *
 * Before #76 a review named a `listing`, a `store` or a `seller` and every one
 * of them fed a single star average, so "the courier lost it" and "the fabric
 * tore" landed in the same number. {@link ReviewScope} is the question a rating
 * answers; {@link ReviewTargetType} is the column that holds the thing being
 * rated. They are different facts — `listing` alone cannot say whether a review
 * is about the PRODUCT or about the CONDITION of one used copy, and that
 * ambiguity is precisely what #76 exists to resolve — and
 * {@link REVIEW_SCOPE_TARGET_TYPE} is the ONE mapping between them, mirrored by
 * a database CHECK so the two can never disagree.
 *
 * A public review always has an Oxy author. Guest purchases become reviewable
 * only through an explicit claim (#109), never automatically and never from a
 * matching email address.
 *
 * ## What is deliberately unrepresentable here
 *
 *  - **A brand rating.** {@link REVIEW_FORBIDDEN_SCOPES} and
 *    {@link REVIEW_SCOPES} are DISJOINT unions, so averaging product reviews
 *    into a brand score has no scope to be stored under and no target column to
 *    name.
 *  - **Buyer contact data on a review.** A review carries an eligibility id, and
 *    an eligibility carries an order line. Neither carries an email, a phone, a
 *    checkout token or a portal token — there is no field, in either direction.
 *  - **Eligibility from anything but a purchase.**
 *    {@link REVIEW_EVIDENCE_TYPES} has exactly two members and
 *    {@link REVIEW_FORBIDDEN_EVIDENCE_SOURCES} names the fourteen things that
 *    may never create one. The two unions are disjoint, which is what makes
 *    "an affiliate click is not proof of purchase" a type error rather than a
 *    policy note.
 */

import type { Timestamps } from './common';

/**
 * The QUESTION a rating answers. Aggregates are kept per scope and are never
 * blended: a `merchant` review cannot move a `product` rating, and vice versa.
 *
 *  - `product` — the canonical product experience, independent of who sold it.
 *  - `merchant` — a seller's service, fulfilment and reliability.
 *  - `native_transaction` — one completed Mercaria order LINE and its
 *    seller-specific experience.
 *  - `p2p_listing` — the condition and description accuracy of one used listing.
 *    Never presented as a product-quality rating (#76 UI rule 5).
 *  - `p2p_seller` — a person's reputation as a seller. Mercaria's own view of
 *    its own marketplace; Oxy Trust owns reputation across the ecosystem and
 *    this never duplicates it.
 */
export type ReviewScope =
  | 'product'
  | 'merchant'
  | 'native_transaction'
  | 'p2p_listing'
  | 'p2p_seller';

/** {@link ReviewScope} as the tuple the column type and its CHECK both read. */
export const REVIEW_SCOPES: readonly ReviewScope[] = [
  'product',
  'merchant',
  'native_transaction',
  'p2p_listing',
  'p2p_seller',
];

/**
 * Scopes that MAY NOT exist, named so the prohibition is a value rather than an
 * omission somebody can quietly fill in.
 *
 * `brand` is the one the issue calls out: "do not create a general brand rating
 * by averaging product reviews". A brand's quality is not the mean of the
 * quality of the things it makes, and a rating computed that way would be
 * unattributable to any review a buyer wrote. `organization`, `product_family`,
 * `category` and `platform` are the same mistake at four other grains.
 *
 * This union is DISJOINT from {@link REVIEW_SCOPES} — asserted by a test — so a
 * later widening cannot accidentally admit one.
 */
export const REVIEW_FORBIDDEN_SCOPES = [
  'brand',
  'organization',
  'product_family',
  'category',
  'platform',
] as const;

/** A scope Mercaria will not compute. See {@link REVIEW_FORBIDDEN_SCOPES}. */
export type ReviewForbiddenScope = (typeof REVIEW_FORBIDDEN_SCOPES)[number];

/**
 * Which COLUMN holds the target of a review.
 *
 * The first three are the pre-#76 vocabulary and remain in use for the
 * compatibility window: a review nobody has classified yet still names a
 * `listing`, a `store` or a `seller` and still reads exactly as it did. The
 * last three arrived with the scoped model.
 */
export type ReviewTargetType =
  | 'listing'
  | 'store'
  | 'seller'
  | 'canonical_product'
  | 'merchant'
  | 'order_item';

/** {@link ReviewTargetType} as the tuple the column type and its CHECK both read. */
export const REVIEW_TARGET_TYPES: readonly ReviewTargetType[] = [
  'listing',
  'store',
  'seller',
  'canonical_product',
  'merchant',
  'order_item',
];

/**
 * The target types that predate #76 and carry no scope until classification
 * decides one. A review on one of these is served by the legacy read paths.
 */
export const LEGACY_REVIEW_TARGET_TYPES: readonly ReviewTargetType[] = [
  'listing',
  'store',
  'seller',
];

/**
 * The ONE scope → target-type mapping.
 *
 * Every consumer reads it rather than switching, and
 * `reviews_scope_target_type_check` renders the same pairs into SQL — so the
 * two columns cannot disagree about what a row is. Note `p2p_listing` and
 * `p2p_seller` map onto the LEGACY columns: classifying one of those reviews
 * moves no data, which is what makes that half of the migration free.
 */
export const REVIEW_SCOPE_TARGET_TYPE: Readonly<Record<ReviewScope, ReviewTargetType>> =
  Object.freeze({
    product: 'canonical_product',
    merchant: 'merchant',
    native_transaction: 'order_item',
    p2p_listing: 'listing',
    p2p_seller: 'seller',
  });

/**
 * Whether the review is backed by a consumed purchase eligibility.
 *
 * `unverified` reviews are labelled and counted SEPARATELY (#76 verification
 * rule 5) — they never enter the primary rating average, so "weighted
 * separately" is a property of the aggregate's shape rather than of a
 * multiplier somebody has to remember to apply.
 */
export type ReviewVerificationState = 'verified_purchase' | 'unverified';

/** {@link ReviewVerificationState} as a tuple. */
export const REVIEW_VERIFICATION_STATES: readonly ReviewVerificationState[] = [
  'verified_purchase',
  'unverified',
];

/**
 * How a purchase was proven. Exactly two, and both are a PURCHASE.
 *
 *  - `authenticated_purchase` — the order was placed by, or has been claimed by,
 *    the Oxy account now reviewing it.
 *  - `claimed_guest_purchase` — a guest order that #109's claim moved into an
 *    Oxy account. Requires a claim id; there is no way to assert one without
 *    the claim record.
 */
export type ReviewEvidenceType = 'authenticated_purchase' | 'claimed_guest_purchase';

/** {@link ReviewEvidenceType} as a tuple. */
export const REVIEW_EVIDENCE_TYPES: readonly ReviewEvidenceType[] = [
  'authenticated_purchase',
  'claimed_guest_purchase',
];

/**
 * Signals that may NEVER create or consume review eligibility, named so each
 * refusal can say which one it refused instead of "unrecognized field".
 *
 * DISJOINT from {@link REVIEW_EVIDENCE_TYPES}, asserted by a test. Every entry
 * is something that identifies a PERSON or a DEVICE rather than establishing
 * that goods changed hands:
 *
 *  - a matching email address between a guest checkout and an Oxy account
 *    proves the two strings are equal and nothing else (#76 verification 9);
 *  - a Stripe Customer, a Link account, a wallet, a card fingerprint or a saved
 *    payment method identifies an instrument, not a delivery (#76
 *    verification 10);
 *  - an affiliate click and a conversion report are a referral network's
 *    opinion about traffic (#76 verification 3/4);
 *  - a portal token and a checkout token are access credentials — holding one
 *    means somebody can READ an order, not that they bought it;
 *  - possession of a guest session is a device, not a person (ADR 0003 D14).
 */
export const REVIEW_FORBIDDEN_EVIDENCE_SOURCES = [
  'email_match',
  'contact_match',
  'stripe_customer',
  'stripe_link',
  'wallet',
  'card_fingerprint',
  'payment_method',
  'affiliate_click',
  'conversion_report',
  'portal_token',
  'checkout_token',
  'guest_session_possession',
  'marketing_consent',
  'ip_match',
] as const;

/** A signal that cannot establish eligibility. See {@link REVIEW_FORBIDDEN_EVIDENCE_SOURCES}. */
export type ReviewForbiddenEvidenceSource = (typeof REVIEW_FORBIDDEN_EVIDENCE_SOURCES)[number];

/** Whether an eligibility is still usable, already spent, or withdrawn. */
export type ReviewEligibilityState = 'open' | 'consumed' | 'revoked' | 'disputed';

/** {@link ReviewEligibilityState} as a tuple. */
export const REVIEW_ELIGIBILITY_STATES: readonly ReviewEligibilityState[] = [
  'open',
  'consumed',
  'revoked',
  'disputed',
];

/**
 * The eligibility policy this row was granted under, stamped on every record.
 *
 * A policy change is a NEW version — the `fee_schedules` posture, reduced to a
 * string because there is nothing here to price. It exists so a later audit can
 * tell an eligibility granted under today's rules from one granted under the
 * rules of the day it was written, without inferring it from a timestamp.
 */
export const REVIEW_ELIGIBILITY_POLICY_VERSION = '2026-08-09.1';

/**
 * Whether a reviewer disclosed an incentive. `none` is the ordinary case and is
 * stored explicitly rather than left NULL, so "nobody asked" and "the reviewer
 * said no" are different facts.
 */
export type ReviewIncentiveDisclosure =
  | 'none'
  | 'free_or_discounted_product'
  | 'sweepstakes_entry'
  | 'compensated'
  | 'other';

/** {@link ReviewIncentiveDisclosure} as a tuple. */
export const REVIEW_INCENTIVE_DISCLOSURES: readonly ReviewIncentiveDisclosure[] = [
  'none',
  'free_or_discounted_product',
  'sweepstakes_entry',
  'compensated',
  'other',
];

/**
 * Where a review stands in the #76 migration.
 *
 *  - `native` — written after #76, born with a scope.
 *  - `classified` — a legacy review the migration assigned a scope to.
 *  - `unclassified` — a legacy review the migration has not examined.
 *  - `ambiguous` — a legacy review the migration EXAMINED and refused to
 *    classify. The distinction from `unclassified` is the point: "we have not
 *    looked" and "we looked and could not tell" need different follow-up, and
 *    collapsing them turns a decision into a backlog.
 */
export type ReviewClassificationState = 'native' | 'classified' | 'unclassified' | 'ambiguous';

/** {@link ReviewClassificationState} as a tuple. */
export const REVIEW_CLASSIFICATION_STATES: readonly ReviewClassificationState[] = [
  'native',
  'classified',
  'unclassified',
  'ambiguous',
];

/**
 * Why the migration refused to classify a review. Every value names a MISSING
 * FACT, never a guess it declined to make on style grounds.
 */
export type ReviewAmbiguityReason =
  | 'store_has_no_linked_merchant'
  | 'listing_has_no_canonical_product'
  | 'listing_no_longer_exists'
  | 'split_requires_explicit_assignment';

/** {@link ReviewAmbiguityReason} as a tuple. */
export const REVIEW_AMBIGUITY_REASONS: readonly ReviewAmbiguityReason[] = [
  'store_has_no_linked_merchant',
  'listing_has_no_canonical_product',
  'listing_no_longer_exists',
  'split_requires_explicit_assignment',
];

/** What a `review_target_migrations` row records. */
export type ReviewTargetMigrationAction =
  | 'classify'
  | 'refuse_ambiguous'
  | 'rehome_merge'
  | 'assign_split';

/** {@link ReviewTargetMigrationAction} as a tuple. */
export const REVIEW_TARGET_MIGRATION_ACTIONS: readonly ReviewTargetMigrationAction[] = [
  'classify',
  'refuse_ambiguous',
  'rehome_merge',
  'assign_split',
];

/**
 * A structured sub-rating. The vocabulary is scope-specific on purpose — see
 * {@link REVIEW_SCOPE_DIMENSION_KEYS}.
 */
export type ReviewDimensionKey =
  // product
  | 'quality'
  | 'durability'
  | 'value_for_money'
  // merchant / native_transaction
  | 'delivery_speed'
  | 'packaging'
  | 'communication'
  | 'order_accuracy'
  // p2p_listing
  | 'condition_accuracy'
  | 'description_accuracy'
  | 'photo_accuracy'
  // p2p_seller
  | 'shipping_speed'
  | 'reliability';

/** {@link ReviewDimensionKey} as a tuple. */
export const REVIEW_DIMENSION_KEYS: readonly ReviewDimensionKey[] = [
  'quality',
  'durability',
  'value_for_money',
  'delivery_speed',
  'packaging',
  'communication',
  'order_accuracy',
  'condition_accuracy',
  'description_accuracy',
  'photo_accuracy',
  'shipping_speed',
  'reliability',
];

/**
 * Which dimensions each scope admits — the second wall between the scopes, and
 * the one that makes acceptance criteria 1 and 2 structural.
 *
 * `delivery_speed` appears under `merchant` and `native_transaction` and under
 * NO product scope, so a slow courier has nowhere to land on a product rating.
 * `condition_accuracy` appears only under `p2p_listing`, so one seller's
 * scuffed copy cannot become a defect of the model. The lists are deliberately
 * disjoint across the product/service boundary; where two service scopes share
 * a key that is because they are asking the same question of the same seller at
 * two different grains.
 */
export const REVIEW_SCOPE_DIMENSION_KEYS: Readonly<
  Record<ReviewScope, readonly ReviewDimensionKey[]>
> = Object.freeze({
  product: ['quality', 'durability', 'value_for_money'],
  merchant: ['delivery_speed', 'packaging', 'communication', 'order_accuracy'],
  native_transaction: ['delivery_speed', 'packaging', 'communication', 'order_accuracy'],
  p2p_listing: ['condition_accuracy', 'description_accuracy', 'photo_accuracy'],
  p2p_seller: ['communication', 'shipping_speed', 'reliability'],
});

/** Minimal author identity rendered on a review (from the Oxy profile). */
export interface ReviewAuthor {
  /** Canonical display name (`name.displayName` from the Oxy profile). */
  displayName: string;
  /** Oxy username. */
  username: string;
  /** Resolved avatar URL, when present. */
  avatar?: string | null;
}

/**
 * Minimal product context attached to a review when the review is listed in a
 * PRODUCT-centric context (e.g. a store's reviews sheet, which renders the
 * reviewed product's thumbnail + title on each card). Only populated by the
 * store-reviews serializer; `undefined` on a listing's own reviews page.
 */
export interface ReviewProduct {
  /** The reviewed listing id (route target for the thumbnail link). */
  id: string;
  /** The reviewed product/variant title shown on the card. */
  title: string;
  /** Resolved URL of the listing's first image (empty string when none). */
  imageUrl: string;
}

/** One structured sub-rating on a review. */
export interface ReviewDimension {
  key: ReviewDimensionKey;
  /** Star rating, 1–5. */
  rating: number;
}

/**
 * A published (or hidden) review, with the relevant target id set and the
 * author hydrated for display.
 *
 * NOTE what has no field here and never will: a buyer email, a phone number, a
 * checkout token, a portal token, a guest session id, or any payment
 * identifier. Authorship is public Oxy identity or nothing (#76 privacy 1).
 */
export interface Review extends Timestamps {
  /** Stable review id. */
  id: string;
  /** Oxy user id of the review author (the buyer). */
  authorOxyUserId: string;
  /** Hydrated author identity, when the Oxy profile resolves. */
  author?: ReviewAuthor;
  /**
   * Minimal reviewed-product context, populated ONLY when the review is served
   * in a product-centric list (the store reviews sheet). Left `undefined` on a
   * listing's own reviews page, where the product is already in context.
   */
  product?: ReviewProduct;
  /** Which column holds the target. */
  targetType: ReviewTargetType;
  /** The question this rating answers. Absent on an unclassified legacy review. */
  scope?: ReviewScope;
  /** The reviewed listing id, for `targetType: 'listing'`. */
  listingId?: string;
  /** The reviewed store id, for `targetType: 'store'`. */
  storeId?: string;
  /** The reviewed P2P seller's Oxy user id, for `targetType: 'seller'`. */
  sellerOxyUserId?: string;
  /** The reviewed canonical product id, for `targetType: 'canonical_product'`. */
  canonicalProductId?: string;
  /** The reviewed merchant id, for `targetType: 'merchant'`. */
  merchantId?: string;
  /** The reviewed order LINE id, for `targetType: 'order_item'`. */
  orderItemId?: string;
  /** The qualifying order the review was written against, when supplied. */
  orderId?: string;
  /**
   * The consumed purchase eligibility. This — not a buyer email, not a
   * checkout token — is the immutable evidence reference a review carries
   * (#76 model rule 11).
   */
  eligibilityId?: string;
  /** Whether a purchase backs this review. Unverified reviews count separately. */
  verification: ReviewVerificationState;
  /** Star rating, 1–5. */
  rating: number;
  /** Structured sub-ratings, in the scope's own vocabulary. */
  dimensions?: ReviewDimension[];
  /** Optional short title. */
  title?: string;
  /** Optional free-text body. */
  body?: string;
  /** BCP-47 tag of the language the review was written in, when known. */
  locale?: string;
  /** Whether the reviewer received an incentive. */
  incentiveDisclosure: ReviewIncentiveDisclosure;
  /** Moderation state. `hidden` reviews are excluded from public reads + aggregates. */
  status: 'published' | 'hidden';
  /** When the review became publicly visible. */
  publishedAt?: string;
  /** When the author last edited the text, if ever. */
  editedAt?: string;
  /** Where this review stands in the #76 scope migration. */
  classificationState: ReviewClassificationState;
  /** Why classification refused, when `classificationState` is `ambiguous`. */
  ambiguityReason?: ReviewAmbiguityReason;
}

/**
 * Body for `POST /reviews` — write a scoped review.
 *
 * The target id field required depends on `scope`; `targetType` is DERIVED
 * server-side from {@link REVIEW_SCOPE_TARGET_TYPE} and is deliberately not
 * accepted from a client, so the two can never arrive disagreeing.
 */
export interface CreateReviewInput {
  /** The question this rating answers. */
  scope: ReviewScope;
  /** Required when `scope` is `'product'`. */
  canonicalProductId?: string;
  /** Required when `scope` is `'merchant'`. */
  merchantId?: string;
  /** Required when `scope` is `'native_transaction'`. */
  orderItemId?: string;
  /** Required when `scope` is `'p2p_listing'`. */
  listingId?: string;
  /** Required when `scope` is `'p2p_seller'`. */
  sellerOxyUserId?: string;
  /**
   * The eligibility being spent. Optional: when omitted the service picks the
   * author's oldest OPEN eligibility for this scope and target, which is what a
   * client that never saw an eligibility id (the ordinary product page) does.
   */
  eligibilityId?: string;
  /** Star rating, 1–5. */
  rating: number;
  /** Structured sub-ratings; every key must belong to the scope. */
  dimensions?: ReviewDimension[];
  /** Optional short title. */
  title?: string;
  /** Optional free-text body. */
  body?: string;
  /** BCP-47 tag of the language the review is written in. */
  locale?: string;
  /** Whether the reviewer received an incentive. Defaults to `none`. */
  incentiveDisclosure?: ReviewIncentiveDisclosure;
}

/**
 * A durable grant: this Oxy account may write ONE review of this scope and
 * target, because this order line says they bought it.
 *
 * Separate from the review so an order correction, a moderation action and a
 * claim audit stay explainable independently of whatever text was written.
 *
 * Nothing here identifies a buyer beyond their Oxy id: no email, no phone, no
 * payment method, no session. The evidence is an order line.
 */
export interface ReviewEligibility {
  id: string;
  /** The Oxy account that may spend this eligibility. */
  oxyUserId: string;
  /** The order the purchase is recorded on. */
  orderId: string;
  /** The exact line. One line grants at most one eligibility per scope. */
  orderItemId: string;
  /** The scope this eligibility unlocks. */
  scope: ReviewScope;
  /** Which column holds the target. */
  targetType: ReviewTargetType;
  /** The target id, resolved out of whichever column holds it. */
  targetId: string;
  /** How the purchase was proven. */
  evidenceType: ReviewEvidenceType;
  /** The #109 claim, present exactly when `evidenceType` is a claimed guest purchase. */
  claimId?: string;
  state: ReviewEligibilityState;
  /** The review that spent it, when spent. */
  consumedByReviewId?: string;
  consumedAt?: string;
  /** Why it was withdrawn, when it was. */
  revokedReason?: string;
  revokedAt?: string;
  disputedAt?: string;
  /** The policy version this grant was made under. */
  policyVersion: string;
  createdAt: string;
}

/** One dimension's aggregate within a scoped rating aggregate. */
export interface ReviewDimensionAggregate {
  key: ReviewDimensionKey;
  /** Average sub-rating over verified published reviews. */
  rating: number;
  /** How many verified published reviews supplied this dimension. */
  count: number;
}

/**
 * A scoped rating aggregate — the ONE public number for one question about one
 * target.
 *
 * `rating`/`reviewCount` cover VERIFIED published reviews only. Unverified ones
 * are a separate pair that is never summed in, which is how "labelled and
 * weighted separately" survives contact with a serializer: there is no combined
 * total to reach for.
 *
 * Guest ORIGIN is not a dimension here and has no field. A claimed guest
 * purchase produces an ordinary verified review with ordinary weight (#76
 * acceptance 11).
 */
export interface ScopedRatingAggregate {
  scope: ReviewScope;
  targetType: ReviewTargetType;
  targetId: string;
  /** Average star rating over VERIFIED published reviews (0 when there are none). */
  rating: number;
  /** Number of VERIFIED published reviews. */
  reviewCount: number;
  /** Unverified published reviews, counted apart and never blended in. */
  unverified: {
    rating: number;
    count: number;
  };
  /** Per-dimension averages, verified reviews only. */
  dimensions: ReviewDimensionAggregate[];
  /** When the aggregate was last derived from review rows. */
  lastRebuiltAt?: string;
}

/**
 * Where a native store's public rating comes from.
 *
 * A native store that resolves to a canonical merchant shows the MERCHANT
 * aggregate; one that does not shows its own legacy store aggregate. Exactly
 * one of the two, from one function, which is how "merchant and native-store
 * linkage must not double-count one review in two public aggregates" (#76
 * migration rule 6) is answered by construction rather than by a rule.
 */
export type StoreRatingSourceKind = 'merchant' | 'legacy_store';

/** A store's public rating plus the statement of where it came from. */
export interface StoreRatingSource {
  kind: StoreRatingSourceKind;
  /** The canonical merchant the rating was read from, for `kind: 'merchant'`. */
  merchantId?: string;
  rating: number;
  reviewCount: number;
}

/** The denormalized rating aggregate persisted on a LEGACY review target. */
export interface RatingAggregate {
  /** Average star rating (0 when there are no published reviews). */
  rating: number;
  /** Number of published reviews. */
  reviewCount: number;
}

/** One drift finding from the aggregate rebuild sweep. */
export interface ReviewAggregateDrift {
  scope: ReviewScope;
  targetId: string;
  /** What the stored aggregate claimed. */
  storedRating: number;
  storedReviewCount: number;
  /** What the review rows actually say. */
  derivedRating: number;
  derivedReviewCount: number;
}

/** The outcome of one bounded run of the aggregate rebuild sweep. */
export interface ReviewAggregateRebuildReport {
  /** Aggregates examined in this run. */
  scanned: number;
  /** Aggregates whose stored figures disagreed with the review rows. */
  drifted: ReviewAggregateDrift[];
  /** Whether the run stopped on its batch ceiling and has more to do. */
  hasMore: boolean;
}

/** The outcome of one bounded run of the legacy-review classification job. */
export interface ReviewClassificationReport {
  /** Legacy reviews examined in this run. */
  scanned: number;
  /** Reviews given a scope. */
  classified: number;
  /** Reviews examined and left on their legacy target, with a stated reason. */
  ambiguous: number;
  /** Whether the run stopped on its batch ceiling and has more to do. */
  hasMore: boolean;
}
