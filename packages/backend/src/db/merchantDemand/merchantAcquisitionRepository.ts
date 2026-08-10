/**
 * The operator acquisition pipeline's four tables (#86 §"Operator acquisition
 * pipeline").
 *
 * ## Every write here is an UPSERT on the merchant, and none of them deletes
 *
 * A candidate row is a merchant's standing in one pipeline, so `ON CONFLICT
 * (merchant_id) DO UPDATE` is what makes re-scoring, re-assigning and
 * re-excluding converge rather than accumulate. Nothing in this file issues a
 * DELETE: excluding a merchant is a STATE, and deleting the row would lose the
 * `do_not_contact` flag that is the whole point of recording the exclusion.
 *
 * ## The audit is written by the SERVICE, on every attempt
 *
 * `recordAcquisitionAudit` takes an outcome of `granted | refused` and is called
 * from both branches — `payment_repairs`' posture, for the reason a surface
 * whose audit records only what succeeded cannot answer who tried.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  MerchantAcquisitionAction,
  MerchantAcquisitionContactSourceKind,
  MerchantAcquisitionExclusionReason,
  MerchantAcquisitionOutreachChannel,
  MerchantAcquisitionOutreachOutcome,
  MerchantAcquisitionScoreInput,
  MerchantAcquisitionState,
} from '@mercaria/shared-types';
import { MERCHANT_ACQUISITION_OPEN_STATES } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  merchantAcquisitionAudits,
  merchantAcquisitionCandidates,
  merchantAcquisitionContactSources,
  merchantAcquisitionOutreach,
  type MerchantAcquisitionAuditRow,
  type MerchantAcquisitionCandidateRow,
  type MerchantAcquisitionContactSourceRow,
  type MerchantAcquisitionOutreachRow,
} from '../schema/merchantDemand.js';
import { merchants } from '../schema/merchants.js';

/** A candidate row plus the merchant name an operator list needs. */
export interface AcquisitionCandidateWithMerchant {
  readonly candidate: MerchantAcquisitionCandidateRow;
  readonly merchantName: string;
  readonly claimState: string;
  readonly claimedByOxyUserId: string | null;
}

/** Create the candidate row for a merchant if it has none. Idempotent. */
export async function ensureAcquisitionCandidate(
  merchantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantAcquisitionCandidateRow> {
  await db
    .insert(merchantAcquisitionCandidates)
    .values({ merchantId, state: 'identified', scoreVersion: 'unscored' })
    .onConflictDoNothing({ target: merchantAcquisitionCandidates.merchantId });

  const rows = await db
    .select()
    .from(merchantAcquisitionCandidates)
    .where(eq(merchantAcquisitionCandidates.merchantId, merchantId))
    .limit(1);
  // `ON CONFLICT DO NOTHING` writes nothing on a repeat — no tuple version, no
  // timestamp — so the read below is the answer in both branches and a repeat
  // is a genuine no-op rather than a quiet write.
  return rows[0];
}

/** One candidate with its merchant, or `undefined`. */
export async function findAcquisitionCandidate(
  merchantId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AcquisitionCandidateWithMerchant | undefined> {
  const rows = await db
    .select({
      candidate: merchantAcquisitionCandidates,
      merchantName: merchants.name,
      claimState: merchants.claimState,
      claimedByOxyUserId: merchants.claimedByOxyUserId,
    })
    .from(merchantAcquisitionCandidates)
    .innerJoin(merchants, eq(merchants.id, merchantAcquisitionCandidates.merchantId))
    .where(eq(merchantAcquisitionCandidates.merchantId, merchantId))
    .limit(1);
  return rows[0];
}

/**
 * One page of the pipeline, highest score first.
 *
 * `states` narrows to a stage; omitting it lists every state including
 * `excluded`, because "which merchants did we decide not to approach and why"
 * is a question the surface has to be able to answer.
 */
export async function listAcquisitionCandidates(
  input: {
    readonly states?: readonly MerchantAcquisitionState[];
    readonly assignedToOxyUserId?: string;
    readonly limit: number;
    readonly offset: number;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly AcquisitionCandidateWithMerchant[]> {
  const states = input.states ?? [...MERCHANT_ACQUISITION_OPEN_STATES];
  return db
    .select({
      candidate: merchantAcquisitionCandidates,
      merchantName: merchants.name,
      claimState: merchants.claimState,
      claimedByOxyUserId: merchants.claimedByOxyUserId,
    })
    .from(merchantAcquisitionCandidates)
    .innerJoin(merchants, eq(merchants.id, merchantAcquisitionCandidates.merchantId))
    .where(
      and(
        inArray(merchantAcquisitionCandidates.state, [...states]),
        input.assignedToOxyUserId === undefined
          ? undefined
          : eq(merchantAcquisitionCandidates.assignedToOxyUserId, input.assignedToOxyUserId),
      ),
    )
    .orderBy(
      desc(merchantAcquisitionCandidates.scoreBps),
      merchantAcquisitionCandidates.merchantId,
    )
    .limit(input.limit)
    .offset(input.offset);
}

/** Store a freshly computed score against the snapshot it was computed from. */
export async function storeAcquisitionScore(
  input: {
    readonly merchantId: string;
    readonly scoreBps: number;
    readonly scoreVersion: string;
    readonly snapshotId: string;
    readonly contributingInputs: readonly MerchantAcquisitionScoreInput[];
    readonly unmeasuredInputs: readonly MerchantAcquisitionScoreInput[];
    readonly scoredAt: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantAcquisitionCandidateRow> {
  const rows = await db
    .update(merchantAcquisitionCandidates)
    .set({
      scoreBps: input.scoreBps,
      scoreVersion: input.scoreVersion,
      snapshotId: input.snapshotId,
      contributingInputs: [...input.contributingInputs],
      unmeasuredInputs: [...input.unmeasuredInputs],
      scoredAt: input.scoredAt,
    })
    .where(eq(merchantAcquisitionCandidates.merchantId, input.merchantId))
    .returning();
  return rows[0];
}

/** Assign a candidate to an operator, or clear the assignment. */
export async function assignAcquisitionCandidate(
  input: { readonly merchantId: string; readonly assignedToOxyUserId: string | null },
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantAcquisitionCandidateRow> {
  const rows = await db
    .update(merchantAcquisitionCandidates)
    .set({ assignedToOxyUserId: input.assignedToOxyUserId })
    .where(eq(merchantAcquisitionCandidates.merchantId, input.merchantId))
    .returning();
  return rows[0];
}

/** Set the next action and its deadline, and move the state with it. */
export async function setAcquisitionNextAction(
  input: {
    readonly merchantId: string;
    readonly state: MerchantAcquisitionState;
    readonly nextAction: string | null;
    readonly nextActionDueAt: Date | null;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantAcquisitionCandidateRow> {
  const rows = await db
    .update(merchantAcquisitionCandidates)
    .set({
      state: input.state,
      nextAction: input.nextAction,
      nextActionDueAt: input.nextActionDueAt,
    })
    .where(eq(merchantAcquisitionCandidates.merchantId, input.merchantId))
    .returning();
  return rows[0];
}

/** Exclude a candidate, attributably. */
export async function excludeAcquisitionCandidate(
  input: {
    readonly merchantId: string;
    readonly reason: MerchantAcquisitionExclusionReason;
    readonly actorOxyUserId: string;
    readonly at: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantAcquisitionCandidateRow> {
  const rows = await db
    .update(merchantAcquisitionCandidates)
    .set({
      state: 'excluded',
      exclusionReason: input.reason,
      excludedAt: input.at,
      excludedByOxyUserId: input.actorOxyUserId,
      // An excluded candidate is nobody's to work.
      nextAction: null,
      nextActionDueAt: null,
    })
    .where(eq(merchantAcquisitionCandidates.merchantId, input.merchantId))
    .returning();
  return rows[0];
}

/**
 * Lift an exclusion, returning the candidate to the queue.
 *
 * `do_not_contact` is deliberately NOT cleared here. A merchant that asked not
 * to be contacted has not withdrawn that because an operator changed their mind
 * about a competitor conflict, and one action that quietly did both is exactly
 * how a do-not-contact request gets lost.
 */
export async function clearAcquisitionExclusion(
  input: { readonly merchantId: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantAcquisitionCandidateRow> {
  const rows = await db
    .update(merchantAcquisitionCandidates)
    .set({
      state: 'queued',
      exclusionReason: null,
      excludedAt: null,
      excludedByOxyUserId: null,
    })
    .where(eq(merchantAcquisitionCandidates.merchantId, input.merchantId))
    .returning();
  return rows[0];
}

/**
 * Record (or withdraw) a do-not-contact request.
 *
 * Setting it also EXCLUDES, because a candidate flagged do-not-contact that
 * stayed in the outreach queue is a queue that will be worked.
 */
export async function setAcquisitionDoNotContact(
  input: {
    readonly merchantId: string;
    readonly doNotContact: boolean;
    readonly actorOxyUserId: string;
    readonly at: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantAcquisitionCandidateRow> {
  const rows = await db
    .update(merchantAcquisitionCandidates)
    .set(
      input.doNotContact
        ? {
            doNotContact: true,
            doNotContactRecordedAt: input.at,
            state: 'excluded',
            exclusionReason: 'do_not_contact_requested',
            excludedAt: input.at,
            excludedByOxyUserId: input.actorOxyUserId,
            nextAction: null,
            nextActionDueAt: null,
          }
        : { doNotContact: false, doNotContactRecordedAt: null },
    )
    .where(eq(merchantAcquisitionCandidates.merchantId, input.merchantId))
    .returning();
  return rows[0];
}

/** Record where a public business contact is published. */
export async function recordContactSource(
  input: {
    readonly candidateId: string;
    readonly kind: MerchantAcquisitionContactSourceKind;
    readonly sourceUrl: string;
    readonly locatorNote: string;
    readonly observedAt: Date;
    readonly recordedByOxyUserId: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantAcquisitionContactSourceRow> {
  await db
    .insert(merchantAcquisitionContactSources)
    .values({
      candidateId: input.candidateId,
      kind: input.kind,
      sourceUrl: input.sourceUrl,
      locatorNote: input.locatorNote,
      observedAt: input.observedAt,
      recordedByOxyUserId: input.recordedByOxyUserId,
    })
    .onConflictDoNothing();

  const rows = await db
    .select()
    .from(merchantAcquisitionContactSources)
    .where(
      and(
        eq(merchantAcquisitionContactSources.candidateId, input.candidateId),
        eq(merchantAcquisitionContactSources.kind, input.kind),
        eq(merchantAcquisitionContactSources.sourceUrl, input.sourceUrl),
      ),
    )
    .limit(1);
  return rows[0];
}

/** Every recorded source for a candidate. */
export async function listContactSources(
  candidateId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly MerchantAcquisitionContactSourceRow[]> {
  return db
    .select()
    .from(merchantAcquisitionContactSources)
    .where(eq(merchantAcquisitionContactSources.candidateId, candidateId))
    .orderBy(desc(merchantAcquisitionContactSources.observedAt));
}

/** Append one outreach attempt. */
export async function recordOutreach(
  input: {
    readonly candidateId: string;
    readonly channel: MerchantAcquisitionOutreachChannel;
    readonly outcome: MerchantAcquisitionOutreachOutcome;
    readonly occurredAt: Date;
    readonly actorOxyUserId: string;
    readonly contactSourceId?: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantAcquisitionOutreachRow> {
  const rows = await db
    .insert(merchantAcquisitionOutreach)
    .values({
      candidateId: input.candidateId,
      channel: input.channel,
      outcome: input.outcome,
      occurredAt: input.occurredAt,
      actorOxyUserId: input.actorOxyUserId,
      contactSourceId: input.contactSourceId ?? null,
    })
    .returning();
  return rows[0];
}

/** The prior-outreach log for a candidate, newest first. */
export async function listOutreach(
  candidateId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly MerchantAcquisitionOutreachRow[]> {
  return db
    .select()
    .from(merchantAcquisitionOutreach)
    .where(eq(merchantAcquisitionOutreach.candidateId, candidateId))
    .orderBy(desc(merchantAcquisitionOutreach.occurredAt));
}

/** Append one audit row. Called on BOTH branches of every operator action. */
export async function recordAcquisitionAudit(
  input: {
    readonly merchantId: string | null;
    readonly action: MerchantAcquisitionAction;
    readonly outcome: 'granted' | 'refused';
    readonly refusalCode?: string;
    readonly actorOxyUserId: string;
    readonly occurredAt: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<MerchantAcquisitionAuditRow> {
  const rows = await db
    .insert(merchantAcquisitionAudits)
    .values({
      merchantId: input.merchantId,
      action: input.action,
      outcome: input.outcome,
      refusalCode: input.refusalCode ?? null,
      actorOxyUserId: input.actorOxyUserId,
      occurredAt: input.occurredAt,
    })
    .returning();
  return rows[0];
}

/** The audit trail for one merchant, newest first. */
export async function listAcquisitionAudits(
  input: { readonly merchantId: string; readonly limit: number },
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly MerchantAcquisitionAuditRow[]> {
  return db
    .select()
    .from(merchantAcquisitionAudits)
    .where(eq(merchantAcquisitionAudits.merchantId, input.merchantId))
    .orderBy(desc(merchantAcquisitionAudits.occurredAt))
    .limit(input.limit);
}

/** How many candidates sit in each state — the pipeline's own health read. */
export async function countCandidatesByState(
  db: DatabaseOrTransaction = getDb(),
): Promise<ReadonlyMap<string, number>> {
  const rows = await db
    .select({
      state: merchantAcquisitionCandidates.state,
      total: sql<string>`count(*)`,
    })
    .from(merchantAcquisitionCandidates)
    .groupBy(merchantAcquisitionCandidates.state);
  return new Map(rows.map((row) => [row.state, Number(row.total)]));
}
