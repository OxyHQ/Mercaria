/**
 * The CrowdSource webhook's raw-body guarantee, asserted against the REAL app.
 *
 * `createApp()` from `app.ts` builds the actual middleware chain production runs,
 * so this exercises the real mount order rather than an app-shaped object the
 * test assembled for itself.
 *
 * ## What is asserted, and why it is not "the mount order"
 *
 * A test that read `app.ts` and checked `/webhooks/crowdsource` appears before
 * `express.json()` would prove only that two lines are in an order. It would keep
 * passing if a parser were added inside the webhook router, if some other
 * middleware installed a global parser earlier, or if Express changed how
 * sub-app parsers inherit.
 *
 * Instead this sends a REAL request and reads which of two mutually exclusive
 * outcomes the SDK produced, because `@oxyhq/crowdsource-express` distinguishes
 * them itself:
 *
 *   * **No parser ran** — it reads the stream, verifies, and answers
 *     `401 {received: false, rejection: …}` for a bad signature.
 *   * **A parser ran first** — `readRawBody` throws
 *     `CrowdSourceWebhookConfigurationError` ("A body parser ran before the
 *     CrowdSource webhook handler, so the signed bytes no longer exist"), which
 *     goes to `next()` and surfaces as a 500 from the app's error handler.
 *
 * So a 401 with a `rejection` is positive evidence that the handler read the raw
 * bytes — the invariant itself, observed, not inferred from source order. This is
 * stronger than probing `typeof req.body`, because it exercises the very code
 * path whose correctness is at stake.
 *
 * ## The vacuity guard
 *
 * A check that cannot fail is worse than no check. The second test mounts the
 * SAME router behind `express.json()` and asserts the 500 configuration error, so
 * the suite demonstrates the assertion discriminates rather than holding for some
 * unrelated reason.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import crowdSourceWebhookRouter from '../crowdsource-webhook.js';

const WEBHOOK_PATH = '/webhooks/crowdsource';
const PROBE_PATH = '/__rawbody_probe';
const servers: Server[] = [];

/**
 * A probe route registered ON the webhook router itself.
 *
 * Position is the entire point. A route added to the APP after `createApp()`
 * returns sits at the END of the middleware stack — behind the global
 * `express.json()` — and would observe a parsed body no matter how the webhook
 * is mounted. Registering it on the router means it inherits the router's mount
 * position, so what it observes is what the webhook handler observes.
 */
crowdSourceWebhookRouter.post(PROBE_PATH, (req, res) => {
  res.json({ bodyType: typeof req.body });
});

/** A syntactically valid delivery whose signature is wrong. */
const UNSIGNED_DELIVERY = JSON.stringify({
  id: 'evt_test_1',
  type: 'case.decided',
  createdAt: new Date().toISOString(),
  organizationId: 'org_test',
  applicationId: 'app_test',
  data: {},
});

function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

async function postDelivery(base: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${base}${WEBHOOK_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      /**
       * A COMPLETE header set with a deliberately wrong signature, so the
       * rejection is a `signature_mismatch` rather than a missing header.
       *
       * The distinction matters for what this test is allowed to claim. Any 401
       * proves the mount invariant — reaching verification at all means
       * `readRawBody` got the bytes — but an earlier version omitted the event-id
       * header and was rejected before the signature was ever compared. That
       * still passed, and would have kept passing if the signature check were
       * removed entirely. The acceptance path is proven separately in
       * `crowdsource-webhook.accepted.realdb.test.ts`, which is the sibling this
       * refusal needs.
       */
      'X-CrowdSource-Event-Id': 'evt_test_1',
      'X-CrowdSource-Signature': 'v1=0000000000000000000000000000000000000000000000000000000000000000',
      'X-CrowdSource-Timestamp': String(Math.floor(Date.now() / 1000)),
    },
    body: UNSIGNED_DELIVERY,
  });
  return { status: response.status, body: await response.text() };
}

beforeAll(() => {
  // Present so verification REACHES the signature check. Without a secret the
  // handler could fail for a different reason, and the test would stop
  // discriminating between the two outcomes it exists to tell apart.
  process.env.CROWDSOURCE_WEBHOOK_SECRET = 'test-secret-not-a-real-one';
});

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function probe(base: string): Promise<{ bodyType: string }> {
  const response = await fetch(`${base}${WEBHOOK_PATH}${PROBE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  });
  return (await response.json()) as { bodyType: string };
}

describe('CrowdSource webhook raw-body mount', () => {
  it('NO parser ran: typeof req.body === "undefined" inside a route on that path', async () => {
    /**
     * The assertion that survives either parser configuration, and the reason it
     * is here alongside the 401/500 one below.
     *
     * Mercaria's parser is a plain `express.json({ limit: '10mb' })` with NO
     * `verify` hook, so nothing leaves a raw body behind and a late mount fails
     * loudly — which is what makes the 401-vs-500 check meaningful HERE. But that
     * check is contingent on that fact. An app using `express.json({ verify })`
     * leaves a Buffer on `req.rawBody`, the SDK accepts it, and a late mount
     * VERIFIES SUCCESSFULLY against bytes the parser handed back: same invariant
     * broken, and the delivery looks perfect.
     *
     * `typeof req.body === 'undefined'` is not contingent on any of that. It is a
     * statement about whether a parser ran at all, which is the invariant itself.
     * So if someone later adds a `verify` hook to this app, this test still fails
     * on a late mount and the one below might not.
     */
    const base = await listen(createApp());
    expect((await probe(base)).bodyType).toBe('undefined');
  });

  it('the SAME probe behind express.json sees a parsed body (vacuity guard)', async () => {
    const app = express();
    app.use(express.json());
    app.use(WEBHOOK_PATH, crowdSourceWebhookRouter);

    const base = await listen(app);

    // Proves the probe discriminates. A probe that reported `undefined` for some
    // unrelated reason would otherwise read as a pass forever.
    expect((await probe(base)).bodyType).toBe('object');
  });

  it('reads the RAW bytes in the real app (rejects the signature, not the mount)', async () => {
    const base = await listen(createApp());
    const { status, body } = await postDelivery(base);

    /**
     * 401 means the handler got as far as verifying a signature, which it can
     * only do over bytes it read itself. 500 would mean
     * `CrowdSourceWebhookConfigurationError` — a parser got there first.
     */
    expect(status).toBe(401);
    // Specifically the signature, now that every required header is present.
    expect(body).toContain('signature_mismatch');
    expect(body).not.toContain('Something went wrong');
  });

  it('the SAME router behind express.json fails as a mount error (vacuity guard)', async () => {
    const app = express();
    app.use(express.json());
    app.use(WEBHOOK_PATH, crowdSourceWebhookRouter);
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: 'Something went wrong!' });
      },
    );

    const base = await listen(app);
    const { status } = await postDelivery(base);

    /**
     * Proves the assertion above is capable of failing. Without this, a 401
     * arriving for any unrelated reason would read as a pass, and the invariant
     * would be guarded by a check that cannot distinguish success from failure.
     */
    expect(status).toBe(500);
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
     * would satisfy the first test and silently break every other route in the
     * API; this is what catches that.
     */
    expect((await response.json()) as { bodyType: string }).toEqual({ bodyType: 'object' });
  });
});
