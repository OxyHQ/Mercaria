/**
 * Merchant → native `Store` linkage — issue #84, bound by ADR 0002 D4/D9.
 *
 * Four tables: `store_linkage_requests`, `store_linkage_candidates`,
 * `store_linkage_profile_adoptions`, `store_linkage_offer_overlaps`.
 *
 * ## There is no second mapping table here, deliberately
 *
 * The merchant ↔ store mapping is `native_store_links` (#54, ADR 0002 D4) and
 * stays there. These four tables are the WORKFLOW that produces one of those
 * rows, reverses one, or corrects one: what was asked for, what evidence
 * proposed it, what a person decided, which profile fields an owner adopted,
 * and which offers turned out to represent the same sale twice. A second
 * mapping would be a second answer to "which merchant is this store", and two
 * answers can disagree — the failure ADR 0002 exists to make unrepresentable.
 *
 * ## Idempotency is a DATABASE property, not a service check
 *
 * Issue acceptance 4: replaying store creation or linkage creates no duplicate
 * store, merchant mapping or follow target. Each of the three is held by an
 * index rather than by a read-then-write two racers walk straight past:
 *
 *  - **no duplicate STORE** — `store_linkage_requests_open_key`, a partial
 *    unique on the GENERATED `request_key` over the live states. A replayed
 *    `create_store` converges on the row that already exists (and therefore on
 *    the store it already made) instead of minting a second one.
 *  - **no duplicate MERCHANT MAPPING** — #54's paired partial uniques
 *    (`native_store_links_{store,merchant}_id_active_key`), already in place.
 *    This domain never writes that table except through #54's own repository,
 *    so it inherits the constraint rather than restating it.
 *  - **no duplicate FOLLOW TARGET** — structurally, and this is worth stating
 *    because there is no index to point at. A `mercaria.store` follow target's
 *    identity is `https://mercaria.co/stores/<storeId>` (frontend
 *    `lib/follow-graph.ts`), keyed on the store's IMMUTABLE id, and
 *    `ensureFollowTarget` is idempotent on that URI. So "exactly one follow
 *    target" is the same fact as "exactly one store, whose id never moves" —
 *    which the first index above already guarantees. Nothing in this domain
 *    constructs a follow URI, creates a target, or changes a store id;
 *    `store-linkage-isolation.test.ts` fails the build if that changes.
 *
 * ## The generated `request_key` is the `commerce_relationships.endpoint_key`
 *
 * Postgres treats NULLs as DISTINCT, and `requested_store_id` is legitimately
 * NULL on every `create_store` request — so a plain multi-column unique over
 * `(claim_id, mode, requested_store_id)` admits exactly the duplicate it exists
 * to refuse: two `create_store` requests for one claim, each making its own
 * store. `coalesce(...) || '|' || …` collapses them into one text value (both
 * functions IMMUTABLE) and the partial unique is taken on that, which is #55's
 * device applied to #84's problem.
 *
 * The key is built from IMMUTABLE inputs only — `claim_id`, `mode`,
 * `requested_store_id` and `supersedes_link_id`. All four are what was ASKED and
 * none of them moves; `resolved_store_id` is what HAPPENED and moves NULL → a
 * value exactly once. Building the key from the resolved column instead would
 * change it at the moment a request applied — freeing the key and admitting the
 * second `create_store` the index exists to refuse. A trigger enforces both
 * halves (see `mercaria_store_linkage_request_guard` in the migration), because
 * a generated unique key whose inputs can be edited is not a unique key.
 */

import { sql, type SQL } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import {
  STORE_LINKAGE_BLOCK_REASONS,
  STORE_LINKAGE_CANDIDATE_DISPOSITIONS,
  STORE_LINKAGE_CANDIDATE_SOURCES,
  STORE_LINKAGE_MATCH_STATES,
  STORE_LINKAGE_MODES,
  STORE_LINKAGE_OVERLAP_RULES,
  STORE_LINKAGE_PROFILE_FIELDS,
  STORE_LINKAGE_PROFILE_SOURCES,
  STORE_LINKAGE_STATES,
  STORE_LINKAGE_STEPS,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { merchantClaims } from './merchantClaims';
import { merchants, nativeStoreLinks } from './merchants';
import { canonicalVariants } from './canonicalCatalog';
import { offers } from './offers';
import { stores } from './stores';

/** The states in which a request still holds its idempotency key. */
export const STORE_LINKAGE_LIVE_STATES = [
  'draft',
  'awaiting_review',
  'applying',
  'applied',
] as const;

/** Bound on a stored application error — `store_linkage_requests_last_error_length_check`. */
export const STORE_LINKAGE_MAX_LAST_ERROR_LENGTH = 2_000;

/**
 * `store_linkage_requests` — one attempt to join, correct or reverse the link
 * between a verified merchant and a native store. **The row IS the job.**
 *
 * The payment/moderation outbox contract, applied to a workflow rather than a
 * delivery: the lease columns and the `step` cursor are on the record itself,
 * so a task that dies half way through an application leaves the work claimable
 * by another instead of leaving a merchant half-linked with nothing to resume
 * from. That is issue revocation rule 2's "resumable job", and giving it to
 * EVERY mode rather than only to corrections means there is one mechanism to
 * reason about instead of two.
 *
 * `claim_id` is RESTRICT and NOT NULL: linkage exists because somebody proved
 * they operate this merchant, and the proof must not be able to vanish from
 * under the record of what it authorized. `merchant_id` is RESTRICT for the
 * same reason the rest of the canonical graph is (nothing hard-deletes a
 * canonical row; retirement is a status, D12/D20). Both store references are
 * RESTRICT: there is no code path that deletes a `stores` row today, and if one
 * ever appears an open linkage request is a fact it must confront rather than
 * silently orphan — the `native_store_links` reasoning exactly.
 *
 * The impact preview is SIX integer columns and not a jsonb summary. That is a
 * security property rather than tidiness, the `provider_accounts` requirements
 * decision: an integer column cannot hold a customer name, a listing title or
 * an order number, so an impact preview can never become a way to read a
 * store's book through the operator surface.
 */
export const storeLinkageRequests = pgTable(
  'store_linkage_requests',
  {
    id: generatedId(),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    /** The verified claim that authorizes this request. RESTRICT — it is the authority. */
    claimId: text()
      .notNull()
      .references(() => merchantClaims.id, { onDelete: 'restrict' }),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    claimantOxyUserId: text().notNull(),
    mode: text({ enum: asEnumValues(STORE_LINKAGE_MODES) }).notNull(),
    state: text({ enum: asEnumValues(STORE_LINKAGE_STATES) })
      .notNull()
      .default('draft'),
    step: text({ enum: asEnumValues(STORE_LINKAGE_STEPS) })
      .notNull()
      .default('opened'),
    /**
     * The store the claimant NAMED. IMMUTABLE (trigger) because the idempotency
     * key is generated from it; NULL exactly on `create_store`, where there is
     * no store to name yet.
     */
    requestedStoreId: text().references(() => stores.id, { onDelete: 'restrict' }),
    /**
     * The store this request ended up joining. Moves NULL → a value exactly
     * once, at `store_ready` — the `retail_cost_acceptances.order_id` contract,
     * and enforced by the same pair of mechanisms (a CAS in the repository and a
     * trigger behind it).
     */
    resolvedStoreId: text().references(() => stores.id, { onDelete: 'restrict' }),
    /** The `native_store_links` row this request produced. RESTRICT: it is the outcome. */
    nativeStoreLinkId: text().references(() => nativeStoreLinks.id, { onDelete: 'restrict' }),
    /**
     * The link this request ENDS — present exactly on `correct_link` and
     * `unlink`, absent on the two opening modes. Distinct from
     * `native_store_link_id`, which names what a correction PRODUCED: two
     * different links, and collapsing them would lose which one was wrong.
     *
     * It is IMMUTABLE and part of the idempotency key, which is what makes a
     * store correctable more than once. Keyed on `(claim, mode, store)` alone, a
     * second correction of the same store would converge on the first — a
     * request that already applied still holds its key — so correcting a
     * correction would be impossible. Keyed on the link it ends, each correction
     * is its own request and a REPLAY of one still converges, which is the
     * property that actually needed holding.
     */
    supersedesLinkId: text().references(() => nativeStoreLinks.id, { onDelete: 'restrict' }),
    blockReason: text({ enum: asEnumValues(STORE_LINKAGE_BLOCK_REASONS) }),
    /** Why this was asked for. Mandatory, non-empty by CHECK, part of the audit trail. */
    reason: text().notNull(),
    /** What #58's matcher seam reported on the last run. NULL before it ran. */
    matchState: text({ enum: asEnumValues(STORE_LINKAGE_MATCH_STATES) }),
    /** An Oxy account id — no foreign key. The operator who decided a reviewed request. */
    decidedByOxyUserId: text(),
    decidedAt: timestamptz(),
    decisionReason: text(),
    // ── The impact preview (issue revocation rule 5), as COUNTS ──────────────
    impactActiveListings: integer().notNull().default(0),
    impactNativeOffers: integer().notNull().default(0),
    impactExternalOffers: integer().notNull().default(0),
    impactStorefronts: integer().notNull().default(0),
    impactPlacedOrders: integer().notNull().default(0),
    impactStoreMembers: integer().notNull().default(0),
    // ── The resumable-job columns. The row IS the job. ──────────────────────
    attempts: integer().notNull().default(0),
    /** Which task holds the lease. An opaque worker identity — no foreign key. */
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    lastError: text(),
    appliedAt: timestamptz(),
    /**
     * The idempotency key, GENERATED from the request's IMMUTABLE identity.
     *
     * `|` is the separator for the `commerce_relationships.endpoint_key` reason:
     * no uuid v7, ObjectId hex or mode value contains it, so two different
     * tuples cannot render to one key.
     */
    requestKey: text()
      .notNull()
      .generatedAlwaysAs(
        (): SQL =>
          sql`coalesce("claim_id", '') || '|' || coalesce("mode", '') || '|' ||
              coalesce("requested_store_id", '') || '|' || coalesce("supersedes_link_id", '')`,
      ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('store_linkage_requests_mode_check', t.mode, STORE_LINKAGE_MODES),
    checkOneOf('store_linkage_requests_state_check', t.state, STORE_LINKAGE_STATES),
    checkOneOf('store_linkage_requests_step_check', t.step, STORE_LINKAGE_STEPS),
    checkOneOf(
      'store_linkage_requests_block_reason_check',
      t.blockReason,
      STORE_LINKAGE_BLOCK_REASONS,
    ),
    checkOneOf('store_linkage_requests_match_state_check', t.matchState, STORE_LINKAGE_MATCH_STATES),
    // An audit record whose reason is whitespace is not an audit record.
    check('store_linkage_requests_reason_check', sql`btrim(${t.reason}) <> ''`),
    /**
     * Exactly one mode names no store up front. Stating it as a CHECK rather
     * than trusting the service means a future mode that changes this needs a
     * migration — the visible decision, the
     * `merchant_claims_document_subject_check` shape.
     */
    check(
      'store_linkage_requests_requested_store_check',
      sql`(${t.mode} = 'create_store') = (${t.requestedStoreId} is null)`,
    ),
    // `blocked` and its reason are one fact in two columns, so their agreement
    // is a CHECK — the `merchants_merged_state_check` shape. A live request
    // carrying a block reason would read as blocked to anything that looked.
    check(
      'store_linkage_requests_blocked_state_check',
      sql`(${t.state} = 'blocked') = (${t.blockReason} is not null)`,
    ),
    // An APPLIED request resolved a store, produced a link and recorded when.
    // Without this, "applied" could mean nothing at all happened.
    check(
      'store_linkage_requests_applied_state_check',
      sql`${t.state} <> 'applied'
          or (${t.resolvedStoreId} is not null and ${t.appliedAt} is not null
              and ${t.step} = 'completed')`,
    ),
    // `unlink` is the one applied mode that produces no NEW link — it ends one.
    // Every other applied mode must name the link it wrote, or the row cannot
    // say what it did.
    check(
      'store_linkage_requests_applied_link_check',
      sql`${t.state} <> 'applied' or ${t.mode} = 'unlink' or ${t.nativeStoreLinkId} is not null`,
    ),
    // A request that ENDS a link names it, and one that opens a link cannot. A
    // biconditional rather than an implication, so a correction with nothing to
    // correct is as unrepresentable as a creation that claims to supersede
    // something.
    check(
      'store_linkage_requests_supersedes_check',
      sql`(${t.supersedesLinkId} is not null) = (${t.mode} in ('correct_link', 'unlink'))`,
    ),
    // Linking an EXISTING store can only ever resolve to the store it named.
    // Without this a `link_existing` request could apply against a different
    // store than the one whose permissions were checked.
    check(
      'store_linkage_requests_resolved_matches_requested_check',
      sql`${t.requestedStoreId} is null or ${t.resolvedStoreId} is null
          or ${t.resolvedStoreId} = ${t.requestedStoreId}`,
    ),
    // A decision names its decider and when — an anonymous operator verdict is
    // unrepresentable, the `merchant_claims_rejected_state_check` shape.
    check(
      'store_linkage_requests_decision_check',
      sql`num_nonnulls(${t.decidedByOxyUserId}, ${t.decidedAt}) in (0, 2)`,
    ),
    check('store_linkage_requests_attempts_check', sql`${t.attempts} >= 0`),
    check(
      'store_linkage_requests_impact_check',
      sql`${t.impactActiveListings} >= 0 and ${t.impactNativeOffers} >= 0
          and ${t.impactExternalOffers} >= 0 and ${t.impactStorefronts} >= 0
          and ${t.impactPlacedOrders} >= 0 and ${t.impactStoreMembers} >= 0`,
    ),
    check(
      'store_linkage_requests_last_error_length_check',
      sql`${t.lastError} is null or length(${t.lastError}) <= ${sql.raw(String(STORE_LINKAGE_MAX_LAST_ERROR_LENGTH))}`,
    ),
    /**
     * THE idempotency gate (issue acceptance 4).
     *
     * One LIVE request per (claim, mode, named store). A replay converges on
     * the row that already exists — and therefore on the store it already
     * created and the link it already wrote — rather than opening a second
     * one. Terminal states (`blocked`, `rejected`, `abandoned`) release the
     * key, which is what lets a claimant retry after a conflict is resolved
     * without the record of the refusal being edited into something else.
     *
     * The predicate is rendered from `STORE_LINKAGE_LIVE_STATES` so it cannot
     * drift from the tuple the service reads — the
     * `merchant_claims_merchant_claimant_active_key` device.
     */
    uniqueIndex('store_linkage_requests_open_key')
      .on(t.requestKey)
      .where(sql`${t.state} in (${sql.raw(inList(STORE_LINKAGE_LIVE_STATES))})`),
    index('store_linkage_requests_merchant_idx').on(t.merchantId, t.createdAt.desc()),
    index('store_linkage_requests_claimant_idx').on(t.claimantOxyUserId, t.createdAt.desc()),
    index('store_linkage_requests_claim_idx').on(t.claimId),
    // The operator review queue reads by state, oldest first — #83's queue shape.
    index('store_linkage_requests_state_idx').on(t.state, t.createdAt),
    // Resuming a stalled application: work left mid-flight, oldest lease first.
    // Partial, so it is the size of the stalled set rather than of every
    // request that ever ran — the `offer_outboxes_reclaim_idx` shape.
    index('store_linkage_requests_resume_idx')
      .on(t.leaseUntil, t.createdAt)
      .where(sql`${t.state} = 'applying'`),
    index('store_linkage_requests_resolved_store_idx')
      .on(t.resolvedStoreId)
      .where(sql`${t.resolvedStoreId} is not null`),
  ],
);

/**
 * `store_linkage_candidates` — the native stores that could be this merchant,
 * and the EVIDENCE that proposed each one.
 *
 * This table is where "no name-only automatic linkage is permitted" stops being
 * a rule and becomes a shape. `source` comes from a closed set with no
 * `name_match` member, and there is no `name`, `similarity`, `score` or
 * `confidence` column for one to be recorded in — so a matcher acting on a
 * resemblance has nowhere to put its answer, and a reviewer reading this table
 * can never be shown a similarity dressed as evidence.
 *
 * Case 3 (several candidates require review) is why the table exists at all
 * rather than the request carrying one store: the request must be able to hold
 * a SET of proposals with one selected by a person, and the `disposition`
 * column is the three states of that decision on one row — the
 * `merchant_claim_scopes` requested/verified/out-of-scope shape, which makes a
 * rejected candidate visible instead of silently absent.
 */
export const storeLinkageCandidates = pgTable(
  'store_linkage_candidates',
  {
    id: generatedId(),
    requestId: text()
      .notNull()
      .references(() => storeLinkageRequests.id, { onDelete: 'cascade' }),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    source: text({ enum: asEnumValues(STORE_LINKAGE_CANDIDATE_SOURCES) }).notNull(),
    /**
     * The proven fact behind the source — a verified hostname, a connection id,
     * a store role. Never a name and never a score: no `source` value admits
     * one, and this column is what a reviewer reads to check the claim.
     */
    evidenceRef: text(),
    disposition: text({ enum: asEnumValues(STORE_LINKAGE_CANDIDATE_DISPOSITIONS) })
      .notNull()
      .default('proposed'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'store_linkage_candidates_source_check',
      t.source,
      STORE_LINKAGE_CANDIDATE_SOURCES,
    ),
    checkOneOf(
      'store_linkage_candidates_disposition_check',
      t.disposition,
      STORE_LINKAGE_CANDIDATE_DISPOSITIONS,
    ),
    // One row per (request, store): re-running discovery converges rather than
    // stacking a fresh proposal every time somebody opens the review screen.
    // The strongest source wins the row, which the repository's upsert decides.
    uniqueIndex('store_linkage_candidates_request_store_key').on(t.requestId, t.storeId),
    // At most ONE selected candidate per request. A request that resolved to
    // two stores is the ambiguity case 3 exists to refuse, and refusing it here
    // means no code path can produce it.
    uniqueIndex('store_linkage_candidates_selected_key')
      .on(t.requestId)
      .where(sql`${t.disposition} = 'selected'`),
    index('store_linkage_candidates_store_idx').on(t.storeId),
  ],
);

/**
 * `store_linkage_profile_adoptions` — which safe public fields an owner chose
 * to take from the canonical merchant, and what was there before.
 *
 * APPEND-ONLY by trigger (`mercaria_store_linkage_adoption_append_only`, the
 * `order_fee_snapshots` / `relationship_reviews` precedent) and carrying its own
 * `at` with no `updated_at`. `previous_value` is the provenance half of issue
 * existing-store rule 3: an adoption that overwrote something must be able to
 * say what it overwrote, or "retaining provenance" is a word rather than a
 * property.
 *
 * `field` and `source` are both closed sets of two and one member respectively,
 * which together are the structural form of issue store-creation rule 4 — do
 * not copy UNVERIFIED external profile fields into merchant-managed fields
 * silently. There is no `source` value naming an unverified external profile,
 * and no `field` value naming the handle, the currency, a policy or a setting.
 */
export const storeLinkageProfileAdoptions = pgTable(
  'store_linkage_profile_adoptions',
  {
    id: generatedId(),
    requestId: text()
      .notNull()
      .references(() => storeLinkageRequests.id, { onDelete: 'restrict' }),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'restrict' }),
    field: text({ enum: asEnumValues(STORE_LINKAGE_PROFILE_FIELDS) }).notNull(),
    source: text({ enum: asEnumValues(STORE_LINKAGE_PROFILE_SOURCES) }).notNull(),
    /** What the store said before. NULL is a real answer: the field was unset. */
    previousValue: text(),
    adoptedValue: text().notNull(),
    /** An Oxy account id — no foreign key. The owner who chose this field. */
    actorOxyUserId: text().notNull(),
    at: timestamptz().notNull(),
  },
  (t) => [
    checkOneOf(
      'store_linkage_profile_adoptions_field_check',
      t.field,
      STORE_LINKAGE_PROFILE_FIELDS,
    ),
    checkOneOf(
      'store_linkage_profile_adoptions_source_check',
      t.source,
      STORE_LINKAGE_PROFILE_SOURCES,
    ),
    // Adopting an empty value is not adopting a fact — it is clearing a field
    // through a door built for something else.
    check(
      'store_linkage_profile_adoptions_value_check',
      sql`btrim(${t.adoptedValue}) <> ''`,
    ),
    // One adoption per (request, field): a replayed application re-applies
    // nothing and writes no second audit row for the same decision.
    uniqueIndex('store_linkage_profile_adoptions_request_field_key').on(t.requestId, t.field),
    index('store_linkage_profile_adoptions_store_idx').on(t.storeId, t.at.desc()),
  ],
);

/**
 * `store_linkage_offer_overlaps` — the same sale, represented twice, and the
 * DETERMINISTIC rule that named the primary (issue catalog rule 4).
 *
 * ## Recording an overlap deletes nothing
 *
 * Both offers keep their rows, their prices, their `source_record_id` chains and
 * their observation history. Issue catalog rules 3 and 5 and acceptance 3 all
 * point at the same property from different angles: an external offer is not
 * deleted because the merchant now sells natively, prior clicks and price
 * history are preserved, and matching external and native offers remain DISTINCT
 * while sharing the canonical product. So this table is a FINDING, in the shape
 * `payment_discrepancies` uses — a durable record that two rows describe one
 * sale, with the rule that decided which to prefer, and no destructive effect at
 * all.
 *
 * Both offer references are RESTRICT: a finding must be able to block a delete
 * rather than vanish with the row it is about. Nothing in the offer domain
 * hard-deletes anyway (retirement is a status transition), so this constraint
 * costs nothing and states the intent at the constraint.
 */
export const storeLinkageOfferOverlaps = pgTable(
  'store_linkage_offer_overlaps',
  {
    id: generatedId(),
    requestId: text()
      .notNull()
      .references(() => storeLinkageRequests.id, { onDelete: 'cascade' }),
    merchantId: text()
      .notNull()
      .references(() => merchants.id, { onDelete: 'restrict' }),
    canonicalVariantId: text()
      .notNull()
      .references(() => canonicalVariants.id, { onDelete: 'restrict' }),
    /** The representation the rule preferred. Not a deletion of the other. */
    primaryOfferId: text()
      .notNull()
      .references(() => offers.id, { onDelete: 'restrict' }),
    duplicateOfferId: text()
      .notNull()
      .references(() => offers.id, { onDelete: 'restrict' }),
    rule: text({ enum: asEnumValues(STORE_LINKAGE_OVERLAP_RULES) }).notNull(),
    detectedAt: timestamptz().notNull(),
  },
  (t) => [
    checkOneOf('store_linkage_offer_overlaps_rule_check', t.rule, STORE_LINKAGE_OVERLAP_RULES),
    // An offer cannot be its own duplicate; without this a bug that compared a
    // row to itself would record a finding nobody could act on.
    check(
      'store_linkage_offer_overlaps_distinct_check',
      sql`${t.primaryOfferId} <> ${t.duplicateOfferId}`,
    ),
    // One finding per (request, duplicate): re-running reconciliation converges
    // instead of stacking a fresh row per sweep — the reason `reportDiscrepancy`
    // dedupes rather than appending, applied at the index.
    uniqueIndex('store_linkage_offer_overlaps_request_duplicate_key').on(
      t.requestId,
      t.duplicateOfferId,
    ),
    index('store_linkage_offer_overlaps_merchant_idx').on(t.merchantId, t.detectedAt.desc()),
    index('store_linkage_offer_overlaps_variant_idx').on(t.canonicalVariantId),
  ],
);
