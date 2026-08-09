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
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOMAIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

/** Every source file in the merchant-claim domain, tests excluded. */
function domainSourceFiles(): string[] {
  return readdirSync(DOMAIN_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(DOMAIN_ROOT, entry.name));
}

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
function strippedSource(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('a merchant claim cannot create a brand relationship (issue acceptance 6)', () => {
  it('no merchant-claim module references the relationship or brand layer', () => {
    const files = domainSourceFiles();
    // The vacuity floor: the domain has six modules today, and a traversal that
    // finds fewer has broken rather than passed.
    expect(files.length, 'the merchant-claim domain looks empty — did it move?').toBeGreaterThan(4);

    for (const file of files) {
      const source = strippedSource(file);
      expect(source.length, `${file} looks empty — did it move?`).toBeGreaterThan(200);
      expect(
        RELATIONSHIP_REFERENCE.test(source),
        `${file} references the relationship/brand layer; claiming must not be able to assert one`,
      ).toBe(false);
    }
  });

  it('no merchant-claim module grants operational access', () => {
    for (const file of domainSourceFiles()) {
      const source = strippedSource(file);
      expect(
        OPERATIONAL_GRANT_REFERENCE.test(source),
        `${file} reaches native-store linkage or store membership; #84 owns that, not #83`,
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
