/**
 * Program lifecycle (#142, API 1): draft, publish, pause, resume, retire.
 *
 * ## The immutability rule, and where each half of it lives
 *
 * "An active version cannot be edited. Publish a new version." The repository
 * enforces the letter (draft edits are a CAS on `status = 'draft'`); this
 * service enforces the shape: the only way to change live terms is
 * {@link createNextProgramVersion} — a clone into a new draft — followed by
 * {@link publishProgram}, which ENDS the currently-active version and activates
 * the new one in one transaction. Prior attributions are untouched by
 * construction: they reference the version ROW they pinned (ADR 0005 D19), and
 * nothing here writes to a published row except its status timestamps.
 *
 * Retirement is prospective only (ADR 0005 D18): it blocks NEW attribution —
 * the attribution service refuses a program with no active version — and never
 * touches historical settlement, which runs from the version rows and
 * attributions that already exist.
 *
 * Every transition appends a `referral_events` row in the SAME transaction, so
 * the audit trail cannot claim a transition that rolled back.
 */

import { uuidv7 } from '@oxyhq/db';
import { conflict, notFound, validationError } from '../../lib/errors/error-codes.js';
import { getDb } from '../../db/postgres.js';
import {
  findActiveProgramVersion,
  findLatestProgramVersion,
  findProgramVersionById,
  insertProgramVersion,
  transitionProgramStatus,
  updateProgramDraft,
  type CreateProgramVersionInput,
  type ProgramDraftPatch,
  type ReferralProgramRow,
} from '../../db/referrals/programRepository.js';
import { appendReferralEvent } from '../../db/referrals/eventRepository.js';

/** What a caller supplies to open a brand-new program's first draft. */
export type CreateProgramDraftInput = Omit<CreateProgramVersionInput, 'programId' | 'version'>;

/** Create version 1 of a NEW program, as a draft. */
export async function createProgramDraft(
  input: CreateProgramDraftInput,
): Promise<ReferralProgramRow> {
  validateWindows(input);
  const db = getDb();
  return await db.transaction(async (tx) => {
    const row = await insertProgramVersion(tx, {
      ...input,
      programId: uuidv7(),
      version: 1,
    });
    await appendReferralEvent(tx, {
      subjectType: 'program',
      subjectId: row.id,
      action: 'program_drafted',
      actorKind: 'operator',
      actorRef: input.createdByOxyUserId,
      reason: `Drafted ${row.programId} v1`,
    });
    return row;
  });
}

/**
 * Clone the latest version of a program into the NEXT draft — the only path
 * to changing published terms.
 */
export async function createNextProgramVersion(input: {
  programId: string;
  createdByOxyUserId: string;
}): Promise<ReferralProgramRow> {
  const db = getDb();
  return await db.transaction(async (tx) => {
    const latest = await findLatestProgramVersion(tx, input.programId);
    if (!latest) throw notFound('Referral program not found');
    if (latest.status === 'draft') {
      throw conflict('This program already has an unpublished draft — edit it instead');
    }
    const row = await insertProgramVersion(tx, {
      programId: latest.programId,
      version: latest.version + 1,
      name: latest.name,
      description: latest.description,
      publicTermsSummary: latest.publicTermsSummary,
      family: latest.family,
      effectiveStartAt: latest.effectiveStartAt ?? undefined,
      effectiveEndAt: latest.effectiveEndAt ?? undefined,
      eligiblePartnerTypes: latest.eligiblePartnerTypes,
      eligibleSubjectKinds: latest.eligibleSubjectKinds,
      markets: latest.markets,
      currencies: latest.currencies,
      channels: latest.channels,
      commercialModes: latest.commercialModes,
      attributionPolicy: latest.attributionPolicy,
      attributionWindowDays: latest.attributionWindowDays,
      activationWindowDays: latest.activationWindowDays ?? undefined,
      qualifyingEventPolicy: latest.qualifyingEventPolicy,
      commissionRuleRef: latest.commissionRuleRef,
      holdDays: latest.holdDays,
      capPolicyRef: latest.capPolicyRef ?? undefined,
      payoutPolicyRef: latest.payoutPolicyRef,
      termsVersion: latest.termsVersion,
      disclosureVersion: latest.disclosureVersion,
      createdByOxyUserId: input.createdByOxyUserId,
      featureFlagKey: latest.featureFlagKey ?? undefined,
      cohortKeys: latest.cohortKeys,
    });
    await appendReferralEvent(tx, {
      subjectType: 'program',
      subjectId: row.id,
      action: 'program_drafted',
      actorKind: 'operator',
      actorRef: input.createdByOxyUserId,
      reason: `Drafted ${row.programId} v${row.version} from v${latest.version}`,
    });
    return row;
  });
}

/**
 * Edit a DRAFT version. A published version matches nothing and is answered
 * with the conflict the issue names: publish a new version to change it.
 */
export async function editProgramDraft(
  id: string,
  patch: ProgramDraftPatch,
): Promise<ReferralProgramRow> {
  if (patch.attributionWindowDays !== undefined && patch.attributionWindowDays <= 0) {
    throw validationError('attributionWindowDays must be positive');
  }
  if (patch.holdDays !== undefined && patch.holdDays < 0) {
    throw validationError('holdDays cannot be negative');
  }
  const db = getDb();
  const row = await updateProgramDraft(db, id, patch);
  if (row) return row;

  const existing = await findProgramVersionById(db, id);
  if (!existing) throw notFound('Referral program version not found');
  throw conflict(
    `Version ${existing.version} is ${existing.status} and cannot be edited — publish a new version to change it`,
  );
}

/**
 * Publish a DRAFT: it becomes `active` (or `scheduled` when its start is in
 * the future), and the previously-active version of the same program — if any
 * — is ENDED in the same transaction. The one-active partial unique index is
 * the backstop against two publishers racing.
 */
export async function publishProgram(input: {
  id: string;
  approvedByOxyUserId: string;
  at?: Date;
}): Promise<ReferralProgramRow> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const draft = await findProgramVersionById(tx, input.id);
    if (!draft) throw notFound('Referral program version not found');
    if (draft.status !== 'draft') {
      throw conflict(`Version ${draft.version} is ${draft.status}, not a draft`);
    }

    const effectiveStartAt = draft.effectiveStartAt ?? at;
    const to = effectiveStartAt.getTime() > at.getTime() ? 'scheduled' : 'active';

    if (to === 'active') {
      const active = await findActiveProgramVersion(tx, draft.programId);
      if (active) {
        const ended = await transitionProgramStatus(tx, {
          id: active.id,
          expected: 'active',
          to: 'ended',
          at,
        });
        if (!ended) {
          throw conflict('The active version changed while publishing — retry');
        }
        await appendReferralEvent(tx, {
          subjectType: 'program',
          subjectId: active.id,
          action: 'program_ended',
          actorKind: 'operator',
          actorRef: input.approvedByOxyUserId,
          reason: `Superseded by v${draft.version}`,
        });
      }
    }

    const row = await transitionProgramStatus(tx, {
      id: draft.id,
      expected: 'draft',
      to,
      at,
      approvedByOxyUserId: input.approvedByOxyUserId,
      effectiveStartAt,
    });
    if (!row) throw conflict('The draft changed while publishing — retry');
    await appendReferralEvent(tx, {
      subjectType: 'program',
      subjectId: row.id,
      action: 'program_published',
      actorKind: 'operator',
      actorRef: input.approvedByOxyUserId,
      reason: `Published ${row.programId} v${row.version} as ${to}`,
    });
    return row;
  });
}

/** Pause an active version — instruments stop resolving, nothing durable moves. */
export async function pauseProgram(input: {
  id: string;
  actorOxyUserId: string;
  reason: string;
  at?: Date;
}): Promise<ReferralProgramRow> {
  return await transition(input, 'active', 'paused', 'program_paused');
}

/** Resume a paused version. */
export async function resumeProgram(input: {
  id: string;
  actorOxyUserId: string;
  reason: string;
  at?: Date;
}): Promise<ReferralProgramRow> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const row = await transitionProgramStatus(tx, {
      id: input.id,
      expected: 'paused',
      to: 'active',
      at,
    });
    if (!row) {
      const existing = await findProgramVersionById(tx, input.id);
      if (!existing) throw notFound('Referral program version not found');
      throw conflict(`Version ${existing.version} is ${existing.status}, not paused`);
    }
    await appendReferralEvent(tx, {
      subjectType: 'program',
      subjectId: row.id,
      action: 'program_resumed',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: input.reason,
    });
    return row;
  });
}

/**
 * Retire a version — terminal, prospective only (ADR 0005 D18). New touches
 * and attributions stop because the program no longer has an active version;
 * every existing attribution, conversion and (later, #145) reward runs its
 * ordinary lifecycle untouched.
 */
export async function retireProgram(input: {
  id: string;
  actorOxyUserId: string;
  reason: string;
  at?: Date;
}): Promise<ReferralProgramRow> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const existing = await findProgramVersionById(tx, input.id);
    if (!existing) throw notFound('Referral program version not found');
    if (existing.status === 'retired') return existing;
    if (existing.status === 'draft') {
      throw conflict('A draft has never been live and cannot be retired');
    }
    const row = await transitionProgramStatus(tx, {
      id: existing.id,
      expected: existing.status,
      to: 'retired',
      at,
    });
    if (!row) throw conflict('The version changed while retiring — retry');
    await appendReferralEvent(tx, {
      subjectType: 'program',
      subjectId: row.id,
      action: 'program_retired',
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: input.reason,
    });
    return row;
  });
}

/** Shared pause-shape transition with its audit row. */
async function transition(
  input: { id: string; actorOxyUserId: string; reason: string; at?: Date },
  expected: 'active',
  to: 'paused',
  action: 'program_paused',
): Promise<ReferralProgramRow> {
  const at = input.at ?? new Date();
  const db = getDb();
  return await db.transaction(async (tx) => {
    const row = await transitionProgramStatus(tx, { id: input.id, expected, to, at });
    if (!row) {
      const existing = await findProgramVersionById(tx, input.id);
      if (!existing) throw notFound('Referral program version not found');
      throw conflict(`Version ${existing.version} is ${existing.status}, not ${expected}`);
    }
    await appendReferralEvent(tx, {
      subjectType: 'program',
      subjectId: row.id,
      action,
      actorKind: 'operator',
      actorRef: input.actorOxyUserId,
      reason: input.reason,
    });
    return row;
  });
}

/** Input validation shared by the create paths. */
function validateWindows(input: CreateProgramDraftInput): void {
  if (input.attributionWindowDays <= 0) {
    throw validationError('attributionWindowDays must be positive');
  }
  if (input.activationWindowDays !== undefined && input.activationWindowDays <= 0) {
    throw validationError('activationWindowDays must be positive when set');
  }
  if (input.holdDays < 0) {
    throw validationError('holdDays cannot be negative');
  }
  if (input.eligiblePartnerTypes.length === 0 || input.eligibleSubjectKinds.length === 0) {
    throw validationError('A program must name who can enroll and what can be referred');
  }
}
