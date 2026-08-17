/**
 * The walls around zero-profit cost reconciliation (#128).
 *
 * Static scans, following `fee-ranking-isolation.test.ts` and
 * `retail-pilot-isolation.test.ts`: each wall names what must be unreachable, is
 * applied to a REAL file set with an anti-vacuity floor, and is MUTATION-TESTED
 * against a synthetic source that genuinely contains what it forbids — so a
 * detector that stopped matching fails HERE rather than passing silently
 * forever.
 *
 * The walls are the mechanical half of three sentences in the issue that would
 * otherwise be intentions:
 *
 *  - "Never infer final cost from current catalog price after the order."
 *  - "Never revalue historical order truth using today's rate."
 *  - "There is no `retail_margin_revenue`, markup-revenue or equivalent
 *    planned-profit account for `mercaria_retail`."
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import {
  RETAIL_ACCOUNTING_COMPONENTS,
  RETAIL_FORBIDDEN_ACCOUNTING_COMPONENTS,
  RETAIL_FORBIDDEN_ACCOUNTING_COMPONENT_LABELS,
  RETAIL_RECONCILIATION_FORBIDDEN_DTO_FIELDS,
  RETAIL_RECONCILIATION_METRIC_KEYS,
  RETAIL_RECONCILIATION_OPERATOR_ACTIONS,
} from '@mercaria/shared-types';
import * as schema from '../../../db/schema/index.js';
import {
  assertNoForbiddenAccountingOutput,
  detectForbiddenAccountingOutputs,
} from '../forbidden-outputs.js';
import { reachesPackageModule } from '../../../__tests__/package-barrel-symbols.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE_DIR = join(HERE, '..');
const REPOSITORY_DIR = join(HERE, '..', '..', '..', 'db', 'retailReconciliation');
const SCHEMA_FILE = join(HERE, '..', '..', '..', 'db', 'schema', 'retailReconciliation.ts');
const ROUTE_FILE = join(HERE, '..', '..', '..', 'routes', 'internal-retail-reconciliation.ts');
const CONTROLLER_FILE = join(
  HERE,
  '..',
  '..',
  '..',
  'controllers',
  'retail-reconciliation-operator.controller.ts',
);

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
 * Load-bearing rather than tidy: these modules DOCUMENT what they refuse to do,
 * in the same vocabulary the detectors look for. A scan over raw source would
 * fire on the docblock explaining why `fx.service` is out of reach, and the
 * "fix" would be to delete the explanation.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

interface Wall {
  name: string;
  files: string[];
  pattern: RegExp;
  /** A source that genuinely contains what the pattern forbids. */
  probe: string;
  /**
   * The same wall asked of a PACKAGE barrel, matched against the OWNING module
   * of each imported symbol (#582).
   *
   * `pattern` above requires a directory segment before the module it forbids,
   * so it matches `from '../referrals/attribution.service.js'` and matches
   * NOTHING in `from '@mercaria/shared-types'` — and nothing in this repository
   * writes any other form, because importing a package by name is how a package
   * is consumed. #581's chokepoint cannot close that: there is no allow-list and
   * no "import from the owner" alternative that is not a deep import into
   * another package's internals. So the predicate here is symbol-level.
   *
   * Deliberately set on ONE wall. A wall is only widened to a package module
   * where reaching that module IS the thing forbidden, and measured across the
   * twelve gates a package barrel defeats, FIVE would BREAK if widened
   * mechanically: `navigation-isolation` forbids ranking and its domain already
   * imports `shared-types/src/offer-ranking.ts`; `pickup-isolation` forbids
   * analytics and already imports `shared-types/src/analytics.ts`; likewise
   * `compatibility`, `awin` and `feed-import` on their own contract modules.
   * Widening a deliberately narrow wall is the census that pushes you toward the
   * hazard (`docs/isolation-gates.md`).
   *
   * The FX wall two entries above is left alone for a different reason:
   * `shared-types/src/fx.ts` exports exactly one type, `FxRates`, while the
   * `FxRateSnapshot` this domain is built on lives in `money.ts`. So converting
   * it would break nothing today and would still be a wall about a live rate
   * LOOKUP being restated as a wall about a DTO — a decision for whoever owns
   * #128, not a mechanical follow-on from #582.
   *
   * ONE optional object rather than two optional fields, because this backend
   * compiles with `strict: false`: a pattern set without its probe would
   * type-check, and the mutation self-test would then hand `undefined` to the
   * resolver instead of proving the wall catches the barrel form.
   */
  packageWall?: {
    /** Matched against the OWNING module path of each imported symbol. */
    modules: RegExp;
    /** A source importing a forbidden module's symbol THROUGH the package barrel. */
    probe: string;
  };
}

const DOMAIN_FILES = [...sourceFiles(SERVICE_DIR), ...sourceFiles(REPOSITORY_DIR)];

const WALLS: Wall[] = [
  {
    // "Never infer final cost from the current catalog price after the order."
    // The evidence kinds have no catalogue member, so a live price has no shape
    // to arrive in — and this is the other half: the domain cannot reach a
    // catalogue read at all, so the shape could not be filled if one were added.
    name: 'a catalogue, listing, offer or procurement-offer price read',
    files: DOMAIN_FILES,
    pattern:
      /from\s+['"][^'"]*(catalog-hydration|catalog-write|pricing\.service|db\/offers|db\/canonical|procurementOfferRepository|retail-pricing\/retail-cost-formula)[^'"]*['"]/,
    probe: "import { hydrateListing } from '../catalog-hydration.service.js';",
  },
  {
    // "Never revalue historical order truth using today's rate." Every
    // conversion here reuses a STORED `FxRateSnapshot`; a live rate would make
    // a reconciliation's answer depend on when it was run.
    name: 'the FX service, from anywhere in the reconciliation domain',
    files: DOMAIN_FILES,
    pattern: /from\s+['"][^'"]*(fx\.service|\/fx\.js|services\/fx)[^'"]*['"]/,
    probe: "import { getRates } from '../fx.service.js';",
  },
  {
    // ADR 0004 D11: nothing in the retail chain may NAME them, comments
    // included — a comment naming one is exactly the anticipation it forbids.
    // Scanned over RAW source for that reason.
    name: 'OxyPay or FairCoin, anywhere in the domain',
    files: [...DOMAIN_FILES, SCHEMA_FILE, ROUTE_FILE, CONTROLLER_FILE],
    pattern: /oxy[_\s-]?pay|oxypay|faircoin|fair[_\s-]coin/i,
    probe: 'const rail = "oxy_pay";',
  },
  {
    // #128's referral boundary: `mercaria_retail` produces no margin base, and
    // a referral reward can neither consume positive cost variance nor delay a
    // customer adjustment. It cannot, because it cannot be reached.
    name: 'the referral domain',
    files: DOMAIN_FILES,
    pattern: /from\s+['"][^'"]*(referral|affiliate)[^'"]*['"]/,
    probe: "import { attributeReferral } from '../referrals/attribution.service.js';",
    // The referral CONTRACTS live in `@mercaria/shared-types` — ten modules of
    // them (`referral.ts`, `referral-attribution.ts`, … `affiliate-outbound.ts`)
    // plus `@mercaria/ui`'s `referral-labels`. The path detector above cannot
    // see one arriving through the package barrel, which is the whole of #582.
    // Measured before this line existed: this domain reaches exactly two package
    // modules, `money.ts` and `retail-reconciliation.ts`, so the wall is
    // tightened here with no legitimate importer to excuse.
    packageWall: {
      modules: /(referral|affiliate)/,
      probe: "import { ReferralProgramStatus } from '@mercaria/shared-types';",
    },
  },
  {
    // #128 item 6: never restock inventory because of a price adjustment. An
    // adjustment moves money, not goods, and the absence of any inventory
    // import is what makes that structural rather than remembered.
    name: 'an inventory writer',
    files: DOMAIN_FILES,
    pattern: /from\s+['"][^'"]*(inventory\.service|inventoryRepository|db\/inventory)[^'"]*['"]/,
    probe: "import { commitInventory } from '../inventory.service.js';",
  },
  {
    // A feed, search or ranking module: neither the cost of an order nor the
    // variance Mercaria absorbed on it may reach what a shopper is shown.
    name: 'a feed, search or ranking module',
    files: DOMAIN_FILES,
    // `\.\./ranking/` as well as the absolute-looking form: a sibling domain is
    // one `../` away from here, so a detector anchored only on `services/`
    // would miss the import somebody would actually write. The mutation
    // self-test below is what found that — the first spelling of this pattern
    // passed the wall and failed its own probe, exactly as #125's did.
    pattern:
      /from\s+['"][^'"]*(feed\.service|search\.service|services\/ranking|\.\.\/ranking\/|merchandising)[^'"]*['"]/,
    probe: "import { buildRankingFacts } from '../ranking/facts.js';",
  },
];

describe('the reconciliation domain cannot reach what it must not', () => {
  it('scans a real file set', () => {
    // The vacuity floor. A broken traversal reads nothing and every wall below
    // passes; this is what makes that impossible.
    expect(DOMAIN_FILES.length).toBeGreaterThanOrEqual(10);
  });

  for (const wall of WALLS) {
    it(`does not reach ${wall.name}`, () => {
      const offenders = wall.files.filter((file) => {
        const source = code(file);
        if (wall.pattern.test(source)) return true;
        // The same question asked of a package barrel, resolved symbol by symbol
        // to the module that owns it (#582).
        return wall.packageWall ? reachesPackageModule(source, wall.packageWall.modules) : false;
      });
      expect(offenders.map((file) => relative(SERVICE_DIR, file))).toEqual([]);
      expect(wall.files.length).toBeGreaterThan(0);
    });

    it(`WOULD catch ${wall.name} (mutation self-test)`, () => {
      // The detector run against a source that genuinely contains what it
      // forbids. A pattern that stopped matching would otherwise pass the wall
      // above forever, reporting a clean domain because it reads nothing.
      expect(wall.pattern.test(wall.probe)).toBe(true);

      if (!wall.packageWall) return;
      // And the barrel form, which the path detector above CANNOT see. Both
      // halves are asserted: that the resolver catches it, and that the path
      // detector does not — so this stays a demonstration of why the second
      // predicate exists rather than a line somebody could delete as redundant.
      expect(reachesPackageModule(wall.packageWall.probe, wall.packageWall.modules)).toBe(true);
      expect(wall.pattern.test(wall.packageWall.probe)).toBe(false);
    });
  }
});

describe('only the runner reads the sweep’s feature flag', () => {
  it('keeps `config.retailReconciliation` out of every durable path', () => {
    // The payment outbox's rule: the LOOP is gated, the record never is. An
    // operator reconciling an order by hand still writes its revision, raises
    // its exceptions and books what it recognizes — which is only true while no
    // module but the runner can see the flag.
    const readers = DOMAIN_FILES.filter(
      (file) => /config\.retailReconciliation/.test(code(file)) && !file.endsWith('runner.ts'),
    );
    expect(readers.map((file) => relative(SERVICE_DIR, file))).toEqual([]);
    // The positive control: the runner DOES read it, so an empty result above
    // cannot mean the flag was renamed away.
    expect(code(join(SERVICE_DIR, 'runner.ts'))).toMatch(/config\.retailReconciliation/);
  });
});

describe('a cost adjustment cannot outrun a chargeback', () => {
  /**
   * #127 wiring item 1, and the failure it closes is the *unnoticed* double
   * payment ADR 0004 rule 10 names: a dispute suspends refunds on an order, a
   * cost adjustment IS a refund, and a suspended order that still pays one has
   * paid the same money twice with nothing recording that it did.
   *
   * A positive gate rather than a wall. The other gates here assert an absence;
   * this asserts a PRESENCE, because the way this breaks is somebody deleting
   * two lines during a refactor and every existing test staying green.
   */
  const adjustment = () => code(join(SERVICE_DIR, 'adjustment.service.ts'));

  it('consults #127’s own suspension reader before serving an obligation', () => {
    // #127's reader, imported from #127. Re-deriving "is this order suspended"
    // here would be a second answer to a question that already has one, and the
    // two would disagree the first time #127 widened what suspends a refund.
    expect(adjustment()).toMatch(
      /from\s+['"][^'"]*db\/retailServiceRequests\/policyRepository[^'"]*['"]/,
    );
    expect(adjustment()).toMatch(/await\s+findRetailRefundSuspension\(/);
    // And it produces the block reason, so `dispute_open` stops being a code
    // with no producer — which is what it was before this wiring landed.
    expect(adjustment()).toMatch(/return\s+'dispute_open'/);
  });

  it('checks the suspension BEFORE the automation floor', () => {
    // The order is load-bearing. `settleRetailCustomerAdjustmentOnRequest`
    // clears `below_automation_threshold` and re-derives; if the floor were
    // consulted first, an operator clearing it would clear the last thing
    // standing between a held order and a second payment.
    const source = adjustment();
    const suspension = source.indexOf('findRetailRefundSuspension(');
    const floor = source.indexOf("=== 'below_automation_threshold'");
    expect(suspension).toBeGreaterThan(-1);
    expect(floor).toBeGreaterThan(-1);
    expect(suspension).toBeLessThan(floor);
  });

  it('WOULD catch the check being dropped (mutation self-test)', () => {
    // Every assertion above must fail on a source with the call removed, or the
    // gate is decorative — the mistake #125's detector made and this file's own
    // ranking wall made before it.
    const mutated = adjustment()
      .replace(/import \{ findRetailRefundSuspension \}[^;]+;/, '')
      .replace(/if \(await findRetailRefundSuspension\([^)]*\)\) return 'dispute_open';/, '');
    expect(mutated).not.toMatch(/await\s+findRetailRefundSuspension\(/);
    expect(mutated).not.toMatch(
      /from\s+['"][^'"]*db\/retailServiceRequests\/policyRepository[^'"]*['"]/,
    );
    // And the mutation really applied — a substitution that matched nothing is
    // indistinguishable from one that survived.
    expect(mutated).not.toEqual(adjustment());
  });
});

describe('no margin, profit or markup exists anywhere in the domain', () => {
  it('names no forbidden component in any of the ten tables', () => {
    const tables = Object.values(schema).filter((value): value is PgTable => is(value, PgTable));
    const domainTables = tables.filter((table) =>
      getTableName(table).startsWith('retail_reconciliation') ||
      getTableName(table) === 'retail_customer_adjustments' ||
      getTableName(table) === 'retail_supplier_credits' ||
      getTableName(table) === 'retail_ledger_recognitions',
    );
    // A vacuity floor on the table set as well as on the columns: a filter that
    // matched nothing would report a clean schema.
    expect(domainTables).toHaveLength(10);

    const offenders: string[] = [];
    let columnsScanned = 0;
    for (const table of domainTables) {
      for (const column of Object.keys(getTableColumns(table))) {
        columnsScanned += 1;
        const matches = detectForbiddenAccountingOutputs([column]);
        if (matches.length > 0) offenders.push(`${getTableName(table)}.${column}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(columnsScanned).toBeGreaterThanOrEqual(100);
  });

  it('WOULD catch a margin column (mutation self-test)', () => {
    // The same detector, over a column name a future change might add. Without
    // this the census above passes just as well when the detector matches
    // nothing at all.
    expect(detectForbiddenAccountingOutputs(['margin_bps'])).toHaveLength(1);
    expect(detectForbiddenAccountingOutputs(['realizedMarginMinor'])).toHaveLength(1);
    expect(detectForbiddenAccountingOutputs(['grossProfit'])).toHaveLength(1);
  });

  it('refuses a forbidden output BY NAME rather than as an unrecognized key', () => {
    expect(() => assertNoForbiddenAccountingOutput(['marginTargetBps'], 'reconciliation policy'))
      .toThrow(/planned_margin/);
    expect(() =>
      assertNoForbiddenAccountingOutput(['unclaimedAdjustmentRevenue'], 'reconciliation policy'),
    ).toThrow(/unclaimed_adjustment_revenue/);
    // An ordinary key is NOT this module's to refuse — the `.strict()` schema
    // above it answers "no", and this answers "why".
    expect(() => assertNoForbiddenAccountingOutput(['toleranceMinor'], 'x')).not.toThrow();
  });

  it('explains every forbidden component', () => {
    for (const kind of RETAIL_FORBIDDEN_ACCOUNTING_COMPONENTS) {
      expect(RETAIL_FORBIDDEN_ACCOUNTING_COMPONENT_LABELS[kind].length).toBeGreaterThan(20);
    }
  });

  it('publishes no margin metric', () => {
    const offenders = RETAIL_RECONCILIATION_METRIC_KEYS.filter(
      (key) => detectForbiddenAccountingOutputs([key]).length > 0,
    );
    expect(offenders).toEqual([]);
    expect(RETAIL_RECONCILIATION_METRIC_KEYS).toHaveLength(10);
  });

  it('names no forbidden field in the DTO prohibition list itself', () => {
    // The list is the prohibition as a VALUE. Every entry has to be something
    // the detector would catch, or the runtime walk that reads it is checking
    // for names nothing would ever produce.
    for (const field of RETAIL_RECONCILIATION_FORBIDDEN_DTO_FIELDS) {
      expect(detectForbiddenAccountingOutputs([field]).length).toBeGreaterThan(0);
    }
    expect(RETAIL_RECONCILIATION_FORBIDDEN_DTO_FIELDS.length).toBeGreaterThanOrEqual(10);
  });
});

describe('the operator surface is a CLOSED set', () => {
  it('registers exactly the routes #128 grants and no others', () => {
    const source = code(ROUTE_FILE);
    const registered = [...source.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)].map(
      (match) => `${match[1]?.toUpperCase() ?? ''} ${match[2] ?? ''}`,
    );
    // EXACT, not a superset. The four shapes a sponsored-placement surface takes
    // in #74 have their analogue here: "set this variance", "waive this
    // adjustment", "override this cost" and "delete this record" are all one
    // route away, and an assertion of "contains" would not notice one arriving.
    expect(registered.sort()).toEqual(
      [
        'GET /adjustments',
        'GET /exceptions',
        'GET /metrics',
        'GET /orders/:orderId',
        'POST /adjustments/:id/retry-refund',
        'POST /exceptions/:id/resolve',
        'POST /orders/:orderId/reconcile',
      ].sort(),
    );
  });

  it('grants exactly three write actions', () => {
    expect([...RETAIL_RECONCILIATION_OPERATOR_ACTIONS].sort()).toEqual([
      'reconcile_order',
      'resolve_exception',
      'retry_adjustment_refund',
    ]);
  });

  /**
   * The allow-list boundary, as a DETECTOR rather than two bare `toMatch`es.
   *
   * `expect(source).toMatch(/requireProcurementOperator/)` passes on a file that
   * merely IMPORTS the symbol and never applies it, which is the one failure
   * mode that matters: an unguarded router still compiles and still serves. So
   * the positive check reads `router.use(...)`.
   *
   * And the negative check is mutation-tested below rather than trusted. A
   * `not.toMatch` is the shape of assertion that goes quiet when the thing it
   * looks for is renamed — it would keep passing against a file that had been
   * moved onto the compliance list under a new symbol name, reporting a clean
   * boundary because it can no longer see one.
   */
  const appliesProcurementGate = (source: string): boolean =>
    /router\.use\(\s*requireProcurementOperator\s*\)/.test(source);
  const reachesComplianceGate = (source: string): boolean =>
    /requireRetailOperator/.test(source);

  it('APPLIES the procurement operator gate as middleware', () => {
    expect(appliesProcurementGate(code(ROUTE_FILE))).toBe(true);
  });

  it('never reaches the compliance allow-list', () => {
    // The fifth list is the compliance one (#121: recalls, eligibility policy,
    // document verification). This surface shows the supplier invoice by
    // component, and `procurement-operator-authz.ts` states outright that a
    // compliance reviewer vetted to verify a product-safety certificate is not
    // thereby vetted to see Mercaria's cost base.
    expect(reachesComplianceGate(code(ROUTE_FILE))).toBe(false);
  });

  it('WOULD catch a surface moved onto the compliance list (mutation self-test)', () => {
    // Both detectors run against a synthetic route file that genuinely does the
    // wrong thing. Without this, the two assertions above pass just as well
    // against a detector that matches nothing at all.
    const substituted = `
      import { requireRetailOperator } from '../middleware/retail-operator-authz.js';
      router.use(authenticateToken);
      router.use(requireRetailOperator);
    `;
    expect(reachesComplianceGate(substituted)).toBe(true);
    expect(appliesProcurementGate(substituted)).toBe(false);

    // And the other direction: a file that imports the right gate but never
    // applies it is caught too, because an unguarded router still serves.
    const importedButUnused = `
      import { requireProcurementOperator } from '../middleware/procurement-operator-authz.js';
      router.use(authenticateToken);
    `;
    expect(appliesProcurementGate(importedButUnused)).toBe(false);
  });

  it('audits every attempt, refusals included', () => {
    const source = code(CONTROLLER_FILE);
    // One wrapper, used by every write handler: a helper only the success path
    // remembered to call would make the audit a record of what worked.
    expect(source).toMatch(/withAudit/);
    // One call per WRITE handler, and there are exactly three writes.
    expect((source.match(/await withAudit\(/g) ?? []).length).toBe(
      RETAIL_RECONCILIATION_OPERATOR_ACTIONS.length,
    );
    expect(source).toMatch(/outcome: 'refused'/);
  });
});

describe('the twelve components are the complete accounting model', () => {
  it('covers #128’s numbered list', () => {
    expect([...RETAIL_ACCOUNTING_COMPONENTS].sort()).toEqual(
      [
        'customer_charge',
        'supplier_item_cost',
        'supplier_handling_cost',
        'fulfilment_shipping_cost',
        'tax_duty_liability',
        'provider_processing_cost',
        'mercaria_promotion_subsidy',
        'customer_refund',
        'supplier_credit',
        'customer_adjustment_payable',
        'mercaria_absorbed_variance',
        'dispute_movement',
      ].sort(),
    );
  });
});
