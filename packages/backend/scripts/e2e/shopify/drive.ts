/**
 * #69 Shopify scenario driver — the half of runbook §6 that an API can execute.
 *
 * ## What this is NOT
 *
 * It is not a pass/fail gate for the connector, and it cannot become one. Six of
 * the ten scenarios need somebody to act inside the Shopify admin (create a
 * product, edit a variant, place an order, uninstall the app) and the driver has
 * no way to do any of that — Mercaria never exposes the stored access token, by
 * design. So the driver's job is to do the API half exactly, PAUSE where a human
 * must act, and record what it actually observed on each side of that pause.
 *
 * Nothing here fabricates a verdict. `EvidenceCollector.record` refuses a
 * `PASSED` that does not state the observable measured AND what that measurement
 * would have read had the thing under test been absent, so "it did not error"
 * cannot become a pass. A scenario the driver could not complete is `NOT_RUN`
 * with the reason, which is a different artefact from a failure and from an
 * oversight.
 *
 * ## DEPENDENCY, stated rather than vendored
 *
 * `../evidence.js` and `../redact.js` are the SHARED collector and redaction
 * scanner (they are provider-neutral: `projectConnection` and `projectSyncRun`
 * read `Connection` and `SyncRun`, which Shopify and WooCommerce both produce).
 * They are owned by the WooCommerce runner branch. If this branch has not been
 * rebased onto it, the import below fails at startup naming the exact missing
 * path — loudly, before anything is measured. That is deliberate: a second copy
 * of a credential scanner is the thing that drifts, and the direction it drifts
 * is always the permissive one.
 *
 * Run:
 *   bun run packages/backend/scripts/e2e/shopify/preflight.ts   # must pass first
 *   bun run packages/backend/scripts/e2e/shopify/drive.ts --phase=connect
 *   bun run packages/backend/scripts/e2e/shopify/drive.ts --phase=backfill
 *   bun run packages/backend/scripts/e2e/shopify/drive.ts --phase=observe
 *   bun run packages/backend/scripts/e2e/shopify/drive.ts --phase=orders
 *   bun run packages/backend/scripts/e2e/shopify/drive.ts --phase=revocation
 *
 * Phases are separate commands because the human steps between them take
 * minutes to hours, and a driver that slept through them would hold one process
 * (and one evidence file) across the whole session.
 */

import type { Connection } from '@mercaria/shared-types';
import { MercariaAdminClient, waitForTerminalRun, type ApiResponse } from '../client.js';
import {
  EvidenceCollector,
  projectConnection,
  projectSyncRun,
  type ScenarioObservation,
} from '../evidence.js';
import { SecretRegistry, redactIdentifier } from '../redact.js';
import { API_VERSION } from '../../../src/connectors/shopify/index.js';
import {
  describeCredentialsProblem,
  loadShopifyCredentials,
  shopifyCredentialsPath,
} from './credentials.js';
import { describeServedApiVersion, probeServedApiVersion } from './api-version.js';

/** Emit one line. `console` is banned in this repo; the scripts use stdout. */
function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** Read a required variable or refuse — the driver never invents a default. */
function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set. Run preflight.ts first — it names every variable and ` +
        'what breaks without it.',
    );
  }
  return value;
}

// The `E2E_*` names are the shared driver harness's (`../config.ts`), not a
// second convention for the same facts.
const API_BASE = requireEnv('E2E_API_BASE_URL').replace(/\/+$/, '');
const TOKEN = requireEnv('E2E_OXY_ACCESS_TOKEN');
const STORE_ID = requireEnv('E2E_STORE_ID');
const EVIDENCE_DIR = requireEnv('E2E_EVIDENCE_DIR');

// The Shopify secrets come from the mode-600 credential file, never from an
// environment block somebody might paste. `preflight.ts` refuses first; this
// refuses again, because the driver is reachable directly.
const credentialsResult = await loadShopifyCredentials(shopifyCredentialsPath());
if (credentialsResult.outcome !== 'available') {
  throw new Error(describeCredentialsProblem(credentialsResult));
}
const SHOP_DOMAIN = credentialsResult.credentials.shopDomain;

const client = new MercariaAdminClient(API_BASE, TOKEN, STORE_ID);

/** How often the run waits below re-read `runs`. See `waitForTerminalRun`. */
const POLL_INTERVAL_MS = 3_000;

/**
 * Unwrap an admin response, or THROW — the one place this driver's error model
 * meets the shared client's.
 *
 * `MercariaAdminClient` never throws. It answers `{ok:false, error}` and leaves
 * the decision to the caller, which is right for the WooCommerce runner: a
 * refused request is a fact that runner RECORDS as evidence. Every call site in
 * this driver is written the other way round — a refusal is fatal, because the
 * scenario after it would measure a store that was never configured.
 *
 * That difference is NOT cosmetic, and collapsing it in the other direction is
 * the bug this seam exists to prevent. Two of the calls below are MUTATIONS
 * whose results were discarded (`updateSyncSettings`, `requestSync`). Drop the
 * throw and a 403 on the settings PATCH is silent: the product pull is never
 * enabled, the backfill that follows completes over a shop it was never told to
 * read, and S2 records `created=0` as **PASSED** — a green for an integration
 * that did nothing. The scenario's own `wouldReadIfAbsent` says exactly that
 * `created=0` on a completed run is indistinguishable from an empty shop.
 *
 * A non-2xx carries the status and the API's own message. The redaction scan
 * over the evidence file is the guarantee; this is the narrowing.
 */
function must<T>(what: string, response: ApiResponse<T>): T | null {
  if (!response.ok) {
    throw new Error(`${what} -> ${response.status}: ${response.error ?? 'no error message'}`);
  }
  return response.body;
}

/**
 * The Shopify connections specifically — S1's "ONE connection row, not two".
 *
 * `?? []` is safe ONLY because `must` has already thrown on a non-2xx: an empty
 * body behind a 200 genuinely means no connections, where an empty body behind
 * a 401 means nothing of the kind. That is the whole reason the throw is not
 * optional here.
 */
async function readShopifyConnections(): Promise<Connection[]> {
  const connections = must('GET channels', await client.listChannels()) ?? [];
  return connections.filter((connection) => connection.provider === 'shopify');
}

/** Block until the operator confirms they have done the Shopify-side step. */
async function pauseForHuman(instruction: string): Promise<void> {
  say('');
  say('  ┌─ A HUMAN MUST ACT IN THE SHOPIFY ADMIN ─────────────────────────────');
  for (const line of instruction.split('\n')) say(`  │ ${line}`);
  say('  └─ press ENTER when done (or Ctrl-C to stop and record NOT_RUN) ───────');
  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

const phase = (process.argv.find((arg) => arg.startsWith('--phase=')) ?? '').split('=')[1] ?? '';
const VALID_PHASES = ['connect', 'backfill', 'observe', 'orders', 'revocation'];
if (!VALID_PHASES.includes(phase)) {
  say(`Usage: drive.ts --phase=<${VALID_PHASES.join('|')}>`);
  process.exit(2);
}

const registry = new SecretRegistry();
registry.register('shopify client secret', credentialsResult.credentials.clientSecret);
registry.register('shopify client id', credentialsResult.credentials.clientId);
registry.register('oxy access token', TOKEN);
registry.register('connector encryption key', requireEnv('CONNECTOR_ENCRYPTION_KEY'));
registry.register('connector oauth state secret', requireEnv('CONNECTOR_OAUTH_STATE_SECRET'));

const collector = new EvidenceCollector(registry, EVIDENCE_DIR, `shopify-${phase}`);
collector.describeEnvironment({
  provider: 'shopify',
  shopDomain: SHOP_DOMAIN,
  apiVersionPinnedByCode: API_VERSION,
  storeId: redactIdentifier(STORE_ID),
  phase,
  // Named so the artefact records which variables were SET, never their values.
  configuredVariables: [
    'SHOPIFY_CLIENT_ID',
    'SHOPIFY_CLIENT_SECRET',
    'CONNECTOR_OAUTH_REDIRECT_BASE_URL',
    'CONNECTOR_OAUTH_STATE_SECRET',
    'CONNECTOR_ENCRYPTION_KEY',
  ].filter((name) => Boolean(process.env[name]?.trim())),
});

/**
 * The one thing every phase must say out loud.
 *
 * A retired pin does not fail a request — Shopify falls forward — so a run taken
 * under one measured a version nobody chose. preflight.ts refuses it; this note
 * makes the artefact carry the fact even if somebody ran the driver directly.
 */
collector.note(
  `Shopify Admin API version pinned by the code at the time of this run: ${API_VERSION}.`,
);

/**
 * The FIRST observation of every run, before any scenario.
 *
 * A retired pin does not fail a request — Shopify falls forward and reports it
 * only in `X-Shopify-API-Version` — so which version actually served is the
 * thing that decides whether the rest of this artefact means anything. It is
 * recorded whatever the answer, including when the probe cannot settle it,
 * because "we could not tell" and "it matched" must not read the same.
 */
const versionProbe = await probeServedApiVersion(SHOP_DOMAIN, API_VERSION);
collector.note(`API version read-back: ${describeServedApiVersion(versionProbe)}`);
say('');
say(`Shopify API version: ${describeServedApiVersion(versionProbe)}`);
if (versionProbe.outcome === 'served' && versionProbe.served !== API_VERSION) {
  say('');
  say('REFUSING to drive scenarios: the pin is not being honoured, so every');
  say('observation below would describe a version nobody selected.');
  process.exit(1);
}

const observations: ScenarioObservation[] = [];

try {
  if (phase === 'connect') {
    // ── S1: OAuth connect and reconnect ───────────────────────────────────────
    const before = await readShopifyConnections();
    say(`Shopify connections before connect: ${before.length}`);

    const connectResponse = must(
      'POST channels/shopify/connect',
      await client.connectShopify({ shopDomain: SHOP_DOMAIN }),
    );
    const authorizeUrl = connectResponse?.authorizeUrl;
    if (!authorizeUrl) throw new Error('connect returned no authorizeUrl');

    // The authorize URL carries client_id and the signed state. It is printed
    // because a human must open it, and deliberately NOT recorded as evidence.
    say('');
    say('Open this URL in a browser signed in to the dev store, and Install:');
    say('');
    say(`  ${authorizeUrl}`);

    await pauseForHuman(
      'Approve the install. You should land on the callback URL\n' +
        '(a plain 200, or CONNECTOR_OAUTH_SUCCESS_REDIRECT_URL if set).',
    );

    const after = await readShopifyConnections();
    const connection = after.find((entry) => entry.shopDomain === SHOP_DOMAIN);
    if (!connection) {
      observations.push({
        id: 'S1',
        title: 'OAuth connect and reconnect',
        status: 'FAILED',
        error: `no Shopify connection for ${SHOP_DOMAIN} after the callback`,
      });
    } else {
      observations.push({
        id: 'S1',
        title: 'OAuth connect and reconnect',
        status: 'PASSED',
        measured:
          `${after.length} Shopify connection row(s) after connect; status ` +
          `"${connection.status}"; ${connection.scopes.length} granted scope(s); ` +
          `${connection.webhookIds.length} webhook subscription id(s); ` +
          `${(connection.webhookFailures ?? []).length} refused topic(s)`,
        wouldReadIfAbsent:
          'zero connection rows, or a row with an empty scopes[] — which is what a ' +
          'callback that never completed the token exchange produces',
        observations: { connection: projectConnection(connection) },
      });

      // Runbook §3.3: read the granted scopes back BEFORE any scenario. A grant
      // narrower than requested makes later scenarios fail for a reason that is
      // not the connector's, so it is recorded as its own observation.
      say('');
      say(`Granted scopes (${connection.scopes.length}):`);
      for (const scope of [...connection.scopes].sort()) say(`  ${scope}`);
      if ((connection.webhookFailures ?? []).length > 0) {
        say('');
        say('Topics Shopify REFUSED (record these verbatim — #218/#262):');
        for (const failure of connection.webhookFailures ?? []) {
          say(`  ${failure.topic}  reason=${failure.reason}  http=${failure.httpStatus ?? '-'}`);
        }
      }

      // The reconnect half: running the whole connect again must converge on ONE
      // row and preserve syncSettings.
      must(
        'POST channels/shopify/connect (reconnect)',
        await client.connectShopify({ shopDomain: SHOP_DOMAIN }),
      );
      await pauseForHuman('Approve the install AGAIN (this is the reconnect half of S1).');
      const reconnected = await readShopifyConnections();
      observations.push({
        id: 'S1b',
        title: 'Reconnect converges on one connection row',
        status: reconnected.length === after.length ? 'PASSED' : 'FAILED',
        measured: `${reconnected.length} Shopify connection row(s) after a second connect`,
        wouldReadIfAbsent:
          `${after.length + 1} rows — a second connect minting a rival connection, ` +
          'which is what an upsert keyed on anything but the shop would produce',
        error:
          reconnected.length === after.length
            ? undefined
            : `expected ${after.length} row(s), found ${reconnected.length}`,
        observations: { connections: reconnected.map(projectConnection) },
      });
    }
  }

  if (phase === 'backfill') {
    // ── S2 / S5: backfill, and pagination at scale ────────────────────────────
    const connection = (await readShopifyConnections()).find(
      (entry) => entry.shopDomain === SHOP_DOMAIN,
    );
    if (!connection) throw new Error(`no Shopify connection for ${SHOP_DOMAIN}; run --phase=connect`);

    must(
      'PATCH channels/:id/settings',
      await client.updateSyncSettings(connection.id, { products: 'pull', inventory: 'pull' }),
    );

    const startedAt = Date.now();
    must('POST channels/:id/sync', await client.requestSync(connection.id));
    say('Backfill requested; polling for a terminal run (up to 30 minutes) ...');
    const settled = await waitForTerminalRun(
      client,
      connection.id,
      startedAt,
      30 * 60_000,
      'backfill',
      POLL_INTERVAL_MS,
    );
    const run = settled.run;
    const wallClockSeconds = Math.round((Date.now() - startedAt) / 1000);

    if (!run) {
      observations.push({
        id: 'S2',
        title: 'Initial product + inventory backfill',
        status: 'NOT_RUN',
        notRunReason:
          'no backfill run appeared within 30 minutes. Either the worker is not ' +
          'running (check REDIS_URL and the inline fallback) or the request never ' +
          'enqueued — this is not evidence about the connector.' +
          (settled.lastReadError === null
            ? ''
            : ` The LAST runs read also failed (${settled.lastReadError}), so this may ` +
              'be neither: an API that refused every poll is indistinguishable from a ' +
              'run that never started, and that is what this reads like.'),
      });
    } else {
      observations.push({
        id: 'S2',
        title: 'Initial product + inventory backfill',
        status: run.status === 'completed' ? 'PASSED' : 'FAILED',
        measured:
          `backfill run reached "${run.status}" in ${wallClockSeconds}s with ` +
          `created=${run.counts.created} updated=${run.counts.updated} ` +
          `skipped=${run.counts.skipped} failed=${run.counts.failed}`,
        wouldReadIfAbsent:
          'created=0 with a completed status — which is what a backfill over an ' +
          'EMPTY shop, or one whose product read was refused for scope, also produces. ' +
          "Compare created against the shop's own product count by hand.",
        error: run.status === 'failed' ? run.error : undefined,
        observations: { run: projectSyncRun(run) },
      });
      say('');
      say(`S5 (pagination at scale) needs the shop seeded > 250 products.`);
      say(`  wall clock: ${wallClockSeconds}s, created: ${run.counts.created}`);
      say(`  If created <= 250 this run says NOTHING about pagination — S5 stays NOT_RUN.`);
      observations.push({
        id: 'S5',
        title: 'Large catalogue pagination + rate limiting',
        status: run.counts.created > 250 ? 'PASSED' : 'NOT_RUN',
        measured:
          run.counts.created > 250
            ? `${run.counts.created} products created in one run, which is more than ` +
              `Shopify's 250-per-page ceiling, so at least one Link rel="next" page ` +
              `was followed; wall clock ${wallClockSeconds}s`
            : undefined,
        wouldReadIfAbsent:
          run.counts.created > 250
            ? 'created <= 250 — one page, and the pagination path never exercised'
            : undefined,
        notRunReason:
          run.counts.created > 250
            ? undefined
            : `the shop holds ${run.counts.created} products; below 251 the run never ` +
              'reaches a second page, so it measures nothing about pagination. Seed ' +
              'more products (runbook §4.1 step 3) and re-run.',
        observations: { run: projectSyncRun(run) },
      });
    }
  }

  if (phase === 'observe') {
    // ── S3 / S4: webhook-driven create, update, delete and edits ──────────────
    const connection = (await readShopifyConnections()).find(
      (entry) => entry.shopDomain === SHOP_DOMAIN,
    );
    if (!connection) throw new Error(`no Shopify connection for ${SHOP_DOMAIN}; run --phase=connect`);

    const since = Date.now();
    await pauseForHuman(
      'In the Shopify admin, on this store:\n' +
        '  1. CREATE a product (any title, one variant, a price)\n' +
        '  2. EDIT it (change the title AND a variant price, add an image)\n' +
        '  3. CHANGE its stock at a location\n' +
        '  4. DELETE it\n' +
        'Do all four, then press ENTER. The driver reads the webhook runs those\n' +
        'produced — it cannot make them happen.',
    );

    // The same one-second skew tolerance `waitForTerminalRun` applies, and for
    // the same reason: `since` is read off THIS machine's clock and `startedAt`
    // off the server's, so a strict comparison drops the driver's own run
    // whenever the server is a few milliseconds behind.
    const runs = (must('GET channels/:id/runs', await client.listRuns(connection.id)) ?? []).filter(
      (run) => run.kind === 'webhook' && Date.parse(run.startedAt) >= since - 1000,
    );
    observations.push({
      id: 'S3+S4',
      title: 'Product create/update/delete and variant/price/image/stock updates over webhooks',
      status: runs.length > 0 ? 'PASSED' : 'FAILED',
      measured: `${runs.length} webhook run(s) recorded after the human actions`,
      wouldReadIfAbsent:
        'zero webhook runs — which is what an unreachable delivery address, a ' +
        'refused topic subscription, or an HMAC mismatch all produce, and all three ' +
        'look identical from here. Cross-check webhookFailures and the tunnel log.',
      error: runs.length > 0 ? undefined : 'no webhook runs appeared',
      observations: {
        runs: runs.map(projectSyncRun),
        webhookFailures: projectConnection(connection).webhookFailures,
      },
    });
    say('');
    say('STILL OWED BY HAND (the driver cannot see these):');
    say('  - the listing appeared, changed, and reached status "archived" (NEVER deleted)');
    say('  - the variant price and gallery followed the Shopify edit');
    say('  - stock followed via inventory_levels/update');
    say('Record each against the listing in the Mercaria dashboard.');
  }

  if (phase === 'orders') {
    // ── S7 / S8 / S10: order import, fulfillment push, native currency ────────
    const connection = (await readShopifyConnections()).find(
      (entry) => entry.shopDomain === SHOP_DOMAIN,
    );
    if (!connection) throw new Error(`no Shopify connection for ${SHOP_DOMAIN}; run --phase=connect`);

    must(
      'PATCH channels/:id/settings',
      await client.updateSyncSettings(connection.id, { orders: 'bidirectional' }),
    );

    await pauseForHuman(
      'In the Shopify admin, place at least TWO test orders on this store\n' +
        '(Bogus Gateway or your provider in test mode — a dev store cannot take\n' +
        'real payments). One paid and unfulfilled, one with a discount and tax.\n' +
        'Then press ENTER.',
    );

    const since = Date.now();
    must('POST channels/:id/sync', await client.requestSync(connection.id));
    const settled = await waitForTerminalRun(
      client,
      connection.id,
      since,
      15 * 60_000,
      'order_sync',
      POLL_INTERVAL_MS,
    );
    const run = settled.run;

    observations.push({
      id: 'S7',
      title: 'Order import + idempotent update',
      status: run?.status === 'completed' ? 'PASSED' : run ? 'FAILED' : 'NOT_RUN',
      measured: run
        ? `order_sync reached "${run.status}" with created=${run.counts.created} ` +
          `updated=${run.counts.updated} skipped=${run.counts.skipped} failed=${run.counts.failed}`
        : undefined,
      wouldReadIfAbsent:
        'created=0 on a completed run — which is also what a shop with no orders ' +
        'in the last 60 DAYS produces, since this app does not hold read_all_orders',
      error: run?.status === 'failed' ? run.error : undefined,
      notRunReason: run
        ? undefined
        : 'no order_sync run appeared within 15 minutes' +
          (settled.lastReadError === null
            ? ''
            : `; the LAST runs read also failed (${settled.lastReadError}), so this is ` +
              'not evidence that no run started'),
      observations: run ? { run: projectSyncRun(run) } : undefined,
    });

    say('');
    say('STILL OWED BY HAND:');
    say('  S7  run the sync a SECOND time after editing an order in Shopify.');
    say('      Expect one Mercaria order per Shopify order and an in-place update.');
    say('  S8  mark a Mercaria order shipped, expect a fulfillment_push run, then');
    say('      confirm in the Shopify admin that the order shows fulfilled WITH');
    say('      tracking, and that a re-push adds NO second fulfillment.');
    say('  S10 inspect an imported variant and order: price.currency must be the');
    say("      SHOP's currency, never FAIR, and DualMoney must carry the platform's");
    say('      own amounts on both sides.');
    say('');
    say('S8 and S10 are left to a person deliberately: the first needs the Shopify');
    say('admin, and the second is a judgement about amounts the driver would have');
    say('to re-implement in order to check — which would measure the copy.');
    observations.push({
      id: 'S8',
      title: 'Fulfillment pushed back',
      status: 'NOT_RUN',
      notRunReason:
        'needs a Mercaria order transitioned to shipped AND confirmation inside the ' +
        'Shopify admin that exactly one fulfillment with tracking appeared. The driver ' +
        'holds no Shopify credential and cannot read the other side.',
    });
    observations.push({
      id: 'S10',
      title: 'Native currency preservation',
      status: 'NOT_RUN',
      notRunReason:
        'a judgement about stored amounts. Checking it here would mean re-implementing ' +
        'the currency rules the connector applies, which measures the re-implementation.',
    });
  }

  if (phase === 'revocation') {
    // ── S9: credential revocation and recovery ────────────────────────────────
    const connection = (await readShopifyConnections()).find(
      (entry) => entry.shopDomain === SHOP_DOMAIN,
    );
    if (!connection) throw new Error(`no Shopify connection for ${SHOP_DOMAIN}; run --phase=connect`);

    await pauseForHuman(
      'In the Shopify admin: Settings -> Apps and sales channels -> UNINSTALL\n' +
        'the Mercaria app. Then press ENTER.\n' +
        'The connector registers NO app/uninstalled webhook, so Mercaria learns of\n' +
        'this only when the next call fails — which is exactly what S9 measures.',
    );

    const since = Date.now();
    must('POST channels/:id/sync', await client.requestSync(connection.id));
    const settled = await waitForTerminalRun(
      client,
      connection.id,
      since,
      10 * 60_000,
      'backfill',
      POLL_INTERVAL_MS,
    );
    const failedRun = settled.run;
    const after = (await readShopifyConnections()).find((entry) => entry.id === connection.id);

    observations.push({
      id: 'S9',
      title: 'Credential revocation and recovery',
      status: failedRun?.status === 'failed' ? 'PASSED' : failedRun ? 'FAILED' : 'NOT_RUN',
      measured: failedRun
        ? `post-uninstall run reached "${failedRun.status}"; connection status ` +
          `"${after?.status ?? 'unknown'}"; the run archived nothing ` +
          `(created=${failedRun.counts.created} updated=${failedRun.counts.updated})`
        : undefined,
      wouldReadIfAbsent:
        'a COMPLETED run that archived the catalogue — which is the failure this ' +
        'scenario exists to catch: a revoked token read as "the shop has no products"',
      notRunReason: failedRun
        ? undefined
        : 'no run appeared within 10 minutes' +
          (settled.lastReadError === null
            ? ''
            : `; the LAST runs read also failed (${settled.lastReadError}), so this is ` +
              'not evidence that no run started'),
      observations: {
        run: failedRun ? projectSyncRun(failedRun) : null,
        connection: after ? projectConnection(after) : null,
      },
    });
    say('');
    say('STILL OWED BY HAND: reinstall the app, re-run --phase=connect, sync again,');
    say('and confirm the catalogue is INTACT — not re-created, not duplicated.');
  }
} finally {
  for (const observation of observations) collector.record(observation);
  if (collector.scenarioCount > 0) {
    const { jsonPath, markdownPath, scan } = await collector.write();
    say('');
    say(`Evidence written (${scan.charactersScanned} characters scanned, no leaks):`);
    say(`  ${jsonPath}`);
    say(`  ${markdownPath}`);
  } else {
    say('');
    say('No observations recorded — nothing written. That is not a pass.');
  }
}
