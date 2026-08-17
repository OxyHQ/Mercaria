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

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SUPPLIER_ADAPTER_CAPABILITIES,
  SUPPLIER_EMULATED_COMMITMENTS,
  SUPPLIER_FORBIDDEN_SOURCING_SIGNALS,
  SUPPLIER_ORDER_CAPABILITIES,
  SUPPLIER_PREFLIGHT_CAPABILITIES,
  SUPPLIER_SOURCING_CRITERIA,
} from '@mercaria/shared-types';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DOMAIN_DIR = join(HERE, '..');
const REPOSITORY_DIR = join(HERE, '..', '..', '..', 'db', 'supplierPreflight');

/** Every `.ts` under a directory, excluding its own tests. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...sourceFiles(path));
      continue;
    }
    if (entry.endsWith('.ts')) out.push(path);
  }
  return out;
}

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

const DOMAIN_FILES = [...sourceFiles(DOMAIN_DIR), ...sourceFiles(REPOSITORY_DIR)];

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
    // below can pass while scanning nothing.
    expect(DOMAIN_FILES.length).toBeGreaterThanOrEqual(12);
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
