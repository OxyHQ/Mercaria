import { View } from 'react-native';
import { Text } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';
import type { DigitalSurfaceUnavailableReason } from '@/lib/digital/source';

/**
 * What a digital surface says when it has nothing to show (#1015 Workstreams 5
 * and 9).
 *
 * ## Why a sentence rather than an empty grid or a hidden section
 *
 * `DigitalSurfaceUnavailableReason` has one member — there is no client-reachable
 * read for digital commerce yet (`lib/digital/source.ts` records why, and what
 * has to land) — and the three ways of rendering that state are not equivalent:
 *
 * - **An empty grid** says the catalogue is empty, which is a claim about the
 *   marketplace rather than about this deployment. `CatalogProductGrid` keeps
 *   three distinct empty states for precisely this reason (#72 brand rule 10).
 * - **A hidden section** leaves a reader unable to tell "we offer none of this"
 *   from "this part did not load" — the failure `docs/catalog-pages.md` names.
 * - **A sentence** is the only one of the three that is true, and it is the
 *   `useFacets` posture one level up: the client cannot see a server lever, so it
 *   states an absence and claims nothing about the cause.
 *
 * The second line is the one that matters to somebody who already owns
 * something: nothing a buyer holds is affected by this surface being dark.
 * `asset_rights` has no delete path, `DIGITAL_DOWNLOADS_ENABLED` is the only
 * lever that reaches an existing right and it defaults ON (ADR 0010 D13), so a
 * dark storefront is never a lost purchase — and a reader should not have to
 * infer that.
 */

export interface DigitalSurfaceNoticeProps {
  /**
   * Why there is nothing to show.
   *
   * Required and typed, even though the union has one member: the sentence
   * rendered is a consequence of a REASON, and a component that took no argument
   * would have to be re-read (rather than re-typed) when a second reason exists.
   */
  reason: DigitalSurfaceUnavailableReason;
}

export function DigitalSurfaceNotice({ reason }: DigitalSurfaceNoticeProps) {
  const { t } = useTranslation();

  /*
   * One reason, one pair of sentences. Written as a switch rather than two bare
   * `t()` calls so a second member of the union fails the typecheck here — the
   * exhaustiveness is the whole value of keeping the reason in the props.
   */
  switch (reason) {
    case 'no_digital_read_surface':
      return (
        <View className="gap-space-4 rounded-radius-16 border border-border-secondary p-space-16">
          <Text className="text-captionBold text-text">{t('digital.unavailable.title')}</Text>
          <Text className="text-bodySmall text-text-secondary">
            {t('digital.unavailable.body')}
          </Text>
        </View>
      );
  }
}
