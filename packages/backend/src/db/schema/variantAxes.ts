/**
 * Typed variant axes and retained seller claims (#367 step 4, ADR 0007 D6/D7) —
 * `native_listing_variant_axes`, `native_variant_axis_assignments`,
 * `native_variant_signatures`, `native_listing_attribute_claims` and
 * `native_variant_attribute_claims`.
 *
 * `listing_options.name` and `product_variant_option_values.name` / `.value` are
 * plain text, so two stores selling one shoe produce `Color`, `Colour`, `color `
 * and `Tono` as four distinct axes and every filter built on them is built on
 * display text. This is the layer that replaces them — and it replaces them by
 * ADDITION: ADR 0007 D13 retains both legacy tables, nothing here deletes a row
 * from either, and a listing nobody has migrated behaves exactly as it does
 * today.
 *
 * ## The three questions, and why they are three tables
 *
 * 1. **Which dimensions does this product vary along?**
 *    `native_listing_variant_axes` — one row per declared axis, citing an
 *    `attribute_definitions` row and its exact version. ADR 0007 D6 makes the
 *    product's own list authoritative FOR THAT PRODUCT, so this table is the
 *    answer and `product_type_fields.variant_capable` is a PERMISSION checked
 *    against it, never a second answer.
 * 2. **What is this variant's value on each of them?**
 *    `native_variant_axis_assignments` — one row per (variant, axis), sparse by
 *    construction. Nothing in this domain generates a Cartesian product: an
 *    assignment exists because a variant exists and somebody gave it a value,
 *    and `variant-axis-isolation.test.ts` fails the build if a function appears
 *    that could enumerate combinations.
 * 3. **Which variant IS this, independent of the order anybody typed it in?**
 *    `native_variant_signatures` — one row per variant, holding the digest of
 *    the normalized `(attribute_definition_id, normalized_value)` set, with
 *    `UNIQUE(listing_id, signature)` as the collision gate. It is a separate
 *    table rather than a column on the assignments because a ZERO-axis variant
 *    has no assignment rows and still has an identity — "zero, one and many
 *    axes are all supported" is not expressible any other way, and the empty
 *    set is the commonest case in this catalogue.
 *
 * ## And why the claims are two MORE tables rather than a column on those
 *
 * ADR 0007 D7: a merchant's or a connector's assertion and Mercaria's selected
 * fact are different rows, both retained, which is what makes a correction
 * auditable. A `raw_value` column beside a typed one would make the raw text a
 * property of the typed fact — so an assertion nobody could type would have
 * nowhere to live, which is precisely the row this epic exists to keep.
 *
 * A claim is frozen once written (`mercaria_native_claim_frozen`) and cannot be
 * deleted while its subject exists (`mercaria_native_claim_no_delete`, the #90
 * revision-trail device: UPDATE refused always, DELETE refused only while the
 * parent is alive, so the `cascade` the foreign keys declare still works).
 *
 * ## What no row here can say
 *
 * - **That a price, a stock level, a seller's condition or a compatibility
 *   target is an axis.** `native_listing_variant_axes_forbidden_key_check` is
 *   rendered from `PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS` — the SAME tuple
 *   `product_type_fields_variant_axis_check` reads — so the prohibition holds
 *   against `psql` at both grains and there is no second list to disagree.
 * - **That an unsettled claim has a value.** Every typed column is tied to its
 *   resolution by a BICONDITIONAL, so "we could not tell, so we stored our best
 *   guess" has no row shape.
 * - **Anything about a canonical entity.** No column in this file references
 *   `canonical_products`, `canonical_variants`, `brands`, `organizations` or
 *   `merchants`, and `NATIVE_CLAIM_FORBIDDEN_TARGETS` states the prohibition as
 *   a value so the absence is checkable rather than merely true today. It is
 *   also what keeps this domain out of `services/curation/merge-plan.ts`: the
 *   merge census walks foreign keys targeting a MERGEABLE entity, and these five
 *   tables target none.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  type PgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, textArrayLiteral, timestamptz, updatedAt } from '@oxyhq/db';
import {
  NATIVE_ATTRIBUTE_CLAIM_KINDS,
  NATIVE_ATTRIBUTE_CLAIM_PROVENANCES,
  NATIVE_CLAIM_RESOLUTIONS,
  PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS,
  VARIANT_AXIS_ATTRIBUTE_REFUSALS,
  VARIANT_AXIS_VALUE_REFUSALS,
} from '@mercaria/shared-types';
import { asEnumValues, checkOneOf } from './columns';
import { attributeDefinitions, attributeEnumValues } from './attributeRegistry';
import { listings, productVariants } from './catalog';
import { connections } from './connectors';
import { productTypeDefinitions } from './productTypes';

/**
 * `native_listing_variant_axes` — the dimensions ONE native listing varies
 * along, typed (ADR 0007 D6).
 *
 * ## The citation columns are a guarded denormalization, not a second authority
 *
 * `attribute_key` and `attribute_definition_version` repeat what the foreign key
 * already points at, for exactly the reason `product_type_fields` repeats them
 * one table over: the forbidden-axis prohibition has to be a CHECK, a CHECK
 * admits no subquery, and a rule that lives only in a service is one forgotten
 * call site from being no rule at all.
 * `mercaria_native_variant_axis_citation()` refuses any row whose citation
 * disagrees with the definition its foreign key names, so divergence is
 * unrepresentable rather than merely unlikely.
 *
 * ## `product_type_definition_id` is NULLABLE, and that is a decision
 *
 * ADR 0007 D6 speaks of "any listing migrated to a product type", and the
 * obvious reading makes this column NOT NULL. It is not, because `listings`
 * carries no `product_type_definition_id` today — ADR 0007 D13 assigns that
 * widening to the authoring workstream (D10, merge-order step 5) — so a NOT NULL
 * citation would make the legacy backfill unable to type a single axis until
 * that lands. A backfill that resolves nothing is not a safer backfill, it is a
 * vacuous one.
 *
 * What the nullability does NOT cost is the prohibition, because the permission
 * is checked at two grains and only one of them needs a product type:
 *
 *  - `attribute_definitions.variant_defining` — the REGISTRY's answer to "may
 *    this attribute define variants at all". Checked on every row by the
 *    citation trigger, product type or no product type.
 *  - `product_type_fields.variant_capable` + `scope = 'variant'` — the product
 *    TYPE's narrower answer. Checked by the same trigger, and only when a
 *    version is cited.
 *
 * When step 5 lands `listings.product_type_definition_id`, the owed change is
 * one trigger clause asserting the citation agrees with the listing's own — and
 * it is named in `docs/variant-axes.md` rather than stubbed here.
 */
export const nativeListingVariantAxes = pgTable(
  'native_listing_variant_axes',
  {
    id: generatedId(),
    /** `cascade`: an axis of a deleted listing describes nothing. */
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /**
     * The registry VERSION this axis is. `restrict`, the
     * `product_type_fields.attribute_definition_id` decision: a definition a
     * live product's identity is computed from is not deletable.
     */
    attributeDefinitionId: text()
      .notNull()
      .references(() => attributeDefinitions.id, { onDelete: 'restrict' }),
    /** Kept in step with the definition by the citation trigger. See the doc above. */
    attributeKey: text().notNull(),
    attributeDefinitionVersion: integer().notNull(),
    /**
     * The product type version the declaration was made under, or NULL.
     * `restrict`: a version a live listing's axis cites is not deletable, and
     * #367 step 3's own trigger already refuses to delete a published one.
     */
    productTypeDefinitionId: text().references(() => productTypeDefinitions.id, {
      onDelete: 'restrict',
    }),
    /** The verbatim `listing_options.name` this axis was resolved FROM, if any. */
    legacyOptionName: text(),
    /** DISPLAY order only — deliberately not an input to the signature. */
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The same anchored shape `attribute_definitions_key_shape_check` uses, so a
    // citation that could never resolve is refused before the trigger looks.
    check(
      'native_listing_variant_axes_attribute_key_shape_check',
      sql`${t.attributeKey} ~ '^[a-z][a-z0-9_]*$'`,
    ),
    check(
      'native_listing_variant_axes_attribute_version_check',
      sql`${t.attributeDefinitionVersion} >= 1`,
    ),
    check('native_listing_variant_axes_position_check', sql`${t.position} >= 0`),
    // ADR 0007 D6/D8, rendered from `product_type_fields_variant_axis_check`'s
    // OWN tuple. Two tables, one list: #94 widening the reserved offer facts
    // widens both, and a compatibility target — a vehicle generation, a year
    // range — is refused here even for a listing that cites no product type at
    // all. One brake-pad SKU fits four hundred vehicles and stays ONE variant.
    check(
      'native_listing_variant_axes_forbidden_key_check',
      sql`${t.attributeKey} <> all (${sql.raw(textArrayLiteral(PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS))})`,
    ),
    // ONE axis per attribute KEY per listing, and the key rather than the
    // definition id is what the uniqueness is on. Two VERSIONS of `color`
    // declared on one listing are two axes both called colour: the signature
    // would distinguish them (it hashes the definition id) and a shopper would
    // see the same word twice. The citation trigger makes key and id agree, so
    // this also refuses the same version twice.
    uniqueIndex('native_listing_variant_axes_listing_attribute_key').on(t.listingId, t.attributeKey),
    index('native_listing_variant_axes_listing_position_idx').on(t.listingId, t.position),
    // Reverse lookup for #367 step 5's schema resolution and for the operator
    // surface: which listings declare an axis on this exact definition version?
    index('native_listing_variant_axes_definition_idx').on(t.attributeDefinitionId),
  ],
);

/**
 * `native_variant_axis_assignments` — one variant's value on one of its
 * listing's axes.
 *
 * ## Sparse, structurally
 *
 * A row exists because a variant exists and somebody gave it a value. Nothing
 * generates the Cartesian product of the axes: there is no function in this
 * domain that takes an axis list and returns a set of combinations, and the
 * isolation gate fails the build if one appears. A 4-colour × 5-size listing
 * with three real SKUs has three variants and six assignment rows, not twenty.
 *
 * ## `normalized_value` is the signature input and `display_value` is not
 *
 * The two are separate columns because they answer different questions and
 * folding them loses the seller's own words — the `canonical_variant_attributes`
 * decision, at the native grain. `normalized_value` is what
 * `typedVariantSignature` hashed; `display_value` is what a shopper reads.
 *
 * `normalized_number` / `normalized_unit` travel together and only on a
 * measurement axis, so a `256 GB` and a `0.25 TB` axis value are comparable
 * without re-parsing the string on every read. They are NOT the signature input:
 * the signature hashes `normalized_value`, which for a measurement is the
 * base-unit magnitude rendered ONCE, so two spellings of one quantity collide.
 */
export const nativeVariantAxisAssignments = pgTable(
  'native_variant_axis_assignments',
  {
    id: generatedId(),
    /** `cascade`: an assignment of a deleted variant describes nothing. */
    variantId: text()
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    /**
     * `cascade`: retiring an axis retires every variant's value on it. The
     * signature that covered those values is recomputed by the same service call
     * in the same transaction — and the deferrable count constraint below is
     * what refuses a transaction that forgot.
     */
    axisId: text()
      .notNull()
      .references(() => nativeListingVariantAxes.id, { onDelete: 'cascade' }),
    /**
     * The axis's definition, repeated. A guarded denormalization for the same
     * reason as the axis table's: the signature is computed over definition ids,
     * so reading a batch of assignments must not need a join to know what it
     * hashed. `mercaria_native_variant_axis_assignment_scope()` keeps it in step
     * with the axis and refuses a variant assigned another listing's axis.
     */
    attributeDefinitionId: text()
      .notNull()
      .references(() => attributeDefinitions.id, { onDelete: 'restrict' }),
    attributeKey: text().notNull(),
    /** The seller's own words. */
    displayValue: text().notNull(),
    /** What the signature hashed. Folded text, or a base-unit magnitude. */
    normalizedValue: text().notNull(),
    /** The controlled value, when the axis has controlled values. `restrict`. */
    enumValueId: text().references(() => attributeEnumValues.id, { onDelete: 'restrict' }),
    normalizedNumber: doublePrecision(),
    normalizedUnit: text(),
    /**
     * The retained claim this typed value was derived from (ADR 0007 D7), or
     * NULL for a value authored typed from the start.
     *
     * `restrict`, which is what makes the audit trail hold: the claim is frozen
     * and undeletable while its variant lives, so "which assertion became this
     * value" is answerable for as long as the value exists. It carries no
     * foreign key onto the LISTING claim table because a variant's value is
     * never derived from a listing-grain assertion.
     */
    sourceClaimId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'native_variant_axis_assignments_attribute_key_shape_check',
      sql`${t.attributeKey} ~ '^[a-z][a-z0-9_]*$'`,
    ),
    check(
      'native_variant_axis_assignments_normalized_shape_check',
      sql`${t.normalizedValue} = lower(btrim(${t.normalizedValue})) and ${t.normalizedValue} <> ''`,
    ),
    // A unit with no magnitude measures nothing — `canonical_variant_attrs_unit_check`,
    // at the native grain.
    check(
      'native_variant_axis_assignments_unit_check',
      sql`${t.normalizedUnit} is null or ${t.normalizedNumber} is not null`,
    ),
    // ONE value per axis per variant. A variant with two storages is not a
    // variant, and the signature would depend on which row won.
    uniqueIndex('native_variant_axis_assignments_variant_axis_key').on(t.variantId, t.axisId),
    index('native_variant_axis_assignments_axis_idx').on(t.axisId),
    // Reverse lookup: which variants are 256 GB? The `canonical_variant_attrs_value_idx`
    // shape, and the read #367 step 9's same-variant semantics will make.
    index('native_variant_axis_assignments_value_idx').on(t.attributeKey, t.normalizedValue),
    index('native_variant_axis_assignments_claim_idx')
      .on(t.sourceClaimId)
      .where(sql`${t.sourceClaimId} is not null`),
  ],
);

/**
 * `native_variant_signatures` — one variant's order-independent identity inside
 * its listing (ADR 0007 D6).
 *
 * ## `listing_id` is denormalized, and a trigger is why that is safe
 *
 * `UNIQUE(listing_id, signature)` is the whole point of the table — the gate
 * that makes "two variants whose axes were entered in different orders collide,
 * by construction" a database fact rather than a hope — and an index needs the
 * column. The correct shape would be a COMPOSITE foreign key onto
 * `product_variants (id, listing_id)`, the `product_type_field_groups` device;
 * that target does not exist, adding it means editing `catalog.ts`, and this
 * branch may not. So `mercaria_native_variant_signature_scope()` refuses any row
 * whose `listing_id` disagrees with the variant's own, and
 * `docs/variant-axes.md` names the composite unique as the change that would
 * retire it.
 *
 * ## `axis_count` and the deferrable constraint trigger
 *
 * A signature is a claim about a SET of assignment rows, and nothing in a row
 * trigger can see whether that set is what was hashed. `axis_count` records how
 * many assignments went into the digest and
 * `mercaria_native_variant_signature_agrees` — a DEFERRABLE constraint trigger,
 * the `mercaria_catalog_source_rights_agree` device — checks it against the real
 * count at COMMIT. Deferred because writing a variant's axes touches two tables
 * and no statement order makes every intermediate state consistent.
 *
 * What it catches is the real bug: an assignment inserted or deleted without the
 * signature being recomputed, which otherwise leaves two distinct variants
 * colliding or one failing to. What it does NOT catch is a signature computed
 * over the right NUMBER of wrong values — re-hashing in plpgsql would need a
 * digest function this schema does not require, and the count is what is
 * affordable. `variant-axes.realdb.test.ts` covers the content half.
 */
export const nativeVariantSignatures = pgTable(
  'native_variant_signatures',
  {
    id: generatedId(),
    variantId: text()
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    /** Denormalized from the variant. See the doc above. */
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /** The sha-256 hex digest of the normalized assignment set. */
    signature: text().notNull(),
    /** How many assignments the digest covered. Zero is a real, common answer. */
    axisCount: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // A signature that is not a sha-256 hex digest is not one this codebase
    // produced, and it would silently occupy key space in the collision gate
    // below without colliding with anything.
    check('native_variant_signatures_signature_shape_check', sql`${t.signature} ~ '^[0-9a-f]{64}$'`),
    check('native_variant_signatures_axis_count_check', sql`${t.axisCount} >= 0`),
    uniqueIndex('native_variant_signatures_variant_key').on(t.variantId),
    // THE order-independence gate. `canonical_variants_product_signature_key`,
    // at the native grain.
    uniqueIndex('native_variant_signatures_listing_signature_key').on(t.listingId, t.signature),
  ],
);

/**
 * The resolution columns every claim table carries, declared ONCE.
 *
 * Two independent halves — which ATTRIBUTE the raw name means, and which VALUE
 * the raw text means — because they fail independently and the failures need
 * different fixes. `Tono` resolving while `Verde Bosque` does not is the common
 * case in real data, and a single verdict would have to call that whole claim
 * unresolved and lose the half that was settled.
 */
function claimResolutionColumns() {
  return {
    attributeResolution: text({ enum: asEnumValues(NATIVE_CLAIM_RESOLUTIONS) })
      .notNull()
      .default('unresolved'),
    attributeRefusal: text({ enum: asEnumValues(VARIANT_AXIS_ATTRIBUTE_REFUSALS) }),
    valueResolution: text({ enum: asEnumValues(NATIVE_CLAIM_RESOLUTIONS) })
      .notNull()
      .default('unresolved'),
    valueRefusal: text({ enum: asEnumValues(VARIANT_AXIS_VALUE_REFUSALS) }),
    /** The registry VERSION the raw name resolved to. `restrict`. */
    attributeDefinitionId: text().references(() => attributeDefinitions.id, {
      onDelete: 'restrict',
    }),
    attributeDefinitionVersion: integer(),
    /** The controlled value the raw text resolved to, when there is one. */
    enumValueId: text().references(() => attributeEnumValues.id, { onDelete: 'restrict' }),
    /** The typed form. Present EXACTLY when the value resolved. */
    normalizedValue: text(),
    /** Who settled it, when a person did. An Oxy account id — no foreign key. */
    resolvedByOxyUserId: text(),
    resolvedAt: timestamptz(),
  };
}

/**
 * The CHECKs every claim table owes, rendered from one place so the two grains
 * cannot drift.
 *
 * Every one is a BICONDITIONAL rather than a one-way requirement, and that is
 * the safety property rather than a style: a one-way `resolved ⇒ value present`
 * still admits a BLOCKED claim carrying a normalized value, which is exactly
 * "we could not tell, so we stored our best guess" — the false merge ADR 0007 D6
 * names #58's shape for.
 *
 * The refusal pairs are written as TWO biconditionals and never one over their
 * conjunction: `(a = x) = (b is not null)` conjoined with `(a = y) = (c is not
 * null)` is satisfied by a row where both sides of each are false, which admits
 * precisely the row the rule exists to refuse. Measured twice in this schema
 * (`retail_delivery_promises_observed_shape_check`,
 * `watchlist_snapshot_items`), both times by a real server.
 */
interface ClaimResolutionColumns {
  attributeResolution: PgColumn;
  attributeRefusal: PgColumn;
  valueResolution: PgColumn;
  valueRefusal: PgColumn;
  attributeDefinitionId: PgColumn;
  attributeDefinitionVersion: PgColumn;
  enumValueId: PgColumn;
  normalizedValue: PgColumn;
  resolvedByOxyUserId: PgColumn;
  resolvedAt: PgColumn;
}

function claimResolutionChecks(
  table: string,
  t: ClaimResolutionColumns,
): ReturnType<typeof check>[] {
  return [
    checkOneOf(`${table}_attribute_resolution_check`, t.attributeResolution, NATIVE_CLAIM_RESOLUTIONS),
    checkOneOf(`${table}_attribute_refusal_check`, t.attributeRefusal, VARIANT_AXIS_ATTRIBUTE_REFUSALS),
    checkOneOf(`${table}_value_resolution_check`, t.valueResolution, NATIVE_CLAIM_RESOLUTIONS),
    checkOneOf(`${table}_value_refusal_check`, t.valueRefusal, VARIANT_AXIS_VALUE_REFUSALS),
    // A blocked or refused half names its cause; an unresolved or resolved one
    // names none.
    check(
      `${table}_attribute_refusal_shape_check`,
      sql`(${t.attributeResolution} in ('blocked', 'refused')) = (${t.attributeRefusal} is not null)`,
    ),
    check(
      `${table}_value_refusal_shape_check`,
      sql`(${t.valueResolution} in ('blocked', 'refused')) = (${t.valueRefusal} is not null)`,
    ),
    // A person's refusal and the machine's block are told apart by the REASON as
    // well as the state, so the two cannot disagree about which happened.
    check(
      `${table}_attribute_operator_refusal_check`,
      sql`(${t.attributeResolution} = 'refused') = (${t.attributeRefusal} is not distinct from 'operator_refused')`,
    ),
    check(
      `${table}_value_operator_refusal_check`,
      sql`(${t.valueResolution} = 'refused') = (${t.valueRefusal} is not distinct from 'operator_refused')`,
    ),
    // ONLY a resolved attribute names a definition, and the version travels with
    // it: a version without a definition names nothing and a definition without a
    // version cannot be reproduced (#94 value rule 2).
    check(
      `${table}_attribute_resolved_check`,
      sql`(${t.attributeResolution} = 'resolved') = (${t.attributeDefinitionId} is not null)`,
    ),
    check(
      `${table}_attribute_version_check`,
      sql`(${t.attributeDefinitionId} is null) = (${t.attributeDefinitionVersion} is null)`,
    ),
    // ONLY a resolved value carries a typed one. THE column that makes an
    // ambiguous legacy option stay text.
    check(
      `${table}_value_resolved_check`,
      sql`(${t.valueResolution} = 'resolved') = (${t.normalizedValue} is not null)`,
    ),
    check(
      `${table}_enum_value_check`,
      sql`${t.enumValueId} is null or ${t.valueResolution} = 'resolved'`,
    ),
    // A value cannot be typed while nobody knows which attribute it is a value
    // OF. The dependent direction of the two halves, and the reason
    // `attribute_unresolved` is a member of the value-refusal vocabulary.
    check(
      `${table}_value_depends_on_attribute_check`,
      sql`${t.valueResolution} <> 'resolved' or ${t.attributeResolution} = 'resolved'`,
    ),
    // A resolution a PERSON made names them and when; one nobody made names
    // neither. The `attribute_value_reviews_resolution_check` shape — an
    // anonymous decision is unrepresentable.
    check(
      `${table}_resolver_audit_check`,
      sql`num_nonnulls(${t.resolvedByOxyUserId}, ${t.resolvedAt}) <> 1`,
    ),
    check(
      `${table}_operator_refusal_audit_check`,
      sql`(${t.attributeResolution} <> 'refused' and ${t.valueResolution} <> 'refused')
          or (${t.resolvedByOxyUserId} is not null and ${t.resolvedAt} is not null)`,
    ),
  ];
}

/**
 * The provenance columns every claim table carries.
 *
 * `asserted_at` is the party's own instant and `created_at` is when Mercaria
 * wrote the row. Two facts, never one: the legacy backfill preserves text a
 * merchant typed months ago, and stamping it with today's clock would make the
 * audit trail claim they said it during the migration.
 */
function claimProvenanceColumns() {
  return {
    provenance: text({ enum: asEnumValues(NATIVE_ATTRIBUTE_CLAIM_PROVENANCES) }).notNull(),
    /** The connector connection, for a `connector_import` claim. `restrict`. */
    sourceConnectionId: text().references(() => connections.id, { onDelete: 'restrict' }),
    /** The merchant, seller or operator who asserted it. An Oxy account id. */
    assertedByOxyUserId: text(),
    assertedAt: timestamptz().notNull(),
  };
}

interface ClaimProvenanceColumns {
  provenance: PgColumn;
  sourceConnectionId: PgColumn;
  assertedByOxyUserId: PgColumn;
}

/** The CHECKs the provenance columns owe, at both grains. */
function claimProvenanceChecks(
  table: string,
  t: ClaimProvenanceColumns,
): ReturnType<typeof check>[] {
  return [
    checkOneOf(`${table}_provenance_check`, t.provenance, NATIVE_ATTRIBUTE_CLAIM_PROVENANCES),
    // A connector claim names its connection and nothing else does — an
    // assertion attributed to a connection that did not make it is worse than
    // one attributed to nobody.
    check(
      `${table}_connector_provenance_check`,
      sql`(${t.provenance} = 'connector_import') = (${t.sourceConnectionId} is not null)`,
    ),
    // The backfill INVENTS no provenance. `legacy_option_migration` names
    // exactly what is known — this text was preserved from the pre-typed option
    // columns — and the legacy rows record neither who asserted the value nor
    // when, so a claim carrying either would be a fact nobody observed.
    check(
      `${table}_legacy_provenance_check`,
      sql`${t.provenance} <> 'legacy_option_migration' or ${t.assertedByOxyUserId} is null`,
    ),
  ];
}

/**
 * `native_listing_attribute_claims` — what a party asserted about one native
 * LISTING (ADR 0007 D7).
 *
 * Two kinds, and the discriminant is the legacy shape rather than a preference:
 * `axis_declaration` preserves a `listing_options.name` (an option LABEL, with
 * no value beside it), and `attribute_value` is a product-scope assertion
 * (`material = leather`). One table with a nullable `raw_value` meaning two
 * things is what the discriminant exists to avoid.
 *
 * The backfill writes only `axis_declaration` rows here today. `attribute_value`
 * has no writer yet and that is stated rather than hidden: ADR 0007 D10's
 * authoring service (merge-order step 5) is what asserts product-scope
 * attributes, and the repository function it needs exists.
 */
export const nativeListingAttributeClaims = pgTable(
  'native_listing_attribute_claims',
  {
    id: generatedId(),
    listingId: text()
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    kind: text({ enum: asEnumValues(NATIVE_ATTRIBUTE_CLAIM_KINDS) }).notNull(),
    /** The party's own words for the attribute, verbatim. Never normalized away. */
    rawName: text().notNull(),
    /** The party's own words for the value. NULL for an `axis_declaration`. */
    rawValue: text(),
    /**
     * The lookup key, GENERATED so the stored spelling and the key cannot
     * disagree — the `attribute_value_aliases.normalized_alias` device. Both
     * functions are IMMUTABLE.
     */
    rawNameNormalized: text()
      .notNull()
      .generatedAlwaysAs(sql`lower(btrim("raw_name"))`),
    /**
     * The value half of the convergence key. `coalesce` to `''` rather than
     * leaving it NULL, because Postgres treats NULLs as DISTINCT in a unique
     * index and two identical axis declarations would both be admitted — the
     * `canonical_attribute_values.value_slot` reasoning.
     */
    rawValueKey: text()
      .notNull()
      .generatedAlwaysAs(sql`lower(btrim(coalesce("raw_value", '')))`),
    ...claimProvenanceColumns(),
    ...claimResolutionColumns(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf('native_listing_attribute_claims_kind_check', t.kind, NATIVE_ATTRIBUTE_CLAIM_KINDS),
    // Verbatim means verbatim — but an EMPTY assertion is not a preserved one,
    // it is a row nobody can act on.
    check('native_listing_attribute_claims_raw_name_check', sql`btrim(${t.rawName}) <> ''`),
    // The discriminant, as a biconditional. An `attribute_value` with no value
    // and an `axis_declaration` with one are both refused.
    check(
      'native_listing_attribute_claims_kind_shape_check',
      sql`(${t.kind} = 'attribute_value') = (${t.rawValue} is not null)`,
    ),
    // An axis DECLARATION has no value to settle, so its value half stays
    // `unresolved` forever. Without this the queue would report every preserved
    // option name as a value nobody could type, which is a backlog of work that
    // does not exist.
    check(
      'native_listing_attribute_claims_declaration_value_check',
      sql`${t.kind} = 'attribute_value' or ${t.valueResolution} = 'unresolved'`,
    ),
    ...claimProvenanceChecks('native_listing_attribute_claims', t),
    ...claimResolutionChecks('native_listing_attribute_claims', t),
    // Convergence. A backfill re-run, two concurrent connector deliveries and an
    // operator re-import all land on the same row, so `ON CONFLICT DO NOTHING`
    // is a genuine no-op rather than a write that moves `updated_at`.
    //
    // The VALUE is in the key deliberately: a merchant renaming `Black` to
    // `Jet Black` has made a NEW assertion, and ADR 0007 D7 retains both. What
    // must not produce a second row is the SAME assertion arriving twice.
    uniqueIndex('native_listing_attribute_claims_identity_key').on(
      t.listingId,
      t.provenance,
      t.kind,
      t.rawNameNormalized,
      t.rawValueKey,
    ),
    // The review queue (ADR 0007 D6: "visible in a review queue"). A partial
    // index the size of the real backlog, not of the catalogue.
    index('native_listing_attribute_claims_queue_idx')
      .on(t.attributeResolution, t.createdAt)
      .where(
        sql`${t.attributeResolution} in ('unresolved', 'blocked') or ${t.valueResolution} in ('unresolved', 'blocked')`,
      ),
    index('native_listing_attribute_claims_raw_name_idx').on(t.rawNameNormalized),
  ],
);

/**
 * `native_variant_attribute_claims` — what a party asserted about one native
 * VARIANT (ADR 0007 D7).
 *
 * This is where every `product_variant_option_values` row is preserved: its
 * `name` and `value` verbatim, its provenance recorded as
 * `legacy_option_migration`, and its resolution settled or blocked by the
 * backfill. The legacy row itself is retained (ADR 0007 D13) and nothing here
 * deletes one.
 *
 * There is no `kind` column, and the asymmetry with the listing grain is the
 * data rather than an oversight: a claim about ONE variant is always a value.
 */
export const nativeVariantAttributeClaims = pgTable(
  'native_variant_attribute_claims',
  {
    id: generatedId(),
    variantId: text()
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    rawName: text().notNull(),
    /** NOT NULL here: a variant claim is always a value. See the doc above. */
    rawValue: text().notNull(),
    rawNameNormalized: text()
      .notNull()
      .generatedAlwaysAs(sql`lower(btrim("raw_name"))`),
    rawValueKey: text()
      .notNull()
      .generatedAlwaysAs(sql`lower(btrim("raw_value"))`),
    ...claimProvenanceColumns(),
    ...claimResolutionColumns(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('native_variant_attribute_claims_raw_name_check', sql`btrim(${t.rawName}) <> ''`),
    ...claimProvenanceChecks('native_variant_attribute_claims', t),
    ...claimResolutionChecks('native_variant_attribute_claims', t),
    uniqueIndex('native_variant_attribute_claims_identity_key').on(
      t.variantId,
      t.provenance,
      t.rawNameNormalized,
      t.rawValueKey,
    ),
    index('native_variant_attribute_claims_queue_idx')
      .on(t.attributeResolution, t.createdAt)
      .where(
        sql`${t.attributeResolution} in ('unresolved', 'blocked') or ${t.valueResolution} in ('unresolved', 'blocked')`,
      ),
    index('native_variant_attribute_claims_raw_name_idx').on(t.rawNameNormalized),
  ],
);

/*
 * A `native_variant_axis_review_queue` table is deliberately ABSENT.
 *
 * ADR 0007 D6 asks that anything ambiguous stay "visible in a review queue". The
 * obvious reading is a table; it would be a second representation of what the
 * claim row already says, and the two would disagree the moment a resolution
 * changed without the queue row being updated — which is the failure mode of
 * every cached verdict in this repository (`price_signal_evaluations` records
 * that decision one domain over). The claim's own resolution columns ARE the
 * queue, `<table>_queue_idx` is the index that makes reading it cheap, and
 * `countQueuedClaims` is the count ADR 0007's consequences section asks the
 * migration to publish.
 *
 * A `native_listing_product_types` table is deliberately ABSENT too. ADR 0007
 * D13 assigns `listings.product_type_definition_id` to the authoring workstream
 * (D10, merge-order step 5); a table here holding the same fact would be the
 * rival the epic exists to remove, and this domain does not need it — an axis
 * cites the version it was declared under directly.
 *
 * Recorded here so both absences read as decisions rather than oversights — the
 * register discipline `CONVENTIONS.md` asks for.
 */
