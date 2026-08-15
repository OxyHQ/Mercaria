/**
 * #97's saved shopping agents, against a REAL PostgreSQL server.
 *
 * Everything here is a property a mocked `insert` would have accepted. A CHECK,
 * a partial unique index, an append-only trigger and a cross-row trigger have
 * no mocked counterpart — they exist or they do not — and four of the five
 * things this issue calls structural are one of those four.
 *
 * Every assertion is scoped to ids THIS FILE owns: the database is shared with
 * every other realdb file, so an unscoped count reads correctly until a sibling
 * seeds a row and then fails in the victim naming nothing about the cause.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import {
  SHOPPING_AGENT_POLICY_VERSION,
  SHOPPING_AGENT_TERMS_VERSION,
  shoppingAgentEvaluationKey,
  shoppingAgentNotificationDecision,
  CONSTRAINT_EVALUATION_VERSION,
  COMPARISON_POLICY_VERSION,
  NORMALIZATION_RULE_VERSION,
} from '@mercaria/shared-types';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import { canonicalProducts, canonicalVariants } from '../../db/schema/canonicalCatalog.js';
import { catalogSplitJobs } from '../../db/schema/curation.js';
import {
  shoppingAgentAudits,
  shoppingAgentFindingLines,
  shoppingAgentFindings,
  shoppingAgentNotifications,
  shoppingAgentTriggers,
  shoppingAgents,
} from '../../db/schema/shoppingAgents.js';
import {
  findShoppingAgentById,
  insertShoppingAgent,
  listShoppingAgentLines,
  markShoppingAgentsAmbiguousAfterSplit,
  stampShoppingAgentRehoming,
  type NewShoppingAgent,
} from '../../db/shoppingAgents/shoppingAgentRepository.js';
import {
  findLatestQualifiedFinding,
  insertShoppingAgentFinding,
  listShoppingAgentFindings,
  setShoppingAgentFindingLifecycle,
  type NewShoppingAgentFinding,
} from '../../db/shoppingAgents/shoppingAgentFindingRepository.js';
import {
  enqueueShoppingAgentNotification,
  listShoppingAgentNotifications,
  recordShoppingAgentNotificationSuppressed,
} from '../../db/shoppingAgents/shoppingAgentNotificationRepository.js';
import { requestShoppingAgentTriggerForProduct } from '../../db/shoppingAgents/shoppingAgentTriggerRepository.js';
import { recordShoppingAgentAudit } from '../../db/shoppingAgents/shoppingAgentAuditRepository.js';
import { deleteTestCanonicalRows } from '../../db/__tests__/canonical-teardown.js';

let db: Database;

/** Unique to this run, so parallel files cannot collide on a shared database. */
const RUN = uuidv7().slice(-12);
const OWNER = `oxy-agent-owner-${RUN}`;
const OTHER_OWNER = `oxy-agent-stranger-${RUN}`;

const createdProductIds: string[] = [];
const createdVariantIds: string[] = [];
const createdSplitJobIds: string[] = [];

/** An empty `inArray` is a statement with no predicate — never let one through. */
function safeIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? ['__none__'] : [...ids];
}

beforeAll(async () => {
  db = await connectPostgres();
}, 120_000);

afterAll(async () => {
  const agentIds = (
    await db
      .select({ id: shoppingAgents.id })
      .from(shoppingAgents)
      .where(inArray(shoppingAgents.oxyUserId, [OWNER, OTHER_OWNER]))
  ).map((row) => row.id);
  // The agent cascades its lines, findings, finding lines, notifications,
  // audits and queue row. That cascade IS the erasure story — see the case
  // below that measures it.
  await db.delete(shoppingAgents).where(inArray(shoppingAgents.id, safeIds(agentIds)));
  await db
    .delete(shoppingAgentTriggers)
    .where(inArray(shoppingAgentTriggers.canonicalProductId, safeIds(createdProductIds)));
  // Children first: an agent's `split_job_id` is `ON DELETE restrict`, so the
  // agents above have to be gone before the job they name can be.
  await db.delete(catalogSplitJobs).where(inArray(catalogSplitJobs.id, safeIds(createdSplitJobIds)));
  await deleteTestCanonicalRows(db, {
    variantIds: createdVariantIds,
    productIds: createdProductIds,
  });
  await closePostgres();
}, 120_000);

async function mintProduct(label: string): Promise<string> {
  const [product] = await db
    .insert(canonicalProducts)
    .values({
      name: `Agent ${label} ${RUN}`,
      normalizedName: `agent ${label} ${RUN}`,
      slug: `agent-${label}-${RUN}`,
    })
    .returning({ id: canonicalProducts.id });
  if (!product) throw new Error('the canonical product was not written');
  createdProductIds.push(product.id);
  return product.id;
}

async function mintVariant(productId: string): Promise<string> {
  const [variant] = await db
    .insert(canonicalVariants)
    .values({
      productId,
      signature: uuidv7().replace(/-/gu, '').padEnd(64, '0').slice(0, 64),
    })
    .returning({ id: canonicalVariants.id });
  if (!variant) throw new Error('the canonical variant was not written');
  createdVariantIds.push(variant.id);
  return variant.id;
}

function newAgent(overrides: Partial<NewShoppingAgent> = {}): NewShoppingAgent {
  return {
    oxyUserId: OWNER,
    kind: 'offer_price_threshold',
    name: `Agent ${RUN}`,
    displayCurrency: 'EUR',
    priceBasis: 'item_price',
    channelPolicy: 'mixed',
    conditionGroups: [],
    excludedMerchantIds: [],
    targetAmount: 50_000,
    targetCurrency: 'EUR',
    constraintSet: { constraints: [] },
    constraintDigest: `sha256:${RUN.padEnd(64, '0')}`,
    triggerSources: ['offer_change'],
    notificationChannels: ['oxy_notification'],
    cooldownSeconds: 3_600,
    authorizedAt: new Date(),
    termsVersion: SHOPPING_AGENT_TERMS_VERSION,
    agentPolicyVersion: SHOPPING_AGENT_POLICY_VERSION,
    constraintEvaluationVersion: CONSTRAINT_EVALUATION_VERSION,
    normalizationRuleVersion: NORMALIZATION_RULE_VERSION,
    comparisonPolicyVersion: COMPARISON_POLICY_VERSION,
    ...overrides,
  };
}

async function seedAgent(
  label: string,
  overrides: Partial<NewShoppingAgent> = {},
): Promise<{ agentId: string; productId: string; lineId: string }> {
  const productId = await mintProduct(label);
  await mintVariant(productId);
  const row = await insertShoppingAgent({
    agent: newAgent(overrides),
    lines: [{ canonicalProductId: productId, quantity: 1, conditionGroups: [], position: 0 }],
  });
  const lines = await listShoppingAgentLines(row.id);
  const line = lines[0];
  if (!line) throw new Error('the agent line was not written');
  return { agentId: row.id, productId, lineId: line.id };
}

function newFinding(
  agentId: string,
  lineId: string,
  productId: string,
  overrides: Partial<NewShoppingAgentFinding> = {},
): NewShoppingAgentFinding {
  const now = new Date();
  return {
    agentId,
    evaluationKey: shoppingAgentEvaluationKey({
      agentId,
      agentRevision: 1,
      inputDigest: `digest-${RUN}`,
      policyVersion: SHOPPING_AGENT_POLICY_VERSION,
    }),
    agentRevision: 1,
    triggerSource: 'offer_change',
    triggeredAt: now,
    evaluatedAt: now,
    outcome: 'qualified',
    incompleteReasons: [],
    completeness: 'complete',
    freshness: 'current',
    optimality: 'proven_optimal',
    inputDigest: `digest-${RUN}`,
    agentPolicyVersion: SHOPPING_AGENT_POLICY_VERSION,
    constraintEvaluationVersion: CONSTRAINT_EVALUATION_VERSION,
    normalizationRuleVersion: NORMALIZATION_RULE_VERSION,
    comparisonPolicyVersion: COMPARISON_POLICY_VERSION,
    rankingPolicyVersion: 'test-policy',
    satisfiedConstraintIds: [],
    failedConstraintIds: [],
    unknownConstraintIds: [],
    objectiveAmount: 42_000,
    objectiveCurrency: 'EUR',
    recordRefs: [{ ref: 'p1', kind: 'canonical_product', recordId: productId }],
    lines: [
      {
        lineId,
        canonicalProductId: productId,
        offerRef: 'o1',
        quantity: 1,
        unitItemPriceAmount: 42_000,
        unitItemPriceCurrency: 'EUR',
        nativeCheckoutEligible: true,
        officialChannel: false,
        position: 0,
      },
    ],
    ...overrides,
  };
}

/** Every message in the cause chain, so a test cannot pass on the wrong refusal. */
async function rejectionMessage(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err: unknown) {
    const parts: string[] = [];
    let current: unknown = err;
    for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
      parts.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return parts.join(' | ');
  }
  throw new Error('expected the statement to be refused, and it was not');
}

/* ────────────────────────────────────────────────────────────────────────── */

describe('ACCEPTANCE 1 — a saved objective re-evaluates IDEMPOTENTLY', () => {
  it('two evaluations over an unchanged catalogue produce ONE finding', async () => {
    const { agentId, lineId, productId } = await seedAgent('idem');

    const first = await insertShoppingAgentFinding(newFinding(agentId, lineId, productId));
    expect(first).toBeDefined();

    // The SAME key: same agent, same revision, same input digest, same policy.
    // The empty `RETURNING` set IS the "already recorded" answer — a
    // read-then-write lets two workers both see "no".
    const second = await insertShoppingAgentFinding(newFinding(agentId, lineId, productId));
    expect(second).toBeUndefined();

    const findings = await listShoppingAgentFindings(agentId, 20);
    expect(findings).toHaveLength(1);
    // And the converged write left NO orphan plan lines behind.
    const lines = await db
      .select({ id: shoppingAgentFindingLines.id })
      .from(shoppingAgentFindingLines)
      .where(eq(shoppingAgentFindingLines.findingId, findings[0]?.id ?? '__none__'));
    expect(lines).toHaveLength(1);
  }, 60_000);

  it('a MOVED catalogue produces a second finding — the key is not a constant', async () => {
    const { agentId, lineId, productId } = await seedAgent('moved');
    await insertShoppingAgentFinding(newFinding(agentId, lineId, productId));

    const movedDigest = `digest-${RUN}-moved`;
    const moved = await insertShoppingAgentFinding(
      newFinding(agentId, lineId, productId, {
        inputDigest: movedDigest,
        evaluationKey: shoppingAgentEvaluationKey({
          agentId,
          agentRevision: 1,
          inputDigest: movedDigest,
          policyVersion: SHOPPING_AGENT_POLICY_VERSION,
        }),
        objectiveAmount: 39_000,
      }),
    );
    // The positive control for the case above: without it, "one finding" is
    // also what a key that can never change reports.
    expect(moved).toBeDefined();
    expect(await listShoppingAgentFindings(agentId, 20)).toHaveLength(2);
  }, 60_000);

  it('the trigger queue CONVERGES: two enqueues, one row, revision 2', async () => {
    const productId = await mintProduct('converge');
    await requestShoppingAgentTriggerForProduct(productId);
    await requestShoppingAgentTriggerForProduct(productId);

    const rows = await db
      .select()
      .from(shoppingAgentTriggers)
      .where(eq(shoppingAgentTriggers.canonicalProductId, productId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.requestedRevision).toBe(2);
    expect(rows[0]?.state).toBe('pending');
  }, 60_000);
});

describe('ACCEPTANCE 2 — one finding, at most one notification under its cooldown', () => {
  it('a withheld notification leaves a ROW with its reason', async () => {
    const { agentId, lineId, productId } = await seedAgent('cooldown');
    const finding = await insertShoppingAgentFinding(newFinding(agentId, lineId, productId));
    if (!finding) throw new Error('the finding was not written');

    await enqueueShoppingAgentNotification({
      findingId: finding.id,
      agentId,
      channel: 'oxy_notification',
      availableAt: new Date(),
    });
    await recordShoppingAgentNotificationSuppressed({
      findingId: finding.id,
      agentId,
      channel: 'email',
      reason: 'cooldown_active',
      now: new Date(),
    });

    const rows = await listShoppingAgentNotifications(finding.id);
    expect(rows).toHaveLength(2);
    const suppressed = rows.find((row) => row.channel === 'email');
    expect(suppressed?.state).toBe('suppressed');
    expect(suppressed?.suppressionReason).toBe('cooldown_active');
    // The point of the row: "how many did we withhold" is a question a table of
    // messages that were SENT can never answer (#97 cost rule 6).
  }, 60_000);

  it('a repeated enqueue converges on the deterministic id', async () => {
    const { agentId, lineId, productId } = await seedAgent('enqueue-twice');
    const finding = await insertShoppingAgentFinding(newFinding(agentId, lineId, productId));
    if (!finding) throw new Error('the finding was not written');

    const first = await enqueueShoppingAgentNotification({
      findingId: finding.id,
      agentId,
      channel: 'oxy_notification',
      availableAt: new Date(),
    });
    const second = await enqueueShoppingAgentNotification({
      findingId: finding.id,
      agentId,
      channel: 'oxy_notification',
      availableAt: new Date(),
    });
    expect(second).toBe(first);
    expect(await listShoppingAgentNotifications(finding.id)).toHaveLength(1);
  }, 60_000);

  it('the pure cooldown decision withholds and NAMES which half withheld it', () => {
    // A fixed instant safely in the PAST. Every other moment in this case is
    // derived from it as an offset, never as a second literal — #253's rule.
    const now = new Date('2025-01-15T12:00:00Z');
    const withinCooldown = shoppingAgentNotificationDecision({
      cooldownSeconds: 3_600,
      lastNotifiedAt: new Date(now.getTime() - 60_000),
      candidateAmountMinor: 100,
      now,
    });
    expect(withinCooldown).toEqual({ decision: 'withhold', reason: 'cooldown_active' });

    const notBetter = shoppingAgentNotificationDecision({
      cooldownSeconds: 60,
      lastNotifiedAt: new Date(now.getTime() - 7_200_000),
      lastNotifiedAmountMinor: 10_000,
      candidateAmountMinor: 9_950,
      now,
    });
    expect(notBetter).toEqual({ decision: 'withhold', reason: 'not_materially_better' });

    const better = shoppingAgentNotificationDecision({
      cooldownSeconds: 60,
      lastNotifiedAt: new Date(now.getTime() - 7_200_000),
      lastNotifiedAmountMinor: 10_000,
      candidateAmountMinor: 8_000,
      now,
    });
    expect(better).toEqual({ decision: 'notify' });
  });
});

describe('ACCEPTANCE 5 — missing data can never become a positive finding', () => {
  it('an INCOMPLETE finding cannot carry an objective value', async () => {
    const { agentId, lineId, productId } = await seedAgent('incomplete-value');
    const message = await rejectionMessage(() =>
      insertShoppingAgentFinding(
        newFinding(agentId, lineId, productId, {
          outcome: 'incomplete',
          incompleteReasons: ['delivery_cost_unknown'],
          completeness: 'partial',
          // The row still names an amount. This is the write the CHECK exists
          // to refuse, and a mocked insert accepts it.
        }),
      ),
    );
    expect(message).toContain('shopping_agent_findings_objective_shape_check');
  }, 60_000);

  it('an INCOMPLETE finding must name at least one reason, and a complete one none', async () => {
    const { agentId, lineId, productId } = await seedAgent('incomplete-reason');
    const noReason = await rejectionMessage(() =>
      insertShoppingAgentFinding(
        newFinding(agentId, lineId, productId, {
          outcome: 'incomplete',
          incompleteReasons: [],
          completeness: 'partial',
          objectiveAmount: null,
          objectiveCurrency: null,
        }),
      ),
    );
    expect(noReason).toContain('shopping_agent_findings_incomplete_shape_check');

    const reasonOnQualified = await rejectionMessage(() =>
      insertShoppingAgentFinding(
        newFinding(agentId, lineId, productId, {
          incompleteReasons: ['no_eligible_offer'],
        }),
      ),
    );
    expect(reasonOnQualified).toContain('shopping_agent_findings_incomplete_shape_check');
  }, 60_000);

  it('a notification cannot belong to a finding that is not QUALIFIED', async () => {
    const { agentId, lineId, productId } = await seedAgent('notify-incomplete');
    const finding = await insertShoppingAgentFinding(
      newFinding(agentId, lineId, productId, {
        outcome: 'incomplete',
        incompleteReasons: ['no_eligible_offer'],
        completeness: 'partial',
        objectiveAmount: null,
        objectiveCurrency: null,
      }),
    );
    if (!finding) throw new Error('the finding was not written');

    // CROSS-ROW, so no CHECK can see it: this is the trigger, and it is what
    // makes #97 evaluation 6 an answer the database gives rather than a rule a
    // service follows.
    const message = await rejectionMessage(() =>
      enqueueShoppingAgentNotification({
        findingId: finding.id,
        agentId,
        channel: 'oxy_notification',
        availableAt: new Date(),
      }),
    );
    expect(message).toContain('only a qualified finding may be notified');
    expect(await listShoppingAgentNotifications(finding.id)).toHaveLength(0);
  }, 60_000);
});

describe('findings are APPENDED and never rewritten', () => {
  it('an UPDATE that touches anything but the lifecycle is refused', async () => {
    const { agentId, lineId, productId } = await seedAgent('immutable');
    const finding = await insertShoppingAgentFinding(newFinding(agentId, lineId, productId));
    if (!finding) throw new Error('the finding was not written');

    const message = await rejectionMessage(() =>
      db
        .update(shoppingAgentFindings)
        .set({ objectiveAmount: 1 })
        .where(eq(shoppingAgentFindings.id, finding.id)),
    );
    expect(message).toContain('a finding is an appended observation');
  }, 60_000);

  it('the ONE permitted update is the lifecycle moving off `current`, once', async () => {
    const { agentId, lineId, productId } = await seedAgent('lifecycle');
    const finding = await insertShoppingAgentFinding(newFinding(agentId, lineId, productId));
    if (!finding) throw new Error('the finding was not written');

    expect(await setShoppingAgentFindingLifecycle({ id: finding.id, lifecycle: 'superseded' })).toBe(
      true,
    );

    // A settled finding is never re-opened — the first branch of the trigger.
    const message = await rejectionMessage(() =>
      setShoppingAgentFindingLifecycle({ id: finding.id, lifecycle: 'invalidated' }),
    );
    expect(message).toContain('is already superseded');
  }, 60_000);

  it('a finding LINE and an audit row admit no update at all', async () => {
    const { agentId, lineId, productId } = await seedAgent('append-only');
    const finding = await insertShoppingAgentFinding(newFinding(agentId, lineId, productId));
    if (!finding) throw new Error('the finding was not written');
    await recordShoppingAgentAudit({
      agentId,
      action: 'created',
      actor: 'owner',
      actorOxyUserId: OWNER,
      agentRevision: 1,
    });

    const lineMessage = await rejectionMessage(() =>
      db
        .update(shoppingAgentFindingLines)
        .set({ quantity: 9 })
        .where(eq(shoppingAgentFindingLines.findingId, finding.id)),
    );
    expect(lineMessage).toContain('append-only');

    const auditMessage = await rejectionMessage(() =>
      db
        .update(shoppingAgentAudits)
        .set({ detail: 'rewritten' })
        .where(eq(shoppingAgentAudits.agentId, agentId)),
    );
    expect(auditMessage).toContain('append-only');
  }, 60_000);

  it('DELETE is PERMITTED, which is what makes erasure one scoped statement', async () => {
    const { agentId, lineId, productId } = await seedAgent('erasure', {
      oxyUserId: OTHER_OWNER,
    });
    const finding = await insertShoppingAgentFinding(newFinding(agentId, lineId, productId));
    if (!finding) throw new Error('the finding was not written');
    await enqueueShoppingAgentNotification({
      findingId: finding.id,
      agentId,
      channel: 'oxy_notification',
      availableAt: new Date(),
    });
    await recordShoppingAgentAudit({
      agentId,
      action: 'created',
      actor: 'owner',
      actorOxyUserId: OTHER_OWNER,
      agentRevision: 1,
    });

    // ONE scoped statement, and the cascade takes the rest. A trigger refusing
    // DELETE would have made this fail SILENTLY on every row it was obliged to
    // remove — the `analytics_events` posture, and the reason DELETE is allowed.
    await db.delete(shoppingAgents).where(eq(shoppingAgents.id, agentId));

    expect(
      await db
        .select({ id: shoppingAgentFindings.id })
        .from(shoppingAgentFindings)
        .where(eq(shoppingAgentFindings.agentId, agentId)),
      'findings survived the erasure',
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: shoppingAgentAudits.id })
        .from(shoppingAgentAudits)
        .where(eq(shoppingAgentAudits.agentId, agentId)),
      'audits survived the erasure',
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: shoppingAgentNotifications.id })
        .from(shoppingAgentNotifications)
        .where(eq(shoppingAgentNotifications.agentId, agentId)),
      'notifications survived the erasure',
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: shoppingAgentFindingLines.id })
        .from(shoppingAgentFindingLines)
        .where(eq(shoppingAgentFindingLines.findingId, finding.id)),
      'finding lines survived the erasure',
    ).toHaveLength(0);
  }, 60_000);
});

describe('ACCEPTANCE 6 — a merge rehomes and a split BLOCKS', () => {
  it('a split marks the agent ambiguous AND blocks it, and a re-run is a no-op', async () => {
    const { agentId, productId } = await seedAgent('split');
    const targetId = await mintProduct('split-target');
    const splitJobId = await mintSplitJob(productId, targetId);

    const marked = await markShoppingAgentsAmbiguousAfterSplit({
      sourceCanonicalProductId: productId,
      splitJobId,
      targetCanonicalProductId: targetId,
    });
    expect(marked).toBe(1);

    const after = await findShoppingAgentById(agentId);
    expect(after?.ambiguityState).toBe('ambiguous_after_split');
    // `shopping_agents_ambiguity_blocked_check` is what makes this true rather
    // than remembered: an ambiguous agent that stayed `enabled` would go on
    // notifying about a product its owner may not have meant.
    expect(after?.state).toBe('blocked');

    // A resumed phase re-runs the same UPDATE and touches nothing.
    expect(
      await markShoppingAgentsAmbiguousAfterSplit({
        sourceCanonicalProductId: productId,
        splitJobId,
        targetCanonicalProductId: targetId,
      }),
    ).toBe(0);
  }, 60_000);

  it('an ambiguous agent that is not blocked is UNWRITABLE', async () => {
    const { agentId, productId } = await seedAgent('ambiguity-check');
    const targetId = await mintProduct('ambiguity-target');
    const splitJobId = await mintSplitJob(productId, targetId);

    const message = await rejectionMessage(() =>
      db
        .update(shoppingAgents)
        .set({ ambiguityState: 'ambiguous_after_split', splitJobId, state: 'enabled' })
        .where(eq(shoppingAgents.id, agentId)),
    );
    expect(message).toContain('shopping_agents_ambiguity_blocked_check');
  }, 60_000);

  it('a merge STAMPS the provenance once, scoped to the loser', async () => {
    const { agentId, productId } = await seedAgent('rehome');
    expect(await stampShoppingAgentRehoming({ canonicalProductId: productId, now: new Date() })).toBe(
      1,
    );
    const stamped = await findShoppingAgentById(agentId);
    expect(stamped?.rehomedFromCanonicalProductId).toBe(productId);
    expect(stamped?.rehomedAt).not.toBeNull();

    // Idempotent by predicate: a resumed phase must not re-stamp, or "the
    // agents that just moved" stops being answerable.
    expect(await stampShoppingAgentRehoming({ canonicalProductId: productId, now: new Date() })).toBe(
      0,
    );
  }, 60_000);
});

describe('the CHECKs a mocked insert would accept', () => {
  it('a price-threshold agent MUST carry a target, and the others may not', async () => {
    const productId = await mintProduct('target-shape');
    const missing = await rejectionMessage(() =>
      insertShoppingAgent({
        agent: newAgent({ targetAmount: null, targetCurrency: null }),
        lines: [{ canonicalProductId: productId, quantity: 1, conditionGroups: [], position: 0 }],
      }),
    );
    expect(missing).toContain('shopping_agents_target_shape_check');

    const spurious = await rejectionMessage(() =>
      insertShoppingAgent({
        agent: newAgent({ kind: 'official_channel_availability' }),
        lines: [{ canonicalProductId: productId, quantity: 1, conditionGroups: [], position: 0 }],
      }),
    );
    expect(spurious).toContain('shopping_agents_target_shape_check');
  }, 60_000);

  it('an EMPTY trigger-source or channel array is refused — `cardinality`, not `array_length`', async () => {
    const productId = await mintProduct('cardinality');
    const noSources = await rejectionMessage(() =>
      insertShoppingAgent({
        agent: newAgent({ triggerSources: [] }),
        lines: [{ canonicalProductId: productId, quantity: 1, conditionGroups: [], position: 0 }],
      }),
    );
    expect(noSources).toContain('shopping_agents_trigger_sources_present_check');

    const noChannels = await rejectionMessage(() =>
      insertShoppingAgent({
        agent: newAgent({ notificationChannels: [] }),
        lines: [{ canonicalProductId: productId, quantity: 1, conditionGroups: [], position: 0 }],
      }),
    );
    expect(noChannels).toContain('shopping_agents_notification_channels_present_check');
    // The reason this case exists: `array_length(col, 1)` is NULL on an empty
    // array and a CHECK reads NULL as SATISFIED, so the obvious spelling would
    // have ADMITTED both rows above.
  }, 60_000);

  it('a scheduled agent carries an interval and an unscheduled one does not', async () => {
    const productId = await mintProduct('schedule');
    const missing = await rejectionMessage(() =>
      insertShoppingAgent({
        agent: newAgent({ triggerSources: ['scheduled'] }),
        lines: [{ canonicalProductId: productId, quantity: 1, conditionGroups: [], position: 0 }],
      }),
    );
    expect(missing).toContain('shopping_agents_schedule_shape_check');

    const spurious = await rejectionMessage(() =>
      insertShoppingAgent({
        agent: newAgent({ triggerSources: ['offer_change'], scheduleIntervalSeconds: 3_600 }),
        lines: [{ canonicalProductId: productId, quantity: 1, conditionGroups: [], position: 0 }],
      }),
    );
    expect(spurious).toContain('shopping_agents_schedule_shape_check');
  }, 60_000);

  it('a `system` audit names no account and an `owner` audit must', async () => {
    const { agentId } = await seedAgent('audit-actor');
    const message = await rejectionMessage(() =>
      recordShoppingAgentAudit({
        agentId,
        action: 'rehomed_by_merge',
        actor: 'system',
        actorOxyUserId: OWNER,
        agentRevision: 1,
      }),
    );
    expect(message).toContain('shopping_agent_audits_actor_shape_check');
  }, 60_000);
});

describe('the prior-comparable read is scoped and QUALIFIED-only', () => {
  it('reads this agent’s newest qualified finding and no sibling’s', async () => {
    const mine = await seedAgent('prior-mine');
    const theirs = await seedAgent('prior-theirs');

    await insertShoppingAgentFinding(
      newFinding(theirs.agentId, theirs.lineId, theirs.productId, { objectiveAmount: 11_111 }),
    );
    await insertShoppingAgentFinding(
      newFinding(mine.agentId, mine.lineId, mine.productId, {
        outcome: 'incomplete',
        incompleteReasons: ['no_eligible_offer'],
        completeness: 'partial',
        objectiveAmount: null,
        objectiveCurrency: null,
        inputDigest: `digest-${RUN}-a`,
        evaluationKey: `${mine.agentId}|1|digest-${RUN}-a|${SHOPPING_AGENT_POLICY_VERSION}`,
      }),
    );
    await insertShoppingAgentFinding(
      newFinding(mine.agentId, mine.lineId, mine.productId, {
        objectiveAmount: 22_222,
        inputDigest: `digest-${RUN}-b`,
        evaluationKey: `${mine.agentId}|1|digest-${RUN}-b|${SHOPPING_AGENT_POLICY_VERSION}`,
      }),
    );

    const prior = await findLatestQualifiedFinding(mine.agentId);
    expect(prior?.objectiveAmount).toBe(22_222);
  }, 60_000);
});

/* ────────────────────────────────────────────────────────────────────────── */

/** A split job to hang an ambiguity on. Only the FK target matters here. */
async function mintSplitJob(sourceId: string, targetId: string): Promise<string> {
  const [job] = await db
    .insert(catalogSplitJobs)
    .values({
      entityType: 'canonical_product',
      sourceEntityId: sourceId,
      // `revive_tombstone` rather than `new_entity`: `catalog_split_jobs_target_shape_check`
      // requires a slug and a name for a new entity and forbids a target id,
      // and the fixture needs the id — the ambiguity a split leaves NAMES the
      // other candidate, which is what a shopper is being asked to choose from.
      targetMode: 'revive_tombstone',
      targetEntityId: targetId,
      reason: `a realdb fixture ${RUN}`,
      requestedByOxyUserId: `operator-${RUN}`,
      // `jobRuntimeColumns()` requires a claim deadline; a fixture job is never
      // claimed, and a NULL here would be a job the dispatcher's own index
      // cannot order.
      availableAt: new Date(),
    })
    .returning({ id: catalogSplitJobs.id });
  if (!job) throw new Error('the split job was not written');
  createdSplitJobIds.push(job.id);
  return job.id;
}
