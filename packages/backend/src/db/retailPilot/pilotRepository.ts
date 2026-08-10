/**
 * The bounded retail pilot's rows (#125).
 *
 * The ONLY writer of all five tables. Every write here is a decision somebody
 * made — publishing a cohort, allow-listing a SKU, raising a stop, lifting one,
 * recording a balance — so each carries an actor or is explicitly automatic,
 * and none of them is reachable from a buyer-facing route.
 *
 * There is deliberately NO `updateCohort`, no `addSkuToActiveCohort` and no
 * `deleteStop`. The first two are what "no automatic expansion follows from
 * technical success" forbids and the triggers refuse anyway; the third would
 * remove the record of a pilot having stopped, which is the most important row
 * in its own history.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { type SelectedRow } from '@oxyhq/db';
import type {
  CurrencyCode,
  RetailPilotAudience,
  RetailPilotStopMetric,
  RetailPilotStopOrigin,
  RetailPilotStopScope,
  RetailPilotThresholdUnit,
  SupplierFundingSource,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  retailPilotCohorts,
  retailPilotSkus,
  retailPilotStops,
  retailPilotStopThresholds,
  supplierFundingObservations,
} from '../schema/retailPilot.js';

const COHORT_COLUMNS = {
  id: retailPilotCohorts.id,
  cohortKey: retailPilotCohorts.cohortKey,
  version: retailPilotCohorts.version,
  status: retailPilotCohorts.status,
  supplierId: retailPilotCohorts.supplierId,
  supplierAccountId: retailPilotCohorts.supplierAccountId,
  marketCountry: retailPilotCohorts.marketCountry,
  currency: retailPilotCohorts.currency,
  audience: retailPilotCohorts.audience,
  audiencePercentageBps: retailPilotCohorts.audiencePercentageBps,
  maxItemTotalAmount: retailPilotCohorts.maxItemTotalAmount,
  maxOrderTotalAmount: retailPilotCohorts.maxOrderTotalAmount,
  minOrderTotalAmount: retailPilotCohorts.minOrderTotalAmount,
  maxLineQuantity: retailPilotCohorts.maxLineQuantity,
  permittedShippingServiceCodes: retailPilotCohorts.permittedShippingServiceCodes,
  fundingFloorAmount: retailPilotCohorts.fundingFloorAmount,
  fundingFloorCurrency: retailPilotCohorts.fundingFloorCurrency,
  fundingAlertAmount: retailPilotCohorts.fundingAlertAmount,
  monthlySpendCapAmount: retailPilotCohorts.monthlySpendCapAmount,
  fundingObservationMaxAgeSeconds: retailPilotCohorts.fundingObservationMaxAgeSeconds,
  publishedAt: retailPilotCohorts.publishedAt,
  publishedByOxyUserId: retailPilotCohorts.publishedByOxyUserId,
  supersededAt: retailPilotCohorts.supersededAt,
  rationale: retailPilotCohorts.rationale,
} as const;

export type RetailPilotCohortRecord = SelectedRow<typeof COHORT_COLUMNS>;

/** What publishing a cohort version needs. Every bound, stated once. */
export interface NewRetailPilotCohort {
  cohortKey: string;
  version: number;
  supplierId: string;
  supplierAccountId: string;
  marketCountry: string;
  currency: CurrencyCode;
  audience: RetailPilotAudience;
  audiencePercentageBps?: number | null;
  maxItemTotalMinor: number;
  maxOrderTotalMinor: number;
  minOrderTotalMinor: number;
  maxLineQuantity: number;
  permittedShippingServiceCodes: readonly string[];
  fundingFloorMinor: number;
  fundingAlertMinor: number;
  monthlySpendCapMinor: number;
  fundingObservationMaxAgeSeconds: number;
  rationale: string;
}

/** Create one DRAFT cohort version. Publishing it is a separate, audited act. */
export async function createRetailPilotCohortDraft(
  input: NewRetailPilotCohort,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailPilotCohortRecord> {
  const [row] = await db
    .insert(retailPilotCohorts)
    .values({
      cohortKey: input.cohortKey,
      version: input.version,
      status: 'draft',
      supplierId: input.supplierId,
      supplierAccountId: input.supplierAccountId,
      marketCountry: input.marketCountry,
      currency: input.currency,
      audience: input.audience,
      audiencePercentageBps: input.audiencePercentageBps ?? null,
      maxItemTotalAmount: input.maxItemTotalMinor,
      maxItemTotalCurrency: input.currency,
      maxOrderTotalAmount: input.maxOrderTotalMinor,
      maxOrderTotalCurrency: input.currency,
      minOrderTotalAmount: input.minOrderTotalMinor,
      minOrderTotalCurrency: input.currency,
      maxLineQuantity: input.maxLineQuantity,
      permittedShippingServiceCodes: [...input.permittedShippingServiceCodes],
      fundingFloorAmount: input.fundingFloorMinor,
      fundingFloorCurrency: input.currency,
      fundingAlertAmount: input.fundingAlertMinor,
      fundingAlertCurrency: input.currency,
      monthlySpendCapAmount: input.monthlySpendCapMinor,
      monthlySpendCapCurrency: input.currency,
      fundingObservationMaxAgeSeconds: input.fundingObservationMaxAgeSeconds,
      rationale: input.rationale,
    })
    .returning(COHORT_COLUMNS);
  if (!row) throw new Error('retail pilot cohort draft was not created');
  return row;
}

/**
 * Publish a draft, superseding whatever was active.
 *
 * ONE transaction, and the order is load-bearing: the incumbent is superseded
 * BEFORE the new version becomes active, because `retail_pilot_cohorts_active_key`
 * permits exactly one active row per key and the reverse order would collide
 * with itself. A publish that fails leaves the incumbent active, which is the
 * safe direction — the pilot keeps running under bounds somebody signed.
 */
export async function publishRetailPilotCohortVersion(
  input: { cohortId: string; publishedByOxyUserId: string; at?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailPilotCohortRecord | undefined> {
  const at = input.at ?? new Date();
  return await db.transaction(async (tx) => {
    const [draft] = await tx
      .select(COHORT_COLUMNS)
      .from(retailPilotCohorts)
      .where(and(eq(retailPilotCohorts.id, input.cohortId), eq(retailPilotCohorts.status, 'draft')))
      .limit(1);
    if (!draft) return undefined;

    await tx
      .update(retailPilotCohorts)
      .set({ status: 'superseded', supersededAt: at })
      .where(
        and(
          eq(retailPilotCohorts.cohortKey, draft.cohortKey),
          eq(retailPilotCohorts.status, 'active'),
        ),
      );

    const [published] = await tx
      .update(retailPilotCohorts)
      .set({ status: 'active', publishedAt: at, publishedByOxyUserId: input.publishedByOxyUserId })
      .where(and(eq(retailPilotCohorts.id, input.cohortId), eq(retailPilotCohorts.status, 'draft')))
      .returning(COHORT_COLUMNS);
    return published;
  });
}

/** The one cohort version a checkout is measured against, or nothing. */
export async function findActiveRetailPilotCohort(
  cohortKey: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailPilotCohortRecord | undefined> {
  const [row] = await db
    .select(COHORT_COLUMNS)
    .from(retailPilotCohorts)
    .where(
      and(eq(retailPilotCohorts.cohortKey, cohortKey), eq(retailPilotCohorts.status, 'active')),
    )
    .limit(1);
  return row;
}

/** Every version of one pilot, newest first — the operator's history. */
export async function listRetailPilotCohorts(
  cohortKey: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<RetailPilotCohortRecord[]> {
  return await db
    .select(COHORT_COLUMNS)
    .from(retailPilotCohorts)
    .where(eq(retailPilotCohorts.cohortKey, cohortKey))
    .orderBy(desc(retailPilotCohorts.version));
}

/** Add one SKU to a DRAFT cohort. The trigger refuses a published one. */
export async function addRetailPilotSku(
  input: {
    cohortId: string;
    supplierSku: string;
    procurementOfferId?: string | null;
    addedByOxyUserId: string;
    note: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.insert(retailPilotSkus).values({
    cohortId: input.cohortId,
    supplierSku: input.supplierSku,
    procurementOfferId: input.procurementOfferId ?? null,
    addedByOxyUserId: input.addedByOxyUserId,
    note: input.note,
  });
}

/** The allow-listed SKUs of one cohort version. */
export async function listRetailPilotSkus(
  cohortId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ supplierSku: string; procurementOfferId: string | null; note: string }[]> {
  return await db
    .select({
      supplierSku: retailPilotSkus.supplierSku,
      procurementOfferId: retailPilotSkus.procurementOfferId,
      note: retailPilotSkus.note,
    })
    .from(retailPilotSkus)
    .where(eq(retailPilotSkus.cohortId, cohortId))
    .orderBy(retailPilotSkus.supplierSku);
}

/** Add one threshold to a DRAFT cohort. */
export async function addRetailPilotThreshold(
  input: {
    cohortId: string;
    metric: RetailPilotStopMetric;
    unit: RetailPilotThresholdUnit;
    thresholdValue: number;
    windowHours: number;
    scope: RetailPilotStopScope;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.insert(retailPilotStopThresholds).values(input);
}

/** The published thresholds of one cohort version. */
export async function listRetailPilotThresholds(
  cohortId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<
  {
    metric: RetailPilotStopMetric;
    unit: RetailPilotThresholdUnit;
    thresholdValue: number;
    windowHours: number;
    scope: RetailPilotStopScope;
  }[]
> {
  return await db
    .select({
      metric: retailPilotStopThresholds.metric,
      unit: retailPilotStopThresholds.unit,
      thresholdValue: retailPilotStopThresholds.thresholdValue,
      windowHours: retailPilotStopThresholds.windowHours,
      scope: retailPilotStopThresholds.scope,
    })
    .from(retailPilotStopThresholds)
    .where(eq(retailPilotStopThresholds.cohortId, cohortId))
    .orderBy(retailPilotStopThresholds.metric);
}

/**
 * Raise a stop, converging on the live one if there already is one.
 *
 * `ON CONFLICT DO NOTHING` against `retail_pilot_stops_live_key`, so two
 * evaluations of one breach — two tasks, a retry, an operator racing the sweep
 * — produce ONE row and page once. The empty `RETURNING` set IS the "already
 * stopped" answer; a read-then-write would report the second evaluation as a
 * fresh breach.
 */
export async function raiseRetailPilotStopRow(
  input: {
    cohortId: string;
    metric: RetailPilotStopMetric;
    scope: RetailPilotStopScope;
    scopeRef: string;
    origin: RetailPilotStopOrigin;
    observedValue: number;
    thresholdValue: number;
    raisedByOxyUserId: string | null;
    detail: string;
    at?: Date;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<{ raised: boolean }> {
  const rows = await db
    .insert(retailPilotStops)
    .values({
      cohortId: input.cohortId,
      metric: input.metric,
      scope: input.scope,
      scopeRef: input.scopeRef,
      origin: input.origin,
      observedValue: input.observedValue,
      thresholdValue: input.thresholdValue,
      raisedAt: input.at ?? new Date(),
      raisedByOxyUserId: input.raisedByOxyUserId,
      detail: input.detail,
    })
    .onConflictDoNothing({
      target: [
        retailPilotStops.cohortId,
        retailPilotStops.metric,
        retailPilotStops.scope,
        retailPilotStops.scopeRef,
      ],
      // The index is PARTIAL, so the predicate has to be repeated or Postgres
      // cannot infer the arbiter and the insert raises instead of converging.
      where: sql`${retailPilotStops.liftedAt} is null`,
    })
    .returning({ id: retailPilotStops.id });
  return { raised: rows.length > 0 };
}

/** Every stop that is live right now for one cohort. */
export async function listLiveRetailPilotStops(
  cohortId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ metric: RetailPilotStopMetric; scope: RetailPilotStopScope; scopeRef: string }[]> {
  return await db
    .select({
      metric: retailPilotStops.metric,
      scope: retailPilotStops.scope,
      scopeRef: retailPilotStops.scopeRef,
    })
    .from(retailPilotStops)
    .where(and(eq(retailPilotStops.cohortId, cohortId), isNull(retailPilotStops.liftedAt)));
}

/** One cohort's stops, newest first, lifted ones included. */
export async function listRetailPilotStops(
  cohortId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<
  {
    id: string;
    metric: RetailPilotStopMetric;
    scope: RetailPilotStopScope;
    scopeRef: string;
    origin: RetailPilotStopOrigin;
    observedValue: number;
    thresholdValue: number;
    raisedAt: Date;
    detail: string;
    liftedAt: Date | null;
    liftReason: string | null;
  }[]
> {
  return await db
    .select({
      id: retailPilotStops.id,
      metric: retailPilotStops.metric,
      scope: retailPilotStops.scope,
      scopeRef: retailPilotStops.scopeRef,
      origin: retailPilotStops.origin,
      observedValue: retailPilotStops.observedValue,
      thresholdValue: retailPilotStops.thresholdValue,
      raisedAt: retailPilotStops.raisedAt,
      detail: retailPilotStops.detail,
      liftedAt: retailPilotStops.liftedAt,
      liftReason: retailPilotStops.liftReason,
    })
    .from(retailPilotStops)
    .where(eq(retailPilotStops.cohortId, cohortId))
    .orderBy(desc(retailPilotStops.raisedAt));
}

/**
 * Lift one stop — a CAS on it still being live.
 *
 * The predicate is what makes two operators lifting at once converge on one
 * lift with one name on it, rather than the second silently overwriting the
 * first's reason. An empty result means somebody else got there.
 */
export async function liftRetailPilotStopRow(
  input: { stopId: string; liftedByOxyUserId: string; liftReason: string; at?: Date },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(retailPilotStops)
    .set({
      liftedAt: input.at ?? new Date(),
      liftedByOxyUserId: input.liftedByOxyUserId,
      liftReason: input.liftReason,
    })
    .where(and(eq(retailPilotStops.id, input.stopId), isNull(retailPilotStops.liftedAt)))
    .returning({ id: retailPilotStops.id });
  return rows.length > 0;
}

/** Record what the supplier balance was. Append-only; a correction is a new row. */
export async function recordSupplierFundingObservationRow(
  input: {
    supplierAccountId: string;
    balanceMinor: number;
    currency: CurrencyCode;
    source: SupplierFundingSource;
    observedAt: Date;
    recordedByOxyUserId: string | null;
    note?: string;
  },
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.insert(supplierFundingObservations).values({
    supplierAccountId: input.supplierAccountId,
    balanceAmount: input.balanceMinor,
    balanceCurrency: input.currency,
    source: input.source,
    observedAt: input.observedAt,
    recordedByOxyUserId: input.recordedByOxyUserId,
    note: input.note ?? '',
  });
}

/** The freshest balance figure for one account, or nothing. */
export async function findLatestSupplierFunding(
  supplierAccountId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<
  { balanceMinor: number; currency: string; observedAt: Date; source: SupplierFundingSource } | undefined
> {
  const [row] = await db
    .select({
      balanceMinor: supplierFundingObservations.balanceAmount,
      currency: supplierFundingObservations.balanceCurrency,
      observedAt: supplierFundingObservations.observedAt,
      source: supplierFundingObservations.source,
    })
    .from(supplierFundingObservations)
    .where(eq(supplierFundingObservations.supplierAccountId, supplierAccountId))
    .orderBy(desc(supplierFundingObservations.observedAt))
    .limit(1);
  return row;
}
