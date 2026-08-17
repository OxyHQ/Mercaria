/**
 * The MARKET a draft is authored for.
 *
 * A market is one of the six dimensions the server composes a schema from, and
 * it is required on every create. Mercaria's `Store` DTO carries no country —
 * `defaultCurrency` is the only jurisdictional fact on it, and a currency is not
 * a country (three of the six shipped codes are used in several) — so there is
 * nothing on the store to derive one from.
 *
 * So the device's own region is offered as a DEFAULT the merchant can see and
 * change, and when the device reports none the field is EMPTY and the merchant
 * supplies it. Nothing here invents a country: a hardcoded fallback would put
 * one deployment's assumption into every draft's pinned classification, and a
 * pinned market is what decides which localizations and which schema variant the
 * answers were given under.
 */

import { getLocales } from "expo-localization";

/** A market is an ISO 3166-1 alpha-2 code, which is what the server accepts. */
export const MARKET_PATTERN = /^[A-Za-z]{2}$/u;

/** Whether a merchant-entered market is one the server will accept. */
export function isValidMarket(value: string): boolean {
  return MARKET_PATTERN.test(value.trim());
}

/** Normalize to the upper-case form the server stores. */
export function normalizeMarket(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * The device's region, or an empty string.
 *
 * Empty is a real answer and is left empty deliberately — see the module note.
 * `getLocales()` is read once per call and never memoized here: it is external
 * mutable state, and reading it from inside a memoized position is how a
 * component keeps rendering the region the device had at first paint.
 */
export function deviceMarket(): string {
  const locales = getLocales();
  for (const locale of locales) {
    const region = locale.regionCode;
    if (typeof region === "string" && isValidMarket(region)) return normalizeMarket(region);
  }
  return "";
}
