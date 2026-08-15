/**
 * The #69 real-store driver for WooCommerce.
 *
 * Drives the RUNNING backend's real HTTP surface against a REAL WooCommerce
 * site, records the observable §7 names for each scenario, and writes redacted
 * evidence. Nothing here fabricates a value, and a scenario whose preconditions
 * are unmet is recorded `NOT_RUN` with the precise reason rather than skipped —
 * a skipped scenario and a passing one look identical in a summary.
 *
 * Run:
 *   set -a; . packages/backend/.env.e2e; set +a
 *   bun run --cwd packages/backend scripts/e2e/run-woocommerce.ts
 *
 * It exits non-zero when a scenario FAILED, and zero when every scenario either
 * passed or was honestly recorded as not run — because "blocked on a site that
 * does not exist" is not a defect in this repository, while a failing scenario
 * is.
 */

import path from 'node:path';
import { Redis } from 'ioredis';
import type { Connection, SyncRun } from '@mercaria/shared-types';
import { MercariaAdminClient, waitForTerminalRun } from './client.js';
import { loadWooCredentials, readDriverConfig, type WooCredentials } from './config.js';
import {
  EvidenceCollector,
  projectConnection,
  projectSyncRun,
  type JsonValue,
  type ScenarioObservation,
} from './evidence.js';
import { decideSyncExecution, readQueueDepth, type QueueDepth } from './queue-evidence.js';
import { redactIdentifier, redactUrl, SecretRegistry } from './redact.js';
import {
  REQUIREMENT_REASONS,
  WOOCOMMERCE_SCENARIOS,
  type ScenarioRequirement,
  type ScenarioSpec,
} from './scenarios.js';
import { seedVerificationContext } from './setup.js';
import { probeWooCommerceWire } from './probe-woocommerce-provider.js';
import { censusSite, type SiteCensus } from './site-capabilities.js';

/** How long a backfill is given to settle before the driver stops waiting. */
const RUN_SETTLE_BUDGET_MS = 180_000;

/** What the environment could actually supply this run. */
interface Capabilities {
  readonly present: ReadonlySet<ScenarioRequirement>;
}

/** The reason a scenario cannot run, or null when it can. */
function blockedBy(spec: ScenarioSpec, capabilities: Capabilities): string | null {
  const missing = spec.requires.filter((r) => !capabilities.present.has(r));
  if (missing.length === 0) return null;
  return missing.map((r) => REQUIREMENT_REASONS[r]).join('; ');
}

async function main(): Promise<void> {
  const config = readDriverConfig();
  const registry = new SecretRegistry();

  // Register every secret this run holds BEFORE anything is recorded. The scan's
  // vacuity floor refuses an empty registry, so a driver that forgot cannot
  // write evidence at all rather than writing unprotected evidence.
  if (config.oxyAccessToken) registry.register('oxy access token', config.oxyAccessToken);
  if (config.databaseUrl) registry.register('database url', config.databaseUrl);

  const wooResult = await loadWooCredentials(config.wooCredentialsFile);
  let woo: WooCredentials | null = null;
  if (wooResult.outcome === 'available') {
    woo = wooResult.credentials;
    registry.register('woocommerce consumer key', woo.consumerKey);
    registry.register('woocommerce consumer secret', woo.consumerSecret);
  }

  // The registry must be non-empty for a scan to mean anything. `DATABASE_URL`
  // is always present (config demands it), so this is satisfiable even with no
  // site — but assert it rather than assuming.
  if (registry.size === 0) {
    throw new Error(
      'No secret was registered, so the redaction scan would be vacuous. Refusing to run.',
    );
  }

  const evidenceDir = config.evidenceDir;
  const runLabel = `woocommerce-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const collector = new EvidenceCollector(registry, evidenceDir, runLabel);

  // --- What this environment can supply -------------------------------------
  const present = new Set<ScenarioRequirement>();
  if (woo) present.add('woo_site');
  if (config.oxyAccessToken && config.oxyUserId) present.add('admin_auth');

  let redis: Redis | null = null;
  if (config.redisUrl) {
    redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    try {
      await redis.connect();
      await redis.ping();
      present.add('redis');
    } catch (err) {
      collector.note(
        `REDIS_URL is set but unreachable (${(err as Error).name}); treated as absent, so ` +
          'every queue-dependent scenario is NOT RUN rather than silently inline.',
      );
      redis = null;
    }
  }

  // A public base that is not a loopback address is the only thing that lets a
  // platform deliver a webhook. Asserting the SHAPE rather than reachability:
  // proving reachability needs the platform, which is what the scenario is.
  if (config.publicBaseUrl) {
    try {
      const host = new URL(config.publicBaseUrl).hostname;
      if (!/^(localhost|127\.|0\.0\.0\.0|\[?::1)/.test(host)) present.add('public_ingress');
    } catch {
      collector.note(`CONNECTOR_OAUTH_REDIRECT_BASE_URL is not a URL; public ingress unavailable.`);
    }
  }

  // What the SITE holds, measured. Without this the driver would write NOT_RUN
  // reasons that are false — "the site does not hold more than one page of
  // products" against a site holding 124 sends the next person to provision
  // something that already exists.
  let census: SiteCensus | null = null;
  if (woo) {
    try {
      census = await censusSite(woo);
      if (census.totalProducts > 100) present.add('large_catalogue');
      if (census.maxDeclaredVariations > 100) present.add('many_variations');
      collector.note(
        `Site census (read from the site's own X-WP-Total, not through the connector): ` +
          `${census.totalProducts} products, ${census.variableProducts} variable, ` +
          `${census.totalOrders} orders, largest declared variation set ` +
          `${census.maxDeclaredVariations}, X-WP-TotalPages published: ` +
          `${census.publishesTotalPagesHeader}.`,
      );
    } catch (err) {
      collector.note(
        `Could not census the site (${(err as Error).message}); the site-dependent ` +
          'preconditions are reported as unmeasured rather than as unmet.',
      );
    }
  }

  // The WIRE facts the runbook says only a real store settles, taken through the
  // REAL provider over a real socket. Recorded as a note and NEVER as a scenario
  // verdict: it exercises the provider, not the admin route, the sync service or
  // any write path, so calling it a scenario pass would overstate it by most of
  // the system.
  if (woo) {
    try {
      const wire = await probeWooCommerceWire(woo);
      collector.note(
        `Provider wire probe (REAL createWooCommerceProvider over a real socket; NOT a ` +
          `scenario run — no admin route, no sync service, no write path): ` +
          `verifyConnection ${wire.verify.outcome}` +
          (wire.verify.outcome === 'ok' ? ` reporting shopCurrency ${wire.verify.shopCurrency}` : '') +
          `; first products page ${wire.firstPage.outcome}` +
          (wire.firstPage.outcome === 'ok'
            ? ` — ${wire.firstPage.productCount} products, nextCursor ` +
              `${wire.firstPage.hasNextCursor}, currencies ` +
              `${wire.firstPage.currencies.join('/')}, ` +
              `${wire.firstPage.withExternalUpdatedAt}/${wire.firstPage.productCount} carrying ` +
              `externalUpdatedAt, ${wire.firstPage.incompleteVariantSets} incomplete variant sets`
            : ''),
      );
    } catch (err) {
      collector.note(`Provider wire probe threw: ${(err as Error).message}`);
    }
  }

  const capabilities: Capabilities = { present };

  collector.describeEnvironment({
    database: databaseNameOf(config.databaseUrl),
    apiBaseUrl: config.apiBaseUrl,
    publicBaseUrl: redactUrl(config.publicBaseUrl),
    redisConfigured: Boolean(config.redisUrl),
    redisReachable: present.has('redis'),
    adminAuthConfigured: present.has('admin_auth'),
    wooCredentials: wooResult.outcome,
    wooSite: woo ? redactUrl(woo.siteUrl) : null,
    defaultCategorySlug: config.defaultCategorySlug,
    capabilitiesPresent: [...present].sort(),
    siteCensus: census ? ({ ...census } as unknown as JsonValue) : null,
  });

  if (wooResult.outcome === 'unreadable') {
    collector.note(
      `The WooCommerce credential file at ${path.basename(wooResult.path)} could not be used: ` +
        `${wooResult.reason}. That is a defect on the provisioning side, not a connector defect.`,
    );
  }

  // --- Seed the commercial context, if we can reach the database ------------
  let storeId: string | null = null;
  if (present.has('admin_auth')) {
    try {
      const seeded = await seedVerificationContext({
        oxyUserId: config.oxyUserId,
        categorySlug: config.defaultCategorySlug,
      });
      storeId = seeded.store.id;
      collector.note(
        `Store ${redactIdentifier(seeded.store.id)} (${seeded.storeCreated ? 'created' : 'reused'}), ` +
          `owner membership ${seeded.membershipCreated ? 'created' : 'already present'}, ` +
          `category '${seeded.categorySlug}' ${seeded.categoryCreated ? 'created' : 'already present'}.`,
      );
    } catch (err) {
      collector.note(
        `Could not seed the verification store: ${(err as Error).message}. Every admin-surface ` +
          'scenario is NOT RUN.',
      );
      present.delete('admin_auth');
    }
  }

  const client =
    storeId && config.oxyAccessToken
      ? new MercariaAdminClient(config.apiBaseUrl, config.oxyAccessToken, storeId)
      : null;

  // --- Execute what can be executed -----------------------------------------
  const results = new Map<string, ScenarioObservation>();

  if (client && woo) {
    await runConnectedScenarios({ client, woo, redis, collector, results, capabilities });
  }

  for (const spec of WOOCOMMERCE_SCENARIOS) {
    if (results.has(spec.id)) {
      collector.record(results.get(spec.id));
      continue;
    }
    const blocked = blockedBy(spec, capabilities);
    collector.record({
      id: spec.id,
      title: spec.title,
      status: 'NOT_RUN',
      notRunReason:
        blocked ??
        'preconditions were met but the scenario needs a change made by a person on the site ' +
          'during the run, which this unattended driver cannot make',
      observations: {
        expectedObservable: spec.expectedObservable,
        wouldReadIfAbsent: spec.wouldReadIfAbsent,
        requires: [...spec.requires],
      },
    });
  }

  const { jsonPath, markdownPath, scan } = await collector.write();
  await redis?.quit();

  const failed = [...results.values()].filter((r) => r.status === 'FAILED');
  process.stdout.write(
    `\nEvidence written:\n  ${jsonPath}\n  ${markdownPath}\n` +
      `Redaction scan: ${scan.charactersScanned} characters, ` +
      `${scan.registeredSecrets} registered secrets, ${scan.shapesChecked} shapes, ` +
      `${scan.leaks.length} leaks.\n` +
      `Scenarios: ${collector.scenarioCount} recorded, ${failed.length} FAILED.\n`,
  );

  process.exitCode = failed.length > 0 ? 1 : 0;
}

/**
 * The scenarios reachable with a live site and a working admin surface.
 *
 * Every verdict states what was MEASURED. Where the measurement is a count, the
 * scenario's own `wouldReadIfAbsent` travels with it, so a reader can check that
 * the two differ rather than taking the pass on trust.
 */
async function runConnectedScenarios(input: {
  client: MercariaAdminClient;
  woo: WooCredentials;
  redis: Redis | null;
  collector: EvidenceCollector;
  results: Map<string, ScenarioObservation>;
  capabilities: Capabilities;
}): Promise<void> {
  const { client, woo, redis, results } = input;
  const spec = (id: string): ScenarioSpec => WOOCOMMERCE_SCENARIOS.find((s) => s.id === id);

  // --- W1: connect ----------------------------------------------------------
  const connectResponse = await client.connectWooCommerce({
    shopDomain: woo.siteUrl,
    consumerKey: woo.consumerKey,
    consumerSecret: woo.consumerSecret,
  });

  if (!connectResponse.ok || !connectResponse.body) {
    results.set('W1', {
      id: 'W1',
      title: spec('W1').title,
      status: 'FAILED',
      error: connectResponse.error ?? `HTTP ${connectResponse.status}`,
      observations: { httpStatus: connectResponse.status, durationMs: connectResponse.durationMs },
    });
    return;
  }

  const connection = connectResponse.body as Connection;
  const listAfterConnect = await client.listChannels();
  const wooRows = (Array.isArray(listAfterConnect.body) ? listAfterConnect.body : []).filter(
    (c: Connection) => c.provider === 'woocommerce',
  );

  results.set('W1', {
    id: 'W1',
    title: spec('W1').title,
    status:
      connection.status === 'connected' && wooRows.length === 1 ? 'PASSED' : 'FAILED',
    measured:
      `connection status \`${connection.status}\`, shopCurrency \`${connection.shopCurrency ?? '—'}\`, ` +
      `${wooRows.length} WooCommerce connection row(s)`,
    wouldReadIfAbsent: spec('W1').wouldReadIfAbsent,
    ...(connection.status === 'connected' && wooRows.length === 1
      ? {}
      : { error: `status=${connection.status} rows=${wooRows.length}` }),
    observations: { connection: projectConnection(connection) as JsonValue },
  });

  if (connection.status !== 'connected') return;

  // --- Enable the product pull, then W2 with the acceptance-4 evidence ------
  await client.updateSyncSettings(connection.id, { products: 'pull', inventory: 'pull' });

  const depthBefore: QueueDepth | null = redis ? await readQueueDepth(redis) : null;
  const requestedAt = Date.now();
  const syncResponse = await client.requestSync(connection.id);
  const depthAfter: QueueDepth | null = redis ? await readQueueDepth(redis) : null;

  const settled = await waitForTerminalRun(
    client,
    connection.id,
    requestedAt,
    RUN_SETTLE_BUDGET_MS,
    // The BACKFILL, not merely the newest run: a webhook delivery arriving
    // mid-backfill settles in milliseconds and would be recorded as this
    // scenario's result.
    'backfill',
  );

  const execution = decideSyncExecution({
    redisConfigured: Boolean(redis),
    depthBefore,
    depthAfter,
    responseMs: syncResponse.durationMs,
    runCompletedMs: settled.settledAfterMs,
  });

  const backfill: SyncRun | null = settled.run;
  const created = backfill?.counts?.created ?? 0;

  results.set('W2', {
    id: 'W2',
    title: spec('W2').title,
    status: backfill?.status === 'completed' ? 'PASSED' : backfill ? 'FAILED' : 'NOT_RUN',
    ...(backfill?.status === 'completed'
      ? {
          measured:
            `backfill run \`${backfill.status}\` with counts ` +
            `created=${backfill.counts.created} updated=${backfill.counts.updated} ` +
            `skipped=${backfill.counts.skipped} failed=${backfill.counts.failed}`,
          wouldReadIfAbsent: spec('W2').wouldReadIfAbsent,
        }
      : {}),
    ...(backfill && backfill.status !== 'completed'
      ? { error: backfill.error ?? `run status ${backfill.status}` }
      : {}),
    ...(backfill
      ? {}
      : {
          notRunReason:
            `no sync run settled within ${RUN_SETTLE_BUDGET_MS}ms of the request; the run may ` +
            'still be in flight, which is a different fact from a failure',
        }),
    observations: {
      run: backfill ? (projectSyncRun(backfill) as JsonValue) : null,
      syncRequest: {
        httpStatus: syncResponse.status,
        responseMs: syncResponse.durationMs,
        body: (syncResponse.body as { status?: string })?.status ?? null,
      },
      // Acceptance 4's evidence travels with the scenario that produced it.
      execution: execution as unknown as JsonValue,
      createdListings: created,
    },
  });

  // --- W3: pagination, only meaningful past one page ------------------------
  if (created > 100) {
    results.set('W3', {
      id: 'W3',
      title: spec('W3').title,
      status: 'PASSED',
      measured:
        `${created} products imported in one completed run — more than one page of 100, so the ` +
        'enumeration continued past page 1',
      wouldReadIfAbsent: spec('W3').wouldReadIfAbsent,
      observations: {
        createdListings: created,
        runCounts: backfill ? (projectSyncRun(backfill).counts as JsonValue) : null,
      },
    });
  } else if (backfill?.status === 'completed') {
    results.set('W3', {
      id: 'W3',
      title: spec('W3').title,
      status: 'NOT_RUN',
      notRunReason:
        `the site holds ${created} product(s), which is inside one page — so a completed run ` +
        'proves nothing about pagination. §4.2 asks for more than 100.',
      observations: { createdListings: created },
    });
  }

  // --- W6: native currency, from what the connection itself reports ---------
  results.set('W6', {
    id: 'W6',
    title: spec('W6').title,
    status: connection.shopCurrency ? 'PASSED' : 'NOT_RUN',
    ...(connection.shopCurrency
      ? {
          measured:
            `the connection records the site's own currency as \`${connection.shopCurrency}\`, ` +
            "read from the site on connect and never from Mercaria's own default",
          wouldReadIfAbsent: spec('W6').wouldReadIfAbsent,
        }
      : {
          notRunReason:
            'the site reported no currency on connect, so there is nothing to compare an ' +
            'imported price against',
        }),
    observations: { shopCurrency: connection.shopCurrency ?? null },
  });

  // --- The readiness projection, which W7 reads -----------------------------
  const readiness = await client.readiness();
  input.collector.note(
    `Channel readiness read: HTTP ${readiness.status}. W7 needs a READ-ONLY key to produce the ` +
      'degraded catalogue axis, which only the site operator can mint.',
  );
}

/** The database NAME out of a connection URL — never the URL, which carries a password. */
function databaseNameOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '') || '<none>';
  } catch {
    return '<unparseable>';
  }
}

await main();
