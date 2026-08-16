/**
 * Proposing, approving, fanning out and superseding a mapping
 * (#367 Workstream 11).
 *
 * Every function here is one operator act. There is deliberately no
 * `upsertMapping`, no `setMappingTarget` and no `approveAll`: a mapping's
 * meaning is frozen once it leaves `proposed`, a change is a new version, and a
 * bulk approval is the shape in which a hundred unreviewed suggestions become a
 * hundred reviewed ones without anybody having read them.
 *
 * ## The two decisions this module makes that the database cannot
 *
 * 1. **A transform rule must be REGISTERED in this image before a mapping may
 *    cite it.** A CHECK can hold the key inside the shipped tuple; only the code
 *    knows which `(key, version)` pairs have an implementation. Storing a
 *    mapping citing an unregistered version would be storable, reviewable and
 *    permanently unresolvable, which is a row that looks like work somebody did.
 * 2. **A proposal for a token that already resolves is a FAN-OUT proposal**, and
 *    it is answered as one: the proposal is accepted (the token needs the
 *    record), a review row is opened naming the ambiguity, and approving it
 *    later requires the second operator the CHECK prices it at. The alternative
 *    — refusing the insert — would leave the second target invisible, which is
 *    the state the review queue exists to prevent.
 */

import type {
  CatalogExternalMappingDimension,
  CatalogExternalMappingProvenance,
  CatalogExternalTarget,
  CatalogExternalTransformRule,
} from '@mercaria/shared-types';
import { conflict, validationError } from '../../lib/errors/index.js';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  approveExternalMappingFanOut,
  closeExternalMappingWindow,
  findExternalMapping,
  insertExternalMapping,
  readHighestMappingVersion,
  readLiveMappings,
  transitionExternalMapping,
  type ExternalMappingRow,
} from '../../db/catalogExternalMappings/externalMappingRepository.js';
import { upsertExternalMappingReview } from '../../db/catalogExternalMappings/externalMappingRepository.js';
import { columnsToTarget, targetsAgree, targetToColumns } from './target.js';
import { isTransformRuleRegistered, latestTransformRuleVersion } from './transform-rules.js';

/** What an operator (or a suggester) is proposing. */
export interface ProposeExternalMappingInput {
  readonly catalogSourceId: string;
  readonly dimension: CatalogExternalMappingDimension;
  readonly externalKey: string;
  readonly externalLabel?: string;
  readonly externalPath?: readonly string[];
  readonly externalLocale?: string;
  readonly target: CatalogExternalTarget;
  readonly transformRule?: CatalogExternalTransformRule;
  readonly transformRuleVersion?: number;
  readonly provenance: CatalogExternalMappingProvenance;
  readonly confidence: number;
  readonly evidenceSourceRecordId?: string;
  readonly evidenceNote?: string;
  readonly validFrom?: Date;
  readonly proposedByOxyUserId?: string;
  /**
   * Provenance for a product-type mapping: the `product_type_definitions` row
   * whose schema an operator was looking at when they proposed this.
   *
   * NEVER the resolution target — resolution reads the key and the single live
   * published version. Recorded because "what did the schema look like when
   * somebody approved this" is the question a later correction actually asks,
   * and a CHECK confines it to `product_type` mappings so no other dimension can
   * carry one and leave a reader deciding what it meant.
   */
  readonly reviewedProductTypeDefinitionId?: string;
  readonly at: Date;
}

/** A proposal, plus whether approving it will need a second operator. */
export interface ProposedExternalMapping {
  readonly mapping: ExternalMappingRow;
  /**
   * True when the token already resolves to something else, so this proposal is
   * a fan-out and its approval is a two-operator act.
   */
  readonly requiresFanOutApproval: boolean;
  /** The live mappings it would sit beside. Empty in the ordinary case. */
  readonly existingLiveMappingIds: readonly string[];
}

/**
 * Record a proposal. Never approves anything.
 *
 * Runs in ONE transaction with the review row it may open, because a fan-out
 * proposal with no review row beside it is a second live target nobody is being
 * asked about — which is precisely the silent fan-out the whole mechanism
 * exists to prevent.
 */
export async function proposeExternalMapping(
  input: ProposeExternalMappingInput,
  db: DatabaseOrTransaction = getDb(),
): Promise<ProposedExternalMapping> {
  if (input.target.dimension !== input.dimension) {
    throw validationError(
      `A ${input.dimension} mapping cannot carry a ${input.target.dimension} target.`,
    );
  }
  if (input.confidence < 0 || input.confidence > 1 || !Number.isFinite(input.confidence)) {
    throw validationError('Confidence must be a number between 0 and 1.');
  }

  const transformRule = input.transformRule ?? 'identity';
  const transformRuleVersion = input.transformRuleVersion ?? latestTransformRuleVersion(transformRule);
  if (!isTransformRuleRegistered(transformRule, transformRuleVersion)) {
    // Storable, reviewable and permanently unresolvable is worse than refused:
    // the row would look like work somebody had done.
    throw validationError(
      `No transform rule '${transformRule}' at version ${transformRuleVersion} ships in this image.`,
    );
  }

  const validFrom = input.validFrom ?? input.at;

  return db.transaction(async (tx) => {
    const live = await readLiveMappings(
      input.catalogSourceId,
      input.dimension,
      input.externalKey,
      input.at,
      tx,
    );
    const conflicting = live.filter((row) => {
      const existing = columnsToTarget(row.dimension, row);
      return existing === null || !targetsAgree(existing, input.target);
    });
    const duplicate = live.length > conflicting.length;
    if (duplicate) {
      // The token already resolves to exactly this concept. Recording a second
      // identical mapping would add a version with no decision in it and would
      // then need a fan-out approval to go live beside its own twin.
      throw conflict('This source token already maps to that concept.');
    }

    const highest = await readHighestMappingVersion(
      input.catalogSourceId,
      input.dimension,
      input.externalKey,
      tx,
    );

    const mapping = await insertExternalMapping(
      {
        catalogSourceId: input.catalogSourceId,
        dimension: input.dimension,
        externalKey: input.externalKey,
        ...(input.externalLabel === undefined ? {} : { externalLabel: input.externalLabel }),
        ...(input.externalPath === undefined ? {} : { externalPath: input.externalPath }),
        ...(input.externalLocale === undefined ? {} : { externalLocale: input.externalLocale }),
        ...targetToColumns(input.target),
        transformRule,
        transformRuleVersion,
        version: highest + 1,
        provenance: input.provenance,
        confidence: input.confidence,
        ...(input.evidenceSourceRecordId === undefined
          ? {}
          : { evidenceSourceRecordId: input.evidenceSourceRecordId }),
        ...(input.evidenceNote === undefined ? {} : { evidenceNote: input.evidenceNote }),
        validFrom,
        ...(input.proposedByOxyUserId === undefined
          ? {}
          : { proposedByOxyUserId: input.proposedByOxyUserId }),
        ...(input.reviewedProductTypeDefinitionId === undefined
          ? {}
          : { reviewedProductTypeDefinitionId: input.reviewedProductTypeDefinitionId }),
      },
      tx,
    );

    if (conflicting.length > 0) {
      await upsertExternalMappingReview(
        {
          catalogSourceId: input.catalogSourceId,
          dimension: input.dimension,
          externalKey: input.externalKey,
          ...(input.externalLabel === undefined ? {} : { externalLabel: input.externalLabel }),
          ...(input.externalPath === undefined ? {} : { externalPath: input.externalPath }),
          reason: 'fan_out_unapproved',
          priority: 10,
          summary:
            `This token already resolves to ${conflicting.length} other concept(s). ` +
            'Approving the new proposal beside them is a fan-out and needs a second operator.',
          candidateMappingIds: [],
          observedAt: input.at,
        },
        tx,
      );
    }

    return {
      mapping,
      requiresFanOutApproval: conflicting.length > 0,
      existingLiveMappingIds: conflicting.map((row) => row.id),
    };
  });
}

/**
 * Approve a proposal.
 *
 * The database decides whether this is legal, twice over: the state trigger
 * refuses an illegal move, and
 * `catalog_external_mappings_live_primary_key` refuses a second live target for
 * one token unless this row already carries a fan-out approval. So an approval
 * that would create a silent one-to-many fails at the index rather than at a
 * comparison two operators can race past — and the error is turned into a
 * conflict naming the fan-out, because that is the operator's actual next step.
 */
export async function approveExternalMapping(
  input: { readonly id: string; readonly approverOxyUserId: string; readonly at: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<ExternalMappingRow> {
  const current = await findExternalMapping(input.id, db);
  if (current === null) throw validationError('No such mapping.');
  if (current.state === 'approved') return current;

  const row = await transitionExternalMapping(
    {
      id: input.id,
      expectedState: current.state,
      nextState: 'approved',
      actorOxyUserId: input.approverOxyUserId,
      at: input.at,
    },
    db,
  ).catch((error: unknown) => {
    // A unique violation here is not a race to retry: it is the one-to-many
    // refusal, and the remedy is a second operator recording a fan-out.
    if (isUniqueViolation(error)) {
      throw conflict(
        'This source token already resolves to another concept. Approving a second target ' +
          'is a fan-out and must be recorded by a second operator.',
      );
    }
    throw error;
  });

  if (row === null) throw conflict('The mapping changed state before this approval landed.');
  return row;
}

/** Refuse a proposal, with a reason. The row stays, which is what stops the re-proposal loop. */
export async function rejectExternalMapping(
  input: {
    readonly id: string;
    readonly reviewerOxyUserId: string;
    readonly reason: string;
    readonly at: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ExternalMappingRow> {
  const current = await findExternalMapping(input.id, db);
  if (current === null) throw validationError('No such mapping.');
  if (current.state === 'rejected') return current;

  const row = await transitionExternalMapping(
    {
      id: input.id,
      expectedState: current.state,
      nextState: 'rejected',
      actorOxyUserId: input.reviewerOxyUserId,
      at: input.at,
      rejectedReason: input.reason,
    },
    db,
  );
  if (row === null) throw conflict('The mapping changed state before this rejection landed.');
  return row;
}

/**
 * Record the SECOND operator's fan-out approval.
 *
 * A separate call by a separate person. `catalog_external_mappings_fan_out_four_eyes_check`
 * requires `fan_out_approved_by <> approved_by` AND that the mapping is already
 * approved, so this cannot be the same request that approved it and cannot be
 * the same account — #55's four eyes, at the one grain in this domain where a
 * decision creates an ambiguity somebody else has to live with.
 */
export async function approveExternalMappingFanOutDecision(
  input: {
    readonly id: string;
    readonly approverOxyUserId: string;
    readonly rationale: string;
    readonly at: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<ExternalMappingRow> {
  if (input.rationale.trim() === '') {
    throw validationError('A fan-out approval must say why one token means several concepts.');
  }
  const row = await approveExternalMappingFanOut(input, db).catch((error: unknown) => {
    if (isCheckViolation(error)) {
      throw conflict(
        'A fan-out must be approved by a second operator, and only on a mapping that is ' +
          'already approved.',
      );
    }
    throw error;
  });
  if (row === null) throw conflict('This mapping already carries a fan-out approval.');
  return row;
}

/**
 * Replace a live mapping with a new version.
 *
 * ONE transaction: the successor is proposed and the incumbent's window is
 * closed together, so there is no instant at which the token resolves to both or
 * to neither. The successor is still only `proposed` — a supersession is not an
 * approval, and letting it be one would be the edit-in-place this domain refuses
 * wearing a version number.
 */
export async function supersedeExternalMapping(
  input: ProposeExternalMappingInput & { readonly supersedesMappingId: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<ProposedExternalMapping> {
  return db.transaction(async (tx) => {
    const incumbent = await findExternalMapping(input.supersedesMappingId, tx);
    if (incumbent === null) throw validationError('No such mapping to supersede.');
    if (incumbent.state !== 'approved') {
      throw conflict('Only an approved mapping can be superseded; reject a proposal instead.');
    }
    const proposed = await proposeExternalMapping(
      { ...input, validFrom: input.validFrom ?? input.at },
      tx,
    );
    const closed = await closeExternalMappingWindow(input.supersedesMappingId, input.at, tx);
    if (closed === null) {
      throw conflict('That mapping already has a closed validity window.');
    }
    return proposed;
  });
}

/** postgres.js reports SQLSTATE on `cause`, never on `error.code` (a house rule). */
function sqlState(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const cause = (error as { cause?: unknown }).cause;
  const carrier = cause !== undefined && cause !== null ? cause : error;
  const code = (carrier as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function isUniqueViolation(error: unknown): boolean {
  return sqlState(error) === '23505';
}

function isCheckViolation(error: unknown): boolean {
  return sqlState(error) === '23514';
}
