/**
 * What the per-locale full-text index COSTS to maintain and what it BUYS to
 * read — issue #367 Workstream 5, the half a CI gate cannot answer.
 *
 * ## The division, and why there are two artefacts
 *
 * `db/__tests__/folding-benchmark.realdb.test.ts` measures RECALL: does an
 * accented query find its unaccented stored form, per folding space. That needs
 * fourteen rows, runs in seconds and is a gate on every push.
 *
 * This measures COST, which needs scale, a `DROP INDEX`, and a `bench`
 * database — #61's `graph-query-benchmark.ts` split, for #61's reason: seeding
 * and re-indexing twenty thousand rows on every commit tells nobody anything.
 *
 * ## The method, and the trap it exists to avoid
 *
 * A first attempt at this ran three trials per arm in BLOCKS against the real
 * table and reported "+1.2% on insert, -1.5% on update". Both numbers were
 * noise: the within-arm spread was about 250 ms and the effect being looked for
 * is about 90 ms, so the instrument could not have resolved it either way. A
 * null result and a blind instrument look identical, which is this repository's
 * house failure mode wearing a benchmark's clothes.
 *
 * So every arm here is INTERLEAVED within each trial (drift hits all arms alike
 * instead of accruing to whichever ran last), every figure is reported beside
 * the spread it must clear, and a difference smaller than the worst inter-
 * quartile range is printed as NOT RESOLVED rather than as a percentage.
 *
 * The decomposition uses tables cloned with
 * `LIKE listing_localizations INCLUDING GENERATED`, so the generated expression
 * under test is the DEPLOYED one rather than a transcription of it — the
 * workload table's rule, applied to DDL.
 *
 * ## Running it
 *
 * ```sh
 * cd packages/backend
 * bun run db:migrate -- --target-database=mercaria_bench --phase=all
 *
 * FOLDING_BENCHMARK=1 \
 *   DATABASE_URL=postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_bench \
 *   bun run scripts/folding-index-benchmark.ts --rows=20000 --trials=8
 * ```
 *
 * Two gates, the same pair `graph-query-benchmark.ts` uses:
 * `FOLDING_BENCHMARK=1` says "I meant to run a benchmark" and the database name
 * containing `bench` says "and this is the database I meant to run it on". This
 * script TRUNCATES its own scratch tables and DROPS AND RECREATES a real index.
 */

import { createDatabase } from '@oxyhq/db';
import { sql } from 'drizzle-orm';
import * as schema from '../src/db/schema/index.js';

interface Options {
  readonly rows: number;
  readonly trials: number;
}

const write = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

function flag(argv: readonly string[], name: string): string | undefined {
  return argv.find((argument) => argument.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
}

function parseOptions(argv: readonly string[]): Options {
  const readInt = (name: string, fallback: number): number => {
    const raw = flag(argv, name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`--${name} must be a positive integer, got ${raw}.`);
    }
    return value;
  };
  return { rows: readInt('rows', 20_000), trials: readInt('trials', 8) };
}

function assertSafeTarget(): string {
  if (process.env['FOLDING_BENCHMARK'] !== '1') {
    throw new Error(
      'Refusing to run: set FOLDING_BENCHMARK=1. This script truncates scratch tables and ' +
        'drops and recreates listing_localizations_search_vector_idx.',
    );
  }
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('Refusing to run: DATABASE_URL is not set.');
  const databaseName = new URL(url).pathname.replace(/^\//u, '');
  if (!databaseName.includes('bench')) {
    throw new Error(
      `Refusing to run against "${databaseName}": the database name must contain "bench".`,
    );
  }
  return url;
}

/** Nearest-rank percentile over a sorted copy. `measure.ts`'s convention. */
function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) throw new Error('percentile of an empty sample');
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1] ?? 0;
}

/** One arm's timings, plus the spread any claim about it has to clear. */
interface ArmSummary {
  readonly label: string;
  readonly medianMs: number;
  readonly iqrMs: number;
  readonly trials: number;
  readonly rowsPerTrial: number;
}

function summarize(label: string, samples: readonly number[], rowsPerTrial: number): ArmSummary {
  return {
    label,
    medianMs: percentile(samples, 0.5),
    iqrMs: percentile(samples, 0.75) - percentile(samples, 0.25),
    trials: samples.length,
    rowsPerTrial,
  };
}

/**
 * Report a difference only when it exceeds the noise, and say so when it does
 * not.
 *
 * The whole discipline of this script in one function: a percentage printed
 * beside a spread that swamps it is a number somebody will quote.
 */
function compare(before: ArmSummary, after: ArmSummary): string {
  const delta = after.medianMs - before.medianMs;
  const noise = Math.max(before.iqrMs, after.iqrMs);
  const percent = ((delta / before.medianMs) * 100).toFixed(1);
  const detail =
    `${before.label} ${before.medianMs.toFixed(1)} ms -> ${after.label} ` +
    `${after.medianMs.toFixed(1)} ms (delta ${delta.toFixed(1)} ms, worst IQR ` +
    `${noise.toFixed(1)} ms)`;
  return Math.abs(delta) > noise
    ? `  RESOLVED  ${percent}% :: ${detail}`
    : `  NOT RESOLVED (effect is inside the noise) :: ${detail}`;
}

async function main(): Promise<void> {
  const databaseUrl = assertSafeTarget();
  const options = parseOptions(process.argv.slice(2));
  const { client, db } = createDatabase({
    databaseUrl,
    schema,
    client: { max: 2, onnotice: () => undefined },
  });

  try {
    write(
      `Measuring the localized full-text index over ${String(options.rows)} rows, ` +
        `${String(options.trials)} interleaved trials per arm.`,
    );

    // Three arms, cloned FROM the real table so the generated expression is the
    // deployed one:
    //   a  plain   — search_vector dropped        -> the row write alone
    //   b  vector  — generated column, no index   -> adds tsvector generation
    //   c  indexed — generated column + GIN index -> adds index maintenance
    //
    // a -> b is the POSITIVE CONTROL. If it shows no difference the instrument
    // cannot see a write cost at all and b -> c means nothing.
    await db.execute(sql`drop table if exists folding_bench_a, folding_bench_b, folding_bench_c`);
    for (const arm of ['a', 'b', 'c']) {
      await db.execute(
        sql.raw(
          `create table folding_bench_${arm} (like listing_localizations including generated including defaults)`,
        ),
      );
    }
    await db.execute(sql`alter table folding_bench_a drop column search_vector`);
    await db.execute(
      sql`create index folding_bench_c_sv on folding_bench_c using gin (search_vector)`,
    );

    const inserts = new Map<string, number[]>([
      ['a', []],
      ['b', []],
      ['c', []],
    ]);
    const updates = new Map<string, number[]>([
      ['a', []],
      ['b', []],
      ['c', []],
    ]);

    for (let trial = 0; trial < options.trials; trial += 1) {
      for (const arm of ['a', 'b', 'c']) {
        await db.execute(sql.raw(`truncate table folding_bench_${arm}`));

        const insertSql = `
          insert into folding_bench_${arm}
            (id, listing_id, locale, title, description, status, source_locale,
             provenance, reviewed_by_oxy_user_id, reviewed_at)
          select 'x'||g, 'l'||g, 'fr',
                 'bicyclette rouge en bon état modèle '||g,
                 'une très belle bicyclette d occasion, état correct, livraison rapide '||g,
                 'approved', 'en', 'mercaria', 'r', now()
            from generate_series(1, ${String(options.rows)}) g`;

        let started = performance.now();
        const inserted = await db.execute(sql.raw(insertSql));
        inserts.get(arm)?.push(performance.now() - started);

        // Vacuity: an arm that wrote nothing would be the fastest of the three.
        const insertedCount = Array.isArray(inserted) ? inserted.length : 0;
        void insertedCount;
        const [count] = await db.execute<{ total: number }>(
          sql.raw(`select count(*)::int as total from folding_bench_${arm}`),
        );
        if ((count?.total ?? 0) !== options.rows) {
          throw new Error(
            `Arm ${arm} holds ${String(count?.total ?? 0)} rows, expected ` +
              `${String(options.rows)} — this run measured nothing.`,
          );
        }

        started = performance.now();
        await db.execute(
          sql.raw(
            `update folding_bench_${arm} set title = 'vélo rouge en très bon état modèle '||id`,
          ),
        );
        updates.get(arm)?.push(performance.now() - started);
      }
    }

    for (const [operation, samples] of [
      ['insert', inserts],
      ['update', updates],
    ] as const) {
      const plain = summarize('plain', samples.get('a') ?? [], options.rows);
      const vector = summarize('vector', samples.get('b') ?? [], options.rows);
      const indexed = summarize('indexed', samples.get('c') ?? [], options.rows);
      write(`\n${operation.toUpperCase()} of ${String(options.rows)} rows`);
      write(`  positive control — what generating the tsvector costs:`);
      write(compare(plain, vector));
      write(`  the question — what the GIN index costs on top of that:`);
      write(compare(vector, indexed));
    }

    write('\nCleaning up the scratch tables.');
    await db.execute(sql`drop table if exists folding_bench_a, folding_bench_b, folding_bench_c`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

await main();
