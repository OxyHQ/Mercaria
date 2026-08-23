/**
 * The seven request-context axes stay seven (#367 line 199, ADR 0007 D4).
 *
 * The epic's invariant reads: *"Keep `language`, `locale`, `market`,
 * `currency`, `measurement system`, `size system` and `time zone` separate in
 * request context."* ADR 0007 D4 says the same thing in the schema's own
 * spelling and adds the mechanism: *"They are carried as seven fields and never
 * collapsed into one."*
 *
 * ## The failure is a DERIVATION, and it never fails loudly
 *
 * Nobody deletes an axis. What happens is that one axis is INFERRED from
 * another because they usually agree — a currency taken off a locale, a market
 * taken off a language, a measurement system taken off a market. Every one of
 * those produces a well-typed, plausible value in the wrong unit for exactly
 * the shopper the axis existed to serve: a Spanish speaker in Ohio, a German
 * device reading `es-ES`, a British buyer paying in euros. `en-US` does not
 * mean USD, Spanish is not Spain, and a market that uses metric for weight may
 * still size shoes locally.
 *
 * ## What was measured before this file was written
 *
 * The storefront half was already gated:
 * `packages/frontend/lib/catalog/__tests__/request-context.test.ts` (#553)
 * carries six of the seven with `timeZone` as one counted exemption, and
 * asserts the market comes off the DEVICE and not off the locale. **The server
 * half had nothing.** There is no request-context object in the backend at all
 * — each endpoint declares its own parameters — so the axes were separate
 * because nothing had been wired together, which is a state and not a
 * mechanism.
 *
 * The walk then asked where a derivation could actually live, and found that a
 * cross-axis inference is almost always ONE SHAPE: a **lookup from one axis's
 * values to another's**. `{ ES: 'EUR' }`, `switch (market) { case 'US': return
 * 'us' }`, `m === 'FR' ? 'fr-fr' : …`, `new Map([['ES', 'Europe/Madrid']])`.
 * All four are gated below (CLAUSE 3), across all six packages.
 *
 * Measured over the tree as it stands: **1,228 candidate mappings in 2,305
 * files, exactly ONE of which maps between two axes** — the CLDR measurement
 * table in `display-units.ts`, which is deliberate, documented, opt-in and
 * named here as a single exemption with its exact key and value sets. Zero
 * false positives. That precision is why this ships: a gate that fires on
 * correct code is a gate the next person disables.
 *
 * ## Why the value census cannot judge four of the 42 ordered pairs
 *
 * It compares VALUES against vocabularies, so it can only separate two axes
 * whose vocabularies are disjoint. CLAUSE 2 derives the overlap matrix rather
 * than assuming it, and finds exactly two overlapping unordered pairs:
 *
 * - `language ∩ locale` = the twelve primary subtags, because `SUPPORTED_LOCALES`
 *   contains bare `es` as well as `es-mx`. This is not a gap in the instrument;
 *   it is the reason the (language, locale) derivation is the one that is
 *   LEGITIMATE. A language is the primary subtag of a locale — a projection
 *   BCP-47 defines, which the ADR's own fallback chain (`es-MX` → `es`) depends
 *   on — not an inference across independent axes.
 * - `measurement_system ∩ size_system` = `{uk, us}`. Both spell two of their
 *   values the same way, so a site mapping into either is reported under BOTH
 *   readings and judged by a person. The exempt site below is exactly that
 *   case.
 *
 * So 38 of the 42 ordered pairs are judgeable and 4 are not, and both numbers
 * are an OUTCOME of vocabularies this file derives rather than a list of pairs
 * somebody found interesting.
 *
 * ## The case values are compared CASE-SENSITIVELY, and that is load-bearing
 *
 * ISO-639 language subtags and ISO-3166 region subtags occupy the same
 * two-letter space and are told apart ONLY by case: `es` is Spanish, `ES` is
 * Spain, `uk` is Ukrainian AND the imperial system, `eu` is Basque AND a size
 * region. BCP-47's convention (lowercase language, uppercase region) is what
 * this repository already follows — `catalog-rollout/cohort.ts` upper-cases a
 * market and lower-cases a locale on both sides of every comparison, and
 * `readDeviceMarket` upper-cases. Comparing case-insensitively made `{ es:
 * 'es' }` read as a language→market table; it is the false positive that shaped
 * the rule.
 *
 * ## Why the vocabularies are DERIVED and not written down
 *
 * `SUPPORTED_LOCALES`, `ALL_CURRENCY_CODES` and the three size tuples come from
 * `@mercaria/shared-types`; `MEASUREMENT_SYSTEMS` is imported from the module
 * that owns it, so deleting it breaks this file rather than emptying it
 * silently; markets and time zones come from `Intl`, which is CLDR. Nothing
 * here transcribes a list, so a widened currency tuple or a new locale is
 * covered on the commit that adds it.
 *
 * CLAUSE 0 is the instrument's own known-answer assertion, and its strongest
 * clause is that the census MUST STILL FIND the one exempt site: an exemption
 * list is exactly how a broken walker reports a clean, constant absence.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import {
  ALL_CURRENCY_CODES,
  SIZE_AUDIENCES,
  SIZE_DOMAINS,
  SIZE_REGIONS,
  SUPPORTED_LOCALES,
} from '@mercaria/shared-types';
import { MEASUREMENT_SYSTEMS } from '../services/canonical/display-units.js';
import { assertEachOf } from './assert-each-of.js';
import {
  PACKAGES_ROOT,
  walkPackagesDirectory,
  type DirectoryEntry,
  type DirectoryReader,
} from './domain-population.js';
import { reportPopulation } from './report-population.js';

/* ------------------------------------------------------------------ *
 * The seven, and the two independent artefacts they are bound to
 * ------------------------------------------------------------------ */

/**
 * The seven axes, each in BOTH spellings the repository uses for it.
 *
 * The ADR writes them in the schema's snake_case; the storefront's own
 * `ADR_0007_D4_REQUEST_DIMENSIONS` writes them as the camelCase fields a
 * context object carries. Two spellings of one set is exactly the drift this
 * list would hide, which is why CLAUSE 1 compares each column for EQUALITY
 * against the artefact that owns it rather than for containment — a list
 * trimmed to match the code would make every clause below pass by describing
 * less.
 *
 * `requestFields` is the third column and is the backend's: the zod field names
 * under which this axis may arrive on an HTTP request. `country` is
 * deliberately NOT a `market` field — the four schemas carrying one
 * (`offer-schemas`, `pickup-schemas`, `payments-schemas`, `schemas`) mean a
 * delivery destination or a location's own country, which is a fact about a
 * ROW rather than about the requester.
 */
const REQUEST_CONTEXT_AXES = [
  { adr: 'language', client: 'language', requestFields: ['language', 'languages'] },
  { adr: 'locale', client: 'locale', requestFields: ['locale', 'locales'] },
  { adr: 'market', client: 'market', requestFields: ['market', 'markets'] },
  { adr: 'currency', client: 'currency', requestFields: ['currency'] },
  { adr: 'measurement_system', client: 'unitSystem', requestFields: ['unitSystem'] },
  { adr: 'size_system', client: 'sizeSystem', requestFields: ['sizeSystem'] },
  { adr: 'time_zone', client: 'timeZone', requestFields: ['timeZone', 'timezone'] },
] as const;

type AxisName = (typeof REQUEST_CONTEXT_AXES)[number]['adr'];

const AXIS_NAMES: readonly AxisName[] = REQUEST_CONTEXT_AXES.map((a) => a.adr);

const ADR_PATH = join(PACKAGES_ROOT, '..', 'docs', 'adr', '0007-universal-catalog-taxonomy-and-authoring.md');
const CLIENT_CONTEXT_PATH = join(PACKAGES_ROOT, 'frontend', 'lib', 'catalog', 'request-context.ts');

/**
 * The seven names out of ADR 0007 D4's own sentence.
 *
 * The sentence WRAPS — `size_system` ends line 449 and `time_zone` opens 450 —
 * so a line-anchored pattern reads six and passes, having silently dropped the
 * axis nothing carries. The `[\s\S]` class is what makes the match span the
 * break, and CLAUSE 1's exact count is what would catch it if it stopped.
 */
function axesNamedByTheAdr(): string[] {
  const text = readFileSync(ADR_PATH, 'utf8');
  const sentence = /((?:`[a-z_]+`(?:,\s*|\s+and\s+))+`[a-z_]+`)[\s\S]{0,40}?are seven independent request-context/u.exec(
    text,
  );
  if (sentence === null) return [];
  return [...sentence[1].matchAll(/`([a-z_]+)`/gu)].map((m) => m[1] as string);
}

/**
 * The dimension names out of the storefront's own constant, read as an AST.
 *
 * As TEXT and not as an import: no backend test imports a client module, and
 * parsing the declaration is exact where a regex over the array body would be a
 * second spelling of the same list.
 */
function dimensionsDeclaredByTheClient(): string[] {
  const source = ts.createSourceFile(
    CLIENT_CONTEXT_PATH,
    readFileSync(CLIENT_CONTEXT_PATH, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'ADR_0007_D4_REQUEST_DIMENSIONS'
    ) {
      const array = node.initializer !== undefined && ts.isAsExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      if (array !== undefined && ts.isArrayLiteralExpression(array)) {
        for (const element of array.elements) {
          if (ts.isStringLiteral(element)) names.push(element.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/* ------------------------------------------------------------------ *
 * The vocabularies, all derived
 * ------------------------------------------------------------------ */

const REGION_DISPLAY_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });

/**
 * Every ISO-3166-1 alpha-2 region CLDR knows, UPPERCASE.
 *
 * Enumerated by asking `Intl` about all 676 two-letter combinations and keeping
 * the ones it names: `DisplayNames.of` returns the input unchanged for a code
 * it does not know, which is the discriminator. Uppercase only — see the
 * docblock on why case is the only thing separating a region from a language.
 */
function iso3166Alpha2Regions(): string[] {
  const codes: string[] = [];
  for (let first = 65; first <= 90; first += 1) {
    for (let second = 65; second <= 90; second += 1) {
      const code = String.fromCharCode(first) + String.fromCharCode(second);
      if (REGION_DISPLAY_NAMES.of(code) !== code) codes.push(code);
    }
  }
  return codes;
}

/** The primary subtag of a BCP-47 tag — `languageOf`, one package over. */
function primarySubtag(tag: string): string {
  const [primary] = tag.split('-');
  return (primary ?? tag).toLowerCase();
}

const AXIS_VOCABULARY: Readonly<Record<AxisName, ReadonlySet<string>>> = Object.freeze({
  language: new Set(SUPPORTED_LOCALES.map(primarySubtag)),
  locale: new Set<string>(SUPPORTED_LOCALES),
  market: new Set(iso3166Alpha2Regions()),
  currency: new Set<string>(ALL_CURRENCY_CODES),
  measurement_system: new Set<string>(MEASUREMENT_SYSTEMS),
  size_system: new Set<string>([...SIZE_REGIONS, ...SIZE_DOMAINS, ...SIZE_AUDIENCES]),
  time_zone: new Set(Intl.supportedValuesOf('timeZone')),
});

/** Ordered pairs whose two vocabularies share no value, so a value can name one. */
function judgeableOrderedPairs(): Set<string> {
  const judgeable = new Set<string>();
  for (const from of AXIS_NAMES) {
    for (const to of AXIS_NAMES) {
      if (from === to) continue;
      let shared = false;
      for (const value of AXIS_VOCABULARY[from]) {
        if (AXIS_VOCABULARY[to].has(value)) {
          shared = true;
          break;
        }
      }
      if (!shared) judgeable.add(`${from}->${to}`);
    }
  }
  return judgeable;
}

const JUDGEABLE_PAIRS = judgeableOrderedPairs();

/* ------------------------------------------------------------------ *
 * The census
 * ------------------------------------------------------------------ */

/** Directories holding no authored source, and `__tests__` (a fixture is not a rule). */
const NON_SOURCE_DIRECTORIES = new Set([
  'node_modules',
  '__tests__',
  'dist',
  '.expo',
  'drizzle',
  'assets',
  'public',
]);

const readSourceDirectory: DirectoryReader = (relative) =>
  readdirSync(join(PACKAGES_ROOT, relative), { withFileTypes: true }).filter(
    (entry: DirectoryEntry) => !NON_SOURCE_DIRECTORIES.has(entry.name),
  );

/** Every workspace package, derived by listing `packages/` rather than named. */
function workspacePackages(): string[] {
  return readdirSync(PACKAGES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !NON_SOURCE_DIRECTORIES.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

interface MappingSite {
  readonly file: string;
  readonly line: number;
  readonly shape: 'object' | 'switch' | 'ternary' | 'entries';
  readonly keys: readonly string[];
  readonly values: readonly string[];
  readonly pairs: readonly string[];
}

interface ScanResult {
  readonly sites: readonly MappingSite[];
  /** Candidate key→value mappings examined, whether or not they named an axis. */
  readonly candidates: number;
}

/** Which judgeable pairs this key set → value set could be a table for. */
function pairsFor(keys: readonly string[], values: readonly string[]): string[] {
  if (keys.length < 2 || values.length < 2) return [];
  const keyAxes = AXIS_NAMES.filter((axis) => keys.every((k) => AXIS_VOCABULARY[axis].has(k)));
  const valueAxes = AXIS_NAMES.filter((axis) => values.every((v) => AXIS_VOCABULARY[axis].has(v)));
  const pairs = new Set<string>();
  for (const from of keyAxes) {
    for (const to of valueAxes) {
      if (from !== to && JUDGEABLE_PAIRS.has(`${from}->${to}`)) pairs.add(`${from}->${to}`);
    }
  }
  return [...pairs];
}

/**
 * The four shapes a value-to-value lookup takes, over one file.
 *
 * A `Record` literal, a `switch` returning literals, a chain of `===` ternaries
 * and an array of two-element tuples (which is what `new Map([...])` is). The
 * fourth exists because `Map` is the shape somebody reaches for when a `Record`
 * would need a string index signature.
 *
 * What it does NOT see is stated rather than implied: an `if`/`else if` chain, a
 * regex, a lookup assembled at runtime, and a table split across two files. The
 * miss set is the price of a detector with no false positives, and every miss
 * is a shape a reviewer can see in a diff.
 */
function scanSource(relativePath: string, text: string): ScanResult {
  const source = ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const sites: MappingSite[] = [];
  let candidates = 0;

  const record = (
    shape: MappingSite['shape'],
    node: ts.Node,
    keys: string[],
    values: string[],
  ): void => {
    candidates += 1;
    const pairs = pairsFor(keys, values);
    if (pairs.length === 0) return;
    sites.push({
      file: relativePath,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      shape,
      keys,
      values,
      pairs,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) && node.properties.length >= 2) {
      const keys: string[] = [];
      const values: string[] = [];
      let literal = true;
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) {
          literal = false;
          break;
        }
        const name = property.name;
        if (ts.isIdentifier(name) || ts.isStringLiteral(name)) keys.push(name.text);
        else {
          literal = false;
          break;
        }
        if (!ts.isStringLiteral(property.initializer)) {
          literal = false;
          break;
        }
        values.push(property.initializer.text);
      }
      if (literal) record('object', node, keys, values);
    }

    if (ts.isSwitchStatement(node)) {
      const keys: string[] = [];
      const values: string[] = [];
      let literal = node.caseBlock.clauses.length >= 2;
      for (const clause of node.caseBlock.clauses) {
        if (!ts.isCaseClause(clause)) continue;
        if (!ts.isStringLiteral(clause.expression)) {
          literal = false;
          break;
        }
        keys.push(clause.expression.text);
        const returned: string[] = [];
        const dig = (statement: ts.Node): void => {
          if (
            ts.isReturnStatement(statement) &&
            statement.expression !== undefined &&
            ts.isStringLiteral(statement.expression)
          ) {
            returned.push(statement.expression.text);
          }
          ts.forEachChild(statement, dig);
        };
        clause.statements.forEach(dig);
        if (returned.length === 0) {
          literal = false;
          break;
        }
        values.push(...returned);
      }
      if (literal && keys.length >= 2) record('switch', node, keys, values);
    }

    if (ts.isConditionalExpression(node) && !ts.isConditionalExpression(node.parent)) {
      const keys: string[] = [];
      const values: string[] = [];
      let cursor: ts.Expression = node;
      let literal = true;
      while (ts.isConditionalExpression(cursor)) {
        const condition = cursor.condition;
        if (
          !ts.isBinaryExpression(condition) ||
          !ts.isStringLiteral(condition.right) ||
          (condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
            condition.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken) ||
          !ts.isStringLiteral(cursor.whenTrue)
        ) {
          literal = false;
          break;
        }
        keys.push(condition.right.text);
        values.push(cursor.whenTrue.text);
        cursor = cursor.whenFalse;
      }
      if (literal && ts.isStringLiteral(cursor)) values.push(cursor.text);
      if (literal && keys.length >= 2) record('ternary', node, keys, values);
    }

    if (ts.isArrayLiteralExpression(node) && node.elements.length >= 2) {
      const keys: string[] = [];
      const values: string[] = [];
      let literal = true;
      for (const element of node.elements) {
        if (!ts.isArrayLiteralExpression(element) || element.elements.length !== 2) {
          literal = false;
          break;
        }
        const [key, value] = element.elements;
        if (key === undefined || value === undefined || !ts.isStringLiteral(key) || !ts.isStringLiteral(value)) {
          literal = false;
          break;
        }
        keys.push(key.text);
        values.push(value.text);
      }
      if (literal) record('entries', node, keys, values);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return { sites, candidates };
}

/**
 * The ONE cross-axis table in the tree, named by its CONTENTS.
 *
 * Not by file and not by line. A file-shaped exemption excuses the second table
 * somebody adds to that file, and a line number rots on any edit above it — so
 * the key set and the value set are the identity, and changing either makes the
 * site a new one that has to be decided again.
 *
 * `NON_METRIC_MARKETS` is CLDR's supplemental `measurementData`, and it is a
 * legitimate market→measurement_system table for a reason the value census
 * cannot see: it is offered as a FALLBACK. `catalog-attributes.controller.ts`'s
 * `preferredSystem` returns an explicit `?unitSystem=` first and reaches this
 * table only when the request stated no preference, and `measurementSystemForMarket`
 * answers `null` rather than `metric` for a market it has no data for. That
 * ordering is what keeps it a fallback instead of the collapse this file
 * exists to prevent, and it is pinned by
 * `routes/__tests__/catalog-attribute-display-units.test.ts`.
 *
 * It is reported under TWO readings because `us` and `uk` are values of both
 * `measurement_system` and `size_system` (CLAUSE 2), and the second reading is
 * false. Recording both is the honest form: the census reports what a value can
 * mean and a person decides which it does.
 */
const CROSS_AXIS_MAPPING_EXEMPTIONS = [
  {
    symbol: 'NON_METRIC_MARKETS',
    file: 'backend/src/services/canonical/display-units.ts',
    keys: ['US', 'LR', 'MM', 'GB'],
    values: ['us', 'us', 'us', 'uk'],
    readings: ['market->measurement_system', 'market->size_system'],
    reason:
      "CLDR supplemental measurementData, transcribed. It is a FALLBACK and not a derivation: "
      + "preferredSystem() returns an explicit ?unitSystem= first and consults this table only "
      + "when the request stated no preference, and measurementSystemForMarket answers null — not "
      + "metric — for a market CLDR has no entry for. The market->size_system reading is an "
      + "artefact of 'us' and 'uk' belonging to both vocabularies; no size system is derived here.",
  },
] as const;

function exemptionMatches(
  site: MappingSite,
  exemption: (typeof CROSS_AXIS_MAPPING_EXEMPTIONS)[number],
): boolean {
  return (
    site.file === exemption.file &&
    site.keys.join('|') === exemption.keys.join('|') &&
    site.values.join('|') === exemption.values.join('|')
  );
}

/** Every authored source file in every workspace package, walked. */
function sourceFiles(): string[] {
  return workspacePackages()
    .flatMap((pkg) => walkPackagesDirectory(pkg, readSourceDirectory))
    .sort();
}

let scannedFiles = 0;
let scannedCandidates = 0;
const foundSites: MappingSite[] = [];
for (const file of sourceFiles()) {
  scannedFiles += 1;
  const result = scanSource(file, readFileSync(join(PACKAGES_ROOT, file), 'utf8'));
  scannedCandidates += result.candidates;
  foundSites.push(...result.sites);
}

/* ------------------------------------------------------------------ *
 * CLAUSE 0 — the instrument answers questions whose answers are known
 * ------------------------------------------------------------------ */

describe('CLAUSE 0: the instrument', () => {
  it('derives a vocabulary for every axis, and each admits and refuses a known value', () => {
    // The floors are what a broken derivation trips: an empty set admits
    // nothing, so every pair below it would report a clean, constant absence.
    const floors: Readonly<Record<AxisName, number>> = {
      language: 10,
      locale: 30,
      market: 200,
      currency: 5,
      measurement_system: 3,
      size_system: 15,
      time_zone: 300,
    };
    assertEachOf(REQUEST_CONTEXT_AXES, 7, (axis) => {
      expect(
        AXIS_VOCABULARY[axis.adr].size,
        `${axis.adr}'s vocabulary collapsed to ${AXIS_VOCABULARY[axis.adr].size}`,
      ).toBeGreaterThanOrEqual(floors[axis.adr]);
    });

    // Known answers. Each pair is a value the axis MUST hold and one it must
    // not — the second half is what a vocabulary of "everything" would fail.
    const known: readonly (readonly [AxisName, string, string])[] = [
      ['language', 'es', 'es-mx'],
      ['locale', 'es-mx', 'ES'],
      ['market', 'ES', 'es'],
      ['currency', 'EUR', 'eur'],
      ['measurement_system', 'metric', 'imperial'],
      ['size_system', 'footwear', 'FOOTWEAR'],
      ['time_zone', 'Europe/Madrid', 'Europe/Atlantis'],
    ];
    assertEachOf(known, 7, ([axis, admitted, refused]) => {
      expect(AXIS_VOCABULARY[axis].has(admitted), `${axis} refused ${admitted}`).toBe(true);
      expect(AXIS_VOCABULARY[axis].has(refused), `${axis} admitted ${refused}`).toBe(false);
    });
  });

  it('walks every workspace package and examines a real population of candidates', () => {
    const packages = workspacePackages();
    // Six today. Derived by listing, so a seventh joins the census on the commit
    // that creates it — and a walk that lost one goes red here rather than
    // reporting a smaller clean tree.
    expect(packages.length, `packages/ listed ${packages.join(', ')}`).toBeGreaterThanOrEqual(6);
    expect(packages).toContain('backend');
    expect(packages).toContain('frontend');
    expect(packages).toContain('shared-types');
    expect(packages).toContain('ui');
    expect(packages).toContain('dashboard');
    expect(packages).toContain('pos');

    // Two floors, because they fail differently: a traversal that stopped early
    // has few FILES, and a parser that stopped recognising literals has few
    // CANDIDATES over the same files.
    expect(scannedFiles, 'the traversal shrank').toBeGreaterThanOrEqual(2_000);
    expect(scannedCandidates, 'the parser stopped recognising mappings').toBeGreaterThanOrEqual(900);
    reportPopulation(
      `[#367 line 199] request-context axes: ${scannedFiles} files, ${scannedCandidates} candidate `
        + `mappings, ${foundSites.length} cross-axis site(s), `
        + `${JUDGEABLE_PAIRS.size}/${AXIS_NAMES.length * (AXIS_NAMES.length - 1)} judgeable pairs`,
    );
  });

  it('still FINDS the one site it exempts — the positive control on the whole census', () => {
    // Without this, a walker that read nothing would report zero unexempted
    // sites and go green forever. The exemption list is precisely the mechanism
    // that would hide it.
    assertEachOf(CROSS_AXIS_MAPPING_EXEMPTIONS, 1, (exemption) => {
      const matched = foundSites.filter((site) => exemptionMatches(site, exemption));
      expect(
        matched.length,
        `${exemption.symbol} was not found by the census — the walker, the parser or the `
          + 'vocabularies stopped working, and every clause below is now vacuous',
      ).toBe(1);
      expect([...(matched[0]?.pairs ?? [])].sort()).toEqual([...exemption.readings].sort());
    });
  });
});

/* ------------------------------------------------------------------ *
 * CLAUSE 1 — the seven are the ADR's seven and the client's seven
 * ------------------------------------------------------------------ */

describe('CLAUSE 1: the axis list is bound to two artefacts it does not own', () => {
  it('names exactly the seven ADR 0007 D4 names, across the line break', () => {
    const fromAdr = axesNamedByTheAdr();
    expect(
      fromAdr.length,
      'ADR 0007 D4 no longer names seven axes in the sentence this file parses — a wrapped '
        + 'sentence read by a line-anchored pattern reads six and passes',
    ).toBe(7);
    // EQUALITY in both directions. Containment one way is satisfied by a list
    // trimmed to the code; the other way by an axis the ADR never named.
    expect([...fromAdr].sort()).toEqual([...AXIS_NAMES].sort());
  });

  it('names exactly the seven the storefront declares, in the storefront spelling', () => {
    const fromClient = dimensionsDeclaredByTheClient();
    expect(
      fromClient.length,
      'ADR_0007_D4_REQUEST_DIMENSIONS was not found in packages/frontend/lib/catalog/'
        + 'request-context.ts, or is no longer seven entries',
    ).toBe(7);
    expect([...fromClient].sort()).toEqual([...REQUEST_CONTEXT_AXES.map((a) => a.client)].sort());
  });

  it('gives every axis a distinct name in both spellings', () => {
    expect(new Set(AXIS_NAMES).size).toBe(7);
    expect(new Set(REQUEST_CONTEXT_AXES.map((a) => a.client)).size).toBe(7);
  });
});

/* ------------------------------------------------------------------ *
 * CLAUSE 2 — which pairs a value census can judge, derived
 * ------------------------------------------------------------------ */

describe('CLAUSE 2: the vocabulary overlap matrix', () => {
  it('finds exactly two overlapping pairs, and names their members', () => {
    const overlaps: { pair: string; shared: string[] }[] = [];
    for (let i = 0; i < AXIS_NAMES.length; i += 1) {
      for (let j = i + 1; j < AXIS_NAMES.length; j += 1) {
        const a = AXIS_NAMES[i] as AxisName;
        const b = AXIS_NAMES[j] as AxisName;
        const shared = [...AXIS_VOCABULARY[a]].filter((v) => AXIS_VOCABULARY[b].has(v));
        if (shared.length > 0) overlaps.push({ pair: `${a} ∩ ${b}`, shared });
      }
    }
    reportPopulation(
      `[#367 line 199] vocabulary overlaps: ${overlaps.map((o) => `${o.pair}={${o.shared.join(',')}}`).join('  ')}`,
    );

    // The two are a fact about the vocabularies, not a choice. A THIRD would
    // mean two axes had started sharing a value space, which is the untyped
    // carrier this whole file is about — so it fails here rather than quietly
    // widening the unjudgeable set.
    expect(overlaps.map((o) => o.pair).sort()).toEqual([
      'language ∩ locale',
      'measurement_system ∩ size_system',
    ]);
    expect(
      overlaps.find((o) => o.pair === 'measurement_system ∩ size_system')?.shared.sort(),
    ).toEqual(['uk', 'us']);
    // language ⊂ locale ENTIRELY: every language is a locale, which is what
    // makes the projection legitimate rather than an inference.
    expect(
      overlaps.find((o) => o.pair === 'language ∩ locale')?.shared.length,
    ).toBe(AXIS_VOCABULARY.language.size);
  });

  it('leaves 38 of the 42 ordered pairs judgeable', () => {
    const ordered = AXIS_NAMES.length * (AXIS_NAMES.length - 1);
    expect(ordered).toBe(42);
    expect(JUDGEABLE_PAIRS.size).toBe(38);
    for (const unjudgeable of [
      'language->locale',
      'locale->language',
      'measurement_system->size_system',
      'size_system->measurement_system',
    ]) {
      expect(JUDGEABLE_PAIRS.has(unjudgeable), `${unjudgeable} should be unjudgeable`).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * CLAUSE 3 — no module maps one axis's values onto another's
 * ------------------------------------------------------------------ */

describe('CLAUSE 3: the cross-axis mapping census', () => {
  it('finds no cross-axis lookup outside the one named exemption', () => {
    const unexempted = foundSites.filter(
      (site) => !CROSS_AXIS_MAPPING_EXEMPTIONS.some((e) => exemptionMatches(site, e)),
    );
    expect(
      unexempted.map((s) => `${s.file}:${s.line} [${s.shape}] ${s.pairs.join(', ')} keys=${JSON.stringify(s.keys.slice(0, 6))} values=${JSON.stringify(s.values.slice(0, 6))}`),
      'a module maps one request-context axis onto another. `en-US` does not mean USD and '
        + 'Spanish is not Spain: each axis is resolved from its own source and carried as its own '
        + 'field. If this table is a legitimate, opt-in FALLBACK — as CLDR measurementData is — '
        + 'add it to CROSS_AXIS_MAPPING_EXEMPTIONS with the ordering that keeps it one.',
    ).toEqual([]);
  });

  it('exempts EXACTLY one site, with a reason', () => {
    // Pinned rather than bounded: a list of exemptions a gate skips is how a
    // gate stops being one.
    expect(CROSS_AXIS_MAPPING_EXEMPTIONS).toHaveLength(1);
    const [only] = CROSS_AXIS_MAPPING_EXEMPTIONS;
    expect(only?.symbol).toBe('NON_METRIC_MARKETS');
    expect(only?.reason.length, 'an empty string satisfies "has a reason"').toBeGreaterThan(200);
  });
});

/* ------------------------------------------------------------------ *
 * CLAUSE 4 — the detector can actually fail
 * ------------------------------------------------------------------ */

describe('CLAUSE 4: the detector is violable, in every shape it claims', () => {
  const PLANTS = [
    ['object   currency from market', "const M = { ES: 'EUR', US: 'USD', JP: 'JPY' };", 'market->currency'],
    ['object   currency from locale', "const M = { 'en-us': 'USD', 'es-es': 'EUR', 'ja-jp': 'JPY' };", 'locale->currency'],
    ['object   market from language', "const M = { fr: 'FR', ja: 'JP', hi: 'IN' };", 'language->market'],
    ['object   zone from market', "const M = { ES: 'Europe/Madrid', JP: 'Asia/Tokyo' };", 'market->time_zone'],
    ['object   locale from market', "const M = { FR: 'fr-fr', JP: 'ja-jp' };", 'market->locale'],
    ['switch   currency from market', "function f(m: string) { switch (m) { case 'ES': return 'EUR'; case 'JP': return 'JPY'; } return null; }", 'market->currency'],
    ['switch   zone from market', "function z(m: string) { switch (m) { case 'ES': return 'Europe/Madrid'; case 'JP': return 'Asia/Tokyo'; } return null; }", 'market->time_zone'],
    ['ternary  currency from market', "const f = (m: string) => (m === 'ES' ? 'EUR' : m === 'JP' ? 'JPY' : 'USD');", 'market->currency'],
    ['ternary  locale from market', "const g = (m: string) => (m === 'FR' ? 'fr-fr' : m === 'JP' ? 'ja-jp' : 'en');", 'market->locale'],
    ['entries  currency from market', "const M = new Map([['ES', 'EUR'], ['JP', 'JPY']]);", 'market->currency'],
    ['entries  market from language', "const M = new Map([['fr', 'FR'], ['ja', 'JP']]);", 'language->market'],
  ] as const;

  it('names every planted conflation', () => {
    assertEachOf(PLANTS, 11, ([label, source, expected]) => {
      const { sites } = scanSource('plant.ts', source);
      expect(sites.flatMap((s) => s.pairs), `${label} was not named`).toContain(expected);
    });
    // Every shape the detector claims is exercised by at least one plant — a
    // shape with no plant is a branch nobody has proved runs, and three of the
    // four found nothing in the real tree.
    const shapes = new Set(
      PLANTS.flatMap(([, source]) => scanSource('plant.ts', source).sites.map((s) => s.shape)),
    );
    expect([...shapes].sort()).toEqual(['entries', 'object', 'switch', 'ternary']);
  });

  const CONTROLS = [
    ['a map between unrelated vocabularies', "const M = { alpha: 'one', beta: 'two' };"],
    ['a single-entry map, which is not a table', "const M = { ES: 'EUR' };"],
    ['a same-axis identity map', "const M = { EUR: 'EUR', USD: 'USD' };"],
    ['a language-to-language map, which the overlap rule makes unjudgeable', "const M = { es: 'es', en: 'en' };"],
    ['a switch over non-axis values', "function f(k: string) { switch (k) { case 'alpha': return 'one'; case 'beta': return 'two'; } return null; }"],
    ['a ternary over non-axis values', "const f = (k: string) => (k === 'alpha' ? 'one' : k === 'beta' ? 'two' : 'three');"],
    ['entries over non-axis values', "const M = new Map([['alpha', 'one'], ['beta', 'two']]);"],
  ] as const;

  it('stays silent on every negative control', () => {
    // The half that decides whether this gate survives contact with a reviewer.
    // A detector that fired on correct code would be disabled by the first
    // person who hit it, so the controls include the two shapes that DID fire
    // before the case rule and the overlap rule were added.
    assertEachOf(CONTROLS, 7, ([label, source]) => {
      const { sites } = scanSource('control.ts', source);
      expect(sites.flatMap((s) => s.pairs), `${label} was flagged`).toEqual([]);
    });
  });
});

/* ------------------------------------------------------------------ *
 * CLAUSE 5 — every ordered pair, reported
 * ------------------------------------------------------------------ */

describe('CLAUSE 5: all 42 ordered pairs', () => {
  it('reports each pair, its judgeability and its site count', () => {
    const lines: string[] = [];
    let judgeableWithoutSite = 0;
    for (const from of AXIS_NAMES) {
      for (const to of AXIS_NAMES) {
        if (from === to) continue;
        const key = `${from}->${to}`;
        const judgeable = JUDGEABLE_PAIRS.has(key);
        const count = foundSites.filter((s) => s.pairs.includes(key)).length;
        if (judgeable && count === 0) judgeableWithoutSite += 1;
        lines.push(`${key}=${judgeable ? count : 'n/a'}`);
      }
    }
    expect(lines).toHaveLength(42);
    reportPopulation(`[#367 line 199] ordered pairs: ${lines.join(' ')}`);
    // 36 of the 38 judgeable pairs have no site at all, which is the finding
    // and not an absence of measurement — CLAUSE 0's positive control is what
    // separates the two.
    expect(judgeableWithoutSite).toBe(36);
  });
});

/* ------------------------------------------------------------------ *
 * CLAUSE 6 — what the backend's request surface can actually receive
 * ------------------------------------------------------------------ */

/**
 * The axes the backend carries no request field for, each with its reason.
 *
 * EXACTLY one, and the count is pinned for the reason the storefront's own
 * exemption list is: a category that excuses is load-bearing in the permissive
 * direction, so it is a named list with an exact length rather than a rule
 * somebody can satisfy by adding a member.
 */
const CARRIAGE_EXEMPTIONS = [
  {
    axis: 'size_system',
    reason:
      'Mercaria publishes NO size-system mapping over HTTP, so there is no value a request could '
      + 'send that would authorize collapsing EU 42 into US 9 — which is exactly why the '
      + 'storefront CatalogSizeSystem has one member, `unspecified`. The axis is fully modelled '
      + 'as a property of a size VALUE (shared-types/size-system.ts: domain, region, audience, '
      + 'basis) and compareSizeDeclarations refuses across systems. A request parameter would be '
      + 'a field with no consumer, which is worse than an absence a reader can see: it satisfies '
      + 'the ADR sentence and changes nothing. It arrives with the sourced mapping that gives it '
      + 'a meaning.',
  },
] as const;

describe('CLAUSE 6: the backend request surface', () => {
  it('carries every axis it does not exempt, and exempts nothing it carries', async () => {
    const middlewareDir = join(PACKAGES_ROOT, 'backend', 'src', 'middleware');
    const modules = readdirSync(middlewareDir).filter((f) => f.endsWith('.ts'));
    const carriers = new Map<string, Set<string>>();
    let fieldNames = 0;

    for (const file of modules) {
      const loaded = (await import(join(middlewareDir, file))) as Record<string, unknown>;
      const seen = new Set<unknown>();
      const walk = (node: unknown, depth: number): void => {
        if (depth > 8 || node === null || typeof node !== 'object' || seen.has(node)) return;
        seen.add(node);
        const def = (node as { _def?: { typeName?: string; shape?: unknown } })._def;
        if (def === undefined) return;
        if (def.typeName === 'ZodObject' && typeof def.shape === 'function') {
          for (const [key, child] of Object.entries((def.shape as () => Record<string, unknown>)())) {
            fieldNames += 1;
            if (!carriers.has(key)) carriers.set(key, new Set());
            (carriers.get(key) as Set<string>).add(file);
            walk(child, depth + 1);
          }
          return;
        }
        for (const value of Object.values(def)) {
          if (Array.isArray(value)) value.forEach((entry) => walk(entry, depth + 1));
          else walk(value, depth + 1);
        }
      };
      for (const exported of Object.values(loaded)) walk(exported, 0);
    }

    // Floors on the instrument. A module that failed to import contributes no
    // fields, and an axis would then read as absent.
    expect(modules.length, 'the middleware directory shrank').toBeGreaterThanOrEqual(70);
    expect(fieldNames, 'the zod walk stopped descending').toBeGreaterThanOrEqual(1_000);
    expect(carriers.size, 'no distinct field names were collected').toBeGreaterThanOrEqual(500);
    // A known answer that must PASS: `currency` is carried widely, so a walk
    // that silently found nothing announces itself here rather than in the
    // clause below, where an exemption could absorb it.
    expect((carriers.get('currency') as Set<string> | undefined)?.size ?? 0).toBeGreaterThanOrEqual(10);

    const exempt = new Set(CARRIAGE_EXEMPTIONS.map((e) => e.axis as string));
    const counts: string[] = [];
    assertEachOf(REQUEST_CONTEXT_AXES, 7, (axis) => {
      const modulesCarrying = new Set(
        axis.requestFields.flatMap((field) => [...(carriers.get(field) ?? [])]),
      );
      counts.push(`${axis.adr}=${modulesCarrying.size}`);
      if (exempt.has(axis.adr)) {
        // An exempt axis must genuinely be absent. An exemption for something
        // that IS carried is a stale excuse, and the next reader cannot tell it
        // from a live one.
        expect(
          modulesCarrying.size,
          `${axis.adr} is exempt but IS carried by ${[...modulesCarrying].join(', ')} — remove the exemption`,
        ).toBe(0);
        return;
      }
      expect(
        modulesCarrying.size,
        `${axis.adr} has no request field on the backend surface. An axis a request cannot state `
          + 'is an axis the server must infer from another one, which is the collapse this file '
          + 'exists to prevent — `measurement_system` is one deletion away from being wholly '
          + 'derived from `market`. Add it back, or exempt it with the reason it may not be sent.',
      ).toBeGreaterThanOrEqual(1);
    });
    reportPopulation(`[#367 line 199] backend request carriage (modules): ${counts.join(' ')}`);
  });

  it('exempts EXACTLY one axis from carriage, with a reason', () => {
    expect(CARRIAGE_EXEMPTIONS).toHaveLength(1);
    const [only] = CARRIAGE_EXEMPTIONS;
    expect(only?.axis).toBe('size_system');
    expect(only?.reason.length).toBeGreaterThan(200);
    // And it is one of the seven, not a name somebody invented.
    expect(AXIS_NAMES as readonly string[]).toContain(only?.axis);
  });
});
