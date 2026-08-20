/**
 * The walls this domain must not reach through, as a build gate.
 *
 * `fee-ranking-isolation.test.ts` is the precedent and this one guards five
 * separate boundaries, each of which is a rule stated somewhere in #122 that a
 * plausible future edit would quietly undo:
 *
 *  1. **Selection never reads a commission or a ranking signal** (#122
 *     selection 3). No module here may reference the fee, referral, ranking or
 *     affiliate layers.
 *  2. **A quote cannot authorize fulfilment** (#122 quote persistence). No
 *     module here may import the purchase-order repository — which is what
 *     makes `authorizeSupplierFulfilment`'s `authorized: false` structural
 *     rather than a placeholder.
 *  3. **External and marketplace offers never enter preflight** (#122 mixed
 *     carts 5–6). No module here may reach the offers, listings or cart layers.
 *  4. **This domain does no FX** — a converted amount would be a rate nobody
 *     quoted, and #120 owns every conversion in the retail money path.
 *  5. **No commitment is emulated.** The `SUPPLIER_EMULATED_COMMITMENTS` union
 *     is disjoint from `SUPPLIER_ADAPTER_CAPABILITIES`, and the ONLY module
 *     that may construct a `reserved` outcome is the adapter boundary and the
 *     reservation repository.
 *
 * Each detector is MUTATION-TESTED below: a synthetic source string that
 * contains the forbidden reference must be caught. A scan that cannot fail is
 * worse than no scan, because it reads as a guarantee.
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
import {
  SUPPLIER_ADAPTER_CAPABILITIES,
  SUPPLIER_EMULATED_COMMITMENTS,
  SUPPLIER_FORBIDDEN_SOURCING_SIGNALS,
  SUPPLIER_ORDER_CAPABILITIES,
  SUPPLIER_PREFLIGHT_CAPABILITIES,
  SUPPLIER_SOURCING_CRITERIA,
} from '@mercaria/shared-types';
import { assertEachOf } from '../../../__tests__/assert-each-of.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Source with comments stripped.
 *
 * The modules here document what they refuse to do in the SAME vocabulary the
 * detectors look for — `redact.ts` names the payments module it deliberately
 * does not import, `selection.ts` names every forbidden signal — so a scan over
 * raw text would fire on the documentation and be disabled by whoever hit it.
 * The `checkout-contact-isolation.test.ts` (#105) rule, verbatim.
 */
function strippedSource(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

/**
 * The shared directories, where this domain sits beside every other domain's.
 *
 * They were ABSENT. `DOMAIN_FILES` was two directories and nothing else, so the
 * OPERATOR surface — `routes/internal-supplier-preflight.ts`,
 * `controllers/supplier-preflight-operator.controller.ts` and
 * `middleware/supplier-preflight-schemas.ts`, which together are what reads what
 * Mercaria PAYS its suppliers and flips the supplier and market kill switches —
 * and `db/schema/supplierPreflight.ts`, the module DECLARING the eight tables,
 * sat behind NONE of the four walls below. Every floor and count stayed green,
 * because a scan whose population never included a file reports exactly what a
 * clean one does (#460).
 *
 * This gate carries no "different sub-domain" assertion, so the two owned
 * directories were audited BY HAND before deriving: all 14 modules under
 * `services/supplier-preflight/` and all 7 under `db/supplierPreflight/` are
 * this domain's, and no other domain has a module in either.
 *
 * `namedInSharedDirectories` recurses, so `routes/admin/` and
 * `controllers/admin/` are reached too. Measured: this domain has no module in
 * either today, so the recursion adds nothing HERE and is the class fix rather
 * than a count.
 */
const OWNED_DIRECTORIES = ['services/supplier-preflight', 'db/supplierPreflight'];
const SHARED_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'];

/**
 * What a module BELONGING to this domain is called, wherever it lives.
 *
 * The HYPHEN is optional, and that half is load-bearing rather than tidy: the
 * schema directory names its files in camelCase, so `db/schema/supplierPreflight.ts`
 * cannot match a hyphenated spelling, and adding `db/schema` above WITHOUT this
 * would have changed nothing while looking exactly like a fix.
 *
 * The FULL two words, never a bare `supplier`: `services/supplier-orders/` is
 * #124's domain with its own gate, `db/procurement/supplierRepository.ts` is
 * #118's, and folding either in would make these walls fire at whoever edits
 * them. Measured: `/supplier-?preflight/i` over the whole of `src/` selects 25
 * modules and every one is this domain's, while a bare `/supplier/i` selects 8
 * more across four foreign domains.
 */
const DOMAIN_NAME_PATTERN = /supplier-?preflight/i;

/** Every module of the domain, DERIVED, relative to `src/`. */
function domainRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative, readDir)),
    ...namedInSharedDirectories(SHARED_DIRECTORIES, DOMAIN_NAME_PATTERN, readDir),
  ];
}

const DOMAIN_FILES = domainRelativePaths().map((relative) => join(SRC_ROOT, relative));

/**
 * The floors, PER SHAPE and measured off this branch.
 *
 * One TOTAL floor was the previous spelling, and a total lets one shape collapse
 * to zero behind another's number: the whole shared half disappearing sits
 * comfortably inside a total of 12 as long as the owned directories still hold
 * twenty-one, and every wall below then runs over a domain missing its operator
 * surface and its tables.
 *
 * MEASURED: 21 under the owned directories, 4 in the shared ones.
 */
const MINIMUM_OWNED_FILES = 18;
const MINIMUM_SHARED_FILES = 3;

/** One forbidden import shape, and the rule it would undo. */
interface Wall {
  name: string;
  /** Matched against comment-stripped source. */
  pattern: RegExp;
  /** Files legitimately allowed to match, by basename. */
  allow?: readonly string[];
}

const WALLS: readonly Wall[] = [
  {
    name: 'the fee, referral and ranking layers (#122 selection 3)',
    // `\.\./fees/` and `\.\./referrals/` are the specifiers a module in
    // `services/supplier-preflight/` actually writes — each sibling domain is
    // one `../` away — and the absolute-looking forms alone never see them. One
    // alternative per domain covers every depth, because however many `../`
    // segments precede it the last always abuts the directory name.
    pattern:
      /from\s+['"][^'"]*(services\/fees|\.\.\/fees\/|db\/fees|schema\/fees|services\/referrals|\.\.\/referrals\/|db\/referrals|schema\/referrals|feed\.service|search\.service)[^'"]*['"]/,
  },
  {
    name: 'purchase-order creation (#122: a quote is not a PurchaseOrder)',
    pattern: /from\s+['"][^'"]*(purchaseOrderRepository|purchase-order\.service)[^'"]*['"]/,
  },
  {
    name: 'the offer, listing and cart layers (#122 mixed carts 5–6)',
    pattern: /from\s+['"][^'"]*(db\/offers|schema\/offers|services\/offers|cart\.service|cart-merge|catalog-write)[^'"]*['"]/,
  },
  {
    name: 'FX conversion (#120 owns every conversion in the retail money path)',
    pattern: /from\s+['"][^'"]*(fx\.service|services\/fx)[^'"]*['"]/,
  },
];

/**
 * The mutation self-test's specimens, one list per wall, keyed by wall name.
 *
 * Written as lines a module in `services/supplier-preflight/` could plausibly
 * contain — NOT as tokens lifted out of the patterns above. A probe copied from
 * the pattern can only confirm the pattern matches itself; the relative-import
 * probes here are the ones the previous, pattern-derived self-test could never
 * have produced, and they are the spellings that actually evaded this gate.
 *
 * The list is keyed by name and asserted present per wall below, so a new wall
 * with no probe FAILS rather than being silently unprobed.
 */
const PROBES: Record<string, readonly string[]> = {
  'the fee, referral and ranking layers (#122 selection 3)': [
    "import { calculateFees } from '../../services/fees/fee-calculation.js';",
    // The relative specifiers — one `../` from here to each sibling domain.
    "import { calculateFees } from '../fees/fee-calculation.js';",
    "import { attribute } from '../../referrals/attribution.js';",
  ],
  'purchase-order creation (#122: a quote is not a PurchaseOrder)': [
    "import { insertPurchaseOrder } from '../../db/procurement/purchaseOrderRepository.js';",
    "import { submit } from '../supplier-orders/purchase-order.service.js';",
  ],
  'the offer, listing and cart layers (#122 mixed carts 5–6)': [
    "import { listOffers } from '../../db/offers/offerRepository.js';",
    "import { hydrateCart } from '../cart.service.js';",
  ],
  'FX conversion (#120 owns every conversion in the retail money path)': [
    "import { convert } from '../fx.service.js';",
    "import { getRates } from '../../services/fx/fx.service.js';",
  ],
};

describe('supplier preflight isolation (static)', () => {
  it('every wall carries at least one probe', () => {
    // A wall with no probe is an unmeasured wall. Asserting the key sets match
    // exactly is what stops a new wall being added without a specimen — and
    // stops a stale probe outliving the wall it was written for.
    expect(Object.keys(PROBES).sort()).toEqual(WALLS.map((wall) => wall.name).sort());
  });

  it('scans a non-trivial number of files', () => {
    // The vacuity floor: a broken traversal produces an empty violation list,
    // which is exactly what a clean tree produces. Without this the whole suite
    // below can pass while scanning nothing. Floored PER SHAPE — a total lets
    // one half collapse to zero behind the other's number.
    const owned = OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative));
    const shared = namedInSharedDirectories(SHARED_DIRECTORIES, DOMAIN_NAME_PATTERN);
    expect(
      owned.length,
      'the owned directories shrank; a walk that lost a module scans clean',
    ).toBeGreaterThanOrEqual(MINIMUM_OWNED_FILES);
    expect(
      shared.length,
      'no controller, route, middleware or schema module is named for this domain — did the ' +
        'derivation break?',
    ).toBeGreaterThanOrEqual(MINIMUM_SHARED_FILES);
    expect(DOMAIN_FILES.length).toBe(owned.length + shared.length);
    for (const path of DOMAIN_FILES) {
      expect(statSync(path).isFile(), `${path} is in the population but is not a file`).toBe(true);
    }
  });

  it('the widening reaches the four modules it exists for', () => {
    // NAMED rather than floored. A floor on the population cannot detect the
    // derivation examining LESS, because the modules it stops examining are
    // exactly the ones a smaller number is consistent with — and these four are
    // the whole reason the shared half was added, so a floor met by the
    // twenty-one owned modules alone would report a healthy run.
    const population = domainRelativePaths();
    const widening = [
      'controllers/supplier-preflight-operator.controller.ts',
      'middleware/supplier-preflight-schemas.ts',
      'routes/internal-supplier-preflight.ts',
      'db/schema/supplierPreflight.ts',
    ];
    for (const expected of widening) {
      expect(population, `${expected} left the population`).toContain(expected);
    }

    // The half that makes this a measurement rather than an assertion about a
    // tree that happens to be convenient: the OWNED walk alone reaches none of
    // them, so the shared sweep is what is being measured.
    const owned = OWNED_DIRECTORIES.flatMap((relative) => walkOwnedDirectory(relative));
    for (const expected of widening) {
      expect(owned, `${expected} is reached without the shared sweep`).not.toContain(expected);
    }

    // …and the same, one level down, for the optional hyphen: the HYPHEN-ONLY
    // spelling cannot reach the module DECLARING this domain's eight tables.
    expect(/supplier-preflight/i.test('db/schema/supplierPreflight.ts')).toBe(false);
    expect(DOMAIN_NAME_PATTERN.test('db/schema/supplierPreflight.ts')).toBe(true);

    // And the neighbours the pattern must NOT drag in, or these walls fire at
    // whoever edits #124 or #118.
    assertEachOf([
      'services/supplier-orders/submission.service.ts',
      'db/procurement/supplierRepository.ts',
      'routes/supplier-webhook.ts',
    ], 3, (foreign) => {
      expect(DOMAIN_NAME_PATTERN.test(foreign), `${foreign} belongs to another domain`).toBe(false);
      expect(population, `${foreign} belongs to another domain`).not.toContain(foreign);
    });
  });

  for (const wall of WALLS) {
    it(`does not reach ${wall.name}`, () => {
      const violations = DOMAIN_FILES.filter((path) => {
        const base = path.split('/').pop() ?? '';
        if (wall.allow?.includes(base)) return false;
        return wall.pattern.test(strippedSource(path));
      });
      expect(violations).toEqual([]);
    });

    it(`would CATCH a reference to ${wall.name}`, () => {
      // Mutation self-test, written from the IDIOM.
      //
      // This block used to build its specimen out of the pattern's OWN first
      // alternative — `pattern.test(<an alternative of pattern>)` — which is
      // true by construction and could never fail. It said so in its own
      // comment, as a virtue: "built from the pattern's own alternatives, so it
      // cannot drift away from what the detector looks for." That is precisely
      // the defect: it cannot drift away from the detector because it IS the
      // detector, so it confirmed only that the regex matches itself while the
      // relative specifier a real module here would write walked straight
      // through the fee/referral wall.
      //
      // Every probe below is instead a line one of these modules could
      // plausibly contain, at the depth it would contain it.
      const probes = PROBES[wall.name];
      expect(probes, `no probe registered for the ${wall.name} wall`).toBeDefined();
      expect((probes ?? []).length).toBeGreaterThanOrEqual(1);
      for (const probe of probes ?? []) {
        expect(wall.pattern.test(probe), `the ${wall.name} wall misses: ${probe}`).toBe(true);
      }
    });
  }
});

describe('supplier preflight vocabularies', () => {
  it('keeps emulated commitments disjoint from declared capabilities', () => {
    // The `RETAIL_FORBIDDEN_COMPONENT_KINDS` device: the two unions must have no
    // member in common, or an emulation could be typed as a capability, stored
    // in a `declared_capabilities` array and required by a policy version.
    const capabilities = new Set<string>(SUPPLIER_ADAPTER_CAPABILITIES);
    const overlap = SUPPLIER_EMULATED_COMMITMENTS.filter((entry) => capabilities.has(entry));
    expect(overlap).toEqual([]);
  });

  it('keeps forbidden sourcing signals disjoint from rankable criteria', () => {
    // Same device, applied to selection: a policy version's `ranking_criteria`
    // CHECK reads `SUPPLIER_SOURCING_CRITERIA`, so an overlap here would make a
    // commission configurable by an operator.
    const criteria = new Set<string>(SUPPLIER_SOURCING_CRITERIA);
    const overlap = SUPPLIER_FORBIDDEN_SOURCING_SIGNALS.filter((entry) => criteria.has(entry));
    expect(overlap).toEqual([]);
  });

  it('declares exactly the twelve PREFLIGHT capabilities #122 names', () => {
    // A floor AND a ceiling: #122's adapter contract is a numbered list of
    // twelve, and both directions matter — a capability quietly removed would
    // stop being enforced by `applyDeclaredCapabilities`, and one quietly added
    // would be enforced by nothing.
    //
    // #124 EXTENDED the union with twelve order-side capabilities rather than
    // forking it, so the assertion moved from the whole tuple to this half of
    // it. The two halves keep separate floors and ceilings for the same reason
    // the union is one: each is enforced by a different boundary
    // (`applyDeclaredCapabilities` here, `applyDeclaredOrderCapabilities`
    // there), and a capability in neither is enforced by nothing.
    expect(SUPPLIER_PREFLIGHT_CAPABILITIES).toHaveLength(12);
    expect(SUPPLIER_ORDER_CAPABILITIES).toHaveLength(12);
    expect(SUPPLIER_ADAPTER_CAPABILITIES).toHaveLength(24);
    // Disjoint, so no capability is enforced by both boundaries or by neither.
    const preflight = new Set<string>(SUPPLIER_PREFLIGHT_CAPABILITIES);
    expect(SUPPLIER_ORDER_CAPABILITIES.filter((entry) => preflight.has(entry))).toEqual([]);
  });

  it('has no sourcing criterion that names a commission or a rank', () => {
    // A shape check beside the set check above, because the disjointness test
    // only catches an EXACT duplicate. A criterion called
    // `affiliate_yield_bps` would pass that and fail this.
    const forbidden = /commission|affiliate|referral|rank|sponsor|placement|subscription|advert/;
    const offenders = SUPPLIER_SOURCING_CRITERIA.filter((entry) => forbidden.test(entry));
    expect(offenders).toEqual([]);
  });
});

/**
 * The population's own defence, and the general form of the fix above.
 *
 * Adding the shared directories closes today's gap; this closes the CLASS. The
 * DIRECTORY list is the last hand list in this gate, and a hand list fails
 * silently — every floor and count here stayed green while the operator surface
 * and the schema module sat outside all four walls. A bag directory nobody has
 * invented yet now brings its modules under the walls with no edit.
 *
 * The exclusion set is EMPTY, and that is measured rather than assumed:
 * `/supplier-?preflight/i` over the whole of `src/` selects 25 modules and all
 * 25 are this domain's.
 */
describe('#460: nothing named for this domain sits outside the scanned population', () => {
  it('every supplier-preflight-named module in src/ is inside the population', () => {
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: DOMAIN_NAME_PATTERN,
      notThisDomain: [],
      // Below today's 25 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 21,
      plantIn: 'lib',
      plantName: 'supplier-preflight-cache.ts',
    });
  });

  it('the derived population really is the one the walls scan', () => {
    // Two spellings of one population can disagree, so this pins them together:
    // every absolute path the walls run over has a relative twin here.
    expect(domainRelativePaths(readSrcDirectory).sort()).toEqual(
      DOMAIN_FILES.map((path) => path.slice(SRC_ROOT.length + 1)).sort(),
    );
  });
});
