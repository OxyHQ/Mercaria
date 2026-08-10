/**
 * The pure half of the entitlement domain — the arithmetic and the vocabulary,
 * with no database, no clock of its own and NO CONFIGURATION.
 *
 * ## Why this file reads no configuration, and a test says so
 *
 * Issue #89 entitlement rule 8: "Feature flags and entitlements solve different
 * problems and remain separate." A feature flag answers "is this code path
 * switched on in this deployment"; an entitlement answers "may THIS merchant do
 * this". Reading one to decide the other collapses them, and the collapse is
 * silent — a flag flip would grant or remove a paid capability for every
 * merchant at once, with nothing in any audit trail saying so.
 *
 * So neither this module nor `resolve.ts` imports `config`, and
 * `merchant-plan-isolation.test.ts` fails the build if either starts to. The
 * billing modules DO read configuration, because whether a rail is configured
 * genuinely is a deployment fact.
 *
 * ## The one place "unknown" could have become "yes"
 *
 * {@link decideEntitlement} refuses on absence — no entitlement means
 * `not_entitled`, and a capability whose definition is `postponed` means
 * `capability_postponed`, never a quiet grant. That direction is the safe one
 * here precisely because nothing a free merchant needs has a capability key at
 * all: refusing an unknown capability withholds a paid extra and can never
 * withhold a catalogue, an order or a refund.
 */

import {
  MERCHANT_ENTITLEMENT_CAPABILITIES,
  MERCHANT_UNGATEABLE_CAPABILITIES,
  type EntitlementDecision,
  type EntitlementLimitKind,
  type EntitlementSource,
  type MerchantEntitlementCapability,
  type UngateableMerchantCapability,
} from '@mercaria/shared-types';

/** One capability a store effectively holds, from wherever it came. */
export interface EffectiveEntitlement {
  readonly capability: MerchantEntitlementCapability;
  readonly limitKind: EntitlementLimitKind;
  /** NULL means unlimited for a quantified kind, and nothing for a `flag`. */
  readonly limit: number | null;
  readonly source: EntitlementSource;
}

/** Whether a string is a capability an entitlement may name. */
export function isEntitlementCapability(key: string): key is MerchantEntitlementCapability {
  return (MERCHANT_ENTITLEMENT_CAPABILITIES as readonly string[]).includes(key);
}

/**
 * Whether a string names one of the capabilities that may NEVER be gated.
 *
 * The two tuples are disjoint, so this and {@link isEntitlementCapability} can
 * never both be true — which is what lets a request schema answer "`data_export`
 * can never be gated" instead of "unrecognized capability". A refusal that names
 * the prohibition leads somewhere; one that says the key is unknown does not.
 */
export function isUngateableCapability(key: string): key is UngateableMerchantCapability {
  return (MERCHANT_UNGATEABLE_CAPABILITIES as readonly string[]).includes(key);
}

/**
 * The more generous of two limits, where NULL is unlimited.
 *
 * Several sources can grant one capability — the plan and a partnership grant,
 * say — and something has to decide. The most generous wins, because the
 * alternative (the most restrictive) makes GIVING a merchant something able to
 * take away what they already had, which is the one direction a grant must never
 * move.
 */
export function mostGenerousLimit(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  return Math.max(left, right);
}

/**
 * The counter key one quantified limit is measured against.
 *
 * `flag` is not accepted at all — it has no counter, and a signature that took
 * it would need a `null` return every caller had to narrow. That is the
 * `EntitlementLimitKind` distinction held by the type rather than by a branch.
 *
 * A `per_period` key is derived from the subscription's own CURRENT PERIOD when
 * there is one, so an allowance resets when the merchant is billed rather than
 * on the first of the month. A store with no subscription falls back to the UTC
 * calendar month, which is the only period a free plan has. The cost is stated
 * rather than hidden: a plan change moves the period start, so it also opens a
 * fresh allowance — generous in the merchant's favour, and the alternative
 * (carrying a counter across a plan change) would measure a new plan's limit
 * against an old plan's usage.
 */
export function entitlementPeriodKey(
  limitKind: Exclude<EntitlementLimitKind, 'flag'>,
  at: Date,
  currentPeriodStart?: Date | null,
): string {
  if (limitKind === 'total') return 'total';
  if (currentPeriodStart) return `p:${currentPeriodStart.toISOString().slice(0, 10)}`;
  return `m:${at.toISOString().slice(0, 7)}`;
}

/**
 * Whether a store may perform one capability's action now.
 *
 * @param entitlement What the store effectively holds, or `undefined`.
 * @param definitionAvailability What the deployment says about the capability —
 *   `undefined` when no definition exists at all.
 * @param used How much of a quantified limit is already consumed in the period.
 */
export function decideEntitlement(input: {
  capability: MerchantEntitlementCapability;
  entitlement: EffectiveEntitlement | undefined;
  definitionAvailability: 'available' | 'postponed' | undefined;
  used: number;
  amount: number;
}): EntitlementDecision {
  if (input.definitionAvailability === undefined) {
    return { outcome: 'refused', capability: input.capability, reason: 'capability_unknown' };
  }
  if (input.definitionAvailability === 'postponed') {
    return { outcome: 'refused', capability: input.capability, reason: 'capability_postponed' };
  }
  if (!input.entitlement) {
    return { outcome: 'refused', capability: input.capability, reason: 'not_entitled' };
  }
  if (input.entitlement.limitKind === 'flag') {
    return { outcome: 'granted', capability: input.capability, limit: null, remaining: null };
  }
  if (input.entitlement.limit === null) {
    return { outcome: 'granted', capability: input.capability, limit: null, remaining: null };
  }
  const remaining = input.entitlement.limit - input.used;
  if (remaining < input.amount) {
    return { outcome: 'refused', capability: input.capability, reason: 'limit_reached' };
  }
  return {
    outcome: 'granted',
    capability: input.capability,
    limit: input.entitlement.limit,
    remaining,
  };
}
