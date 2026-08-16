/**
 * The destination allow-list (#67 outbound rule 2).
 *
 * The one table in this domain that DECIDES anything, so its reads are narrow
 * and its writes are attributable. Approving a host is what makes a redirect to
 * it possible; revoking one keeps the row, because an approval that was
 * withdrawn is history somebody may need to read during the incident that
 * withdrew it.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { affiliateOutboundHosts } from '../schema/affiliateOutbound.js';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import type { ApprovedOutboundHost } from '../../services/outbound/destination.js';

/** One allow-list row, as an operator surface reads it. */
export type AffiliateOutboundHostRow = typeof affiliateOutboundHosts.$inferSelect;

/**
 * The LIVE approvals for one source, in the shape the admission function takes.
 *
 * Two columns and no more. The admission is pure and needs a host and a kind;
 * handing it the whole row would give a later edit somewhere to reach for an
 * operator's id or a revocation note while deciding where to send a shopper.
 */
export async function listApprovedOutboundHosts(
  catalogSourceId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly ApprovedOutboundHost[]> {
  const rows = await db
    .select({ host: affiliateOutboundHosts.host, kind: affiliateOutboundHosts.kind })
    .from(affiliateOutboundHosts)
    .where(
      and(
        eq(affiliateOutboundHosts.catalogSourceId, catalogSourceId),
        isNull(affiliateOutboundHosts.revokedAt),
      ),
    );
  return rows;
}

/** Every row for one source, live and revoked, oldest first — the operator read. */
export async function listOutboundHostsForSource(
  catalogSourceId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<readonly AffiliateOutboundHostRow[]> {
  return db
    .select()
    .from(affiliateOutboundHosts)
    .where(eq(affiliateOutboundHosts.catalogSourceId, catalogSourceId))
    .orderBy(asc(affiliateOutboundHosts.approvedAt));
}

/**
 * Approve one host for one source.
 *
 * `ON CONFLICT DO NOTHING RETURNING` against the partial unique on the LIVE
 * rows, so two operators approving the same host converge on one row and the
 * empty result IS the "already approved" answer. Never a read-then-write: two
 * concurrent approvals both read "absent" and the second would fail on the
 * index, and never a caught duplicate-key error, because one failed statement
 * aborts the whole transaction in Postgres.
 */
export async function approveOutboundHost(
  input: {
    readonly catalogSourceId: string;
    readonly host: string;
    readonly kind: 'network_redirector' | 'merchant_site';
    readonly reason: string;
    readonly approvedByOxyUserId: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<AffiliateOutboundHostRow | undefined> {
  const [row] = await db
    .insert(affiliateOutboundHosts)
    .values({
      catalogSourceId: input.catalogSourceId,
      // Normalised HERE rather than at the caller, so every writer stores the
      // one spelling the exact comparison at redirect time will look for.
      host: input.host.trim().toLowerCase(),
      kind: input.kind,
      reason: input.reason,
      approvedByOxyUserId: input.approvedByOxyUserId,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

/**
 * Revoke one live approval, attributably.
 *
 * A conditional UPDATE whose empty result IS "there was nothing live to
 * revoke" — the same answer shape as the approval, so a repeat converges rather
 * than raising.
 */
export async function revokeOutboundHost(
  input: {
    readonly id: string;
    readonly revokedByOxyUserId: string;
    readonly revokedReason: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<AffiliateOutboundHostRow | undefined> {
  const [row] = await db
    .update(affiliateOutboundHosts)
    .set({
      revokedAt: new Date(),
      revokedByOxyUserId: input.revokedByOxyUserId,
      revokedReason: input.revokedReason,
    })
    .where(
      and(eq(affiliateOutboundHosts.id, input.id), isNull(affiliateOutboundHosts.revokedAt)),
    )
    .returning();
  return row;
}
