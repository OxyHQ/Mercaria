/**
 * The walls around the curation domain (#59), asserted STRUCTURALLY.
 *
 * Five properties, each a scan rather than a fixture, because "cannot" is a
 * stronger statement than "did not in this case" — the
 * `matching-isolation.test.ts` and `fee-ranking-isolation.test.ts` precedent.
 *
 * 1. **Nothing in this domain deletes.** A wrong merge is undone by a split and
 *    a wrong suppression by a lift; both leave the record. A `.delete(` here
 *    would be the one operation whose damage the audit trail cannot describe.
 * 2. **A merge never touches the native catalogue or a placed order** (#59 merge
 *    invariant 3). The census test proves no PLAN entry names one; this proves
 *    no module reaches for one directly either.
 * 3. **Curation cannot become a ranking signal.** No feed, search or catalogue
 *    read may reference this domain, and this domain may reference no fee,
 *    payment or referral module. What an operator decided about an identity must
 *    not be reachable from what a seller pays, in either direction.
 * 4. **No HTTP caller can post a job's end state.** The schemas carry no
 *    `status`, `phase`, `mergedIntoId`, `appliedAt` or impact field, so there is
 *    no route around the conflict gate or the four-eyes threshold.
 * 5. **The split's declared item types and the columns it actually moves are the
 *    same set**, so a client validating against the contract cannot name
 *    something the runner would silently skip.
 *
 * The scanner carries the metro-gate defences (`~/Oxy/AGENTS.md`): a vacuity
 * floor so a moved file fails instead of shrinking the gate, and a mutation
 * self-test so a rotted regex cannot pass by matching nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_SPLIT_ITEM_TYPES_BY_ENTITY,
  SPLITTABLE_ENTITY_TYPES,
} from '@mercaria/shared-types';
import { SPLIT_ITEM_COLUMNS } from '../split.service.js';
import {
  RANKING_SURFACE_PATHS,
  assertRankingSurfaceIsWhole,
} from '../../../__tests__/ranking-surface.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every module of the curation domain — services, repositories, route, controller. */
const CURATION_DOMAIN_PATHS = [
  'services/curation/merge.service.ts',
  'services/curation/merge-conflicts.ts',
  'services/curation/merge-plan.ts',
  'services/curation/split.service.ts',
  'services/curation/review-queue.service.ts',
  'services/curation/correction.service.ts',
  'services/curation/revision.ts',
  'services/curation/rollups.ts',
  'services/curation/impact.ts',
  'services/curation/entity-registry.ts',
  'services/curation/curation-dispatcher.ts',
  'db/curation/curationRepository.ts',
  'db/curation/jobRepository.ts',
  'db/curation/rehomeRepository.ts',
  'db/curation/conflictRepository.ts',
  'controllers/curation-operator.controller.ts',
  'middleware/curation-schemas.ts',
];

/*
 * The organic discovery surface is `__tests__/ranking-surface.ts` — WALKED and
 * derived from the import graph, shared with every other gate asserting that a
 * domain cannot influence what a buyer sees.
 *
 * It used to be a fourteen-entry `RANKING_PATHS` array here, under the comment
 * "a new ranking module belongs on this list", which is the instruction #460 is
 * about: nothing enforces it, and what a list like that ends up holding is the
 * modules somebody remembered.
 *
 * #483 replaced eleven such copies with the shared derivation. Its own docblock
 * table names this file beside `matching` at fourteen entries — and `matching`
 * really was converted and imports the derivation today, while this one was not.
 * So #483 ended ten copies and documented eleven, and this is the eleventh.
 *
 * Measured on `origin/main` at 4b30d5a2: fourteen entries against forty-two,
 * missing all of `db/ranking/`, all of `db/search/`, five modules of
 * `services/ranking/` (`dominance`, `money`, `policy`, `policy.service`,
 * `seams`), six of `services/search/` including the canonical search service
 * itself, `db/catalog/listingRepository.ts`, and eleven derived controllers and
 * routes including both operator surfaces.
 *
 * The wall it computes — what an operator decided about an IDENTITY must not
 * reach organic ranking — is the kind that goes silently green: a merge, a split
 * or a review verdict leaking into an ordering produces no error and no symptom,
 * and the modules the copy skipped were by construction the ones nobody had
 * reviewed against this rule.
 */

const CURATION_REFERENCE =
  /curation\/|catalogRevisions|catalogMergeJobs|catalogReviewItems|catalog_revisions|catalog_merge_jobs|catalog_review_items|requestMerge|requestSplit/;

const COMMERCIAL_REFERENCE =
  /fees\/|payments\/|referrals\/|feeSchedule|orderFeeSnapshot|ledgerRepository/;

/** The native catalogue and the money record — invariant 3's forbidden set. */
const NATIVE_COMMERCE_REFERENCE =
  /\borderItems\b|\borders\b\s*[,)]|schema\/orders|schema\/catalog\.js'|\blistings\b\s*[,)]|\bproductVariants\b\s*[,)]/;

/**
 * Strip comments before scanning, and keep the vacuity floor on the RAW file.
 *
 * Every module in this domain documents, in prose, exactly which table it
 * refuses to touch — so a scanner that read comments would fire on the
 * documentation of the rule it enforces. That is the "cries wolf" shape
 * `~/Oxy/AGENTS.md` warns about: the next person to hit it weakens the regex and
 * the gate is gone.
 */
function readDomainFile(relative: string): string {
  const raw = readFileSync(join(SRC_ROOT, relative), 'utf8');
  expect(raw.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  const code = raw.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '');
  expect(code.length, `${relative} is all comments — did its code move?`).toBeGreaterThan(100);
  return code;
}

describe('curation never deletes', () => {
  it('no curation module issues a delete', () => {
    let scanned = 0;
    for (const relative of CURATION_DOMAIN_PATHS) {
      const source = readDomainFile(relative);
      expect(
        /\.delete\(/.test(source),
        `${relative} deletes. A merge leaves a tombstone, a suppression hides and a correction ` +
          'appends; there is no act in this domain whose effect is that a row stops existing.',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(CURATION_DOMAIN_PATHS.length);
  });
});

describe('a merge cannot disturb a placed order or a native listing', () => {
  it('no curation module reaches the order or native-catalogue tables to write', () => {
    // `impact.ts` is the ONE exception and it is a READ: it counts the order
    // lines a merge leaves alone, which is the reassurance #59 merge invariant 3
    // exists to give. Excluding it by name rather than by loosening the regex is
    // what keeps the gate meaningful for the other sixteen modules.
    for (const relative of CURATION_DOMAIN_PATHS) {
      if (relative === 'services/curation/impact.ts') continue;
      const source = readDomainFile(relative);
      expect(
        NATIVE_COMMERCE_REFERENCE.test(source),
        `${relative} references the native catalogue or a placed order; a canonical merge must ` +
          'never touch either (#59 merge invariant 3).',
      ).toBe(false);
    }
  });

  it('the one module that DOES read orders only counts them', () => {
    const source = readDomainFile('services/curation/impact.ts');
    expect(source).toContain('orderItems');
    // A count and nothing else: no update, no insert, no delete against orders.
    expect(/\.update\(\s*orderItems/.test(source)).toBe(false);
    expect(/\.insert\(\s*orderItems/.test(source)).toBe(false);
    expect(/\.delete\(/.test(source)).toBe(false);
  });
});

describe('curation cannot become a ranking signal', () => {
  it('no feed, search or catalogue-read module references the curation domain', () => {
    // The derivation's own per-SHAPE floors and a `statSync` on every path.
    // This assertion is only as wide as the walk behind it, and a walk that
    // collapsed to nothing produces exactly the zero violations a healthy run
    // produces.
    assertRankingSurfaceIsWhole();
    for (const relative of RANKING_SURFACE_PATHS) {
      const source = readDomainFile(relative);
      expect(
        CURATION_REFERENCE.test(source),
        `${relative} references the curation domain; what an operator decided about an identity ` +
          'must not reach organic ranking.',
      ).toBe(false);
    }
  });

  it('no curation module references a fee, payment or referral module', () => {
    for (const relative of CURATION_DOMAIN_PATHS) {
      const source = readDomainFile(relative);
      expect(
        COMMERCIAL_REFERENCE.test(source),
        `${relative} reaches a commercial domain; what a seller pays cannot influence what an ` +
          'operator is shown about their identity.',
      ).toBe(false);
    }
  });
});

describe('no HTTP caller can post a job end state', () => {
  it('the operator schemas carry no status, phase, tombstone or impact field', () => {
    const schemas = readDomainFile('middleware/curation-schemas.ts');
    for (const forbidden of [
      'status:',
      'phase:',
      'mergedIntoId',
      'appliedAt',
      'impactTotalMoving',
      'requiresSecondApproval',
      'approvedByOxyUserId',
      'leaseOwner',
    ]) {
      expect(
        schemas.includes(forbidden),
        `curation-schemas.ts accepts '${forbidden}'; a route that can post a job's end state is a ` +
          'route around the conflict gate and the four-eyes threshold.',
      ).toBe(false);
    }
    // Every schema is CLOSED, so an unknown key is a 400 rather than a drop.
    const strictCount = (schemas.match(/\.strict\(\)/gu) ?? []).length;
    expect(strictCount).toBeGreaterThanOrEqual(14);
  });

  it('every mutating schema demands a reason (#59 security 2)', () => {
    const schemas = readDomainFile('middleware/curation-schemas.ts');
    // The `reason` const is defined once and reused; counting its uses is what
    // catches a new mutating schema that forgot it.
    const uses = (schemas.match(/\breason\b/gu) ?? []).length;
    expect(uses).toBeGreaterThanOrEqual(10);
  });
});

describe('the split contract and the split runner name the same items', () => {
  it('every declared item type has a column, and every column a declared type', () => {
    for (const entityType of SPLITTABLE_ENTITY_TYPES) {
      const declared = [...CATALOG_SPLIT_ITEM_TYPES_BY_ENTITY[entityType]].sort();
      const implemented = Object.keys(SPLIT_ITEM_COLUMNS[entityType]).sort();
      expect(
        implemented,
        `the ${entityType} split accepts item types the runner cannot move, or moves ones the ` +
          'contract does not accept. Either way an operator names something and nothing happens.',
      ).toEqual(declared);
      expect(declared.length).toBeGreaterThan(0);
    }
  });
});

describe('the scanner itself is not vacuous', () => {
  it('every detector fires on a seeded positive', () => {
    expect(CURATION_REFERENCE.test("import { requestMerge } from '../curation/merge.service.js';")).toBe(
      true,
    );
    expect(COMMERCIAL_REFERENCE.test("import { x } from '../fees/fee.service.js';")).toBe(true);
    expect(NATIVE_COMMERCE_REFERENCE.test('await db.update(orderItems).set({});')).toBe(true);
    expect(/\.delete\(/.test('await db.delete(catalogRevisions);')).toBe(true);
  });

  it('scans a floor of modules, so a domain that moved cannot shrink the gate', () => {
    expect(CURATION_DOMAIN_PATHS.length).toBeGreaterThanOrEqual(17);
    // The ranking surface carries its own PER-SHAPE floors, which is strictly
    // stronger than the total this line used to assert: a `>= 7` over a hand
    // list of fourteen was already satisfied by half of it, so the walk that
    // matters could have collapsed entirely while the number stayed green.
    assertRankingSurfaceIsWhole();
  });

  it('strips comments without stripping code', () => {
    const source = readDomainFile('services/curation/merge.service.ts');
    // The docblock says "never deletes a row"; the stripper must have removed it
    // or every scan above would be passing vacuously on its own documentation.
    expect(source).not.toContain('never deletes a row');
    expect(source).toContain('export async function runMergeJob');
  });
});
