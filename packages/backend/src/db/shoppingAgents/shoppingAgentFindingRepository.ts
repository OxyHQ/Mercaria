/**
 * `shopping_agent_findings` and `shopping_agent_finding_lines` — the record that
 * one evaluation happened, written EXACTLY once (#97 evaluation 2).
 *
 * ## This module is the SINGLE writer, and that is load-bearing
 *
 * A finding and the plan behind it are one observation. They are written in ONE
 * transaction so a finding never exists with a partial selection attached, which
 * is a state every reader would render as a complete answer.
 *
 * ## The conflict is not an error to catch
 *
 * `ON CONFLICT DO NOTHING … RETURNING` returns one row when this call created the
 * finding and NO rows when an earlier evaluation already had. That empty set IS
 * the "already recorded" answer — the `moderation_events` claim shape — so a
 * genuine failure (a dropped connection, a violated CHECK) still propagates
 * instead of being read as a duplicate.
 *
 * A read-then-write would lose exactly the case this exists for: two workers
 * evaluating one agent against one unchanged catalogue both read "no finding
 * yet", both insert, and the shopper is told the same good news twice. The
 * database decides, and `shopping_agent_findings_identity_key` is what decides
 * it.
 *
 * ## `undefined` means the caller must NOT notify, and must NOT write lines
 *
 * The lines are written only on the branch that created the finding. Writing them
 * on a converge would attach a SECOND plan to a finding that already has one —
 * `shopping_agent_finding_lines_position_key` would refuse the collision, and the
 * ones that did not collide would be a plan nobody produced.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import type {
  ConditionGroup,
  CurrencyCode,
  ShoppingAgentEvidenceCompleteness,
  ShoppingAgentFindingLifecycle,
  ShoppingAgentFindingOutcome,
  ShoppingAgentFreshness,
  ShoppingAgentIncompleteReason,
  ShoppingAgentOptimality,
  ShoppingAgentRecordRef,
  ShoppingAgentTriggerSource,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  shoppingAgentFindingLines,
  shoppingAgentFindings,
  shoppingAgents,
} from '../schema/shoppingAgents.js';

export type ShoppingAgentFindingRow = typeof shoppingAgentFindings.$inferSelect;
export type ShoppingAgentFindingLineRow = typeof shoppingAgentFindingLines.$inferSelect;

/** One line of the plan behind a finding. */
export interface NewShoppingAgentFindingLine {
  readonly lineId: string;
  readonly canonicalProductId: string;
  readonly offerRef: string;
  readonly quantity: number;
  readonly unitItemPriceAmount?: number | null;
  readonly unitItemPriceCurrency?: CurrencyCode | null;
  readonly conditionGroup?: ConditionGroup | null;
  readonly nativeCheckoutEligible: boolean;
  readonly officialChannel: boolean;
  readonly position: number;
}

/**
 * Everything one finding records. Composed by the evaluator, never partially.
 *
 * `lifecycle` is absent: a finding written now IS the current one, and the two
 * other values are things a LATER observation or a catalogue correction decides
 * about it. Accepting one here would let an evaluator file an observation already
 * marked superseded, which no reader could tell from a real one.
 */
export interface NewShoppingAgentFinding {
  readonly agentId: string;
  readonly evaluationKey: string;
  readonly agentRevision: number;
  readonly triggerSource: ShoppingAgentTriggerSource;
  readonly triggeredAt: Date;
  readonly evaluatedAt: Date;

  readonly outcome: ShoppingAgentFindingOutcome;
  readonly incompleteReasons: readonly ShoppingAgentIncompleteReason[];
  readonly completeness: ShoppingAgentEvidenceCompleteness;
  readonly freshness: ShoppingAgentFreshness;
  readonly optimality?: ShoppingAgentOptimality | null;

  readonly inputDigest: string;
  readonly agentPolicyVersion: string;
  readonly constraintEvaluationVersion: string;
  readonly normalizationRuleVersion: string;
  readonly comparisonPolicyVersion: string;
  readonly rankingPolicyVersion: string;

  readonly satisfiedConstraintIds: readonly string[];
  readonly failedConstraintIds: readonly string[];
  readonly unknownConstraintIds: readonly string[];

  readonly objectiveAmount?: number | null;
  readonly objectiveCurrency?: CurrencyCode | null;
  readonly objectiveDeltaAmount?: number | null;

  readonly recordRefs: readonly ShoppingAgentRecordRef[];
  readonly lines: readonly NewShoppingAgentFindingLine[];
}

/**
 * Write one finding and its plan, or converge on the one that already exists.
 *
 * `undefined` means an earlier evaluation already recorded this exact
 * observation — a repeated source event, a second worker, a re-run against an
 * unchanged catalogue — and the caller must NOT enqueue a notification for it.
 * That is #97 evaluation 2 in one return value.
 *
 * The handle is used as it arrives when it can already roll back, and a
 * transaction is opened when it cannot; `db/moderation/transactionGuard.ts`
 * states that discriminator and why a TYPE is not one.
 */
export async function insertShoppingAgentFinding(
  input: NewShoppingAgentFinding,
  db: DatabaseOrTransaction = getDb(),
): Promise<ShoppingAgentFindingRow | undefined> {
  const write = async (
    tx: DatabaseOrTransaction,
  ): Promise<ShoppingAgentFindingRow | undefined> => {
    const inserted = await tx
      .insert(shoppingAgentFindings)
      .values({
        agentId: input.agentId,
        evaluationKey: input.evaluationKey,
        agentRevision: input.agentRevision,
        triggerSource: input.triggerSource,
        triggeredAt: input.triggeredAt,
        evaluatedAt: input.evaluatedAt,
        outcome: input.outcome,
        incompleteReasons: [...input.incompleteReasons],
        completeness: input.completeness,
        freshness: input.freshness,
        optimality: input.optimality ?? null,
        lifecycle: 'current',
        inputDigest: input.inputDigest,
        agentPolicyVersion: input.agentPolicyVersion,
        constraintEvaluationVersion: input.constraintEvaluationVersion,
        normalizationRuleVersion: input.normalizationRuleVersion,
        comparisonPolicyVersion: input.comparisonPolicyVersion,
        rankingPolicyVersion: input.rankingPolicyVersion,
        satisfiedConstraintIds: [...input.satisfiedConstraintIds],
        failedConstraintIds: [...input.failedConstraintIds],
        unknownConstraintIds: [...input.unknownConstraintIds],
        objectiveAmount: input.objectiveAmount ?? null,
        objectiveCurrency: input.objectiveCurrency ?? null,
        objectiveDeltaAmount: input.objectiveDeltaAmount ?? null,
        recordRefs: [...input.recordRefs],
      })
      .onConflictDoNothing()
      .returning();

    const finding = inserted[0];
    if (!finding) return undefined;

    if (input.lines.length > 0) {
      await tx.insert(shoppingAgentFindingLines).values(
        input.lines.map((line) => ({
          findingId: finding.id,
          lineId: line.lineId,
          canonicalProductId: line.canonicalProductId,
          offerRef: line.offerRef,
          quantity: line.quantity,
          unitItemPriceAmount: line.unitItemPriceAmount ?? null,
          unitItemPriceCurrency: line.unitItemPriceCurrency ?? null,
          conditionGroup: line.conditionGroup ?? null,
          nativeCheckoutEligible: line.nativeCheckoutEligible,
          officialChannel: line.officialChannel,
          position: line.position,
        })),
      );
    }

    return finding;
  };

  const rollback: unknown = (db as { rollback?: unknown }).rollback;
  if (typeof rollback === 'function') return write(db);
  return db.transaction(write);
}

/**
 * One finding by id and NOTHING else — the delivery job's own read.
 *
 * Deliberately separate from {@link findShoppingAgentFindingForOwner} rather
 * than an optional owner parameter: an owner argument that can be omitted is one
 * a caller forgets, and this one's caller is a leased worker holding a
 * notification row that names the finding. A delivery has no owner in hand and
 * must not need one — asking it to carry an account id would put an identity on
 * the queue row purely so a read could check it against itself.
 *
 * The owner-scoped read is the one an HTTP surface uses, and it is the one that
 * joins.
 */
export async function findShoppingAgentFindingById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ShoppingAgentFindingRow | undefined> {
  const rows = await db
    .select()
    .from(shoppingAgentFindings)
    .where(eq(shoppingAgentFindings.id, id))
    .limit(1);
  return rows[0];
}

/**
 * The newest QUALIFIED finding for one agent — the prior-comparable read.
 *
 * Served by `shopping_agent_findings_qualified_idx`, whose partial predicate is
 * this query's own `outcome = 'qualified'`: the comparison a material-improvement
 * rule makes is against the last thing that actually qualified, and reading the
 * newest finding of any outcome would compare today's price against an evaluation
 * that concluded nothing.
 *
 * Ties break on the id after `created_at` because `@oxyhq/db`'s uuid v7 key is
 * not monotonic within a millisecond, so two findings written in one tick would
 * otherwise order arbitrarily — and the ordering decides which amount the next
 * notification is measured against.
 */
export async function findLatestQualifiedFinding(
  agentId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ShoppingAgentFindingRow | undefined> {
  const rows = await db
    .select()
    .from(shoppingAgentFindings)
    .where(
      and(eq(shoppingAgentFindings.agentId, agentId), eq(shoppingAgentFindings.outcome, 'qualified')),
    )
    .orderBy(desc(shoppingAgentFindings.createdAt), desc(shoppingAgentFindings.id))
    .limit(1);
  return rows[0];
}

/** One agent's own history, newest first. */
export async function listShoppingAgentFindings(
  agentId: string,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<ShoppingAgentFindingRow[]> {
  return db
    .select()
    .from(shoppingAgentFindings)
    .where(eq(shoppingAgentFindings.agentId, agentId))
    .orderBy(desc(shoppingAgentFindings.createdAt), desc(shoppingAgentFindings.id))
    .limit(limit);
}

/**
 * One finding, SCOPED TO THE OWNER OF ITS AGENT, in the statement.
 *
 * The join is what carries the scope; a finding id belonging to somebody else
 * therefore answers `undefined` and the surface answers 404, for the reason
 * `findShoppingAgentForOwner` does — the id is opaque and a distinguishable
 * answer confirms that a stranger's finding exists.
 *
 * The projection names the FINDING alone, so the agent's protected description
 * cannot arrive through a join that only exists to check an owner.
 */
export async function findShoppingAgentFindingForOwner(
  findingId: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ShoppingAgentFindingRow | undefined> {
  const rows = await db
    .select({ finding: shoppingAgentFindings })
    .from(shoppingAgentFindings)
    .innerJoin(shoppingAgents, eq(shoppingAgents.id, shoppingAgentFindings.agentId))
    .where(and(eq(shoppingAgentFindings.id, findingId), eq(shoppingAgents.oxyUserId, oxyUserId)))
    .limit(1);
  return rows[0]?.finding;
}

/** The plan behind one finding, in its own order. */
export async function listShoppingAgentFindingLines(
  findingId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ShoppingAgentFindingLineRow[]> {
  return db
    .select()
    .from(shoppingAgentFindingLines)
    .where(eq(shoppingAgentFindingLines.findingId, findingId))
    .orderBy(shoppingAgentFindingLines.position, shoppingAgentFindingLines.id);
}

/**
 * Mark a finding superseded or invalidated — the ONE permitted update.
 *
 * Every other column is frozen by the append-only trigger, so this function is
 * not a convention about what may change: a statement touching anything else
 * raises. A correction is a LATER observation that supersedes this one, never a
 * rewrite of what was observed — #78's superseding-record device, applied to an
 * observation about somebody's own objective.
 *
 * @returns `true` when a row moved.
 */
export async function setShoppingAgentFindingLifecycle(
  input: {
    readonly id: string;
    readonly lifecycle: ShoppingAgentFindingLifecycle;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(shoppingAgentFindings)
    .set({ lifecycle: input.lifecycle })
    .where(eq(shoppingAgentFindings.id, input.id))
    .returning({ id: shoppingAgentFindings.id });
  return rows.length === 1;
}

/**
 * How many findings concluded each of the three outcomes — the operator metric.
 *
 * All three, never just the qualified count: `incomplete` is what a broken input
 * looks like from here, and a surface reporting only what qualified would show a
 * domain that has stopped being able to answer anything as a quiet one.
 */
export async function readShoppingAgentFindingSummaryCounts(
  db: DatabaseOrTransaction = getDb(),
): Promise<{ qualified: number; notQualified: number; incomplete: number }> {
  const rows = await db
    .select({
      qualified: sql<number>`count(*) filter (where ${shoppingAgentFindings.outcome} = 'qualified')::int`,
      notQualified: sql<number>`count(*) filter (where ${shoppingAgentFindings.outcome} = 'not_qualified')::int`,
      incomplete: sql<number>`count(*) filter (where ${shoppingAgentFindings.outcome} = 'incomplete')::int`,
    })
    .from(shoppingAgentFindings);
  const row = rows[0];
  return {
    qualified: row?.qualified ?? 0,
    notQualified: row?.notQualified ?? 0,
    incomplete: row?.incomplete ?? 0,
  };
}
