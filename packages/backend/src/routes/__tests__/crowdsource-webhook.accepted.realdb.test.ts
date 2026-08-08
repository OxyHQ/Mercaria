/**
 * The webhook ACCEPTS a genuinely valid delivery — the sibling every refusal test
 * needs.
 *
 * ## Why this file exists
 *
 * The other webhook tests all assert a REFUSAL: mounted late → 500, bad signature
 * → 401, no parser ran → `req.body` undefined. Every one of those can pass while
 * the endpoint is incapable of accepting anything at all. A refusal test on its own
 * proves the request was rejected; it does not prove it was rejected *for the
 * reason under test*, and it never proves the happy path works.
 *
 * So this signs a delivery properly and asserts the whole path: signature verified
 * over the raw bytes, handler run, decision durably queued in the outbox. Against a
 * real Postgres database, because the handler opens a transaction AND because the
 * redelivery assertion below now depends on the shared dedupe claim
 * (`moderation_events`) rather than on a per-process map.
 *
 * The signing here deliberately reconstructs the scheme from the CONTRACT's own
 * `buildWebhookSignedPayload` and header constants rather than hardcoding
 * `timestamp + "." + body`. If the contract changes what gets signed, this test
 * follows it instead of silently testing a scheme nobody uses any more.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import express from 'express';
import { eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
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
const servers: Server[] = [];

/** Unique to this run: the Postgres database is shared with every parallel file. */
const RUN = uuidv7();

let pg: typeof import('../../db/postgres.js');
let moderationEvents: typeof import('../../db/schema/moderation.js').moderationEvents;
let moderationOutboxes: typeof import('../../db/schema/moderation.js').moderationOutboxes;
let app: express.Express;

/** Every webhook event id this file delivers, so teardown is scoped. */
const deliveredEventIds: string[] = [];

beforeAll(async () => {
  process.env.CROWDSOURCE_WEBHOOK_SECRET = SECRET;

  pg = await import('../../db/postgres.js');
  ({ moderationEvents, moderationOutboxes } = await import('../../db/schema/moderation.js'));
  await pg.connectPostgres();

  // The REAL router, mounted the way `app.ts` mounts it: ahead of any parser.
  const { default: crowdSourceWebhookRouter } = await import('../crowdsource-webhook.js');
  app = express();
  app.use('/webhooks/crowdsource', crowdSourceWebhookRouter);
}, 120_000);

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await cleanup();
  await pg.closePostgres();
});

beforeEach(async () => {
  await cleanup();
});

async function cleanup(): Promise<void> {
  const eventIds = deliveredEventIds.splice(0);
  if (eventIds.length === 0) return;
  await pg
    .getDb()
    .delete(moderationOutboxes)
    .where(inArray(moderationOutboxes.id, eventIds.map((id) => `moderation:decision.apply:${id}`)));
  await pg.getDb().delete(moderationEvents).where(inArray(moderationEvents.id, eventIds));
}

/** How many outbox rows exist for one webhook event id. */
async function outboxRowsFor(eventId: string): Promise<{ id: string; kind: string }[]> {
  return pg
    .getDb()
    .select({ id: moderationOutboxes.id, kind: moderationOutboxes.kind })
    .from(moderationOutboxes)
    .where(eq(moderationOutboxes.id, `moderation:decision.apply:${eventId}`));
}

function listen(instance: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const server = instance.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

/** An event id unique to this run, registered for teardown. */
function eventId(name: string): string {
  const id = `evt-${name}-${RUN}`;
  deliveredEventIds.push(id);
  return id;
}

function decidedEvent(id: string): Record<string, unknown> {
  return {
    id,
    type: 'case.decided',
    createdAt: new Date().toISOString(),
    organizationId: 'org_test',
    applicationId: 'app_test',
    data: {
      caseId: `case-${RUN}`,
      /**
       * A decision that genuinely satisfies `DecisionSchema`.
       *
       * Every field here is required by the contract, and getting that wrong is
       * the whole reason this test asserts the outbox row rather than just the
       * status: an envelope the schema rejects is acknowledged 200 with
       * `handled: false` and no handler ever runs. The first version of this
       * fixture did exactly that, and a status-only assertion would have called it
       * a pass.
       */
      decision: {
        id: `dec-${RUN}`,
        caseId: `case-${RUN}`,
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
    const id = eventId('accepted-1');
    const response = await deliver(base, decidedEvent(id));

    expect(response.status).toBe(200);

    /**
     * The 200 alone would only mean "did not throw". The outbox row is what makes
     * it honest: the handler's contract is that a 2xx means the decision is
     * durably recorded, so acknowledging without the row would be a lie to
     * CrowdSource that stops it retrying.
     */
    const rows = await outboxRowsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('decision.apply');
  });

  it('a REDELIVERY is acknowledged without queueing the work twice', async () => {
    const base = await listen(app);
    const id = eventId('accepted-2');
    const event = decidedEvent(id);

    const first = await deliver(base, event);
    const second = await deliver(base, event);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    /**
     * One row, twice over: the event id is the key in BOTH the shared dedupe claim
     * (`moderation_events`, which is a Postgres row now rather than a per-process
     * map, because several ECS tasks sit behind one ALB) and the outbox primary
     * key. CrowdSource retries a delivery whose 2xx was lost, so this is the
     * ordinary case rather than an edge one.
     */
    expect(await outboxRowsFor(id)).toHaveLength(1);
  });

  it('the SAME body signed with the wrong secret is refused (discrimination)', async () => {
    /**
     * The pair that makes the acceptance test mean something. Identical envelope,
     * identical headers, only the signing key differs — so a 200 above cannot be
     * explained by "this endpoint accepts anything", and the 401 here cannot be
     * explained by a malformed payload.
     */
    const base = await listen(app);
    const id = eventId('rejected-1');
    const response = await deliver(base, decidedEvent(id), { secret: 'a-different-secret' });

    expect(response.status).toBe(401);
    expect(await outboxRowsFor(id)).toHaveLength(0);
  });
});
