import { View } from 'react-native';
import type { FeeRefundPolicy, FeeScheduleSummary, FeeTaxTreatment } from '@mercaria/shared-types';
import { Text } from '../ui/text';
import { formatDate } from '../../lib/date';
import { useFormatters } from '../../lib/use-formatters';
import { useSharedUiLocale, useSharedUiTranslation } from '../../i18n/ui-translation';

export interface FeeScheduleTermsProps {
  schedule: FeeScheduleSummary;
}

/**
 * How each tax treatment is worded.
 *
 * KEYS rather than sentences, and a full literal per member: this map is read
 * before the locale store has rehydrated, and `validate:i18n-strings` resolves
 * `t()` arguments as literals — a key composed from the value at runtime would
 * be invisible to it and could go missing from a bundle unnoticed.
 */
const TAX_COPY: Record<FeeTaxTreatment, string> = {
  unknown: 'ui.feeTerms.taxUnknown',
  exclusive: 'ui.feeTerms.taxExclusive',
  inclusive: 'ui.feeTerms.taxInclusive',
};

/**
 * How each refund policy is worded.
 *
 * A `Record<FeeRefundPolicy, string>` rather than the one key the single member
 * needs today, for the reason `FeeRefundPolicy`'s own docblock gives: adding a
 * `retain` policy is "a code change plus a CHECK widening under its own
 * review". This map is what makes that review reach every screen that records
 * a seller's consent — a new member fails `tsc` here. Keyed on a literal
 * sentence instead, a second policy would leave every seller reading "refunded
 * in proportion" about a fee Mercaria now keeps, on a green build.
 */
const REFUND_COPY: Record<FeeRefundPolicy, string> = {
  proportional: 'ui.feeTerms.refundProportional',
};

/**
 * A marketplace fee schedule's terms, stated from the schedule itself — the ONE
 * rendering of what a seller accepts (ADR 0018), for a store on the dashboard's
 * Settings → Marketplace fees and a private seller on the storefront's
 * Settings → Payments. Two copies would be two descriptions of one consent that
 * could drift apart.
 *
 * `merchantSummary` is shown verbatim and untranslated: it is the text the
 * acceptance record points at, English by design (`services/fees/catalog.ts`).
 * The lines below it are each app's language, derived from the schedule's own
 * figures, never a literal rate.
 *
 * Renders the content only; the caller supplies the card around it.
 */
export function FeeScheduleTerms({ schedule }: FeeScheduleTermsProps) {
  const t = useSharedUiTranslation();
  const locale = useSharedUiLocale();
  const { formatMoney, formatPercent } = useFormatters();
  const currency = schedule.eligibleCurrency;
  const effectiveFrom = formatDate(schedule.effectiveStart, locale);

  return (
    <View>
      <Text className="text-sm font-semibold text-foreground">{schedule.name}</Text>
      <Text className="mt-1 text-xs text-muted-foreground">{schedule.merchantSummary}</Text>
      <View className="mt-3 gap-1">
        <Text className="text-xs text-foreground">
          {t('ui.feeTerms.percentage', { percent: formatPercent(schedule.percentageBps) })}
        </Text>
        {schedule.fixedFee ? (
          <Text className="text-xs text-foreground">
            {t('ui.feeTerms.fixed', { amount: formatMoney(schedule.fixedFee) })}
          </Text>
        ) : null}
        {/*
          True of every schedule under the charge model (ADR 0001 D3, ADR 0018):
          Mercaria is the platform and pays the card processor itself, so the
          fee above is the whole of what a seller pays per sale.
        */}
        <Text className="text-xs text-foreground">{t('ui.feeTerms.processingIncluded')}</Text>
        {/*
          A schedule pinned to a fiat currency is a card-sales schedule: card
          checkout presents only in fiat, and no schedule covers FAIR, so a
          sale paid in FairCoin selects none and carries no fee (ADR 0018,
          ADR 0019 D5). FairCoin is a payment method every seller can be paid
          with, so the terms say so in words.
        */}
        {currency !== undefined && currency !== 'FAIR' ? (
          <Text className="text-xs text-foreground">
            {t('ui.feeTerms.cardSalesOnly', { currency })}
          </Text>
        ) : null}
        <Text className="text-xs text-foreground">{t('ui.feeTerms.faircoinNoFee')}</Text>
        {/*
          A clamp is an amount, so it can only be rendered in the currency the
          schedule pinned. The type allows the currency to be absent (a pure
          percentage applies in any), and the database refuses that combination
          — so this shows nothing rather than guessing a currency, which is the
          "unknown is never zero" rule applied to a unit.
        */}
        {schedule.minFeeMinor !== undefined && currency !== undefined ? (
          <Text className="text-xs text-foreground">
            {t('ui.feeTerms.min', {
              amount: formatMoney({ amount: schedule.minFeeMinor, currency }),
            })}
          </Text>
        ) : null}
        {schedule.maxFeeMinor !== undefined && currency !== undefined ? (
          <Text className="text-xs text-foreground">
            {t('ui.feeTerms.max', {
              amount: formatMoney({ amount: schedule.maxFeeMinor, currency }),
            })}
          </Text>
        ) : null}
        <Text className="text-xs text-muted-foreground">{t('ui.feeTerms.basis')}</Text>
        <Text className="text-xs text-muted-foreground">
          {t(REFUND_COPY[schedule.refundPolicy])}
        </Text>
        <Text className="text-xs text-muted-foreground">{t(TAX_COPY[schedule.taxTreatment])}</Text>
        <Text className="text-xs text-muted-foreground">
          {t('ui.feeTerms.version', { version: schedule.termsVersion })}
        </Text>
        {effectiveFrom === null ? null : (
          <Text className="text-xs text-muted-foreground">
            {t('ui.feeTerms.effectiveFrom', { date: effectiveFrom })}
          </Text>
        )}
      </View>
    </View>
  );
}
