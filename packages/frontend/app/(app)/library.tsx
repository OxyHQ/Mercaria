import { Pressable, View } from 'react-native';
import Head from 'expo-router/head';
import { useRouter } from 'expo-router';
import { openAccountDialog, useOxy } from '@oxy.so/services';
import { BuyerAssetRightCard, Text } from '@mercaria/ui';
import { ScreenShell } from '@/components/shell/ScreenShell';
import { Footer } from '@/components/shell/Footer';
import { DigitalSurfaceNotice } from '@/components/digital/DigitalSurfaceNotice';
import { digitalAssetHref } from '@/lib/digital/routes';
import { digitalLibrarySource } from '@/lib/digital/source';
import { useTranslation } from '@/lib/i18n';

/**
 * `/library` — everything a buyer owns digitally (#1015 Workstream 9).
 *
 * ## What a library row is, and what it is not
 *
 * One `asset_rights` row, projected as `BuyerAssetRightSummary` and rendered by
 * `BuyerAssetRightCard`. A right is the ownership record; a URL is not (#1015
 * boundary 3), which is why the DTO carries no storage reference at all and why
 * the download control on each file asks the SERVER for a five-minute grant
 * rather than following a link this page was handed.
 *
 * The four things W9 requires a buyer see before fetching — the file NAME, its
 * FORMAT, its BYTE SIZE, and whether it is downloadable — are on every file row,
 * and the `updateAvailable` flag is the DTO's own comparison rather than one
 * recomputed here from two version labels.
 *
 * ## Signed out, this page offers rather than gates
 *
 * A right is keyed on a buyer — an Oxy account, or a guest session that CLAIMS
 * its order later (ADR 0010 D9.5). So there is genuinely nothing to show a
 * signed-out visitor, and the invitation says what signing in gets them rather
 * than what they are missing: the `saved.tsx` posture, for the same reason.
 *
 * ## Nothing here can delete a row, and that is the domain's doing
 *
 * ADR 0010 D6 gives `asset_rights` no delete path and freezes every commercial
 * column, so a refunded, disputed or revoked purchase is still on this page with
 * its status stated and its download controls gone. There is no "remove from
 * library" control because there is no operation behind one.
 *
 * ## What renders today
 *
 * `listBuyerLibrary` already returns this exact projection, and it is reachable
 * from the service layer only — #1015 Phase A shipped no buyer-facing HTTP route
 * (`HANDOFF.md` §6). So the page renders a sentence, and the list below is what
 * runs when the route lands.
 */
export default function DigitalLibraryScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { isAuthenticated } = useOxy();

  const source = digitalLibrarySource();

  return (
    <ScreenShell contentClassName="pt-6">
      <Head>
        <title>{t('digital.documentTitle', { title: t('digital.library.title') })}</title>
      </Head>

      <View className="mb-space-32 gap-space-16 web:mx-auto web:w-full web:max-w-[1200px] md:px-5">
        <View className="gap-space-4">
          <Text className="text-headerBold text-text" accessibilityRole="header">
            {t('digital.library.title')}
          </Text>
          <Text className="text-bodySmall text-text-secondary">
            {t('digital.library.description')}
          </Text>
        </View>

        {!isAuthenticated ? (
          <SignedOutInvitation />
        ) : source.kind === 'unavailable' ? (
          <DigitalSurfaceNotice reason={source.reason} />
        ) : source.value.rights.length === 0 ? (
          <Text className="text-bodySmall text-text-tertiary">{t('digital.library.empty')}</Text>
        ) : (
          <View className="gap-space-12">
            {source.value.rights.map((right) => (
              <BuyerAssetRightCard
                key={right.rightId}
                right={right}
                /*
                 * No `onDownload` yet: minting a grant is a server call that does
                 * not exist, and a button that cannot do its job is worse than no
                 * button — the card renders the full inventory without one, which
                 * is the part W9 requires. Wiring it is one prop.
                 */
                onOpenAsset={(assetId) => router.push(digitalAssetHref(assetId))}
              />
            ))}
          </View>
        )}
      </View>

      <Footer />
    </ScreenShell>
  );
}

/**
 * What a signed-out visitor is offered.
 *
 * Says what an account holds, and nothing about what they are missing — they are
 * not missing anything they had. `openAccountDialog()` is the ONE sign-in surface
 * (`~/Oxy/AGENTS.md`: no app-local sign-in screen).
 */
function SignedOutInvitation() {
  const { t } = useTranslation();
  return (
    <View className="gap-space-12 rounded-radius-16 border border-border-secondary bg-bg-fill p-space-16">
      <Text className="text-bodyTitleSmall text-text">{t('digital.library.signedOut.title')}</Text>
      <Text className="text-bodySmall text-text-secondary">
        {t('digital.library.signedOut.body')}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('digital.library.signedOut.signIn')}
        onPress={() => openAccountDialog()}
        className="items-center rounded-radius-max bg-bg-fill-brand py-space-12"
      >
        <Text className="text-buttonMedium text-text-inverse">
          {t('digital.library.signedOut.signIn')}
        </Text>
      </Pressable>
    </View>
  );
}
