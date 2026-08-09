/**
 * The fleet-wide eBay call budget — issue #65 reliability 1, "respect quotas
 * across all workers".
 *
 * ## One conditional UPDATE is the whole mechanism
 *
 * ```sql
 * update ebay_call_budgets
 *    set calls_used = calls_used + $n
 *  where application_key = $k and budget_date = $d
 *    and calls_used + $n <= daily_limit
 * returning calls_used, daily_limit
 * ```
 *
 * It either grants the whole reservation or grants nothing, in one statement,
 * under the row lock Postgres takes for the update anyway. N ECS tasks racing
 * produce N serialized updates and the sum can never pass `daily_limit`. A
 * counter held in each process bounds each process and nothing else — five tasks
 * would draw 25,000 calls against a 5,000-call agreement, and eBay would start
 * refusing before anybody noticed.
 *
 * An EMPTY returning set is the refusal. It is not an error to catch: "the
 * predicate did not hold" and "the row does not exist" both mean no allowance
 * was granted, and treating either as an exception would make a legitimate
 * exhaustion look like a fault. The moderation outbox's
 * `ON CONFLICT DO NOTHING … RETURNING` reads its answer the same way.
 *
 * ## Reservations are never returned
 *
 * There is deliberately no `release`. A call that was reserved and then not made
 * — because a lease expired between the reservation and the request — is spent
 * as far as this budget is concerned. Refunding it would need the caller to be
 * trusted to report a failure it may not survive to observe, and the cost of the
 * conservative reading is a handful of calls a day against five thousand.
 *
 * ## The key is a DIGEST of the credential LOCATOR
 *
 * Not of the credential. `catalog_source_configs.credential_ref` is
 * `env:EBAY_KEYSET`, which #62's CHECK already refuses to let be a secret. The
 * digest is here because it is fixed-width — so the unique index is bounded
 * whatever an operator types — and because two sources naming one keyset must
 * collapse onto one row by construction rather than by string equality on a
 * value somebody might write two ways.
 */

import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { EBAY_DEFAULT_DAILY_CALL_LIMIT } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { ebayCallBudgets } from '../schema/ebay.js';

export type EbayCallBudgetRow = typeof ebayCallBudgets.$inferSelect;

/** sha-256 hex of a credential LOCATOR. See the module docblock. */
export function ebayApplicationKey(credentialRef: string): string {
  return createHash('sha256').update(credentialRef, 'utf8').digest('hex');
}

/**
 * The UTC day a reservation belongs to.
 *
 * eBay resets at midnight UTC and a budget on any other clock is a budget that
 * disagrees with the one being enforced — in the direction that gets an
 * application throttled. Rendered as `YYYY-MM-DD` because that is what a
 * `date` column binds cleanly to; a `Date` inside a value list would be handed
 * to postgres.js with the driver's own timezone opinion attached.
 */
export function ebayBudgetDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface EbayReservationResult {
  readonly granted: boolean;
  readonly callsUsed: number;
  readonly dailyLimit: number;
}

/**
 * Reserve `calls` against today's allowance for one application keyset.
 *
 * The row is created on first use with `ON CONFLICT DO NOTHING`, so two tasks
 * arriving at midnight converge instead of racing; the reservation is then a
 * separate conditional UPDATE, which is what makes the bound exact.
 *
 * A refusal increments `calls_refused` — the other half of the vacuity floor.
 * `calls_used` alone cannot tell a quiet day from a day the budget spent hours
 * refusing everything, and those need opposite responses (leave it alone; file
 * eBay's application growth check).
 */
export async function reserveEbayCalls(
  db: DatabaseOrTransaction = getDb(),
  input: { applicationKey: string; calls: number; dailyLimit: number; now: Date },
): Promise<EbayReservationResult> {
  const budgetDate = ebayBudgetDate(input.now);
  const dailyLimit = input.dailyLimit > 0 ? input.dailyLimit : EBAY_DEFAULT_DAILY_CALL_LIMIT;

  await db
    .insert(ebayCallBudgets)
    .values({
      applicationKey: input.applicationKey,
      budgetDate,
      dailyLimit,
      callsUsed: 0,
      callsRefused: 0,
    })
    .onConflictDoNothing();

  const [granted] = await db
    .update(ebayCallBudgets)
    .set({
      callsUsed: sql`${ebayCallBudgets.callsUsed} + ${input.calls}`,
      lastCallAt: input.now,
    })
    .where(
      and(
        eq(ebayCallBudgets.applicationKey, input.applicationKey),
        eq(ebayCallBudgets.budgetDate, budgetDate),
        // The predicate IS the bound. `ebay_call_budgets_within_limit_check`
        // states the same rule at the row so a replay or a hand-typed repair
        // cannot exceed it either; neither is a second source of truth, because
        // the CHECK cannot grant and the predicate cannot exceed it.
        sql`${ebayCallBudgets.callsUsed} + ${input.calls} <= ${ebayCallBudgets.dailyLimit}`,
      ),
    )
    .returning({
      callsUsed: ebayCallBudgets.callsUsed,
      dailyLimit: ebayCallBudgets.dailyLimit,
    });

  if (granted !== undefined) {
    return { granted: true, callsUsed: granted.callsUsed, dailyLimit: granted.dailyLimit };
  }

  const [refused] = await db
    .update(ebayCallBudgets)
    .set({
      callsRefused: sql`${ebayCallBudgets.callsRefused} + 1`,
      lastRefusedAt: input.now,
    })
    .where(
      and(
        eq(ebayCallBudgets.applicationKey, input.applicationKey),
        eq(ebayCallBudgets.budgetDate, budgetDate),
      ),
    )
    .returning({
      callsUsed: ebayCallBudgets.callsUsed,
      dailyLimit: ebayCallBudgets.dailyLimit,
    });

  return {
    granted: false,
    callsUsed: refused?.callsUsed ?? 0,
    dailyLimit: refused?.dailyLimit ?? dailyLimit,
  };
}

/** Recent budget days, newest first — the operator's quota metric. */
export async function listEbayCallBudgets(
  db: DatabaseOrTransaction = getDb(),
  input: { limit: number },
): Promise<EbayCallBudgetRow[]> {
  return db
    .select()
    .from(ebayCallBudgets)
    .orderBy(desc(ebayCallBudgets.budgetDate))
    .limit(input.limit);
}
