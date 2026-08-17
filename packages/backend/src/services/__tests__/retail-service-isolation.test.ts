/**
 * The retail service-request domain's structural boundaries (#127), asserted by
 * SCAN.
 *
 * Every claim below is about what a path CANNOT do, and a behavioural test can
 * only ever say "it did not this time". The strongest of them is ADR 0004
 * D8.5 — *a customer's remedy is never contingent on, sized by, or delayed for
 * a supplier credit* — and it is checkable here by reading a list of imports
 * rather than by tracing branches through nine services.
 *
 * Both defences from `~/Oxy/AGENTS.md` are present: a VACUITY FLOOR, so a moved
 * or emptied file fails the gate instead of shrinking it silently, and a
 * MUTATION SELF-TEST per detector, so a regex that matches nothing cannot pass
 * by being broken. `buyer-request-isolation.test.ts` is the precedent.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RETAIL_FORBIDDEN_POLICY_EXCEPTION_SOURCES,
  RETAIL_POLICY_EXCEPTION_SOURCES,
  RETAIL_SERVICE_FORBIDDEN_CUSTOMER_INPUTS,
  SUPPLIER_RECOVERY_FORBIDDEN_EFFECTS,
} from '@mercaria/shared-types';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every `.ts` under `relative`, recursively, excluding the test tree. */
function walk(relative: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(SRC_ROOT, relative), { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(child));
    else if (entry.name.endsWith('.ts')) found.push(child);
  }
  return found;
}

/**
 * The domain's HTTP surface, derived from the filename convention every module
 * in these flat directories already follows (#472's device).
 *
 * It does NOT reach `routes/orders.ts` or `routes/guest-orders.ts`, which MOUNT
 * this domain's router: a route that mounts decides nothing and its imports are
 * the union of every surface on it, so scanning one here would fail this gate
 * for a co-location (#483's `AGGREGATOR_ROUTES` reasoning, reached by the
 * derivation never selecting them rather than by an exclusion needing a count).
 */
function httpSurface(): string[] {
  return ['controllers', 'routes', 'middleware'].flatMap((directory) =>
    readdirSync(join(SRC_ROOT, directory), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .filter((entry) => entry.name.startsWith('retail-service'))
      .map((entry) => `${directory}/${entry.name}`),
  );
}

/**
 * Every module in the domain, WALKED rather than listed (#460).
 *
 * The hand list this replaces named all 26 and was complete on the day it was
 * written, which is the defect rather than a defence: what a list omits is
 * whatever somebody adds next, and that is the module nobody has reviewed.
 */
const DOMAIN_PATHS = [
  ...walk('services/retail-service-requests'),
  ...walk('db/retailServiceRequests'),
  ...httpSurface(),
];

/**
 * The two modules that may reach a refund path or the payment domain — the ONLY
 * crossings, each with the reason it is one, and an EXACT count (#448).
 *
 * `BUYER_PATHS` is DERIVED by subtracting these, so a module added tomorrow is
 * held to the stricter wall by default. The hand list this replaces named the
 * buyer half directly at 7 of 26 modules, so nineteen sat outside the wall with
 * no reason recorded — and every one of them passes it.
 */
const PAYMENT_CROSSINGS = [
  {
    path: 'services/retail-service-requests/refund-bridge.ts',
    /** The ONE place this domain moves money. */
    reason: 'refund',
  },
  {
    path: 'services/retail-service-requests/registration.ts',
    /**
     * Boot wiring, not a request path: it registers this domain's consumer with
     * `services/payments/retail-dispute.port.ts`, which is what keeps the
     * dependency pointing one way. It reaches the payment domain by NAMING the
     * port it registers against and moves no money.
     */
    reason: 'payment',
  },
] as const;

/**
 * The BUYER path — DERIVED: the domain walk minus the counted payment crossings.
 *
 * These may not reach an order writer, a refund path, an inventory function or
 * the payment domain. That is #110's acceptance 2 applied to a retail order,
 * and it is the same property for the same reason: cancelling a paid order has
 * to return money and respect a fulfilment state, and each belongs to a service
 * that already gets it right.
 */
const BUYER_PATHS = DOMAIN_PATHS.filter(
  (path) => !PAYMENT_CROSSINGS.some((entry) => entry.path === path),
);

/**
 * The modules that may reach the SUPPLIER side, measured rather than listed.
 *
 * ADR 0004 D8.5 as a property of the import graph: everything else in the domain
 * decides or reports what a BUYER is owed, and may not reach the supplier
 * recovery repository, the supplier RMA port or #124's purchase-order
 * repository — so a customer's remedy cannot be a function of a supplier's
 * answer in any code path.
 *
 * `decision.service.ts` was named in the list this replaces as deliberately
 * outside the customer half, on the grounds that it opens a return case. It
 * reaches no supplier module today (measured), so the derivation puts it INSIDE
 * the wall and it passes. That is a real widening and it is the safe direction:
 * if #127's owner later gives it the supplier call the old comment anticipated,
 * this gate names it and the crossing gets a row here with a reason — which is
 * the decision being recorded rather than assumed.
 */
const SUPPLIER_CROSSINGS = [
  {
    path: 'services/retail-service-requests/return-case.service.ts',
    /** Where the two halves meet, in the one ORDER that matters. */
    reason: 'opens the supplier recovery after the customer is answered',
  },
  {
    path: 'services/retail-service-requests/cancellation.service.ts',
    /** Reaches #124's purchase-order repository and supplier cancellation. */
    reason: 'cancels the supplier purchase order',
  },
  {
    path: 'services/retail-service-requests/projection.ts',
    /** A READ projection: reports recoveries, decides no remedy. */
    reason: 'projects supplier recoveries for the operator surface',
  },
  {
    path: 'controllers/retail-service-operator.controller.ts',
    /** The operator surface, which reads the supplier side by design. */
    reason: 'the operator surface reads supplier recovery state',
  },
] as const;

/** The CUSTOMER half — DERIVED: the domain walk minus the counted supplier crossings. */
const CUSTOMER_HALF_PATHS = DOMAIN_PATHS.filter(
  (path) => !SUPPLIER_CROSSINGS.some((entry) => entry.path === path),
);

/** The module that MAY move money, listed so the positive half can assert it does. */
const REFUND_BRIDGE_PATH = 'services/retail-service-requests/refund-bridge.ts';

/** The module that MAY reach the supplier, for the same reason. */
const SUPPLIER_PATH = 'services/retail-service-requests/return-case.service.ts';

/** An order STATUS writer. `transition` is the only lifecycle authority. */
const ORDER_WRITER_REFERENCE =
  /from\s+['"][^'"]*order\.service|setOrderStatus|transitionOrderStatus/;

/** Any path that commits a refund. */
const REFUND_WRITER_REFERENCE = /from\s+['"][^'"]*refund\.service|insertRefund/;

/**
 * Any inventory movement.
 *
 * #127 refund rule 7 is *"restock only when Mercaria owns inventory; supplier
 * return state does not mutate native inventory"*, and a retail line reserved
 * none (ADR 0004 D5). So NO module in this domain may reach one — this is the
 * one detector that runs over the whole domain rather than over a half.
 */
const INVENTORY_REFERENCE = /from\s+['"][^'"]*inventory\.service|\brestock\s*\(/;

/**
 * The payment domain. `refund-bridge.ts` is the only crossing.
 *
 * BOTH spellings, and the relative one is the load-bearing half: every real
 * import inside `services/` is `../payments/…`, so a detector matching only the
 * absolute path would find nothing anywhere and pass every negative assertion
 * while measuring nothing. #125's own gate recorded exactly this — its mutation
 * self-test caught a relative import slipping past the first pattern — and the
 * positive assertion below is what caught it again here.
 */
const PAYMENT_DOMAIN_REFERENCE = /services\/payments\/|\.\.\/payments\//;

/** The supplier side: recoveries, RMAs and #124's purchase orders. */
const SUPPLIER_REFERENCE =
  /supplierRecoveryRepository|supplier-rma\.port|purchaseOrderRepository|(?:services|\.\.)\/supplier-orders\//;

/**
 * The retail ENTRY levers.
 *
 * #127 acceptance 8: *"existing cases remain operable after new retail checkout
 * or supplier integration is paused"*. `MERCARIA_RETAIL_ENABLED` gates checkout
 * ENTRY and a supplier account's `killed` state stops NEW submissions; neither
 * may reach a case that already exists, so nothing here reads either.
 */
const RETAIL_ENTRY_LEVER_REFERENCE = /config\.retail\b|MERCARIA_RETAIL_ENABLED|['"]killed['"]/;

/** The ledger. #128 books what this domain classifies (ADR 0004 D7). */
const LEDGER_REFERENCE =
  /ledgerRepository|insertLedgerTransaction|ledger-postings|LEDGER_ACCOUNTS|commission_revenue/;

/** FX. A refund returns exactly what was charged, in the currency it was charged in. */
const FX_REFERENCE = /fx\.service|getRates\s*\(|toDualMoney|pairRate/;

/** The forbidden ecosystem spellings this repository excludes twice over. */
const OXYPAY_OR_FAIRCOIN_REFERENCE = /oxy_?[Pp]ay|OxyPay|[Ff]air[Cc]oin/;

/** Read a domain file, refusing an empty or moved one. */
function readSource(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * Source with comments stripped.
 *
 * These modules DOCUMENT what they refuse to do in the same vocabulary the
 * detectors use — `refund-bridge.ts` explains that it imports no inventory
 * function, `policy.ts` explains that it reads no supply agreement — so a scan
 * over raw text would fail on the prose that proves the rule is understood. The
 * `checkout-contact-isolation.test.ts` decision, verbatim.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('retail service isolation (static)', () => {
  it('scans every module in the domain', () => {
    // The vacuity floor. A gate that scanned nothing would pass every assertion
    // below, and the shape of that failure — a moved file, a renamed directory
    // — is exactly the one nobody notices.
    // Vacuity floors PER SHAPE rather than one on the total: the three sources
    // break independently, and a single total would let one walk collapse to
    // zero while the others carried the number. Each is today's count, so a
    // SHRINK stops the build rather than quietly narrowing every assertion here.
    const from = (prefix: string) => DOMAIN_PATHS.filter((path) => path.startsWith(prefix)).length;
    expect(from('services/retail-service-requests/'), 'the service walk found nothing').toBeGreaterThanOrEqual(18);
    expect(from('db/retailServiceRequests/'), 'the repository walk found nothing').toBeGreaterThanOrEqual(5);
    expect(httpSurface().length, 'the HTTP surface derivation found nothing').toBeGreaterThanOrEqual(3);
    expect(BUYER_PATHS.length).toBeGreaterThanOrEqual(24);
    expect(CUSTOMER_HALF_PATHS.length).toBeGreaterThanOrEqual(22);

    // EXACT: an unbounded exclusion list lets any number of modules ride in
    // behind the ones somebody justified (#448).
    expect(PAYMENT_CROSSINGS.length, 'a third payment crossing was excluded').toBe(2);
    expect(SUPPLIER_CROSSINGS.length, 'a fifth supplier crossing was excluded').toBe(4);

    // The walk really reads the disk, and no test file enters the scanned set.
    for (const path of DOMAIN_PATHS) {
      expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} is not a file`).toBe(true);
    }
    expect(DOMAIN_PATHS.filter((path) => path.includes('__tests__'))).toEqual([]);

    // Every excluded crossing must still be IN the domain: an exclusion naming a
    // module the walk no longer finds excuses nothing while looking like a
    // decision.
    for (const { path } of [...PAYMENT_CROSSINGS, ...SUPPLIER_CROSSINGS]) {
      expect(DOMAIN_PATHS, `${path} is excluded from a wall but is not in the domain`).toContain(path);
    }
    for (const path of DOMAIN_PATHS) {
      expect(readSource(path).length).toBeGreaterThan(200);
    }
  });

  it('no BUYER path can write an order, commit a refund or reach the payment domain', () => {
    for (const path of BUYER_PATHS) {
      const source = stripComments(readSource(path));
      expect(
        ORDER_WRITER_REFERENCE.test(source),
        `${path} can move an order's status; a buyer files a REQUEST`,
      ).toBe(false);
      expect(
        REFUND_WRITER_REFERENCE.test(source),
        `${path} can commit a refund; only the decision path may`,
      ).toBe(false);
      expect(
        PAYMENT_DOMAIN_REFERENCE.test(source),
        `${path} reaches the payment domain; refund-bridge.ts is the only crossing`,
      ).toBe(false);
    }
  });

  it('no CUSTOMER-half module can read a supplier recovery, an RMA or a purchase order', () => {
    // ADR 0004 D8.5, and the reason it is a SCAN: "the refund was not sized by
    // the credit this time" is what a behavioural test proves, and what has to
    // be true is that there is no import through which it could be.
    for (const path of CUSTOMER_HALF_PATHS) {
      const source = stripComments(readSource(path));
      expect(
        SUPPLIER_REFERENCE.test(source),
        `${path} can read what a supplier owes Mercaria; a customer remedy is never sized by it`,
      ).toBe(false);
    }
  });

  it('nothing in the domain moves stock, books a ledger entry or converts a currency', () => {
    for (const path of DOMAIN_PATHS) {
      const source = stripComments(readSource(path));
      expect(
        INVENTORY_REFERENCE.test(source),
        `${path} can move stock; a retail line reserved none (ADR 0004 D5)`,
      ).toBe(false);
      expect(
        LEDGER_REFERENCE.test(source),
        `${path} books to the ledger; #128 books what this domain classifies (ADR 0004 D7)`,
      ).toBe(false);
      expect(
        FX_REFERENCE.test(source),
        `${path} converts a currency; a refund returns what was charged, as charged`,
      ).toBe(false);
    }
  });

  it('nothing in the domain reads a retail ENTRY lever', () => {
    // #127 acceptance 8. A case already filed must survive `MERCARIA_RETAIL_ENABLED`
    // going false and a supplier account being killed, and the way that is made
    // true is by nothing here being able to see either.
    for (const path of DOMAIN_PATHS) {
      const source = stripComments(readSource(path));
      expect(
        RETAIL_ENTRY_LEVER_REFERENCE.test(source),
        `${path} reads a retail entry lever; existing cases must stay operable`,
      ).toBe(false);
    }
  });

  it('nothing in the domain names OxyPay or FairCoin', () => {
    for (const path of DOMAIN_PATHS) {
      // Scanned RAW, comments included: a copy change naming a rail Mercaria
      // does not have is as wrong as an import of one.
      expect(
        OXYPAY_OR_FAIRCOIN_REFERENCE.test(readSource(path)),
        `${path} names OxyPay or FairCoin; neither is a payment rail here`,
      ).toBe(false);
    }
  });

  it('the modules that MAY cross each wall actually do', () => {
    // The positive half. Without it, every absence above would still hold if
    // `insertRefund` and the supplier repositories had simply been renamed, and
    // the gate would be measuring nothing.
    expect(REFUND_WRITER_REFERENCE.test(stripComments(readSource(REFUND_BRIDGE_PATH)))).toBe(true);
    expect(PAYMENT_DOMAIN_REFERENCE.test(stripComments(readSource(REFUND_BRIDGE_PATH)))).toBe(true);
    expect(SUPPLIER_REFERENCE.test(stripComments(readSource(SUPPLIER_PATH)))).toBe(true);

    // And EVERY excluded crossing, not only the two named above. This is what
    // keeps the exclusion lists honest: a module that stops crossing stops being
    // excludable and is named here, so both walls can only get wider by neglect,
    // never narrower. Without it a stale exclusion goes on excusing a module
    // that no longer needs excusing, which reads exactly like a decision.
    for (const { path } of PAYMENT_CROSSINGS) {
      expect(
        PAYMENT_DOMAIN_REFERENCE.test(stripComments(readSource(path))),
        `${path} is excused from the buyer wall as a payment crossing, and no longer is one`,
      ).toBe(true);
    }
    for (const { path } of SUPPLIER_CROSSINGS) {
      expect(
        SUPPLIER_REFERENCE.test(stripComments(readSource(path))),
        `${path} is excused from the customer half as a supplier crossing, and no longer is one`,
      ).toBe(true);
    }
  });

  it('the customer view has no member a supplier fact could arrive in', () => {
    // The type is the primary enforcement (a serializer reaching for one fails
    // `tsc`); this asserts the vocabulary that names the prohibition is real and
    // non-trivial, so the runtime walk in the realdb suite cannot pass by the
    // tuple having been emptied.
    expect(RETAIL_SERVICE_FORBIDDEN_CUSTOMER_INPUTS.length).toBeGreaterThanOrEqual(12);
    expect(SUPPLIER_RECOVERY_FORBIDDEN_EFFECTS.length).toBeGreaterThanOrEqual(6);
    const view = readSource('services/retail-service-requests/projection.ts');
    for (const forbidden of ['wholesale', 'supplierName', 'purchaseOrderId'] as const) {
      // `projectRetailServiceRequestForOperator` legitimately names a purchase
      // order; the CUSTOMER projection must not, so the check is scoped to the
      // function that builds it.
      const customerHalf = view.slice(
        view.indexOf('export async function projectRetailServiceRequestForCustomer'),
        view.indexOf('export async function projectRetailServiceRequestForOperator'),
      );
      expect(
        customerHalf.includes(forbidden),
        `the customer projection names ${forbidden}`,
      ).toBe(false);
    }
  });

  it('a supplier can never be the SOURCE of a policy exception', () => {
    // #127 policy rule 3, as disjoint unions. A supply agreement's narrower
    // returns policy has no value it could be recorded under, so it cannot
    // reduce a customer right by being written down — whatever a service does.
    const allowed = new Set<string>(RETAIL_POLICY_EXCEPTION_SOURCES);
    for (const forbidden of RETAIL_FORBIDDEN_POLICY_EXCEPTION_SOURCES) {
      expect(allowed.has(forbidden), `${forbidden} is both allowed and forbidden`).toBe(false);
    }
    expect(RETAIL_FORBIDDEN_POLICY_EXCEPTION_SOURCES.length).toBeGreaterThanOrEqual(6);
    expect(RETAIL_POLICY_EXCEPTION_SOURCES.length).toBeGreaterThanOrEqual(2);
  });

  it('mutation self-test: every detector fires on a seeded positive', () => {
    // Each pattern is run against text that DOES contain what it looks for. A
    // regex that matched nothing would pass every assertion above while
    // measuring nothing at all — the failure this repository keeps finding.
    expect(ORDER_WRITER_REFERENCE.test("import { transition } from '../order.service.js';")).toBe(
      true,
    );
    expect(ORDER_WRITER_REFERENCE.test('await setOrderStatus(orderId, "cancelled");')).toBe(true);
    expect(REFUND_WRITER_REFERENCE.test('await insertRefund({ orderId }, tx);')).toBe(true);
    expect(INVENTORY_REFERENCE.test("import { restock } from '../inventory.service.js';")).toBe(
      true,
    );
    expect(INVENTORY_REFERENCE.test('await restock(variantId, 1);')).toBe(true);
    expect(
      PAYMENT_DOMAIN_REFERENCE.test("import { x } from '../services/payments/provider.js';"),
    ).toBe(true);
    // The relative spelling every real import inside `services/` uses.
    expect(
      PAYMENT_DOMAIN_REFERENCE.test("import { x } from '../payments/payment-outbox.service.js';"),
    ).toBe(true);
    expect(
      SUPPLIER_REFERENCE.test("import { openSupplierRecovery } from '../supplierRecoveryRepository.js';"),
    ).toBe(true);
    expect(SUPPLIER_REFERENCE.test("import { supplierRmaPort } from './supplier-rma.port.js';")).toBe(
      true,
    );
    expect(
      SUPPLIER_REFERENCE.test("import { findPurchaseOrderById } from '../purchaseOrderRepository.js';"),
    ).toBe(true);
    expect(RETAIL_ENTRY_LEVER_REFERENCE.test('if (config.retail.enabled) return;')).toBe(true);
    expect(RETAIL_ENTRY_LEVER_REFERENCE.test("if (account.state === 'killed') return;")).toBe(true);
    expect(LEDGER_REFERENCE.test('await insertLedgerTransaction(tx, t, e);')).toBe(true);
    expect(LEDGER_REFERENCE.test("import { x } from './ledger-postings.js';")).toBe(true);
    expect(FX_REFERENCE.test('const rates = await getRates("EUR", ["USD"]);')).toBe(true);
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test('OxyPay accepts FairCoin')).toBe(true);
  });
});
