/**
 * `condition_mapping_rulesets` + `condition_source_mappings` (#90 evidence rules
 * 5–6, migration rule 5).
 *
 * A source's own condition wording is mapped onto the taxonomy by RULES that
 * carry a version, and an offer records which version read its label. That is
 * what "external source mappings are versioned and can be corrected without
 * rewriting old observations" means in practice: correcting a rule publishes
 * v2, and the offers observed under v1 keep saying so until something re-reads
 * their source.
 *
 * ## The publish is a CAS, not a read-then-write
 *
 * `condition_mapping_rulesets_provider_active_key` is a partial unique on
 * `(provider) WHERE state = 'active'`, so two operators publishing concurrently
 * cannot both win. {@link publishRuleset} supersedes the incumbent and activates
 * the draft in ONE transaction, in that order, because the index would refuse
 * the reverse.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type { ConnectorProviderId, ItemConditionKey } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { conditionMappingRulesets, conditionSourceMappings } from '../schema/condition.js';

export type ConditionMappingRulesetRecord = InferSelectModel<typeof conditionMappingRulesets>;
export type ConditionSourceMappingRecord = InferSelectModel<typeof conditionSourceMappings>;

/** One label→key rule, as the writer supplies it. */
export interface NewConditionSourceMapping {
  sourceLabel: string;
  sourceLabelNormalized: string;
  conditionKey: ItemConditionKey;
  confidence: number;
}

/** Open a new DRAFT ruleset for a provider, one version above its highest. */
export async function createRulesetDraft(
  provider: ConnectorProviderId,
  note: string | null,
): Promise<ConditionMappingRulesetRecord> {
  return getDb().transaction(async (tx) => {
    const [highest] = await tx
      .select({ version: conditionMappingRulesets.version })
      .from(conditionMappingRulesets)
      .where(eq(conditionMappingRulesets.provider, provider))
      .orderBy(desc(conditionMappingRulesets.version))
      .limit(1);

    const [row] = await tx
      .insert(conditionMappingRulesets)
      .values({
        provider,
        version: (highest?.version ?? 0) + 1,
        state: 'draft',
        note,
      })
      .returning();

    if (!row) {
      throw new Error('Condition mapping ruleset insert returned no row');
    }
    return row;
  });
}

/** The active ruleset for a provider, or `undefined` when none is published. */
export async function findActiveRuleset(
  provider: ConnectorProviderId,
): Promise<ConditionMappingRulesetRecord | undefined> {
  const [row] = await getDb()
    .select()
    .from(conditionMappingRulesets)
    .where(
      and(
        eq(conditionMappingRulesets.provider, provider),
        eq(conditionMappingRulesets.state, 'active'),
      ),
    )
    .limit(1);
  return row;
}

/** One ruleset by id. */
export async function findRulesetById(
  id: string,
): Promise<ConditionMappingRulesetRecord | undefined> {
  const [row] = await getDb()
    .select()
    .from(conditionMappingRulesets)
    .where(eq(conditionMappingRulesets.id, id))
    .limit(1);
  return row;
}

/** Every ruleset for a provider, newest version first. */
export async function findRulesetsByProvider(
  provider: ConnectorProviderId,
): Promise<ConditionMappingRulesetRecord[]> {
  return getDb()
    .select()
    .from(conditionMappingRulesets)
    .where(eq(conditionMappingRulesets.provider, provider))
    .orderBy(desc(conditionMappingRulesets.version));
}

/**
 * Replace a DRAFT ruleset's rules.
 *
 * The `WHERE state = 'draft'` predicate is on the delete AND the caller checks
 * the ruleset's state first, which looks redundant and is not: the trigger that
 * freezes an active ruleset raises on the child table too, so a race between the
 * check and the write ends in a refusal rather than in a silently edited
 * published version.
 */
export async function replaceRulesetMappings(
  rulesetId: string,
  mappings: readonly NewConditionSourceMapping[],
): Promise<ConditionSourceMappingRecord[]> {
  return getDb().transaction(async (tx) => {
    await tx.delete(conditionSourceMappings).where(eq(conditionSourceMappings.rulesetId, rulesetId));

    if (mappings.length === 0) return [];

    return tx
      .insert(conditionSourceMappings)
      .values(mappings.map((mapping) => ({ rulesetId, ...mapping })))
      .returning();
  });
}

/**
 * Publish a draft: supersede the incumbent, then activate the draft.
 *
 * ONE transaction and that ORDER. The partial unique index permits exactly one
 * active row per provider, so activating first would be refused by the database
 * rather than by anything this function checks — which is the correct failure,
 * but a needlessly confusing one to read in a log.
 */
export async function publishRuleset(
  rulesetId: string,
  publishedByOxyUserId: string,
  publishedAt: Date,
): Promise<ConditionMappingRulesetRecord | undefined> {
  return getDb().transaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(conditionMappingRulesets)
      .where(
        and(
          eq(conditionMappingRulesets.id, rulesetId),
          eq(conditionMappingRulesets.state, 'draft'),
        ),
      )
      .for('update')
      .limit(1);

    if (!draft) return undefined;

    await tx
      .update(conditionMappingRulesets)
      .set({ state: 'superseded' })
      .where(
        and(
          eq(conditionMappingRulesets.provider, draft.provider),
          eq(conditionMappingRulesets.state, 'active'),
        ),
      );

    const [activated] = await tx
      .update(conditionMappingRulesets)
      .set({ state: 'active', publishedAt, publishedByOxyUserId })
      .where(eq(conditionMappingRulesets.id, rulesetId))
      .returning();

    return activated;
  });
}

/**
 * Look one normalized label up in one ruleset.
 *
 * Returns the rule WHATEVER its confidence, including below the floor. The
 * caller decides what may be done with it, because the floor is enforced by the
 * `offers` CHECKs and a repository that hid sub-floor rows would make the review
 * queue impossible to build.
 */
export async function findMappingForLabel(
  rulesetId: string,
  sourceLabelNormalized: string,
): Promise<ConditionSourceMappingRecord | undefined> {
  const [row] = await getDb()
    .select()
    .from(conditionSourceMappings)
    .where(
      and(
        eq(conditionSourceMappings.rulesetId, rulesetId),
        eq(conditionSourceMappings.sourceLabelNormalized, sourceLabelNormalized),
      ),
    )
    .limit(1);
  return row;
}

/** Every rule in one ruleset, alphabetically by the normalized label. */
export async function findMappingsByRuleset(
  rulesetId: string,
): Promise<ConditionSourceMappingRecord[]> {
  return getDb()
    .select()
    .from(conditionSourceMappings)
    .where(eq(conditionSourceMappings.rulesetId, rulesetId))
    .orderBy(asc(conditionSourceMappings.sourceLabelNormalized));
}

/** How many rules a ruleset holds — the operator list's summary column. */
export async function countMappingsByRuleset(rulesetId: string): Promise<number> {
  const [row] = await getDb()
    .select({ total: sql<number>`count(*)::int` })
    .from(conditionSourceMappings)
    .where(eq(conditionSourceMappings.rulesetId, rulesetId));
  return row?.total ?? 0;
}

/** Delete a DRAFT ruleset. An active or superseded one is refused by the trigger. */
export async function deleteRulesetDraft(
  tx: DatabaseOrTransaction,
  rulesetId: string,
): Promise<void> {
  await tx
    .delete(conditionMappingRulesets)
    .where(
      and(eq(conditionMappingRulesets.id, rulesetId), eq(conditionMappingRulesets.state, 'draft')),
    );
}
