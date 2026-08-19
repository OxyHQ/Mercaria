/**
 * Issue acceptance 6, asserted STRUCTURALLY: claiming "Apple Store" creates no
 * Apple official-channel relationship.
 *
 * A behavioural fixture could only show that one particular claim did not
 * write one. This shows that no claim CAN: nothing in the merchant-claim
 * domain imports the relationship or brand vocabulary, names its tables, or
 * reaches the modules that own them — and code that cannot reach a table
 * cannot write to it, which is a stronger statement than any fixture makes.
 *
 * The scanner carries the metro-gate defences (`~/Oxy/AGENTS.md` §"Metro
 * bundle freshness"): a vacuity floor, so a moved or emptied file fails the
 * gate rather than shrinking it silently, and a mutation self-test, so a
 * broken detector cannot pass by matching nothing.
 *
 * It also scans for the OPERATIONAL grants a claim must not make — store
 * membership and native-store linkage (ADR 0002 D4) — for the same reason:
 * #84 owns the link, and a claim that could write one would be granting
 * inventory, payouts and member access as a side effect of proving a domain.
 *
 * ## The population, and what it used to be (#460)
 *
 * It was `readdirSync(services/merchant-claims)` ONE LEVEL DEEP and nothing
 * else — seven modules. The other SIX of this domain's thirteen were behind
 * neither wall: both controllers (including the operator surface that DECIDES
 * a claim), the repository, the request schemas, `routes/merchant-claims.ts`
 * and `db/schema/merchantClaims.ts`.
 *
 * `db/schema/merchantClaims.ts` is the one to read. It is where the two
 * partial unique indexes carrying this domain's security properties are
 * DECLARED — `(merchant_id) WHERE state='verified'` is acceptance 4 — and it
 * is exactly the file in which a `commerce_relationships` foreign key would be
 * written if anybody ever decided a verified claim should imply a badge. It
 * was behind no wall at all.
 *
 * All six were measured against BOTH detectors, on comment-stripped source,
 * before being added: zero hits. So this widens the coverage rather than
 * building a wall around code that was already violating one.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
 * The hyphen is optional because `db/schema/merchantClaims.ts` is camelCase,
 * and the plural is optional because `middleware/merchant-claim-schemas.ts`
 * is singular. Both halves are asserted below rather than assumed — a
 * widening that changes nothing looks exactly like a fix, and the narrow
 * spelling is asserted NOT to reach what the wide one adds.
 */
const CLAIM_NAME_PATTERN = /merchant-?claims?/i;

/** The two directories this domain owns outright. */
const OWNED_DIRECTORIES = ['services/merchant-claims', 'db/merchant-claims'] as const;

/** The flat directories a module of this domain lives in under a domain NAME. */
const SHARED_DIRECTORIES = ['routes', 'controllers', 'middleware', 'db/schema'] as const;

/** Every module of the merchant-claim domain, enumerated from disk. */
function domainRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    // RECURSIVE, where this read one directory level.
    ...OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative, readDir)),
    ...namedInSharedDirectories(SHARED_DIRECTORIES, CLAIM_NAME_PATTERN, readDir),
  ];
}

/**
 * What reaching #55's relationship layer looks like from any direction: an
 * import of a relationship module, a reference to a brand or relationship
 * table object, or a raw-SQL mention of the tables themselves.
 *
 * `brands` is in here as well as `commerce_relationships`, because ADR 0002
 * D10's badges are relationships BETWEEN a merchant and a brand — a claim
 * module that could read the brand table is one refactor away from asserting
 * one.
 *
 * Case-INSENSITIVE, so `insertCommerceRelationship` and `commerce_relationship`
 * are one rule rather than two spellings to keep in step.
 */
const RELATIONSHIP_REFERENCE =
  /commerce_relationship|commerceRelationship|relationship_evidence|relationshipEvidence|official_channel|officialChannel|authorized_reseller|authorizedReseller|\bbrands\b|brandRepository|brand\.service/i;

/**
 * What granting OPERATIONAL access looks like. `native_store_links` is #84's
 * to write; `store_members` is the native store's own.
 */
const OPERATIONAL_GRANT_REFERENCE =
  /native_store_links|nativeStoreLink|native-store-link\.service|insertStoreMember|store_members\b|storeMembers\b/i;

/**
 * The gate is about what the code can REACH, so comments are stripped first.
 *
 * That is not leniency, it is the point: every module in this domain explains
 * in prose what it must not do — "an Official store badge is a
 * `commerce_relationships` row owned by #55", "#84 owns `native_store_links`"
 * — and a scanner that forbade those sentences would push the reasoning out of
 * the files where a reviewer actually reads it, which is the opposite of what
 * this gate is for.
 */
function strippedSource(relative: string): string {
  return readFileSync(join(SRC_ROOT, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('a merchant claim cannot create a brand relationship (issue acceptance 6)', () => {
  it('no merchant-claim module references the relationship or brand layer', () => {
    const files = domainRelativePaths();
    // The vacuity floor: the domain has thirteen modules today, and a traversal
    // that finds fewer has broken rather than passed.
    expect(files.length, 'the merchant-claim domain looks empty — did it move?').toBeGreaterThan(9);

    for (const relative of files) {
      const source = strippedSource(relative);
      expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        RELATIONSHIP_REFERENCE.test(source),
        `${relative} references the relationship/brand layer; claiming must not be able to assert one`,
      ).toBe(false);
    }
  });

  it('no merchant-claim module grants operational access', () => {
    for (const relative of domainRelativePaths()) {
      const source = strippedSource(relative);
      expect(
        OPERATIONAL_GRANT_REFERENCE.test(source),
        `${relative} reaches native-store linkage or store membership; #84 owns that, not #83`,
      ).toBe(false);
    }
  });

  it('detects a seeded violation (the detector is not vacuous)', () => {
    // Mutation self-test: a broken regex would pass both assertions above by
    // matching nothing at all. These are the exact strings the gate exists to
    // catch, and each must be seen.
    expect(RELATIONSHIP_REFERENCE.test("import { x } from '../commerce-graph/brand.service.js'")).toBe(
      true,
    );
    expect(RELATIONSHIP_REFERENCE.test('await insertCommerceRelationship(tx, {...})')).toBe(true);
    expect(RELATIONSHIP_REFERENCE.test("db.insert(brands).values({ name: 'Apple' })")).toBe(true);
    expect(OPERATIONAL_GRANT_REFERENCE.test('await insertNativeStoreLink(tx, {...})')).toBe(true);
    expect(OPERATIONAL_GRANT_REFERENCE.test('db.insert(storeMembers).values({})')).toBe(true);
  });
});

describe('the population the two walls above are applied to (#460)', () => {
  it('nothing naming this domain sits outside it', () => {
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: CLAIM_NAME_PATTERN,
      // Deliberately empty, and the assertion is what makes that a measurement
      // rather than a hope: every one of the thirteen modules the whole-tree
      // sweep finds is this domain's, so there is nothing to excuse. A module
      // named for merchant claiming that belongs to somebody else goes red here
      // rather than being quietly excused.
      notThisDomain: [],
      // Below today's 13 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 9,
      plantIn: 'lib',
      plantName: 'merchant-claims-cache.ts',
    });
  });

  it('the six modules the one-level population could not reach are in it', () => {
    // An identity assertion, not a floor. These are exactly what
    // `readdirSync(services/merchant-claims)` missed, and a floor set below 13
    // is met without any of them.
    const population = domainRelativePaths();
    for (const named of [
      'controllers/merchant-claims.controller.ts',
      'controllers/merchant-claims-operator.controller.ts',
      'db/merchant-claims/merchantClaimRepository.ts',
      'db/schema/merchantClaims.ts',
      'middleware/merchant-claim-schemas.ts',
      'routes/merchant-claims.ts',
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
    const shared = namedInSharedDirectories(SHARED_DIRECTORIES, CLAIM_NAME_PATTERN);
    expect(owned.length, 'the owned-directory walk reached nothing').toBeGreaterThanOrEqual(6);
    expect(shared.length, 'the shared-directory name sweep reached nothing').toBeGreaterThanOrEqual(
      4,
    );
  });

  it('both halves of the NAME pattern are load-bearing', () => {
    // A widening that changes nothing looks exactly like a fix. `-?` and `s?`
    // each reach modules the narrow spelling does not, and the narrow spelling
    // is asserted NOT to reach them — otherwise this measures a tree that
    // happens to be convenient rather than the widening itself.
    const camelCase = 'db/schema/merchantClaims.ts';
    const singular = 'middleware/merchant-claim-schemas.ts';
    expect(CLAIM_NAME_PATTERN.test(camelCase)).toBe(true);
    expect(CLAIM_NAME_PATTERN.test(singular)).toBe(true);
    expect(/merchant-claims/.test(camelCase), 'the hyphenated spelling already matched').toBe(false);
    expect(/merchant-claims/.test(singular), 'the plural spelling already matched').toBe(false);
    expect(domainRelativePaths()).toContain(camelCase);
    expect(domainRelativePaths()).toContain(singular);
  });
});
