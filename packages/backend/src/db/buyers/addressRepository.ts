/**
 * `addresses` — a buyer's saved shipping addresses.
 *
 * ## The single-default invariant is now a constraint, and that CHANGES writes
 *
 * Mongo let one user hold two default addresses; `address.service` avoided it by
 * clearing the previous default in a second statement that could simply not run.
 * Here `addresses_oxy_user_id_default_key` —
 * `uniqueIndex().on(oxyUserId).where(isDefault)` — makes two unrepresentable.
 *
 * Postgres checks a unique index PER STATEMENT, so demote-then-promote inside one
 * transaction is fine and promote-then-demote is not. That is why
 * {@link updateAddress} opens a transaction: the clear and the promote must land
 * together, or the clear alone leaves the buyer with NO default and checkout has
 * nothing to preselect. {@link deleteAddress} opens one for the mirror reason —
 * removing the default and promoting the successor are one change, not two.
 *
 * The index is per USER, not global: two buyers each holding their own default is
 * the ordinary case and the partial index permits it. Pinned by a test, because
 * an index accidentally written `.on(t.isDefault)` would also pass every
 * single-user assertion.
 *
 * ## The one race the constraint cannot absorb, and why the retry is correct
 *
 * "The user's FIRST address becomes their default" is a read-then-write, and no
 * lock is available to make it atomic — Oxy owns identity, so there is no `users`
 * row to serialize on. Two genuinely simultaneous first-address creates therefore
 * both compute `isDefault: true`, and the second is refused by the index.
 * {@link insertAddress} answers that refusal by re-inserting as NON-default,
 * which is not a workaround but the exact semantics: losing that race means the
 * address was not the first, and a non-first address is not the default. The
 * retry is confined to that one constraint and to the `first` case, so it can
 * never mask a different violation.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { InferSelectModel } from 'drizzle-orm';
import { isUniqueViolation } from '@oxyhq/db';
import { getDb, type DatabaseOrTransaction } from '../postgres.js';
import { addresses } from '../schema/buyers.js';

/** One row of `addresses`. */
export type AddressRecord = InferSelectModel<typeof addresses>;

/**
 * The nine address fields a caller may supply.
 *
 * `isDefault` is deliberately absent: whether a NEW address is the default is
 * decided here (the first one is), and a promotion is an explicit
 * {@link updateAddress} with `isDefault: true`.
 */
export interface NewAddress {
  label?: string;
  recipientName: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode: string;
  country: string;
  phone?: string;
}

/** The fields a caller may patch. `undefined` means "leave alone". */
export interface AddressPatch {
  label?: string;
  recipientName?: string;
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
  phone?: string;
  isDefault?: boolean;
}

/**
 * The five optional columns as NULL-or-value.
 *
 * A field Mongo left ABSENT is NULL here, never `''` — the empty string is a real
 * value, so writing one would put a blank line2 on an order's address snapshot
 * and print it on the label.
 */
function optionalColumns(values: NewAddress): {
  label: string | null;
  line2: string | null;
  region: string | null;
  phone: string | null;
} {
  return {
    label: values.label ?? null,
    line2: values.line2 ?? null,
    region: values.region ?? null,
    phone: values.phone ?? null,
  };
}

/** The buyer's addresses, default first then newest — the list order the client renders. */
export async function findAddressesByUser(
  oxyUserId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AddressRecord[]> {
  return db
    .select()
    .from(addresses)
    .where(eq(addresses.oxyUserId, oxyUserId))
    .orderBy(desc(addresses.isDefault), desc(addresses.createdAt), desc(addresses.id));
}

/** One address scoped to its owner, or `null` — the scoping IS the authorization. */
export async function findAddress(
  oxyUserId: string,
  addressId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<AddressRecord | null> {
  const [row] = await db
    .select()
    .from(addresses)
    .where(and(eq(addresses.id, addressId), eq(addresses.oxyUserId, oxyUserId)))
    .limit(1);
  return row ?? null;
}

/** Whether the buyer has any address at all — what makes the next one their first. */
async function userHasAddress(
  oxyUserId: string,
  db: DatabaseOrTransaction,
): Promise<boolean> {
  const rows = await db
    .select({ id: addresses.id })
    .from(addresses)
    .where(eq(addresses.oxyUserId, oxyUserId))
    .limit(1);
  return rows.length > 0;
}

/** Clear every default flag of one buyer. Only ever called inside a transaction. */
async function clearDefault(oxyUserId: string, db: DatabaseOrTransaction): Promise<void> {
  await db
    .update(addresses)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(eq(addresses.oxyUserId, oxyUserId), eq(addresses.isDefault, true)));
}

/** The insert itself, with the default flag already decided. */
async function insertOne(
  oxyUserId: string,
  values: NewAddress,
  isDefault: boolean,
  db: DatabaseOrTransaction,
): Promise<AddressRecord> {
  const [row] = await db
    .insert(addresses)
    .values({
      oxyUserId,
      recipientName: values.recipientName,
      line1: values.line1,
      city: values.city,
      postalCode: values.postalCode,
      country: values.country,
      isDefault,
      ...optionalColumns(values),
    })
    .returning();
  return row;
}

/**
 * Create an address. The buyer's FIRST address becomes their default; every one
 * after it does not.
 *
 * The probe and the insert share a transaction so no other writer can observe a
 * half-applied create, and the unique index is the final authority — see the
 * module docblock for why losing that race is answered by inserting as
 * non-default rather than by failing.
 *
 * Note the probe asks whether the buyer has ANY address, not whether they have a
 * DEFAULT one. A buyer who demoted their only address has addresses and no
 * default, and the next one they add must not silently become default — that is
 * the Mongo behaviour and it is preserved deliberately.
 */
export async function insertAddress(
  oxyUserId: string,
  values: NewAddress,
  db: DatabaseOrTransaction = getDb(),
): Promise<AddressRecord> {
  const run = async (tx: DatabaseOrTransaction): Promise<AddressRecord> =>
    insertOne(oxyUserId, values, !(await userHasAddress(oxyUserId, tx)), tx);

  try {
    return await ('transaction' in db ? db.transaction(run) : run(db));
  } catch (error) {
    if (!isUniqueViolation(error, 'addresses_oxy_user_id_default_key')) {
      throw error;
    }
    // A concurrent create was the buyer's first, so this one is not — and a
    // non-first address is not the default. A fresh transaction, because the
    // refusal aborted the one the first attempt ran in; when a caller supplied
    // their own, the attempt was a SAVEPOINT and only that rolled back, so their
    // transaction is still usable here.
    return 'transaction' in db
      ? db.transaction((tx) => insertOne(oxyUserId, values, false, tx))
      : insertOne(oxyUserId, values, false, db);
  }
}

/**
 * Patch an address, clearing the buyer's previous default first when this one is
 * being promoted. Returns the updated row, or `null` when it does not belong to
 * the buyer.
 *
 * `isDefault: false` demotes without promoting anything else, exactly as it did
 * under Mongo: a buyer may deliberately have no default, and picking a
 * replacement for them would override a choice they just made.
 *
 * ## The promote path LOCKS its target before clearing anything
 *
 * The clear has to precede the promote — the partial unique index refuses the
 * other order — and that puts a destructive statement in front of a guard. If the
 * address is not this buyer's, or no longer exists, the clear has already stripped
 * their default by the time the promote matches nothing, and they are left with
 * none. Mongo could not have this bug: its service read the row and threw
 * NOT_FOUND before touching anything.
 *
 * `SELECT … FOR UPDATE` restores that order without giving up atomicity. It
 * answers "is this address the buyer's" BEFORE the clear runs, and it holds the
 * row so a concurrent delete cannot land between the clear and the promote and
 * produce the same defaultless buyer by a narrower route.
 */
export async function updateAddress(
  oxyUserId: string,
  addressId: string,
  patch: AddressPatch,
  db: DatabaseOrTransaction = getDb(),
): Promise<AddressRecord | null> {
  const run = async (tx: DatabaseOrTransaction): Promise<AddressRecord | null> => {
    if (patch.isDefault === true) {
      const [target] = await tx
        .select({ id: addresses.id })
        .from(addresses)
        .where(and(eq(addresses.id, addressId), eq(addresses.oxyUserId, oxyUserId)))
        .limit(1)
        .for('update');
      if (!target) return null;

      await clearDefault(oxyUserId, tx);
    }

    const rows = await tx
      .update(addresses)
      .set({
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.recipientName !== undefined ? { recipientName: patch.recipientName } : {}),
        ...(patch.line1 !== undefined ? { line1: patch.line1 } : {}),
        ...(patch.line2 !== undefined ? { line2: patch.line2 } : {}),
        ...(patch.city !== undefined ? { city: patch.city } : {}),
        ...(patch.region !== undefined ? { region: patch.region } : {}),
        ...(patch.postalCode !== undefined ? { postalCode: patch.postalCode } : {}),
        ...(patch.country !== undefined ? { country: patch.country } : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(addresses.id, addressId), eq(addresses.oxyUserId, oxyUserId)))
      .returning();

    return rows[0] ?? null;
  };

  return 'transaction' in db ? db.transaction(run) : run(db);
}

/**
 * Delete an address scoped to its owner, promoting the buyer's newest remaining
 * address when the deleted one was their default.
 *
 * One statement decides existence AND removal (`DELETE … RETURNING`), where the
 * Mongo path read the row and then deleted it — two concurrent deletes of the
 * same address could both pass that read, and both would have gone on to promote
 * a successor. Here exactly one of them gets a row back.
 *
 * @returns `deleted: false` when the address does not exist or belongs to someone
 *   else — the caller cannot tell those apart, which is the point.
 *   `promotedId` names the successor when there was one.
 */
export async function deleteAddress(
  oxyUserId: string,
  addressId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ deleted: boolean; promotedId: string | null }> {
  const run = async (
    tx: DatabaseOrTransaction,
  ): Promise<{ deleted: boolean; promotedId: string | null }> => {
    const [removed] = await tx
      .delete(addresses)
      .where(and(eq(addresses.id, addressId), eq(addresses.oxyUserId, oxyUserId)))
      .returning({ id: addresses.id, isDefault: addresses.isDefault });

    if (!removed) {
      return { deleted: false, promotedId: null };
    }
    if (!removed.isDefault) {
      return { deleted: true, promotedId: null };
    }

    // The default has already gone in this transaction, so the partial unique
    // index is free and the promotion cannot collide with it.
    const [successor] = await tx
      .select({ id: addresses.id })
      .from(addresses)
      .where(eq(addresses.oxyUserId, oxyUserId))
      .orderBy(desc(addresses.createdAt), desc(addresses.id))
      .limit(1);

    if (!successor) {
      return { deleted: true, promotedId: null };
    }

    await tx
      .update(addresses)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(eq(addresses.id, successor.id));

    return { deleted: true, promotedId: successor.id };
  };

  return 'transaction' in db ? db.transaction(run) : run(db);
}
