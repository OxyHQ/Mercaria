/**
 * `/internal/guest-commerce/governance/*` — the retention, monitoring, abuse
 * and rollout surface (#111).
 *
 * On the SAME `GUEST_OPERATOR_OXY_USER_IDS` allow-list #104, #108, #109 and
 * #110 use, and deliberately NOT a seventh. The power is the one that list
 * already grants — reading what happened to a guest's data and driving a path
 * that is already bounded — and a new list would be a second answer to a
 * question this one answers. It is deliberately not the PAYMENT list either: a
 * support engineer checking whether the retention job is running should not
 * thereby be able to see every store's money.
 *
 * ## What this surface cannot do
 *
 * There is no "delete this guest's data now", no "clear this counter", no "set
 * this gate satisfied for me", and no route that returns a subject hash. The
 * writes are: publish a retention policy version, raise or lift a legal hold,
 * review an intervention, record a sign-off, and request a stage advance. Every
 * one is a decision somebody is accountable for, and every one is recorded with
 * the account that made it.
 *
 * The omission worth naming is the first: an erasure is driven by the DATA
 * SUBJECT through their own credential, and an operator-triggered one would be
 * a way for staff to destroy a buyer's records without the buyer asking.
 */

import type { Request, Response } from 'express';
import {
  GUEST_ABUSE_POLICIES,
  GUEST_DATA_INVENTORY,
  GUEST_FEATURE_GATE_REGISTER,
  GUEST_LAUNCH_GATE_REGISTER,
  GUEST_RETENTION_SCHEDULE,
  GUEST_ROLLOUT_STAGES,
  type GuestDataRetentionReason,
  type GuestLaunchGate,
  type GuestRetentionClass,
  type GuestRolloutStage,
  type GuestSignoffDiscipline,
} from '@mercaria/shared-types';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import { ErrorCodes, sendError, sendSuccess } from '../utils/api-response.js';
import { getDb } from '../db/postgres.js';
import {
  listRecentInterventions,
  readInterventionRates,
  reviewIntervention,
} from '../db/guestGovernance/abuseRepository.js';
import {
  liftLegalHold,
  listRetentionRuns,
  publishRetentionPolicyVersion,
  raiseLegalHold,
  readPolicyCoverage,
} from '../db/guestGovernance/retentionRepository.js';
import { listDataRequestsForGroup } from '../db/guestGovernance/dataRequestRepository.js';
import {
  listGateHistory,
  listStageAdvances,
  readCurrentStage,
  recordGateSignoff,
} from '../db/guestGovernance/rolloutRepository.js';
import {
  measureCleanupLag,
  readSecuritySignals,
} from '../services/guest-governance/security-signals.service.js';
import {
  minimizationClasses,
  proposedRetentionRules,
  runRetentionPass,
} from '../services/guest-governance/retention.service.js';
import { gatesRequiredFor, readGateStatuses, requestStageAdvance } from '../services/guest-governance/rollout.service.js';

/** How many rows a list route returns. Bounded, so a trace cannot page a table. */
const LIST_LIMIT = 100;

/** The default monitoring range — a day, which is what an alert review reads. */
const DEFAULT_RANGE_HOURS = 24;

/**
 * `GET /governance/inventory` — the data inventory and the retention schedule.
 *
 * Static DATA served from the shared-types tuples, so the document an auditor
 * reads and the rules the code follows are the same object. It also reports
 * which classes have an ACTIVE published policy and which do not — the vacuity
 * floor for the whole schedule, because a policy covering nine of thirteen
 * classes and one nobody published look identical to anything that reads one
 * class at a time.
 */
export async function guestDataInventoryHandler(_req: Request, res: Response): Promise<void> {
  const coverage = await readPolicyCoverage(getDb());
  sendSuccess(res, {
    inventory: GUEST_DATA_INVENTORY,
    schedule: GUEST_RETENTION_SCHEDULE,
    activePolicy: {
      covered: coverage.covered,
      missing: coverage.missing,
      complete: coverage.missing.length === 0,
    },
    featureGates: GUEST_FEATURE_GATE_REGISTER,
  });
}

/**
 * `POST /governance/retention-policy` — publish the schedule as a version.
 *
 * The body carries a version STRING and nothing else. The rules come from
 * `GUEST_RETENTION_SCHEDULE`, deliberately: a body able to carry retention
 * figures would let an operator publish a schedule no reviewer had seen, which
 * is the whole thing versioning exists to prevent. Changing a figure is a code
 * change, a review and a deploy; publishing is recording that the reviewed
 * figures are now in force.
 */
export async function publishGuestRetentionPolicyHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const version = typeof req.body?.version === 'string' ? req.body.version.trim() : '';
  if (version === '' || version.length > 64) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'A version string is required.', 400);
    return;
  }
  await getDb().transaction(async (tx) => {
    await publishRetentionPolicyVersion(tx, {
      version,
      publishedByOxyUserId: getRequiredOxyUserId(req),
      now: new Date(),
      rules: proposedRetentionRules().map((rule) => ({
        retentionClass: rule.retentionClass,
        retentionSeconds: rule.retentionSeconds,
        mechanism: rule.mechanism,
        pausableByLegalHold: rule.pausableByLegalHold,
        rationale: rule.rationale,
      })),
    });
  });
  sendSuccess(res, { version, classes: GUEST_RETENTION_SCHEDULE.length }, 201);
}

/** `GET /governance/retention-runs` — what each pass did, newest first. */
export async function listGuestRetentionRunsHandler(_req: Request, res: Response): Promise<void> {
  sendSuccess(res, {
    runs: await listRetentionRuns(getDb(), LIST_LIMIT),
    minimizationClasses: minimizationClasses(),
  });
}

/**
 * `POST /governance/retention-runs` — run one pass now.
 *
 * Drives the SAME function the scheduled loop drives, so this surface adds a
 * trigger and no second way to delete anything. Whether it dry-runs is
 * `GUEST_RETENTION_DRY_RUN`'s decision and not a body field — an operator able
 * to pass `mode: 'apply'` past a deployment that chose dry-run would make the
 * flag decorative.
 */
export async function runGuestRetentionPassHandler(req: Request, res: Response): Promise<void> {
  const retentionClass = req.body?.retentionClass as GuestRetentionClass | undefined;
  if (retentionClass === undefined || !minimizationClasses().includes(retentionClass)) {
    sendError(
      res,
      ErrorCodes.VALIDATION_ERROR,
      'retentionClass must name a class this job performs.',
      400,
    );
    return;
  }
  const outcome = await runRetentionPass({ retentionClass, now: new Date() });
  if (outcome.outcome === 'refused') {
    sendError(
      res,
      ErrorCodes.CONFLICT,
      `The retention pass was refused: ${outcome.reason}.`,
      409,
    );
    return;
  }
  sendSuccess(res, outcome.result, 202);
}

/** `POST /governance/legal-holds` — pause one class's deletion for one group. */
export async function raiseGuestLegalHoldHandler(req: Request, res: Response): Promise<void> {
  const checkoutGroupId = typeof req.body?.checkoutGroupId === 'string' ? req.body.checkoutGroupId : '';
  const retentionClass = req.body?.retentionClass as GuestRetentionClass | undefined;
  const reason = req.body?.reason as GuestDataRetentionReason | undefined;
  if (checkoutGroupId === '' || retentionClass === undefined || reason === undefined) {
    sendError(
      res,
      ErrorCodes.VALIDATION_ERROR,
      'checkoutGroupId, retentionClass and reason are required.',
      400,
    );
    return;
  }
  const holdId = await raiseLegalHold(getDb(), {
    checkoutGroupId,
    retentionClass,
    reason,
    raisedByOxyUserId: getRequiredOxyUserId(req),
    ...(typeof req.body?.evidenceRef === 'string' ? { evidenceRef: req.body.evidenceRef } : {}),
  });
  sendSuccess(res, { holdId }, 201);
}

/** `POST /governance/legal-holds/:holdId/lift` — attributable, dated and explained. */
export async function liftGuestLegalHoldHandler(req: Request, res: Response): Promise<void> {
  const liftReason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (liftReason === '') {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'A lift reason is required.', 400);
    return;
  }
  const lifted = await liftLegalHold(getDb(), {
    holdId: String(req.params.holdId),
    liftedByOxyUserId: getRequiredOxyUserId(req),
    liftReason,
    now: new Date(),
  });
  if (!lifted) {
    sendError(res, ErrorCodes.CONFLICT, 'That hold is not live.', 409);
    return;
  }
  sendSuccess(res, { lifted: true });
}

/**
 * `GET /governance/signals` — every security signal over a range.
 *
 * Measures the cleanup lag as part of the read, because that signal has no call
 * site to instrument: nothing HAPPENS when a retention job stops running, so
 * the absence has to be counted by somebody looking.
 */
export async function guestSecuritySignalsHandler(req: Request, res: Response): Promise<void> {
  const hours = Number.parseInt(String(req.query.hours ?? DEFAULT_RANGE_HOURS), 10);
  const window = Number.isFinite(hours) && hours > 0 && hours <= 720 ? hours : DEFAULT_RANGE_HOURS;
  const until = new Date();
  const since = new Date(until.getTime() - window * 60 * 60 * 1000);
  const cleanupLag = await measureCleanupLag(until);
  sendSuccess(res, {
    since: since.toISOString(),
    until: until.toISOString(),
    cleanupLag,
    signals: await readSecuritySignals({ since, until }),
  });
}

/**
 * `GET /governance/interventions` — the abuse queue.
 *
 * Carries NO subject hash: the column is protected, and it is the one
 * cross-row join key this domain has. A reviewer needs the pattern, the count
 * and the threshold, all of which are in the projection.
 */
export async function listGuestInterventionsHandler(req: Request, res: Response): Promise<void> {
  const until = new Date();
  const since = new Date(until.getTime() - 28 * 24 * 60 * 60 * 1000);
  const rates = await readInterventionRates(getDb(), { since, until });
  sendSuccess(res, {
    policies: GUEST_ABUSE_POLICIES,
    interventions: await listRecentInterventions(getDb(), { limit: LIST_LIMIT }),
    rates: {
      created: rates.created,
      falsePositives: rates.falsePositives,
      // Reported as counts and NOT as a ratio when the denominator is zero: a
      // rate of 0/0 renders as 0% and reads as "the controls are never wrong",
      // which is the opposite of what an empty window means.
      measurable: rates.created > 0,
    },
  });
}

/** `POST /governance/interventions/:id/review` — lift, or record a false positive. */
export async function reviewGuestInterventionHandler(req: Request, res: Response): Promise<void> {
  const state = req.body?.state;
  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
  if ((state !== 'lifted' && state !== 'false_positive') || note === '') {
    sendError(
      res,
      ErrorCodes.VALIDATION_ERROR,
      'state must be lifted or false_positive, and a note is required.',
      400,
    );
    return;
  }
  const reviewed = await reviewIntervention(getDb(), {
    interventionId: String(req.params.interventionId),
    state,
    reviewedByOxyUserId: getRequiredOxyUserId(req),
    note,
    now: new Date(),
  });
  if (!reviewed) {
    sendError(res, ErrorCodes.CONFLICT, 'That intervention is not active.', 409);
    return;
  }
  sendSuccess(res, { reviewed: true });
}

/** `GET /governance/rollout` — the stage, its gates and the advance history. */
export async function guestRolloutStatusHandler(req: Request, res: Response): Promise<void> {
  const db = getDb();
  const current = await readCurrentStage(db);
  const stage = (req.query.stage as GuestRolloutStage | undefined) ?? current ?? GUEST_ROLLOUT_STAGES[0];
  sendSuccess(res, {
    // `null` and `stage_0_internal` are DIFFERENT answers: nobody having
    // advanced anything is not the same as somebody deliberately advancing to
    // stage 0, and only the second has a row behind it.
    currentStage: current,
    inspectedStage: stage,
    requiredGates: gatesRequiredFor(stage),
    gates: await readGateStatuses(stage),
    register: GUEST_LAUNCH_GATE_REGISTER,
    advances: await listStageAdvances(db, LIST_LIMIT),
  });
}

/** `POST /governance/rollout/signoffs` — record a sign-off, or withdraw one. */
export async function recordGuestGateSignoffHandler(req: Request, res: Response): Promise<void> {
  const stage = req.body?.stage as GuestRolloutStage | undefined;
  const gate = req.body?.gate as GuestLaunchGate | undefined;
  const discipline = req.body?.discipline as GuestSignoffDiscipline | undefined;
  const satisfied = req.body?.satisfied;
  if (stage === undefined || gate === undefined || discipline === undefined || typeof satisfied !== 'boolean') {
    sendError(
      res,
      ErrorCodes.VALIDATION_ERROR,
      'stage, gate, discipline and a boolean satisfied are required.',
      400,
    );
    return;
  }
  const id = await recordGateSignoff(getDb(), {
    stage,
    gate,
    discipline,
    satisfied,
    signedByOxyUserId: getRequiredOxyUserId(req),
    ...(typeof req.body?.evidenceRef === 'string' ? { evidenceRef: req.body.evidenceRef } : {}),
    ...(typeof req.body?.note === 'string' ? { note: req.body.note } : {}),
  });
  sendSuccess(res, { signoffId: id, history: await listGateHistory(getDb(), { stage, gate }) }, 201);
}

/**
 * `POST /governance/rollout/advance` — ask to move to the next stage.
 *
 * Records the ATTEMPT either way, which is the point: a table holding only
 * successful advances answers "how did we get here" and cannot answer "what did
 * we try, and what stopped us".
 */
export async function advanceGuestRolloutStageHandler(req: Request, res: Response): Promise<void> {
  const stage = req.body?.stage as GuestRolloutStage | undefined;
  if (stage === undefined || !GUEST_ROLLOUT_STAGES.includes(stage)) {
    sendError(res, ErrorCodes.VALIDATION_ERROR, 'stage must name a rollout stage.', 400);
    return;
  }
  const verdict = await requestStageAdvance({
    stage,
    requestedByOxyUserId: getRequiredOxyUserId(req),
    ...(typeof req.body?.note === 'string' ? { note: req.body.note } : {}),
  });
  sendSuccess(res, verdict, verdict.outcome === 'permitted' ? 201 : 409);
}

/**
 * `GET /governance/data-requests/:checkoutGroupId` — the erasure audit.
 *
 * Opens from a GROUP and nothing else. There is no lookup by email, by hash or
 * by account, which is what stops this surface answering "what has this inbox
 * ever asked us to delete" — #108's trace shape, for its reason.
 */
export async function listGuestDataRequestsHandler(req: Request, res: Response): Promise<void> {
  sendSuccess(res, {
    requests: await listDataRequestsForGroup(getDb(), String(req.params.checkoutGroupId)),
  });
}
