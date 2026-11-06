import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import type { FeeScheduleSummary, SellerFeeScheduleView } from '@mercaria/shared-types';
import { FeeScheduleTerms, Text, formatDate, useSettingsDialog } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';
import { useAcceptSellerFeeSchedule, useSellerFeeSchedule } from '@/lib/hooks/use-seller-payments';

/**
 * A private seller's marketplace fee terms (ADR 0018 D3).
 *
 * The same terms, the same rendering (`FeeScheduleTerms`) and the same
 * acceptance record a store's owner meets on the dashboard: the storefront
 * writes `fee_schedule_acceptances` with `owner_type = 'user'` through the
 * handler the store route uses, and checkout's gate reads that one table for
 * both. Until a seller accepts the schedule their card sales select, the gate
 * refuses those sales — so this card is not optional furniture, and it says
 * exactly that, before the first sale rather than after a refused one.
 */

/** Whether a fee schedule applies to the seller and they have not accepted it. */
export function isFeeTermsPending(view: SellerFeeScheduleView | undefined): boolean {
  return view?.schedule !== undefined && view.acceptance === undefined;
}

/**
 * The fee card on Settings → Payments. Renders nothing while no schedule
 * applies: a seller is never asked to accept a fee nobody charges.
 */
export function SellerFeeTermsCard({ view }: { view: SellerFeeScheduleView }) {
  const { t, locale } = useTranslation();
  const { schedule, acceptance } = view;
  if (!schedule) return null;
  const acceptedOn = acceptance ? formatDate(acceptance.acceptedAt, locale) : null;

  return (
    <View
      className={`rounded-2xl border bg-card p-4 ${acceptance ? 'border-border' : 'border-primary'}`}
    >
      <Text className="text-sm font-semibold text-foreground">
        {t(
          acceptance
            ? 'settings.payments.fees.accepted.heading'
            : 'settings.payments.fees.pending.heading',
        )}
      </Text>
      {acceptance ? (
        // `formatDate` answers null on a value it cannot parse; the heading
        // already says the terms were accepted, so the detail is omitted
        // rather than rendering the word "null" as a date.
        acceptedOn === null ? null : (
          <Text className="mt-1 text-xs text-muted-foreground">
            {t('settings.payments.fees.accepted.body', {
              version: acceptance.termsVersion,
              date: acceptedOn,
            })}
          </Text>
        )
      ) : (
        <Text className="mt-1 text-xs text-muted-foreground">
          {t('settings.payments.fees.pending.body')}
        </Text>
      )}

      <View className="mt-4 rounded-xl border border-border p-3">
        <FeeScheduleTerms schedule={schedule} />
      </View>
      {acceptance ? null : (
        <>
          <Text className="mt-3 text-xs text-muted-foreground">
            {t('settings.payments.fees.englishTerms')}
          </Text>
          <AcceptAction schedule={schedule} />
        </>
      )}
    </View>
  );
}

/**
 * The one write: the body echoes the version this render showed. A schedule
 * that moved underneath it is refused with a conflict and the card refetches
 * (the mutation invalidates on settle), so the seller reads the current terms
 * before pressing again.
 */
function AcceptAction({ schedule }: { schedule: FeeScheduleSummary }) {
  const { t } = useTranslation();
  const accept = useAcceptSellerFeeSchedule();

  async function onAccept(): Promise<void> {
    try {
      await accept.mutateAsync({
        scheduleKey: schedule.scheduleKey,
        version: schedule.version,
        termsVersion: schedule.termsVersion,
      });
      toast.success(t('settings.payments.fees.acceptSucceeded'));
    } catch {
      toast.error(t('settings.payments.fees.acceptFailed'));
    }
  }

  return (
    <Button
      tone="accent"
      className="mt-3 self-start"
      loading={accept.isPending}
      disabled={accept.isPending}
      onPress={onAccept}
    >
      {t('settings.payments.fees.pending.action')}
    </Button>
  );
}

/**
 * The prompt where a private seller starts selling (`/sell`): before their
 * first card sale, not after a buyer was refused. Renders nothing unless a
 * schedule applies and is not yet accepted.
 */
export function SellerFeeTermsNotice() {
  const { t } = useTranslation();
  const { open } = useSettingsDialog();
  const { data } = useSellerFeeSchedule();
  if (!isFeeTermsPending(data)) return null;

  return (
    <View className="gap-2 rounded-xl border border-primary p-4">
      <Text className="text-sm font-semibold text-foreground">
        {t('settings.payments.fees.pending.heading')}
      </Text>
      <Text className="text-sm text-muted-foreground">
        {t('settings.payments.fees.notice.body')}
      </Text>
      <Button tone="accent" size="sm" className="self-start" onPress={() => open('payments')}>
        {t('settings.payments.fees.notice.action')}
      </Button>
    </View>
  );
}
