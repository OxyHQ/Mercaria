/**
 * The structural walls #90 is built on, asserted rather than promised.
 *
 * Six gates, each answering something the issue states as a prohibition. They
 * follow the defences the other domains' gates use (`~/Oxy/AGENTS.md` metro-gate
 * rules): every scan carries a VACUITY FLOOR — a moved or emptied module fails
 * the gate instead of silently shrinking it — and a MUTATION SELF-TEST, so a
 * rotted regex cannot pass by matching nothing.
 *
 *  1. **A catalogue image is not condition evidence** (#90 acceptance 4). The
 *     provenance vocabulary and the forbidden list are DISJOINT, and no table in
 *     the domain has a column that could hold a canonical image reference.
 *  2. **An unrefined assertion cannot carry a claim-bearing key** (#90 migration
 *     rule 2). `used_like_new` is not in `UNREFINED_CONDITION_KEYS`, and the
 *     database CHECK is rendered from that same tuple.
 *  3. **Category-specific facts stay in #94's registry.** No module here defines
 *     a column or a tuple member for battery health, activation lock or garment
 *     alterations.
 *  4. **Ranking cannot read the condition domain** (#74 owns ranking). The
 *     `fee-ranking-isolation.test.ts` precedent.
 *  5. **The condition domain cannot read the fee, referral or payment domains.**
 *     A module that cannot see a commission cannot let one influence how an item
 *     is described.
 *  6. **No mapping module can write a taxonomy key from a sub-floor
 *     confidence** (#90 evidence rule 6). The only literal comparison against
 *     the floor is the documented one, and no module hard-codes a competing
 *     number.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
import {
  CONDITION_ASSERTIONS,
  CONDITION_MAPPING_CONFIDENCE_FLOOR,
  CONDITION_PHOTO_PROVENANCES,
  CONDITION_REGISTRY_DELEGATED_FACT_KEYS,
  FORBIDDEN_CONDITION_PHOTO_PROVENANCES,
  ITEM_CONDITION_KEYS,
  UNREFINED_CONDITION_ASSERTIONS,
  UNREFINED_CONDITION_KEYS,
} from '@mercaria/shared-types';
import {
  conditionCategoryPolicies,
  conditionMappingRulesets,
  conditionSourceMappings,
  listingConditionDetails,
  listingConditionPhotos,
  listingConditionRevisions,
} from '../../../db/schema/condition.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Every module of the condition domain.
 *
 * A new one belongs on this list, and the vacuity floor below is what forces
 * whoever adds one to look here rather than quietly landing a module no gate
 * scans.
 */
function conditionModulesUnder(relative: string): string[] {
  return readdirSync(join(SRC_ROOT, relative))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `${relative}/${name}`)
    .sort();
}

/**
 * Every module of the condition domain — WALKED, not listed.
 *
 * A hand-maintained array is complete on the day it is written and silently
 * incomplete the day somebody adds a file, and the file it then skips is the
 * one nobody has reviewed. The exact-count assertion this replaced pinned the
 * ARRAY's length, which a new source file does not change, so it could never
 * detect the omission it looked like it was guarding against.
 *
 * `db/schema/condition.ts` is named individually because it is the one member
 * that lives in a directory this domain does not own.
 */
const CONDITION_DOMAIN_PATHS = [
  ...conditionModulesUnder('services/condition'),
  ...conditionModulesUnder('db/condition'),
  'db/schema/condition.ts',
];

/** The six tables, with their SQL names so a failure reads as a table name. */
const CONDITION_TABLES = [
  ['listing_condition_details', listingConditionDetails],
  ['listing_condition_photos', listingConditionPhotos],
  ['listing_condition_revisions', listingConditionRevisions],
  ['condition_mapping_rulesets', conditionMappingRulesets],
  ['condition_source_mappings', conditionSourceMappings],
  ['condition_category_policies', conditionCategoryPolicies],
] as const;

/**
 * Modules that decide what a shopper SEES first — the ranking surface #74 owns.
 *
 * If any of these could read the condition domain, "a condition is a
 * description" and "a condition is a placement input" would be one hop apart,
 * and nothing in the code would say which one was intended.
 */
const RANKING_SURFACE_PATHS = [
  'services/feed.service.ts',
  'services/search.service.ts',
  'services/collection.service.ts',
  'db/merchandising/collectionRules.ts',
];

function read(relative: string): string {
  return readFileSync(join(SRC_ROOT, relative), 'utf8');
}

/**
 * Source with comments removed.
 *
 * Every module in this domain DOCUMENTS what it refuses to do, in the same
 * vocabulary the detectors look for — `condition-mapping.service.ts` says
 * "never upgraded" and `condition.ts` names every forbidden provenance. Scanning
 * raw text would fail on the prose, so the reachability detectors read code
 * only. The two gates that must see prose (the copy scan below) say so.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

describe('#90 gate 1 — a catalogue image can never be condition evidence', () => {
  it('the seller-owned and forbidden provenance vocabularies are DISJOINT', () => {
    const forbidden = new Set<string>(FORBIDDEN_CONDITION_PHOTO_PROVENANCES);
    const overlap = CONDITION_PHOTO_PROVENANCES.filter((value) => forbidden.has(value));

    expect(overlap).toEqual([]);
    // Vacuity: an emptied tuple would make the intersection trivially empty.
    expect(CONDITION_PHOTO_PROVENANCES.length).toBeGreaterThanOrEqual(2);
    expect(FORBIDDEN_CONDITION_PHOTO_PROVENANCES.length).toBeGreaterThanOrEqual(5);
  });

  it('the disjointness check would FAIL if a forbidden value were admitted', () => {
    // The mutation self-test: seed the exact overlap the gate exists to catch.
    const mutated: readonly string[] = [...CONDITION_PHOTO_PROVENANCES, 'stock_photo'];
    const forbidden = new Set<string>(FORBIDDEN_CONDITION_PHOTO_PROVENANCES);
    expect(mutated.filter((value) => forbidden.has(value))).toEqual(['stock_photo']);
  });

  it('no condition table has a column that could reference a canonical image', () => {
    const offenders: string[] = [];
    for (const [table, definition] of CONDITION_TABLES) {
      for (const property of Object.keys(getTableColumns(definition))) {
        if (/canonical|catalogImage|stockPhoto|productImage/i.test(property)) {
          offenders.push(`${table}.${property}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the photo table records the three facts #90 evidence rule 3 asks for', () => {
    // The positive control for the gate above: it must not be passing because
    // the table is empty of columns. Ownership, upload time and moderation
    // state are what make a row evidence rather than a picture.
    const columns = Object.keys(getTableColumns(listingConditionPhotos));
    expect(columns).toEqual(
      expect.arrayContaining([
        'uploadedByOxyUserId',
        'uploadedAt',
        'moderationState',
        'provenance',
      ]),
    );
  });
});

describe('#90 gate 2 — an unrefined assertion cannot carry a claim', () => {
  it('`used_like_new` is NOT a key a migration or a v1 client may assert', () => {
    expect(UNREFINED_CONDITION_KEYS).not.toContain('used_like_new');
    expect(UNREFINED_CONDITION_KEYS).not.toContain('refurbished_manufacturer');
    expect(UNREFINED_CONDITION_KEYS).not.toContain('refurbished_seller');
    expect(UNREFINED_CONDITION_KEYS).not.toContain('open_box');
    // Vacuity: an empty tuple would satisfy every assertion above and would make
    // the CHECK it renders refuse EVERY migrated row instead of the wrong ones.
    expect(UNREFINED_CONDITION_KEYS).toEqual(['new', 'used_good']);
  });

  it('both unrefined assertions are real members of the assertion set', () => {
    // A tuple member the CHECK is rendered from that is not in the column's own
    // enum would make the constraint unsatisfiable rather than restrictive.
    for (const assertion of UNREFINED_CONDITION_ASSERTIONS) {
      expect(CONDITION_ASSERTIONS).toContain(assertion);
    }
    expect(UNREFINED_CONDITION_ASSERTIONS.length).toBe(2);
  });

  it('every unrefined key is a real taxonomy key', () => {
    for (const key of UNREFINED_CONDITION_KEYS) {
      expect(ITEM_CONDITION_KEYS).toContain(key);
    }
  });
});

describe('#90 gate 3 — category-specific facts stay in #94’s registry', () => {
  it('no condition table has a column for a delegated fact', () => {
    const offenders: string[] = [];
    for (const [table, definition] of CONDITION_TABLES) {
      for (const property of Object.keys(getTableColumns(definition))) {
        const normalized = property.replace(/[^a-z]/gi, '').toLowerCase();
        for (const fact of CONDITION_REGISTRY_DELEGATED_FACT_KEYS) {
          if (normalized.includes(fact.replace(/_/g, ''))) {
            offenders.push(`${table}.${property} (delegated to #94: ${fact})`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(CONDITION_REGISTRY_DELEGATED_FACT_KEYS.length).toBeGreaterThanOrEqual(5);
  });

  it('the delegated-fact detector FIRES on a seeded column name', () => {
    const normalized = 'batteryHealthPercentage'.replace(/[^a-z]/gi, '').toLowerCase();
    const hit = CONDITION_REGISTRY_DELEGATED_FACT_KEYS.some((fact) =>
      normalized.includes(fact.replace(/_/g, '')),
    );
    expect(hit).toBe(true);
  });
});

describe('#90 gate 4 — ranking cannot read the condition domain', () => {
  /**
   * What reaching this domain looks like from a ranking surface: an import of a
   * condition module, or a reference to one of its table objects.
   *
   * `search.service` and `collectionRules` legitimately FILTER on
   * `listings.condition`, which is a column on a table they already read — that
   * is the issue's own "search and ranking use condition groups explicitly"
   * (propagation rule 4), and it is a different thing from reaching the
   * evidence, the disclosures or the mapping rules behind it.
   */
  const DOMAIN_REACH =
    /from ['"][^'"]*(?:services\/condition|db\/condition|schema\/condition)[^'"]*['"]|listingConditionPhotos|listingConditionRevisions|conditionSourceMappings|conditionMappingRulesets/;

  it('no ranking surface imports a condition module or names its tables', () => {
    const offenders: string[] = [];
    for (const path of RANKING_SURFACE_PATHS) {
      const source = stripComments(read(path));
      if (DOMAIN_REACH.test(source)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
    // Vacuity: a renamed file would make this loop scan nothing.
    expect(RANKING_SURFACE_PATHS.length).toBe(4);
    for (const path of RANKING_SURFACE_PATHS) {
      expect(read(path).length).toBeGreaterThan(500);
    }
  });

  it('the reach detector FIRES on a seeded import', () => {
    expect(
      DOMAIN_REACH.test("import { x } from '../services/condition/condition-write.service.js';"),
    ).toBe(true);
    expect(DOMAIN_REACH.test('const rows = await db.select().from(listingConditionPhotos);')).toBe(
      true,
    );
  });
});

describe('#90 gate 5 — the condition domain cannot read commercial standing', () => {
  // `\.\./(fees|referrals|payments)/` are the specifiers a module in
  // `services/condition/` actually writes — each of those domains is one `../`
  // away — and the absolute-looking forms alone never see them. One alternative
  // per domain covers every depth, because however many `../` segments precede
  // it the last always abuts the directory name.
  const COMMERCIAL_REACH =
    /from ['"][^'"]*(?:services\/fees|\.\.\/fees\/|db\/fees|schema\/fees|services\/referrals|\.\.\/referrals\/|db\/referrals|services\/payments|\.\.\/payments\/|db\/payments)[^'"]*['"]/;

  it('no condition module imports the fee, referral or payment domains', () => {
    const offenders: string[] = [];
    for (const path of CONDITION_DOMAIN_PATHS) {
      const source = stripComments(read(path));
      if (COMMERCIAL_REACH.test(source)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
    // A vacuity floor rather than an exact count: the set is walked now, so it
    // GROWS when the domain does, and an exact number would fail every honest
    // addition while still not detecting the file a hand-maintained list omits.
    // The floor is what stops a broken walk from reading as a clean scan.
    expect(CONDITION_DOMAIN_PATHS.length).toBeGreaterThanOrEqual(9);
    expect(CONDITION_DOMAIN_PATHS.filter((path) => path.startsWith('services/'))).not.toEqual([]);
    expect(CONDITION_DOMAIN_PATHS.filter((path) => path.startsWith('db/condition/'))).not.toEqual(
      [],
    );
    for (const path of CONDITION_DOMAIN_PATHS) {
      expect(read(path).length).toBeGreaterThan(500);
    }
  });

  it('the commercial-reach detector FIRES on a seeded import', () => {
    expect(
      COMMERCIAL_REACH.test("import { feeFor } from '../../services/fees/fee.service.js';"),
    ).toBe(true);
    // The RELATIVE specifiers, which are what a module in `services/condition/`
    // would actually write: each of the three forbidden domains is one `../`
    // away. The absolute-looking probe above passes against a pattern that
    // misses all three, which is why it kept this wall green.
    expect(COMMERCIAL_REACH.test("import { feeFor } from '../fees/fee-calculation.js';")).toBe(true);
    expect(
      COMMERCIAL_REACH.test("import { paymentService } from '../payments/payment.service.js';"),
    ).toBe(true);
    expect(
      COMMERCIAL_REACH.test("import { attribute } from '../../referrals/attribution.js';"),
    ).toBe(true);
    // Neighbours that merely share a prefix are not those domains.
    expect(COMMERCIAL_REACH.test("import { x } from '../fees-display/format.js';")).toBe(false);
  });
});

describe('#90 gate 6 — a sub-floor mapping can never carry a taxonomy key', () => {
  it('exactly one module compares against the confidence floor, by NAME', () => {
    const mapping = stripComments(read('services/condition/condition-mapping.service.ts'));
    expect(mapping).toContain('CONDITION_MAPPING_CONFIDENCE_FLOOR');

    // The number itself appears nowhere in the domain's code: a second literal
    // is how the service and the CHECK start disagreeing about where the line
    // is, and the disagreement is invisible until a real feed sits on it.
    const literal = String(CONDITION_MAPPING_CONFIDENCE_FLOOR);
    const offenders = CONDITION_DOMAIN_PATHS.filter((path) => {
      if (path === 'db/schema/condition.ts') return false; // renders the CHECK from the constant
      return stripComments(read(path)).includes(literal);
    });
    expect(offenders).toEqual([]);
  });

  it('the schema renders the CHECK from the shared constant, not a literal', () => {
    const schema = stripComments(read('db/schema/condition.ts'));
    expect(schema).toContain('CONDITION_MAPPING_CONFIDENCE_FLOOR');
    const offers = stripComments(read('db/schema/offers.ts'));
    expect(offers).toContain('CONDITION_MAPPING_CONFIDENCE_FLOOR_SQL');
  });

  it('the literal detector FIRES on a seeded hard-coded floor', () => {
    expect(`if (rule.confidence < ${CONDITION_MAPPING_CONFIDENCE_FLOOR}) return;`).toContain(
      String(CONDITION_MAPPING_CONFIDENCE_FLOOR),
    );
  });
});
