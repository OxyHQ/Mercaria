/**
 * The three calls a paid capability's own code makes, with the refusal already
 * turned into the API's error vocabulary.
 *
 * `usage.ts` answers with an {@link EntitlementDecision} and leaves the caller to
 * decide what a refusal means. Every paid tool means the same thing by it — a
 * 403 the dashboard can explain — so the mapping lives here once:
 *
 * - {@link requireCapability} — "may this store use the tool at all, now". For a
 *   `flag` capability (a report) it is the whole check; for a quantified one it
 *   is what a BACKGROUND run asks before executing something already created
 *   (an automation rule, a schedule), because the allowance was taken when the
 *   thing was created and is not taken again per run.
 * - {@link consumeCapabilityOrThrow} — take the allowance in the caller's
 *   transaction, so the row and the counter commit together.
 * - {@link releaseCapability} — give a `total` allowance back when the counted
 *   thing is deleted, in the same transaction as the delete.
 *
 * ## What a refusal can never touch
 *
 * Only the eight capability keys reach these functions, and none of them names
 * reading or exporting what a merchant already has: a store that stops paying
 * keeps every rule, schedule, register and report row it created, readable and
 * exportable for free (`data_export` is ungateable). What stops is the paid
 * tool's NEW work.
 */

import type {
  EntitlementDecision,
  EntitlementRefusalReason,
  MerchantEntitlementCapability,
} from '@mercaria/shared-types';
import { ErrorCodes } from '../../utils/api-response.js';
import { MercariaError } from '../../lib/errors/error-codes.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { releaseEntitlementUsage } from '../../db/merchantPlans/usageRepository.js';
import { MERCHANT_CAPABILITY_CATALOG } from './catalog.js';
import { checkCapability, consumeCapability, type CapabilityRequest } from './usage.js';
import { invalidateMerchantEntitlements } from './resolve.js';

/** The refusal as the API answers it: the plan lacks the tool, or the limit is spent. */
export class PlanCapabilityRefusal extends MercariaError {
  readonly capability: MerchantEntitlementCapability;
  readonly reason: EntitlementRefusalReason;

  constructor(capability: MerchantEntitlementCapability, reason: EntitlementRefusalReason) {
    const name = MERCHANT_CAPABILITY_CATALOG[capability].name;
    const limit = reason === 'limit_reached';
    super({
      code: limit ? ErrorCodes.PLAN_LIMIT_REACHED : ErrorCodes.PLAN_CAPABILITY_REQUIRED,
      message: limit
        ? `This store has used everything its plan includes for ${name}.`
        : `${name} is part of a Mercaria plan this store does not have.`,
    });
    this.name = 'PlanCapabilityRefusal';
    this.capability = capability;
    this.reason = reason;
  }
}

function orThrow(decision: EntitlementDecision): EntitlementDecision & { outcome: 'granted' } {
  if (decision.outcome === 'refused') {
    throw new PlanCapabilityRefusal(decision.capability, decision.reason);
  }
  return decision;
}

/**
 * Whether the store holds the capability now, throwing the API refusal if not.
 *
 * Read only. For a quantified capability it asks with `amount: 0`-equivalent
 * semantics — "is it entitled at all" — so a store whose counter sits exactly
 * at its limit can still RUN what it already created; only creating more is
 * refused, by {@link consumeCapabilityOrThrow}.
 */
export async function requireCapability(
  input: Omit<CapabilityRequest, 'amount'>,
): Promise<EntitlementDecision & { outcome: 'granted' }> {
  const decision = await checkCapability({ ...input, amount: 1 });
  if (decision.outcome === 'refused' && decision.reason === 'limit_reached') {
    // Entitled, and at the ceiling: running existing work is still allowed.
    return { outcome: 'granted', capability: input.capability, limit: null, remaining: 0 };
  }
  return orThrow(decision);
}

/** Whether the store holds the capability now, as a boolean. Never throws a refusal. */
export async function holdsCapability(input: Omit<CapabilityRequest, 'amount'>): Promise<boolean> {
  try {
    await requireCapability(input);
    return true;
  } catch (error) {
    if (error instanceof PlanCapabilityRefusal) return false;
    throw error;
  }
}

/**
 * Take `amount` of the allowance in the caller's transaction, or throw the refusal.
 *
 * The caller must pass its OPEN transaction and write the counted row in it, so
 * a rollback of either undoes both.
 */
export async function consumeCapabilityOrThrow(
  db: DatabaseOrTransaction,
  input: CapabilityRequest,
): Promise<EntitlementDecision & { outcome: 'granted' }> {
  return orThrow(await consumeCapability(db, input));
}

/**
 * Give back a `total` allowance when the counted thing is deleted.
 *
 * Refuses a `per_period` capability by type and at runtime: a period allowance
 * measures use, and deleting an export file does not un-run the export.
 */
export async function releaseCapability(
  db: DatabaseOrTransaction,
  input: { storeId: string; capability: MerchantEntitlementCapability; amount?: number },
): Promise<void> {
  if (MERCHANT_CAPABILITY_CATALOG[input.capability].limitKind !== 'total') {
    throw new RangeError(`${input.capability} is not a total allowance and cannot be released.`);
  }
  await releaseEntitlementUsage(db, {
    storeId: input.storeId,
    capabilityKey: input.capability,
    amount: input.amount ?? 1,
  });
  invalidateMerchantEntitlements(input.storeId);
}
