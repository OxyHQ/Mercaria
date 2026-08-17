/**
 * Submitting, converging on and closing a catalog proposal (#367 step 6,
 * ADR 0007 D9).
 *
 * A proposal is a REQUEST. Everything here is shaped by ADR 0007 D9's binding
 * sentence — **a merchant proposal never becomes globally trusted data by being
 * submitted** — and the load-bearing part of that is what this module CANNOT do:
 *
 * - It writes to no catalogue table. Not a category, not a brand, not an
 *   attribute definition, not an enum value. The one path that mints is
 *   `review.service.ts`'s approval, behind the operator allow-list, and
 *   `catalog-proposal-isolation.test.ts` fails the build if a module in this
 *   domain other than that one imports a catalogue write.
 * - It accepts no key and no slug, because
 *   {@link CatalogProposalSubmission} has no field that could carry one
 *   (ADR 0007 D1). A merchant's spelling has nowhere to become identity.
 * - It sets no state but `submitted`, `needs_information` → `submitted` and
 *   `withdrawn`. Every other move needs an operator, and
 *   `catalog_proposals_decision_audit_check` refuses one without a decider.
 *
 * ## The order of checks at submission, and why it is that order
 *
 * 1. **Permission**, resolved by the caller from the real store membership.
 * 2. **The value policy** — is this field even proposal-enabled. A refusal here
 *    is about the SCHEMA and does not depend on any other merchant's activity.
 * 3. **The rate limit**, both durable axes, with ONE message: a refusal that said
 *    which axis tripped would report somebody else's activity to this caller
 *    (#83's rule).
 * 4. **The duplicate scan**, last, because it is the only step that reads the
 *    catalogue — and running it before the cheap refusals would spend a trigram
 *    probe answering a request that was never going to be stored.
 */

import type {
  CatalogProposal,
  CatalogProposalDuplicateScan,
  CatalogProposalState,
  CatalogProposalTrace,
  CatalogProposalType,
} from '@mercaria/shared-types';
import {
  CATALOG_PROPOSAL_BLOCKING_DETECTORS,
  CATALOG_PROPOSAL_OPEN_STATES,
} from '@mercaria/shared-types';
import { conflict, forbidden, notFound, validationError } from '../../lib/errors/error-codes.js';
import { config } from '../../config/index.js';
import { getDb, type Database, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  countProposalsSince,
  findOpenProposalByConvergenceKey,
  findProposal,
  insertDuplicateCandidates,
  insertProposal,
  insertProposalReference,
  insertReviewEvent,
  listDuplicateCandidates,
  listProposalReferences,
  listProposals,
  listReviewEvents,
  lockProposal,
  transitionProposal,
  type CatalogProposalRow,
} from '../../db/catalogProposals/proposalRepository.js';
import { scanForDuplicates } from './duplicate-detection.service.js';
import { normalizeProposalLabel } from './normalization.js';
import {
  projectDuplicateCandidate,
  projectProposal,
  projectProposalReference,
  projectReviewEvent,
} from './projection.js';

/**
 * The convergence key, composed exactly as the GENERATED column composes it.
 *
 * Stated here so a submission can ask "would this collide" before it writes, and
 * so the duplicate scan can look the open proposal up by the same string the
 * partial unique holds. The two spellings are pinned equal by a real-server test
 * — a service key that drifted from the column's would make the pre-check answer
 * a different question from the constraint, silently, in the direction where the
 * constraint refuses a submission the scan said was fine.
 */
export function proposalConvergenceKey(input: {
  readonly type: CatalogProposalType;
  readonly attributeDefinitionId: string | null;
  readonly categoryId: string | null;
  readonly productTypeDefinitionId: string | null;
  readonly normalizedLabel: string;
}): string {
  return [
    input.type,
    input.attributeDefinitionId ?? '',
    input.categoryId ?? '',
    input.productTypeDefinitionId ?? '',
    input.normalizedLabel,
  ].join(':');
}

/** Everything a submission carries once the route has resolved the caller. */
export interface SubmitProposalInput {
  readonly type: CatalogProposalType;
  readonly storeId: string;
  readonly submittedByOxyUserId: string;
  readonly proposedLabel: string;
  readonly sourceLocale: string;
  readonly proposedDescription: string | null;
  readonly submitterNote: string | null;
  readonly categoryId: string | null;
  readonly productTypeDefinitionId: string | null;
  readonly attributeDefinitionId: string | null;
  /** DERIVED by the caller from the definition above; never supplied by a client. */
  readonly attributeDefinitionVersion: number | null;
  /** The draft answer that is waiting on this, when it came out of a form. */
  readonly draftId: string | null;
  readonly draftValueId: string | null;
}

/**
 * The outcome, as a STRING discriminant.
 *
 * `converged` is not a failure and is not `created`: the submitter is now waiting
 * with somebody else on a request that already exists, which is a different thing
 * to tell them than either "we made you one" or "that already exists, use it".
 * The backend compiles with `strict: false`, so a boolean discriminant would not
 * narrow (#68, #110).
 */
export type ProposalSubmission =
  | { readonly outcome: 'created'; readonly proposal: CatalogProposal; readonly scan: CatalogProposalDuplicateScan }
  | { readonly outcome: 'converged'; readonly proposal: CatalogProposal; readonly scan: CatalogProposalDuplicateScan };

/**
 * Run the pre-submission duplicate scan and report it, storing nothing.
 *
 * ADR 0007 D9 asks for duplicate detection BEFORE submission, and this is the
 * read a client calls to show a merchant what already exists while they are still
 * typing. It is deliberately the SAME function `submitProposal` runs, so what a
 * merchant was shown and what the submission decided on cannot be two different
 * scans.
 */
export async function previewDuplicates(
  db: DatabaseOrTransaction,
  input: {
    readonly type: CatalogProposalType;
    readonly proposedLabel: string;
    readonly categoryId: string | null;
    readonly productTypeDefinitionId: string | null;
    readonly attributeDefinitionId: string | null;
  },
): Promise<CatalogProposalDuplicateScan> {
  const label = normalizeProposalLabel(input.proposedLabel);
  assertLabelIsUsable(label.normalized, label.search);
  return scanForDuplicates(db, {
    type: input.type,
    normalizedLabel: label.normalized,
    searchLabel: label.search,
    attributeDefinitionId: input.attributeDefinitionId,
    convergenceKey: proposalConvergenceKey({
      type: input.type,
      attributeDefinitionId: input.attributeDefinitionId,
      categoryId: input.categoryId,
      productTypeDefinitionId: input.productTypeDefinitionId,
      normalizedLabel: label.normalized,
    }),
    nearLimit: config.catalogProposals.duplicateNearLimit,
    nearThreshold: config.catalogProposals.duplicateNearThreshold,
  });
}

/**
 * Submit a proposal, or converge on the open one that already covers it.
 *
 * ONE transaction: the proposal, its scan evidence, its reference and its
 * `submitted` event commit together. A proposal whose evidence committed
 * separately would let an operator open a request that says nobody checked for
 * duplicates, which is the one thing the evidence exists to answer.
 */
export async function submitProposal(
  db: Database,
  input: SubmitProposalInput,
): Promise<ProposalSubmission> {
  const label = normalizeProposalLabel(input.proposedLabel);
  assertLabelIsUsable(label.normalized, label.search);

  if (input.type === 'controlled_value') {
    if (input.attributeDefinitionId === null || input.attributeDefinitionVersion === null) {
      throw validationError(
        'A controlled-value proposal names the attribute definition its value belongs to.',
      );
    }
  }

  await assertWithinSubmissionBudget(db, input.submittedByOxyUserId, input.storeId);

  const convergenceKey = proposalConvergenceKey({
    type: input.type,
    attributeDefinitionId: input.attributeDefinitionId,
    categoryId: input.categoryId,
    productTypeDefinitionId: input.productTypeDefinitionId,
    normalizedLabel: label.normalized,
  });

  const scan = await scanForDuplicates(db, {
    type: input.type,
    normalizedLabel: label.normalized,
    searchLabel: label.search,
    attributeDefinitionId: input.attributeDefinitionId,
    convergenceKey,
    nearLimit: config.catalogProposals.duplicateNearLimit,
    nearThreshold: config.catalogProposals.duplicateNearThreshold,
  });

  // An EXISTING entity under this exact name is a refusal that NAMES it: the
  // remedy is to use it, and a proposal for something that already exists is
  // work an operator would close by pointing at the same row. A near match is
  // never a refusal — see the detection module.
  if (scan.blocking !== null && CATALOG_PROPOSAL_BLOCKING_DETECTORS.includes(scan.blocking.detector)) {
    throw conflict(
      `“${scan.blocking.label}” already exists in the catalogue; use it instead of proposing it.`,
    );
  }

  const now = new Date();
  return db.transaction(async (tx) => {
    const inserted = await insertProposal(tx, {
      type: input.type,
      origin: 'merchant',
      storeId: input.storeId,
      submittedByOxyUserId: input.submittedByOxyUserId,
      proposedLabel: label.source,
      sourceLocale: input.sourceLocale,
      normalizedLabel: label.normalized,
      searchLabel: label.search,
      proposedDescription: input.proposedDescription,
      submitterNote: input.submitterNote,
      categoryId: input.categoryId,
      productTypeDefinitionId: input.productTypeDefinitionId,
      attributeDefinitionId: input.attributeDefinitionId,
      attributeDefinitionVersion: input.attributeDefinitionVersion,
      duplicateScanPopulation: scan.population,
      duplicateScanCandidates: scan.candidates.length,
      duplicateScanAt: now,
    });

    // The insert lost the convergence race, or an open proposal already covered
    // this concept. Both land here and both are the SAME outcome: read the
    // winner back and join it. Doing this inside the transaction is what makes
    // the reference and the event belong to the row that actually exists.
    if (inserted === undefined) {
      const existing = await findOpenProposalByConvergenceKey(tx, convergenceKey);
      if (existing === null) {
        // The open proposal was decided between the scan and the insert, so the
        // partial unique no longer covers it and the insert should have
        // succeeded. Retrying inside this transaction would race the same way;
        // a 409 the client re-submits is the honest answer.
        throw conflict('This proposal was decided while you were submitting it. Try again.');
      }
      await attachReference(tx, existing.id, input);
      return {
        outcome: 'converged' as const,
        proposal: projectProposal(existing),
        scan,
      };
    }

    await insertDuplicateCandidates(
      tx,
      scan.candidates.map((candidate) => ({
        proposalId: inserted.id,
        kind: candidate.kind,
        detector: candidate.detector,
        candidateRef: candidate.ref,
        candidateLabel: candidate.label,
        similarity: candidate.similarity,
      })),
    );
    await attachReference(tx, inserted.id, input);
    await insertReviewEvent(tx, {
      proposalId: inserted.id,
      action: 'submitted',
      actorKind: 'submitter',
      actorOxyUserId: input.submittedByOxyUserId,
      fromState: null,
      toState: 'submitted',
      reason: input.submitterNote,
      at: now,
    });
    // A SEPARATE event from `submitted`, and it carries the numbers. "Detection
    // ran and found nothing" and "detection never ran" are the same silence
    // otherwise, which is the failure the population counter exists for — and an
    // operator reading the timeline sees the scan as an act rather than as a
    // column they have to know to look at.
    await insertReviewEvent(tx, {
      proposalId: inserted.id,
      action: 'duplicate_scan_recorded',
      actorKind: 'system',
      actorOxyUserId: null,
      fromState: 'submitted',
      toState: 'submitted',
      reason: `examined ${scan.population}, recorded ${scan.candidates.length}`,
      at: now,
    });

    return { outcome: 'created' as const, proposal: projectProposal(inserted), scan };
  });
}

/**
 * Attach the draft answer waiting on a proposal, when the submission named one.
 *
 * Both halves or neither: `catalog_proposal_references_draft_pair_check` refuses
 * a value with no draft, because the backfill has to bump the DRAFT's version
 * after rewriting one of its answers and a value id alone cannot say which draft
 * that is.
 */
async function attachReference(
  db: DatabaseOrTransaction,
  proposalId: string,
  input: SubmitProposalInput,
): Promise<void> {
  if (input.draftId === null || input.draftValueId === null) return;
  await insertProposalReference(db, {
    proposalId,
    kind: 'authoring_draft_value',
    draftId: input.draftId,
    draftValueId: input.draftValueId,
  });
}

/**
 * The two DURABLE rate-limit axes, counted in Postgres.
 *
 * "How many proposals has this store asked for today, across every ECS task" is
 * not a question a per-process counter or a per-IP bucket can answer — #83's
 * ruling, with the two axes this domain actually needs. The network axis is the
 * route's own limiter.
 *
 * ONE message for both, deliberately: a refusal that named the axis would tell
 * this caller about their colleagues' activity, and a per-store axis is exactly
 * the one where that matters.
 */
async function assertWithinSubmissionBudget(
  db: DatabaseOrTransaction,
  submittedByOxyUserId: string,
  storeId: string,
): Promise<void> {
  const now = Date.now();
  const [perAccount, perStore] = await Promise.all([
    countProposalsSince(db, { submittedByOxyUserId }, new Date(now - 60 * 60 * 1000)),
    countProposalsSince(db, { storeId }, new Date(now - 24 * 60 * 60 * 1000)),
  ]);
  if (
    perAccount >= config.catalogProposals.maxPerSubmitterPerHour ||
    perStore >= config.catalogProposals.maxPerStorePerDay
  ) {
    throw forbidden('Too many catalogue proposals recently. Try again later.');
  }
}

/** A label of punctuation converges on nothing and is findable by nobody. */
function assertLabelIsUsable(normalized: string, search: string): void {
  if (normalized.length === 0 || search.length === 0) {
    throw validationError('The proposed label has no letters or digits to record.');
  }
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export async function readProposal(
  db: DatabaseOrTransaction,
  id: string,
): Promise<CatalogProposal> {
  const row = await findProposal(db, id);
  if (row === null) throw notFound('No such proposal.');
  return projectProposal(row);
}

/** A store's own proposals. The merchant surface's only feed. */
export async function listStoreProposals(
  db: DatabaseOrTransaction,
  input: {
    readonly storeId: string;
    readonly states?: readonly CatalogProposalState[];
    readonly types?: readonly CatalogProposalType[];
    readonly limit?: number;
    readonly offset?: number;
  },
): Promise<CatalogProposal[]> {
  const rows = await listProposals(db, {
    storeId: input.storeId,
    ...(input.states === undefined ? {} : { states: input.states }),
    ...(input.types === undefined ? {} : { types: input.types }),
    limit: Math.min(input.limit ?? config.catalogProposals.pageSize, config.catalogProposals.pageSize),
    offset: input.offset ?? 0,
  });
  return rows.map(projectProposal);
}

/**
 * Everything an operator trace shows.
 *
 * FOUR lists rather than a richer proposal, and the composition is the same shape
 * a merchant read returns with three more arrays beside it — so there is exactly
 * one idea of what a proposal is.
 */
export async function readProposalTrace(
  db: DatabaseOrTransaction,
  id: string,
): Promise<CatalogProposalTrace> {
  const row = await findProposal(db, id);
  if (row === null) throw notFound('No such proposal.');
  const [candidates, references, events] = await Promise.all([
    listDuplicateCandidates(db, id),
    listProposalReferences(db, id),
    listReviewEvents(db, id),
  ]);
  return {
    proposal: projectProposal(row),
    duplicateCandidates: candidates.map(projectDuplicateCandidate),
    references: references.map(projectProposalReference),
    events: events.map(projectReviewEvent),
  };
}

/* -------------------------------------------------------------------------- */
/* What a SUBMITTER may do                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Withdraw one's own proposal.
 *
 * The one state move that is not an operator's, and the reason it exists: a
 * merchant who realises their own mistake must be able to close their request
 * without an operator spending a decision on it. It is excluded from
 * `catalog_proposals_decision_audit_check`'s demand for a decider precisely
 * because it is not a review outcome.
 *
 * Only from an OPEN state, and only by the account that submitted it. The
 * ownership check is by `submitted_by_oxy_user_id` rather than by store
 * membership: a colleague with `products:write` can see the request, and closing
 * somebody else's is a different act from closing your own.
 */
export async function withdrawProposal(
  db: Database,
  input: {
    readonly proposalId: string;
    readonly storeId: string;
    readonly actorOxyUserId: string;
    readonly reason: string | null;
  },
): Promise<CatalogProposal> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const row = await requireOpenStoreProposal(tx, input.proposalId, input.storeId);
    if (row.submittedByOxyUserId !== input.actorOxyUserId) {
      throw forbidden('Only the account that submitted a proposal may withdraw it.');
    }
    const moved = await transitionProposal(tx, row.id, row.state, { toState: 'withdrawn' });
    if (moved === null) throw conflict('This proposal changed while you were withdrawing it.');
    await insertReviewEvent(tx, {
      proposalId: row.id,
      action: 'withdrawn',
      actorKind: 'submitter',
      actorOxyUserId: input.actorOxyUserId,
      fromState: row.state,
      toState: 'withdrawn',
      reason: input.reason,
      at: now,
    });
    return projectProposal(moved);
  });
}

/**
 * Answer an operator's request for information.
 *
 * Moves `needs_information` back to `submitted`, which is what puts the row back
 * in the queue. The answer itself is a review EVENT and not a column: an operator
 * asked one question and got one answer, and a `submitter_response` column would
 * hold only the last of them while the timeline holds all of them.
 */
export async function supplyProposalInformation(
  db: Database,
  input: {
    readonly proposalId: string;
    readonly storeId: string;
    readonly actorOxyUserId: string;
    readonly response: string;
  },
): Promise<CatalogProposal> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const row = await requireOpenStoreProposal(tx, input.proposalId, input.storeId);
    if (row.state !== 'needs_information') {
      throw conflict('This proposal is not waiting for information.');
    }
    const moved = await transitionProposal(tx, row.id, 'needs_information', {
      toState: 'submitted',
    });
    if (moved === null) throw conflict('This proposal changed while you were answering it.');
    await insertReviewEvent(tx, {
      proposalId: row.id,
      action: 'information_supplied',
      actorKind: 'submitter',
      actorOxyUserId: input.actorOxyUserId,
      fromState: 'needs_information',
      toState: 'submitted',
      reason: input.response,
      at: now,
    });
    return projectProposal(moved);
  });
}

/**
 * Load a proposal for a merchant action, locked, and refuse everything that is
 * not this store's open request.
 *
 * A proposal belonging to ANOTHER store answers 404 and not 403, because a
 * distinguishable answer is an oracle over which merchants have asked for what —
 * the `merchant-competitiveness` and `seller-profile` ruling.
 */
async function requireOpenStoreProposal(
  db: DatabaseOrTransaction,
  proposalId: string,
  storeId: string,
): Promise<CatalogProposalRow> {
  const row = await lockProposal(db, proposalId);
  if (row === null || row.storeId !== storeId) throw notFound('No such proposal.');
  if (!CATALOG_PROPOSAL_OPEN_STATES.includes(row.state)) {
    throw conflict('This proposal has already been decided.');
  }
  return row;
}

/** The shared handle for callers that have no transaction of their own. */
export function proposalsDb(): Database {
  return getDb();
}
