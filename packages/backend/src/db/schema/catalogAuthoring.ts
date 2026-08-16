/**
 * The catalog authoring domain (#367 step 5, ADR 0007 D10) —
 * `catalog_authoring_drafts`, `catalog_authoring_draft_variants`,
 * `catalog_authoring_draft_values` and
 * `catalog_authoring_schema_invalidations`.
 *
 * A draft is the half-finished product somebody is filling in, pinned to the
 * exact rules it was started under. The service in front of it composes an
 * `AuthoringSchema`; these four tables are what the composition is remembered
 * against and what a publication reads.
 *
 * ## Everything a draft PINS, and why every pin is a real column
 *
 * `category_id`, `product_type_definition_id` (the exact VERSION), `locale`,
 * `market`, and — on every value row — `attribute_definition_id` plus its
 * version. ADR 0007 D5's rule is that a newer version never silently
 * reinterprets an older record, and a pin nobody stored is a pin that does not
 * exist: without the version columns "what was this answer an answer to" is
 * answerable only by guessing at the schema that happens to be current now.
 *
 * The attribute pin is on the VALUE and not on the draft, deliberately. A draft
 * is answered over days; the schema it pins can cite twenty attribute versions
 * and an upgrade preview has to say which individual answers move. A single
 * draft-level "attribute versions" array could say that a set changed and never
 * which answer it was about.
 *
 * ## The ONE jsonb, and what it is NOT
 *
 * `catalog_authoring_drafts.schema_snapshot` is ADR 0007 D14's second sanctioned
 * use: a BOUNDED, IMMUTABLE snapshot kept for audit and recovery. It is frozen
 * by `mercaria_catalog_authoring_draft_snapshot_immutable` from the moment it is
 * written, because the thing it is evidence OF is what an author was shown — and
 * a snapshot a later write can edit is evidence of nothing.
 *
 * It is emphatically not a cache and nothing reads a rule out of it: every
 * validation and every publish composes the schema live and compares
 * `schema_hash`. `catalog-authoring-schema.test.ts` asserts the domain declares
 * exactly one jsonb column, the `product_type_fields.visibility_rule` device.
 *
 * ## What no row here can say
 *
 * - **That a draft is a listing.** No status here is a listing status, there is
 *   no `published_at`, no price range and no facet: a draft becomes a listing by
 *   being PUBLISHED, in one transaction, and `published_listing_id` is a pointer
 *   at the result rather than a copy of it.
 * - **That a canonical selection is a match.** The selection columns carry no
 *   confidence and no rule id, because a person chose. What the publication
 *   writes is a `native_listing_links` row with method `merchant_declared`, and
 *   the matcher is not run for an entity the author resolved (D10).
 * - **That an expired draft was published.** `expires_at` is NOT NULL exactly
 *   while a draft can still be abandoned and NULL once it has been published (a
 *   biconditional CHECK), so the expiry sweep's unconditional
 *   `DELETE WHERE expires_at <= now()` selects exactly the abandoned set — the
 *   `notifications.dismissed_at` device, which turns a condition the sweep
 *   cannot express into a column it can.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  ATTRIBUTE_COMPONENT_AXES,
  AUTHORING_CANONICAL_REF_KINDS,
  AUTHORING_DRAFT_STATUSES,
  AUTHORING_INVALIDATION_SUBJECTS,
  AUTHORING_VALUE_KINDS,
  PRODUCT_TYPE_AUTHORING_FLOWS,
  PRODUCT_TYPE_FIELD_SCOPES,
  type AuthoringSchema,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, currencyChecks, optionalMoney } from './columns';
import { attributeDefinitions, attributeEnumValues } from './attributeRegistry';
import { categories, listings } from './catalog';
import { productTypeDefinitions, productTypeFields } from './productTypes';
import { stores } from './stores';

/**
 * `catalog_authoring_drafts` — one product somebody is authoring.
 *
 * ## `cascade` from the store, and it is the only cascade in the domain
 *
 * A draft is working state. It is not a commerce record, nobody can be asked
 * about it by a tax authority, and it expires on its own — which is exactly the
 * shape `CONVENTIONS.md` names for a cascade ("rows that exist only to point at
 * a parent and are meaningless without it"). `listings` uses `restrict` on the
 * same column because a listing IS such a record; the difference between the two
 * is the whole reason publication exists.
 *
 * ## Optimistic concurrency is on the DRAFT, not on the answer
 *
 * `version` is a compare-and-swap carrying `store_id` in the same predicate (the
 * `watchlists` device). The unit is the draft rather than the value because a
 * form is submitted as a whole: a per-answer token would let a variant matrix
 * computed against one set of axes be applied to another, and the two would
 * disagree about which axes exist while every individual write succeeded.
 *
 * ## The canonical selection carries NO foreign key, and that is a decision
 *
 * `selected_canonical_product_id` and `selected_canonical_variant_id` are plain
 * columns, ledgered in `ID_COLUMNS_WITHOUT_FOREIGN_KEY`. A `restrict` foreign
 * key would let one merchant's half-finished form BLOCK a catalogue merge; a
 * `cascade` would delete their work; `set null` would silently erase the one
 * answer D10 says must never be overruled. The resolution instead happens at
 * PUBLISH time, through `canonical_product_redirects` — which #59's merge
 * already writes — so a merge during a long-lived draft resolves to the winner
 * with no rehoming pass and no blocked operator.
 */
export const catalogAuthoringDrafts = pgTable(
  'catalog_authoring_drafts',
  {
    id: generatedId(),
    /** `cascade`: a draft is working state and means nothing without its store. */
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key; Oxy owns identity. */
    createdByOxyUserId: text().notNull(),
    status: text({ enum: asEnumValues(AUTHORING_DRAFT_STATUSES) }).notNull().default('open'),

    /** `restrict`: nothing deletes a category, and a pin may not be orphaned. */
    categoryId: text()
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    /** The EXACT product-type version, which is the pin ADR 0007 D5 requires. */
    productTypeDefinitionId: text()
      .notNull()
      .references(() => productTypeDefinitions.id, { onDelete: 'restrict' }),
    flow: text({ enum: asEnumValues(PRODUCT_TYPE_AUTHORING_FLOWS) }).notNull(),
    /** A folded BCP 47 tag — the same stored form the localization family uses. */
    locale: text().notNull(),
    /** An ISO 3166-1 alpha-2 market, upper-case. */
    market: text().notNull(),

    /**
     * The deterministic hash of the schema this draft's answers were given
     * under — the same string served as the ETag.
     *
     * Compared on every validate and every publish. A mismatch is not an error:
     * it is what makes the upgrade preview possible, because "the rules moved
     * under this draft" is a fact somebody has to be shown rather than one a
     * write should silently absorb.
     */
    schemaHash: text().notNull(),
    /** ADR 0007 D14's bounded, immutable audit snapshot. See the file header. */
    schemaSnapshot: jsonb().$type<AuthoringSchema>(),

    /** The compare-and-swap token every mutation states. */
    version: integer().notNull().default(1),

    title: text(),
    description: text(),
    /** Oxy media file ids — no foreign key; Oxy owns the file. */
    imageFileIds: text().array().notNull().default(sql`'{}'::text[]`),
    tags: text().array().notNull().default(sql`'{}'::text[]`),

    /**
     * The canonical PRODUCT the author selected. See the doc above for the FK.
     *
     * The product is here and the configuration is on the VARIANT row, because a
     * draft has one product and N configurations. Carrying a single canonical
     * variant id here would be unresolvable the moment a draft declared two
     * variants: nothing could say which of them the chosen configuration was, and
     * `native_listing_links` is keyed on `product_variant_id`.
     */
    selectedCanonicalProductId: text(),

    /**
     * The listing this draft became. `restrict`: a published draft is the audit
     * record of what was published, and a listing is never hard-deleted anyway.
     */
    publishedListingId: text().references(() => listings.id, { onDelete: 'restrict' }),
    publishedAt: timestamptz(),
    /** The caller-supplied `Idempotency-Key` a publish converged on. */
    publishIdempotencyKey: text(),

    /**
     * The abandonment deadline. NOT NULL exactly while a draft can still be
     * abandoned; NULL once published. See the file header.
     */
    expiresAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('catalog_authoring_drafts_status_check', t.status, AUTHORING_DRAFT_STATUSES),
    checkOneOf('catalog_authoring_drafts_flow_check', t.flow, PRODUCT_TYPE_AUTHORING_FLOWS),
    // The stored form, stated at the row: a lookup that folded and a write that
    // did not are a miss rather than an error anybody sees. Identical to
    // `attribute_labels_locale_shape_check`, so the two vocabularies cannot
    // diverge on what a legal tag looks like.
    check(
      'catalog_authoring_drafts_locale_shape_check',
      sql`${t.locale} = lower(btrim(${t.locale})) and ${t.locale} ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$'`,
    ),
    check('catalog_authoring_drafts_market_shape_check', sql`${t.market} ~ '^[A-Z]{2}$'`),
    check('catalog_authoring_drafts_version_check', sql`${t.version} >= 1`),
    check('catalog_authoring_drafts_schema_hash_check', sql`btrim(${t.schemaHash}) <> ''`),
    /**
     * THREE biconditionals on the published state, not one over their
     * conjunction. The single-CHECK spelling is SATISFIED by an `open` row
     * carrying a listing id and no timestamp, because both sides evaluate false
     * — which is exactly the row the discriminant exists to forbid. Measured
     * twice already in this schema (`category_redirects`,
     * `retail_delivery_promises`).
     */
    check(
      'catalog_authoring_drafts_published_listing_check',
      sql`(${t.status} = 'published') = (${t.publishedListingId} is not null)`,
    ),
    check(
      'catalog_authoring_drafts_published_at_check',
      sql`(${t.status} = 'published') = (${t.publishedAt} is not null)`,
    ),
    /**
     * The expiry half of the same fact, and the reason the sweep is correct: a
     * published draft has no deadline and is never swept, and everything else
     * has one. The sweep selects on `expires_at` alone
     * (`expiryTargets.ts`), so this CHECK is what makes that selection
     * equal to "the abandoned ones".
     */
    check(
      'catalog_authoring_drafts_expiry_check',
      sql`(${t.status} = 'published') = (${t.expiresAt} is null)`,
    ),
    /**
     * A snapshot belongs to a draft somebody actually saw a schema for, and a
     * bounded one — ADR 0007 D14. `octet_length(<col>::text)` rather than
     * `pg_column_size`: the second is STABLE (its answer depends on TOAST and
     * compression), so PostgreSQL refuses it in a CHECK, and it measures the
     * compressed size rather than the size a reader has to parse.
     */
    check(
      'catalog_authoring_drafts_snapshot_bounded_check',
      sql`${t.schemaSnapshot} is null
          or (jsonb_typeof(${t.schemaSnapshot}) = 'object'
              and octet_length(${t.schemaSnapshot}::text) <= 262144)`,
    ),
    /**
     * ONE publish per idempotency key per store.
     *
     * Partial, because Postgres treats NULLs as DISTINCT and most drafts carry
     * none. The key is scoped to the STORE rather than being global: two
     * merchants generating the same client-side key must not collide, and a
     * global unique would answer the second one with somebody else's listing.
     */
    uniqueIndex('catalog_authoring_drafts_idempotency_key')
      .on(t.storeId, t.publishIdempotencyKey)
      .where(sql`${t.publishIdempotencyKey} is not null`),
    /** The store's own draft list, newest first — the surface's only feed. */
    index('catalog_authoring_drafts_store_idx').on(t.storeId, t.status, t.updatedAt.desc()),
    index('catalog_authoring_drafts_expires_at_idx')
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} is not null`),
    index('catalog_authoring_drafts_product_type_idx').on(t.productTypeDefinitionId),
  ],
);

/**
 * `catalog_authoring_draft_variants` — the variants an author is building.
 *
 * Their AXIS VALUES are not here: they are `catalog_authoring_draft_values` rows
 * with `scope = 'variant'` pointing at this row. Two representations of one
 * answer is the failure this whole epic is written against, and a `{name, value}`
 * pair on a variant row is precisely the free-text axis ADR 0007 D6 replaces.
 *
 * `axis_signature` is the order-independent hash D6 requires — the normalized
 * set of `(attribute_definition_id, normalized_value)` pairs. It is UNIQUE per
 * draft while non-null, so two variants whose axes were entered in different
 * orders collide by construction rather than by a service comparing lists.
 */
export const catalogAuthoringDraftVariants = pgTable(
  'catalog_authoring_draft_variants',
  {
    id: generatedId(),
    draftId: text()
      .notNull()
      .references(() => catalogAuthoringDrafts.id, { onDelete: 'cascade' }),
    position: integer().notNull().default(0),
    title: text(),
    /** NULL when absent, never `''` — an empty string is a VALUE that collides. */
    sku: text(),
    barcode: text(),
    ...optionalMoney('price'),
    ...optionalMoney('compareAtPrice'),
    inventoryTracked: boolean().notNull().default(true),
    inventoryAvailable: integer().notNull().default(0),
    /** The order-independent axis hash (ADR 0007 D6). NULL until axes are set. */
    axisSignature: text(),
    /**
     * The canonical CONFIGURATION the author selected for this variant.
     *
     * No foreign key, for the reason the draft's product selection carries none:
     * a `restrict` FK would let a half-finished form block a catalogue merge, and
     * every other `ON DELETE` would destroy or silently empty the one answer
     * ADR 0007 D10 says must never be overruled. The publication resolves it
     * through `canonical_variants.merged_into_id` instead, so a merge that
     * happened while the draft was open lands on the winner.
     */
    selectedCanonicalVariantId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    ...currencyChecks('catalog_authoring_draft_variants', [t.priceCurrency, t.compareAtPriceCurrency]),
    check('catalog_authoring_draft_variants_position_check', sql`${t.position} >= 0`),
    check(
      'catalog_authoring_draft_variants_inventory_check',
      sql`${t.inventoryAvailable} >= 0`,
    ),
    // The two halves of a `Money` are absent TOGETHER. `product_variants` states
    // the same rule; a draft that could hold an amount with no currency would
    // publish one.
    check(
      'catalog_authoring_draft_variants_price_paired_check',
      sql`(${t.priceAmount} is null) = (${t.priceCurrency} is null)`,
    ),
    check(
      'catalog_authoring_draft_variants_compare_at_paired_check',
      sql`(${t.compareAtPriceAmount} is null) = (${t.compareAtPriceCurrency} is null)`,
    ),
    check(
      'catalog_authoring_draft_variants_sku_not_empty_check',
      sql`${t.sku} is null or btrim(${t.sku}) <> ''`,
    ),
    check(
      'catalog_authoring_draft_variants_barcode_not_empty_check',
      sql`${t.barcode} is null or btrim(${t.barcode}) <> ''`,
    ),
    /** ADR 0007 D6: two variants of one draft cannot carry the same axis set. */
    uniqueIndex('catalog_authoring_draft_variants_signature_key')
      .on(t.draftId, t.axisSignature)
      .where(sql`${t.axisSignature} is not null`),
    uniqueIndex('catalog_authoring_draft_variants_position_key').on(t.draftId, t.position),
  ],
);

/**
 * `catalog_authoring_draft_values` — one TYPED answer.
 *
 * ADR 0007 D10 says draft values are stored **typed**, and this is what that
 * means in practice: five value columns, a `kind` discriminant, and a CHECK
 * making exactly one of them populated. The alternative — a `value jsonb` bag —
 * would make every validation a re-parse of whatever the client last sent, would
 * put an unvalidated shape on the publication path, and is precisely the
 * open-shaped column D14 forbids.
 *
 * ## The composite pin, and why the citation columns are guarded rather than
 * trusted
 *
 * `field_id` cites `product_type_fields`; `attribute_definition_id` and
 * `attribute_definition_version` cite the exact registry version the answer was
 * given under. The last two are a DENORMALIZATION and are kept in step by
 * `mercaria_catalog_authoring_value_citation()`, the
 * `mercaria_product_type_field_citation()` device: a CHECK admits no subquery, a
 * service-level check is one forgotten call site from being no check at all, and
 * an upgrade preview that compared a stale version would report "unchanged" for
 * an answer whose meaning had moved.
 *
 * ## Scope and the variant pointer are ONE fact, stated as a biconditional
 *
 * A `variant`-scope value names a draft variant; every other scope names none.
 * Anything else is an answer that belongs to two places at once or to nowhere.
 */
export const catalogAuthoringDraftValues = pgTable(
  'catalog_authoring_draft_values',
  {
    id: generatedId(),
    draftId: text()
      .notNull()
      .references(() => catalogAuthoringDrafts.id, { onDelete: 'cascade' }),
    /**
     * `cascade`: an answer about a variant that no longer exists is not a weaker
     * answer, it is one about nothing.
     */
    draftVariantId: text().references(() => catalogAuthoringDraftVariants.id, {
      onDelete: 'cascade',
    }),
    /**
     * The schema field this answers. `restrict`: a field with answers stored
     * against it is not deletable, and a published version's fields are frozen
     * by trigger anyway — so this only ever bites a draft version somebody is
     * still editing, which is exactly when they should be told.
     */
    fieldId: text()
      .notNull()
      .references(() => productTypeFields.id, { onDelete: 'restrict' }),
    /** The registry VERSION this answer was given under. `restrict`, per above. */
    attributeDefinitionId: text()
      .notNull()
      .references(() => attributeDefinitions.id, { onDelete: 'restrict' }),
    /** Guarded citations. See the doc above; the trigger is the authority. */
    attributeKey: text().notNull(),
    attributeDefinitionVersion: integer().notNull(),
    scope: text({ enum: asEnumValues(PRODUCT_TYPE_FIELD_SCOPES) }).notNull(),
    /** 0 for a single value; the position inside an ordered or multi value. */
    ordinal: integer().notNull().default(0),
    /** Non-null exactly for a `structured` attribute's component. */
    componentAxis: text({ enum: asEnumValues(ATTRIBUTE_COMPONENT_AXES) }),

    kind: text({ enum: asEnumValues(AUTHORING_VALUE_KINDS) }).notNull(),
    valueText: text(),
    valueNumber: doublePrecision(),
    valueBoolean: boolean(),
    /**
     * `cascade`: a controlled value that was withdrawn takes the answers that
     * cited it with it. That is the RIGHT direction for a draft — the author is
     * asked again — and would be wrong for a published fact, which is why
     * nothing published stores an answer here.
     */
    valueEnumValueId: text().references(() => attributeEnumValues.id, { onDelete: 'cascade' }),
    canonicalRefKind: text({ enum: asEnumValues(AUTHORING_CANONICAL_REF_KINDS) }),
    /** No foreign key — see `catalog_authoring_drafts`' selection columns. */
    canonicalRefId: text(),
    /** The unit the author entered, when the attribute has a unit family. */
    unit: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('catalog_authoring_draft_values_scope_check', t.scope, PRODUCT_TYPE_FIELD_SCOPES),
    checkOneOf('catalog_authoring_draft_values_kind_check', t.kind, AUTHORING_VALUE_KINDS),
    checkOneOf(
      'catalog_authoring_draft_values_component_axis_check',
      t.componentAxis,
      ATTRIBUTE_COMPONENT_AXES,
    ),
    checkOneOf(
      'catalog_authoring_draft_values_canonical_ref_kind_check',
      t.canonicalRefKind,
      AUTHORING_CANONICAL_REF_KINDS,
    ),
    check(
      'catalog_authoring_draft_values_attribute_key_shape_check',
      sql`${t.attributeKey} ~ '^[a-z][a-z0-9_]*$'`,
    ),
    check(
      'catalog_authoring_draft_values_attribute_version_check',
      sql`${t.attributeDefinitionVersion} >= 1`,
    ),
    check('catalog_authoring_draft_values_ordinal_check', sql`${t.ordinal} >= 0`),
    /**
     * EXACTLY ONE value column, counted with `num_nonnulls` rather than stated
     * as five pairwise biconditionals.
     *
     * `num_nonnulls` is the spelling `watchlist_snapshot_items` arrived at for
     * the same problem: a per-kind biconditional set is satisfied by a row that
     * populates a column no kind claims, because every individual biconditional
     * reads false on both sides. Counting is the only form that refuses that.
     */
    check(
      'catalog_authoring_draft_values_exactly_one_value_check',
      sql`num_nonnulls(${t.valueText}, ${t.valueNumber}, ${t.valueBoolean}, ${t.valueEnumValueId}, ${t.canonicalRefId}) = 1`,
    ),
    // …and each kind names the column it uses. The count above stops a row
    // populating two; these stop it populating the WRONG one.
    check(
      'catalog_authoring_draft_values_text_kind_check',
      sql`(${t.kind} = 'text') = (${t.valueText} is not null)`,
    ),
    check(
      'catalog_authoring_draft_values_number_kind_check',
      sql`(${t.kind} = 'number') = (${t.valueNumber} is not null)`,
    ),
    check(
      'catalog_authoring_draft_values_boolean_kind_check',
      sql`(${t.kind} = 'boolean') = (${t.valueBoolean} is not null)`,
    ),
    check(
      'catalog_authoring_draft_values_controlled_kind_check',
      sql`(${t.kind} = 'controlled_value') = (${t.valueEnumValueId} is not null)`,
    ),
    check(
      'catalog_authoring_draft_values_canonical_kind_check',
      sql`(${t.kind} = 'canonical_reference') = (${t.canonicalRefId} is not null)`,
    ),
    /** A canonical reference names WHAT it points at, or it names nothing. */
    check(
      'catalog_authoring_draft_values_canonical_ref_shape_check',
      sql`(${t.canonicalRefId} is not null) = (${t.canonicalRefKind} is not null)`,
    ),
    /** A variant answer names a variant; every other scope names none. */
    check(
      'catalog_authoring_draft_values_variant_scope_check',
      sql`(${t.scope} = 'variant') = (${t.draftVariantId} is not null)`,
    ),
    /** A unit belongs to a number. Nothing else has one to be measured in. */
    check(
      'catalog_authoring_draft_values_unit_check',
      sql`${t.unit} is null or (${t.kind} = 'number' and btrim(${t.unit}) <> '')`,
    ),
    /**
     * ONE answer per (draft, variant, field, component, ordinal).
     *
     * TWO partial uniques rather than one, because Postgres treats NULLs as
     * DISTINCT: with `draft_variant_id` and `component_axis` both nullable, a
     * single index over all five columns would admit any number of rows for the
     * ordinary product-scope, non-structured answer — which is nearly every row
     * in the table.
     */
    uniqueIndex('catalog_authoring_draft_values_product_key')
      .on(t.draftId, t.fieldId, t.ordinal)
      .where(sql`${t.draftVariantId} is null and ${t.componentAxis} is null`),
    uniqueIndex('catalog_authoring_draft_values_product_component_key')
      .on(t.draftId, t.fieldId, t.componentAxis, t.ordinal)
      .where(sql`${t.draftVariantId} is null and ${t.componentAxis} is not null`),
    uniqueIndex('catalog_authoring_draft_values_variant_key')
      .on(t.draftVariantId, t.fieldId, t.ordinal)
      .where(sql`${t.draftVariantId} is not null and ${t.componentAxis} is null`),
    uniqueIndex('catalog_authoring_draft_values_variant_component_key')
      .on(t.draftVariantId, t.fieldId, t.componentAxis, t.ordinal)
      .where(sql`${t.draftVariantId} is not null and ${t.componentAxis} is not null`),
    index('catalog_authoring_draft_values_draft_idx').on(t.draftId, t.scope),
    index('catalog_authoring_draft_values_attribute_idx').on(
      t.attributeKey,
      t.attributeDefinitionVersion,
    ),
  ],
);

/**
 * `catalog_authoring_schema_invalidations` — the transactional cache register
 * (ADR 0007 D10).
 *
 * ## A revision READ INTO the key, not an event pushed at a listener
 *
 * D10 requires invalidation to be transactional rather than process-local,
 * because Mercaria runs several ECS tasks and a process-local cache is one
 * task's opinion. The mechanism is a revision per SUBJECT: a writer bumps it in
 * its own transaction, and a composition reads the revisions it depends on and
 * puts them IN the cache key.
 *
 * That is a deliberate, stated divergence from an outbox with a dispatcher, and
 * the reason is that an outbox has a DELIVERY WINDOW — between the write and the
 * dispatch, every task still serves the old entry, and nothing anywhere says so.
 * A revision in the key has no window: an entry composed under revision 4 is
 * unreachable the instant the revision is 5, in every task, because no lookup
 * can name it. The cost is one small indexed read per composition, which is
 * paid against a composition that already issues five.
 *
 * ## Why only these four subjects
 *
 * Everything else a schema composes from is FROZEN by somebody else's trigger: a
 * published `product_type_definitions` version and an active
 * `attribute_definitions` version are both immutable, so no revision could ever
 * change. What can still move under a live schema is the controlled-value set,
 * the localizations, the category, and — for a draft or in-review product type,
 * which is never memoized at all — the version itself.
 */
export const catalogAuthoringSchemaInvalidations = pgTable(
  'catalog_authoring_schema_invalidations',
  {
    id: generatedId(),
    subject: text({ enum: asEnumValues(AUTHORING_INVALIDATION_SUBJECTS) }).notNull(),
    /**
     * The row the subject is about — an attribute definition id, a category id,
     * a product type definition id, or the localized entity's id.
     *
     * No foreign key, and this one is not the merge-census reasoning: a register
     * row must OUTLIVE the thing it invalidates. A cascade would delete the
     * revision at the exact moment every task most needs to know the old entry
     * is gone.
     */
    subjectId: text().notNull(),
    /** Monotonic per subject. Never a clock — two tasks' clocks disagree. */
    revision: bigint({ mode: 'number' }).notNull().default(1),
    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (t) => [
    checkOneOf(
      'catalog_authoring_schema_invalidations_subject_check',
      t.subject,
      AUTHORING_INVALIDATION_SUBJECTS,
    ),
    check('catalog_authoring_schema_invalidations_revision_check', sql`${t.revision} >= 1`),
    check(
      'catalog_authoring_schema_invalidations_subject_id_check',
      sql`btrim(${t.subjectId}) <> ''`,
    ),
    /** The convergence key: one register row per subject, ever. */
    uniqueIndex('catalog_authoring_schema_invalidations_key').on(t.subject, t.subjectId),
  ],
);
