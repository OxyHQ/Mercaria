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
 *
 * ## The population, and what it used to be (#460)
 *
 * `readdirSync` over `services/catalog-proposals` and `db/catalogProposals`,
 * ONE LEVEL DEEP each: eleven modules. SIX of this domain's seventeen were
 * behind none of the three walls — both controllers, both routes,
 * `middleware/catalog-proposal-schemas.ts` and `db/schema/catalogProposals.ts`.
 *
 * Two of those matter more than the count:
 *
 * **`db/schema/catalogProposals.ts`** is where `catalog_proposals_resolution_check`
 * and its siblings — the row shapes named as defence 1 above — are DECLARED. The
 * file holding the first of the three mechanisms was outside the third.
 *
 * **The two routes** make the lever paragraph below enforceable. It claims
 * `routes/internal-catalog-proposals.ts` is deliberately not gated on
 * `config.catalogProposals.enabled`; until #460 that route was outside the scan,
 * so the claim was a sentence rather than an assertion. It is now measured, and
 * the mount lever is read in exactly one place — `app.ts`, outside this domain.
 *
 * All six were measured against all three detector sets on comment-stripped
 * source before being added: zero hits.
 *
 * `CATALOGUE_WRITER` was also TIGHTENED from a bare filename to a full path. A
 * basename excuses every module of that name anywhere in the population, and the
 * population now spans six directories.
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type DirectoryReader,
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
} from '../../../__tests__/domain-population.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * What a module of this domain is called, wherever it lives.
 *
 * The hyphen is optional because `db/catalogProposals/` and
 * `db/schema/catalogProposals.ts` are camelCase, and the plural is optional
 * because `middleware/catalog-proposal-schemas.ts` is singular. Both halves are
 * asserted below rather than assumed.
 */
const PROPOSAL_NAME_PATTERN = /catalog-?proposals?/i;

/** The two directories this domain owns outright. */
const OWNED_DIRECTORIES = ['services/catalog-proposals', 'db/catalogProposals'] as const;

/** The flat directories a module of this domain lives in under a domain NAME. */
const SHARED_DIRECTORIES = ['routes', 'controllers', 'middleware', 'db/schema'] as const;

/** Every module of the catalog-proposal domain, enumerated from disk. */
function domainRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    // RECURSIVE, where this read one directory level.
    ...OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative, readDir)),
    ...namedInSharedDirectories(SHARED_DIRECTORIES, PROPOSAL_NAME_PATTERN, readDir),
  ];
}

/** Every source file of the domain, tests excluded. */
function domainFiles(): { readonly path: string; readonly name: string }[] {
  return domainRelativePaths().map((relative) => ({
    path: join(SRC_ROOT, relative),
    name: relative,
  }));
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

/**
 * The ONE module allowed to hold a catalogue write.
 *
 * A FULL PATH rather than the bare `review.service.ts` it used to be. The
 * population now spans six directories, and a basename excuses every module of
 * that name in any of them — including one somebody adds tomorrow.
 */
const CATALOGUE_WRITER = 'services/catalog-proposals/review.service.ts';

describe('catalog proposals reach no commercial or ranking domain', () => {
  it('names no fee, ranking, referral, retail-pricing or payment module', () => {
    const files = domainFiles();
    // The vacuity floor. A scan over an empty file list passes every assertion
    // below and reads exactly like a clean one.
    expect(files.length, 'the domain scan found too few files to be real').toBeGreaterThanOrEqual(13);

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
    expect(files.length).toBeGreaterThanOrEqual(13);
    let scanned = 0;
    for (const file of files) {
      if (file.name === CATALOGUE_WRITER) continue;
      scanned += 1;
      const found = violations(readFileSync(file.path, 'utf8'), CATALOGUE_WRITE_PATTERNS);
      expect(found, `${file.name} writes a catalogue table`).toEqual([]);
    }
    // A floor on the SCANNED set, not on the file list: renaming the writer would
    // otherwise skip everything and pass.
    expect(scanned, 'no non-writer module was scanned').toBeGreaterThanOrEqual(12);
  });

  it('and the ONE that may genuinely does — otherwise this gate measures nothing', () => {
    // The other half of the census. Without it, deleting the approval's mint and
    // leaving the domain unable to create anything would make every assertion
    // above pass, which is the "green and inert" shape.
    const source = readFileSync(join(SRC_ROOT, CATALOGUE_WRITER), 'utf8');
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
      join(SRC_ROOT, 'middleware', 'catalog-proposal-schemas.ts'),
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

/**
 * ADR 0007 D12: `CATALOG_PROPOSALS_ENABLED` gates the MOUNT and never a stored row.
 *
 * The wall is on the LEVER specifically and NOT on configuration generally, which
 * is the difference between this domain and the facet and navigation ones. These
 * services legitimately read six BOUNDS off the same config object —
 * `pageSize`, `backfillPageSize`, `duplicateNearLimit`, `duplicateNearThreshold`,
 * `maxPerStorePerDay`, `maxPerSubmitterPerHour` — and a blanket "no config" wall
 * here would be refused on its first run, then widened by whoever hit it, and the
 * lever prohibition would go with it. So the pattern names `.enabled`.
 *
 * What it prevents: a service or a repository that read the mount flag could
 * refuse to return, decide or backfill a proposal a merchant already submitted —
 * which is the rollback nobody would pull, and the reason
 * `routes/internal-catalog-proposals.ts` is deliberately not gated on it either.
 */
const LEVER_PATTERNS: readonly RegExp[] = [/config\s*\.\s*catalogProposals\s*\.\s*enabled/];

describe('the rollout lever gates the MOUNT and never a stored row', () => {
  it('no module in the domain reads `config.catalogProposals.enabled`', () => {
    const files = domainFiles();
    expect(files.length, 'the domain scan found too few files to be real').toBeGreaterThanOrEqual(13);
    for (const file of files) {
      const found = violations(readFileSync(file.path, 'utf8'), LEVER_PATTERNS);
      expect(found, `${file.name} reads the rollout lever`).toEqual([]);
    }
  });

  it('POSITIVE CONTROL: the domain DOES read its bounds, so the scan is over real config reads', () => {
    // Without this the wall above would be indistinguishable from one over a
    // domain that touches no configuration at all — and it would keep passing if
    // somebody moved every bound out, which is when a `.enabled` read becomes
    // likely rather than less so.
    const joined = domainFiles()
      .map((file) => stripComments(readFileSync(file.path, 'utf8')))
      .join('\n');
    expect(/config\s*\.\s*catalogProposals\s*\./.test(joined)).toBe(true);
  });

  it('MUTATION SELF-TEST: the lever pattern fires through the real path, and not on a comment', () => {
    for (const pattern of LEVER_PATTERNS) {
      expect(violations('if (config.catalogProposals.enabled) return null;', [pattern])).toEqual([
        pattern.source,
      ]);
      // A bound must NOT trip it — the whole point of naming `.enabled`.
      expect(violations('const n = config.catalogProposals.pageSize;', [pattern])).toEqual([]);
      expect(violations('// config.catalogProposals.enabled\n', [pattern])).toEqual([]);
    }
  });
});

describe('the population the three walls above are applied to (#460)', () => {
  it('nothing naming this domain sits outside it', () => {
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: PROPOSAL_NAME_PATTERN,
      // Deliberately empty, and the assertion is what makes that a measurement:
      // all seventeen modules the whole-tree sweep finds are this domain's.
      notThisDomain: [],
      // Below today's 17 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 13,
      plantIn: 'lib',
      plantName: 'catalog-proposals-cache.ts',
    });
  });

  it('the six modules the one-level population could not reach are in it', () => {
    // An identity assertion, not a floor. A floor set below 17 is met without
    // any of them, which is the shape a sweep floor cannot see either.
    const population = domainRelativePaths();
    for (const named of [
      'controllers/catalog-proposals.controller.ts',
      'controllers/catalog-proposals-operator.controller.ts',
      'db/schema/catalogProposals.ts',
      'middleware/catalog-proposal-schemas.ts',
      'routes/catalog-proposals.ts',
      'routes/internal-catalog-proposals.ts',
    ]) {
      expect(population, `${named} is outside the walls again`).toContain(named);
      expect(
        statSync(join(SRC_ROOT, named)).isFile(),
        `${named} no longer exists, so naming it proves nothing`,
      ).toBe(true);
    }
  });

  it('floors PER SHAPE, because the two sources break independently', () => {
    // One total lets the walk collapse to zero while the sweep carries it.
    const owned = OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative));
    const shared = namedInSharedDirectories(SHARED_DIRECTORIES, PROPOSAL_NAME_PATTERN);
    expect(owned.length, 'the owned-directory walk reached nothing').toBeGreaterThanOrEqual(9);
    expect(shared.length, 'the shared-directory name sweep reached nothing').toBeGreaterThanOrEqual(
      5,
    );
  });

  it('both halves of the NAME pattern are load-bearing', () => {
    // A widening that changes nothing looks exactly like a fix. Each optional
    // character reaches a module the narrow spelling does not, and the narrow
    // spelling is asserted NOT to reach it.
    const camelCase = 'db/schema/catalogProposals.ts';
    const singular = 'middleware/catalog-proposal-schemas.ts';
    expect(PROPOSAL_NAME_PATTERN.test(camelCase)).toBe(true);
    expect(PROPOSAL_NAME_PATTERN.test(singular)).toBe(true);
    expect(/catalog-proposals/.test(camelCase), 'the hyphenated spelling already matched').toBe(
      false,
    );
    expect(/catalog-proposals/.test(singular), 'the plural spelling already matched').toBe(false);
    expect(domainRelativePaths()).toContain(camelCase);
    expect(domainRelativePaths()).toContain(singular);
  });

  it('the permitted writer is excused by PATH, so a same-named module elsewhere is not', () => {
    // The tightening. Under the old bare-filename rule, a
    // `controllers/review.service.ts` — now inside the population — would have
    // been skipped by the catalogue-write scan entirely.
    expect(CATALOGUE_WRITER).toContain('/');
    expect(domainRelativePaths()).toContain(CATALOGUE_WRITER);
    // The skip predicate the wall above uses, applied to a same-named module in
    // one of the five OTHER directories the population now spans. Under the old
    // bare-filename rule this would have been skipped by the catalogue-write
    // scan entirely; under the path rule it is scanned like everything else.
    const skipped = (relative: string): boolean => relative === CATALOGUE_WRITER;
    const shadow = 'controllers/review.service.ts';
    expect(shadow.endsWith('review.service.ts'), 'the shadow is not same-named').toBe(true);
    expect(skipped(shadow), 'a same-named module elsewhere is still scanned').toBe(false);
    expect(skipped(CATALOGUE_WRITER), 'the real writer is no longer skipped').toBe(true);
  });
});
