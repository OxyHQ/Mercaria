import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@mercaria/ui';
import { create } from 'zustand';
import { useTranslation } from '@/lib/i18n';
import {
  useReferralConsent,
  useReferralConsentStore,
  useReferralDisclosureStore,
} from '@/lib/hooks/use-referral-binding';

/**
 * What a buyer who followed a partner's link is told, and — first — asked.
 *
 * ## While the answer is pending: the consent prompt
 *
 * The link's carrier is in page memory only (`use-referral-binding.ts`), and
 * nothing is stored on the device or bound to anybody until the buyer allows it
 * (ePrivacy Art. 5(3)). So the notice says what is true by ADR 0005 — somebody
 * may be rewarded, and the price does not move (I2: the pricing engine takes no
 * referral input), never who — adds that Mercaria remembers the visit for up to
 * 90 days only if allowed, and offers two equally weighted choices: declining
 * must be as easy as allowing.
 *
 * ## After Allow: the paid-referral disclosure
 *
 * Shown while a consented carrier is held and after a bind that says one is
 * owed, with the program's own buyer-facing terms VERBATIM once bound —
 * `publicTermsSummary` exists precisely to be rendered as written. Dismissed in
 * memory, per terms: a reload while the click is still held shows it again,
 * and terms that arrive after a dismissal are new and shown.
 */
const useDismissed = create<{ terms: string | null; dismiss: (terms: string) => void }>((set) => ({
  terms: null,
  dismiss: (terms) => set({ terms }),
}));

export function ReferralDisclosureNotice() {
  const undecided = useReferralConsentStore((state) => state.carrier !== null);
  return undecided ? <ReferralConsentPrompt /> : <ReferralDisclosure />;
}

function ReferralConsentPrompt() {
  const { t } = useTranslation();
  const consent = useReferralConsent();
  const busy = consent.isPending;

  return (
    <View
      role="note"
      className="mx-space-16 mt-space-12 gap-space-8 rounded-radius-16 border border-border-secondary p-space-16"
    >
      <Text className="text-shop-captionBold text-text">{t('referral.disclosure.title')}</Text>
      <Text className="text-shop-bodySmall text-text-secondary">
        {t('referral.disclosure.body')}
      </Text>
      <Text className="text-shop-bodySmall text-text-secondary">{t('referral.consent.body')}</Text>
      <View className="flex-row flex-wrap gap-space-8">
        <Button
          appearance="outline"
          size="sm"
          disabled={busy}
          loading={busy && consent.variables === 'granted'}
          onPress={() => consent.mutate('granted')}
        >
          {t('referral.consent.allow')}
        </Button>
        <Button
          appearance="outline"
          size="sm"
          disabled={busy}
          onPress={() => consent.mutate('denied')}
        >
          {t('referral.consent.decline')}
        </Button>
      </View>
      {consent.isError ? (
        <Text role="alert" className="text-shop-bodySmall text-text-secondary">
          {t('referral.consent.failed')}
        </Text>
      ) : null}
    </View>
  );
}

function ReferralDisclosure() {
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
