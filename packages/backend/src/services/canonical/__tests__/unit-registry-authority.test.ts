/**
 * ONE unit registry, with stable keys (#367 Workstream 4, "add/confirm one unit
 * registry with stable unit IDs/keys and unit families").
 *
 * `services/canonical/units.ts` IS that registry today, and thirteen modules
 * read it. What was missing is anything that would notice a FOURTEENTH deciding
 * to keep its own factors — which is not a hypothetical shape, it is the
 * cheapest thing to write: `const inches = mm / 25.4` is one line, needs no
 * import, reviews as arithmetic and is a second answer to a question the
 * catalogue must have exactly one of. #68 records the identical hazard for
 * freshness lifetimes and closes it the same way.
 *
 * ## What each check would report if its subject were absent
 *
 * - The **conversion-constant scan** answers "no violations" for a healthy tree
 *   AND for a walk that read nothing, so it carries its own population floor and
 *   the floor is printed on success.
 * - The **import census** answers "every user imports it" for thirteen users and
 *   for zero, so the user count is floored too.
 * - The **key snapshot** is the only one that measures a REMOVAL, which no scan
 *   over the current table can: a table walked against itself agrees with itself
 *   whatever is in it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNIT_DEFINITIONS, resolveUnit, unitFamilyOf } from '../units.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The registry itself, and it is the ONLY exemption.
 *
 * Its factors are exact rationals, so it carries none of the decimals the scan
 * looks for today — but a table entry that legitimately needs one belongs here
 * and nowhere else, and the exemption is asserted by exact equality rather than
 * containment: a list a gate skips is how a gate stops being one.
 */
const CONVERSION_CONSTANT_EXEMPTIONS = ['services/canonical/units.ts'];

/**
 * Decimal factors that mean exactly one thing.
 *
 * Every one of these is a unit conversion and nothing else: 25.4 mm to the inch,
 * 453.59237 g to the pound, 29.5735… ml to the US fluid ounce. Deliberately NOT
 * the round factors — 1000, 60, 1024 — which are everywhere in a codebase and
 * would make this a scan somebody disables. Measured across 1611 production
 * modules on the day it was written: zero matches, so every future one is a
 * second conversion authority rather than noise.
 *
 * The lookarounds stop `125.44` and `225.4` matching, which is the way a
 * numeric detector normally goes wrong. Each factor appears BOTH at full
 * precision and at the truncation people actually type, as separate
 * alternatives rather than as a trailing `\d*` — the self-test below caught the
 * `\d*`-free first draft missing `29.5735295625`, and a trailing `\d*` would
 * have made `25.45` a violation.
 */
const CONVERSION_CONSTANTS =
  /(?<![\d.])(?:25\.4|2\.54|0\.0254|0\.3048|304\.8|39\.3700787|39\.3701|453\.59237|0\.45359237|28\.349523125|28\.3495|29\.5735295625|29\.5735|3\.785411784|3\.78541)(?![\d])/;

/**
 * Symbols that name the unit table and could not plausibly mean anything else.
 *
 * `parseQuantity`, `parseRange` and `sourceDecimalPlaces` are deliberately NOT
 * here even though the registry exports all three: `services/ebay/normalize.ts`
 * has its own private `parseQuantity` that reads an inventory COUNT out of an
 * unknown, which is a different function with the same ordinary name. Including
 * it would make this census report a violation that is not one, and a census
 * that cries wolf is a census somebody deletes.
 */
const UNIT_SYMBOLS =
  /\b(?:BASE_UNITS|UNIT_DEFINITIONS|convertUnit|resolveUnit|toBaseUnit|fromBaseUnit|unitFamilyOf|normalizeQuantity|normalizeRange)\b/;

/** Any import path ending in the registry module, relative or otherwise. */
const UNIT_IMPORT = /from\s+'[^']*\/units\.js'/;

/**
 * Every unit key the table carries, as of the day this file was written.
 *
 * A SNAPSHOT, and the only check here that can see a removal. `normalized_unit`
 * on `canonical_attribute_values` is plain text with no foreign key — by design,
 * since the registry is code — so renaming `GB` to `gigabyte` orphans every
 * stored row that says `GB` with nothing in the schema noticing and nothing in a
 * table-walked test noticing either, because the walk would happily agree with
 * the new table about itself.
 *
 * Containment is asserted in ONE direction: every key here must still exist, and
 * new ones are welcome and reported. That is what makes a widening free and a
 * rename a deliberate act — a renamed unit needs a data migration over stored
 * values, and this is where somebody finds that out.
 */
const SNAPSHOT_UNIT_KEYS: readonly string[] = [
  'mm', 'cm', 'm', 'km', 'in', 'ft',
  'mg', 'g', 'kg', 'lb', 'oz',
  'ml', 'cl', 'dl', 'l', 'fl_oz', 'gal',
  'B', 'kB', 'MB', 'GB', 'TB', 'KiB', 'MiB', 'GiB', 'TiB',
  'ms', 's', 'min', 'h', 'd',
  'mW', 'W', 'kW', 'mWh', 'Wh', 'kWh',
  'Hz', 'kHz', 'MHz', 'GHz',
  'bit_s', 'kbit_s', 'Mbit_s', 'Gbit_s',
  'px', 'MP', 'cd_m2', 'mAh', 'Ah', 'count',
  'pct', 'ratio', 'rating_point',
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(directory: string): string[] {
  const files: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      // A test names a forbidden constant in order to test for it — this file
      // literally holds the whole list.
      if (entry === '__tests__' || entry === 'node_modules') continue;
      files.push(...walk(full));
      continue;
    }
    if (entry.endsWith('.ts')) files.push(full);
  }
  return files;
}

/** The production modules the two scans below share. */
function productionModules(): string[] {
  const paths = walk(SRC_ROOT);
  expect(paths.length, `scanned ${paths.length} backend modules`).toBeGreaterThanOrEqual(1500);
  return paths;
}

describe('no second conversion table', () => {
  it('carries no unit conversion constant outside the registry', () => {
    const paths = productionModules();
    // The exemption list, by exact equality. Containment would let it grow.
    expect(CONVERSION_CONSTANT_EXEMPTIONS).toEqual(['services/canonical/units.ts']);

    const violations: string[] = [];
    let scanned = 0;
    for (const path of paths) {
      const key = relative(SRC_ROOT, path);
      if (CONVERSION_CONSTANT_EXEMPTIONS.includes(key)) continue;
      scanned += 1;
      const match = CONVERSION_CONSTANTS.exec(stripComments(readFileSync(path, 'utf8')));
      if (match !== null) violations.push(`${key} carries the conversion constant ${match[0]}`);
    }
    expect(scanned, `${scanned} modules cleared of conversion constants`).toBeGreaterThanOrEqual(
      1500,
    );
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the constant detector fires on a real second table, and not on ordinary numbers', () => {
    expect(CONVERSION_CONSTANTS.test('const inches = millimetres / 25.4;')).toBe(true);
    expect(CONVERSION_CONSTANTS.test('const grams = pounds * 453.59237;')).toBe(true);
    // Full precision AND the truncation people type. The first draft of this
    // pattern matched only the truncations and this line is what found it.
    expect(CONVERSION_CONSTANTS.test('const ml = ounces * 29.5735295625;')).toBe(true);
    expect(CONVERSION_CONSTANTS.test('const ml = ounces * 29.5735;')).toBe(true);
    expect(CONVERSION_CONSTANTS.test('const g = ounces * 28.349523125;')).toBe(true);
    // The three ways a numeric detector normally goes wrong: a longer number
    // that merely contains one, a longer number that merely starts with one,
    // and the round factors that are everywhere.
    expect(CONVERSION_CONSTANTS.test('const share = 125.44;')).toBe(false);
    expect(CONVERSION_CONSTANTS.test('const bps = 225.4;')).toBe(false);
    expect(CONVERSION_CONSTANTS.test('const rate = 25.45;')).toBe(false);
    expect(CONVERSION_CONSTANTS.test('const kilo = value * 1000;')).toBe(false);
    expect(CONVERSION_CONSTANTS.test('const kib = value * 1024;')).toBe(false);
  });

  it('strips comments first, and the stripper keeps the code beside them', () => {
    // This registry's own documentation quotes its factors, so a raw scan would
    // implicate the files that explain themselves best.
    const stripped = stripComments('// 25.4 mm to the inch\nconst kept = toBaseUnit(1, "in");');
    expect(stripped).not.toContain('25.4');
    expect(stripped).toContain('toBaseUnit');
  });
});

describe('every unit reader reads the one registry', () => {
  it('imports it rather than restating it', () => {
    const paths = productionModules();
    const users: string[] = [];
    const strangers: string[] = [];

    for (const path of paths) {
      const source = stripComments(readFileSync(path, 'utf8'));
      if (!UNIT_SYMBOLS.test(source)) continue;
      const key = relative(SRC_ROOT, path);
      users.push(key);
      if (key === 'services/canonical/units.ts') continue;
      if (!UNIT_IMPORT.test(source)) strangers.push(key);
    }

    // The census's own floor. "Every user imports it" is equally true of zero
    // users, which is what a broken symbol pattern produces.
    expect(users.length, `${users.length} modules read the unit registry`).toBeGreaterThanOrEqual(
      10,
    );
    expect(users).toContain('services/canonical/units.ts');
    expect(strangers, `these name a unit symbol without importing it: ${strangers.join(', ')}`)
      .toEqual([]);
  });

  it('the symbol and import patterns each fire on their own fixture', () => {
    expect(UNIT_SYMBOLS.test('const base = BASE_UNITS[family];')).toBe(true);
    expect(UNIT_SYMBOLS.test('const mm = convertUnit(1, "in", "mm");')).toBe(true);
    // The deliberate omission, stated as a test: an unrelated private helper of
    // the same ordinary name is not a unit reader.
    expect(UNIT_SYMBOLS.test('function parseQuantity(value: unknown) { return 0; }')).toBe(false);
    expect(UNIT_IMPORT.test("import { BASE_UNITS } from './units.js';")).toBe(true);
    expect(UNIT_IMPORT.test("import { BASE_UNITS } from '../canonical/units.js';")).toBe(true);
    expect(UNIT_IMPORT.test("import { readUnits } from '../units-report.js';")).toBe(false);
  });
});

describe('unit keys are stable identifiers', () => {
  it('still carries every key stored values may already name', () => {
    const current = new Set(Object.keys(UNIT_DEFINITIONS));
    const missing = SNAPSHOT_UNIT_KEYS.filter((key) => !current.has(key));
    expect(
      missing,
      `these unit keys left the table; stored 'normalized_unit' values naming them are orphaned: ${missing.join(', ')}`,
    ).toEqual([]);
    // Population floor on the snapshot itself, or an emptied list makes the
    // check above vacuous.
    expect(SNAPSHOT_UNIT_KEYS.length).toBeGreaterThanOrEqual(54);
    expect(new Set(SNAPSHOT_UNIT_KEYS).size).toBe(SNAPSHOT_UNIT_KEYS.length);

    // Additions are reported, never refused: widening the table is free and a
    // rename is what this test exists to make expensive.
    const added = [...current].filter((key) => !SNAPSHOT_UNIT_KEYS.includes(key));
    expect(current.size, `unit table carries ${current.size} keys; new since the snapshot: ${added.join(', ') || 'none'}`)
      .toBeGreaterThanOrEqual(SNAPSHOT_UNIT_KEYS.length);
  });

  it('resolves every key to ITSELF, which is what a stored value round-trips through', () => {
    // `normalized_unit` stores the canonical key, and every read resolves it
    // back through `resolveUnit`. A key the resolver answers differently for —
    // an alias entry shadowing a canonical spelling — silently re-points every
    // stored row that names it.
    for (const key of Object.keys(UNIT_DEFINITIONS)) {
      expect(resolveUnit(key), `'${key}' does not resolve to itself`).toBe(key);
      expect(unitFamilyOf(key), `'${key}' has no family`).not.toBeNull();
    }
  });
});
