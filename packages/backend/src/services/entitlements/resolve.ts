/**
 * The ONE server-side resolution of a merchant's effective entitlements (#89
 * entitlement rule 1) — from the plan version, the subscription and the grants,
 * in that order of authority.
 *
 * ## What a store with no subscription gets
 *
 * The ACTIVE FREE plan's entitlements, and today that is an EMPTY SET — not
 * because the free plan is impoverished but because everything a free merchant
 * does is ungateable by construction (`MERCHANT_UNGATEABLE_CAPABILITIES`), so
 * none of it has a capability key an entitlement could name. A deployment with
 * no free plan published at all resolves to the same empty set and refuses
 * nothing that matters, which is why this resolver — unlike #58's matcher or
 * #121's eligibility — has no "no active version, refuse" branch. Refusing here
 * would withhold a paid extra; refusing there would withhold a sale.
 *
 * ## `past_due` still entitles, and the DEADLINE is what ends it
 *
 * Issue #89 entitlement rule 6: a subscription failure removes paid extras
 * "after a grace policy". The grace is a stored deadline on the subscription,
 * computed once from the plan version in force when the payment failed — so a
 * plan change cannot shorten a grace already running, and this resolver compares
 * a timestamp instead of re-deriving a policy. Once the deadline passes the
 * store falls back to the free plan, and the sweep that writes `expired` is a
 * tidy-up rather than the mechanism: the entitlements go away at the deadline
 * whether or not the sweep has run.
 *
 * ## The cache, and the bound it really has
 *
 * Results are cached in-process for {@link ENTITLEMENT_CACHE_TTL_MS} and
 * invalidated explicitly by every writer in this domain. Mercaria runs several
 * ECS tasks, so an invalidation reaches ONE of them: the TTL is the real bound
 * on how long another task can serve a stale answer, and it is deliberately
 * short. That is acceptable here and would not be somewhere else — nothing a
 * merchant needs in order to trade is resolved through this function, so the
 * worst a stale entry can do is let a paid extra work for up to a minute after a
 * downgrade.
 *
 * No timer, deliberately: a module-level `setInterval` would keep the event loop
 * alive and hang the test run (`~/Oxy/AGENTS.md`). Entries are evicted lazily on
 * read and the map is bounded, so a deployment with many stores cannot grow it
 * without limit.
 */

import {
  ENTITLING_SUBSCRIPTION_STATUSES,
  type EntitlementAvailability,
  type EntitlementLimitKind,
  type MerchantEntitlementCapability,
  type MerchantSubscriptionStatus,
} from '@mercaria/shared-types';
import { getDb } from '../../db/postgres.js';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findActiveFreeMerchantPlan,
  findMerchantPlanById,
  listEntitlementDefinitions,
  listPlanEntitlements,
  type MerchantPlanRow,
} from '../../db/merchantPlans/planRepository.js';
import { listLiveEntitlementGrants } from '../../db/merchantPlans/grantRepository.js';
import { findSubscriptionByStore } from '../../db/merchantPlans/subscriptionRepository.js';
import { mostGenerousLimit, type EffectiveEntitlement } from './capabilities.js';

/** How long a resolution may be reused. Short on purpose — see the docblock. */
export const ENTITLEMENT_CACHE_TTL_MS = 60_000;

/** How many stores' resolutions are held at once, so the map cannot grow forever. */
const ENTITLEMENT_CACHE_MAX_ENTRIES = 5_000;

/** Everything the entitlement layer knows about one store at one instant. */
export interface ResolvedMerchantEntitlements {
  readonly storeId: string;
  /** The plan whose entitlements apply — NULL when no free plan is published. */
  readonly planKey: string | null;
  readonly planVersion: number | null;
  readonly planId: string | null;
  /** The subscription's status, or NULL when the store has none. */
  readonly subscriptionStatus: MerchantSubscriptionStatus | null;
  /** The billing period a `per_period` counter is keyed on, when there is one. */
  readonly currentPeriodStart: Date | null;
  /** When paid entitlements stop, for a subscription inside its grace. */
  readonly graceExpiresAt: Date | null;
  /** The effective entitlements, by capability key. */
  readonly entitlements: ReadonlyMap<MerchantEntitlementCapability, EffectiveEntitlement>;
  /** What this deployment says about each defined capability. */
  readonly availability: ReadonlyMap<MerchantEntitlementCapability, EntitlementAvailability>;
  readonly resolvedAt: Date;
}

interface CacheEntry {
  readonly expiresAtMs: number;
  readonly value: ResolvedMerchantEntitlements;
}

const cache = new Map<string, CacheEntry>();

/**
 * Drop one store's cached resolution.
 *
 * Called by every writer in this domain — a subscription change, a grant, a
 * revocation. "Deterministic invalidation" (#89 entitlement rule 5) means the
 * writer says so rather than the reader guessing; the TTL is the backstop for
 * the other tasks that never saw the write.
 */
export function invalidateMerchantEntitlements(storeId: string): void {
  cache.delete(storeId);
}

/**
 * Drop every cached resolution.
 *
 * A plan version activating or a capability definition moving changes what EVERY
 * store resolves to, and enumerating the affected stores would be a query whose
 * answer is "all of them".
 */
export function invalidateAllMerchantEntitlements(): void {
  cache.clear();
}

/** Whether a subscription's paid entitlements still apply at `at`. */
function subscriptionEntitles(
  status: MerchantSubscriptionStatus,
  graceExpiresAt: Date | null,
  at: Date,
): boolean {
  if (!ENTITLING_SUBSCRIPTION_STATUSES.includes(status)) return false;
  if (status !== 'past_due') return true;
  // The CHECK makes a `past_due` without a deadline unwritable, so a NULL here
  // means a row that predates the constraint or was written by something that
  // bypassed it — and the safe reading of "past due, deadline unknown" is that
  // the grace has run out.
  return graceExpiresAt !== null && graceExpiresAt > at;
}

/**
 * Resolve one store's effective entitlements.
 *
 * @param options.at The instant to resolve against. A parameter rather than
 *   `new Date()` inside, so a grace boundary is testable without waiting for it.
 * @param options.fresh Skip the cache — what a write path uses immediately after
 *   changing something, and what the operator trace uses always.
 */
export async function resolveMerchantEntitlements(
  storeId: string,
  options?: { at?: Date; fresh?: boolean; db?: DatabaseOrTransaction },
): Promise<ResolvedMerchantEntitlements> {
  const at = options?.at ?? new Date();
  if (!options?.fresh) {
    const hit = cache.get(storeId);
    if (hit && hit.expiresAtMs > at.getTime()) return hit.value;
    if (hit) cache.delete(storeId);
  }

  const db = options?.db ?? getDb();
  const subscription = await findSubscriptionByStore(db, storeId);

  const entitlingSubscription =
    subscription && subscriptionEntitles(subscription.status, subscription.graceExpiresAt, at)
      ? subscription
      : undefined;

  const plan: MerchantPlanRow | undefined = entitlingSubscription
    ? await findMerchantPlanById(db, entitlingSubscription.planId)
    : await findActiveFreeMerchantPlan(db);

  const [planRows, grants, definitions] = await Promise.all([
    plan ? listPlanEntitlements(db, [plan.id]) : Promise.resolve([]),
    listLiveEntitlementGrants(db, { storeId, at }),
    listEntitlementDefinitions(db),
  ]);

  const entitlements = new Map<MerchantEntitlementCapability, EffectiveEntitlement>();
  for (const row of planRows) {
    entitlements.set(row.capabilityKey, {
      capability: row.capabilityKey,
      limitKind: row.limitKind,
      limit: row.limitValue,
      source: 'plan',
    });
  }
  for (const grant of grants) {
    const existing = entitlements.get(grant.capabilityKey);
    if (!existing) {
      entitlements.set(grant.capabilityKey, {
        capability: grant.capabilityKey,
        limitKind: grant.limitKind,
        limit: grant.limitValue,
        source: 'grant',
      });
      continue;
    }
    const merged = mostGenerousLimit(existing.limit, grant.limitValue);
    entitlements.set(grant.capabilityKey, {
      capability: grant.capabilityKey,
      limitKind: existing.limitKind,
      limit: merged,
      // The source names where the WINNING limit came from, so a merchant asking
      // "why do I have this" is answered by the thing that actually granted it.
      source: merged === existing.limit ? existing.source : 'grant',
    });
  }

  const availability = new Map<MerchantEntitlementCapability, EntitlementAvailability>();
  for (const definition of definitions) {
    availability.set(definition.capabilityKey, definition.availability);
  }

  const resolved: ResolvedMerchantEntitlements = {
    storeId,
    planKey: plan?.planKey ?? null,
    planVersion: plan?.version ?? null,
    planId: plan?.id ?? null,
    subscriptionStatus: subscription?.status ?? null,
    currentPeriodStart: entitlingSubscription?.currentPeriodStart ?? null,
    graceExpiresAt: subscription?.graceExpiresAt ?? null,
    entitlements,
    availability,
    resolvedAt: at,
  };

  if (cache.size >= ENTITLEMENT_CACHE_MAX_ENTRIES) {
    // Oldest-inserted first: `Map` iterates in insertion order, so one delete is
    // enough to keep the bound and there is no eviction policy to get wrong.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(storeId, { expiresAtMs: at.getTime() + ENTITLEMENT_CACHE_TTL_MS, value: resolved });
  return resolved;
}

/** The limit kind one capability carries in this resolution, when it holds it. */
export function resolvedLimitKind(
  resolved: ResolvedMerchantEntitlements,
  capability: MerchantEntitlementCapability,
): EntitlementLimitKind | undefined {
  return resolved.entitlements.get(capability)?.limitKind;
}
