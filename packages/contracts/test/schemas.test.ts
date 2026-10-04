import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  CONTRACT_JSON_SCHEMA_NAMES,
  CONTRACT_SCHEMAS,
  MERCARIA_PUBLIC_ROUTES,
  MercariaCollectionPageSchema,
  MercariaErrorBodySchema,
  MercariaProductSchema,
  MercariaProductSummaryPageSchema,
  MercariaRefSchema,
  MercariaStoreSchema,
  mercariaErrorBody,
  mercariaJsonSchema,
  type MercariaCollection,
  type MercariaPage,
  type MercariaProductSummary,
} from '../src/index';

export function productWire(id = 'prod_1'): Record<string, unknown> {
  return {
    ref: { kind: 'product', id },
    title: 'Cyberpunk 2077',
    primaryImage: { url: 'https://cdn.mercaria.co/p/1.jpg', alt: 'Box art' },
    price: { amount: 2999, currency: 'EUR' },
    compareAtPrice: null,
    priceRange: null,
    availability: 'in_stock',
    condition: { key: 'used_good', group: 'used' },
    seller: {
      kind: 'store',
      store: { kind: 'store', id: 'store_1' },
      handle: 'night-city-games',
      name: 'Night City Games',
      logoUrl: null,
    },
    url: `https://mercaria.co/products/${id}`,
    description: 'An open-world RPG.',
    images: [],
    purchaseOptions: [
      {
        ref: { kind: 'variant', productId: id, variantId: 'var_1' },
        title: 'PS5',
        price: { amount: 2999, currency: 'EUR' },
        compareAtPrice: null,
        availability: 'in_stock',
      },
    ],
    updatedAt: '2026-09-01T12:00:00.000Z',
    viewer: null,
  };
}

function issuePaths(result: z.ZodSafeParseResult<unknown>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('response schemas', () => {
  it('parse a contract product into a fresh object holding only contract keys', () => {
    const wire = { ...productWire(), sku: 'LEAKED', supplierId: 'x' };
    const parsed = MercariaProductSchema.parse(wire);
    expect(parsed).not.toBe(wire);
    expect('sku' in parsed).toBe(false);
    expect('supplierId' in parsed).toBe(false);
    expect(Object.isFrozen(parsed.ref)).toBe(true);
  });

  it('refuse an unknown closed value, wherever it sits', () => {
    const wire = productWire();
    (wire.price as Record<string, unknown>).currency = 'XXX';
    wire.availability = 'maybe';
    expect(issuePaths(MercariaProductSchema.safeParse(wire)).sort()).toEqual(['availability', 'price.currency']);
  });

  it('refuse a condition whose group is not its key’s group', () => {
    const wire = productWire();
    wire.condition = { key: 'used_good', group: 'new' };
    expect(issuePaths(MercariaProductSchema.safeParse(wire))).toEqual(['condition.group']);
  });

  it('refuse a purchase option that names another product', () => {
    const wire = productWire('prod_1');
    const [option] = wire.purchaseOptions as Record<string, unknown>[];
    option!.ref = { kind: 'variant', productId: 'prod_2', variantId: 'v' };
    expect(issuePaths(MercariaProductSchema.safeParse(wire))).toEqual(['purchaseOptions.0.ref.productId']);
  });

  it('refuse a non-http URL and a malformed timestamp', () => {
    const wire = productWire();
    wire.url = 'javascript:alert(1)';
    wire.updatedAt = 'yesterday';
    expect(issuePaths(MercariaProductSchema.safeParse(wire)).sort()).toEqual(['updatedAt', 'url']);
  });

  it('bound a store’s rating and colour', () => {
    const store = {
      ref: { kind: 'store', id: 's' },
      handle: 'h',
      name: 'n',
      description: null,
      logoUrl: null,
      coverImageUrl: null,
      brandColor: '#ff00aa',
      rating: 4.5,
      reviewCount: 2,
      url: 'https://mercaria.co/stores/h',
    };
    expect(MercariaStoreSchema.safeParse(store).success).toBe(true);
    expect(issuePaths(MercariaStoreSchema.safeParse({ ...store, rating: 6, brandColor: 'red' })).sort()).toEqual([
      'brandColor',
      'rating',
    ]);
  });
});

describe('refs', () => {
  it('in a response drop an added key, like every response object', () => {
    const parsed = MercariaProductSchema.parse({ ...productWire(), ref: { kind: 'product', id: 'prod_1', handle: 'h' } });
    expect(parsed.ref).toEqual({ kind: 'product', id: 'prod_1' });
  });

  it('read back from storage are strict: an extra key is refused, never dropped', () => {
    expect(MercariaRefSchema.safeParse({ kind: 'product', id: 'p' }).success).toBe(true);
    expect(MercariaRefSchema.safeParse({ kind: 'product', id: 'p', title: 'snapshot' }).success).toBe(false);
    expect(MercariaRefSchema.safeParse({ kind: 'product', id: '   ' }).success).toBe(false);
    expect(MercariaRefSchema.safeParse({ kind: 'listing', id: 'p' }).success).toBe(false);
  });
});

describe('pages', () => {
  it('are typed as MercariaPage of their item', () => {
    expectTypeOf<z.infer<typeof MercariaProductSummaryPageSchema>>().toEqualTypeOf<
      MercariaPage<MercariaProductSummary>
    >();
    expectTypeOf<z.infer<typeof MercariaCollectionPageSchema>>().toEqualTypeOf<MercariaPage<MercariaCollection>>();
  });

  it('fail whole when one item is malformed', () => {
    const bad = productWire();
    bad.title = 7;
    expect(
      issuePaths(MercariaProductSummaryPageSchema.safeParse({ items: [productWire(), bad], nextCursor: null })),
    ).toEqual(['items.1.title']);
  });
});

describe('the error body', () => {
  it('is built in one spelling and parses back', () => {
    const body = mercariaErrorBody('rate_limited', 'slow down', { retryAfterSeconds: 30 });
    expect(MercariaErrorBodySchema.parse(body)).toEqual({
      error: { code: 'rate_limited', message: 'slow down', details: { retryAfterSeconds: 30 } },
    });
    expect(mercariaErrorBody('gone', 'x')).toEqual({ error: { code: 'gone', message: 'x' } });
  });

  it('refuses a SCREAMING code and non-scalar details', () => {
    expect(MercariaErrorBodySchema.safeParse({ error: { code: 'NOT_FOUND', message: 'x' } }).success).toBe(false);
    expect(
      MercariaErrorBodySchema.safeParse({ error: { code: 'gone', message: 'x', details: { list: [1] } } }).success,
    ).toBe(false);
  });
});

describe('JSON Schema', () => {
  it('converts every named schema', () => {
    expect(Object.keys(CONTRACT_SCHEMAS).sort()).toEqual([...CONTRACT_JSON_SCHEMA_NAMES].sort());
    for (const name of CONTRACT_JSON_SCHEMA_NAMES) {
      expect(Object.keys(mercariaJsonSchema(name)).length, name).toBeGreaterThan(1);
    }
  });

  it('leaves response objects open and persisted refs closed', () => {
    expect(mercariaJsonSchema('MercariaStore')).not.toHaveProperty('additionalProperties');
    expect(mercariaJsonSchema('MercariaStoreRef')).not.toHaveProperty('additionalProperties');
    expect(JSON.stringify(mercariaJsonSchema('MercariaRef'))).toContain('"additionalProperties":false');
  });
});

/**
 * The identity-string wall the backend holds over its request schemas
 * (`catalog-identity-isolation.test.ts`, `IDENTITY_SHAPED_FIELDS`) and
 * `validate:catalog-identity-contracts` holds over `@mercaria/shared-types`,
 * applied to every request and response shape published here (#1017) — which
 * sit outside both of those walks. The vocabulary is theirs, plus the private
 * storefront facts the field-by-field projection declines to publish.
 */
describe('no public shape carries an ambiguous identity string or a private storefront fact', () => {
  const FORBIDDEN = new Set([
    // IDENTITY_SHAPED_FIELDS
    'category',
    'categoryName',
    'optionName',
    'attributeName',
    'productType',
    'productTypeName',
    'brand',
    'brandName',
    'controlledValue',
    // never published (docs/public-api.md §Deliberately not exposed)
    'vendor',
    'tags',
    'sku',
    'barcode',
  ]);

  function keysOf(schema: z.ZodType, seen = new Set<z.ZodType>()): string[] {
    if (seen.has(schema)) return [];
    seen.add(schema);
    const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
    const children: z.ZodType[] = [];
    const keys: string[] = [];
    if (schema instanceof z.ZodObject) {
      for (const [key, child] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
        keys.push(key);
        children.push(child);
      }
    }
    for (const field of ['innerType', 'element', 'in', 'out', 'options']) {
      const value = def[field];
      if (Array.isArray(value)) children.push(...(value as z.ZodType[]));
      else if (value instanceof z.ZodType) children.push(value);
    }
    return [...keys, ...children.flatMap((child) => keysOf(child, seen))];
  }

  it('walks every named schema and every route’s params and query, and finds none (and can see one)', () => {
    const keys = [
      ...CONTRACT_JSON_SCHEMA_NAMES.flatMap((name) => keysOf(CONTRACT_SCHEMAS[name])),
      ...MERCARIA_PUBLIC_ROUTES.flatMap((route) => [
        ...(route.params ? keysOf(route.params) : []),
        ...keysOf(route.query),
      ]),
    ];
    // Vacuity floor: the walk reached nested response keys and request keys.
    expect(keys).toEqual(
      expect.arrayContaining(['ref', 'currency', 'variantId', 'oxyUserId', 'nextCursor', 'storeId', 'handle', 'limit']),
    );
    expect(keys.filter((key) => FORBIDDEN.has(key))).toEqual([]);
    // Positive control: the same walk sees a forbidden key nested in a page.
    const leaky = z.object({ items: z.array(z.object({ seller: z.object({ brand: z.string() }).nullable() })) });
    expect(keysOf(leaky).filter((key) => FORBIDDEN.has(key))).toEqual(['brand']);
  });
});
