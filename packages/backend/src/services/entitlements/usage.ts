/**
 * The API a capability's own code calls: may this store do it, and record that
 * it did.
 *
 * ## Two functions, and the difference between them is the whole point
 *
 * {@link checkCapability} answers without changing anything — what a screen uses
 * to decide whether to OFFER something. {@link consumeCapability} answers AND
 * takes the allowance, in ONE conditional statement, and takes a transaction
 * handle so the consumption commits with whatever it gated. Issue #89
 * entitlement rule 3 asks for "atomic or transactionally safe usage counters
 * where enforcement matters", and a check followed by a create followed by an
 * increment is neither: two concurrent callers both pass the check.
 *
 * A caller must never do `if (check(...)) { create(); consume(); }`. The check
 * is advisory by construction — it reads a counter that anyone may move a
 * microsecond later — and the consume is the decision.
 *
 * ## Nothing in Mercaria calls either of these today, and that is deliberate
 *
 * Every capability in `MERCHANT_ENTITLEMENT_CAPABILITIES` is `postponed`,
 * because #89's binding constraint is that this work must not put an EXISTING
 * capability behind a plan. So this is the framework a future paid feature is
 * built against, complete and exercised against a real server, with no caller
 * yet — which is a different thing from a stub: it works, and the day somebody
 * ships `scheduled_exports` the only new code is the feature itself.
 */

import type { EntitlementDecision, MerchantEntitlementCapability } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  consumeEntitlementUsage,
  findEntitlementUsage,
} from '../../db/merchantPlans/usageRepository.js';
import { decideEntitlement, entitlementPeriodKey } from './capabilities.js';
import { resolveMerchantEntitlements } from './resolve.js';

/** What both functions accept. `amount` is only meaningful for a quantified kind. */
export interface CapabilityRequest {
  storeId: string;
  capability: MerchantEntitlementCapability;
  amount?: number;
  at?: Date;
}

/**
 * Whether this store may perform the capability's action now — read only.
 *
 * The counter is read live rather than through the entitlement cache: limits
 * change rarely and usage changes constantly, so caching the second would make
 * the answer wrong in the direction that matters (a merchant told they have
 * allowance they have already spent).
 */
export async function checkCapability(input: CapabilityRequest): Promise<EntitlementDecision> {
  const at = input.at ?? new Date();
  const amount = input.amount ?? 1;
  const resolved = await resolveMerchantEntitlements(input.storeId, { at });
  const entitlement = resolved.entitlements.get(input.capability);

  let used = 0;
  if (entitlement && entitlement.limitKind !== 'flag' && entitlement.limit !== null) {
    const periodKey = entitlementPeriodKey(
      entitlement.limitKind,
      at,
      resolved.currentPeriodStart,
    );
    const counter = await findEntitlementUsage(getDb(), {
      storeId: input.storeId,
      capabilityKey: input.capability,
      periodKey,
    });
    used = counter?.used ?? 0;
  }

  return decideEntitlement({
    capability: input.capability,
    entitlement,
    definitionAvailability: resolved.availability.get(input.capability),
    used,
    amount,
  });
}

/**
 * Take the allowance if there is one, in the caller's transaction.
 *
 * @param db The caller's OPEN transaction. Taking one is the point: the counter
 *   must commit with the thing it gated, or a crash between them either charges
 *   a merchant for something that does not exist or hands them one for free.
 * @returns `granted` with the allowance remaining AFTER this consumption, or a
 *   refusal. A `flag` and an unlimited quantified capability consume nothing and
 *   still answer `granted` — there is no counter for either.
 */
export async function consumeCapability(
  db: DatabaseOrTransaction,
  input: CapabilityRequest,
): Promise<EntitlementDecision> {
  const at = input.at ?? new Date();
  const amount = input.amount ?? 1;
  const resolved = await resolveMerchantEntitlements(input.storeId, { at, db });
  const entitlement = resolved.entitlements.get(input.capability);

  const availability = resolved.availability.get(input.capability);
  if (availability === undefined) {
    return { outcome: 'refused', capability: input.capability, reason: 'capability_unknown' };
  }
  if (availability === 'postponed') {
    return { outcome: 'refused', capability: input.capability, reason: 'capability_postponed' };
  }
  if (!entitlement) {
    return { outcome: 'refused', capability: input.capability, reason: 'not_entitled' };
  }
  if (entitlement.limitKind === 'flag') {
    return { outcome: 'granted', capability: input.capability, limit: null, remaining: null };
  }

  const periodKey = entitlementPeriodKey(entitlement.limitKind, at, resolved.currentPeriodStart);
  const counter = await consumeEntitlementUsage(db, {
    storeId: input.storeId,
    capabilityKey: input.capability,
    periodKey,
    amount,
    limit: entitlement.limit,
  });
  if (!counter) {
    return { outcome: 'refused', capability: input.capability, reason: 'limit_reached' };
  }
  return {
    outcome: 'granted',
    capability: input.capability,
    limit: entitlement.limit,
    remaining: entitlement.limit === null ? null : entitlement.limit - counter.used,
  };
}
