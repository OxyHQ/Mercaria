import type { Collection, CollectionRule, CollectionRuleField, CollectionRuleOperator } from '@mercaria/shared-types';

export type CollectionRules = NonNullable<Collection['rules']>;
export const EDITABLE_RULE_FIELDS = ['title', 'productType', 'vendor', 'tag', 'categorySlug', 'inventory'] as const satisfies readonly CollectionRuleField[];
const TEXT_OPERATORS = ['equals', 'not_equals', 'contains', 'starts_with', 'ends_with'] as const;
const ELEMENT_OPERATORS = ['equals', 'not_equals', 'contains'] as const;

/** Form choices only; membership is exclusively evaluated by the backend. */
export function ruleOperators(field: CollectionRuleField): readonly CollectionRuleOperator[] {
  if (field === 'title' || field === 'productType' || field === 'vendor') return TEXT_OPERATORS;
  if (field === 'tag' || field === 'categorySlug') return ELEMENT_OPERATORS;
  return field === 'inventory' ? ['equals'] : [];
}

/** Unrepresented historical conditions remain byte-for-byte intact on save. */
export function isEditableRule(rule: CollectionRule): boolean {
  return ruleOperators(rule.field).includes(rule.operator)
    && (rule.field !== 'inventory' || rule.value === '0' || rule.value === '1');
}

export function ruleForField(field: typeof EDITABLE_RULE_FIELDS[number]): CollectionRule {
  return { field, operator: 'equals', value: field === 'inventory' ? '1' : '' };
}

export function normalizeEditedRules(rules: CollectionRules): CollectionRules {
  return { ...rules, conditions: rules.conditions.map(rule => isEditableRule(rule) ? { ...rule, value: rule.value.trim() } : rule) };
}
