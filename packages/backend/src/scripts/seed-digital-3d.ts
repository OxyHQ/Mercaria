/**
 * Seed the Mercaria 3D product profiles and the reference licences
 * (#1015 Workstream 3).
 *
 * ```
 *   bun run src/scripts/seed-digital-3d.ts                    # dry run, everything
 *   bun run src/scripts/seed-digital-3d.ts --licences-only    # dry run, the licences
 *   bun run src/scripts/seed-digital-3d.ts --apply            # write
 *   bun run src/scripts/seed-digital-3d.ts --apply --namespace=demo
 * ```
 *
 * A flat script beside `provision-taxonomy.ts` and `provision-fee-schedule.ts`,
 * which is this repository's shape for "an operator applies a decision to a
 * database". The package it applies lives in
 * `services/digital/profiles/`, not here: a seed that held its own data would be
 * a second copy of the vocabulary the services and their tests read.
 *
 * **There is no root `package.json` shortcut**, unlike `seed:verticals`. Adding
 * one is a one-line change to a file this workstream does not own; until
 * somebody makes it, the two invocations above are the whole interface and
 * `docs/verticals/3d.md` carries them.
 *
 * ## The default is a DRY RUN, and it reads the database
 *
 * `--apply` is what writes. Without it every step still runs its EXISTENCE query
 * and reports `create` or `present`, so the plan is a statement about the real
 * database rather than about the package. A dry run that only echoed the fixture
 * would print the same output against a database where half the package already
 * exists and against one where none of it does.
 *
 * ## Exit codes
 *
 * - `0` — everything the package declares is present and agrees.
 * - `1` — the declared expectation disagrees with the package data, or a step
 *   DIVERGED (a stored row disagrees and is never overwritten), or the census
 *   found the wrong number of rows, or it found NOTHING.
 *
 * The census runs after a real apply and is skipped after a dry run, because
 * counting rows nobody wrote answers a question nobody asked.
 *
 * ## Running it twice
 *
 * Required, and the thing to know is WHICH half the second run exercises. The
 * catalogue half converges on `categories.key`, `attribute_definitions.key` and
 * `(product_type_definitions.key, version)`; the licence half converges on
 * `asset_licences`' partial unique over a NULL `store_id`, plus a read of version
 * 1 whatever state it is in — which is what makes a run interrupted between the
 * insert and the publish resumable rather than permanently stuck on
 * `asset_licence_versions_licence_version_key`.
 *
 * ## `--namespace` is for tests, and production wants it ABSENT
 *
 * Without it the keys are the canonical ones — `three_d_print_model`,
 * `intended_use` — which is what `THREE_D_PROFILE_KEYS` publishes and therefore
 * what a deployment must store. With it every key and slug is prefixed, which is
 * what parallel test files need against one shared database. The licences are
 * NEVER namespaced: there is exactly one `mercaria-personal` in the world, by a
 * partial unique index, and that is the point of it.
 */

import { THREE_D_PROFILE_VERTICAL } from '@mercaria/shared-types';

import { connectPostgres } from '../db/postgres.js';
import {
  applyThreeDProfilePackage,
  applyReferenceLicences,
  censusThreeDProfiles,
  deriveExpectation,
  disagreementsWithPublishedVocabulary,
  formatProfileCensus,
  namespaceFor,
  profileVocabularyFingerprint,
  THREE_D_PROFILE_PACKAGE,
  type ProfileSeedReport,
  type ProfileStep,
} from '../services/digital/profiles/index.js';

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match === undefined ? undefined : match.slice(prefix.length);
}

function printSteps(steps: readonly ProfileStep[]): void {
  for (const step of steps) {
    const mark = step.outcome === 'create' ? '+' : step.outcome === 'present' ? '=' : '!';
    process.stdout.write(
      `  ${mark} ${step.entity.padEnd(22)} ${step.identity}` +
        `${step.detail === undefined ? '' : `\n      ${step.detail}`}\n`,
    );
  }
}

function printReport(report: ProfileSeedReport): void {
  const verb = report.applied ? 'applied' : 'would apply';
  const namespace = report.namespace === null ? 'canonical keys' : `namespace '${report.namespace.snake}'`;
  process.stdout.write(`\n${report.packageName} (${namespace}) — ${verb}\n`);
  printSteps(report.steps);
  process.stdout.write(
    `  ${report.created} to create, ${report.present} already present, ${report.divergent} divergent\n`,
  );
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const licencesOnly = process.argv.includes('--licences-only');
  const namespaceToken = flag('namespace');
  const actorOxyUserId = flag('actor') ?? 'mercaria-reference-3d-profiles';
  const pkg = THREE_D_PROFILE_PACKAGE;

  // Both published vocabularies the package must agree with, BEFORE anything is
  // read or written: a package missing a profile `THREE_D_PROFILE_KEYS` names, or
  // seeding a licence `MERCARIA_REFERENCE_LICENCES` has no terms for, is a
  // package that cannot be applied correctly at all.
  const disagreements = disagreementsWithPublishedVocabulary(pkg);
  if (disagreements.length > 0) {
    for (const problem of disagreements) process.stderr.write(`${problem}\n`);
    process.exitCode = 1;
    return;
  }

  // The declared expectation and the one the DATA implies must agree before
  // anything is written. They are two statements of one fact, produced
  // differently, and the whole census rests on them not drifting — a package
  // whose `expect` was hand-edited to match a bad run would otherwise validate
  // that run forever.
  const derived = deriveExpectation(pkg);
  const drift = (Object.keys(derived) as (keyof typeof derived)[]).filter(
    (entity) => derived[entity] !== pkg.expect[entity],
  );
  if (drift.length > 0) {
    process.stderr.write(
      `${pkg.name}: the declared expectation disagrees with the package data for ` +
        `${drift
          .map((entity) => `${entity} (declared ${pkg.expect[entity]}, data implies ${derived[entity]})`)
          .join(', ')}.\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `${pkg.title} — vocabulary ${profileVocabularyFingerprint(pkg)}\n${pkg.proves}\n` +
      // The lever key, printed because seeding the profiles does not make them
      // sellable: ADR 0010 D13's fifth lever is an ALLOW-list and defaults EMPTY,
      // so a deployment that applied this and set nothing sells none of it — and
      // an operator should read that here rather than discover it from an empty
      // storefront.
      `Selling any of this also needs '${THREE_D_PROFILE_VERTICAL}' in DIGITAL_ENABLED_VERTICALS.\n`,
  );

  const db = await connectPostgres();
  let failed = false;

  if (licencesOnly) {
    // The licence half alone, because it is the half a deployment may want
    // before it has decided anything about the catalogue: it names no category,
    // no attribute and no product type, so it is genuinely independent rather
    // than merely separable.
    const result = await applyReferenceLicences(pkg, { apply }, db);
    process.stdout.write(`\nreference licences — ${apply ? 'applied' : 'would apply'}\n`);
    printSteps(result.steps);
    if (result.steps.some((step) => step.outcome === 'divergent')) failed = true;
  } else {
    const { report } = await applyThreeDProfilePackage(
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

    if (apply) {
      const verdict = await censusThreeDProfiles(
        db,
        pkg,
        namespaceToken === undefined ? null : namespaceFor(namespaceToken),
      );
      process.stdout.write(`\n${formatProfileCensus(verdict)}\n`);
      if (verdict.outcome !== 'matched') failed = true;
    }
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
