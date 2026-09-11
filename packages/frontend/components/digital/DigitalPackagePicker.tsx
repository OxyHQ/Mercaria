import { Pressable, View } from 'react-native';
import { PriceDisplay, Text } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';
import type { DigitalPackageOffer } from '@/lib/digital/source';

/**
 * The packages one digital work sells, as a choice (#1015 Workstream 5, ADR 0010
 * D2).
 *
 * ## A package is a VARIANT, and that is why this is a picker
 *
 * ADR 0010 D2, on #1015 boundary 5 holding in the direction people expect it to
 * fail:
 *
 * > A buyer choosing between Personal €6 and Commercial €25 is choosing between
 * > two VARIANTS, each bound to its own licence option. The licence is not a
 * > variant AXIS and the rights still live on the licence version, but a priced
 * > choice is a priced thing and the catalogue already knows how to price
 * > variants.
 *
 * So selecting a package changes the PRICE and the LICENCE together, because both
 * belong to the option the variant is bound to. The screen holds the selection and
 * renders `AssetLicenceSummary` for whatever is selected; this component never
 * renders terms itself, so there is one place a licence is spelled out and no way
 * for a picker row and a terms panel to disagree.
 *
 * ## A FORMAT is not a choice, and the distinction is load-bearing
 *
 * #1015 boundary 6: several formats belong to one purchased package, so a format
 * is not a variant. A picker over formats would sell a buyer one file out of a set
 * they already own — which is why `formats` is rendered as a STATEMENT of what the
 * package contains, with no control beside it.
 *
 * The keys (`stl`, `glb`, `3mf`) are `ASSET_FORMAT_REGISTRY` machine keys shown
 * verbatim, for the reason an ISO currency code is: there is no localized form of
 * a file extension, and inventing one would stop matching what the creator's
 * archive actually contains.
 *
 * ## Every price goes through `PriceDisplay`
 *
 * `Money.amount` is integer MINOR UNITS and FAIR carries eight decimals, so a
 * price rendered as a number and a code prints `100000000 FAIR` for 1 FAIR.
 * `PriceDisplay` is the one chokepoint (`validate:money-formatting`), and it also
 * supplies the shopper's display currency, the approximate secondary figure and
 * bidi isolation — three properties a local render would lose at once.
 */

export interface DigitalPackagePickerProps {
  packages: readonly DigitalPackageOffer[];
  selectedPackageId: string;
  onSelect: (packageId: string) => void;
}

export function DigitalPackagePicker({
  packages,
  selectedPackageId,
  onSelect,
}: DigitalPackagePickerProps) {
  const { t } = useTranslation();

  return (
    <View className="gap-space-8" accessibilityRole="radiogroup">
      {packages.map((offer) => {
        const selected = offer.packageId === selectedPackageId;
        return (
          <Pressable
            key={offer.packageId}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            accessibilityLabel={offer.name}
            onPress={() => onSelect(offer.packageId)}
            className={
              selected
                ? 'gap-space-4 rounded-radius-16 border border-border-input-active bg-bg-fill-secondary p-space-16'
                : 'gap-space-4 rounded-radius-16 border border-border-secondary p-space-16'
            }
          >
            <View className="flex-row items-center justify-between gap-space-12">
              {/* The selected row is SPELLED as well as outlined — never colour
                  alone, which is the house rule every badge here follows. */}
              <Text className="text-bodyTitleSmall text-text">
                {selected ? `${offer.name} ✓` : offer.name}
              </Text>
              {offer.price === undefined ? (
                <Text className="text-caption text-text-tertiary">
                  {t('digital.asset.notForSale')}
                </Text>
              ) : (
                <PriceDisplay price={offer.price} primaryClassName="text-bodyTitleSmall text-text" />
              )}
            </View>

            {/* What is in the package — a statement, with no control beside it. */}
            <Text className="text-caption text-text-secondary">
              {t('digital.asset.formatsLabel', { formats: offer.formats.join(' · ') })}
            </Text>

            {/* The licence NAME only. Its terms render once, below, for whichever
                package is selected. */}
            <Text className="text-caption text-text-tertiary">{offer.licenceName}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
