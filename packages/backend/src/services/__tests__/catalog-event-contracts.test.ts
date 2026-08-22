/**
 * Every catalogue event contract names a carrier, a producer set, a consumer
 * and a retry posture that are STILL TRUE (#367 Workstream 0).
 *
 * ## What this exists to catch, measured rather than imagined
 *
 * `services/catalog-event-contracts.ts` could have been a paragraph. Three
 * paragraphs describing exactly these mechanisms were already in the repository
 * when it was written, all correct on the day they were written, and all wrong
 * now:
 *
 *  - "three enqueuers" for `attribute_reindex_requests`, in
 *    `services/catalog-observability/trace.service.ts`, `queries.ts` and
 *    `docs/catalog-observability.md`. There are five producers, and the fifth
 *    (`services/backfill/stages/projections.ts`) is invisible to a census over
 *    the repository function because it inserts the table directly.
 *  - "four triggers" writing `catalog_localization_revisions`, in
 *    `db/schema/catalogLocalization.ts` and
 *    `db/catalogLocalization/revisionRepository.ts`. Eight triggers write it.
 *  - `db/catalogLocalization/revisionRepository.ts`'s three exported readers,
 *    cited in a disposition and reachable from nothing.
 *
 * So every population below is DERIVED — from the drizzle schema barrel, from a
 * walk of the production source tree, and from the migration SQL — and compared
 * against what the register declares. The register is the decision; this file is
 * what stops the decision going stale.
 *
 * ## Comment-stripped, test tree excluded
 *
 * COMMENT-STRIPPED because this repository documents what it forbids in the
 * vocabulary it forbids: `trace.service.ts`'s docblock names
 * `listPendingReindexRequests` while asserting nothing calls it, and
 * `internal-catalog-attributes.controller.ts` names
 * `bumpAuthoringSchemaInvalidation` twice to say it deliberately does not call
 * it. A scan that kept comments would report both as producers, which is
 * precisely the reading this gate exists to refuse.
 *
 * String LITERALS survive stripping, and that is why the producer detector is
 * anchored on a CALL (`symbol(`) rather than on a mention:
 * `services/catalog-governance/impact-plan.ts` carries
 * `symbol: 'bumpAuthoringSchemaInvalidation'` inside a disposition, and a
 * bare-name scan reports the plan as a producer of the register it merely
 * describes. The limit that buys is stated rather than papered over: a call made
 * through a renamed import (`import { x as y }`) is invisible to it. That shape
 * appears nowhere in this repository's db layer, and the failure direction is a
 * missing producer, which the SET EQUALITY below turns red rather than green.
 *
 * The test tree is excluded because a test is not a production caller; counting
 * one would have made the translation-trail consumer look present for the whole
 * time it was unreachable — `db/__tests__/localization-revisions.realdb.test.ts`
 * exercises all three of its readers.
 *
 * ## Floors and controls
 *
 * Every population carries a vacuity floor, every detector carries a positive
 * control (it finds something it is known to find) and every set-equality check
 * carries a mutation self-test in BOTH directions — a declared member removed,
 * and an underived member added. A scan that found nothing and a repository with
 * nothing to find produce the same green.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { is, getTableName } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import {
  AUTHORING_INVALIDATION_SUBJECTS,
  CATALOG_GOVERNANCE_ACTIONS,
  type AuthoringInvalidationSubject,
} from '@mercaria/shared-types';

import * as schema from '../../db/schema/index.js';
import { stripComments } from '../../__tests__/package-barrel-symbols.js';
import { SRC_ROOT, walkOwnedDirectory } from '../../__tests__/domain-population.js';
import {
  CATALOG_EVENT_CARRIER_SHAPES,
  CATALOG_EVENT_CONTRACTS,
  CATALOG_EVENT_KINDS,
  CATALOG_PUBLICATION_INVALIDATION,
  type CatalogEventContract,
  type CatalogEventKind,
} from '../catalog-event-contracts.js';

/** `packages/backend/drizzle`, where every applied migration lives. */
const MIGRATIONS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../drizzle');

/** The register's own module, excluded from every derived population. */
const REGISTER_MODULE = 'services/catalog-event-contracts.ts';

/** The one module that applies governance actions; read for the bump assertions. */
const APPLY_MODULE = 'services/catalog-governance/apply.ts';

/* -------------------------------------------------------------------------- */
/* The populations                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every production `.ts` under `src/`, comment-stripped, keyed by path.
 *
 * `walkOwnedDirectory` drops the `__tests__` tree; the `.test.ts` filter drops
 * the co-located ones.
 */
function productionSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const relative of walkOwnedDirectory('')) {
    if (relative.endsWith('.test.ts')) continue;
    sources.set(relative, stripComments(readFileSync(join(SRC_ROOT, relative), 'utf8')));
  }
  return sources;
}

const SOURCES = productionSources();

const MIGRATION_FILES = readdirSync(MIGRATIONS_ROOT).filter((name) => name.endsWith('.sql'));
const MIGRATION_SQL = MIGRATION_FILES.map((name) =>
  readFileSync(join(MIGRATIONS_ROOT, name), 'utf8'),
).join('\n');

/** Every `PgTable` the drizzle barrel exports, by its SQL name. */
const TABLES_BY_SQL_NAME = new Map<string, PgTable>(
  Object.values(schema)
    .flatMap((value) => (is(value, PgTable) ? [value] : []))
    .map((table) => [getTableName(table), table]),
);

const CONTRACTS = Object.values(CATALOG_EVENT_CONTRACTS);

/* -------------------------------------------------------------------------- */
/* The detectors                                                              */
/* -------------------------------------------------------------------------- */

/** Production modules containing a CALL of `symbol`. See the header on why a call. */
function callers(symbol: string, sources: Map<string, string> = SOURCES): string[] {
  const pattern = new RegExp(`\\b${symbol}\\s*\\(`, 'u');
  return [...sources]
    .filter(([, source]) => pattern.test(source))
    .map(([relative]) => relative)
    .sort();
}

/** Production modules issuing an `insert`/`update`/`delete` against a drizzle table symbol. */
function tableWriters(tableSymbol: string, sources: Map<string, string> = SOURCES): string[] {
  const pattern = new RegExp(`\\.(?:insert|update|delete)\\(\\s*${tableSymbol}\\b`, 'u');
  return [...sources]
    .filter(([, source]) => pattern.test(source))
    .map(([relative]) => relative)
    .sort();
}

/** Production modules issuing an `update` against a drizzle table symbol. */
function tableUpdaters(tableSymbol: string, sources: Map<string, string> = SOURCES): string[] {
  const pattern = new RegExp(`\\.update\\(\\s*${tableSymbol}\\b`, 'u');
  return [...sources]
    .filter(([, source]) => pattern.test(source))
    .map(([relative]) => relative)
    .sort();
}

/** Production modules importing `module` (matched on its basename-bearing specifier). */
function importers(module: string, sources: Map<string, string> = SOURCES): string[] {
  const basename = module.slice(module.lastIndexOf('/') + 1).replace(/\.ts$/u, '');
  const pattern = new RegExp(`from\\s+'[^']*\\b${basename}\\.js'`, 'u');
  return [...sources]
    .filter(([relative, source]) => relative !== module && pattern.test(source))
    .map(([relative]) => relative)
    .sort();
}

/**
 * The module that EXPORTS `symbol`, or `null`. Anchored on the export form so a
 * re-export or a local `const` cannot stand in for a definition.
 */
function modulesExporting(symbol: string, sources: Map<string, string> = SOURCES): string[] {
  const pattern = new RegExp(
    `export\\s+(?:async\\s+)?(?:function|const|class)\\s+${symbol}\\b`,
    'u',
  );
  return [...sources]
    .filter(([, source]) => pattern.test(source))
    .map(([relative]) => relative)
    .sort();
}

/**
 * Every production module that WRITES a contract's carrier.
 *
 * The union of two detectors, and the union is the point: `enqueueAttributeReindex`
 * has four callers and the queue has five writers.
 */
function derivedProducers(
  contract: CatalogEventContract,
  sources: Map<string, string> = SOURCES,
): string[] {
  const found = new Set<string>(tableWriters(contract.tableSymbol, sources));
  if (contract.write.by === 'repository') {
    for (const relative of callers(contract.write.symbol, sources)) found.add(relative);
    found.delete(contract.write.definedIn);
  }
  for (const relative of [...found]) {
    if (relative === REGISTER_MODULE || relative.startsWith('db/schema/')) found.delete(relative);
  }
  return [...found].sort();
}

/**
 * Trigger names whose plpgsql function body inserts into `table`.
 *
 * Parsed from the concatenated migration SQL rather than from any list: a
 * migration is never edited, so the SQL is the only record of what the database
 * actually has. `CREATE OR REPLACE` is honoured by keeping the LAST body seen
 * for a function name.
 */
function triggersWritingTable(table: string, sql: string = MIGRATION_SQL): string[] {
  const bodies = new Map<string, string>();
  const functionPattern = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z0-9_]+)\s*\(\s*\)[^$]*\$\$([\s\S]*?)\$\$/giu;
  for (const match of sql.matchAll(functionPattern)) bodies.set(match[1], match[2]);

  const found = new Set<string>();
  const triggerPattern = /CREATE\s+TRIGGER\s+([a-z0-9_]+)[\s\S]*?EXECUTE\s+FUNCTION\s+([a-z0-9_]+)\s*\(/giu;
  for (const match of sql.matchAll(triggerPattern)) {
    const body = bodies.get(match[2]);
    if (body !== undefined && body.includes(`INSERT INTO "${table}"`)) found.add(match[1]);
  }
  return [...found].sort();
}

/** Every `AuthoringInvalidationSubject` a production module actually bumps. */
function subjectsWithAProducer(sources: Map<string, string> = SOURCES): string[] {
  const pattern = /bumpAuthoringSchemaInvalidation\s*\([\s\S]{0,400}?subject:\s*'([a-z_]+)'/gu;
  const found = new Set<string>();
  for (const [, source] of sources) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return [...found].sort();
}

/** Every `(subject, module)` bump site, for the floor and the controls. */
function bumpSites(sources: Map<string, string> = SOURCES): string[] {
  const pattern = /bumpAuthoringSchemaInvalidation\s*\([\s\S]{0,400}?subject:\s*'([a-z_]+)'/gu;
  const found = new Set<string>();
  for (const [relative, source] of sources) {
    for (const match of source.matchAll(pattern)) found.add(`${match[1]}@${relative}`);
  }
  return [...found].sort();
}

/* -------------------------------------------------------------------------- */
/* The populations are populated                                              */
/* -------------------------------------------------------------------------- */

describe('the populations this gate derives from', () => {
  it('walks a src tree, a migration set and a schema barrel that are actually populated', () => {
    // Floors per SHAPE rather than one total: the three break independently, and
    // one number lets any of them collapse while the others carry it. All three
    // are DERIVED sweeps that grow on their own, so the floors sit well below
    // today's counts — what they have to catch is a walk that COLLAPSED (a moved
    // root, a `readdirSync` returning nothing, a barrel import that resolved to
    // an empty module), not a legitimate addition.
    expect(SOURCES.size, `the src walk found ${String(SOURCES.size)} production modules`)
      .toBeGreaterThan(1_200);
    expect(
      MIGRATION_FILES.length,
      `the drizzle walk found ${String(MIGRATION_FILES.length)} migrations`,
    ).toBeGreaterThan(100);
    expect(MIGRATION_SQL.length, 'the migration concatenation is empty').toBeGreaterThan(100_000);
    expect(
      TABLES_BY_SQL_NAME.size,
      `the barrel yielded ${String(TABLES_BY_SQL_NAME.size)} PgTables`,
    ).toBeGreaterThan(300);
  });

  it('excludes the test tree, so a test can never be read as a production caller', () => {
    for (const relative of SOURCES.keys()) {
      expect(relative).not.toMatch(/__tests__|\.test\.ts$/u);
    }
    // The positive control for that exclusion: without it, "no path matched" is
    // satisfied by an empty walk. This test file is itself in the tree that was
    // dropped, and the realdb file below is the one that exercises the three
    // translation-trail readers this gate reports as having no production caller.
    expect(
      existsSync(join(SRC_ROOT, 'db/__tests__/localization-revisions.realdb.test.ts')),
      'the control file moved; the exclusion above is no longer proved by anything',
    ).toBe(true);
  });

  it('strips comments, and the control is a module that NAMES a symbol only in prose', () => {
    // `internal-catalog-attributes.controller.ts` says twice, in comments, that
    // it deliberately does not call `bumpAuthoringSchemaInvalidation`. If
    // stripping regressed, it would appear as a producer of the register and the
    // set-equality check below would fail with a module that calls nothing.
    const controller = SOURCES.get('controllers/internal-catalog-attributes.controller.ts');
    expect(controller, 'the control module moved').toBeDefined();
    expect(controller).not.toMatch(/bumpAuthoringSchemaInvalidation/u);

    // The inverse control: the raw file DOES contain the name, so the assertion
    // above measures stripping rather than a file that never mentioned it.
    const raw = readFileSync(
      join(SRC_ROOT, 'controllers/internal-catalog-attributes.controller.ts'),
      'utf8',
    );
    expect(raw).toMatch(/bumpAuthoringSchemaInvalidation/u);
  });

  it('anchors the producer detector on a CALL, not a mention', () => {
    // `impact-plan.ts` carries `symbol: 'bumpAuthoringSchemaInvalidation'` in a
    // STRING, which survives comment stripping. A bare-name detector reports the
    // plan as a producer of a register it only describes.
    const plan = SOURCES.get('services/catalog-governance/impact-plan.ts');
    expect(plan, 'the control module moved').toBeDefined();
    expect(plan).toMatch(/bumpAuthoringSchemaInvalidation/u);
    expect(callers('bumpAuthoringSchemaInvalidation')).not.toContain(
      'services/catalog-governance/impact-plan.ts',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The register is total, and every field is real                             */
/* -------------------------------------------------------------------------- */

describe('the register is total over the vocabulary', () => {
  it('every kind has a contract and every contract names its own key', () => {
    expect(CATALOG_EVENT_KINDS.length).toBe(4);
    for (const kind of CATALOG_EVENT_KINDS) {
      const contract = CATALOG_EVENT_CONTRACTS[kind];
      expect(contract, `${kind} has no contract`).toBeDefined();
      // The `Record` makes a MISSING key a compile error; this catches the other
      // direction, a contract filed under the wrong key by a copy-paste.
      expect(contract.kind, `${kind} is filed under the wrong key`).toBe(kind);
      expect(CATALOG_EVENT_CARRIER_SHAPES).toContain(contract.shape);
      expect(contract.note.length, `${kind} has no note`).toBeGreaterThan(60);
    }
    expect(CONTRACTS).toHaveLength(CATALOG_EVENT_KINDS.length);
  });

  it('a kind with no contract fails — the mutation self-test', () => {
    // Both directions, over COPIES rather than by editing a file: an added kind
    // with no contract, and a contract filed under the wrong key.
    const registerWithAGap: Partial<Record<string, CatalogEventContract>> = {
      ...CATALOG_EVENT_CONTRACTS,
    };
    delete registerWithAGap.reindex_request;
    const missing = CATALOG_EVENT_KINDS.filter((kind) => registerWithAGap[kind] === undefined);
    expect(missing).toEqual(['reindex_request']);

    const invented = [...CATALOG_EVENT_KINDS, 'facet_rebuild'] as readonly string[];
    const uncontracted = invented.filter(
      (kind) => CATALOG_EVENT_CONTRACTS[kind as CatalogEventKind] === undefined,
    );
    expect(uncontracted).toEqual(['facet_rebuild']);
  });

  it('every carrier table exists in the drizzle barrel under the declared name', () => {
    for (const contract of CONTRACTS) {
      const table = TABLES_BY_SQL_NAME.get(contract.table);
      expect(table, `${contract.kind}: no barrel table is named ${contract.table}`).toBeDefined();
      // The SYMBOL half: `tableSymbol` is what the producer derivation greps for,
      // so a rename that left `table` correct would silently empty that census.
      const exported = (schema as Record<string, unknown>)[contract.tableSymbol];
      expect(
        exported !== undefined && is(exported, PgTable),
        `${contract.kind}: the barrel exports no PgTable called ${contract.tableSymbol}`,
      ).toBe(true);
      expect(getTableName(exported as PgTable)).toBe(contract.table);
    }
    // Vacuity floor on this check itself: a register of zero contracts passes the
    // loop above without measuring anything.
    expect(CONTRACTS.length).toBeGreaterThanOrEqual(4);
  });

  it('every repository write handle is exported by exactly one production module', () => {
    let checked = 0;
    for (const contract of CONTRACTS) {
      if (contract.write.by !== 'repository') continue;
      checked += 1;
      const exporters = modulesExporting(contract.write.symbol);
      expect(
        exporters,
        `${contract.kind}: ${contract.write.symbol} should be exported by exactly one module`,
      ).toEqual([contract.write.definedIn]);
      expect(existsSync(join(SRC_ROOT, contract.write.definedIn))).toBe(true);
    }
    expect(checked, 'no repository-written contract was checked').toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/* Producers: derived, and equal to what is declared                          */
/* -------------------------------------------------------------------------- */

describe('the producer set of every carrier is derived, not transcribed', () => {
  it('matches the register exactly, for every contract', () => {
    for (const contract of CONTRACTS) {
      expect(
        derivedProducers(contract),
        `${contract.kind}: the modules that write ${contract.table} are not what the register says`,
      ).toEqual([...contract.producers].sort());
    }
  });

  it('finds the writer that never calls the repository function — the positive control', () => {
    // The whole reason the derivation is a UNION. `enqueueAttributeReindex` has
    // four callers; `services/backfill/stages/projections.ts` inserts the table
    // directly, and a census over the function alone reports four and reads tidy.
    // This is also the known-answer baseline: the union must find FIVE.
    const reindex = CATALOG_EVENT_CONTRACTS.reindex_request;
    expect(callers('enqueueAttributeReindex')).toContain('db/attributes/attributeOpsRepository.ts');
    expect(callers('enqueueAttributeReindex')).not.toContain(
      'services/backfill/stages/projections.ts',
    );
    expect(tableWriters('attributeReindexRequests')).toContain(
      'services/backfill/stages/projections.ts',
    );
    expect(derivedProducers(reindex)).toHaveLength(5);
  });

  it('goes red when a producer is added or removed — the mutation self-test', () => {
    const reindex = CATALOG_EVENT_CONTRACTS.reindex_request;
    const real = derivedProducers(reindex);

    // Direction 1: a module gains a write and the register does not know.
    const withANewWriter = new Map(SOURCES);
    withANewWriter.set(
      'services/facets/invented-writer.ts',
      'await db.insert(attributeReindexRequests).values({});',
    );
    const grown = derivedProducers(reindex, withANewWriter);
    expect(grown).toContain('services/facets/invented-writer.ts');
    expect(grown).not.toEqual([...reindex.producers].sort());

    // Direction 2: a declared producer stops writing and the register still lists it.
    const withAWriterRemoved = new Map(SOURCES);
    withAWriterRemoved.set('services/curation/correction.service.ts', 'export const nothing = 1;');
    const shrunk = derivedProducers(reindex, withAWriterRemoved);
    expect(shrunk).not.toContain('services/curation/correction.service.ts');
    expect(shrunk).not.toEqual([...reindex.producers].sort());

    // And the unmutated derivation still equals the declaration, so the two
    // mutations above are measuring the detector rather than a broken baseline.
    expect(real).toEqual([...reindex.producers].sort());
  });

  it('the trigger-written carrier has NO repository writer, and that is derived', () => {
    // `revisionRepository.ts` states there is deliberately no `recordRevision`,
    // because a second writer would disagree with the triggers the first time a
    // path forgot to call it. That sentence is now a gate.
    const trail = CATALOG_EVENT_CONTRACTS.translation_change;
    expect(trail.producers).toEqual([]);
    expect(derivedProducers(trail)).toEqual([]);

    // The control that stops the emptiness above being vacuous: the SAME
    // detector, on the same tree, finds writers for a table that has them.
    expect(tableWriters('catalogGovernanceAuditEvents').length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Triggers: derived from the migration SQL                                   */
/* -------------------------------------------------------------------------- */

describe('a trigger-written carrier names every trigger that writes it', () => {
  it('matches the migration SQL exactly', () => {
    let checked = 0;
    for (const contract of CONTRACTS) {
      if (contract.write.by !== 'database_trigger') continue;
      checked += 1;
      expect(
        triggersWritingTable(contract.table),
        `${contract.kind}: the triggers writing ${contract.table} are not what the register says`,
      ).toEqual([...contract.write.triggers].sort());
    }
    expect(checked, 'no trigger-written contract was checked').toBe(1);
  });

  it('none of the declared triggers has since been dropped', () => {
    // The derivation reads CREATE statements, so a later DROP would leave it
    // reporting a trigger the database does not have. Rather than model drops,
    // this fails loudly and hands the decision back.
    for (const contract of CONTRACTS) {
      if (contract.write.by !== 'database_trigger') continue;
      for (const trigger of contract.write.triggers) {
        expect(
          MIGRATION_SQL,
          `${trigger} is dropped by a migration; the trigger derivation no longer holds`,
        ).not.toMatch(new RegExp(`DROP\\s+TRIGGER[^;]*\\b${trigger}\\b`, 'u'));
      }
    }
  });

  it('goes red when a trigger appears or disappears — the mutation self-test', () => {
    const trail = CATALOG_EVENT_CONTRACTS.translation_change;
    if (trail.write.by !== 'database_trigger') throw new Error('the control contract changed');

    // The known-answer baseline: eight, and the docblocks that say four are the
    // reason this number is derived instead of written down.
    expect(triggersWritingTable(trail.table)).toHaveLength(8);

    const withANewTrigger = `${MIGRATION_SQL}
CREATE OR REPLACE FUNCTION mercaria_invented_localization_revision()
RETURNS trigger AS $$
BEGIN
  INSERT INTO "catalog_localization_revisions" ("id") VALUES ('x');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER mercaria_invented_localization_revision
  AFTER INSERT OR UPDATE ON "invented_localizations"
  FOR EACH ROW EXECUTE FUNCTION mercaria_invented_localization_revision();`;
    const grown = triggersWritingTable(trail.table, withANewTrigger);
    expect(grown).toContain('mercaria_invented_localization_revision');
    expect(grown).not.toEqual([...trail.write.triggers].sort());

    // Direction 2: a trigger the register still lists stops writing the table.
    const withOneRewritten = MIGRATION_SQL.replaceAll(
      'INSERT INTO "catalog_localization_revisions"',
      'INSERT INTO "somewhere_else"',
    );
    expect(triggersWritingTable(trail.table, withOneRewritten)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Consumers: present ones are reachable, absent ones are still absent        */
/* -------------------------------------------------------------------------- */

describe('every declared consumer is a symbol something actually calls', () => {
  it('a present consumer is exported and has a production caller outside its own module', () => {
    let checked = 0;
    for (const contract of CONTRACTS) {
      if (contract.consumer.state === 'absent') continue;
      checked += 1;
      const { symbol } = contract.consumer;
      const exporters = modulesExporting(symbol);
      expect(exporters, `${contract.kind}: ${symbol} is exported by nothing`).toHaveLength(1);
      const outside = callers(symbol).filter((relative) => relative !== exporters[0]);
      // The defect a "does the function exist" check cannot see, and the one
      // that was live in this repository twice: a real, correct, tested export
      // that nothing reaches.
      expect(
        outside,
        `${contract.kind}: ${symbol} is exported and called by no production module`,
      ).not.toHaveLength(0);
    }
    expect(checked, 'no present consumer was checked').toBe(2);
  });

  it('an absent consumer is STILL absent, by its own probe', () => {
    let checked = 0;
    for (const contract of CONTRACTS) {
      if (contract.consumer.state !== 'absent') continue;
      checked += 1;
      const { probe, owedBy, reason } = contract.consumer;
      expect(owedBy, `${contract.kind}: an absent consumer must name the issue that owes it`)
        .toMatch(/#\d+/u);
      expect(reason.length).toBeGreaterThan(60);
      if (probe.kind === 'no_update_of_carrier') {
        expect(
          tableUpdaters(contract.tableSymbol),
          `${contract.kind}: something now updates ${contract.table} — the consumer may exist`,
        ).toEqual([]);
      } else {
        expect(existsSync(join(SRC_ROOT, probe.module))).toBe(true);
        expect(
          importers(probe.module),
          `${contract.kind}: ${probe.module} now has a production importer — the consumer may exist`,
        ).toEqual([]);
      }
    }
    expect(checked, 'no absent consumer was checked').toBe(2);
  });

  it('both absence probes find something when the thing is present — the positive controls', () => {
    // `no_update_of_carrier` on a queue that IS drained. Without this, an empty
    // result from a broken pattern is indistinguishable from a real absence.
    expect(tableUpdaters('moderationOutboxes').length).toBeGreaterThan(0);
    expect(tableUpdaters('offerOutboxes').length).toBeGreaterThan(0);

    // `no_importer_of` on a module that IS imported.
    expect(importers('db/catalogAuthoring/schemaInvalidationRepository.ts').length)
      .toBeGreaterThan(0);

    // And the subjects: the translation trail's readers exist, are exported, and
    // are called by nobody. This is the finding the `absent` state records, and
    // asserting it here is what makes the classification measured rather than
    // declared.
    for (const symbol of [
      'readLocalizationFieldHistory',
      'findLocalizationRevision',
      'rollbackLocalizationField',
    ]) {
      expect(modulesExporting(symbol)).toEqual(['db/catalogLocalization/revisionRepository.ts']);
      expect(callers(symbol)).toEqual(['db/catalogLocalization/revisionRepository.ts']);
    }
  });

  it('only a durable queue may report an absent consumer as a gap, and no queue claims a dead letter it lacks', () => {
    for (const contract of CONTRACTS) {
      if (contract.shape !== 'durable_queue') {
        // Nothing drains a register or a trail, so `drains` would be a category
        // error rather than good news.
        expect(
          contract.consumer.state,
          `${contract.kind}: a ${contract.shape} cannot be drained`,
        ).not.toBe('drains');
      }
      if (contract.consumer.state === 'absent' && contract.shape === 'durable_queue') {
        // You cannot give up on work nothing attempts. `docs/catalog-observability.md`
        // records that reporting a dead-letter count of zero would put a
        // permanently green tile on a dashboard for a condition that cannot occur.
        expect(
          contract.retry.deadLetter,
          `${contract.kind}: an undrained queue cannot have a dead-letter state`,
        ).toBe(false);
      }
      expect(contract.retry.note.length).toBeGreaterThan(60);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Every invalidation subject has a producer — the #655 catcher               */
/* -------------------------------------------------------------------------- */

describe('every invalidation subject is bumped by something', () => {
  it('the derived producer set covers the whole vocabulary', () => {
    // `localization` was declared, folded into the memo key AND the ETag, and
    // bumped by NOTHING until #655: an operator approved a translation and every
    // task went on serving the previous text until it restarted. A subject in the
    // vocabulary with no producer is that defect, and this is the shape that sees
    // it without knowing which subject it will be.
    expect(subjectsWithAProducer()).toEqual([...AUTHORING_INVALIDATION_SUBJECTS].sort());
  });

  it('finds real bump sites, and goes red when one subject loses its only producer', () => {
    // Vacuity floor: the detector has to be finding call sites at all.
    const sites = bumpSites();
    expect(sites.length, `only ${String(sites.length)} bump sites were found`).toBeGreaterThanOrEqual(5);
    expect(sites).toContain('localization@services/catalog-governance/review.service.ts');

    // The mutation: `localization` has exactly one producer, so removing it takes
    // the subject out of the derived set — which is the #655 state exactly.
    const withoutTheOnlyLocalizationBump = new Map(SOURCES);
    withoutTheOnlyLocalizationBump.set(
      'services/catalog-governance/review.service.ts',
      'export const nothing = 1;',
    );
    const shrunk = subjectsWithAProducer(withoutTheOnlyLocalizationBump);
    expect(shrunk).not.toContain('localization');
    expect(shrunk).not.toEqual([...AUTHORING_INVALIDATION_SUBJECTS].sort());
  });
});

/* -------------------------------------------------------------------------- */
/* Which publication action owes which bump                                   */
/* -------------------------------------------------------------------------- */

describe('every governance action has an invalidation decision', () => {
  it('the table is TOTAL over the action vocabulary', () => {
    expect(CATALOG_GOVERNANCE_ACTIONS.length).toBeGreaterThanOrEqual(17);
    for (const action of CATALOG_GOVERNANCE_ACTIONS) {
      const entry = CATALOG_PUBLICATION_INVALIDATION[action];
      expect(entry, `${action} has no invalidation decision`).toBeDefined();
      expect(entry.note.length, `${action} has no note`).toBeGreaterThan(40);
      if (entry.bumps !== null) {
        expect(
          AUTHORING_INVALIDATION_SUBJECTS,
          `${action} bumps ${entry.bumps}, which is not a subject`,
        ).toContain(entry.bumps as AuthoringInvalidationSubject);
      }
    }
  });

  it('an action declaring a bump has a case and that subject literal in applyChange', () => {
    const apply = SOURCES.get(APPLY_MODULE);
    expect(apply, 'applyChange moved; every assertion below measures nothing').toBeDefined();
    let checked = 0;
    for (const action of CATALOG_GOVERNANCE_ACTIONS) {
      const entry = CATALOG_PUBLICATION_INVALIDATION[action];
      if (entry.bumps === null) continue;
      checked += 1;
      expect(apply, `${action} has no case in applyChange`).toContain(`case '${action}':`);
      expect(
        apply,
        `${action} declares a ${entry.bumps} bump and applyChange never names that subject`,
      ).toContain(`subject: '${entry.bumps}'`);
    }
    expect(checked, 'no bumping action was checked').toBe(13);

    // The control for the two `null`s that are null because applyChange REFUSES
    // them: they still have a case label, and it throws rather than applying.
    for (const action of ['definition_snapshot_restore', 'vertical_package_apply'] as const) {
      expect(CATALOG_PUBLICATION_INVALIDATION[action].bumps).toBeNull();
      expect(apply).toContain(`case '${action}':`);
    }
  });

  it('goes red when an action is added without a decision — the mutation self-test', () => {
    const invented = [...CATALOG_GOVERNANCE_ACTIONS, 'facet_publish'] as readonly string[];
    const undecided = invented.filter(
      (action) =>
        CATALOG_PUBLICATION_INVALIDATION[action as (typeof CATALOG_GOVERNANCE_ACTIONS)[number]] ===
        undefined,
    );
    expect(undecided).toEqual(['facet_publish']);

    // And the other direction: a declared bump whose subject applyChange does not
    // name. The check above is a `toContain` on the real source, so mutate that.
    const applyWithoutTheCategoryBump = (SOURCES.get(APPLY_MODULE) ?? '').replaceAll(
      "subject: 'category'",
      "subject: 'nothing'",
    );
    expect(applyWithoutTheCategoryBump).not.toContain("subject: 'category'");
    expect(SOURCES.get(APPLY_MODULE)).toContain("subject: 'category'");
  });
});
