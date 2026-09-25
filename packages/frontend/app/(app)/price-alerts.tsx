import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { Loading } from "@oxy.so/bloom/loading";
import { TextFieldInput } from "@oxy.so/bloom/text-field";
import Head from "expo-router/head";
import { useLocalSearchParams, useRouter } from "expo-router";
import { openAccountDialog, useOxy } from "@oxy.so/services";
import { RiNotification3Line } from "@oxy.so/bloom/icons/RiNotification3Line";
import { EmptyState } from "@oxy.so/bloom/empty-state";
import { PriceAlertCard, Text, useFormatters, useFx } from "@mercaria/ui";
import {
  CURRENCY_PRECISION,
  type CurrencyCode,
  type PriceAlert,
  type PriceAlertComparisonBasis,
  type PriceAlertSplitResolution,
} from "@mercaria/shared-types";
import { ScreenShell } from "@/components/shell/ScreenShell";
import {
  useCreatePriceAlert,
  useDeletePriceAlert,
  usePriceAlerts,
  usePriceAlertSuggestion,
  useResolvePriceAlertSplit,
  useUpdatePriceAlert,
} from "@/lib/hooks/use-price-alerts";
import { useTranslation } from "@/lib/i18n";

/** Icon size for the empty-state badge. */

/**
 * Price alerts (#79) — the account's own list, and the one place an alert is
 * created from a product a buyer arrived with.
 *
 * ## Creating one is reached WITH a product, never chosen from a picker
 *
 * `?canonicalProductId=` is how the saved list, a product page and an offer row
 * all get here (#79 UX rule 1). A picker would be a second way to name a
 * product, and the one thing this screen must not do is let somebody set an
 * alert on something they were not looking at.
 *
 * ## The suggested target is PREFILLED and never applied
 *
 * `usePriceAlertSuggestion` reads the current best eligible amount and the
 * field starts there; nothing is created until the buyer presses the button
 * (UX rule 2). The figure beside it says what it is — the best eligible price
 * right now, in the alert's own currency — because a bare number a client
 * computed is exactly what a buyer would accept without reading.
 *
 * ## Signed out, this page offers rather than gates
 *
 * An alert is stored under an Oxy account id, so there is genuinely nothing to
 * show a signed-out visitor.
 */
export default function PriceAlertsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { isAuthenticated } = useOxy();
  const params = useLocalSearchParams<{ canonicalProductId?: string }>();
  const alerts = usePriceAlerts();
  const update = useUpdatePriceAlert();
  const remove = useDeletePriceAlert();
  const resolveSplit = useResolvePriceAlertSplit();

  const list = useMemo<PriceAlert[]>(() => alerts.data ?? [], [alerts.data]);

  return (
    <ScreenShell>
      <Head>
        <title>{t("priceAlerts.pageTitle")}</title>
      </Head>

      <View className="gap-space-16 px-space-16 py-space-20">
        <Text className="text-2xl font-bold text-foreground">{t("priceAlerts.heading")}</Text>

        {!isAuthenticated ? (
          <SignedOutInvitation />
        ) : (
          <>
            {params.canonicalProductId ? (
              <CreatePriceAlert canonicalProductId={params.canonicalProductId} />
            ) : null}

            {alerts.isLoading ? (
              <View className="items-center py-space-24">
                <Loading variant="inline" size="sm" />
              </View>
            ) : null}

            {!alerts.isLoading && list.length === 0 ? <EmptyAlertsPlaceholder /> : null}

            <View className="gap-space-12">
              {list.map((alert) => (
                <PriceAlertCard
                  key={alert.id}
                  alert={alert}
                  onOpen={() => router.push(`/products/${alert.canonicalProductId}`)}
                  onPause={() => update.mutate({ alertId: alert.id, patch: { state: "paused" } })}
                  onResume={() => update.mutate({ alertId: alert.id, patch: { state: "enabled" } })}
                  onDelete={() => remove.mutate(alert.id)}
                  onResolveSplit={(_alert, resolution: PriceAlertSplitResolution) =>
                    resolveSplit.mutate({ alertId: alert.id, resolution })
                  }
                />
              ))}
            </View>
          </>
        )}
      </View>
    </ScreenShell>
  );
}

/**
 * The create form.
 *
 * The buyer types a target in MAJOR units and this converts to minor units with
 * the currency's own precision — never a hard-coded two. A zero-decimal
 * currency's minor unit IS its major unit and an eight-decimal one is six orders
 * of magnitude the other way, so a fixed multiplier would set a target a hundred
 * times too small or a million times too large, silently, on the one field whose
 * whole purpose is a number.
 */
function CreatePriceAlert({ canonicalProductId }: { canonicalProductId: string }) {
  const { t } = useTranslation();
  const { formatMoney } = useFormatters();
  const { primaryCurrency } = useFx();
  const currency = primaryCurrency as CurrencyCode;
  const suggestion = usePriceAlertSuggestion({ canonicalProductId, currency });
  const create = useCreatePriceAlert();
  const [basis, setBasis] = useState<PriceAlertComparisonBasis>("item_price");
  const [typed, setTyped] = useState<string>("");

  const precision = CURRENCY_PRECISION[currency] ?? 2;
  const suggested = suggestion.data?.suggestedTarget;
  // The ONE place in this screen that converts minor units by hand, and it must
  // stay that way: this is a TEXT INPUT's value, not display text. It is read
  // straight back by `Number(value)` two lines down, and `formatMoney` returns a
  // symbol-prefixed string wrapped in bidi isolates (U+2068/U+2069) — so routing
  // this through the formatter would make `Number("⁨$148.00⁩")` NaN and
  // silently break the create form. It also needs the currency's FULL precision
  // rather than the formatter's fixed 2dp, or a FAIR target would round away six
  // decimals of what the buyer is editing. Recorded as a known exception in
  // `scripts/validate-money-formatting.mjs` rather than left for the guard to
  // rediscover. The DISPLAY figure below goes through `formatMoney` (#441).
  const prefill =
    suggested === undefined ? "" : (suggested.amount / 10 ** precision).toFixed(precision);
  const value = typed === "" ? prefill : typed;
  const minorUnits = Math.round(Number(value) * 10 ** precision);
  const usable = Number.isInteger(minorUnits) && minorUnits > 0;

  return (
    <View className="gap-space-8 rounded-radius-16 border border-border-secondary bg-bg-fill p-space-12">
      <Text className="text-bodyTitleSmall text-text">{t("priceAlerts.create.heading")}</Text>

      {/* UX rule 3 — the current best eligible amount, in the alert's currency. */}
      {suggestion.isLoading ? (
        <Loading variant="inline" size="sm" />
      ) : suggestion.data && suggestion.data.eligibleOfferCount > 0 ? (
        <Text className="text-caption text-text-tertiary">
          {suggested
            ? t("priceAlerts.create.bestRightNow", { price: formatMoney(suggested) })
            : t("priceAlerts.create.noPricedOffer", {
                count: suggestion.data.eligibleOfferCount,
              })}
        </Text>
      ) : (
        <Text className="text-caption text-text-tertiary">
          {t("priceAlerts.create.nothingOnSale")}
        </Text>
      )}

      <TextFieldInput
        label={t("priceAlerts.create.targetPrice")}
        inputMode="decimal"
        value={value}
        onValueChange={setTyped}
        placeholder={t("priceAlerts.create.targetPlaceholder", { currency })}
      />

      <View className="flex-row gap-space-8">
        <BasisChoice
          label={t("priceAlerts.create.basisItemPrice")}
          selected={basis === "item_price"}
          onPress={() => setBasis("item_price")}
        />
        <BasisChoice
          label={t("priceAlerts.create.basisKnownTotal")}
          selected={basis === "known_total"}
          onPress={() => setBasis("known_total")}
        />
      </View>
      {basis === "known_total" ? (
        <Text className="text-caption text-text-tertiary">
          {t("priceAlerts.create.knownTotalNote")}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("priceAlerts.create.submitA11y")}
        disabled={!usable || create.isPending}
        onPress={() =>
          create.mutate({
            canonicalProductId,
            target: { amount: minorUnits, currency },
            basis,
          })
        }
        className="self-start rounded-radius-max bg-bg-fill-secondary px-space-16 py-space-8"
      >
        <Text className="text-caption text-text">
          {create.isPending ? t("priceAlerts.create.submitting") : t("priceAlerts.create.submit")}
        </Text>
      </Pressable>

      {create.isError ? (
        <Text className="text-caption text-text-tertiary">
          {create.error instanceof Error
            ? create.error.message
            : t("priceAlerts.create.failed")}
        </Text>
      ) : null}
    </View>
  );
}

function BasisChoice({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className={
        selected
          ? "rounded-radius-max bg-bg-fill-inverse px-space-12 py-space-4"
          : "rounded-radius-max bg-bg-fill-secondary px-space-12 py-space-4"
      }
    >
      <Text className={selected ? "text-caption text-text-inverse" : "text-caption text-text"}>
        {label}
      </Text>
    </Pressable>
  );
}

function EmptyAlertsPlaceholder() {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={RiNotification3Line}
      media="circle"
      title={t("priceAlerts.empty.title")}
      description={t("priceAlerts.empty.body")}
    />
  );
}

function SignedOutInvitation() {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={RiNotification3Line}
      media="circle"
      title={t("priceAlerts.signedOut.title")}
      description={t("priceAlerts.signedOut.body")}
      action={{ label: t("priceAlerts.signedOut.signIn"), onPress: () => openAccountDialog() }}
    />
  );
}
