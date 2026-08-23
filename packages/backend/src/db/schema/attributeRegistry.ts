/**
 * The versioned category-attribute registry (#94) — `attribute_definitions` and
 * its six satellites.
 *
 * #56 landed the first cut of this registry inside `canonicalCatalog.ts`,
 * because the only thing that needed it was a variant axis. #94 makes it the
 * substrate deterministic search runs on, and that changes the shape in one
 * structural way: **a definition is now a VERSION**. `(key, version)` is the
 * identity, a partial unique keeps exactly one version ACTIVE per key, and a
 * trigger freezes every semantic column the moment a version leaves `draft` —
 * the `fee_schedules` mechanism, applied to catalogue policy for the same
 * reason. A stored attribute value cites the version it was normalized under, so
 * changing what an attribute MEANS can never silently reinterpret facts recorded
 * under the old meaning; it schedules a re-normalization instead.
 *
 * The two tables `canonicalCatalog.ts` used to own (`attribute_definitions`,
 * `attribute_definition_categories`) MOVED here rather than being copied. #94
 * owns the registry; the canonical catalogue cites it. A second registry beside
 * the first is the outcome this file exists to prevent.
 *
 * ## What this layer structurally cannot hold
 *
 * - **No offer fact.** `attribute_definitions_reserved_key_check` refuses a
 *   definition whose key names a price, a stock level, a shipping cost or a
 *   condition. Those belong to a current eligible OFFER (#57) and are answered
 *   through the offer port, never from a static product attribute
 *   (#94 hard-constraint rule 6). Without this CHECK a source could assert
 *   `price` as a specification and a shopper's price filter would find it.
 * - **No source ranking or tie-break weight.** Two comparably attested,
 *   contradictory facts stay contradictory. There is no column that could say
 *   "prefer this feed", because the cost of preferring wrongly is a product page
 *   asserting a specification nobody published.
 * - **No `is_valid` boolean beside `lifecycle_state`,** and no `ready` flag
 *   anywhere — the `provider_accounts` one-stored-verdict rule.
 * - **No jsonb.** Enum values, aliases, labels, category scopes and validation
 *   rules are all real columns or child tables.
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
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import {
  ATTRIBUTE_CARDINALITIES,
  ATTRIBUTE_COMPONENT_AXES,
  ATTRIBUTE_DISPLAY_POLICIES,
  ATTRIBUTE_ENTITY_KINDS,
  ATTRIBUTE_EVIDENCE_POLICIES,
  ATTRIBUTE_LIFECYCLE_STATES,
  ATTRIBUTE_OBJECTIVITIES,
  ATTRIBUTE_REINDEX_REASONS,
  ATTRIBUTE_REVIEW_REASONS,
  ATTRIBUTE_REVIEW_STATES,
  ATTRIBUTE_VALUE_TYPES,
  RESERVED_OFFER_FACT_KEYS,
  UNIT_FAMILIES,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf, currencyChecks, CURRENCY_CODE_VALUES } from './columns';
import {
  localizationSettlementColumns,
  localizationTextChecks,
} from './localizationFamily';
import { categories } from './catalog';
import { catalogSources } from './provenance';

/**
 * `attribute_definitions` — one VERSION of one attribute's meaning.
 *
 * `key` is the stable machine name every stored value cites and is never
 * renamed: a rename would silently re-point every value recorded under it, so a
 * rename is a NEW key plus a migration of the values that use it. `label` and
 * `description` are free to change at any time and are deliberately NOT part of
 * anything a value stores — that is the whole of "stored keys remain stable when
 * labels or descriptions change" (#94 registry rule, closing sentence).
 *
 * ## The CHECKs, and what each one makes unrepresentable
 *
 * Every pairing below is a biconditional rather than a one-way requirement,
 * because a half-declared definition is the shape that produces a value nobody
 * can interpret:
 *
 * - a `measurement` (and a `structured` value, whose components are magnitudes
 *   on named axes) has a unit family and nothing else may carry one, so a
 *   `string` attribute cannot claim a normalization it has no way to perform;
 * - a unit family travels with its base unit, so normalization always has
 *   somewhere to put the result;
 * - `rating_scale_max` is present exactly for the `rating` family, because a
 *   4.5 out of 5 and a 4.5 out of 10 are different facts and a scale-less rating
 *   is neither;
 * - a `money` attribute names exactly one currency, the `fee_schedules` rule —
 *   an amount whose currency lives in a label is a generic decimal wearing a
 *   currency's clothes (#94 normalization rule 9);
 * - `structured` is the only type that may declare component axes, and it must;
 * - only an `objective` attribute may be `hard_constraint_capable`, which is
 *   what stops an editorial opinion from being able to EXCLUDE a product.
 *
 * `hard_constraint_capable ⇒ filterable` is one of them: a requirement that
 * excludes but cannot be offered as a filter is a rule with no way for a shopper
 * to see it, which #94's explanation requirements rule out. `searchable ⇒
 * display_policy = 'public'` is the other, and it is the same shape one surface
 * over — see its own comment for why an interpretation is a public DTO.
 *
 * ## The capability family
 *
 * {@link ATTRIBUTE_DEFINITION_CAPABILITY_COLUMNS} names what may be DONE with an
 * attribute, as against what its values mean. Every member is frozen with the
 * version, every member has a reader that is named beside it, and the ones that
 * IMPLY each other say so as CHECKs rather than as prose — the two above are the
 * whole set, and the two that are conspicuously missing (`filterable ⇒ public`,
 * `comparable ⇒ public`) are missing for a stated reason rather than by
 * oversight.
 */
export const attributeDefinitions = pgTable(
  'attribute_definitions',
  {
    id: generatedId(),
    /** Stable machine key — lowercase, snake_case, never renamed. */
    key: text().notNull(),
    /** Monotonic per key, assigned by the operator drafting the version. */
    version: integer().notNull().default(1),
    lifecycleState: text({ enum: asEnumValues(ATTRIBUTE_LIFECYCLE_STATES) })
      .notNull()
      .default('draft'),
    /** The default-locale label. Localized ones live in `attribute_labels`. */
    label: text().notNull(),
    description: text(),
    valueType: text({ enum: asEnumValues(ATTRIBUTE_VALUE_TYPES) }).notNull(),
    cardinality: text({ enum: asEnumValues(ATTRIBUTE_CARDINALITIES) }).notNull().default('single'),
    objectivity: text({ enum: asEnumValues(ATTRIBUTE_OBJECTIVITIES) })
      .notNull()
      .default('objective'),
    /**
     * Set exactly when `value_type` is `measurement` OR `structured`. A
     * structured value's components are magnitudes on named axes — a dimensions
     * attribute measures length three times — so it needs the same base unit
     * every one of them normalizes into.
     */
    unitFamily: text({ enum: asEnumValues(UNIT_FAMILIES) }),
    /** The unit normalized magnitudes are stored in. Travels with `unit_family`. */
    baseUnit: text(),
    /** Set exactly when `unit_family` is `rating` — a 5-star scale is not a 10-point one. */
    ratingScaleMax: integer(),
    /** Set exactly when `value_type` is `money`. A money attribute names ONE currency. */
    currency: text({ enum: CURRENCY_CODE_VALUES }),
    /** The axes a `structured` value carries, in order. Empty for every other type. */
    componentAxes: text().array().notNull().default(sql`'{}'::text[]`),
    /** Validation and precision rules (#94 registry rule 10). */
    minValue: doublePrecision(),
    maxValue: doublePrecision(),
    decimalPlaces: integer(),
    maxLength: integer(),
    /** The scale-error detector's bounds. See the DTO's doc comment for why they are not min/max. */
    implausibleAbove: doublePrecision(),
    implausibleBelow: doublePrecision(),
    variantDefining: boolean().notNull().default(false),
    filterable: boolean().notNull().default(true),
    sortable: boolean().notNull().default(false),
    comparable: boolean().notNull().default(true),
    /**
     * Whether a shopper's own WORDS may resolve to this attribute (#367 line
     * 277).
     *
     * Distinct from `filterable`, which decides whether the rail OFFERS it as a
     * facet somebody picks from. This decides whether the natural-language
     * interpreter may recognise its label, its localized labels and its
     * controlled-value spellings in free text at all — so an attribute can be
     * one without the other: a facet nobody would ever type, or a term that is
     * understood and applied as a PREFERENCE where no facet exists.
     *
     * Default `true`, matching `filterable`: the registry's posture is that an
     * attribute is usable and an operator NARROWS it.
     */
    searchable: boolean().notNull().default(true),
    hardConstraintCapable: boolean().notNull().default(false),
    displayPolicy: text({ enum: asEnumValues(ATTRIBUTE_DISPLAY_POLICIES) })
      .notNull()
      .default('public'),
    evidencePolicy: text({ enum: asEnumValues(ATTRIBUTE_EVIDENCE_POLICIES) })
      .notNull()
      .default('source_required'),
    /** The operator who drafted it — an Oxy account id, no foreign key. */
    createdByOxyUserId: text(),
    /** The operator who published it — the audit half of "publish a new version". */
    publishedByOxyUserId: text(),
    publishedAt: timestamptz(),
    deprecatedAt: timestamptz(),
    /**
     * The definition to use INSTEAD of this one (#367 line 237).
     *
     * ## Forward, where the rest of the schema points backward
     *
     * `product_identifiers.supersedes_identifier_id` and its dozen siblings run
     * BACKWARDS — the successor names its predecessor, so the pointer always
     * resolves. This one runs FORWARD, and it has to: "use X instead" is read by
     * somebody standing on the DEPRECATED row, and a backward pointer answers
     * that only by scanning the table for whoever names them.
     *
     * It still carries a real foreign key, which the other forward pointer in
     * this schema deliberately does not. `merchant_demand_snapshots.superseded_by_id`
     * has none because a partial unique forces the outgoing row to be stamped
     * before its replacement exists, so "a real foreign key would refuse exactly
     * that statement". No such ordering applies here: a replacement definition is
     * drafted and published BEFORE the old one is deprecated, so the successor is
     * already there to point at. Copying the no-FK shape would import a
     * workaround for a problem this table does not have.
     *
     * ## Same-key replacement is NOT what this is for
     *
     * `(key, version)` already expresses that: version N+1 replaces N. What
     * nothing could say before is CROSS-KEY — "use `display_diagonal` instead of
     * `screen_size`" — because version ordering says nothing between two keys.
     *
     * ## ONE HOP. It is not chased, and that is deliberate
     *
     * The pointer records what an operator decided at one moment. If `a -> b` and
     * later `b -> c`, nobody ever decided "use c instead of a", and a reader told
     * so is handed an inference wearing a record's clothes. Chasing also admits a
     * cycle, which one hop cannot. The merge chain DOES chase
     * (`resolveProductRow`, bounded at `MAX_MERGE_HOPS`) because a merge asserts
     * IDENTITY — a *is* b, so following it is the same fact. A replacement asserts
     * ADVICE, and advice does not compose. A consumer that wants the terminal
     * replacement walks it itself and bounds the walk.
     */
    replacedByDefinitionId: text().references((): AnyPgColumn => attributeDefinitions.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('attribute_definitions_lifecycle_check', t.lifecycleState, ATTRIBUTE_LIFECYCLE_STATES),
    checkOneOf('attribute_definitions_value_type_check', t.valueType, ATTRIBUTE_VALUE_TYPES),
    checkOneOf('attribute_definitions_cardinality_check', t.cardinality, ATTRIBUTE_CARDINALITIES),
    checkOneOf('attribute_definitions_objectivity_check', t.objectivity, ATTRIBUTE_OBJECTIVITIES),
    checkOneOf('attribute_definitions_unit_family_check', t.unitFamily, UNIT_FAMILIES),
    checkOneOf('attribute_definitions_display_policy_check', t.displayPolicy, ATTRIBUTE_DISPLAY_POLICIES),
    checkOneOf('attribute_definitions_evidence_policy_check', t.evidencePolicy, ATTRIBUTE_EVIDENCE_POLICIES),
    ...currencyChecks('attribute_definitions', [t.currency]),
    check('attribute_definitions_key_shape_check', sql`${t.key} ~ '^[a-z][a-z0-9_]*$'`),
    // A definition cannot replace itself. The `<> id` shape every supersession
    // pointer in this schema carries.
    check(
      'attribute_definitions_replaced_by_self_check',
      sql`${t.replacedByDefinitionId} is null or ${t.replacedByDefinitionId} <> ${t.id}`,
    ),
    // Only a definition that is OUT of service may name a replacement, so the
    // pointer can never become a second way of saying "deprecated" beside
    // `lifecycle_state`. ONE-WAY rather than a biconditional, deliberately: a
    // version may be deprecated with no successor at all — "we stopped using
    // this" is a complete decision — and demanding one would make an honest
    // deprecation unrepresentable.
    check(
      'attribute_definitions_replaced_by_lifecycle_check',
      sql`${t.replacedByDefinitionId} is null
          or ${t.lifecycleState} in ('deprecated', 'retired')`,
    ),
    check('attribute_definitions_version_check', sql`${t.version} >= 1`),
    // An offer fact is not a product attribute. See the file header.
    check(
      'attribute_definitions_reserved_key_check',
      sql`${t.key} <> all (${sql.raw(`array[${RESERVED_OFFER_FACT_KEYS.map((k) => `'${k}'`).join(', ')}]::text[]`)})`,
    ),
    check(
      'attribute_definitions_measurement_unit_check',
      sql`(${t.valueType} in ('measurement', 'structured')) = (${t.unitFamily} is not null)`,
    ),
    check(
      'attribute_definitions_base_unit_check',
      sql`(${t.unitFamily} is null) = (${t.baseUnit} is null)`,
    ),
    check(
      'attribute_definitions_rating_scale_check',
      sql`(${t.unitFamily} is not distinct from 'rating') = (${t.ratingScaleMax} is not null)`,
    ),
    check(
      'attribute_definitions_money_currency_check',
      sql`(${t.valueType} = 'money') = (${t.currency} is not null)`,
    ),
    check(
      'attribute_definitions_component_axes_check',
      sql`(${t.valueType} = 'structured') = (array_length(${t.componentAxes}, 1) is not null)`,
    ),
    // Element-wise shape on a text[] cannot use `unnest` (a CHECK admits no
    // subquery), so containment is the only expressible form — the
    // `commerce_relationships.territories` precedent, one table over.
    check(
      'attribute_definitions_axes_domain_check',
      sql`${t.componentAxes} <@ ${sql.raw(`array[${ATTRIBUTE_COMPONENT_AXES.map((a) => `'${a}'`).join(', ')}]::text[]`)}`,
    ),
    check(
      'attribute_definitions_bounds_order_check',
      sql`${t.minValue} is null or ${t.maxValue} is null or ${t.minValue} <= ${t.maxValue}`,
    ),
    check(
      'attribute_definitions_plausible_order_check',
      sql`${t.implausibleBelow} is null or ${t.implausibleAbove} is null or ${t.implausibleBelow} <= ${t.implausibleAbove}`,
    ),
    check(
      'attribute_definitions_decimal_places_check',
      sql`${t.decimalPlaces} is null or (${t.decimalPlaces} >= 0 and ${t.decimalPlaces} <= 12)`,
    ),
    check(
      'attribute_definitions_max_length_check',
      sql`${t.maxLength} is null or (${t.maxLength} >= 1 and ${t.maxLength} <= 4096)`,
    ),
    // An opinion may not exclude a product, and a rule nobody can see as a
    // filter may not exclude one either.
    check(
      'attribute_definitions_hard_constraint_check',
      sql`${t.hardConstraintCapable} is false or (${t.objectivity} = 'objective' and ${t.filterable})`,
    ),
    // An `operator_only` attribute's values never reach a public DTO, and an
    // interpretation IS one: the deterministic interpreter echoes the matched
    // attribute's LABEL and its controlled value's LABEL back to the shopper in
    // the explanation it attaches to every requirement it raises. So recognising
    // a term for such an attribute publishes exactly what `display_policy`
    // withheld.
    //
    // Added VALIDATED, and provably so: `0141` backfills `searchable` from
    // `display_policy` in the statement before this one, so no stored row can
    // violate it. The two SIBLING implications — `filterable ⇒ public` and
    // `comparable ⇒ public` — are deliberately NOT stated here, because those
    // columns already hold values this branch cannot prove and rewriting them
    // would edit the frozen meaning of a published version. They are enforced at
    // the READ instead (`facets/metadata.ts`, `comparison.service.ts`), and what
    // is owed is a count of the rows that would fail, then the two checks — the
    // `attribute_labels` locale decision one table over, for the same reason.
    check(
      'attribute_definitions_searchable_display_check',
      sql`${t.searchable} is false or ${t.displayPolicy} = 'public'`,
    ),
    // A published version records who published it and when; a draft records
    // neither. The `fee_schedules` activation-audit shape.
    check(
      'attribute_definitions_published_audit_check',
      sql`(${t.lifecycleState} = 'draft') = (${t.publishedAt} is null)`,
    ),
    check(
      'attribute_definitions_deprecated_at_check',
      sql`${t.deprecatedAt} is null or ${t.lifecycleState} in ('deprecated', 'retired')`,
    ),
    uniqueIndex('attribute_definitions_key_version_key').on(t.key, t.version),
    // Exactly one live meaning per key. The `fee_schedules_one_active_per_key`
    // mechanism: "the active version of this attribute" is a single row rather
    // than a query with a bug in it.
    uniqueIndex('attribute_definitions_one_active_per_key')
      .on(t.key)
      .where(sql`${t.lifecycleState} = 'active'`),
    index('attribute_definitions_lifecycle_idx').on(t.lifecycleState, t.key),
  ],
);

/**
 * The capability columns of `attribute_definitions` — what may be DONE with an
 * attribute, as opposed to what its values MEAN (#367 line 277).
 *
 * Six of epic #367's seven capabilities live here. The seventh,
 * variant-capability, is deliberately absent and is NOT a column on this table:
 * whether an attribute can distinguish two variants is a property of the
 * attribute WITHIN a product type — colour varies a shirt and an ISBN varies
 * nothing — so it is `product_type_fields.variant_capable` (ADR 0007 D6), one
 * grain down. {@link attributeDefinitions.variantDefining} is the registry's own
 * default for an attribute the product type does not mention, which is a
 * different fact from the binding and is why both exist. A `variant_capable`
 * column here would be a second representation of the binding, and two
 * representations of one fact can disagree.
 *
 * `display_policy` is this list's odd member and belongs in it: it IS #367's
 * "displayable", spelled as a two-value closed set rather than a boolean
 * because `operator_only` names WHO may see the value rather than merely
 * withholding it.
 *
 * The list has one consumer — `attribute-registry.realdb.test.ts`, which drives
 * an UPDATE of every member against a published version and asserts the freeze
 * trigger refuses it. A capability that can be flipped on a live version is a
 * capability whose version stamp means nothing, and the trigger's column list
 * is hand-maintained SQL that no compiler reads. A member added here without
 * being added there turns that test red.
 */
export const ATTRIBUTE_DEFINITION_CAPABILITY_COLUMNS = [
  'variantDefining',
  'filterable',
  'sortable',
  'comparable',
  'searchable',
  'hardConstraintCapable',
  'displayPolicy',
] as const;

/** One of {@link ATTRIBUTE_DEFINITION_CAPABILITY_COLUMNS}. */
export type AttributeDefinitionCapabilityColumn =
  (typeof ATTRIBUTE_DEFINITION_CAPABILITY_COLUMNS)[number];

/**
 * `attribute_labels` — localized labels for a definition version
 * (#94 registry rule 2).
 *
 * A child table rather than a jsonb map: the locale set is open, the rows are
 * read by locale, and a map would make "which locales does this attribute have"
 * a scan of every definition. Cascade, because a label is meaningless without
 * the version it labels.
 *
 * Nothing a VALUE stores comes from here. That is the mechanical reason a label
 * change is free: there is no write path from this table to a stored value.
 */
export const attributeLabels = pgTable(
  'attribute_labels',
  {
    id: generatedId(),
    attributeDefinitionId: text()
      .notNull()
      .references(() => attributeDefinitions.id, { onDelete: 'cascade' }),
    /**
     * BCP-47 tag, stored lower-case so a lookup cannot miss on case.
     *
     * Plain `text` with a SHAPE check, and NOT `text({ enum: LOCALE_VALUES })`
     * like the rest of the family. This column predates ADR 0007 D4 and already
     * holds production data, so narrowing it to `SUPPORTED_LOCALES` is a
     * separate, data-dependent change — see the note on the checks below. A
     * narrowed TypeScript type over a column the database does not narrow would
     * be a type that lies.
     */
    locale: text().notNull(),
    label: text().notNull(),
    description: text(),
    ...localizationSettlementColumns(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'attribute_labels_locale_shape_check',
      sql`${t.locale} = lower(btrim(${t.locale})) and ${t.locale} ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$'`,
    ),
    // The family's TEXT half only.
    //
    // `localizationLocaleChecks` is deliberately NOT applied. It narrows
    // `locale` to `SUPPORTED_LOCALES` and away from the base locale, and a
    // narrowing CHECK is validated against every existing row the moment it is
    // added — so on a table that already holds production data it can ABORT the
    // deploy on rows nobody has looked at. That is not hypothetical: the same
    // shape was measured on #632, where redefining a generated expression
    // aborted an index rebuild.
    //
    // Deferring it costs little and the two reasons are worth stating.
    // `ALL_REPORTABLE_LOCALES` excludes the base locale, so a stray `en` row
    // here cannot inflate a completeness figure; and the coverage read joins on
    // an explicit locale list, so a tag outside `SUPPORTED_LOCALES` is invisible
    // to it rather than miscounted. What is owed is a count of the rows that
    // would fail, then the two checks — one query, in the PR that adds them.
    ...localizationTextChecks('attribute_labels', { ...t, primaryText: t.label }),
    uniqueIndex('attribute_labels_locale_key').on(t.attributeDefinitionId, t.locale),
  ],
);

/**
 * `attribute_definition_categories` — the category SCOPE of a definition
 * version, with its inheritance rule (#94 registry rule 4).
 *
 * A junction table rather than a `category_id[]` column, per CONVENTIONS: an
 * array of ids cannot be joined or constrained, and this one is read both ways
 * (which attributes apply to this category; which categories does this attribute
 * cover). NO rows means the definition is UNSCOPED and applies anywhere — the
 * opposite reading from a procurement agreement's empty scope, because a scope
 * NARROWS something otherwise general while a grant that names no destination
 * grants none.
 *
 * `include_descendants` is per SCOPE rather than per definition, which is the
 * whole of the "inheritance rules" requirement. One global policy would have to
 * be wrong for either "screen size, everywhere under Electronics" or "shoe
 * width, in Shoes and not in Shoe care".
 */
export const attributeDefinitionCategories = pgTable(
  'attribute_definition_categories',
  {
    id: generatedId(),
    attributeDefinitionId: text()
      .notNull()
      .references(() => attributeDefinitions.id, { onDelete: 'cascade' }),
    /** `restrict`: nothing deletes a category today, and a scope may not be orphaned. */
    categoryId: text()
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    /** Whether the scope reaches this category's subtree. See the doc above. */
    includeDescendants: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('attribute_definition_categories_key').on(t.attributeDefinitionId, t.categoryId),
    index('attribute_definition_categories_category_idx').on(t.categoryId),
  ],
);

/**
 * `attribute_enum_values` — the permitted values of an `enum` definition version
 * (#94 registry rule 6).
 *
 * Rows rather than #56's `allowed_values text[]`, and the array column is gone
 * rather than kept beside them: an alias has to resolve to exactly one canonical
 * value, which needs a row to point at. Keeping both would be two
 * representations of the permitted set, and the one an alias resolved against
 * would be whichever the writer remembered to update.
 *
 * `value` is stored already normalized (lower-cased, whitespace-collapsed) and a
 * CHECK enforces it, so a case-variant spelling cannot dodge the unique — the
 * `merchant_domains.domain` device.
 */
export const attributeEnumValues = pgTable(
  'attribute_enum_values',
  {
    id: generatedId(),
    attributeDefinitionId: text()
      .notNull()
      .references(() => attributeDefinitions.id, { onDelete: 'cascade' }),
    /** The canonical, normalized value stored on every assignment. */
    value: text().notNull(),
    /** What a shopper reads. Changing it never moves a stored value. */
    label: text().notNull(),
    position: integer().notNull().default(0),
    /**
     * The value of a PREVIOUS version that this one replaces — "use this instead
     * of `gray`" (#367 line 280).
     *
     * ## Why this points BACKWARD where `attribute_definitions` points forward
     *
     * #367 line 237 put a FORWARD pointer on `attribute_definitions`, because
     * there the successor is published before the predecessor is deprecated, so
     * the deprecated row could still be written. **Neither is true here**, and
     * the asymmetry is forced rather than chosen:
     *
     * `mercaria_attribute_enum_frozen` refuses INSERT, UPDATE *and* DELETE on
     * this table for any definition that has left `draft`. A retired value's row
     * belongs to a published version, so it can never be written again — a
     * forward pointer would need that freeze weakened, and the freeze is what
     * keeps a published version's value vocabulary immutable.
     *
     * The successor, by contrast, is being drafted when the redirect is known:
     * retiring a value means drafting version N+1 that carries everything except
     * it, and the row naming what it replaces is inserted in that same draft.
     * So this is the classic case the house idiom was built for —
     * `product_identifiers.supersedes_identifier_id`'s *"the successor names its
     * predecessor, so it always resolves"* — and pointing forward here would
     * cost a trigger change to buy a worse write ordering.
     *
     * ## ONE HOP, and it is not chased
     *
     * `attribute_definitions.replaced_by_definition_id` states the reasoning in
     * full and it holds unchanged: a replacement records what an operator
     * decided at one moment, and if `a` was replaced by `b` and `b` later by
     * `c`, nobody decided that `c` replaces `a`. A consumer wanting the terminal
     * value walks the chain itself and bounds the walk.
     *
     * ## What it does NOT do
     *
     * It does not move stored assignments. Those cite the version they were
     * recorded under and keep resolving through `resolveDefinitionVersion`,
     * which is the whole reason the `restrict` below exists.
     */
    replacesEnumValueId: text().references((): AnyPgColumn => attributeEnumValues.id, {
      onDelete: 'restrict',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'attribute_enum_values_normalized_check',
      sql`${t.value} = lower(btrim(${t.value})) and ${t.value} <> ''`,
    ),
    uniqueIndex('attribute_enum_values_value_key').on(t.attributeDefinitionId, t.value),
    // A value cannot replace itself — the `<> id` shape every supersession
    // pointer in this schema carries.
    check(
      'attribute_enum_values_replaces_self_check',
      sql`${t.replacesEnumValueId} is null or ${t.replacesEnumValueId} <> ${t.id}`,
    ),
    // At most ONE successor per retired value: "use X instead" has to be
    // unambiguous, and two rows claiming to replace `gray` is a question with no
    // answer. PARTIAL with the predicate spelled out rather than relying on
    // Postgres treating NULLs as distinct — the behaviour is the same and the
    // intent is not readable from the plain form.
    uniqueIndex('attribute_enum_values_replaces_key')
      .on(t.replacesEnumValueId)
      .where(sql`${t.replacesEnumValueId} is not null`),
    index('attribute_enum_values_position_idx').on(t.attributeDefinitionId, t.position),
    /**
     * The target of `product_type_field_allowed_values`' composite foreign key
     * (#367 W7, epic line 235).
     *
     * `unique()` and NOT `uniqueIndex()`: a foreign key may only reference a
     * unique CONSTRAINT or a primary key, and `uniqueIndex` emits an index,
     * which Postgres refuses as an FK target.
     *
     * It can never fail to apply. `id` is the primary key, so `(attribute_
     * definition_id, id)` is unique by construction for every row that exists or
     * could exist — no scan, no duplicate risk, no backfill. It adds no NEW
     * invariant; it exists so a subset's composite key can pin the value and its
     * owning definition together.
     */
    unique('attribute_enum_values_definition_id_key').on(t.attributeDefinitionId, t.id),
  ],
);

/**
 * `attribute_value_aliases` — source spellings that resolve to one canonical
 * enum value (#94 registry rule 6, normalization rule 4).
 *
 * `UNIQUE(attribute_definition_id, normalized_alias)` is the load-bearing
 * constraint: one alias resolves to at most ONE canonical value per definition,
 * the ADR 0002 D16 rule that an alias never resolves to two entities. Without it
 * "USB C" could map to both `usb_c` and `usb_c_thunderbolt` and the answer would
 * depend on row order.
 *
 * `normalized_alias` is GENERATED from `alias` (`lower(btrim(...))`, both
 * IMMUTABLE), the `<entity>_aliases` device, so the stored spelling and the
 * lookup key cannot disagree. The SOURCE text is kept in `alias` — normalizing
 * an enum alias never destroys what a source actually wrote (#94 normalization
 * rule 4).
 */
export const attributeValueAliases = pgTable(
  'attribute_value_aliases',
  {
    id: generatedId(),
    attributeDefinitionId: text()
      .notNull()
      .references(() => attributeDefinitions.id, { onDelete: 'cascade' }),
    enumValueId: text()
      .notNull()
      .references(() => attributeEnumValues.id, { onDelete: 'cascade' }),
    /** The source's own spelling, verbatim. */
    alias: text().notNull(),
    normalizedAlias: text()
      .notNull()
      .generatedAlwaysAs(sql`lower(btrim("alias"))`),
    /** Which source this spelling was seen from, when it came from one. */
    catalogSourceId: text().references(() => catalogSources.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('attribute_value_aliases_alias_key').on(t.attributeDefinitionId, t.normalizedAlias),
    index('attribute_value_aliases_enum_value_idx').on(t.enumValueId),
  ],
);

/**
 * `attribute_source_mappings` — how one source's field names map onto the
 * registry (#94 coverage rule 4).
 *
 * The recorded answer to "does `16 GB` mean memory or storage": this source's
 * `memory_size` field is `ram_capacity`, and its values are in GB when it omits
 * the unit. That `assumed_unit` column is the ONLY place a unit may come from
 * when a source reports a bare number — never from the value, never from the
 * attribute's base unit, never from what a similar feed usually means. It is a
 * human-recorded fact about the FEED, which is exactly what "never infer a unit
 * from a number when the source is genuinely ambiguous" requires.
 *
 * `category_ids` narrows a mapping when one source reuses a field name across
 * categories. Empty means every category the attribute itself is scoped to,
 * which is the common case and the honest default.
 */
export const attributeSourceMappings = pgTable(
  'attribute_source_mappings',
  {
    id: generatedId(),
    catalogSourceId: text()
      .notNull()
      .references(() => catalogSources.id, { onDelete: 'restrict' }),
    /** The field name as the source spells it, stored folded for lookup. */
    sourceField: text().notNull(),
    /** The registry key it maps to. A NAME, not an id: the version is resolved at read. */
    attributeKey: text().notNull(),
    /** The unit this source's values carry when it omits one. See the doc above. */
    assumedUnit: text(),
    /** The component axis this field always carries, for a `structured` attribute. */
    componentAxis: text({ enum: asEnumValues(ATTRIBUTE_COMPONENT_AXES) }),
    categoryIds: text().array().notNull().default(sql`'{}'::text[]`),
    note: text(),
    createdByOxyUserId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf(
      'attribute_source_mappings_axis_check',
      t.componentAxis,
      ATTRIBUTE_COMPONENT_AXES,
    ),
    check(
      'attribute_source_mappings_field_shape_check',
      sql`${t.sourceField} = lower(btrim(${t.sourceField})) and ${t.sourceField} <> ''`,
    ),
    check(
      'attribute_source_mappings_key_shape_check',
      sql`${t.attributeKey} ~ '^[a-z][a-z0-9_]*$'`,
    ),
    uniqueIndex('attribute_source_mappings_field_key').on(t.catalogSourceId, t.sourceField),
    index('attribute_source_mappings_attribute_idx').on(t.attributeKey),
  ],
);

/**
 * `attribute_value_reviews` — the queue for values a person has to settle
 * (#94 coverage rules 2 and 5).
 *
 * One OPEN row per (entity, attribute), held by a partial unique on a GENERATED
 * key rather than by a service read-then-write: two ingestion workers observing
 * the same conflict a millisecond apart would otherwise open two rows, and the
 * reviewer would resolve one of them.
 *
 * `priority` is a stored integer rather than a derived rank because "high-impact"
 * is a product judgement (how many offers hang off this variant, whether the
 * attribute is hard-constraint-capable) computed when the row is opened, and
 * re-deriving it later against a changed catalogue would silently reorder a queue
 * somebody is working through.
 */
export const attributeValueReviews = pgTable(
  'attribute_value_reviews',
  {
    id: generatedId(),
    entityKind: text({ enum: asEnumValues(ATTRIBUTE_ENTITY_KINDS) }).notNull(),
    /**
     * The canonical product or variant. No foreign key: one polymorphic column
     * cannot reference two tables, and the alternative (two nullable columns
     * plus a CHECK) buys a constraint on rows whose targets are never
     * hard-deleted — the `merchant_claim_scopes.scope_ref` reasoning.
     */
    entityId: text().notNull(),
    attributeKey: text().notNull(),
    definitionVersion: integer().notNull(),
    reason: text({ enum: asEnumValues(ATTRIBUTE_REVIEW_REASONS) }).notNull(),
    state: text({ enum: asEnumValues(ATTRIBUTE_REVIEW_STATES) }).notNull().default('open'),
    /** Higher is more urgent. Frozen at open time; see the doc above. */
    priority: integer().notNull().default(0),
    /** One line naming what disagrees, for a reviewer scanning the queue. */
    summary: text().notNull(),
    /** The value an operator chose, when the resolution was a choice. */
    resolvedValueId: text(),
    resolvedByOxyUserId: text(),
    resolvedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('attribute_value_reviews_entity_kind_check', t.entityKind, ATTRIBUTE_ENTITY_KINDS),
    checkOneOf('attribute_value_reviews_reason_check', t.reason, ATTRIBUTE_REVIEW_REASONS),
    checkOneOf('attribute_value_reviews_state_check', t.state, ATTRIBUTE_REVIEW_STATES),
    // A closed review names who closed it and when; an open one names neither.
    // An anonymous resolution is unrepresentable, the `merchant_claims`
    // rejected-state rule.
    check(
      'attribute_value_reviews_resolution_check',
      sql`(${t.state} = 'open') = (${t.resolvedAt} is null and ${t.resolvedByOxyUserId} is null)`,
    ),
    check('attribute_value_reviews_priority_check', sql`${t.priority} >= 0`),
    uniqueIndex('attribute_value_reviews_open_key')
      .on(t.entityKind, t.entityId, t.attributeKey)
      .where(sql`${t.state} = 'open'`),
    index('attribute_value_reviews_queue_idx').on(t.state, t.priority.desc(), t.createdAt),
    index('attribute_value_reviews_attribute_idx').on(t.attributeKey, t.state),
  ],
);

/**
 * `attribute_reindex_requests` — what has to be re-indexed, and why
 * (#94 coverage rule 8).
 *
 * The moderation-outbox shape: the ROW is the job, its id is DETERMINISTIC so a
 * repeat converges with `ON CONFLICT DO NOTHING`, and a claim is a LEASE — an
 * owner and a deadline, in three columns held all-or-nothing by
 * `attribute_reindex_requests_claim_check`. The lease SHAPE is what exists; the
 * owner CHECK `moderation_outboxes` performs inside its claim query has no
 * counterpart here, because nothing claims yet (#551).
 * It is written here and DRAINED by whoever owns the index — #61
 * decides what that index is, and until it does, this table accumulates the
 * durable record. Gate the loop, never the record: a request written today is
 * still correct when a consumer appears.
 *
 * A definition change enqueues one row per affected ENTITY rather than one row
 * naming the definition, because the consumer's unit of work is a document, and
 * a single "everything with key X changed" row would have to be expanded by
 * whoever drained it — at which point the expansion is unbounded work inside a
 * lease.
 */
export const attributeReindexRequests = pgTable(
  'attribute_reindex_requests',
  {
    /** Deterministic: `<entityKind>:<entityId>:<attributeKey>:<reason>`. No default. */
    id: text().primaryKey(),
    entityKind: text({ enum: asEnumValues(ATTRIBUTE_ENTITY_KINDS) }).notNull(),
    /** No foreign key, for the `attribute_value_reviews.entity_id` reason. */
    entityId: text().notNull(),
    /** The attribute whose change caused this, when one did. */
    attributeKey: text(),
    definitionVersion: integer(),
    reason: text({ enum: asEnumValues(ATTRIBUTE_REINDEX_REASONS) }).notNull(),
    enqueuedAt: timestamptz().notNull(),
    /** Lease columns — the `moderation_outboxes` claim shape. */
    claimedAt: timestamptz(),
    claimedBy: text(),
    claimExpiresAt: timestamptz(),
    processedAt: timestamptz(),
    attempts: integer().notNull().default(0),
    lastError: text(),
  },
  (t) => [
    checkOneOf('attribute_reindex_requests_entity_kind_check', t.entityKind, ATTRIBUTE_ENTITY_KINDS),
    checkOneOf('attribute_reindex_requests_reason_check', t.reason, ATTRIBUTE_REINDEX_REASONS),
    check('attribute_reindex_requests_attempts_check', sql`${t.attempts} >= 0`),
    // A claim is a lease: an owner and a deadline travel together, and neither
    // is meaningful alone.
    check(
      'attribute_reindex_requests_claim_check',
      sql`num_nonnulls(${t.claimedAt}, ${t.claimedBy}, ${t.claimExpiresAt}) in (0, 3)`,
    ),
    index('attribute_reindex_requests_pending_idx')
      .on(t.enqueuedAt)
      .where(sql`${t.processedAt} is null`),
    index('attribute_reindex_requests_entity_idx').on(t.entityKind, t.entityId),
  ],
);

/*
 * An `attribute_coverage_runs` table is deliberately ABSENT.
 *
 * #94 coverage rule 1 asks for completeness measured by category, source and
 * field. That is a QUERY over `canonical_attribute_values`, and storing its
 * answer would be a second representation of a fact the values already carry —
 * one that goes stale the moment an observation lands and that two writers could
 * disagree about. `services/attributes/coverage.service.ts` computes it live;
 * if a future dashboard needs history, a snapshot table arrives with the
 * retention decision that justifies it, not before.
 *
 * Recorded here so the absence reads as a decision rather than an oversight —
 * the register discipline `CONVENTIONS.md` asks for.
 */
