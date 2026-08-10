/**
 * Reads and writes on `guest_order_access_grants` (#108, ADR 0003 D5).
 *
 * Like `guestSessionRepository` and `guestCheckoutRepository`, this module knows
 * nothing about plaintext: it stores and matches digests a service produced, so
 * a portal credential cannot end up in a query log.
 *
 * ## Liveness is expressed in SQL, once
 *
 * Every read narrows on the same predicate — not consumed, not revoked, not
 * expired — because a grant that is live for the resolver and dead for the
 * operator trace is a bug whose only symptom is somebody being logged out. It
 * is spelled once in {@link liveGrantPredicate} and reused; the service layer
 * re-derives nothing.
 */

import { and, eq, gt, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type {
  GuestOrderExchangeReason,
  GuestOrderGrantOrigin,
  GuestOrderGrantPurpose,
  GuestOrderScope,
} from '@mercaria/shared-types';
import { guestOrderAccessGrants } from '../schema/guestPortal.js';
import type { DatabaseOrTransaction } from '../postgres.js';

/** A `guest_order_access_grants` row as the backend reads it. */
export type GuestOrderAccessGrantRow = typeof guestOrderAccessGrants.$inferSelect;

/** What a mint writes. Every field is decided server-side. */
export interface InsertGuestOrderAccessGrantInput {
  checkoutGroupId: string;
  guestCheckoutId: string;
  /** Hex SHA-256 of the token. Never the plaintext. */
  tokenHash: string;
  purpose: GuestOrderGrantPurpose;
  createdVia: GuestOrderGrantOrigin;
  /** Present exactly on `exchange` rows — a CHECK states the biconditional. */
  exchangeReason?: GuestOrderExchangeReason;
  scopes: readonly GuestOrderScope[];
  /** The instant a consumed magic link proved the inbox; absent otherwise. */
  emailVerifiedAt?: Date;
  expiresAt: Date;
  /** When the retention sweep may delete the row — see the schema docblock. */
  purgeAt: Date;
}

/**
 * The liveness predicate every resolution shares: unconsumed, unrevoked and
 * not past its expiry, judged against a caller-supplied instant.
 *
 * The clock is a parameter rather than `now()` so a test can drive expiry
 * without waiting and so one request judges every grant it touches against ONE
 * instant — two statements a millisecond apart disagreeing about a deadline is
 * the kind of flake nobody reproduces.
 */
function liveGrantPredicate(now: Date): SQL {
  const live = and(
    isNull(guestOrderAccessGrants.consumedAt),
    isNull(guestOrderAccessGrants.revokedAt),
    gt(guestOrderAccessGrants.expiresAt, now),
  );
  if (live === undefined) {
    // Unreachable: `and` returns undefined only when handed no defined
    // conditions. Named rather than non-null-asserted, because a silent
    // `undefined` here would widen every read to the whole table.
    throw new Error('guest_order_access_grants liveness predicate built empty');
  }
  return live;
}

/**
 * Every column of a grant, named once.
 *
 * `token_hash` is registered in `db/protectedColumns.ts`, so a bare
 * `db.select()` on this table is a build failure — correctly, because the row
 * carries an offline oracle. The RESOLVER legitimately needs it (it re-makes
 * the accept decision with `verifySecret`), and naming the columns is how that
 * need is declared. `listGrantsForGroup` below deliberately does NOT use this
 * list: an operator trace has no business holding the digest.
 */
const GRANT_COLUMNS = {
  id: guestOrderAccessGrants.id,
  checkoutGroupId: guestOrderAccessGrants.checkoutGroupId,
  guestCheckoutId: guestOrderAccessGrants.guestCheckoutId,
  tokenHash: guestOrderAccessGrants.tokenHash,
  purpose: guestOrderAccessGrants.purpose,
  createdVia: guestOrderAccessGrants.createdVia,
  exchangeReason: guestOrderAccessGrants.exchangeReason,
  scopes: guestOrderAccessGrants.scopes,
  emailVerifiedAt: guestOrderAccessGrants.emailVerifiedAt,
  expiresAt: guestOrderAccessGrants.expiresAt,
  consumedAt: guestOrderAccessGrants.consumedAt,
  revokedAt: guestOrderAccessGrants.revokedAt,
  lastUsedAt: guestOrderAccessGrants.lastUsedAt,
  purgeAt: guestOrderAccessGrants.purgeAt,
  createdAt: guestOrderAccessGrants.createdAt,
  updatedAt: guestOrderAccessGrants.updatedAt,
} as const;

/** Mint a grant. The caller has already decided its scopes and deadlines. */
export async function insertGuestOrderAccessGrant(
  db: DatabaseOrTransaction,
  input: InsertGuestOrderAccessGrantInput,
): Promise<GuestOrderAccessGrantRow> {
  const [row] = await db
    .insert(guestOrderAccessGrants)
    .values({
      checkoutGroupId: input.checkoutGroupId,
      guestCheckoutId: input.guestCheckoutId,
      tokenHash: input.tokenHash,
      purpose: input.purpose,
      createdVia: input.createdVia,
      exchangeReason: input.exchangeReason ?? null,
      scopes: [...input.scopes],
      emailVerifiedAt: input.emailVerifiedAt ?? null,
      expiresAt: input.expiresAt,
      purgeAt: input.purgeAt,
    })
    .returning();
  if (!row) {
    throw new Error('guest_order_access_grants insert returned no row');
  }
  return row;
}

/**
 * The LIVE grant a presented digest names, or `null`.
 *
 * Narrows on the unique hash index and on liveness together, so an expired or
 * revoked credential is indistinguishable from an unknown one at this layer —
 * which is what makes the uniform rejection above it easy to keep uniform.
 */
export async function findLiveGrantByTokenHash(
  db: DatabaseOrTransaction,
  tokenHash: string,
  purpose: GuestOrderGrantPurpose,
  now: Date,
): Promise<GuestOrderAccessGrantRow | null> {
  const [row] = await db
    // Every column NAMED, `token_hash` included, and that naming is the
    // greppable opt-in `db/protectedColumns.ts` describes rather than an
    // oversight: the resolver re-makes the accept decision with `verifySecret`
    // against the stored digest, so it genuinely needs the column — while a
    // `.select()` here would ship an offline oracle to whoever added a route
    // that returned the row. `findImplicitWholeRowReads` fails the build on the
    // shorter spelling, which is what makes the distinction enforceable.
    .select(GRANT_COLUMNS)
    .from(guestOrderAccessGrants)
    .where(
      and(
        eq(guestOrderAccessGrants.tokenHash, tokenHash),
        eq(guestOrderAccessGrants.purpose, purpose),
        liveGrantPredicate(now),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Whether the grant with this ID is STILL live, at this instant.
 *
 * The claim transaction's revalidation (#109 claim-transaction rule 1). The
 * middleware resolved the credential when the request arrived; between then and
 * the commit a buyer on another device can press "secure my access", and a
 * claim that went through anyway would be one authorized by a credential its
 * owner had just revoked.
 *
 * Selects the ID alone, deliberately: the caller already holds the resolved row
 * and needs a yes or no, and re-reading `token_hash` into a second place is how
 * a digest ends up somewhere it was never needed. Returns a boolean rather than
 * a row so there is nothing to accidentally serialize.
 */
export async function grantIsStillLive(
  db: DatabaseOrTransaction,
  grantId: string,
  now: Date,
): Promise<boolean> {
  const [row] = await db
    .select({ id: guestOrderAccessGrants.id })
    .from(guestOrderAccessGrants)
    .where(and(eq(guestOrderAccessGrants.id, grantId), liveGrantPredicate(now)))
    .limit(1);
  return row !== undefined;
}

/**
 * Consume an exchange grant atomically — the whole of "single use".
 *
 * `UPDATE … SET consumed_at = $now WHERE token_hash = $hash AND purpose =
 * 'exchange' AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at >
 * $now RETURNING *`. The empty-vs-one-row result IS the already-used answer —
 * the moderation dedupe-claim pattern — so a real failure (a dropped
 * connection, a CHECK violation) still propagates instead of being read as a
 * duplicate.
 *
 * Two concurrent exchanges of one link therefore mint exactly one portal
 * credential, without a lock, a lease or a read-then-write for a racer to walk
 * past. That is also why a link scanner cannot burn a grant invisibly: consuming
 * requires this statement, and the token never leaves the URL fragment, which no
 * scanner sends to a server.
 */
export async function consumeExchangeGrant(
  db: DatabaseOrTransaction,
  tokenHash: string,
  now: Date,
): Promise<GuestOrderAccessGrantRow | null> {
  const [row] = await db
    .update(guestOrderAccessGrants)
    .set({ consumedAt: now })
    .where(
      and(
        eq(guestOrderAccessGrants.tokenHash, tokenHash),
        eq(guestOrderAccessGrants.purpose, 'exchange'),
        liveGrantPredicate(now),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Record that a credential authorized a request, at a coarse granularity.
 *
 * Conditional in SQL (`WHERE last_used_at IS NULL OR last_used_at < now -
 * granularity`), the `touchGuestSessionLastSeen` shape: a portal open fires
 * several requests and each one writing a row is write amplification for an
 * audit field nobody reads at that resolution.
 *
 * This does NOT slide the expiry, and the absence is the point — a portal
 * credential's deadline is absolute, so a stolen one cannot be kept alive by
 * being used.
 */
export async function touchGrantLastUsed(
  db: DatabaseOrTransaction,
  id: string,
  now: Date,
  granularityMs: number,
): Promise<void> {
  const threshold = new Date(now.getTime() - granularityMs);
  await db
    .update(guestOrderAccessGrants)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(guestOrderAccessGrants.id, id),
        sql`(${guestOrderAccessGrants.lastUsedAt} is null
             or ${guestOrderAccessGrants.lastUsedAt} < ${threshold})`,
      ),
    );
}

/** Revoke one grant by row id. Idempotent — a second call reports `false`. */
export async function revokeGrant(
  db: DatabaseOrTransaction,
  id: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(guestOrderAccessGrants)
    .set({ revokedAt: now })
    .where(and(eq(guestOrderAccessGrants.id, id), isNull(guestOrderAccessGrants.revokedAt)))
    .returning({ id: guestOrderAccessGrants.id });
  return rows.length > 0;
}

/**
 * Revoke every live grant for a checkout group, optionally sparing one.
 *
 * The "secure my access" primitive (ADR 0003 diagram 10) and the revocation a
 * claim performs (D14). `exceptGrantId` is what lets the person who just
 * pressed the button keep the session they pressed it from — without it,
 * securing your access logs you out, which is how a feature stops being used.
 *
 * Returns the ids it revoked so the caller can audit the blast radius rather
 * than a count: an operator reading "revoked 4" cannot tell whether the right
 * four went.
 */
export async function revokeGroupGrants(
  db: DatabaseOrTransaction,
  checkoutGroupId: string,
  now: Date,
  options: { exceptGrantId?: string; purpose?: GuestOrderGrantPurpose } = {},
): Promise<string[]> {
  const conditions: SQL[] = [
    eq(guestOrderAccessGrants.checkoutGroupId, checkoutGroupId),
    isNull(guestOrderAccessGrants.revokedAt),
    isNull(guestOrderAccessGrants.consumedAt),
    gt(guestOrderAccessGrants.expiresAt, now),
  ];
  if (options.exceptGrantId !== undefined) {
    conditions.push(sql`${guestOrderAccessGrants.id} <> ${options.exceptGrantId}`);
  }
  if (options.purpose !== undefined) {
    conditions.push(eq(guestOrderAccessGrants.purpose, options.purpose));
  }
  const rows = await db
    .update(guestOrderAccessGrants)
    .set({ revokedAt: now })
    .where(and(...conditions))
    .returning({ id: guestOrderAccessGrants.id });
  return rows.map((row) => row.id);
}

/**
 * Every grant a checkout group has ever had, newest first — the operator trace.
 *
 * Names every column it needs and deliberately omits `token_hash`, which is
 * registered in `db/protectedColumns.ts`: a whole-row select here would put an
 * offline oracle in an operator response, and the trace DTO has no field for it
 * anyway, so this select list and that type agree by construction.
 */
export async function listGrantsForGroup(
  db: DatabaseOrTransaction,
  checkoutGroupId: string,
  limit: number,
): Promise<
  Pick<
    GuestOrderAccessGrantRow,
    | 'id'
    | 'purpose'
    | 'createdVia'
    | 'exchangeReason'
    | 'scopes'
    | 'emailVerifiedAt'
    | 'createdAt'
    | 'expiresAt'
    | 'consumedAt'
    | 'revokedAt'
    | 'lastUsedAt'
  >[]
> {
  return await db
    .select({
      id: guestOrderAccessGrants.id,
      purpose: guestOrderAccessGrants.purpose,
      createdVia: guestOrderAccessGrants.createdVia,
      exchangeReason: guestOrderAccessGrants.exchangeReason,
      scopes: guestOrderAccessGrants.scopes,
      emailVerifiedAt: guestOrderAccessGrants.emailVerifiedAt,
      createdAt: guestOrderAccessGrants.createdAt,
      expiresAt: guestOrderAccessGrants.expiresAt,
      consumedAt: guestOrderAccessGrants.consumedAt,
      revokedAt: guestOrderAccessGrants.revokedAt,
      lastUsedAt: guestOrderAccessGrants.lastUsedAt,
    })
    .from(guestOrderAccessGrants)
    .where(eq(guestOrderAccessGrants.checkoutGroupId, checkoutGroupId))
    .orderBy(sql`${guestOrderAccessGrants.createdAt} desc`)
    .limit(limit);
}

/**
 * How many live `post_checkout` grants a group already has.
 *
 * The confirmation mint is bounded by this rather than by a unique index,
 * deliberately: a buyer may legitimately want the confirmation on their phone
 * and their laptop, so "exactly one" would be wrong, and an unbounded mint from
 * one cart credential would be a credential factory. A small cap is the honest
 * middle, and the count is a read the mint takes inside its own transaction.
 */
export async function countLivePostCheckoutGrants(
  db: DatabaseOrTransaction,
  checkoutGroupId: string,
  now: Date,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(guestOrderAccessGrants)
    .where(
      and(
        eq(guestOrderAccessGrants.checkoutGroupId, checkoutGroupId),
        eq(guestOrderAccessGrants.createdVia, 'post_checkout'),
        liveGrantPredicate(now),
      ),
    );
  return row?.total ?? 0;
}

/**
 * Grants whose retention deadline has passed — exported for the realdb test
 * that proves the sweep's predicate matches the column the registry names.
 *
 * The shared expiry sweep does the deleting; this exists so a test can assert
 * WHICH rows it will take without reaching into `@oxyhq/db`'s internals.
 */
export async function countGrantsDueForPurge(
  db: DatabaseOrTransaction,
  now: Date,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(guestOrderAccessGrants)
    .where(lt(guestOrderAccessGrants.purgeAt, now));
  return row?.total ?? 0;
}
