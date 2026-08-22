/**
 * `CATALOG_ROLLOUT_COHORTS` gates a REQUEST and nothing durable — as a scan
 * rather than as a sentence (ADR 0007 D12, house invariant "a flag gates the
 * LOOP or the MOUNT, never a durable record").
 *
 * D12's four levers each carry a wall of this shape (`#552`), and the reason a
 * fifth lever needs its own is that this one is the easiest of the five to
 * misuse. A boolean lever is read at a mount and there is nowhere else obvious to
 * put it. A COHORT looks like something a repository could helpfully filter on —
 * "only return this store's drafts while we are staging" — and the moment one
 * does, narrowing the rollout stops meaning "these people cannot reach the
 * surface" and starts meaning "these rows are gone", which is precisely the
 * rollback that costs a merchant an afternoon of typing.
 *
 * ## The population is WALKED, and the verdict is a directory RULE
 *
 * Every non-test `.ts` under `src/` is read, so a module nobody has written yet
 * is covered. A file that mentions the cohort vocabulary is then classified by
 * WHERE it lives, not by a list of filenames: configuration, the middleware, the
 * domain itself and the route layer may read it; `db/`, every other `services/`
 * directory, `controllers/` and `jobs/` may not.
 *
 * Both directions are floored. A walk that reached nothing would report no
 * violations, and a rule that matched nothing would report the same — so the
 * file count, the matched count and the permitted-reader count are asserted
 * separately, because they break independently.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SRC_ROOT, walkOwnedDirectory } from '../../../__tests__/domain-population.js';
import { stripComments } from '../../../__tests__/package-barrel-symbols.js';

/**
 * The symbols that MEAN "this module consults the rollout cohorts".
 *
 * The config property is here as well as the functions because it is the one a
 * repository would reach for directly — `config.catalog.rolloutCohorts` inside a
 * `where` clause is the exact defect this file exists to catch, and it names no
 * function at all.
 */
const COHORT_SYMBOLS: readonly { readonly signal: string; readonly pattern: RegExp }[] = [
  { signal: 'config.catalog.rolloutCohorts', pattern: /\bconfig\s*\.\s*catalog\s*\.\s*rolloutCohorts\b/u },
  { signal: 'CATALOG_ROLLOUT_COHORTS', pattern: /\bCATALOG_ROLLOUT_COHORTS\b/u },
  { signal: 'catalogRolloutGate', pattern: /\bcatalogRolloutGate\b/u },
  { signal: 'catalogRolloutAllowedFor', pattern: /\bcatalogRolloutAllowedFor\b/u },
  { signal: 'parseCatalogRolloutCohorts', pattern: /\bparseCatalogRolloutCohorts\b/u },
  { signal: 'catalogRolloutSubjectFromRequest', pattern: /\bcatalogRolloutSubjectFromRequest\b/u },
];

/**
 * Where a cohort reader may live.
 *
 * A RULE over directories rather than a list of files: a sixth gated route
 * added under `routes/` is permitted without editing this test, and a
 * repository added under `db/` is refused without anybody having to remember to
 * add it. A list would have had to be edited in both cases, and only one of them
 * is a change somebody would think to come here for.
 */
function isPermittedReader(path: string): boolean {
  return (
    path === 'config/index.ts' ||
    path === 'middleware/catalog-rollout.ts' ||
    path.startsWith('services/catalog-rollout/') ||
    path.startsWith('routes/')
  );
}

/** Every non-test module under `src/`. */
function backendModules(): string[] {
  return walkOwnedDirectory('');
}

interface Reader {
  readonly path: string;
  readonly signals: string[];
}

function cohortReaders(paths: readonly string[]): Reader[] {
  const readers: Reader[] = [];
  for (const path of paths) {
    // Comment-stripped, because every file in this domain DOCUMENTS the
    // vocabulary it must not reach — the module docblocks name
    // `catalogRolloutGate` and `CATALOG_ROLLOUT_COHORTS` repeatedly — and a scan
    // that kept comments would report the routes' own explanations as reads.
    const source = stripComments(readFileSync(join(SRC_ROOT, path), 'utf8'));
    const signals = COHORT_SYMBOLS.filter((symbol) => symbol.pattern.test(source)).map(
      (symbol) => symbol.signal,
    );
    if (signals.length > 0) readers.push({ path, signals });
  }
  return readers;
}

describe('the population is real and the scan finds something in it', () => {
  const modules = backendModules();
  const readers = cohortReaders(modules);

  it('walks the whole backend, not a corner of it', () => {
    // Today's tree is well over a thousand modules. The floor is far below that
    // deliberately — it exists to catch a walk that collapsed, not to pin a
    // count that grows on its own.
    expect(modules.length, 'the module walk collapsed').toBeGreaterThanOrEqual(500);
    expect(modules).toContain('app.ts');
    expect(modules).toContain('config/index.ts');
    // Negative control: the walk must not be reaching into the test tree, or
    // this file's own docblock would be counted as a reader.
    expect(modules.some((path) => path.includes('__tests__'))).toBe(false);
  });

  it('finds the readers it should, across every layer that is allowed one', () => {
    // The vacuity floor that matters. A broken pattern, a NUL byte or a renamed
    // symbol would leave `readers` empty and every violation assertion below
    // green — "I found less" and "there is less" look identical.
    const paths = readers.map((reader) => reader.path);
    expect(paths, 'the cohort scan found no reader at all').toContain('config/index.ts');
    expect(paths).toContain('middleware/catalog-rollout.ts');
    expect(paths).toContain('services/catalog-rollout/cohort.ts');
    // Six route modules carry the gate today; the floor is on the SHAPE (at
    // least one route reader) plus a total, so adding a seventh needs no edit
    // and removing all six goes red.
    expect(
      paths.filter((path) => path.startsWith('routes/')).length,
      'no route module reads the gate — every catalog surface is ungated',
    ).toBeGreaterThanOrEqual(6);
    expect(readers.length).toBeGreaterThanOrEqual(9);
  });
});

describe('no durable-record path consults a rollout cohort', () => {
  it('every reader sits in configuration, the middleware, the domain or a route', () => {
    const violations = cohortReaders(backendModules())
      .filter((reader) => !isPermittedReader(reader.path))
      .map((reader) => `${reader.path} reads ${reader.signals.join(', ')}`);
    expect(
      violations,
      'a rollout cohort reached a layer that owns rows, jobs or business decisions:\n' +
        violations.join('\n'),
    ).toEqual([]);
  });

  it('the classifier detects — a repository, a service and a job are all refused', () => {
    // The mutation self-test on the instrument. Without it, an
    // `isPermittedReader` that returned `true` unconditionally would report a
    // clean tree forever, and so would one whose walk returned nothing.
    expect(isPermittedReader('db/catalogAuthoring/draftRepository.ts')).toBe(false);
    expect(isPermittedReader('services/catalog-authoring/schema.service.ts')).toBe(false);
    expect(isPermittedReader('services/moderation/outbox.dispatcher.ts')).toBe(false);
    expect(isPermittedReader('controllers/catalog-authoring.controller.ts')).toBe(false);
    // …and the permitted half, so the detector cannot pass by refusing
    // everything.
    expect(isPermittedReader('config/index.ts')).toBe(true);
    expect(isPermittedReader('middleware/catalog-rollout.ts')).toBe(true);
    expect(isPermittedReader('routes/navigation.ts')).toBe(true);
    expect(isPermittedReader('services/catalog-rollout/cohort.ts')).toBe(true);
  });

  it('the symbol patterns detect what they claim to', () => {
    // Each pattern run against a line that MUST match and one that must not, so
    // a pattern broken into one that matches nothing cannot sit here green.
    const positives: Record<string, string> = {
      'config.catalog.rolloutCohorts': 'const c = config.catalog.rolloutCohorts;',
      CATALOG_ROLLOUT_COHORTS: "strEnv('CATALOG_ROLLOUT_COHORTS', '')",
      catalogRolloutGate: 'router.use(catalogRolloutGate());',
      catalogRolloutAllowedFor: 'if (catalogRolloutAllowedFor(cohorts, subject)) return;',
      parseCatalogRolloutCohorts: 'parseCatalogRolloutCohorts(raw)',
      catalogRolloutSubjectFromRequest: 'const s = catalogRolloutSubjectFromRequest(req);',
    };
    expect(Object.keys(positives).sort()).toEqual(
      COHORT_SYMBOLS.map((symbol) => symbol.signal).sort(),
    );
    for (const symbol of COHORT_SYMBOLS) {
      expect(symbol.pattern.test(positives[symbol.signal] ?? ''), symbol.signal).toBe(true);
      expect(
        symbol.pattern.test('const cohorts = config.catalog.readCohorts;'),
        `${symbol.signal} matched a DIFFERENT domain's cohort list`,
      ).toBe(false);
    }
  });
});
