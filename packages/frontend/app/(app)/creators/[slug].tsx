import { View } from 'react-native';
import Head from 'expo-router/head';
import { useLocalSearchParams } from 'expo-router';
import { Text } from '@mercaria/ui';
import { ScreenShell } from '@/components/shell/ScreenShell';
import { Footer } from '@/components/shell/Footer';
import { DigitalAssetGrid } from '@/components/digital/DigitalAssetGrid';
import { DigitalSurfaceNotice } from '@/components/digital/DigitalSurfaceNotice';
import { digitalCreatorPageSource } from '@/lib/digital/source';
import { useTranslation } from '@/lib/i18n';

/**
 * `/creators/:slug` — a digital creator's public page (#1015 Workstream 5).
 *
 * ## Why this is not `/sellers/:oxyUserId` or `/stores/:handle`
 *
 * The storefront already has two seller surfaces and this is a third, which is
 * worth justifying rather than assuming:
 *
 * - **`/sellers/:oxyUserId`** (#92) is the P2P person who sold a used thing. It
 *   is keyed on the Oxy ACCOUNT ID on purpose — never a handle, which a person
 *   can change — because that page is about a counterparty's trading record.
 * - **`/stores/:handle`** (#73) is a merchant's storefront: a commercial
 *   identity with listings, policies and a brand.
 * - **A creator** is the author of a WORK, and the page's subject is authorship:
 *   everything they made, and the versions they keep publishing to it. A buyer
 *   arrives from a model they liked, looking for the rest of that person's work.
 *
 * The address is a SLUG because a creator page is a thing people link to and
 * recognise; it resolves an id too, the way `/categories/:handle` does, so a
 * rename does not break a link (ADR 0007 D1 — a label is never identity).
 *
 * ## What renders today
 *
 * There is no client-reachable creator read (`lib/digital/source.ts`,
 * `HANDOFF.md` §6), so this answers `unavailable` and says so. The grid below is
 * the same `DigitalAssetGrid` the browse surfaces use — one grid, so a creator's
 * page and `/3d` cannot disagree about what a card says or where it goes.
 */
export default function CreatorScreen() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ slug: string }>();
  const slug = params.slug ?? '';

  const source = digitalCreatorPageSource(slug);
  const title = source.kind === 'ready' ? source.value.creator.name : t('digital.creator.fallbackTitle');

  return (
    <ScreenShell contentClassName="pt-6">
      <Head>
        <title>{t('digital.documentTitle', { title })}</title>
      </Head>

      <View className="mb-space-32 gap-space-24 web:mx-auto web:w-full web:max-w-[1200px] md:px-5">
        <Text className="text-headerBold text-text" accessibilityRole="header">
          {title}
        </Text>

        {source.kind === 'unavailable' ? (
          <DigitalSurfaceNotice reason={source.reason} />
        ) : (
          <>
            {source.value.biography === undefined ? null : (
              /* The creator's own words, verbatim. */
              <Text className="text-bodySmall text-text-secondary">{source.value.biography}</Text>
            )}
            <View className="gap-space-8">
              <Text className="text-captionBold text-text" accessibilityRole="header">
                {t('digital.creator.worksTitle')}
              </Text>
              {/* `filtered: false` — this page offers no filter rail, so an empty
                  grid can only mean the creator has published nothing here. */}
              <DigitalAssetGrid pages={source.value.pages} filtered={false} />
            </View>
          </>
        )}
      </View>

      <Footer />
    </ScreenShell>
  );
}
