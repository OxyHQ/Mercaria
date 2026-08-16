/**
 * The reproducible canonical-graph dataset #61 measures against.
 *
 * ## Deterministic, and that is the whole point
 *
 * Every id, every price, every Zipf rank and every market code is a pure
 * function of the scale name and one integer seed — there is no `Math.random`,
 * no `uuidv7` and no `now()` anywhere in the generator. Two runs of the same
 * scale produce byte-identical rows, so a plan that changed between two runs
 * changed because the SCHEMA changed, which is the only way a before/after
 * measurement means anything. A generator seeded from the clock produces
 * before/after numbers that differ for a reason nobody can name.
 *
 * That determinism is also why the hot ids the workload targets
 * ({@link SeededGraph}) are computed from the PLAN rather than looked up
 * afterwards: "the variant carrying the most offers" is a property of the seed,
 * not of a query whose own result could be the thing that is broken. The census
 * then verifies the plan actually landed — see {@link countSeededRows}.
 *
 * ## The distribution is skewed, because a uniform one measures nothing
 *
 * Real catalogue data is Zipf-shaped in three places at once: a handful of
 * brands carry most products, a handful of products carry most variants, and a
 * handful of variants carry most offers. A uniform seed makes every read touch
 * the same small number of rows and reports a latency production will never see.
 * The generator therefore reports the MEDIAN and the MAXIMUM fan-out at each
 * level, and the workload deliberately reads the maximum: the median is the
 * answer a typical page gets and the maximum is the answer the worst page gets,
 * and only the second one tells you whether an index is doing its job.
 *
 * ## Nothing here may run against a database somebody cares about
 *
 * The generator TRUNCATEs before it seeds. Both gates
 * (`GRAPH_BENCHMARK=1` and a database name containing `bench`) live in the
 * script that calls it — see `scripts/graph-query-benchmark.ts` — and
 * {@link seedGraph} additionally refuses a connection whose `current_database()`
 * does not contain `bench`, because a truncation is not something to protect
 * with one gate in one file.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../../db/postgres.js';
import { brands } from '../../db/schema/organizations.js';
import {
  canonicalAttributeValues,
  canonicalProductAliases,
  canonicalProductFamilies,
  canonicalProducts,
  canonicalVariantAttributes,
  canonicalVariants,
  productIdentifiers,
} from '../../db/schema/canonicalCatalog.js';
import { categories, listings } from '../../db/schema/catalog.js';
import { merchants, storefronts } from '../../db/schema/merchants.js';
import { catalogSources, sourceRecords } from '../../db/schema/provenance.js';
import { offers } from '../../db/schema/offers.js';
import { commerceRelationships, relationshipEvidence } from '../../db/schema/relationships.js';
import { matchDecisions, matchPolicyVersions } from '../../db/schema/matching.js';
import { catalogBackfillRecords, catalogBackfillRuns } from '../../db/schema/backfill.js';

/** How big a run is. The three sizes the issue's dataset section names. */
export interface BenchmarkScale {
  readonly name: string;
  readonly brands: number;
  readonly families: number;
  readonly products: number;
  /** The Zipf head's variant count; the tail settles at one. */
  readonly maxVariantsPerProduct: number;
  readonly merchants: number;
  readonly storefronts: number;
  /** The TARGET active-plus-retired offer count. A short seed fails the floor. */
  readonly offers: number;
  readonly relationships: number;
  readonly matchDecisions: number;
  readonly backfillRecords: number;
  /** Listings with real coordinates — the only rows the `near` filter can find. */
  readonly geoListings: number;
  readonly zipfExponent: number;
}

/**
 * The three scales, matching the issue's dataset section.
 *
 * `large` is defined and is NOT claimed to have been run — see
 * `docs/performance/canonical-graph-benchmarks.md` for what was actually
 * measured on what hardware. A scale nobody executed is a plan, and printing its
 * name beside numbers from another scale is exactly the misattribution this
 * harness exists to make impossible.
 */
export const BENCHMARK_SCALES: Readonly<Record<string, BenchmarkScale>> = {
  /**
   * The scale the PLAN-REGRESSION suite seeds on every push.
   *
   * Small enough to seed in seconds and large enough that the planner still
   * prefers an index over a heap scan for the shapes whose expectation forbids
   * one — which is the property the gate is measuring. Shrinking it further
   * does not make the gate faster in any way that matters; it makes the gate
   * start failing for a reason that is about statistics rather than about the
   * schema, which is how a gate gets disabled by whoever hits it next.
   */
  ci: {
    name: 'ci',
    brands: 60,
    families: 120,
    products: 4_000,
    maxVariantsPerProduct: 12,
    merchants: 120,
    storefronts: 60,
    offers: 16_000,
    // Three thousand six hundred, not a hundred: `commerce_relationships` is a
    // tiny table and Postgres correctly sequential-scans a hundred rows, so a
    // gate asserting the brand index at that size fails for a reason that is
    // about statistics rather than about the schema. Measured — the gate did
    // exactly that first time round. Relationship rows are cheap; the honest
    // fix is to seed enough of them that the planner faces the real choice.
    relationships: 3_600,
    matchDecisions: 1_200,
    backfillRecords: 2_000,
    geoListings: 1_500,
    zipfExponent: 1.1,
  },
  small: {
    name: 'small',
    brands: 200,
    families: 500,
    products: 10_000,
    maxVariantsPerProduct: 24,
    merchants: 150,
    storefronts: 200,
    offers: 50_000,
    relationships: 400,
    matchDecisions: 5_000,
    backfillRecords: 10_000,
    geoListings: 5_000,
    zipfExponent: 1.1,
  },
  medium: {
    name: 'medium',
    brands: 1_000,
    families: 3_000,
    products: 100_000,
    maxVariantsPerProduct: 40,
    merchants: 600,
    storefronts: 900,
    offers: 1_000_000,
    relationships: 4_000,
    matchDecisions: 50_000,
    backfillRecords: 100_000,
    geoListings: 50_000,
    zipfExponent: 1.1,
  },
  large: {
    name: 'large',
    brands: 4_000,
    families: 12_000,
    products: 1_000_000,
    maxVariantsPerProduct: 40,
    merchants: 2_000,
    storefronts: 3_000,
    offers: 10_000_000,
    relationships: 20_000,
    matchDecisions: 200_000,
    backfillRecords: 400_000,
    geoListings: 200_000,
    zipfExponent: 1.1,
  },
};

/**
 * mulberry32 — a 32-bit PRNG with a stated period and no dependency.
 *
 * The requirement is reproducibility, not cryptographic quality: the same seed
 * must give the same sequence on every machine and every Node version, which
 * `Math.random` explicitly does not promise.
 */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A Zipf-shaped count for rank `index` of `count`, clamped to `[1, max]`.
 *
 * Computed from the rank rather than drawn at random, so the reported maximum is
 * a fact about the seed rather than about the seed's luck.
 */
export function zipfCount(index: number, count: number, exponent: number, max: number): number {
  const weight = 1 / (index + 1) ** exponent;
  return Math.min(max, Math.max(1, Math.round(weight * max)));
}

/**
 * A pronounceable pseudo-word, deterministic in `seed`.
 *
 * ## This is not decoration — it is what makes the trigram measurement mean
 * anything
 *
 * The first version of this generator named products `Benchmodel <i> Pro <j>X`.
 * Every name then shared the trigrams of "benchmodel" and "pro", so
 * `normalized_name % '<any product name>'` matched 9,999 of 10,000 rows, the
 * planner correctly chose a sequential scan over the GIN index, and the run
 * would have reported "the trigram index does not serve the search" — a
 * conclusion about the SEED, presented as a conclusion about the SCHEMA. The
 * vacuity floor (`forbidNodeTypes: ['Seq Scan']`) caught it.
 *
 * Real catalogue names share a brand token and little else, so the words here
 * are built from disjoint syllable tables and the shared part of a product name
 * is exactly one brand word.
 */
const SYLLABLES = [
  'ka', 'ro', 'mi', 'tel', 'vor', 'zan', 'lu', 'bre', 'nix', 'qua',
  'sil', 'dro', 'fen', 'gar', 'hep', 'jol', 'kir', 'mun', 'pav', 'ryn',
  'tos', 'ulv', 'wex', 'yad', 'zeb', 'cor', 'dim', 'elk', 'fyr', 'glo',
] as const;

function syntheticWord(index: number, syllables: number): string {
  let word = '';
  let cursor = index;
  for (let position = 0; position < syllables; position += 1) {
    // A different stride per position, and both coprime with the table length,
    // so two nearby indexes differ in EVERY syllable rather than only the last.
    const pick = (cursor + position * 7) % SYLLABLES.length;
    word += SYLLABLES[pick] ?? 'ka';
    cursor = Math.floor(cursor / SYLLABLES.length) + position * 11;
  }
  return word;
}

/** Category nouns, so a name ends in something a shopper would recognise. */
const NOUNS = [
  'headset', 'blender', 'kettle', 'monitor', 'lamp', 'router', 'camera',
  'scooter', 'mattress', 'printer', 'speaker', 'keyboard',
] as const;

/**
 * A product's model token — the DISCRIMINATING part of its name.
 *
 * Base 36 rather than base 10, so two adjacent products differ in characters
 * and not only in a digit: `m7k2` and `m7k3` share more trigrams than any real
 * pair of model numbers, and the token retrieval stage (#58 stage 5, measured
 * as X04) is exactly the read that would flatter itself on decimal indexes.
 */
function modelToken(index: number): string {
  return `${syntheticWord(index + 40_000, 1)}${index.toString(36)}`;
}

/**
 * One product's name: brand word, model token, category noun.
 *
 * The brand word is the ONLY part two products of one brand share, which is
 * what a real catalogue looks like and what makes `%` selective.
 */
function aliasFor(productIndex: number): string {
  return `${syntheticWord(productIndex + 300_000, 3)} ${modelToken(productIndex)}`;
}

/** One merchant's name. The seed and #70's search shapes read this one function. */
function merchantName(index: number): string {
  return `${syntheticWord(index + 700_000, 2)} store`;
}

function productName(brandIndex: number, productIndex: number): string {
  return [
    syntheticWord(brandIndex, 3),
    modelToken(productIndex),
    NOUNS[productIndex % NOUNS.length] ?? 'device',
  ].join(' ');
}

/** Where the median and the worst case sit, per fan-out level. */
export interface FanOut {
  readonly median: number;
  readonly max: number;
}

function summarizeFanOut(counts: readonly number[]): FanOut {
  const sorted = [...counts].sort((left, right) => left - right);
  return {
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/** The ids and shapes the workload reads, derived from the seed plan. */
export interface SeededGraph {
  readonly scale: BenchmarkScale;
  /** The variant carrying the most active offers — the worst product page. */
  readonly hottestVariantId: string;
  readonly hottestProductId: string;
  readonly hottestProductSlug: string;
  /** The brand carrying the most products — the worst brand page. */
  readonly biggestBrandId: string;
  readonly biggestFamilyId: string;
  /** A merchant carrying offers on many variants — the worst merchant page. */
  readonly busiestMerchantId: string;
  readonly busiestStorefrontId: string;
  /** A variant with no offers, so the write-cost pass can insert freely. */
  readonly writeCostVariantId: string;
  /** A GTIN that really is on a variant, and its canonical 14-digit form. */
  readonly knownGtin: string;
  readonly knownGtinCanonical: string;
  /** A product name and its discriminating token — the search shapes' input. */
  readonly knownProductName: string;
  readonly knownModelCode: string;
  readonly knownAlias: string;
  /**
   * The busiest merchant's own name — #70's merchant-search shapes' input.
   *
   * Derived from the SAME generator the seed writes with rather than
   * transcribed, for the reason `workload.ts` calls real readers: a second
   * spelling of a fixture drifts silently and the shape then measures a query
   * that matches nothing, which reads exactly like a fast one.
   */
  readonly knownMerchantName: string;
  readonly matchPolicyVersionId: string;
  readonly backfillRunId: string;
  /** A real category id, so a facet scope names one that carries products. */
  readonly facetCategoryId: string;
  readonly market: string;
  readonly offersPerVariant: FanOut;
  readonly variantsPerProduct: FanOut;
  readonly productsPerBrand: FanOut;
}

/**
 * The whole seed, as arithmetic — computed before a single row is written.
 *
 * Splitting the PLAN from the WRITING is what makes `--no-seed` honest: a
 * before/after pass must measure the same physical dataset twice, so the second
 * run re-derives the ids from the same scale and seed instead of re-seeding.
 * Both paths go through this one function, so "the hottest variant" cannot mean
 * two different things in the two halves of a comparison.
 */
interface SeedPlan {
  readonly brandOfProduct: readonly number[];
  readonly productsPerBrand: readonly number[];
  readonly variantsPerProduct: readonly number[];
  readonly variantIds: readonly string[];
  readonly variantProduct: readonly number[];
  readonly offersPerVariant: readonly number[];
  readonly plannedOffers: number;
  readonly graph: SeededGraph;
}

/** Markets the seed publishes offers and storefronts into. */
const MARKETS = ['ES', 'FR', 'DE', 'IT', 'PT'] as const;
/** Conditions the seed uses — the third axis of `offers_active_commercial_key`. */
const CONDITIONS = ['new', 'used_good', 'refurbished_seller', 'open_box'] as const;
const CATEGORY_COUNT = 24;
/**
 * The attribute vocabulary the facet shapes measure (#367 Workstream 10).
 *
 * Exported as CONSTANTS rather than transcribed into `workload.ts`, for the
 * reason that file states about readers: a fixture spelled twice drifts
 * silently, and a facet aggregate whose key matches nothing returns zero rows —
 * which trips the row floor rather than reporting a fast query, but only
 * because the floor is there.
 */
export const BENCH_PRODUCT_ATTRIBUTE_KEY = 'bench_material';
export const BENCH_PRODUCT_NUMERIC_KEY = 'bench_weight';
export const BENCH_VARIANT_ATTRIBUTE_KEY = 'bench_colour';
/** Distinct values per facet — enough that a bucket aggregate is a real one. */
const BENCH_MATERIALS = ['leather', 'canvas', 'nylon', 'suede', 'rubber', 'mesh'] as const;
const BENCH_COLOURS = ['black', 'white', 'red', 'blue', 'green', 'grey', 'navy', 'olive'] as const;
/** Singleton parents the workload cites by id. Named so the plan and the seed agree. */
const POLICY_VERSION_ID = 'bx-policy-0';
const BACKFILL_RUN_ID = 'bx-run-0';
/**
 * A product and variant carrying NO offers, reserved for the write-cost pass.
 *
 * `offers_active_commercial_key` admits one active offer per (variant, seller,
 * channel, condition), so measuring N inserts against a variant the seed
 * already filled fails on the second one — measured here first time round. A
 * variant with no offers lets each attempt name a different merchant and
 * succeed, which is also the honest ingestion case: a new offer arriving.
 * It carries no brand, family or category, so it perturbs no measured page.
 */
const WRITE_COST_PRODUCT_ID = 'bx-prod-writecost';
const WRITE_COST_VARIANT_ID = 'bx-var-writecost';
/**
 * How many distinct observation rows the seed mints.
 *
 * At least one per match decision, and that is a CONSTRAINT rather than a
 * preference: `match_decisions_evaluation_key` is unique on
 * `('src:' || source_record_id, policy_version_id)`, so a pool smaller than the
 * decision count cannot be seeded at all. Offers then share the pool, which is
 * realistic — one feed delivery is observed once and priced many times.
 */
function sourceRecordCount(scale: BenchmarkScale): number {
  return Math.max(1_024, scale.matchDecisions);
}

/** Statement batch size. Each offer row binds ~20 parameters; Postgres caps at 65,535. */
const BATCH = 1_000;

/** The tables the generator owns and truncates. Order is irrelevant to CASCADE. */
const SEEDED_TABLES = [
  // The facet aggregates' population (#367 Workstream 10). Ahead of the
  // entities they hang off, though CASCADE makes the order irrelevant.
  'canonical_attribute_values',
  'canonical_variant_attributes',
  'catalog_backfill_records',
  'catalog_backfill_runs',
  'match_decisions',
  'match_policy_versions',
  'relationship_evidence',
  'commerce_relationships',
  'offers',
  'product_identifiers',
  'canonical_variants',
  'canonical_product_aliases',
  'canonical_products',
  'canonical_product_families',
  'brands',
  'storefronts',
  'merchants',
  'source_records',
  'catalog_sources',
  'listings',
  'categories',
] as const;

/** The whole seed as arithmetic. Pure — no clock, no randomness, no database. */
function buildSeedPlan(scale: BenchmarkScale): SeedPlan {
  // Brand assignment is Zipf: brand 0 carries the head of the catalogue, which
  // is what makes the brand page's worst case measurable at all.
  const productsPerBrand = new Array<number>(scale.brands).fill(0);
  const brandShare = Array.from(
    { length: scale.brands },
    (_, index) => 1 / (index + 1) ** scale.zipfExponent,
  );
  const brandShareTotal = brandShare.reduce((sum, weight) => sum + weight, 0);
  const brandOfProduct = new Array<number>(scale.products).fill(0);
  let cursor = 0;
  for (let brand = 0; brand < scale.brands; brand += 1) {
    const share = Math.floor(((brandShare[brand] ?? 0) / brandShareTotal) * scale.products);
    for (let n = 0; n < share && cursor < scale.products; n += 1) {
      brandOfProduct[cursor] = brand;
      productsPerBrand[brand] = (productsPerBrand[brand] ?? 0) + 1;
      cursor += 1;
    }
  }
  // The floor() above leaves a remainder; spread it over the tail so the product
  // count is EXACTLY what the scale promised and the floor can be an equality
  // rather than a "roughly".
  for (let brand = 0; cursor < scale.products; brand = (brand + 1) % scale.brands) {
    brandOfProduct[cursor] = brand;
    productsPerBrand[brand] = (productsPerBrand[brand] ?? 0) + 1;
    cursor += 1;
  }

  const variantsPerProduct = Array.from({ length: scale.products }, (_, index) =>
    zipfCount(index, scale.products, scale.zipfExponent, scale.maxVariantsPerProduct),
  );
  const variantIds: string[] = [];
  const variantProduct: number[] = [];
  for (let product = 0; product < scale.products; product += 1) {
    const count = variantsPerProduct[product] ?? 1;
    for (let n = 0; n < count; n += 1) {
      variantIds.push(`bx-var-${String(variantIds.length)}`);
      variantProduct.push(product);
    }
  }

  // Zipf over variants, then topped up round-robin to the target. The raw Zipf
  // shape reaches one offer per variant within a few hundred ranks, so without
  // the top-up a "one million offers" run silently seeds a tenth of that and
  // every latency below is measured against a table that never reached the size
  // the scale names.
  const offerCapacityPerVariant = scale.merchants * scale.storefronts * CONDITIONS.length;
  const offersPerVariant = variantIds.map((_, index) =>
    Math.min(
      offerCapacityPerVariant,
      zipfCount(index, variantIds.length, scale.zipfExponent, scale.merchants),
    ),
  );
  let plannedOffers = offersPerVariant.reduce((sum, count) => sum + count, 0);
  for (
    let topUp = 0;
    plannedOffers < scale.offers && topUp < offersPerVariant.length * 256;
    topUp += 1
  ) {
    const index = topUp % offersPerVariant.length;
    const current = offersPerVariant[index] ?? 0;
    if (current >= offerCapacityPerVariant) continue;
    offersPerVariant[index] = current + 1;
    plannedOffers += 1;
  }
  if (plannedOffers < scale.offers) {
    throw new Error(
      `Scale "${scale.name}" cannot reach ${String(scale.offers)} offers ` +
        `(capacity ${String(plannedOffers)}). Raise products, merchants or storefronts.`,
    );
  }

  const hottestVariantIndex = offersPerVariant.reduce(
    (best, count, index) => (count > (offersPerVariant[best] ?? 0) ? index : best),
    0,
  );
  const hottestProduct = variantProduct[hottestVariantIndex] ?? 0;
  const biggestBrand = productsPerBrand.reduce(
    (best, count, index) => (count > (productsPerBrand[best] ?? 0) ? index : best),
    0,
  );

  return {
    brandOfProduct,
    productsPerBrand,
    variantsPerProduct,
    variantIds,
    variantProduct,
    offersPerVariant,
    plannedOffers,
    graph: {
      scale,
      hottestVariantId: variantIds[hottestVariantIndex] ?? 'bx-var-0',
      hottestProductId: `bx-prod-${String(hottestProduct)}`,
      hottestProductSlug: `bench-prod-${String(hottestProduct)}`,
      biggestBrandId: `bx-brand-${String(biggestBrand)}`,
      biggestFamilyId: 'bx-fam-0',
      busiestMerchantId: 'bx-merch-0',
      busiestStorefrontId: 'bx-sf-0',
      writeCostVariantId: WRITE_COST_VARIANT_ID,
      knownGtin: gtinFor(0).slice(1),
      knownGtinCanonical: gtinFor(0),
      knownProductName: productName(brandOfProduct[hottestProduct] ?? 0, hottestProduct),
      knownModelCode: modelToken(hottestProduct),
      // Aliases sit on every third product, so the lookup has to name one that
      // really has one — the nearest multiple of three at or below the hottest.
      // `normalized_alias` is `lower(btrim(alias))` and every word here is
      // already lowercase and untrimmed, so the two forms coincide.
      knownAlias: aliasFor(hottestProduct - (hottestProduct % 3)),
      knownMerchantName: merchantName(0),
      matchPolicyVersionId: POLICY_VERSION_ID,
      backfillRunId: BACKFILL_RUN_ID,
      // Category 0, which carries every product whose index is 0 mod 24 — about
      // a twenty-fourth of the catalogue, which is what a facet rail over one
      // category actually aggregates.
      facetCategoryId: 'bx-cat-0',
      market: 'ES',
      offersPerVariant: summarizeFanOut(offersPerVariant),
      variantsPerProduct: summarizeFanOut(variantsPerProduct),
      productsPerBrand: summarizeFanOut(productsPerBrand),
    },
  };
}

/**
 * The ids a run of this scale and seed WILL use, without touching the database.
 *
 * What `--no-seed` reads. The generator is deterministic, so this is not an
 * approximation of the seed — it is the same arithmetic the seed writes from.
 */
export function deriveSeedPlan(scale: BenchmarkScale): SeededGraph {
  return buildSeedPlan(scale).graph;
}

/**
 * The two database-name shapes this generator will TRUNCATE.
 *
 * `bench` is the operator's own scratch database, named by hand. The second is
 * the throwaway `@oxyhq/db/testing` mints for a suite run — the plan-regression
 * test creates ITS OWN rather than sharing the suite's, precisely because this
 * generator truncates and the shared one carries every other realdb test's
 * fixtures. That pattern is the same one `dropTestDatabase` refuses to drop
 * outside of, so a database matching it is a scratch database by construction
 * and no production name matches either.
 */
const SCRATCH_DATABASE_PATTERN = /bench|^oxydb_test_[0-9a-f]{16}$/;

async function assertBenchDatabase(db: Database): Promise<void> {
  const rows = await db.execute<{ name: string }>(sql`select current_database() as name`);
  const name = rows[0]?.name ?? '';
  if (!SCRATCH_DATABASE_PATTERN.test(name)) {
    throw new Error(
      `Refusing to seed "${name}": this generator TRUNCATES, so the database name must ` +
        'contain "bench" or be a throwaway `oxydb_test_<16 hex>`.',
    );
  }
}

async function insertBatched<TRow>(
  rows: readonly TRow[],
  write: (batch: readonly TRow[]) => Promise<void>,
): Promise<void> {
  for (let start = 0; start < rows.length; start += BATCH) {
    await write(rows.slice(start, start + BATCH));
  }
}

/** A 14-digit canonical GTIN, deterministic in the variant index. */
function gtinFor(index: number): string {
  return String(1_000_000_000_000 + (index % 8_999_999_999_999)).padStart(14, '0');
}

/**
 * Seed the whole graph and return the shapes the workload reads.
 *
 * Writes with a fixed clock (`epoch`) so `stale_at`, `last_seen_at` and
 * `observed_at` are reproducible; the freshness sweep's shape then depends on
 * the seed rather than on when the benchmark happened to run.
 */
export async function seedGraph(
  db: Database,
  scale: BenchmarkScale,
  seed = 61,
  log: (message: string) => void = () => undefined,
): Promise<SeededGraph> {
  await assertBenchDatabase(db);
  await db.execute(sql.raw(`truncate table ${SEEDED_TABLES.join(', ')} cascade`));

  const plan = buildSeedPlan(scale);
  const epoch = new Date('2026-01-01T00:00:00.000Z');
  const at = (offsetDays: number): Date =>
    new Date(epoch.getTime() + offsetDays * 24 * 60 * 60 * 1000);

  log(`Seeding scale "${scale.name}" (seed ${String(seed)})…`);

  // ---- Sources, categories -------------------------------------------------
  const sourceId = 'bx-source-0';
  await db.insert(catalogSources).values({
    id: sourceId,
    kind: 'feed',
    name: 'bench-feed',
    mayDisplay: true,
    mayStore: true,
    attributionRequired: false,
  });

  const sourceRecordPool = sourceRecordCount(scale);
  log(`  source records ${String(sourceRecordPool)}…`);
  await insertBatched(
    Array.from({ length: sourceRecordPool }, (_, index) => ({
      id: `bx-sr-${String(index)}`,
      sourceId,
      externalType: 'offer' as const,
      externalId: `bx-ext-${String(index)}`,
      observedAt: at(-(index % 720) / 24),
      staleAt: at(7 - (index % 14)),
      contentHash: String(index).padStart(64, '0'),
    })),
    (batch) => db.insert(sourceRecords).values([...batch]).then(() => undefined),
  );

  await db.insert(categories).values(
    Array.from({ length: CATEGORY_COUNT }, (_, index) => ({
      id: `bx-cat-${String(index)}`,
      key: `bench-cat-${String(index)}`,
      name: `Bench category ${String(index)}`,
      slug: `bench-cat-${String(index)}`,
      ancestorSlugs: [`bench-cat-${String(index % 4)}`],
      position: index,
    })),
  );

  // ---- Brands and families -------------------------------------------------
  log(`  brands ${String(scale.brands)}, families ${String(scale.families)}…`);
  await insertBatched(
    Array.from({ length: scale.brands }, (_, index) => ({
      id: `bx-brand-${String(index)}`,
      slug: `bench-brand-${String(index)}`,
      name: syntheticWord(index, 3),
      normalizedName: syntheticWord(index, 3),
    })),
    (batch) => db.insert(brands).values([...batch]).then(() => undefined),
  );

  await insertBatched(
    Array.from({ length: scale.families }, (_, index) => ({
      id: `bx-fam-${String(index)}`,
      slug: `bench-fam-${String(index)}`,
      name: `${syntheticWord(index + 5_000, 2)} series`,
      normalizedName: `${syntheticWord(index + 5_000, 2)} series`,
      brandId: `bx-brand-${String(index % scale.brands)}`,
    })),
    (batch) => db.insert(canonicalProductFamilies).values([...batch]).then(() => undefined),
  );

  // ---- Products ------------------------------------------------------------
  log(`  products ${String(scale.products)}…`);
  await insertBatched(
    Array.from({ length: scale.products }, (_, index) => ({
      id: `bx-prod-${String(index)}`,
      slug: `bench-prod-${String(index)}`,
      name: productName(plan.brandOfProduct[index] ?? 0, index),
      normalizedName: productName(plan.brandOfProduct[index] ?? 0, index),
      brandId: `bx-brand-${String(plan.brandOfProduct[index] ?? 0)}`,
      familyId: `bx-fam-${String(index % scale.families)}`,
      categoryId: `bx-cat-${String(index % CATEGORY_COUNT)}`,
      searchTokens: [modelToken(index), syntheticWord(index + 90_000, 2)],
      modelCode: modelToken(index).toUpperCase(),
      status: 'active' as const,
      firstSeenAt: at(-30),
      lastSeenAt: at(0),
    })),
    (batch) => db.insert(canonicalProducts).values([...batch]).then(() => undefined),
  );

  await db.insert(canonicalProducts).values({
    id: WRITE_COST_PRODUCT_ID,
    slug: 'bench-prod-writecost',
    name: 'Benchmark write-cost product',
    normalizedName: 'benchmark write cost product',
    status: 'active',
    firstSeenAt: at(-30),
  });
  await db.insert(canonicalVariants).values({
    id: WRITE_COST_VARIANT_ID,
    productId: WRITE_COST_PRODUCT_ID,
    // `canonical_variants_signature_shape_check` wants 64 lowercase HEX; every
    // other signature here is a decimal index left-padded with 'a', so an
    // all-'f' one is both valid and unreachable by that scheme.
    signature: ''.padStart(64, 'f'),
    name: 'Write-cost variant',
    isDefault: true,
    status: 'active',
    firstSeenAt: at(-30),
  });

  // One alias on every third product — enough for the alias lookup to have real
  // selectivity without doubling the seed.
  const aliasProducts = Array.from(
    { length: Math.floor(scale.products / 3) },
    (_, index) => index * 3,
  );
  await insertBatched(
    aliasProducts.map((index) => ({
      id: `bx-alias-${String(index)}`,
      productId: `bx-prod-${String(index)}`,
      alias: aliasFor(index),
      kind: 'marketing_name' as const,
    })),
    (batch) => db.insert(canonicalProductAliases).values([...batch]).then(() => undefined),
  );

  // ---- Variants ------------------------------------------------------------
  const { variantIds, variantProduct } = plan;
  log(`  variants ${String(variantIds.length)}…`);
  {
    // `n` is the variant's position WITHIN its product, recovered by counting
    // back to the first variant of that product — the plan stores the mapping
    // and not the offset, and re-deriving it here keeps one representation.
    let positionInProduct = 0;
    let previousProduct = -1;
    const rows = variantIds.map((id, variantIndex) => {
      const product = variantProduct[variantIndex] ?? 0;
      positionInProduct = product === previousProduct ? positionInProduct + 1 : 0;
      previousProduct = product;
      return {
        id,
        productId: `bx-prod-${String(product)}`,
        signature: String(variantIndex).padStart(64, 'a'),
        name: `Variant ${String(positionInProduct)}`,
        isDefault: positionInProduct === 0,
        status: 'active' as const,
        firstSeenAt: at(-30),
      };
    });
    await insertBatched(rows, (batch) =>
      db.insert(canonicalVariants).values([...batch]).then(() => undefined),
    );
  }

  // A GTIN on every fourth variant — the identifier lookup's population.
  await insertBatched(
    variantIds.flatMap((id, index) =>
      index % 4 === 0
        ? [
            {
              id: `bx-ident-${String(index)}`,
              variantId: id,
              scheme: 'ean' as const,
              rawValue: gtinFor(index).slice(1),
              normalizedValue: gtinFor(index).slice(1),
              canonicalScheme: 'gtin' as const,
              canonicalValue: gtinFor(index),
              status: 'active' as const,
            },
          ]
        : [],
    ),
    (batch) => db.insert(productIdentifiers).values([...batch]).then(() => undefined),
  );

  // ---- Merchants and storefronts ------------------------------------------
  log(`  merchants ${String(scale.merchants)}, storefronts ${String(scale.storefronts)}…`);
  await insertBatched(
    Array.from({ length: scale.merchants }, (_, index) => ({
      id: `bx-merch-${String(index)}`,
      slug: `bench-merch-${String(index)}`,
      name: merchantName(index),
    })),
    (batch) => db.insert(merchants).values([...batch]).then(() => undefined),
  );

  await insertBatched(
    Array.from({ length: scale.storefronts }, (_, index) => ({
      id: `bx-sf-${String(index)}`,
      // Every third channel is operated by a DIFFERENT merchant than the one
      // whose offers sit on it — which is what makes an offer a marketplace
      // offer (ADR 0002 D8) and what the merchant-page read has to join for.
      merchantId: `bx-merch-${String((index * 7) % scale.merchants)}`,
      name: `Benchchannel ${String(index)}`,
      slug: `bench-sf-${String(index)}`,
      channelKind: 'marketplace' as const,
      country: MARKETS[index % MARKETS.length] ?? 'ES',
      status: 'active' as const,
      lastSeenAt: at(-(index % 30)),
    })),
    (batch) => db.insert(storefronts).values([...batch]).then(() => undefined),
  );

  // ---- Offers --------------------------------------------------------------
  // The per-variant counts come from the plan; the (merchant, storefront,
  // condition) triple below is a unique DECOMPOSITION of the offer's index on
  // its variant, so `offers_active_commercial_key` is satisfied by construction
  // rather than by luck.
  const { offersPerVariant } = plan;
  log(`  offers ${String(plan.plannedOffers)}…`);
  {
    let pending: (typeof offers.$inferInsert)[] = [];
    let written = 0;
    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      await db.insert(offers).values(batch);
      written += batch.length;
      if (written % (BATCH * 50) === 0) log(`    ${String(written)} offers…`);
    };

    for (const [variantIndex, variantId] of variantIds.entries()) {
      const count = offersPerVariant[variantIndex] ?? 1;
      for (let n = 0; n < count; n += 1) {
        const merchant = n % scale.merchants;
        const storefront = Math.floor(n / scale.merchants) % scale.storefronts;
        const condition =
          CONDITIONS[Math.floor(n / (scale.merchants * scale.storefronts)) % CONDITIONS.length] ??
          'new';
        // One offer in twenty is already retired and one in ten has lapsed, so
        // the partial indexes are measured against a table that really does
        // carry rows they must not scan.
        const retired = (variantIndex + n) % 20 === 0;
        const lapsed = (variantIndex + n) % 10 === 0;
        pending.push({
          id: `bx-offer-${String(variantIndex)}-${String(n)}`,
          kind: 'external',
          status: retired ? 'retired' : 'active',
          retirementReason: retired ? 'source_disappeared' : null,
          retiredAt: retired ? at(-1) : null,
          canonicalVariantId: variantId,
          merchantId: `bx-merch-${String(merchant)}`,
          storefrontId: `bx-sf-${String(storefront)}`,
          sourceRecordId: `bx-sr-${String((variantIndex + n) % sourceRecordPool)}`,
          provider: 'bench-feed',
          externalOfferId: `bx-eo-${String(variantIndex)}-${String(n)}`,
          destinationUrl: 'https://example.test/p',
          priceAmount: 1_000 + ((variantIndex * 7 + n * 13) % 500_000),
          priceCurrency: 'EUR',
          availability: 'in_stock',
          condition,
          conditionMappingState: 'declared',
          // A quarter of the offers are market-less, so the country filter's
          // "admit the global ones too" branch is exercised at scale.
          country: n % 4 === 0 ? null : (MARKETS[n % MARKETS.length] ?? 'ES'),
          observedAt: at(-(n % 20)),
          firstSeenAt: at(-30),
          lastSeenAt: at(-(n % 20)),
          staleAt: lapsed ? at(-2) : at(30),
        });
        if (pending.length >= BATCH) await flush();
      }
    }
    await flush();
  }

  // ---- Relationships and evidence -----------------------------------------
  log(`  relationships ${String(scale.relationships)}…`);
  await insertBatched(
    Array.from({ length: scale.relationships }, (_, index) => ({
      id: `bx-rel-${String(index)}`,
      kind:
        index % 2 === 0
          ? ('merchant_official_channel_for_brand' as const)
          : ('merchant_authorized_reseller_for_brand' as const),
      // The (merchant, brand) pair is a unique DECOMPOSITION of the index, not
      // two independent moduli. `commerce_relationships_open_claim_key` is a
      // partial unique on `(kind, endpoint_key) WHERE valid_to IS NULL`, and two
      // independent moduli collide as soon as the index passes their lcm —
      // measured here first time round, on relationship 150.
      merchantId: `bx-merch-${String(index % scale.merchants)}`,
      // Bucketed rather than spread, so the head brands carry a page's worth of
      // resellers each and "the resellers of the biggest brand" has real
      // fan-out rather than three rows.
      brandId: `bx-brand-${String(Math.floor(index / scale.merchants))}`,
      territories: index % 3 === 0 ? [] : [MARKETS[index % MARKETS.length] ?? 'ES'],
      languages: [],
      validFrom: at(-60),
      // One in seven has already lapsed — the temporal predicate must drop it
      // whether or not a sweep ran.
      validTo: index % 7 === 0 ? at(-1) : null,
      // `commerce_relationships_verified_state_check` demands all three of
      // method, timestamp and attributor on a verified row — a verified claim
      // nobody signed is unrepresentable (#55), so the seed has to sign them.
      status: 'verified' as const,
      verifiedAt: at(-50),
      verifiedByOxyUserId: 'bx-operator',
      verificationMethod: 'operator_review' as const,
      assertedByKind: 'catalog_operator' as const,
    })),
    (batch) => db.insert(commerceRelationships).values([...batch]).then(() => undefined),
  );

  await insertBatched(
    Array.from({ length: scale.relationships }, (_, index) => ({
      id: `bx-rev-${String(index)}`,
      relationshipId: `bx-rel-${String(index)}`,
      kind: 'source_document' as const,
      status: 'active' as const,
      observedFact: `bench evidence ${String(index)}`,
      observedAt: at(-55),
      sourceRecordId: `bx-sr-${String(index % sourceRecordPool)}`,
    })),
    (batch) => db.insert(relationshipEvidence).values([...batch]).then(() => undefined),
  );

  // ---- Match decisions (the #59 review inbox) ------------------------------
  await db.insert(matchPolicyVersions).values({
    id: POLICY_VERSION_ID,
    versionKey: 'bench-policy-1',
    status: 'active',
    description: 'Benchmark policy',
    autoMinConfidence: 0.9,
    reviewMinConfidence: 0.6,
    minCandidateSeparation: 0.05,
    maxCandidates: 25,
    minTitleSimilarity: 0.3,
    weightIdentifier: 1,
    weightBrand: 1,
    weightModel: 1,
    weightAttribute: 1,
    weightTitle: 1,
    weightCategory: 1,
    weightSemantic: 0,
    semanticEnabled: false,
    minBenchmarkPrecision: 0.98,
    minBenchmarkSamples: 200,
    createdByOxyUserId: 'bx-operator',
    activatedAt: at(-40),
  });

  log(`  match decisions ${String(scale.matchDecisions)}…`);
  await insertBatched(
    Array.from({ length: scale.matchDecisions }, (_, index) => {
      // One in ten waits for a person. The inbox read must find those in a
      // table dominated by decisions nobody has to look at.
      const pending = index % 10 === 0;
      return {
        id: `bx-dec-${String(index)}`,
        subjectKind: 'source_record' as const,
        subjectKey: `src:bx-sr-${String(index)}`,
        // One observation per decision, never a modulo: the evaluation key is
        // derived from this column and a repeat is a unique violation.
        sourceRecordId: `bx-sr-${String(index)}`,
        policyVersionId: POLICY_VERSION_ID,
        outcome: pending ? ('manual_review' as const) : ('create_new' as const),
        decidedStage: 'candidate_retrieval' as const,
        reasonCodes: pending ? ['ambiguous_candidates'] : ['no_candidate_found'],
        blockers: pending ? ['ambiguous_candidates'] : [],
        normalizedTitle: `benchmodel ${String(index)}`,
        candidateCount: pending ? 2 : 0,
        reviewState: pending ? ('pending' as const) : ('not_required' as const),
        lastEvaluatedAt: at(-(index % 30)),
        createdAt: at(-(index % 30)),
      };
    }),
    (batch) => db.insert(matchDecisions).values([...batch]).then(() => undefined),
  );

  // ---- Backfill evidence ---------------------------------------------------
  await db.insert(catalogBackfillRuns).values({
    id: BACKFILL_RUN_ID,
    stage: 'variant_matching',
    mode: 'apply',
    mappingVersion: 1,
    cohortKind: 'all',
    status: 'completed',
    // `catalog_backfill_runs_counters_total_check` is #60's vacuity floor as a
    // CHECK — the outcomes must SUM to `scanned`, equality and not `<=` — so the
    // two figures here are derived from the same `% 8` rule the records use
    // rather than typed in beside it.
    scanned: scale.backfillRecords,
    reviewRequired: Math.ceil(scale.backfillRecords / 8),
    matched: scale.backfillRecords - Math.ceil(scale.backfillRecords / 8),
    startedAt: at(-5),
    completedAt: at(-4),
    requestedByOxyUserId: 'bx-operator',
  });

  log(`  backfill records ${String(scale.backfillRecords)}…`);
  await insertBatched(
    Array.from({ length: scale.backfillRecords }, (_, index) => ({
      id: `bx-bfr-${String(index)}`,
      runId: BACKFILL_RUN_ID,
      stage: 'variant_matching' as const,
      mode: 'apply' as const,
      mappingVersion: 1,
      subjectKind: 'product_variant' as const,
      subjectKey: `pv:bx-var-${String(index)}`,
      outcome: index % 8 === 0 ? ('review_required' as const) : ('matched' as const),
      reasonCode:
        index % 8 === 0 ? ('blocked_by_decision' as const) : ('variant_attached' as const),
    })),
    (batch) => db.insert(catalogBackfillRecords).values([...batch]).then(() => undefined),
  );

  // ---- Attribute values, at BOTH grains (#367 Workstream 10) ---------------
  //
  // The facet aggregates read `canonical_attribute_values` at product grain and
  // the UNION of it with `canonical_variant_attributes` at variant grain, and
  // #61's generator seeded neither — so a facet shape appended to the workload
  // would have returned zero rows and tripped its own vacuity floor. Seeding
  // them is what makes the measurement one; it perturbs no existing shape,
  // because no shape before Q28 reads either table.
  log(`  product attribute values ${String(scale.products)}…`);
  await insertBatched(
    Array.from({ length: scale.products }, (_, index) => ({
      id: `bx-cav-m-${String(index)}`,
      productId: `bx-prod-${String(index)}`,
      attributeKey: BENCH_PRODUCT_ATTRIBUTE_KEY,
      // The DISPLAY value differs from the normalized one on every third row,
      // so `listObservedValueLabels` has commercial spellings to report — the
      // colour-family case, at product grain.
      sourceDisplayValue:
        index % 3 === 0
          ? `Full-grain ${BENCH_MATERIALS[index % BENCH_MATERIALS.length] ?? 'leather'}`
          : (BENCH_MATERIALS[index % BENCH_MATERIALS.length] ?? 'leather'),
      normalizedText: BENCH_MATERIALS[index % BENCH_MATERIALS.length] ?? 'leather',
      normalizationState: 'normalized' as const,
      selectionState: 'selected' as const,
      sourceRecordId: `bx-sr-${String(index % sourceRecordCount(scale))}`,
      observedAt: at(-1),
    })),
    (batch) => db.insert(canonicalAttributeValues).values([...batch]).then(() => undefined),
  );

  // A numeric spec on every FIFTH product, so the range aggregate has a real
  // span AND the unknown count has a real population.
  //
  // Five rather than two, and the stride is load bearing: a category holds every
  // product whose index is `0 mod 24`, so a spec on every SECOND product covers
  // every product of every category — `countProductsWithoutAttribute` then
  // returns ZERO rows and its shape reports a vacuous measurement. Measured: the
  // plan gate went red on Q32 the first time this ran, which is the row floor
  // doing its job. Five is coprime with 24, so a category's coverage is partial.
  await insertBatched(
    Array.from({ length: Math.floor(scale.products / 5) }, (_, index) => ({
      id: `bx-cav-w-${String(index)}`,
      productId: `bx-prod-${String(index * 5)}`,
      attributeKey: BENCH_PRODUCT_NUMERIC_KEY,
      sourceDisplayValue: `${String(200 + ((index * 17) % 4_000))} g`,
      normalizedNumber: 200 + ((index * 17) % 4_000),
      normalizedUnit: 'g',
      normalizationState: 'normalized' as const,
      selectionState: 'selected' as const,
      sourceRecordId: `bx-sr-${String(index % sourceRecordCount(scale))}`,
      observedAt: at(-1),
    })),
    (batch) => db.insert(canonicalAttributeValues).values([...batch]).then(() => undefined),
  );

  log(`  variant axis assignments ${String(variantIds.length)}…`);
  await insertBatched(
    variantIds.map((id, index) => ({
      id: `bx-vaa-${String(index)}`,
      variantId: id,
      attributeKey: BENCH_VARIANT_ATTRIBUTE_KEY,
      displayValue: BENCH_COLOURS[index % BENCH_COLOURS.length] ?? 'black',
      normalizedValue: BENCH_COLOURS[index % BENCH_COLOURS.length] ?? 'black',
      normalizationState: 'normalized' as const,
    })),
    (batch) => db.insert(canonicalVariantAttributes).values([...batch]).then(() => undefined),
  );

  // ---- Geo listings --------------------------------------------------------
  // The generator's ONE use of the PRNG, and it is created here rather than at
  // the top so its sequence cannot depend on how many rows an earlier section
  // happened to write. Every other value in this file is arithmetic on an index.
  const rng = createRng(seed);
  log(`  geo listings ${String(scale.geoListings)}…`);
  await insertBatched(
    Array.from({ length: scale.geoListings }, (_, index) => ({
      id: `bx-listing-${String(index)}`,
      ownerType: 'user' as const,
      oxyUserId: `bx-user-${String(index % 500)}`,
      title: `Bench listing ${String(index)} bicycle`,
      description: 'A benchmark listing.',
      condition: 'used_good' as const,
      conditionAssertion: 'seller_declared' as const,
      status: 'active' as const,
      // A 2°×2° box around Barcelona, deterministic, so `st_dwithin` at 5 km
      // finds a real neighbourhood rather than everything or nothing.
      longitude: 2.17 + (rng() - 0.5) * 2,
      latitude: 41.38 + (rng() - 0.5) * 2,
      priceRangeMinAmount: 1_000 + ((index * 31) % 200_000),
      priceRangeMinCurrency: 'EUR' as const,
      categorySlugs: [`bench-cat-${String(index % CATEGORY_COUNT)}`],
      publishedAt: at(-(index % 90)),
    })),
    (batch) => db.insert(listings).values([...batch]).then(() => undefined),
  );

  // ANALYZE before anything is measured: a plan chosen from default statistics
  // on a freshly-bulk-loaded table is a plan production will never produce, and
  // it is the one most likely to look wrong in an interesting way.
  log('  analyze…');
  await db.execute(sql.raw(`analyze ${SEEDED_TABLES.join(', ')}`));

  return plan.graph;
}

/**
 * The floors a seed must clear, derived from the SCALE rather than from what
 * the generator happened to write.
 *
 * Deriving them from the run's own output would make the check circular: a
 * generator that wrote a tenth of what it promised would announce a tenth and
 * then pass its own floor. These are the numbers the scale asked for.
 */
export function rowCountFloors(scale: BenchmarkScale): Map<string, number> {
  return new Map<string, number>([
    ['brands', scale.brands],
    ['canonical_product_families', scale.families],
    ['canonical_products', scale.products],
    ['canonical_variants', scale.products],
    ['canonical_product_aliases', Math.floor(scale.products / 3)],
    ['product_identifiers', Math.floor(scale.products / 4)],
    ['merchants', scale.merchants],
    ['storefronts', scale.storefronts],
    ['offers', scale.offers],
    ['commerce_relationships', scale.relationships],
    ['relationship_evidence', scale.relationships],
    ['match_decisions', scale.matchDecisions],
    ['catalog_backfill_records', scale.backfillRecords],
    ['listings', scale.geoListings],
    // #367 Workstream 10: the facet aggregates' own population. Floored against
    // the SCALE, never against what the generator wrote — that would be circular.
    ['canonical_attribute_values', scale.products + Math.floor(scale.products / 5)],
    ['source_records', sourceRecordCount(scale)],
  ]);
}

/** The census the floors are checked against — one statement, real counts. */
export async function countSeededRows(db: Database): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const table of SEEDED_TABLES) {
    const rows = await db.execute<{ count: string | number }>(
      sql.raw(`select count(*)::bigint as count from ${table}`),
    );
    counts.set(table, Number(rows[0]?.count ?? 0));
  }
  return counts;
}
