import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getLocales } from "expo-localization";
import { useOxy } from "@oxyhq/services";
import {
  ALL_CURRENCY_CODES,
  type CurrencyCode,
  type CurrencyPreference,
  type FxRates,
  type UpdateCurrencyPreferenceInput,
} from "@mercaria/shared-types";
import { FxProvider, type FxContextValue } from "@mercaria/ui";
import apiClient from "./api/client";

/** Canonical currency: the pivot every display rate is quoted against. */
const FAIR: CurrencyCode = "FAIR";
/**
 * Fiat quotes fetched for display conversion — every supported code except FAIR
 * (which is the pivot, with an implicit rate of 1). Fetching the full set lets
 * `PriceDisplay` pivot ANY native currency to ANY chosen display currency.
 * Data-driven from the shared currency set so adding a currency in
 * `@mercaria/shared-types` propagates here without editing a literal list.
 */
const QUOTE_CURRENCIES: readonly CurrencyCode[] = ALL_CURRENCY_CODES.filter(
  (code) => code !== FAIR,
);
/** Fallback secondary currency when the locale doesn't resolve a supported one. */
const DEFAULT_SECONDARY: CurrencyCode = "EUR";
/** How long resolved rates stay fresh before refetch (15 minutes, in ms). */
const RATES_STALE_TIME = 1000 * 60 * 15;
/** How long the persisted currency preference stays fresh (5 minutes, in ms). */
const PREFERENCE_STALE_TIME = 1000 * 60 * 5;
/** Stable query key for the FX rates query. */
const RATES_QUERY_KEY = ["fx-rates", FAIR, QUOTE_CURRENCIES.join(",")] as const;
/** Stable query key for the persisted display-currency preference. */
const CURRENCY_PREFERENCE_QUERY_KEY = ["currency-preference"] as const;

/** The success envelope shape returned by `GET /rates`. */
interface RatesEnvelope {
  success: boolean;
  data?: FxRates;
}

/** The success envelope shape returned by `GET/PUT /me/currency-preference`. */
interface PreferenceEnvelope {
  success: boolean;
  data?: CurrencyPreference;
}

/**
 * Fetch display-side FX rates from the PUBLIC `GET /rates` endpoint. The backend
 * never throws (it falls back to last-good/static rates), but if the request
 * itself fails (endpoint not deployed yet, offline) the query reports an error
 * and consumers fall back to empty rates — display degrades to the native amount,
 * it never crashes.
 */
async function fetchRates(): Promise<FxRates> {
  const { data } = await apiClient.get<RatesEnvelope>("/rates", {
    params: { base: FAIR, quote: QUOTE_CURRENCIES.join(",") },
  });
  if (!data.success || !data.data) {
    throw new Error("Failed to load FX rates");
  }
  return data.data;
}

/** React Query hook for the public FX rates feed. */
export function useRatesQuery() {
  return useQuery<FxRates>({
    queryKey: RATES_QUERY_KEY,
    queryFn: fetchRates,
    staleTime: RATES_STALE_TIME,
    // Display-only: a transient failure must not noisily retry; native-only is fine.
    retry: 1,
  });
}

/** Fetch the caller's persisted dual-currency DISPLAY preference. */
async function fetchCurrencyPreference(): Promise<CurrencyPreference> {
  const { data } = await apiClient.get<PreferenceEnvelope>("/me/currency-preference");
  if (!data.success || !data.data) {
    throw new Error("Failed to load currency preference");
  }
  return data.data;
}

/**
 * React Query hook for the caller's persisted display-currency preference. Gated
 * on auth — an anonymous shopper has no server preference and falls back to
 * FAIR + a locale-derived secondary.
 */
export function useCurrencyPreferenceQuery() {
  const { isAuthenticated } = useOxy();
  return useQuery<CurrencyPreference>({
    queryKey: CURRENCY_PREFERENCE_QUERY_KEY,
    queryFn: fetchCurrencyPreference,
    enabled: isAuthenticated,
    staleTime: PREFERENCE_STALE_TIME,
  });
}

/** Patch the caller's persisted display-currency preference. */
async function updateCurrencyPreference(
  input: UpdateCurrencyPreferenceInput,
): Promise<CurrencyPreference> {
  const { data } = await apiClient.put<PreferenceEnvelope>(
    "/me/currency-preference",
    input,
  );
  if (!data.success || !data.data) {
    throw new Error("Failed to update currency preference");
  }
  return data.data;
}

/**
 * Mutate the persisted display-currency preference. On success it primes the
 * preference query cache with the server's canonical result, so the FX provider
 * re-resolves and every `PriceDisplay` re-renders in the new currency live — no
 * effect, no manual refetch.
 */
export function useUpdateCurrencyPreference() {
  const queryClient = useQueryClient();
  return useMutation<CurrencyPreference, Error, UpdateCurrencyPreferenceInput>({
    mutationFn: updateCurrencyPreference,
    onSuccess: (preference) => {
      queryClient.setQueryData(CURRENCY_PREFERENCE_QUERY_KEY, preference);
    },
  });
}

/** Type guard: `value` is a currency code Mercaria supports for display. */
function isSupportedCurrency(value: string): value is CurrencyCode {
  return (ALL_CURRENCY_CODES as readonly string[]).includes(value);
}

/**
 * Resolve the viewer's secondary display currency from their device locale's
 * `currencyCode`, falling back to `DEFAULT_SECONDARY` when the locale currency
 * isn't one Mercaria supports for display.
 */
function resolveLocaleSecondary(): CurrencyCode {
  const [primaryLocale] = getLocales();
  const localeCurrency = primaryLocale.currencyCode;
  return localeCurrency !== null && isSupportedCurrency(localeCurrency)
    ? localeCurrency
    : DEFAULT_SECONDARY;
}

/**
 * App FX provider. Fetches the public rates and the viewer's persisted display
 * preference, then exposes the presentation-only `FxContextValue` to descendant
 * price components (e.g. `PriceDisplay`). The PRIMARY display currency is the
 * viewer's `preferredCurrency` (FAIR by default); the secondary is their chosen
 * one or a locale default. Must be mounted INSIDE the Oxy/Query provider so the
 * queries (and any bearer token) work.
 */
export function AppFxProvider({ children }: { children: React.ReactNode }) {
  const { data: rates } = useRatesQuery();
  const { data: preference } = useCurrencyPreferenceQuery();

  const localeSecondary = useMemo(() => resolveLocaleSecondary(), []);

  const value = useMemo<FxContextValue>(
    () => ({
      primaryCurrency: preference?.preferredCurrency ?? FAIR,
      secondaryCurrency: preference?.secondaryCurrency ?? localeSecondary,
      dualDisplayEnabled: preference?.dualDisplayEnabled ?? true,
      rates: rates?.rates ?? {},
    }),
    [preference, localeSecondary, rates],
  );

  return <FxProvider value={value}>{children}</FxProvider>;
}
