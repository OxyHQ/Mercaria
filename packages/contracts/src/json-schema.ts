/**
 * Every NAMED schema of the contract, and its JSON Schema.
 *
 * The names are the OpenAPI component names (`#/components/schemas/<name>`) and
 * the names `mercariaJsonSchema(name)` answers, so a schema a route responds
 * with is the same document a non-TypeScript integrator downloads.
 *
 * **What JSON Schema does NOT carry.** zod refinements have no JSON Schema
 * equivalent and are dropped by the conversion: a condition key belonging to
 * its group, a purchase option naming its own product, `relevance` requiring
 * `q`. A payload that passes the JSON Schema is well-FORMED; the zod schema is
 * the authority, and it is what the backend and the SDK run.
 */

import { z } from 'zod';
import {
  MercariaCollectionSchema,
  MercariaProductConditionSchema,
  MercariaProductSchema,
  MercariaProductSummarySchema,
  MercariaPurchaseOptionSchema,
  MercariaSellerSchema,
  MercariaStoreSchema,
} from './catalog';
import { MercariaErrorBodySchema } from './errors';
import { MercariaLocationProductSchema, MercariaLocationSchema } from './locations';
import {
  MercariaCollectionPageSchema,
  MercariaLocationPageSchema,
  MercariaLocationProductPageSchema,
  MercariaProductSummaryPageSchema,
} from './pagination';
import { MercariaImageSchema, MercariaMoneySchema } from './primitives';
import {
  MercariaCollectionRefSchema,
  MercariaLocationRefSchema,
  MercariaProductRefSchema,
  MercariaRefSchema,
  MercariaStoreRefSchema,
  MercariaVariantRefSchema,
} from './refs';

/**
 * The OpenAPI document the API serves about itself. Described loosely on
 * purpose: it is generated from this package, and the freshness gate
 * (`scripts/check-public-openapi.mjs`) is what holds it to its own content.
 */
export const MercariaOpenApiDocumentSchema = z.looseObject({
  openapi: z.literal('3.1.0'),
  info: z.looseObject({ title: z.string(), version: z.string() }),
  paths: z.record(z.string(), z.looseObject({})),
});

export const CONTRACT_JSON_SCHEMA_NAMES = [
  'MercariaMoney',
  'MercariaImage',
  'MercariaProductRef',
  'MercariaVariantRef',
  'MercariaStoreRef',
  'MercariaCollectionRef',
  'MercariaLocationRef',
  'MercariaRef',
  'MercariaProductCondition',
  'MercariaSeller',
  'MercariaPurchaseOption',
  'MercariaProductSummary',
  'MercariaProduct',
  'MercariaStore',
  'MercariaCollection',
  'MercariaLocation',
  'MercariaLocationProduct',
  'MercariaProductSummaryPage',
  'MercariaCollectionPage',
  'MercariaLocationPage',
  'MercariaLocationProductPage',
  'MercariaErrorBody',
  'MercariaOpenApiDocument',
] as const;

export type ContractJsonSchemaName = (typeof CONTRACT_JSON_SCHEMA_NAMES)[number];

/**
 * The zod schema behind each published name. `satisfies` an exhaustive
 * `Record`, so a name without a schema — or a schema without a name — is a
 * compile error, and each entry keeps its own type for the route registry.
 */
export const CONTRACT_SCHEMAS = {
  MercariaMoney: MercariaMoneySchema,
  MercariaImage: MercariaImageSchema,
  MercariaProductRef: MercariaProductRefSchema,
  MercariaVariantRef: MercariaVariantRefSchema,
  MercariaStoreRef: MercariaStoreRefSchema,
  MercariaCollectionRef: MercariaCollectionRefSchema,
  MercariaLocationRef: MercariaLocationRefSchema,
  MercariaRef: MercariaRefSchema,
  MercariaProductCondition: MercariaProductConditionSchema,
  MercariaSeller: MercariaSellerSchema,
  MercariaPurchaseOption: MercariaPurchaseOptionSchema,
  MercariaProductSummary: MercariaProductSummarySchema,
  MercariaProduct: MercariaProductSchema,
  MercariaStore: MercariaStoreSchema,
  MercariaCollection: MercariaCollectionSchema,
  MercariaLocation: MercariaLocationSchema,
  MercariaLocationProduct: MercariaLocationProductSchema,
  MercariaProductSummaryPage: MercariaProductSummaryPageSchema,
  MercariaCollectionPage: MercariaCollectionPageSchema,
  MercariaLocationPage: MercariaLocationPageSchema,
  MercariaLocationProductPage: MercariaLocationProductPageSchema,
  MercariaErrorBody: MercariaErrorBodySchema,
  MercariaOpenApiDocument: MercariaOpenApiDocumentSchema,
} as const satisfies Record<ContractJsonSchemaName, z.ZodType>;

/** A JSON Schema document, as the conversion produces it. */
export type JsonSchemaDocument = z.core.JSONSchema.BaseSchema;

/**
 * JSON Schema draft 2020-12 — the dialect OpenAPI 3.1 speaks — on the INPUT
 * side of each schema, which is what a consumer validating a response needs:
 * response objects stay open to added fields, refs and queries stay closed.
 */
export const JSON_SCHEMA_OPTIONS = { target: 'draft-2020-12', io: 'input' } as const;

/** The standalone JSON Schema for one named contract schema. Lazy: nothing converts at import. */
export function mercariaJsonSchema(name: ContractJsonSchemaName): JsonSchemaDocument {
  return z.toJSONSchema(CONTRACT_SCHEMAS[name], JSON_SCHEMA_OPTIONS);
}

/**
 * Every named schema in one zod registry, so a conversion of the whole set
 * writes a `$ref` wherever one named schema contains another. Built per call:
 * a module-level registry would be a side effect of importing the package.
 */
export function contractSchemaRegistry(): z.core.$ZodRegistry<{ id: string }> {
  const registry = z.registry<{ id: string }>();
  for (const name of CONTRACT_JSON_SCHEMA_NAMES) registry.add(CONTRACT_SCHEMAS[name], { id: name });
  return registry;
}
