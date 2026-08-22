/**
 * Request schemas for the attribute registry and the constraint surfaces (#94).
 *
 * Its own file, following `canonical-catalog-schemas.ts`. Every body schema is
 * `.strict()`, which is load-bearing rather than tidy: it is what makes "this
 * request cannot carry X" a property of the schema instead of a habit at every
 * handler.
 *
 * Three absences are the point:
 *
 * - **No `strength` on a text preference.** {@link textPreferenceSchema} has no
 *   such field and the parsed object is stamped `'preference'` — so a hard text
 *   requirement is not something an HTTP caller can express, matching the
 *   TypeScript type (#94 constraint rule 7).
 * - **No nested groups.** A group's members are LEAF schemas, so the expression
 *   tree is exactly two levels deep and the bound on its width is checkable
 *   (rule 12).
 * - **No `normalizedValue` on an observation.** The value endpoints take what a
 *   source SAID, never what the normalized fact should become — the #56 API
 *   rule 4 decision, carried forward, so an ingestion caller cannot write a
 *   magnitude no source expressed.
 */

import { z } from 'zod';
import { localizedText } from './localized-text-schemas.js';
import {
  ALL_CURRENCY_CODES,
  ATTRIBUTE_CARDINALITIES,
  ATTRIBUTE_COMPONENT_AXES,
  ATTRIBUTE_DISPLAY_POLICIES,
  ATTRIBUTE_ENTITY_KINDS,
  ATTRIBUTE_EVIDENCE_POLICIES,
  ATTRIBUTE_OBJECTIVITIES,
  ATTRIBUTE_VALUE_TYPES,
  MAX_CONSTRAINTS_PER_SET,
  MAX_CONSTRAINT_VALUES_PER_OPERATOR,
  MAX_OR_GROUP_MEMBERS,
  MISSING_DATA_POLICIES,
  OFFER_CHANNEL_KINDS,
  SOURCE_LINK_METHODS,
  TAXONOMY_SUBJECTS,
  TEXT_PREFERENCE_FIELDS,
  UNIT_FAMILIES,
  type AttributeCardinality,
  type AttributeComponentAxis,
  type AttributeDisplayPolicy,
  type AttributeEntityKind,
  type AttributeEvidencePolicy,
  type AttributeObjectivity,
  type AttributeValueType,
  type CurrencyCode,
  type MissingDataPolicy,
  type OfferChannelKind,
  type SourceLinkMethod,
  type TaxonomySubject,
  type TextPreferenceField,
  type UnitFamily,
} from '@mercaria/shared-types';
import {
  MEASUREMENT_SYSTEMS,
  type MeasurementSystem,
} from '../services/canonical/display-units.js';

const asEnum = <T extends string>(values: readonly T[]): readonly [T, ...T[]] => {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error('An enum schema needs at least one value.');
  return [first, ...rest];
};

const idSchema = z.string().trim().min(1).max(64);
const attributeKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/u, 'An attribute key is a stable machine name: ^[a-z][a-z0-9_]*$');
const localeSchema = z
  .string()
  .trim()
  .min(2)
  .max(35)
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u, 'A locale is a BCP-47 tag');

const CURRENCY_VALUES = asEnum(ALL_CURRENCY_CODES as readonly CurrencyCode[]);
const VALUE_TYPE_VALUES = asEnum(ATTRIBUTE_VALUE_TYPES as readonly AttributeValueType[]);
const CARDINALITY_VALUES = asEnum(ATTRIBUTE_CARDINALITIES as readonly AttributeCardinality[]);
const OBJECTIVITY_VALUES = asEnum(ATTRIBUTE_OBJECTIVITIES as readonly AttributeObjectivity[]);
const UNIT_FAMILY_VALUES = asEnum(UNIT_FAMILIES as readonly UnitFamily[]);
const AXIS_VALUES = asEnum(ATTRIBUTE_COMPONENT_AXES as readonly AttributeComponentAxis[]);
const DISPLAY_POLICY_VALUES = asEnum(ATTRIBUTE_DISPLAY_POLICIES as readonly AttributeDisplayPolicy[]);
const EVIDENCE_POLICY_VALUES = asEnum(
  ATTRIBUTE_EVIDENCE_POLICIES as readonly AttributeEvidencePolicy[],
);
const ENTITY_KIND_VALUES = asEnum(ATTRIBUTE_ENTITY_KINDS as readonly AttributeEntityKind[]);
const MEASUREMENT_SYSTEM_VALUES = asEnum(MEASUREMENT_SYSTEMS as readonly MeasurementSystem[]);
const MISSING_DATA_VALUES = asEnum(MISSING_DATA_POLICIES as readonly MissingDataPolicy[]);
const TAXONOMY_SUBJECT_VALUES = asEnum(TAXONOMY_SUBJECTS as readonly TaxonomySubject[]);
const OFFER_CHANNEL_VALUES = asEnum(OFFER_CHANNEL_KINDS as readonly OfferChannelKind[]);
const TEXT_FIELD_VALUES = asEnum(TEXT_PREFERENCE_FIELDS as readonly TextPreferenceField[]);
const SOURCE_LINK_METHOD_VALUES = asEnum(SOURCE_LINK_METHODS as readonly SourceLinkMethod[]);

/** `POST /internal/catalog-attributes/definitions` — drafts a NEW version. */
export const attributeDefinitionDraftSchema = z
  .object({
    key: attributeKeySchema,
    label: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2_000).optional(),
    valueType: z.enum(VALUE_TYPE_VALUES),
    cardinality: z.enum(CARDINALITY_VALUES).optional(),
    objectivity: z.enum(OBJECTIVITY_VALUES).optional(),
    unitFamily: z.enum(UNIT_FAMILY_VALUES).optional(),
    ratingScaleMax: z.number().int().min(2).max(100).optional(),
    currency: z.enum(CURRENCY_VALUES).optional(),
    componentAxes: z.array(z.enum(AXIS_VALUES)).min(1).max(5).optional(),
    minValue: z.number().finite().optional(),
    maxValue: z.number().finite().optional(),
    decimalPlaces: z.number().int().min(0).max(12).optional(),
    maxLength: z.number().int().min(1).max(4_096).optional(),
    implausibleAbove: z.number().finite().optional(),
    implausibleBelow: z.number().finite().optional(),
    variantDefining: z.boolean().optional(),
    filterable: z.boolean().optional(),
    sortable: z.boolean().optional(),
    comparable: z.boolean().optional(),
    hardConstraintCapable: z.boolean().optional(),
    displayPolicy: z.enum(DISPLAY_POLICY_VALUES).optional(),
    evidencePolicy: z.enum(EVIDENCE_POLICY_VALUES).optional(),
    enumValues: z
      .array(
        z
          .object({
            value: z.string().trim().min(1).max(160),
            label: z.string().trim().min(1).max(160),
            aliases: z.array(z.string().trim().min(1).max(160)).max(50).optional(),
          })
          .strict(),
      )
      .max(500)
      .optional(),
    // The LOCALIZED half — one `attribute_labels` row per locale. Both fields
    // carry their `LOCALIZED_TEXT_FIELDS` declaration (#367 line 187): the
    // label is a facet-group heading and a table header, so it is PLAIN; the
    // description is block copy. `label`/`description` at the top of this
    // schema are the definition's own BASE-locale text on `attribute_definitions`,
    // a table with no `locale` column and therefore outside that registry.
    labels: z
      .array(
        z
          .object({
            locale: localeSchema,
            label: localizedText('attribute_labels.label', { min: 1, max: 160 }),
            description: localizedText('attribute_labels.description', { max: 2_000 }).optional(),
          })
          .strict(),
      )
      .max(40)
      .optional(),
    categoryScopes: z
      .array(
        z
          .object({ categoryId: idSchema, includeDescendants: z.boolean().optional() })
          .strict(),
      )
      .max(200)
      .optional(),
  })
  .strict();

/** `POST /internal/catalog-attributes/source-mappings`. */
export const attributeSourceMappingSchema = z
  .object({
    catalogSourceId: idSchema,
    sourceField: z.string().trim().min(1).max(160),
    attributeKey: attributeKeySchema,
    assumedUnit: z.string().trim().min(1).max(32).optional(),
    componentAxis: z.enum(AXIS_VALUES).optional(),
    categoryIds: z.array(idSchema).max(200).optional(),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict();

/** `POST /internal/catalog-attributes/observations` — a SOURCE fact, never a canonical one. */
export const attributeObservationSchema = z
  .object({
    entityKind: z.enum(ENTITY_KIND_VALUES),
    entityId: idSchema,
    attributeKey: attributeKeySchema,
    displayValue: z.string().trim().min(1).max(2_000),
    sourceRecordId: idSchema,
    catalogSourceId: idSchema.optional(),
    sourceField: z.string().trim().min(1).max(160).optional(),
    method: z.enum(SOURCE_LINK_METHOD_VALUES).optional(),
    locale: localeSchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

/** `POST /internal/catalog-attributes/reviews/:id/resolve`. */
export const attributeReviewResolveSchema = z
  .object({
    state: z.enum(['resolved', 'dismissed']),
    selectedValueId: idSchema.optional(),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict();

/**
 * A typed literal a constraint compares against.
 *
 * Discriminated on `type`, so a money amount cannot arrive as a bare decimal and
 * a measurement cannot arrive without its unit. That is the request-boundary
 * half of #94 normalization rule 9.
 */
const constraintValueSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('string'), value: z.string().trim().min(1).max(300) }).strict(),
  z.object({ type: z.literal('boolean'), value: z.boolean() }).strict(),
  z.object({ type: z.literal('integer'), value: z.number().int() }).strict(),
  z.object({ type: z.literal('decimal'), value: z.number().finite() }).strict(),
  z
    .object({
      type: z.literal('date'),
      value: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}/u, 'A date value is ISO-8601'),
    })
    .strict(),
  z
    .object({
      type: z.literal('money'),
      amountMinor: z.number().int(),
      currency: z.enum(CURRENCY_VALUES),
    })
    .strict(),
  z
    .object({
      type: z.literal('measurement'),
      magnitude: z.number().finite(),
      unit: z.string().trim().min(1).max(32),
    })
    .strict(),
]);

const rangeBoundSchema = z
  .object({ value: constraintValueSchema, inclusive: z.boolean() })
  .strict();

const attributePredicateSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('eq'), value: constraintValueSchema }).strict(),
  z.object({ op: z.literal('ne'), value: constraintValueSchema }).strict(),
  z.object({ op: z.literal('gt'), value: constraintValueSchema }).strict(),
  z.object({ op: z.literal('gte'), value: constraintValueSchema }).strict(),
  z.object({ op: z.literal('lt'), value: constraintValueSchema }).strict(),
  z.object({ op: z.literal('lte'), value: constraintValueSchema }).strict(),
  z.object({ op: z.literal('between'), lower: rangeBoundSchema, upper: rangeBoundSchema }).strict(),
  z
    .object({
      op: z.literal('in'),
      values: z.array(constraintValueSchema).min(1).max(MAX_CONSTRAINT_VALUES_PER_OPERATOR),
    })
    .strict(),
  z
    .object({
      op: z.literal('not_in'),
      values: z.array(constraintValueSchema).min(1).max(MAX_CONSTRAINT_VALUES_PER_OPERATOR),
    })
    .strict(),
  z.object({ op: z.literal('exists') }).strict(),
  z.object({ op: z.literal('missing') }).strict(),
  z.object({ op: z.literal('is'), value: z.boolean() }).strict(),
]);

const constraintBase = {
  id: z.string().trim().min(1).max(64),
  scope: z.enum(['product', 'variant']),
  explanation: z.string().trim().min(1).max(300),
};

const strengthSchema = z.enum(['hard', 'preference']);

const attributeConstraintSchema = z
  .object({
    ...constraintBase,
    kind: z.literal('attribute'),
    strength: strengthSchema,
    missingDataPolicy: z.enum(MISSING_DATA_VALUES),
    attributeKey: attributeKeySchema,
    // The version a caller BELIEVES it is constraining. Validation overwrites the
    // recorded version with the active one, so this is advisory input rather
    // than something a client can pin a stale meaning with.
    definitionVersion: z.number().int().min(0).optional(),
    axis: z.enum(AXIS_VALUES).optional(),
    predicate: attributePredicateSchema,
  })
  .strict();

const taxonomyConstraintSchema = z
  .object({
    ...constraintBase,
    kind: z.literal('taxonomy'),
    strength: strengthSchema,
    missingDataPolicy: z.enum(MISSING_DATA_VALUES),
    subject: z.enum(TAXONOMY_SUBJECT_VALUES),
    op: z.enum(['in', 'not_in']),
    ids: z.array(idSchema).min(1).max(MAX_CONSTRAINT_VALUES_PER_OPERATOR),
    includeDescendants: z.boolean().optional(),
  })
  .strict();

const commercePredicateSchema = z.discriminatedUnion('facet', [
  z
    .object({
      facet: z.literal('offer_price'),
      op: z.enum(['lte', 'lt', 'gte', 'gt', 'between']),
      currency: z.enum(CURRENCY_VALUES),
      amountMinor: z.number().int().optional(),
      lower: rangeBoundSchema.optional(),
      upper: rangeBoundSchema.optional(),
    })
    .strict(),
  z
    .object({
      facet: z.literal('known_total'),
      op: z.enum(['lte', 'lt', 'gte', 'gt', 'between']),
      currency: z.enum(CURRENCY_VALUES),
      amountMinor: z.number().int().optional(),
      lower: rangeBoundSchema.optional(),
      upper: rangeBoundSchema.optional(),
    })
    .strict(),
  z
    .object({
      facet: z.literal('availability'),
      op: z.literal('in'),
      values: z.array(z.string().trim().min(1).max(32)).min(1).max(8),
    })
    .strict(),
  z
    .object({
      facet: z.literal('condition'),
      op: z.enum(['in', 'not_in']),
      values: z.array(z.string().trim().min(1).max(32)).min(1).max(8),
    })
    .strict(),
  z
    .object({
      facet: z.literal('market'),
      op: z.literal('in'),
      territories: z.array(z.string().trim().regex(/^[A-Z]{2}$/u)).min(1).max(32),
    })
    .strict(),
  z.object({ facet: z.literal('official_channel'), op: z.literal('is'), value: z.boolean() }).strict(),
  z
    .object({
      facet: z.literal('offer_channel'),
      op: z.literal('in'),
      values: z.array(z.enum(OFFER_CHANNEL_VALUES)).min(1).max(2),
    })
    .strict(),
  z
    .object({
      facet: z.literal('proximity'),
      op: z.literal('within'),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      radiusMetres: z.number().int().min(1).max(500_000),
    })
    .strict(),
]);

const commerceConstraintSchema = z
  .object({
    ...constraintBase,
    kind: z.literal('commerce'),
    strength: strengthSchema,
    missingDataPolicy: z.enum(MISSING_DATA_VALUES),
    predicate: commercePredicateSchema,
  })
  .strict();

/**
 * A text preference — with NO `strength` field.
 *
 * The parsed object is stamped `'preference'` by the transform below, so the
 * request boundary agrees with the type: there is no wire representation of a
 * hard text requirement, and adding one would need a schema change somebody has
 * to justify.
 */
const textPreferenceSchema = z
  .object({
    ...constraintBase,
    kind: z.literal('text'),
    query: z.string().trim().min(1).max(300),
    fields: z.array(z.enum(TEXT_FIELD_VALUES)).min(1).max(3),
  })
  .strict()
  .transform((value) => ({ ...value, strength: 'preference' as const }));

const leafConstraintSchema = z.union([
  attributeConstraintSchema,
  taxonomyConstraintSchema,
  commerceConstraintSchema,
  textPreferenceSchema,
]);

/** An "any of" group. Members are LEAVES — the tree is two levels, always. */
const constraintGroupSchema = z
  .object({
    ...constraintBase,
    kind: z.literal('any_of'),
    strength: strengthSchema,
    missingDataPolicy: z.enum(MISSING_DATA_VALUES),
    members: z.array(leafConstraintSchema).min(1).max(MAX_OR_GROUP_MEMBERS),
  })
  .strict();

/**
 * Any constraint a set may contain.
 *
 * EXPORTED so #96's comparison and basket surfaces parse the constraint
 * language through this one schema. A second spelling of the same grammar is a
 * second answer to what a shopper asked for, and the two would disagree at
 * exactly the operator #94 refused and #96 accepted.
 */
export const productConstraintSchema = z.union([leafConstraintSchema, constraintGroupSchema]);

/** `POST /catalog-attributes/constraints/validate`. */
export const constraintSetValidateSchema = z
  .object({
    categoryId: idSchema.optional(),
    constraints: z.array(productConstraintSchema).min(1).max(MAX_CONSTRAINTS_PER_SET),
  })
  .strict();

/** `POST /catalog-attributes/constraints/evaluate`. */
export const constraintSetEvaluateSchema = z
  .object({
    categoryId: idSchema.optional(),
    productId: idSchema,
    /** Evaluate ONE variant rather than the product. */
    variantId: idSchema.optional(),
    currency: z.enum(CURRENCY_VALUES).optional(),
    territory: z.string().trim().regex(/^[A-Z]{2}$/u).optional(),
    constraints: z.array(productConstraintSchema).min(1).max(MAX_CONSTRAINTS_PER_SET),
  })
  .strict();

/** `GET /catalog-attributes/definitions`. */
export const attributeDefinitionQuerySchema = z
  .object({
    categoryId: idSchema.optional(),
    key: attributeKeySchema.optional(),
    version: z.coerce.number().int().min(1).optional(),
  })
  .strict();

/** `GET /catalog-attributes/facets`. */
export const attributeFacetQuerySchema = z.object({ categoryId: idSchema }).strict();

/**
 * `GET /catalog-attributes/values/:entityKind/:entityId`.
 *
 * Two OPTIONAL display preferences and nothing else. `.strict()`, so a client
 * cannot smuggle in a unit, a magnitude or a precision: this endpoint chooses
 * how a stored measurement is SHOWN, and a body or query able to carry a number
 * is where one would eventually be trusted (the `checkoutSchema` reasoning).
 *
 * `unitSystem` is the shopper's own preference, which the storefront reads off
 * the DEVICE's CLDR measurement system. `market` is the fallback for a client
 * that has a market and no stated preference — and it is deliberately a SECOND
 * parameter rather than something the server derives from a locale, because a
 * shopper reading Spanish in Ohio is in a US-customary market and taking the
 * system off the reading language is the collapse ADR 0007 D4 forbids. Neither
 * is required, and with neither present the response is byte-identical to what
 * it was before they existed.
 */
export const attributeValuesQuerySchema = z
  .object({
    unitSystem: z.enum(MEASUREMENT_SYSTEM_VALUES).optional(),
    market: z.string().trim().regex(/^[A-Za-z]{2}$/u).optional(),
  })
  .strict();

/** `GET /internal/catalog-attributes/coverage`. */
export const attributeCoverageQuerySchema = z
  .object({
    entityKind: z.enum(ENTITY_KIND_VALUES).optional(),
    categoryId: idSchema.optional(),
    catalogSourceId: idSchema.optional(),
  })
  .strict();

/** `GET /internal/catalog-attributes/reviews`. */
export const attributeReviewQuerySchema = z
  .object({
    attributeKey: attributeKeySchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

/**
 * The parsed body types, written out rather than inferred with `z.infer`.
 *
 * The backend compiles with `strict: false`, under which `undefined extends T`
 * holds for every `T` — so zod's `addQuestionMarks` marks EVERY key optional and
 * `z.infer` produces a type in which nothing is required. That is not a
 * cosmetic annoyance: a handler reading `body.key` would be typed `string |
 * undefined` and every call site would grow a guard for a field the schema
 * guarantees. The existing `canonical-catalog-operator.controller.ts` writes its
 * body shapes out for the same reason; these do it here, once, beside the schema
 * they describe, rather than at each handler.
 */
export interface AttributeDefinitionDraftBody {
  key: string;
  label: string;
  description?: string;
  valueType: AttributeValueType;
  cardinality?: AttributeCardinality;
  objectivity?: AttributeObjectivity;
  unitFamily?: UnitFamily;
  ratingScaleMax?: number;
  currency?: CurrencyCode;
  componentAxes?: AttributeComponentAxis[];
  minValue?: number;
  maxValue?: number;
  decimalPlaces?: number;
  maxLength?: number;
  implausibleAbove?: number;
  implausibleBelow?: number;
  variantDefining?: boolean;
  filterable?: boolean;
  sortable?: boolean;
  comparable?: boolean;
  hardConstraintCapable?: boolean;
  displayPolicy?: AttributeDisplayPolicy;
  evidencePolicy?: AttributeEvidencePolicy;
  enumValues?: { value: string; label: string; aliases?: string[] }[];
  labels?: { locale: string; label: string; description?: string }[];
  categoryScopes?: { categoryId: string; includeDescendants?: boolean }[];
}

export interface AttributeSourceMappingBody {
  catalogSourceId: string;
  sourceField: string;
  attributeKey: string;
  assumedUnit?: string;
  componentAxis?: AttributeComponentAxis;
  categoryIds?: string[];
  note?: string;
}

export interface AttributeObservationBody {
  entityKind: AttributeEntityKind;
  entityId: string;
  attributeKey: string;
  displayValue: string;
  sourceRecordId: string;
  catalogSourceId?: string;
  sourceField?: string;
  method?: SourceLinkMethod;
  locale?: string;
  confidence?: number;
}

export interface AttributeReviewResolveBody {
  state: 'resolved' | 'dismissed';
  selectedValueId?: string;
  note?: string;
}

/** The two optional display preferences of the public values route. */
export interface AttributeValuesQuery {
  unitSystem?: MeasurementSystem;
  market?: string;
}

export interface ConstraintSetValidateBody {
  categoryId?: string;
  constraints: unknown[];
}

export interface ConstraintSetEvaluateBody {
  categoryId?: string;
  productId: string;
  variantId?: string;
  currency?: CurrencyCode;
  territory?: string;
  constraints: unknown[];
}
