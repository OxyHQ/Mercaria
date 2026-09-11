import { useState } from 'react';
import { Pressable, View } from 'react-native';
import Head from 'expo-router/head';
import { useRouter } from 'expo-router';
import type { FacetSelectionEntry } from '@mercaria/shared-types';
import { Text } from '@mercaria/ui';
import { ScreenShell } from '@/components/shell/ScreenShell';
import { Footer } from '@/components/shell/Footer';
import { FacetRail } from '@/components/catalog/FacetRail';
import { DigitalAssetGrid } from '@/components/digital/DigitalAssetGrid';
import { DigitalSurfaceNotice } from '@/components/digital/DigitalSurfaceNotice';
import { useFacets } from '@/lib/catalog/use-facets';
import { digitalBrowseHref, digitalLibraryHref } from '@/lib/digital/routes';
import { digitalBrowseSource } from '@/lib/digital/source';
import {
  DIGITAL_BROWSE_SURFACES,
  siblingDigitalSurfaces,
  type DigitalBrowseSurfaceKey,
} from '@/lib/digital/surfaces';
import { useTranslation } from '@/lib/i18n';

/**
 * The body of `/3d`, `/3d/printable` and `/3d/game-assets` (#1015 Workstream 5).
 *
 * ONE component for three addresses, because the three differ only in which
 * surface descriptor they name: same rail, same grid, same empty states, same
 * cross-links. Three copies would be three places for the rail wiring to drift,
 * and the drift is invisible — each page still renders.
 *
 * ## The facet rail is the SERVER's, end to end (#1015 acceptance criterion 18)
 *
 * > facets and filters must come from the product-profile/attribute registry,
 * > never from hard-coded 3D React components
 *
 * There is no filter list in this file and nowhere to put one. `useFacets` posts
 * a SCOPE and a selection to `POST /facets`, which generates the rail from #94's
 * attribute registry over the canonical graph — the ordering from versioned
 * metadata, the suppressions with their reasons, the counts at the right grain and
 * the localized labels. `FacetRail` maps over that response and composes, filters,
 * orders and suppresses none of it. This screen adds only the selection STATE.
 *
 * Three consequences worth stating, because each is a thing somebody would
 * otherwise add:
 *
 * 1. **The scope comes from the read, never from here.** A `FacetScope` names a
 *    category id or a set of canonical product ids; a client that built one for
 *    "3D" would hold catalogue identity a data change cannot reach (ADR 0007 D1,
 *    `validate:storefront-catalog-driven` wall 3). Until the read hands one over,
 *    `useFacets` is disabled by its own `enabled: scope !== undefined`.
 * 2. **A 404 is "no rail", never an empty rail.** `FACETS_ENABLED` defaults off
 *    and a client cannot see it, so `data === undefined` means this deployment
 *    offers no filters here — and an empty rail would say there is nothing to
 *    filter by, which is a different and false statement.
 * 3. **A rail is offered only when the grid can act on the WHOLE selection.**
 *    `selectionApplied` is the read's own answer. `lib/catalog/facet-consumption.ts`
 *    measured why a partially-wired rail is worse than none: buckets that filter
 *    and buckets that do not, rendered identically, leave a shopper unable to tell
 *    which half is which.
 *
 * ## What renders today
 *
 * `lib/digital/source.ts` answers `unavailable` for every surface, because #1015
 * Phase A shipped no client-reachable read (`HANDOFF.md` §6). So the page renders
 * its heading, its cross-links and a sentence — and the composition below is the
 * one that runs when the read lands, with nothing else to change here.
 */

export interface DigitalBrowseScreenProps {
  surfaceKey: DigitalBrowseSurfaceKey;
}

export function DigitalBrowseScreen({ surfaceKey }: DigitalBrowseScreenProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const surface = DIGITAL_BROWSE_SURFACES[surfaceKey];

  /** The shopper's filter selection. The SERVER decides what it can contain. */
  const [selection, setSelection] = useState<readonly FacetSelectionEntry[]>([]);

  const source = digitalBrowseSource(surface, { entries: selection });
  const result = source.kind === 'ready' ? source.value : undefined;

  /*
   * `scope` is `undefined` until the read hands one over, which DISABLES the
   * query (`useFacets`' own `enabled`) rather than sending a scope this screen
   * invented.
   */
  const facets = useFacets({ scope: result?.facetScope, selection });

  const title = t(surface.titleKey);
  /* A rail only when the server answered one AND the grid can act on all of it. */
  const railResponse =
    result?.selectionApplied === true ? facets.data : undefined;

  return (
    <ScreenShell contentClassName="pt-6">
      <Head>
        <title>{t('digital.documentTitle', { title })}</title>
        <meta name="description" content={t(surface.descriptionKey)} />
      </Head>

      <View className="mb-space-32 gap-space-24 web:mx-auto web:w-full web:max-w-[1200px] md:px-5">
        <View className="gap-space-8">
          <Text className="text-headerBold text-text" accessibilityRole="header">
            {title}
          </Text>
          <Text className="text-bodySmall text-text-secondary">
            {t(surface.descriptionKey)}
          </Text>
        </View>

        {/* The other digital surfaces, derived from the table so a fourth cannot
            be forgotten on two screens out of three. */}
        <View className="gap-space-8">
          <Text className="text-captionBold text-text-secondary">
            {t('digital.browseOther')}
          </Text>
          <View className="flex-row flex-wrap gap-space-8">
            {siblingDigitalSurfaces(surfaceKey).map((sibling) => (
              <Pressable
                key={sibling.key}
                accessibilityRole="link"
                accessibilityLabel={t(sibling.titleKey)}
                onPress={() => router.push(digitalBrowseHref(sibling.route))}
                className="rounded-radius-max border border-border-secondary px-space-12 py-space-6"
              >
                <Text className="text-caption text-text">{t(sibling.titleKey)}</Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={t('digital.library.title')}
              onPress={() => router.push(digitalLibraryHref())}
              className="rounded-radius-max border border-border-secondary px-space-12 py-space-6"
            >
              <Text className="text-caption text-text">{t('digital.library.title')}</Text>
            </Pressable>
          </View>
        </View>

        <View className="gap-space-24 md:flex-row">
          {railResponse === undefined ? null : (
            <View className="md:w-64">
              <FacetRail
                response={railResponse}
                selection={selection}
                onSelectionChange={(next) => setSelection(next)}
              />
            </View>
          )}

          <View className="flex-1">
            {source.kind === 'unavailable' ? (
              <DigitalSurfaceNotice reason={source.reason} />
            ) : (
              <DigitalAssetGrid pages={source.value.pages} filtered={selection.length > 0} />
            )}
          </View>
        </View>
      </View>

      <Footer />
    </ScreenShell>
  );
}
