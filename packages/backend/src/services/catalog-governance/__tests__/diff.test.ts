/**
 * The version diff (#367 Workstream 12).
 *
 * Table tests over the pure functions. The property that matters most is the
 * DIRECTION of `breaking`: getting it backwards reports every relaxation as
 * dangerous and every tightening as safe, which is worse than reporting
 * nothing, and it is invisible in a diff whose entries all look plausible.
 *
 * Every fixture here is built by hand, which is normally the thing to avoid —
 * a test that builds its fixture by hand measures your own assumption. It is
 * the right shape here because these functions take PLAIN DATA and no database:
 * the assumption under test is the diff RULE, and there is no read whose
 * behaviour a hand-built input could misrepresent.
 *
 * The HYDRATION that feeds them — `definition-diff.service.ts`, the only thing
 * `GET /diff/product-types/:key` and `GET /diff/attributes/:key` call — is
 * covered by `definition-diff.realdb.test.ts`. That sentence was here before
 * that file was, naming `catalog-governance.realdb.test.ts`, which never
 * mentioned the hydration: the pure differ was well covered and the production
 * path was covered by nothing, behind a comment saying otherwise. Do not
 * restate a coverage claim here without checking that the file named makes it.
 */

import { describe, expect, it } from 'vitest';
import {
  diffAttributeVersions,
  diffProductTypeVersions,
  type DiffableAttributeVersion,
  type DiffableProductTypeField,
  type DiffableProductTypeVersion,
} from '../diff.js';

function field(patch: Partial<DiffableProductTypeField> = {}): DiffableProductTypeField {
  return {
    attributeKey: 'colour',
    scope: 'variant',
    flow: 'merchant',
    requirement: 'optional',
    valuePolicy: 'controlled_value',
    variantCapable: true,
    attributeDefinitionVersion: 1,
    groupKey: 'basics',
    ...patch,
  };
}

function productType(patch: Partial<DiffableProductTypeVersion> = {}): DiffableProductTypeVersion {
  return { version: 1, fields: [field()], categoryIds: ['cat-1'], ...patch };
}

function attribute(patch: Partial<DiffableAttributeVersion> = {}): DiffableAttributeVersion {
  return {
    version: 1,
    valueType: 'string',
    cardinality: 'single',
    unitFamily: null,
    baseUnit: null,
    minValue: null,
    maxValue: null,
    decimalPlaces: null,
    variantDefining: true,
    filterable: true,
    hardConstraintCapable: false,
    enumValues: ['black', 'white'],
    categoryIds: ['cat-1'],
    ...patch,
  };
}

describe('diffProductTypeVersions', () => {
  it('reports no entries between two identical versions', () => {
    const diff = diffProductTypeVersions(productType(), productType({ version: 2 }));
    // A republished version with no semantic change is a REAL answer and must
    // not be confused with an error — `composeDefinitionDiff` refuses equal
    // version numbers separately, so an empty diff here always means "nothing
    // changed" rather than "you asked the wrong question".
    expect(diff.entries).toEqual([]);
    expect(diff.breakingCount).toBe(0);
    expect(diff.fromVersion).toBe(1);
    expect(diff.toVersion).toBe(2);
  });

  it('treats tightening a requirement as breaking and relaxing it as not', () => {
    const tightened = diffProductTypeVersions(
      productType({ fields: [field({ requirement: 'optional' })] }),
      productType({ version: 2, fields: [field({ requirement: 'required' })] }),
    );
    expect(tightened.breakingCount).toBe(1);

    const relaxed = diffProductTypeVersions(
      productType({ fields: [field({ requirement: 'required' })] }),
      productType({ version: 2, fields: [field({ requirement: 'optional' })] }),
    );
    // The asymmetry IS the rule. Both diffs have exactly one entry; only the
    // direction differs, so a symmetric implementation passes one of these and
    // fails the other.
    expect(relaxed.entries).toHaveLength(1);
    expect(relaxed.breakingCount).toBe(0);
  });

  it('treats optional → forbidden as breaking, not as a relaxation', () => {
    // The trap the strictness table exists for. `forbidden` reads like the most
    // permissive value and is the most destructive: it empties every draft that
    // filled the field.
    const diff = diffProductTypeVersions(
      productType({ fields: [field({ requirement: 'optional' })] }),
      productType({ version: 2, fields: [field({ requirement: 'forbidden' })] }),
    );
    expect(diff.breakingCount).toBe(1);
  });

  it('treats every removed field as breaking, including a hidden one', () => {
    // A hidden field still holds data.
    const diff = diffProductTypeVersions(
      productType({ fields: [field({ requirement: 'hidden' })] }),
      productType({ version: 2, fields: [] }),
    );
    expect(diff.entries.map((entry) => entry.change)).toEqual(['removed']);
    expect(diff.breakingCount).toBe(1);
  });

  it('treats an added required field as breaking and an added optional one as not', () => {
    const required = diffProductTypeVersions(
      productType({ fields: [] }),
      productType({ version: 2, fields: [field({ requirement: 'required' })] }),
    );
    expect(required.breakingCount).toBe(1);

    const optional = diffProductTypeVersions(
      productType({ fields: [] }),
      productType({ version: 2, fields: [field({ requirement: 'optional' })] }),
    );
    expect(optional.entries).toHaveLength(1);
    expect(optional.breakingCount).toBe(0);
  });

  it('treats withdrawing variant capability as breaking and granting it as not', () => {
    const withdrawn = diffProductTypeVersions(
      productType({ fields: [field({ variantCapable: true })] }),
      productType({ version: 2, fields: [field({ variantCapable: false })] }),
    );
    expect(withdrawn.breakingCount).toBe(1);

    const granted = diffProductTypeVersions(
      productType({ fields: [field({ variantCapable: false })] }),
      productType({ version: 2, fields: [field({ variantCapable: true })] }),
    );
    expect(granted.breakingCount).toBe(0);
  });

  it('does not call a regrouped field breaking', () => {
    // #367 step 3 leaves `name` and `description` unfrozen precisely because
    // presentation carries no semantics. A diff that flagged it would train
    // operators to ignore the breaking count.
    const diff = diffProductTypeVersions(
      productType({ fields: [field({ groupKey: 'basics' })] }),
      productType({ version: 2, fields: [field({ groupKey: 'details' })] }),
    );
    expect(diff.entries).toHaveLength(1);
    expect(diff.breakingCount).toBe(0);
  });

  it('identifies a field by (flow, scope, attributeKey) and not by position', () => {
    // Reordering the field list must produce no diff at all — the identity is
    // the triple, and diffing on order would report every version as a total
    // rewrite the first time somebody sorted a query.
    const two = [field({ attributeKey: 'colour' }), field({ attributeKey: 'size' })];
    const diff = diffProductTypeVersions(
      productType({ fields: two }),
      productType({ version: 2, fields: [...two].reverse() }),
    );
    expect(diff.entries).toEqual([]);
  });

  it('reports the same field under a different flow as added, not changed', () => {
    // Two flows are two genuinely different requirements on one attribute, and
    // #367 step 3's own unique index is `(definition, flow, attribute)`.
    const diff = diffProductTypeVersions(
      productType({ fields: [field({ flow: 'merchant' })] }),
      productType({ version: 2, fields: [field({ flow: 'merchant' }), field({ flow: 'p2p' })] }),
    );
    expect(diff.entries.map((entry) => entry.change)).toEqual(['added']);
  });

  it('treats a withdrawn category scope as breaking and an added one as not', () => {
    const withdrawn = diffProductTypeVersions(
      productType({ categoryIds: ['cat-1', 'cat-2'] }),
      productType({ version: 2, categoryIds: ['cat-1'] }),
    );
    expect(withdrawn.breakingCount).toBe(1);

    const added = diffProductTypeVersions(
      productType({ categoryIds: ['cat-1'] }),
      productType({ version: 2, categoryIds: ['cat-1', 'cat-2'] }),
    );
    expect(added.breakingCount).toBe(0);
  });

  it('derives breakingCount from the entries', () => {
    const diff = diffProductTypeVersions(
      productType({ fields: [field({ requirement: 'optional' }), field({ attributeKey: 'size' })] }),
      productType({
        version: 2,
        fields: [field({ requirement: 'required' })],
        categoryIds: [],
      }),
    );
    // The headline and the list cannot disagree, because one is computed from
    // the other. A separately maintained count goes wrong in the flattering
    // direction: "0 breaking changes" over a list containing a removed field.
    expect(diff.breakingCount).toBe(diff.entries.filter((entry) => entry.breaking).length);
    expect(diff.breakingCount).toBeGreaterThan(0);
  });
});

describe('diffAttributeVersions', () => {
  it('reports no entries between two identical versions', () => {
    expect(diffAttributeVersions(attribute(), attribute({ version: 2 })).entries).toEqual([]);
  });

  it('treats a value type or cardinality move as breaking', () => {
    const valueType = diffAttributeVersions(
      attribute({ valueType: 'string' }),
      attribute({ version: 2, valueType: 'integer' }),
    );
    expect(valueType.breakingCount).toBe(1);

    const cardinality = diffAttributeVersions(
      attribute({ cardinality: 'single' }),
      attribute({ version: 2, cardinality: 'set' }),
    );
    expect(cardinality.breakingCount).toBe(1);
  });

  it('treats a narrowed bound as breaking and a widened one as not', () => {
    const narrowed = diffAttributeVersions(
      attribute({ maxValue: 100 }),
      attribute({ version: 2, maxValue: 50 }),
    );
    expect(narrowed.breakingCount).toBe(1);

    const widened = diffAttributeVersions(
      attribute({ maxValue: 100 }),
      attribute({ version: 2, maxValue: 200 }),
    );
    expect(widened.entries).toHaveLength(1);
    expect(widened.breakingCount).toBe(0);
  });

  it('treats an APPEARING bound as breaking and a removed one as not', () => {
    // The case a naive numeric comparison gets wrong, because one side is null.
    const appearing = diffAttributeVersions(
      attribute({ minValue: null }),
      attribute({ version: 2, minValue: 0 }),
    );
    expect(appearing.breakingCount).toBe(1);

    const removed = diffAttributeVersions(
      attribute({ minValue: 0 }),
      attribute({ version: 2, minValue: null }),
    );
    expect(removed.entries).toHaveLength(1);
    expect(removed.breakingCount).toBe(0);
  });

  it('treats fewer decimal places as breaking and more as not', () => {
    const fewer = diffAttributeVersions(
      attribute({ decimalPlaces: 3 }),
      attribute({ version: 2, decimalPlaces: 1 }),
    );
    expect(fewer.breakingCount).toBe(1);

    const more = diffAttributeVersions(
      attribute({ decimalPlaces: 1 }),
      attribute({ version: 2, decimalPlaces: 3 }),
    );
    expect(more.breakingCount).toBe(0);
  });

  it('treats a removed controlled value as breaking and an added one as not', () => {
    const removed = diffAttributeVersions(
      attribute({ enumValues: ['black', 'white'] }),
      attribute({ version: 2, enumValues: ['black'] }),
    );
    expect(removed.breakingCount).toBe(1);

    const added = diffAttributeVersions(
      attribute({ enumValues: ['black'] }),
      attribute({ version: 2, enumValues: ['black', 'white'] }),
    );
    expect(added.entries).toHaveLength(1);
    expect(added.breakingCount).toBe(0);
  });

  it('treats withdrawing a capability as breaking and granting it as not', () => {
    const withdrawn = diffAttributeVersions(
      attribute({ hardConstraintCapable: true }),
      attribute({ version: 2, hardConstraintCapable: false }),
    );
    expect(withdrawn.breakingCount).toBe(1);

    const granted = diffAttributeVersions(
      attribute({ hardConstraintCapable: false }),
      attribute({ version: 2, hardConstraintCapable: true }),
    );
    expect(granted.breakingCount).toBe(0);
  });

  it('does not call a filterability change breaking', () => {
    const diff = diffAttributeVersions(
      attribute({ filterable: true }),
      attribute({ version: 2, filterable: false }),
    );
    // Presentation. A facet disappearing is visible immediately and invalidates
    // no stored value.
    expect(diff.entries).toHaveLength(1);
    expect(diff.breakingCount).toBe(0);
  });

  it('sorts entries deterministically', () => {
    // Two runs over the same input must produce byte-identical output, or a
    // digest over a diff — and an operator comparing two previews — is noise.
    const from = attribute({ enumValues: ['white', 'black'], valueType: 'string' });
    const to = attribute({ version: 2, enumValues: ['black', 'grey'], valueType: 'integer' });
    expect(diffAttributeVersions(from, to)).toEqual(diffAttributeVersions(from, to));
    expect(diffAttributeVersions(from, to).entries.map((entry) => entry.key)).toEqual(
      [...diffAttributeVersions(from, to).entries.map((entry) => entry.key)].sort(),
    );
  });
});
