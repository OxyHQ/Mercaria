import { sql } from 'drizzle-orm';
import { pgTable, text, integer, check, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { generatedId, createdAt, updatedAt } from '@oxy.so/db';
import { MATERIAL_OFFER_STATUSES, MATERIAL_RESERVATION_STATUSES } from '@mercaria/shared-types';
import { checkOneOf } from './columns';

/** Donations are independent of checkout: no amount, payment or order reference exists. */
export const materialOffers = pgTable(
  'material_offers',
  {
    id: generatedId(),
    ownerAccountId: text().notNull(),
    title: text().notNull(),
    description: text().notNull(),
    publicArea: text().notNull(),
    quantity: integer().notNull(),
    unit: text().notNull(),
    pickupInstructions: text().notNull(),
    status: text({ enum: MATERIAL_OFFER_STATUSES }).notNull().default('active'),
    idempotencyKey: text().notNull(),
    createdByAccountId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('material_offers_owner_key').on(t.ownerAccountId, t.idempotencyKey),
    index('material_offers_status_id_idx').on(t.status, t.id),
    checkOneOf('material_offers_status_check', t.status, MATERIAL_OFFER_STATUSES),
    check('material_offers_quantity_check', sql`${t.quantity} between 1 and 1000000`),
  ],
);

export const materialReservations = pgTable(
  'material_reservations',
  {
    id: generatedId(),
    offerId: text()
      .notNull()
      .references(() => materialOffers.id, { onDelete: 'restrict' }),
    requesterAccountId: text().notNull(),
    // Opaque Moovo reference. Transport facts are fetched from its owning SDK.
    moovoTransportId: text(),
    quantity: integer().notNull(),
    status: text({ enum: MATERIAL_RESERVATION_STATUSES }).notNull().default('requested'),
    idempotencyKey: text().notNull(),
    createdByAccountId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('material_reservations_request_key').on(t.requesterAccountId, t.idempotencyKey),
    index('material_reservations_offer_status_idx').on(t.offerId, t.status),
    index('material_reservations_requester_id_idx').on(t.requesterAccountId, t.id),
    checkOneOf('material_reservations_status_check', t.status, MATERIAL_RESERVATION_STATUSES),
    check('material_reservations_quantity_check', sql`${t.quantity} between 1 and 1000000`),
  ],
);

/** Audit and replay ledger; identities are Oxy account references, never copied membership. */
export const materialReservationEvents = pgTable(
  'material_reservation_events',
  {
    id: generatedId(),
    reservationId: text()
      .notNull()
      .references(() => materialReservations.id, { onDelete: 'restrict' }),
    actingAccountId: text().notNull(),
    actorAccountId: text().notNull(),
    status: text({ enum: MATERIAL_RESERVATION_STATUSES }).notNull(),
    idempotencyKey: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('material_reservation_events_action_key').on(
      t.reservationId,
      t.actingAccountId,
      t.idempotencyKey,
    ),
    checkOneOf('material_reservation_events_status_check', t.status, MATERIAL_RESERVATION_STATUSES),
  ],
);
