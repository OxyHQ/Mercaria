/**
 * The Stripe webhook's raw-body guarantee, asserted against the REAL app.
 *
 * `createApp()` from `app.ts` builds the actual middleware chain production
 * runs, so this exercises the real mount order rather than an app-shaped object
 * the test assembled for itself.
 *
 * ## What is asserted, and why it is not "the mount order"
 *
 * A test that read `app.ts` and checked `/webhooks/stripe` appears before
 * `express.json()` would prove only that two lines are in an order. It would
 * keep passing if a parser were added inside the webhook router, if some other
 * middleware installed a global parser earlier, or if Express changed how
 * sub-app parsers inherit.
 *
 * Instead this sends REAL bytes signed with the SDK's own test-header helper and
 * observes which of two mutually exclusive outcomes the ingress produced:
 *
 *   * **No parser ran** — the raw Buffer reaches `constructEventAsync`, the
 *     signature verifies, and the delivery is accepted.
 *   * **A parser ran first** — `req.body` is a parsed object rather than a
 *     Buffer, the handler substitutes an empty buffer, and verification fails.
 *
 * So an ACCEPTED delivery is positive evidence that the handler read the raw
 * bytes — the invariant itself, observed, not inferred from source order. The
 * vacuity guard below mounts the SAME router behind `express.json()` and asserts
 * the refusal, so the assertion is shown to discriminate rather than holding for
 * some unrelated reason.
 *
 * ## Everything is signed with the ASYNC helper, deliberately
 *
 * `Stripe.webhooks.generateTestHeaderString` is synchronous and throws outright
 * under Bun, whose export condition resolves stripe's worker build (measured on
 * stripe@22.4.0). The suite runs under Node today, where both work — using the
 * async variant anyway means a future `bun vitest` does not turn every test in
 * this file red for a reason that has nothing to do with the code under test.
 * See `services/payments/stripe/client.ts`.
 *
 * ## "Nothing persisted" is asserted against the REAL table
 *
 * A refusal has two halves and a status code only shows one. The other — that
 * an unverified body never reached the event store — matters more: an
 * attacker's chosen `(provider, account, event id)` sitting in the dedupe key
 * means the REAL event carrying that id is later swallowed as a duplicate, and
 * nothing anywhere reports it. So this file connects the suite's throwaway
 * Postgres and queries `payment_provider_events` directly.
 *
 * Stubbing the repository instead was tried and CANNOT work: the ingress calls
 * `recordProviderEvent(getDb(), …)`, so `getDb()` is evaluated as an argument
 * whether or not the function it is passed to is mocked. The real database is
 * the stronger assertion anyway.
 *
 * Deep behaviour — convergence, dead-lettering, replay — is in
 * `services/payments/stripe/__tests__/stripe-ingress.realdb.test.ts`. Here the
 * deliveries deliberately name payments that do not exist, so they are stored
 * and then fail PROCESSING, which is exactly the separation under test: the
 * response is 200 either way.
 */

import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import express from 'express';
import Stripe from 'stripe';
import { and, eq } from 'drizzle-orm';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Database } from '../../db/postgres.js';

const PLATFORM_SECRET = 'whsec_platform_current_not_a_real_one';
const PLATFORM_SECRET_PREVIOUS = 'whsec_platform_previous_not_a_real_one';
const CONNECT_SECRET = 'whsec_connect_current_not_a_real_one';

const PLATFORM_PATH = '/webhooks/stripe';
const CONNECT_PATH = '/webhooks/stripe/connect';

const servers: Server[] = [];

let createApp: typeof import('../../app.js').createApp;
let stripeWebhookRouter: typeof import('../stripe-webhook.js').default;
let db: Database;
let closePostgres: typeof import('../../db/postgres.js').closePostgres;
let paymentProviderEvents: typeof import('../../db/schema/payments.js').paymentProviderEvents;

/**
 * Everything is imported AFTER the environment is set.
 *
 * `config/index.ts` reads `process.env` once at module load and freezes the
 * result, and `app.ts` decides whether to mount the router from that frozen
 * value. A static import would evaluate the config before `beforeAll` ran and
 * this whole file would be testing a deployment with Stripe switched off.
 */
beforeAll(async () => {
  process.env.STRIPE_ENABLED = 'true';
  // `sk_test_` is what makes `config.payments.stripe.livemode` false, which is
  // what the livemode-mismatch case below is measured against. It is not a real
  // key and nothing in this file makes a Stripe API call.
  process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
  process.env.STRIPE_WEBHOOK_SECRET = PLATFORM_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET_PREVIOUS = PLATFORM_SECRET_PREVIOUS;
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;

  ({ createApp } = await import('../../app.js'));
  stripeWebhookRouter = (await import('../stripe-webhook.js')).default;
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
 * The stored rows for one Stripe event id.
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
        eq(paymentProviderEvents.provider, 'stripe'),
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

/** A syntactically complete Stripe event body. */
function eventBody(overrides: {
  id?: string;
  type?: string;
  livemode?: boolean;
  account?: string;
  object?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    id: overrides.id ?? 'evt_test_1',
    object: 'event',
    api_version: '2026-07-29.dahlia',
    created: Math.floor(Date.now() / 1000),
    livemode: overrides.livemode ?? false,
    type: overrides.type ?? 'payment_intent.succeeded',
    ...(overrides.account ? { account: overrides.account } : {}),
    data: {
      object: overrides.object ?? {
        id: 'pi_test_1',
        object: 'payment_intent',
        status: 'succeeded',
        amount: 1000,
        currency: 'eur',
        metadata: { paymentId: 'mercaria-payment-1' },
      },
    },
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
  });
}

/** Sign a body with the async helper — see this file's header. */
async function sign(payload: string, secret: string): Promise<string> {
  return await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret });
}

async function post(
  base: string,
  path: string,
  payload: string,
  signature: string,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature },
    body: payload,
  });
  return { status: response.status, body: await response.text() };
}

describe('Stripe webhook raw-body mount', () => {
  it('verifies a real signature over the RAW bytes in the real app', async () => {
    const payload = eventBody({ id: 'evt_rawbody_ok' });
    const signature = await sign(payload, PLATFORM_SECRET);

    const base = await listen(createApp());
    const { status, body } = await post(base, PLATFORM_PATH, payload, signature);

    /**
     * 200 means the handler got a Buffer and the signature verified over it.
     * Nothing else in this application can produce that outcome: a parsed body
     * substitutes an empty buffer and fails verification with a 400.
     *
     * It is a 200 rather than an assertion about storage because the ingress
     * treats receipt and processing separately — this delivery names a payment
     * that does not exist, so it will fail PROCESSING and be retried, and the
     * response is deliberately unaffected by that.
     */
    expect(status).toBe(200);
    expect(body).toContain('"received":true');
  });

  it('the SAME router behind express.json refuses the same delivery (vacuity guard)', async () => {
    const payload = eventBody({ id: 'evt_rawbody_guard' });
    const signature = await sign(payload, PLATFORM_SECRET);

    const app = express();
    app.use(express.json());
    app.use('/webhooks/stripe', stripeWebhookRouter);
    const base = await listen(app);

    const { status, body } = await post(base, PLATFORM_PATH, payload, signature);

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
    app.post('/__probe-normal', (req, res) => {
      res.json({ bodyType: typeof req.body });
    });
    const base = await listen(app);

    const response = await fetch(`${base}/__probe-normal`, {
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

describe('Stripe webhook signature verification', () => {
  it('a TAMPERED body is refused and nothing is persisted', async () => {
    const payload = eventBody({ id: 'evt_tampered' });
    const signature = await sign(payload, PLATFORM_SECRET);
    // The AMOUNT, which is exactly the field an attacker would want to change
    // and exactly the change a signature exists to catch.
    const tampered = payload.replace('"amount":1000', '"amount":9999');
    expect(tampered).not.toBe(payload);

    const base = await listen(createApp());
    const { status, body } = await post(base, PLATFORM_PATH, tampered, signature);

    expect(status).toBe(400);
    expect(body).toContain('invalid_signature');
    /**
     * The half a status code cannot show. An unverified body must never reach
     * the event store: an attacker's chosen event id sitting in the dedupe key
     * means the REAL event carrying it is later swallowed as a duplicate, with
     * nothing anywhere reporting it.
     */
    expect(await storedEvents('evt_tampered')).toHaveLength(0);
  });

  it('the PREVIOUS secret is accepted during a rotation window', async () => {
    const payload = eventBody({ id: 'evt_previous_secret' });
    const signature = await sign(payload, PLATFORM_SECRET_PREVIOUS);

    const base = await listen(createApp());
    const { status } = await post(base, PLATFORM_PATH, payload, signature);

    expect(status).toBe(200);
    // A rotation window that accepted the old signature but stored nothing
    // would be a rotation that silently drops every event still signed with it.
    expect(await storedEvents('evt_previous_secret')).toHaveLength(1);
  });

  it('an UNRELATED secret is refused', async () => {
    const payload = eventBody({ id: 'evt_wrong_secret' });
    const signature = await sign(payload, 'whsec_some_other_endpoints_secret');

    const base = await listen(createApp());
    const { status, body } = await post(base, PLATFORM_PATH, payload, signature);

    /**
     * The rotation window must not turn into "any secret works". This is what
     * distinguishes "tries both configured secrets" from "does not really
     * verify" — without it, the previous-secret test above would pass even if
     * verification had been removed entirely.
     */
    expect(status).toBe(400);
    expect(body).toContain('invalid_signature');
  });

  it('a MISSING signature header is refused', async () => {
    const payload = eventBody({ id: 'evt_no_signature' });
    const base = await listen(createApp());

    const response = await fetch(`${base}${PLATFORM_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('missing_signature');
  });
});

describe('Stripe webhook endpoint scope', () => {
  it('the connect endpoint verifies against its OWN secret', async () => {
    const payload = eventBody({
      id: 'evt_connect_ok',
      type: 'account.updated',
      account: 'acct_test_1',
      object: { id: 'acct_test_1', object: 'account' },
    });
    const signature = await sign(payload, CONNECT_SECRET);

    const base = await listen(createApp());
    const { status } = await post(base, CONNECT_PATH, payload, signature);

    expect(status).toBe(200);
    const [row] = await storedEvents('evt_connect_ok');
    expect(row?.type).toBe('account.updated');
    // The connected account is stored, because it is HALF the dedupe key.
    expect(row?.providerAccountId).toBe('acct_test_1');
  });

  it("the platform secret does NOT verify at the connect endpoint", async () => {
    const payload = eventBody({
      id: 'evt_connect_wrong_secret',
      type: 'account.updated',
      account: 'acct_test_1',
      object: { id: 'acct_test_1', object: 'account' },
    });
    const signature = await sign(payload, PLATFORM_SECRET);

    const base = await listen(createApp());
    const { status, body } = await post(base, CONNECT_PATH, payload, signature);

    /**
     * The two endpoints are two Stripe objects with two secrets. If one secret
     * verified at both paths the scope split would be decorative, and a
     * compromise of either endpoint's secret would be a compromise of both.
     */
    expect(status).toBe(400);
    expect(body).toContain('invalid_signature');
  });

  it('an authentic CONNECT-scope event at the PLATFORM endpoint is refused', async () => {
    // Correctly signed for the endpoint it arrived at — only the TYPE is wrong,
    // which is what a misconfigured dashboard subscription produces.
    const payload = eventBody({
      id: 'evt_scope_mismatch',
      type: 'payout.paid',
      object: { id: 'po_test_1', object: 'payout' },
    });
    const signature = await sign(payload, PLATFORM_SECRET);

    const base = await listen(createApp());
    const { status, body } = await post(base, PLATFORM_PATH, payload, signature);

    expect(status).toBe(400);
    expect(body).toContain('wrong_scope');
    // Storing it would file a connect-scope event with no account under the
    // platform scope, silently corrupting the (provider, account, event) key.
    expect(await storedEvents('evt_scope_mismatch')).toHaveLength(0);
  });
});

describe('Stripe webhook livemode filter', () => {
  it('a LIVE event on a test-mode deployment is acknowledged and dropped', async () => {
    const payload = eventBody({ id: 'evt_livemode_mismatch', livemode: true });
    const signature = await sign(payload, PLATFORM_SECRET);

    const base = await listen(createApp());
    const { status, body } = await post(base, PLATFORM_PATH, payload, signature);

    /**
     * 200, because Stripe must stop retrying a delivery that will never be
     * accepted — and nothing persisted, because a live object's ids belong to a
     * different key space and would correlate to nothing, or to the wrong thing.
     */
    expect(status).toBe(200);
    expect(body).toContain('livemode_mismatch');
    expect(await storedEvents('evt_livemode_mismatch')).toHaveLength(0);
  });

  it('a TEST event on a test-mode deployment is accepted', async () => {
    const payload = eventBody({ id: 'evt_livemode_match', livemode: false });
    const signature = await sign(payload, PLATFORM_SECRET);

    const base = await listen(createApp());
    const { status } = await post(base, PLATFORM_PATH, payload, signature);

    /**
     * The vacuity guard for the filter. Without it, a filter that dropped
     * EVERYTHING would pass the test above.
     */
    expect(status).toBe(200);
    expect(await storedEvents('evt_livemode_match')).toHaveLength(1);
  });
});

describe('Stripe webhook rate limiting', () => {
  it('a burst of deliveries is never answered with 429', async () => {
    const base = await listen(createApp());
    const payload = eventBody({ id: 'evt_burst' });
    const signature = await sign(payload, 'whsec_deliberately_wrong');

    // Refused deliveries on purpose: this is about the LIMITER, and a refusal is
    // the cheapest way to hit the path many times without touching a database.
    const statuses = await Promise.all(
      Array.from({ length: 60 }, () =>
        post(base, PLATFORM_PATH, payload, signature).then((response) => response.status),
      ),
    );

    /**
     * Stripe delivers from a small pool of its own IP addresses, so a per-IP
     * limiter is ONE bucket for the entire provider: an incident backlog being
     * redelivered would trip it, and Stripe would retry into the same bucket
     * until it disabled the endpoint (issue #48, security 2).
     *
     * The webhook routers are mounted before the global limiter and add none of
     * their own, and this is what would notice a well-meaning future change
     * adding one.
     */
    expect(statuses.filter((status) => status === 429)).toEqual([]);
    expect(new Set(statuses)).toEqual(new Set([400]));
  });
});

describe('Stripe webhook when the rail is not configured', () => {
  it('mounts nothing and answers 404', async () => {
    vi.resetModules();
    const previous = process.env.STRIPE_ENABLED;
    process.env.STRIPE_ENABLED = 'false';
    const { createApp: disabledCreateApp } = await import('../../app.js');
    process.env.STRIPE_ENABLED = previous;

    const payload = eventBody({ id: 'evt_disabled' });
    const signature = await sign(payload, PLATFORM_SECRET);

    const base = await listen(disabledCreateApp());
    const platform = await post(base, PLATFORM_PATH, payload, signature);
    const connect = await post(base, CONNECT_PATH, payload, signature);

    /**
     * The MOUNT is gated, not just the handler. A 404 is the truthful answer for
     * a deployment with no secret — it has no way to tell a real delivery from a
     * forged one — and it stops an endpoint being registered in the Stripe
     * dashboard against a deployment that could never verify it.
     *
     * A correctly-signed body is used deliberately: this must be a 404 because
     * nothing is mounted, not because the signature failed.
     */
    expect(platform.status).toBe(404);
    expect(connect.status).toBe(404);
  });
});
