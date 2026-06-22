import * as React from "react";
import type { CurrencyCode } from "@mercaria/shared-types";

/**
 * Display-side FX state shared with presentational price components.
 *
 * This is PRESENTATION ONLY. Mercaria always stores amounts in the canonical
 * currency (FAIR); this context never affects stored money — it only carries
 * what a consumer optionally sees alongside the FAIR figure:
 *  - `secondaryCurrency` — the fiat to show next to FAIR (`null` = none chosen).
 *  - `dualDisplayEnabled` — whether to render the secondary figure at all.
 *  - `rates` — quote code → units of that quote per 1 FAIR (mirrors `FxRates.rates`).
 *
 * The provider value is supplied by the app shell (which fetches `/rates` and
 * resolves the shopper's preference); components here never fetch.
 */
export interface FxContextValue {
  /** Secondary fiat currency to display alongside FAIR, or `null` for none. */
  secondaryCurrency: CurrencyCode | null;
  /** Whether to render the dual (FAIR + secondary) figure at all. */
  dualDisplayEnabled: boolean;
  /** Quote code → units of that quote per 1 FAIR (presentation-only multipliers). */
  rates: Record<string, number>;
}

/** Inert default: no secondary currency, dual display off, no rates. */
const DEFAULT_FX_VALUE: FxContextValue = {
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
