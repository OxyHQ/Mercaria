import { View } from 'react-native';
import { Text } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';
import type {
  SpecificationGroup,
  SpecificationTable,
} from '@/lib/catalog/specifications';

/**
 * A product's specification table (#367 workstream 9 §"Product detail pages").
 *
 * Rows, labels, order and rendered values all arrive composed. This component
 * chooses a heading for each group and lays them out, and there is no attribute
 * key anywhere in it.
 *
 * ## Two group headings, and they name a SCOPE rather than a subject
 *
 * "About this product" and "About this configuration" are the two entity kinds
 * the value surface has. They are copy for a structural fact, not a
 * product-type-specific section list — see `lib/catalog/specifications.ts` for
 * why the product type's own ordered field groups are a seam rather than
 * something invented here.
 *
 * ## An unverified fact is not marked, and that is deliberate
 *
 * `verificationState` is carried on every entry and rendered by nothing. #94's
 * public projection already excludes the values Mercaria is unwilling to state
 * (conflicting, unparsed, `operator_only`), so what remains is what it IS
 * willing to state — and decorating a subset of it with a trust mark would
 * invite the reading that the undecorated rows are doubted. What the state is
 * FOR is #59's correction workflow, which is an operator surface.
 */

export interface SpecificationGroupsProps {
  table: SpecificationTable;
  /**
   * True when the definition read failed, so every label fell back to the value
   * projection's own — which the server falls back to the stable KEY on.
   */
  definitionsUnavailable: boolean;
}

export function SpecificationGroups({
  table,
  definitionsUnavailable,
}: SpecificationGroupsProps) {
  const { t } = useTranslation();

  if (table.groups.length === 0) return null;

  return (
    <View className="gap-space-24">
      <Text className="text-captionBold text-text" accessibilityRole="header">
        {t('catalog.specs.title')}
      </Text>

      {definitionsUnavailable ? (
        <Text className="text-caption text-text-tertiary">
          {t('catalog.specs.definitionsUnavailable')}
        </Text>
      ) : null}

      {table.groups.map((group) => (
        <SpecificationGroupBlock key={group.scope} group={group} />
      ))}

      {table.hasUntranslatedLabels ? (
        <Text className="text-caption text-text-tertiary">
          {t('catalog.specs.untranslated')}
        </Text>
      ) : null}
    </View>
  );
}

function SpecificationGroupBlock({ group }: { group: SpecificationGroup }) {
  const { t } = useTranslation();
  const heading =
    group.scope === 'variant' ? t('catalog.specs.variant') : t('catalog.specs.product');

  return (
    <View className="gap-space-8">
      <Text className="text-caption text-text-secondary" accessibilityRole="header">
        {heading}
      </Text>
      {group.entries.map((entry) => (
        <View
          key={`${group.scope}:${entry.attributeKey}`}
          className="flex-row items-start justify-between gap-space-16 border-b border-border-secondary py-space-8"
        >
          <View className="flex-1">
            <Text className="text-caption text-text-secondary">{entry.label}</Text>
          </View>
          <View className="flex-1 items-end">
            <Text className="text-body text-text">{entry.displayValue}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}
