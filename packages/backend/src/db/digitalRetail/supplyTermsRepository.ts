/**
 * The only writer of `digital_supply_terms` and `digital_supplier_capabilities`,
 * and the reader the eligibility derivation is fed from (#1016, ADR 0011 D2).
 *
 * ## Why the candidate read joins rather than returning rows
 *
 * `deriveDigitalProcurementEligibility` is PURE and takes facts, not rows. The
 * facts it needs live on four tables — supplier, account, rider, capability — and
 * fetching them per offer would be an N+1 against a checkout path. So the reader
 * here composes them into one shape per offer in ONE statement, and the pure
 * function stays testable against fixtures with no database at all.
 *
 * ## Nothing here reads a credential
 *
 * `supplier_accounts.credential_reference` is a protected column and no select in
 * this directory names it. Resolving a credential is the adapter registry's job
 * and it is a separate, greppable act.
 */

import { and, eq } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import type {
  DigitalFulfilmentCapability,
  DigitalRetailProductClass,
  DigitalSupplierApiCapability,
  DigitalSupplyProvenance,
} from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  digitalSupplierCapabilities,
  digitalSupplyTerms,
} from '../schema/digitalRetail.js';

export type DigitalSupplyTermsRow = InferSelectModel<typeof digitalSupplyTerms>;
export type DigitalSupplierCapabilityRow = InferSelectModel<typeof digitalSupplierCapabilities>;

/**
 * What an operator records when a digital rider is signed.
 *
 * Every field is a term somebody agreed to, and the ones with no default are the
 * ones an approval cannot be recorded without: the evidence, the approver and
 * the date. The CHECKs repeat that, so a rider written by any other path is
 * refused rather than being merely unreviewed.
 */
export interface NewDigitalSupplyTerms {
  readonly agreementId: string;
  readonly supplierId: string;
  readonly provenance: DigitalSupplyProvenance;
  readonly permittedProductClasses: readonly DigitalRetailProductClass[];
  readonly permittedFulfilmentCapabilities: readonly DigitalFulfilmentCapability[];
  /** ISO-3166-1 alpha-2. Upper-cased here; empty GRANTS none. */
  readonly permittedTerritories: readonly string[];
  readonly excludedBrands?: readonly string[];
  readonly excludedProductRefs?: readonly string[];
  readonly resaleRightsGranted: boolean;
  readonly catalogDataRightsGranted?: boolean;
  readonly replacementSupported?: boolean;
  readonly creditSupported?: boolean;
  readonly cancellationSupported?: boolean;
  readonly maxOrderCostAmount?: number;
  readonly maxOrderCostCurrency?: string;
  readonly evidenceLocation: string;
  readonly approvedByOxyUserId: string;
  readonly approvedAt: Date;
  readonly expiresAt?: Date | null;
  readonly supportEscalationNote?: string | null;
}

/**
 * Record one signed rider. ONE per agreement version, by unique index.
 *
 * Territories and brands are normalized HERE rather than at the call site — the
 * Mongoose-behaviour rule in `CONVENTIONS.md`: `lowercase`/`uppercase` do not
 * survive the port, and the eligibility derivation compares an upper-cased
 * territory and a lower-cased brand.
 */
export async function createSupplyTerms(
  input: NewDigitalSupplyTerms,
  tx?: DatabaseOrTransaction,
): Promise<DigitalSupplyTermsRow> {
  const db = tx ?? getDb();
  const [row] = await db
    .insert(digitalSupplyTerms)
    .values({
      agreementId: input.agreementId,
      supplierId: input.supplierId,
      provenance: input.provenance,
      permittedProductClasses: [...input.permittedProductClasses],
      permittedFulfilmentCapabilities: [...input.permittedFulfilmentCapabilities],
      permittedTerritories: input.permittedTerritories.map((value) => value.toUpperCase()),
      excludedBrands: (input.excludedBrands ?? []).map((value) => value.toLowerCase()),
      excludedProductRefs: [...(input.excludedProductRefs ?? [])],
      resaleRightsGranted: input.resaleRightsGranted,
      catalogDataRightsGranted: input.catalogDataRightsGranted ?? false,
      replacementSupported: input.replacementSupported ?? false,
      creditSupported: input.creditSupported ?? false,
      cancellationSupported: input.cancellationSupported ?? false,
      maxOrderCostAmount: input.maxOrderCostAmount ?? null,
      maxOrderCostCurrency:
        (input.maxOrderCostCurrency as DigitalSupplyTermsRow['maxOrderCostCurrency']) ?? null,
      evidenceLocation: input.evidenceLocation,
      approvedByOxyUserId: input.approvedByOxyUserId,
      approvedAt: input.approvedAt,
      expiresAt: input.expiresAt ?? null,
      supportEscalationNote: input.supportEscalationNote ?? null,
    })
    .returning();
  if (!row) throw new Error(`digital supply terms for agreement ${input.agreementId} were not written`);
  return row;
}

/**
 * End a rider early, without touching the agreement it hangs off.
 *
 * The withdrawal of a digital permission is frequently NOT the end of the
 * commercial relationship — a publisher pulls one territory, a distributor loses
 * one brand — so this exists rather than making an operator terminate the whole
 * agreement to stop digital supply.
 */
export async function expireSupplyTerms(
  termsId: string,
  expiresAt: Date,
  tx?: DatabaseOrTransaction,
): Promise<DigitalSupplyTermsRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .update(digitalSupplyTerms)
    .set({ expiresAt, updatedAt: new Date() })
    .where(eq(digitalSupplyTerms.id, termsId))
    .returning();
  return row ?? null;
}

/**
 * Create or refresh one capability row for an account.
 *
 * Upsert rather than insert, because the set an adapter advertises changes with
 * its version and the row carries state an operator set — a delete-and-recreate
 * would silently lift a pause somebody put there during an incident.
 */
export async function upsertAccountCapability(
  supplierAccountId: string,
  capability: DigitalSupplierApiCapability,
  adapterVersion: string,
  tx?: DatabaseOrTransaction,
): Promise<DigitalSupplierCapabilityRow> {
  const db = tx ?? getDb();
  const [row] = await db
    .insert(digitalSupplierCapabilities)
    .values({ supplierAccountId, capability, adapterVersion })
    .onConflictDoUpdate({
      target: [
        digitalSupplierCapabilities.supplierAccountId,
        digitalSupplierCapabilities.capability,
      ],
      set: { adapterVersion, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error(`capability ${capability} for ${supplierAccountId} was not written`);
  return row;
}

/** The rider governing one agreement version, or null when none does. */
export async function findSupplyTermsByAgreement(
  agreementId: string,
  tx?: DatabaseOrTransaction,
): Promise<DigitalSupplyTermsRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .select()
    .from(digitalSupplyTerms)
    .where(eq(digitalSupplyTerms.agreementId, agreementId))
    .limit(1);
  return row ?? null;
}

/** One rider by id — the purchase order's authorization, read back for audit. */
export async function findSupplyTermsById(
  id: string,
  tx?: DatabaseOrTransaction,
): Promise<DigitalSupplyTermsRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .select()
    .from(digitalSupplyTerms)
    .where(eq(digitalSupplyTerms.id, id))
    .limit(1);
  return row ?? null;
}

/** Every capability row for one account, for the operator surface and the health sweep. */
export async function findAccountCapabilities(
  supplierAccountId: string,
  tx?: DatabaseOrTransaction,
): Promise<DigitalSupplierCapabilityRow[]> {
  const db = tx ?? getDb();
  return db
    .select()
    .from(digitalSupplierCapabilities)
    .where(eq(digitalSupplierCapabilities.supplierAccountId, supplierAccountId));
}

/** One capability row, which is what the procurement gate asks about by name. */
export async function findAccountCapability(
  supplierAccountId: string,
  capability: DigitalSupplierApiCapability,
  tx?: DatabaseOrTransaction,
): Promise<DigitalSupplierCapabilityRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .select()
    .from(digitalSupplierCapabilities)
    .where(
      and(
        eq(digitalSupplierCapabilities.supplierAccountId, supplierAccountId),
        eq(digitalSupplierCapabilities.capability, capability),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Pause ONE capability, leaving every other capability of the same account alone.
 *
 * The epic's Workstream 2 requirement 9 — catalog sync and procurement pause
 * separately — and Workstream 22's kill-switch list. A pause carries its reason
 * by CHECK, so there is no way to pause something and leave nobody able to say
 * why an hour later.
 */
export async function pauseCapability(
  supplierAccountId: string,
  capability: DigitalSupplierApiCapability,
  reason: string,
  now: Date,
  tx?: DatabaseOrTransaction,
): Promise<DigitalSupplierCapabilityRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .update(digitalSupplierCapabilities)
    .set({ state: 'paused', pausedAt: now, pauseReason: reason, updatedAt: now })
    .where(
      and(
        eq(digitalSupplierCapabilities.supplierAccountId, supplierAccountId),
        eq(digitalSupplierCapabilities.capability, capability),
      ),
    )
    .returning();
  return row ?? null;
}

/** Lift a pause. The reason is cleared with it — the CHECK pairs the two. */
export async function resumeCapability(
  supplierAccountId: string,
  capability: DigitalSupplierApiCapability,
  now: Date,
  tx?: DatabaseOrTransaction,
): Promise<DigitalSupplierCapabilityRow | null> {
  const db = tx ?? getDb();
  const [row] = await db
    .update(digitalSupplierCapabilities)
    .set({ state: 'enabled', pausedAt: null, pauseReason: null, updatedAt: now })
    .where(
      and(
        eq(digitalSupplierCapabilities.supplierAccountId, supplierAccountId),
        eq(digitalSupplierCapabilities.capability, capability),
      ),
    )
    .returning();
  return row ?? null;
}

/** Record a health probe. `ok = null` is never written — that is "never checked". */
export async function recordCapabilityHealth(
  supplierAccountId: string,
  capability: DigitalSupplierApiCapability,
  ok: boolean,
  now: Date,
  tx?: DatabaseOrTransaction,
): Promise<void> {
  const db = tx ?? getDb();
  await db
    .update(digitalSupplierCapabilities)
    .set({ lastHealthCheckAt: now, lastHealthCheckOk: ok, updatedAt: now })
    .where(
      and(
        eq(digitalSupplierCapabilities.supplierAccountId, supplierAccountId),
        eq(digitalSupplierCapabilities.capability, capability),
      ),
    );
}
