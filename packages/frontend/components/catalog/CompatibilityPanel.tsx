import { View } from 'react-native';
import type { AutomotiveFitmentView } from '@mercaria/shared-types';
import { Text } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';
import type { ProductCompatibility } from '@/lib/catalog/compatibility';

/**
 * Compatibility and fitment on a product page (#367 workstream 5, workstream 9).
 *
 * ## The unavailable branch renders NOTHING, and that is the decision
 *
 * `lib/catalog/compatibility.ts` refuses unconditionally, because no endpoint
 * serves the domain. The alternative — a section saying "we do not publish
 * fitment for this product" on every product in the catalogue — would be a
 * permanent apology on a page where the vast majority of products have no
 * fitment relationship to publish in the first place. A phone is not missing its
 * fitment data; it has none.
 *
 * So the refusal is rendered as absence here and is stated once, in
 * `docs/storefront-catalog.md` and in the module's own header, where a reader
 * looking for it will find it.
 *
 * ## Only FITMENT is rendered, and the reason is in the DTO
 *
 * `AutomotiveFitmentView` carries `VehicleReferenceView`s, which have names. A
 * `CompatibilityRelationView`'s target is a bare id union — a family id, a
 * product id, a variant id — with no name anywhere on it, so rendering "this
 * fits …" would need a resolution no public surface performs. Counting it is
 * possible and is not done: "compatible with 4 things" is a sentence that helps
 * nobody. The list stays on {@link ProductCompatibility} because the read that
 * closes the seam produces it, and it is the resolution that is owed.
 */

export interface CompatibilityPanelProps {
  compatibility: ProductCompatibility;
}

export function CompatibilityPanel({ compatibility }: CompatibilityPanelProps) {
  const { t } = useTranslation();

  if (compatibility.state === 'unavailable') return null;
  if (compatibility.fitment.length === 0) return null;

  return (
    <View className="gap-space-8">
      <Text className="text-captionBold text-text" accessibilityRole="header">
        {t('catalog.compatibility.title')}
      </Text>
      {compatibility.fitment.map((entry) => (
        <Text key={entry.id} className="text-body text-text-secondary">
          {describeFitment(entry)}
        </Text>
      ))}
    </View>
  );
}

/**
 * One fitment row as a sentence fragment.
 *
 * Every part comes off the row — the vehicle names are the registry's, the year
 * range is stored, and an absent part is omitted rather than filled in. Nothing
 * here abbreviates a generation or guesses a market.
 */
function describeFitment(entry: AutomotiveFitmentView): string {
  const parts = [
    entry.make.name,
    entry.model?.name,
    entry.generation?.name,
    entry.configuration?.name,
  ].filter((part): part is string => part !== null && part !== undefined);

  const years =
    entry.yearFrom === null && entry.yearTo === null
      ? undefined
      : `${entry.yearFrom === null ? '' : String(entry.yearFrom)}–${
          entry.yearTo === null ? '' : String(entry.yearTo)
        }`;

  return years === undefined ? parts.join(' ') : `${parts.join(' ')} (${years})`;
}
