/**
 * The product-type domain's walls, asserted STRUCTURALLY (#367, ADR 0007
 * D5/D6/D14).
 *
 * Four things this domain must not be able to do, and a gate for each:
 *
 * 1. **Reach money, stock or ranking.** ADR 0007 D5: "listing, offer and
 *    inventory fields are COMPOSED into the authoring schema, never modelled as
 *    product-type attributes", and the epic's non-goals put every ranking use of
 *    catalog data behind #74's versioned policy. A module that cannot IMPORT
 *    those domains cannot model them, which is a stronger statement than any
 *    behavioural fixture makes.
 * 2. **Execute anything.** The visibility-rule interpreter is the one place a
 *    stored row's content is interpreted at all, and D5 requires it to have no
 *    function calls and no row-supplied regexes. `eval`, `new Function`,
 *    `node:vm`, `child_process` and four template engines are scanned for.
 * 3. **Restate what an attribute MEANS.** The schema file may not declare a
 *    value type, a unit family, a bound, a precision or an enum-value column:
 *    #94's registry is the one authority, and a second description of one fact
 *    is how the two come to disagree.
 * 4. **Reach the outside world.** A schema resolution makes no HTTP call, opens
 *    no socket and reads no environment variable — there is no TTL, no cohort
 *    and no flag in this domain, so a `config` import would be the first step
 *    toward one.
 *
 * Built with the AGENTS.md gate defences throughout: every detector runs against
 * COMMENT-STRIPPED source (these modules document what they refuse to do in the
 * same vocabulary the detectors use), every list carries a vacuity floor, and
 * every detector is mutation-tested against a seeded positive AND a seeded
 * negative THROUGH THE SAME FUNCTION the real scan calls — a self-test fed
 * literals the production path never sees is a control on the wrong instrument.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The two directories that ARE the domain, scanned whole. */
const DOMAIN_DIRS = [
  join(SRC_ROOT, 'services', 'product-types'),
  join(SRC_ROOT, 'db', 'productTypes'),
];

/** The schema module, checked separately for columns it may not declare. */
const SCHEMA_FILE = join(SRC_ROOT, 'db', 'schema', 'productTypes.ts');

/** Every non-test `.ts` file under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      files.push(...sourceFiles(path));
    } else if (entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

const DOMAIN_FILES = DOMAIN_DIRS.flatMap(sourceFiles);

/**
 * Source with comments stripped.
 *
 * Every module in this domain explains what it refuses to do using exactly the
 * words the detectors match — `visibility-rule.ts` says in its header that it
 * contains no `eval` and no `new Function`, and `variant-axis.ts` explains that
 * a price is not a variant axis. A scan over raw text would fail on the prose
 * that proves the rule is understood. The `checkout-contact-isolation.test.ts`
 * decision, reused.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** What reaching money, stock or ranking looks like, from any direction. */
const COMMERCE_REFERENCE =
  /services\/payments\/|services\/ranking\/|db\/payments\/|db\/ranking\/|ledgerRepository|inventoryRepository|adjustInventory|reserveInventory|paymentService|rankOffers|evaluateOfferEligibility|ledger_entries|inventory_levels/;

/** Any way to turn stored text into running code. */
const CODE_EXECUTION =
  /\beval\s*\(|new\s+Function\s*\(|node:vm\b|require\(['"]vm['"]\)|child_process|\bhandlebars\b|\bliquidjs\b|\bnunjucks\b|\bejs\b|Function\s*\(\s*['"`]/;

/** Any way to leave the process. */
const OUTBOUND_CALL = /\bfetch\s*\(|safeFetch|axios|node:https?\b|\bundici\b|new\s+WebSocket\b/;

/** Any way to read a lever. This domain has none, and must not grow one quietly. */
const CONFIG_REFERENCE = /from\s+'[^']*\/config[^']*'|process\.env\b/;

/** The detector, run over one file exactly as the real scan runs it. */
function detects(pattern: RegExp, source: string): boolean {
  return pattern.test(stripComments(source));
}

/**
 * Column-shaped spellings the schema may not declare, because #94 already does.
 *
 * Matched against the drizzle property names, which are camelCase, and the raw
 * SQL-ish spellings a hand-written CHECK might use.
 */
const REGISTRY_RESTATEMENTS = [
  'valueType',
  'value_type',
  'unitFamily',
  'unit_family',
  'baseUnit',
  'base_unit',
  'minValue',
  'maxValue',
  'decimalPlaces',
  'maxLength',
  'ratingScaleMax',
  'allowedValues',
  'enumValues',
  'cardinality',
  'componentAxes',
];

describe('the product-type domain scans a real, non-trivial file set', () => {
  it('has files to scan and none of them is a stub', () => {
    // The vacuity floor, in both dimensions: a moved directory or an emptied
    // module must fail HERE, not pass every assertion below by having nothing to
    // match. Six is the shipped count minus room for one refactor.
    expect(DOMAIN_FILES.length).toBeGreaterThanOrEqual(5);
    expect(sourceFiles(DOMAIN_DIRS[0]).length).toBeGreaterThanOrEqual(3);
    expect(sourceFiles(DOMAIN_DIRS[1]).length).toBeGreaterThanOrEqual(2);
    for (const file of DOMAIN_FILES) {
      expect(readFileSync(file, 'utf8').length, `${relative(SRC_ROOT, file)} looks empty`).toBeGreaterThan(400);
    }
    expect(statSync(SCHEMA_FILE).size).toBeGreaterThan(4_000);
  });
});

describe('a product type cannot reach money, stock or ranking', () => {
  it('no module in the domain references the payment, inventory or ranking domains', () => {
    const offenders: string[] = [];
    for (const file of DOMAIN_FILES) {
      if (detects(COMMERCE_REFERENCE, readFileSync(file, 'utf8'))) {
        offenders.push(relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the schema module declares no listing, offer, inventory or price column', () => {
    const source = stripComments(readFileSync(SCHEMA_FILE, 'utf8'));
    for (const shape of [
      'priceAmount',
      'price_amount',
      'stockLevel',
      'stock_level',
      'availableQuantity',
      'inventoryLevel',
      'listingId',
      'offerId',
      'variantId',
      'rankingWeight',
      'boost',
    ]) {
      expect(source.includes(shape), `productTypes.ts declares ${shape}`).toBe(false);
    }
  });

  it('the commerce detector actually detects — the mutation self-test', () => {
    // Through `detects`, which is the function the scan above calls: a self-test
    // that matched a literal directly would be a control on a different
    // instrument from the one under test.
    expect(detects(COMMERCE_REFERENCE, "import { postLedger } from '../payments/ledgerRepository.js';")).toBe(true);
    expect(detects(COMMERCE_REFERENCE, "import { rankOffers } from '../ranking/ranking.js';")).toBe(true);
    expect(detects(COMMERCE_REFERENCE, 'const rows = await db.select().from(inventory_levels);')).toBe(true);
    expect(detects(COMMERCE_REFERENCE, "import { getDb } from '../../db/postgres.js';")).toBe(false);
    // And it is blind to a comment, which is what makes the real scan's silence
    // mean something: every module here NAMES these domains while explaining
    // that it does not reach them.
    expect(detects(COMMERCE_REFERENCE, '// never imports services/payments/ anything')).toBe(false);
  });
});

describe('the visibility-rule interpreter cannot execute anything', () => {
  it('no module in the domain contains a code-execution primitive', () => {
    const offenders: string[] = [];
    for (const file of DOMAIN_FILES) {
      if (detects(CODE_EXECUTION, readFileSync(file, 'utf8'))) {
        offenders.push(relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the execution detector actually detects — the mutation self-test', () => {
    expect(detects(CODE_EXECUTION, 'const answer = eval(rule.expression);')).toBe(true);
    expect(detects(CODE_EXECUTION, 'const fn = new Function("draft", rule.body);')).toBe(true);
    expect(detects(CODE_EXECUTION, "import vm from 'node:vm';")).toBe(true);
    expect(detects(CODE_EXECUTION, "import { compile } from 'handlebars';")).toBe(true);
    expect(detects(CODE_EXECUTION, 'const outcome = evaluateNode(rule, values, trace);')).toBe(false);
  });

  it('no module in the domain builds a RegExp from anything but a literal', () => {
    // A row-supplied pattern is the DoS primitive D5 names. The two literal
    // patterns this domain owns (`PRODUCT_TYPE_ATTRIBUTE_KEY_PATTERN` and the
    // product-type key shape) live in shared-types and are constants; nothing
    // here may construct one.
    const offenders: string[] = [];
    for (const file of DOMAIN_FILES) {
      if (/new\s+RegExp\s*\(/.test(stripComments(readFileSync(file, 'utf8')))) {
        offenders.push(relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
    expect(/new\s+RegExp\s*\(/.test(stripComments('const re = new RegExp(row.pattern);'))).toBe(true);
  });
});

describe('a product-type field restates nothing about the attribute it cites', () => {
  it('the schema module declares no value type, unit family, bound or precision', () => {
    const source = stripComments(readFileSync(SCHEMA_FILE, 'utf8'));
    for (const shape of REGISTRY_RESTATEMENTS) {
      expect(source.includes(shape), `productTypes.ts declares ${shape}, which #94 owns`).toBe(
        false,
      );
    }
    // The positive control: the file DOES cite the registry, so a scan that
    // found nothing because it read the wrong file fails here.
    expect(source.includes('attributeDefinitionId')).toBe(true);
    expect(source.includes('attributeDefinitionVersion')).toBe(true);
  });

  it('the restatement list is not vacuous', () => {
    // A seeded column of each forbidden spelling is detected by the same
    // `includes` the assertion above uses.
    for (const shape of REGISTRY_RESTATEMENTS) {
      expect(stripComments(`export const t = { ${shape}: text() };`).includes(shape)).toBe(true);
    }
    expect(REGISTRY_RESTATEMENTS.length).toBeGreaterThanOrEqual(15);
  });
});

describe('the domain makes no outbound call and reads no lever', () => {
  it('nothing here fetches, and nothing here reads configuration', () => {
    const fetchers: string[] = [];
    const readers: string[] = [];
    for (const file of DOMAIN_FILES) {
      const source = readFileSync(file, 'utf8');
      if (detects(OUTBOUND_CALL, source)) fetchers.push(relative(SRC_ROOT, file));
      if (detects(CONFIG_REFERENCE, source)) readers.push(relative(SRC_ROOT, file));
    }
    expect(fetchers).toEqual([]);
    expect(readers).toEqual([]);
  });

  it('both detectors actually detect — the mutation self-test', () => {
    expect(detects(OUTBOUND_CALL, 'const res = await fetch(url);')).toBe(true);
    expect(detects(OUTBOUND_CALL, "import { safeFetch } from '@oxyhq/core/server';")).toBe(true);
    expect(detects(OUTBOUND_CALL, 'const rows = await listProductTypeFields(db, id, flow);')).toBe(
      false,
    );
    expect(detects(CONFIG_REFERENCE, "import { config } from '../../config/index.js';")).toBe(true);
    expect(detects(CONFIG_REFERENCE, 'const ttl = process.env.PRODUCT_TYPE_TTL;')).toBe(true);
    expect(detects(CONFIG_REFERENCE, "import { eq } from 'drizzle-orm';")).toBe(false);
  });
});
