import { View } from 'react-native';
import type { AutomotiveFitmentView, CompatibilityApplicability } from '@mercaria/shared-types';
import { Text } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';
import type { ProductCompatibility } from '@/lib/catalog/compatibility';

/**
 * Compatibility and fitment on a product page (#367 workstream 5, workstream 9).
 *
 * ## Every group states what it MEANS, and that is the whole point of the file
 *
 * The public read includes `does_not_apply` statements and offers no parameter to
 * remove them, so this component's one job is to render an exclusion AS an
 * exclusion. It used to render a flat list of vehicle names under a single
 * "Compatibility" heading, which meant a `does_not_apply` row printed identically
 * to a fit — "SEAT León (2015–2020)" under a heading a shopper reads as "fits" for
 * a part that explicitly does not. That is the highest-cost wrong answer in this
 * epic and it arrived through the renderer rather than through the data, which is
 * why the heading now comes from the group's own applicability through a `Record`
 * over the whole union: a fifth applicability fails `tsc` here rather than
 * inheriting whichever heading an `else` happened to name.
 *
 * `lib/catalog/compatibility.ts` does the partitioning and the ordering. Nothing
 * here decides which group a statement belongs in.
 *
 * ## The unavailable branch renders NOTHING, and that is the decision
 *
 * A section saying "we do not publish fitment for this product" on every product
 * in the catalogue would be a permanent apology on a page where the vast majority
 * of products have no fitment relationship to publish in the first place. A phone
 * is not missing its fitment data; it has none. Both unavailable reasons render as
 * absence — including `read_failed`, because a shopper cannot act on a fitment
 * endpoint being down, and the failure is already visible to whoever watches the
 * API.
 *
 * ## What is NOT rendered, and what each would need
 *
 * **A verdict for the shopper's own car.** `GET /compatibility/fitments/verdict`
 * answers it and the four `/compatibility/vehicles/...` rungs are the picker; both
 * are served and neither is called. That is an interaction rather than a read — a
 * cascading selection, a remembered vehicle, an answer that narrows as they choose
 * — and `resolveFitment` on the server is the only thing that may produce the
 * verdict, never a rule re-derived here from the list below.
 *
 * **The generic relation lookup.** `CompatibilityRelationView.target` is a bare id
 * union with no display name on it (a typed target's localized name is ADR 0007
 * D4's, and the public read resolves none), so there is nothing renderable to
 * fetch. Counting them is possible and is not done: "compatible with 4 things" is
 * a sentence that helps nobody.
 */

export interface CompatibilityPanelProps {
  compatibility: ProductCompatibility;
}

/**
 * The heading for each group, as a `Record` over the whole union.
 *
 * Total by construction, which is the point — see the header. `unknown` is present
 * and says "not confirmed": the server's publication policy does not publish an
 * unknown statement, so the group is empty in practice, but if one ever arrives it
 * must not inherit a heading meaning either "fits" or "does not fit".
 */
const GROUP_HEADING_KEY: Record<CompatibilityApplicability, string> = {
  applies: 'catalog.compatibility.fits',
  partially_applies: 'catalog.compatibility.partiallyFits',
  does_not_apply: 'catalog.compatibility.doesNotFit',
  unknown: 'catalog.compatibility.notConfirmed',
};

export function CompatibilityPanel({ compatibility }: CompatibilityPanelProps) {
  const { t } = useTranslation();

  if (compatibility.state === 'unavailable') return null;

  return (
    <View className="gap-space-12">
      <Text className="text-captionBold text-text" accessibilityRole="header">
        {t('catalog.compatibility.title')}
      </Text>

      {compatibility.groups.map((group) => (
        <View key={group.applicability} className="gap-space-4">
          <Text className="text-captionBold text-text-secondary" accessibilityRole="header">
            {t(GROUP_HEADING_KEY[group.applicability])}
          </Text>
          {group.fitments.map((entry) => (
            <Text key={entry.id} className="text-body text-text-secondary">
              {describeFitment(entry)}
            </Text>
          ))}
        </View>
      ))}

      {compatibility.truncated ? (
        <Text className="text-caption text-text-secondary">
          {t('catalog.compatibility.truncated')}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * One fitment row as a sentence fragment.
 *
 * Every part comes off the row — the vehicle names are the registry's, the year
 * range is stored, and an absent part is omitted rather than filled in. Nothing
 * here abbreviates a generation or guesses a market, and nothing states the
 * applicability: that is the GROUP's heading, so a row lifted out of its group
 * carries no claim of its own.
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
