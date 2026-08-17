/**
 * Seed a reference vertical package (#367 Workstream 14).
 *
 * ```
 *   bun run src/scripts/seed-verticals/index.ts                       # dry run, all three
 *   bun run src/scripts/seed-verticals/index.ts --package=footwear    # dry run, one
 *   bun run src/scripts/seed-verticals/index.ts --apply               # write
 *   bun run src/scripts/seed-verticals/index.ts --apply --namespace=demo
 * ```
 *
 * **The default is a DRY RUN**, and it reads the database — see `apply.ts` for
 * why that distinction is the whole point of having a dry run at all.
 *
 * ## Exit codes, and what each one means for the operator
 *
 * - `0` — everything the package declares is present and agrees.
 * - `1` — a step DIVERGED (a stored row disagrees with the package, or an
 *   observation could not be normalized), or the census found the wrong number
 *   of rows, or it found NOTHING. Nothing is corrected: this seed's authority is
 *   to add what is missing, and rewriting a row somebody edited in the database
 *   is how a hand-applied fix silently comes back.
 *
 * The census runs after a real apply and is skipped after a dry run, because
 * counting rows nobody wrote answers a question nobody asked.
 */

import { connectPostgres } from '../../db/postgres.js';
import { applyVerticalPackage, namespaceFor, type SeedReport } from './apply.js';
import { censusVerticalPackage, deriveExpectation, formatCensus } from './census.js';
import { BRAKE_PAD_PACKAGE } from './brake-pad.js';
import { FOOTWEAR_PACKAGE } from './footwear.js';
import { SMARTPHONE_PACKAGE } from './smartphone.js';
import type { VerticalPackage } from './types.js';

/** Every package, in the order a fresh database should receive them. */
export const VERTICAL_PACKAGES: readonly VerticalPackage[] = [
  FOOTWEAR_PACKAGE,
  SMARTPHONE_PACKAGE,
  BRAKE_PAD_PACKAGE,
];

export function verticalPackageByName(name: string): VerticalPackage | undefined {
  return VERTICAL_PACKAGES.find((pkg) => pkg.name === name);
}

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match === undefined ? undefined : match.slice(prefix.length);
}

function printReport(report: SeedReport): void {
  const verb = report.applied ? 'applied' : 'would apply';
  process.stdout.write(
    `\n${report.packageName} (namespace '${report.namespace.snake}') — ${verb}\n`,
  );
  for (const step of report.steps) {
    const mark = step.outcome === 'create' ? '+' : step.outcome === 'present' ? '=' : '!';
    process.stdout.write(
      `  ${mark} ${step.entity.padEnd(22)} ${step.identity}${step.detail === undefined ? '' : `\n      ${step.detail}`}\n`,
    );
  }
  process.stdout.write(
    `  ${report.created} to create, ${report.present} already present, ${report.divergent} divergent\n`,
  );
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const requested = flag('package');
  const namespaceToken = flag('namespace');
  const actorOxyUserId = flag('actor') ?? 'mercaria-reference-verticals';

  const packages =
    requested === undefined || requested === 'all'
      ? VERTICAL_PACKAGES
      : [verticalPackageByName(requested)].filter(
          (pkg): pkg is VerticalPackage => pkg !== undefined,
        );

  if (packages.length === 0) {
    process.stderr.write(
      `Unknown package '${requested}'. Known: ${VERTICAL_PACKAGES.map((pkg) => pkg.name).join(', ')}, all.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const db = await connectPostgres();
  let failed = false;

  for (const pkg of packages) {
    // The declared expectation and the one the DATA implies must agree before
    // anything is written. They are two statements of one fact and the whole
    // census rests on them not drifting — a package whose `expect` was edited
    // by hand to match a bad run would otherwise validate that run forever.
    const derived = deriveExpectation(pkg);
    const drift = (Object.keys(derived) as (keyof typeof derived)[]).filter(
      (entity) => derived[entity] !== pkg.expect[entity],
    );
    if (drift.length > 0) {
      process.stderr.write(
        `${pkg.name}: the declared expectation disagrees with the package data for ` +
          `${drift.map((entity) => `${entity} (declared ${pkg.expect[entity]}, data implies ${derived[entity]})`).join(', ')}.\n`,
      );
      failed = true;
      continue;
    }

    const { report } = await applyVerticalPackage(
      pkg,
      {
        apply,
        ...(namespaceToken === undefined ? {} : { namespace: namespaceToken }),
        actorOxyUserId,
      },
      db,
    );
    printReport(report);
    if (report.divergent > 0) failed = true;

    if (!apply) continue;
    const verdict = await censusVerticalPackage(
      db,
      pkg,
      namespaceFor(namespaceToken ?? pkg.name),
    );
    process.stdout.write(`\n${formatCensus(verdict)}\n`);
    if (verdict.outcome !== 'matched') failed = true;
  }

  if (!apply) {
    process.stdout.write(
      '\nDry run. Nothing was written. Re-run with --apply to write, and the census will follow it.\n',
    );
  }
  if (failed) process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}
