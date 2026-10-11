/**
 * The OpenAPI 3.1 document for `/public/v1`, built from the route registry and
 * the named schemas — never from route files.
 *
 * It is committed (`packages/contracts/openapi.json`, written by
 * `bun run openapi:generate`) and served at `/public/v1/openapi.json`;
 * `scripts/check-public-openapi.mjs` fails the build when the committed bytes
 * are not what this function produces, or when the document stops describing
 * what a consumer's client is generated from.
 *
 * Output is deterministic: paths and component names are sorted, so a
 * regeneration diff is the semantic diff and nothing else.
 */

import { z } from 'zod';
import { MERCARIA_PUBLIC_ERROR_STATUS, type MercariaPublicErrorCode } from './errors';
import {
  CONTRACT_JSON_SCHEMA_NAMES,
  JSON_SCHEMA_OPTIONS,
  contractSchemaRegistry,
  type JsonSchemaDocument,
} from './json-schema';
import { MERCARIA_PUBLIC_LIST_MAX_OFFSET } from './pagination';
import {
  MERCARIA_PUBLIC_API_BASE_PATH,
  MERCARIA_PUBLIC_API_ORIGIN,
  MERCARIA_PUBLIC_API_VERSION,
  MERCARIA_PUBLIC_ROUTES,
  MERCARIA_PUBLIC_ROUTE_TAGS,
  MERCARIA_PUBLIC_UNIVERSAL_ERRORS,
  type MercariaPublicRoute,
} from './routes';

/** The OpenAPI document, as plain JSON. */
export type OpenApiDocument = {
  openapi: '3.1.0';
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  tags: { name: string }[];
  security: Record<string, string[]>[];
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, JsonSchemaDocument>;
    securitySchemes: Record<string, unknown>;
  };
};

const schemaRef = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const ERROR_DESCRIPTIONS: Record<MercariaPublicErrorCode, string> = {
  bad_request:
    'Malformed: a wrong type, a missing field, an unknown or repeated parameter, or a cursor from another list.',
  unauthorized: 'No credentials, or credentials that did not verify.',
  forbidden: 'Authenticated, but not permitted.',
  not_found: 'The entity never existed, or the id is malformed.',
  unknown_route: 'No such route.',
  gone: 'The entity existed and is no longer publicly available. Says nothing about why.',
  conflict: 'Conflicts with current state.',
  validation_failed: 'Well-formed, but a value is refused.',
  rate_limited: 'Rate limit hit. `details.retryAfterSeconds` and `Retry-After` say when to retry.',
  internal_error: 'Unexpected server defect.',
  service_unavailable: 'Degraded or not yet ready.',
};

/** A field's JSON Schema with the document-level keys a parameter must not carry. */
function fieldSchema(field: z.ZodType): JsonSchemaDocument {
  const {
    $schema: _schema,
    description: _description,
    ...schema
  } = z.toJSONSchema(field, JSON_SCHEMA_OPTIONS);
  return schema;
}

function parameters(route: MercariaPublicRoute): unknown[] {
  const result: unknown[] = [];
  const add = (location: 'path' | 'query', shape: Record<string, z.ZodType>) => {
    for (const [name, field] of Object.entries(shape)) {
      const description = field.description;
      result.push({
        name,
        in: location,
        required: location === 'path' || !field.safeParse(undefined).success,
        ...(description === undefined ? {} : { description }),
        schema: fieldSchema(field),
      });
    }
  };
  if (route.params) add('path', route.params.shape);
  if (route.query instanceof z.ZodObject) add('query', route.query.shape);
  return result;
}

function responses(route: MercariaPublicRoute): Record<string, unknown> {
  const result: Record<string, unknown> = {
    '200': {
      description: route.summary,
      content: { 'application/json': { schema: schemaRef(route.response) } },
    },
  };
  const codes = [
    ...new Set<MercariaPublicErrorCode>([...MERCARIA_PUBLIC_UNIVERSAL_ERRORS, ...route.errors]),
  ];
  const byStatus = new Map<number, MercariaPublicErrorCode[]>();
  for (const code of codes) {
    const status = MERCARIA_PUBLIC_ERROR_STATUS[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  for (const status of [...byStatus.keys()].sort((a, b) => a - b)) {
    const statusCodes = byStatus.get(status) ?? [];
    result[String(status)] = {
      description: statusCodes.map((code) => `\`${code}\`: ${ERROR_DESCRIPTIONS[code]}`).join(' '),
      ...(status === MERCARIA_PUBLIC_ERROR_STATUS.rate_limited
        ? {
            headers: {
              'Retry-After': {
                description: 'Seconds until the caller may retry.',
                schema: { type: 'integer', minimum: 0 },
              },
            },
          }
        : {}),
      content: { 'application/json': { schema: schemaRef('MercariaErrorBody') } },
    };
  }
  return result;
}

function operation(route: MercariaPublicRoute): Record<string, unknown> {
  const params = parameters(route);
  return {
    operationId: route.operationId,
    tags: [route.tag],
    summary: route.summary,
    description: route.description,
    ...(params.length === 0 ? {} : { parameters: params }),
    responses: responses(route),
  };
}

/** Every named schema as a component, `$ref`-linked, without per-document keys. */
function componentSchemas(): Record<string, JsonSchemaDocument> {
  const { schemas } = z.toJSONSchema(contractSchemaRegistry(), {
    ...JSON_SCHEMA_OPTIONS,
    uri: (id) => `#/components/schemas/${id}`,
  });
  const result: Record<string, JsonSchemaDocument> = {};
  for (const name of [...CONTRACT_JSON_SCHEMA_NAMES].sort()) {
    const converted = schemas[name];
    if (converted === undefined)
      throw new Error(`the schema registry produced no component for ${name}`);
    const { $schema: _schema, $id: _id, ...schema } = converted;
    result[name] = schema;
  }
  return result;
}

/** Build the OpenAPI document. Pure and deterministic. */
export function mercariaPublicOpenApiDocument(): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of [...MERCARIA_PUBLIC_ROUTES].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    if (paths[route.path]?.[route.method] !== undefined) {
      throw new Error(`two registry entries describe ${route.method.toUpperCase()} ${route.path}`);
    }
    paths[route.path] = { ...paths[route.path], [route.method]: operation(route) };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Mercaria public API',
      version: MERCARIA_PUBLIC_API_VERSION,
      description:
        'Read-only commerce data for other Oxy applications: products, stores, collections and locations. ' +
        'Success bodies are the value itself; every error is `{ "error": { "code", "message", "details"? } }`. ' +
        `Lists are \`{ items, nextCursor }\` and end at ${MERCARIA_PUBLIC_LIST_MAX_OFFSET} items. ` +
        'Generated from `@mercaria/contracts`; `@mercaria.co/sdk` is the supported client.',
    },
    servers: [{ url: `${MERCARIA_PUBLIC_API_ORIGIN}${MERCARIA_PUBLIC_API_BASE_PATH}` }],
    tags: MERCARIA_PUBLIC_ROUTE_TAGS.map((name) => ({ name })),
    // Anonymous, or an Oxy bearer token: nothing here requires a session, and a
    // verified one only adds `viewer` facts to a product.
    security: [{}, { oxyBearer: [] }],
    paths,
    components: {
      schemas: componentSchemas(),
      securitySchemes: {
        oxyBearer: {
          type: 'http',
          scheme: 'bearer',
          description:
            'An Oxy access token. Optional; a token that does not verify is read as anonymous.',
        },
      },
    },
  };
}
