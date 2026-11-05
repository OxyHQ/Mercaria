/**
 * `pos_registers` — the NAMED registers a store adds to a location with the
 * paid `expanded_pos_registers` tool (#89).
 *
 * ## The default register is not a row, and that is the free baseline
 *
 * Every location has one implicit default register: an order whose
 * `pos_register_id` is NULL was rung up on it. That is every POS sale taken
 * before this table existed and every sale a free store takes after it — any
 * number of devices, unnamed, unlimited. Making the default a row would mean
 * backfilling one per location and refusing a sale at a location that somehow
 * lacked it; NULL means the same thing and cannot be missing.
 *
 * ## `store_id` is denormalized ON PURPOSE, and constrained rather than trusted
 *
 * A register must sit at one of ITS store's locations, and an order may only
 * name one of ITS store's registers. Both are COMPOSITE foreign keys
 * (`(location_id, store_id)` onto `locations`, `(pos_register_id, store_id)`
 * from `orders`), the `discount_codes` precedent — so a cross-store register is
 * unrepresentable rather than refused by a service comparison.
 *
 * ## Removing a register: deleted when unused, archived when it has sales
 *
 * `orders.pos_register_id` is RESTRICT — an order is the record of a sale and
 * its register is part of that record, so a register with sales is never
 * deleted: `archived_at` is set instead, its name keeps labelling its history,
 * and no new sale can be attributed to it. One with no sales is deleted
 * outright, which is what lets its location be deleted afterwards (this
 * table's `location_id` is RESTRICT too, so a location is never removed out
 * from under a register). Either way the plan allowance is given back, in the
 * same transaction.
 *
 * Names are unique per location among LIVE registers, case-insensitively: two
 * tills both called "Front" make the summary unreadable, while an archived
 * "Front" must not stop a new one taking the name.
 */

import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { POS_REGISTER_NAME_MAX_LENGTH } from '@mercaria/shared-types';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { locations, stores } from './stores';

export const posRegisters = pgTable(
  'pos_registers',
  {
    id: generatedId(),
    storeId: text()
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    /** Constrained together with `storeId` by the composite key below. */
    locationId: text().notNull(),
    name: text().notNull(),
    /** An Oxy account id — no foreign key. The member who added the register. */
    createdByOxyUserId: text().notNull(),
    /** Set when a register with sales is removed; such a register takes no new sale. */
    archivedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'pos_registers_location_id_store_id_fkey',
      columns: [t.locationId, t.storeId],
      foreignColumns: [locations.id, locations.storeId],
    }).onDelete('restrict'),
    // The parent half of `orders`' composite key onto this table.
    unique('pos_registers_id_store_id_key').on(t.id, t.storeId),
    check(
      'pos_registers_name_check',
      sql`char_length(${t.name}) between 1 and ${sql.raw(String(POS_REGISTER_NAME_MAX_LENGTH))} and ${t.name} = btrim(${t.name})`,
    ),
    uniqueIndex('pos_registers_live_name_key')
      .on(t.locationId, sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} is null`),
    index('pos_registers_store_id_location_id_idx').on(t.storeId, t.locationId),
  ],
);
