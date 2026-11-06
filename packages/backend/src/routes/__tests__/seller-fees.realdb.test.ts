/**
 * `/seller/fees/{schedule,accept}` — a private (P2P) seller's marketplace fee
 * terms (ADR 0018 D3) — over HTTP against a real database.
 *
 * What it proves is the property the surface exists for: a person's acceptance
 * is the SAME `fee_schedule_acceptances` row (`owner_type = 'user'`) the
 * checkout gate reads, so accepting here is what lets their card sale through,
 * and a store's terms are never what a person is shown or accepts.
 *
 * ## Scoping, because this database is SHARED
 *
 * An ACTIVE `user`-scoped schedule would reach every private seller in every
 * sibling file, so the schedules here are scoped to ZAR, which no other realdb
 * suite prices in, and the card rail's currencies are stubbed to ZAR for this
 * file only. Each case's seller id is unique to the run.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { uuidv7 } from '@oxy.so/db';

let currentUser = `p2p-fees-${uuidv7()}`;

vi.mock('@oxy.so/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxy.so/core/server')>()),
  getRequiredOxyUserId: () => currentUser,
}));
vi.mock('../../middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../middleware/auth.js')>()),
  authenticateToken: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    next();
  },
}));
vi.mock('../../lib/rate-limit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/rate-limit.js')>()),
  makeRateLimiter:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => {
      next();
    },
}));
vi.mock('../../services/payments/native-rail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/payments/native-rail.js')>()),
  nativeRailPresentmentCurrencies: () => ['ZAR'],
}));
vi.mock('../../services/oxy-user.service.js', () => ({
  getProfiles: async () => new Map(),
}));

const { connectPostgres, closePostgres } = await import('../../db/postgres.js');
const fees = await import('../../db/fees/feeScheduleRepository.js');
const { assertSellerGroupsActivated } = await import(
  '../../services/merchant-activation/checkout-gate.js'
);
const { findApplicableSellerSchedule } = await import('../../services/fees/order-fees.service.js');
const { default: sellerRouter } = await import('../seller.js');

const db = await connectPostgres();
let server: Server;
let base: string;

async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? {} : JSON.parse(text) };
}

async function activeSchedule(sellerType: 'store' | 'user') {
  const row = await fees.insertFeeSchedule(db, {
    scheduleKey: `p2p-fees-${sellerType}-${uuidv7()}`,
    version: 1,
    name: `Test ${sellerType} schedule`,
    merchantSummary: 'The words a seller accepts.',
    effectiveStart: new Date('2026-01-01T00:00:00Z'),
    eligibleSellerType: sellerType,
    eligibleCurrency: 'ZAR',
    percentageBps: 500,
    termsVersion: `terms-${sellerType}-${uuidv7()}`,
    draftedBy: { authority: 'deployment', ref: 'test' },
  });
  const active = await fees.activateFeeSchedule(db, {
    id: row.id,
    approvedBy: { authority: 'deployment', ref: 'test' },
  });
  if (!active) throw new Error('could not activate the test schedule');
  return active;
}

let userSchedule: Awaited<ReturnType<typeof activeSchedule>>;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/seller', sellerRouter);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  // A store schedule beside the private sellers' one: a person must never be
  // shown it, or accept it.
  await activeSchedule('store');
  userSchedule = await activeSchedule('user');
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});

describe('a private seller’s fee terms (ADR 0018 D3)', () => {
  it('shows the private sellers’ schedule as pending, never the store one', async () => {
    currentUser = `p2p-fees-${uuidv7()}`;
    const response = await call('GET', '/seller/fees/schedule');
    expect(response.status).toBe(200);
    const view = response.body.data as { schedule?: Record<string, unknown>; acceptance?: unknown };
    expect(view.schedule?.scheduleKey).toBe(userSchedule.scheduleKey);
    expect(view.schedule?.eligibleSellerType).toBe('user');
    expect(view.schedule?.merchantSummary).toBe('The words a seller accepts.');
    expect(view.acceptance).toBeUndefined();
  });

  it('records the acceptance the checkout gate reads, once however often it is sent', async () => {
    const seller = `p2p-fees-${uuidv7()}`;
    currentUser = seller;
    const sellerKey = `user:${seller}`;
    const feeSchedule = { scheduleKey: userSchedule.scheduleKey, version: userSchedule.version };

    await expect(assertSellerGroupsActivated([{ sellerKey, feeSchedule }])).rejects.toMatchObject({
      reason: 'seller_not_activated',
    });

    const echo = {
      scheduleKey: userSchedule.scheduleKey,
      version: userSchedule.version,
      termsVersion: userSchedule.termsVersion,
    };
    const first = await call('POST', '/seller/fees/accept', echo);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data).toMatchObject({
      scheduleKey: userSchedule.scheduleKey,
      termsVersion: userSchedule.termsVersion,
      acceptedByOxyUserId: seller,
    });
    const replay = await call('POST', '/seller/fees/accept', echo);
    expect(replay.status).toBe(200);

    const row = await fees.findFeeScheduleAcceptance(db, {
      ownerType: 'user',
      ownerId: seller,
      scheduleKey: userSchedule.scheduleKey,
      scheduleVersion: userSchedule.version,
    });
    expect(row?.termsVersion).toBe(userSchedule.termsVersion);
    await expect(
      assertSellerGroupsActivated([{ sellerKey, feeSchedule }]),
    ).resolves.toBeUndefined();

    const view = (await call('GET', '/seller/fees/schedule')).body.data as {
      acceptance?: Record<string, unknown>;
    };
    expect(view.acceptance?.termsVersion).toBe(userSchedule.termsVersion);
  });

  it('refuses a stale or foreign echo with a conflict, recording nothing', async () => {
    const seller = `p2p-fees-${uuidv7()}`;
    currentUser = seller;
    const store = await findApplicableSellerSchedule({
      sellerType: 'store',
      saleCurrencies: ['ZAR'],
    });
    if (!store) throw new Error('the store schedule is not applicable');
    const foreign = await call('POST', '/seller/fees/accept', {
      scheduleKey: store.scheduleKey,
      version: store.version,
      termsVersion: store.termsVersion,
    });
    expect(foreign.status).toBe(409);
    const stale = await call('POST', '/seller/fees/accept', {
      scheduleKey: userSchedule.scheduleKey,
      version: userSchedule.version,
      termsVersion: 'an-older-text',
    });
    expect(stale.status).toBe(409);
    for (const schedule of [store, userSchedule]) {
      expect(
        await fees.findFeeScheduleAcceptance(db, {
          ownerType: 'user',
          ownerId: seller,
          scheduleKey: schedule.scheduleKey,
          scheduleVersion: schedule.version,
        }),
      ).toBeUndefined();
    }
  });

  it('refuses a body that smuggles a field into the audit record', async () => {
    currentUser = `p2p-fees-${uuidv7()}`;
    const response = await call('POST', '/seller/fees/accept', {
      scheduleKey: userSchedule.scheduleKey,
      version: userSchedule.version,
      termsVersion: userSchedule.termsVersion,
      ownerId: 'somebody-else',
    });
    expect(response.status).toBe(400);
  });
});
