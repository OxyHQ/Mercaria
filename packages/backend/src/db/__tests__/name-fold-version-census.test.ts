/**
 * Every production write that FOLDS a name also stamps the fold version (#915,
 * epic #367 line 580).
 *
 * ## The risk is a WRITE SITE, not a table
 *
 * The obvious gate — "every table carrying a folded column carries the version"
 * — is satisfied by this branch and would have gone on passing while the defect
 * it exists to catch sat in the tree. Measured: `curation/split.service.ts`
 * MINTS a canonical product with `normalizeEntityName(name)` and no stamp,
 * bypassing the repository entirely. The table has the column, so a table-level
 * check is green; the row silently takes the column DEFAULT of 1, which is
 * correct only while the constant is 1 and becomes a lie the moment it is not.
 *
 * That is the whole failure mode: a wrong stamp is indistinguishable from a
 * right one, and it is discovered by a lookup that silently matches nothing.
 *
 * ## Two gates, because there are two ways to write these tables
 *
 * 1. **Through the repository.** `nameFoldVersion` is REQUIRED in the four
 *    insert input types, so a caller that omits it fails `tsc` — verified by
 *    mutation, and it bites even under this package's `strict: false`
 *    (`Property 'nameFoldVersion' is missing ... but required`). A property the
 *    type system already knows gets a gate in the type system: it is precise, it
 *    needs no exclusion list, and it covers callers nobody has written yet.
 *    This file asserts those declarations still exist, because deleting one
 *    makes nothing else fail.
 *
 * 2. **Directly**, with `db.insert(<table>)`. The type gate cannot see those, so
 *    they are DERIVED from source and each must stamp or be excused by name.
 *
 * ## What this gate does NOT claim
 *
 * `normalizeEntityName` is one of THREE folds in this codebase.
 * `normalizeAliasLookup` (trim and lowercase, no accent folding) writes the
 * canonical `normalized_alias` columns, and `normalizeCatalogAlias` writes
 * `category_aliases`. Neither is versioned, and #915 did not version them —
 * that is a stated residual, not a silent exclusion. They are outside the
 * population because a DIFFERENT function folds them, not because their columns
 * are generated: both are service-maintained, as their own schema docblocks say
 * in as many words.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAME_FOLD_VERSION } from '../../services/canonical/normalization.js';

const SRC = new URL('../../', import.meta.url).pathname;

/** The drizzle table identifiers whose rows carry a `normalizeEntityName` fold. */
const FOLDED_TABLES = [
  'canonicalProducts',
  'canonicalProductFamilies',
  'organizations',
  'brands',
  'catalogProposals',
] as const;

/** The repository that owns each table's writes, and re-imposes the requirement. */
const OWNING_REPOSITORIES = [
  'db/canonical/canonicalProductRepository.ts',
  'db/canonical/productFamilyRepository.ts',
  'db/canonical/organizationRepository.ts',
  'db/canonical/brandRepository.ts',
  'db/catalogProposals/proposalRepository.ts',
] as const;

/**
 * Direct writers that legitimately do not stamp. Counted exactly, and each
 * reason is a fact about the file that was READ rather than assumed.
 */
const EXCLUDED_DIRECT_WRITERS: readonly { readonly file: string; readonly why: string }[] = [
  {
    file: 'services/graph-benchmark/dataset.ts',
    why: "#61's benchmark generator: opt-in behind GRAPH_BENCHMARK=1 and a database name containing `bench`, and it refuses a connection whose current_database() does not — it TRUNCATES, so it can never write a production row",
  },
  {
    file: 'services/catalog-observability/ancestry-benchmark.ts',
    why: "ADR 0007 D2's benchmark seeder; its only caller in the tree is its own realdb test, so it is a fixture writer rather than a production one",
  },
];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== '__tests__') walk(full);
      } else if (entry.endsWith('.ts')) out.push(full);
    }
  };
  walk(SRC);
  return out;
}

/** Comments are stripped: these modules DESCRIBE the stamp as well as writing it. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** The balanced `{...}` opened at `from`, so a nested object cannot end it early. */
function balancedBlock(text: string, from: number): string {
  const start = text.indexOf('{', from);
  if (start === -1) return '';
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

/**
 * `literal` — the write's values are an object literal this scanner can read.
 * `opaque` — they are a variable, so whether it folds is NOT decidable here.
 *
 * Opaque is the one that matters. A scanner that only understands literals
 * reports a clean sweep over `db.insert(x).values(rows)`, which is how both
 * benchmark seeders write. So an opaque write is an OFFENDER until it is
 * excused by name: the blind spot fails closed instead of reading as coverage.
 */
type DirectWriteShape = 'literal' | 'opaque';

interface DirectWrite {
  readonly file: string;
  readonly table: string;
  readonly shape: DirectWriteShape;
  readonly folds: boolean;
  readonly stamped: boolean;
}

/**
 * Every `db.insert(<foldedTable>).values({...})` outside an owning repository.
 *
 * Exported shape so the mutation self-test below can run the SAME scanner over a
 * synthetic unstamped write — a detector nobody has driven is a detector nobody
 * knows the polarity of.
 */
function scanDirectWrites(files: readonly { path: string; text: string }[]): DirectWrite[] {
  const found: DirectWrite[] = [];
  for (const { path, text } of files) {
    const source = stripComments(text);
    for (const table of FOLDED_TABLES) {
      const pattern = new RegExp(`\\.insert\\(\\s*${table}\\s*\\)`, 'g');
      let match = pattern.exec(source);
      while (match !== null) {
        // The `.values(` must follow the insert IMMEDIATELY. Searching forward
        // for the next `{` instead walks past `.values(rows)` into whatever
        // block comes next and measures an unrelated object.
        const rest = source.slice(match.index + match[0].length);
        const call = /^\s*\.values\(\s*/.exec(rest);
        if (call === null) {
          match = pattern.exec(source);
          continue;
        }
        const isLiteral = rest.charAt(call[0].length) === '{';
        if (isLiteral) {
          const block = balancedBlock(rest, call[0].length - 1);
          // Only a write that FOLDS owes a stamp. A write with no folded column
          // — a rollup setting counts, say — is outside the population.
          const folds = /(?:^|[\s{])(normalizedName|normalizedLabel)\s*[,:]/m.test(block);
          found.push({
            file: path,
            table,
            shape: 'literal',
            folds,
            stamped: block.includes('nameFoldVersion'),
          });
        } else {
          found.push({ file: path, table, shape: 'opaque', folds: true, stamped: false });
        }
        match = pattern.exec(source);
      }
    }
  }
  return found;
}

describe('a name fold and its version are written together', () => {
  const files = sourceFiles().map((path) => ({
    path: path.slice(SRC.length),
    text: readFileSync(path, 'utf8'),
  }));

  it('scans a real tree, not an empty one', () => {
    // The vacuity floor. Every assertion below passes over zero files, and a
    // resolved-wrong SRC is exactly how that happens.
    expect(files.length, `${String(files.length)} source files walked`).toBeGreaterThan(500);
  });

  it('requires the stamp in all five owning repository input types', () => {
    // The type-system gate, asserted because deleting it makes nothing else
    // fail. Four re-impose it on a drizzle-inferred insert type; the fifth
    // builds its values itself and stamps them there, so it is checked for the
    // stamp rather than for the type.
    const missing: string[] = [];
    for (const repository of OWNING_REPOSITORIES.slice(0, 4)) {
      const text = files.find((file) => file.path === repository)?.text;
      expect(text, `${repository} is gone`).toBeDefined();
      if (text === undefined) continue;
      if (!/Required<\s*Pick<[^>]*'nameFoldVersion'\s*>\s*>/.test(text)) missing.push(repository);
    }
    expect(missing, `no required-stamp type: ${missing.join(', ')}`).toEqual([]);

    const proposals = files.find((file) => file.path === OWNING_REPOSITORIES[4])?.text ?? '';
    expect(proposals, 'proposalRepository stopped stamping').toContain('nameFoldVersion');
  });

  it('stamps every direct write, or excuses it by name with a reason', () => {
    const writes = scanDirectWrites(files);
    // A derived population needs an anchor to the known cases, or a scanner that
    // matched nothing reports a clean sweep.
    expect(writes.length, 'the scanner found no direct writes at all').toBeGreaterThan(0);
    expect(
      writes.some((write) => write.shape === 'literal' && write.folds),
      'no folded literal write found — the fold detector matches nothing',
    ).toBe(true);

    const excused = new Set(EXCLUDED_DIRECT_WRITERS.map((entry) => entry.file));
    const owning = new Set<string>(OWNING_REPOSITORIES);
    const offenders = writes
      .filter((write) => !owning.has(write.file) && !excused.has(write.file))
      // A literal that folds must stamp; an opaque write cannot be judged here
      // at all, so it owes an exemption rather than the benefit of the doubt.
      .filter((write) => (write.shape === 'opaque' ? true : write.folds && !write.stamped))
      .map((write) => `${write.file} -> ${write.table} (${write.shape})`);
    expect(offenders, `unstamped or unreadable: ${offenders.join(', ')}`).toEqual([]);
  });

  it('counts the excused writers exactly, each with a reason', () => {
    // A disposition list with no count is one that grows quietly.
    expect(EXCLUDED_DIRECT_WRITERS.length).toBe(2);
    const writes = scanDirectWrites(files);
    for (const entry of EXCLUDED_DIRECT_WRITERS) {
      expect(entry.why.length).toBeGreaterThan(40);
      // An exemption that can no longer match is a stale exemption, and it reads
      // exactly like a defended one.
      expect(
        writes.some((write) => write.file === entry.file),
        `${entry.file} no longer writes one of these tables — drop the exemption`,
      ).toBe(true);
    }
  });

  it('reports an unstamped write when it is given one (mutation self-test)', () => {
    // The detector, driven. Without this the suite cannot tell "nothing is
    // wrong" from "the regex matches nothing".
    const unstamped = scanDirectWrites([
      {
        path: 'services/fake/minting.service.ts',
        text: `await db.insert(canonicalProducts).values({
           slug, name, normalizedName: normalizeEntityName(name),
         });`,
      },
    ]);
    expect(unstamped).toHaveLength(1);
    expect(unstamped[0]).toMatchObject({ shape: 'literal', folds: true, stamped: false });

    // The other polarity: a stamped write is clean.
    const stamped = scanDirectWrites([
      {
        path: 'services/fake/minting.service.ts',
        text: `await db.insert(canonicalProducts).values({
           slug, name, normalizedName: normalizeEntityName(name),
           nameFoldVersion: NAME_FOLD_VERSION,
         });`,
      },
    ]);
    expect(stamped[0]).toMatchObject({ folds: true, stamped: true });

    // A write that folds NOTHING owes no stamp — otherwise every rollup becomes
    // an exemption and the list stops meaning anything.
    const noFold = scanDirectWrites([
      { path: 'services/fake/rollup.ts', text: 'db.insert(canonicalProducts).values({ slug });' },
    ]);
    expect(noFold[0]).toMatchObject({ folds: false });

    // And the blind spot itself: a variable-fed write is reported as opaque
    // rather than silently passing, which is what makes the exemption list the
    // only way past it.
    const opaque = scanDirectWrites([
      { path: 'services/fake/seed.ts', text: 'await db.insert(canonicalProducts).values(rows);' },
    ]);
    expect(opaque[0]).toMatchObject({ shape: 'opaque' });
  });

  it('the constant starts at 1, which is what makes the migration default true', () => {
    // `0148` backfills every existing row with 1 — a claim that those rows were
    // folded under version 1, correct only because the constant introduced in
    // the same change is 1. What a bump obliges is on NAME_FOLD_VERSION itself.
    expect(NAME_FOLD_VERSION).toBe(1);
  });
});
