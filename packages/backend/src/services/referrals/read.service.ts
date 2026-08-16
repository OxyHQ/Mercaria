/**
 * Partner-safe and operator reads (#142, APIs 7 and 8).
 *
 * ## The partner projections are explicit ALLOW-LISTS (ADR 0005 A5)
 *
 * Every field is NAMED; nothing is passed through. The attribution view in
 * particular carries a day-granularity date, the state, the program and the
 * subject KIND — no subject reference, no order data, no contact data, at any
 * aggregation level. The DTO shapes live in `@mercaria/shared-types` so the
 * dashboard consumes the same contract, and the projection functions here are
 * the only place a row becomes one.
 *
 * ## The operator trace is a different function on purpose
 *
 * Provenance — full rows, events, conversions — is an operator concern with an
 * operator gate to come (#147 owns the surface; the interim gate follows
 * `PAYMENT_OPERATOR_OXY_USER_IDS` when it is mounted). Keeping it a separate
 * function means a partner endpoint can never "accidentally" reach it by
 * passing a flag.
 */

import type {
  ReferralAttributionPartnerView,
  ReferralCodePartnerView,
  ReferralLinkPartnerView,
  ReferralProgramPartnerView,
} from '@mercaria/shared-types';
import { notFound } from '../../lib/errors/error-codes.js';
import { getDb } from '../../db/postgres.js';
import {
  findActiveProgramVersion,
  type ReferralProgramRow,
} from '../../db/referrals/programRepository.js';
import {
  listCodesByPartner,
  listLinksByCode,
  type ReferralCodeRow,
  type ReferralLinkRow,
} from '../../db/referrals/instrumentRepository.js';
import {
  findAttributionById,
  listAttributionsByPartner,
  listAttributionsForSubject,
  type ReferralAttributionRow,
} from '../../db/referrals/attributionRepository.js';
import { listConversionsByAttribution } from '../../db/referrals/conversionRepository.js';
import { listReferralEvents } from '../../db/referrals/eventRepository.js';

/** The active version of a program, projected for a partner. */
export async function partnerProgramView(programId: string): Promise<ReferralProgramPartnerView> {
  const db = getDb();
  const version = await findActiveProgramVersion(db, programId);
  if (!version) throw notFound('Referral program not found or not active');
  return projectProgram(version);
}

/** A partner's own codes, newest first, keyset-paginated. */
export async function partnerCodesView(input: {
  partnerId: string;
  limit?: number;
  before?: Date;
}): Promise<ReferralCodePartnerView[]> {
  const db = getDb();
  const rows = await listCodesByPartner(db, {
    partnerId: input.partnerId,
    limit: clampLimit(input.limit),
    before: input.before,
  });
  return rows.map(projectCode);
}

/** A code's links, newest first — the partner shares the tokens themselves. */
export async function partnerLinksView(input: {
  codeId: string;
  limit?: number;
  before?: Date;
}): Promise<ReferralLinkPartnerView[]> {
  const db = getDb();
  const rows = await listLinksByCode(db, {
    codeId: input.codeId,
    limit: clampLimit(input.limit),
    before: input.before,
  });
  return rows.map(projectLink);
}

/** A partner's attributions in the A5 shape — nothing about WHO was referred. */
export async function partnerAttributionsView(input: {
  partnerId: string;
  limit?: number;
  before?: Date;
}): Promise<ReferralAttributionPartnerView[]> {
  const db = getDb();
  const rows = await listAttributionsByPartner(db, {
    partnerId: input.partnerId,
    limit: clampLimit(input.limit),
    before: input.before,
  });
  return rows.map(projectAttributionForPartner);
}

/**
 * OPERATOR-ONLY provenance: one attribution with its full audit trail and
 * conversions. Never mounted for partners; the caller is responsible for the
 * operator gate.
 */
export async function operatorAttributionTrace(attributionId: string): Promise<{
  attribution: ReferralAttributionRow;
  events: Awaited<ReturnType<typeof listReferralEvents>>;
  conversions: Awaited<ReturnType<typeof listConversionsByAttribution>>;
}> {
  const db = getDb();
  const attribution = await findAttributionById(db, attributionId);
  if (!attribution) throw notFound('Referral attribution not found');
  const [events, conversions] = await Promise.all([
    listReferralEvents(db, { subjectType: 'attribution', subjectId: attribution.id }),
    listConversionsByAttribution(db, attribution.id),
  ]);
  return { attribution, events, conversions };
}

/** OPERATOR-ONLY: a subject's full attribution history (correction reads). */
export async function operatorSubjectHistory(input: {
  subjectKind: ReferralAttributionRow['subjectKind'];
  subjectRef: string;
  limit?: number;
}): Promise<ReferralAttributionRow[]> {
  const db = getDb();
  return await listAttributionsForSubject(db, {
    subjectKind: input.subjectKind,
    subjectRef: input.subjectRef,
    limit: clampLimit(input.limit),
  });
}

// ─── Projections: the allow-lists themselves ─────────────────────────────────

function projectProgram(row: ReferralProgramRow): ReferralProgramPartnerView {
  return {
    programId: row.programId,
    version: row.version,
    name: row.name,
    publicTermsSummary: row.publicTermsSummary,
    family: row.family,
    status: row.status,
    ...(row.effectiveStartAt !== null ? { effectiveStartAt: row.effectiveStartAt.toISOString() } : {}),
    ...(row.effectiveEndAt !== null ? { effectiveEndAt: row.effectiveEndAt.toISOString() } : {}),
    attributionWindowDays: row.attributionWindowDays,
    termsVersion: row.termsVersion,
    disclosureVersion: row.disclosureVersion,
  };
}

export function projectCode(row: ReferralCodeRow): ReferralCodePartnerView {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    programId: row.programVersionId,
    ...(row.destinationType !== null ? { destinationType: row.destinationType } : {}),
    ...(row.destinationRef !== null ? { destinationRef: row.destinationRef } : {}),
    ...(row.campaignRef !== null ? { campaignRef: row.campaignRef } : {}),
    ...(row.market !== null ? { market: row.market } : {}),
    ...(row.locale !== null ? { locale: row.locale } : {}),
    disclosureRequired: row.disclosureRequired,
    createdAt: row.createdAt.toISOString(),
    ...(row.expiresAt !== null ? { expiresAt: row.expiresAt.toISOString() } : {}),
  };
}

export function projectLink(row: ReferralLinkRow): ReferralLinkPartnerView {
  return {
    id: row.id,
    codeId: row.codeId,
    token: row.token,
    status: row.status,
    ...(row.destinationType !== null ? { destinationType: row.destinationType } : {}),
    ...(row.destinationRef !== null ? { destinationRef: row.destinationRef } : {}),
    ...(row.campaignRef !== null ? { campaignRef: row.campaignRef } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.expiresAt !== null ? { expiresAt: row.expiresAt.toISOString() } : {}),
  };
}

/** ADR 0005 A5: day-granularity date, state, program, subject KIND. Nothing else. */
export function projectAttributionForPartner(
  row: ReferralAttributionRow,
): ReferralAttributionPartnerView {
  return {
    date: row.createdAt.toISOString().slice(0, 10),
    state: row.state,
    programId: row.programId,
    subjectKind: row.subjectKind,
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 50;
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}
