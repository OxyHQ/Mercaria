import { and, desc, eq, getTableColumns, inArray, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  MaterialOfferCreateSchema,
  MaterialRequestCreateSchema,
  MaterialActionSchema,
  MaterialOfferQuerySchema,
  MaterialReservationQuerySchema,
  type MaterialOffer,
  type MaterialOfferCreate,
  type MaterialRequestCreate,
  type MaterialAction,
  type MaterialOfferQuery,
  type MaterialReservationQuery,
  type MaterialReservation,
} from '@mercaria/contracts';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres.js';
import {
  materialOffers as offers,
  materialReservations as reservations,
  materialReservationEvents as events,
} from '../../db/schema/materials.js';
import { PublicApiError } from '../public-api/errors.js';
import { publicCursorFingerprint } from '../public-api/cursor.js';
import { readCallerAccountRole } from '../oxy-account-graph.js';
import { MercariaError } from '../../lib/errors/error-codes.js';
import type { StoreCaller } from '../store-access.service.js';

const offerColumns = {
  id: offers.id,
  ownerAccountId: offers.ownerAccountId,
  title: offers.title,
  description: offers.description,
  publicArea: offers.publicArea,
  quantity: offers.quantity,
  unit: offers.unit,
  pickupInstructions: offers.pickupInstructions,
  status: offers.status,
  idempotencyKey: offers.idempotencyKey,
  createdByAccountId: offers.createdByAccountId,
  createdAt: offers.createdAt,
  updatedAt: offers.updatedAt,
};
const reservationColumns = getTableColumns(reservations);
type OfferRow = typeof offers.$inferSelect;
type ReservationRow = typeof reservations.$inferSelect;

/** No role cache: a removed organization member cannot act using a prior materials response. */
async function authorize(caller: StoreCaller | null, accountId: string): Promise<string> {
  if (!caller) throw new PublicApiError('unauthorized', 'Sign in to manage donated materials');
  if (caller.accountId === accountId && caller.actorAccountId === accountId && !caller.delegated)
    return accountId;
  let role: Awaited<ReturnType<typeof readCallerAccountRole>>;
  try {
    role = await readCallerAccountRole(caller.accessToken, accountId);
  } catch (err) {
    if (err instanceof MercariaError && err.httpStatus === 401)
      throw new PublicApiError('unauthorized', 'Your Oxy session is no longer valid');
    throw new PublicApiError('service_unavailable', 'Account access cannot be checked right now');
  }
  if (role !== 'owner' && role !== 'admin' && role !== 'editor')
    throw new PublicApiError(
      'forbidden',
      'This account does not authorize you to manage materials',
    );
  if (!caller.actorAccountId)
    throw new PublicApiError('forbidden', 'The session must identify the acting account');
  return caller.actorAccountId;
}
const conflict = (message: string): never => {
  throw new PublicApiError('conflict', message);
};
const missing = (): never => {
  throw new PublicApiError('not_found', 'Materials resource not found');
};
const check = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new PublicApiError('validation_failed', 'Invalid materials input');
  return result.data;
};

async function findOffer(id: string, db: DatabaseOrTransaction, lock = false): Promise<OfferRow> {
  const q = db.select(offerColumns).from(offers).where(eq(offers.id, id));
  const [row] = await (lock ? q.for('update') : q);
  return row ?? missing();
}
async function findReservation(id: string, db: DatabaseOrTransaction): Promise<ReservationRow> {
  const [row] = await db
    .select(reservationColumns)
    .from(reservations)
    .where(eq(reservations.id, id));
  return row ?? missing();
}

/** Aggregate only this page's offers. No stored counter can drift from reservation state. */
async function projectOffers(
  rows: OfferRow[],
  db: DatabaseOrTransaction,
): Promise<MaterialOffer[]> {
  if (!rows.length) return [];
  const quantities = await db
    .select({
      offerId: reservations.offerId,
      committed: sql<number>`coalesce(sum(${reservations.quantity}) filter (where ${reservations.status} = 'accepted'), 0)::int`,
      received: sql<number>`coalesce(sum(${reservations.quantity}) filter (where ${reservations.status} = 'delivered'), 0)::int`,
    })
    .from(reservations)
    .where(
      inArray(
        reservations.offerId,
        rows.map((row) => row.id),
      ),
    )
    .groupBy(reservations.offerId);
  const byOffer = new Map(quantities.map((row) => [row.offerId, row]));
  return rows.map((row) => {
    const totals = byOffer.get(row.id);
    const committedQuantity = totals?.committed ?? 0;
    const receivedQuantity = totals?.received ?? 0;
    return {
      id: row.id,
      ownerAccountId: row.ownerAccountId,
      title: row.title,
      description: row.description,
      publicArea: row.publicArea,
      quantity: row.quantity,
      unit: row.unit,
      status: row.status,
      committedQuantity,
      receivedQuantity,
      availableQuantity: row.quantity - committedQuantity - receivedQuantity,
      createdAt: row.createdAt.toISOString(),
    };
  });
}
function projectReservation(row: ReservationRow, offer: OfferRow): MaterialReservation {
  return {
    id: row.id,
    offerId: row.offerId,
    donorAccountId: offer.ownerAccountId,
    requesterAccountId: row.requesterAccountId,
    moovoTransportId: row.moovoTransportId,
    quantity: row.quantity,
    status: row.status,
    pickupInstructions:
      row.status === 'accepted' || row.status === 'delivered' ? offer.pickupInstructions : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getMaterialOffer(id: string) {
  return (await projectOffers([await findOffer(id, getDb())], getDb()))[0];
}
export async function createMaterialOffer(caller: StoreCaller | null, input: MaterialOfferCreate) {
  const body = check(MaterialOfferCreateSchema, input);
  const actor = await authorize(caller, body.ownerAccountId);
  return getDb().transaction(async (tx) => {
    const [created] = await tx
      .insert(offers)
      .values({ ...body, createdByAccountId: actor })
      .onConflictDoNothing()
      .returning(offerColumns);
    const [existing] = created
      ? [created]
      : await tx
          .select(offerColumns)
          .from(offers)
          .where(
            and(
              eq(offers.ownerAccountId, body.ownerAccountId),
              eq(offers.idempotencyKey, body.idempotencyKey),
            ),
          );
    if (!existing) return missing();
    for (const key of [
      'title',
      'description',
      'publicArea',
      'quantity',
      'unit',
      'pickupInstructions',
    ] as const) {
      if (existing[key] !== body[key])
        conflict('This idempotency key was already used for another offer');
    }
    return (await projectOffers([existing], tx))[0];
  });
}
export async function closeMaterialOffer(
  caller: StoreCaller | null,
  id: string,
  input: MaterialAction,
) {
  const body = check(MaterialActionSchema, input);
  await authorize(caller, body.actingAccountId);
  return getDb().transaction(async (tx) => {
    const row = await findOffer(id, tx, true);
    if (row.ownerAccountId !== body.actingAccountId) return missing();
    const [closed] = await tx
      .update(offers)
      .set({ status: 'closed', updatedAt: new Date() })
      .where(eq(offers.id, id))
      .returning(offerColumns);
    return (await projectOffers([closed], tx))[0];
  });
}
export async function requestMaterial(
  caller: StoreCaller | null,
  offerId: string,
  input: MaterialRequestCreate,
) {
  const body = check(MaterialRequestCreateSchema, input);
  const actor = await authorize(caller, body.requesterAccountId);
  return getDb().transaction(async (tx) => {
    const offer = await findOffer(offerId, tx, true);
    if (offer.ownerAccountId === body.requesterAccountId)
      conflict('An account cannot request its own donation');
    const [existing] = await tx
      .select(reservationColumns)
      .from(reservations)
      .where(
        and(
          eq(reservations.requesterAccountId, body.requesterAccountId),
          eq(reservations.idempotencyKey, body.idempotencyKey),
        ),
      );
    if (existing) {
      if (existing.offerId !== offerId || existing.quantity !== body.quantity)
        conflict('This idempotency key was already used for another request');
      return projectReservation(existing, offer);
    }
    if (offer.status !== 'active') conflict('This offer is closed');
    if (body.quantity > offer.quantity) conflict('The requested quantity exceeds this offer');
    const [created] = await tx
      .insert(reservations)
      .values({ ...body, offerId, createdByAccountId: actor })
      .onConflictDoNothing()
      .returning(reservationColumns);
    if (!created) conflict('This idempotency key was already used for another request');
    await tx.insert(events).values({
      reservationId: created.id,
      actingAccountId: body.requesterAccountId,
      actorAccountId: actor,
      status: 'requested',
      idempotencyKey: body.idempotencyKey,
    });
    return projectReservation(created, offer);
  });
}

/** All mutations lock the OFFER first; races between distinct reservations serialize on stock. */
export async function transitionMaterialReservation(
  caller: StoreCaller | null,
  id: string,
  input: MaterialAction,
  target: 'accepted' | 'cancelled' | 'delivered',
) {
  const body = check(MaterialActionSchema, input);
  const actor = await authorize(caller, body.actingAccountId);
  const initial = await findReservation(id, getDb());
  return getDb().transaction(async (tx) => {
    const offer = await findOffer(initial.offerId, tx, true);
    const row = await findReservation(id, tx);
    const donor = body.actingAccountId === offer.ownerAccountId;
    const recipient = body.actingAccountId === row.requesterAccountId;
    if (!donor && !recipient) return missing();
    if ((target === 'accepted' && !donor) || (target === 'delivered' && !recipient))
      throw new PublicApiError(
        'forbidden',
        target === 'accepted'
          ? 'Only the donor can accept'
          : 'Only the recipient can confirm receipt',
      );
    const [replay] = await tx
      .select({ status: events.status })
      .from(events)
      .where(
        and(
          eq(events.reservationId, id),
          eq(events.actingAccountId, body.actingAccountId),
          eq(events.idempotencyKey, body.idempotencyKey),
        ),
      );
    if (replay) {
      if (replay.status !== target)
        conflict('This idempotency key was used for a different action');
      return projectReservation(row, offer);
    }
    if (row.status === target) {
      await tx.insert(events).values({
        reservationId: id,
        actingAccountId: body.actingAccountId,
        actorAccountId: actor,
        status: target,
        idempotencyKey: body.idempotencyKey,
      });
      return projectReservation(row, offer);
    }
    if (target === 'accepted') {
      if (row.status !== 'requested' || offer.status !== 'active')
        conflict('This request cannot be accepted');
      const [totals] = await projectOffers([offer], tx);
      if (totals.availableQuantity < row.quantity)
        conflict('There are not enough unreserved units');
    } else if (target === 'delivered') {
      if (row.status !== 'accepted') conflict('Only an accepted reservation can be received');
    } else if (row.status !== 'requested' && row.status !== 'accepted')
      conflict('A received donation cannot be cancelled');
    const [updated] = await tx
      .update(reservations)
      .set({ status: target, updatedAt: new Date() })
      .where(eq(reservations.id, id))
      .returning(reservationColumns);
    await tx.insert(events).values({
      reservationId: id,
      actingAccountId: body.actingAccountId,
      actorAccountId: actor,
      status: target,
      idempotencyKey: body.idempotencyKey,
    });
    return projectReservation(updated, offer);
  });
}
export async function getMaterialReservation(
  caller: StoreCaller | null,
  id: string,
  accountId: string,
) {
  await authorize(caller, accountId);
  const row = await findReservation(id, getDb());
  const offer = await findOffer(row.offerId, getDb());
  if (row.requesterAccountId !== accountId && offer.ownerAccountId !== accountId) return missing();
  return projectReservation(row, offer);
}

const cursorSchema = z.strictObject({
  v: z.literal(1),
  fingerprint: z.string(),
  last: z.string().min(1).max(200),
});
function after(raw: string | undefined, fingerprint: string): string | undefined {
  if (!raw) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const value = cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    if (value.fingerprint !== fingerprint) throw new Error();
    return value.last;
  } catch {
    throw new PublicApiError('bad_request', 'This cursor belongs to another materials list');
  }
}
function next(rows: { id: string }[], limit: number, fingerprint: string) {
  return rows.length > limit
    ? Buffer.from(JSON.stringify({ v: 1, fingerprint, last: rows[limit - 1].id })).toString(
        'base64url',
      )
    : null;
}
export async function listMaterialOffers(input: MaterialOfferQuery) {
  const query = check(MaterialOfferQuerySchema, {
    ...input,
    ...(input.limit === undefined ? {} : { limit: String(input.limit) }),
  });
  const limit = query.limit ?? 20;
  const fingerprint = publicCursorFingerprint('material-offers', {
    ownerAccountId: query.ownerAccountId,
  });
  const last = after(query.cursor, fingerprint);
  const rows = await getDb()
    .select(offerColumns)
    .from(offers)
    .where(
      and(
        eq(offers.status, 'active'),
        query.ownerAccountId ? eq(offers.ownerAccountId, query.ownerAccountId) : undefined,
        last ? lt(offers.id, last) : undefined,
      ),
    )
    .orderBy(desc(offers.id))
    .limit(limit + 1);
  return {
    items: await projectOffers(rows.slice(0, limit), getDb()),
    nextCursor: next(rows, limit, fingerprint),
  };
}
export async function listMaterialReservations(
  caller: StoreCaller | null,
  input: MaterialReservationQuery,
) {
  const query = check(MaterialReservationQuerySchema, {
    ...input,
    ...(input.limit === undefined ? {} : { limit: String(input.limit) }),
  });
  await authorize(caller, query.accountId);
  const limit = query.limit ?? 20;
  const fingerprint = publicCursorFingerprint('material-reservations', {
    accountId: query.accountId,
    status: query.status,
    offerId: query.offerId,
  });
  const last = after(query.cursor, fingerprint);
  const rows = await getDb()
    .select({ reservation: reservationColumns, offer: offerColumns })
    .from(reservations)
    .innerJoin(offers, eq(offers.id, reservations.offerId))
    .where(
      and(
        or(
          eq(reservations.requesterAccountId, query.accountId),
          eq(offers.ownerAccountId, query.accountId),
        ),
        query.status ? eq(reservations.status, query.status) : undefined,
        query.offerId ? eq(reservations.offerId, query.offerId) : undefined,
        last ? lt(reservations.id, last) : undefined,
      ),
    )
    .orderBy(desc(reservations.id))
    .limit(limit + 1);
  return {
    items: rows.slice(0, limit).map((row) => projectReservation(row.reservation, row.offer)),
    nextCursor: next(
      rows.map((row) => row.reservation),
      limit,
      fingerprint,
    ),
  };
}
