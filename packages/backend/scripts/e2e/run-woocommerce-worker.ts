/**
 * Drive the WooCommerce scenarios through the REAL worker layer, against the
 * REAL site and the REAL database.
 *
 * ## What this is, and what it is not
 *
 * `runBackfill`, `syncOrders` and `syncInventory` are the WORKER BODIES —
 * `queue/handlers.ts` calls exactly these, and in production a BullMQ job is what
 * invokes them. There is no authentication anywhere inside them, because a
 * queued job has no bearer token: the auth and the `channels:write` gate live in
 * the HTTP route that ENQUEUES, one layer up. So calling them here is not a
 * bypass of anything — it is the production code path for a queued sync, driven
 * directly.
 *
 * `connectWithApiKey` is the same shape: `connectKeyChannelHandler` validates the
 * body, `requireStorePermission('channels:write')` gates it, and then this
 * function does the whole job — verify the credentials against the site, encrypt
 * them, register the platform webhooks, persist.
 *
 * **What is therefore NOT exercised, and must never be read as if it were:** the
 * `/admin/stores/:storeId/channels/*` HTTP routes, `authenticateToken`,
 * `loadStore`, `requireStorePermission`, the request schemas and the rate
 * limiters. Every observation this script produces is labelled with that limit,
 * and `run-woocommerce.ts` remains the driver that exercises the HTTP surface —
 * it needs an Oxy bearer token, which is the one thing this environment cannot
 * mint.
 *
 * It WRITES: it creates a connection, registers webhooks on the merchant's site,
 * and imports a catalogue. Point it only at a disposable site.
 *
 * Run:
 *   set -a; . packages/backend/.env.e2e; set +a
 *   bun run --cwd packages/backend scripts/e2e/run-woocommerce-worker.ts
 */

import { and, eq, sql } from 'drizzle-orm';
import { connectPostgres, getDb } from '../../src/db/postgres.js';
import { listings, productVariants } from '../../src/db/schema/catalog.js';
import {
  connectWithApiKey,
  runBackfill,
  syncOrders,
  toConnectionDTOWithWebhookFailures,
  updateSyncSettings,
} from '../../src/services/connector-sync.service.js';
import { loadWooCredentials, readDriverConfig } from './config.js';
import {
  EvidenceCollector,
  projectConnection,
  projectSyncRun,
  type JsonValue,
} from './evidence.js';
import { redactIdentifier, redactUrl, SecretRegistry } from './redact.js';
import { WOOCOMMERCE_SCENARIOS, type ScenarioSpec } from './scenarios.js';
import type { SyncRun } from '@mercaria/shared-types';
import { seedVerificationContext } from './setup.js';
import { censusSite } from './site-capabilities.js';

/** The limitation every observation from this driver carries. */
const SURFACE_NOTE =
  'admin surface not exercised (Oxy auth unavailable) — driven through the REAL ' +
  'worker/service layer (the functions a BullMQ job calls) against the real site and real ' +
  'Postgres; the HTTP admin route, `authenticateToken`, `loadStore` and ' +
  '`requireStorePermission` were NOT exercised';

const spec = (id: string): ScenarioSpec => WOOCOMMERCE_SCENARIOS.find((s) => s.id === id);

/**
 * A `sync_runs` ROW as the `SyncRun` DTO.
 *
 * `runBackfill` returns the row (four flat `counts*` columns) while the HTTP
 * surface returns the DTO (a nested `counts`). Projecting here rather than
 * reading the columns straight into evidence keeps ONE shape in the artefact, so
 * a run recorded by this driver and one recorded by `run-woocommerce.ts` are
 * comparable rather than merely similar.
 */
function rowToSyncRun(row: {
  id: string;
  connectionId: string;
  kind: string;
  status: string;
  countsCreated: number;
  countsUpdated: number;
  countsSkipped: number;
  countsFailed: number;
  startedAt: Date;
  finishedAt?: Date | null;
  error?: string | null;
}): SyncRun {
  return {
    id: row.id,
    connectionId: row.connectionId,
    kind: row.kind as SyncRun['kind'],
    status: row.status as SyncRun['status'],
    counts: {
      created: row.countsCreated,
      updated: row.countsUpdated,
      skipped: row.countsSkipped,
      failed: row.countsFailed,
    },
    startedAt: row.startedAt?.toISOString?.() ?? String(row.startedAt),
    ...(row.finishedAt ? { finishedAt: row.finishedAt.toISOString() } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

async function main(): Promise<void> {
  const config = readDriverConfig();
  const credentials = await loadWooCredentials(config.wooCredentialsFile);
  if (credentials.outcome !== 'available') {
    process.stdout.write(`WooCommerce credentials unavailable (${credentials.outcome}).\n`);
    process.exitCode = 1;
    return;
  }
  const woo = credentials.credentials;

  const registry = new SecretRegistry();
  registry.register('database url', config.databaseUrl);
  registry.register('woocommerce consumer key', woo.consumerKey);
  registry.register('woocommerce consumer secret', woo.consumerSecret);

  const runLabel = `woocommerce-worker-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const collector = new EvidenceCollector(registry, config.evidenceDir, runLabel);

  await connectPostgres();
  const census = await censusSite(woo);

  // The store's owner is a synthetic Oxy id: Oxy owns identity and this column
  // carries no foreign key, so a store can exist for an account this deployment
  // cannot authenticate. It is what makes the worker layer reachable at all here
  // — and precisely why the HTTP surface is not.
  const oxyUserId = config.oxyUserId ?? 'e2e-worker-driver-no-oxy-session';
  const seeded = await seedVerificationContext({
    oxyUserId,
    categorySlug: config.defaultCategorySlug,
  });
  const storeId = seeded.store.id;

  collector.describeEnvironment({
    surface: SURFACE_NOTE,
    database: new URL(config.databaseUrl).pathname.replace(/^\//, ''),
    wooSite: redactUrl(woo.siteUrl),
    storeId: redactIdentifier(storeId),
    storeDefaultCurrency: seeded.store.defaultCurrency,
    siteCensus: { ...census } as unknown as JsonValue,
  });
  collector.note(
    `Site census: ${census.totalProducts} products (${census.variableProducts} variable), ` +
      `${census.totalOrders} orders, largest declared variation set ${census.maxDeclaredVariations}, ` +
      `X-WP-TotalPages published: ${census.publishesTotalPagesHeader}.`,
  );

  // Webhook registration is best-effort inside `connectWithApiKey` and needs the
  // PUBLIC delivery address. Without it the connection still reaches `connected`
  // with zero webhook ids — which must not be read as "the site refused them".
  if (!config.publicBaseUrl) {
    collector.note(
      'CONNECTOR_OAUTH_REDIRECT_BASE_URL is NOT configured in this run, so ' +
        '`registerWebhooks` failed with a configuration error before reaching the site. ' +
        'A connection therefore reads `connected` with ZERO webhook ids and ZERO refused ' +
        'topics — the absence is Mercaria\'s own missing configuration, NOT a refusal by ' +
        'the site, and W7/X1 cannot be judged from it.',
    );
  }

  // --- W1 -------------------------------------------------------------------
  const connection = await connectWithApiKey(storeId, 'woocommerce', {
    shopDomain: woo.siteUrl,
    consumerKey: woo.consumerKey,
    consumerSecret: woo.consumerSecret,
  });
  const dto = await toConnectionDTOWithWebhookFailures(connection);
  const wooRowCount = await countConnections(storeId);

  collector.record({
    id: 'W1',
    title: spec('W1').title,
    status: dto.status === 'connected' && wooRowCount === 1 ? 'PASSED' : 'FAILED',
    measured:
      `connection status \`${dto.status}\`, shopCurrency \`${dto.shopCurrency}\` (the site's own), ` +
      `${wooRowCount} WooCommerce connection row(s), ${dto.webhookIds.length} webhook id(s), ` +
      `${(dto.webhookFailures ?? []).length} refused topic(s) — ${SURFACE_NOTE}`,
    wouldReadIfAbsent: spec('W1').wouldReadIfAbsent,
    ...(dto.status === 'connected' && wooRowCount === 1
      ? {}
      : { error: `status=${dto.status} rows=${wooRowCount}` }),
    observations: { connection: projectConnection(dto) as JsonValue },
  });

  if (dto.status !== 'connected') {
    await finish(collector);
    return;
  }

  // --- W2 / W3 / W8: one backfill, three questions ---------------------------
  await updateSyncSettings(storeId, connection.id, { products: 'pull', inventory: 'pull' });
  const startedAt = Date.now();
  const backfill = await runBackfill(storeId, connection.id);
  const wallClockMs = Date.now() - startedAt;

  const backfillRun = rowToSyncRun(backfill as never);
  const imported = await countListings(storeId);
  const variantHistogram = await variantCountHistogram(storeId);
  const currencies = await distinctVariantCurrencies(storeId);

  collector.record({
    id: 'W2',
    title: spec('W2').title,
    status: backfill.status === 'completed' ? 'PASSED' : 'FAILED',
    measured:
      `backfill \`${backfillRun.status}\` in ${wallClockMs}ms with counts created=` +
      `${backfillRun.counts.created} updated=${backfillRun.counts.updated} skipped=` +
      `${backfillRun.counts.skipped} failed=${backfillRun.counts.failed}; ${imported} listing(s) in ` +
      `Postgres afterwards, variant-count histogram ${JSON.stringify(variantHistogram)} — ` +
      SURFACE_NOTE,
    wouldReadIfAbsent: spec('W2').wouldReadIfAbsent,
    ...(backfill.status === 'completed' ? {} : { error: backfill.error ?? backfill.status }),
    observations: {
      run: projectSyncRun(backfillRun) as JsonValue,
      wallClockMs,
      listingsInPostgres: imported,
      variantCountHistogram: variantHistogram as unknown as JsonValue,
      siteProducts: census.totalProducts,
    },
  });

  collector.record({
    id: 'W3',
    title: spec('W3').title,
    status: imported > 100 ? 'PASSED' : 'FAILED',
    measured:
      `${imported} listing(s) imported from a site holding ${census.totalProducts} products, in ` +
      `${wallClockMs}ms — more than the 100-row page limit, so the enumeration continued past ` +
      `page 1. No 429 surfaced (the run reached \`${backfill.status}\`) — ${SURFACE_NOTE}`,
    wouldReadIfAbsent: spec('W3').wouldReadIfAbsent,
    ...(imported > 100 ? {} : { error: `only ${imported} listing(s) imported` }),
    observations: { listingsInPostgres: imported, siteProducts: census.totalProducts, wallClockMs },
  });

  const largestVariantSet = Math.max(0, ...Object.keys(variantHistogram).map(Number));
  collector.record({
    id: 'W8',
    title: spec('W8').title,
    status: largestVariantSet > 100 ? 'PASSED' : 'FAILED',
    measured:
      `the site's largest variable product declares ${census.maxDeclaredVariations} variations; ` +
      `the largest variant set in Postgres after the backfill is ${largestVariantSet} — ` +
      SURFACE_NOTE,
    wouldReadIfAbsent: spec('W8').wouldReadIfAbsent,
    ...(largestVariantSet > 100
      ? {}
      : {
          error:
            `largest imported variant set is ${largestVariantSet} against ` +
            `${census.maxDeclaredVariations} declared on the site`,
        }),
    observations: {
      declaredOnSite: census.maxDeclaredVariations,
      largestImportedVariantSet: largestVariantSet,
    },
  });

  // --- W6 -------------------------------------------------------------------
  collector.record({
    id: 'W6',
    title: spec('W6').title,
    status: currencies.length === 1 && currencies[0] === dto.shopCurrency ? 'PASSED' : 'FAILED',
    measured:
      `every imported variant is priced in \`${currencies.join('/')}\`, against the site's own ` +
      `\`${dto.shopCurrency}\` and the STORE's default \`${seeded.store.defaultCurrency}\` — ` +
      SURFACE_NOTE,
    wouldReadIfAbsent: spec('W6').wouldReadIfAbsent,
    ...(currencies.length === 1 && currencies[0] === dto.shopCurrency
      ? {}
      : { error: `variant currencies were ${JSON.stringify(currencies)}` }),
    observations: {
      variantCurrencies: currencies,
      siteCurrency: dto.shopCurrency,
      storeDefaultCurrency: seeded.store.defaultCurrency,
    },
  });

  // --- W5 -------------------------------------------------------------------
  await updateSyncSettings(storeId, connection.id, { orders: 'pull' });
  const orderRun = rowToSyncRun((await syncOrders(storeId, connection.id)) as never);
  const orderCount = await countOrders(storeId);
  collector.record({
    id: 'W5',
    title: spec('W5').title,
    status:
      orderRun.status === 'completed' && orderCount === census.totalOrders ? 'PASSED' : 'FAILED',
    measured:
      `order sync \`${orderRun.status}\`; ${orderCount} Mercaria order(s) against ` +
      `${census.totalOrders} on the site — ${SURFACE_NOTE}`,
    wouldReadIfAbsent: spec('W5').wouldReadIfAbsent,
    ...(orderRun.status === 'completed' && orderCount === census.totalOrders
      ? {}
      : { error: orderRun.error ?? `${orderCount} order(s) against ${census.totalOrders}` }),
    observations: {
      run: projectSyncRun(orderRun) as JsonValue,
      mercariaOrders: orderCount,
      siteOrders: census.totalOrders,
    },
  });

  await finish(collector);
}

/** Write the artefact and report. */
async function finish(collector: EvidenceCollector): Promise<void> {
  const { jsonPath, markdownPath, scan } = await collector.write();
  process.stdout.write(
    `\nEvidence written:\n  ${jsonPath}\n  ${markdownPath}\n` +
      `Redaction scan: ${scan.charactersScanned} chars, ${scan.registeredSecrets} secrets, ` +
      `${scan.leaks.length} leaks.\n`,
  );
}

async function countConnections(storeId: string): Promise<number> {
  const rows = await getDb().execute(
    sql`select count(*)::int as n from connections where store_id = ${storeId} and provider = 'woocommerce'`,
  );
  return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
}

async function countListings(storeId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(listings)
    .where(eq(listings.storeId, storeId));
  return Number(rows[0]?.n ?? 0);
}

async function countOrders(storeId: string): Promise<number> {
  const rows = await getDb().execute(
    sql`select count(*)::int as n from orders where store_id = ${storeId}`,
  );
  return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
}

/** How many listings have N variants, keyed by N. */
async function variantCountHistogram(storeId: string): Promise<Record<string, number>> {
  const rows = (await getDb().execute(sql`
    select variant_count::text as k, count(*)::int as n
    from (
      select l.id, count(v.id) as variant_count
      from listings l left join product_variants v on v.listing_id = l.id
      where l.store_id = ${storeId}
      group by l.id
    ) t
    group by variant_count
    order by variant_count
  `)) as unknown as Array<{ k: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.k, Number(r.n)]));
}

/** The distinct currencies every imported variant is priced in. */
async function distinctVariantCurrencies(storeId: string): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ currency: productVariants.priceCurrency })
    .from(productVariants)
    .innerJoin(listings, eq(productVariants.listingId, listings.id))
    .where(and(eq(listings.storeId, storeId)));
  return rows.map((r) => r.currency).filter(Boolean).sort();
}

await main();
