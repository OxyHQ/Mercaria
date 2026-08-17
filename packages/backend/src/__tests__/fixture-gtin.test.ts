/**
 * The fixture GTIN generator, and the guard that keeps barcodes out of two
 * files at once (#594).
 *
 * The guard's population is DERIVED, not listed: a GTIN literal is only a
 * hazard when two files that both reach the shared database write it, because
 * `product_identifiers_canonical_active_key` is unique per GTIN with no file
 * scoping. A pure unit test may reuse a real barcode freely — several
 * deliberately do, since normalization and check-digit tests need fixed inputs
 * — and a guard broader than the hazard is one somebody later weakens.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureGtin, gtinCheckDigit } from './fixture-gtin.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('gtinCheckDigit', () => {
  /**
   * REAL barcodes, taken from fixtures already in this repository. A generator
   * with a wrong check digit emits values the matcher's identifier stage
   * discards, which presents as a fixture that quietly stopped matching.
   */
  it.each([
    ['400638133393', 1, '4006381333931'],
    ['590123412345', 7, '5901234123457'],
    ['978013235088', 4, '9780132350884'],
    ['454873613290', 0, '4548736132900'],
  ])('%s -> %i (%s)', (body, expected) => {
    expect(gtinCheckDigit(body)).toBe(expected);
  });

  it('refuses a body that is not 12 digits', () => {
    expect(() => gtinCheckDigit('123')).toThrow(/12-digit/u);
  });
});

describe('fixtureGtin', () => {
  it('is a valid GTIN-13 — its own check digit verifies', () => {
    const gtin = fixtureGtin('abc123def456', 0);
    expect(gtin).toMatch(/^[0-9]{13}$/u);
    expect(gtinCheckDigit(gtin.slice(0, 12))).toBe(Number(gtin[12]));
  });

  it('differs across run tokens — the property the whole module exists for', () => {
    expect(fixtureGtin('run-one', 0)).not.toBe(fixtureGtin('run-two', 0));
  });

  it('differs across sequences within one run', () => {
    expect(fixtureGtin('run-one', 0)).not.toBe(fixtureGtin('run-one', 1));
  });

  it('is deterministic for one (run, sequence)', () => {
    expect(fixtureGtin('run-one', 3)).toBe(fixtureGtin('run-one', 3));
  });

  it('refuses a constant-shaped misuse', () => {
    expect(() => fixtureGtin('', 0)).toThrow(/run token/u);
    expect(() => fixtureGtin('run', 1000)).toThrow(/0\.\.999/u);
  });

  it('spreads run tokens that differ by one character', () => {
    // FNV-1a rather than a sum, so `…a` and `…b` do not land in adjacent
    // buckets and then collide once a sequence is added.
    const a = fixtureGtin('run-token-a', 0).slice(0, 9);
    const b = fixtureGtin('run-token-b', 0).slice(0, 9);
    expect(a).not.toBe(b);
  });
});

describe('GUARD: no GTIN literal is shared by two database-reaching test files', () => {
  /** Every GTIN-shaped literal, per file, over the DB-reaching test files. */
  function literalsByFile(): Map<string, Set<string>> {
    const files = execFileSync('sh', [
      '-c',
      `cd ${SRC} && grep -rl 'connectPostgres\\|getDb()' --include='*.ts' . | grep '__tests__' | sed 's|^\\./||'`,
    ])
      .toString()
      .split('\n')
      .filter(Boolean)
      // THIS file, excluded — and the reason is worth keeping. Its source
      // contains the pattern it greps for, so the guard selected itself into
      // its own population, and the real barcodes it uses as check-digit
      // controls then read as duplicates of the fixtures they were taken from.
      // Measured on the first run: it reported five shared literals, of which
      // two were itself. A detector must exclude itself, for the same reason it
      // cannot recognise its quarry by inspecting a value.
      .filter((f) => f !== '__tests__/fixture-gtin.test.ts');

    const out = new Map<string, Set<string>>();
    for (const file of files) {
      const hits = execFileSync('sh', [
        '-c',
        `grep -ohE "'[0-9]{8}'|'[0-9]{12}'|'[0-9]{13}'|'[0-9]{14}'" ${join(SRC, file)} 2>/dev/null || true`,
      ])
        .toString()
        .split('\n')
        .filter(Boolean)
        .map((s) => s.replace(/'/gu, ''));
      if (hits.length > 0) out.set(file, new Set(hits));
    }
    return out;
  }

  function sharedLiterals(byFile: Map<string, Set<string>>): Map<string, string[]> {
    const owners = new Map<string, string[]>();
    for (const [file, values] of byFile) {
      for (const v of values) owners.set(v, [...(owners.get(v) ?? []), file]);
    }
    return new Map([...owners].filter(([, files]) => files.length > 1));
  }

  it('finds GTIN literals at all, and finds the DB-reaching files', () => {
    // Vacuity floor. Without it a broken grep reports a clean guard: no
    // literals found means no duplicates found, which is the same green.
    const byFile = literalsByFile();
    expect(byFile.size).toBeGreaterThan(3);
    const total = [...byFile.values()].reduce((n, s) => n + s.size, 0);
    expect(total).toBeGreaterThan(10);
  });

  it('no GTIN literal appears in two of them', () => {
    const shared = sharedLiterals(literalsByFile());
    // Named, so a failure says WHICH barcode and WHICH files rather than a count.
    expect([...shared].map(([v, files]) => `${v}: ${files.join(' + ')}`)).toEqual([]);
  });

  it('SELF-TEST: a planted duplicate is caught and both files are named', () => {
    const byFile = literalsByFile();
    // A value that appears NOWHERE in the tree, so the plant is the only
    // source of the duplicate. Planting a barcode the fixtures already use
    // measures the fixtures rather than the detector — the first version of
    // this self-test did exactly that and reported six owners.
    const absent = '2999999999998';
    expect([...byFile.values()].some((s) => s.has(absent))).toBe(false);

    const planted = new Map(byFile);
    planted.set('planted/a.realdb.test.ts', new Set([absent]));
    planted.set('planted/b.realdb.test.ts', new Set([absent]));

    const shared = sharedLiterals(planted);
    expect(shared.get(absent)).toEqual(['planted/a.realdb.test.ts', 'planted/b.realdb.test.ts']);
    // And the real tree is still clean, so the self-test proves the DETECTOR
    // rather than the plant.
    expect([...sharedLiterals(byFile)]).toEqual([]);
  });
});
