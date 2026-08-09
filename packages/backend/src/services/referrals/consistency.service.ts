/**
 * Consistency checks and repair REPORTS (#142, API 10).
 *
 * Reports, not repairs: every finding is an observation an operator reads, and
 * nothing here writes anything — the payment domain's rule that a sweep may
 * observe and a repair is an explicit operator action, applied to a domain
 * that does not move money yet. When #145's earnings ledger lands, its
 * reconciliation sweep extends this shape rather than replacing it.
 */

import { and, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { getDb } from '../../db/postgres.js';
import {
  referralAttributions,
  referralCodes,
  referralConversions,
  referralLinks,
  referralPartners,
  referralPrograms,
} from '../../db/schema/referrals.js';

/** One observed inconsistency (or noteworthy condition), for an operator. */
export interface ReferralConsistencyFinding {
  kind:
    | 'expired_active_attribution'
    | 'active_attribution_partner_not_approved'
    | 'active_attribution_program_not_active'
    | 'eligible_conversion_attribution_not_active'
    | 'active_link_code_not_active'
    | 'duplicate_active_attribution';
  subjectId: string;
  detail: string;
}

/** Per-run bound, so a backlog cannot turn a report into a table scan of everything. */
const FINDING_LIMIT = 200;

/**
 * Run every check and return the findings. Read-only by construction — the
 * only statements in this file are SELECTs.
 */
export async function runReferralConsistencyChecks(input?: {
  at?: Date;
}): Promise<ReferralConsistencyFinding[]> {
  const at = input?.at ?? new Date();
  const db = getDb();
  const findings: ReferralConsistencyFinding[] = [];

  // Active attributions past their window: legitimate (expiry is a timestamp,
  // not a state) but worth surfacing — conversions against them will reject.
  const expired = await db
    .select({ id: referralAttributions.id, expiresAt: referralAttributions.expiresAt })
    .from(referralAttributions)
    .where(
      and(eq(referralAttributions.state, 'active'), lte(referralAttributions.expiresAt, at)),
    )
    .limit(FINDING_LIMIT);
  for (const row of expired) {
    findings.push({
      kind: 'expired_active_attribution',
      subjectId: row.id,
      detail: `Active attribution expired ${row.expiresAt.toISOString()}`,
    });
  }

  // Active attributions whose partner is no longer approved. Expected under
  // D18 (historical records survive suspension) — reported so an operator can
  // see the population the policy applies to.
  const suspendedPartners = await db
    .select({ id: referralAttributions.id, partnerId: referralAttributions.partnerId })
    .from(referralAttributions)
    .innerJoin(referralPartners, eq(referralAttributions.partnerId, referralPartners.id))
    .where(and(eq(referralAttributions.state, 'active'), ne(referralPartners.state, 'approved')))
    .limit(FINDING_LIMIT);
  for (const row of suspendedPartners) {
    findings.push({
      kind: 'active_attribution_partner_not_approved',
      subjectId: row.id,
      detail: `Partner ${row.partnerId} is not approved`,
    });
  }

  // Active attributions whose pinned program version is no longer the active
  // one AND whose program has no active version at all (retired/ended).
  const orphanedPrograms = await db
    .select({ id: referralAttributions.id, programId: referralAttributions.programId })
    .from(referralAttributions)
    .where(
      and(
        eq(referralAttributions.state, 'active'),
        sql`not exists (select 1 from ${referralPrograms}
             where ${referralPrograms.programId} = ${referralAttributions.programId}
               and ${referralPrograms.status} = 'active')`,
      ),
    )
    .limit(FINDING_LIMIT);
  for (const row of orphanedPrograms) {
    findings.push({
      kind: 'active_attribution_program_not_active',
      subjectId: row.id,
      detail: `Program ${row.programId} has no active version`,
    });
  }

  // Eligible conversions whose attribution left `active` after verification —
  // the population #145's reversal machinery will need to look at.
  const detachedConversions = await db
    .select({ id: referralConversions.id, attributionId: referralConversions.attributionId })
    .from(referralConversions)
    .innerJoin(
      referralAttributions,
      eq(referralConversions.attributionId, referralAttributions.id),
    )
    .where(
      and(
        eq(referralConversions.state, 'eligible'),
        inArray(referralAttributions.state, ['invalidated', 'conflicted']),
      ),
    )
    .limit(FINDING_LIMIT);
  for (const row of detachedConversions) {
    findings.push({
      kind: 'eligible_conversion_attribution_not_active',
      subjectId: row.id,
      detail: `Attribution ${row.attributionId} is no longer standing`,
    });
  }

  // Live links wrapping a code that can no longer attribute.
  const liveLinksDeadCodes = await db
    .select({ id: referralLinks.id, codeId: referralLinks.codeId })
    .from(referralLinks)
    .innerJoin(referralCodes, eq(referralLinks.codeId, referralCodes.id))
    .where(and(eq(referralLinks.status, 'active'), ne(referralCodes.status, 'active')))
    .limit(FINDING_LIMIT);
  for (const row of liveLinksDeadCodes) {
    findings.push({
      kind: 'active_link_code_not_active',
      subjectId: row.id,
      detail: `Code ${row.codeId} is not active`,
    });
  }

  // Two active winners for one scope — impossible while the partial unique
  // index stands; checked anyway, because the index is the invariant this
  // whole domain leans on and a dropped index has no other symptom
  // (the generated-column lesson: the definition can outlive the DDL).
  const duplicateWinners = await db
    .select({
      programId: referralAttributions.programId,
      subjectKind: referralAttributions.subjectKind,
      subjectRef: referralAttributions.subjectRef,
    })
    .from(referralAttributions)
    .where(and(eq(referralAttributions.state, 'active'), isNull(referralAttributions.resolvedAt)))
    .groupBy(
      referralAttributions.programId,
      referralAttributions.subjectKind,
      referralAttributions.subjectRef,
    )
    .having(sql`count(*) > 1`)
    .limit(FINDING_LIMIT);
  for (const row of duplicateWinners) {
    findings.push({
      kind: 'duplicate_active_attribution',
      subjectId: `${row.programId}:${row.subjectKind}:${row.subjectRef}`,
      detail: 'More than one active attribution holds this scope',
    });
  }

  return findings;
}
