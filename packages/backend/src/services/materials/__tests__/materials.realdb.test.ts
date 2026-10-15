import { listPendingMaterialPickups } from '../pending-pickups.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { closePostgres, connectPostgres, type Database } from '../../../db/postgres.js';
import {
  materialOffers,
  materialReservations,
  materialReservationEvents,
} from '../../../db/schema/materials.js';
import {
  createMaterialOffer,
  getMaterialOffer,
  closeMaterialOffer,
  requestMaterial,
  transitionMaterialReservation,
  getMaterialReservation,
  listMaterialReservations,
  listMaterialOffers,
} from '../materials.service.js';
import type { StoreCaller } from '../../store-access.service.js';
import { readCallerAccountRole } from '../../oxy-account-graph.js';

vi.mock('../../oxy-account-graph.js', () => ({ readCallerAccountRole: vi.fn() }));
const RUN = uuidv7();
const person = (name: string): StoreCaller => ({
  accountId: `${RUN}_${name}`,
  actorAccountId: `${RUN}_${name}`,
  delegated: false,
  accessToken: 'test-bearer',
});
const donor = person('donor');
const receiver = person('receiver');
const other = person('other');
const ids: string[] = [];
let db: Database;
const key = () => uuidv7();
const action = (caller: StoreCaller, idempotencyKey = key()) => ({
  actingAccountId: caller.accountId,
  idempotencyKey,
});
async function offer(quantity = 10, caller = donor) {
  const result = await createMaterialOffer(caller, {
    ownerAccountId: caller.accountId,
    title: 'Surplus wood',
    description: 'Reusable boards',
    publicArea: 'North district',
    quantity,
    unit: 'boards',
    pickupInstructions: `PRIVATE_${RUN}_call_on_arrival`,
    idempotencyKey: key(),
  });
  ids.push(result.id);
  return result;
}
const reserve = (offerId: string, quantity: number, caller = receiver) =>
  requestMaterial(caller, offerId, {
    requesterAccountId: caller.accountId,
    quantity,
    idempotencyKey: key(),
  });
beforeAll(async () => {
  db = await connectPostgres();
});
afterAll(async () => {
  const rows = await db
    .select({ id: materialReservations.id })
    .from(materialReservations)
    .where(inArray(materialReservations.offerId, ids));
  if (rows.length)
    await db.delete(materialReservationEvents).where(
      inArray(
        materialReservationEvents.reservationId,
        rows.map((r) => r.id),
      ),
    );
  await db.delete(materialReservations).where(inArray(materialReservations.offerId, ids));
  await db.delete(materialOffers).where(inArray(materialOffers.id, ids));
  await closePostgres();
});

/** Observe THIS holder's recursive waiter chain; no timing race or global lock count. */
async function waitForTwo(holder: number) {
  for (let i = 0; i < 400; i++) {
    const rows = await db.execute<{ waiting: number }>(sql`with recursive blocked(pid) as (
      select a.pid from pg_stat_activity a where pg_blocking_pids(a.pid) @> array[${holder}]::int[]
      union select a.pid from pg_stat_activity a join blocked b on pg_blocking_pids(a.pid) @> array[b.pid]::int[]
    ) select count(*)::int as waiting from blocked`);
    if (rows[0].waiting >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Both reservation writers never queued behind the fixture offer lock');
}

describe('donated materials on real PostgreSQL', () => {
  it('serializes two competing acceptances, never oversubscribes, then releases on cancellation', async () => {
    const item = await offer(5);
    const a = await reserve(item.id, 4);
    const b = await reserve(item.id, 4, other);
    let ready!: (pid: number) => void;
    const locked = new Promise<number>((resolve) => {
      ready = resolve;
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx
        .select({ id: materialOffers.id })
        .from(materialOffers)
        .where(eq(materialOffers.id, item.id))
        .for('update');
      const pid = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      ready(pid[0].pid);
      await hold;
    });
    const pid = await locked;
    const aKey = action(donor);
    const bKey = action(donor);
    const results = Promise.allSettled([
      transitionMaterialReservation(donor, a.id, aKey, 'accepted'),
      transitionMaterialReservation(donor, b.id, bKey, 'accepted'),
    ]);
    try {
      await waitForTwo(pid);
    } finally {
      release();
      await holder;
    }
    const outcomes = await results;
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(outcomes.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'conflict' },
    });
    expect(await getMaterialOffer(item.id)).toMatchObject({
      quantity: 5,
      availableQuantity: 1,
      committedQuantity: 4,
      receivedQuantity: 0,
    });
    const winner = outcomes[0].status === 'fulfilled' ? a : b;
    const winnerAccount = winner.id === a.id ? receiver : other;
    const cancel = action(winnerAccount);
    await transitionMaterialReservation(winnerAccount, winner.id, cancel, 'cancelled');
    await transitionMaterialReservation(winnerAccount, winner.id, cancel, 'cancelled');
    expect(await getMaterialOffer(item.id)).toMatchObject({
      availableQuantity: 5,
      committedQuantity: 0,
      receivedQuantity: 0,
    });
    expect(
      await getMaterialReservation(winnerAccount, winner.id, winnerAccount.accountId),
    ).toMatchObject({ status: 'cancelled', pickupInstructions: null });
    const replay = await transitionMaterialReservation(
      donor,
      winner.id,
      winner.id === a.id ? aKey : bKey,
      'accepted',
    );
    expect(replay.status).toBe('cancelled');
    const loser = winner.id === a.id ? b : a;
    await transitionMaterialReservation(donor, loser.id, action(donor), 'accepted');
    expect((await getMaterialOffer(item.id)).availableQuantity).toBe(1);
  });

  it('only the recipient confirms receipt; retry and concurrent confirmations do not double count', async () => {
    const item = await offer(7);
    const row = await reserve(item.id, 3);
    expect(row.pickupInstructions).toBeNull();
    expect(JSON.stringify(await getMaterialOffer(item.id))).not.toContain('PRIVATE_');
    const acceptKey = action(donor);
    const accepted = await transitionMaterialReservation(donor, row.id, acceptKey, 'accepted');
    expect(accepted.pickupInstructions).toContain('PRIVATE_');
    const noOpKey = action(donor);
    await transitionMaterialReservation(donor, row.id, noOpKey, 'accepted');
    await expect(
      transitionMaterialReservation(donor, row.id, noOpKey, 'cancelled'),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      transitionMaterialReservation(receiver, row.id, action(receiver), 'accepted'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      transitionMaterialReservation(donor, row.id, action(donor), 'delivered'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const receiptKey = action(receiver);
    const [first, second] = await Promise.all([
      transitionMaterialReservation(receiver, row.id, receiptKey, 'delivered'),
      transitionMaterialReservation(receiver, row.id, receiptKey, 'delivered'),
    ]);
    expect(first.status).toBe('delivered');
    expect(second.status).toBe('delivered');
    expect(await getMaterialOffer(item.id)).toMatchObject({
      availableQuantity: 4,
      committedQuantity: 0,
      receivedQuantity: 3,
    });
    const receivedEvents = await db
      .select({ id: materialReservationEvents.id })
      .from(materialReservationEvents)
      .where(
        and(
          eq(materialReservationEvents.reservationId, row.id),
          eq(materialReservationEvents.status, 'delivered'),
        ),
      );
    expect(receivedEvents.length).toBeGreaterThan(0);
    expect(receivedEvents).toHaveLength(1);
    await expect(
      transitionMaterialReservation(receiver, row.id, action(receiver), 'cancelled'),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      transitionMaterialReservation(donor, row.id, acceptKey, 'cancelled'),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('reuses creation keys after lost responses and refuses changed quantities or owners', async () => {
    const input = {
      ownerAccountId: donor.accountId,
      title: 'Bricks',
      description: '',
      publicArea: 'East',
      quantity: 12,
      unit: 'bricks',
      pickupInstructions: 'Ring bell',
      idempotencyKey: key(),
    };
    const [first, replay] = await Promise.all([
      createMaterialOffer(donor, input),
      createMaterialOffer(donor, input),
    ]);
    ids.push(first.id);
    expect(replay.id).toBe(first.id);
    await expect(createMaterialOffer(donor, { ...input, quantity: 13 })).rejects.toMatchObject({
      code: 'conflict',
    });
    const request = { requesterAccountId: receiver.accountId, quantity: 3, idempotencyKey: key() };
    const [a, b] = await Promise.all([
      requestMaterial(receiver, first.id, request),
      requestMaterial(receiver, first.id, request),
    ]);
    expect(a.id).toBe(b.id);
    await expect(
      requestMaterial(receiver, first.id, { ...request, quantity: 4 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    vi.mocked(readCallerAccountRole).mockResolvedValue(null);
    await expect(createMaterialOffer(other, input)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(getMaterialReservation(other, a.id, other.accountId)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(reserve(first.id, 1, donor)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('checks delegated organization membership fresh, blocks revoked members and fails closed on Oxy outages', async () => {
    const org: StoreCaller = {
      ...person('organization'),
      actorAccountId: donor.accountId,
      delegated: true,
    };
    vi.mocked(readCallerAccountRole).mockResolvedValue('editor');
    const item = await offer(8, org);
    const row = await reserve(item.id, 2);
    await transitionMaterialReservation(org, row.id, action(org), 'accepted');
    expect(readCallerAccountRole).toHaveBeenLastCalledWith(org.accessToken, org.accountId);
    vi.mocked(readCallerAccountRole).mockResolvedValue(null);
    await expect(
      transitionMaterialReservation(org, row.id, action(org), 'cancelled'),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(getMaterialReservation(org, row.id, org.accountId)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(listMaterialReservations(org, { accountId: org.accountId })).rejects.toMatchObject(
      { code: 'forbidden' },
    );
    vi.mocked(readCallerAccountRole).mockResolvedValue('viewer');
    await expect(closeMaterialOffer(org, item.id, action(org))).rejects.toMatchObject({
      code: 'forbidden',
    });
    vi.mocked(readCallerAccountRole).mockRejectedValue(new Error('Oxy unavailable'));
    await expect(getMaterialReservation(org, row.id, org.accountId)).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    vi.mocked(readCallerAccountRole).mockResolvedValue('admin');
    await transitionMaterialReservation(org, row.id, action(org), 'cancelled');
    expect((await getMaterialOffer(item.id)).committedQuantity).toBe(0);
  });

  it('supports organization recipients and filters accepted pickups for SDK consumers', async () => {
    const org: StoreCaller = {
      ...person('receiving_org'),
      actorAccountId: receiver.accountId,
      delegated: true,
    };
    vi.mocked(readCallerAccountRole).mockResolvedValue('admin');
    const item = await offer();
    const row = await reserve(item.id, 2, org);
    await transitionMaterialReservation(donor, row.id, action(donor), 'accepted');
    const page = await listMaterialReservations(org, {
      accountId: org.accountId,
      status: 'accepted',
    });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.map((item) => item.id)).toContain(row.id);
    await transitionMaterialReservation(org, row.id, action(org), 'delivered');
    expect(
      (await listMaterialReservations(org, { accountId: org.accountId, status: 'accepted' })).items,
    ).toHaveLength(0);
  });

  it('closes new requests but preserves accepted pickup; keyset cursors are scope-bound', async () => {
    const item = await offer();
    const accepted = await reserve(item.id, 2);
    const pending = await reserve(item.id, 3, other);
    await transitionMaterialReservation(donor, accepted.id, action(donor), 'accepted');
    await closeMaterialOffer(donor, item.id, action(donor));
    await expect(reserve(item.id, 1)).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      transitionMaterialReservation(donor, pending.id, action(donor), 'accepted'),
    ).rejects.toMatchObject({ code: 'conflict' });
    await transitionMaterialReservation(receiver, accepted.id, action(receiver), 'delivered');
    await offer();
    await offer();
    const page = await listMaterialOffers({ ownerAccountId: donor.accountId, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const second = await listMaterialOffers({
      ownerAccountId: donor.accountId,
      limit: 1,
      cursor: page.nextCursor!,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0].id).not.toBe(page.items[0].id);
    await expect(
      listMaterialOffers({ ownerAccountId: receiver.accountId, cursor: page.nextCursor! }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    const privatePage = await listMaterialReservations(donor, {
      accountId: donor.accountId,
      limit: 1,
    });
    expect(privatePage.nextCursor).not.toBeNull();
    await expect(
      listMaterialReservations(donor, {
        accountId: donor.accountId,
        status: 'accepted',
        cursor: privatePage.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('agent pickup projection', () => {
  it('reads only accepted own reservations, keeps transport references and omits private location', async () => {
    const outsider = person('projection-outsider');
    const source = await offer(10);
    const accepted = await reserve(source.id, 1);
    const acceptedSecond = await reserve(source.id, 1);
    await transitionMaterialReservation(donor, acceptedSecond.id, action(donor), 'accepted');
    const delivered = await reserve(source.id, 1);
    const cancelled = await reserve(source.id, 1);
    await reserve(source.id, 1);
    await transitionMaterialReservation(donor, accepted.id, action(donor), 'accepted');
    await transitionMaterialReservation(donor, delivered.id, action(donor), 'accepted');
    await transitionMaterialReservation(receiver, delivered.id, action(receiver), 'delivered');
    await transitionMaterialReservation(receiver, cancelled.id, action(receiver), 'cancelled');
    await db
      .update(materialReservations)
      .set({ moovoTransportId: 'transport-ref-only' })
      .where(eq(materialReservations.id, accepted.id));
    const pending = await listPendingMaterialPickups(donor.accountId, { limit: 100 });
    expect(pending.items.some((row) => row.reservationId === accepted.id)).toBe(true);
    expect(
      pending.items.some(
        (row) => row.reservationId === delivered.id || row.reservationId === cancelled.id,
      ),
    ).toBe(false);
    expect(pending.items.find((row) => row.reservationId === accepted.id)?.moovoTransportId).toBe(
      'transport-ref-only',
    );
    expect(JSON.stringify(pending)).not.toContain(`PRIVATE_${RUN}`);
    expect(
      (await listPendingMaterialPickups(outsider.accountId, { limit: 100 })).items,
    ).toHaveLength(0);
    const page = await listPendingMaterialPickups(donor.accountId, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    if (!page.nextCursor) throw new Error('Expected more than one pending pickup');
    await expect(
      listPendingMaterialPickups(outsider.accountId, { limit: 1, cursor: page.nextCursor }),
    ).rejects.toThrow('cursor');
  });
});
