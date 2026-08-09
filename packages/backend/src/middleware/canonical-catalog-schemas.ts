/**
 * Request schemas for the canonical catalogue surfaces (#56).
 *
 * Its own file, following `commerce-graph-schemas.ts` and `payments-schemas.ts`.
 * Every body schema is `.strict()`, which is load-bearing rather than tidy: it
 * is what makes "this request cannot carry X" a property of the schema instead
 * of a habit at every handler.
 *
 * Two absences are the point of the whole surface:
 *
 * - **No `sku` field, anywhere.** A merchant SKU is not a product identifier
 *   (ADR 0002 D14), and the strict schemas mean there is no field through which
 *   one could arrive and be mistaken for one (#56 acceptance 2).
 * - **No `canonicalName` on an observation.** The source-fact endpoints accept
 *   what a source SAID (`sourceTitle`), never what the canonical row should
 *   become, so an ingestion caller has no way to overwrite a curated name —
 *   #56 API rule 4 ("internal upsert APIs accept source facts rather than
 *   arbitrary canonical overwrite"), enforced at the request boundary.
 *
 * Value tuples come from `@mercaria/shared-types`, never retyped — a hand-copied
 * list here could accept a value the database CHECK then refuses.
 */

import { z } from 'zod';
import {
  CANONICAL_ALIAS_KINDS,
  IDENTIFIER_SCHEMES,
  SOURCE_LINK_METHODS,
  type CanonicalAliasKind,
  type IdentifierScheme,
  type SourceLinkMethod,
} from '@mercaria/shared-types';

const ALIAS_KIND_VALUES = CANONICAL_ALIAS_KINDS as readonly [
  CanonicalAliasKind,
  ...CanonicalAliasKind[],
];
const IDENTIFIER_SCHEME_VALUES = IDENTIFIER_SCHEMES as readonly [
  IdentifierScheme,
  ...IdentifierScheme[],
];
const SOURCE_LINK_METHOD_VALUES = SOURCE_LINK_METHODS as readonly [
  SourceLinkMethod,
  ...SourceLinkMethod[],
];

const idSchema = z.string().trim().min(1).max(64);
const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'A slug is lowercase alphanumeric words joined by hyphens');
const nameSchema = z.string().trim().min(1).max(300);
const attributeKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/u, 'An attribute key is a stable machine name: ^[a-z][a-z0-9_]*$');

const aliasSchema = z
  .object({
    alias: nameSchema,
    kind: z.enum(ALIAS_KIND_VALUES),
    language: z.string().trim().min(2).max(35).optional(),
  })
  .strict();

/** `POST /internal/canonical-catalog/product-families`. */
export const productFamilyCreateSchema = z
  .object({
    name: nameSchema,
    slug: slugSchema.optional(),
    description: z.string().trim().max(5_000).optional(),
    brandId: idSchema.optional(),
    categoryId: idSchema.optional(),
    aliases: z.array(aliasSchema).max(50).optional(),
  })
  .strict();

/**
 * `POST /internal/canonical-catalog/products`.
 *
 * `variantDefiningAttributeKeys` is the product's declared option axes — the
 * explicit marking #56 attribute rule 5 asks for. An empty array is meaningful
 * and different from an absent one only in intent; both mean "this product has
 * one default configuration".
 */
export const canonicalProductCreateSchema = z
  .object({
    name: nameSchema,
    slug: slugSchema.optional(),
    description: z.string().trim().max(20_000).optional(),
    brandId: idSchema.optional(),
    familyId: idSchema.optional(),
    categoryId: idSchema.optional(),
    releasedAt: z.coerce.date().optional(),
    modelYear: z.number().int().min(1800).max(2200).optional(),
    modelCode: z.string().trim().min(1).max(120).optional(),
    variantDefiningAttributeKeys: z.array(attributeKeySchema).max(20).optional(),
    searchTokens: z.array(z.string().trim().min(1).max(80)).max(100).optional(),
    aliases: z.array(aliasSchema).max(50).optional(),
  })
  .strict();

/** `POST /internal/canonical-catalog/products/:productId/variants`. */
export const canonicalVariantCreateSchema = z
  .object({
    name: nameSchema.optional(),
    isDefault: z.boolean().optional(),
    releasedAt: z.coerce.date().optional(),
    options: z
      .array(
        z
          .object({
            key: attributeKeySchema,
            value: z.string().trim().min(1).max(300),
            position: z.number().int().min(0).max(100).optional(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

/**
 * `POST /internal/canonical-catalog/products/:productId/observations` — the
 * SOURCE-FACT upsert.
 *
 * The field names say what they are: `sourceTitle` is what the source called the
 * thing, not what the product should be named. There is deliberately no field
 * that sets `name`, `slug`, `status` or `pinnedFields`, so no ingestion caller
 * can reach a curated value through this endpoint at all.
 */
export const canonicalProductObservationSchema = z
  .object({
    sourceId: idSchema,
    externalId: z.string().trim().min(1).max(300),
    observedAt: z.coerce.date(),
    staleAt: z.coerce.date().optional(),
    method: z.enum(SOURCE_LINK_METHOD_VALUES),
    matchRule: z.string().trim().min(1).max(120),
    confidence: z.number().min(0).max(1).optional(),
    sourceTitle: nameSchema.optional(),
    description: z.string().trim().max(20_000).optional(),
    releasedAt: z.coerce.date().optional(),
    modelYear: z.number().int().min(1800).max(2200).optional(),
    modelCode: z.string().trim().min(1).max(120).optional(),
    images: z
      .array(
        z
          .object({
            fileId: idSchema.optional(),
            sourceUrl: z.string().trim().url().max(2_000).optional(),
            alt: z.string().trim().max(500).optional(),
            locale: z.string().trim().min(2).max(35).optional(),
          })
          .strict()
          .refine((image) => image.fileId !== undefined || image.sourceUrl !== undefined, {
            message: 'An image needs either a fileId or a sourceUrl',
          }),
      )
      .max(50)
      .optional(),
    identifiers: z
      .array(
        z
          .object({
            scheme: z.enum(IDENTIFIER_SCHEME_VALUES),
            rawValue: z.string().trim().min(1).max(120),
          })
          .strict(),
      )
      .max(50)
      .optional(),
  })
  .strict();

/** `POST /internal/canonical-catalog/identifiers` — assign one assertion. */
export const identifierAssignSchema = z
  .object({
    productId: idSchema.optional(),
    variantId: idSchema.optional(),
    scheme: z.enum(IDENTIFIER_SCHEME_VALUES),
    rawValue: z.string().trim().min(1).max(120),
    sourceRecordId: idSchema.optional(),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict()
  .refine(
    (body) => (body.productId === undefined) !== (body.variantId === undefined),
    { message: 'Provide exactly one of: productId, variantId' },
  );

/** `POST /internal/canonical-catalog/identifiers/:id/correct`. */
export const identifierCorrectSchema = z
  .object({
    scheme: z.enum(IDENTIFIER_SCHEME_VALUES),
    rawValue: z.string().trim().min(1).max(120),
    note: z.string().trim().min(10).max(2_000),
  })
  .strict();

/**
 * Every merge endpoint's body. The reason is mandatory and long enough to be a
 * sentence — a merge is irreversible in the sense that matters (the loser's slug
 * is never reused), so an audit trail that says only "merged" is not one.
 */
export const canonicalMergeSchema = z
  .object({
    loserId: idSchema,
    reason: z.string().trim().min(10).max(2_000),
  })
  .strict();

/**
 * `GET /canonical-products/lookup` — exactly ONE criterion, refused otherwise.
 *
 * A combined lookup would silently AND or OR them, and the two readings return
 * different products (the `merchantLookupQuerySchema` reasoning).
 */
export const canonicalProductLookupQuerySchema = z
  .object({
    scheme: z.enum(IDENTIFIER_SCHEME_VALUES).optional(),
    identifier: z.string().trim().min(1).max(120).optional(),
    alias: nameSchema.optional(),
    sourceId: idSchema.optional(),
    externalId: z.string().trim().min(1).max(300).optional(),
  })
  .strict()
  .refine((query) => (query.scheme === undefined) === (query.identifier === undefined), {
    message: 'scheme and identifier go together',
  })
  .refine((query) => (query.sourceId === undefined) === (query.externalId === undefined), {
    message: 'sourceId and externalId go together',
  })
  .refine(
    (query) =>
      [query.identifier !== undefined, query.alias !== undefined, query.sourceId !== undefined].filter(
        Boolean,
      ).length === 1,
    { message: 'Provide exactly one of: scheme+identifier, alias, sourceId+externalId' },
  );
