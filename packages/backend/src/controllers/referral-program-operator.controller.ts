/**
 * Operator program management (#147 "Operator program management", acceptance
 * 4 and 5).
 *
 * On the SAME `REFERRAL_OPERATOR_OXY_USER_IDS` allow-list #143 and #145 use,
 * NOT an eighth: publishing the terms a partner earns under, pausing the
 * attribution that stops them earning and approving the payout that pays them
 * are one economy, and splitting them would put one half of a partner's fate
 * behind a list the other half's operator is not on. Empty means the router is
 * not mounted at all — 404, never 401 — which is the house convention every one
 * of the eight follows.
 *
 * ## "No operator can edit an active rule version in place" is not a check here
 *
 * #147 acceptance 4, and it is enforced by #142's repository rather than by
 * this controller: `updateProgramDraft` carries `status = 'draft'` in its WHERE,
 * so a published version matches nothing and the caller gets `undefined` back.
 * The schema helps by having no `status`, `version`, `publishedAt` or
 * `approvedByOxyUserId` field to carry — a body able to name a status would be
 * a second way to publish, and the one that skips the lifecycle service.
 *
 * ## The route set is CLOSED
 *
 * Draft, edit-a-draft, publish, next-version, pause, resume, end, retire, and
 * three reads. There is deliberately NO "edit this active version", no "set
 * this program's status", no "delete this version", no "backdate this
 * effective start" and no "move this partner to that program". Every write
 * drives an existing service whose own CAS is what makes it safe, so this
 * surface adds routes and no new way to change what a partner is owed.
 *
 * ## Pausing does not strand anything
 *
 * #147 acceptance 5. `pauseProgram` moves the program's STATUS, and ADR 0005
 * D18 makes that prospective: no new touches, no new attributions, no new
 * accruals, while every held and vested reward runs its ordinary lifecycle to
 * payout. Nothing in this controller touches a reward, a batch or a ledger
 * entry — there is no import that could.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type { ReferralProgramOperatorView } from '@mercaria/shared-types';
import { notFound, respondWithError } from '../lib/errors/error-codes.js';
import { getDb } from '../db/postgres.js';
import {
  findLatestProgramVersion,
  listProgramIdentities,
  listProgramVersions,
  type ReferralProgramRow,
} from '../db/referrals/programRepository.js';
import {
  createNextProgramVersion,
  createProgramDraft,
  editProgramDraft,
  endProgram,
  pauseProgram,
  publishProgram,
  resumeProgram,
  retireProgram,
} from '../services/referrals/program.service.js';
import { readProgramUtilization } from '../services/referrals/dashboard/utilization.service.js';
import type {
  ReferralProgramDraftBody,
  ReferralProgramDraftPatchBody,
  ReferralProgramLifecycleBody,
} from '../middleware/referral-dashboard-schemas.js';
import { sendSuccess } from '../utils/api-response.js';

/** How many programs the operator list carries. A marketing artefact, not a feed. */
const PROGRAM_LIST_LIMIT = 200;

/**
 * The operator projection — every column of the version, named.
 *
 * Named rather than spread, and deliberately NOT a superset of
 * `ReferralProgramPartnerView`: the partner view exists so a partner surface
 * cannot reach a policy reference or an approver's identity, and one shared
 * type with optional fields would put both behind a serializer's discretion.
 */
export function projectProgramForOperator(row: ReferralProgramRow): ReferralProgramOperatorView {
  return {
    id: row.id,
    programId: row.programId,
    version: row.version,
    name: row.name,
    description: row.description,
    publicTermsSummary: row.publicTermsSummary,
    family: row.family,
    status: row.status,
    ...(row.effectiveStartAt !== null
      ? { effectiveStartAt: row.effectiveStartAt.toISOString() }
      : {}),
    ...(row.effectiveEndAt !== null ? { effectiveEndAt: row.effectiveEndAt.toISOString() } : {}),
    eligiblePartnerTypes: row.eligiblePartnerTypes,
    eligibleSubjectKinds: row.eligibleSubjectKinds,
    markets: row.markets,
    currencies: row.currencies,
    channels: row.channels,
    commercialModes: row.commercialModes,
    attributionPolicy: row.attributionPolicy,
    attributionWindowDays: row.attributionWindowDays,
    ...(row.activationWindowDays !== null
      ? { activationWindowDays: row.activationWindowDays }
      : {}),
    qualifyingEventPolicy: row.qualifyingEventPolicy,
    commissionRuleRef: row.commissionRuleRef,
    holdDays: row.holdDays,
    ...(row.capPolicyRef !== null ? { capPolicyRef: row.capPolicyRef } : {}),
    payoutPolicyRef: row.payoutPolicyRef,
    termsVersion: row.termsVersion,
    disclosureVersion: row.disclosureVersion,
    ...(row.featureFlagKey !== null ? { featureFlagKey: row.featureFlagKey } : {}),
    cohortKeys: row.cohortKeys,
    createdByOxyUserId: row.createdByOxyUserId,
    ...(row.approvedByOxyUserId !== null
      ? { approvedByOxyUserId: row.approvedByOxyUserId }
      : {}),
    ...(row.publishedAt !== null ? { publishedAt: row.publishedAt.toISOString() } : {}),
    ...(row.pausedAt !== null ? { pausedAt: row.pausedAt.toISOString() } : {}),
    ...(row.endedAt !== null ? { endedAt: row.endedAt.toISOString() } : {}),
    ...(row.retiredAt !== null ? { retiredAt: row.retiredAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Every program, one row each, at its highest version. */
export async function listReferralProgramsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const rows = await listProgramIdentities(getDb(), { limit: PROGRAM_LIST_LIMIT });
    sendSuccess(res, { programs: rows.map(projectProgramForOperator) });
  } catch (err) {
    respondWithError(res, err, 'Failed to list referral programs');
  }
}

/** Every VERSION of one program, newest first — the immutability audit read. */
export async function getReferralProgramHandler(req: Request, res: Response): Promise<void> {
  try {
    const programId = req.params.programId as string;
    const versions = await listProgramVersions(getDb(), programId);
    if (versions.length === 0) throw notFound('Referral program not found');
    sendSuccess(res, { versions: versions.map(projectProgramForOperator) });
  } catch (err) {
    respondWithError(res, err, 'Failed to read the referral program');
  }
}

/** Budget and cap utilization, derived. */
export async function getReferralProgramUtilizationHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const programId = req.params.programId as string;
    const latest = await findLatestProgramVersion(getDb(), programId);
    if (!latest) throw notFound('Referral program not found');
    sendSuccess(res, await readProgramUtilization(programId));
  } catch (err) {
    respondWithError(res, err, 'Failed to read referral program utilization');
  }
}

/** Draft version 1 of a NEW program. */
export async function createReferralProgramHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as ReferralProgramDraftBody;
    // The stable program identity is MINTED by the service, never supplied:
    // it is what every version of a program shares, and a caller-supplied one
    // is a caller-supplied collision with somebody else's version chain.
    const row = await createProgramDraft({
      ...toDraftInput(body),
      createdByOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, { program: projectProgramForOperator(row) }, 201);
  } catch (err) {
    respondWithError(res, err, 'Failed to draft the referral program');
  }
}

/**
 * Draft the NEXT version of an existing program.
 *
 * The service copies the current version's terms into a fresh draft, which is
 * the shape #147 acceptance 4 asks for: a policy change is a new version, so
 * an operator starts from what is live rather than retyping it and getting one
 * field wrong.
 */
export async function createReferralProgramVersionHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const row = await createNextProgramVersion({
      programId: req.params.programId as string,
      createdByOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, { program: projectProgramForOperator(row) }, 201);
  } catch (err) {
    respondWithError(res, err, 'Failed to draft the next referral program version');
  }
}

/** Edit a DRAFT. A published version matches nothing and is refused. */
export async function editReferralProgramDraftHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as ReferralProgramDraftPatchBody;
    const row = await editProgramDraft(req.params.versionId as string, toDraftPatch(body));
    sendSuccess(res, { program: projectProgramForOperator(row) });
  } catch (err) {
    respondWithError(res, err, 'Failed to edit the referral program draft');
  }
}

/**
 * Publish a draft.
 *
 * The approver comes off the CREDENTIAL and there is no field for it. #142's
 * `referral_programs_published_check` pairs `approved_by_oxy_user_id` with
 * `published_at` and `effective_start_at`, so "who approved the live terms"
 * always has an answer — and a body able to name a different approver would be
 * the way to make that answer somebody else's name.
 */
export async function publishReferralProgramHandler(req: Request, res: Response): Promise<void> {
  try {
    const row = await publishProgram({
      id: req.params.versionId as string,
      approvedByOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, { program: projectProgramForOperator(row) });
  } catch (err) {
    respondWithError(res, err, 'Failed to publish the referral program version');
  }
}

/**
 * One handler for the four lifecycle transitions.
 *
 * A factory rather than four bodies, because the difference between them is the
 * service call and nothing else — and four near-identical handlers is how one
 * of them ends up missing the reason or the actor.
 */
export function transitionReferralProgramHandler(
  action: 'pause' | 'resume' | 'end' | 'retire',
): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    try {
      const id = req.params.versionId as string;
      const actorOxyUserId = getRequiredOxyUserId(req);
      const { reason } = req.body as ReferralProgramLifecycleBody;
      const row = await runTransition(action, { id, actorOxyUserId, reason });
      sendSuccess(res, { program: projectProgramForOperator(row) });
    } catch (err) {
      respondWithError(res, err, `Failed to ${action} the referral program`);
    }
  };
}

async function runTransition(
  action: 'pause' | 'resume' | 'end' | 'retire',
  input: { id: string; actorOxyUserId: string; reason: string },
): Promise<ReferralProgramRow> {
  switch (action) {
    case 'pause':
      return await pauseProgram(input);
    case 'resume':
      return await resumeProgram(input);
    case 'end':
      // ADR 0005 D18's program TERMINATION: prospective only. Existing held and
      // vested rewards run their ordinary lifecycle to payout, including the
      // final sub-minimum batch — obligations already earned are honored, and
      // ending a program is not a reversal case.
      return await endProgram(input);
    case 'retire':
      return await retireProgram(input);
  }
}

/** Turn the validated body into the repository's own draft shape. */
function toDraftInput(body: ReferralProgramDraftBody) {
  return {
    name: body.name,
    description: body.description,
    publicTermsSummary: body.publicTermsSummary,
    family: body.family,
    eligiblePartnerTypes: body.eligiblePartnerTypes,
    eligibleSubjectKinds: body.eligibleSubjectKinds,
    markets: body.markets ?? [],
    currencies: body.currencies ?? [],
    channels: body.channels ?? [],
    commercialModes: body.commercialModes ?? [],
    // ONE policy exists (ADR 0005 D4's last-touch) and the schema has no field
    // for it: an operator choosing an attribution policy would be choosing
    // between one option and a value nothing implements.
    attributionPolicy: 'last_touch' as const,
    attributionWindowDays: body.attributionWindowDays,
    ...(body.activationWindowDays !== undefined
      ? { activationWindowDays: body.activationWindowDays }
      : {}),
    qualifyingEventPolicy: body.qualifyingEventPolicy,
    commissionRuleRef: body.commissionRuleRef,
    holdDays: body.holdDays,
    ...(body.capPolicyRef !== undefined ? { capPolicyRef: body.capPolicyRef } : {}),
    payoutPolicyRef: body.payoutPolicyRef,
    termsVersion: body.termsVersion,
    disclosureVersion: body.disclosureVersion,
    ...(body.featureFlagKey !== undefined ? { featureFlagKey: body.featureFlagKey } : {}),
    cohortKeys: body.cohortKeys ?? [],
    ...(body.effectiveStartAt !== undefined
      ? { effectiveStartAt: new Date(body.effectiveStartAt) }
      : {}),
    ...(body.effectiveEndAt !== undefined ? { effectiveEndAt: new Date(body.effectiveEndAt) } : {}),
  };
}

/** The same for a partial edit — every key spread only when it was sent. */
function toDraftPatch(body: ReferralProgramDraftPatchBody) {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (key === 'effectiveStartAt' || key === 'effectiveEndAt') {
      patch[key] = new Date(value as string);
      continue;
    }
    patch[key] = value;
  }
  return patch as Parameters<typeof editProgramDraft>[1];
}
