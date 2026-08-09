/**
 * Reads and writes for `product_identifiers` (#56, ADR 0002 D14).
 *
 * The one shape worth reading closely is {@link insertIdentifierAssertion}: it
 * converges on the per-entity ACTIVE partial unique, so re-observing an
 * identifier a variant already carries writes nothing at all — no tuple
 * version, no `updated_at` movement — while a collision with a DIFFERENT entity
 * is deliberately NOT absorbed here. That case has to reach the service, which
 * records it as `disputed` naming the row it collides with; swallowing it as a
 * conflict would turn "another product already owns this GTIN" into silence.
 *
 * Nothing here edits a value. The database refuses that outright
 * (`product_identifiers_values_immutable`), which is why a correction is
 * {@link retireIdentifier} plus a fresh insert naming the retired row.
 */

import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type {
  CanonicalIdentifierScheme,
  IdentifierScheme,
  IdentifierStatus,
} from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../postgres.js';
import { productIdentifiers } from '../schema/canonicalCatalog.js';

export type ProductIdentifierRow = typeof productIdentifiers.$inferSelect;

export interface InsertIdentifierAssertionInput {
  productId?: string;
  variantId?: string;
  scheme: IdentifierScheme;
  rawValue: string;
  normalizedValue: string;
  canonicalScheme?: CanonicalIdentifierScheme;
  canonicalValue?: string;
  status?: IdentifierStatus;
  conflictsWithIdentifierId?: string;
  supersedesIdentifierId?: string;
  sourceRecordId?: string;
  assignedByOxyUserId?: string;
  note?: string;
}

/**
 * Insert one assertion.
 *
 * @returns The inserted row, or `undefined` when this entity already carries an
 *   ACTIVE assertion of the same (scheme, normalized value) — the re-observation
 *   case, and a genuine no-op.
 */
export async function insertIdentifierAssertion(
  db: DatabaseOrTransaction,
  input: InsertIdentifierAssertionInput,
): Promise<ProductIdentifierRow | undefined> {
  const values = {
    productId: input.productId ?? null,
    variantId: input.variantId ?? null,
    scheme: input.scheme,
    rawValue: input.rawValue,
    normalizedValue: input.normalizedValue,
    canonicalScheme: input.canonicalScheme ?? null,
    canonicalValue: input.canonicalValue ?? null,
    status: input.status ?? 'active',
    conflictsWithIdentifierId: input.conflictsWithIdentifierId ?? null,
    supersedesIdentifierId: input.supersedesIdentifierId ?? null,
    sourceRecordId: input.sourceRecordId ?? null,
    assignedByOxyUserId: input.assignedByOxyUserId ?? null,
    note: input.note ?? null,
  };

  // The arbiter is the grain's own active partial unique. A DISPUTED row is not
  // covered by either (they are `WHERE status = 'active'`), which is what lets
  // two disputes over one value coexist while exactly one active owner does not.
  const target =
    input.variantId === undefined
      ? [productIdentifiers.productId, productIdentifiers.scheme, productIdentifiers.normalizedValue]
      : [productIdentifiers.variantId, productIdentifiers.scheme, productIdentifiers.normalizedValue];
  const where =
    input.variantId === undefined
      ? sql`${productIdentifiers.status} = 'active' and ${productIdentifiers.productId} is not null`
      : sql`${productIdentifiers.status} = 'active' and ${productIdentifiers.variantId} is not null`;

  if ((input.status ?? 'active') !== 'active') {
    const rows = await db.insert(productIdentifiers).values(values).returning();
    return rows[0];
  }
  const rows = await db
    .insert(productIdentifiers)
    .values(values)
    .onConflictDoNothing({ target, where })
    .returning();
  return rows[0];
}

export async function findIdentifierById(
  db: DatabaseOrTransaction,
  id: string,
): Promise<ProductIdentifierRow | undefined> {
  const rows = await db
    .select()
    .from(productIdentifiers)
    .where(eq(productIdentifiers.id, id))
    .limit(1);
  return rows[0];
}

/**
 * The ACTIVE owner of one canonical identifier value, if any.
 *
 * This is the read behind the collision gate: exactly one row can satisfy it,
 * because `product_identifiers_canonical_active_key` says so.
 */
export async function findActiveCanonicalOwner(
  db: DatabaseOrTransaction,
  canonicalScheme: CanonicalIdentifierScheme,
  canonicalValue: string,
): Promise<ProductIdentifierRow | undefined> {
  const rows = await db
    .select()
    .from(productIdentifiers)
    .where(
      and(
        eq(productIdentifiers.canonicalScheme, canonicalScheme),
        eq(productIdentifiers.canonicalValue, canonicalValue),
        eq(productIdentifiers.status, 'active'),
      ),
    )
    .limit(1);
  return rows[0];
}

/** Every active assertion of one (scheme, normalized value), across entities. */
export async function findActiveAssertionsByValue(
  db: DatabaseOrTransaction,
  scheme: IdentifierScheme,
  normalizedValue: string,
): Promise<ProductIdentifierRow[]> {
  return db
    .select()
    .from(productIdentifiers)
    .where(
      and(
        eq(productIdentifiers.scheme, scheme),
        eq(productIdentifiers.normalizedValue, normalizedValue),
        eq(productIdentifiers.status, 'active'),
      ),
    )
    .orderBy(asc(productIdentifiers.createdAt), asc(productIdentifiers.id));
}

/** Every DISPUTED assertion over one canonical value — the review queue's input. */
export async function findDisputesForCanonicalValue(
  db: DatabaseOrTransaction,
  canonicalScheme: CanonicalIdentifierScheme,
  canonicalValue: string,
): Promise<ProductIdentifierRow[]> {
  return db
    .select()
    .from(productIdentifiers)
    .where(
      and(
        eq(productIdentifiers.canonicalScheme, canonicalScheme),
        eq(productIdentifiers.canonicalValue, canonicalValue),
        eq(productIdentifiers.status, 'disputed'),
      ),
    )
    .orderBy(asc(productIdentifiers.createdAt), asc(productIdentifiers.id));
}

export async function listIdentifiersForVariant(
  db: DatabaseOrTransaction,
  variantId: string,
): Promise<ProductIdentifierRow[]> {
  return db
    .select()
    .from(productIdentifiers)
    .where(eq(productIdentifiers.variantId, variantId))
    .orderBy(asc(productIdentifiers.createdAt), asc(productIdentifiers.id));
}

export async function listIdentifiersForVariants(
  db: DatabaseOrTransaction,
  variantIds: readonly string[],
): Promise<ProductIdentifierRow[]> {
  if (variantIds.length === 0) return [];
  return db
    .select()
    .from(productIdentifiers)
    .where(inArray(productIdentifiers.variantId, [...variantIds]))
    .orderBy(asc(productIdentifiers.createdAt), asc(productIdentifiers.id));
}

export async function listIdentifiersForProduct(
  db: DatabaseOrTransaction,
  productId: string,
): Promise<ProductIdentifierRow[]> {
  return db
    .select()
    .from(productIdentifiers)
    .where(eq(productIdentifiers.productId, productId))
    .orderBy(asc(productIdentifiers.createdAt), asc(productIdentifiers.id));
}

/**
 * Move an assertion out of `active` — the only mutation this table permits, and
 * the first half of a correction.
 *
 * A one-statement CAS on the current status, so two concurrent corrections
 * produce exactly one retirement.
 */
export async function retireIdentifier(
  db: DatabaseOrTransaction,
  id: string,
  status: Extract<IdentifierStatus, 'corrected' | 'retired'>,
  note?: string,
): Promise<ProductIdentifierRow | undefined> {
  const rows = await db
    .update(productIdentifiers)
    .set({ status, ...(note === undefined ? {} : { note }) })
    .where(and(eq(productIdentifiers.id, id), eq(productIdentifiers.status, 'active')))
    .returning();
  return rows[0];
}

/**
 * Repoint a loser variant's identifiers to the winner during a merge.
 *
 * Where the winner already actively owns the same (scheme, value), the loser's
 * row is moved as `corrected` naming the winner's row — never deleted. The
 * identifier HISTORY is the point: which source once asserted what, against
 * which entity, is exactly what a later dispute is reviewed from.
 */
export async function repointVariantIdentifiers(
  db: DatabaseOrTransaction,
  loserVariantId: string,
  winnerVariantId: string,
): Promise<void> {
  const winnerActive = await db
    .select({
      id: productIdentifiers.id,
      scheme: productIdentifiers.scheme,
      normalizedValue: productIdentifiers.normalizedValue,
    })
    .from(productIdentifiers)
    .where(
      and(
        eq(productIdentifiers.variantId, winnerVariantId),
        eq(productIdentifiers.status, 'active'),
      ),
    );

  for (const covered of winnerActive) {
    await db
      .update(productIdentifiers)
      .set({ status: 'corrected' })
      .where(
        and(
          eq(productIdentifiers.variantId, loserVariantId),
          eq(productIdentifiers.status, 'active'),
          eq(productIdentifiers.scheme, covered.scheme),
          eq(productIdentifiers.normalizedValue, covered.normalizedValue),
        ),
      );
  }
  // The collisions above are retired FIRST, so this statement cannot violate the
  // per-entity active unique. The owner change itself is one of the two updates
  // the immutability trigger deliberately permits — a merge moves ownership and
  // never a value.
  await db
    .update(productIdentifiers)
    .set({ variantId: winnerVariantId })
    .where(eq(productIdentifiers.variantId, loserVariantId));
}

/** Repoint a loser product's identifiers to the winner. See the variant twin. */
export async function repointProductIdentifiers(
  db: DatabaseOrTransaction,
  loserProductId: string,
  winnerProductId: string,
): Promise<void> {
  const winnerActive = await db
    .select({
      scheme: productIdentifiers.scheme,
      normalizedValue: productIdentifiers.normalizedValue,
    })
    .from(productIdentifiers)
    .where(
      and(
        eq(productIdentifiers.productId, winnerProductId),
        eq(productIdentifiers.status, 'active'),
      ),
    );

  for (const covered of winnerActive) {
    await db
      .update(productIdentifiers)
      .set({ status: 'corrected' })
      .where(
        and(
          eq(productIdentifiers.productId, loserProductId),
          eq(productIdentifiers.status, 'active'),
          eq(productIdentifiers.scheme, covered.scheme),
          eq(productIdentifiers.normalizedValue, covered.normalizedValue),
        ),
      );
  }
  await db
    .update(productIdentifiers)
    .set({ productId: winnerProductId })
    .where(eq(productIdentifiers.productId, loserProductId));
}

/** Every canonical value a set of variants actively owns — the bulk read. */
export async function findCanonicalValuesForVariants(
  db: DatabaseOrTransaction,
  variantIds: readonly string[],
): Promise<{ variantId: string; canonicalValue: string }[]> {
  if (variantIds.length === 0) return [];
  const rows = await db
    .select({
      variantId: productIdentifiers.variantId,
      canonicalValue: productIdentifiers.canonicalValue,
    })
    .from(productIdentifiers)
    .where(
      and(
        inArray(productIdentifiers.variantId, [...variantIds]),
        eq(productIdentifiers.status, 'active'),
        isNotNull(productIdentifiers.canonicalValue),
      ),
    );
  const answer: { variantId: string; canonicalValue: string }[] = [];
  for (const row of rows) {
    if (row.variantId === null || row.canonicalValue === null) continue;
    answer.push({ variantId: row.variantId, canonicalValue: row.canonicalValue });
  }
  return answer;
}
