/**
 * The Peable webhook's raw-body guarantee, asserted against the REAL app.
 *
 * `createApp()` from `app.ts` builds the actual middleware chain production
 * runs, so this exercises the real mount order rather than an app-shaped object
 * the test assembled for itself. It is the sibling of
 * `stripe-webhook.integration.test.ts`, and it exists separately because the
 * invariant is per-MOUNT: the Stripe file passing proves nothing about a router
 * added later, which is exactly how a fifth raw-body mount would acquire a
 * parser above it and nobody would notice.
 *
 * ## What is asserted, and why it is not "the mount order"
 *
 * A test that read `app.ts` and checked `/webhooks/peable` appears before
 * `express.json()` would prove only that two lines are in an order. It would
 * keep passing if a parser were added inside the webhook router, if some other
 * middleware installed a global parser earlier, or if Express changed how
 * sub-app parsers inherit.
 *
 * Instead this sends REAL bytes signed with the gateway's own scheme and
 * observes which of two mutually exclusive outcomes the ingress produced:
 *
 *   * **No parser ran** — the raw Buffer reaches the HMAC, the signature
 *     verifies, and the delivery is accepted.
 *   * **A parser ran first** — `req.body` is a parsed object rather than a
 *     Buffer, the handler substitutes an empty buffer, and verification fails.
 *
 * So an ACCEPTED delivery is positive evidence that the handler read the raw
 * bytes. The vacuity guard mounts the SAME router behind `express.json()` and
 * asserts the refusal, so the assertion is shown to discriminate.
 *
 * ## The signature is computed here, from the scheme, not imported
 *
 * `verify.ts` is the code under test, so signing with its own helper would make
 * the suite agree with itself no matter what the scheme was. These bytes are
 * signed the way the GATEWAY signs them — `t=<unix>,v1=<hex hmac-sha256 of
 * "<t>.<rawBody>">` — written out longhand, so a change to either side is a
 * failure rather than a silent redefinition of the contract.
 *
 * ## "Nothing persisted" is asserted against the REAL table
 *
 * A refusal has two halves and a status code only shows one. The other — that
 * an unverified body never reached the event store — matters more: an
 * attacker's chosen `(provider, event id)` sitting in the dedupe key means the
 * REAL event carrying that id is later swallowed as a duplicate, and nothing
 * anywhere reports it.
 *
 * The deliveries here deliberately name payments that do not exist, so they are
 * stored and then fail PROCESSING, which is exactly the separation under test:
 * the response is 200 either way.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import express from 'express';
import { createHmac } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Database } from '../../db/postgres.js';

const SECRET = 'pwhsec_current_not_a_real_one';
const SECRET_PREVIOUS = 'pwhsec_previous_not_a_real_one';
const PATH = '/webhooks/peable';

const servers: Server[] = [];

let createApp: typeof import('../../app.js').createApp;
let peableWebhookRouter: typeof import('../peable-webhook.js').default;
let db: Database;
let closePostgres: typeof import('../../db/postgres.js').closePostgres;
let paymentProviderEvents: typeof import('../../db/schema/payments.js').paymentProviderEvents;

/**
 * Everything is imported AFTER the environment is set.
 *
 * `config/index.ts` reads `process.env` once at module load and freezes the
 * result, and `app.ts` decides whether to mount the router from that frozen
 * value. A static import would evaluate the config before `beforeAll` ran and
 * this whole file would be testing a deployment with Peable switched off — every
 * request a 404, and the raw-body assertion vacuous.
 */
beforeAll(async () => {
  process.env.PEABLE_ENABLED = 'true';
  // All four of `resolvePeableEnabled`'s required names, not just the ones this
  // file exercises: the flag is a CONJUNCTION, so omitting `PEABLE_BASE_URL`
  // leaves the rail off and every request here a 404 — which would make the
  // raw-body assertion vacuous while still looking like a wiring bug.
  process.env.PEABLE_BASE_URL = 'https://api.peable.invalid';
  process.env.PEABLE_APP_PUBLIC_KEY = 'peable_pub_not_a_real_key';
  process.env.PEABLE_APP_SECRET = 'peable_secret_not_a_real_key';
  process.env.PEABLE_WEBHOOK_SECRET = SECRET;
  process.env.PEABLE_WEBHOOK_SECRET_PREVIOUS = SECRET_PREVIOUS;

  ({ createApp } = await import('../../app.js'));
  peableWebhookRouter = (await import('../peable-webhook.js')).default;
  const postgres = await import('../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();
  ({ paymentProviderEvents } = await import('../../db/schema/payments.js'));
}, 120_000);

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await closePostgres();
});

/**
 * The stored rows for one gateway event id.
 *
 * Scoped to this test's own event ids, never a table-wide count: `*.realdb`
 * files share ONE throwaway database and run in parallel, so a count over the
 * whole table would pass or fail on what another file happened to be doing.
 */
async function storedEvents(providerEventId: string) {
  return await db
    .select()
    .from(paymentProviderEvents)
    .where(
      and(
        eq(paymentProviderEvents.provider, 'peable'),
        eq(paymentProviderEvents.providerEventId, providerEventId),
      ),
    );
}

function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

/** A syntactically complete gateway event body. */
function eventBody(overrides: { id?: string; type?: string; intentId?: string }): string {
  return JSON.stringify({
    id: overrides.id ?? 'evt_peable_1',
    object: 'event',
    type: overrides.type ?? 'payment_intent.settled',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: overrides.intentId ?? 'pi_peable_test_1',
        object: 'payment_intent',
        status: 'settled',
        amount: '1000',
        currency: 'EUR',
      },
    },
  });
}

/**
 * Sign a body the way the GATEWAY does — longhand, not through `verify.ts`.
 *
 * See this file's header: signing with the verifier's own helper would make the
 * suite agree with itself whatever the scheme became.
 */
function sign(payload: string, secret: string, timestamp?: number): string {
  const t = timestamp ?? Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(`${String(t)}.${payload}`).digest('hex');
  return `t=${String(t)},v1=${signature}`;
}

async function post(
  base: string,
  payload: string,
  signature: string,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${base}${PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Peable-Signature': signature },
    body: payload,
  });
  return { status: response.status, body: await response.text() };
}

describe('Peable webhook raw-body mount', () => {
  it('verifies a real signature over the RAW bytes in the real app', async () => {
    const payload = eventBody({ id: 'evt_peable_rawbody_ok' });
    const signature = sign(payload, SECRET);

    const base = await listen(createApp());
    const { status, body } = await post(base, payload, signature);

    /**
     * 200 means the handler got a Buffer and the signature verified over it.
     * Nothing else in this application can produce that outcome: a parsed body
     * substitutes an empty buffer and fails verification with a 400.
     *
     * It is a 200 rather than an assertion about processing because the ingress
     * treats receipt and processing separately — this delivery names a payment
     * that does not exist, so it will fail PROCESSING and be retried, and the
     * response is deliberately unaffected by that.
     */
    expect(status).toBe(200);
    expect(body).toContain('"received":true');
  });

  it('the SAME router behind express.json refuses the same delivery (vacuity guard)', async () => {
    const payload = eventBody({ id: 'evt_peable_rawbody_guard' });
    const signature = sign(payload, SECRET);

    const app = express();
    app.use(express.json());
    app.use(PATH, peableWebhookRouter);
    const base = await listen(app);

    const { status, body } = await post(base, payload, signature);

    /**
     * Proves the assertion above is capable of failing. Without this, a 200
     * arriving for any unrelated reason would read as a pass forever, and the
     * mount invariant would be guarded by a check that cannot distinguish
     * success from failure.
     */
    expect(status).toBe(400);
    expect(body).toContain('invalid_signature');
  });

  it('a body on a NON-webhook path is still parsed', async () => {
    const app = createApp();
    app.post('/__probe-peable-normal', (req, res) => {
      res.json({ bodyType: typeof req.body });
    });
    const base = await listen(app);

    const response = await fetch(`${base}/__probe-peable-normal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });

    /**
     * The webhook exemption must stay SCOPED. Deleting `express.json()` outright
     * would satisfy the test above and silently break every other route in the
     * API; this is what catches that.
     */
    expect((await response.json()) as { bodyType: string }).toEqual({ bodyType: 'object' });
  });
});

describe('Peable webhook signature verification', () => {
  it('a TAMPERED body is refused and nothing is persisted', async () => {
    const payload = eventBody({ id: 'evt_peable_tampered' });
    const signature = sign(payload, SECRET);
    const tampered = payload.replace('"1000"', '"999900"');

    const base = await listen(createApp());
    const { status } = await post(base, tampered, signature);

    expect(status).toBe(400);
    // The half a status code cannot show. An unverified body reaching the store
    // would put an attacker's chosen event id in the dedupe key, after which the
    // REAL event carrying it is swallowed as a duplicate, silently.
    expect(await storedEvents('evt_peable_tampered')).toHaveLength(0);
  });

  it('accepts a delivery signed with the PREVIOUS secret, so a rotation loses nothing', async () => {
    const payload = eventBody({ id: 'evt_peable_rotation' });
    const signature = sign(payload, SECRET_PREVIOUS);

    const base = await listen(createApp());
    const { status } = await post(base, payload, signature);

    // The gateway cannot atomically swap a secret. Without this window every
    // delivery in flight during a rotation is rejected as a forgery.
    expect(status).toBe(200);
  });

  it('refuses a signature outside the tolerance window', async () => {
    const payload = eventBody({ id: 'evt_peable_stale' });
    // Well past the 300s tolerance. This is the whole replay defence: without
    // it, a signature captured today verifies forever.
    const signature = sign(payload, SECRET, Math.floor(Date.now() / 1000) - 3_600);

    const base = await listen(createApp());
    const { status } = await post(base, payload, signature);

    expect(status).toBe(400);
    expect(await storedEvents('evt_peable_stale')).toHaveLength(0);
  });

  it('refuses a delivery with no signature header at all', async () => {
    const payload = eventBody({ id: 'evt_peable_unsigned' });
    const base = await listen(createApp());

    const response = await fetch(`${base}${PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('missing_signature');
    expect(await storedEvents('evt_peable_unsigned')).toHaveLength(0);
  });

  it('stores a verified delivery exactly once, however many times it arrives', async () => {
    const payload = eventBody({ id: 'evt_peable_dupe' });
    const base = await listen(createApp());

    const first = await post(base, payload, sign(payload, SECRET));
    // A SECOND signature, freshly computed: a redelivery is not a byte-identical
    // replay, so deduping on the signature rather than the event id would let
    // this one through.
    const second = await post(base, payload, sign(payload, SECRET));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toContain('"duplicate":true');
    expect(await storedEvents('evt_peable_dupe')).toHaveLength(1);
  });
});
