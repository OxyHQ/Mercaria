/**
 * A product-type field's VALUE POLICY must agree with the attribute it cites
 * (#367, ADR 0007 D5).
 *
 * `value_policy` says HOW a value is supplied and `attribute_definitions.value_type`
 * says WHAT it is. Nothing checked that they agree, so the policy was decorative
 * on three of its five members: a field declaring `controlled_value` while citing
 * a `decimal` stored cleanly, published cleanly, and then behaved as the
 * ATTRIBUTE says — because `validation.ts`'s `expectedKind` derives the answer
 * shape from `validation.valueType` for every policy except `canonical_reference`.
 * A schema saying "pick from a list" while the form accepted a number, with no
 * error anywhere.
 *
 * ## A case per contradiction SHAPE, not one representative
 *
 * The four shapes fail differently and want different fixes, so one case would
 * prove the mechanism FIRES without proving it DISCRIMINATES:
 *
 *  - `controlled_value` on a non-enum — wants the attribute changing, or the
 *    policy relaxing to `typed_scalar`;
 *  - `proposal_enabled` on a non-enum — the same, plus it is the only policy
 *    that admits a value the registry does not carry (D9), so it is the one
 *    where getting it wrong widens what an author may assert;
 *  - `typed_scalar` on an `enum` — wants `controlled_value`, and is the exact
 *    inverse of the first;
 *  - `typed_structured` on a scalar — wants the multi-axis attribute it thought
 *    it was citing.
 *
 * Each asserts the MESSAGE names the field, its policy, the type it contradicts
 * and what that policy would have accepted. "The policy contradicts the
 * attribute" sends somebody to read both rows to learn which is wrong.
 *
 * ## The three cases that must NOT refuse
 *
 * An agreeing field, a `canonical_reference` field over a `string` (the policy
 * that overrides the type by design), and every legal `typed_scalar` type. Two
 * of the three are what stop the fix being "refuse more", which passes every
 * refusal case and breaks every real schema.
 *
 * The repositories are mocked, which is the right depth: every assertion is
 * about a decision the service makes over rows it was handed, and the pure rule
 * beneath it is exercised directly by the table at the end.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTRIBUTE_VALUE_TYPES,
  PRODUCT_TYPE_VALUE_POLICIES,
  type AttributeValueType,
  type ProductTypeValuePolicy,
} from '@mercaria/shared-types';
import { assessValuePolicy, VALUE_POLICY_ADMITS } from '../product-types/value-policy.js';

const findProductTypeDefinitionById = vi.fn();
const findPublishedProductTypeDefinition = vi.fn();
const setProductTypeLifecycleIfIn = vi.fn();
const listProductTypeCategoryScopes = vi.fn();
const listProductTypeFieldGroups = vi.fn();
const listProductTypeFields = vi.fn();
const listAttributeValueTypesByIds = vi.fn();

vi.mock('../../db/productTypes/productTypeRepository.js', () => ({
  findProductTypeDefinitionById: (...args: unknown[]) => findProductTypeDefinitionById(...args),
  findPublishedProductTypeDefinition: (...args: unknown[]) =>
    findPublishedProductTypeDefinition(...args),
  setProductTypeLifecycleIfIn: (...args: unknown[]) => setProductTypeLifecycleIfIn(...args),
}));

vi.mock('../../db/productTypes/productTypeFieldRepository.js', () => ({
  listProductTypeCategoryScopes: (...args: unknown[]) => listProductTypeCategoryScopes(...args),
  listProductTypeFieldGroups: (...args: unknown[]) => listProductTypeFieldGroups(...args),
  listProductTypeFields: (...args: unknown[]) => listProductTypeFields(...args),
}));

vi.mock('../../db/attributes/definitionRepository.js', () => ({
  listAttributeValueTypesByIds: (...args: unknown[]) => listAttributeValueTypesByIds(...args),
}));

const { publishProductTypeVersion } = await import('../product-types/product-type.service.js');

const db = { transaction: async (run: (tx: unknown) => Promise<unknown>) => run({}) } as never;

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
    scope: 'product',
    flow: 'merchant',
    requirement: 'optional',
    valuePolicy: 'controlled_value',
    variantCapable: false,
    position: 0,
    visibilityRule: null,
    ...overrides,
  };
}

/** Publish one merchant-flow field citing `ad_1`, whose type the caller states. */
async function publishWith(
  valuePolicy: ProductTypeValuePolicy,
  valueType: AttributeValueType,
): Promise<Awaited<ReturnType<typeof publishProductTypeVersion>>> {
  listProductTypeFields.mockImplementation(async (_db: unknown, _id: string, flow: string) =>
    flow === 'merchant' ? [field({ valuePolicy })] : [],
  );
  listAttributeValueTypesByIds.mockResolvedValue(new Map([['ad_1', valueType]]));
  return publishProductTypeVersion(db, { definitionId: 'ptd_1', publishedByOxyUserId: 'oxy_op' });
}

beforeEach(() => {
  vi.clearAllMocks();
  findProductTypeDefinitionById.mockResolvedValue(DEFINITION);
  findPublishedProductTypeDefinition.mockResolvedValue(null);
  listProductTypeCategoryScopes.mockResolvedValue([
    { id: 'pts_1', categoryId: 'cat_1', includeDescendants: true },
  ]);
  listProductTypeFieldGroups.mockResolvedValue([]);
  setProductTypeLifecycleIfIn.mockImplementation(async (_db: unknown, id: string) => ({
    ...DEFINITION,
    id,
    lifecycle: 'published',
  }));
});

describe('each contradiction shape is refused, and the message says WHICH', () => {
  it('refuses `controlled_value` citing a decimal', async () => {
    const result = await publishWith('controlled_value', 'decimal');

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.refusal).toBe('value_policy_contradicts_attribute');
    // The field, its policy, the type it contradicts, and what it would accept.
    expect(result.detail).toContain('"color"');
    expect(result.detail).toContain('"controlled_value"');
    expect(result.detail).toContain('"decimal"');
    expect(result.detail).toContain('"enum"');
    // …and the flow, because a version's flows are different forms.
    expect(result.detail).toContain('merchant');
    expect(setProductTypeLifecycleIfIn).not.toHaveBeenCalled();
  });

  it('refuses `proposal_enabled` citing a measurement', async () => {
    const result = await publishWith('proposal_enabled', 'measurement');

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.refusal).toBe('value_policy_contradicts_attribute');
    expect(result.detail).toContain('"proposal_enabled"');
    expect(result.detail).toContain('"measurement"');
    expect(result.detail).toContain('"enum"');
  });

  it('refuses `typed_scalar` citing an enum — the inverse mistake', async () => {
    const result = await publishWith('typed_scalar', 'enum');

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.refusal).toBe('value_policy_contradicts_attribute');
    expect(result.detail).toContain('"typed_scalar"');
    expect(result.detail).toContain('"enum"');
    // It must NOT tell this author to use an enum — that is the other mistake.
    expect(result.detail).toContain('"string"');
  });

  it('refuses `typed_structured` citing a scalar', async () => {
    const result = await publishWith('typed_structured', 'integer');

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.refusal).toBe('value_policy_contradicts_attribute');
    expect(result.detail).toContain('"typed_structured"');
    expect(result.detail).toContain('"integer"');
    expect(result.detail).toContain('"structured"');
  });
});

describe('what must NOT be refused', () => {
  it('publishes an agreeing field', async () => {
    const result = await publishWith('controlled_value', 'enum');

    expect(result.outcome).toBe('published');
  });

  it('publishes `canonical_reference` over a string — the policy overrides the type', async () => {
    // The one policy whose whole job is "this is a pointer, not a literal".
    // Without this case the fix could be "refuse more", which passes every
    // refusal above and breaks every pointer field in the catalogue.
    const result = await publishWith('canonical_reference', 'string');

    expect(result.outcome).toBe('published');
  });

  it('publishes `typed_scalar` over EVERY scalar type it admits', async () => {
    for (const valueType of VALUE_POLICY_ADMITS.typed_scalar ?? []) {
      const result = await publishWith('typed_scalar', valueType);
      expect(result.outcome, `typed_scalar should admit ${valueType}`).toBe('published');
    }
  });
});

describe('the rule itself is total and non-vacuous', () => {
  it('classifies every (policy, value type) pair without throwing', () => {
    let agreed = 0;
    let contradicted = 0;
    for (const valuePolicy of PRODUCT_TYPE_VALUE_POLICIES) {
      for (const valueType of ATTRIBUTE_VALUE_TYPES) {
        const verdict = assessValuePolicy({ attributeKey: 'k', valuePolicy, valueType });
        if (verdict.outcome === 'agrees') agreed += 1;
        else contradicted += 1;
      }
    }

    const pairs = PRODUCT_TYPE_VALUE_POLICIES.length * ATTRIBUTE_VALUE_TYPES.length;
    expect(agreed + contradicted).toBe(pairs);
    // BOTH floors, because a rule that agreed with everything and one that
    // refused everything each satisfy a single-sided assertion — and the first
    // is exactly the state this file exists to end.
    expect(agreed).toBeGreaterThan(0);
    expect(contradicted).toBeGreaterThan(0);
    console.log(
      `[value-policy] ${String(pairs)} pairs classified: ${String(agreed)} agree, ${String(contradicted)} contradict`,
    );
  });

  it('leaves `canonical_reference` unconstrained and every other policy constrained', () => {
    // `null` and not `[]`: an empty array would refuse every attribute, and the
    // two spellings are one keystroke apart.
    expect(VALUE_POLICY_ADMITS.canonical_reference).toBeNull();
    for (const valuePolicy of PRODUCT_TYPE_VALUE_POLICIES) {
      if (valuePolicy === 'canonical_reference') continue;
      const admits = VALUE_POLICY_ADMITS[valuePolicy];
      expect(admits, `${valuePolicy} must state what it admits`).not.toBeNull();
      expect(admits?.length, `${valuePolicy} must admit something`).toBeGreaterThan(0);
    }
  });
});
