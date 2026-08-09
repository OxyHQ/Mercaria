/**
 * `awin_advertisers` — one Awin advertiser, and the #62 source that IS it (#66).
 *
 * ## Two lifecycles, two writers, and no function that moves both
 *
 * `membership_status` is what AWIN says and is written only by
 * {@link applyAwinMembership}, from a feed-list row. `activation` is what
 * MERCARIA decided and is written only by {@link changeAwinActivation}, from an
 * operator's request or from the closure reconciliation. There is deliberately
 * no `updateAdvertiser` that takes both: a single writer would let a discovery
 * pass silently resume an advertiser somebody paused, which is the one direction
 * of that mistake nobody would notice.
 */

import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { AwinActivation, AwinMembershipStatus } from '@mercaria/shared-types';
import { AWIN_FETCHING_ACTIVATIONS } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { AWIN_MAX_TEXT_LENGTH, awinAdvertisers } from '../schema/awin.js';

export type AwinAdvertiserRow = typeof awinAdvertisers.$inferSelect;

export interface DiscoverAwinAdvertiserInput {
  accountId: string;
  advertiserId: string;
  displayName: string;
  membershipStatus: AwinMembershipStatus;
  primaryRegion?: string | null;
  vertical?: string | null;
  declaredHost?: string | null;
  now?: Date;
}

/**
 * Record that the feed list mentioned this advertiser.
 *
 * IDEMPOTENT by construction (issue feed lifecycle 1): `ON CONFLICT DO UPDATE`
 * on `(account_id, advertiser_id)`, so a re-run of the same list changes
 * nothing an operator decided. It never touches `activation`,
 * `catalog_source_id` or the activating sample — discovery finds advertisers
 * and registers none of them, because creating a source would mean creating a
 * merchant and a storefront for a retailer nobody reviewed.
 *
 * `membership_changed_at` moves only when the STATUS actually moved. A list
 * poll every hour that stamped it regardless would make "when did Awin suspend
 * us" unanswerable, which is the question the column exists for.
 */
export async function discoverAwinAdvertiser(
  input: DiscoverAwinAdvertiserInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<AwinAdvertiserRow> {
  const now = input.now ?? new Date();
  const [row] = await db
    .insert(awinAdvertisers)
    .values({
      accountId: input.accountId,
      advertiserId: input.advertiserId,
      displayName: input.displayName,
      membershipStatus: input.membershipStatus,
      membershipChangedAt: now,
      primaryRegion: input.primaryRegion ?? null,
      vertical: input.vertical ?? null,
      declaredHost: input.declaredHost ?? null,
      lastSeenInListAt: now,
    })
    .onConflictDoUpdate({
      target: [awinAdvertisers.accountId, awinAdvertisers.advertiserId],
      set: {
        displayName: input.displayName,
        membershipStatus: input.membershipStatus,
        // The stamp moves only when the STATUS actually moved. Bound as an ISO
        // string with an explicit cast, never a bare `Date`: a `Date`
        // interpolated into a `sql` template has no column to take a wire type
        // from and postgres.js refuses it in the DRIVER, with a message that
        // never mentions the column (`~/Oxy/AGENTS.md`, the `sql`-template
        // traps).
        membershipChangedAt: sql`case
          when ${awinAdvertisers.membershipStatus} is distinct from ${input.membershipStatus}
          then ${now.toISOString()}::timestamptz
          else ${awinAdvertisers.membershipChangedAt} end`,
        primaryRegion: input.primaryRegion ?? null,
        vertical: input.vertical ?? null,
        declaredHost: input.declaredHost ?? null,
        lastSeenInListAt: now,
        updatedAt: now,
      },
    })
    .returning();
  if (row === undefined) throw new Error('awin_advertisers upsert returned no row');
  return row;
}

export interface ApplyAwinMembershipInput {
  advertiserRowId: string;
  membershipStatus: AwinMembershipStatus;
  now?: Date;
}

/** Apply a membership change Awin reported. Never touches `activation`. */
export async function applyAwinMembership(
  input: ApplyAwinMembershipInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<AwinAdvertiserRow | null> {
  const now = input.now ?? new Date();
  const [row] = await db
    .update(awinAdvertisers)
    .set({
      membershipStatus: input.membershipStatus,
      membershipChangedAt: now,
      updatedAt: now,
    })
    .where(eq(awinAdvertisers.id, input.advertiserRowId))
    .returning();
  return row ?? null;
}

export interface ChangeAwinActivationInput {
  advertiserRowId: string;
  activation: AwinActivation;
  actorOxyUserId: string;
  activatingSampleId?: string | null;
  note?: string;
  now?: Date;
}

/**
 * Move Mercaria's own decision about this advertiser.
 *
 * `activating_sample_id` is written on the way IN to `active` and left alone
 * otherwise, so a pause keeps the evidence that authorised the activation it
 * suspends — and the CHECK
 * (`awin_advertisers_activation_sample_check`) refuses `active` without one,
 * whether the writer is this function, a service bug or `psql`.
 */
export async function changeAwinActivation(
  input: ChangeAwinActivationInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<AwinAdvertiserRow | null> {
  const now = input.now ?? new Date();
  const [row] = await db
    .update(awinAdvertisers)
    .set({
      activation: input.activation,
      activationChangedAt: now,
      activationChangedByOxyUserId: input.actorOxyUserId,
      activationNote: input.note === undefined ? null : input.note.slice(0, AWIN_MAX_TEXT_LENGTH),
      ...(input.activatingSampleId === undefined
        ? {}
        : { activatingSampleId: input.activatingSampleId }),
      updatedAt: now,
    })
    .where(eq(awinAdvertisers.id, input.advertiserRowId))
    .returning();
  return row ?? null;
}

/** Bind the #62 registry row an operator configured for this advertiser. */
export async function bindAwinAdvertiserSource(
  input: { advertiserRowId: string; catalogSourceId: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<AwinAdvertiserRow | null> {
  const now = input.now ?? new Date();
  const [row] = await db
    .update(awinAdvertisers)
    .set({ catalogSourceId: input.catalogSourceId, updatedAt: now })
    .where(eq(awinAdvertisers.id, input.advertiserRowId))
    .returning();
  return row ?? null;
}

export async function findAwinAdvertiser(
  advertiserRowId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AwinAdvertiserRow | null> {
  const [row] = await db
    .select()
    .from(awinAdvertisers)
    .where(eq(awinAdvertisers.id, advertiserRowId))
    .limit(1);
  return row ?? null;
}

/** The adapter's entry point: which advertiser is this #62 source? */
export async function findAwinAdvertiserBySource(
  catalogSourceId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AwinAdvertiserRow | null> {
  const [row] = await db
    .select()
    .from(awinAdvertisers)
    .where(eq(awinAdvertisers.catalogSourceId, catalogSourceId))
    .limit(1);
  return row ?? null;
}

export async function listAwinAdvertisers(
  input: { accountId: string; activation?: AwinActivation },
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly AwinAdvertiserRow[]> {
  return db
    .select()
    .from(awinAdvertisers)
    .where(
      input.activation === undefined
        ? eq(awinAdvertisers.accountId, input.accountId)
        : and(
            eq(awinAdvertisers.accountId, input.accountId),
            eq(awinAdvertisers.activation, input.activation),
          ),
    )
    .orderBy(asc(awinAdvertisers.displayName));
}

/**
 * Every advertiser whose feed this deployment may fetch.
 *
 * `AWIN_FETCHING_ACTIVATIONS` is the tuple, read here rather than spelled as
 * two comparisons: a third fetching state added later must not need this
 * predicate to be remembered.
 */
export async function listFetchingAwinAdvertisers(
  input: { accountId: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly AwinAdvertiserRow[]> {
  return db
    .select()
    .from(awinAdvertisers)
    .where(
      and(
        eq(awinAdvertisers.accountId, input.accountId),
        inArray(awinAdvertisers.activation, [...AWIN_FETCHING_ACTIVATIONS]),
        isNotNull(awinAdvertisers.catalogSourceId),
      ),
    )
    .orderBy(asc(awinAdvertisers.displayName));
}
