/**
 * The walls around the compatibility and automotive-fitment domain, as SCANS
 * rather than conventions (#367 step 8, ADR 0007 D8).
 *
 * ## The one that matters
 *
 * D8: **a year range, a make or a model may never be stored as a variant
 * option.** One brake-pad SKU fits a thousand vehicles and stays ONE variant;
 * expressed as options it is a thousand variants, a thousand rows of stock
 * nobody counts and a canonical variant signature that describes a car rather
 * than a part. Two independent walls hold it, in opposite directions:
 *
 * - **No module of this domain can write an option row.** Not by policy — by
 *   the import graph: nothing under `services/compatibility/` or
 *   `db/compatibility/` may name `listing_options`,
 *   `product_variant_option_values`, their drizzle constants, or the two
 *   repositories that write them.
 * - **No option-writing module can reach this domain**, so a vehicle fact
 *   cannot arrive at those tables through the front door either.
 *
 * A third wall is a schema census: the real drizzle columns of both option
 * tables are walked and none may be named for one of
 * `COMPATIBILITY_FORBIDDEN_VARIANT_AXIS_FACTS`. It is deliberately stated as a
 * COLUMN census and nothing more, because the option tables store their axis in
 * a free-text `name`, and no static gate can see a VALUE. The value-level
 * guarantee is the first wall — the domain has no writer — and this one catches
 * the other shape of the same mistake: somebody adding
 * `listing_options.vehicle_generation_id` because it seemed like the tidy place
 * for it.
 *
 * Every detector carries the two defences `~/Oxy/AGENTS.md` requires of a gate:
 * a VACUITY FLOOR (the scanned set must exist and be non-trivial, so a moved or
 * emptied file fails the gate instead of passing it by having nothing to match)
 * and a MUTATION SELF-TEST (each pattern is run against a seeded positive and a
 * seeded negative, so a regex that rotted cannot pass by matching nothing).
 *
 * Reachability detectors scan COMMENT-STRIPPED source — `checkout-contact-isolation.test.ts`'s
 * rule — because these modules document at length what they refuse to do, in
 * exactly the vocabulary the detectors look for.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxyhq/db';
import {
  COMPATIBILITY_APPLICABILITIES,
  COMPATIBILITY_FORBIDDEN_SUBJECT_FACTS,
  COMPATIBILITY_FORBIDDEN_VARIANT_AXIS_FACTS,
  COMPATIBILITY_FORBIDDEN_VERIFICATION_METHODS,
  COMPATIBILITY_FORBIDDEN_VIEW_FIELDS,
  COMPATIBILITY_VERIFICATION_METHODS,
  FITMENT_TARGET_SCOPES,
} from '@mercaria/shared-types';
import { listingOptions, productVariantOptionValues } from '../../../db/schema/catalog.js';
import {
  automotiveFitments,
  compatibilityClaims,
  genericCompatibilityRelations,
  vehicleConfigurations,
  vehicleGenerations,
  vehicleMakes,
  vehicleModels,
} from '../../../db/schema/compatibility.js';
import { projectAutomotiveFitment, projectCompatibilityRelation } from '../projection.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Every `.ts` file under `packages/backend/src`, recursively, tests excluded.
 *
 * RECURSIVE, and over the WHOLE tree. The previous walk did
 * `if (statSync(full).isDirectory()) continue;` — it explicitly SKIPPED
 * subdirectories, which is the shape #472 found hiding
 * `services/ingestion/adapters/`, five provider modules behind no wall at all.
 */
function walkSource(absolute: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const child = join(absolute, entry.name);
    if (entry.isDirectory()) found.push(...walkSource(child));
    else if (entry.name.endsWith('.ts')) found.push(child);
  }
  return found;
}

/**
 * The domain's files, derived by WALKING THE WHOLE TREE and SUBTRACTING a
 * counted exclusion list — never by matching a name or a predicted directory.
 *
 * ## Two earlier versions of this, and why both were wrong
 *
 * **1. A filename pattern.** `/^compatibility.*\.ts$/`, anchored, matched
 * nothing called `routes/internal-compatibility.ts` — the name every one of the
 * thirty-eight sibling operator routers uses — so the natural filename for a
 * compatibility operator surface escaped all five walls in silence.
 *
 * **2. A pattern plus an import test, over four named directories.** Admitting
 * `internal-` and adding "or the file imports the domain" closed the filename
 * hole and left a bigger one: the loop still visited exactly
 * `db/schema`, `routes`, `controllers`, `middleware`. Anything the domain grew
 * ANYWHERE ELSE was invisible. Measured, that was not hypothetical — it was
 * missing five real files, one of them added in the same pull request as the
 * gate: `services/catalog-governance/compatibility-claim.service.ts`, the module
 * that promotes an unresolved claim into a fitment, behind no wall at all. Also
 * `queue.service.ts`, `review.service.ts`, `controllers/catalog-governance.controller.ts`
 * and `scripts/seed-verticals/apply.ts`, which writes the fixture every
 * automotive E2E reads.
 *
 * So the population is now **total minus counted exclusions**. A file joins the
 * domain the moment it names the domain in an import, wherever it lives and
 * whatever it is called; the only way out is an entry in `AGGREGATE_EXCLUSIONS`
 * with a reason, an exact count and its own three-directional probe.
 *
 * `belongsToDomain` is pure over `(relativePath, source)` — the PATH, not the
 * basename, precisely so the self-test can hand it a file in a directory nobody
 * has thought of. That is the only way to prove a population derivation covers
 * what has not been written.
 */
function enumerateDomain(): { derived: string[]; scanned: string[]; walked: number } {
  const all = walkSource(SRC_ROOT);
  const derived = all.filter((absolute) =>
    belongsToDomain(relativeToSrc(absolute), readFileSync(absolute, 'utf8')),
  );
  const excluded = new Set(AGGREGATE_EXCLUSIONS.map((entry) => entry.path));
  return {
    derived,
    scanned: derived.filter((absolute) => !excluded.has(relativeToSrc(absolute))),
    walked: all.length,
  };
}

/**
 * Every module in `db/schema/`, by basename — DERIVED from the directory, never
 * listed, so it cannot go stale as domains are added.
 *
 * Used to measure "names a row per domain" for the two curation exclusions: a
 * file reaching one schema module is coupled to it, and a file reaching several
 * is an aggregate.
 */
const SCHEMA_MODULES: readonly string[] = readdirSync(join(SRC_ROOT, 'db/schema'))
  .filter((entry) => entry.endsWith('.ts') && entry !== 'index.ts')
  .map((entry) => entry.replace(/\.ts$/u, ''));

/** A path relative to `src`, with forward slashes, as the exclusion list spells them. */
function relativeToSrc(absolute: string): string {
  return relative(SRC_ROOT, absolute).split(sep).join('/');
}

/**
 * The five files that reach this domain and belong to NO domain.
 *
 * Each is an AGGREGATE: it names the compatibility tables or router because it
 * names every domain's, by construction. Scanning them would put four hundred
 * unrelated symbols under five walls, and the first one to go red would be red
 * for a legitimate reason — at which point the cheapest green is to weaken the
 * wall. That is the failure an exclusion list exists to prevent, so each entry
 * carries the falsifiable form of its reason and is probed in three directions
 * below: it is still DERIVED (not a stale path), its reason still HOLDS, and the
 * list's size is exact.
 *
 * Nothing else may be added here without the same three probes. `__tests__` is
 * excluded by the walk rather than by this list, and separately asserted.
 */
const AGGREGATE_EXCLUSIONS: readonly {
  readonly path: string;
  readonly reason: string;
}[] = [
  {
    path: 'app.ts',
    reason: 'the composition root: it imports every router there is, so it reaches every domain',
  },
  {
    path: 'db/schema/index.ts',
    reason: 're-export barrel: it names every table in the database and defines none',
  },
  {
    path: 'services/curation/merge-plan.ts',
    reason:
      "#59's rehoming plan, whose census FAILS THE BUILD unless it names every table referencing " +
      'a mergeable entity — so naming other domains is the property it is gated on',
  },
  {
    path: 'db/schema/curation.ts',
    reason:
      '`catalog_merge_conflicts` names the colliding ROW in whichever domain collided — an ' +
      'identifier, a variant, a relationship, an offer, a claim, and since #405 a compatibility ' +
      'relation — so reaching six domains is the shape of the table, not a coupling',
  },
  {
    path: 'services/curation/merge-conflicts.ts',
    reason:
      'the module that applies each merge conflict in ITS OWN domain\'s terms — retired, revoked, ' +
      'retired-offer, closed — so it imports one writer per domain by construction, exactly as ' +
      'the merge plan names one column per domain',
  },
];

/**
 * The measured size of the derived population, asserted by EQUALITY.
 *
 * A file that moves out of the domain shrinks the scanned set silently, and a
 * shrinking scan looks exactly like a clean one. **The next legitimate file
 * fails this line — deliberately.** A floor parked comfortably below the truth
 * proves only that the walk found something, which is what `>= 1` already does.
 * Raising it is one line and forces whoever adds a module to the domain to
 * notice that five walls now scan it.
 *
 * Twenty-three today: four services and four repositories in the domain's own
 * two directories, one schema module, one schema barrel, one route, two
 * controllers, two request-schema modules, three catalog-governance services,
 * the seed script, the merge plan, `app.ts`, and — since #405 gave a merge
 * conflict a way to name a collapsing compatibility relation — the curation
 * schema and its conflict applier. Eighteen of them are scanned; five are the
 * aggregates above.
 */
const DERIVED_FILES = 23;

/**
 * The floor on the WALK ITSELF, which is a different measurement from the one
 * above: it catches a walk that silently covered a fraction of the tree —
 * a swallowed `readdirSync`, a wrong root, a rename of `src` — where the
 * equality above would report a plausible-looking shortfall in the DOMAIN and
 * send the reader hunting for a moved compatibility file. Deliberately a floor
 * and not an equality: this number moves with every backend file anybody adds,
 * and a gate that fails on an unrelated addition is one somebody deletes.
 */
const MINIMUM_WALKED_FILES = 1200;

/** A filename that names the domain outright. Kept for the schema module, which imports none of it. */
const NAMED_FOR_THE_DOMAIN = /^(?:internal-)?compatibility.*\.ts$/;

/**
 * An import or export specifier with a path segment that NAMES the domain.
 *
 * Deliberately not `(services|db)/compatibility/`: the schema barrel spells it
 * `export * from './compatibility'` — relative, and with no extension — so an
 * absolute-looking pattern missed the one file that re-exports the tables to
 * everybody. Segment-prefixed, so `./compatibility.js`,
 * `../db/compatibility/x.js`, `../middleware/compatibility-schemas.js` and
 * `./compatibility-claim.service.js` all count, under any relative spelling.
 */
const REACHES_THE_DOMAIN = /(?:from|import)\s+['"](?:[^'"]*\/)?compatibility[^'"]*['"]/u;

/**
 * Whether a file belongs to the compatibility domain.
 *
 * Pure over `(relativePath, source)` so the self-test can ask about a file
 * nobody has written, in a directory nobody has predicted.
 */
function belongsToDomain(relativePath: string, source: string): boolean {
  if (!relativePath.endsWith('.ts')) return false;
  if (
    relativePath.startsWith('services/compatibility/') ||
    relativePath.startsWith('db/compatibility/')
  ) {
    return true;
  }
  const basename = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  return NAMED_FOR_THE_DOMAIN.test(basename) || REACHES_THE_DOMAIN.test(source);
}

/** Strip comments, so a module that DESCRIBES what it refuses is not read as doing it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * A variant OPTION, in any of the four spellings that reach one.
 *
 * Both SQL table names, both drizzle constants, and the two repositories that
 * own the writes. The repository paths are in the pattern because importing
 * `insertVariants` reaches the option write without ever naming the table.
 */
const OPTION_WRITE_REFERENCE =
  /listing_options|product_variant_option_values|listingOptions|productVariantOptionValues|catalog\/listingRepository|catalog\/variantRepository|catalog-write\.service/;

/** The compatibility domain, from the other direction. */
const COMPATIBILITY_REFERENCE =
  /compatibility\/|generic_compatibility_relations|automotive_fitments|compatibility_claims|vehicle_makes|vehicle_models|vehicle_generations|vehicle_configurations|genericCompatibilityRelations|automotiveFitments|resolveFitment/;

/** Ranking — #74's, behind its versioned policy (ADR 0007 non-goals). */
const RANKING_REFERENCE =
  /services\/ranking\/|rankingPolicy|ranking_policy_versions|rankOffers|scoreListing|boostScore|(^|[/'"])(feed|search)\.service/;

/** A price, an offer or a payment rail — a fit is not a sale. */
const COMMERCE_REFERENCE =
  /(^|[/'"])payments\/|checkout\/|checkout-payment|checkout\.service|PaymentIntent|ledger_entries|priceAmount|offer_price_snapshots|listOffersForComparison/;

/** The brand-relationship layer — #55's, and a different kind of claim. */
const RELATIONSHIP_REFERENCE =
  /commerce_relationships|relationship_evidence|relationship_reviews|commerceRelationships|SUFFICIENT_EVIDENCE_KINDS/;

/** The modules that legitimately DO write an option row. Scanned in reverse. */
const OPTION_WRITER_PATHS = [
  'db/catalog/listingRepository.ts',
  'db/catalog/variantRepository.ts',
  'services/backfill/stages/provisional-products.ts',
];

/** ONE enumeration for the whole file: it reads every source file, so twice is twice. */
const DOMAIN = enumerateDomain();

describe('the population derivation covers files nobody has written', () => {
  // The point of `belongsToDomain` being pure over a PATH: a floor over the
  // CURRENT tree proves the walk found today's files, and says nothing about
  // whether it would find tomorrow's. These cases hand it paths that do not
  // exist, in directories the old four-entry loop never visited.

  it('admits a file in a directory nobody predicted, because it imports the domain', () => {
    // Both of these are the shape that actually escaped: not an unpredicted NAME
    // (the previous version fixed that) but an unpredicted PLACE. Neither `lib/`
    // nor `services/storefront/` was in the four-directory loop, so both scored
    // zero and both would have walked through all five walls.
    expect(
      belongsToDomain(
        'lib/vehicle-picker.ts',
        "import { answerFitment } from '../services/compatibility/fitment.service.js';",
      ),
    ).toBe(true);
    expect(
      belongsToDomain(
        'services/storefront/fitment-widget.ts',
        "import { openAutomotiveFitment } from '../../db/compatibility/automotiveFitmentRepository.js';",
      ),
    ).toBe(true);
    // A deeply nested one, in a subdirectory of a subdirectory: the walk is
    // recursive, and the predicate reads a path rather than a directory listing.
    expect(
      belongsToDomain(
        'services/ingestion/adapters/fitment-feed.ts',
        "import { recordCompatibilityClaim } from '../../compatibility/claim.service.js';",
      ),
    ).toBe(true);
  });

  it('admits an unpredicted NAME as well, which is the hole before this one', () => {
    expect(
      belongsToDomain(
        'controllers/vehicle-fitment.controller.ts',
        "import { answerFitment } from '../services/compatibility/fitment.service.js';",
      ),
    ).toBe(true);
    expect(
      belongsToDomain(
        'middleware/fitment-admin-schemas.ts',
        "import { openAutomotiveFitment } from '../db/compatibility/automotiveFitmentRepository.js';",
      ),
    ).toBe(true);
  });

  it('still admits the schema module, which imports none of the domain', () => {
    // Why the union has a name half at all: `db/schema/compatibility.ts` DEFINES
    // the tables, so an import-only derivation would drop the one file every
    // other member depends on.
    expect(
      belongsToDomain('db/schema/compatibility.ts', 'export const automotiveFitments = pgTable('),
    ).toBe(true);
    expect(belongsToDomain('routes/internal-compatibility.ts', '')).toBe(true);
  });

  it('admits an extensionless relative re-export — the spelling the barrel uses', () => {
    // `db/schema/index.ts` writes `export * from './compatibility';` — no
    // extension, relative — and an `(services|db)/compatibility/` pattern missed
    // it, which meant the one file that hands the tables to everybody was not
    // even DERIVED, let alone excluded on purpose.
    expect(belongsToDomain('db/schema/index.ts', "export * from './compatibility';")).toBe(true);
  });

  it('excludes a neighbour that does neither — the control', () => {
    // Without this the cases above are satisfied by a predicate that returns
    // true for everything, which would put sixteen hundred files in a five-wall
    // scan and read as thoroughness.
    expect(
      belongsToDomain(
        'controllers/orders.controller.ts',
        "import { transition } from '../services/order.service.js';",
      ),
    ).toBe(false);
    // And a file that merely MENTIONS the domain in prose is not a member — the
    // predicate reads an import specifier, not the word.
    expect(
      belongsToDomain(
        'controllers/offers.controller.ts',
        '// see services/compatibility/ for fitment',
      ),
    ).toBe(false);
    expect(belongsToDomain('docs/compatibility.md', '')).toBe(false);
    // A path that merely CONTAINS the word outside a specifier, and a
    // sibling-named module in another domain: both are non-members.
    expect(
      belongsToDomain(
        'services/ranking/facts.ts',
        "import { readOffer } from '../../db/offers/offerRepository.js';",
      ),
    ).toBe(false);
  });
});

describe('the exclusion list is exact, live and necessary', () => {
  // Three directions, because an exemption fails in three ways and each looks
  // like a pass: it goes STALE (the file moved, so it excuses nothing), it was
  // never NEEDED (so it hides that the wall does no work on that file), or the
  // list silently GROWS (so tomorrow's real violation is excused).
  const derivedPaths = new Set(DOMAIN.derived.map(relativeToSrc));

  it('names exactly five files, and every one of them is really derived', () => {
    expect(AGGREGATE_EXCLUSIONS.length, 'the exclusion list changed size').toBe(5);
    for (const entry of AGGREGATE_EXCLUSIONS) {
      // Direction one: not stale. An entry naming a path the derivation does not
      // produce excuses nothing and would go on excusing nothing forever.
      expect(
        derivedPaths.has(entry.path),
        `${entry.path} is excluded but is not in the derived population — did it move or stop ` +
          'importing the domain? A stale exclusion is indistinguishable from a working one',
      ).toBe(true);
      expect(entry.reason.length, `${entry.path} has no reason`).toBeGreaterThan(40);
    }
    // Direction three: subtraction is the ONLY way out of the population. If
    // these two numbers stop differing by exactly the list's length, something
    // else is dropping files.
    expect(DOMAIN.scanned.length).toBe(DOMAIN.derived.length - AGGREGATE_EXCLUSIONS.length);
  });

  it("proves each exclusion's reason still holds, in the reason's own terms", () => {
    // Direction two, and the one that is easy to fake: a reason stated as prose
    // cannot fail. Each of these is the MEASURABLE form of the sentence in the
    // list, so an entry whose justification evaporated goes red here.
    const read = (path: string) => readFileSync(join(SRC_ROOT, path), 'utf8');

    // `app.ts` is the composition root: it imports routers by the hundred.
    const appRouterImports = read('app.ts').match(/from\s+'\.\/routes\//gu) ?? [];
    expect(
      appRouterImports.length,
      'app.ts no longer imports routers wholesale, so "composition root" is not why it reaches ' +
        'this domain — re-read the exclusion',
    ).toBeGreaterThanOrEqual(40);

    // The barrel re-exports every table and defines none.
    const barrel = read('db/schema/index.ts');
    expect((barrel.match(/export \* from/gu) ?? []).length).toBeGreaterThanOrEqual(30);
    expect(
      /pgTable\(/u.test(barrel),
      'db/schema/index.ts now DEFINES a table, so it is not a pure re-export barrel',
    ).toBe(false);

    // The merge plan is the one exclusion whose necessity is demonstrable: it
    // would go RED on a wall today. That is what makes it an exclusion rather
    // than a member — and if it ever stops tripping one, it should be scanned.
    const mergePlan = stripComments(read('services/curation/merge-plan.ts'));
    expect(
      RELATIONSHIP_REFERENCE.test(mergePlan) ||
        COMMERCE_REFERENCE.test(mergePlan) ||
        RANKING_REFERENCE.test(mergePlan) ||
        OPTION_WRITE_REFERENCE.test(mergePlan),
      'merge-plan.ts trips no wall any more; it is excluded for a cost it no longer has, so put ' +
        'it back in the scanned set rather than leaving an exemption that hides nothing',
    ).toBe(true);
    // And it is derived for the right reason: it names the domain's own tables.
    expect(COMPATIBILITY_REFERENCE.test(mergePlan)).toBe(true);

    /**
     * #405's two, measured the same way the merge plan is.
     *
     * Each would go RED on a wall today, and each is derived because it names
     * this domain's own table — which together is what makes them exclusions
     * rather than members. The extra probe below is the reason in ITS own terms:
     * the sentence says these files name a row (or a writer) PER DOMAIN, so the
     * falsifiable form is that they still reach several, not merely one.
     */
    for (const path of ['db/schema/curation.ts', 'services/curation/merge-conflicts.ts']) {
      const source = stripComments(read(path));
      expect(
        RELATIONSHIP_REFERENCE.test(source) ||
          COMMERCE_REFERENCE.test(source) ||
          RANKING_REFERENCE.test(source) ||
          OPTION_WRITE_REFERENCE.test(source),
        `${path} trips no wall any more; it is excluded for a cost it no longer has, so put it ` +
          'back in the scanned set rather than leaving an exemption that hides nothing',
      ).toBe(true);
      expect(
        COMPATIBILITY_REFERENCE.test(source),
        `${path} no longer names this domain, so the exclusion is stale`,
      ).toBe(true);
      // "one per domain": a conflict row that named ONE other domain would be a
      // coupling rather than an aggregate, and belongs in the scanned set.
      const reached = SCHEMA_MODULES.filter((module) =>
        new RegExp(`from '[^']*/${module}(?:\\.js)?'`, 'u').test(source),
      );
      expect(
        reached.length,
        `${path} reaches only ${String(reached.length)} schema module(s); "one per domain" ` +
          'is no longer why it is here',
      ).toBeGreaterThanOrEqual(4);
    }
  });

  it('does not excuse a file the derivation would newly admit', () => {
    // The ADD direction on the LIST rather than on the population: the
    // exclusions are exact PATHS, never a pattern, so a new file cannot be
    // excused by resembling one. Two paths that do not exist, either of which a
    // prefix or suffix rule would have swallowed.
    const excluded = new Set(AGGREGATE_EXCLUSIONS.map((entry) => entry.path));
    expect(excluded.has('app.fitment.ts')).toBe(false);
    expect(excluded.has('services/curation/merge-plan-vehicles.ts')).toBe(false);
    expect(excluded.has('db/schema/index.compatibility.ts')).toBe(false);
  });
});

describe('the compatibility domain cannot reach what it must not', () => {
  const { derived, walked } = DOMAIN;
  const files = DOMAIN.scanned;

  it('scans a domain that has not silently shrunk', () => {
    // The floor on the walk comes FIRST: everything below is a subtraction from
    // it, so a walk that covered a fraction of the tree makes every count under
    // it meaningless while looking like a domain that shrank.
    expect(
      walked,
      `the walk found ${String(walked)} source files under src/ — that is far too few; the walk ` +
        'itself is broken, and the domain counts below are measuring a fragment',
    ).toBeGreaterThanOrEqual(MINIMUM_WALKED_FILES);
    // Vacuity floors PER SHAPE rather than one on the total: the sources break
    // independently, and a single total would let the service walk collapse to
    // zero while the repositories carried the number.
    const from = (segment: string) => files.filter((file) => file.includes(segment)).length;
    expect(from('/services/compatibility/'), 'the service walk found nothing').toBeGreaterThanOrEqual(4);
    expect(from('/db/compatibility/'), 'the repository walk found nothing').toBeGreaterThanOrEqual(4);
    expect(from('/db/schema/compatibility'), 'the schema derivation found nothing').toBeGreaterThanOrEqual(1);
    // The HTTP surface, floored per LAYER rather than as one total: a route file
    // and its controller break independently, and one floor of three would let the
    // controller vanish from the scan while the route and the schemas carried the
    // number — which is the layer a forbidden import is most likely to enter.
    expect(from('/routes/compatibility'), 'the route walk found nothing').toBeGreaterThanOrEqual(1);
    expect(from('/controllers/'), 'the controller derivation found nothing').toBeGreaterThanOrEqual(2);
    expect(from('/middleware/'), 'the request-schema derivation found nothing').toBeGreaterThanOrEqual(2);
    // The layer the four-directory loop could not see at all, floored on its own
    // for exactly that reason: the claim-promotion service lives here, and a
    // floor that lumped it in with the services above would have been satisfied
    // by the domain's own directory while this one was empty.
    expect(
      from('/services/catalog-governance/'),
      'the governance derivation found nothing — the promotion surface is unscanned',
    ).toBeGreaterThanOrEqual(3);
    expect(
      from('/scripts/seed-verticals/'),
      'the seed derivation found nothing — the fixture every automotive E2E reads is unscanned',
    ).toBeGreaterThanOrEqual(1);
    // Printed on SUCCESS, not only in a failure message: the population size is
    // the one number that says this census measured anything, and a reader who
    // only ever sees it when the gate is red cannot tell a healthy scan of
    // eighteen files from a healthy scan of two.
    process.stdout.write(
      `compatibility isolation: walked ${String(walked)} source file(s), derived ` +
        `${String(derived.length)}, scanning ${String(files.length)} after ` +
        `${String(AGGREGATE_EXCLUSIONS.length)} counted exclusion(s)\n`,
    );
    // EQUALITY on the DERIVED set, because the comment on `DERIVED_FILES` says
    // "the next legitimate file fails this line, and that is deliberate" — and
    // `toBeGreaterThanOrEqual` passed on every addition, so the mechanism the
    // comment describes did not exist. It is asserted on `derived` rather than on
    // `scanned` so that MOVING a file into the exclusion list cannot satisfy it:
    // both numbers would have to be edited, and the exclusion needs its reason
    // probed besides.
    expect(
      derived.length,
      `the domain holds ${String(derived.length)} files; DERIVED_FILES says ${String(DERIVED_FILES)}. ` +
        'Raising it is one line, and doing so is how you notice five walls now scan your new module.',
    ).toBe(DERIVED_FILES);
    // No test file may enter the scanned set: a gate that scans its own probes
    // reports violations it wrote itself.
    expect(files.filter((file) => file.includes('__tests__'))).toEqual([]);
    for (const file of files) {
      // The vacuity floor: an empty or moved file must fail here, not pass the
      // scans below by having nothing to match.
      expect(
        readFileSync(file, 'utf8').length,
        `${file} looks empty — did it move?`,
      ).toBeGreaterThan(200);
    }
  });

  it('has no writer for a variant option — ADR 0007 D8, the acceptance scenario', () => {
    for (const file of files) {
      expect(
        OPTION_WRITE_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches the variant-option path; a brake pad that fits a thousand vehicles ` +
          'is ONE variant, and a year range, a make or a model may never be stored as an option',
      ).toBe(false);
    }
  });

  it('is not reachable FROM an option writer either', () => {
    let scanned = 0;
    for (const relative of OPTION_WRITER_PATHS) {
      const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
      expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        COMPATIBILITY_REFERENCE.test(stripComments(source)),
        `${relative} writes option rows and references the compatibility domain; ` +
          'that is the front door for the fact D8 forbids',
      ).toBe(false);
      scanned += 1;
    }
    // EXACT, not `scanned === length`: that comparison is circular (the loop
    // increments once per entry, so it holds for ANY list including an empty
    // one). This list names modules in OTHER domains that legitimately write an
    // option row, so it stays a hand list — a walk of `db/catalog/` would pull in
    // every unrelated repository — but an unbounded one is a predicate rather
    // than an identity (#448).
    expect(OPTION_WRITER_PATHS.length, 'the option-writer list changed size').toBe(3);
    expect(scanned).toBe(OPTION_WRITER_PATHS.length);
  });

  it('reads no ranking module — that is #74', () => {
    for (const file of files) {
      expect(
        RANKING_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches ranking; "fits your vehicle" is an eligibility fact, not a weight`,
      ).toBe(false);
    }
  });

  it('reads no price, offer or payment rail — a fit is not a sale', () => {
    for (const file of files) {
      expect(
        COMMERCE_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches commerce; a fitment says a part goes on a car and says nothing ` +
          'about whether anybody is selling it today',
      ).toBe(false);
    }
  });

  it('does not reuse the brand-relationship layer — a fit is not a badge', () => {
    for (const file of files) {
      expect(
        RELATIONSHIP_REFERENCE.test(stripComments(readFileSync(file, 'utf8'))),
        `${file} reaches #55's relationship layer; sharing that vocabulary would make ` +
          '`verified` mean two things — a badge on one side and a fit on the other',
      ).toBe(false);
    }
  });
});

describe('no vehicle fact can become a variant axis — the schema census', () => {
  /**
   * The two option tables' REAL drizzle columns.
   *
   * `sqlColumnName`, never `column.name` — the latter is the TypeScript property
   * (`listingId`) and an `endsWith('_id')` or a name comparison against it
   * silently matches nothing, which is a check that passes vacuously.
   */
  const optionColumns = [listingOptions, productVariantOptionValues].flatMap((table) =>
    getTableConfig(table).columns.map((column) => ({
      table: getTableConfig(table).name,
      column: sqlColumnName(column),
    })),
  );

  it('walks a non-empty column set', () => {
    // The vacuity floor. Both tables have six columns today; a census over an
    // empty set is a gate that can never fail.
    expect(optionColumns.length).toBeGreaterThanOrEqual(10);
  });

  it('names no vehicle, year or fitment fact in either option table', () => {
    for (const { table, column } of optionColumns) {
      for (const forbidden of COMPATIBILITY_FORBIDDEN_VARIANT_AXIS_FACTS) {
        expect(
          column.includes(forbidden),
          `${table}.${column} names \`${forbidden}\`; ADR 0007 D8 forbids a vehicle fact ` +
            'as a variant option, and a column is the tidy-looking way it arrives',
        ).toBe(false);
      }
    }
  });

  it('the prohibition list is non-empty and disjoint from what this domain does store', () => {
    // A vacuity floor on the LIST itself: an empty prohibition passes every
    // check above while forbidding nothing.
    expect(COMPATIBILITY_FORBIDDEN_VARIANT_AXIS_FACTS.length).toBeGreaterThanOrEqual(10);
    // And a positive control: these ARE the columns this domain stores, so the
    // census above would fire if the option tables ever grew one.
    const compatibilityColumns = getTableConfig(automotiveFitments).columns.map((column) =>
      sqlColumnName(column),
    );
    expect(compatibilityColumns).toContain('vehicle_generation_id');
    expect(compatibilityColumns).toContain('vehicle_configuration_id');
  });
});

describe('no compatibility table can hold a person or a physical car', () => {
  const domainTables = [
    genericCompatibilityRelations,
    compatibilityClaims,
    automotiveFitments,
    vehicleMakes,
    vehicleModels,
    vehicleGenerations,
    vehicleConfigurations,
  ];

  it('walks all seven tables', () => {
    expect(domainTables.length).toBe(7);
    for (const table of domainTables) {
      expect(getTableConfig(table).columns.length).toBeGreaterThan(4);
    }
  });

  /**
   * The ATTRIBUTION columns, exempt from the person census below — and the
   * exemption carries its own exact-count assertion, per the house rule that a
   * list of exemptions needs one.
   *
   * The distinction the census is actually making is between what a fit is
   * KEYED ON and who RECORDED it. An Oxy account id naming the operator who
   * verified a claim is the audit trail; an Oxy account id naming the person the
   * claim is about would make "does this fit" answerable differently for two
   * shoppers, which is what the prohibition exists to prevent. Three columns,
   * named, and nothing else.
   */
  const ATTRIBUTION_COLUMNS: readonly string[] = [
    'verified_by_oxy_user_id',
    'revoked_by_oxy_user_id',
    'reviewed_by_oxy_user_id',
  ];

  it('the attribution exemption is exactly three columns, and each really exists', () => {
    expect(ATTRIBUTION_COLUMNS.length).toBe(3);
    // A vacuity floor on the EXEMPTION itself: one naming a column that does not
    // exist excuses nothing while hiding that a real column went unexcused.
    const everyColumn = new Set(
      domainTables.flatMap((table) =>
        getTableConfig(table).columns.map((column) => sqlColumnName(column)),
      ),
    );
    for (const exempt of ATTRIBUTION_COLUMNS) {
      expect(everyColumn.has(exempt), `\`${exempt}\` is exempted and does not exist`).toBe(true);
    }
  });

  it('declares no VIN, plate, buyer, order or price column', () => {
    for (const table of domainTables) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        const name = sqlColumnName(column);
        if (ATTRIBUTION_COLUMNS.includes(name)) continue;
        for (const forbidden of COMPATIBILITY_FORBIDDEN_SUBJECT_FACTS) {
          expect(
            name === forbidden || name.endsWith(`_${forbidden}`),
            `${config.name}.${name} names \`${forbidden}\`; a VIN identifies one physical car ` +
              'with an owner attached, and a fit is not keyed on a person, an order or a price',
          ).toBe(false);
        }
      }
    }
    expect(COMPATIBILITY_FORBIDDEN_SUBJECT_FACTS.length).toBeGreaterThanOrEqual(6);
  });

  it('the person detector would fire on a subject column — the mutation self-test', () => {
    // Without this, the exemption above could grow until the census matched
    // nothing and still reported clean. Driven through the same comparison the
    // loop uses, on names the loop never receives.
    const fires = (name: string): boolean =>
      !ATTRIBUTION_COLUMNS.includes(name) &&
      COMPATIBILITY_FORBIDDEN_SUBJECT_FACTS.some(
        (forbidden) => name === forbidden || name.endsWith(`_${forbidden}`),
      );
    expect(fires('vin')).toBe(true);
    expect(fires('vehicle_vin')).toBe(true);
    expect(fires('subject_oxy_user_id')).toBe(true);
    expect(fires('order_id')).toBe(true);
    expect(fires('verified_by_oxy_user_id')).toBe(false);
    expect(fires('vehicle_generation_id')).toBe(false);
  });
});

describe('the vocabularies are disjoint where they claim to be', () => {
  it('no forbidden verification method is also a real one', () => {
    expect(COMPATIBILITY_FORBIDDEN_VERIFICATION_METHODS.length).toBeGreaterThanOrEqual(7);
    expect(COMPATIBILITY_VERIFICATION_METHODS.length).toBeGreaterThanOrEqual(6);
    for (const forbidden of COMPATIBILITY_FORBIDDEN_VERIFICATION_METHODS) {
      expect(
        (COMPATIBILITY_VERIFICATION_METHODS as readonly string[]).includes(forbidden),
        `\`${forbidden}\` is offered as a verification method; two names looking alike ` +
          'is exactly how a 2016 part gets published as fitting a 2017 car',
      ).toBe(false);
    }
  });

  it('applicability has four members and `unknown` is not `does_not_apply`', () => {
    // The distinction is the domain's central one, so it gets its own assertion
    // rather than relying on a tuple nobody re-reads.
    expect(COMPATIBILITY_APPLICABILITIES).toEqual([
      'applies',
      'partially_applies',
      'does_not_apply',
      'unknown',
    ]);
  });

  it('the fitment scope ladder is ordered broadest-first', () => {
    // Reverse this tuple and every exclusion in the database silently stops
    // applying, while every query still returns rows and every page renders.
    expect(FITMENT_TARGET_SCOPES).toEqual([
      'vehicle_make',
      'vehicle_model',
      'vehicle_generation',
      'vehicle_configuration',
    ]);
  });
});

describe('no compatibility DTO can carry provenance — the two-gate rule', () => {
  it('the shared-types module declares none of the forbidden fields', () => {
    const source = readFileSync(
      join(SRC_ROOT, '..', '..', 'shared-types', 'src', 'compatibility.ts'),
      'utf8',
    );
    expect(source.length).toBeGreaterThan(5_000);
    for (const field of COMPATIBILITY_FORBIDDEN_VIEW_FIELDS) {
      // The list itself is the one legitimate mention, so the check is on the
      // FIELD DECLARATION shape rather than on the bare name — otherwise the
      // prohibition would trip over stating itself.
      const declaration = new RegExp(`readonly\\s+${field}\\s*[?:]`);
      expect(declaration.test(source), `compatibility.ts declares \`${field}\``).toBe(false);
    }
    expect(COMPATIBILITY_FORBIDDEN_VIEW_FIELDS.length).toBeGreaterThanOrEqual(6);
  });

  /**
   * The RUNTIME half (#92's rule): a static scan proves the module does not
   * DECLARE a field, and only a walk of a real emitted object proves the
   * serializer does not ADD one. `projectCompatibilityRelation` is a spread away
   * from shipping every provenance column, so this is the gate that would catch
   * that edit.
   */
  it('a real emitted relation view carries no forbidden field', () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    const view = projectCompatibilityRelation({
      id: 'rel_1',
      kind: 'accessory_for',
      direction: 'subject_to_target',
      subjectProductId: 'prod_case',
      subjectVariantId: null,
      targetKind: 'canonical_product',
      targetFamilyId: null,
      targetProductId: 'prod_phone',
      targetVariantId: null,
      targetType: null,
      targetKey: null,
      applicability: 'applies',
      conditionKinds: [],
      conditionNote: null,
      markets: ['ES'],
      validFrom: now,
      validTo: null,
      verification: 'verified',
      verificationMethod: 'manufacturer_publication',
      assertedByKind: 'manufacturer',
      assertedBySourceId: null,
      confidence: 0.99,
      verifiedAt: now,
      verifiedByOxyUserId: 'oxy_1',
      lastCheckedAt: null,
      revokedAt: null,
      revokedByOxyUserId: null,
      revokeReason: null,
      supersededById: null,
      note: null,
      createdAt: now,
      updatedAt: now,
      relationKey: 'prod_case||||prod_phone|||',
    });
    for (const field of COMPATIBILITY_FORBIDDEN_VIEW_FIELDS) {
      expect(Object.keys(view), `the emitted relation view carries \`${field}\``).not.toContain(
        field,
      );
    }
    // The positive control: the walk is over a real object with real keys, so an
    // empty projection cannot pass this block by carrying nothing.
    expect(Object.keys(view).length).toBeGreaterThanOrEqual(12);
    expect(view.target).toEqual({ kind: 'canonical_product', productId: 'prod_phone' });
  });

  it('a real emitted fitment view carries no forbidden field', () => {
    const now = new Date('2026-01-02T03:04:05.000Z');
    const vehicleRow = {
      id: 'make_1',
      key: 'volkswagen',
      name: 'Volkswagen',
      countryCode: 'DE',
      status: 'active' as const,
      mergedIntoId: null,
      createdAt: now,
      updatedAt: now,
    };
    const view = projectAutomotiveFitment(
      {
        id: 'fit_1',
        subjectProductId: 'prod_pad',
        subjectVariantId: null,
        scope: 'vehicle_make',
        vehicleMakeId: 'make_1',
        vehicleModelId: null,
        vehicleGenerationId: null,
        vehicleConfigurationId: null,
        applicability: 'applies',
        position: 'front',
        qualifiers: [],
        conditionKinds: [],
        conditionNote: null,
        yearFrom: null,
        yearTo: null,
        quantityPerVehicle: 2,
        verification: 'verified',
        verificationMethod: 'manufacturer_publication',
        assertedByKind: 'manufacturer',
        assertedBySourceId: null,
        manufacturerReference: 'TD-99',
        manufacturerPublicationUrl: 'https://example.invalid/f',
        contentSha256: 'a'.repeat(64),
        sourceRecordId: null,
        confidence: null,
        observedAt: now,
        verifiedAt: now,
        verifiedByOxyUserId: 'oxy_1',
        lastCheckedAt: null,
        validFrom: now,
        validTo: null,
        revokedAt: null,
        revokedByOxyUserId: null,
        revokeReason: null,
        supersededById: null,
        note: null,
        createdAt: now,
        updatedAt: now,
        fitmentKey: 'prod_pad||make_1||||front',
      },
      { make: vehicleRow },
    );
    for (const field of COMPATIBILITY_FORBIDDEN_VIEW_FIELDS) {
      expect(Object.keys(view), `the emitted fitment view carries \`${field}\``).not.toContain(field);
    }
    expect(Object.keys(view).length).toBeGreaterThanOrEqual(15);
    expect(view.make).toEqual({ id: 'make_1', key: 'volkswagen', name: 'Volkswagen' });
  });
});

describe('the detectors actually detect — the mutation self-tests', () => {
  it('the option detector sees a table, a constant and a repository import', () => {
    expect(OPTION_WRITE_REFERENCE.test('await tx.insert(listingOptions).values(rows);')).toBe(true);
    expect(
      OPTION_WRITE_REFERENCE.test("import { insertVariants } from '../../db/catalog/variantRepository.js';"),
    ).toBe(true);
    expect(OPTION_WRITE_REFERENCE.test('delete from product_variant_option_values')).toBe(true);
    expect(
      OPTION_WRITE_REFERENCE.test("import { canonicalVariants } from '../schema/canonicalCatalog.js';"),
    ).toBe(false);
  });

  it('the reverse detector sees a compatibility import and not an innocent word', () => {
    expect(
      COMPATIBILITY_REFERENCE.test("import { resolveFitment } from '@mercaria/shared-types';"),
    ).toBe(true);
    expect(COMPATIBILITY_REFERENCE.test('select * from automotive_fitments')).toBe(true);
    expect(COMPATIBILITY_REFERENCE.test('const compatible = true;')).toBe(false);
  });

  it('the ranking detector sees a policy and a feed import', () => {
    expect(RANKING_REFERENCE.test("import { rankOffers } from '../ranking/rank.js';")).toBe(true);
    expect(RANKING_REFERENCE.test('const rankingPolicy = 1;')).toBe(true);
    expect(RANKING_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(false);
  });

  it('the commerce detector sees a rail and not the word part', () => {
    expect(COMMERCE_REFERENCE.test("import { x } from '../payments/checkout-payment.service.js';")).toBe(
      true,
    );
    expect(COMMERCE_REFERENCE.test('const intent = new PaymentIntent();')).toBe(true);
    expect(COMMERCE_REFERENCE.test('const partNumber = "BP-1234";')).toBe(false);
  });

  it('the relationship detector sees #55 and not the word relation', () => {
    expect(
      RELATIONSHIP_REFERENCE.test("import { commerceRelationships } from '../schema/relationships.js';"),
    ).toBe(true);
    expect(RELATIONSHIP_REFERENCE.test('select * from commerce_relationships')).toBe(true);
    expect(
      RELATIONSHIP_REFERENCE.test('const relation = await findRelationById(id);'),
    ).toBe(false);
  });

  it('the comment stripper does not hide a real reference on the same line', () => {
    // The stripper is itself load-bearing: if it removed too much, every scan
    // above would pass vacuously.
    const stripped = stripComments('await tx.insert(listingOptions).values(rows); // a note');
    expect(OPTION_WRITE_REFERENCE.test(stripped)).toBe(true);
    expect(stripComments('/* listingOptions */').trim()).toBe('');
    // And it must not eat a URL's `//`, which would silently truncate a line
    // carrying a real reference after one.
    expect(stripComments("const u = 'https://x/listing_options';")).toContain('listing_options');
  });
});
