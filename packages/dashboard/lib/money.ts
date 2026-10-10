import { CURRENCY_PRECISION, type CurrencyCode } from "@mercaria/shared-types";

/** Radix used to derive minor units from a currency's decimal precision. */
const DECIMAL_RADIX = 10;

/**
 * Parse a human-entered major-unit amount (e.g. `"148.00"`) into integer minor
 * units for `currency` (default FAIR, 8dp). Returns `null` for empty/invalid
 * input so callers can validate before submitting. The conversion rounds to the
 * nearest minor unit to avoid float drift (e.g. `0.1 * 1e8`).
 */
export function toMinorUnits(
  major: string,
  currency: CurrencyCode = "FAIR",
): number | null {
  const trimmed = major.trim();
  if (trimmed === "") {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  const minor = Math.round(parsed * DECIMAL_RADIX ** CURRENCY_PRECISION[currency]);
  // The API and persistence boundary require exactly representable minor units.
  // A finite major amount can overflow, or lose integer precision, when scaled.
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Convenience wrapper for the canonical FAIR currency. */
export function toFairMinor(major: string): number | null {
  return toMinorUnits(major, "FAIR");
}

/**
 * Format integer minor units back to a major-unit string for an editable field
 * (e.g. `14_800_000_000` FAIR → `"148"`). Trailing zeros are trimmed so an edit
 * field doesn't show `148.00000000`.
 */
export function toMajorString(
  amount: number,
  currency: CurrencyCode = "FAIR",
): string {
  const major = amount / DECIMAL_RADIX ** CURRENCY_PRECISION[currency];
  return String(major);
}
