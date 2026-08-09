/**
 * Recalls and emergency kill switches (#121 "Recall and emergency controls").
 *
 * ## Raising one is an INSERT and nothing else has to run
 *
 * Eligibility is derived, so a committed `stop_sale` row stops new publication
 * and new checkout in the very next derivation: no queue, no sweep, no cache to
 * invalidate (#121 acceptance 5). That is why the emergency path is testable
 * INDEPENDENTLY of ordinary source refresh — the refresh path is not involved.
 *
 * ## A repeat converges rather than stacking
 *
 * `ON CONFLICT DO NOTHING` against the partial unique
 * `(scope, scope_ref, kind) WHERE lifted_at IS NULL`, then a read of the
 * survivor — the `moderation_events` claim shape. Two operators reacting to one
 * authority notice at the same moment produce ONE suppression, not two an
 * operator would have to lift one at a time.
 */

import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type {
  RetailSuppressionKind,
  RetailSuppressionScope,
  RetailSuppressionSeverity,
  RetailSuppressionSource,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { retailSuppressions } from '../schema/retailEligibility.js';

/** One suppression row, whole. */
export type RetailSuppressionRecord = typeof retailSuppressions.$inferSelect;

/** The scopes whose key space is Mercaria's own and which carry a real reference. */
const REFERENCE_COLUMN_BY_SCOPE = {
  supplier: 'supplierId',
  supplier_account: 'supplierAccountId',
  canonical_product: 'canonicalProductId',
  canonical_variant: 'canonicalVariantId',
  brand: 'brandId',
} as const satisfies Partial<Record<RetailSuppressionScope, string>>;

/** What raising one records. */
export interface NewRetailSuppression {
  scope: RetailSuppressionScope;
  scopeRef: string;
  kind: RetailSuppressionKind;
  severity: RetailSuppressionSeverity;
  source: RetailSuppressionSource;
  externalReference?: string;
  reason: string;
  effectiveFrom?: Date;
  raisedByOxyUserId: string;
}

/**
 * Raise a suppression, converging on any live one for the same subject.
 *
 * The reference column is derived from the SCOPE rather than passed separately:
 * the CHECKs require `scope_ref` and the matching foreign key to agree, and two
 * parameters that must agree are two ways to get it wrong.
 */
export async function raiseRetailSuppression(
  db: DatabaseOrTransaction,
  input: NewRetailSuppression,
): Promise<RetailSuppressionRecord> {
  const scopeRef =
    input.scope === 'market' ? input.scopeRef.toUpperCase() : input.scopeRef;
  const referenceColumn =
    input.scope in REFERENCE_COLUMN_BY_SCOPE
      ? REFERENCE_COLUMN_BY_SCOPE[input.scope as keyof typeof REFERENCE_COLUMN_BY_SCOPE]
      : undefined;

  const inserted = await db
    .insert(retailSuppressions)
    .values({
      scope: input.scope,
      scopeRef,
      supplierId: referenceColumn === 'supplierId' ? scopeRef : null,
      supplierAccountId: referenceColumn === 'supplierAccountId' ? scopeRef : null,
      canonicalProductId: referenceColumn === 'canonicalProductId' ? scopeRef : null,
      canonicalVariantId: referenceColumn === 'canonicalVariantId' ? scopeRef : null,
      brandId: referenceColumn === 'brandId' ? scopeRef : null,
      kind: input.kind,
      severity: input.severity,
      source: input.source,
      externalReference: input.externalReference ?? null,
      reason: input.reason,
      effectiveFrom: input.effectiveFrom ?? new Date(),
      raisedByOxyUserId: input.raisedByOxyUserId,
    })
    // The partial unique's predicate must be repeated (`where`, drizzle's
    // spelling for a DO NOTHING arbiter's index predicate), or Postgres cannot
    // infer the arbiter at all — the `carts` lesson (#104), one domain over.
    .onConflictDoNothing({
      target: [retailSuppressions.scope, retailSuppressions.scopeRef, retailSuppressions.kind],
      where: isNull(retailSuppressions.liftedAt),
    })
    .returning();

  const row = inserted[0];
  if (row) return row;

  const existing = await findLiveRetailSuppression(db, {
    scope: input.scope,
    scopeRef,
    kind: input.kind,
  });
  if (!existing) {
    throw new Error('raiseRetailSuppression found neither an inserted nor an existing row');
  }
  return existing;
}

/** The live suppression for one subject and kind, if any. */
export async function findLiveRetailSuppression(
  db: DatabaseOrTransaction,
  input: { scope: RetailSuppressionScope; scopeRef: string; kind: RetailSuppressionKind },
): Promise<RetailSuppressionRecord | undefined> {
  const [row] = await db
    .select()
    .from(retailSuppressions)
    .where(
      and(
        eq(retailSuppressions.scope, input.scope),
        eq(retailSuppressions.scopeRef, input.scopeRef),
        eq(retailSuppressions.kind, input.kind),
        isNull(retailSuppressions.liftedAt),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Every live suppression that could touch one offer — the derivation's read.
 *
 * ONE query over every scope the offer participates in. The derivation then
 * decides which actually applies, so the scope-matching rule lives in exactly
 * one place; this function's job is to fetch a superset, never to filter.
 *
 * `effective_from <= now` is applied here because a future-dated suppression is
 * not live yet by definition, and loading it would make the derivation's own
 * clock check the second place that decides it.
 */
export async function listLiveRetailSuppressionsForOffer(
  db: DatabaseOrTransaction,
  input: {
    supplierId: string;
    supplierAccountId: string;
    canonicalProductId: string | null;
    canonicalVariantId: string | null;
    supplierSku: string;
    categoryKey: string | null;
    brandId: string | null;
    destinationCountry: string;
    now?: Date;
  },
): Promise<RetailSuppressionRecord[]> {
  const now = input.now ?? new Date();
  const refs: string[] = [
    input.supplierId,
    input.supplierAccountId,
    input.supplierSku,
    input.destinationCountry.toUpperCase(),
    ...(input.canonicalProductId ? [input.canonicalProductId] : []),
    ...(input.canonicalVariantId ? [input.canonicalVariantId] : []),
    ...(input.categoryKey ? [input.categoryKey] : []),
    ...(input.brandId ? [input.brandId] : []),
  ];
  return await db
    .select()
    .from(retailSuppressions)
    .where(
      and(
        isNull(retailSuppressions.liftedAt),
        lte(retailSuppressions.effectiveFrom, now),
        inArray(retailSuppressions.scopeRef, refs),
      ),
    );
}

/**
 * Lift a suppression. A CAS on "still live", so two operators lifting one
 * recall produce exactly one lift and one audit row.
 *
 * The row is never deleted: what was suppressed, by whom, why and for how long
 * is the record an incident review reads.
 */
export async function liftRetailSuppression(
  db: DatabaseOrTransaction,
  input: { id: string; liftedByOxyUserId: string; reason: string; at?: Date },
): Promise<RetailSuppressionRecord | undefined> {
  const at = input.at ?? new Date();
  const [row] = await db
    .update(retailSuppressions)
    .set({
      liftedAt: at,
      liftedByOxyUserId: input.liftedByOxyUserId,
      liftReason: input.reason,
      updatedAt: at,
    })
    .where(and(eq(retailSuppressions.id, input.id), isNull(retailSuppressions.liftedAt)))
    .returning();
  return row;
}

/** One row by id — the operator surface's addressing. */
export async function findRetailSuppressionById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<RetailSuppressionRecord | undefined> {
  const [row] = await db
    .select()
    .from(retailSuppressions)
    .where(eq(retailSuppressions.id, id))
    .limit(1);
  return row;
}

/** Every suppression, live first then lifted, newest first within each. */
export async function listRetailSuppressions(
  db: DatabaseOrTransaction,
  filter?: { liveOnly?: boolean; limit?: number },
): Promise<RetailSuppressionRecord[]> {
  const query = db.select().from(retailSuppressions);
  const rows = filter?.liveOnly
    ? await query
        .where(isNull(retailSuppressions.liftedAt))
        .orderBy(desc(retailSuppressions.createdAt))
        .limit(filter.limit ?? 100)
    : await query
        .orderBy(sql`${retailSuppressions.liftedAt} is not null`, desc(retailSuppressions.createdAt))
        .limit(filter?.limit ?? 100);
  return rows;
}

/**
 * Which procurement offers a live suppression reaches — the "find every active
 * offer for affected SKUs" half of #121's recall control (item 2).
 *
 * Deliberately expressed as a predicate over `scope`/`scope_ref` rather than as
 * a join per scope: the caller (`recall.service`) owns the impact scan and
 * needs the SUBJECT, not a pre-joined result, because the same subject also has
 * to be scanned against pending checkouts, customer orders and purchase orders
 * — three domains this repository does not read.
 */
export async function listLiveBlockingSuppressions(
  db: DatabaseOrTransaction,
  input?: { now?: Date },
): Promise<RetailSuppressionRecord[]> {
  const now = input?.now ?? new Date();
  return await db
    .select()
    .from(retailSuppressions)
    .where(
      and(
        isNull(retailSuppressions.liftedAt),
        lte(retailSuppressions.effectiveFrom, now),
        or(
          eq(retailSuppressions.severity, 'stop_sale'),
          eq(retailSuppressions.severity, 'stop_sale_and_recover'),
        ),
      ),
    )
    .orderBy(desc(retailSuppressions.createdAt));
}
