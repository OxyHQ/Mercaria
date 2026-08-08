/**
 * `discounts` and `discount_codes`.
 *
 * The pricing engine loads a store's whole active set and tests eligibility in
 * memory, so the reads here are deliberately coarse: one query returns the
 * discounts with their codes attached, and nothing filters by product or
 * collection in SQL. That is why `applies_to_product_ids` and friends stayed
 * `text[]` rather than becoming four more junction tables — no query wants them
 * by element.
 *
 * ## {@link redeemDiscountCode} is the one place a race can cost money
 *
 * Mongo enforced the total-usage ceiling with an `$expr` over the summed code
 * counters inside the same `updateOne`, which is safe there because the whole
 * document is re-read under the write lock. **The obvious Postgres translation is
 * not safe.** A subquery in an `UPDATE … WHERE` is evaluated against the
 * statement's own snapshot, and READ COMMITTED explicitly does not re-read OTHER
 * rows during an EvalPlanQual recheck — so two concurrent redemptions at
 * `totalMax - 1` both see the pre-increment sum, both pass, and the ceiling is
 * exceeded by one with no error anywhere.
 *
 * The fix is to serialize on something: this takes `SELECT … FOR UPDATE` on the
 * PARENT discount row first, and only then counts. The lock makes the second
 * redemption wait; because each statement in READ COMMITTED takes a fresh
 * snapshot, the count it runs AFTER acquiring the lock sees the first one's
 * committed increment and refuses. Pinned by a two-concurrent-redemptions test
 * against a real server, which is the only thing that can tell these two
 * implementations apart.
 */

import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { InferSelectModel, SQL } from 'drizzle-orm';
import type { DiscountMethod, DiscountScope, DiscountValueType } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { discountCodes, discounts } from '../schema/merchandising.js';

/** One row of `discounts`. */
export type DiscountRow = InferSelectModel<typeof discounts>;

/** One row of `discount_codes`. */
export type DiscountCodeRow = InferSelectModel<typeof discountCodes>;

/** A discount with its redeemable codes attached — what callers read. */
export interface DiscountRecord extends DiscountRow {
  readonly codes: DiscountCodeRow[];
}

/** A buy/get leg as a caller supplies it. */
export interface DiscountLegInput {
  quantity: number;
  scope: Exclude<DiscountScope, 'order'>;
  productIds?: string[];
  collectionIds?: string[];
  discountPercent?: number;
}

/** A whole discount as a caller supplies it. */
export interface NewDiscount {
  title: string;
  method: DiscountMethod;
  valueType: DiscountValueType;
  value: number;
  appliesTo: { scope: DiscountScope; productIds?: string[]; collectionIds?: string[] };
  buy?: DiscountLegInput;
  get?: DiscountLegInput;
  minimumRequirement?: { type: 'none' | 'subtotal' | 'quantity'; value: number };
  customerEligibility?: {
    type: 'all' | 'groups' | 'customers';
    customerIds?: string[];
    groupTags?: string[];
  };
  usageLimits?: { totalMax?: number; perCustomerMax?: number };
  combinesWith: { orderDiscounts: boolean; productDiscounts: boolean; shippingDiscounts: boolean };
  startsAt: Date;
  endsAt?: Date;
  isActive: boolean;
  codes: string[];
}

/** A patch. Every field is optional; an absent one is left alone. */
export type DiscountPatch = Partial<Omit<NewDiscount, 'codes'>> & { codes?: string[] };

/** Attach the codes to a batch of discount rows, in ONE query for the batch. */
async function withCodes(
  rows: DiscountRow[],
  db: DatabaseOrTransaction,
): Promise<DiscountRecord[]> {
  if (rows.length === 0) return [];

  const codeRows = await db
    .select()
    .from(discountCodes)
    .where(inArray(discountCodes.discountId, rows.map((row) => row.id)))
    // Insertion order is what the embedded array had; `code` is the stable
    // tiebreaker so the admin list does not reorder between requests.
    .orderBy(asc(discountCodes.createdAt), asc(discountCodes.code));

  const byDiscount = new Map<string, DiscountCodeRow[]>();
  for (const code of codeRows) {
    const bucket = byDiscount.get(code.discountId);
    if (bucket) bucket.push(code);
    else byDiscount.set(code.discountId, [code]);
  }

  return rows.map((row) => ({ ...row, codes: byDiscount.get(row.id) ?? [] }));
}

/**
 * The scheduled-window predicate: started, and either open-ended or not yet over.
 *
 * `endsAt IS NULL OR endsAt >= now` reproduces Mongo's three-branch `$or`
 * (`$exists: false`, `null`, `$gte`) — the first two collapse into one here,
 * because an absent column and a NULL column are the same thing in Postgres.
 */
function inWindow(now: Date): SQL {
  return and(
    lte(discounts.startsAt, now),
    or(isNull(discounts.endsAt), gte(discounts.endsAt, now)),
  ) as SQL;
}

/** A store's discounts, newest first — the admin list. */
export async function findDiscountsForStore(
  storeId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<DiscountRecord[]> {
  const rows = await db
    .select()
    .from(discounts)
    .where(eq(discounts.storeId, storeId))
    .orderBy(sql`${discounts.createdAt} desc nulls last`, sql`${discounts.id} desc nulls last`);
  return withCodes(rows, db);
}

/** One discount scoped to its store, or `null` — the scoping IS the authorization. */
export async function findDiscount(
  storeId: string,
  discountId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<DiscountRecord | null> {
  const rows = await db
    .select()
    .from(discounts)
    .where(and(eq(discounts.id, discountId), eq(discounts.storeId, storeId)))
    .limit(1);
  const [record] = await withCodes(rows, db);
  return record ?? null;
}

/**
 * A store's ACTIVE, in-window discounts with their codes — the pricing engine's
 * one query per seller group.
 */
export async function findActiveDiscounts(
  storeId: string,
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<DiscountRecord[]> {
  const rows = await db
    .select()
    .from(discounts)
    .where(and(eq(discounts.storeId, storeId), eq(discounts.isActive, true), inWindow(now)))
    .orderBy(asc(discounts.id));
  return withCodes(rows, db);
}

/**
 * Whether any of these stores has an ACTIVE, in-window discount carrying `code` —
 * the cart's "is this code worth pinning" check.
 *
 * A join rather than a two-step read: the code lives on the child row and the
 * window on the parent, so answering it in one statement is what stops a code
 * from being accepted against an expired discount that merely still has the code.
 */
export async function activeDiscountCodeExists(
  storeIds: readonly string[],
  code: string,
  now: Date,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  if (storeIds.length === 0) return false;
  const rows = await db
    .select({ id: discounts.id })
    .from(discounts)
    .innerJoin(discountCodes, eq(discountCodes.discountId, discounts.id))
    .where(
      and(
        inArray(discounts.storeId, [...storeIds]),
        eq(discounts.isActive, true),
        eq(discountCodes.code, code),
        inWindow(now),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** The flat columns a discount's nested input sub-documents expand into. */
function discountColumns(input: NewDiscount | DiscountPatch) {
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.method !== undefined ? { method: input.method } : {}),
    ...(input.valueType !== undefined ? { valueType: input.valueType } : {}),
    ...(input.value !== undefined ? { value: input.value } : {}),
    ...(input.appliesTo !== undefined
      ? {
          appliesToScope: input.appliesTo.scope,
          appliesToProductIds: input.appliesTo.productIds ?? null,
          appliesToCollectionIds: input.appliesTo.collectionIds ?? null,
        }
      : {}),
    ...(input.buy !== undefined
      ? {
          buyQuantity: input.buy.quantity,
          buyScope: input.buy.scope,
          buyProductIds: input.buy.productIds ?? null,
          buyCollectionIds: input.buy.collectionIds ?? null,
          buyDiscountPercent: input.buy.discountPercent ?? null,
        }
      : {}),
    ...(input.get !== undefined
      ? {
          getQuantity: input.get.quantity,
          getScope: input.get.scope,
          getProductIds: input.get.productIds ?? null,
          getCollectionIds: input.get.collectionIds ?? null,
          getDiscountPercent: input.get.discountPercent ?? null,
        }
      : {}),
    ...(input.minimumRequirement !== undefined
      ? {
          minimumRequirementType: input.minimumRequirement.type,
          minimumRequirementValue: input.minimumRequirement.value,
        }
      : {}),
    ...(input.customerEligibility !== undefined
      ? {
          customerEligibilityType: input.customerEligibility.type,
          customerEligibilityCustomerIds: input.customerEligibility.customerIds ?? null,
          customerEligibilityGroupTags: input.customerEligibility.groupTags ?? null,
        }
      : {}),
    ...(input.usageLimits !== undefined
      ? {
          usageLimitsTotalMax: input.usageLimits.totalMax ?? null,
          usageLimitsPerCustomerMax: input.usageLimits.perCustomerMax ?? null,
        }
      : {}),
    ...(input.combinesWith !== undefined
      ? {
          combinesWithOrderDiscounts: input.combinesWith.orderDiscounts,
          combinesWithProductDiscounts: input.combinesWith.productDiscounts,
          combinesWithShippingDiscounts: input.combinesWith.shippingDiscounts,
        }
      : {}),
    ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
    ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
  };
}

/**
 * Create a discount and its codes in ONE transaction.
 *
 * @throws A unique-violation on `discount_codes_store_id_code_key` when the store
 *   already has one of these codes. The caller maps it to a CONFLICT.
 */
export async function insertDiscount(
  storeId: string,
  input: NewDiscount,
  db: DatabaseOrTransaction = getDb(),
): Promise<DiscountRecord> {
  const run = async (tx: DatabaseOrTransaction): Promise<DiscountRecord> => {
    const [row] = await tx
      .insert(discounts)
      .values({
        storeId,
        title: input.title,
        method: input.method,
        valueType: input.valueType,
        value: input.value,
        appliesToScope: input.appliesTo.scope,
        startsAt: input.startsAt,
        isActive: input.isActive,
        combinesWithOrderDiscounts: input.combinesWith.orderDiscounts,
        combinesWithProductDiscounts: input.combinesWith.productDiscounts,
        combinesWithShippingDiscounts: input.combinesWith.shippingDiscounts,
        ...discountColumns(input),
      })
      .returning();

    if (input.codes.length > 0) {
      await tx.insert(discountCodes).values(
        input.codes.map((code) => ({
          discountId: row.id,
          storeId,
          code,
          usageCount: 0,
        })),
      );
    }

    const [record] = await withCodes([row], tx);
    return record;
  };

  return 'transaction' in db ? db.transaction(run) : run(db);
}

/**
 * Patch a discount scoped to its store, optionally replacing its codes.
 *
 * A code that survives the edit KEEPS its usage count: the replacement reads the
 * existing counters first and carries them over, which is what the Mongo path did
 * by rebuilding the sub-document array. Resetting them instead would hand every
 * capped promotion a fresh budget on an unrelated title change.
 *
 * @returns `null` when the discount is not that store's.
 */
export async function updateDiscount(
  storeId: string,
  discountId: string,
  patch: DiscountPatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<DiscountRecord | null> {
  const run = async (tx: DatabaseOrTransaction): Promise<DiscountRecord | null> => {
    const columns = discountColumns(patch);
    const [row] =
      Object.keys(columns).length > 0
        ? await tx
            .update(discounts)
            .set({ ...columns, updatedAt: new Date() })
            .where(and(eq(discounts.id, discountId), eq(discounts.storeId, storeId)))
            .returning()
        : await tx
            .select()
            .from(discounts)
            .where(and(eq(discounts.id, discountId), eq(discounts.storeId, storeId)))
            .limit(1);
    if (!row) return null;

    if (patch.codes !== undefined) {
      const existing = await tx
        .select({ code: discountCodes.code, usageCount: discountCodes.usageCount })
        .from(discountCodes)
        .where(eq(discountCodes.discountId, discountId));
      const usageByCode = new Map(existing.map((entry) => [entry.code, entry.usageCount]));

      await tx.delete(discountCodes).where(eq(discountCodes.discountId, discountId));
      if (patch.codes.length > 0) {
        await tx.insert(discountCodes).values(
          patch.codes.map((code) => ({
            discountId,
            storeId,
            code,
            usageCount: usageByCode.get(code) ?? 0,
          })),
        );
      }
    }

    const [record] = await withCodes([row], tx);
    return record;
  };

  return 'transaction' in db ? db.transaction(run) : run(db);
}

/** Delete a discount and its codes. `false` when it is not that store's. */
export async function deleteDiscount(
  storeId: string,
  discountId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .delete(discounts)
    .where(and(eq(discounts.id, discountId), eq(discounts.storeId, storeId)))
    .returning({ id: discounts.id });
  return rows.length > 0;
}

/**
 * Count one redemption of `code` against its discount's total-usage ceiling.
 *
 * Serialized on the PARENT discount row — see the module header for why the
 * shorter `UPDATE … WHERE (subquery) < max` form is NOT safe and this is.
 *
 * @returns `false` when the ceiling was already reached, or when no such code
 *   exists. The caller logs and carries on: a redemption count is bookkeeping and
 *   must never fail a completed checkout.
 */
export async function redeemDiscountCode(
  code: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const run = async (tx: DatabaseOrTransaction): Promise<boolean> => {
    const [target] = await tx
      .select({ id: discountCodes.id, discountId: discountCodes.discountId })
      .from(discountCodes)
      .where(eq(discountCodes.code, code))
      .limit(1);
    if (!target) return false;

    // The lock, and the reason this is a transaction at all. Any concurrent
    // redemption of the SAME discount blocks here until we commit.
    const [locked] = await tx
      .select({ totalMax: discounts.usageLimitsTotalMax })
      .from(discounts)
      .where(eq(discounts.id, target.discountId))
      .for('update');
    if (!locked) return false;

    if (locked.totalMax !== null) {
      // A SEPARATE statement, which is what makes this correct: READ COMMITTED
      // gives each statement a fresh snapshot, so this count — taken after the
      // lock was granted — includes whatever the transaction we waited for
      // committed. Folding it into the SELECT above would read the pre-wait
      // snapshot and let both redemptions through.
      const [used] = await tx
        .select({ total: sql<number>`coalesce(sum(${discountCodes.usageCount}), 0)::int` })
        .from(discountCodes)
        .where(eq(discountCodes.discountId, target.discountId));
      if (Number(used?.total ?? 0) >= locked.totalMax) return false;
    }

    await tx
      .update(discountCodes)
      .set({ usageCount: sql`${discountCodes.usageCount} + 1`, updatedAt: new Date() })
      .where(eq(discountCodes.id, target.id));
    return true;
  };

  return 'transaction' in db ? db.transaction(run) : run(db);
}
