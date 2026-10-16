import React, { useState } from 'react';
import { View } from 'react-native';
import type {
  Collection,
  CollectionRuleField,
  CollectionRuleOperator,
} from '@mercaria/shared-types';
import { Button } from '@oxy.so/bloom/button';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectIcon,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectItemIndicator,
} from '@oxy.so/bloom/select';
import { Text } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';
import type { useUpdateCollection } from '@/lib/hooks/use-collections';
import {
  EDITABLE_RULE_FIELDS,
  isEditableRule,
  ruleForField,
  ruleOperators,
  normalizeEditedRules,
  type CollectionRules as Rules,
} from '@/lib/collection-rules';

const FIELD_KEYS: Record<CollectionRuleField, string> = {
  title: 'common.title',
  productType: 'products.wizard.review.productType',
  vendor: 'products.new.vendorLabel',
  tag: 'products.detail.organization.tags',
  categorySlug: 'collections.rules.categoryIdentifier',
  inventory: 'collections.rules.availability',
  price: 'collections.rules.price',
  compareAtPrice: 'collections.rules.compareAtPrice',
};
const OPERATOR_KEYS: Record<CollectionRuleOperator, string> = {
  equals: 'collections.rules.operators.equals',
  not_equals: 'collections.rules.operators.notEquals',
  contains: 'collections.rules.operators.contains',
  starts_with: 'collections.rules.operators.startsWith',
  ends_with: 'collections.rules.operators.endsWith',
  gt: 'collections.rules.operators.gt',
  gte: 'collections.rules.operators.gte',
  lt: 'collections.rules.operators.lt',
  lte: 'collections.rules.operators.lte',
};
const EMPTY_RULES: Rules = { appliesDisjunctively: false, conditions: [] };

export function CollectionRules({
  collection,
  canWrite,
  busy,
  readBlocked,
  mutation,
}: {
  collection: Collection;
  canWrite: boolean;
  busy: boolean;
  readBlocked: boolean;
  mutation: ReturnType<typeof useUpdateCollection>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Rules>();
  const original = collection.rules ?? EMPTY_RULES;
  const rules = draft ?? original;
  const normalized = normalizeEditedRules(rules);
  const changed = draft !== undefined && JSON.stringify(normalized) !== JSON.stringify(original);
  const valid = rules.conditions.every(
    (rule) => !isEditableRule(rule) || rule.value.trim().length > 0,
  );
  const disabled = busy || !canWrite;
  const edit = (next: Rules) => {
    if (!disabled) {
      setDraft(next);
      mutation.reset();
    }
  };
  const save = () => {
    if (disabled || readBlocked || !changed || !valid) return;
    mutation.mutate({ rules: normalized }, { onSuccess: () => setDraft(undefined) });
  };
  return (
    <View
      testID="merchant-collection-rules"
      className="gap-4 rounded-xl border border-border bg-white p-4 dark:bg-surface"
    >
      <Text className="text-base font-semibold text-foreground">
        {t('collections.rules.heading')}
      </Text>
      <RuleSelect
        label={t('collections.rules.match')}
        value={rules.appliesDisjunctively ? 'any' : 'all'}
        disabled={disabled}
        items={[
          { value: 'all', label: t('collections.rules.all') },
          { value: 'any', label: t('collections.rules.any') },
        ]}
        onChange={(value) => edit({ ...rules, appliesDisjunctively: value === 'any' })}
      />
      {!rules.conditions.length ? (
        <Text className="text-sm text-muted-foreground">{t('collections.rules.empty')}</Text>
      ) : null}
      {rules.conditions.map((rule, index) => {
        const editable = isEditableRule(rule);
        const patch = (value: typeof rule) =>
          edit({
            ...rules,
            conditions: rules.conditions.map((current, position) =>
              position === index ? value : current,
            ),
          });
        return (
          <View
            key={index}
            testID="merchant-collection-condition"
            className="gap-3 rounded-lg border border-border p-3"
          >
            {editable ? (
              <>
                <RuleSelect
                  label={t('collections.rules.field')}
                  value={rule.field}
                  disabled={disabled}
                  items={EDITABLE_RULE_FIELDS.map((value) => ({
                    value,
                    label: t(FIELD_KEYS[value]),
                  }))}
                  onChange={(value) => {
                    const field = EDITABLE_RULE_FIELDS.find((item) => item === value);
                    if (field) patch(ruleForField(field));
                  }}
                />
                {rule.field === 'inventory' ? (
                  <RuleSelect
                    label={t('collections.rules.value')}
                    value={rule.value}
                    disabled={disabled}
                    items={[
                      { value: '1', label: t('collections.rules.inStock') },
                      { value: '0', label: t('collections.rules.outOfStock') },
                    ]}
                    onChange={(value) => patch({ ...rule, value })}
                  />
                ) : (
                  <>
                    <RuleSelect
                      label={t('collections.rules.operator')}
                      value={rule.operator}
                      disabled={disabled}
                      items={ruleOperators(rule.field).map((value) => ({
                        value,
                        label: t(OPERATOR_KEYS[value]),
                      }))}
                      onChange={(value) => {
                        const operator = ruleOperators(rule.field).find((item) => item === value);
                        if (operator) patch({ ...rule, operator });
                      }}
                    />
                    <Field
                      label={t('collections.rules.value')}
                      error={!rule.value.trim() ? t('products.wizard.fields.required') : undefined}
                    >
                      <TextFieldInput
                        label={t('collections.rules.value')}
                        value={rule.value}
                        disabled={disabled}
                        onValueChange={(value) => patch({ ...rule, value })}
                      />
                    </Field>
                  </>
                )}
                {rule.field === 'tag' || rule.field === 'categorySlug' ? (
                  <Text className="text-xs text-muted-foreground">
                    {t('collections.rules.exactElement')}
                  </Text>
                ) : null}
              </>
            ) : (
              <>
                <Text className="text-sm font-semibold text-foreground">
                  {t(FIELD_KEYS[rule.field])}
                </Text>
                <Text className="text-sm text-foreground">{t(OPERATOR_KEYS[rule.operator])}</Text>
                <Text className="text-sm text-foreground">{rule.value}</Text>
                <Text className="text-xs text-muted-foreground">
                  {t('collections.rules.retained')}
                </Text>
              </>
            )}
            {canWrite ? (
              <Button
                size="sm"
                appearance="outline"
                material="flat"
                disabled={disabled}
                accessibilityLabel={t('collections.rules.remove', { position: index + 1 })}
                onPress={() =>
                  edit({
                    ...rules,
                    conditions: rules.conditions.filter((_, position) => position !== index),
                  })
                }
              >
                {t('collections.rules.remove', { position: index + 1 })}
              </Button>
            ) : null}
          </View>
        );
      })}
      {canWrite ? (
        <Button
          appearance="outline"
          material="flat"
          disabled={disabled}
          onPress={() =>
            edit({ ...rules, conditions: [...rules.conditions, ruleForField('title')] })
          }
        >
          {t('collections.rules.add')}
        </Button>
      ) : null}
      <View className="min-h-5" accessibilityLiveRegion="polite">
        {mutation.isError ? (
          <Text className="text-sm text-destructive">{t('collections.rules.failed')}</Text>
        ) : mutation.isSuccess ? (
          <Text className="text-sm text-muted-foreground">{t('collections.rules.saved')}</Text>
        ) : null}
      </View>
      {canWrite ? (
        <View className="flex-row flex-wrap gap-2">
          <Button
            disabled={disabled || readBlocked || !changed || !valid}
            loading={mutation.isPending}
            onPress={save}
          >
            {t('collections.rules.save')}
          </Button>
          <Button
            appearance="outline"
            material="flat"
            disabled={busy || draft === undefined}
            onPress={() => {
              setDraft(undefined);
              mutation.reset();
            }}
          >
            {t('common.cancel')}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

function RuleSelect({
  label,
  value,
  disabled,
  items,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  items: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <Select value={value} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger label={label}>
          <SelectValue />
          <SelectIcon />
        </SelectTrigger>
        <SelectContent
          label={label}
          items={items}
          renderItem={(item) => (
            <SelectItem value={item.value} label={item.label}>
              <SelectItemText>{item.label}</SelectItemText>
              <SelectItemIndicator />
            </SelectItem>
          )}
        />
      </Select>
    </Field>
  );
}
