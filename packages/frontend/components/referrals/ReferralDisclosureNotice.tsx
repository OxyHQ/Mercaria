import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@mercaria/ui';
import { create } from 'zustand';
import { useTranslation } from '@/lib/i18n';
import { useReferralDisclosureStore } from '@/lib/hooks/use-referral-binding';

/**
 * The paid-referral disclosure a buyer is owed after following a partner's
 * link (#143): a held carrier is proof a link was followed, so the notice shows
 * before any bind, and once bound it adds the program's own buyer-facing terms,
 * VERBATIM — `publicTermsSummary` exists precisely to be rendered as written.
 *
 * It says what is true by ADR 0005: somebody may be rewarded, and the price
 * does not move (I2: the pricing engine takes no referral input). It never says
 * who — the client is never told (`ReferralStateView` carries no partner).
 *
 * Dismissed in memory, per terms: a reload while the click is still held shows
 * it again, and terms that arrive after a dismissal are new and shown.
 */
const useDismissed = create<{ terms: string | null; dismiss: (terms: string) => void }>((set) => ({
  terms: null,
  dismiss: (terms) => set({ terms }),
}));

export function ReferralDisclosureNotice() {
  const { t } = useTranslation();
  const required = useReferralDisclosureStore((state) => state.required);
  const termsSummary = useReferralDisclosureStore((state) => state.termsSummary);
  const dismissedTerms = useDismissed((state) => state.terms);
  const dismiss = useDismissed((state) => state.dismiss);

  const terms = termsSummary ?? '';
  if (!required || dismissedTerms === terms) return null;

  return (
    <View
      role="note"
      className="mx-space-16 mt-space-12 gap-space-8 rounded-radius-16 border border-border-secondary p-space-16"
    >
      <Text className="text-shop-captionBold text-text">{t('referral.disclosure.title')}</Text>
      <Text className="text-shop-bodySmall text-text-secondary">
        {t('referral.disclosure.body')}
      </Text>
      {termsSummary ? (
        <Text className="text-shop-bodySmall text-text-secondary">{termsSummary}</Text>
      ) : null}
      <View className="flex-row">
        <Button appearance="outline" size="sm" onPress={() => dismiss(terms)}>
          {t('referral.disclosure.dismiss')}
        </Button>
      </View>
    </View>
  );
}
