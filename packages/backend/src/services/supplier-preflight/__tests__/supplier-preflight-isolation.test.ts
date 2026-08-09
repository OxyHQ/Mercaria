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
    pattern: /from\s+['"][^'"]*(services\/fees|db\/fees|schema\/fees|services\/referrals|db\/referrals|schema\/referrals|feed\.service|search\.service)[^'"]*['"]/,
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

describe('supplier preflight isolation (static)', () => {
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
      // Mutation self-test: the detector must fire on a source that really does
      // import the forbidden thing. Built from the pattern's own alternatives,
      // so it cannot drift away from what the detector looks for.
      const [, alternatives] = /\(([^)]*)\)/.exec(wall.pattern.source) ?? [];
      // The alternatives are REGEX source, so `\/` and `\.` carry a backslash
      // the specimen must not. Every escape in these patterns is a literal
      // character escaped, so dropping the backslash recovers the text — and a
      // self-test that silently specimens the wrong string is exactly the
      // "check that cannot fail" this whole block exists to avoid, which is why
      // the specimen is built from the pattern rather than typed beside it.
      const first = (alternatives?.split('|')[0] ?? '').replace(/\\(.)/g, '$1');
      expect(first).not.toEqual('');
      expect(wall.pattern.test(`import { x } from '../../${first}.js';`)).toBe(true);
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
