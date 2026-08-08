/**
 * Reads and writes for `provider_accounts` — a seller's standing with a rail.
 *
 * `db` is the first parameter everywhere, for the reason
 * `paymentRepository.ts` gives: a helper typed only as `Database` would silently
 * run outside its caller's transaction. Nothing here interprets provider
 * vocabulary; the mapping from a Stripe account onto these columns lives in
 * `services/payments/stripe/account.service.ts`, and the readiness verdict is
 * already collapsed into `onboarding_state` by the time a row is written.
 *
 * ## Two writers, and the reason the second one is guarded
 *
 * A row's state is refreshed from BOTH the `account.updated` webhook and the
 * reconciliation sweep, which is the point — a missed delivery converges without
 * anyone knowing which one was missed (ADR 0001, sequence 6). But that means two
 * tasks can be holding two reads of the same account taken seconds apart, and
 * the later-read one can arrive second. {@link applyProviderAccountState} refuses
 * to move a row BACKWARDS in `last_synced_at`, so the freshest read wins
 * regardless of which write lands first, and neither caller has to know the
 * other exists.
 *
 * That is a compare-and-swap on an observation time rather than a version
 * counter, because the thing being ordered is when the PROVIDER was read, not
 * how many times Mercaria has written.
 */

import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { ProviderAccountOwnerType, ProviderOnboardingState } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { providerAccounts } from '../schema/payments.js';

/** A provider-account row as the services read it back. */
export type ProviderAccountRow = typeof providerAccounts.$inferSelect;

/** Which seller, on which rail. The natural key every read starts from. */
export interface ProviderAccountOwnerKey {
  provider: 'stripe';
  ownerType: ProviderAccountOwnerType;
  ownerId: string;
}

/** What the create path knows before the provider has ever been read back. */
export interface CreateProviderAccountInput extends ProviderAccountOwnerKey {
  providerAccountId: string;
  /** ISO-3166-1 alpha-2, upper-cased — the CHECK refuses anything else. */
  country: string;
}

/**
 * The provider state one synchronisation observed, already interpreted.
 *
 * Every field is what Mercaria decided, not what the provider said: the adapter
 * has already counted the requirements, filtered the reason codes to those safe
 * to show an owner, and evaluated ADR 0001 D9's conjunction into
 * `onboardingState`. Nothing downstream re-derives any of it.
 */
export interface ProviderAccountState {
  onboardingState: ProviderOnboardingState;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  transfersCapability?: 'active' | 'inactive' | 'pending';
  requirementsCurrentlyDue: number;
  requirementsEventuallyDue: number;
  requirementsPastDue: number;
  requirementsPendingVerification: number;
  requirementsDeadlineAt?: Date;
  disabledReasonCodes: readonly string[];
  defaultCurrency?: string;
  payoutScheduleInterval?: string;
  payoutScheduleDelayDays?: number;
  /** When the provider was READ. The ordering key — see this file's docblock. */
  syncedAt: Date;
}

/** The seller's account on a rail, or `undefined` if they have never started. */
export async function findProviderAccountByOwner(
  db: DatabaseOrTransaction,
  key: ProviderAccountOwnerKey,
): Promise<ProviderAccountRow | undefined> {
  const [row] = await db
    .select()
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.provider, key.provider),
        eq(providerAccounts.ownerType, key.ownerType),
        eq(providerAccounts.ownerId, key.ownerId),
      ),
    );
  return row;
}

/**
 * The account a provider event is about.
 *
 * The whole reason `provider_accounts` exists as a table: an inbound
 * `account.updated` or `payout.*` names only the provider's own account id, and
 * this is the one place that resolves it to a seller.
 */
export async function findProviderAccountByProviderId(
  db: DatabaseOrTransaction,
  provider: 'stripe',
  providerAccountId: string,
): Promise<ProviderAccountRow | undefined> {
  const [row] = await db
    .select()
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.provider, provider),
        eq(providerAccounts.providerAccountId, providerAccountId),
      ),
    );
  return row;
}

/**
 * Record an account the provider has just created, converging on the row that
 * already exists if one does.
 *
 * `onConflictDoNothing` on the owner key plus a re-read, rather than a read
 * followed by an insert: two concurrent onboarding clicks race that gap, and the
 * loser of the race must return the winner's row rather than a duplicate-key
 * error the caller would have to interpret. What the unique index cannot undo is
 * the ACCOUNT the loser already created at the provider — which is why the
 * caller checks for an existing row first, and this is the second line of
 * defence rather than the only one.
 */
export async function insertProviderAccount(
  db: DatabaseOrTransaction,
  input: CreateProviderAccountInput,
): Promise<ProviderAccountRow> {
  const [inserted] = await db
    .insert(providerAccounts)
    .values({
      provider: input.provider,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      providerAccountId: input.providerAccountId,
      country: input.country,
      onboardingState: 'action_required',
    })
    .onConflictDoNothing({
      target: [providerAccounts.provider, providerAccounts.ownerType, providerAccounts.ownerId],
    })
    .returning();
  if (inserted) return inserted;

  const existing = await findProviderAccountByOwner(db, input);
  if (!existing) {
    throw new Error(
      `provider_accounts insert for ${input.ownerType}:${input.ownerId} conflicted with a row ` +
        'that then could not be read back.',
    );
  }
  return existing;
}

/**
 * Apply an observation of provider state, unless a FRESHER one already landed.
 *
 * @returns The row as it now stands, and whether this observation was the one
 *   applied. `applied: false` is an ordinary outcome — a concurrent, newer read
 *   won — and never an error.
 */
export async function applyProviderAccountState(
  db: DatabaseOrTransaction,
  input: { id: string; state: ProviderAccountState },
): Promise<{ row: ProviderAccountRow; applied: boolean }> {
  const { state } = input;
  const [updated] = await db
    .update(providerAccounts)
    .set({
      onboardingState: state.onboardingState,
      chargesEnabled: state.chargesEnabled,
      payoutsEnabled: state.payoutsEnabled,
      transfersCapability: state.transfersCapability ?? null,
      requirementsCurrentlyDue: state.requirementsCurrentlyDue,
      requirementsEventuallyDue: state.requirementsEventuallyDue,
      requirementsPastDue: state.requirementsPastDue,
      requirementsPendingVerification: state.requirementsPendingVerification,
      requirementsDeadlineAt: state.requirementsDeadlineAt ?? null,
      disabledReasonCodes: [...state.disabledReasonCodes],
      defaultCurrency: state.defaultCurrency ?? null,
      payoutScheduleInterval: state.payoutScheduleInterval ?? null,
      payoutScheduleDelayDays: state.payoutScheduleDelayDays ?? null,
      lastSyncedAt: state.syncedAt,
      // Set on the first sync that reports readiness and never moved again. A
      // seller who loses and regains readiness activated ONCE — the date a
      // marketplace is asked about is when they were first able to sell.
      //
      // `coalesce` rather than a read-then-write, so two concurrent syncs cannot
      // both see NULL and race. The value is interpolated as an ISO STRING with
      // an explicit cast: a raw `Date` inside `sql` bypasses drizzle's column
      // mapper and postgres.js rejects it outright with `ERR_INVALID_ARG_TYPE`
      // (`CONVENTIONS.md`, the `db.execute` trap — this is its write direction,
      // which is the friendly one because it throws instead of storing garbage).
      ...(state.onboardingState === 'ready'
        ? {
            activatedAt: sql`coalesce(${providerAccounts.activatedAt}, ${state.syncedAt.toISOString()}::timestamptz)`,
          }
        : {}),
    })
    .where(
      and(
        eq(providerAccounts.id, input.id),
        // The compare-and-swap. `<=` and not `<` so a re-application of the same
        // observation is a write that changes nothing rather than a refusal the
        // caller has to distinguish from a real conflict.
        or(isNull(providerAccounts.lastSyncedAt), lte(providerAccounts.lastSyncedAt, state.syncedAt)),
        // A revoked account is CLOSED to observations, and the timestamp guard
        // alone does not close it: a sync that read Stripe BEFORE the
        // deauthorization arrived still stamps `synced_at` after it, so its CAS
        // would pass and it would write back the healthy account it had been
        // handed — restoring `ready` on a seller Mercaria can no longer pay,
        // with `revoked_at` still set beside it. The window is one Stripe API
        // call wide and the consequence is an unpayable seller selling, so it is
        // closed here rather than left to the caller to remember.
        isNull(providerAccounts.revokedAt),
      ),
    )
    .returning();

  if (updated) return { row: updated, applied: true };

  const [current] = await db
    .select()
    .from(providerAccounts)
    .where(eq(providerAccounts.id, input.id));
  if (!current) {
    throw new Error(`provider_accounts row ${input.id} disappeared during a state update.`);
  }
  return { row: current, applied: false };
}

/**
 * The provider revoked the platform's authorisation for this account.
 *
 * Terminal, and applied WITHOUT the freshness guard above: a deauthorization is
 * not an observation of state that a later read supersedes, it is the end of
 * Mercaria's ability to read that account at all. A sync that was in flight when
 * it arrived must not be able to put the row back.
 *
 * @returns Whether this call was the one that revoked it.
 */
export async function revokeProviderAccount(
  db: DatabaseOrTransaction,
  input: { id: string; at: Date },
): Promise<boolean> {
  const updated = await db
    .update(providerAccounts)
    .set({
      onboardingState: 'disabled',
      payoutsEnabled: false,
      chargesEnabled: false,
      transfersCapability: null,
      revokedAt: input.at,
      lastSyncedAt: input.at,
    })
    .where(and(eq(providerAccounts.id, input.id), isNull(providerAccounts.revokedAt)))
    .returning({ id: providerAccounts.id });
  return updated.length === 1;
}

/**
 * Accounts whose provider state has not been read recently — oldest first.
 *
 * The reconciliation sweep's input. Never-synced rows sort first because
 * `last_synced_at` is NULL and `asc` puts NULLs last in Postgres by default —
 * hence the explicit `nulls first`, which is not decoration: a row that was
 * created and never read back is the one MOST likely to be stuck, and default
 * ordering would visit it after every account that has ever synced.
 *
 * Revoked accounts are excluded. There is nothing left to read: the platform's
 * authorisation is gone, so every call would 401 forever.
 */
export async function findStaleProviderAccounts(
  db: DatabaseOrTransaction,
  input: { provider: 'stripe'; staleBefore: Date; limit: number },
): Promise<ProviderAccountRow[]> {
  return await db
    .select()
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.provider, input.provider),
        isNull(providerAccounts.revokedAt),
        or(
          isNull(providerAccounts.lastSyncedAt),
          lte(providerAccounts.lastSyncedAt, input.staleBefore),
        ),
      ),
    )
    .orderBy(sql`${providerAccounts.lastSyncedAt} asc nulls first`, asc(providerAccounts.createdAt))
    .limit(input.limit);
}
