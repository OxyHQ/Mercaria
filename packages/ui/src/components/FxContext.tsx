import * as React from "react";
import type { CurrencyCode } from "@mercaria/shared-types";

/**
 * Display-side FX state shared with presentational price components.
 *
 * This is PRESENTATION ONLY — it never affects the amounts Mercaria stores. A
 * stored price carries its NATIVE currency (FAIR by default, but a store may
 * price in EUR/USD/…); this context tells the price components which currency to
 * SHOW it in and supplies the FAIR-pivot rates to convert with:
 *  - `primaryCurrency` — the shopper's chosen display currency (FAIR by default).
 *  - `secondaryCurrency` — an optional fiat shown alongside the primary (`null` = none).
 *  - `dualDisplayEnabled` — whether to render the secondary figure at all.
 *  - `rates` — quote code → units of that quote per 1 FAIR (`rates.USD = 0.49`
 *    means `1 FAIR = 0.49 USD`); FAIR itself is the pivot with an implicit rate
 *    of 1, so it is not a key. Any native→display conversion pivots through FAIR.
 *
 * The provider value is supplied by the app shell (which fetches `/rates` and
 * resolves the shopper's persisted preference); components here never fetch.
 */
export interface FxContextValue {
  /** The shopper's chosen PRIMARY display currency. Defaults to canonical FAIR. */
  primaryCurrency: CurrencyCode;
  /** Optional secondary fiat currency to display alongside the primary, or `null`. */
  secondaryCurrency: CurrencyCode | null;
  /** Whether to render the secondary (primary + secondary) figure at all. */
  dualDisplayEnabled: boolean;
  /** Quote code → units of that quote per 1 FAIR (presentation-only multipliers). */
  rates: Record<string, number>;
}

/**
 * Inert default: display in canonical FAIR, no secondary, no rates. Chosen so a
 * price rendered outside any provider still shows its stored FAIR amount.
 */
const DEFAULT_FX_VALUE: FxContextValue = {
  primaryCurrency: "FAIR",
  secondaryCurrency: null,
  dualDisplayEnabled: false,
  rates: {},
};

const FxContext = React.createContext<FxContextValue>(DEFAULT_FX_VALUE);

export interface FxProviderProps {
  /** The display-side FX state to expose to descendant price components. */
  value: FxContextValue;
  children: React.ReactNode;
}

/**
 * Provides display-side FX state to descendant presentational price components.
 * The app shell owns fetching `/rates` and resolving the shopper preference,
 * then passes the resolved value here.
 */
export function FxProvider({ value, children }: FxProviderProps) {
  return <FxContext.Provider value={value}>{children}</FxContext.Provider>;
}

/**
 * Read the current display-side FX state. Returns the inert default when no
 * `FxProvider` is mounted, so price components never crash outside a provider.
 */
export function useFx(): FxContextValue {
  return React.useContext(FxContext);
}

export { FxContext };
