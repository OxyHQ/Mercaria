/**
 * `shopping_agents` and `shopping_agent_lines` — one shopper's own saved
 * objective, and the things it watches (#97).
 *
 * ## Every owner-facing read carries `oxy_user_id` IN THE STATEMENT
 *
 * {@link findShoppingAgentForOwner} takes the owner as a PREDICATE rather than
 * fetching by id and comparing afterwards, so a service that forgets the check
 * cannot exist: there is no function here that returns an owner's agent by id
 * alone. An id belonging to somebody else is therefore a 404 and not a 403 — the
 * id is opaque, and a distinguishable answer would confirm that a stranger's
 * agent exists.
 *
 * {@link findShoppingAgentById} is a SEPARATE function rather than an optional
 * owner parameter, and that is #79's `findPriceAlertForOwner` /
 * `findPriceAlertById` split verbatim: an owner argument that can be omitted is
 * one a caller forgets, while a second function has to be reached for. Its
 * callers are the leased dispatcher and the notification composer, and it DOES
 * return a `deleted` agent — a queued delivery naming one has to be able to say
 * `agent_deleted` rather than fail on a missing row.
 *
 * ## The description is read only where a caller NAMES it
 *
 * `shopping_agents.description` is in `PROTECTED_COLUMNS` (#97 privacy 3 and 5),
 * so {@link PUBLIC_AGENT_COLUMNS} withholds it at runtime AND at the type level.
 * Every read here except {@link findShoppingAgentForOwner} therefore CANNOT carry
 * one — including the evaluation's own read, which is the path that composes a
 * summary package for a model provider. The owner's own DETAIL read asks for it
 * explicitly ({@link OWNER_AGENT_COLUMNS}), which is what the registry's opt-in
 * is for and what makes that one read visibly different from every other. The
 * owner's LIST deliberately does not: a list renders a name, a kind and a state,
 * and carrying a private note on every card would make the cheapest, most-called
 * read the widest disclosure surface in the domain.
 *
 * ## An agent and its lines commit together
 *
 * {@link insertShoppingAgent} writes both inside ONE transaction. An agent with
 * no line is not a state anything should observe — the fan-out finds agents
 * THROUGH their lines, so a lineless agent is one nothing can ever evaluate and
 * nothing repairs.
 *
 * ## There is deliberately no "who is watching this product" read
 *
 * {@link listEvaluableShoppingAgentIdsForProduct} exists because the fan-out must
 * have it, and it returns IDS to a worker inside the process. Nothing else reads
 * by product, no route reaches it, and no function here takes a merchant or a
 * storefront at all — #97 privacy 3, held by the absence of the function rather
 * than by a filter somebody has to remember.
 */

import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { publicColumns } from '@oxyhq/db/assert';
import type {
  ConditionGroup,
  ConstraintSet,
  CurrencyCode,
  ShoppingAgentChannelPolicy,
  ShoppingAgentJobKind,
  ShoppingAgentNotificationChannel,
  ShoppingAgentPriceBasis,
  ShoppingAgentSplitResolution,
  ShoppingAgentState,
  ShoppingAgentTriggerSource,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import { shoppingAgentLines, shoppingAgents } from '../schema/shoppingAgents.js';

/** One row of `shopping_agents`, description included. The owner's own read. */
export type ShoppingAgentRow = InferSelectModel<typeof shoppingAgents>;

/** The same row WITHOUT the description — what every other read is handed. */
export type ShoppingAgentFactsRow = Omit<ShoppingAgentRow, 'description'>;

/** One watched line. Nothing on this table is protected. */
export type ShoppingAgentLineRow = InferSelectModel<typeof shoppingAgentLines>;

/**
 * Everything but the description — the evaluation's read, the dispatcher's, and
 * the owner's own list.
 */
const PUBLIC_AGENT_COLUMNS = publicColumns(shoppingAgents, PROTECTED_COLUMNS);

/**
 * Every column INCLUDING the description, named explicitly.
 *
 * The owner legitimately reads their own note back, and the protected registry's
 * rule is that such a path NAMES what it wants — a bare
 * `.select().from(shoppingAgents)` is refused by `schema-conventions.test.ts`'s
 * implicit-whole-row gate precisely so this choice is visible in a diff rather
 * than inherited by every later read that copies the line above it.
 */
const OWNER_AGENT_COLUMNS = {
  id: shoppingAgents.id,
  oxyUserId: shoppingAgents.oxyUserId,
  kind: shoppingAgents.kind,
  name: shoppingAgents.name,
  description: shoppingAgents.description,
  state: shoppingAgents.state,
  revision: shoppingAgents.revision,
  displayCurrency: shoppingAgents.displayCurrency,
  priceBasis: shoppingAgents.priceBasis,
  channelPolicy: shoppingAgents.channelPolicy,
  market: shoppingAgents.market,
  conditionGroups: shoppingAgents.conditionGroups,
  excludedMerchantIds: shoppingAgents.excludedMerchantIds,
  targetAmount: shoppingAgents.targetAmount,
  targetCurrency: shoppingAgents.targetCurrency,
  constraintSet: shoppingAgents.constraintSet,
  constraintDigest: shoppingAgents.constraintDigest,
  triggerSources: shoppingAgents.triggerSources,
  scheduleIntervalSeconds: shoppingAgents.scheduleIntervalSeconds,
  nextScheduledAt: shoppingAgents.nextScheduledAt,
  notificationChannels: shoppingAgents.notificationChannels,
  cooldownSeconds: shoppingAgents.cooldownSeconds,
  quietHoursStartMinute: shoppingAgents.quietHoursStartMinute,
  quietHoursEndMinute: shoppingAgents.quietHoursEndMinute,
  quietHoursTimeZone: shoppingAgents.quietHoursTimeZone,
  locale: shoppingAgents.locale,
  ambiguityState: shoppingAgents.ambiguityState,
  splitJobId: shoppingAgents.splitJobId,
  splitTargetCanonicalProductId: shoppingAgents.splitTargetCanonicalProductId,
  rehomedFromCanonicalProductId: shoppingAgents.rehomedFromCanonicalProductId,
  rehomedAt: shoppingAgents.rehomedAt,
  authorizedAt: shoppingAgents.authorizedAt,
  termsVersion: shoppingAgents.termsVersion,
  agentPolicyVersion: shoppingAgents.agentPolicyVersion,
  constraintEvaluationVersion: shoppingAgents.constraintEvaluationVersion,
  normalizationRuleVersion: shoppingAgents.normalizationRuleVersion,
  comparisonPolicyVersion: shoppingAgents.comparisonPolicyVersion,
  parserVersion: shoppingAgents.parserVersion,
  lastEvaluatedAt: shoppingAgents.lastEvaluatedAt,
  lastNotifiedAt: shoppingAgents.lastNotifiedAt,
  lastNotifiedAmount: shoppingAgents.lastNotifiedAmount,
  createdAt: shoppingAgents.createdAt,
  updatedAt: shoppingAgents.updatedAt,
} as const;

/**
 * Everything a shopper states when they save an agent.
 *
 * `state` is absent deliberately — a saved agent is `enabled`, and every later
 * move through the lifecycle goes through {@link setShoppingAgentState}, which
 * is where the ambiguity CHECK can refuse a resume nobody answered. `revision`
 * is absent for the same reason: it starts at 1 and only
 * {@link bumpShoppingAgentRevision} moves it.
 */
export interface NewShoppingAgent {
  readonly oxyUserId: string;
  readonly kind: ShoppingAgentJobKind;
  readonly name: string;
  readonly description?: string | null;
  readonly displayCurrency: CurrencyCode;
  readonly priceBasis: ShoppingAgentPriceBasis;
  readonly channelPolicy: ShoppingAgentChannelPolicy;
  readonly market?: string | null;
  readonly conditionGroups: readonly ConditionGroup[];
  readonly excludedMerchantIds: readonly string[];
  readonly targetAmount?: number | null;
  readonly targetCurrency?: CurrencyCode | null;
  readonly constraintSet: ConstraintSet;
  readonly constraintDigest: string;
  readonly triggerSources: readonly ShoppingAgentTriggerSource[];
  readonly scheduleIntervalSeconds?: number | null;
  readonly nextScheduledAt?: Date | null;
  readonly notificationChannels: readonly ShoppingAgentNotificationChannel[];
  readonly cooldownSeconds: number;
  readonly quietHoursStartMinute?: number | null;
  readonly quietHoursEndMinute?: number | null;
  readonly quietHoursTimeZone?: string | null;
  readonly locale?: string | null;
  readonly authorizedAt: Date;
  readonly termsVersion: string;
  readonly agentPolicyVersion: string;
  readonly constraintEvaluationVersion: string;
  readonly normalizationRuleVersion: string;
  readonly comparisonPolicyVersion: string;
  readonly parserVersion?: string | null;
}

/** One thing the agent watches. `position` is the shopper's own ordering. */
export interface NewShoppingAgentLine {
  readonly canonicalProductId: string;
  readonly canonicalVariantId?: string | null;
  readonly quantity: number;
  readonly conditionGroups: readonly ConditionGroup[];
  readonly merchantId?: string | null;
  readonly position: number;
}

/**
 * The columns a shopper's edit may change.
 *
 * `state`, `revision`, the ambiguity trio and the rehoming pair are all absent:
 * each belongs to a function whose predicate carries the invariant that makes it
 * safe, and a patch able to write any of them would be a way around all four.
 */
export interface ShoppingAgentPatch {
  readonly name?: string;
  readonly description?: string | null;
  readonly displayCurrency?: CurrencyCode;
  readonly priceBasis?: ShoppingAgentPriceBasis;
  readonly channelPolicy?: ShoppingAgentChannelPolicy;
  readonly market?: string | null;
  readonly conditionGroups?: readonly ConditionGroup[];
  readonly excludedMerchantIds?: readonly string[];
  readonly targetAmount?: number | null;
  readonly targetCurrency?: CurrencyCode | null;
  readonly constraintSet?: ConstraintSet;
  readonly constraintDigest?: string;
  readonly triggerSources?: readonly ShoppingAgentTriggerSource[];
  readonly scheduleIntervalSeconds?: number | null;
  readonly nextScheduledAt?: Date | null;
  readonly notificationChannels?: readonly ShoppingAgentNotificationChannel[];
  readonly cooldownSeconds?: number;
  readonly quietHoursStartMinute?: number | null;
  readonly quietHoursEndMinute?: number | null;
  readonly quietHoursTimeZone?: string | null;
  readonly locale?: string | null;
  readonly authorizedAt?: Date;
  readonly termsVersion?: string;
  readonly agentPolicyVersion?: string;
  readonly constraintEvaluationVersion?: string;
  readonly normalizationRuleVersion?: string;
  readonly comparisonPolicyVersion?: string;
  readonly parserVersion?: string | null;
}

/**
 * Save an agent and its lines, in ONE transaction.
 *
 * The handle is used as it arrives when it can already roll back, and a
 * transaction is opened when it cannot — `db/moderation/transactionGuard.ts`
 * states that discriminator and why a TYPE is not one: the root `Database` and a
 * transaction share `DatabaseOrTransaction`, so a caller that forgets the handle
 * compiles either way and only the runtime shape tells them apart.
 */
export async function insertShoppingAgent(
  input: {
    readonly agent: NewShoppingAgent;
    readonly lines: readonly NewShoppingAgentLine[];
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ShoppingAgentRow> {
  const write = async (tx: DatabaseOrTransaction): Promise<ShoppingAgentRow> => {
    const rows = await tx
      .insert(shoppingAgents)
      .values({
        oxyUserId: input.agent.oxyUserId,
        kind: input.agent.kind,
        name: input.agent.name,
        description: input.agent.description ?? null,
        state: 'enabled',
        revision: 1,
        displayCurrency: input.agent.displayCurrency,
        priceBasis: input.agent.priceBasis,
        channelPolicy: input.agent.channelPolicy,
        market: input.agent.market ?? null,
        conditionGroups: [...input.agent.conditionGroups],
        excludedMerchantIds: [...input.agent.excludedMerchantIds],
        targetAmount: input.agent.targetAmount ?? null,
        targetCurrency: input.agent.targetCurrency ?? null,
        constraintSet: input.agent.constraintSet,
        constraintDigest: input.agent.constraintDigest,
        triggerSources: [...input.agent.triggerSources],
        scheduleIntervalSeconds: input.agent.scheduleIntervalSeconds ?? null,
        nextScheduledAt: input.agent.nextScheduledAt ?? null,
        notificationChannels: [...input.agent.notificationChannels],
        cooldownSeconds: input.agent.cooldownSeconds,
        quietHoursStartMinute: input.agent.quietHoursStartMinute ?? null,
        quietHoursEndMinute: input.agent.quietHoursEndMinute ?? null,
        quietHoursTimeZone: input.agent.quietHoursTimeZone ?? null,
        locale: input.agent.locale ?? null,
        ambiguityState: 'resolved',
        authorizedAt: input.agent.authorizedAt,
        termsVersion: input.agent.termsVersion,
        agentPolicyVersion: input.agent.agentPolicyVersion,
        constraintEvaluationVersion: input.agent.constraintEvaluationVersion,
        normalizationRuleVersion: input.agent.normalizationRuleVersion,
        comparisonPolicyVersion: input.agent.comparisonPolicyVersion,
        parserVersion: input.agent.parserVersion ?? null,
      })
      .returning();

    const agent = rows[0];
    if (!agent) throw new Error('shopping_agents insert returned no row');

    if (input.lines.length > 0) {
      await tx.insert(shoppingAgentLines).values(
        input.lines.map((line) => ({
          agentId: agent.id,
          canonicalProductId: line.canonicalProductId,
          canonicalVariantId: line.canonicalVariantId ?? null,
          quantity: line.quantity,
          conditionGroups: [...line.conditionGroups],
          merchantId: line.merchantId ?? null,
          position: line.position,
        })),
      );
    }

    return agent;
  };

  const rollback: unknown = (db as { rollback?: unknown }).rollback;
  if (typeof rollback === 'function') return write(db);
  return db.transaction(write);
}

/**
 * One agent, SCOPED TO ITS OWNER, description included.
 *
 * The ONE read that returns the shopper's own private note. See the module
 * docblock for both halves of why.
 */
export async function findShoppingAgentForOwner(
  id: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ShoppingAgentRow | undefined> {
  const rows = await db
    .select(OWNER_AGENT_COLUMNS)
    .from(shoppingAgents)
    .where(
      and(
        eq(shoppingAgents.id, id),
        eq(shoppingAgents.oxyUserId, oxyUserId),
        ne(shoppingAgents.state, 'deleted'),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * One agent by id and NOTHING else — the dispatcher's read.
 *
 * Deliberately separate from {@link findShoppingAgentForOwner} rather than an
 * optional owner parameter, and it returns a `deleted` agent on purpose: a queued
 * notification naming one has to be able to record `agent_deleted` as the reason
 * it was withheld instead of failing on a missing row.
 */
export async function findShoppingAgentById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ShoppingAgentFactsRow | undefined> {
  const rows = await db
    .select(PUBLIC_AGENT_COLUMNS)
    .from(shoppingAgents)
    .where(eq(shoppingAgents.id, id))
    .limit(1);
  return rows[0];
}

/** A shopper's own list, newest first — keyset-free, because the cap is small. */
export async function listShoppingAgentsForOwner(
  oxyUserId: string,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<ShoppingAgentFactsRow[]> {
  return db
    .select(PUBLIC_AGENT_COLUMNS)
    .from(shoppingAgents)
    .where(and(eq(shoppingAgents.oxyUserId, oxyUserId), ne(shoppingAgents.state, 'deleted')))
    .orderBy(desc(shoppingAgents.createdAt), desc(shoppingAgents.id))
    .limit(limit);
}

/**
 * How many agents this account still holds — the per-user cap's basis.
 *
 * Counts every state a shopper can still see rather than only `enabled`: a
 * paused or blocked agent still occupies a slot and is still one the catalogue
 * has to be able to answer, and deleting one is how a slot is freed.
 */
export async function countActiveShoppingAgents(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(shoppingAgents)
    .where(and(eq(shoppingAgents.oxyUserId, oxyUserId), ne(shoppingAgents.state, 'deleted')));
  return rows[0]?.total ?? 0;
}

/** One agent's lines, in the shopper's own order. */
export async function listShoppingAgentLines(
  agentId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<ShoppingAgentLineRow[]> {
  return db
    .select()
    .from(shoppingAgentLines)
    .where(eq(shoppingAgentLines.agentId, agentId))
    .orderBy(asc(shoppingAgentLines.position), asc(shoppingAgentLines.id));
}

/**
 * Every agent worth evaluating for one product — the fan-out's read, and the ONE
 * read by product.
 *
 * Returns IDS and nothing else: a fan-out needs to know WHICH agents to enqueue,
 * and a function that answered with rows would be one call away from "who is
 * watching this product" with a shopper's own objective attached.
 *
 * `ambiguity_state = 'resolved'` is stated even though an ambiguous agent is
 * `blocked` by CHECK and therefore excluded by the state predicate already. The
 * duplication is deliberate: this read decides what gets evaluated, and it should
 * not depend on a constraint declared in another file staying exactly as it is.
 *
 * Ordered by id so a partially processed batch resumes in the same order.
 */
export async function listEvaluableShoppingAgentIdsForProduct(
  canonicalProductId: string,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ agentId: shoppingAgentLines.agentId })
    .from(shoppingAgentLines)
    .innerJoin(shoppingAgents, eq(shoppingAgents.id, shoppingAgentLines.agentId))
    .where(
      and(
        eq(shoppingAgentLines.canonicalProductId, canonicalProductId),
        eq(shoppingAgents.state, 'enabled'),
        eq(shoppingAgents.ambiguityState, 'resolved'),
      ),
    )
    .orderBy(asc(shoppingAgentLines.agentId))
    .limit(limit);
  return rows.map((row) => row.agentId);
}

/**
 * Apply a shopper's edit, scoped to its owner.
 *
 * Absent means "leave it alone", written as a conditional spread rather than by
 * handing drizzle an `undefined`: `$set: { x: undefined }` is a no-op in Mongo
 * and this domain's ancestors came from there, so the spelling that reads as
 * "leave it alone" and the spelling that WRITES NULL must never be the same one.
 */
export async function updateShoppingAgentColumns(
  id: string,
  oxyUserId: string,
  patch: ShoppingAgentPatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<ShoppingAgentRow | undefined> {
  const values = {
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.description === undefined ? {} : { description: patch.description }),
    ...(patch.displayCurrency === undefined ? {} : { displayCurrency: patch.displayCurrency }),
    ...(patch.priceBasis === undefined ? {} : { priceBasis: patch.priceBasis }),
    ...(patch.channelPolicy === undefined ? {} : { channelPolicy: patch.channelPolicy }),
    ...(patch.market === undefined ? {} : { market: patch.market }),
    ...(patch.conditionGroups === undefined ? {} : { conditionGroups: [...patch.conditionGroups] }),
    ...(patch.excludedMerchantIds === undefined
      ? {}
      : { excludedMerchantIds: [...patch.excludedMerchantIds] }),
    ...(patch.targetAmount === undefined ? {} : { targetAmount: patch.targetAmount }),
    ...(patch.targetCurrency === undefined ? {} : { targetCurrency: patch.targetCurrency }),
    ...(patch.constraintSet === undefined ? {} : { constraintSet: patch.constraintSet }),
    ...(patch.constraintDigest === undefined ? {} : { constraintDigest: patch.constraintDigest }),
    ...(patch.triggerSources === undefined ? {} : { triggerSources: [...patch.triggerSources] }),
    ...(patch.scheduleIntervalSeconds === undefined
      ? {}
      : { scheduleIntervalSeconds: patch.scheduleIntervalSeconds }),
    ...(patch.nextScheduledAt === undefined ? {} : { nextScheduledAt: patch.nextScheduledAt }),
    ...(patch.notificationChannels === undefined
      ? {}
      : { notificationChannels: [...patch.notificationChannels] }),
    ...(patch.cooldownSeconds === undefined ? {} : { cooldownSeconds: patch.cooldownSeconds }),
    ...(patch.quietHoursStartMinute === undefined
      ? {}
      : { quietHoursStartMinute: patch.quietHoursStartMinute }),
    ...(patch.quietHoursEndMinute === undefined
      ? {}
      : { quietHoursEndMinute: patch.quietHoursEndMinute }),
    ...(patch.quietHoursTimeZone === undefined
      ? {}
      : { quietHoursTimeZone: patch.quietHoursTimeZone }),
    ...(patch.locale === undefined ? {} : { locale: patch.locale }),
    ...(patch.authorizedAt === undefined ? {} : { authorizedAt: patch.authorizedAt }),
    ...(patch.termsVersion === undefined ? {} : { termsVersion: patch.termsVersion }),
    ...(patch.agentPolicyVersion === undefined
      ? {}
      : { agentPolicyVersion: patch.agentPolicyVersion }),
    ...(patch.constraintEvaluationVersion === undefined
      ? {}
      : { constraintEvaluationVersion: patch.constraintEvaluationVersion }),
    ...(patch.normalizationRuleVersion === undefined
      ? {}
      : { normalizationRuleVersion: patch.normalizationRuleVersion }),
    ...(patch.comparisonPolicyVersion === undefined
      ? {}
      : { comparisonPolicyVersion: patch.comparisonPolicyVersion }),
    ...(patch.parserVersion === undefined ? {} : { parserVersion: patch.parserVersion }),
  };

  if (Object.keys(values).length === 0) return findShoppingAgentForOwner(id, oxyUserId, db);

  const rows = await db
    .update(shoppingAgents)
    .set(values)
    .where(
      and(
        eq(shoppingAgents.id, id),
        eq(shoppingAgents.oxyUserId, oxyUserId),
        ne(shoppingAgents.state, 'deleted'),
      ),
    )
    .returning(OWNER_AGENT_COLUMNS);
  return rows[0];
}

/**
 * A MATERIAL edit happened — the agent is now a different question.
 *
 * `revision + 1` in SQL rather than a read-then-write: the revision is part of
 * the evaluation key, so two concurrent edits that both read `3` and both wrote
 * `4` would leave the second edit's findings colliding with the first's.
 *
 * Scoped to the owner in the same statement for the reason the reads are: a bump
 * on a stranger's agent silences an answer they were owed, and nothing about the
 * row afterwards would say it happened.
 *
 * @returns the new revision, or `undefined` when nothing matched.
 */
export async function bumpShoppingAgentRevision(
  id: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<number | undefined> {
  const rows = await db
    .update(shoppingAgents)
    .set({ revision: sql`${shoppingAgents.revision} + 1` })
    .where(
      and(
        eq(shoppingAgents.id, id),
        eq(shoppingAgents.oxyUserId, oxyUserId),
        ne(shoppingAgents.state, 'deleted'),
      ),
    )
    .returning({ revision: shoppingAgents.revision });
  return rows[0]?.revision;
}

/**
 * Stamp an evaluation, whatever it concluded.
 *
 * `nextScheduledAt` is applied only when the caller supplies one: a scheduled
 * agent's next run is computed from its own interval by the sweeper, and an
 * offer-driven evaluation must not move a schedule it knows nothing about.
 */
export async function recordShoppingAgentEvaluated(
  input: {
    readonly id: string;
    readonly now: Date;
    readonly nextScheduledAt?: Date | null;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(shoppingAgents)
    .set({
      lastEvaluatedAt: input.now,
      ...(input.nextScheduledAt === undefined ? {} : { nextScheduledAt: input.nextScheduledAt }),
    })
    .where(eq(shoppingAgents.id, input.id));
}

/**
 * Record that the shopper was actually told something.
 *
 * The amount is written even when it is ABSENT, and that is the load-bearing
 * half: `last_notified_amount` is the basis the material-improvement rule
 * compares against, so a qualifying observation carrying no number (an official
 * channel opening, say) must CLEAR it rather than leaving an older figure
 * standing. Leaving it would make the next comparison measure against something
 * this shopper was never told.
 */
export async function recordShoppingAgentNotified(
  input: {
    readonly id: string;
    readonly amountMinor?: number | null;
    readonly now: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(shoppingAgents)
    .set({ lastNotifiedAt: input.now, lastNotifiedAmount: input.amountMinor ?? null })
    .where(eq(shoppingAgents.id, input.id));
}

/**
 * Move an agent through its lifecycle — pause, resume, complete, delete.
 *
 * Deleting is a STATE and not a row removal: a queued notification names the
 * agent and must be able to say `agent_deleted`, and a repeat delete converges
 * rather than 404ing. A row is only genuinely removed by an erasure, which
 * cascades everything else here.
 *
 * An `ambiguous_after_split` agent cannot be resumed through this function, and
 * the refusal is the DATABASE's: `shopping_agents_ambiguity_blocked_check` holds
 * such an agent to `blocked`, so a write moving it to `enabled` raises rather
 * than quietly re-arming an agent whose subject nobody has picked.
 * {@link resolveShoppingAgentSplit} is the answer.
 */
export async function setShoppingAgentState(
  input: {
    readonly id: string;
    readonly oxyUserId: string;
    readonly state: ShoppingAgentState;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(shoppingAgents)
    .set({ state: input.state })
    .where(
      and(
        eq(shoppingAgents.id, input.id),
        eq(shoppingAgents.oxyUserId, input.oxyUserId),
        ne(shoppingAgents.state, 'deleted'),
      ),
    )
    .returning({ id: shoppingAgents.id });
  return rows.length === 1;
}

/**
 * A product MERGE is about to move these agents' lines — stamp where they came
 * FROM (#59 merge invariant 2).
 *
 * Runs BEFORE the generic rehomer and is scoped to the LOSER through a subquery
 * over the agent's own lines, which is the whole reason it exists: the rehomer
 * sets a line's product to the WINNER's id and knows nothing about provenance, so
 * a stamp applied afterwards would have to find "the agents on the winner that
 * just moved" — indistinguishable from the ones that were always there.
 *
 * Idempotent by PREDICATE: after the move no line points at the loser, so a
 * resumed phase re-runs it as a no-op. The `is null` guard additionally keeps a
 * SECOND merge from overwriting the first hop of a chain, which is the one a
 * shopper would recognise.
 *
 * @returns how many agents were stamped.
 */
export async function stampShoppingAgentRehoming(
  input: { readonly canonicalProductId: string; readonly now: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .update(shoppingAgents)
    .set({ rehomedFromCanonicalProductId: input.canonicalProductId, rehomedAt: input.now })
    .where(
      and(
        isNull(shoppingAgents.rehomedAt),
        sql`exists (
          select 1 from ${shoppingAgentLines}
          where ${shoppingAgentLines.agentId} = ${shoppingAgents.id}
            and ${shoppingAgentLines.canonicalProductId} = ${input.canonicalProductId}
        )`,
      ),
    )
    .returning({ id: shoppingAgents.id });
  return rows.length;
}

/**
 * A product SPLIT divided one of this agent's lines — BLOCK it and mark it (#59
 * split invariant 3).
 *
 * `state: 'blocked'` is not decoration: `shopping_agents_ambiguity_blocked_check`
 * requires it, and the shopper requires it more — an ambiguous agent that kept
 * evaluating would go on notifying them, on its own schedule, about a product
 * they may not have meant, for as long as nobody looked.
 *
 * Idempotent by PREDICATE and not by a phase record: only `resolved` agents are
 * touched, so a resumed job re-runs it as a no-op AND an agent already made
 * ambiguous by an EARLIER split keeps naming that earlier job. Retargeting an
 * unanswered question at a newer job would destroy the pair of candidates the
 * shopper was being asked about.
 *
 * `deleted` agents are excluded: somebody who removed an agent is not owed a
 * question about it.
 */
export async function markShoppingAgentsAmbiguousAfterSplit(
  input: {
    readonly sourceCanonicalProductId: string;
    readonly splitJobId: string;
    readonly targetCanonicalProductId?: string | null;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .update(shoppingAgents)
    .set({
      ambiguityState: 'ambiguous_after_split',
      splitJobId: input.splitJobId,
      splitTargetCanonicalProductId: input.targetCanonicalProductId ?? null,
      state: 'blocked',
    })
    .where(
      and(
        eq(shoppingAgents.ambiguityState, 'resolved'),
        ne(shoppingAgents.state, 'deleted'),
        sql`exists (
          select 1 from ${shoppingAgentLines}
          where ${shoppingAgentLines.agentId} = ${shoppingAgents.id}
            and ${shoppingAgentLines.canonicalProductId} = ${input.sourceCanonicalProductId}
        )`,
      ),
    )
    .returning({ id: shoppingAgents.id });
  return rows.length;
}

/**
 * The shopper's answer to a split ambiguity.
 *
 * The CAS on "still ambiguous" runs FIRST and is the serialization point: two
 * answers from two devices converge on one, and only the winner moves any line.
 * Moving the lines first and clearing afterwards would let a loser repoint a
 * subject the winner had already decided.
 *
 * `move_to_target` repoints only the lines that pointed at the SOURCE product,
 * and clears each one's variant preference: a configuration named before the
 * split may have stayed on the other side, and a preference silently naming a
 * variant of a product the line no longer watches matches nothing.
 *
 * @returns the resolved agent, or `undefined` when it was not this owner's, was
 * not ambiguous, or somebody answered first.
 */
export async function resolveShoppingAgentSplit(
  input: {
    readonly id: string;
    readonly oxyUserId: string;
    readonly sourceCanonicalProductId: string;
    readonly resolution: ShoppingAgentSplitResolution;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ShoppingAgentRow | undefined> {
  const current = await findShoppingAgentForOwner(input.id, input.oxyUserId, db);
  if (!current) return undefined;
  if (current.ambiguityState !== 'ambiguous_after_split') return undefined;

  const target = current.splitTargetCanonicalProductId;
  if (input.resolution === 'move_to_target' && target === null) return undefined;

  const rows = await db
    .update(shoppingAgents)
    .set({
      ambiguityState: 'resolved',
      splitJobId: null,
      splitTargetCanonicalProductId: null,
      state: 'enabled',
    })
    .where(
      and(
        eq(shoppingAgents.id, input.id),
        eq(shoppingAgents.oxyUserId, input.oxyUserId),
        eq(shoppingAgents.ambiguityState, 'ambiguous_after_split'),
      ),
    )
    .returning(OWNER_AGENT_COLUMNS);

  const resolved = rows[0];
  if (!resolved) return undefined;

  if (input.resolution === 'move_to_target' && target !== null) {
    await db
      .update(shoppingAgentLines)
      .set({ canonicalProductId: target, canonicalVariantId: null })
      .where(
        and(
          eq(shoppingAgentLines.agentId, input.id),
          eq(shoppingAgentLines.canonicalProductId, input.sourceCanonicalProductId),
        ),
      );
  }

  return resolved;
}
