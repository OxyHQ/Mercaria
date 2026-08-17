/**
 * Versioned product types (#367, ADR 0007 D5) — `product_type_definitions`,
 * `product_type_category_scopes`, `product_type_field_groups` and
 * `product_type_fields`.
 *
 * A product type is the authoring contract for a class of things: which
 * attributes a smartphone has to declare, which of them a P2P seller is asked
 * for, which may define variants, and in what order a form shows them. It is the
 * one genuinely new entity in the universal-catalog epic — everything else it
 * touches already exists and is CITED rather than copied.
 *
 * ## Immutable once published, by the same mechanism twice already in this repo
 *
 * `fee_schedules` (#88) and `attribute_definitions` (#94) both hold "a version
 * is editable until it is published, and then it is frozen" with a trigger plus
 * a partial unique index. This is the third use and it is deliberately not a new
 * idiom: `(key, version)` is unique, `product_type_definitions_one_published_per_key`
 * makes "the current schema for smartphones" a single row rather than a query
 * with a bug in it, and `product_type_definitions_immutable_once_published`
 * refuses every semantic UPDATE and every DELETE from `published` onward.
 *
 * The reason is stronger here than for either precedent. A stored listing pins
 * the product type VERSION it was authored under, so editing a published version
 * would not correct those listings — it would silently reinterpret them, and the
 * evidence that they ever meant something else would be gone.
 *
 * ## A field cites the registry and describes NOTHING about it
 *
 * `product_type_fields` names an `attribute_definitions` row by foreign key and
 * carries no value type, no unit family, no bounds and no validation rule. #94
 * is the one registry; a second description of one attribute's meaning is how
 * the two come to disagree, and the direction they disagree in is never the safe
 * one. What this table adds is everything the registry cannot know: whether a
 * merchant must supply it, which group it sits in, whether it may define
 * variants, and under what condition it is shown at all.
 *
 * The two citation columns (`attribute_key`, `attribute_definition_version`) are
 * a deliberate, GUARDED denormalization and not a second authority. They exist
 * because the variant-axis prohibition below has to be a CHECK, a CHECK admits
 * no subquery, and a rule that lives only in a service is one forgotten call
 * site from being no rule at all. `mercaria_product_type_field_citation()`
 * refuses any row whose citation disagrees with the definition its foreign key
 * points at, so divergence is unrepresentable rather than merely unlikely.
 *
 * ## What no row here can say
 *
 * - **A price, a stock level, a seller's condition or a compatibility target is
 *   a variant axis.** `product_type_fields_variant_axis_check` is two conjuncts:
 *   a variant-capable field must be `scope = 'variant'` (so a compatibility
 *   target can never be one), and its attribute key must be outside
 *   `PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS` (so a compatibility fact
 *   mislabelled `variant` still cannot). Two independent walls, both local, both
 *   enforced against `psql` (ADR 0007 D6/D8).
 * - **A listing, offer or inventory fact at all.** Those are COMPOSED into the
 *   authoring schema by ADR 0007 D10's service and are not product-type
 *   attributes; #94's `attribute_definitions_reserved_key_check` already refuses
 *   to define them, and `product-type-isolation.test.ts` fails the build if a
 *   module in this domain reaches the payment, inventory or ranking domains.
 * - **An open-ended rule.** `visibility_rule` is the bounded declarative AST
 *   ADR 0007 D14 permits, capped in bytes at the column and in nodes, depth,
 *   branches and values by the interpreter. There is no operator that could
 *   carry a regex, a template or a call.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, textArrayLiteral, timestamptz, updatedAt } from '@oxyhq/db';
import {
  PRODUCT_TYPE_AUTHORING_FLOWS,
  PRODUCT_TYPE_FIELD_REQUIREMENTS,
  PRODUCT_TYPE_FIELD_SCOPES,
  PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS,
  PRODUCT_TYPE_KEY_PATTERN,
  PRODUCT_TYPE_LIFECYCLES,
  PRODUCT_TYPE_PENDING_PROPOSAL_POLICIES,
  PRODUCT_TYPE_RULE_MAX_SERIALIZED_BYTES,
  PRODUCT_TYPE_VALUE_POLICIES,
  type ProductTypeVisibilityRule,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { attributeDefinitions } from './attributeRegistry';
import { categories } from './catalog';

/**
 * `product_type_definitions` — one VERSION of one product type's authoring
 * contract.
 *
 * `(key, version)` is the public name every authored record carries forever; the
 * uuid primary key is what foreign keys reference (ADR 0007 D1: two stable
 * identifiers and no third).
 *
 * `key` is frozen from INSERT rather than from publication, unlike the semantic
 * columns. D1 rule 2 is explicit about why: a renamed key is indistinguishable
 * from a different concept to every seed, fixture, external mapping and export
 * that cited it, and a draft's key is exactly what a seed cites while the schema
 * is being built.
 */
export const productTypeDefinitions = pgTable(
  'product_type_definitions',
  {
    id: generatedId(),
    /** The stable machine key shared by every version (`smartphone`). */
    key: text().notNull(),
    /** Monotonic per key, assigned by the operator drafting the version. */
    version: integer().notNull().default(1),
    lifecycle: text({ enum: asEnumValues(PRODUCT_TYPE_LIFECYCLES) }).notNull().default('draft'),
    /** The base-locale name. Localized names live in the D4 localization family. */
    name: text().notNull(),
    description: text(),
    /**
     * What happens to a publication while one of its values is still a proposal
     * (ADR 0007 D9). A property of the VERSION, so it is reviewed and versioned
     * rather than decided per request.
     */
    pendingProposalPolicy: text({ enum: asEnumValues(PRODUCT_TYPE_PENDING_PROPOSAL_POLICIES) })
      .notNull()
      .default('block_publication'),
    /** The operator who drafted it — an Oxy account id, no foreign key. */
    createdByOxyUserId: text(),
    /** The operator who published it — the audit half of "publish a new version". */
    publishedByOxyUserId: text(),
    publishedAt: timestamptz(),
    deprecatedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('product_type_definitions_lifecycle_check', t.lifecycle, PRODUCT_TYPE_LIFECYCLES),
    checkOneOf(
      'product_type_definitions_pending_proposal_policy_check',
      t.pendingProposalPolicy,
      PRODUCT_TYPE_PENDING_PROPOSAL_POLICIES,
    ),
    // Dotted namespaces are permitted here and not on an attribute key: ADR 0007
    // D1 gives catalog concepts a documented namespace, and #94 shipped without
    // one. Anchored at both ends, so a key with a trailing dot or an embedded
    // space is refused rather than stored and looked up forever by nobody.
    //
    // Rendered from `PRODUCT_TYPE_KEY_PATTERN` through `sql.raw`, and BOTH
    // halves of that are load-bearing (#477).
    //
    // `sql.raw`, because a tagged template's COOKED strings drop `\.` to `.`
    // before drizzle ever sees it, and a bare `.` in a POSIX regex matches ANY
    // character — so the inline spelling this replaces admitted `foo bar` and
    // `foo/bar`, exactly what it was written to refuse. `categories_key_format_
    // check` learned this first; the fix did not reach here until the applied
    // SQL was read rather than the declaration.
    //
    // The shared constant rather than a second copy, because it is what
    // `product-type-text.ts` validates against: two spellings of one key shape
    // can disagree, and the way they disagree is a key the service accepts and
    // the database refuses, or worse the reverse.
    check(
      'product_type_definitions_key_shape_check',
      sql`${t.key} ~ ${sql.raw(`'${PRODUCT_TYPE_KEY_PATTERN.source}'`)}`,
    ),
    check('product_type_definitions_version_check', sql`${t.version} >= 1`),
    // A version that has left draft records who published it and when; one that
    // has not records neither. The `fee_schedules` activation-audit shape —
    // nothing published is anonymous. `review` is still unpublished.
    check(
      'product_type_definitions_published_audit_check',
      sql`(${t.lifecycle} in ('draft', 'review'))
          = (${t.publishedAt} is null and ${t.publishedByOxyUserId} is null)`,
    ),
    check(
      'product_type_definitions_deprecated_at_check',
      sql`(${t.lifecycle} = 'deprecated') = (${t.deprecatedAt} is not null)`,
    ),
    uniqueIndex('product_type_definitions_key_version_key').on(t.key, t.version),
    // THE structural half of "a published version is immutable; publish a new
    // one": at most one published version per key, so publishing must deprecate
    // its predecessor in the same transaction and the index refuses any ordering
    // that would leave two current schemas for one product type.
    uniqueIndex('product_type_definitions_one_published_per_key')
      .on(t.key)
      .where(sql`${t.lifecycle} = 'published'`),
    index('product_type_definitions_lifecycle_idx').on(t.lifecycle, t.key),
  ],
);

/**
 * `product_type_category_scopes` — which categories a version may be used under
 * (ADR 0007 D2/D5).
 *
 * A junction table rather than a `category_id[]` column, per CONVENTIONS: an
 * array of ids cannot be joined or constrained, and this is read both ways
 * (which types may be authored under this category; which categories does this
 * type cover).
 *
 * NO rows means the version is scoped to NOTHING and may be used nowhere — the
 * opposite reading from `attribute_definition_categories`, whose empty scope
 * means "everywhere". The asymmetry is deliberate and follows the grant/narrow
 * rule ADR 0007 D4 states for the localization family: an attribute scope
 * NARROWS something otherwise general, while a product type's eligibility GRANTS
 * a place it may be used, and a grant that names no destination grants none. A
 * freshly drafted version therefore permits nothing until somebody says where.
 */
export const productTypeCategoryScopes = pgTable(
  'product_type_category_scopes',
  {
    id: generatedId(),
    productTypeDefinitionId: text()
      .notNull()
      .references(() => productTypeDefinitions.id, { onDelete: 'cascade' }),
    /** `restrict`: nothing deletes a category today, and a scope may not be orphaned. */
    categoryId: text()
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    /** Whether the eligibility reaches this category's subtree. */
    includeDescendants: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('product_type_category_scopes_key').on(t.productTypeDefinitionId, t.categoryId),
    index('product_type_category_scopes_category_idx').on(t.categoryId),
  ],
);

/**
 * `product_type_field_groups` — the ordered sections a form and a spec table are
 * laid out in.
 *
 * `unique(id, product_type_definition_id)` is not decoration: it is the target
 * `product_type_fields`' composite foreign key references, which is what makes
 * "a field cannot sit in another product type's group" unrepresentable rather
 * than checked. The `match_category_gates` device, and a CONSTRAINT rather than
 * a unique index because a foreign key must target one.
 */
export const productTypeFieldGroups = pgTable(
  'product_type_field_groups',
  {
    id: generatedId(),
    productTypeDefinitionId: text()
      .notNull()
      .references(() => productTypeDefinitions.id, { onDelete: 'cascade' }),
    /** Stable machine key, cited by seeds and by the authoring client's layout. */
    key: text().notNull(),
    /** The base-locale label. Localized labels are ADR 0007 D4's. */
    label: text().notNull(),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('product_type_field_groups_key_shape_check', sql`${t.key} ~ '^[a-z][a-z0-9_]*$'`),
    check('product_type_field_groups_position_check', sql`${t.position} >= 0`),
    uniqueIndex('product_type_field_groups_key_key').on(t.productTypeDefinitionId, t.key),
    /** The composite key `product_type_fields` cites. See the doc above. */
    unique('product_type_field_groups_identity_key').on(t.id, t.productTypeDefinitionId),
    index('product_type_field_groups_position_idx').on(t.productTypeDefinitionId, t.position),
  ],
);

/**
 * `product_type_fields` — one attribute, in one authoring flow, of one version.
 *
 * ## One row per (version, flow, attribute), which is what ADR 0007 D5 asks for
 *
 * The ADR has a field carry both `flow` and a `requirement` per flow, so the row
 * IS per flow: a merchant is asked for twelve identity fields and a P2P seller
 * for two, and that is the whole reason the flow vocabulary exists. The cost is
 * that `scope`, `variant_capable` and `value_policy` are repeated across the
 * flows of one attribute and could in principle disagree — two flows arguing
 * about whether colour defines variants. That is a CROSS-ROW rule, so it is a
 * trigger (`mercaria_product_type_field_citation()`), not a comment.
 *
 * ## `visibility_rule`
 *
 * The bounded declarative AST of ADR 0007 D14, and one of the three JSONB uses
 * that ADR permits. The column carries a byte bound; the interpreter in
 * `services/product-types/visibility-rule.ts` carries the node, depth, branch
 * and value bounds and refuses anything it does not recognise. Nothing here is
 * ever `eval`ed, no operator can hold a pattern, and a rule may only read the
 * attribute keys of the same product type version — which is the mechanical
 * reason a visibility rule can never consult a price.
 */
export const productTypeFields = pgTable(
  'product_type_fields',
  {
    id: generatedId(),
    productTypeDefinitionId: text()
      .notNull()
      .references(() => productTypeDefinitions.id, { onDelete: 'cascade' }),
    /**
     * The group this field is laid out in, or NULL for an ungrouped one. The
     * composite foreign key below ties it to THIS version's groups.
     */
    groupId: text(),
    /**
     * The registry version this field cites. `restrict`, because a definition
     * with a schema pointing at it is not deletable — and #94's own trigger
     * already refuses to delete a published one.
     */
    attributeDefinitionId: text()
      .notNull()
      .references(() => attributeDefinitions.id, { onDelete: 'restrict' }),
    /**
     * The cited definition's `key` and `version`, kept in step by
     * `mercaria_product_type_field_citation()`. A guarded denormalization, not a
     * second authority — see the file header for why a CHECK needs them here.
     */
    attributeKey: text().notNull(),
    attributeDefinitionVersion: integer().notNull(),
    scope: text({ enum: asEnumValues(PRODUCT_TYPE_FIELD_SCOPES) }).notNull(),
    flow: text({ enum: asEnumValues(PRODUCT_TYPE_AUTHORING_FLOWS) }).notNull(),
    requirement: text({ enum: asEnumValues(PRODUCT_TYPE_FIELD_REQUIREMENTS) }).notNull(),
    valuePolicy: text({ enum: asEnumValues(PRODUCT_TYPE_VALUE_POLICIES) }).notNull(),
    /** May this attribute define variants for this type (ADR 0007 D6)? */
    variantCapable: boolean().notNull().default(false),
    position: integer().notNull().default(0),
    /** The bounded declarative AST, or NULL for a field that is always shown. */
    visibilityRule: jsonb().$type<ProductTypeVisibilityRule>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('product_type_fields_scope_check', t.scope, PRODUCT_TYPE_FIELD_SCOPES),
    checkOneOf('product_type_fields_flow_check', t.flow, PRODUCT_TYPE_AUTHORING_FLOWS),
    checkOneOf(
      'product_type_fields_requirement_check',
      t.requirement,
      PRODUCT_TYPE_FIELD_REQUIREMENTS,
    ),
    checkOneOf('product_type_fields_value_policy_check', t.valuePolicy, PRODUCT_TYPE_VALUE_POLICIES),
    // The same anchored shape `attribute_definitions_key_shape_check` uses, so a
    // citation that could never resolve is refused before the trigger looks.
    check('product_type_fields_attribute_key_shape_check', sql`${t.attributeKey} ~ '^[a-z][a-z0-9_]*$'`),
    check('product_type_fields_attribute_version_check', sql`${t.attributeDefinitionVersion} >= 1`),
    check('product_type_fields_position_check', sql`${t.position} >= 0`),
    // ADR 0007 D6/D8, and the reason this table exists in the shape it does. Two
    // independent conjuncts:
    //
    //  1. an axis is a VARIANT-scope field, so a compatibility target — a
    //     vehicle generation, a socket — can never be one whatever else is true;
    //  2. and its attribute may not be one of the keys that name a price, a
    //     stock level, a seller's condition or a fitment fact, so a
    //     compatibility attribute mislabelled `variant` is still refused.
    //
    // One brake-pad SKU fits four hundred vehicles and stays ONE variant.
    check(
      'product_type_fields_variant_axis_check',
      sql`${t.variantCapable} is false
          or (${t.scope} = 'variant'
              and ${t.attributeKey} <> all (${sql.raw(textArrayLiteral(PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS))}))`,
    ),
    // A flow that may not supply a field has nothing to make conditional and
    // nothing to vary on. Both halves are refusals of a row that would read as a
    // rule while doing nothing.
    check(
      'product_type_fields_forbidden_shape_check',
      sql`${t.requirement} <> 'forbidden'
          or (${t.visibilityRule} is null and ${t.variantCapable} is false)`,
    ),
    // The storage half of "bounded JSONB" (ADR 0007 D14). The interpreter bounds
    // nodes, depth, branches and values; this bounds the bytes, so an oversized
    // rule cannot be stored and then refused on every single read.
    //
    // `octet_length(<col>::text)` and not `pg_column_size(<col>)`: the second is
    // marked STABLE (its answer depends on TOAST and compression settings), and
    // PostgreSQL refuses a CHECK containing a function that is not IMMUTABLE. It
    // also measures the wrong thing — the STORED size after compression, which
    // is not the size the interpreter has to parse.
    check(
      'product_type_fields_visibility_rule_bounded_check',
      sql`${t.visibilityRule} is null
          or (jsonb_typeof(${t.visibilityRule}) = 'object'
              and octet_length(${t.visibilityRule}::text) <= ${sql.raw(String(PRODUCT_TYPE_RULE_MAX_SERIALIZED_BYTES))})`,
    ),
    // A field sits in a group of ITS OWN version, or in none. Unrepresentable
    // rather than validated: the composite target is `product_type_field_groups`'
    // `unique(id, product_type_definition_id)`, and MATCH SIMPLE — PostgreSQL's
    // default — satisfies the whole constraint when `group_id` is NULL, which is
    // exactly what an ungrouped field is.
    //
    // `no action` and NOT `restrict`, measured against the cascade: deleting a
    // definition cascades to its groups AND its fields in one statement, and
    // `restrict` is checked IMMEDIATELY, so whichever cascade ran first would
    // raise. `no action` is checked at the end of the statement, by which point
    // both are gone. Deleting a group that still has fields still raises.
    foreignKey({
      name: 'product_type_fields_group_fk',
      columns: [t.groupId, t.productTypeDefinitionId],
      foreignColumns: [productTypeFieldGroups.id, productTypeFieldGroups.productTypeDefinitionId],
    }).onDelete('no action'),
    // One row per attribute per flow. Two rows for `merchant` + `color` is a
    // schema that asks for one thing twice with two different answers.
    uniqueIndex('product_type_fields_flow_attribute_key').on(
      t.productTypeDefinitionId,
      t.flow,
      t.attributeDefinitionId,
    ),
    index('product_type_fields_layout_idx').on(t.productTypeDefinitionId, t.flow, t.position),
    index('product_type_fields_attribute_idx').on(t.attributeKey, t.attributeDefinitionVersion),
  ],
);

/*
 * A `product_type_field_flow_requirements` table is deliberately ABSENT.
 *
 * The obvious alternative to `flow` being a column is a field row per attribute
 * plus a child row per (field, flow) carrying only the requirement. It removes
 * the cross-flow repetition the trigger currently guards — and it makes ADR 0007
 * D5's own shape ("a field carries scope, requirement per flow, flow, order,
 * group, value policy") unrepresentable, because order and group would then have
 * to be identical across flows. They are not: a P2P form is a shorter form in a
 * different order, and that is most of what the flow vocabulary is for.
 *
 * Recorded here so the absence reads as a decision rather than an oversight —
 * the register discipline `CONVENTIONS.md` asks for.
 */
