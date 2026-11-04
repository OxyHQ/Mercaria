/**
 * The Oxy file-events webhook's raw-body guarantee, asserted against the REAL
 * app — the SIXTH raw-body mount, so the sixth file (`docs/house-invariants.md`,
 * "Raw-body mounts": the assertion is PER MOUNT).
 *
 * The bytes are signed the way OXY signs them — `oxy-signature: t=<unix>,
 * v1=<hex HMAC-SHA256 of "<t>.<raw body>">` — written out longhand here, never
 * through the verifier under test, so a change to either side is a failure
 * rather than a silent redefinition of the contract.
 *
 * An accepted delivery is positive evidence the handler read the raw bytes: a
 * parser that got there first leaves no Buffer, the handler verifies an empty
 * body, and the delivery is refused. The vacuity guard mounts the SAME router
 * behind `express.json()` and requires exactly that refusal.
 *
 * "Stored" is asserted against the real `oxy_file_events` table, scoped to this
 * file's own event ids (the database is shared by every realdb file).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { uuidv7 } from '@oxy.so/db';
import type { Database } from '../../db/postgres.js';

const SECRET = 'whsec_not_a_real_one';
const PATH = '/webhooks/oxy-files';
const RUN = uuidv7().slice(-12);

const servers: Server[] = [];
let createApp: typeof import('../../app.js').createApp;
let oxyFilesWebhookRouter: typeof import('../oxy-files-webhook.js').default;
let db: Database;
let closePostgres: typeof import('../../db/postgres.js').closePostgres;
let oxyFileEvents: typeof import('../../db/schema/oxyFiles.js').oxyFileEvents;

/**
 * Everything is imported AFTER the environment is set: `config` is read once
 * and frozen at module load, and `app.ts` decides the mount from it. A static
 * import would test a deployment with the route switched off — every request a
 * 404 and the raw-body assertion vacuous.
 */
beforeAll(async () => {
  process.env.OXY_FILE_EVENTS_ENABLED = 'true';
  process.env.OXY_FILE_EVENTS_SECRET = SECRET;
  ({ createApp } = await import('../../app.js'));
  oxyFilesWebhookRouter = (await import('../oxy-files-webhook.js')).default;
  const postgres = await import('../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();
  ({ oxyFileEvents } = await import('../../db/schema/oxyFiles.js'));
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

/** A file event body exactly as Oxy's `recordFileEvents` composes one. */
function eventBody(id: string, type = 'file.trashed'): string {
  return JSON.stringify({
    id,
    type,
    occurredAt: new Date().toISOString(),
    file: {
      id: `webhook-file-${RUN}`,
      ownerKind: 'account',
      visibility: 'public',
      status: 'trash',
    },
    references: [],
  });
}

/** Sign longhand, the way Oxy signs. */
function sign(payload: string, secret = SECRET, timestamp?: number): string {
  const t = timestamp ?? Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
}

async function post(base: string, payload: string, signature?: string) {
  const response = await fetch(`${base}${PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(signature === undefined ? {} : { 'oxy-signature': signature }),
    },
    body: payload,
  });
  return { status: response.status, body: await response.text() };
}

async function stored(eventId: string) {
  return db.select().from(oxyFileEvents).where(eq(oxyFileEvents.eventId, eventId));
}

describe('Oxy file-events raw-body mount', () => {
  it('verifies a real signature over the RAW bytes in the real app, and stores the event', async () => {
    const id = `evt-webhook-ok-${RUN}`;
    const payload = eventBody(id);
    const base = await listen(createApp());
    const { status, body } = await post(base, payload, sign(payload));
    expect(status).toBe(200);
    expect(body).toContain('"received":true');
    expect(await stored(id)).toHaveLength(1);
    // A redelivery is acknowledged and stores nothing more.
    expect((await post(base, payload, sign(payload))).body).toContain('"duplicate":true');
    expect(await stored(id)).toHaveLength(1);
  });

  it('the SAME router behind express.json refuses the same delivery (vacuity guard)', async () => {
    const id = `evt-webhook-guard-${RUN}`;
    const payload = eventBody(id);
    const app = express();
    app.use(express.json());
    app.use(PATH, oxyFilesWebhookRouter);
    const base = await listen(app);
    const { status } = await post(base, payload, sign(payload));
    expect(status).toBe(400);
    expect(await stored(id)).toHaveLength(0);
  });

  it('a body on a NON-webhook path is still parsed', async () => {
    const app = createApp();
    app.post('/__probe-oxy-files-normal', (req, res) => {
      res.json({ bodyType: typeof req.body });
    });
    const base = await listen(app);
    const response = await fetch(`${base}/__probe-oxy-files-normal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect((await response.json()) as { bodyType: string }).toEqual({ bodyType: 'object' });
  });
});

describe('Oxy file-events verification', () => {
  it('echoes the endpoint challenge without a signature (Oxy shows the secret only after it)', async () => {
    const base = await listen(createApp());
    const response = await post(
      base,
      JSON.stringify({ type: 'webhook.challenge', challenge: `challenge-${RUN}` }),
    );
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ challenge: `challenge-${RUN}` });
  });

  it.each([
    ['unsigned', (_payload: string) => undefined as string | undefined],
    ['signed with another secret', (payload: string) => sign(payload, 'whsec_someone_else')],
    [
      'replayed from an hour ago',
      (payload: string) => sign(payload, SECRET, Math.floor(Date.now() / 1000) - 3_600),
    ],
  ] as const)('refuses a delivery %s and stores nothing', async (label, signer) => {
    const id = `evt-webhook-${label.replaceAll(' ', '-')}-${RUN}`;
    const payload = eventBody(id);
    const base = await listen(createApp());
    const { status } = await post(base, payload, signer(payload));
    expect(status).toBe(400);
    expect(await stored(id)).toHaveLength(0);
  });

  it('refuses a tampered body', async () => {
    const id = `evt-webhook-tampered-${RUN}`;
    const payload = eventBody(id);
    const base = await listen(createApp());
    const { status } = await post(
      base,
      payload.replace('file.trashed', 'file.blocked'),
      sign(payload),
    );
    expect(status).toBe(400);
    expect(await stored(id)).toHaveLength(0);
  });
});
