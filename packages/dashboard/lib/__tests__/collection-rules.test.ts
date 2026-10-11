import { expect, it } from 'vitest';
import {
  isEditableRule,
  normalizeEditedRules,
  ruleForField,
  ruleOperators,
} from '../collection-rules';

it('offers field-compatible controls without evaluating membership', () => {
  expect(ruleOperators('title')).toEqual([
    'equals',
    'not_equals',
    'contains',
    'starts_with',
    'ends_with',
  ]);
  expect(ruleOperators('tag')).toEqual(['equals', 'not_equals', 'contains']);
  expect(ruleOperators('categorySlug')).toEqual(ruleOperators('tag'));
  expect(ruleOperators('price')).toEqual([]);
  expect(ruleForField('inventory')).toEqual({ field: 'inventory', operator: 'equals', value: '1' });
  expect(isEditableRule({ field: 'inventory', operator: 'gt', value: '20' })).toBe(false);
  expect(isEditableRule({ field: 'inventory', operator: 'equals', value: '0' })).toBe(true);
  expect(isEditableRule({ field: 'tag', operator: 'starts_with', value: 'x' })).toBe(false);
});
it('preserves historical rule values verbatim while trimming only edited-supported fields', () => {
  const legacy = { field: 'price', operator: 'gt', value: '  0500 ' } as const;
  expect(
    normalizeEditedRules({
      appliesDisjunctively: true,
      conditions: [legacy, { field: 'title', operator: 'contains', value: ' Summer ' }],
    }),
  ).toEqual({
    appliesDisjunctively: true,
    conditions: [legacy, { field: 'title', operator: 'contains', value: 'Summer' }],
  });
});
it('keeps empty conditions as an explicit replacement, not an omitted rules patch', () => {
  expect(normalizeEditedRules({ appliesDisjunctively: false, conditions: [] })).toEqual({
    appliesDisjunctively: false,
    conditions: [],
  });
});
