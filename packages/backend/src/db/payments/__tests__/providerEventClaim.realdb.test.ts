/**
 * A drain claims only the rails it can interpret — against a REAL database.
 *
 * `claimProviderEvent` takes the OLDEST due row. That is unambiguous only while
 * one rail can write `payment_provider_events`, and the table is keyed by rail
 * precisely because that need not stay true: a claim is immediately followed by
 * the claimer handing the row to ITS OWN router, and a router reads an event's
 * TYPE, which says nothing about which rail sent it.
 *
 * The failure is silent and it destroys money. A drain claiming another rail's
 * `payment_intent.succeeded` would find a handler, ask ITS rail about an intent
 * that rail has never heard of, retry until the row dead-letters — while the
 * owning drain finds nothing left to do and the order is never funded.
 *
 * So the scope is asserted at the CLAIM, which is the only place every rail's
 * rows are visible at once, rather than trusted to each router noticing an
 * event that is not its own. Peable is the only rail with a drain today; the
 * other rail here is `mock`, a real `PaymentProviderId` the provider CHECK
 * admits, standing in for whichever rail is added next.
 *
 * No cleanup and no TRUNCATE: vitest runs files in parallel against one
 * throwaway database, so every id here is unique per run instead.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  claimProviderEvent,
  findProviderEventById,
  recordProviderEvent,
} from '../paymentRepository.js';
import type { Database } from '../../postgres.js';

/** Unique per run, so parallel files and repeated runs never collide. */
const RUN = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

const EXPIRES_AT = new Date(Date.now() + 86_400_000);

let db: Database;
let closePostgres: typeof import('../../postgres.js').closePostgres;

beforeAll(async () => {
  const postgres = await import('../../postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

async function store(
  provider: 'mock' | 'peable',
  name: string,
  type: string,
  receivedAt: Date,
): Promise<string> {
  const stored = await recordProviderEvent(db, {
    provider,
    providerEventId: `evt_${RUN}_${name}`,
    type,
    livemode: false,
    objectIds: {},
    payloadSummary: {},
    receivedAt,
    expiresAt: EXPIRES_AT,
  });
  return stored.row.id;
}

describe('claiming an inbound provider event', () => {
  it('never hands a Peable event to a drain that asked for another rail', async () => {
    // Deliberately OLDER than anything else, so an unscoped claim ordered by
    // `received_at` would reach for it first. That ordering is what makes the
    // bug reliable rather than occasional.
    const peableId = await store(
      'peable',
      'cross_steal',
      'payment_intent.succeeded',
      new Date(Date.now() - 3_600_000),
    );

    let claimed: string | undefined;
    // Drain a bounded number of times rather than once: another file could
    // have its own due rows on that rail, and this must not depend on being
    // the only writer. What it asserts is that the Peable row is never among
    // what a claim scoped to another rail returns.
    for (let index = 0; index < 25; index += 1) {
      const row = await claimProviderEvent(db, {
        leaseOwner: `mock-scope-${RUN}-${String(index)}`,
        leaseMs: 60_000,
        providers: ['mock'],
      });
      if (!row) break;
      if (row.id === peableId) {
        claimed = row.id;
        break;
      }
    }

    expect(claimed).toBeUndefined();

    // And it is still claimable BY ITS OWN RAIL — the scope must withhold the
    // row, not consume it. Without this half the test would also pass if the
    // claim had simply marked everything processed.
    const own = await claimProviderEvent(db, {
      leaseOwner: `peable-scope-${RUN}`,
      leaseMs: 60_000,
      providers: ['peable'],
      eventId: peableId,
    });
    expect(own?.id).toBe(peableId);
  });

  /**
   * The `eventId` path is the ingress's inline claim, and it is scoped too.
   *
   * It looks safe — the caller names one row it just wrote — but "the row I
   * just wrote" is exactly what a caller believes right up until an id is
   * threaded from somewhere else. Scoping it costs nothing and removes the
   * question.
   */
  it('refuses a named event that belongs to another rail', async () => {
    const peableId = await store('peable', 'named', 'payment_intent.payment_failed', new Date());

    const row = await claimProviderEvent(db, {
      leaseOwner: `mock-named-${RUN}`,
      leaseMs: 60_000,
      providers: ['mock'],
      eventId: peableId,
    });

    expect(row).toBeUndefined();
    // Untouched: still `received`, and its attempt counter never moved. A claim
    // that refused the row but had already incremented `attempts` would burn
    // the event's retry budget from a drain that was never entitled to it.
    const after = await findProviderEventById(db, peableId);
    expect(after?.status).toBe('received');
    expect(after?.attempts).toBe(0);
  });

  it('claims nothing at all for a caller that names no rail', async () => {
    await store('peable', 'empty_scope', 'payment_intent.succeeded', new Date());

    const row = await claimProviderEvent(db, {
      leaseOwner: `empty-${RUN}`,
      leaseMs: 60_000,
      providers: [],
    });

    // The dangerous reading of an empty list is "no filter, so every rail".
    expect(row).toBeUndefined();
  });
});
