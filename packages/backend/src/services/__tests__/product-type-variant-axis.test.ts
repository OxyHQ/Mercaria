/**
 * The variant-axis prohibition, stated twice, checked once (#367, ADR 0007
 * D6/D8).
 *
 * `product_type_fields_variant_axis_check` is the authority and holds against
 * every writer including `psql`; `assessVariantAxis` is the second statement,
 * and it exists so a schema author reads a sentence rather than a constraint
 * name. Two statements of one rule can disagree, so this file runs the WHOLE
 * forbidden tuple through both and asserts they answer the same way — the census
 * with a positive control, rather than three examples.
 */

import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { DATABASE_CASING } from '@oxyhq/db';
import {
  PRODUCT_TYPE_FIELD_SCOPES,
  PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS,
} from '@mercaria/shared-types';
import { productTypeFields } from '../../db/schema/productTypes.js';
import { assessVariantAxis, describeVariantAxisRefusal } from '../product-types/variant-axis.js';

const dialect = new PgDialect({ casing: DATABASE_CASING });

const RENDERED_CHECK = (() => {
  const entry = getTableConfig(productTypeFields).checks.find(
    (candidate) => candidate.name === 'product_type_fields_variant_axis_check',
  );
  if (entry === undefined) throw new Error('product_type_fields_variant_axis_check is missing');
  return dialect.sqlToQuery(entry.value).sql;
})();

/** Attributes that are perfectly good axes — the positive control. */
const LEGITIMATE_AXES = ['color', 'size', 'storage_capacity', 'material', 'ram_capacity'];

describe('the function and the CHECK refuse the same set', () => {
  it('refuses every forbidden key at variant scope, and the CHECK names each one', () => {
    expect(PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS.length).toBeGreaterThanOrEqual(30);
    for (const attributeKey of PRODUCT_TYPE_FORBIDDEN_VARIANT_AXIS_KEYS) {
      const verdict = assessVariantAxis({ scope: 'variant', attributeKey, variantCapable: true });
      expect(verdict.outcome, attributeKey).toBe('refused');
      if (verdict.outcome === 'refused') {
        expect(verdict.refusal, attributeKey).toBe('attribute_may_not_be_an_axis');
        expect(describeVariantAxisRefusal(verdict)).toContain(attributeKey);
      }
      expect(RENDERED_CHECK, `the CHECK does not name ${attributeKey}`).toContain(
        `'${attributeKey}'`,
      );
    }
  });

  it('permits a legitimate axis, and the CHECK does not name it', () => {
    // The positive control. Without it, a function that refused EVERYTHING and a
    // CHECK that named every key in the language would both pass the case above.
    for (const attributeKey of LEGITIMATE_AXES) {
      expect(
        assessVariantAxis({ scope: 'variant', attributeKey, variantCapable: true }).outcome,
        attributeKey,
      ).toBe('permitted');
      expect(RENDERED_CHECK).not.toContain(`'${attributeKey}'`);
    }
  });
});

describe('scope is the first wall', () => {
  it('refuses an axis at every scope but `variant`', () => {
    for (const scope of PRODUCT_TYPE_FIELD_SCOPES) {
      const verdict = assessVariantAxis({
        scope,
        attributeKey: 'color',
        variantCapable: true,
      });
      if (scope === 'variant') {
        expect(verdict.outcome).toBe('permitted');
        continue;
      }
      expect(verdict.outcome, scope).toBe('refused');
      if (verdict.outcome === 'refused') expect(verdict.refusal).toBe('scope_is_not_variant');
    }
  });

  it('says nothing about a field that is not an axis at all', () => {
    // The question is only asked of a field claiming to define variants; a
    // compatibility field that makes no such claim is the normal case and has
    // nothing to refuse.
    for (const scope of PRODUCT_TYPE_FIELD_SCOPES) {
      expect(
        assessVariantAxis({ scope, attributeKey: 'vehicle_model', variantCapable: false }).outcome,
      ).toBe('permitted');
    }
    expect(describeVariantAxisRefusal({ outcome: 'permitted' })).toBeNull();
  });

  it('a year range is refused by BOTH walls independently', () => {
    // ADR 0007 D8's acceptance scenario, and the reason there are two walls: the
    // realistic mistake is declaring a fitment fact with `scope: 'variant'`,
    // which walks straight past the scope wall.
    expect(
      assessVariantAxis({ scope: 'compatibility', attributeKey: 'year_range', variantCapable: true })
        .outcome,
    ).toBe('refused');
    const mislabelled = assessVariantAxis({
      scope: 'variant',
      attributeKey: 'year_range',
      variantCapable: true,
    });
    expect(mislabelled.outcome).toBe('refused');
    if (mislabelled.outcome === 'refused') {
      expect(mislabelled.refusal).toBe('attribute_may_not_be_an_axis');
    }
  });
});
