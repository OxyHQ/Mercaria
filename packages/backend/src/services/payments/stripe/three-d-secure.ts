/**
 * WHEN Mercaria asks the issuer to authenticate a card payment.
 *
 * ## Why this is a loss control and not a friction setting
 *
 * A payment authenticated with 3-D Secure shifts liability for a fraudulent
 * chargeback from the merchant to the ISSUER. Mercaria is merchant of record
 * and ADR 0001 D2 sets `controller.losses.payments = 'application'`, so an
 * unauthenticated fraudulent charge is Mercaria's loss — not the seller's, who
 * has already been transferred their share.
 *
 * Nothing requested 3DS before this. The PaymentIntent carried no
 * `payment_method_options`, which leaves Stripe's `automatic` behaviour:
 * authentication happens when the ISSUER or a REGULATION demands it.
 *
 * ## And a regulation demanding it is exactly what cannot be relied on here
 *
 * SCA applies when the issuer AND the acquirer are both in the EEA. Mercaria's
 * platform account is `Mercaria, Inc.`, US (`GET /v1/account`: `country: US`,
 * `default_currency: usd`), so a Spanish shopper paying a Spanish card through
 * this platform is a ONE-LEG-OUT transaction and SCA does not mandate a
 * challenge. Under `automatic`, most such payments would therefore never be
 * authenticated, and every one of them keeps its fraud liability with Mercaria.
 *
 * That is a fact about the acquiring entity rather than about this code, and it
 * is the single reason this module exists. Confirm the exact scope with Stripe
 * before treating the liability shift as guaranteed for a given corridor; what
 * is NOT in doubt is that not asking cannot shift anything.
 *
 * ## The threshold is per currency, and an unknown currency asks
 *
 * A minor-unit amount is meaningless without its currency — JPY has no minor
 * unit and FAIR has eight — so one global integer would mean three different
 * real amounts across the presentment set. `STRIPE_3DS_THRESHOLDS` is therefore
 * a per-currency map.
 *
 * A currency with NO configured threshold requests authentication on every
 * payment. That is the fail-closed direction and it is deliberate: the failure
 * of a missing entry is then extra friction on a currency nobody configured,
 * rather than silent unlimited exposure on one. `assertSafeMoneyAmount`'s rule,
 * applied to a policy.
 */

import type { CurrencyCode, Money } from '@mercaria/shared-types';

/** What Stripe is asked to do about authentication, in its own vocabulary. */
export type ThreeDSecureRequest = 'any' | 'automatic';

/**
 * Decide whether this charge should be authenticated.
 *
 * Pure, and takes the thresholds rather than reading `config`, so both branches
 * are reachable from a test whatever this deployment happens to be configured
 * with — the `resolveRefusalAccountRef` rule.
 *
 * `'any'` asks Stripe to authenticate wherever the card supports it. It is NOT
 * `'challenge'`: a large share of 3DS authentications are frictionless, so
 * demanding a visible challenge would add friction the liability shift does not
 * require.
 */
export function threeDSecureRequestFor(
  amount: Money,
  thresholds: Readonly<Partial<Record<CurrencyCode, number>>>,
): ThreeDSecureRequest {
  const threshold = thresholds[amount.currency];
  if (threshold === undefined) return 'any';
  return amount.amount >= threshold ? 'any' : 'automatic';
}

/**
 * Parse `STRIPE_3DS_THRESHOLDS` — `EUR:50000,USD:50000`, in MINOR units.
 *
 * An entry whose currency Mercaria does not know, or whose amount is not a
 * non-negative integer, is DROPPED rather than defaulted. Dropping it leaves
 * that currency with no threshold, which asks for authentication on every
 * payment — so a typo costs friction and never exposure, and the two failure
 * directions are not symmetrical enough to leave to chance.
 */
export function parseThreeDSecureThresholds(
  raw: string,
  isKnownCurrency: (code: string) => code is CurrencyCode,
): { thresholds: Record<string, number>; rejected: string[] } {
  const thresholds: Record<string, number> = {};
  const rejected: string[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const separator = trimmed.indexOf(':');
    const code = (separator === -1 ? trimmed : trimmed.slice(0, separator)).trim().toUpperCase();
    const value = separator === -1 ? '' : trimmed.slice(separator + 1).trim();
    if (!isKnownCurrency(code) || !/^\d+$/u.test(value)) {
      rejected.push(trimmed);
      continue;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      rejected.push(trimmed);
      continue;
    }
    thresholds[code] = parsed;
  }
  return { thresholds, rejected };
}
