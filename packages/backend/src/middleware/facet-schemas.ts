/**
 * The wire contract for `/facets` (#367 Workstream 10).
 *
 * `.strict()` everywhere, which is load bearing rather than tidy: a facet
 * request is a set of stable KEYS, and an undeclared field is either a client
 * sending a label where a key belongs (ADR 0007 D1's failure) or a client
 * sending a weight where none may exist. Stripping it silently would let both
 * ship; refusing names the mistake at the boundary.
 *
 * A POST rather than a GET, and it is worth saying why the usual reasoning does
 * not apply. A facet rail IS a read and a GET would be cacheable — but the
 * selection is a nested, repeated structure with per-entry numeric bounds, and
 * every URL encoding of one is a small parser somebody has to agree on. #70's
 * `SearchFilters` shows the cost: eleven flat parameters, and the two that need
 * structure (`attributes`, `price`) are the two that need documentation. The
 * response carries nothing viewer-specific, so a caching layer keys on the body.
 */

import { z } from 'zod';
import {
  ALL_CURRENCY_CODES,
  FACET_COMMERCE_DIMENSIONS,
  FACET_MAX_SCOPE_PRODUCT_IDS,
  FACET_MAX_SELECTION_VALUES,
  FACET_MAX_SELECTIONS,
  FACET_TAXONOMY_KEY,
  MAX_MONEY_MINOR_UNITS,
} from '@mercaria/shared-types';

const idSchema = z.string().trim().min(1).max(64);

/** A #94 registry key. The same shape `attribute_definitions_key_format` holds. */
const attributeKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/u);

/** A controlled value, a market code, a condition segment — always a stable key. */
const valueKeySchema = z.string().trim().min(1).max(128);

/**
 * A money bound.
 *
 * `z.number().int()` alone accepts `1e300`; `MAX_MONEY_MINOR_UNITS` is what makes
 * the check real, and it is the same ceiling every money boundary in this
 * repository applies.
 */
const minorUnitsSchema = z.number().int().min(0).max(MAX_MONEY_MINOR_UNITS);

/** A magnitude in an attribute's BASE unit — never the source's own unit. */
const magnitudeSchema = z.number().finite();

const attributeSelectionSchema = z
  .object({
    origin: z.literal('attribute'),
    facetKey: attributeKeySchema,
    values: z.array(valueKeySchema).min(1).max(FACET_MAX_SELECTION_VALUES).optional(),
    min: magnitudeSchema.optional(),
    max: magnitudeSchema.optional(),
  })
  .strict();

const commerceSelectionSchema = z
  .object({
    origin: z.literal('commerce'),
    facetKey: z.enum(FACET_COMMERCE_DIMENSIONS as unknown as [string, ...string[]]),
    values: z.array(valueKeySchema).min(1).max(FACET_MAX_SELECTION_VALUES).optional(),
    minMinor: minorUnitsSchema.optional(),
    maxMinor: minorUnitsSchema.optional(),
    currency: z.enum(ALL_CURRENCY_CODES as unknown as [string, ...string[]]).optional(),
  })
  .strict();

const taxonomySelectionSchema = z
  .object({
    origin: z.literal('taxonomy'),
    facetKey: z.literal(FACET_TAXONOMY_KEY),
    values: z.array(idSchema).min(1).max(FACET_MAX_SELECTION_VALUES),
  })
  .strict();

/**
 * The selection union, discriminated on a STRING.
 *
 * The backend compiles with `strict: false`, so a boolean-literal discriminant
 * would not narrow — measured in #68 and again in #110. `origin` is the same
 * discriminant the DTO carries, so the wire shape and the type agree.
 */
const selectionEntrySchema = z
  .discriminatedUnion('origin', [
    attributeSelectionSchema,
    commerceSelectionSchema,
    taxonomySelectionSchema,
  ])
  // The cross-field rules live on the UNION rather than on its members, because
  // `z.discriminatedUnion` accepts only plain objects and a `.refine()` on a
  // member yields a `ZodEffects` it cannot read the discriminant off. Same
  // rules, one level out.
  .superRefine((entry, ctx) => {
    if (entry.origin === 'attribute') {
      if (entry.values === undefined && entry.min === undefined && entry.max === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'An attribute selection must carry values or a bound.',
        });
      }
      if (entry.min !== undefined && entry.max !== undefined && entry.min > entry.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'An attribute selection\u2019s lower bound must not exceed its upper bound.',
        });
      }
      return;
    }
    if (entry.origin !== 'commerce') return;
    if (entry.minMinor !== undefined && entry.maxMinor !== undefined && entry.minMinor > entry.maxMinor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A price bound\u2019s lower end must not exceed its upper end.',
      });
    }
    // A bound with no currency is not a bound. Every money rule in this
    // repository says an amount names its own currency, and a facet that
    // guessed one would compare raw minor units across currencies.
    if (
      entry.facetKey === 'offer_price' &&
      !((entry.minMinor !== undefined || entry.maxMinor !== undefined) && entry.currency !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A price bound must name its currency.',
      });
    }
  });

const scopeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('category'),
      categoryId: idSchema,
      includeDescendants: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('canonical_products'),
      canonicalProductIds: z.array(idSchema).min(1).max(FACET_MAX_SCOPE_PRODUCT_IDS),
    })
    .strict(),
]);

/** `POST /facets`. */
export const facetRequestSchema = z
  .object({
    scope: scopeSchema,
    selection: z.array(selectionEntrySchema).max(FACET_MAX_SELECTIONS).optional(),
    /** BCP-47. Validated against the supported set by the resolver, not here. */
    locale: z.string().trim().min(2).max(35).optional(),
    currency: z.enum(ALL_CURRENCY_CODES as unknown as [string, ...string[]]).optional(),
    sort: z
      .object({ key: z.string().trim().min(1).max(64), direction: z.string().trim().min(1).max(8) })
      .strict()
      .optional(),
  })
  .strict();

/**
 * The validated body, spelled by hand.
 *
 * `z.infer` is not used and must not be: the backend compiles with
 * `strict: false`, so zod's inference collapses every `T | undefined` and hands
 * back a shape whose REQUIRED fields all read as optional — which is how a
 * discriminant becomes `kind?: 'category'` and stops narrowing anything. Writing
 * the type out is the same choice `catalog-attributes.controller.ts` makes for
 * its query, and the schema above is what guarantees it at runtime.
 */
export interface FacetRequestBody {
  readonly scope:
    | { readonly kind: 'category'; readonly categoryId: string; readonly includeDescendants?: boolean }
    | { readonly kind: 'canonical_products'; readonly canonicalProductIds: string[] };
  readonly selection?: {
    readonly origin: 'attribute' | 'commerce' | 'taxonomy';
    readonly facetKey: string;
    readonly values?: string[];
    readonly min?: number;
    readonly max?: number;
    readonly minMinor?: number;
    readonly maxMinor?: number;
    readonly currency?: string;
  }[];
  readonly locale?: string;
  readonly currency?: string;
  readonly sort?: { readonly key: string; readonly direction: string };
}
