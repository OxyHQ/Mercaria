/**
 * The supplier webhook ingress, against the REAL middleware chain and a REAL
 * Postgres database.
 *
 * `createApp()` builds the actual chain production runs, which is what makes
 * the raw-body invariant assertable rather than a comment: this is the FOURTH
 * router that must be mounted before `express.json()`, and a later reorder has
 * to fail CI rather than production.
 *
 * The vacuity guard is the second half and is the reason this file exists at
 * all: a delivery that verifies through `createApp()` proves the mount is
 * right ONLY if the same delivery through a json-parsed copy of the same router
 * fails. Without that, a verification that happened to ignore the body would
 * pass both ways and the assertion would be measuring nothing.
 *
 * ## What is deliberately NOT asserted here
 *
 * Whether the event was PROCESSED. A 200 means stored (#124 polling and
 * webhooks 2), and the interpretation is a separate leased act with its own
 * coverage in the conformance suite.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Database } from '../../db/postgres.js';

const CREDENTIAL = 'supplier-webhook-shared-secret';

const servers: Server[] = [];

let createApp: typeof import('../../app.js').createApp;
let supplierWebhookRouter: typeof import('../supplier-webhook.js').default;
let db: Database;
let closePostgres: typeof import('../../db/postgres.js').closePostgres;
let supplierProviderEvents: typeof import('../../db/schema/supplierOrders.js').supplierProviderEvents;
let supplierAccountId: string;

/**
 * Everything is imported AFTER the environment is set.
 *
 * `config/index.ts` reads `process.env` once at module load and freezes the
 * result. A static import would evaluate it before `beforeAll` ran.
 */
beforeAll(async () => {
  process.env.PROCUREMENT_FAKE_ADAPTER_ENABLED = 'true';

  ({ createApp } = await import('../../app.js'));
  supplierWebhookRouter = (await import('../supplier-webhook.js')).default;
  const postgres = await import('../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();
  ({ supplierProviderEvents } = await import('../../db/schema/supplierOrders.js'));

  const { registerFakeOrderAdapter } = await import(
    '../../services/supplier-orders/fake-adapter-registration.js'
  );
  registerFakeOrderAdapter();
  const { registerSupplierCredentialReader } = await import(
    '../../services/supplier-orders/credential.port.js'
  );
  registerSupplierCredentialReader(async () => await Promise.resolve(CREDENTIAL));

  const { createSupplier } = await import('../../db/procurement/supplierRepository.js');
  const { createSupplierAccount, setAccountCredential, transitionAccountState } = await import(
    '../../db/procurement/supplierAccountRepository.js'
  );
  const { FAKE_ORDER_PROVIDER } = await import(
    '../../services/supplier-orders/adapters/fake-order-adapter.js'
  );
  const suffix = uuidv7();
  const supplier = await createSupplier({
    supplierType: 'dropship_distributor',
    canonicalName: `Webhook supplier ${suffix}`,
  });
  const account = await createSupplierAccount({
    supplierId: supplier.id,
    provider: FAKE_ORDER_PROVIDER,
    environment: 'test',
    providerAccountId: `acct-${suffix}`,
  });
  await setAccountCredential({
    accountId: account.id,
    credentialReference: `/oxy/mercaria/suppliers/${suffix}`,
    status: 'valid',
  });
  await transitionAccountState({ accountId: account.id, expected: 'inactive', next: 'active' });
  supplierAccountId = account.id;
}, 120_000);

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await closePostgres();
});

function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

/** A delivery the fake adapter's shared-secret verification accepts. */
function delivery(overrides: { eventId?: string; secret?: string; status?: string } = {}): string {
  return JSON.stringify({
    secret: overrides.secret ?? CREDENTIAL,
    eventId: overrides.eventId ?? `evt-${uuidv7()}`,
    clientReference: 'mercaria-po-not-a-real-order',
    externalOrderId: 'ord-1',
    status: overrides.status ?? 'CONFIRMED',
    observedAt: new Date().toISOString(),
  });
}

/** The stored rows for one provider event id — scoped, never a table-wide count. */
async function storedEvents(providerEventId: string) {
  return await db
    .select()
    .from(supplierProviderEvents)
    .where(eq(supplierProviderEvents.providerEventId, providerEventId));
}

describe('the supplier webhook ingress', () => {
  it('verifies a delivery through the REAL chain and STORES it', async () => {
    const base = await listen(createApp());
    const eventId = `evt-${uuidv7()}`;
    const response = await fetch(`${base}/webhooks/suppliers/${supplierAccountId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: delivery({ eventId }),
    });
    expect(response.status).toBe(200);
    expect(await storedEvents(eventId)).toHaveLength(1);
  });

  it('a json-parsed copy of the same router FAILS — the vacuity guard', async () => {
    // Without this, the case above would pass even for a verification that
    // ignored the body entirely, and the mount assertion would be measuring
    // nothing. The fake adapter reads the RAW bytes, so a parser reaching the
    // stream first leaves it an object rather than a Buffer.
    const app = express();
    app.use(express.json());
    app.use('/webhooks/suppliers', supplierWebhookRouter);
    const base = await listen(app);

    const eventId = `evt-${uuidv7()}`;
    const response = await fetch(`${base}/webhooks/suppliers/${supplierAccountId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: delivery({ eventId }),
    });
    expect(response.status).toBe(401);
    expect(await storedEvents(eventId)).toHaveLength(0);
  });

  it('refuses a wrong secret with 401 and stores NOTHING', async () => {
    // An unverified callback has no row shape at all — it cannot be stored now
    // and applied later by a sweep that never re-checked.
    const base = await listen(createApp());
    const eventId = `evt-${uuidv7()}`;
    const response = await fetch(`${base}/webhooks/suppliers/${supplierAccountId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: delivery({ eventId, secret: 'not-the-secret' }),
    });
    expect(response.status).toBe(401);
    expect(await storedEvents(eventId)).toHaveLength(0);
  });

  it('answers an unknown account the SAME way as an unverifiable delivery', async () => {
    // A distinguishable response would let a caller enumerate which account ids
    // exist, which is a supplier learning about Mercaria's other suppliers.
    const base = await listen(createApp());
    const response = await fetch(`${base}/webhooks/suppliers/not-an-account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: delivery(),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ success: false, error: 'unverified' });
  });

  it('answers 200 to a REDELIVERY and stores one row', async () => {
    // A supplier retrying a delivery Mercaria already has must be told to stop;
    // any other answer makes it retry forever.
    const base = await listen(createApp());
    const eventId = `evt-${uuidv7()}`;
    const body = delivery({ eventId });
    const first = await fetch(`${base}/webhooks/suppliers/${supplierAccountId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const second = await fetch(`${base}/webhooks/suppliers/${supplierAccountId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await storedEvents(eventId)).toHaveLength(1);
  });
});
