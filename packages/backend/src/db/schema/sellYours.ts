/**
 * The "Sell yours" seller draft (#91) — `seller_listing_drafts`,
 * `seller_draft_condition_details`, `seller_draft_images`,
 * `seller_draft_match_assertions`.
 *
 * A draft is server-side, resumable work-in-progress that becomes exactly one
 * P2P listing. Everything here is the SELLER's, and the canonical graph is
 * referenced rather than copied: the four columns pointing at
 * `canonical_products` / `canonical_variants` are the whole of the connection,
 * and #59's merge-plan census forces a disposition for each of them.
 *
 * ## Three shapes worth reading before changing anything
 *
 * 1. **There is no canonical TEXT on this table.** No prefilled title, brand,
 *    model or attribute is stored — the draft stores what the SELLER typed, and
 *    a read joins the canonical row for the rest. A stored copy would be a
 *    second representation of a fact the graph already owns, and a merge or a
 *    correction would leave it saying what the product used to be called.
 * 2. **`published_listing_id` moves NULL → value exactly once.** The trigger
 *    permits NULL→value (a publication) and value→NULL (a listing genuinely
 *    deleted, which the foreign key's `set null` performs) and REFUSES
 *    value→value — #106's buyer-origin trigger, for its reason: that refusal is
 *    what makes "repeated submits create one listing" (#91 acceptance 3)
 *    impossible for a service bug to get wrong, rather than merely unlikely.
 * 3. **`seller_draft_match_assertions` is append-only.** UPDATE is refused
 *    always and DELETE only while the parent draft still exists (#90's precise
 *    exception), so "the seller changed their mind about the product" is a new
 *    row rather than an edit — which is the only shape under which #91's
 *    acceptance 4 ("an incorrect match can be changed without corrupting the
 *    canonical product") leaves any evidence that it happened.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
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
  CONDITION_DETAIL_KINDS,
  CONDITION_DETAIL_KINDS_WITH_SEVERITY,
  CONDITION_DETAIL_SEVERITIES,
  CONDITION_PHOTO_PROVENANCES,
  ITEM_CONDITION_KEYS,
  MATCH_BLOCKERS,
  SCORED_SELLER_MATCH_ACTORS,
  SELLER_DRAFT_ENTRY_PATHS,
  SELLER_DRAFT_MATCH_STATES,
  SELLER_DRAFT_STATUSES,
  SELLER_DRAFT_STEPS,
  SELLER_MATCH_ACTORS,
  SELLER_MATCH_ASSERTION_OUTCOMES,
  SELLER_PICKUP_AVAILABILITIES,
} from '@mercaria/shared-types';
import { asEnumValues, checkEveryElementOf, checkOneOf, currencyChecks, optionalMoney } from './columns.js';
import { canonicalProducts, canonicalVariants } from './canonicalCatalog.js';
import { categories, listings } from './catalog.js';

/**
 * `seller_listing_drafts` — one in-flight "Sell yours" flow.
 *
 * The owner is an Oxy account id with NO foreign key, like every other
 * `oxy_user_id` in this schema: Oxy owns identity.
 *
 * `client_draft_key` is the idempotency key a client mints once per flow, so a
 * retried "start selling" tap resumes rather than creating a second draft. It is
 * scoped to the owner, which is what stops one account's key colliding with
 * another's.
 */
export const sellerListingDrafts = pgTable(
  'seller_listing_drafts',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    oxyUserId: text().notNull(),
    clientDraftKey: text().notNull(),
    entryPath: text({ enum: asEnumValues(SELLER_DRAFT_ENTRY_PATHS) }).notNull(),
    status: text({ enum: asEnumValues(SELLER_DRAFT_STATUSES) }).notNull().default('in_progress'),

    // ── Progress, saved server-side so another Oxy client resumes exactly here ──
    currentStep: text({ enum: asEnumValues(SELLER_DRAFT_STEPS) }).notNull().default('identify'),
    completedSteps: text().array().notNull().default(sql`'{}'::text[]`),

    // ── The canonical match the seller is proposing ────────────────────────────
    /**
     * `set null` on both canonical references, and the choice is the interesting
     * part: a draft outlives a catalogue correction, and `restrict` would make a
     * merge or a deletion fail because somebody had a half-finished listing open.
     * NULL already means "unmatched", which is a state the flow handles
     * completely — so losing the pointer degrades to the honest answer.
     */
    canonicalProductId: text().references(() => canonicalProducts.id, { onDelete: 'set null' }),
    canonicalVariantId: text().references(() => canonicalVariants.id, { onDelete: 'set null' }),
    matchState: text({ enum: asEnumValues(SELLER_DRAFT_MATCH_STATES) })
      .notNull()
      .default('unmatched'),
    matchActor: text({ enum: asEnumValues(SELLER_MATCH_ACTORS) }),
    /** Only a `matcher` may carry one — see `SCORED_SELLER_MATCH_ACTORS`. */
    matchConfidence: doublePrecision(),

    // ── The seller's own statement ─────────────────────────────────────────────
    title: text(),
    description: text(),
    /**
     * `restrict`: the same decision `listings.category_id` makes. Nothing deletes
     * a category, and `set null` would silently promote a draft into
     * "uncategorized", which the publication gate treats as a missing category.
     */
    categoryId: text().references(() => categories.id, { onDelete: 'restrict' }),
    tags: text().array().notNull().default(sql`'{}'::text[]`),

    conditionKey: text({ enum: asEnumValues(ITEM_CONDITION_KEYS) }),
    /**
     * When the seller affirmatively acknowledged the disclosed defects — the
     * `listings.condition_acknowledged_at` decision, one step earlier in the
     * flow. A timestamp rather than a boolean, because "they agreed" and "they
     * agreed at this point, to what was disclosed then" are different facts.
     */
    defectsAcknowledgedAt: timestamptz(),
    /**
     * What IS in the box, as a scalar list rendered whole.
     *
     * `text[]` rather than a child table for the `listing_options.values`
     * reason: it is never queried by element. What is MISSING is deliberately
     * NOT here — that is #90's `missing_accessory` condition detail, which
     * carries a mandatory note and counts toward the disclosure gate. Two
     * vocabularies for one fact would let a seller list a missing remote as an
     * "included accessory" and satisfy nothing.
     */
    includedAccessories: text().array().notNull().default(sql`'{}'::text[]`),

    quantity: integer().notNull().default(1),
    ...optionalMoney('price'),

    pickup: text({ enum: asEnumValues(SELLER_PICKUP_AVAILABILITIES) })
      .notNull()
      .default('not_offered'),

    /**
     * The coarse public location, and it is stored ALREADY COARSENED.
     *
     * `coarsenSellerCoordinate` runs at the write boundary, so the precise
     * coordinate a device reported never reaches a column. Rounding at read time
     * instead would leave the exact position in the database, in backups and in
     * every operator query — a privacy property that depends on every reader
     * remembering is not a privacy property.
     */
    locationOptIn: boolean().notNull().default(false),
    locationLongitude: doublePrecision(),
    locationLatitude: doublePrecision(),

    // ── The publication ────────────────────────────────────────────────────────
    /**
     * `set null`: a seller who deletes the published listing must not be blocked
     * by a finished draft, and the trigger below permits the resulting
     * value→NULL transition. `published_at` is the durable fact and survives it.
     */
    publishedListingId: text().references(() => listings.id, { onDelete: 'set null' }),
    publishedAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('seller_listing_drafts_entry_path_check', t.entryPath, SELLER_DRAFT_ENTRY_PATHS),
    checkOneOf('seller_listing_drafts_status_check', t.status, SELLER_DRAFT_STATUSES),
    checkOneOf('seller_listing_drafts_current_step_check', t.currentStep, SELLER_DRAFT_STEPS),
    checkEveryElementOf(
      'seller_listing_drafts_completed_steps_check',
      t.completedSteps,
      SELLER_DRAFT_STEPS,
    ),
    checkOneOf('seller_listing_drafts_match_state_check', t.matchState, SELLER_DRAFT_MATCH_STATES),
    checkOneOf('seller_listing_drafts_match_actor_check', t.matchActor, SELLER_MATCH_ACTORS),
    checkOneOf('seller_listing_drafts_condition_check', t.conditionKey, ITEM_CONDITION_KEYS),
    checkOneOf('seller_listing_drafts_pickup_check', t.pickup, SELLER_PICKUP_AVAILABILITIES),
    ...currencyChecks('seller_listing_drafts', [t.priceCurrency]),

    /**
     * A match state and its ids cannot disagree.
     *
     * `unmatched` and `seller_rejected` carry NO canonical product — a rejection
     * that kept the id it rejected would read, to every consumer, exactly like a
     * proposal. Everything else carries at least a product, because #58 resolves
     * product identity before variant identity and "matched the model, not the
     * configuration" is a real outcome.
     */
    check(
      'seller_listing_drafts_match_shape_check',
      sql`(${t.matchState} in ('unmatched', 'seller_rejected')
             and ${t.canonicalProductId} is null and ${t.canonicalVariantId} is null)
          or (${t.matchState} not in ('unmatched', 'seller_rejected')
             and ${t.canonicalProductId} is not null)`,
    ),
    // A variant without its product is an attachment nothing can resolve.
    check(
      'seller_listing_drafts_variant_implies_product_check',
      sql`${t.canonicalVariantId} is null or ${t.canonicalProductId} is not null`,
    ),
    // #58's rule, one domain over: only a scorer carries a score.
    check(
      'seller_listing_drafts_match_confidence_check',
      sql`${t.matchConfidence} is null
          or (${t.matchActor} in (${sql.raw(
            SCORED_SELLER_MATCH_ACTORS.map((actor) => `'${actor}'`).join(', '),
          )}) and ${t.matchConfidence} between 0 and 1)`,
    ),
    // An actor with no match, or a match with no actor, is half a record.
    check(
      'seller_listing_drafts_match_actor_paired_check',
      sql`(${t.matchActor} is null) = (${t.canonicalProductId} is null)`,
    ),

    check('seller_listing_drafts_quantity_check', sql`${t.quantity} >= 1`),
    check(
      'seller_listing_drafts_price_paired_check',
      sql`(${t.priceAmount} is null) = (${t.priceCurrency} is null)`,
    ),
    // The `listings_coordinates_check` rule: a point is whole or absent.
    check(
      'seller_listing_drafts_coordinates_check',
      sql`(${t.locationLongitude} is null) = (${t.locationLatitude} is null)`,
    ),
    // Coordinates without the opt-in are coordinates nobody agreed to publish.
    check(
      'seller_listing_drafts_location_opt_in_check',
      sql`${t.locationOptIn} or (${t.locationLongitude} is null and ${t.locationLatitude} is null)`,
    ),
    /**
     * `published_at` is the durable publication fact, not the id.
     *
     * The id may become NULL again if the listing is genuinely deleted, so a
     * biconditional on the ID would turn a legitimate deletion into a constraint
     * violation. Stated on the timestamp instead, which nothing clears.
     */
    check(
      'seller_listing_drafts_published_check',
      sql`(${t.status} = 'published') = (${t.publishedAt} is not null)`,
    ),

    uniqueIndex('seller_listing_drafts_owner_client_key').on(t.oxyUserId, t.clientDraftKey),
    // The seller's own list of drafts, newest first — the resume surface.
    index('seller_listing_drafts_owner_status_updated_at_idx').on(
      t.oxyUserId,
      t.status,
      t.updatedAt.desc(),
      t.id.desc(),
    ),
    // One published listing has at most one draft behind it, which is what makes
    // "which flow produced this listing" answerable and a double publication
    // impossible even if the trigger were dropped.
    uniqueIndex('seller_listing_drafts_published_listing_key')
      .on(t.publishedListingId)
      .where(sql`${t.publishedListingId} is not null`),
    index('seller_listing_drafts_canonical_product_idx')
      .on(t.canonicalProductId)
      .where(sql`${t.canonicalProductId} is not null`),
    index('seller_listing_drafts_canonical_variant_idx')
      .on(t.canonicalVariantId)
      .where(sql`${t.canonicalVariantId} is not null`),
  ],
);

/**
 * `seller_draft_condition_details` — #90's structured disclosures, staged.
 *
 * The same vocabulary and the same two shape rules as `listing_condition_details`,
 * because these rows ARE those rows one step before publication: the publish path
 * hands them to `resolveConditionInput` verbatim. A second vocabulary here would
 * mean a seller could disclose something on the draft that the listing has no way
 * to record.
 */
export const sellerDraftConditionDetails = pgTable(
  'seller_draft_condition_details',
  {
    id: generatedId(),
    draftId: text()
      .notNull()
      .references(() => sellerListingDrafts.id, { onDelete: 'cascade' }),
    kind: text({ enum: asEnumValues(CONDITION_DETAIL_KINDS) }).notNull(),
    severity: text({ enum: asEnumValues(CONDITION_DETAIL_SEVERITIES) }),
    note: text(),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('seller_draft_condition_details_kind_check', t.kind, CONDITION_DETAIL_KINDS),
    checkOneOf(
      'seller_draft_condition_details_severity_value_check',
      t.severity,
      CONDITION_DETAIL_SEVERITIES,
    ),
    // Only wear and faults have a severity; "the box is missing" is not `light`.
    check(
      'seller_draft_condition_details_severity_shape_check',
      sql`${t.severity} is null or ${t.kind} in (${sql.raw(
        CONDITION_DETAIL_KINDS_WITH_SEVERITY.map((kind) => `'${kind}'`).join(', '),
      )})`,
    ),
    index('seller_draft_condition_details_draft_id_position_idx').on(t.draftId, t.position),
  ],
);

/**
 * `seller_draft_images` — the seller's own gallery, staged.
 *
 * These file ids become `listing_images` at publication and are the ONLY source
 * of the listing's condition evidence. There is deliberately no second upload
 * channel and no way to reference a canonical asset: the provenance column
 * carries #90's seller-owned vocabulary, and a trigger refuses a file id that a
 * `canonical_images` row already claims or that another account's listing
 * already shows.
 *
 * The trigger is the half the vocabulary cannot see. A seller cannot record a
 * photo as `canonical_product_image` because no such value exists; they can
 * perfectly well paste the file id of one, and only the database can notice.
 */
export const sellerDraftImages = pgTable(
  'seller_draft_images',
  {
    id: generatedId(),
    draftId: text()
      .notNull()
      .references(() => sellerListingDrafts.id, { onDelete: 'cascade' }),
    /** An Oxy media file id — no foreign key; Oxy owns the file. */
    fileId: text().notNull(),
    alt: text(),
    position: integer().notNull().default(0),
    provenance: text({ enum: asEnumValues(CONDITION_PHOTO_PROVENANCES) }).notNull(),
    showsDefect: boolean().notNull().default(false),
    /**
     * The disclosure this photograph evidences (#90 evidence rule 4).
     *
     * `set null` rather than `cascade`: removing a disclosure must not silently
     * delete the photograph that showed it. The photo survives as an unlabelled
     * item photo, which still counts toward the evidence minimum.
     */
    conditionDetailId: text().references(() => sellerDraftConditionDetails.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('seller_draft_images_provenance_check', t.provenance, CONDITION_PHOTO_PROVENANCES),
    // One file is one photograph. Added twice by a retry, it converges.
    uniqueIndex('seller_draft_images_draft_id_file_id_key').on(t.draftId, t.fileId),
    index('seller_draft_images_draft_id_position_idx').on(t.draftId, t.position),
  ],
);

/**
 * `seller_draft_match_assertions` — the append-only trail of what was proposed,
 * confirmed, rejected, refused and attached (#91 listing creation 2).
 *
 * APPEND-ONLY, with #90's PRECISE delete exception: UPDATE is refused always,
 * DELETE only while the parent draft still exists. The whole value of this table
 * is that a seller who changed their mind about which product they are selling
 * leaves both answers behind, and an UPDATE would collapse that into the last
 * one — the state that makes a false merge unexplainable afterwards.
 *
 * The exception is not a softening: an UNCONDITIONAL delete refusal makes the
 * `ON DELETE cascade` on `draft_id` fail, so a draft carrying any assertion
 * becomes undeletable and an erasure request against it fails at the database.
 * The first version of the trigger had exactly that bug and the realdb suite
 * caught it on its first run, in the TEARDOWN rather than in an assertion.
 *
 * `canonical_*_id` are `set null` here too, and the merge plan deliberately
 * leaves these rows with the TOMBSTONE rather than repointing them: an assertion
 * records what the seller declared THEN, and moving it onto the surviving
 * product would rewrite a person's statement to be about something else.
 */
export const sellerDraftMatchAssertions = pgTable(
  'seller_draft_match_assertions',
  {
    id: generatedId(),
    draftId: text()
      .notNull()
      .references(() => sellerListingDrafts.id, { onDelete: 'cascade' }),
    outcome: text({ enum: asEnumValues(SELLER_MATCH_ASSERTION_OUTCOMES) }).notNull(),
    actor: text({ enum: asEnumValues(SELLER_MATCH_ACTORS) }).notNull(),
    /** Required for a person, forbidden for a matcher — the CHECK below. */
    actorOxyUserId: text(),
    canonicalProductId: text().references(() => canonicalProducts.id, { onDelete: 'set null' }),
    canonicalVariantId: text().references(() => canonicalVariants.id, { onDelete: 'set null' }),
    confidence: doublePrecision(),
    /** #58's own blocker vocabulary — never a second one. */
    blockers: text().array().notNull().default(sql`'{}'::text[]`),
    reasonCodes: text().array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'seller_draft_match_assertions_outcome_check',
      t.outcome,
      SELLER_MATCH_ASSERTION_OUTCOMES,
    ),
    checkOneOf('seller_draft_match_assertions_actor_check', t.actor, SELLER_MATCH_ACTORS),
    checkEveryElementOf('seller_draft_match_assertions_blockers_check', t.blockers, MATCH_BLOCKERS),
    /**
     * A person is identified; a matcher is not.
     *
     * `IDENTIFIED_CONDITION_REVISION_ACTORS`' rule (#90): recording an account id
     * for an automatic evaluation would be a lie in an audit table, and omitting
     * one for a human decision makes the table unable to answer who decided.
     */
    check(
      'seller_draft_match_assertions_actor_identity_check',
      sql`(${t.actor} = 'matcher') = (${t.actorOxyUserId} is null)`,
    ),
    check(
      'seller_draft_match_assertions_confidence_check',
      sql`${t.confidence} is null
          or (${t.actor} in (${sql.raw(
            SCORED_SELLER_MATCH_ACTORS.map((actor) => `'${actor}'`).join(', '),
          )}) and ${t.confidence} between 0 and 1)`,
    ),
    /**
     * A refusal that named no blocker explains nothing.
     *
     * `cardinality`, never `array_length`: the latter is NULL on `{}` and a CHECK
     * reads NULL as satisfied, so the obvious spelling admits exactly the row it
     * exists to refuse. Measured twice elsewhere in this schema (#68, #108).
     */
    check(
      'seller_draft_match_assertions_refusal_check',
      sql`${t.outcome} <> 'gate_refused' or cardinality(${t.blockers}) >= 1`,
    ),
    // An attachment names both ends; there is nothing to attach otherwise.
    check(
      'seller_draft_match_assertions_attachment_check',
      sql`${t.outcome} <> 'attached'
          or (${t.canonicalProductId} is not null and ${t.canonicalVariantId} is not null)`,
    ),
    index('seller_draft_match_assertions_draft_id_created_at_idx').on(
      t.draftId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
  ],
);
