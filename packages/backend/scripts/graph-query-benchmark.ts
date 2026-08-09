/**
 * The canonical graph's query plans, at scale — issue #61.
 *
 * Opt-in and OUT of the normal suite, deliberately, for the reason
 * `offer-load-benchmark.ts` (#57) states and this inherits: seeding a hundred
 * thousand products in CI is a long job that tells nobody anything on every
 * commit. What CI DOES run is the plan-regression suite
 * (`src/db/__tests__/graph-plan-regression.realdb.test.ts`), which drives the
 * SAME workload table against a small seed and fails the build when a read
 * stops using the index it was measured on. This script is what produces the
 * numbers; that test is what keeps them true.
 *
 * ## Running it
 *
 * ```sh
 * # The database must exist, carry postgis + pg_trgm, and be migrated:
 * cd packages/backend
 * bun run db:migrate -- --target-database=mercaria_bench --phase=all
 *
 * GRAPH_BENCHMARK=1 \
 *   DATABASE_URL=postgres://mercaria:mercaria@127.0.0.1:5435/mercaria_bench \
 *   bun run scripts/graph-query-benchmark.ts --scale=medium --out=../../docs/performance
 * ```
 *
 * Flags: `--scale=small|medium|large`, `--seed=<int>`, `--runs=<int>` (latency
 * samples per statement), `--out=<dir>` (omit to print to stdout),
 * `--label=<stem>` (the report filename, so a before/after pair does not
 * overwrite itself) and `--no-seed` (measure an already-seeded database — for a
 * before/after pass where the dataset must not move between the two).
 *
 * ## Two gates, and the generator has a third
 *
 * `GRAPH_BENCHMARK=1` says "I meant to run a benchmark"; the database name
 * containing `bench` says "and this is the database I meant to run it on". The
 * generator TRUNCATES, so it re-checks `current_database()` itself rather than
 * trusting a caller to have checked — a truncation guarded in one file is
 * guarded once.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  BENCHMARK_SCALES,
  deriveSeedPlan,
  seedGraph,
  type BenchmarkScale,
} from '../src/services/graph-benchmark/dataset.js';
import { createCapturingDatabase, runBenchmark } from '../src/services/graph-benchmark/runner.js';
import { collectViolations, renderReport } from '../src/services/graph-benchmark/report.js';
import { WORKLOAD_SHAPES } from '../src/services/graph-benchmark/workload.js';

interface Options {
  readonly scale: BenchmarkScale;
  readonly seed: number;
  readonly runs: number;
  readonly outDir: string | null;
  /** Filename stem, so a before/after pair does not overwrite itself. */
  readonly label: string;
  readonly reseed: boolean;
}

function flag(argv: readonly string[], name: string): string | undefined {
  return argv.find((argument) => argument.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
}

function parseOptions(argv: readonly string[]): Options {
  const scaleName = flag(argv, 'scale') ?? 'small';
  const scale = BENCHMARK_SCALES[scaleName];
  if (!scale) {
    throw new Error(
      `Unknown --scale=${scaleName}. Known scales: ${Object.keys(BENCHMARK_SCALES).join(', ')}.`,
    );
  }
  const readInt = (name: string, fallback: number): number => {
    const raw = flag(argv, name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`--${name} must be a positive integer, got ${raw}.`);
    }
    return value;
  };
  const outDir = flag(argv, 'out');
  return {
    scale,
    label: flag(argv, 'label') ?? scale.name,
    seed: readInt('seed', 61),
    runs: readInt('runs', 50),
    outDir: outDir === undefined ? null : resolve(outDir),
    reseed: !argv.includes('--no-seed'),
  };
}

function assertSafeTarget(): string {
  if (process.env.GRAPH_BENCHMARK !== '1') {
    throw new Error(
      'Refusing to run: set GRAPH_BENCHMARK=1. This script TRUNCATES and re-seeds the ' +
        'canonical graph.',
    );
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Refusing to run: DATABASE_URL is not set.');
  const databaseName = new URL(url).pathname.replace(/^\//, '');
  if (!databaseName.includes('bench')) {
    throw new Error(
      `Refusing to run against "${databaseName}": the database name must contain "bench".`,
    );
  }
  return url;
}

const write = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

async function main(): Promise<void> {
  const databaseUrl = assertSafeTarget();
  const options = parseOptions(process.argv.slice(2));
  const capturing = createCapturingDatabase(databaseUrl);

  try {
    write(
      `Benchmarking ${String(WORKLOAD_SHAPES.length)} shipped reads at scale ` +
        `"${options.scale.name}" (seed ${String(options.seed)}, ${String(options.runs)} runs each)`,
    );
    // `--no-seed` exists for the before/after pass, where the dataset must be
    // byte-identical across the two runs: re-seeding between them would change
    // the physical layout as well as the schema, and the difference could then
    // be attributed to either. Both branches go through the SAME plan
    // arithmetic (`buildSeedPlan`), so "the hottest variant" cannot mean two
    // different things in the two halves of a comparison.
    const graph = options.reseed
      ? await seedGraph(capturing.db, options.scale, options.seed, write)
      : deriveSeedPlan(options.scale);

    const result = await runBenchmark(capturing, graph, options.seed, options.runs, write);
    const markdown = renderReport(result);
    const violations = collectViolations(result);

    if (options.outDir === null) {
      write(markdown);
    } else {
      await mkdir(options.outDir, { recursive: true });
      const path = join(options.outDir, `plans-${options.label}.md`);
      await writeFile(path, `${markdown}\n`, 'utf8');
      write(`\nWrote ${path}`);
    }

    if (violations.length > 0) {
      write('\nThis run measured nothing. Violations:');
      for (const violation of violations) write(`  - ${violation}`);
      process.exitCode = 1;
    }
  } finally {
    await capturing.close();
  }
}

await main();
