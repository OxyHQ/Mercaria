/**
 * A shopper reading their own findings (#97 UX 3 and 4).
 *
 * The read that composes a timeline: every observation the agent made, each
 * with its lifecycle, its summary and what it could not check. It deliberately
 * shows `not_qualified` and `incomplete` findings beside the qualifying ones —
 * a timeline of only the good news cannot show somebody that their agent has
 * been running and finding nothing, which is the question they actually have.
 *
 * ## The summary is COMPOSED on read, not stored
 *
 * There is no summary column. The deterministic template is a pure function of
 * the finding, so storing it would be a second copy that a copy fix could not
 * reach — #108's reasoning about message templates, one domain over. A
 * PROVIDER's summary is different: it is attributed and would have to be
 * stored, which is why closing that seam means adding a table rather than a
 * column, and why nothing here pretends one exists today.
 */

import type { ShoppingAgentFinding } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { notFound } from '../../lib/errors/error-codes.js';
import {
  findShoppingAgentFindingForOwner,
  listShoppingAgentFindingLines,
  listShoppingAgentFindings,
} from '../../db/shoppingAgents/shoppingAgentFindingRepository.js';
import { listShoppingAgentNotifications } from '../../db/shoppingAgents/shoppingAgentNotificationRepository.js';
import { requireOwnedShoppingAgent } from './agent.service.js';
import { toShoppingAgentFindingDTO } from './projection.js';
import { renderShoppingAgentSummaryTemplate } from './summary.js';
import type { ShoppingAgentSummaryPackage } from './summary.port.js';

/** One agent's timeline, newest first. */
export async function listShoppingAgentFindingsForOwner(
  oxyUserId: string,
  agentId: string,
  limit = config.shoppingAgents.findingPageSize,
): Promise<readonly ShoppingAgentFinding[]> {
  const agent = await requireOwnedShoppingAgent(oxyUserId, agentId);
  const rows = await listShoppingAgentFindings(agentId, limit);

  const findings: ShoppingAgentFinding[] = [];
  for (const row of rows) {
    const lines = await listShoppingAgentFindingLines(row.id);
    const notifications = await listShoppingAgentNotifications(row.id);
    findings.push(
      toShoppingAgentFindingDTO({
        row,
        lines,
        notifications,
        summary: renderShoppingAgentSummaryTemplate(packageFor(row, lines.length, agent.kind)),
      }),
    );
  }
  return findings;
}

/** One finding, or a 404. Owner-scoped in the statement. */
export async function getShoppingAgentFinding(
  oxyUserId: string,
  findingId: string,
): Promise<ShoppingAgentFinding> {
  const row = await findShoppingAgentFindingForOwner(findingId, oxyUserId);
  if (row === undefined) throw notFound('Finding not found');
  const agent = await requireOwnedShoppingAgent(oxyUserId, row.agentId);
  const lines = await listShoppingAgentFindingLines(row.id);
  return toShoppingAgentFindingDTO({
    row,
    lines,
    notifications: await listShoppingAgentNotifications(row.id),
    summary: renderShoppingAgentSummaryTemplate(packageFor(row, lines.length, agent.kind)),
  });
}

/**
 * The package the template renders from.
 *
 * `numericTokens` is EMPTY for a template, and that is not an omission: the
 * list exists to bound what a PROVIDER may write, and a template composed from
 * the finding cannot write a number the finding does not contain. Filling it
 * here would be a control that can never fire.
 */
function packageFor(
  row: {
    readonly id: string;
    readonly outcome: ShoppingAgentSummaryPackage['outcome'];
    readonly completeness: ShoppingAgentSummaryPackage['completeness'];
    readonly freshness: ShoppingAgentSummaryPackage['freshness'];
    readonly satisfiedConstraintIds: readonly string[];
    readonly failedConstraintIds: readonly string[];
    readonly unknownConstraintIds: readonly string[];
    readonly recordRefs: ShoppingAgentSummaryPackage['records'];
  },
  lineCount: number,
  kind: ShoppingAgentSummaryPackage['kind'],
): ShoppingAgentSummaryPackage {
  return {
    findingId: row.id,
    kind,
    outcome: row.outcome,
    completeness: row.completeness,
    freshness: row.freshness,
    lineCount,
    satisfiedConstraintCount: row.satisfiedConstraintIds.length,
    failedConstraintCount: row.failedConstraintIds.length,
    unknownConstraintCount: row.unknownConstraintIds.length,
    records: row.recordRefs,
    validRefs: row.recordRefs.map((record) => record.ref),
    numericTokens: [],
  };
}
