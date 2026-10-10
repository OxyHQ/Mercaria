import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  CONTRACT_JSON_SCHEMA_NAMES,
  MERCARIA_PUBLIC_CURSOR_KINDS,
  MERCARIA_PUBLIC_ROUTES,
  MercariaPageQuerySchema,
  MercariaProductSearchQuerySchema,
  MercariaStoreLookupQuerySchema,
  classifyRequestIssues,
  expressRoutePath,
  mercariaPublicOpenApiDocument,
} from '../src/index';

function refusal(schema: z.ZodType, query: unknown) {
  const result = schema.safeParse(query);
  if (result.success) throw new Error(`expected ${JSON.stringify(query)} to be refused`);
  return classifyRequestIssues(result.error.issues);
}

describe('request errors: shape is bad_request, value is validation_failed', () => {
  it('an unknown parameter is bad_request naming it', () => {
    expect(refusal(MercariaPageQuerySchema, { limt: '5' })).toMatchObject({
      code: 'bad_request',
      details: { field: 'limt' },
    });
  });

  it('a repeated parameter (an array from Express) is bad_request', () => {
    expect(refusal(MercariaProductSearchQuerySchema, { q: ['a', 'b'] })).toMatchObject({
      code: 'bad_request',
      details: { field: 'q' },
    });
  });

  it('a limit that is not a whole number is bad_request; one out of range is validation_failed', () => {
    expect(refusal(MercariaPageQuerySchema, { limit: '1e1' }).code).toBe('bad_request');
    expect(refusal(MercariaPageQuerySchema, { limit: '0' })).toMatchObject({
      code: 'validation_failed',
      details: { field: 'limit' },
    });
    expect(refusal(MercariaPageQuerySchema, { limit: '51' }).code).toBe('validation_failed');
  });

  it('a missing required parameter is bad_request; a blank one is validation_failed', () => {
    expect(refusal(MercariaStoreLookupQuerySchema, {}).code).toBe('bad_request');
    expect(refusal(MercariaStoreLookupQuerySchema, { handle: '  ' }).code).toBe(
      'validation_failed',
    );
  });

  it('a cross-field rule and an unknown enum value are validation_failed', () => {
    expect(refusal(MercariaProductSearchQuerySchema, { sort: 'relevance' })).toMatchObject({
      code: 'validation_failed',
      details: { field: 'sort' },
    });
    expect(refusal(MercariaProductSearchQuerySchema, { sort: 'cheapest' }).code).toBe(
      'validation_failed',
    );
  });

  it('shape wins over value when a request has both', () => {
    expect(refusal(MercariaPageQuerySchema, { limit: '0', extra: '1' }).code).toBe('bad_request');
  });

  it('parses exact spellings into typed values', () => {
    expect(
      MercariaProductSearchQuerySchema.parse({ limit: '050', inStock: 'false', q: ' x ' }),
    ).toEqual({
      limit: 50,
      inStock: false,
      q: 'x',
    });
  });
});

describe('the route registry', () => {
  it('names each operation once and each method+path once', () => {
    const ids = MERCARIA_PUBLIC_ROUTES.map((route) => route.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = MERCARIA_PUBLIC_ROUTES.map((route) => `${route.method} ${route.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('declares exactly the path parameters each template names', () => {
    for (const route of MERCARIA_PUBLIC_ROUTES) {
      const templated = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
      const declared = route.params ? Object.keys(route.params.shape).sort() : [];
      expect(declared, route.operationId).toEqual(templated);
    }
  });

  it('answers every 200 with a named schema', () => {
    for (const route of MERCARIA_PUBLIC_ROUTES) {
      expect(CONTRACT_JSON_SCHEMA_NAMES as readonly string[], route.operationId).toContain(
        route.response,
      );
    }
  });

  it('gives every list route its own cursor kind, and every kind a route', () => {
    const lists = MERCARIA_PUBLIC_ROUTES.filter((route) => route.cursorKind !== null);
    expect(lists.map((route) => route.cursorKind).sort()).toEqual(
      [...MERCARIA_PUBLIC_CURSOR_KINDS].sort(),
    );
    for (const route of lists) expect(route.response, route.operationId).toMatch(/Page$/);
  });

  it('registers /stores/lookup before /stores/{id}, or Express reads lookup as an id', () => {
    const paths = MERCARIA_PUBLIC_ROUTES.map((route) => route.path);
    expect(paths.indexOf('/stores/lookup')).toBeLessThan(paths.indexOf('/stores/{id}'));
  });

  it('lets a GoWay consumer ask for a place’s locations, and only by place', () => {
    const route = MERCARIA_PUBLIC_ROUTES.find((entry) => entry.operationId === 'listLocations');
    expect(route?.query.safeParse({ goWayPlaceId: ' plc_1 ' }).data).toEqual({
      goWayPlaceId: 'plc_1',
    });
    expect(refusal(route!.query, {}).code).toBe('bad_request');
    expect(refusal(route!.query, { goWayPlaceId: 'x'.repeat(129) })).toMatchObject({
      code: 'validation_failed',
      details: { field: 'goWayPlaceId' },
    });
  });

  it('answers service_unavailable — never only gone — on every read that asks GoWay', () => {
    for (const route of MERCARIA_PUBLIC_ROUTES.filter(
      (entry) => entry.tag === 'locations' || entry.path.endsWith('/locations'),
    )) {
      expect(route.errors as readonly string[], route.operationId).toContain('service_unavailable');
    }
  });

  it('spells an Express path from a template', () => {
    expect(expressRoutePath('/collections/{id}/products')).toBe('/collections/:id/products');
    expect(expressRoutePath('/products')).toBe('/products');
  });
});

describe('the OpenAPI document', () => {
  const document = mercariaPublicOpenApiDocument();
  const serialized = JSON.stringify(document);

  it('describes every registry operation, with a unique operationId', () => {
    const operations = Object.values(document.paths).flatMap((item) => Object.values(item)) as {
      operationId: string;
    }[];
    expect(operations.map((op) => op.operationId).sort()).toEqual(
      MERCARIA_PUBLIC_ROUTES.map((route) => route.operationId).sort(),
    );
  });

  it('speaks OpenAPI 3.1: no `nullable`, no boolean exclusive bounds', () => {
    expect(serialized).not.toContain('"nullable"');
    expect(serialized).not.toMatch(/"exclusive(?:Minimum|Maximum)":(?:true|false)/);
  });

  it('resolves every $ref to a component', () => {
    for (const [, name] of serialized.matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)) {
      expect(document.components.schemas, name).toHaveProperty(name!);
    }
  });

  it('is deterministic', () => {
    expect(JSON.stringify(mercariaPublicOpenApiDocument())).toBe(serialized);
  });
});
