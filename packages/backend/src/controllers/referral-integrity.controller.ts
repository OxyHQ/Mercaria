/**
 * The referral INTEGRITY controllers (THIN) — #148.
 *
 * Two surfaces, and the split is the privacy model:
 *
 *  - the OPERATOR half publishes conduct policies and disclosures, records
 *    manual evidence, runs one risk evaluation, imposes and lifts scoped
 *    enforcement, and decides appeals;
 *  - the PARTNER half reads the rules they are held to, the disclosure copy
 *    they must render, the actions against them (through
 *    `ReferralEnforcementPartnerView`, which carries no operator identity and
 *    no evidence ids) and files an appeal.
 *
 * The operator route set is CLOSED and the omissions are the design. There is
 * no "clear this signal", no "edit this action", no "delete this appeal" and no
 * "set this partner's risk state" — each would be a way to make the enforcement
 * record say something nobody decided, and the two corrections an operator
 * legitimately makes (a LIFT, and an appeal DECISION) are both append-only and
 * both name their actor.
 *
 * There is also deliberately no route that OPENS an appeal on a partner's
 * behalf: an operator who could open one could open one they then decide, and
 * the independence CHECK would be satisfied by two accounts one person holds.
 */

import type { Request, Response } from 'express';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import type {
  ReferralDisclosureSurface,
  ReferralEnforcementAction,
  ReferralEnforcementBasis,
  ReferralEnforcementScope,
  ReferralProhibitedConduct,
  ReferralRiskSubjectType,
} from '@mercaria/shared-types';
import { sendSuccess } from '../utils/api-response.js';
import { notFound, respondWithError } from '../lib/errors/error-codes.js';
import { routeParam } from '../utils/request.js';
import { getDb } from '../db/postgres.js';
import { findPartnerByOwner } from '../db/referrals/partnerRepository.js';
import { findRiskSignalsForPartner } from '../db/referralIntegrity/riskSignalRepository.js';
import {
  draftConductPolicy,
  publishConductPolicy,
  readActiveConductPolicy,
  readConductPolicyVersions,
} from '../services/referrals/integrity/conduct-policy.service.js';
import {
  draftDisclosure,
  publishDisclosure,
  readDisclosuresForPartner,
} from '../services/referrals/integrity/disclosure.service.js';
import {
  imposeEnforcementAction,
  liftEnforcement,
  readEnforcementEffects,
  readEnforcementForPartner,
  readEnforcementHistory,
} from '../services/referrals/integrity/enforcement.service.js';
import {
  decideAppeal,
  openEnforcementAppeal,
  readAppealsForPartner,
} from '../services/referrals/integrity/appeal.service.js';
import {
  evaluatePartnerRisk,
  recordManualRiskSignal,
} from '../services/referrals/integrity/risk-evaluation.service.js';

// ─── Operator: the conduct policy ───────────────────────────────────────────

/** Every version of the conduct policy, newest first. */
export async function listConductPolicyVersionsHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    sendSuccess(res, { versions: await readConductPolicyVersions() });
  } catch (error) {
    respondWithError(res, error, 'Referral integrity request failed');
  }
}

/** Draft a version. The version NUMBER is derived, never supplied. */
export async function draftConductPolicyHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      prohibitedConduct: ReferralProhibitedConduct[];
      termsVersion?: string;
      summary: string;
      effectiveFrom?: string;
    };
    const view = await draftConductPolicy({
      prohibitedConduct: body.prohibitedConduct,
      termsVersion: body.termsVersion,
      summary: body.summary,
      effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : new Date(),
      actorOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, view, 201);
  } catch (error) {
    respondWithError(res, error, 'Referral integrity request failed');
  }
}

/** Publish a draft, superseding the incumbent in the same transaction. */
export async function publishConductPolicyHandler(req: Request, res: Response): Promise<void> {
  try {
    const view = await publishConductPolicy({
      policyId: routeParam(req, 'policyId'),
      actorOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, view);
  } catch (error) {
    respondWithError(res, error, 'Referral integrity request failed');
  }
}

// ─── Operator: disclosures ──────────────────────────────────────────────────

/** Draft one disclosure requirement, refusing any forbidden claim by name. */
export async function draftDisclosureHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as {
      surface: ReferralDisclosureSurface;
      market?: string;
      language?: string;
      copy: string;
      required?: boolean;
      effectiveFrom?: string;
    };
    const view = await draftDisclosure({
      surface: body.surface,
      market: body.market,
      language: body.language,
      copy: body.copy,
      required: body.required,
      effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : new Date(),
      actorOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, view, 201);
  } catch (error) {
    respondWithError(res, error, 'Referral integrity request failed');
  }
}

/** Publish a disclosure draft. */
export async function publishDisclosureHandler(req: Request, res: Response): Promise<void> {
  try {
    const view = await publishDisclosure({
      disclosureId: routeParam(req, 'disclosureId'),
      actorOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, view);
  } catch (error) {
    respondWithError(res, error, 'Referral integrity request failed');
  }
}

// ─── Operator: one partner's integrity picture ──────────────────────────────

/**
 * The trace: what is in force, what was decided, what was observed, what was
 * appealed.
 *
 * It opens from a PARTNER id and nothing else. There is no "which partners
 * match this signal" and no search by name, email or URL — a fraud surface that
 * could be asked "who looks suspicious" is one that has to answer.
 */
export async function traceReferralIntegrityHandler(req: Request, res: Response): Promise<void> {
  try {
    const partnerId = routeParam(req, 'partnerId');
    const db = getDb();
    const [effects, actions, appeals, signals] = await Promise.all([
      readEnforcementEffects(db, partnerId),
      readEnforcementHistory(partnerId),
      readAppealsForPartner(db, partnerId),
      findRiskSignalsForPartner(db, partnerId),
    ]);
    sendSuccess(res, {
      partnerId,
      effects,
      actions,
      appeals,
      signals: signals.map((row) => ({
        id: row.id,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        kind: row.kind,
        severity: row.severity,
        observedValue: row.observedValue,
        thresholdValue: row.thresholdValue ?? undefined,
        windowStart: row.windowStart.toISOString(),
        windowEnd: row.windowEnd.toISOString(),
        recordedByKind: row.recordedByKind,
        note: row.note ?? undefined,
        expiresAt: row.expiresAt.toISOString(),
      })),
    });
  } catch (error) {
    respondWithError(res, error, 'Referral integrity request failed');
  }
}

/** Measure a partner over the trailing window and record whatever fired. */
export async function evaluateReferralRiskHandler(req: Request, res: Response): Promise<void> {
  try {
    const written = await evaluatePartnerRisk({ partnerId: routeParam(req, 'partnerId') });
    // An EMPTY result is the ordinary answer for a partner inside every
    // threshold, and it is reported as one rather than as a failure.
    sendSuccess(res, { recorded: written.length, kinds: written.map((row) => row.kind) });
  } catch (error) {
    respondWithError(res, error, 'Referral integrity request failed');
  }
}

/** Record one observation an operator made by hand, attributably. */
export async function recordReferralRiskSignalHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = req.body as {
      subjectType: ReferralRiskSubjectType;
      subjectId: string;
      note: string;
      evidenceRef?: string;
    };
    const row = await recordManualRiskSignal({
      partnerId: routeParam(req, 'partnerId'),
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      note: body.note,
      evidenceRef: body.evidenceRef,
      actorOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, { id: row.id, kind: row.kind }, 201);
  } catch (error) {
    respondWithError(res, error, 'Referral integrity request failed');
  }
}

// ─── Operator: enforcement ──────────────────────────────────────────────────

/** Impose one scoped action. */
export async function imposeReferralEnforcementHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = req.body as {
      action: ReferralEnforcementAction;
      scope: ReferralEnforcementScope;
      subjectId: string;
      programId?: string;
      basis: ReferralEnforcementBasis;
      conduct?: ReferralProhibitedConduct;
      reason: string;
      evidenceSignalIds?: string[];
      expiresAt?: string;
    };
    const view = await imposeEnforcementAction({
      partnerId: routeParam(req, 'partnerId'),
      action: body.action,
      scope: body.scope,
      subjectId: body.subjectId,
      programId: body.programId,
      basis: body.basis,
      conduct: body.conduct,
      reason: body.reason,
      evidenceSignalIds: body.evidenceSignalIds,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
      actorOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, view, 201);
  } catch (error) {
    respondWithError(res, error, 'Referral integrity request failed');
  }
}

/** Lift one, attributably. The decision itself is never edited. */
export async function liftReferralEnforcementHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { reason: string };
    const view = await liftEnforcement({
      actionId: routeParam(req, 'actionId'),
      reason: body.reason,
      actorOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, view);
  } catch (error) {
    respondWithError(res, error, 'Referral integrity request failed');
  }
}

/** Decide an open appeal, as a DIFFERENT operator. */
export async function decideReferralAppealHandler(req: Request, res: Response): Promise<void> {
  try {
    const body = req.body as { decision: 'accepted' | 'rejected'; reason: string };
    const view = await decideAppeal({
      appealId: routeParam(req, 'appealId'),
      decision: body.decision,
      reason: body.reason,
      actorOxyUserId: getRequiredOxyUserId(req),
    });
    sendSuccess(res, view);
  } catch (error) {
    respondWithError(res, error, 'Referral integrity request failed');
  }
}

// ─── Partner: the rules, the copy, the record and the appeal ────────────────

/**
 * The prohibited-conduct policy a partner is held to.
 *
 * Mounted with NO enrollment requirement, which is #148's *"visible before
 * participation"*: an account that has never applied can read exactly what it
 * would be agreeing to, and gating it behind enrollment would make the
 * requirement unmeetable by construction. `undefined` when nothing is
 * published, which is an honest absence rather than an invented policy.
 */
export async function getReferralConductPolicyHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    sendSuccess(res, { policy: (await readActiveConductPolicy()) ?? null });
  } catch (error) {
    respondWithError(res, error, 'Referral integrity request failed');
  }
}

/** The disclosure copy for one market and language, most specific first. */
export async function getReferralDisclosuresHandler(req: Request, res: Response): Promise<void> {
  try {
    const market = typeof req.query.market === 'string' ? req.query.market : '*';
    const language = typeof req.query.language === 'string' ? req.query.language : '*';
    sendSuccess(res, { disclosures: await readDisclosuresForPartner({ market, language }) });
  } catch (error) {
    respondWithError(res, error, 'Referral integrity request failed');
  }
}

/**
 * Resolve the caller's own partner row, or 404.
 *
 * The owner arrives from `makeReferralPartnerRouter`'s resolver (#146), so the
 * store half has already been through `requireStorePermission('store:manage')`
 * and the self half takes the owner from the verified caller. This file answers
 * the store-permission question NOWHERE, which is what its isolation gate
 * asserts.
 */
async function requireOwnPartnerId(
  owner: { ownerType: 'user' | 'store'; ownerId: string },
): Promise<string> {
  const partner = await findPartnerByOwner(getDb(), owner);
  if (!partner) throw notFound('You are not a referral partner');
  return partner.id;
}

/** What a partner may see about the actions against them. */
export function makeReferralEnforcementPartnerHandlers(
  resolveOwner: (req: Request) => { ownerType: 'user' | 'store'; ownerId: string },
) {
  return {
    async list(req: Request, res: Response): Promise<void> {
      try {
        const partnerId = await requireOwnPartnerId(resolveOwner(req));
        const db = getDb();
        const [actions, appeals] = await Promise.all([
          readEnforcementForPartner(db, partnerId),
          readAppealsForPartner(db, partnerId),
        ]);
        sendSuccess(res, { actions, appeals });
      } catch (error) {
        respondWithError(res, error, 'Referral integrity request failed');
      }
    },

    async appeal(req: Request, res: Response): Promise<void> {
      try {
        const owner = resolveOwner(req);
        const partnerId = await requireOwnPartnerId(owner);
        const body = req.body as { reason: string };
        const view = await openEnforcementAppeal({
          actionId: routeParam(req, 'actionId'),
          partnerId,
          submittedByOxyUserId: getRequiredOxyUserId(req),
          reason: body.reason,
        });
        sendSuccess(res, view, 201);
      } catch (error) {
        respondWithError(res, error, 'Referral integrity request failed');
      }
    },
  };
}
