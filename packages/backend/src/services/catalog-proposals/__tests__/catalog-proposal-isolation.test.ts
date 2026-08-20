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
import { assertEachOf } from '../../../__tests__/assert-each-of.js';
import {
  dispositionKey,
  forbiddenSymbolsReachableFrom,
} from '../../../__tests__/import-closure.js';

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
// #723: the loop below is its only reader, so emptying this list makes it a no-op and
// nothing goes red. The floor is today's count: an addition passes it freely, while a
// REMOVAL has to move this number in the same diff.
expect(
  COMMERCIAL_PATTERNS.length,
  'COMMERCIAL_PATTERNS shrank without this floor moving — the assertion below now defends less than it did',
).toBeGreaterThanOrEqual(9);

/**
 * Every catalogue WRITE this domain could reach, and the one module that may.
 *
 * `insertAttributeEnumValue` and `insertAttributeValueAlias` are the two the
 * approval performs; everything else names a writer of a table whose creation
 * belongs to the surface that owns it (`CATALOG_PROPOSAL_LINK_ONLY_TYPES`).
 */
const PERMITTED_CATALOGUE_WRITE_PATTERNS: readonly RegExp[] = [
  /\binsertAttributeEnumValue\b/,
  /\binsertAttributeValueAlias\b/,
];

/**
 * The seven link-only types' mints, in ONE place.
 *
 * Read by the module-text wall below AND by the transitive-reach wall at the foot
 * of this file. Two lists would be two answers to "what may an approval never
 * create", and the one that drifts is always the one nobody is looking at.
 */
const LINK_ONLY_MINT_PATTERNS: readonly RegExp[] = [
  /\bcreateBrand\b/,
  /\bcreateCanonicalProduct\b/,
  /\bcreateProductFamily\b/,
  /\binsertProductTypeDefinition\b/,
  /\binsertAttributeDefinition\b/,
  /\binsert\(categories\)/,
];

const CATALOGUE_WRITE_PATTERNS: readonly RegExp[] = [
  ...PERMITTED_CATALOGUE_WRITE_PATTERNS,
  ...LINK_ONLY_MINT_PATTERNS,
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
    assertEachOf(LINK_ONLY_MINT_PATTERNS, 6, (forbidden) => {
      expect(
        violations(source, [forbidden]),
        `${CATALOGUE_WRITER} mints an entity a link-only type owns`,
      ).toEqual([]);
    });
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
// #723: the loop below is its only reader, so emptying this list makes it a no-op and
// nothing goes red. The floor is today's count: an addition passes it freely, while a
// REMOVAL has to move this number in the same diff.
expect(
  LEVER_PATTERNS.length,
  'LEVER_PATTERNS shrank without this floor moving — the assertion below now defends less than it did',
).toBeGreaterThanOrEqual(1);

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
      expectedExclusions: 0,
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

/**
 * The catalogue-write wall, applied to what the writer can REACH (#568).
 *
 * The wall above reads `review.service.ts`'s own text. That answers "does this
 * file contain the word", when what it means to answer is "can this module cause
 * the write" — and the two came apart the first time somebody needed the second.
 * An implementation of #568 called `draftAttributeDefinition`, which calls
 * `insertAttributeDefinition` internally; the module minted an
 * `attribute_definitions` row transitively and the name-keyed scan saw nothing.
 * The gate went green on a real violation, which is worse than no gate.
 *
 * ## Why this needs DISPOSITIONS and the wall above does not
 *
 * Because the correct fix puts a legitimate mint inside the closure. #568's value
 * cannot be written to a published attribute at all — `mercaria_attribute_enum_frozen`
 * refuses it — so the approval asks the registry to draft version N+1, and
 * drafting a version inserts a definition row. Forbidding the reach outright would
 * forbid the only implementation there is.
 *
 * So the population is DERIVED (walk the import graph, find every reachable
 * forbidden symbol) and each reachable one must be DISPOSITIONED with a reason.
 * That is `merge-plan-census.test.ts`'s device: a new path fails the build until
 * somebody decides what it means, and omission cannot pass. It is deliberately not
 * an allow-list of module names — the key carries the SYMBOL that is reached, so
 * excusing one seam excuses nothing else, and the map is asserted to be EXHAUSTED
 * as well as sufficient, because a disposition that no longer matches anything is
 * a sentence about code that has moved.
 *
 * ## Bounds, stated rather than implied
 *
 * The walk follows named value imports along relative specifiers. A dynamic
 * `import()`, a symbol reached through an object property and anything behind a
 * package boundary are invisible to it. It raises the cost of an accidental
 * wrapper; it is not a sandbox, and the module-text wall above is not replaced by
 * it. The remaining evasions are recorded on the gate-evadability issue rather
 * than left for a reader to discover.
 */
const PERMITTED_TRANSITIVE_MINTS: Readonly<Record<string, string>> = Object.freeze({
  'services/attributes/value-extension.service.ts#addControlledValueToAttribute -> \\binsertAttributeDefinition\\b':
    'The registry drafting version N+1 of an attribute an operator already published (#568). ' +
    'A published version is immutable, so this is the ONLY way an approved controlled value ' +
    'can be stored at all. It mints no identity and invents no key: the seam takes an existing ' +
    "definition's id, reads the key off the stored row, and has no parameter that could name a " +
    'new attribute — asserted below, so this reason is measured rather than promised.',
});

/**
 * The COUNT, pinned — because a disposition census is satisfied by disposing of
 * everything.
 *
 * The two assertions below ask that each finding have a reason and that each
 * reason still match something. Neither notices a SECOND seam being
 * dispositioned: the author writes a sentence, both assertions pass, and the
 * diff is green. An entry appearing here is exactly the moment somebody should
 * look at it, so the number is what makes them — a new disposition cannot land
 * without moving a literal a reviewer can see.
 *
 * This is the shape a column carry-forward census in this repo was missing: a
 * positive assertion BESIDE the census, rather than the census alone.
 */
const EXPECTED_DISPOSITION_COUNT = 1;

describe('the catalogue-write wall survives a one-hop wrapper (#568)', () => {
  it('disposes of exactly the paths somebody has reviewed, and no more', () => {
    expect(
      Object.keys(PERMITTED_TRANSITIVE_MINTS),
      'a transitive mint was dispositioned or removed — move this number deliberately',
    ).toHaveLength(EXPECTED_DISPOSITION_COUNT);
  });

  const closure = (): ReturnType<typeof forbiddenSymbolsReachableFrom> =>
    forbiddenSymbolsReachableFrom({
      srcRoot: SRC_ROOT,
      entry: CATALOGUE_WRITER,
      // The SAME six the module-text wall forbids, and read from one place so the
      // two cannot drift into forbidding different things.
      forbidden: LINK_ONLY_MINT_PATTERNS,
    });

  it('every forbidden symbol the writer can REACH is dispositioned', () => {
    const result = closure();

    // Vacuity floors first, and soft so a failure below is still reported.
    // A walk that resolved nothing finds nothing and reads exactly like a clean
    // wall; `unresolvedBodies` is the discriminator, and the body count is the
    // positive control that the walk went somewhere at all.
    expect.soft(result.unresolvedBodies, 'the walk failed to resolve a declaration').toBe(0);
    expect
      .soft(result.bodiesScanned, 'the import walk reached too few bodies to be real')
      .toBeGreaterThanOrEqual(40);

    const undispositioned = result.findings.filter(
      (finding) => PERMITTED_TRANSITIVE_MINTS[dispositionKey(finding)] === undefined,
    );
    expect(
      undispositioned.map((finding) => `${dispositionKey(finding)}  via  ${finding.path.join(' -> ')}`),
      `${CATALOGUE_WRITER} reaches a link-only mint through an undispositioned path`,
    ).toEqual([]);
  });

  it('and every disposition still matches something — a stale one is not a wall', () => {
    // The other half of the census. Without it a disposition survives the code it
    // excused being deleted or renamed, and the next reader treats a sentence
    // about a path that no longer exists as evidence the path is safe.
    const reached = new Set(closure().findings.map(dispositionKey));
    for (const key of Object.keys(PERMITTED_TRANSITIVE_MINTS)) {
      expect(reached.has(key), `${key} is dispositioned but no longer reachable`).toBe(true);
    }
  });

  it('every disposition states a REASON, not a shrug', () => {
    for (const [key, reason] of Object.entries(PERMITTED_TRANSITIVE_MINTS)) {
      expect.soft(reason.trim().length, `${key} has no reason`).toBeGreaterThan(80);
    }
  });

  it('the permitted seam cannot NAME an attribute — the disposition, measured', () => {
    // What makes drafting version N+1 different from minting an attribute is that
    // the seam has no parameter that could carry a key. Asserted here rather than
    // taken on the disposition's word: the reason above is only true while this is.
    const source = readFileSync(
      join(SRC_ROOT, 'services', 'attributes', 'value-extension.service.ts'),
      'utf8',
    );
    const stripped = stripComments(source);
    const start = stripped.indexOf('export async function addControlledValueToAttribute');
    expect(start, 'the seam is gone or renamed').toBeGreaterThan(-1);
    const signature = stripped.slice(start, stripped.indexOf(')', stripped.indexOf('{', start)) + 1);
    const parameters = signature.slice(signature.indexOf('('), signature.indexOf(')') + 1);
    expect.soft(parameters.length, 'the signature slice looks too short to be real').toBeGreaterThan(40);
    // POSITIVE CONTROL: it DOES take the existing definition's id.
    expect(/existingDefinitionId\s*:\s*string/.test(parameters)).toBe(true);
    // And nothing in it can name a new attribute.
    expect(/\bkey\s*:/.test(parameters), 'the seam takes a key').toBe(false);
    expect(/\battributeKey\s*:/.test(parameters), 'the seam takes an attribute key').toBe(false);
  });

  it('MUTATION SELF-TEST: a one-hop wrapper is caught, through the real walker', () => {
    // A crafted module graph fed to the SAME function the real scan calls. This is
    // the shape that defeated the module-text wall: the guarded module names only
    // the wrapper, and the wrapper names the forbidden symbol.
    const files: Record<string, string> = {
      '/src/entry.ts': "import { draftForMe } from './wrapper.js';\nexport async function go() { return draftForMe(); }\n",
      '/src/wrapper.ts':
        "import { insertAttributeDefinition } from './repo.js';\nexport async function draftForMe() { return insertAttributeDefinition(); }\n",
      '/src/repo.ts': 'export async function insertAttributeDefinition() { return 1; }\n',
    };
    const crafted = (entry: string): ReturnType<typeof forbiddenSymbolsReachableFrom> =>
      forbiddenSymbolsReachableFrom({
        srcRoot: '/src',
        entry,
        forbidden: [/\binsertAttributeDefinition\b/],
        readFile: (path) => files[path] ?? '',
        fileExists: (path) => files[path] !== undefined,
      });

    const caught = crafted('entry.ts');
    expect.soft(caught.unresolvedBodies).toBe(0);
    expect.soft(caught.bodiesScanned).toBeGreaterThanOrEqual(2);
    // It must red, and it must red NAMING THE WRAPPER — a gate that fires without
    // saying which hop is at fault sends the next reader to the wrong module.
    expect(caught.findings.map((finding) => finding.firstHop)).toContain('wrapper.ts#draftForMe');
    expect(caught.findings.length).toBeGreaterThan(0);

    // NEGATIVE CONTROL: the same graph with the wrapper calling something else.
    // Without this, a detector that fires on every input would pass the assertion
    // above and measure nothing.
    files['/src/wrapper.ts'] =
      "import { listAttributeEnumValues } from './repo.js';\nexport async function draftForMe() { return listAttributeEnumValues(); }\n";
    files['/src/repo.ts'] = 'export async function listAttributeEnumValues() { return []; }\n';
    const clean = crafted('entry.ts');
    expect.soft(clean.unresolvedBodies, 'the clean walk resolved nothing, so it proves nothing').toBe(0);
    expect.soft(clean.bodiesScanned).toBeGreaterThanOrEqual(2);
    expect(clean.findings).toEqual([]);
  });

  it('MUTATION SELF-TEST: a comment naming the symbol does not fire', () => {
    const files: Record<string, string> = {
      '/src/entry.ts': "import { seam } from './wrapper.js';\nexport async function go() { return seam(); }\n",
      '/src/wrapper.ts':
        '// insertAttributeDefinition is exactly what this must never call.\nexport async function seam() { return 1; }\n',
    };
    const result = forbiddenSymbolsReachableFrom({
      srcRoot: '/src',
      entry: 'entry.ts',
      forbidden: [/\binsertAttributeDefinition\b/],
      readFile: (path) => files[path] ?? '',
      fileExists: (path) => files[path] !== undefined,
    });
    expect.soft(result.bodiesScanned).toBeGreaterThanOrEqual(1);
    expect(result.findings).toEqual([]);
  });
});
