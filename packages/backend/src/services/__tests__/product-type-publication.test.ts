/**
 * `publishProductTypeVersion` — the decisions publication makes before a version
 * becomes permanent (#367, ADR 0007 D5).
 *
 * The repositories are mocked, which is the right depth for exactly this: every
 * assertion here is about a CHOICE the service makes — which refusal, in which
 * order, and whether the incumbent is deprecated before the successor flips. The
 * constraints those choices sit inside (`product_type_definitions_one_published_per_key`,
 * the immutability triggers, the citation trigger) are the database's, have no
 * mocked counterpart, and are asserted against a real server by the realdb suite
 * that lands with the migration. Neither test substitutes for the other.
 *
 * `variant_axis_refused` is the case worth reading twice: the CHECK is still the
 * authority and still holds against `psql`. What this path buys is that an
 * operator publishing a schema is told which attribute and why, instead of a
 * constraint name — and, because the check runs at publication rather than at
 * authoring, that a half-finished draft can still be saved.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findProductTypeDefinitionById = vi.fn();
const findPublishedProductTypeDefinition = vi.fn();
const setProductTypeLifecycleIfIn = vi.fn();
const listProductTypeCategoryScopes = vi.fn();
const listProductTypeFieldGroups = vi.fn();
const listProductTypeFields = vi.fn();

vi.mock('../../db/productTypes/productTypeRepository.js', () => ({
  findProductTypeDefinitionById: (...args: unknown[]) => findProductTypeDefinitionById(...args),
  findPublishedProductTypeDefinition: (...args: unknown[]) =>
    findPublishedProductTypeDefinition(...args),
  setProductTypeLifecycleIfIn: (...args: unknown[]) => setProductTypeLifecycleIfIn(...args),
}));

/**
 * The value-policy agreement read (#367 box 5).
 *
 * Stubbed to AGREE by default — `ad_1` is an `enum` and the fixture field's
 * policy is `controlled_value` — so every case in this file goes on testing the
 * decision it was written for. The contradictions themselves are a file of their
 * own (`product-type-value-policy.test.ts`), one case per shape.
 */
const listAttributeValueTypesByIds = vi.fn();

vi.mock('../../db/attributes/definitionRepository.js', () => ({
  listAttributeValueTypesByIds: (...args: unknown[]) => listAttributeValueTypesByIds(...args),
}));

vi.mock('../../db/productTypes/productTypeFieldRepository.js', () => ({
  listProductTypeCategoryScopes: (...args: unknown[]) => listProductTypeCategoryScopes(...args),
  listProductTypeFieldGroups: (...args: unknown[]) => listProductTypeFieldGroups(...args),
  listProductTypeFields: (...args: unknown[]) => listProductTypeFields(...args),
}));

const { publishProductTypeVersion } = await import('../product-types/product-type.service.js');

/** A `Database` whose `transaction` just runs the callback — the shape under test. */
const db = {
  transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}),
} as never;

const DEFINITION = {
  id: 'ptd_1',
  key: 'smartphone',
  version: 2,
  lifecycle: 'draft',
  name: 'Smartphone',
  description: null,
  pendingProposalPolicy: 'block_publication',
  createdByOxyUserId: 'oxy_author',
  publishedByOxyUserId: null,
  publishedAt: null,
  deprecatedAt: null,
};

function field(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ptf_1',
    productTypeDefinitionId: 'ptd_1',
    groupId: null,
    attributeDefinitionId: 'ad_1',
    attributeKey: 'color',
    attributeDefinitionVersion: 3,
    scope: 'variant',
    flow: 'merchant',
    requirement: 'required',
    valuePolicy: 'controlled_value',
    variantCapable: true,
    position: 0,
    visibilityRule: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listAttributeValueTypesByIds.mockResolvedValue(new Map([['ad_1', 'enum']]));
  findProductTypeDefinitionById.mockResolvedValue(DEFINITION);
  findPublishedProductTypeDefinition.mockResolvedValue(null);
  listProductTypeCategoryScopes.mockResolvedValue([
    { id: 'pts_1', categoryId: 'cat_1', includeDescendants: true },
  ]);
  listProductTypeFieldGroups.mockResolvedValue([]);
  listProductTypeFields.mockImplementation(async (_db: unknown, _id: string, flow: string) =>
    flow === 'merchant' ? [field()] : [],
  );
  setProductTypeLifecycleIfIn.mockImplementation(async (_db: unknown, id: string) => ({
    ...DEFINITION,
    id,
    lifecycle: 'published',
  }));
});

describe('publication refuses a version nothing could use', () => {
  it('refuses one scoped to no category', async () => {
    listProductTypeCategoryScopes.mockResolvedValue([]);
    const result = await publishProductTypeVersion(db, {
      definitionId: 'ptd_1',
      publishedByOxyUserId: 'oxy_op',
    });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.refusal).toBe('no_category_scope');
    expect(setProductTypeLifecycleIfIn).not.toHaveBeenCalled();
  });

  it('refuses one that declares no field in any flow', async () => {
    listProductTypeFields.mockResolvedValue([]);
    const result = await publishProductTypeVersion(db, {
      definitionId: 'ptd_1',
      publishedByOxyUserId: 'oxy_op',
    });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.refusal).toBe('no_fields');
  });

  it('refuses one already published or deprecated', async () => {
    findProductTypeDefinitionById.mockResolvedValue({ ...DEFINITION, lifecycle: 'published' });
    const result = await publishProductTypeVersion(db, {
      definitionId: 'ptd_1',
      publishedByOxyUserId: 'oxy_op',
    });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.refusal).toBe('not_publishable_from_this_lifecycle');
    }
  });

  it('refuses a missing version', async () => {
    findProductTypeDefinitionById.mockResolvedValue(null);
    const result = await publishProductTypeVersion(db, {
      definitionId: 'nope',
      publishedByOxyUserId: 'oxy_op',
    });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.refusal).toBe('definition_not_found');
  });
});

describe('publication refuses a variant axis the CHECK would also refuse', () => {
  it('refuses a compatibility target declared as an axis, naming the attribute', async () => {
    listProductTypeFields.mockImplementation(async (_db: unknown, _id: string, flow: string) =>
      flow === 'merchant'
        ? [field({ attributeKey: 'vehicle_model', scope: 'variant', variantCapable: true })]
        : [],
    );
    const result = await publishProductTypeVersion(db, {
      definitionId: 'ptd_1',
      publishedByOxyUserId: 'oxy_op',
    });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.refusal).toBe('variant_axis_refused');
      expect(result.detail).toContain('vehicle_model');
      // The sentence names the fact, not the constraint — a schema author has no
      // way to act on `product_type_fields_variant_axis_check`.
      expect(result.detail).not.toContain('_check');
    }
  });

  it('refuses a compatibility-SCOPE field declared as an axis', async () => {
    listProductTypeFields.mockImplementation(async (_db: unknown, _id: string, flow: string) =>
      flow === 'merchant'
        ? [field({ attributeKey: 'socket_type', scope: 'compatibility', variantCapable: true })]
        : [],
    );
    const result = await publishProductTypeVersion(db, {
      definitionId: 'ptd_1',
      publishedByOxyUserId: 'oxy_op',
    });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.refusal).toBe('variant_axis_refused');
  });

  it('permits a legitimate axis', async () => {
    const result = await publishProductTypeVersion(db, {
      definitionId: 'ptd_1',
      publishedByOxyUserId: 'oxy_op',
    });
    expect(result.outcome).toBe('published');
  });
});

describe('publication refuses a visibility rule that reads a field nobody declares', () => {
  it('refuses a dangling reference and names both fields and the flow', async () => {
    listProductTypeFields.mockImplementation(async (_db: unknown, _id: string, flow: string) =>
      flow === 'merchant'
        ? [
            field({
              attributeKey: 'storage_capacity',
              variantCapable: false,
              scope: 'product',
              visibilityRule: { node: 'presence', field: 'connectivity', op: 'is_present' },
            }),
          ]
        : [],
    );
    const result = await publishProductTypeVersion(db, {
      definitionId: 'ptd_1',
      publishedByOxyUserId: 'oxy_op',
    });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.refusal).toBe('visibility_rule_names_unknown_field');
      expect(result.detail).toContain('connectivity');
      expect(result.detail).toContain('storage_capacity');
      expect(result.detail).toContain('merchant');
    }
  });

  it('refuses a reference declared only in ANOTHER flow', async () => {
    // The quiet one. `connectivity` exists in the merchant flow, so a check that
    // ignored the flow would pass — and the P2P author would never be asked the
    // question whose answer decides whether they see the guarded field, leaving
    // it permanently `unknown` and permanently hidden with nothing reporting it.
    listProductTypeFields.mockImplementation(async (_db: unknown, _id: string, flow: string) => {
      if (flow === 'merchant') {
        return [field({ attributeKey: 'connectivity', variantCapable: false, scope: 'product' })];
      }
      if (flow === 'p2p') {
        return [
          field({
            id: 'ptf_2',
            attributeKey: 'storage_capacity',
            flow: 'p2p',
            variantCapable: false,
            scope: 'product',
            visibilityRule: { node: 'presence', field: 'connectivity', op: 'is_present' },
          }),
        ];
      }
      return [];
    });
    const result = await publishProductTypeVersion(db, {
      definitionId: 'ptd_1',
      publishedByOxyUserId: 'oxy_op',
    });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.refusal).toBe('visibility_rule_names_unknown_field');
      expect(result.detail).toContain('p2p');
    }
  });

  it('walks a nested rule, not just the top node', async () => {
    listProductTypeFields.mockImplementation(async (_db: unknown, _id: string, flow: string) =>
      flow === 'merchant'
        ? [
            field({
              attributeKey: 'storage_capacity',
              variantCapable: false,
              scope: 'product',
              visibilityRule: {
                node: 'all',
                rules: [
                  { node: 'presence', field: 'storage_capacity', op: 'is_present' },
                  { node: 'not', rule: { node: 'compare', field: 'ghost', op: 'eq', value: 1 } },
                ],
              },
            }),
          ]
        : [],
    );
    const result = await publishProductTypeVersion(db, {
      definitionId: 'ptd_1',
      publishedByOxyUserId: 'oxy_op',
    });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.detail).toContain('ghost');
  });
});

describe('publication supersedes the incumbent, in that order', () => {
  it('deprecates the previously published version BEFORE flipping the successor', async () => {
    findPublishedProductTypeDefinition.mockResolvedValue({
      ...DEFINITION,
      id: 'ptd_0',
      version: 1,
      lifecycle: 'published',
    });
    // A PAST literal, deliberately. `now` is an injected clock here, so a future
    // date would be compared against another literal and would be safe — but
    // #253's census flags every future literal rather than trying to decide
    // which ones a service secretly compares against the wall clock, and the
    // cheapest way to satisfy a blunt gate correctly is not to need an
    // exemption.
    const at = new Date('2026-01-15T10:00:00.000Z');
    const result = await publishProductTypeVersion(db, {
      definitionId: 'ptd_1',
      publishedByOxyUserId: 'oxy_op',
      now: at,
    });
    expect(result.outcome).toBe('published');

    // The order is the partial unique index's, not a preference: the reverse
    // sequence leaves two published rows for one key for the duration of one
    // statement, which the index refuses outright.
    expect(setProductTypeLifecycleIfIn.mock.calls.map((call) => [call[1], call[3]])).toEqual([
      ['ptd_0', 'deprecated'],
      ['ptd_1', 'published'],
    ]);
    expect(setProductTypeLifecycleIfIn.mock.calls[0][4]).toEqual({ deprecatedAt: at });
    expect(setProductTypeLifecycleIfIn.mock.calls[1][4]).toEqual({
      publishedByOxyUserId: 'oxy_op',
      publishedAt: at,
    });
  });

  it('reports the lost CAS rather than claiming a publication', async () => {
    // The empty result set IS the "somebody got there first" answer, and it is
    // reachable: the lifecycle read above and the update below are two
    // statements, and a concurrent publication lands between them.
    setProductTypeLifecycleIfIn.mockResolvedValue(null);
    const result = await publishProductTypeVersion(db, {
      definitionId: 'ptd_1',
      publishedByOxyUserId: 'oxy_op',
    });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') {
      expect(result.refusal).toBe('not_publishable_from_this_lifecycle');
    }
  });

  it('does not deprecate itself when it is already the key\'s published row', async () => {
    findPublishedProductTypeDefinition.mockResolvedValue({ ...DEFINITION, lifecycle: 'published' });
    await publishProductTypeVersion(db, {
      definitionId: 'ptd_1',
      publishedByOxyUserId: 'oxy_op',
    });
    expect(setProductTypeLifecycleIfIn.mock.calls.map((call) => call[3])).toEqual(['published']);
  });
});
