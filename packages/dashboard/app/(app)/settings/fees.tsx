import React, { useState } from "react";
import { View, Pressable } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { ChevronLeft } from "lucide-react-native";
import {
  CURRENCY_PRECISION,
  type CurrencyCode,
  type FeePreview,
  type FeeRefundPolicy,
  type FeeScheduleSummary,
  type FeeTaxTreatment,
  type StoreFeeScheduleView,
} from "@mercaria/shared-types";
import { Text, Button, formatDate, useColorScheme, useFormatters } from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { useTranslation } from "@/lib/i18n";
import { useAcceptFeeSchedule, useFeeSchedule, usePreviewFee } from "@/lib/hooks/use-fees";

/**
 * Marketplace fees — what this store pays Mercaria per sale, and the consent
 * that lets it keep selling (#88, #85).
 *
 * ## Why this screen is not optional furniture
 *
 * `merchant-activation/checkout-gate.ts` refuses a checkout with
 * `seller_not_activated` once an applicable schedule exists and this store has
 * no acceptance row for that exact version. So the schedule an operator
 * activates and this screen are two halves of one act: activating without a
 * surface to accept on takes every unaccepted store offline, silently, at the
 * next purchase.
 *
 * ## `store:manage`, not `settings:write`
 *
 * The same gate the route carries, and for the route's stated reason: agreeing
 * to what a store pays Mercaria is a binding commercial consent and therefore
 * the owner's decision. `store:manage` is the one permission an `admin` does
 * not hold.
 *
 * ## No schedule is a real answer, not a failure
 *
 * A deployment with none charges a real zero (`no_active_schedule`, never a
 * calculated zero). The empty state says exactly that rather than implying
 * something did not load.
 *
 * ## The preview asks the server
 *
 * The percentage, the fixed component and both clamps are all on screen, so
 * multiplying them here would be a few lines. It would also be a second
 * implementation of the arithmetic `services/fees/` exists to keep single —
 * and the copy that drifts is the one no order is ever charged against. The
 * example baskets are whole major units scaled by `CURRENCY_PRECISION`, so
 * they are correct for JPY (no minor unit) and FAIR (eight) as well as EUR.
 */
export default function FeesScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("settings.fees.documentTitle")}</title>
      </Head>
      <RequireStore permission="store:manage">
        {(storeId) => <FeesBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function FeesBody({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const { data, isPending, isError } = useFeeSchedule(storeId);

  const back = (
    <Pressable
      onPress={() => router.back()}
      className="h-9 flex-row items-center gap-1 rounded-lg border border-border px-3 active:opacity-70"
    >
      <ChevronLeft size={16} color={colors.foreground} />
      <Text className="text-sm font-medium text-foreground">{t("common.back")}</Text>
    </Pressable>
  );

  if (isPending) {
    return (
      <Screen title={t("settings.fees.title")} action={back}>
        <ScreenLoading />
      </Screen>
    );
  }
  if (isError || !data) {
    return (
      <Screen title={t("settings.fees.title")} action={back}>
        <ScreenMessage
          title={t("settings.fees.loadFailed")}
          body={t("common.pleaseTryAgain")}
        />
      </Screen>
    );
  }

  return (
    <Screen
      title={t("settings.fees.title")}
      subtitle={t("settings.fees.subtitle")}
      action={back}
    >
      <FeesPanel storeId={storeId} view={data} />
    </Screen>
  );
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
  unknown: "settings.fees.terms.taxUnknown",
  exclusive: "settings.fees.terms.taxExclusive",
  inclusive: "settings.fees.terms.taxInclusive",
};

/**
 * How each refund policy is worded.
 *
 * A `Record<FeeRefundPolicy, string>` rather than the one key the single member
 * needs today, for the reason `FeeRefundPolicy`'s own docblock gives: adding a
 * `retain` policy is "a code change plus a CHECK widening under its own
 * review". This map is what makes that review reach this screen — a new member
 * fails `tsc` here. Keyed on a literal sentence instead, a second policy would
 * leave every merchant reading "refunded in proportion" about a fee Mercaria
 * now keeps, on a green build, inside the screen that records their consent.
 */
const REFUND_COPY: Record<FeeRefundPolicy, string> = {
  proportional: "settings.fees.terms.refundProportional",
};

function FeesPanel({ storeId, view }: { storeId: string; view: StoreFeeScheduleView }) {
  const { t, locale } = useTranslation();
  const { schedule, acceptance } = view;
  const acceptedOn = acceptance ? formatDate(acceptance.acceptedAt, locale) : null;

  if (!schedule) {
    return (
      <View className="rounded-2xl border border-border bg-surface p-4">
        <Text className="text-sm font-semibold text-foreground">
          {t("settings.fees.none.heading")}
        </Text>
        <Text className="mt-1 text-xs text-muted-foreground">
          {t("settings.fees.none.body")}
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-5">
      <View
        className={`rounded-2xl border p-4 ${acceptance ? "border-primary bg-surface" : "border-border bg-surface"}`}
      >
        <Text className="text-sm font-semibold text-foreground">
          {t(acceptance ? "settings.fees.accepted.heading" : "settings.fees.pending.heading")}
        </Text>
        {/*
          `formatDate` answers null on a value it cannot parse, and a null
          interpolated into the sentence would render the word "null" as a
          date. The heading already carries the fact that the terms were
          accepted, so the detail line is simply omitted rather than guessed.
        */}
        {acceptance ? (
          acceptedOn === null ? null : (
            <Text className="mt-1 text-xs text-muted-foreground">
              {t("settings.fees.accepted.body", {
                version: acceptance.termsVersion,
                date: acceptedOn,
              })}
            </Text>
          )
        ) : (
          <Text className="mt-1 text-xs text-muted-foreground">
            {t("settings.fees.pending.body")}
          </Text>
        )}
        {acceptance ? null : <AcceptAction storeId={storeId} schedule={schedule} />}
      </View>

      <ScheduleTerms schedule={schedule} />
      <FeeExample storeId={storeId} schedule={schedule} />
    </View>
  );
}

/** The commercial offer itself, stated in the schedule's own terms. */
function ScheduleTerms({ schedule }: { schedule: FeeScheduleSummary }) {
  const { t, locale } = useTranslation();
  const { formatMoney, formatPercent } = useFormatters();
  const currency = schedule.eligibleCurrency;
  const effectiveFrom = formatDate(schedule.effectiveStart, locale);

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">{schedule.name}</Text>
      <Text className="mt-1 text-xs text-muted-foreground">{schedule.merchantSummary}</Text>
      <View className="mt-3 gap-1">
        <Text className="text-xs text-foreground">
          {t("settings.fees.terms.percentage", {
            percent: formatPercent(schedule.percentageBps),
          })}
        </Text>
        {schedule.fixedFee ? (
          <Text className="text-xs text-foreground">
            {t("settings.fees.terms.fixed", { amount: formatMoney(schedule.fixedFee) })}
          </Text>
        ) : null}
        {/*
          A clamp is an amount, so it can only be rendered in the currency the
          schedule pinned. The type allows the currency to be absent (a pure
          percentage applies in any), and the database refuses that combination
          — so this shows nothing rather than guessing a currency, which is the
          "unknown is never zero" rule applied to a unit.
        */}
        {schedule.minFeeMinor !== undefined && currency !== undefined ? (
          <Text className="text-xs text-foreground">
            {t("settings.fees.terms.min", {
              amount: formatMoney({ amount: schedule.minFeeMinor, currency }),
            })}
          </Text>
        ) : null}
        {schedule.maxFeeMinor !== undefined && currency !== undefined ? (
          <Text className="text-xs text-foreground">
            {t("settings.fees.terms.max", {
              amount: formatMoney({ amount: schedule.maxFeeMinor, currency }),
            })}
          </Text>
        ) : null}
        <Text className="text-xs text-muted-foreground">{t("settings.fees.terms.basis")}</Text>
        <Text className="text-xs text-muted-foreground">
          {t(REFUND_COPY[schedule.refundPolicy])}
        </Text>
        <Text className="text-xs text-muted-foreground">{t(TAX_COPY[schedule.taxTreatment])}</Text>
        <Text className="text-xs text-muted-foreground">
          {t("settings.fees.terms.version", { version: schedule.termsVersion })}
        </Text>
        {effectiveFrom === null ? null : (
          <Text className="text-xs text-muted-foreground">
            {t("settings.fees.terms.effectiveFrom", { date: effectiveFrom })}
          </Text>
        )}
      </View>
    </View>
  );
}

/**
 * Acceptance, which is the only write on this screen.
 *
 * The body echoes the version this render actually showed. A schedule that
 * moved underneath it is refused by the server with a conflict naming the
 * current one, never recorded against the wrong version — so the failure path
 * refetches (the mutation invalidates on settle) and the owner reads the terms
 * now in force before pressing again.
 */
function AcceptAction({
  storeId,
  schedule,
}: {
  storeId: string;
  schedule: FeeScheduleSummary;
}) {
  const { t } = useTranslation();
  const accept = useAcceptFeeSchedule(storeId);

  async function onAccept(): Promise<void> {
    try {
      await accept.mutateAsync({
        scheduleKey: schedule.scheduleKey,
        version: schedule.version,
        termsVersion: schedule.termsVersion,
      });
      toast.success(t("settings.fees.acceptSucceeded"));
    } catch {
      toast.error(t("settings.fees.acceptFailed"));
    }
  }

  return (
    <Button className="mt-3" isLoading={accept.isPending} disabled={accept.isPending} onPress={onAccept}>
      <Text>{t("settings.fees.pending.action")}</Text>
    </Button>
  );
}

/** Whole major units of the schedule's currency, as example baskets. */
const EXAMPLE_MAJOR_UNITS = [10, 50, 100] as const;

/**
 * What the fee actually comes to, answered by the server.
 *
 * Rendered only when the schedule pins a currency: without one there is no
 * currency to quote an example in, and inventing the store's own would preview
 * a fee under a scope this schedule does not have.
 */
function FeeExample({ storeId, schedule }: { storeId: string; schedule: FeeScheduleSummary }) {
  const { t } = useTranslation();
  const { formatMoney } = useFormatters();
  const preview = usePreviewFee(storeId);
  const [quote, setQuote] = useState<FeePreview | undefined>(undefined);
  const currency: CurrencyCode | undefined = schedule.eligibleCurrency;
  if (currency === undefined) return null;

  async function onPreview(major: number, quoteCurrency: CurrencyCode): Promise<void> {
    try {
      setQuote(
        await preview.mutateAsync({
          basisAmount: major * 10 ** CURRENCY_PRECISION[quoteCurrency],
          currency: quoteCurrency,
        }),
      );
    } catch {
      toast.error(t("settings.fees.preview.failed"));
    }
  }

  return (
    <View className="rounded-2xl border border-border bg-surface p-4">
      <Text className="text-sm font-semibold text-foreground">
        {t("settings.fees.preview.title")}
      </Text>
      <Text className="mt-1 text-xs text-muted-foreground">{t("settings.fees.preview.body")}</Text>
      <View className="mt-3 flex-row flex-wrap gap-2">
        {EXAMPLE_MAJOR_UNITS.map((major) => (
          <Button
            key={major}
            variant="outline"
            size="sm"
            disabled={preview.isPending}
            onPress={() => onPreview(major, currency)}
          >
            <Text>
              {formatMoney({ amount: major * 10 ** CURRENCY_PRECISION[currency], currency })}
            </Text>
          </Button>
        ))}
      </View>
      {quote ? (
        <Text className="mt-3 text-xs text-foreground">
          {t("settings.fees.preview.result", {
            fee: formatMoney(quote.fee),
            net: formatMoney(quote.net),
          })}
        </Text>
      ) : null}
    </View>
  );
}
