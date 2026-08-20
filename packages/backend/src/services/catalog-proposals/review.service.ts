/**
 * The six operator actions ADR 0007 D9 names — approve, reject, request
 * information, merge into existing, redirect, defer (#367 step 6).
 *
 * This is the ONLY module in the domain that may write a catalogue table, and it
 * may write exactly one: `attribute_enum_values`, plus an alias for the
 * submitter's own spelling. `catalog-proposal-isolation.test.ts` scans the rest
 * of the domain for a catalogue write and fails the build on one, so "a merchant
 * proposal never becomes globally trusted data by being submitted" is a property
 * of the import graph rather than of anybody's discipline.
 *
 * ## Why approval MINTS one type and LINKS the other seven
 *
 * `CATALOG_PROPOSAL_MINTABLE_TYPES` has one member and
 * `CATALOG_PROPOSAL_LINK_ONLY_TYPES` has the other seven, each naming the surface
 * that owns creating one. That is the design and not a deferral.
 *
 * A controlled value is a row under an attribute definition an operator has
 * already drafted, reviewed and published; adding one moves no identity, is a
 * single idempotent insert, and the authoring cache already has a subject for it
 * (`attribute_values`) precisely because the controlled-value set is the one
 * thing that can still move under a live schema.
 *
 * A category carries a key and an ancestry behind a write chokepoint; a product
 * type is a versioned schema with a publication ritual; a brand, family, product
 * and variant are the canonical graph, with identity, alias and merge machinery
 * around every mint; an attribute definition is #94's registry with its own
 * version freeze. A second writer for any of them is exactly what those
 * chokepoints exist to refuse — and "the proposal surface may create one" is how
 * a second writer arrives wearing a reasonable name. So the operator creates the
 * entity where it is owned and MERGES the proposal into it, which is one of D9's
 * own six actions and leaves the record saying exactly what happened.
 *
 * ## Every action is one transaction, and every one appends an event
 *
 * The decision, whatever it mints, and its `catalog_review_events` row commit
 * together. A decision whose audit row committed separately is a decision nobody
 * can attribute, and `catalog_review_events` is append-only against UPDATE and
 * DELETE so nothing can add one afterwards that looks the same.
 */

import type {
  CatalogProposal,
  CatalogProposalApproval,
  CatalogProposalMerge,
  CatalogProposalRejectionReason,
  CatalogProposalState,
  CatalogProposalType,
} from '@mercaria/shared-types';
import {
  CATALOG_PROPOSAL_LINK_ONLY_TYPES,
  CATALOG_PROPOSAL_MINTABLE_TYPES,
  CATALOG_PROPOSAL_OPEN_STATES,
} from '@mercaria/shared-types';
import { conflict, forbidden, notFound, validationError } from '../../lib/errors/error-codes.js';
import { log } from '../../lib/logger.js';
import type { Database, DatabaseOrTransaction } from '../../db/postgres.js';
import {
  findAttributeDefinitionById,
  insertAttributeEnumValue,
  insertAttributeValueAlias,
  listAttributeEnumValues,
} from '../../db/attributes/definitionRepository.js';
import {
  draftAttributeDefinition,
  resolveActiveDefinition,
} from '../attributes/definition-registry.service.js';
import { buildNextVersionInput } from '../attributes/version-carry-forward.js';
import { bumpAuthoringSchemaInvalidation } from '../../db/catalogAuthoring/schemaInvalidationRepository.js';
import {
  insertProposal,
  insertReviewEvent,
  lockProposal,
  transitionProposal,
  type CatalogProposalRow,
} from '../../db/catalogProposals/proposalRepository.js';
import { projectProposal } from './projection.js';
import { normalizeProposalLabel } from './normalization.js';
import { runProposalBackfill } from './backfill.service.js';

/** Every operator action shares these. `reason` is mandatory — a decision is explained. */
export interface OperatorDecisionContext {
  readonly proposalId: string;
  readonly operatorOxyUserId: string;
}

/**
 * Approve a proposal, minting the concept it asked for.
 *
 * The `key` is the OPERATOR's and it is required. ADR 0007 D1 makes the machine
 * key identity, frozen after insert and cited by every seed, mapping and export —
 * so the one place it may be chosen is a request only an operator can make. The
 * submitter's label became `proposed_label` and is offered as the value's LABEL;
 * it never becomes the key in any code path, because
 * {@link CatalogProposalSubmission} has no field that could carry one.
 */
export async function approveProposal(
  db: Database,
  context: OperatorDecisionContext,
  approval: CatalogProposalApproval,
): Promise<CatalogProposal> {
  assertReason(approval.reason);
  const now = new Date();

  const proposal = await db.transaction(async (tx) => {
    const row = await requireOpenProposal(tx, context.proposalId, context.operatorOxyUserId);
    const resolvedEntityId = await mintForProposal(
      tx,
      row,
      approval,
      context.operatorOxyUserId,
    );
    const moved = await transitionProposal(tx, row.id, row.state, {
      toState: 'approved',
      decidedByOxyUserId: context.operatorOxyUserId,
      decidedAt: now,
      decisionReason: approval.reason,
      resolvedEntityId,
    });
    if (moved === null) throw conflict('This proposal changed while you were approving it.');
    await insertReviewEvent(tx, {
      proposalId: row.id,
      action: 'approved',
      actorKind: 'operator',
      actorOxyUserId: context.operatorOxyUserId,
      fromState: row.state,
      toState: 'approved',
      reason: approval.reason,
      at: now,
    });
    return moved;
  });

  await backfillAfterResolution(db, proposal, context.operatorOxyUserId);
  return projectProposal(proposal);
}

/**
 * Add a controlled value to a PUBLISHED attribute, by drafting version N+1 (#568).
 *
 * The published version is immutable and stays exactly as it is; the new version
 * carries its whole vocabulary forward (`buildNextVersionInput`, whose coverage
 * is censused against the drizzle table) and appends the approved value.
 *
 * ## Two things this deliberately does NOT do
 *
 * **It does not publish.** Activation is a separate, attributable operator step —
 * the pattern `fee_schedules`, `match_policy_versions` and the ranking policies
 * all follow. Publishing here would put a global, live schema change for every
 * store on the far end of a review queue, triggered implicitly by approving one
 * merchant's colour.
 *
 * **It does not bump `catalog_authoring_schema_invalidations`.** Nothing a
 * merchant can see has changed: the value lives in a draft version. Bumping
 * would make every ECS task recompose a schema that is identical, and would
 * assert a liveness the value does not have.
 *
 * So the approval is real and the value is not yet usable, which is exactly what
 * the caller's projection reports rather than hiding — `resolvedEntityId` names
 * the minted VALUE (unchanged in meaning from the draft path, and the id
 * `catalog_authoring_draft_values.value_enum_value_id` points at), and the
 * version is one join away through `attribute_definition_id`.
 */
async function mintIntoNextVersion(
  db: DatabaseOrTransaction,
  input: {
    readonly definitionKey: string;
    readonly key: string;
    readonly label: string;
    readonly aliases: readonly string[];
    readonly operatorOxyUserId: string;
  },
): Promise<string> {
  // The ACTIVE version, not the one the proposal named. A merchant may have
  // proposed against a version that has since been superseded, and carrying the
  // stale one forward would silently discard everything published since.
  const active = await resolveActiveDefinition(db, input.definitionKey);
  if (active === undefined) {
    throw conflict(
      `“${input.definitionKey}” has no active version to extend. Publish one, then approve this.`,
    );
  }
  if (active.enumValues.some((value) => value.value === input.key)) {
    throw conflict(
      `“${input.key}” is already a value of this attribute. Merge this proposal into it instead.`,
    );
  }

  const drafted = await draftAttributeDefinition(
    buildNextVersionInput(
      active,
      [{ value: input.key, label: input.label, aliases: input.aliases }],
      input.operatorOxyUserId,
    ),
    // The CALLER's transaction. `draftAttributeDefinition` opens its own when
    // given none, and doing that from inside `approveProposal`'s transaction is
    // the #59 merge-runner deadlock — a second connection writing rows this one
    // holds locks on, presenting as a hang with no error.
    db,
  );

  // Read the id back: the DTO carries values by `value`/`label`/`position` and
  // no id, and `resolvedEntityId` must name the row itself.
  const minted = (await listAttributeEnumValues(db, [drafted.id])).find(
    (value) => value.value === input.key,
  );
  if (minted === undefined) {
    throw new Error(
      `Drafted ${input.definitionKey} v${drafted.version} without the approved value “${input.key}”.`,
    );
  }
  return minted.id;
}

/**
 * Mint the entity a proposal asked for, or refuse and name the surface that owns
 * it.
 *
 * The `switch` is total over `CatalogProposalType`, so adding a proposal type
 * fails `tsc` here until somebody decides whether it may be minted — instead of
 * falling into a default that either refuses everything new or, far worse, mints
 * it through a path nobody reviewed.
 */
async function mintForProposal(
  db: DatabaseOrTransaction,
  row: CatalogProposalRow,
  approval: CatalogProposalApproval,
  operatorOxyUserId: string,
): Promise<string> {
  if (!CATALOG_PROPOSAL_MINTABLE_TYPES.includes(row.type)) {
    const owner = CATALOG_PROPOSAL_LINK_ONLY_TYPES[row.type];
    throw forbidden(
      `A ${row.type} is not created from the proposal surface. Create it where it is owned — ` +
        `${owner ?? 'its own operator surface'} — and then merge this proposal into it.`,
    );
  }

  // The one mintable type. The narrowing is not a `default` branch: every other
  // member was refused above, by a tuple a census test holds disjoint from
  // `CATALOG_PROPOSAL_LINK_ONLY_TYPES` and equal in union to
  // `CATALOG_PROPOSAL_TYPES`.
  if (row.type !== 'controlled_value') {
    throw forbidden(`A ${row.type} cannot be minted from the proposal surface.`);
  }
  if (row.attributeDefinitionId === null) {
    // Unreachable for a row `catalog_proposals_controlled_value_subject_check`
    // admitted, and the only honest answer if one somehow was: a value with no
    // attribute is a value under nothing.
    throw validationError('This controlled-value proposal names no attribute definition.');
  }

  const key = approval.key.trim();
  // The same shape `attribute_enum_values_normalized_check` holds, stated here so
  // the refusal names the rule rather than surfacing a 23514 the surface cannot
  // attribute — the `matchIncomingVariant` ruling: a constraint can only refuse
  // the write, never say what it found.
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(key)) {
    throw validationError(
      'A controlled value key is lower-case and made of letters, digits, `_`, `.` and `-`.',
    );
  }

  const label = (approval.label ?? row.proposedLabel).trim();
  if (label.length === 0) throw validationError('A controlled value needs a label.');

  // Which VERSION the value can actually be written to (#568).
  //
  // `mercaria_attribute_enum_frozen` refuses to touch the value vocabulary of any
  // definition that has left `draft`, and its own message names the remedy:
  // "publish a new version instead". `seed-verticals/apply.ts` publishes every
  // attribute it drafts, so in a seeded deployment EVERY attribute a merchant can
  // see is `active` — which made this, the only mintable proposal type, raise
  // `restrict_violation` on every approval that mattered. The one test that
  // minted used a `draft` fixture, chosen for a teardown reason, so the suite was
  // green over the single lifecycle state in which the write works.
  const definition = await findAttributeDefinitionById(db, row.attributeDefinitionId);
  if (definition === undefined) {
    throw validationError('This proposal names an attribute definition that no longer exists.');
  }

  // The submitter's verbatim spelling, so the next merchant who types it resolves
  // rather than proposing again. Computed once: both paths below need it, and the
  // carry-forward needs it BEFORE the value row exists.
  const spelling = normalizeProposalLabel(row.proposedLabel);
  const submittedAliases =
    approval.recordSubmittedSpellingAsAlias === true && spelling.normalized !== key
      ? [row.proposedLabel]
      : [];

  if (definition.lifecycleState !== 'draft') {
    return mintIntoNextVersion(db, {
      definitionKey: definition.key,
      key,
      label,
      aliases: submittedAliases,
      operatorOxyUserId,
    });
  }

  const inserted = await insertAttributeEnumValue(db, row.attributeDefinitionId, key, label, 0);
  if (inserted === undefined) {
    // `ON CONFLICT DO NOTHING` fired: an operator picked a key that already
    // exists under this attribute. That is a MERGE and not an approval, and
    // saying so is the difference between an operator repeating the action with
    // the right verb and one wondering why nothing happened.
    throw conflict(
      `“${key}” is already a value of this attribute. Merge this proposal into it instead.`,
    );
  }

  // Best-effort by shape: the alias insert is `ON CONFLICT DO NOTHING`, and an
  // alias already pointing at ANOTHER value is a fact this approval must not
  // overwrite.
  for (const alias of submittedAliases) {
    await insertAttributeValueAlias(db, {
      attributeDefinitionId: row.attributeDefinitionId,
      enumValueId: inserted.id,
      alias,
    });
  }

  // The controlled-value set is one of the four things that can still move under
  // a live authoring schema, which is why `catalog_authoring_schema_invalidations`
  // has a subject for it. Bumping it IN THIS TRANSACTION is what makes every ECS
  // task stop serving the old composition the instant the value exists — an
  // outbox here would have a delivery window in which a merchant is shown a form
  // without the value an operator just approved for them.
  await bumpAuthoringSchemaInvalidation(db, {
    subject: 'attribute_values',
    subjectId: row.attributeDefinitionId,
  });

  return inserted.id;
}

/**
 * Merge a proposal into an entity that already exists (D9's "merge into
 * existing").
 *
 * The entity's kind is the proposal's own `type`; there is deliberately no kind
 * parameter, because a merge that could name a different kind would be a way to
 * resolve a colour proposal onto a brand. The id carries no foreign key
 * (`ID_COLUMNS_WITHOUT_FOREIGN_KEY`), so nothing here can verify it exists —
 * which is exactly why the operator states a reason and the act is audited.
 */
export async function mergeProposalIntoExisting(
  db: Database,
  context: OperatorDecisionContext,
  merge: CatalogProposalMerge,
): Promise<CatalogProposal> {
  assertReason(merge.reason);
  const resolvedEntityId = merge.resolvedEntityId.trim();
  if (resolvedEntityId.length === 0) {
    throw validationError('A merge names the entity this proposal actually means.');
  }
  const now = new Date();

  const proposal = await db.transaction(async (tx) => {
    const row = await requireOpenProposal(tx, context.proposalId, context.operatorOxyUserId);
    const moved = await transitionProposal(tx, row.id, row.state, {
      toState: 'merged',
      decidedByOxyUserId: context.operatorOxyUserId,
      decidedAt: now,
      decisionReason: merge.reason,
      resolvedEntityId,
    });
    if (moved === null) throw conflict('This proposal changed while you were merging it.');
    await insertReviewEvent(tx, {
      proposalId: row.id,
      action: 'merged_into_existing',
      actorKind: 'operator',
      actorOxyUserId: context.operatorOxyUserId,
      fromState: row.state,
      toState: 'merged',
      reason: merge.reason,
      at: now,
    });
    return moved;
  });

  await backfillAfterResolution(db, proposal, context.operatorOxyUserId);
  return projectProposal(proposal);
}

/** Refuse a proposal. Terminal; another attempt is a NEW row. */
export async function rejectProposal(
  db: Database,
  context: OperatorDecisionContext,
  input: { readonly rejectionReason: CatalogProposalRejectionReason; readonly reason: string },
): Promise<CatalogProposal> {
  assertReason(input.reason);
  return decide(db, context, {
    toState: 'rejected',
    action: 'rejected',
    reason: input.reason,
    extra: { rejectionReason: input.rejectionReason },
  });
}

/**
 * Ask the submitter for more.
 *
 * The question is the event's `reason` and not a column: an operator asks several
 * questions over a proposal's life, and a `pending_question` column would hold
 * only the last of them while the timeline holds all of them.
 */
export async function requestProposalInformation(
  db: Database,
  context: OperatorDecisionContext,
  input: { readonly reason: string },
): Promise<CatalogProposal> {
  assertReason(input.reason);
  return decide(db, context, {
    toState: 'needs_information',
    action: 'information_requested',
    reason: input.reason,
    extra: {},
  });
}

/**
 * Put a proposal down for now.
 *
 * `deferred` is an OPEN state (`CATALOG_PROPOSAL_OPEN_STATES`): an operator
 * saying "not now" has not decided, and a draft waiting on a deferred proposal is
 * still waiting on an unanswered question. Reading it as closed would let a
 * publication proceed on the strength of a decision nobody made.
 */
export async function deferProposal(
  db: Database,
  context: OperatorDecisionContext,
  input: { readonly until: Date; readonly reason: string },
): Promise<CatalogProposal> {
  assertReason(input.reason);
  if (Number.isNaN(input.until.getTime())) {
    throw validationError('A deferral names when the proposal comes back.');
  }
  return decide(db, context, {
    toState: 'deferred',
    action: 'deferred',
    reason: input.reason,
    extra: { deferredUntil: input.until },
  });
}

/**
 * Redirect a proposal to a different TYPE.
 *
 * The submitter asked for a category and it is really a controlled value. This
 * mints a NEW, operator-origin proposal carrying the same label and context, and
 * points the old one at it — so the original request survives verbatim with the
 * reviewer's reasoning beside it, and the continuation is a row somebody can act
 * on rather than a sentence asking a merchant to start again.
 *
 * The new proposal has NO store (`catalog_proposals_origin_scope_check`): it is
 * the operator's own request, and attributing it to the merchant would put an
 * assertion in their name that they did not make.
 */
export async function redirectProposal(
  db: Database,
  context: OperatorDecisionContext,
  input: {
    readonly toType: CatalogProposalType;
    readonly attributeDefinitionId?: string;
    readonly attributeDefinitionVersion?: number;
    readonly reason: string;
  },
): Promise<CatalogProposal> {
  assertReason(input.reason);
  const now = new Date();

  return db.transaction(async (tx) => {
    const row = await requireOpenProposal(tx, context.proposalId, context.operatorOxyUserId);
    if (input.toType === row.type) {
      throw validationError('A redirect changes the proposal type; this one is already that type.');
    }
    const attributeDefinitionId =
      input.attributeDefinitionId ?? row.attributeDefinitionId ?? null;
    const attributeDefinitionVersion =
      input.attributeDefinitionVersion ?? row.attributeDefinitionVersion ?? null;
    if (
      input.toType === 'controlled_value' &&
      (attributeDefinitionId === null || attributeDefinitionVersion === null)
    ) {
      throw validationError(
        'Redirecting to a controlled value names the attribute definition it belongs to.',
      );
    }

    const successor = await insertProposal(tx, {
      type: input.toType,
      origin: 'operator',
      storeId: null,
      submittedByOxyUserId: context.operatorOxyUserId,
      proposedLabel: row.proposedLabel,
      sourceLocale: row.sourceLocale,
      normalizedLabel: row.normalizedLabel,
      searchLabel: row.searchLabel,
      proposedDescription: row.proposedDescription,
      submitterNote: input.reason,
      categoryId: row.categoryId,
      productTypeDefinitionId: row.productTypeDefinitionId,
      attributeDefinitionId,
      attributeDefinitionVersion,
      // The redirect performs NO new scan, and the counters say so rather than
      // copying the original's. Copying would attribute a measurement of one
      // population to a probe over a different one — an `attribute` proposal and
      // a `controlled_value` proposal for the same label examine different sets.
      duplicateScanPopulation: 0,
      duplicateScanCandidates: 0,
      duplicateScanAt: now,
    });
    if (successor === undefined) {
      throw conflict('An open proposal of that type already covers this concept.');
    }

    const moved = await transitionProposal(tx, row.id, row.state, {
      toState: 'redirected',
      decidedByOxyUserId: context.operatorOxyUserId,
      decidedAt: now,
      decisionReason: input.reason,
      redirectedToProposalId: successor.id,
    });
    if (moved === null) throw conflict('This proposal changed while you were redirecting it.');

    await insertReviewEvent(tx, {
      proposalId: row.id,
      action: 'redirected',
      actorKind: 'operator',
      actorOxyUserId: context.operatorOxyUserId,
      fromState: row.state,
      toState: 'redirected',
      reason: input.reason,
      at: now,
    });
    await insertReviewEvent(tx, {
      proposalId: successor.id,
      action: 'submitted',
      actorKind: 'operator',
      actorOxyUserId: context.operatorOxyUserId,
      fromState: null,
      toState: 'submitted',
      reason: `redirected from ${row.id}`,
      at: now,
    });
    return projectProposal(moved);
  });
}

/* -------------------------------------------------------------------------- */
/* The shared decision body                                                    */
/* -------------------------------------------------------------------------- */

interface DecisionShape {
  readonly toState: CatalogProposalState;
  readonly action: 'rejected' | 'information_requested' | 'deferred';
  readonly reason: string;
  readonly extra: {
    readonly rejectionReason?: CatalogProposalRejectionReason;
    readonly deferredUntil?: Date;
  };
}

/**
 * The three decisions that mint nothing and link nothing.
 *
 * ONE body, so "does a decision lock the row, carry a decider, append an event
 * and refuse a lost CAS" is answered once rather than three times. Approve,
 * merge and redirect are deliberately NOT routed through it: each writes
 * something else in the same transaction, and folding them in would need a
 * callback parameter that made the shared body the union of all six rather than
 * the intersection.
 */
async function decide(
  db: Database,
  context: OperatorDecisionContext,
  shape: DecisionShape,
): Promise<CatalogProposal> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const row = await requireOpenProposal(tx, context.proposalId, context.operatorOxyUserId);
    const moved = await transitionProposal(tx, row.id, row.state, {
      toState: shape.toState,
      decidedByOxyUserId: context.operatorOxyUserId,
      decidedAt: now,
      decisionReason: shape.reason,
      ...(shape.extra.rejectionReason === undefined
        ? {}
        : { rejectionReason: shape.extra.rejectionReason }),
      // A move OUT of `deferred` must clear the date, or
      // `catalog_proposals_deferred_check` refuses the row — which is the CHECK
      // working, and stating it here is what stops a later reader "fixing" the
      // constraint instead.
      deferredUntil: shape.extra.deferredUntil ?? null,
    });
    if (moved === null) throw conflict('This proposal changed while you were deciding it.');
    await insertReviewEvent(tx, {
      proposalId: row.id,
      action: shape.action,
      actorKind: 'operator',
      actorOxyUserId: context.operatorOxyUserId,
      fromState: row.state,
      toState: shape.toState,
      reason: shape.reason,
      at: now,
    });
    return projectProposal(moved);
  });
}

/**
 * Load a proposal for a decision, locked, and refuse everything that is not an
 * open one somebody else submitted.
 *
 * `FOR UPDATE` because two operators working the same queue is the ordinary case:
 * without it both read `submitted`, both pass, and the second silently overwrites
 * the first's decision on a row that may already have minted a value. The CAS in
 * `transitionProposal` is the second layer and would catch it — the lock is what
 * makes the loser WAIT and then see the decision rather than race it.
 *
 * The self-approval refusal is stated here as well as in
 * `catalog_proposals_decider_distinct_check`, so the operator gets a sentence
 * naming the rule rather than a 23514.
 */
async function requireOpenProposal(
  db: DatabaseOrTransaction,
  proposalId: string,
  operatorOxyUserId: string,
): Promise<CatalogProposalRow> {
  const row = await lockProposal(db, proposalId);
  if (row === null) throw notFound('No such proposal.');
  if (!CATALOG_PROPOSAL_OPEN_STATES.includes(row.state)) {
    throw conflict(`This proposal is already ${row.state}.`);
  }
  if (row.submittedByOxyUserId === operatorOxyUserId) {
    throw forbidden('A proposal is decided by somebody other than the account that submitted it.');
  }
  return row;
}

/** A decision nobody explained is a decision nobody can review. */
function assertReason(reason: string): void {
  if (reason.trim().length === 0) throw validationError('A decision states its reason.');
}

/**
 * Run the backfill after a resolution commits, and never inside it.
 *
 * AFTER, because the backfill writes to `catalog_authoring_draft_values` and to
 * the retained claims — tables the decision's transaction does not hold and must
 * not start holding, since a long backfill would then keep a lock on the proposal
 * row every other operator action queues behind. It is the #59 merge-runner
 * ruling: the aggregate rebuild runs after the phase commits, or the phase
 * deadlocks against itself.
 *
 * BEST-EFFORT, because a failed backfill must not un-approve a decision an
 * operator made. The work is fully recoverable: every reference is claimed by a
 * compare-and-swap on `backfilled_at IS NULL`, so the operator surface's own
 * `POST …/backfill` picks up exactly what is left.
 */
async function backfillAfterResolution(
  db: Database,
  proposal: CatalogProposalRow,
  operatorOxyUserId: string,
): Promise<void> {
  try {
    await runProposalBackfill(db, { proposalId: proposal.id, operatorOxyUserId });
  } catch (err) {
    log.general.error(
      { err, proposalId: proposal.id },
      'Catalog proposal backfill failed after resolution; re-run it from /internal/catalog-proposals.',
    );
  }
}
