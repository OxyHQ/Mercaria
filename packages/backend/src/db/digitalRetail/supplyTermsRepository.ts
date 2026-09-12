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
import type { DigitalSupplierApiCapability } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import {
  digitalSupplierCapabilities,
  digitalSupplyTerms,
} from '../schema/digitalRetail.js';

export type DigitalSupplyTermsRow = InferSelectModel<typeof digitalSupplyTerms>;
export type DigitalSupplierCapabilityRow = InferSelectModel<typeof digitalSupplierCapabilities>;

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
