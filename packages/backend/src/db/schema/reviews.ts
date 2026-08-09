/**
 * The review domain (#76): `reviews`, `review_dimensions`,
 * `review_eligibilities`, `review_aggregates`, `review_target_migrations`.
 *
 * `reviews` was born in `buyers.ts` and moved here when #76 gave it targets in
 * the canonical graph — a scoped review references `canonical_products` and
 * `merchants`, both exported after `buyers` in the barrel's dependency order.
 * Its id did NOT move: CrowdSource holds review ids as `subject.externalId` and
 * a `moderation_enforcements` row is keyed on the decision plus this id, so a
 * new table would have orphaned every open case. Widening the row is the only
 * shape that keeps moderation working through the change.
 *
 * ## Two columns for the target, and they are not two representations of one fact
 *
 * `target_type` says WHICH COLUMN holds the thing being rated. `scope` says
 * WHAT QUESTION the rating answers. Those genuinely differ, and the difference
 * is the whole issue: `target_type = 'listing'` cannot say whether a review is
 * about the product or about the condition of one used copy. So the pair is
 * tied by `reviews_scope_target_type_check`, rendered from the SAME
 * `REVIEW_SCOPE_TARGET_TYPE` map every consumer reads — the two cannot disagree
 * about what a row is, and a `scope` of NULL means exactly one thing: the
 * classification job has not yet decided (or has decided it cannot).
 *
 * ## What is unrepresentable here, and why that is the point
 *
 *  - **A brand rating.** No `brand_id`, no `organization_id`, no
 *    `product_family_id`, in this table or in `review_aggregates`, and
 *    `REVIEW_FORBIDDEN_SCOPES` names the prohibition as a value. Averaging
 *    product reviews into a brand score has no column to be stored in.
 *  - **Buyer contact data.** No email, phone, checkout token, portal token or
 *    guest-session column exists on a review or on an eligibility. The evidence
 *    a review carries is an eligibility id; the evidence an eligibility carries
 *    is an order LINE. `review-scope-isolation.test.ts` scans every column of
 *    all five tables against a forbidden-name shape, with a vacuity floor and a
 *    mutation self-test — the `retail_pricing_policies` markup gate, reused.
 *  - **A cheaper guest review.** There is no `origin` column and no weight
 *    column anywhere in the domain. A claimed guest purchase produces an
 *    ordinary verified review.
 */

import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  LEGACY_REVIEW_TARGET_TYPES,
  REVIEW_AMBIGUITY_REASONS,
  REVIEW_CLASSIFICATION_STATES,
  REVIEW_DIMENSION_KEYS,
  REVIEW_ELIGIBILITY_STATES,
  REVIEW_EVIDENCE_TYPES,
  REVIEW_INCENTIVE_DISCLOSURES,
  REVIEW_SCOPE_TARGET_TYPE,
  REVIEW_SCOPES,
  REVIEW_TARGET_MIGRATION_ACTIONS,
  REVIEW_TARGET_TYPES,
  REVIEW_VERIFICATION_STATES,
  type ReviewScope,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { canonicalProducts } from './canonicalCatalog';
import { listings } from './catalog';
import { merchants } from './merchants';
import { orderItems, orders } from './orders';
import { stores } from './stores';

/** `Review.status`. Read by `moderation.ts` for the enforcement previous-state column. */
export const REVIEW_STATUSES = ['published', 'hidden'] as const;

/** Lowest and highest allowed star rating, on the review and on every dimension. */
const MIN_REVIEW_RATING = 1;
const MAX_REVIEW_RATING = 5;

/**
 * The six target columns collapsed into ONE text value, IMMUTABLE and therefore
 * storable as a generated column — the `commerce_relationships.endpoint_key`
 * device, for the same reason.
 *
 * A plain multi-column unique over six NULLABLE columns would NOT work:
 * Postgres treats NULLs as distinct, so it admits exactly the duplicate pairs
 * it exists to refuse. `coalesce` and `||` are both IMMUTABLE. The separator is
 * `|`, a character no uuid v7 and no ObjectId hex contains, so two different
 * target sets cannot render to one key.
 *
 * `reviews` and `review_aggregates` share this expression verbatim because they
 * hold their targets under the same six names; `review_eligibilities` needs its
 * own, because its transaction target is `target_order_item_id` (the column
 * `order_item_id` there is the EVIDENCE line, a different role).
 */
function targetKeyExpression(): SQL {
  return sql`coalesce("listing_id", '') || '|' ||
             coalesce("store_id", '') || '|' ||
             coalesce("seller_oxy_user_id", '') || '|' ||
             coalesce("canonical_product_id", '') || '|' ||
             coalesce("merchant_id", '') || '|' ||
             coalesce("order_item_id", '')`;
}

/**
 * "Exactly the column this scope names is set, and the other five are not",
 * rendered from `REVIEW_SCOPE_TARGET_TYPE` so the SQL and the TypeScript map
 * cannot drift apart.
 *
 * The `else false` branch is load-bearing, the `commerce_relationships` device:
 * a scope value the CHECK does not recognise is unrepresentable even if the
 * scope CHECK itself were dropped, so widening `REVIEW_SCOPES` without widening
 * this fails the first write instead of admitting a targetless row.
 */
const TARGET_COLUMNS: Readonly<Record<ReviewScope, string>> = Object.freeze({
  product: 'canonical_product_id',
  merchant: 'merchant_id',
  native_transaction: 'order_item_id',
  p2p_listing: 'listing_id',
  p2p_seller: 'seller_oxy_user_id',
});

/** Every target column, in one place, so a branch cannot forget to NULL one. */
const ALL_TARGET_COLUMNS: readonly string[] = [
  'listing_id',
  'store_id',
  'seller_oxy_user_id',
  'canonical_product_id',
  'merchant_id',
  'order_item_id',
];

/** `case "scope" when … then '<target type>' … end`, rendered from the ONE map. */
function scopeToTargetTypeCase(): string {
  const branches = REVIEW_SCOPES.map(
    (scope) => `when '${scope}' then '${REVIEW_SCOPE_TARGET_TYPE[scope]}'`,
  ).join('\n            ');
  return `case "scope"\n            ${branches}\n          end`;
}

/**
 * The scoped half of an exclusivity CHECK: one `WHEN` per scope naming its own
 * column as NOT NULL and every other target column as NULL.
 *
 * `transactionColumn` is the parameter because `review_eligibilities` holds a
 * `native_transaction` target under `target_order_item_id` while the other two
 * tables use `order_item_id` — the branch shape is otherwise identical, and one
 * generator is what keeps three CHECKs from drifting apart.
 */
function legacyTargetBranches(): string {
  return LEGACY_REVIEW_TARGET_TYPES.map((targetType) => {
    // The legacy target types are exactly the three whose column names differ
    // from the type name only by the `_id`/`_oxy_user_id` suffix, which is why
    // this map is written out rather than derived: `seller` → the Oxy id column
    // breaks any suffix rule somebody would be tempted to write.
    const own =
      targetType === 'listing'
        ? 'listing_id'
        : targetType === 'store'
          ? 'store_id'
          : 'seller_oxy_user_id';
    const others = ALL_TARGET_COLUMNS.filter((column) => column !== own)
      .map((column) => `"${column}" is null`)
      .join(' and ');
    return `when "target_type" = '${targetType}' then "${own}" is not null and ${others}`;
  }).join('\n        ');
}

function scopedTargetBranches(transactionColumn = 'order_item_id'): string {
  const columns = ALL_TARGET_COLUMNS.map((column) =>
    column === 'order_item_id' ? transactionColumn : column,
  );
  return REVIEW_SCOPES.map((scope) => {
    const own =
      TARGET_COLUMNS[scope] === 'order_item_id' ? transactionColumn : TARGET_COLUMNS[scope];
    const others = columns
      .filter((column) => column !== own)
      .map((column) => `"${column}" is null`)
      .join(' and ');
    return `when '${scope}' then "${own}" is not null and ${others}`;
  }).join('\n        ');
}

/**
 * `reviews` — one buyer's answer to ONE question about ONE target.
 *
 * `order_id` is `restrict`: it is part of what makes a review VERIFIED, and
 * erasing the order would leave a review claiming a purchase with nothing
 * behind it. `order_item_id` is `restrict` for the same reason one step finer —
 * a transaction review IS about that line. `eligibility_id` is `restrict`
 * because the eligibility is the immutable evidence reference the review exists
 * to point at (#76 model rule 11); deleting it would turn a verified review
 * into an unattributable one.
 *
 * `listing_id` and `store_id` keep the CASCADE they were born with. That is a
 * deliberate asymmetry: those are the LEGACY targets, a delisted P2P listing's
 * condition feedback has nothing left to describe, and narrowing them to
 * RESTRICT would start blocking `catalog-write` deletions that succeed today.
 */
export const reviews = pgTable(
  'reviews',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. A public review always has an Oxy author. */
    authorOxyUserId: text().notNull(),
    /** Which COLUMN holds the target. */
    targetType: text({ enum: asEnumValues(REVIEW_TARGET_TYPES) }).notNull(),
    /**
     * WHAT QUESTION this rating answers. NULL only while the classification job
     * has not decided — every review written after #76 is born with one.
     */
    scope: text({ enum: asEnumValues(REVIEW_SCOPES) }),
    listingId: text().references(() => listings.id, { onDelete: 'cascade' }),
    storeId: text().references(() => stores.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key. Set iff the target is a P2P seller. */
    sellerOxyUserId: text(),
    /** The canonical product a `product` review is about. */
    canonicalProductId: text().references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    /** The canonical merchant a `merchant` review is about. */
    merchantId: text().references(() => merchants.id, { onDelete: 'restrict' }),
    /** The exact order LINE a `native_transaction` review is about. */
    orderItemId: text().references(() => orderItems.id, { onDelete: 'restrict' }),
    orderId: text().references(() => orders.id, { onDelete: 'restrict' }),
    /**
     * The purchase eligibility this review spent — the immutable evidence
     * reference, standing where a buyer's contact details would otherwise be
     * tempting to keep. NULL on an unverified review and on every pre-#76 row.
     */
    eligibilityId: text().references(() => reviewEligibilities.id, { onDelete: 'restrict' }),
    /** Whether a consumed eligibility backs this review. */
    verification: text({ enum: asEnumValues(REVIEW_VERIFICATION_STATES) })
      .notNull()
      .default('unverified'),
    rating: integer().notNull(),
    title: text(),
    body: text(),
    /** BCP-47 tag, shape-CHECKed. NULL when the writer did not declare one. */
    locale: text(),
    /**
     * Whether the reviewer received an incentive. `none` is stored explicitly
     * rather than left NULL so "nobody asked" and "the reviewer said no" are
     * different facts — the distinction a disclosure exists to make.
     */
    incentiveDisclosure: text({ enum: asEnumValues(REVIEW_INCENTIVE_DISCLOSURES) })
      .notNull()
      .default('none'),
    status: text({ enum: asEnumValues(REVIEW_STATUSES) }).notNull().default('published'),
    /**
     * When the author last edited the TEXT.
     *
     * Distinct from `updated_at`, which a moderation status change also moves —
     * an edited review and a hidden one are not the same event and a reader has
     * to be able to tell them apart. NULL until an edit path exists to write it;
     * the column is the seam, and it is a real fact no other column carries.
     *
     * There is deliberately NO `published_at` beside it. #76's model asks for a
     * publication timestamp, and in Mercaria that is `created_at`: a review has
     * no draft state, so it becomes visible the moment it is written, and a
     * second column holding the same instant is the two-representations problem
     * `CONVENTIONS.md` refuses everywhere else. The DTO still carries
     * `publishedAt`, derived. A real draft-then-publish flow is what would earn
     * the column, and that is when to add it.
     */
    editedAt: timestamptz(),
    /** Where this row stands in the #76 scope migration. */
    classificationState: text({ enum: asEnumValues(REVIEW_CLASSIFICATION_STATES) })
      .notNull()
      .default('unclassified'),
    /** Which FACT was missing, when classification refused. Never a style verdict. */
    ambiguityReason: text({ enum: asEnumValues(REVIEW_AMBIGUITY_REASONS) }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** See {@link targetKeyExpression}. */
    targetKey: text().notNull().generatedAlwaysAs(targetKeyExpression()),
  },
  (t) => [
    checkOneOf('reviews_target_type_check', t.targetType, REVIEW_TARGET_TYPES),
    checkOneOf('reviews_scope_check', t.scope, REVIEW_SCOPES),
    checkOneOf('reviews_verification_check', t.verification, REVIEW_VERIFICATION_STATES),
    checkOneOf(
      'reviews_incentive_disclosure_check',
      t.incentiveDisclosure,
      REVIEW_INCENTIVE_DISCLOSURES,
    ),
    // `hidden` is written by moderation enforcement, which runs no application
    // validator — so a CHECK missing it would disarm review takedowns exactly as
    // one missing `restricted` would disarm listing takedowns.
    checkOneOf('reviews_status_check', t.status, REVIEW_STATUSES),
    checkOneOf(
      'reviews_classification_state_check',
      t.classificationState,
      REVIEW_CLASSIFICATION_STATES,
    ),
    checkOneOf('reviews_ambiguity_reason_check', t.ambiguityReason, REVIEW_AMBIGUITY_REASONS),
    check(
      'reviews_rating_check',
      sql`${t.rating} between ${sql.raw(String(MIN_REVIEW_RATING))} and ${sql.raw(String(MAX_REVIEW_RATING))}`,
    ),
    // BCP-47 shape, not a registry: a language tag Mercaria has not heard of is
    // still a language tag, and rejecting it would drop a genuine review.
    check(
      'reviews_locale_shape_check',
      sql`${t.locale} is null or ${t.locale} ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'`,
    ),
    /**
     * The scope ⇄ target-type tie. A scoped row must name the target type its
     * scope maps to; an unscoped row must be one of the three LEGACY types,
     * because a `canonical_product` target with no scope would be a review
     * nobody can read the question of.
     */
    check(
      'reviews_scope_target_type_check',
      sql.raw(
        `case when "scope" is null
          then "target_type" in (${LEGACY_REVIEW_TARGET_TYPES.map((value) => `'${value}'`).join(', ')})
          else "target_type" = ${scopeToTargetTypeCase()}
        end`,
      ),
    ),
    /**
     * Exactly one target column is set, and which one is decided by the scope
     * when there is one and by the legacy target type when there is not.
     */
    check(
      'reviews_target_exclusivity_check',
      sql.raw(
        `case
        when "scope" is not null then case "scope"
        ${scopedTargetBranches()}
          else false
        end
        ${legacyTargetBranches()}
        else false
      end`,
      ),
    ),
    /**
     * A scope and a classification state are the same decision seen twice, so
     * they are tied both ways: a scoped row has been classified (natively or by
     * the job), an unscoped row has not. And an ambiguity reason exists exactly
     * when classification refused — a reason on a classified row would be a
     * refusal nobody acted on.
     */
    check(
      'reviews_classification_consistency_check',
      sql`(${t.scope} is not null) = (${t.classificationState} in ('native', 'classified'))
          and (${t.ambiguityReason} is not null) = (${t.classificationState} = 'ambiguous')`,
    ),
    /**
     * A verified review names the eligibility it spent, and an unverified one
     * has none. Both directions: an eligibility id on an `unverified` row would
     * be a spent grant nobody counted, and a `verified_purchase` row without one
     * is a claim with no evidence — which is the whole failure mode #76 exists
     * to close.
     */
    check(
      'reviews_verification_evidence_check',
      sql`(${t.verification} = 'verified_purchase') = (${t.eligibilityId} is not null)`,
    ),
    /**
     * ONE review per author per SCOPED target. The pre-#76 index covered only
     * (author, listing) and store/seller uniqueness was service-enforced; on the
     * generated key it now holds for every scope, in the database, which is what
     * "one order line cannot generate unlimited verified reviews for the same
     * scope" means once the eligibility is spent.
     *
     * On `target_key` and not the raw columns, for the reason the generated
     * column exists: Postgres treats NULLs as distinct.
     */
    uniqueIndex('reviews_author_scope_target_key')
      .on(t.authorOxyUserId, t.scope, t.targetKey)
      .where(sql`${t.scope} is not null`),
    /**
     * The pre-#76 index, kept verbatim. It still holds for LEGACY listing rows
     * during the compatibility window, and `review.service` still maps its
     * violation to the same CONFLICT. Classifying a listing review to
     * `p2p_listing` does not move `listing_id`, so both indexes cover the row
     * and agree.
     */
    uniqueIndex('reviews_author_oxy_user_id_listing_id_key')
      .on(t.authorOxyUserId, t.listingId)
      .where(sql`${t.listingId} is not null`),
    /**
     * An eligibility is spent at most ONCE. This is the whole of "claim retries
     * and migration replays create at most one eligibility per order line,
     * author and review scope" on the consuming side — and it is why there is
     * deliberately NO `consumed_by_review_id` on `review_eligibilities`: this
     * column already names the pair, the index already makes it at most one, and
     * a second pointer is a second representation of one fact (the
     * `provider_accounts` no-`ready`-boolean rule).
     */
    uniqueIndex('reviews_eligibility_id_key')
      .on(t.eligibilityId)
      .where(sql`${t.eligibilityId} is not null`),
    index('reviews_listing_id_status_created_at_idx').on(
      t.listingId,
      t.status,
      t.createdAt.desc(),
    ),
    index('reviews_store_id_status_created_at_idx').on(t.storeId, t.status, t.createdAt.desc()),
    index('reviews_seller_oxy_user_id_status_created_at_idx').on(
      t.sellerOxyUserId,
      t.status,
      t.createdAt.desc(),
    ),
    // The three scoped feeds, each keyset-ordered exactly as it is read.
    index('reviews_canonical_product_id_status_created_at_idx').on(
      t.canonicalProductId,
      t.status,
      t.createdAt.desc(),
    ),
    index('reviews_merchant_id_status_created_at_idx').on(
      t.merchantId,
      t.status,
      t.createdAt.desc(),
    ),
    index('reviews_order_item_id_idx').on(t.orderItemId),
    // The aggregate rebuild's work list and the classification job's cursor.
    index('reviews_scope_target_key_status_idx').on(t.scope, t.targetKey, t.status),
    index('reviews_classification_state_created_at_idx').on(t.classificationState, t.createdAt),
  ],
);

/**
 * `review_dimensions` — the structured sub-ratings on one review.
 *
 * A child table rather than columns, because the vocabulary is per SCOPE: a
 * `condition_accuracy` column on every review would be NULL on four scopes out
 * of five and would invite somebody to average it across them.
 *
 * The KEY is CHECKed against the global tuple here; that it belongs to the
 * PARENT's scope is enforced by `insertScopedReview`, the single writer, before
 * any SQL is issued — a CHECK admits no subquery and cannot read the parent, and
 * copying the scope onto every dimension row to make one possible would be the
 * second representation this schema keeps refusing.
 *
 * CASCADE: a dimension exists only to qualify its review and is meaningless
 * without it.
 */
export const reviewDimensions = pgTable(
  'review_dimensions',
  {
    id: generatedId(),
    reviewId: text()
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    key: text({ enum: asEnumValues(REVIEW_DIMENSION_KEYS) }).notNull(),
    rating: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('review_dimensions_key_check', t.key, REVIEW_DIMENSION_KEYS),
    check(
      'review_dimensions_rating_check',
      sql`${t.rating} between ${sql.raw(String(MIN_REVIEW_RATING))} and ${sql.raw(String(MAX_REVIEW_RATING))}`,
    ),
    uniqueIndex('review_dimensions_review_id_key_key').on(t.reviewId, t.key),
  ],
);

/**
 * `review_eligibilities` — a durable grant: this Oxy account may write ONE
 * review of this scope and target, because this order line says they bought it.
 *
 * Separate from the review (issue requirement) so an order correction, a
 * moderation action and a claim audit stay explainable independently of
 * whatever text was written.
 *
 * ## What CANNOT create a row here
 *
 * The evidence is an ORDER LINE and nothing else. There is no email column, no
 * phone column, no payment-method column, no card-fingerprint column, no
 * session column and no affiliate/referral column — so a matching email, a
 * Stripe Customer, a wallet, a saved card, an affiliate click, a conversion
 * report, a portal token or possession of a guest session has nowhere to be
 * recorded as the reason a row exists. `REVIEW_FORBIDDEN_EVIDENCE_SOURCES`
 * names all fourteen so a refusal can say which one it refused, and the
 * eligibility service refuses each by name.
 *
 * `evidence_type = 'claimed_guest_purchase'` requires a `claim_id`, and #109
 * owns the only thing that can produce one. Until it lands, the guest path
 * fails CLOSED: there is no code that can synthesise a claim id, and the CHECK
 * refuses a claimed-guest row without one.
 */
export const reviewEligibilities = pgTable(
  'review_eligibilities',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. The account that may spend this. */
    oxyUserId: text().notNull(),
    orderId: text()
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    /** The exact line. RESTRICT: the evidence must outlive any catalogue change. */
    orderItemId: text()
      .notNull()
      .references(() => orderItems.id, { onDelete: 'restrict' }),
    scope: text({ enum: asEnumValues(REVIEW_SCOPES) }).notNull(),
    targetType: text({ enum: asEnumValues(REVIEW_TARGET_TYPES) }).notNull(),
    listingId: text().references(() => listings.id, { onDelete: 'cascade' }),
    storeId: text().references(() => stores.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key. */
    sellerOxyUserId: text(),
    canonicalProductId: text().references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    merchantId: text().references(() => merchants.id, { onDelete: 'restrict' }),
    /**
     * The target of a `native_transaction` eligibility. Deliberately a SECOND
     * reference to the same line `order_item_id` names: the evidence and the
     * target are different roles that happen to coincide for one scope, and
     * collapsing them would make a product eligibility look like a transaction
     * one.
     */
    targetOrderItemId: text().references(() => orderItems.id, { onDelete: 'restrict' }),
    evidenceType: text({ enum: asEnumValues(REVIEW_EVIDENCE_TYPES) }).notNull(),
    /**
     * The #109 claim that moved a guest order into this Oxy account. No foreign
     * key: `guest_order_claims` does not exist yet, and this column is what
     * makes the seam explicit rather than implicit.
     */
    claimId: text(),
    state: text({ enum: asEnumValues(REVIEW_ELIGIBILITY_STATES) }).notNull().default('open'),
    consumedAt: timestamptz(),
    revokedAt: timestamptz(),
    revokedReason: text(),
    disputedAt: timestamptz(),
    /** The eligibility policy in force when this grant was made. */
    policyVersion: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** See {@link targetKeyExpression}; the same six columns, the same reason. */
    targetKey: text()
      .notNull()
      .generatedAlwaysAs(
        sql`coalesce("listing_id", '') || '|' ||
            coalesce("store_id", '') || '|' ||
            coalesce("seller_oxy_user_id", '') || '|' ||
            coalesce("canonical_product_id", '') || '|' ||
            coalesce("merchant_id", '') || '|' ||
            coalesce("target_order_item_id", '')`,
      ),
  },
  (t) => [
    checkOneOf('review_eligibilities_scope_check', t.scope, REVIEW_SCOPES),
    checkOneOf('review_eligibilities_target_type_check', t.targetType, REVIEW_TARGET_TYPES),
    checkOneOf('review_eligibilities_evidence_type_check', t.evidenceType, REVIEW_EVIDENCE_TYPES),
    checkOneOf('review_eligibilities_state_check', t.state, REVIEW_ELIGIBILITY_STATES),
    // The same scope ⇄ target-type tie the review carries. An eligibility is
    // always scoped, so there is no legacy branch here.
    check(
      'review_eligibilities_scope_target_type_check',
      sql.raw(`"target_type" = ${scopeToTargetTypeCase()}`),
    ),
    check(
      'review_eligibilities_target_exclusivity_check',
      sql.raw(
        `case "scope"
        ${scopedTargetBranches('target_order_item_id')}
          else false
      end`,
      ),
    ),
    /**
     * A guest-origin eligibility names its claim and an authenticated one does
     * not. Both directions, so neither "a claimed purchase with no claim" nor
     * "an ordinary purchase carrying a claim id" is storable.
     */
    check(
      'review_eligibilities_claim_check',
      sql`(${t.evidenceType} = 'claimed_guest_purchase') = (${t.claimId} is not null)`,
    ),
    /** The state and its timestamp are one fact; neither may travel alone. */
    check(
      'review_eligibilities_state_timestamps_check',
      sql`(${t.state} = 'consumed') = (${t.consumedAt} is not null)
          and (${t.state} = 'revoked') = (${t.revokedAt} is not null)
          and (${t.state} = 'disputed') = (${t.disputedAt} is not null)`,
    ),
    /** A revocation nobody can explain is not an auditable reversal. */
    check(
      'review_eligibilities_revoked_reason_check',
      sql`${t.revokedAt} is null or ${t.revokedReason} is not null`,
    ),
    check('review_eligibilities_policy_version_check', sql`btrim(${t.policyVersion}) <> ''`),
    /**
     * #76 verification rule 11, stated as a constraint: at most ONE eligibility
     * per (order line, author, scope), whatever replays a claim or a migration
     * performs. Not partial — all three columns are NOT NULL, so a plain unique
     * is exact here.
     */
    uniqueIndex('review_eligibilities_line_author_scope_key').on(
      t.orderItemId,
      t.oxyUserId,
      t.scope,
    ),
    // "What may this buyer still review?" — the order-history surface's read.
    index('review_eligibilities_oxy_user_id_state_created_at_idx').on(
      t.oxyUserId,
      t.state,
      t.createdAt.desc(),
    ),
    index('review_eligibilities_scope_target_key_idx').on(t.scope, t.targetKey),
    index('review_eligibilities_order_id_idx').on(t.orderId),
  ],
);

/**
 * `review_aggregates` — the ONE authority for a scoped rating.
 *
 * ## Why a table and not just the columns that already exist
 *
 * `canonical_products.rating`, `merchants.rating`, `listings.rating`,
 * `stores.rating` and `seller_profiles.rating` are PROJECTIONS of the rows here:
 * written by the same function, in the same call, derived from the same query,
 * never independently. A projection with one writer is not a second
 * representation of a fact; a second WRITER would be. What they cannot hold is
 * what forced a table: the verified/unverified split, the per-dimension
 * averages, the target TYPE stated explicitly (#76 requires every aggregate to
 * record it), and the rebuild bookkeeping drift detection needs. An order line
 * has no rating column at all, so `native_transaction` has nowhere else to go.
 *
 * ## No brand row can exist here
 *
 * The target columns are the same six the review carries. There is no
 * `brand_id`, no `organization_id` and no `product_family_id`, so the aggregate
 * the issue forbids has no row shape — not a rule, an absence.
 *
 * `rating`/`review_count` cover VERIFIED published reviews only.
 * `unverified_rating`/`unverified_count` sit beside them and are never summed
 * in; there is deliberately no `total_count` column, because a combined total is
 * exactly what "labelled and weighted separately" forbids and a serializer that
 * cannot find one cannot ship one.
 */
export const reviewAggregates = pgTable(
  'review_aggregates',
  {
    id: generatedId(),
    scope: text({ enum: asEnumValues(REVIEW_SCOPES) }).notNull(),
    targetType: text({ enum: asEnumValues(REVIEW_TARGET_TYPES) }).notNull(),
    listingId: text().references(() => listings.id, { onDelete: 'cascade' }),
    storeId: text().references(() => stores.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key. */
    sellerOxyUserId: text(),
    canonicalProductId: text().references(() => canonicalProducts.id, { onDelete: 'restrict' }),
    merchantId: text().references(() => merchants.id, { onDelete: 'restrict' }),
    orderItemId: text().references(() => orderItems.id, { onDelete: 'restrict' }),
    /** Mean over VERIFIED published reviews; 0 when there are none. */
    rating: doublePrecision().notNull().default(0),
    reviewCount: integer().notNull().default(0),
    /** Mean over UNVERIFIED published reviews. Never blended into `rating`. */
    unverifiedRating: doublePrecision().notNull().default(0),
    unverifiedCount: integer().notNull().default(0),
    /** When these figures were last derived from review rows. */
    lastRebuiltAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** See {@link targetKeyExpression}. */
    targetKey: text().notNull().generatedAlwaysAs(targetKeyExpression()),
  },
  (t) => [
    checkOneOf('review_aggregates_scope_check', t.scope, REVIEW_SCOPES),
    checkOneOf('review_aggregates_target_type_check', t.targetType, REVIEW_TARGET_TYPES),
    check(
      'review_aggregates_scope_target_type_check',
      sql.raw(`"target_type" = ${scopeToTargetTypeCase()}`),
    ),
    check(
      'review_aggregates_target_exclusivity_check',
      sql.raw(
        `case "scope"
        ${scopedTargetBranches()}
          else false
      end`,
      ),
    ),
    check(
      'review_aggregates_rating_check',
      sql`${t.rating} >= 0 and ${t.rating} <= 5 and ${t.reviewCount} >= 0
          and ${t.unverifiedRating} >= 0 and ${t.unverifiedRating} <= 5 and ${t.unverifiedCount} >= 0`,
    ),
    /** ONE aggregate per (scope, target). The upsert's conflict target. */
    uniqueIndex('review_aggregates_scope_target_key').on(t.scope, t.targetKey),
    // The rebuild sweep's resumable cursor: oldest-rebuilt first.
    index('review_aggregates_last_rebuilt_at_idx').on(t.lastRebuiltAt),
  ],
);

/**
 * `review_dimension_aggregates` — one row per (aggregate, dimension).
 *
 * Kept out of `review_aggregates` for the reason `review_dimensions` is kept
 * out of `reviews`: twelve nullable pairs on one row, most of them meaningless
 * for any given scope, is the shape that invites averaging across scopes.
 *
 * CASCADE: it qualifies its aggregate and is meaningless apart from it.
 */
export const reviewDimensionAggregates = pgTable(
  'review_dimension_aggregates',
  {
    id: generatedId(),
    aggregateId: text()
      .notNull()
      .references(() => reviewAggregates.id, { onDelete: 'cascade' }),
    key: text({ enum: asEnumValues(REVIEW_DIMENSION_KEYS) }).notNull(),
    rating: doublePrecision().notNull(),
    count: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('review_dimension_aggregates_key_check', t.key, REVIEW_DIMENSION_KEYS),
    check(
      'review_dimension_aggregates_rating_check',
      sql`${t.rating} >= 0 and ${t.rating} <= 5 and ${t.count} >= 0`,
    ),
    uniqueIndex('review_dimension_aggregates_aggregate_id_key_key').on(t.aggregateId, t.key),
  ],
);

/**
 * `review_target_migrations` — every scope decision ever made about a review.
 *
 * APPEND-ONLY by trigger (`mercaria_review_target_migration_append_only`, the
 * `order_fee_snapshots` posture). This is the "merge and migration metadata"
 * the review model asks for, held as HISTORY rather than as two columns on the
 * review: `reviews.scope` answers where a review points NOW and cannot answer
 * where it pointed before, exactly as `merged_into_id` cannot — the
 * `canonical_product_redirects` reasoning, one domain over.
 *
 * It is also what makes a product SPLIT answerable. A split cannot be inferred
 * (that is the whole reason #76 requires explicit assignment), so an operator's
 * `assign_split` decision is recorded here as the thing that moved the review.
 *
 * `UNIQUE(review_id, action, to_target_ref)` converges a replay: re-running the
 * classification job over a review it already classified writes nothing new.
 */
export const reviewTargetMigrations = pgTable(
  'review_target_migrations',
  {
    id: generatedId(),
    reviewId: text()
      .notNull()
      .references(() => reviews.id, { onDelete: 'restrict' }),
    action: text({ enum: asEnumValues(REVIEW_TARGET_MIGRATION_ACTIONS) }).notNull(),
    /** The scope the review carried before, NULL when it carried none. */
    fromScope: text({ enum: asEnumValues(REVIEW_SCOPES) }),
    fromTargetType: text({ enum: asEnumValues(REVIEW_TARGET_TYPES) }).notNull(),
    /** The target id before. No foreign key — it spans six target key spaces and
     * must survive a tombstone, the `catalog_revisions.entity_id` reasoning. */
    fromTargetRef: text().notNull(),
    /** NULL exactly when the action REFUSED to assign one. */
    toScope: text({ enum: asEnumValues(REVIEW_SCOPES) }),
    toTargetType: text({ enum: asEnumValues(REVIEW_TARGET_TYPES) }),
    toTargetRef: text(),
    /** Why. For a refusal this is the ambiguity reason; otherwise a short code. */
    reason: text().notNull(),
    /** `migration` for the job, `operator` for a person's explicit assignment. */
    actorKind: text({ enum: ['migration', 'operator'] as const }).notNull(),
    /** An Oxy account id — no foreign key. Required exactly for `operator`. */
    actorOxyUserId: text(),
    at: timestamptz().notNull(),
  },
  (t) => [
    checkOneOf('review_target_migrations_action_check', t.action, REVIEW_TARGET_MIGRATION_ACTIONS),
    checkOneOf('review_target_migrations_from_scope_check', t.fromScope, REVIEW_SCOPES),
    checkOneOf(
      'review_target_migrations_from_target_type_check',
      t.fromTargetType,
      REVIEW_TARGET_TYPES,
    ),
    checkOneOf('review_target_migrations_to_scope_check', t.toScope, REVIEW_SCOPES),
    checkOneOf('review_target_migrations_to_target_type_check', t.toTargetType, REVIEW_TARGET_TYPES),
    checkOneOf(
      'review_target_migrations_actor_kind_check',
      t.actorKind,
      ['migration', 'operator'] as const,
    ),
    /** A refusal names no destination; every other action names all three. */
    check(
      'review_target_migrations_destination_check',
      sql`case when ${t.action} = 'refuse_ambiguous'
            then num_nonnulls(${t.toScope}, ${t.toTargetType}, ${t.toTargetRef}) = 0
            else num_nonnulls(${t.toScope}, ${t.toTargetType}, ${t.toTargetRef}) = 3
          end`,
    ),
    /** An operator decision names the operator; the job names nobody. */
    check(
      'review_target_migrations_actor_check',
      sql`(${t.actorKind} = 'operator') = (${t.actorOxyUserId} is not null)`,
    ),
    check('review_target_migrations_reason_check', sql`btrim(${t.reason}) <> ''`),
    /**
     * A replayed decision converges instead of growing the log. `coalesce` on
     * the destination because a refusal has none and Postgres would treat two
     * refusals of the same review as distinct rows forever.
     */
    uniqueIndex('review_target_migrations_review_action_target_key').on(
      t.reviewId,
      t.action,
      sql`coalesce(${t.toTargetRef}, '')`,
    ),
    index('review_target_migrations_review_id_at_idx').on(t.reviewId, t.at.desc()),
    index('review_target_migrations_action_at_idx').on(t.action, t.at.desc()),
  ],
);

