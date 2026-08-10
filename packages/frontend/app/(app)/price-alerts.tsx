import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, TextInput, View } from "react-native";
import Head from "expo-router/head";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Bell } from "lucide-react-native";
import { openAccountDialog, useOxy } from "@oxyhq/services";
import { PriceAlertCard, Text, useFx } from "@mercaria/ui";
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

/** Icon size for the empty-state badge. */
const EMPTY_ICON_SIZE = 28;

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
        <title>Price alerts · Mercaria</title>
      </Head>

      <View className="gap-space-16 px-space-16 py-space-20">
        <Text className="text-2xl font-bold text-foreground">Price alerts</Text>

        {!isAuthenticated ? (
          <SignedOutInvitation />
        ) : (
          <>
            {params.canonicalProductId ? (
              <CreatePriceAlert canonicalProductId={params.canonicalProductId} />
            ) : null}

            {alerts.isLoading ? (
              <View className="items-center py-space-24">
                <ActivityIndicator />
              </View>
            ) : null}

            {!alerts.isLoading && list.length === 0 ? <EmptyState /> : null}

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
  const { primaryCurrency } = useFx();
  const currency = primaryCurrency as CurrencyCode;
  const suggestion = usePriceAlertSuggestion({ canonicalProductId, currency });
  const create = useCreatePriceAlert();
  const [basis, setBasis] = useState<PriceAlertComparisonBasis>("item_price");
  const [typed, setTyped] = useState<string>("");

  const precision = CURRENCY_PRECISION[currency] ?? 2;
  const suggested = suggestion.data?.suggestedTarget;
  const prefill =
    suggested === undefined ? "" : (suggested.amount / 10 ** precision).toFixed(precision);
  const value = typed === "" ? prefill : typed;
  const minorUnits = Math.round(Number(value) * 10 ** precision);
  const usable = Number.isInteger(minorUnits) && minorUnits > 0;

  return (
    <View className="gap-space-8 rounded-radius-16 border border-border-secondary bg-bg-fill p-space-12">
      <Text className="text-bodyTitleSmall text-text">Tell me when the price drops</Text>

      {/* UX rule 3 — the current best eligible amount, in the alert's currency. */}
      {suggestion.isLoading ? (
        <ActivityIndicator />
      ) : suggestion.data && suggestion.data.eligibleOfferCount > 0 ? (
        <Text className="text-caption text-text-tertiary">
          {suggested
            ? `Best right now: ${(suggested.amount / 10 ** precision).toFixed(precision)} ${currency}`
            : `No priced offer right now (${suggestion.data.eligibleOfferCount} offers)`}
        </Text>
      ) : (
        <Text className="text-caption text-text-tertiary">
          Nothing is on sale for this right now. You can still set an alert.
        </Text>
      )}

      <TextInput
        accessibilityLabel="Target price"
        inputMode="decimal"
        value={value}
        onChangeText={setTyped}
        placeholder={`Target in ${currency}`}
        className="rounded-radius-12 border border-border-secondary px-space-12 py-space-8 text-text"
      />

      <View className="flex-row gap-space-8">
        <BasisChoice
          label="Item price"
          selected={basis === "item_price"}
          onPress={() => setBasis("item_price")}
        />
        <BasisChoice
          label="Including delivery"
          selected={basis === "known_total"}
          onPress={() => setBasis("known_total")}
        />
      </View>
      {basis === "known_total" ? (
        <Text className="text-caption text-text-tertiary">
          Only offers whose delivery cost is published can match this.
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Create this price alert"
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
          {create.isPending ? "Creating…" : "Create alert"}
        </Text>
      </Pressable>

      {create.isError ? (
        <Text className="text-caption text-text-tertiary">
          {create.error instanceof Error ? create.error.message : "Failed to create that alert"}
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

function EmptyState() {
  return (
    <View className="items-center gap-space-8 py-space-24">
      <View className="rounded-radius-max bg-bg-fill-secondary p-space-12">
        <Bell size={EMPTY_ICON_SIZE} className="text-text-tertiary" />
      </View>
      <Text className="text-bodyTitleSmall text-text">No price alerts yet</Text>
      <Text className="text-caption text-text-tertiary">
        Set one from a product you are watching and we will tell you when it drops.
      </Text>
    </View>
  );
}

function SignedOutInvitation() {
  return (
    <View className="items-center gap-space-8 py-space-24">
      <View className="rounded-radius-max bg-bg-fill-secondary p-space-12">
        <Bell size={EMPTY_ICON_SIZE} className="text-text-tertiary" />
      </View>
      <Text className="text-bodyTitleSmall text-text">Sign in to set price alerts</Text>
      <Text className="text-caption text-text-tertiary">
        Alerts live with your account, so they follow you between devices.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sign in"
        onPress={() => openAccountDialog()}
        className="rounded-radius-max bg-bg-fill-secondary px-space-16 py-space-8"
      >
        <Text className="text-caption text-text">Sign in</Text>
      </Pressable>
    </View>
  );
}
