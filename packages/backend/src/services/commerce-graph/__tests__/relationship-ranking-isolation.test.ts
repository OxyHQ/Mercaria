/**
 * Issue #55, product behaviour 5: the ranking service may expose verification as
 * a TRANSPARENT TRUST ATTRIBUTE, and may never turn it into a hidden paid boost.
 *
 * The mirror of `services/fees/__tests__/fee-ranking-isolation.test.ts`, and the
 * distinction it draws is the whole design of this file. Fees are asserted
 * structurally, by a wall: no ranking module may reach the fee domain at all.
 * Verification cannot be walled off that way — a brand page legitimately ranks
 * official channels first, and a product page legitimately shows a badge — so
 * the gate has to be about what verification can be BOUGHT with, not about
 * whether ranking can see it.
 *
 * Three separate claims, each with its own mechanism:
 *
 *  1. A relationship carries no commercial field at all — no fee, plan, spend or
 *     tier column exists for a boost to be priced in.
 *  2. The relationship domain never imports the fee, payment or referral
 *     domains, so a rank cannot be conditioned on what a merchant paid.
 *  3. No feed, search or catalogue-read module reaches the relationship domain
 *     TODAY, which is what makes any future use of it a visible, reviewable
 *     change rather than a silent one.
 *
 * Scanner defences follow the metro gate: a vacuity floor on every scanned file
 * and a mutation self-test on every detector.
 */

import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DirectoryReader,
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
} from '../../../__tests__/domain-population.js';
import { commerceRelationships } from '../../../db/schema/relationships.js';
import {
  RANKING_SURFACE_PATHS,
  assertRankingSurfaceIsWhole,
  readRankingSurfaceFile,
} from '../../../__tests__/ranking-surface.js';
import { assertEachOf } from '../../../__tests__/assert-each-of.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The relationship domain's own modules — the source side of claim 2, DERIVED.
 *
 * `services/commerce-graph/` holds three sub-domains (merchants, storefronts,
 * native-store links) and only one of them is this gate's subject, so the
 * population cannot be the directory. It is the directory NARROWED BY NAME,
 * which is a derivation rather than a list: every module of this domain is
 * called `relationship*`, in all three places one can live.
 *
 * It was a six-entry hand list until #460. That list was COMPLETE — the
 * derivation reproduces exactly the six it named, no more and no less — which is
 * precisely why a floor could not defend it. A hand list is only ever blind in
 * ONE direction, and it is the direction nothing else covers: a module ADDED to
 * the domain tomorrow. Measured before this change: a new
 * `services/commerce-graph/relationship-badge.ts` importing `rankOffers` — the
 * exact thing this gate forbids — left the suite at 8 passed.
 * {@link relationshipModules} closes that, and the added-module probe below is
 * kept as a permanent test rather than a note saying it was run once.
 */
const RELATIONSHIP_OWNED_DIRECTORIES = ['services/commerce-graph', 'db/commerce-graph'] as const;

/**
 * The flat directories a module of this sub-domain lives in under a domain NAME.
 *
 * `db/schema` was here and the three HTTP directories were NOT, so FOUR modules
 * were behind none of the walls below (#460): `routes/brand-relationships.ts`,
 * `controllers/brand-relationships.controller.ts`,
 * `controllers/relationships-operator.controller.ts` and
 * `middleware/relationship-schemas.ts` — the public badge read and the whole
 * `/internal/commerce-graph/relationships*` operator surface. The operator
 * controller is the module in this domain with the most reach: it approves,
 * revokes and reviews the very claims a badge is derived from.
 *
 * Verified before adding: none of the four matches `COMMERCIAL_COLUMN` in
 * comment-stripped code, so this is a widening of coverage rather than a new
 * false wall.
 */
const RELATIONSHIP_SHARED_DIRECTORIES = [
  'routes',
  'controllers',
  'middleware',
  'db/schema',
] as const;

const RELATIONSHIP_DIRECTORIES = [
  ...RELATIONSHIP_OWNED_DIRECTORIES,
  ...RELATIONSHIP_SHARED_DIRECTORIES,
] as const;

/** What a module of THIS sub-domain is called, wherever it lives. */
const RELATIONSHIP_NAME_PATTERN = /relationship/i;

/**
 * MEASURED on this branch: 4 + 1 + 1. A floor rather than an exact count,
 * because the derivation exists so a new module is covered the moment it is
 * written — an exact count would fail the build on exactly that legitimate case
 * and make "bump the number" the cheapest green.
 */
const MINIMUM_RELATIONSHIP_MODULES = 6;

function relationshipRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  // EVERY directory is narrowed by NAME here, including the two this gate calls
  // its own — and that is a real difference from the other gates converted
  // under #460, where the owned directory is walked WHOLE.
  //
  // `services/commerce-graph/` hosts SEVERAL sub-domains: `merchant.service.ts`,
  // `storefront.service.ts` and the relationship modules share it. Walking it
  // whole was tried and the gate's own "is a different sub-domain" assertion
  // caught it immediately, which is the assertion doing its job. So the
  // narrowing stays, and what #460 adds here is the three HTTP directories
  // rather than a change of shape.
  return namedInSharedDirectories(RELATIONSHIP_DIRECTORIES, RELATIONSHIP_NAME_PATTERN, readDir);
}

function relationshipModules(): string[] {
  return relationshipRelativePaths()
      .sort()
      .map((entry) => {
        const relative = entry;
        // A derived population is only as honest as the assertion that every
        // member resolves; a stale `readdirSync` would otherwise hand the scan
        // names that no longer exist, which reads as a clean run.
        expect(
          statSync(join(SRC_ROOT, relative)).isFile(),
          `${relative} is not a file — did it move?`,
        ).toBe(true);
        return relative;
      });
}


/**
 * Reaching anything that could price a boost, from any direction. Matched on the
 * bare `<domain>/` path segment rather than `services/<domain>/`, because an
 * import from a sibling directory is written `../fees/…` and would slip past the
 * longer form — the mutation self-test below is what caught that.
 */
const COMMERCIAL_REFERENCE =
  /\bfees\/|\bpayments\/|\breferrals\/|feeSchedule|orderFeeSnapshot|fee_schedules|order_fee_snapshots|marketplaceFee|ledgerRepository|referral_programs/;

/**
 * The discovery modules permitted to read a verification, each named here rather
 * than the pattern being loosened — and the count asserted EXACTLY below.
 *
 * `services/ranking/facts.ts` (#74) gathers the comparison's facts once and
 * hands them to a PURE scorer, so the verification is read in one place, at one
 * moment, through the public finder — every other module in the ranking domain
 * sees only `OfferRankingFacts.relationship`, a three-valued standing with no
 * id, no evidence and no review state attached.
 *
 * `services/search/offer-context.ts` (#70) does the same job for a search page:
 * one `findCurrentRelationships` read for the whole page, feeding the official
 * and authorized-reseller LABELS #74 defines.
 *
 * **The second one was found by widening this gate's scan population, and it had
 * been there since #70 shipped (#460).** The docblock above said "exactly one
 * module may read it … and the other twelve discovery modules still may not",
 * and it was measured over a fifteen-path hand list that contained no module of
 * `services/search/` at all. So the gate asserted a count of one over a
 * population that excluded the second reader. Nothing was wrong with the READ —
 * it goes through the same read repository, for the same reason, and #74's
 * labels depend on it — but a gate claiming "exactly one" while unable to see
 * the second is worse than no count, because it is read as evidence.
 *
 * The property this gate exists to protect is unchanged and is enforced below:
 * a seam may reach the domain ONLY through `relationshipRepository`, never a
 * write or resolution service, so no discovery module can change what it then
 * ranks on. What the exact count buys is that a THIRD reader is a decision
 * somebody makes in a diff rather than one that arrives unnoticed.
 */
const RANKING_RELATIONSHIP_SEAMS = [
  'services/ranking/facts.ts',
  'services/search/offer-context.ts',
] as const;

/**
 * Comments stripped, the sibling gates' implementation verbatim
 * (`retail-eligibility`, `price-history`, `price-alert`): block comments
 * wholesale and full-line `//` comments.
 *
 * A TRAILING `//` comment on a code line survives, deliberately — stripping one
 * means deciding whether a `//` is a comment or the middle of a URL, and the
 * failure direction of getting that wrong is a scan that silently excuses real
 * code. A trailing comment that names this domain would produce a FALSE RED,
 * which somebody reads and fixes; the alternative produces a false green, which
 * nobody sees. The self-test below pins the boundary either way.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Reaching the relationship domain, from any direction. */
const RELATIONSHIP_REFERENCE =
  /commerce-graph\/relationship|commerceRelationships|commerce_relationships|relationship_evidence|resolveOfficialChannel|listBrandChannels/;

/**
 * Column-name fragments that would let a relationship carry a price. A verified
 * relationship is a factual claim about the world; a column able to hold what it
 * cost is the field a paid boost would live in.
 */
const COMMERCIAL_COLUMN = /fee|price|amount|plan|tier|spend|boost|rank|score|bid|sponsor/i;

describe('verification is a trust attribute, never a purchasable boost', () => {
  it('gives a relationship no column a price could live in', () => {
    const columns = Object.keys(getTableColumns(commerceRelationships));
    // Vacuity floor: a renamed table or a broken import must fail here rather
    // than scan an empty column list and pass.
    expect(columns.length).toBeGreaterThan(25);
    const commercial = columns.filter((name) => COMMERCIAL_COLUMN.test(name));
    expect(commercial, 'a relationship must carry no commercial field').toEqual([]);
  });

  it('the column detector actually detects — the mutation self-test', () => {
    expect(COMMERCIAL_COLUMN.test('boostAmount')).toBe(true);
    expect(COMMERCIAL_COLUMN.test('sponsoredTier')).toBe(true);
    expect(COMMERCIAL_COLUMN.test('rankWeight')).toBe(true);
    expect(COMMERCIAL_COLUMN.test('territories')).toBe(false);
    expect(COMMERCIAL_COLUMN.test('verifiedAt')).toBe(false);
  });

  it('never lets the relationship domain read the fee, payment or referral domains', () => {
    let scanned = 0;
    const modules = relationshipModules();
    // A FLOOR on the derived population, never `toBe(LIST.length)` — comparing a
    // counter against the list the loop just iterated is satisfied by any list
    // including an empty one, so it catches a broken loop and never a shrunk
    // population.
    expect(
      modules.length,
      'the relationship module derivation shrank; a walk that lost a module scans clean',
    ).toBeGreaterThanOrEqual(MINIMUM_RELATIONSHIP_MODULES);
    for (const relative of modules) {
      const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
      expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        COMMERCIAL_REFERENCE.test(source),
        `${relative} reaches a commercial domain; verification must not be priceable`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(modules.length);
  });

  it('the derivation covers what the hand list named, and only this sub-domain', () => {
    // A derivation that replaced a list owes the proof that it still selects
    // everything the list named — anything it stopped selecting silently left
    // the scan.
    const modules = relationshipModules();
    for (const expected of [
      'services/commerce-graph/relationship.service.ts',
      'services/commerce-graph/relationship-authority.ts',
      'services/commerce-graph/relationship-conflicts.ts',
      'services/commerce-graph/relationship-resolution.ts',
      'db/commerce-graph/relationshipRepository.ts',
      'db/schema/relationships.ts',
    ]) {
      expect(modules, `the derivation stopped selecting ${expected}`).toContain(expected);
    }
    // …and does NOT drag in the two sibling sub-domains that share the
    // directory, or this wall would start firing at whoever edits a storefront.
    assertEachOf([
      'services/commerce-graph/merchant.service.ts',
      'services/commerce-graph/storefront.service.ts',
      'services/commerce-graph/native-store-link.service.ts',
    ], 3, (foreign) => {
      expect(modules, `${foreign} is a different sub-domain`).not.toContain(foreign);
    });
    expect(RELATIONSHIP_NAME_PATTERN.test('relationshipRepository.ts')).toBe(true);
    expect(RELATIONSHIP_NAME_PATTERN.test('relationships.ts')).toBe(true);
    expect(RELATIONSHIP_NAME_PATTERN.test('merchant.service.ts')).toBe(false);
  });

  it('a module ADDED to the domain is scanned — the direction a hand list is blind in', () => {
    // The probe that justifies the whole conversion, kept as a test rather than
    // as a claim that one was run once. A hand list that is COMPLETE today
    // passes every floor and every count; the only way it fails is a module
    // nobody adds to it, so that is the case asserted here.
    //
    // Written against the DERIVATION rather than the filesystem: seeding a real
    // file would make this test mutate the tree it shares with every parallel
    // suite. What is under test is that the population is computed from a name
    // rule over a directory, so a name the rule admits is a name the scan gets.
    const admitted = ['relationship-badge.ts', 'relationship-projection.ts', 'relationships.ts'];
    for (const name of admitted) {
      expect(
        RELATIONSHIP_NAME_PATTERN.test(name),
        `a new ${name} would not be scanned; the population is not derived from the name`,
      ).toBe(true);
    }
    // The second spelling of the population that used to live here is GONE.
    //
    // It re-derived the set inline — `RELATIONSHIP_DIRECTORIES.flatMap(readdirSync
    // ...)` — and compared it to `relationshipModules()`. Two spellings of one
    // population is the defect this workstream is about: it broke the moment the
    // real derivation started recursing and matching the PATH, and it broke on
    // ORDER rather than on membership, which reads like a bug in the conversion
    // rather than like a stale copy. Kept in step by hand, it would have gone on
    // agreeing with itself while both drifted.
    //
    // What replaces it is strictly stronger and has no second spelling: the
    // whole-tree wall at the end of this file requires every relationship-named
    // module in `src/` to be in this population or in a counted exclusion. A
    // module admitted by the name rule and missing from the scan is exactly what
    // it reports.
    expect(
      relationshipModules().length,
      'the derivation found almost nothing',
    ).toBeGreaterThanOrEqual(8);
  });

  it('the commercial detector actually detects — the mutation self-test', () => {
    expect(
      COMMERCIAL_REFERENCE.test("import { planFee } from '../fees/order-fees.service.js';"),
    ).toBe(true);
    expect(COMMERCIAL_REFERENCE.test('select * from order_fee_snapshots')).toBe(true);
    expect(
      COMMERCIAL_REFERENCE.test("import { getDb } from '../../db/postgres.js';"),
    ).toBe(false);
  });

  it('lets ranking read a verification through ONE named seam, and nowhere else', () => {
    // This gate said in as many words that it was "not a permanent wall — a
    // brand page ordering official channels first is legitimate and arrives with
    // #72/#74", and that what it held was that the first ranking module to read
    // a verification would do so in a diff that changes this list.
    //
    // #74 IS that diff. Ranking input 9 makes a verified direct-channel or
    // authorized-reseller relationship a visible TRUST ATTRIBUTE, so the wall
    // becomes a seam: exactly one module may read it, it reads the public
    // finder and nothing else, and the other twelve discovery modules still may
    // not — which keeps the property this gate was protecting (a use of
    // verification is visible in a diff) while permitting the use the issue
    // asked for.
    let scanned = 0;
    assertRankingSurfaceIsWhole();

    // EXACT, not a floor. This is the number the docblock above claims, and a
    // claim of "exactly N" measured without a count is how the second seam sat
    // unrecorded (#460).
    expect(RANKING_RELATIONSHIP_SEAMS.length).toBe(2);

    for (const relative of RANKING_SURFACE_PATHS) {
      const source = readRankingSurfaceFile(relative);

      // `.some` rather than `.includes`: the tuple is `as const`, so `includes`
      // narrows its parameter to the two literals and rejects an arbitrary
      // path — the compiler refusing the very question this line asks.
      if (RANKING_RELATIONSHIP_SEAMS.some((seam) => seam === relative)) {
        // A seam may reach the domain — but only through the READ repository. A
        // write service or the resolution service reaching it here would be a
        // discovery module able to CHANGE what it then ranks on.
        for (const line of source.split('\n')) {
          if (!RELATIONSHIP_REFERENCE.test(line)) continue;
          if (!line.includes('import') && !line.includes('from ')) continue;
          expect(
            line.includes('db/commerce-graph/relationshipRepository.js'),
            `${relative} reaches the relationship domain outside the read seam: ${line.trim()}`,
          ).toBe(true);
        }
        scanned += 1;
        continue;
      }

      // Comments are stripped, and only here. A module explaining in prose that
      // brand ownership is a `commerce_relationships` claim has taken on no
      // dependency — `db/search/searchCandidateRepository.ts` says exactly that
      // in a docblock about a column it deliberately does NOT carry. An IMPORT
      // is the thing this wall is about, and the mutation self-test below pins
      // both directions so the stripper cannot quietly excuse a real one.
      expect(
        RELATIONSHIP_REFERENCE.test(stripComments(source)),
        `${relative} reads the relationship domain; add it to this gate deliberately`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(RANKING_SURFACE_PATHS.length);
  });

  it('every seam is a real file, in the scanned set, that really does read the domain', () => {
    // The vacuity half of the carve-out: an exemption for a file that does NOT
    // reach the domain would silently widen the gate the day somebody moved the
    // read into a different module — the exemption would still be listed, and
    // the new module would be scanned as if it were ordinary.
    for (const relative of RANKING_RELATIONSHIP_SEAMS) {
      // …and it must be a module this gate actually scans. An exemption naming a
      // path outside the population excuses nothing while reading as a decision.
      expect(RANKING_SURFACE_PATHS, `${relative} is exempted but is not scanned`).toContain(
        relative,
      );
      const seam = readRankingSurfaceFile(relative);
      expect(RELATIONSHIP_REFERENCE.test(seam), `${relative} no longer reads the domain`).toBe(true);
      expect(seam).toContain('findCurrentRelationships');
    }
  });

  it('the relationship detector actually detects — the mutation self-test', () => {
    expect(
      RELATIONSHIP_REFERENCE.test(
        "import { resolveOfficialChannel } from '../commerce-graph/relationship-resolution.js';",
      ),
    ).toBe(true);
    expect(RELATIONSHIP_REFERENCE.test('select * from commerce_relationships')).toBe(true);
    expect(RELATIONSHIP_REFERENCE.test("import { getCart } from './cart.service.js';")).toBe(false);
  });

  it('the comment stripper excuses prose and never an import — both directions', () => {
    // The stripper is load-bearing the moment it is applied: one that ate too
    // much would make every non-seam scan above pass vacuously. So it is pinned
    // against the exact shape that made it necessary AND against the shape it
    // must never excuse.
    const prose = [
      '/**',
      ' * ownership is a `commerce_relationships` claim (#55).',
      ' */',
      'export type BrandResultRow = EntityRefRow;',
    ].join('\n');
    expect(RELATIONSHIP_REFERENCE.test(prose)).toBe(true);
    expect(RELATIONSHIP_REFERENCE.test(stripComments(prose))).toBe(false);

    const real =
      "import { findCurrentRelationships } from '../../db/commerce-graph/relationshipRepository.js';";
    expect(RELATIONSHIP_REFERENCE.test(stripComments(real))).toBe(true);

    // A full-line comment is stripped; the code on other lines survives.
    expect(RELATIONSHIP_REFERENCE.test(stripComments('  // commerce_relationships\n'))).toBe(false);
    expect(stripComments('const x = 1;\n// commerce_relationships\n')).toContain('const x = 1;');

    // And the stated boundary: a TRAILING comment is NOT stripped, so it fails
    // LOUD rather than quiet. Pinned so that changing the stripper is a visible
    // decision rather than a silent widening.
    expect(RELATIONSHIP_REFERENCE.test(stripComments('const x = 1; // commerce_relationships'))).toBe(
      true,
    );
  });
});

/**
 * The population's own defence.
 *
 * The DIRECTORY list above is the last hand list in this gate. Sweep the whole
 * of `src/` for paths NAMING this sub-domain and require each to be in the
 * population or in a counted exclusion — which is what replaces the inline
 * reconstruction removed above.
 *
 * The exclusion set is EMPTY because it was MEASURED: `relationship` selects 10
 * modules across the tree and every one is this sub-domain's. Note the sweep
 * would also reach a `relationship`-named module in ANY directory, which is
 * precisely the four HTTP modules this conversion brought in — they had been
 * outside every wall because the directory list named none of their homes.
 */
describe('#460: nothing named for this sub-domain sits outside the scanned population', () => {
  it('every relationship-named module in src/ is inside the population', () => {
    assertNothingOutsideDomainPopulation({
      population: relationshipRelativePaths,
      pattern: RELATIONSHIP_NAME_PATTERN,
      notThisDomain: [],
      // Below today's 10 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 7,
      plantIn: 'lib',
      plantName: 'relationship-cache.ts',
    });
  });

  it('the four HTTP modules the old directory list could not reach are in it', () => {
    // An identity assertion, not a floor: the old population was the two owned
    // directories plus `db/schema`, so a floor set below 10 would be met without
    // any of these four.
    const population = relationshipRelativePaths();
    for (const named of [
      'routes/brand-relationships.ts',
      'controllers/brand-relationships.controller.ts',
      'controllers/relationships-operator.controller.ts',
      'middleware/relationship-schemas.ts',
    ]) {
      expect(population, `${named} is outside the walls again`).toContain(named);
    }
  });
});
