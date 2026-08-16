/**
 * Request schemas for the catalog authoring surface (#367 step 5, ADR 0007 D10).
 *
 * Every object is `.strict()`, so an undeclared key is REFUSED rather than
 * stripped. That is the stronger posture and the reason is #63's: silently
 * dropping a key a client thought it sent is how a merchant's answer disappears
 * with every surface reporting success.
 *
 * ## What no schema here can carry
 *
 * A `category: string` NAME, an `optionName`, an `attributeName` or a bare
 * `value` where an id or a key belongs — ADR 0007 D1 rule 3, and the reason a
 * field answer names an `attributeKey` (a stable machine key) while a controlled
 * value names an `enumValueId` (a row id). A schema that accepted a label would
 * make identity depend on presentation, which is the single invariant this whole
 * epic exists to establish.
 *
 * A price, a stock level or a condition as a product-type FIELD is likewise
 * unrepresentable: `fields` carries attribute keys, and #94's reserved-key CHECK
 * refuses to define any of them as an attribute at all.
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  ATTRIBUTE_COMPONENT_AXES,
  AUTHORING_CANONICAL_REF_KINDS,
  AUTHORING_DRAFT_STATUSES,
  MAX_MONEY_MINOR_UNITS,
  PRODUCT_TYPE_AUTHORING_FLOWS,
} from '@mercaria/shared-types';

/** A shared-types list as the non-empty tuple `z.enum` requires. */
function tuple<T extends string>(values: readonly T[]): readonly [T, ...T[]] {
  const [first, ...rest] = values;
  if (first === undefined) {
    throw new Error('An empty enum accepts nothing and types every value never');
  }
  return [first, ...rest];
}

const entityId = z.string().trim().min(1).max(64);

/**
 * A stable machine key — lowercase, snake_case, anchored.
 *
 * The SAME pattern `attribute_definitions_key_shape_check` renders, so a key
 * this surface accepts and a key the database stores cannot diverge. The message
 * names the rule rather than the regex, because an author's client shows it.
 */
const attributeKey = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(
    /^[a-z][a-z0-9_]*$/u,
    'an attribute is named by its stable machine key (ADR 0007 D1); a label is not a key',
  );

/** A product-type key. Dots are permitted — ADR 0007 D1's documented namespace. */
const productTypeKey = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/u,
    'a product type is named by its stable machine key (ADR 0007 D1)',
  );

/**
 * A BCP 47 tag, lower-cased HERE rather than refused.
 *
 * The stored form is folded (`catalog_authoring_drafts_locale_shape_check`), so
 * this is what makes a read find it. Refusing `es-MX` instead would answer a
 * legitimate Spanish request with a 400 over a case convention the tag itself
 * declares insignificant.
 */
const locale = z
  .string()
  .trim()
  .min(2)
  .max(35)
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u, 'a locale is a BCP-47 tag')
  .transform((value) => value.toLowerCase());

const market = z
  .string()
  .trim()
  .length(2)
  .regex(/^[A-Za-z]{2}$/u, 'a market is an ISO 3166-1 alpha-2 code')
  .transform((value) => value.toUpperCase());

const money = z
  .object({
    amount: z.number().int().min(0).max(MAX_MONEY_MINOR_UNITS),
    currency: z.enum(tuple(ALL_CURRENCY_CODES)),
  })
  .strict();

/**
 * One answer.
 *
 * `.strict()` plus a refinement counting the populated value members, because
 * zod has no "exactly one of" and the CHECK that enforces it lives in Postgres
 * — a request carrying two would otherwise reach the database and fail as a
 * constraint name no client can act on.
 */
const answer = z
  .object({
    ordinal: z.number().int().min(0).max(64).optional(),
    componentAxis: z.enum(tuple(ATTRIBUTE_COMPONENT_AXES)).optional(),
    text: z.string().max(4096).optional(),
    number: z.number().finite().optional(),
    boolean: z.boolean().optional(),
    enumValueId: entityId.optional(),
    canonicalRef: z
      .object({ kind: z.enum(tuple(AUTHORING_CANONICAL_REF_KINDS)), id: entityId })
      .strict()
      .optional(),
    unit: z.string().trim().min(1).max(32).optional(),
  })
  .strict()
  .refine(
    (value) =>
      [value.text, value.number, value.boolean, value.enumValueId, value.canonicalRef].filter(
        (entry) => entry !== undefined,
      ).length === 1,
    { message: 'an answer carries exactly one of text, number, boolean, enumValueId or canonicalRef' },
  );

/** The answers for one field. An empty `values` CLEARS it — a real request. */
const fieldAnswers = z
  .object({ attributeKey, values: z.array(answer).max(64) })
  .strict();

const variantInput = z
  .object({
    title: z.string().trim().max(255).optional(),
    sku: z.string().trim().max(255).optional(),
    barcode: z.string().trim().max(255).optional(),
    price: money.optional(),
    compareAtPrice: money.optional(),
    inventoryTracked: z.boolean().optional(),
    inventoryAvailable: z.number().int().min(0).max(1_000_000),
    axes: z.array(fieldAnswers).max(16),
    selectedCanonicalVariantId: entityId.nullable().optional(),
  })
  .strict();

/** `POST /stores/:storeId/product-drafts`. */
export const createProductDraftSchema = z
  .object({
    categoryId: entityId,
    productTypeKey,
    version: z.number().int().min(1).optional(),
    flow: z.enum(tuple(PRODUCT_TYPE_AUTHORING_FLOWS)).optional(),
    locale: locale.optional(),
    market,
    title: z.string().trim().max(255).optional(),
    description: z.string().trim().max(20_000).optional(),
  })
  .strict();

/**
 * `PATCH /stores/:storeId/product-drafts/:draftId`.
 *
 * `version` is REQUIRED and is the compare-and-swap token. Making it optional
 * would give a client a way to opt out of the concurrency control by omitting a
 * field — which is the same as not having one, for every client that forgets.
 */
export const patchProductDraftSchema = z
  .object({
    version: z.number().int().min(1),
    title: z.string().trim().max(255).nullable().optional(),
    description: z.string().trim().max(20_000).nullable().optional(),
    imageFileIds: z.array(entityId).max(64).optional(),
    tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
    selectedCanonicalProductId: entityId.nullable().optional(),
    fields: z.array(fieldAnswers).max(256).optional(),
    variants: z.array(variantInput).max(200).optional(),
  })
  .strict();

/** `POST /stores/:storeId/product-drafts/:draftId/upgrade`. */
export const upgradeProductDraftSchema = z
  .object({ version: z.number().int().min(1), targetDefinitionId: entityId })
  .strict();

/** `DELETE /stores/:storeId/product-drafts/:draftId`. */
export const discardProductDraftQuerySchema = z
  .object({ version: z.coerce.number().int().min(1) })
  .strict();

/** `GET /stores/:storeId/product-drafts`. */
export const listProductDraftsQuerySchema = z
  .object({
    status: z.enum(tuple(AUTHORING_DRAFT_STATUSES)).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).max(10_000).optional(),
  })
  .strict();

/** `GET /catalog-authoring/categories`. */
export const authoringCategoriesQuerySchema = z
  .object({
    /** Absent means the whole selectable set; `null` is not expressible in a query. */
    parentId: entityId.optional(),
    /** `true` restricts to top-level nodes, which `parentId` cannot express. */
    roots: z.enum(['true', 'false']).optional(),
    locale: locale.optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

/** `GET /catalog-authoring/product-types?categoryId=`. */
export const authoringProductTypesQuerySchema = z
  .object({ categoryId: entityId, locale: locale.optional() })
  .strict();

/** `GET /catalog-authoring/schemas/:productTypeKey`. */
export const authoringSchemaQuerySchema = z
  .object({
    categoryId: entityId,
    version: z.coerce.number().int().min(1).optional(),
    flow: z.enum(tuple(PRODUCT_TYPE_AUTHORING_FLOWS)).optional(),
    locale: locale.optional(),
    market,
  })
  .strict();

/**
 * `GET /catalog-authoring/canonical-search`.
 *
 * `q` has a floor of two characters. A one-character trigram query is a scan of
 * the whole canonical catalogue that returns whatever sorted first, which is
 * both a slow read and a candidate list an author would be wrong to trust.
 */
export const authoringCanonicalSearchQuerySchema = z
  .object({
    q: z.string().trim().min(2).max(200),
    kind: z.enum(['canonical_product', 'brand']).optional(),
    canonicalProductId: entityId.optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();
