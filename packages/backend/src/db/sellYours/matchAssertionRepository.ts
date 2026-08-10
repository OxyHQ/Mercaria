/**
 * `seller_draft_match_assertions` (#91) — the append-only record of what a
 * seller was offered, what they said about it, and what the gate did.
 *
 * There is deliberately no update and no delete in this module, and the database
 * refuses both anyway. The two halves are not redundant: the trigger is what
 * holds against a future writer, and the absence here is what stops one being
 * written in the first place.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type {
  MatchBlocker,
  SellerMatchActor,
  SellerMatchAssertionOutcome,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { sellerDraftMatchAssertions } from '../schema/sellYours.js';

export type SellerMatchAssertionRecord = InferSelectModel<typeof sellerDraftMatchAssertions>;

/** One assertion, as a caller supplies it. */
export interface NewSellerMatchAssertion {
  readonly draftId: string;
  readonly outcome: SellerMatchAssertionOutcome;
  readonly actor: SellerMatchActor;
  /** Required for a person, forbidden for a matcher — the row's own CHECK. */
  readonly actorOxyUserId: string | null;
  readonly canonicalProductId: string | null;
  readonly canonicalVariantId: string | null;
  readonly confidence: number | null;
  readonly blockers: readonly MatchBlocker[];
  readonly reasonCodes: readonly string[];
}

/** Append one assertion. */
export async function recordSellerMatchAssertion(
  input: NewSellerMatchAssertion,
  db: DatabaseOrTransaction = getDb(),
): Promise<SellerMatchAssertionRecord> {
  const [row] = await db
    .insert(sellerDraftMatchAssertions)
    .values({
      draftId: input.draftId,
      outcome: input.outcome,
      actor: input.actor,
      actorOxyUserId: input.actorOxyUserId,
      canonicalProductId: input.canonicalProductId,
      canonicalVariantId: input.canonicalVariantId,
      confidence: input.confidence,
      blockers: [...input.blockers],
      reasonCodes: [...input.reasonCodes],
    })
    .returning();
  return row;
}

/** One draft's whole trail, newest first. */
export async function listSellerMatchAssertions(
  draftId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SellerMatchAssertionRecord[]> {
  return db
    .select()
    .from(sellerDraftMatchAssertions)
    .where(eq(sellerDraftMatchAssertions.draftId, draftId))
    .orderBy(desc(sellerDraftMatchAssertions.createdAt), desc(sellerDraftMatchAssertions.id));
}

/**
 * The most recent refusal on this draft, if the gate ever refused one.
 *
 * Read by the readiness derivation, which reports `match_review_required` — so
 * the block a seller sees and the evidence a reviewer reads come from the same
 * row rather than from two places that could disagree.
 */
export async function findLatestGateRefusal(
  draftId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<SellerMatchAssertionRecord | null> {
  const [row] = await db
    .select()
    .from(sellerDraftMatchAssertions)
    .where(
      and(
        eq(sellerDraftMatchAssertions.draftId, draftId),
        eq(sellerDraftMatchAssertions.outcome, 'gate_refused'),
      ),
    )
    .orderBy(desc(sellerDraftMatchAssertions.createdAt), desc(sellerDraftMatchAssertions.id))
    .limit(1);
  return row ?? null;
}
