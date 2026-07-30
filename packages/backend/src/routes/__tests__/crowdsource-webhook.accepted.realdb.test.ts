/**
 * The webhook ACCEPTS a genuinely valid delivery — the sibling every
 * refusal test needs.
 *
 * ## Why this file exists
 *
 * The other webhook tests all assert a REFUSAL: mounted late → 500, bad
 * signature → 401, no parser ran → `req.body` undefined. Every one of those can
 * pass while the endpoint is incapable of accepting anything at all. A refusal
 * test on its own proves the request was rejected; it does not prove it was
 * rejected *for the reason under test*, and it never proves the happy path works.
 *
 * That is not hypothetical here. The refusal test in the sibling file sends a
 * delivery with no `X-CrowdSource-Event-Id` at all, so its 401 is a
 * `missing_event_id` rejection rather than a signature one. That still proves what
 * that test claims — reaching verification at all means `readRawBody` succeeded,
 * which is the mount invariant — but it would look identical if the route were
 * incapable of ever returning 200.
 *
 * So this signs a delivery properly and asserts the whole path: signature verified
 * over the raw bytes, handler run, decision durably queued in the outbox. Against
 * a real replica set, because the handler opens a transaction.
 *
 * The signing here deliberately reconstructs the scheme from the CONTRACT's own
 * `buildWebhookSignedPayload` and header constants rather than hardcoding
 * `timestamp + "." + body`. If the contract changes what gets signed, this test
 * follows it instead of silently testing a scheme nobody uses any more.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import express from 'express';
import mongoose from 'mongoose';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  buildWebhookSignedPayload,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_TIMESTAMP_HEADER,
} from '@oxyhq/crowdsource-contracts';

const SECRET = 'test-secret-not-a-real-one';
const uri = process.env.MERCARIA_TEST_MONGODB_URI;
const servers: Server[] = [];

let ModerationOutbox: typeof import('../../models/moderation-outbox.js').ModerationOutbox;
let app: express.Express;

beforeAll(async () => {
  if (!uri) throw new Error('MERCARIA_TEST_MONGODB_URI missing — is vitest.globalSetup.ts wired?');
  process.env.CROWDSOURCE_WEBHOOK_SECRET = SECRET;
  await mongoose.connect(uri, { dbName: 'mercaria-webhook-accept-test' });

  ({ ModerationOutbox } = await import('../../models/moderation-outbox.js'));
  await ModerationOutbox.syncIndexes();

  // The REAL router, mounted the way `app.ts` mounts it: ahead of any parser.
  const { default: crowdSourceWebhookRouter } = await import('../crowdsource-webhook.js');
  app = express();
  app.use('/webhooks/crowdsource', crowdSourceWebhookRouter);
}, 120_000);

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await mongoose.disconnect();
});

beforeEach(async () => {
  await ModerationOutbox.deleteMany({});
});

function listen(instance: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const server = instance.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

function decidedEvent(eventId: string): Record<string, unknown> {
  return {
    id: eventId,
    type: 'case.decided',
    createdAt: new Date().toISOString(),
    organizationId: 'org_test',
    applicationId: 'app_test',
    data: {
      caseId: 'case_test_1',
      /**
       * A decision that genuinely satisfies `DecisionSchema`.
       *
       * Every field here is required by the contract, and getting that wrong is
       * the whole reason this test asserts the outbox row rather than just the
       * status: an envelope the schema rejects is acknowledged 200 with
       * `handled: false` and no handler ever runs. The first version of this
       * fixture did exactly that, and a status-only assertion would have called
       * it a pass.
       */
      decision: {
        id: 'dec_test_1',
        caseId: 'case_test_1',
        revision: 1,
        status: 'final',
        outcome: 'no_violation',
        contextSufficiency: 'sufficient',
        findings: [],
        recommendedActions: [],
        confidence: 0.9,
        jury: {
          size: 5,
          decisiveVotes: 5,
          winningVotes: 4,
          agreement: 0.8,
          specialistPresent: false,
        },
        policyVersions: {
          taxonomy: '2026.1',
          application: 'mercaria.1',
          oxyConduct: 'oxy.1',
        },
        publishedAt: new Date().toISOString(),
      },
    },
  };
}

/** Sign exactly the way the contract says both sides must. */
function deliver(
  base: string,
  event: Record<string, unknown>,
  options: { secret?: string } = {},
): Promise<Response> {
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', options.secret ?? SECRET)
    .update(buildWebhookSignedPayload(timestamp, body))
    .digest('hex');

  return fetch(`${base}/webhooks/crowdsource`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [WEBHOOK_EVENT_ID_HEADER]: String(event.id),
      [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
      [WEBHOOK_SIGNATURE_HEADER]: `${WEBHOOK_SIGNATURE_VERSION}=${signature}`,
    },
    body,
  });
}

describe('a correctly signed delivery is ACCEPTED and durably queued', () => {
  it('answers 200 and writes the decision to the outbox', async () => {
    const base = await listen(app);
    const response = await deliver(base, decidedEvent('evt_accepted_1'));

    expect(response.status).toBe(200);

    /**
     * The 200 alone would only mean "did not throw". The outbox row is what makes
     * it honest: the handler's contract is that a 2xx means the decision is
     * durably recorded, so acknowledging without the row would be a lie to
     * CrowdSource that stops it retrying.
     */
    const row = await ModerationOutbox.findById(
      'moderation:decision.apply:evt_accepted_1',
    ).lean();
    expect(row).not.toBeNull();
    expect(row?.kind).toBe('decision.apply');
  });

  it('a REDELIVERY is acknowledged without queueing the work twice', async () => {
    const base = await listen(app);
    const event = decidedEvent('evt_accepted_2');

    const first = await deliver(base, event);
    const second = await deliver(base, event);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // One row, because the event id is the key in both the dedupe claim and the
    // outbox `_id`. CrowdSource retries a delivery whose 2xx was lost, so this is
    // the ordinary case rather than an edge one.
    expect(await ModerationOutbox.countDocuments({})).toBe(1);
  });

  it('the SAME body signed with the wrong secret is refused (discrimination)', async () => {
    /**
     * The pair that makes the acceptance test mean something. Identical envelope,
     * identical headers, only the signing key differs — so a 200 above cannot be
     * explained by "this endpoint accepts anything", and the 401 here cannot be
     * explained by a malformed payload.
     */
    const base = await listen(app);
    const response = await deliver(base, decidedEvent('evt_rejected_1'), {
      secret: 'a-different-secret',
    });

    expect(response.status).toBe(401);
    expect(await ModerationOutbox.countDocuments({})).toBe(0);
  });
});
