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
 * use: a BOUNDED snapshot kept for audit and recovery. It is frozen by
 * `mercaria_catalog_authoring_draft_pins_frozen` — the same trigger that freezes
 * the draft's identity — once the draft leaves `open`, and deliberately NOT from
 * the moment it is written: ADR 0007 D10's upgrade re-pins an OPEN draft to a
 * newer published version after the author saw a preview, which
 * `repinDraftIfVersion` is the one writer of. What must never change is the pin a
 * PUBLISHED draft records, because that row is the audit answer to "what was this
 * product authored against" — and a snapshot a later write can edit is evidence
 * of nothing. `catalog-authoring.realdb.test.ts` pins all three behaviours,
 * including the re-pin the trigger permits.
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
  CONDITION_ASSERTIONS,
  ITEM_CONDITION_KEYS,
  PRODUCT_TYPE_AUTHORING_FLOWS,
  PRODUCT_TYPE_FIELD_SCOPES,
  UNREFINED_CONDITION_ASSERTIONS,
  UNREFINED_CONDITION_KEYS,
  type ConditionAssertion,
  type AuthoringSchema,
  type ItemConditionKey,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, currencyChecks, optionalMoney } from './columns';
import { attributeDefinitions, attributeEnumValues } from './attributeRegistry';
import { categories, listings } from './catalog';
import { productTypeDefinitions, productTypeFields } from './productTypes';
import { stores } from './stores';

/**
 * The condition a publication applies when the flow does not demand one and the
 * author stated none (#572).
 *
 * Declared HERE, as data, beside the columns it fills — and not left to
 * `resolveConditionInput(input) ?? { key: 'new', … }` inside
 * `catalog-write.service.ts`, which is where it lived and where nothing named
 * it. The difference is not cosmetic: a default nobody can point at is a default
 * nobody reviews, and this one was silently asserting "factory new, declared by
 * the seller" about every item authored through the wizard.
 *
 * `new` + `seller_declared` is the same pair the write service falls back to, so
 * this changes NO behaviour for a merchant draft; `authoring-condition.test.ts`
 * pins the two against each other so they cannot drift apart later. What #572
 * changes is that a `p2p` draft may no longer reach it — `condition_missing`
 * refuses publication first.
 */
export const AUTHORING_DEFAULT_MERCHANT_CONDITION: {
  readonly key: ItemConditionKey;
  readonly assertion: ConditionAssertion;
} = Object.freeze({ key: 'new', assertion: 'seller_declared' });

/**
 * The flows that may NOT publish without the author stating a condition.
 *
 * `p2p` is a person selling their own used thing, so "factory new, declared by
 * the seller" is a claim about goods nobody made — a false statement in the
 * seller's own name, which is what makes this different from a missing optional
 * field. The other four flows describe stock, a feed or an operator acting on
 * one, where the default is ordinarily true and is applied openly.
 *
 * A tuple rather than `flow === 'p2p'` so a sixth flow forces the question
 * rather than inheriting the permissive answer by omission.
 */
export const CONDITION_REQUIRED_AUTHORING_FLOWS: readonly (typeof PRODUCT_TYPE_AUTHORING_FLOWS)[number][] =
  Object.freeze(['p2p'] as const);

/**
 * The flows whose listings are EXPECTED to carry at least one image.
 *
 * Named `EXPECTED` and not `REQUIRED`, unlike its condition sibling above, and
 * the difference is the whole decision rather than a shade of wording.
 * `media_missing` is a WARNING: it is reported in the same list, on the same
 * path, and it does not block publication.
 *
 * ## Why `p2p` is the flow
 *
 * The same reasoning the condition half carries. A `p2p` draft must state a
 * condition (#572); #90 draws the evidence for a condition claim from the
 * listing's OWN gallery, and `mercaria_reject_canonical_condition_photo`
 * refuses a `file_id` any `canonical_images` row already claims — so a p2p
 * listing with no photograph of its own has made a claim about used goods that
 * nothing it owns can support, and the catalogue's picture of the model is
 * barred from standing in. A merchant, a connector and an operator are
 * describing stock or replaying a feed against a canonical product that already
 * carries catalogue imagery, so the same absence is not the same fact.
 *
 * ## Why it is not an ERROR, which is the part to read before changing it
 *
 * Because no surface in this repository can satisfy it. `imageFileIds` holds
 * Oxy file ids and there is no upload path to Oxy's file service anywhere in
 * this monorepo — `components/catalog-authoring/ReviewPanel.tsx` and
 * `lib/authoring/wizard-state.ts` both say so, and the wizard's listing step
 * renders a static `products.wizard.listing.mediaUnavailable` notice instead of
 * a picker. An error would therefore be a gate whose cheapest green is
 * unreachable: a p2p author would be told to add a photograph by a product that
 * gives them no way to add one, with no remedy at all.
 *
 * That is the difference from `condition_missing`, which looks like the same
 * shape and is not: a condition is a value an author can simply state, so that
 * gate always has a green. This one would not.
 *
 * **It becomes an error in the diff that ships a media picker**, not before —
 * and at that point this constant is renamed to match. Recorded here rather
 * than left as a judgement somebody has to reconstruct.
 *
 * A tuple rather than `flow === 'p2p'` so a sixth flow forces the question
 * rather than inheriting the permissive answer by omission.
 */
export const MEDIA_EXPECTED_AUTHORING_FLOWS: readonly (typeof PRODUCT_TYPE_AUTHORING_FLOWS)[number][] =
  Object.freeze(['p2p'] as const);

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
     * What the author says the GOODS are like (#572, #90's taxonomy).
     *
     * ## Nullable, with NO column default, and that is the whole point
     *
     * Before #572 the draft could not express a condition at all, and
     * `createStoreProductWithin` fell through to
     * `resolveConditionInput(input) ?? {key: 'new', assertion: 'seller_declared'}`
     * — so EVERY authored listing was published as factory-new, declared in the
     * seller's name. Harmless for merchant stock and a false assertion about the
     * goods on the `p2p` flow.
     *
     * A column DEFAULT of `'new'` would move that bug rather than fix it: with
     * one, "the author said new" and "nobody answered" become the same row, and
     * `condition_missing` could not be raised for a p2p draft because there
     * would be nothing to detect. NULL means UNSTATED, which is the fact the
     * validation reads.
     *
     * ## Why the p2p rule is not a CHECK here
     *
     * `flow` is on this row, so `flow <> 'p2p' or item_condition_key is not
     * null` is expressible — and it would refuse a p2p draft at CREATION, before
     * the author has reached the question. A draft is working state and must be
     * creatable empty. The rule is therefore a PUBLICATION rule
     * (`condition_missing` in `validation.ts`), which is where `title_missing`
     * and `description_missing` already live for the same reason.
     *
     * The merchant default a publication applies is
     * `AUTHORING_DEFAULT_MERCHANT_CONDITION` below — named, exported and pinned
     * by a test, rather than falling out of a `??` inside a write service.
     */
    itemConditionKey: text({ enum: asEnumValues(ITEM_CONDITION_KEYS) }),
    /**
     * WHO says so. Paired with the key by a biconditional below.
     *
     * Stored rather than derived, even though every value an author can write is
     * `seller_declared` today: the assertion is what
     * `listings_unrefined_condition_check` reads one table over, and a draft that
     * carried a key with no statement of who asserted it would have to have one
     * invented at publication.
     */
    itemConditionAssertion: text({ enum: asEnumValues(CONDITION_ASSERTIONS) }),

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
    // Rendered from `@mercaria/shared-types`, never hand-copied: the rule the
    // type system states and the rule the database enforces are one list.
    checkOneOf(
      'catalog_authoring_drafts_item_condition_key_check',
      t.itemConditionKey,
      ITEM_CONDITION_KEYS,
    ),
    checkOneOf(
      'catalog_authoring_drafts_item_condition_assertion_check',
      t.itemConditionAssertion,
      CONDITION_ASSERTIONS,
    ),
    /**
     * A condition is a key AND who asserted it, or it is neither.
     *
     * A key with no assertion cannot be published — `conditionColumnsFor` needs
     * both — and an assertion with no key is a statement about nothing. Written
     * as ONE biconditional over the pair rather than two one-way requirements,
     * for the reason this schema records in three other places.
     */
    check(
      'catalog_authoring_drafts_item_condition_pair_check',
      sql`(${t.itemConditionKey} is null) = (${t.itemConditionAssertion} is null)`,
    ),
    /**
     * #90 MIGRATION RULE 2 at the DRAFT grain — `listings_unrefined_condition_check`,
     * one table upstream.
     *
     * An UNREFINED assertion (`migrated_binary`, `legacy_client_binary`) may only
     * carry an unrefined key (`new`, `used_good`). No authoring path writes
     * either assertion today, which is exactly why the constraint is here rather
     * than left to the service: the listing-grain CHECK would refuse such a row
     * at PUBLICATION, naming a constraint on a table the author never touched,
     * after the draft had been accepted for days. Refusing it at the draft is the
     * same rule where somebody can act on it.
     */
    check(
      'catalog_authoring_drafts_unrefined_condition_check',
      sql`${t.itemConditionAssertion} is null
          or ${t.itemConditionAssertion} not in (${sql.raw(
            UNREFINED_CONDITION_ASSERTIONS.map((assertion) => `'${assertion}'`).join(', '),
          )})
          or ${t.itemConditionKey} in (${sql.raw(
            UNREFINED_CONDITION_KEYS.map((key) => `'${key}'`).join(', '),
          )})`,
    ),
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
