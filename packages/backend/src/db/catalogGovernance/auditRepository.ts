/**
 * The governance audit trail and the role grants (#367 Workstream 12).
 *
 * Both tables are written from inside the caller's transaction so that a
 * decision and its record commit together. An audit write that could succeed
 * while its decision rolled back — or the reverse — is exactly the trail nobody
 * can trust afterwards, and the reverse is the commoner bug: an `await` outside
 * the transaction block looks identical on the page.
 *
 * There is no update function for either table and no delete for the audit
 * events, because the triggers refuse both. A repository offering a call the
 * database refuses is a call site somebody writes, ships and discovers in
 * production.
 */

import { and, asc, count, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type {
  CatalogGovernanceActorKind,
  CatalogGovernanceAuditAction,
  CatalogGovernanceAuditSource,
  CatalogGovernanceDomain,
  CatalogGovernanceRole,
  CatalogGovernanceSubjectKind,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import {
  catalogGovernanceAuditEvents,
  catalogGovernanceRoleGrants,
} from '../schema/catalogGovernance.js';

export type CatalogGovernanceAuditEventRow = typeof catalogGovernanceAuditEvents.$inferSelect;
export type CatalogGovernanceRoleGrantRow = typeof catalogGovernanceRoleGrants.$inferSelect;

/** One audited act. `actorOxyUserId` is NULL exactly when the actor is `system`. */
export interface NewAuditEvent {
  readonly domain: CatalogGovernanceDomain;
  readonly action: CatalogGovernanceAuditAction;
  readonly subjectKind: CatalogGovernanceSubjectKind;
  readonly subjectId: string;
  readonly actorKind: CatalogGovernanceActorKind;
  readonly actorOxyUserId: string | null;
  readonly reason: string;
  readonly source: CatalogGovernanceAuditSource;
  readonly changeRequestId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly at: Date;
}

/** Append one event. There is deliberately no batch form and no upsert. */
export async function recordAuditEvent(
  db: DatabaseOrTransaction,
  input: NewAuditEvent,
): Promise<CatalogGovernanceAuditEventRow> {
  const [row] = await db
    .insert(catalogGovernanceAuditEvents)
    .values({
      domain: input.domain,
      action: input.action,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      actorKind: input.actorKind,
      actorOxyUserId: input.actorOxyUserId,
      reason: input.reason,
      source: input.source,
      changeRequestId: input.changeRequestId,
      before: input.before,
      after: input.after,
      at: input.at,
    })
    .returning();
  return row;
}

/** An audit filter. Every field narrows. */
export interface AuditFilter {
  readonly subjectKind?: CatalogGovernanceSubjectKind;
  readonly subjectId?: string;
  readonly domains?: readonly CatalogGovernanceDomain[];
  readonly actorOxyUserId?: string;
  readonly changeRequestId?: string;
  readonly since?: Date;
  readonly until?: Date;
  readonly limit: number;
  readonly offset: number;
}

/** The trail, newest first. */
export async function listAuditEvents(
  db: DatabaseOrTransaction,
  filter: AuditFilter,
): Promise<CatalogGovernanceAuditEventRow[]> {
  const predicates = [];
  if (filter.subjectKind) {
    predicates.push(eq(catalogGovernanceAuditEvents.subjectKind, filter.subjectKind));
  }
  if (filter.subjectId) predicates.push(eq(catalogGovernanceAuditEvents.subjectId, filter.subjectId));
  if (filter.domains && filter.domains.length > 0) {
    predicates.push(inArray(catalogGovernanceAuditEvents.domain, [...filter.domains]));
  }
  if (filter.actorOxyUserId) {
    predicates.push(eq(catalogGovernanceAuditEvents.actorOxyUserId, filter.actorOxyUserId));
  }
  if (filter.changeRequestId) {
    predicates.push(eq(catalogGovernanceAuditEvents.changeRequestId, filter.changeRequestId));
  }
  if (filter.since) predicates.push(gte(catalogGovernanceAuditEvents.at, filter.since));
  if (filter.until) predicates.push(lte(catalogGovernanceAuditEvents.at, filter.until));

  return db
    .select()
    .from(catalogGovernanceAuditEvents)
    .where(predicates.length > 0 ? and(...predicates) : undefined)
    .orderBy(desc(catalogGovernanceAuditEvents.at))
    .limit(filter.limit)
    .offset(filter.offset);
}

/**
 * How many events the trail holds for a subject.
 *
 * The positive control for a trace: a trace page that came back empty and a
 * subject nothing ever happened to look the same, and only this number tells
 * them apart.
 */
export async function countAuditEventsForSubject(
  db: DatabaseOrTransaction,
  subjectKind: CatalogGovernanceSubjectKind,
  subjectId: string,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(catalogGovernanceAuditEvents)
    .where(
      and(
        eq(catalogGovernanceAuditEvents.subjectKind, subjectKind),
        eq(catalogGovernanceAuditEvents.subjectId, subjectId),
      ),
    );
  return Number(row?.total ?? 0);
}

/** What a new grant states. */
export interface NewRoleGrant {
  readonly subjectOxyUserId: string;
  readonly role: CatalogGovernanceRole;
  readonly grantedByOxyUserId: string;
  readonly grantedAt: Date;
  readonly reason: string;
}

/**
 * Grant a role.
 *
 * `onConflictDoNothing` against the live partial unique, so a repeat converges
 * on the existing grant rather than raising: two operators granting the same
 * capability to the same person is convergent intent, not a conflict. An empty
 * result means it was already held, and the service reads it back.
 */
export async function insertRoleGrant(
  db: DatabaseOrTransaction,
  input: NewRoleGrant,
): Promise<CatalogGovernanceRoleGrantRow | null> {
  const [row] = await db
    .insert(catalogGovernanceRoleGrants)
    .values({
      subjectOxyUserId: input.subjectOxyUserId,
      role: input.role,
      grantedByOxyUserId: input.grantedByOxyUserId,
      grantedAt: input.grantedAt,
      reason: input.reason,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/**
 * Revoke a live grant. `null` means there was nothing live to revoke — which
 * the service reports as convergence rather than as an error, because the end
 * state a caller asked for is the end state.
 */
export async function revokeRoleGrant(
  db: DatabaseOrTransaction,
  subjectOxyUserId: string,
  role: CatalogGovernanceRole,
  revokedByOxyUserId: string,
  revokedAt: Date,
): Promise<CatalogGovernanceRoleGrantRow | null> {
  const [row] = await db
    .update(catalogGovernanceRoleGrants)
    .set({ revokedByOxyUserId, revokedAt })
    .where(
      and(
        eq(catalogGovernanceRoleGrants.subjectOxyUserId, subjectOxyUserId),
        eq(catalogGovernanceRoleGrants.role, role),
        isNull(catalogGovernanceRoleGrants.revokedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** Every live grant for one person. */
export async function listLiveRoleGrants(
  db: DatabaseOrTransaction,
  subjectOxyUserId: string,
): Promise<CatalogGovernanceRoleGrantRow[]> {
  return db
    .select()
    .from(catalogGovernanceRoleGrants)
    .where(
      and(
        eq(catalogGovernanceRoleGrants.subjectOxyUserId, subjectOxyUserId),
        isNull(catalogGovernanceRoleGrants.revokedAt),
      ),
    )
    .orderBy(asc(catalogGovernanceRoleGrants.role));
}

/** Every grant, live and revoked — the history a role audit reads. */
export async function listAllRoleGrants(
  db: DatabaseOrTransaction,
  limit: number,
  offset: number,
): Promise<CatalogGovernanceRoleGrantRow[]> {
  return db
    .select()
    .from(catalogGovernanceRoleGrants)
    .orderBy(desc(catalogGovernanceRoleGrants.grantedAt))
    .limit(limit)
    .offset(offset);
}

/**
 * How many live grants exist at all, and how many of them carry `publish`.
 *
 * Both numbers in one read because `role.service.ts` needs them together: the
 * first says whether the deployment has adopted role separation, the second is
 * the lockout guard. Reading them separately leaves a window in which a
 * deployment goes from "unrestricted" to "nobody can publish".
 */
export async function countLiveRoleGrants(
  db: DatabaseOrTransaction,
): Promise<{ readonly total: number; readonly publishers: number }> {
  const [row] = await db
    .select({
      total: count(),
      publishers: sql<number>`count(*) filter (where ${catalogGovernanceRoleGrants.role} = 'publish')`,
    })
    .from(catalogGovernanceRoleGrants)
    .where(isNull(catalogGovernanceRoleGrants.revokedAt));
  return { total: Number(row?.total ?? 0), publishers: Number(row?.publishers ?? 0) };
}
