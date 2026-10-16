import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { createMercariaClient } from '@mercaria.co/sdk';
import { closePostgres, connectPostgres, type Database } from '../../db/postgres.js';
import {
  materialOffers,
  materialReservations,
  materialReservationEvents,
} from '../../db/schema/materials.js';

const auth = vi.hoisted(() => ({ tokens: new Map<string, string>() }));
vi.mock('../../middleware/auth.js', () => ({
  oxyClient: {
    middleware: {
      auth: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
        next(),
    },
    assets: { publicUrl: (id: string) => `https://media.test.invalid/${id}` },
  },
  authenticateToken: (_req: express.Request, res: express.Response) => res.sendStatus(401),
  optionalAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const account = auth.tokens.get(req.headers.authorization ?? '');
    if (account)
      Object.assign(req, {
        userId: account,
        accessToken: req.headers.authorization?.slice(7),
        user: { id: account },
        oxyActor: { actorAccountId: account, effectiveAccountId: account, delegated: false },
      });
    next();
  },
}));

const RUN = uuidv7();
const donorId = `${RUN}_donor`;
const recipientId = `${RUN}_recipient`;
let db: Database;
let server: Server;
let base: string;
const offers: string[] = [];
beforeAll(async () => {
  db = await connectPostgres();
  const { createApp } = await import('../../app.js');
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  auth.tokens.set('Bearer donor-token', donorId);
  auth.tokens.set('Bearer recipient-token', recipientId);
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  const rows = await db
    .select({ id: materialReservations.id })
    .from(materialReservations)
    .where(inArray(materialReservations.offerId, offers));
  if (rows.length)
    await db.delete(materialReservationEvents).where(
      inArray(
        materialReservationEvents.reservationId,
        rows.map((r) => r.id),
      ),
    );
  await db.delete(materialReservations).where(inArray(materialReservations.offerId, offers));
  await db.delete(materialOffers).where(inArray(materialOffers.id, offers));
  await closePostgres();
});

describe('materials SDK through the real HTTP middleware and PostgreSQL', () => {
  it('verifies Moovo ownership through its SDK and stores only the reference, including after donation cancellation', async () => {
    const jwt = `e30.${Buffer.from(JSON.stringify({ sub: donorId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test-signature`;
    auth.tokens.set(`Bearer ${jwt}`, donorId);
    const donor = createMercariaClient({ apiBaseUrl: base, getAccessToken: () => jwt }).materials;
    const recipient = createMercariaClient({
      apiBaseUrl: base,
      getAccessToken: () => 'recipient-token',
    }).materials;
    const offer = await donor.createOffer({
      ownerAccountId: donorId,
      title: 'Spare material',
      description: 'Free',
      publicArea: 'West',
      quantity: 4,
      unit: 'pieces',
      pickupInstructions: 'Private collection notes',
      idempotencyKey: uuidv7(),
    });
    offers.push(offer.id);
    const reservation = await recipient.request(offer.id, {
      requesterAccountId: recipientId,
      quantity: 2,
      idempotencyKey: uuidv7(),
    });
    await donor.accept(reservation.id, { actingAccountId: donorId, idempotencyKey: uuidv7() });
    const endpoint = {
      address: { line1: 'Moovo-only address', city: 'Test', postalCode: '08001', country: 'ES' },
      latitude: 41,
      longitude: 2,
      contactName: 'Test',
      contactPhone: '+34000000000',
    };
    const transport = {
      id: 'moovo-opaque-reference',
      reservationId: reservation.id,
      requestingAccountId: donorId,
      payerAccountId: recipientId,
      status: 'quoted',
      pickup: endpoint,
      dropoff: endpoint,
      parcel: { weightKg: 2, pieces: 1, sizeClass: 'small' },
      itemDescription: 'Shipment snapshot',
      quotes: [
        {
          id: 'quote',
          amountMinor: 1234,
          currency: 'FAIR',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          fulfillment: 'moovo_courier',
        },
      ],
      authorization: null,
      jobId: null,
      jobStatus: null,
      paymentStatus: 'pending',
      paymentCollectionAvailable: false,
      createdAt: new Date().toISOString(),
    };
    const methods: string[] = [];
    const moovoApp = express();
    moovoApp.use((req, res) => {
      methods.push(req.method);
      expect(req.headers.authorization).toBe(`Bearer ${jwt}`);
      res.json(
        req.path.endsWith('/wrong-reservation')
          ? { ...transport, reservationId: 'other' }
          : transport,
      );
    });
    const moovoServer = moovoApp.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => moovoServer.once('listening', resolve));
    process.env.MOOVO_API_URL = `http://127.0.0.1:${(moovoServer.address() as AddressInfo).port}`;
    try {
      await expect(
        donor.linkTransport(reservation.id, {
          actingAccountId: donorId,
          transportId: 'wrong-reservation',
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      const linked = await donor.linkTransport(reservation.id, {
        actingAccountId: donorId,
        transportId: transport.id,
      });
      expect(linked.moovoTransportId).toBe(transport.id);
      expect(
        (
          await donor.linkTransport(reservation.id, {
            actingAccountId: donorId,
            transportId: transport.id,
          })
        ).moovoTransportId,
      ).toBe(transport.id);
      const [stored] = await db
        .select()
        .from(materialReservations)
        .where(eq(materialReservations.id, reservation.id));
      expect(stored.moovoTransportId).toBe(transport.id);
      expect(JSON.stringify(stored)).not.toContain('Moovo-only');
      expect(stored).not.toHaveProperty('amountMinor');
      expect(stored).not.toHaveProperty('transportStatus');
      const cancelled = await donor.cancel(reservation.id, {
        actingAccountId: donorId,
        idempotencyKey: uuidv7(),
      });
      expect(cancelled).toMatchObject({
        moovoTransportId: transport.id,
        pickupInstructions: null,
        status: 'cancelled',
      });
      expect(methods.every((method) => method === 'GET')).toBe(true);
    } finally {
      await new Promise<void>((resolve) => moovoServer.close(() => resolve()));
      delete process.env.MOOVO_API_URL;
    }
  });

  it('creates, lists, accepts and confirms receipt with refreshed authority and replay-safe responses', async () => {
    let token = 'donor-token';
    const getter = vi.fn(() => token);
    const client = createMercariaClient({ apiBaseUrl: base, getAccessToken: getter }).materials;
    const body = {
      ownerAccountId: donorId,
      title: 'Reclaimed boards',
      description: 'Free, reusable wood',
      publicArea: 'West district',
      quantity: 9,
      unit: 'boards',
      pickupInstructions: 'PRIVATE_COLLECTION_SENTINEL',
      idempotencyKey: uuidv7(),
    };
    const offered = await client.createOffer(body);
    offers.push(offered.id);
    expect((await client.createOffer(body)).id).toBe(offered.id);
    expect(JSON.stringify(offered)).not.toContain('PRIVATE_COLLECTION');
    const publicResponse = await fetch(`${base}/public/v1/materials/offers/${offered.id}`);
    expect(publicResponse.headers.get('cache-control')).toBe('no-store');
    token = 'recipient-token';
    const requested = await client.request(offered.id, {
      requesterAccountId: recipientId,
      quantity: 4,
      idempotencyKey: uuidv7(),
    });
    expect(requested).toMatchObject({ status: 'requested', pickupInstructions: null });
    await expect(
      client.accept(requested.id, { actingAccountId: recipientId, idempotencyKey: uuidv7() }),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    token = 'donor-token';
    await client.accept(requested.id, { actingAccountId: donorId, idempotencyKey: uuidv7() });
    expect(await client.getOffer(offered.id)).toMatchObject({
      availableQuantity: 5,
      committedQuantity: 4,
      receivedQuantity: 0,
    });
    token = 'recipient-token';
    const accepted = await client.getReservation(requested.id, recipientId);
    expect(accepted.pickupInstructions).toBe('PRIVATE_COLLECTION_SENTINEL');
    const pages = [];
    for await (const page of client.iterateReservations({
      accountId: recipientId,
      status: 'accepted',
      limit: 1,
    }))
      pages.push(...page.items);
    expect(pages.map((row) => row.id)).toContain(requested.id);
    const receipt = { actingAccountId: recipientId, idempotencyKey: uuidv7() };
    expect((await client.confirmDelivery(requested.id, receipt)).status).toBe('delivered');
    expect((await client.confirmDelivery(requested.id, receipt)).status).toBe('delivered');
    expect(await client.getOffer(offered.id)).toMatchObject({
      availableQuantity: 5,
      committedQuantity: 0,
      receivedQuantity: 4,
    });
    expect(getter.mock.calls.length).toBeGreaterThan(10);
    token = 'donor-token';
    await client.closeOffer(offered.id, { actingAccountId: donorId, idempotencyKey: uuidv7() });
    expect(
      (await client.listOffers({ ownerAccountId: donorId })).items.map((row) => row.id),
    ).not.toContain(offered.id);
    const saved = await db
      .select({ id: materialOffers.id })
      .from(materialOffers)
      .where(eq(materialOffers.id, offered.id));
    expect(saved.length).toBeGreaterThan(0);
    expect(saved).toHaveLength(1);
  });

  it('keeps the error contract, strict bodies, unauthenticated refusal and materials-only write CORS', async () => {
    const root = `${base}/public/v1`;
    const missing = await fetch(`${root}/materials/reservations?accountId=${donorId}`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: { code: 'unauthorized' } });
    const invalid = await fetch(`${root}/materials/offers`, {
      method: 'POST',
      headers: { Authorization: 'Bearer donor-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerAccountId: donorId, price: 100 }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'bad_request' } });
    const malformed = await fetch(`${root}/materials/offers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: 'bad_request' } });
    const cors = await fetch(`${root}/materials/offers`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://alia.onl',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization,Content-Type',
      },
    });
    expect(cors.status).toBe(204);
    expect(cors.headers.get('access-control-allow-origin')).toBe('*');
    expect(cors.headers.get('access-control-allow-methods')).toContain('POST');
    expect(cors.headers.get('access-control-allow-credentials')).toBeNull();
    const catalogCors = await fetch(`${root}/products`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://alia.onl', 'Access-Control-Request-Method': 'POST' },
    });
    expect(catalogCors.headers.get('access-control-allow-methods')).not.toContain('POST');
    const document = await (await fetch(`${root}/openapi.json`)).json();
    expect(document).toHaveProperty(['paths', '/materials/offers', 'post', 'responses', '201']);
    expect(document).toHaveProperty(
      ['paths', '/materials/offers', 'post', 'security'],
      [{ oxyBearer: [] }],
    );
    expect(document).toHaveProperty(
      ['paths', '/materials/offers', 'post', 'requestBody', 'required'],
      true,
    );
  });
});
