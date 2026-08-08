/**
 * `customers` — a store-scoped buyer record, Oxy-backed or a POS walk-in.
 *
 * ## Every read here NAMES `email` and `phone`, and that is the point
 *
 * Both are registered in `db/protectedColumns.ts`: a walk-in's contact details
 * are the single most likely accidental disclosure in this schema. The store
 * customer surface legitimately renders them — a member with `customers:read`
 * typed them at the register — so this module opts in EXPLICITLY, spreading
 * `publicColumns` and then naming the two it wants back. That reads differently
 * from an ordinary select and stays greppable, which is exactly what the registry
 * asks of a path that needs a protected column. Every OTHER module keeps the
 * protection: nothing outside a store-scoped admin route selects this table.
 *
 * ## The two aggregate writers are NOT symmetrical
 *
 * {@link upsertCustomerOnPaid} is an UPSERT with `$inc` semantics — a buyer's
 * first paid order at a store creates their record. {@link decrementOnRefund} is
 * a plain UPDATE: a refund for a buyer with no customer record (a P2P order, or a
 * store order whose buyer was never related) must be a no-op, and an upsert there
 * would MINT a customer with a negative lifetime spend and no order.
 */

import { and, count, eq, ilike, isNotNull, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { type SelectedRow } from '@oxyhq/db';
import { publicColumns } from '@oxyhq/db/assert';
import type { AddressSnapshot, CurrencyCode, Money } from '@mercaria/shared-types';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { PROTECTED_COLUMNS } from '../protectedColumns.js';
import { customers } from '../schema/stores.js';

/**
 * Every column of `customers` INCLUDING the two protected contact fields.
 *
 * The explicit opt-in described in the module header. Adding a column to
 * `PROTECTED_COLUMNS.customers` without adding it here withholds it from this
 * surface too, which is the fail-closed direction.
 */
const CUSTOMER_COLUMNS = {
  ...publicColumns(customers, PROTECTED_COLUMNS),
  email: customers.email,
  phone: customers.phone,
} as const;

/** One row of `customers`, contact details included. */
export type CustomerRecord = SelectedRow<typeof CUSTOMER_COLUMNS>;

/** The columns a caller may set when creating a customer. */
export interface NewCustomer {
  oxyUserId?: string;
  isWalkIn: boolean;
  displayName?: string;
  email?: string;
  phone?: string;
  defaultAddress?: AddressSnapshot;
  tags: string[];
  groupTags: string[];
  notes?: string;
  totalSpentCurrency: CurrencyCode;
}

/** The columns a caller may patch. `undefined` means "leave alone"; `null` clears. */
export interface CustomerPatch {
  oxyUserId?: string;
  isWalkIn?: boolean;
  displayName?: string;
  email?: string;
  phone?: string;
  defaultAddress?: AddressSnapshot | undefined;
  tags?: string[];
  groupTags?: string[];
  notes?: string;
}

/** The nine address columns, or nine NULLs when the address is being cleared. */
function addressColumnValues(address: AddressSnapshot | undefined) {
  return {
    defaultAddressLabel: address?.label ?? null,
    defaultAddressRecipientName: address?.recipientName ?? null,
    defaultAddressLine1: address?.line1 ?? null,
    defaultAddressLine2: address?.line2 ?? null,
    defaultAddressCity: address?.city ?? null,
    defaultAddressRegion: address?.region ?? null,
    defaultAddressPostalCode: address?.postalCode ?? null,
    defaultAddressCountry: address?.country ?? null,
    defaultAddressPhone: address?.phone ?? null,
  };
}

/** One customer scoped to its store, or `null` — the scoping IS the authorization. */
export async function findCustomer(
  storeId: string,
  customerId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CustomerRecord | null> {
  const [row] = await db
    .select(CUSTOMER_COLUMNS)
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.storeId, storeId)))
    .limit(1);
  return row ?? null;
}

/** One store's customer record for an Oxy account, or `null`. */
export async function findCustomerByOxyUser(
  storeId: string,
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CustomerRecord | null> {
  const [row] = await db
    .select(CUSTOMER_COLUMNS)
    .from(customers)
    .where(and(eq(customers.storeId, storeId), eq(customers.oxyUserId, oxyUserId)))
    .limit(1);
  return row ?? null;
}

/** One store's customer record for an email address, or `null`. */
export async function findCustomerByEmail(
  storeId: string,
  email: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CustomerRecord | null> {
  const [row] = await db
    .select(CUSTOMER_COLUMNS)
    .from(customers)
    .where(and(eq(customers.storeId, storeId), eq(customers.email, email)))
    .limit(1);
  return row ?? null;
}

/**
 * Escape a user-supplied string for use inside a `LIKE`/`ILIKE` pattern.
 *
 * `%`, `_` and the escape character itself are the three that matter: unescaped,
 * a search for `100%` matches every customer, and a search for `a_b` matches
 * `axb`. The Mongo path escaped a RegExp for the same reason; dropping the escape
 * during the port would turn a search box into a wildcard nobody typed.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** A page of a store's customers, newest first, optionally name/email-filtered. */
export async function findCustomersPage(
  storeId: string,
  filter: { search?: string },
  page: number,
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ rows: CustomerRecord[]; total: number }> {
  const search = filter.search?.trim();
  const where: SQL | undefined = search
    ? and(
        eq(customers.storeId, storeId),
        or(
          ilike(customers.displayName, `%${escapeLike(search)}%`),
          ilike(customers.email, `%${escapeLike(search)}%`),
        ),
      )
    : eq(customers.storeId, storeId);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select(CUSTOMER_COLUMNS)
      .from(customers)
      .where(where)
      // `desc nulls last` matches `customers_store_id_created_at_idx`; a bare
      // Postgres `DESC` is NULLS FIRST and cannot use it for ordering.
      .orderBy(sql`${customers.createdAt} desc nulls last`, sql`${customers.id} desc nulls last`)
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ total: count() }).from(customers).where(where),
  ]);

  return { rows, total: totalRow?.total ?? 0 };
}

/**
 * Create a customer.
 *
 * @throws A unique-violation on `customers_store_id_oxy_user_id_key` when this
 *   store already has a record for that Oxy account. The caller maps it to a
 *   CONFLICT.
 */
export async function insertCustomer(
  storeId: string,
  input: NewCustomer,
  db: DatabaseOrTransaction = getDb(),
): Promise<CustomerRecord> {
  const [row] = await db
    .insert(customers)
    .values({
      storeId,
      // NULL, never `''`: the partial unique index treats NULLs as distinct so
      // walk-ins never collide, but an empty string IS a value and collides for
      // real — the second walk-in would be refused.
      oxyUserId: input.oxyUserId ?? null,
      isWalkIn: input.isWalkIn,
      displayName: input.displayName ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      ...addressColumnValues(input.defaultAddress),
      tags: [...input.tags],
      groupTags: [...input.groupTags],
      notes: input.notes ?? null,
      statsTotalSpentAmount: 0,
      statsTotalSpentCurrency: input.totalSpentCurrency,
    })
    .returning(CUSTOMER_COLUMNS);
  return row;
}

/**
 * Patch a customer scoped to its store. Returns `null` when it is not that
 * store's.
 *
 * @throws A unique-violation on `customers_store_id_oxy_user_id_key` when the
 *   patch would claim an Oxy account this store already has a record for.
 */
export async function updateCustomer(
  storeId: string,
  customerId: string,
  patch: CustomerPatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<CustomerRecord | null> {
  const [row] = await db
    .update(customers)
    .set({
      ...(patch.oxyUserId !== undefined ? { oxyUserId: patch.oxyUserId } : {}),
      ...(patch.isWalkIn !== undefined ? { isWalkIn: patch.isWalkIn } : {}),
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.email !== undefined ? { email: patch.email } : {}),
      ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
      ...('defaultAddress' in patch ? addressColumnValues(patch.defaultAddress) : {}),
      ...(patch.tags !== undefined ? { tags: [...patch.tags] } : {}),
      ...(patch.groupTags !== undefined ? { groupTags: [...patch.groupTags] } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(customers.id, customerId), eq(customers.storeId, storeId)))
    .returning(CUSTOMER_COLUMNS);
  return row ?? null;
}

/**
 * Relate a buyer to a store and bump their lifetime aggregates — exactly once per
 * paid store order.
 *
 * `ON CONFLICT … DO UPDATE` is the port of Mongo's `$inc` + `$setOnInsert` in one
 * statement, with the same split of responsibilities: the INSERT values carry the
 * identity a first order establishes, and the DO UPDATE carries only what
 * accumulates. The increments reference the EXISTING row's columns (never
 * `excluded`, which is the row this statement proposed), so two concurrent first
 * orders settle at `orderCount = 2` rather than one of them overwriting the
 * other.
 *
 * `targetWhere` is required, not decoration: `customers_store_id_oxy_user_id_key`
 * is a PARTIAL unique index, and Postgres cannot infer a partial index for
 * conflict resolution without being told its predicate.
 */
export async function upsertCustomerOnPaid(
  storeId: string,
  oxyUserId: string,
  orderGrandTotal: Money,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  const now = new Date();
  await db
    .insert(customers)
    .values({
      storeId,
      oxyUserId,
      isWalkIn: false,
      tags: [],
      groupTags: [],
      statsOrderCount: 1,
      statsTotalSpentAmount: orderGrandTotal.amount,
      statsTotalSpentCurrency: orderGrandTotal.currency,
      statsLastOrderAt: now,
    })
    .onConflictDoUpdate({
      target: [customers.storeId, customers.oxyUserId],
      targetWhere: isNotNull(customers.oxyUserId),
      set: {
        statsOrderCount: sql`${customers.statsOrderCount} + 1`,
        statsTotalSpentAmount: sql`${customers.statsTotalSpentAmount} + ${orderGrandTotal.amount}`,
        statsLastOrderAt: now,
        updatedAt: now,
      },
    });
}

/**
 * Give back a refunded amount from a store customer's lifetime spend.
 *
 * NOT an upsert — see the module header. `orderCount` is deliberately untouched:
 * a refund does not un-count the order.
 *
 * `greatest(0, …)` is a BEHAVIOUR CHANGE against the Mongo `$inc`, which would
 * happily drive the total negative. A negative lifetime spend is not a state any
 * reader can render, and the clamp matches `adjustStoreProductCount`'s existing
 * convention for the same class of counter.
 */
export async function decrementCustomerOnRefund(
  storeId: string,
  oxyUserId: string,
  refundAmount: Money,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(customers)
    .set({
      statsTotalSpentAmount: sql`greatest(0, ${customers.statsTotalSpentAmount} - ${refundAmount.amount})`,
      updatedAt: new Date(),
    })
    .where(and(eq(customers.storeId, storeId), eq(customers.oxyUserId, oxyUserId)));
}

/**
 * Find-or-create the store's record for a POS sale, refreshing whatever the
 * cashier typed.
 *
 * The Oxy-backed branch of `resolveOrCreate`. Same partial-index caveat as
 * {@link upsertCustomerOnPaid}; the aggregates are untouched, since ringing
 * someone up is not a sale until the order is paid.
 */
export async function upsertPosCustomer(
  storeId: string,
  oxyUserId: string,
  contact: { displayName?: string; email?: string; phone?: string },
  totalSpentCurrency: CurrencyCode,
  db: DatabaseOrTransaction = getDb(),
): Promise<CustomerRecord> {
  const now = new Date();
  const [row] = await db
    .insert(customers)
    .values({
      storeId,
      oxyUserId,
      isWalkIn: false,
      displayName: contact.displayName ?? null,
      email: contact.email ?? null,
      phone: contact.phone ?? null,
      tags: [],
      groupTags: [],
      statsTotalSpentAmount: 0,
      statsTotalSpentCurrency: totalSpentCurrency,
    })
    .onConflictDoUpdate({
      target: [customers.storeId, customers.oxyUserId],
      targetWhere: isNotNull(customers.oxyUserId),
      set: {
        isWalkIn: false,
        // Only what the cashier actually typed overwrites what is stored: a blank
        // field at the register is "not asked", not "erase what we know".
        ...(contact.displayName !== undefined ? { displayName: contact.displayName } : {}),
        ...(contact.email !== undefined ? { email: contact.email } : {}),
        ...(contact.phone !== undefined ? { phone: contact.phone } : {}),
        updatedAt: now,
      },
    })
    .returning(CUSTOMER_COLUMNS);
  return row;
}
