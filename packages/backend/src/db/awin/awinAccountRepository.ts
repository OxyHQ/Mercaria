/**
 * `awin_accounts` — the publisher account, its credential LOCATORS and its
 * network-level state (#66).
 *
 * Nothing here reads a secret. The columns hold `env:`/`ssm:` locators, and
 * resolving one is `services/awin/credential.ts`'s job — the same division
 * #62 draws for `catalog_source_configs.credential_ref`, so a repository that
 * returns a row can never be the thing that leaked a key.
 */

import { asc, eq } from 'drizzle-orm';
import type { AwinAccountState, AwinAccountStateReason } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { AWIN_MAX_TEXT_LENGTH, awinAccounts } from '../schema/awin.js';

/**
 * Fit a note or an error to the column's own CHECK.
 *
 * Bounded HERE rather than at every call site, because the alternative is a
 * 23514 raised from inside a dispatcher tick on the one path whose whole job is
 * to record why something failed — a failure to record a failure, which reads
 * as the loop being silent.
 */
function bounded(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  return value.slice(0, AWIN_MAX_TEXT_LENGTH);
}

export type AwinAccountRow = typeof awinAccounts.$inferSelect;

export interface UpsertAwinAccountInput {
  publisherId: string;
  label: string;
  feedCredentialRef?: string | null;
  publisherApiCredentialRef?: string | null;
  maxConcurrency?: number;
  maxCallsPerMinute?: number;
}

/**
 * Register or reconfigure one publisher account.
 *
 * Converges on `publisher_id` rather than minting a second row — two rows for
 * one Awin publisher would be two budgets for one key, which is the arithmetic
 * that gets an integration suspended.
 *
 * It deliberately does not accept a STATE. Configuration and a state change are
 * different acts by different people at different times, and a state parameter
 * here is how an account gets resumed by somebody who was only correcting a
 * label.
 */
export async function upsertAwinAccount(
  input: UpsertAwinAccountInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<AwinAccountRow> {
  const values = {
    publisherId: input.publisherId,
    label: input.label,
    feedCredentialRef: input.feedCredentialRef ?? null,
    publisherApiCredentialRef: input.publisherApiCredentialRef ?? null,
    ...(input.maxConcurrency === undefined ? {} : { maxConcurrency: input.maxConcurrency }),
    ...(input.maxCallsPerMinute === undefined ? {} : { maxCallsPerMinute: input.maxCallsPerMinute }),
  };
  const [row] = await db
    .insert(awinAccounts)
    .values(values)
    .onConflictDoUpdate({ target: awinAccounts.publisherId, set: values })
    .returning();
  if (row === undefined) throw new Error('awin_accounts upsert returned no row');
  return row;
}

export async function findAwinAccount(
  accountId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AwinAccountRow | null> {
  const [row] = await db.select().from(awinAccounts).where(eq(awinAccounts.id, accountId)).limit(1);
  return row ?? null;
}

export async function listAwinAccounts(
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly AwinAccountRow[]> {
  return db.select().from(awinAccounts).orderBy(asc(awinAccounts.publisherId));
}

/** Every account a discovery loop may poll. */
export async function listPollableAwinAccounts(
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly AwinAccountRow[]> {
  return db
    .select()
    .from(awinAccounts)
    .where(eq(awinAccounts.state, 'active'))
    .orderBy(asc(awinAccounts.publisherId));
}

export interface ChangeAwinAccountStateInput {
  accountId: string;
  state: AwinAccountState;
  reason: AwinAccountStateReason;
  actorOxyUserId: string | null;
  note?: string;
  now?: Date;
}

/**
 * Move an account's state, always with a reason.
 *
 * `active` still records the reason and the actor: resuming an account after a
 * deauthorization is a decision somebody made, and an unattributed resume is
 * the one people argue about afterwards. The CHECK only DEMANDS them off
 * `active`; writing them always costs nothing and answers more.
 *
 * `actorOxyUserId` is nullable because the loop itself raises
 * `credential_rejected` — attributing that to a person would be a false audit
 * trail, which is `catalog_source_runs_requested_by_check`'s rule one domain
 * over.
 */
export async function changeAwinAccountState(
  input: ChangeAwinAccountStateInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<AwinAccountRow | null> {
  const now = input.now ?? new Date();
  const [row] = await db
    .update(awinAccounts)
    .set({
      state: input.state,
      stateReason: input.reason,
      stateChangedAt: now,
      stateChangedByOxyUserId: input.actorOxyUserId,
      stateNote: bounded(input.note),
      updatedAt: now,
    })
    .where(eq(awinAccounts.id, input.accountId))
    .returning();
  return row ?? null;
}

export interface RecordAwinListPollInput {
  accountId: string;
  digest: string;
  feedCount: number;
  now?: Date;
}

/** A successful feed-list poll: what was read, and when. Clears the last error. */
export async function recordAwinListPoll(
  input: RecordAwinListPollInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const now = input.now ?? new Date();
  await db
    .update(awinAccounts)
    .set({
      lastListPolledAt: now,
      lastListDigest: input.digest,
      lastListFeedCount: input.feedCount,
      lastListError: null,
      lastListErrorAt: null,
      updatedAt: now,
    })
    .where(eq(awinAccounts.id, input.accountId));
}

/**
 * A failed feed-list poll.
 *
 * `lastListPolledAt` is deliberately NOT moved: it means "when did Mercaria
 * last successfully READ the list", and a failure that advanced it would make a
 * network that has been unreadable for a week look freshly polled. The failure
 * gets its own instant.
 */
export async function recordAwinListPollFailure(
  input: { accountId: string; error: string; now?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const now = input.now ?? new Date();
  await db
    .update(awinAccounts)
    .set({ lastListError: bounded(input.error), lastListErrorAt: now, updatedAt: now })
    .where(eq(awinAccounts.id, input.accountId));
}
