/**
 * `shopping_agent_audits` — what was done to a saved agent, and by whom
 * (#97 privacy 7).
 *
 * ## The trail is append-only against UPDATE, and this module never tries
 *
 * There is one write and it is an INSERT. A "correct an audit row" function would
 * be refused by the trigger, so its absence here is not a second guard — it is
 * the statement that nothing in this domain has a reason to ask.
 *
 * ## `actor` and `actorOxyUserId` are stated together, and the CHECK ties them
 *
 * An `owner` act names the account that performed it; a `system` act names none.
 * `shopping_agent_audits_actor_shape_check` is a BICONDITIONAL rather than a
 * one-way implication, because a system act carrying an account id would read, to
 * whoever looked next, as somebody having done it by hand.
 *
 * ## `detail` is a bounded code or short phrase, never a shopper's own words
 *
 * The column's CHECK bounds it at {@link MAX_AUDIT_DETAIL_LENGTH}, and the write
 * below slices rather than letting a long value raise: an audit that throws would
 * roll back the act it exists to record, which trades a truncated note for a lost
 * edit. The truncation is safe precisely because the value is a code — a
 * description, a note or a constraint the shopper typed belongs in neither this
 * column nor this table.
 */

import { desc, eq } from 'drizzle-orm';
import type { ShoppingAgentAuditAction, ShoppingAgentAuditActor } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { shoppingAgentAudits } from '../schema/shoppingAgents.js';

export type ShoppingAgentAuditRow = typeof shoppingAgentAudits.$inferSelect;

/** The same bound `shopping_agent_audits_detail_check` states at the row. */
const MAX_AUDIT_DETAIL_LENGTH = 200;

/**
 * Record one audited act.
 *
 * Takes the agent REVISION as it stood at the moment of the act rather than
 * reading it: a revision read here would be the one after a bump the caller has
 * already performed, so the trail would say every edit happened to the agent it
 * produced instead of the one it changed.
 *
 * Runs in the caller's transaction when it is handed one, so an act and its
 * record commit together — an edit that landed with no audit row is exactly the
 * gap #97 privacy 7 exists to close.
 */
export async function recordShoppingAgentAudit(
  input: {
    readonly agentId: string;
    readonly action: ShoppingAgentAuditAction;
    readonly actor: ShoppingAgentAuditActor;
    readonly actorOxyUserId?: string | null;
    readonly agentRevision: number;
    readonly detail?: string | null;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.insert(shoppingAgentAudits).values({
    agentId: input.agentId,
    action: input.action,
    actor: input.actor,
    actorOxyUserId: input.actorOxyUserId ?? null,
    agentRevision: input.agentRevision,
    detail:
      input.detail === undefined || input.detail === null
        ? null
        : input.detail.slice(0, MAX_AUDIT_DETAIL_LENGTH),
  });
}

/** One agent's own trail, newest first. */
export async function listShoppingAgentAudits(
  agentId: string,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<ShoppingAgentAuditRow[]> {
  return db
    .select()
    .from(shoppingAgentAudits)
    .where(eq(shoppingAgentAudits.agentId, agentId))
    .orderBy(desc(shoppingAgentAudits.createdAt), desc(shoppingAgentAudits.id))
    .limit(limit);
}
