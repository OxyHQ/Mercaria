/**
 * The reference registry is COMPLETE — a census, because the failure it guards
 * is silent: a column holding an Oxy file id that the registry does not know is
 * a usage Oxy never hears about, and Oxy collects an application file nobody
 * references (ADR 0043 D5) while a page still shows it.
 *
 * Three derived populations, each with a floor and a self-test:
 *
 * 1. Every `OXY_FILE_REFERENCE_ENTITY_TYPES` member has exactly one definition.
 * 2. Every schema column NAMED like a file id (`file_id`, `*_file_id`,
 *    `*_file_ids`) is a holding column of some definition, or is named below
 *    with the reason it holds no Oxy file. Derived from the drizzle barrel, so a
 *    new table's column is in the population the day it is added.
 * 3. Every source of a `trigger`-registered type has the trigger of migration
 *    0172 with exactly its entity type, entity column, mode and columns — and
 *    no other type has one. Read from the migration SQL, which is what runs.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { is } from 'drizzle-orm';
import { sqlColumnName } from '@oxy.so/db';
import { describe, expect, it } from 'vitest';
import { OXY_FILE_REFERENCE_ENTITY_TYPES } from '@mercaria/shared-types';
import * as schema from '../../../db/schema/index.js';
import { diffFileReferences } from '../file-reference-outbox.js';
import { fileIdsOf, fileReferenceDefinitions } from '../file-reference-registry.js';

const DRIZZLE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'drizzle',
);

/** File-id-NAMED columns that hold no Oxy file, each with the reason. */
const NOT_OXY_FILES: Readonly<Record<string, string>> = {
  'asset_package_files.file_id':
    'an `asset_files` row id (a Mercaria foreign key), not an Oxy file',
  'asset_file_inspections.file_id': 'an `asset_files` row id (a Mercaria foreign key)',
  'asset_provenance_signals.file_id': 'an `asset_files` row id (a Mercaria foreign key)',
  'asset_download_grants.file_id': 'an `asset_files` row id (a Mercaria foreign key)',
  'asset_download_events.file_id': 'an `asset_files` row id (a Mercaria foreign key)',
  'oxy_file_references.file_id': "the registry's own ledger of what Oxy acknowledged",
  'oxy_file_events.file_id': "the registry's own event audit",
  'oxy_application_files.file_id':
    "the adapter's record of which files Oxy answered as the application's own",
  'feed_upload_sessions.oxy_file_id':
    'storage’s answer to an upload session BEFORE Mercaria accepted the bytes; the holding row ' +
    'is the `feed_uploads` row the session completes into',
};

const FILE_ID_NAME = /(?:^|_)file_ids?$/;

function fileIdNamedColumns(): string[] {
  const found: string[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    for (const column of config.columns) {
      // The SQL name: `column.name` is the TypeScript property (CONVENTIONS.md's
      // trap), and a property-name census matches nothing and passes vacuously.
      const name = sqlColumnName(column);
      if (FILE_ID_NAME.test(name)) found.push(`${config.name}.${name}`);
    }
  }
  return found.sort();
}

function holdingColumns(): Set<string> {
  return new Set(
    fileReferenceDefinitions().flatMap((definition) =>
      definition.sources.flatMap((source) =>
        source.columns.map((column) => `${source.table}.${column.name}`),
      ),
    ),
  );
}

interface TriggerCall {
  readonly table: string;
  readonly args: readonly string[];
}

function migrationTriggers(): TriggerCall[] {
  const calls: TriggerCall[] = [];
  const pattern =
    /CREATE TRIGGER\s+\w+\s+AFTER INSERT OR DELETE OR UPDATE OF [\s\S]*? ON "(\w+)"\s+FOR EACH ROW EXECUTE FUNCTION mercaria_oxy_file_reference_touch\(([^)]*)\)/g;
  for (const file of readdirSync(DRIZZLE_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join(DRIZZLE_DIR, file), 'utf8');
    for (const match of sql.matchAll(pattern)) {
      calls.push({
        table: match[1] ?? '',
        args: (match[2] ?? '').split(',').map((arg) => arg.trim().replace(/^'|'$/g, '')),
      });
    }
  }
  return calls;
}

describe('the Oxy file reference registry is complete', () => {
  it('defines every entity type exactly once', () => {
    const types = fileReferenceDefinitions().map((definition) => definition.entityType);
    expect(types).toEqual([...OXY_FILE_REFERENCE_ENTITY_TYPES]);
    expect(new Set(types).size).toBe(types.length);
    expect(types.length).toBeGreaterThanOrEqual(24);
  });

  it('holds every file-id-named column in the schema, or says why it is not an Oxy file', () => {
    const population = fileIdNamedColumns();
    // Floor: the census is not vacuous (19 holding + 7 named exceptions today).
    expect(population.length).toBeGreaterThanOrEqual(25);
    const held = holdingColumns();
    const unregistered = population.filter(
      (column) => !held.has(column) && !(column in NOT_OXY_FILES),
    );
    expect(
      unregistered,
      'a column named like an Oxy file id is in no reference definition. Register it in ' +
        '`file-reference-registry.ts` (and give its table a trigger in a migration) or name it ' +
        'in NOT_OXY_FILES with the reason it holds no Oxy file.',
    ).toEqual([]);
    // Every exception still names a real column, so the list cannot rot.
    expect(Object.keys(NOT_OXY_FILES).filter((column) => !population.includes(column))).toEqual([]);
  });

  it('MUTATION SELF-TEST: a file-id column nobody registered is named', () => {
    const held = holdingColumns();
    held.delete('listing_images.file_id');
    const population = fileIdNamedColumns();
    expect(population.filter((column) => !held.has(column) && !(column in NOT_OXY_FILES))).toEqual([
      'listing_images.file_id',
    ]);
  });

  it('gives every trigger-registered source exactly its trigger, and nothing else one', () => {
    const triggers = migrationTriggers();
    expect(triggers.length).toBeGreaterThanOrEqual(24);
    const expected = fileReferenceDefinitions()
      .filter((definition) => definition.registration === 'trigger')
      .flatMap((definition) =>
        definition.sources.map((source) => ({
          table: source.table,
          args: [
            definition.entityType,
            source.entityColumn,
            source.columns.every((column) => column.kind === 'html') ? 'html' : 'value',
            ...source.columns.map((column) => column.name),
          ],
        })),
      );
    const key = (call: TriggerCall) => `${call.table}(${call.args.join(',')})`;
    expect(triggers.map(key).sort()).toEqual(expected.map(key).sort());
    // A type registered any other way has no trigger at all.
    const triggered = new Set(triggers.map((call) => call.args[0]));
    for (const definition of fileReferenceDefinitions()) {
      if (definition.registration !== 'trigger')
        expect(triggered.has(definition.entityType)).toBe(false);
    }
  });

  it('every type a takedown cannot change is history, and says so by having no detach', () => {
    const retained = fileReferenceDefinitions()
      .filter((definition) => !definition.detach)
      .map((definition) => definition.entityType)
      .sort();
    expect(retained).toEqual(
      [
        'digital_asset_file',
        'feed_upload',
        'merchant_claim_evidence',
        'order_item_image',
        'organization_archive_logo',
        'relationship_evidence',
        'retail_compliance_evidence',
        'retail_resale_evidence',
        'retail_service_request_evidence',
        'return_request_evidence',
        'supplier_agreement_evidence',
      ].sort(),
    );
  });
});

describe('what a column value holds', () => {
  it('reads ids, arrays, Oxy URLs and HTML, and refuses what Oxy would refuse', () => {
    expect(fileIdsOf('file_id', 'abc_DEF-1')).toEqual(['abc_DEF-1']);
    expect(fileIdsOf('file_id', 'https://supplier.example/legacy.jpg')).toEqual([]);
    expect(fileIdsOf('file_id', 'x'.repeat(65))).toEqual([]);
    expect(fileIdsOf('file_id_array', ['a', 'https://x.example/b.png', 'c'])).toEqual(['a', 'c']);
    expect(fileIdsOf('stored_url', 'https://cloud.oxy.so/file-1?variant=thumb')).toEqual([
      'file-1',
    ]);
    expect(fileIdsOf('stored_url', 'https://images.unsplash.com/photo')).toEqual([]);
    expect(
      fileIdsOf(
        'html',
        '<p>x</p><img src="https://cloud.oxy.so/file-2"><img src="https://cloud.oxy.so/file-2"><img src="https://supplier.example/a.png"><script><img src="https://cloud.oxy.so/hidden"></script>',
      ),
    ).toEqual(['file-2']);
    expect(fileIdsOf('html', null)).toEqual([]);
  });
});

describe('the convergence diff', () => {
  it('adds what is held and untold, removes what is told and no longer held', () => {
    const diff = diffFileReferences(
      ['a', 'b', 'c'],
      new Map([
        ['a', new Set(['f1', 'f2'])],
        ['c', new Set(['f4'])],
      ]),
      [
        { entityId: 'a', fileId: 'f1', state: 'registered' },
        { entityId: 'b', fileId: 'f3', state: 'registered' },
        { entityId: 'c', fileId: 'f5', state: 'refused' },
        { entityId: 'c', fileId: 'f4', state: 'refused' },
      ],
    );
    expect(diff.add).toEqual([{ entityId: 'a', fileId: 'f2' }]);
    expect(diff.remove).toEqual([{ entityId: 'b', fileId: 'f3' }]);
    // A refused pair is never sent to Oxy to remove: Oxy never held it.
    expect(diff.forgetRefused).toEqual([{ entityId: 'c', fileId: 'f5' }]);
  });
});
