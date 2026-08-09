/**
 * Reads and writes for the five merchant-claim tables (#83).
 *
 * `db` is the first parameter everywhere, for the reason `paymentRepository.ts`
 * gives: a helper typed only as `Database` would silently run outside its
 * caller's transaction — and several of the writes below are only correct
 * INSIDE one (issuing a challenge closes the previous one; verifying a claim
 * writes the claim, its scopes and its audit event together).
 *
 * ## Three writes are conditional UPDATEs on purpose
 *
 * `transitionClaimState`, `consumeChallenge` and `expireClaimIfDue` are each
 * ONE statement with their guard in the `WHERE`, per CONVENTIONS.md's first
 * concurrency shape: the row is locked for the statement, so a loser's
 * predicate is re-checked against the winner's write. A read-then-write is a
 * different function with the same signature and a lost-update bug — and here
 * the lost update is two verifications of one challenge.
 */

import { and, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import type { SelectedRow } from '@oxyhq/db';
import type {
  MerchantClaimActorKind,
  MerchantClaimChallengeCloseReason,
  MerchantClaimChallengeSubjectKind,
  MerchantClaimEventAction,
  MerchantClaimEvidenceKind,
  MerchantClaimMethod,
  MerchantClaimRevokeReason,
  MerchantClaimScopeKind,
  MerchantClaimScopeState,
  MerchantClaimState,
} from '@mercaria/shared-types';
import { MERCHANT_CLAIM_ACTIVE_STATES } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import {
  merchantClaimChallenges,
  merchantClaimEvents,
  merchantClaimEvidence,
  merchantClaimScopes,
  merchantClaims,
} from '../schema/merchantClaims.js';

/** A claim row as the services read it back. */
export type MerchantClaimRow = typeof merchantClaims.$inferSelect;
/** A scope row. */
export type MerchantClaimScopeRow = typeof merchantClaimScopes.$inferSelect;
/** An audit-timeline row. */
export type MerchantClaimEventRow = typeof merchantClaimEvents.$inferSelect;

/** Every challenge column EXCEPT the token digest, which is protected. */
const PUBLIC_CHALLENGE_COLUMNS = publicColumns(merchantClaimChallenges, PROTECTED_COLUMNS);

/**
 * A challenge row WITHOUT its token digest. The type has no such property, so
 * a serializer that reaches for it fails `tsc` rather than shipping it.
 */
export type MerchantClaimChallengeRow = SelectedRow<typeof PUBLIC_CHALLENGE_COLUMNS>;

/** Every evidence column EXCEPT the private ones (file id, url, note). */
const PUBLIC_EVIDENCE_COLUMNS = publicColumns(merchantClaimEvidence, PROTECTED_COLUMNS);

/** An evidence row with its private columns withheld. */
export type MerchantClaimEvidenceRow = SelectedRow<typeof PUBLIC_EVIDENCE_COLUMNS>;

/**
 * An evidence row WITH its private columns — the greppable opt-in.
 *
 * There is deliberately no helper for this and it reads differently from an
 * ordinary select, exactly as `protectedColumns.ts` requires. Its ONE caller
 * is the operator review read, which writes an `evidence_accessed` audit row
 * before it returns.
 */
export interface MerchantClaimPrivateEvidenceRow extends MerchantClaimEvidenceRow {
  oxyFileId: string | null;
  url: string | null;
  note: string | null;
}

// ── Claims ──────────────────────────────────────────────────────────────────

export interface InsertMerchantClaimInput {
  merchantId: string;
  claimantOxyUserId: string;
  method: MerchantClaimMethod;
  /** The proof subject, absent only for `business_document`. */
  subject?: { kind: MerchantClaimChallengeSubjectKind; ref: string };
  nativeStoreId?: string;
  /**
   * The attempt's deadline, or `null` for a claim that is waiting on a person
   * rather than on the claimant — a contest, which must not resolve itself in
   * the incumbent's favour by timing out.
   */
  expiresAt: Date | null;
  state?: MerchantClaimState;
  conflictingClaimId?: string;
}

/**
 * Open a claim.
 *
 * Returns `undefined` when the caller already has a LIVE claim on this
 * merchant — the partial unique on the active states refuses it, and
 * `onConflictDoNothing` turns that into an answer the service can convert into
 * "you already have one" rather than a 500.
 */
export async function insertMerchantClaim(
  db: DatabaseOrTransaction,
  input: InsertMerchantClaimInput,
): Promise<MerchantClaimRow | undefined> {
  const [row] = await db
    .insert(merchantClaims)
    .values({
      merchantId: input.merchantId,
      claimantOxyUserId: input.claimantOxyUserId,
      method: input.method,
      subjectKind: input.subject?.kind ?? null,
      subjectRef: input.subject?.ref ?? null,
      nativeStoreId: input.nativeStoreId ?? null,
      state: input.state ?? 'draft',
      expiresAt: input.expiresAt,
      conflictingClaimId: input.conflictingClaimId ?? null,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

export async function findClaimById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<MerchantClaimRow | undefined> {
  const [row] = await db.select().from(merchantClaims).where(eq(merchantClaims.id, id));
  return row;
}

/** The merchant's current verified claim, if it has one. */
export async function findVerifiedClaimForMerchant(
  db: DatabaseOrTransaction,
  merchantId: string,
): Promise<MerchantClaimRow | undefined> {
  const [row] = await db
    .select()
    .from(merchantClaims)
    .where(and(eq(merchantClaims.merchantId, merchantId), eq(merchantClaims.state, 'verified')));
  return row;
}

/** Every LIVE claim on a merchant — the eligibility read's second question. */
export async function findActiveClaimsForMerchant(
  db: DatabaseOrTransaction,
  merchantId: string,
): Promise<MerchantClaimRow[]> {
  return db
    .select()
    .from(merchantClaims)
    .where(
      and(
        eq(merchantClaims.merchantId, merchantId),
        inArray(merchantClaims.state, [...MERCHANT_CLAIM_ACTIVE_STATES]),
      ),
    );
}

/** One claimant's claims, newest first. */
export async function findClaimsByClaimant(
  db: DatabaseOrTransaction,
  claimantOxyUserId: string,
  limit: number,
): Promise<MerchantClaimRow[]> {
  return db
    .select()
    .from(merchantClaims)
    .where(eq(merchantClaims.claimantOxyUserId, claimantOxyUserId))
    .orderBy(desc(merchantClaims.createdAt))
    .limit(limit);
}

/** The operator review queue, oldest first — the order a queue is worked in. */
export async function findClaimsByState(
  db: DatabaseOrTransaction,
  states: readonly MerchantClaimState[],
  limit: number,
): Promise<MerchantClaimRow[]> {
  return db
    .select()
    .from(merchantClaims)
    .where(inArray(merchantClaims.state, [...states]))
    .orderBy(merchantClaims.createdAt)
    .limit(limit);
}

/** The columns a transition may write. Explicit, never a spread of a request. */
export interface ClaimTransitionPatch {
  expiresAt?: Date | null;
  revalidateAfter?: Date | null;
  reviewedByOxyUserId?: string;
  reviewedAt?: Date;
  decisionReason?: string;
  verifiedAt?: Date;
  revokedAt?: Date;
  revokedByOxyUserId?: string;
  revokeReason?: MerchantClaimRevokeReason;
  conflictingClaimId?: string;
}

/**
 * Move a claim from an EXPECTED state to a new one — the compare-and-swap that
 * makes every transition in this domain race-safe.
 *
 * `expected` is a SET rather than one value because several legitimate
 * transitions have more than one origin (an operator may verify from
 * `review_pending` or from `disputed`), and enumerating them at the call site
 * keeps the state machine's shape in the service where it can be read whole.
 *
 * Returns `undefined` when the row was not in one of those states — the loser
 * of a race, or a client acting on a stale view.
 */
export async function transitionClaimState(
  db: DatabaseOrTransaction,
  params: {
    claimId: string;
    expected: readonly MerchantClaimState[];
    next: MerchantClaimState;
    patch?: ClaimTransitionPatch;
  },
): Promise<MerchantClaimRow | undefined> {
  const [row] = await db
    .update(merchantClaims)
    .set({ state: params.next, ...(params.patch ?? {}) })
    .where(
      and(
        eq(merchantClaims.id, params.claimId),
        inArray(merchantClaims.state, [...params.expected]),
      ),
    )
    .returning();
  return row;
}

/**
 * Expire a claim whose deadline has passed — the lazy sweep, run on the read
 * path (`guest_sessions`' idle-expiry rule: the deadline is enforced where it
 * is observed, so nothing can disagree with it).
 *
 * `expires_at` is cleared as part of the transition, so a second read cannot
 * re-expire an already-expired claim and write a second audit row.
 */
export async function expireClaimIfDue(
  db: DatabaseOrTransaction,
  claimId: string,
  now: Date,
): Promise<MerchantClaimRow | undefined> {
  const [row] = await db
    .update(merchantClaims)
    .set({ state: 'expired', expiresAt: null })
    .where(
      and(
        eq(merchantClaims.id, claimId),
        inArray(merchantClaims.state, ['draft', 'challenge_pending']),
        // `lte`, not an interpolated `sql` template: drizzle knows this
        // column's type and encodes the Date, while a comparison written as a
        // raw expression hands postgres.js a Date it refuses outright
        // (`ERR_INVALID_ARG_TYPE`) — CONVENTIONS.md, "A Date is not a safe
        // parameter against an EXPRESSION".
        isNotNull(merchantClaims.expiresAt),
        lte(merchantClaims.expiresAt, now),
      ),
    )
    .returning();
  return row;
}

/** How many challenges a claimant has been issued in a window — the user budget. */
export async function countChallengesForClaimantSince(
  db: DatabaseOrTransaction,
  claimantOxyUserId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(merchantClaimChallenges)
    .innerJoin(merchantClaims, eq(merchantClaimChallenges.claimId, merchantClaims.id))
    .where(
      and(
        eq(merchantClaims.claimantOxyUserId, claimantOxyUserId),
        gte(merchantClaimChallenges.createdAt, since),
      ),
    );
  return row?.total ?? 0;
}

/** How many challenges a MERCHANT has attracted in a window, across claimants. */
export async function countChallengesForMerchantSince(
  db: DatabaseOrTransaction,
  merchantId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(merchantClaimChallenges)
    .innerJoin(merchantClaims, eq(merchantClaimChallenges.claimId, merchantClaims.id))
    .where(
      and(
        eq(merchantClaims.merchantId, merchantId),
        gte(merchantClaimChallenges.createdAt, since),
      ),
    );
  return row?.total ?? 0;
}

/**
 * How many challenges one SUBJECT has attracted in a window — the domain
 * budget, counted across every claimant and every merchant.
 *
 * The subject lives on the claim, so this joins rather than reading a copy off
 * the challenge; the copy is exactly what the schema declines to keep.
 */
export async function countChallengesForSubjectSince(
  db: DatabaseOrTransaction,
  subject: { kind: MerchantClaimChallengeSubjectKind; ref: string },
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(merchantClaimChallenges)
    .innerJoin(merchantClaims, eq(merchantClaimChallenges.claimId, merchantClaims.id))
    .where(
      and(
        eq(merchantClaims.subjectKind, subject.kind),
        eq(merchantClaims.subjectRef, subject.ref),
        gte(merchantClaimChallenges.createdAt, since),
      ),
    );
  return row?.total ?? 0;
}

// ── Scopes ──────────────────────────────────────────────────────────────────

/**
 * Record the requested scope. Converges on `(claim, kind, ref)` so re-running
 * the open path is a no-op rather than a duplicate-key 500.
 */
export async function insertRequestedScopes(
  db: DatabaseOrTransaction,
  claimId: string,
  entries: readonly { kind: MerchantClaimScopeKind; ref: string }[],
): Promise<void> {
  if (entries.length === 0) return;
  await db
    .insert(merchantClaimScopes)
    .values(
      entries.map((entry) => ({
        claimId,
        scopeKind: entry.kind,
        scopeRef: entry.ref,
        state: 'requested' as MerchantClaimScopeState,
      })),
    )
    .onConflictDoNothing({
      target: [
        merchantClaimScopes.claimId,
        merchantClaimScopes.scopeKind,
        merchantClaimScopes.scopeRef,
      ],
    });
}

export async function findScopesForClaim(
  db: DatabaseOrTransaction,
  claimId: string,
): Promise<MerchantClaimScopeRow[]> {
  return db.select().from(merchantClaimScopes).where(eq(merchantClaimScopes.claimId, claimId));
}

/**
 * Stamp one scope entry's verdict.
 *
 * `verified_at` travels with the state because the CHECK ties them together —
 * a verified scope nobody can date is not auditable, and the constraint makes
 * that unrepresentable rather than a convention.
 */
export async function setScopeState(
  db: DatabaseOrTransaction,
  params: {
    claimId: string;
    kind: MerchantClaimScopeKind;
    ref: string;
    state: MerchantClaimScopeState;
    verifiedAt: Date | null;
  },
): Promise<void> {
  await db
    .update(merchantClaimScopes)
    .set({ state: params.state, verifiedAt: params.verifiedAt })
    .where(
      and(
        eq(merchantClaimScopes.claimId, params.claimId),
        eq(merchantClaimScopes.scopeKind, params.kind),
        eq(merchantClaimScopes.scopeRef, params.ref),
      ),
    );
}

// ── Challenges ──────────────────────────────────────────────────────────────

export interface InsertChallengeInput {
  claimId: string;
  tokenHash: string;
  expiresAt: Date;
}

/**
 * Open a challenge. Returns `undefined` when one is already open for the claim
 * — the partial unique refuses it, which is the caller's cue to close the
 * previous one first (in the SAME transaction, or the claim can end up with
 * none at all).
 */
export async function insertChallenge(
  db: DatabaseOrTransaction,
  input: InsertChallengeInput,
): Promise<MerchantClaimChallengeRow | undefined> {
  const [row] = await db
    .insert(merchantClaimChallenges)
    .values({
      claimId: input.claimId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing()
    .returning(PUBLIC_CHALLENGE_COLUMNS);
  return row;
}

/** The claim's open challenge, without its digest. */
export async function findOpenChallenge(
  db: DatabaseOrTransaction,
  claimId: string,
): Promise<MerchantClaimChallengeRow | undefined> {
  const [row] = await db
    .select(PUBLIC_CHALLENGE_COLUMNS)
    .from(merchantClaimChallenges)
    .where(
      and(
        eq(merchantClaimChallenges.claimId, claimId),
        isNull(merchantClaimChallenges.closedAt),
      ),
    );
  return row;
}

/**
 * The open challenge WITH its digest — the one greppable opt-in, named column
 * by column so it reads differently from an ordinary select.
 *
 * Every token-carried method reaches it, because the server keeps only the
 * digest and therefore cannot reproduce the value it must look for in a zone
 * file or a web page: the claimant presents the token they were given, the
 * accept decision is a constant-time compare against this digest, and only
 * then does the verifier go looking for that exact value at the claim's own
 * subject.
 *
 * For the site methods that presentation adds no secrecy — a token published
 * in DNS is public the moment the claimant acts on it — and it is not there
 * for secrecy. It is there so the server never stores a live credential it
 * could be made to disclose, which is what lets `role_email` (whose token IS
 * secret) travel the identical path instead of a special one.
 */
export async function findOpenChallengeDigest(
  db: DatabaseOrTransaction,
  claimId: string,
): Promise<{ id: string; tokenHash: string; expiresAt: Date } | undefined> {
  const [row] = await db
    .select({
      id: merchantClaimChallenges.id,
      tokenHash: merchantClaimChallenges.tokenHash,
      expiresAt: merchantClaimChallenges.expiresAt,
    })
    .from(merchantClaimChallenges)
    .where(
      and(
        eq(merchantClaimChallenges.claimId, claimId),
        isNull(merchantClaimChallenges.closedAt),
      ),
    );
  return row;
}

/**
 * Record one verification ATTEMPT and return the new count.
 *
 * A single statement so two concurrent attempts cannot both read the same
 * count and both pass the ceiling — the increment reads the EXISTING row, not
 * a proposed one, which is CONVENTIONS.md's third concurrency shape.
 */
export async function recordChallengeAttempt(
  db: DatabaseOrTransaction,
  challengeId: string,
  at: Date,
): Promise<number> {
  const [row] = await db
    .update(merchantClaimChallenges)
    .set({
      attemptCount: sql`${merchantClaimChallenges.attemptCount} + 1`,
      lastAttemptAt: at,
    })
    .where(eq(merchantClaimChallenges.id, challengeId))
    .returning({ attemptCount: merchantClaimChallenges.attemptCount });
  return row?.attemptCount ?? 0;
}

/**
 * Consume a challenge — the single-use compare-and-swap.
 *
 * The guard is `closed_at IS NULL`, so exactly one of two concurrent successes
 * wins and the loser gets `undefined`. Expiry is part of the same predicate
 * when the caller asks for it, which is what makes "an expired challenge
 * cannot verify anything" a property of the statement rather than of a check
 * somebody remembered to run first.
 */
export async function consumeChallenge(
  db: DatabaseOrTransaction,
  params: {
    challengeId: string;
    reason: MerchantClaimChallengeCloseReason;
    at: Date;
    /** When set, the swap also requires the challenge not to have expired. */
    requireUnexpiredAt?: Date;
  },
): Promise<MerchantClaimChallengeRow | undefined> {
  const guards = [
    eq(merchantClaimChallenges.id, params.challengeId),
    isNull(merchantClaimChallenges.closedAt),
  ];
  if (params.requireUnexpiredAt !== undefined) {
    // `gt` for the same reason `expireClaimIfDue` uses `lte`: a Date bound
    // against a raw expression is refused by the driver at query time.
    guards.push(gt(merchantClaimChallenges.expiresAt, params.requireUnexpiredAt));
  }
  const [row] = await db
    .update(merchantClaimChallenges)
    .set({ closedAt: params.at, closedReason: params.reason })
    .where(and(...guards))
    .returning(PUBLIC_CHALLENGE_COLUMNS);
  return row;
}

// ── Evidence ────────────────────────────────────────────────────────────────

export interface InsertEvidenceInput {
  claimId: string;
  kind: MerchantClaimEvidenceKind;
  oxyFileId?: string;
  sha256?: string;
  note?: string;
  url?: string;
  collectedByOxyUserId?: string;
  collectedAt: Date;
}

export async function insertEvidence(
  db: DatabaseOrTransaction,
  input: InsertEvidenceInput,
): Promise<MerchantClaimEvidenceRow> {
  const [row] = await db
    .insert(merchantClaimEvidence)
    .values({
      claimId: input.claimId,
      kind: input.kind,
      oxyFileId: input.oxyFileId ?? null,
      sha256: input.sha256 ?? null,
      note: input.note ?? null,
      url: input.url ?? null,
      collectedByOxyUserId: input.collectedByOxyUserId ?? null,
      collectedAt: input.collectedAt,
    })
    .returning(PUBLIC_EVIDENCE_COLUMNS);
  if (!row) {
    throw new Error('Inserting merchant claim evidence returned no row.');
  }
  return row;
}

/**
 * The private evidence, columns named ONE BY ONE.
 *
 * This is the deliberate, greppable opt-in `protectedColumns.ts` describes: it
 * does not read like an ordinary select, and its only caller writes an
 * `evidence_accessed` audit row in the same transaction.
 */
export async function findPrivateEvidenceForClaim(
  db: DatabaseOrTransaction,
  claimId: string,
): Promise<MerchantClaimPrivateEvidenceRow[]> {
  return db
    .select({
      id: merchantClaimEvidence.id,
      claimId: merchantClaimEvidence.claimId,
      kind: merchantClaimEvidence.kind,
      sha256: merchantClaimEvidence.sha256,
      collectedByOxyUserId: merchantClaimEvidence.collectedByOxyUserId,
      collectedAt: merchantClaimEvidence.collectedAt,
      oxyFileId: merchantClaimEvidence.oxyFileId,
      url: merchantClaimEvidence.url,
      note: merchantClaimEvidence.note,
    })
    .from(merchantClaimEvidence)
    .where(eq(merchantClaimEvidence.claimId, claimId));
}

// ── Events ──────────────────────────────────────────────────────────────────

export interface InsertClaimEventInput {
  claimId: string;
  action: MerchantClaimEventAction;
  actorKind: MerchantClaimActorKind;
  actorOxyUserId?: string;
  fromState?: MerchantClaimState;
  toState?: MerchantClaimState;
  reason?: string;
  at: Date;
}

/** Append one audit row. Never updated, never deleted — the row IS the record. */
export async function insertClaimEvent(
  db: DatabaseOrTransaction,
  input: InsertClaimEventInput,
): Promise<MerchantClaimEventRow> {
  const [row] = await db
    .insert(merchantClaimEvents)
    .values({
      claimId: input.claimId,
      action: input.action,
      actorKind: input.actorKind,
      actorOxyUserId: input.actorOxyUserId ?? null,
      fromState: input.fromState ?? null,
      toState: input.toState ?? null,
      reason: input.reason ?? null,
      at: input.at,
    })
    .returning();
  if (!row) {
    throw new Error('Inserting a merchant claim event returned no row.');
  }
  return row;
}

export async function findEventsForClaim(
  db: DatabaseOrTransaction,
  claimId: string,
): Promise<MerchantClaimEventRow[]> {
  return db
    .select()
    .from(merchantClaimEvents)
    .where(eq(merchantClaimEvents.claimId, claimId))
    .orderBy(merchantClaimEvents.at);
}
