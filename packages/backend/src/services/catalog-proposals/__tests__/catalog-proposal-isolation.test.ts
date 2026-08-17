/**
 * The scanned walls around catalog proposals (#367 step 6, ADR 0007 D9).
 *
 * ADR 0007 D9's binding sentence — **a merchant proposal never becomes globally
 * trusted data by being submitted** — is held by three things, and only the third
 * survives somebody refactoring in good faith:
 *
 * 1. The row shapes (`catalog_proposals_resolution_check` and its siblings).
 * 2. The vocabulary (`CATALOG_PROPOSAL_MINTABLE_TYPES`, one member).
 * 3. **The IMPORT GRAPH**, which is this file. Exactly ONE module in the domain
 *    may write a catalogue table, and it is `review.service.ts` — the operator
 *    decision path. A submission, a duplicate scan, a projection or a backfill
 *    that learned to mint would satisfy every CHECK on the way past.
 *
 * ## Every detector is comment-stripped, floored and mutation-tested
 *
 * These modules DOCUMENT what they refuse to do in the same words a violation
 * would use — `review.service.ts`'s own header says "ranking" and "canonical
 * graph" — so a scan over raw source would go red on the documentation and green
 * on nothing. The stripper runs first.
 *
 * The mutation self-test feeds each detector a crafted source string through
 * `violations()`, the SAME function the real scan calls, rather than testing the
 * regex against a literal. A control that does not take production's code path is
 * how three of eighteen tokens were found inert and green one domain over.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SERVICE_DIR = join(import.meta.dirname, '..');
const REPOSITORY_DIR = join(import.meta.dirname, '..', '..', '..', 'db', 'catalogProposals');

/** Every source file of the domain, tests excluded. */
function domainFiles(): { readonly path: string; readonly name: string }[] {
  const out: { path: string; name: string }[] = [];
  for (const dir of [SERVICE_DIR, REPOSITORY_DIR]) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) continue;
      if (!entry.endsWith('.ts')) continue;
      out.push({ path, name: entry });
    }
  }
  return out;
}

/**
 * Source with comments removed.
 *
 * Block comments first, then line comments, and the line-comment rule requires
 * the `//` to be at the start of a line or preceded by whitespace — so a `://`
 * inside a URL in a string does not swallow the rest of the line and hide a
 * violation after it.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

/** Which of `patterns` appear in `source` once its comments are gone. */
function violations(source: string, patterns: readonly RegExp[]): string[] {
  const stripped = stripComments(source);
  return patterns.filter((pattern) => pattern.test(stripped)).map((pattern) => pattern.source);
}

/**
 * Anything that would make a proposal a COMMERCIAL or RANKING input.
 *
 * A proposal is a request about the catalogue's vocabulary. The moment this
 * domain can read a fee schedule, a ranking policy or a referral attribution,
 * "which merchant's proposals get approved" becomes one join from a plan-weighted
 * ordering — the `fee-ranking-isolation.test.ts` precedent, and #74's own gate in
 * the other direction.
 */
const COMMERCIAL_PATTERNS: readonly RegExp[] = [
  /services\/ranking\//,
  /services\/fees\//,
  /services\/referrals\//,
  /services\/retail-pricing\//,
  /services\/payments\//,
  /\bdb\/schema\/ranking\b/,
  /\bdb\/schema\/fees\b/,
  /\brankOffers?\b/,
  /\bcommissionRevenue\b/,
];

/**
 * Every catalogue WRITE this domain could reach, and the one module that may.
 *
 * `insertAttributeEnumValue` and `insertAttributeValueAlias` are the two the
 * approval performs; everything else names a writer of a table whose creation
 * belongs to the surface that owns it (`CATALOG_PROPOSAL_LINK_ONLY_TYPES`).
 */
const CATALOGUE_WRITE_PATTERNS: readonly RegExp[] = [
  /\binsertAttributeEnumValue\b/,
  /\binsertAttributeValueAlias\b/,
  /\bcreateBrand\b/,
  /\bcreateCanonicalProduct\b/,
  /\bcreateProductFamily\b/,
  /\binsertProductTypeDefinition\b/,
  /\binsertAttributeDefinition\b/,
  /\binsert\(categories\)/,
];

/** The ONE module allowed to hold a catalogue write. */
const CATALOGUE_WRITER = 'review.service.ts';

describe('catalog proposals reach no commercial or ranking domain', () => {
  it('names no fee, ranking, referral, retail-pricing or payment module', () => {
    const files = domainFiles();
    // The vacuity floor. A scan over an empty file list passes every assertion
    // below and reads exactly like a clean one.
    expect(files.length, 'the domain scan found too few files to be real').toBeGreaterThanOrEqual(8);

    for (const file of files) {
      const found = violations(readFileSync(file.path, 'utf8'), COMMERCIAL_PATTERNS);
      expect(found, `${file.name} reaches a commercial domain`).toEqual([]);
    }
  });

  it('POSITIVE CONTROL: the scan reads real content', () => {
    // Without this, every assertion above would also pass on files the reader
    // failed to open, on an empty string, and on a stripper that returned ''.
    const sources = domainFiles().map((file) => stripComments(readFileSync(file.path, 'utf8')));
    const joined = sources.join('\n');
    expect(joined.length).toBeGreaterThan(20_000);
    // Two markers drawn from the POPULATION itself and not from the scan's own
    // output: the domain genuinely reads the authoring SCHEMA (the backfill
    // rewrites a draft answer) and the shared-types vocabulary, so a stripper
    // that ate everything, a reader that opened nothing and a file list built
    // from the wrong directory all fail here.
    expect(/schema\/catalogAuthoring/.test(joined)).toBe(true);
    expect(/@mercaria\/shared-types/.test(joined)).toBe(true);
  });

  it('MUTATION SELF-TEST: every commercial pattern fires through the real path', () => {
    for (const pattern of COMMERCIAL_PATTERNS) {
      // Built from the pattern's own source so the sample cannot drift from what
      // the detector looks for, and fed through `violations()` — the function the
      // real scan calls — rather than tested against the regex directly.
      const sample = `const x = "${pattern.source.replace(/\\b|\\/g, '')}";`;
      expect(
        violations(sample, [pattern]),
        `${pattern.source} does not fire on a source containing it`,
      ).toEqual([pattern.source]);
      // …and it must NOT fire when the same text is only a comment.
      expect(
        violations(`// ${pattern.source.replace(/\\b|\\/g, '')}\n`, [pattern]),
        `${pattern.source} fires on a comment`,
      ).toEqual([]);
    }
  });
});

describe('exactly one module may write a catalogue table', () => {
  it('every other module in the domain holds no catalogue write', () => {
    const files = domainFiles();
    expect(files.length).toBeGreaterThanOrEqual(8);
    let scanned = 0;
    for (const file of files) {
      if (file.name === CATALOGUE_WRITER) continue;
      scanned += 1;
      const found = violations(readFileSync(file.path, 'utf8'), CATALOGUE_WRITE_PATTERNS);
      expect(found, `${file.name} writes a catalogue table`).toEqual([]);
    }
    // A floor on the SCANNED set, not on the file list: renaming the writer would
    // otherwise skip everything and pass.
    expect(scanned, 'no non-writer module was scanned').toBeGreaterThanOrEqual(7);
  });

  it('and the ONE that may genuinely does — otherwise this gate measures nothing', () => {
    // The other half of the census. Without it, deleting the approval's mint and
    // leaving the domain unable to create anything would make every assertion
    // above pass, which is the "green and inert" shape.
    const source = readFileSync(join(SERVICE_DIR, CATALOGUE_WRITER), 'utf8');
    const found = violations(source, CATALOGUE_WRITE_PATTERNS);
    expect(found).toContain('\\binsertAttributeEnumValue\\b');
    expect(found).toContain('\\binsertAttributeValueAlias\\b');
    // …and even the permitted writer may not mint the seven LINK-ONLY types.
    for (const forbidden of [
      /\bcreateBrand\b/,
      /\bcreateCanonicalProduct\b/,
      /\bcreateProductFamily\b/,
      /\binsertProductTypeDefinition\b/,
      /\binsertAttributeDefinition\b/,
      /\binsert\(categories\)/,
    ]) {
      expect(
        violations(source, [forbidden]),
        `${CATALOGUE_WRITER} mints an entity a link-only type owns`,
      ).toEqual([]);
    }
  });
});

describe('nothing in the domain accepts a submitter-supplied identity', () => {
  it('no request schema declares a `key` or a `slug` a merchant could send', () => {
    const schema = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'middleware', 'catalog-proposal-schemas.ts'),
      'utf8',
    );
    const stripped = stripComments(schema);
    // The SUBMISSION schema, sliced by name, so the operator APPROVAL schema's
    // legitimate `key` is not what this reads.
    const from = stripped.indexOf('submitCatalogProposalSchema');
    const to = stripped.indexOf('previewCatalogProposalDuplicatesSchema');
    expect(from, 'could not find the submission schema').toBeGreaterThan(-1);
    expect(to, 'could not find the slice end').toBeGreaterThan(from);
    const submission = stripped.slice(from, to);
    expect(submission.length, 'the submission slice looks too short to be real').toBeGreaterThan(200);
    expect(/\bkey\s*:/.test(submission), 'the submission schema declares a key').toBe(false);
    expect(/\bslug\s*:/.test(submission), 'the submission schema declares a slug').toBe(false);

    // POSITIVE CONTROL for the slice: the OPERATOR approval schema does carry a
    // key, so a slice that captured the wrong region fails here.
    const approvalFrom = stripped.indexOf('approveCatalogProposalSchema');
    expect(approvalFrom).toBeGreaterThan(-1);
    expect(/\bkey\s*:/.test(stripped.slice(approvalFrom, approvalFrom + 400))).toBe(true);
  });
});
