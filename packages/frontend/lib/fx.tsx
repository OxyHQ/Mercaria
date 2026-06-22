import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getLocales } from "expo-localization";
import type { CurrencyCode, FxRates } from "@mercaria/shared-types";
import { FxProvider, type FxContextValue } from "@mercaria/ui";
import apiClient from "./api/client";

/** Canonical base currency for display-side conversion (FAIR is canonical). */
const BASE_CURRENCY: CurrencyCode = "FAIR";
/** Fiat quotes Mercaria fetches for dual-currency display. */
const QUOTE_CURRENCIES: readonly CurrencyCode[] = ["USD", "EUR", "GBP"];
/** Fiat codes a viewer may have as their secondary display currency. */
const SUPPORTED_SECONDARY: readonly CurrencyCode[] = QUOTE_CURRENCIES;
/** Fallback secondary currency when the locale doesn't resolve a supported one. */
const DEFAULT_SECONDARY: CurrencyCode = "EUR";
/** How long resolved rates stay fresh before refetch (15 minutes, in ms). */
const RATES_STALE_TIME = 1000 * 60 * 15;
/** Stable query key for the FX rates query. */
const RATES_QUERY_KEY = ["fx-rates", BASE_CURRENCY, QUOTE_CURRENCIES.join(",")] as const;

/** The success envelope shape returned by `GET /rates`. */
interface RatesEnvelope {
  success: boolean;
  data?: FxRates;
}

/**
 * Fetch display-side FX rates from the PUBLIC `GET /rates` endpoint. The backend
 * never throws (it falls back to last-good/static rates), but if the request
 * itself fails (endpoint not deployed yet, offline) the query reports an error
 * and consumers fall back to empty rates — display degrades to FAIR-only, it
 * never crashes.
 */
async function fetchRates(): Promise<FxRates> {
  const { data } = await apiClient.get<RatesEnvelope>("/rates", {
    params: { base: BASE_CURRENCY, quote: QUOTE_CURRENCIES.join(",") },
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
    // Display-only: a transient failure must not noisily retry; FAIR-only is fine.
    retry: 1,
  });
}

/** Narrow an arbitrary string to a supported secondary `CurrencyCode`, or null. */
function toSupportedSecondary(value: string | null): CurrencyCode | null {
  if (value === null) {
    return null;
  }
  return (SUPPORTED_SECONDARY as readonly string[]).includes(value)
    ? (value as CurrencyCode)
    : null;
}

/**
 * Resolve the viewer's secondary display currency from their device locale's
 * `currencyCode`, falling back to `DEFAULT_SECONDARY` when the locale currency
 * isn't one Mercaria supports for display.
 */
function resolveSecondaryCurrency(): CurrencyCode {
  const [primaryLocale] = getLocales();
  return toSupportedSecondary(primaryLocale.currencyCode) ?? DEFAULT_SECONDARY;
}

/**
 * App FX provider. Fetches the public rates and resolves the viewer's secondary
 * display currency from the device locale, then exposes the presentation-only
 * `FxContextValue` to descendant price components (e.g. `PriceDisplay`). Must be
 * mounted INSIDE the Oxy/Query provider so the query (and any bearer token) work.
 */
export function AppFxProvider({ children }: { children: React.ReactNode }) {
  const { data } = useRatesQuery();

  const secondaryCurrency = useMemo(() => resolveSecondaryCurrency(), []);

  const value = useMemo<FxContextValue>(
    () => ({
      secondaryCurrency,
      dualDisplayEnabled: true,
      rates: data?.rates ?? {},
    }),
    [secondaryCurrency, data],
  );

  return <FxProvider value={value}>{children}</FxProvider>;
}
