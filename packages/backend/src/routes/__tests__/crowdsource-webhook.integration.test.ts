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
const servers: Server[] = [];

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
      // Deliberately wrong. A VALID signature would exercise the happy path and
      // hit the database; a wrong one still proves which bytes were read.
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

describe('CrowdSource webhook raw-body mount', () => {
  it('reads the RAW bytes in the real app (rejects the signature, not the mount)', async () => {
    const base = await listen(createApp());
    const { status, body } = await postDelivery(base);

    /**
     * 401 means the handler got as far as verifying a signature, which it can
     * only do over bytes it read itself. 500 would mean
     * `CrowdSourceWebhookConfigurationError` — a parser got there first.
     */
    expect(status).toBe(401);
    expect(body).toContain('rejection');
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
