/**
 * The offer comparison reads at scale — issue #57, indexes and scale item 6.
 *
 * Opt-in and OUT of the normal suite, deliberately. A million-row generator in
 * CI is a twenty-minute job that tells everybody nothing on every commit; what
 * the issue actually asks for is a number somebody measured, on a shape somebody
 * chose, that can be re-measured when the shape changes. So this is a script,
 * it seeds a database you name, and it prints plans and timings you can paste.
 *
 * ## Running it
 *
 * ```sh
 * # Against the local compose server (docker compose -f docker-compose.postgres.yml up -d postgres)
 * cd packages/backend
 * OFFER_BENCHMARK=1 \
 *   DATABASE_URL=postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_bench \
 *   bun run scripts/offer-load-benchmark.ts --offers=1000000 --products=25000
 * ```
 *
 * The database must already exist and be migrated:
 *
 * ```sh
 * bun run db:migrate -- --target-database=mercaria_bench --phase=all
 * ```
 *
 * `OFFER_BENCHMARK=1` is a second gate on top of the explicit invocation,
 * because this script WRITES A MILLION ROWS and the one thing it must never do
 * is run against a database somebody thought was safe. It refuses a
 * `DATABASE_URL` whose database name does not contain `bench`, for the same
 * reason: `--target-database` exists because a migrator pointed at the wrong
 * database prints a success line, and a seeder pointed at the wrong one is
 * strictly worse.
 *
 * ## The distribution, and why it is skewed
 *
 * Real offer data is not uniform: a handful of popular variants carry hundreds
 * of offers and the long tail carries one or two. A uniform seed makes every
 * comparison read touch the same tiny number of rows and reports a latency the
 * production shape will never see. `--zipf` (default 1.1) shapes the per-product
 * offer count, so the hottest variant in a million-row seed carries thousands
 * and the median carries a handful — and the benchmark reports BOTH, because the
 * median is the answer a product page gets and the maximum is the answer the
 * worst page gets.
 */

import { sql } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, type Database } from '../src/db/postgres.js';
import { canonicalProducts, canonicalVariants } from '../src/db/schema/canonicalCatalog.js';
import { merchants } from '../src/db/schema/merchants.js';
import { offers } from '../src/db/schema/offers.js';

interface BenchmarkOptions {
  offers: number;
  products: number;
  merchants: number;
  zipf: number;
  batch: number;
}

function parseOptions(argv: readonly string[]): BenchmarkOptions {
  const read = (name: string, fallback: number): number => {
    const raw = argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`--${name} must be a positive number, got ${raw}`);
    }
    return value;
  };
  return {
    offers: Math.floor(read('offers', 1_000_000)),
    products: Math.floor(read('products', 25_000)),
    // The CEILING on how many offers one variant can carry, and it is not a
    // tuning knob: `offers_active_commercial_key` admits one active offer per
    // (variant, merchant, storefront, condition), so a variant cannot hold more
    // active offers than there are sellers. Seeding past it would not produce a
    // hotter variant, it would produce a unique violation.
    merchants: Math.floor(read('merchants', 500)),
    zipf: read('zipf', 1.1),
    batch: Math.floor(read('batch', 1_000)),
  };
}

/**
 * Refuse to run anywhere that is not obviously a scratch database.
 *
 * Two independent gates, because either alone is one mistake away from a seeded
 * production table: the env flag says "I meant to run a benchmark" and the name
 * check says "and this is the database I meant to run it on".
 */
function assertSafeTarget(): string {
  if (process.env.OFFER_BENCHMARK !== '1') {
    throw new Error(
      'Refusing to run: set OFFER_BENCHMARK=1. This script writes hundreds of thousands of rows.',
    );
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Refusing to run: DATABASE_URL is not set.');
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.includes('bench')) {
    throw new Error(
      `Refusing to run against "${databaseName}": the database name must contain "bench". ` +
        'Create a scratch database and migrate it first.',
    );
  }
  return databaseName;
}

/**
 * A Zipf-shaped share of the offers for rank `index` out of `count`.
 *
 * Not drawn at random: the shares are computed once and the seeder walks them,
 * so a run is reproducible and the reported per-product maximum is a fact about
 * the seed rather than about the seed's luck.
 */
function zipfShares(count: number, exponent: number): number[] {
  const weights = Array.from({ length: count }, (_, index) => 1 / (index + 1) ** exponent);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

interface Fixtures {
  canonicalVariantIds: string[];
  merchantIds: string[];
  storefrontId: string;
  sourceRecordId: string;
}

/**
 * Seed the graph the offers hang off.
 *
 * One storefront and one source record for every offer: neither is what the
 * comparison read scans, and giving each offer its own would make the seed
 * dominated by rows the benchmark does not measure.
 */
async function seedFixtures(db: Database, options: BenchmarkOptions): Promise<Fixtures> {
  const run = uuidv7().slice(-8);
  process.stdout.write(`Seeding ${String(options.products)} canonical products…\n`);

  const canonicalVariantIds: string[] = [];
  for (let start = 0; start < options.products; start += options.batch) {
    const size = Math.min(options.batch, options.products - start);
    const products = Array.from({ length: size }, (_, offset) => {
      const index = start + offset;
      return {
        id: uuidv7(),
        slug: `bench-p-${run}-${String(index)}`,
        name: `Bench product ${String(index)}`,
        normalizedName: `bench product ${String(index)}`,
      };
    });
    await db.insert(canonicalProducts).values(products);

    const variants = products.map((product) => ({
      id: uuidv7(),
      productId: product.id,
      signature: uuidv7().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
    }));
    await db.insert(canonicalVariants).values(variants);
    canonicalVariantIds.push(...variants.map((row) => row.id));
  }

  const merchantIds: string[] = [];
  for (let start = 0; start < options.merchants; start += options.batch) {
    const size = Math.min(options.batch, options.merchants - start);
    const rows = Array.from({ length: size }, (_, offset) => ({
      id: uuidv7(),
      name: `Bench merchant ${String(start + offset)}`,
      slug: `bench-m-${run}-${String(start + offset)}`,
    }));
    await db.insert(merchants).values(rows);
    merchantIds.push(...rows.map((row) => row.id));
  }

  const storefrontId = uuidv7();
  await db.execute(sql`
    insert into storefronts (id, merchant_id, name, slug, channel_kind)
    values (${storefrontId}, ${merchantIds[0] ?? ''}, ${'Bench channel'},
            ${`bench-sf-${run}`}, 'marketplace')`);

  const sourceId = uuidv7();
  await db.execute(sql`
    insert into catalog_sources (id, kind, name, may_display, may_store, attribution_required)
    values (${sourceId}, 'feed', ${`bench-source-${run}`}, true, true, false)`);
  const sourceRecordId = uuidv7();
  await db.execute(sql`
    insert into source_records (id, source_id, external_type, external_id, observed_at, content_hash)
    values (${sourceRecordId}, ${sourceId}, 'offer', ${`bench-ext-${run}`}, now(),
            ${uuidv7().replace(/-/g, '').padEnd(64, 'a').slice(0, 64)})`);

  return { canonicalVariantIds, merchantIds, storefrontId, sourceRecordId };
}

/** Seed the offers themselves, Zipf-distributed across the variants. */
async function seedOffers(
  db: Database,
  options: BenchmarkOptions,
  fixtures: Fixtures,
): Promise<{ median: number; max: number }> {
  const cap = fixtures.merchantIds.length;
  const shares = zipfShares(fixtures.canonicalVariantIds.length, options.zipf);
  const perVariant = shares.map((share) =>
    Math.min(cap, Math.max(1, Math.round(share * options.offers))),
  );

  /**
   * Top up from the tail until the target is met.
   *
   * The raw Zipf shape wants tens of thousands of offers on its hottest variant
   * and the commercial-key unique admits at most one per seller, so the head is
   * CLAMPED and the shortfall is redistributed. Without this the run silently
   * seeds a fraction of what was asked for and every latency below is measured
   * against a table that never reached the size the issue names.
   */
  let total = perVariant.reduce((sum, count) => sum + count, 0);
  for (let cursor = 0; total < options.offers && cursor < perVariant.length * cap; cursor += 1) {
    const index = cursor % perVariant.length;
    const current = perVariant[index] ?? 0;
    if (current >= cap) continue;
    perVariant[index] = current + 1;
    total += 1;
  }
  if (total < options.offers) {
    process.stdout.write(
      `NOTE: capacity is ${String(total)} offers ` +
        `(${String(perVariant.length)} variants × ${String(cap)} sellers). ` +
        'Raise --products or --merchants to reach the target.\n',
    );
  }

  process.stdout.write(`Seeding ${String(total)} offers (zipf ${String(options.zipf)})…\n`);

  const run = uuidv7().slice(-8);
  let written = 0;
  let pending: {
    id: string;
    variantId: string;
    merchantId: string;
    price: number;
    country: string;
    externalOfferId: string;
  }[] = [];

  const now = new Date();
  const staleAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  /**
   * One multi-row INSERT per batch, through drizzle rather than a hand-written
   * `unnest`.
   *
   * Not a style choice: postgres.js binds a JS array interpolated into `sql` as a
   * RECORD, not an array, so `${ids}::text[]` fails with
   * `cannot cast type record to text[]` — the tuple-binding trap CONVENTIONS.md
   * records, hit here first time round. Drizzle's own `.values([...])` builds a
   * multi-row VALUES list and binds each column properly. Postgres caps a
   * statement at 65,535 parameters, and each row here carries 19, so the batch
   * must stay under about 3,400 — the default 1,000 leaves room.
   */
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const rows = pending;
    pending = [];
    await db.insert(offers).values(
      rows.map((row) => ({
        id: row.id,
        kind: 'external' as const,
        status: 'active' as const,
        canonicalVariantId: row.variantId,
        merchantId: row.merchantId,
        storefrontId: fixtures.storefrontId,
        sourceRecordId: fixtures.sourceRecordId,
        provider: 'bench-feed',
        externalOfferId: row.externalOfferId,
        destinationUrl: 'https://example.test/p',
        priceAmount: row.price,
        priceCurrency: 'EUR',
        availability: 'in_stock' as const,
        /**
         * The seed OBSERVED no condition, so it claims none.
         *
         * `unmapped` plus `unknown` is the one #90 combination that asserts
         * nothing about the goods: `offers_condition_unmapped_shape_check`
         * requires exactly `condition = 'unknown'` and a NULL confidence, which
         * is what a row nobody read a label for looks like. The tempting
         * alternative — the `new` / `declared` pair `services/graph-benchmark/`
         * carries — is a FIRST-PARTY declaration, and these rows are
         * `kind: 'external'` from `provider: 'bench-feed'`, so it would claim a
         * seller stated a condition on an offer no seller ever touched.
         * `offers_condition_declared_shape_check` cannot catch that, because
         * `declared` requires precisely the three NULLs this seed already has.
         *
         * It costs the measurement nothing: no statement below reads
         * `condition`, and it enters `offers_commercial_key` as a constant, so
         * the per-variant seller cap is unchanged either way. The graph
         * benchmark cannot make the same choice — it VARIES condition as one
         * leg of the (merchant, storefront, condition) decomposition that
         * satisfies `offers_active_commercial_key` by construction, and only
         * `declared` may sit beside a key with no source label.
         */
        condition: 'unknown' as const,
        conditionMappingState: 'unmapped' as const,
        // NULL, never the empty-string sentinel: `offers_country_check` is
        // `~ '^[A-Z]{2}$'`, which passes on NULL and refuses `''` outright.
        country: row.country === '' ? null : row.country,
        observedAt: now,
        firstSeenAt: now,
        lastSeenAt: now,
        staleAt: staleAt,
      })),
    );
    written += rows.length;
    if (written % (options.batch * 10) === 0) {
      process.stdout.write(`  ${String(written)} offers…\n`);
    }
  };

  const COUNTRIES = ['ES', 'FR', 'DE', 'IT'];
  for (const [variantIndex, variantId] of fixtures.canonicalVariantIds.entries()) {
    const count = perVariant[variantIndex] ?? 1;
    for (let n = 0; n < count; n += 1) {
      pending.push({
        id: uuidv7(),
        variantId,
        // `n` indexes the sellers DIRECTLY rather than modulo: the count is
        // already capped at the seller total above, so every offer on a variant
        // names a different merchant and the commercial-key unique is satisfied
        // by construction instead of by luck.
        merchantId: fixtures.merchantIds[n] ?? '',
        price: 1_000 + ((variantIndex * 7 + n * 13) % 500_000),
        // A quarter of the offers are market-less, so the country filter's
        // "admit the global ones too" branch is exercised at scale.
        country: n % 4 === 0 ? '' : (COUNTRIES[n % COUNTRIES.length] ?? 'ES'),
        externalOfferId: `bench-${run}-${String(variantIndex)}-${String(n)}`,
      });
      if (pending.length >= options.batch) await flush();
    }
  }
  await flush();

  const sorted = [...perVariant].sort((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/**
 * Run one query five times and report the plan plus the best and median timing.
 *
 * FIVE, and the median rather than the mean: the first run pays for a cold
 * buffer cache and reporting it as "the" latency measures the disk, while the
 * mean lets one slow run stand in for a distribution nobody saw.
 */
async function explain(db: Database, label: string, statement: ReturnType<typeof sql>): Promise<void> {
  const timings: number[] = [];
  let plan = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rows = await db.execute<{ 'QUERY PLAN': string }>(
      sql`explain (analyze, buffers, format text) ${statement}`,
    );
    const text = rows.map((row) => row['QUERY PLAN']).join('\n');
    const match = /Execution Time: ([\d.]+) ms/.exec(text);
    if (match?.[1]) timings.push(Number(match[1]));
    plan = text;
  }
  timings.sort((a, b) => a - b);
  const median = timings[Math.floor(timings.length / 2)] ?? 0;
  process.stdout.write(
    `\n=== ${label} ===\n` +
      `best ${String(timings[0] ?? 0)} ms | median ${String(median)} ms | ` +
      `runs ${timings.map((value) => value.toFixed(2)).join(', ')}\n${plan}\n`,
  );
}

async function main(): Promise<void> {
  const databaseName = assertSafeTarget();
  const options = parseOptions(process.argv.slice(2));
  const db = await connectPostgres();

  try {
    process.stdout.write(`Benchmarking offers on "${databaseName}"\n`);
    const fixtures = await seedFixtures(db, options);
    const distribution = await seedOffers(db, options, fixtures);
    await db.execute(sql`analyze offers`);

    const [{ count }] = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from offers where status = 'active'`,
    );
    process.stdout.write(
      `\nActive offers: ${String(count)} | per-variant median ${String(distribution.median)}, ` +
        `max ${String(distribution.max)}\n`,
    );

    // The HOTTEST variant, which is the page whose latency actually matters.
    const [{ variant_id: hottest }] = await db.execute<{ variant_id: string }>(
      sql`select canonical_variant_id as variant_id from offers where status = 'active'
          group by canonical_variant_id order by count(*) desc limit 1`,
    );
    const [{ product_id: hottestProduct }] = await db.execute<{ product_id: string }>(
      sql`select product_id from canonical_variants where id = ${hottest}`,
    );

    await explain(
      db,
      'ISSUE INDEX 2 — comparison read for one variant, cheapest first',
      sql`select o.*, s.merchant_id as operator_merchant_id
          from offers o left join storefronts s on s.id = o.storefront_id
          where o.status = 'active' and o.canonical_variant_id = ${hottest}
          order by coalesce(o.price_amount, 9223372036854775807), o.id
          limit 20`,
    );

    await explain(
      db,
      'ISSUE INDEX 2 — the same read for a whole product (semi-join through variants)',
      sql`select o.*, s.merchant_id as operator_merchant_id
          from offers o left join storefronts s on s.id = o.storefront_id
          where o.status = 'active'
            and o.canonical_variant_id in (
              select id from canonical_variants where product_id = ${hottestProduct}
            )
          order by coalesce(o.price_amount, 9223372036854775807), o.id
          limit 20`,
    );

    await explain(
      db,
      'ISSUE INDEX 5 — the market-scoped comparison (country plus the global ones)',
      sql`select o.* from offers o
          where o.status = 'active' and o.canonical_variant_id = ${hottest}
            and (o.country = 'ES' or o.country is null)
          order by coalesce(o.price_amount, 9223372036854775807), o.id
          limit 20`,
    );

    await explain(
      db,
      'ISSUE INDEX 3 — merchant browse, most recently seen first',
      sql`select o.* from offers o
          where o.merchant_id = ${fixtures.merchantIds[0] ?? ''} and o.status = 'active'
          order by o.last_seen_at desc
          limit 20`,
    );

    await explain(
      db,
      'ISSUE INDEX 1 — the idempotent source mapping (the ingestion upsert’s own probe)',
      sql`select id from offers
          where source_key = ${'bench-feed||bench-nonexistent'} and status = 'active'
            and external_offer_id is not null`,
    );

    await explain(
      db,
      'ISSUE INDEX 5 — the freshness sweep’s own scan',
      sql`select id from offers
          where status = 'active' and kind <> 'native' and stale_at <= now()
          order by stale_at limit 500`,
    );

    const [{ size }] = await db.execute<{ size: string }>(
      sql`select pg_size_pretty(pg_total_relation_size('offers')) as size`,
    );
    process.stdout.write(`\nTotal relation size (heap + indexes): ${size}\n`);
    const indexSizes = await db.execute<{ indexname: string; size: string }>(
      sql`select indexname, pg_size_pretty(pg_relation_size(indexname::regclass)) as size
          from pg_indexes where tablename = 'offers' order by pg_relation_size(indexname::regclass) desc`,
    );
    for (const row of indexSizes) {
      process.stdout.write(`  ${row.indexname}: ${row.size}\n`);
    }
  } finally {
    await closePostgres();
  }
}

await main();
