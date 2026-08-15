/**
 * The shopper's own surface (#97 §"Explicit authorization and privacy").
 *
 * Every function here is OWNER-SCOPED in the STATEMENT rather than by a filter
 * afterwards, and every material act writes an audit row in the same
 * transaction as the change it records (#97 privacy 7).
 *
 * ## Creating an agent is a DELIBERATE act and the shape says so
 *
 * #97 privacy 2 — "do not create agents from ordinary searches, saves or
 * watchlists without a deliberate user action" — is held by the signature:
 * {@link createShoppingAgent} takes a `constraintDigest` the client must have
 * computed from what it RENDERED, and refuses when it does not match what was
 * submitted. No search, save or watchlist path can produce one by accident,
 * because producing one means having shown a person the interpretation and
 * taken their answer.
 *
 * ## An edit is a NEW question
 *
 * A material edit bumps `revision`, which is part of the evaluation key — so
 * the answer to the old question can never silence the new one, and the edited
 * agent is evaluated afresh rather than converging on a finding about something
 * else. Non-material edits (a name, a note) do not bump it, because renaming an
 * agent does not change what it asks.
 */

import {
  MAX_SHOPPING_AGENT_LINES,
  SHOPPING_AGENT_POLICY_VERSION,
  SHOPPING_AGENT_TERMS_VERSION,
  CONSTRAINT_EVALUATION_VERSION,
  COMPARISON_POLICY_VERSION,
  NORMALIZATION_RULE_VERSION,
  isSupportedShoppingAgentTimeZone,
  type ConditionGroup,
  type ConstraintSet,
  type CurrencyCode,
  type ShoppingAgent,
  type ShoppingAgentChannelPolicy,
  type ShoppingAgentJobKind,
  type ShoppingAgentNotificationChannel,
  type ShoppingAgentPriceBasis,
  type ShoppingAgentQuietHours,
  type ShoppingAgentSplitResolution,
  type ShoppingAgentTriggerSource,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getDb } from '../../db/postgres.js';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { validateConstraintSet } from '../attributes/constraint-validation.js';
import {
  bumpShoppingAgentRevision,
  countActiveShoppingAgents,
  findShoppingAgentForOwner,
  insertShoppingAgent,
  listShoppingAgentLines,
  listShoppingAgentsForOwner,
  resolveShoppingAgentSplit,
  setShoppingAgentState,
  updateShoppingAgentColumns,
  type NewShoppingAgentLine,
} from '../../db/shoppingAgents/shoppingAgentRepository.js';
import { recordShoppingAgentAudit } from '../../db/shoppingAgents/shoppingAgentAuditRepository.js';
import { requestShoppingAgentEvaluation } from '../../db/shoppingAgents/shoppingAgentEvaluationRepository.js';
import { shoppingAgentAuthorizationMatches } from './authorization.js';
import { toShoppingAgentDTO } from './projection.js';

export interface CreateShoppingAgentInput {
  readonly oxyUserId: string;
  readonly kind: ShoppingAgentJobKind;
  readonly name: string;
  readonly description?: string;
  readonly displayCurrency: CurrencyCode;
  readonly priceBasis?: ShoppingAgentPriceBasis;
  readonly channelPolicy?: ShoppingAgentChannelPolicy;
  readonly market?: string;
  readonly conditionGroups?: readonly ConditionGroup[];
  readonly excludedMerchantIds?: readonly string[];
  readonly target?: { readonly amount: number; readonly currency: CurrencyCode };
  readonly lines: readonly {
    readonly canonicalProductId: string;
    readonly canonicalVariantId?: string;
    readonly quantity?: number;
    readonly conditionGroups?: readonly ConditionGroup[];
    readonly merchantId?: string;
  }[];
  readonly constraints: ConstraintSet;
  readonly constraintDigest: string;
  readonly triggerSources?: readonly ShoppingAgentTriggerSource[];
  readonly scheduleIntervalSeconds?: number;
  readonly notificationChannels?: readonly ShoppingAgentNotificationChannel[];
  readonly cooldownSeconds?: number;
  readonly quietHours?: ShoppingAgentQuietHours;
  readonly locale?: string;
}

/** The default policy a client that states none gets. */
const DEFAULT_COOLDOWN_SECONDS = 24 * 60 * 60;

export async function createShoppingAgent(
  input: CreateShoppingAgentInput,
): Promise<ShoppingAgent> {
  assertAuthorization(input.constraints, input.constraintDigest);
  assertQuietHours(input.quietHours);
  assertTargetShape(input.kind, input.target);
  if (input.lines.length > MAX_SHOPPING_AGENT_LINES) {
    throw validationError(`An agent watches at most ${String(MAX_SHOPPING_AGENT_LINES)} items`);
  }

  const active = await countActiveShoppingAgents(input.oxyUserId);
  if (active >= config.shoppingAgents.maxActivePerUser) {
    throw conflict(
      `You already have ${String(config.shoppingAgents.maxActivePerUser)} saved agents. Delete one to save another.`,
    );
  }

  // #94's own validator, before anything is stored: an agent whose constraints
  // the registry refuses would evaluate to `incomplete` forever, and a shopper
  // is entitled to be told at the moment they save it rather than never.
  const validation = await validateConstraintSet(getDb(), input.constraints);
  if (validation.valid !== true) {
    throw validationError(
      `Those requirements cannot be saved: ${validation.issues.map((issue) => issue.message).join(' ')}`,
    );
  }

  const triggerSources = input.triggerSources ?? ['offer_change'];
  const scheduled = triggerSources.includes('scheduled');
  const now = new Date();

  const lines: NewShoppingAgentLine[] = input.lines.map((line, position) => ({
    canonicalProductId: line.canonicalProductId,
    ...(line.canonicalVariantId === undefined
      ? {}
      : { canonicalVariantId: line.canonicalVariantId }),
    quantity: line.quantity ?? 1,
    conditionGroups: line.conditionGroups ?? [],
    ...(line.merchantId === undefined ? {} : { merchantId: line.merchantId }),
    position,
  }));

  const agent = await getDb().transaction(async (tx) => {
    const row = await insertShoppingAgent(
      {
        agent: {
          oxyUserId: input.oxyUserId,
          kind: input.kind,
          name: input.name,
          ...(input.description === undefined ? {} : { description: input.description }),
          displayCurrency: input.displayCurrency,
          priceBasis: input.priceBasis ?? 'item_price',
          channelPolicy: input.channelPolicy ?? 'mixed',
          ...(input.market === undefined ? {} : { market: input.market }),
          conditionGroups: input.conditionGroups ?? [],
          excludedMerchantIds: input.excludedMerchantIds ?? [],
          ...(input.target === undefined
            ? {}
            : { targetAmount: input.target.amount, targetCurrency: input.target.currency }),
          constraintSet: input.constraints,
          constraintDigest: input.constraintDigest,
          triggerSources,
          ...(scheduled
            ? {
                scheduleIntervalSeconds: input.scheduleIntervalSeconds ?? DEFAULT_COOLDOWN_SECONDS,
                nextScheduledAt: now,
              }
            : {}),
          notificationChannels: input.notificationChannels ?? ['oxy_notification'],
          cooldownSeconds: input.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS,
          ...(input.quietHours === undefined
            ? {}
            : {
                quietHoursStartMinute: input.quietHours.startMinute,
                quietHoursEndMinute: input.quietHours.endMinute,
                quietHoursTimeZone: input.quietHours.timeZone,
              }),
          ...(input.locale === undefined ? {} : { locale: input.locale }),
          authorizedAt: now,
          termsVersion: SHOPPING_AGENT_TERMS_VERSION,
          agentPolicyVersion: SHOPPING_AGENT_POLICY_VERSION,
          constraintEvaluationVersion: CONSTRAINT_EVALUATION_VERSION,
          normalizationRuleVersion: NORMALIZATION_RULE_VERSION,
          comparisonPolicyVersion: COMPARISON_POLICY_VERSION,
        },
        lines,
      },
      tx,
    );
    // Two rows, one act: creating an agent and recording that a person
    // authorized it are the same event, and a create that committed without its
    // audit would be exactly the unattributable agent #97 privacy 7 forbids.
    await recordShoppingAgentAudit(
      {
        agentId: row.id,
        action: 'created',
        actor: 'owner',
        actorOxyUserId: input.oxyUserId,
        agentRevision: row.revision,
      },
      tx,
    );
    await recordShoppingAgentAudit(
      {
        agentId: row.id,
        action: 'authorization_recorded',
        actor: 'owner',
        actorOxyUserId: input.oxyUserId,
        agentRevision: row.revision,
        detail: SHOPPING_AGENT_TERMS_VERSION,
      },
      tx,
    );
    return row;
  });

  // The first evaluation is requested AFTER the commit, deliberately: the queue
  // row is a convergence and re-requesting it is free, while a failure to
  // enqueue must not roll back an agent a person just authorized.
  await requestShoppingAgentEvaluation({ agentId: agent.id, triggerSource: 'manual' });

  return toShoppingAgentDTO(agent, await listShoppingAgentLines(agent.id));
}

/** The owner's own list, newest first. */
export async function listShoppingAgents(
  oxyUserId: string,
  limit = 50,
): Promise<readonly ShoppingAgent[]> {
  const rows = await listShoppingAgentsForOwner(oxyUserId, limit);
  const projected: ShoppingAgent[] = [];
  for (const row of rows) {
    projected.push(toShoppingAgentDTO(row, await listShoppingAgentLines(row.id)));
  }
  return projected;
}

/** One agent, or a 404. Owner-scoped in the statement. */
export async function getShoppingAgent(
  oxyUserId: string,
  agentId: string,
): Promise<ShoppingAgent> {
  const row = await requireOwnedShoppingAgent(oxyUserId, agentId);
  return toShoppingAgentDTO(row, await listShoppingAgentLines(row.id));
}

export interface UpdateShoppingAgentInput {
  readonly name?: string;
  readonly description?: string;
  readonly state?: 'enabled' | 'paused';
  readonly cooldownSeconds?: number;
  readonly quietHours?: ShoppingAgentQuietHours;
  readonly locale?: string;
  readonly notificationChannels?: readonly ShoppingAgentNotificationChannel[];
  readonly constraints?: ConstraintSet;
  readonly constraintDigest?: string;
}

/**
 * Edit an agent through the same validated contract it was created with
 * (#97 UX 6).
 *
 * A constraint edit REQUIRES a fresh digest — the same confirmation the create
 * demanded, for the same reason: an edit is the other moment an interpretation
 * is put in front of somebody, and accepting one without it would make the
 * confirmation a thing that happens once.
 */
export async function updateShoppingAgent(
  oxyUserId: string,
  agentId: string,
  input: UpdateShoppingAgentInput,
): Promise<ShoppingAgent> {
  const existing = await requireOwnedShoppingAgent(oxyUserId, agentId);
  if (existing.state === 'blocked') {
    throw conflict(
      'This agent is waiting for you to say which product it should follow after a catalogue change.',
    );
  }
  assertQuietHours(input.quietHours);

  const material = input.constraints !== undefined;
  if (material) {
    if (input.constraintDigest === undefined) {
      throw validationError('Changing what an agent looks for needs a fresh confirmation');
    }
    assertAuthorization(input.constraints, input.constraintDigest);
    const validation = await validateConstraintSet(getDb(), input.constraints);
    if (validation.valid !== true) {
      throw validationError(
        `Those requirements cannot be saved: ${validation.issues.map((issue) => issue.message).join(' ')}`,
      );
    }
  }

  const updated = await getDb().transaction(async (tx) => {
    // The STATE and the REVISION are moved by their own writers, deliberately:
    // `ShoppingAgentPatch` carries neither, so a patch object built from a
    // request body has no shape in which either could arrive. That is what
    // stops a client typing `enabled` over a blocked agent, and what stops an
    // edit forgetting to make itself a new question.
    if (input.state !== undefined) {
      await setShoppingAgentState({ id: agentId, oxyUserId, state: input.state }, tx);
    }
    if (material) {
      await bumpShoppingAgentRevision(agentId, oxyUserId, tx);
    }
    const row = await updateShoppingAgentColumns(
      agentId,
      oxyUserId,
      {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.cooldownSeconds === undefined
          ? {}
          : { cooldownSeconds: input.cooldownSeconds }),
        ...(input.locale === undefined ? {} : { locale: input.locale }),
        ...(input.notificationChannels === undefined
          ? {}
          : { notificationChannels: input.notificationChannels }),
        ...(input.quietHours === undefined
          ? {}
          : {
              quietHoursStartMinute: input.quietHours.startMinute,
              quietHoursEndMinute: input.quietHours.endMinute,
              quietHoursTimeZone: input.quietHours.timeZone,
            }),
        ...(input.constraints === undefined || input.constraintDigest === undefined
          ? {}
          : {
              constraintSet: input.constraints,
              constraintDigest: input.constraintDigest,
              // #97 model 12: a re-confirmed set is a fresh authorization.
              authorizedAt: new Date(),
            }),
      },
      tx,
    );
    if (row === undefined) throw notFound('Agent not found');

    await recordShoppingAgentAudit(
      {
        agentId,
        action: material
          ? 'constraints_edited'
          : input.state === 'paused'
            ? 'paused'
            : input.state === 'enabled'
              ? 'resumed'
              : 'policy_edited',
        actor: 'owner',
        actorOxyUserId: oxyUserId,
        agentRevision: row.revision,
      },
      tx,
    );
    return row;
  });

  if (material || input.state === 'enabled') {
    await requestShoppingAgentEvaluation({ agentId, triggerSource: 'manual' });
  }
  return toShoppingAgentDTO(updated, await listShoppingAgentLines(agentId));
}

/**
 * Delete an agent.
 *
 * A soft delete: the state moves to `deleted`, the agent leaves every list and
 * every evaluation, and the row survives so its audit trail and its findings
 * remain readable to the one person entitled to them. A hard erasure is one
 * scoped DELETE that cascades — the `product_saves` posture — and it belongs to
 * the account-deletion path rather than to a button on a list.
 */
export async function deleteShoppingAgent(oxyUserId: string, agentId: string): Promise<void> {
  const existing = await requireOwnedShoppingAgent(oxyUserId, agentId);
  await getDb().transaction(async (tx) => {
    await setShoppingAgentState({ id: agentId, oxyUserId, state: 'deleted' }, tx);
    await recordShoppingAgentAudit(
      {
        agentId,
        action: 'deleted',
        actor: 'owner',
        actorOxyUserId: oxyUserId,
        agentRevision: existing.revision,
      },
      tx,
    );
  });
}

/** Ask for one more evaluation now (#97 model 7, UX 5). */
export async function requestShoppingAgentRun(
  oxyUserId: string,
  agentId: string,
): Promise<void> {
  const existing = await requireOwnedShoppingAgent(oxyUserId, agentId);
  if (existing.state !== 'enabled') {
    throw conflict('Only an active agent can be run.');
  }
  await getDb().transaction(async (tx) => {
    await recordShoppingAgentAudit(
      {
        agentId,
        action: 'manual_run_requested',
        actor: 'owner',
        actorOxyUserId: oxyUserId,
        agentRevision: existing.revision,
      },
      tx,
    );
    await requestShoppingAgentEvaluation({ agentId, triggerSource: 'manual' }, tx);
  });
}

/**
 * Answer the question a catalogue split asked (#97 evaluation 8).
 *
 * The only way out of `blocked`, deliberately: a client able to write
 * `state: 'enabled'` over a blocked agent would walk around the ambiguity
 * rather than resolve it, and the agent would resume watching a product its
 * owner may not have meant.
 */
export async function resolveShoppingAgentSplitChoice(
  oxyUserId: string,
  agentId: string,
  resolution: ShoppingAgentSplitResolution,
): Promise<ShoppingAgent> {
  const existing = await requireOwnedShoppingAgent(oxyUserId, agentId);
  if (existing.ambiguityState !== 'ambiguous_after_split') {
    throw conflict('This agent has nothing to resolve.');
  }

  // The SOURCE is the product the agent's lines still point at — a split moves
  // nothing until this answer arrives, so a line's current product IS the side
  // it was left on. Read here rather than stored on the agent: two columns
  // naming one product would be two answers the moment a merge repoints one.
  const lines = await listShoppingAgentLines(agentId);
  const sourceCanonicalProductId = lines[0]?.canonicalProductId;
  if (sourceCanonicalProductId === undefined) {
    throw conflict('This agent has nothing left to follow.');
  }

  const updated = await getDb().transaction(async (tx) => {
    const row = await resolveShoppingAgentSplit(
      { id: agentId, oxyUserId, sourceCanonicalProductId, resolution },
      tx,
    );
    if (row === undefined) throw notFound('Agent not found');
    await recordShoppingAgentAudit(
      {
        agentId,
        action: 'split_resolved',
        actor: 'owner',
        actorOxyUserId: oxyUserId,
        agentRevision: row.revision,
        detail: resolution,
      },
      tx,
    );
    return row;
  });

  await requestShoppingAgentEvaluation({ agentId, triggerSource: 'manual' });
  return toShoppingAgentDTO(updated, await listShoppingAgentLines(agentId));
}

/* ────────────────────────────────────────────────────────────────────────── */

/** One agent this account owns, or a 404. Never a 403 — see `guest-portal`. */
export async function requireOwnedShoppingAgent(oxyUserId: string, agentId: string) {
  const row = await findShoppingAgentForOwner(agentId, oxyUserId);
  if (row === undefined || row.state === 'deleted') throw notFound('Agent not found');
  return row;
}

function assertAuthorization(set: ConstraintSet, digest: string): void {
  if (shoppingAgentAuthorizationMatches(set, digest)) return;
  throw validationError(
    'The requirements you confirmed are not the ones that were submitted. Review them and try again.',
  );
}

function assertQuietHours(quietHours: ShoppingAgentQuietHours | undefined): void {
  if (quietHours === undefined) return;
  if (!isSupportedShoppingAgentTimeZone(quietHours.timeZone)) {
    throw validationError('That time zone is not one this server can resolve');
  }
}

/**
 * The two kinds that compare against a number carry one, and the other four do
 * not.
 *
 * Checked here as well as by `shopping_agents_target_shape_check`, because a
 * 400 naming the field is a better answer than a 500 naming a constraint.
 */
function assertTargetShape(
  kind: ShoppingAgentJobKind,
  target: { readonly amount: number } | undefined,
): void {
  const needsTarget = kind === 'offer_price_threshold' || kind === 'basket_target_total';
  if (needsTarget && target === undefined) {
    throw validationError('That kind of agent needs a target amount');
  }
  if (!needsTarget && target !== undefined) {
    throw validationError('That kind of agent does not compare against an amount');
  }
}
