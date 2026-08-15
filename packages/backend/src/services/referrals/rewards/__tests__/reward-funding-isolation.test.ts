/**
 * The walls around referral reward funding (#144 "Pricing and fee isolation",
 * ADR 0005 I1–I5), and — since #145 — around the earnings ledger built on it.
 *
 * Static scans, following `fee-ranking-isolation.test.ts`: each wall names what
 * must be unreachable, is applied to a real file set with an anti-vacuity
 * floor, and is MUTATION-TESTED against a synthetic source that genuinely
 * contains what it forbids — so a detector that stopped matching fails HERE
 * rather than passing silently forever.
 *
 * What the walls are FOR, stated once: #144's seven isolation rules are all the
 * same sentence from different sides — referral attribution changes no buyer
 * price, no merchant fee, no retail cost, no #128 adjustment and no organic
 * ranking. A rule is only as good as the absence of an import that could break
 * it, and the reward domain having no path to those modules is what makes the
 * absence checkable by reading a list rather than by reasoning about behaviour.
 *
 * ## The ONE exception, named
 *
 * `db/referrals/commissionBaseRepository.ts` may reach the ledger, because
 * ADR 0001 D3 puts Mercaria's commission nowhere else and ADR 0005's
 * reward-base contract says the adapter reads ledger facts. It is read-only, it
 * selects two columns, and it is the only file in the domain the payment wall
 * exempts. Widening the exemption is a visible edit to this file.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REWARDS_DIR = join(HERE, '..');
const REFERRAL_SERVICES_DIR = join(HERE, '..', '..');
const REFERRAL_DB_DIR = join(HERE, '..', '..', '..', '..', 'db', 'referrals');
const REFERRAL_EARNINGS_DB_DIR = join(HERE, '..', '..', '..', '..', 'db', 'referralEarnings');
const EARNINGS_DIR = join(HERE, '..', '..', 'earnings');
const LEDGER_SEAM = join(REFERRAL_DB_DIR, 'commissionBaseRepository.ts');
/** #145's read: a partner's balance, derived from `ledger_entries` and nothing else. */
const BALANCE_SEAM = join(REFERRAL_EARNINGS_DB_DIR, 'partnerBalanceRepository.ts');
/** #145's ONE writer. Everything else in the domain reaches the ledger through it. */
const POSTING_SEAM = join(EARNINGS_DIR, 'posting.service.ts');
/** The three files the payment wall exempts, and no others. */
const PAYMENT_SEAMS = [LEDGER_SEAM, BALANCE_SEAM, POSTING_SEAM];

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
 * fire on the docblock explaining why the fee domain is out of reach, and the
 * "fix" would be to delete the explanation.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Source with comments AND type-only imports stripped.
 *
 * Used by the payment wall alone, and the narrowing is real rather than
 * convenient: `import type { LedgerEntryInput } from '…/ledgerRepository.js'`
 * is ERASED at compile time — it cannot call anything, cannot move money and
 * cannot be turned into a call without becoming a value import, which this
 * still catches. A posting builder has to name the shape it emits, and refusing
 * that would push the shape into a duplicate type the two could disagree about.
 *
 * The mutation self-test below asserts a VALUE import of the very same module
 * still fires, which is what stops this becoming a hole.
 */
function valueImports(path: string): string {
  return code(path).replace(/import\s+type\s+\{[\s\S]*?\}\s+from\s+['"][^'"]*['"];?/g, '');
}

interface Wall {
  name: string;
  files: string[];
  pattern: RegExp;
  /** A source that genuinely contains what the pattern forbids. */
  probe: string;
  /** Scan VALUE imports only — see {@link valueImports}. */
  valueImportsOnly?: boolean;
}

const REWARD_FILES = sourceFiles(REWARDS_DIR);
const REFERRAL_SERVICE_FILES = sourceFiles(REFERRAL_SERVICES_DIR);
const REFERRAL_DB_FILES = [
  ...sourceFiles(REFERRAL_DB_DIR),
  ...sourceFiles(REFERRAL_EARNINGS_DB_DIR),
];
/** Everything in the domain EXCEPT the three named payment seams. */
const NON_SEAM_FILES = [...REFERRAL_SERVICE_FILES, ...REFERRAL_DB_FILES].filter(
  (path) => !PAYMENT_SEAMS.includes(path),
);

const WALLS: Wall[] = [
  {
    // #144 isolation 2 and ADR 0005 I3. A referral cannot increase a #88 fee
    // because it cannot reach the thing that computes or stores one — and the
    // snapshot is additionally append-only by trigger, so even a reachable
    // module could not rewrite a placed order's fee.
    name: 'the marketplace fee domain, from anywhere in the referral domain',
    files: NON_SEAM_FILES,
    pattern:
      /from\s+['"][^'"]*(services\/fees|\.\.\/fees\/|db\/fees|schema\/fees|order-fees|fee-calculation)[^'"]*['"]/,
    probe: "import { calculateOrderFee } from '../../fees/fee-calculation.js';",
  },
  {
    // #144 isolation 3 and 4, ADR 0005 I2/I4. The pricing engine and the retail
    // cost-only engine take no referral input, and this is the other half:
    // nothing here can call them either.
    name: 'the pricing engine or the retail pricing domain',
    files: NON_SEAM_FILES,
    pattern:
      /from\s+['"][^'"]*(pricing\.service|services\/retail-pricing|\.\.\/retail-pricing\/|db\/retailPricing|schema\/retailPricing)[^'"]*['"]/,
    probe: "import { composeRetailCostOnlyTotal } from '../../retail-pricing/formula.js';",
  },
  {
    // #144 isolation 6, ADR 0005 I5. A positive cost variance is reserved for
    // the CUSTOMER (#128), and the way a referral would eat one is by reading
    // the procurement or retail-checkout ledger. It cannot.
    name: 'the procurement, retail-checkout or supplier domain',
    files: NON_SEAM_FILES,
    pattern:
      /from\s+['"][^'"]*(retail-checkout|retail-fulfilment|retail-pilot|supplier-orders|supplier-preflight|schema\/retailCheckout|schema\/supplier)[^'"]*['"]/,
    probe:
      "import { recordRetailCostVariance } from '../../retail-checkout/variance.service.js';",
  },
  {
    // #144 isolation 7, ADR 0005 I1. Referral reward, partner tier, campaign
    // and commission amount cannot enter organic ranking — in either
    // direction, so this wall is repeated from the ranking side in
    // `offer-ranking-isolation.test.ts`.
    name: 'ranking, search, discovery or a feed',
    files: NON_SEAM_FILES,
    pattern:
      /from\s+['"][^'"]*(services\/ranking|\.\.\/ranking\/|services\/search|\.\.\/search\/|feed\.service|merchandising|schema\/ranking)[^'"]*['"]/,
    probe: "import { rankOfferComparison } from '../../ranking/rank.js';",
  },
  {
    // #144 isolation 4 and ADR 0005 I2's other half: a referral creates no
    // Discount. A buyer promotion for referred buyers, if a program wants one,
    // is a separate explicit Discount through the discount domain, visible as
    // such at checkout.
    name: 'the discount, cart or checkout write path',
    files: NON_SEAM_FILES,
    pattern:
      /from\s+['"][^'"]*(discount\.service|services\/checkout|\.\.\/checkout\/|cart\.service|catalog-write)[^'"]*['"]/,
    probe: "import { applyDiscount } from '../../discount.service.js';",
  },
  {
    // The payment wall, minus the one named seam. A reward reads the ledger to
    // learn what Mercaria EARNED; it may not reach the payment service, the
    // adapter, the refund path or the order linkage — every one of which can
    // move money or change an order.
    name: 'the payment domain, from any file but the three named seams',
    files: NON_SEAM_FILES,
    valueImportsOnly: true,
    pattern:
      /from\s+['"][^'"]*(services\/payments|\.\.\/payments\/|db\/payments|schema\/payments|schema\/ledger|order-linkage|refund\.service)[^'"]*['"]/,
    probe: "import { paymentService } from '../../payments/payment.service.js';",
  },
  {
    // No FX, anywhere. A reward is denominated in the currency its funding was
    // realized in and a rule that pins one REFUSES funding in another; a
    // conversion here would let a rate move between accrual and vesting change
    // an amount ADR 0005 D19 fixes at attribution.
    name: 'the FX service',
    files: [...REWARD_FILES, ...REFERRAL_DB_FILES],
    pattern: /from\s+['"][^'"]*(fx\.service|services\/fx|\.\.\/fx\/)[^'"]*['"]/,
    probe: "import { convert } from '../../fx.service.js';",
  },
  {
    // ADR 0004 D11 and the standing rule across every money-adjacent domain in
    // this repo: nothing may NAME them, comments included.
    name: 'OxyPay or FairCoin, anywhere in the reward domain',
    files: [...REWARD_FILES, ...REFERRAL_DB_FILES],
    pattern: /oxy[_\s-]?pay|oxypay|faircoin|fair[_\s-]coin/i,
    probe: 'const rail = "oxy_pay";',
  },
];

describe('referral reward funding isolation (static)', () => {
  it('scans a non-trivial number of files', () => {
    // The anti-vacuity floor. A broken traversal scans nothing and every wall
    // below passes, which is exactly what a BROKEN scan produces.
    expect(REWARD_FILES.length).toBeGreaterThanOrEqual(6);
    expect(REFERRAL_SERVICE_FILES.length).toBeGreaterThanOrEqual(12);
    expect(REFERRAL_DB_FILES.length).toBeGreaterThanOrEqual(14);
    expect(NON_SEAM_FILES.length).toBeGreaterThanOrEqual(24);
    // …#145's own modules are genuinely in the scanned set, so the walls below
    // are measuring them rather than a directory that failed to traverse.
    expect(sourceFiles(EARNINGS_DIR).length).toBeGreaterThanOrEqual(8);
    expect(REFERRAL_SERVICE_FILES).toContain(POSTING_SEAM);
    // …and every seam is genuinely excluded from the non-seam set, rather than
    // the filter having matched nothing.
    for (const seam of PAYMENT_SEAMS) {
      expect([...REFERRAL_SERVICE_FILES, ...REFERRAL_DB_FILES]).toContain(seam);
      expect(NON_SEAM_FILES).not.toContain(seam);
    }
  });

  for (const wall of WALLS) {
    it(`does not reach ${wall.name}`, () => {
      const offenders = wall.files.filter((path) => {
        const source = wall.name.includes('OxyPay')
          ? readFileSync(path, 'utf8')
          : wall.valueImportsOnly === true
            ? valueImports(path)
            : code(path);
        return wall.pattern.test(source);
      });
      expect(offenders.map((path) => path.split('/').pop())).toEqual([]);
    });

    it(`would CATCH a reference to ${wall.name}`, () => {
      expect(wall.pattern.test(wall.probe)).toBe(true);
    });
  }

  it('reads the ledger SCHEMA from exactly two files, and both only read', () => {
    const ledgerImporters = [...REFERRAL_SERVICE_FILES, ...REFERRAL_DB_FILES]
      .filter((path) => /from\s+['"][^'"]*schema\/ledger[^'"]*['"]/.test(code(path)))
      .sort();
    // An EXACT set. #145 added the balance read and nothing else; a third file
    // reaching the ledger tables directly fails HERE.
    expect(ledgerImporters).toEqual([BALANCE_SEAM, LEDGER_SEAM].sort());

    for (const seam of [LEDGER_SEAM, BALANCE_SEAM]) {
      const source = code(seam);
      for (const writer of ['.insert(', '.update(', '.delete(', 'insertLedgerTransaction']) {
        expect(source.includes(writer), `${seam} calls ${writer}`).toBe(false);
      }
    }
    // The mutation self-test: the same scan against a seeded positive fires.
    expect('await db.insert(ledgerEntries)'.includes('.insert(')).toBe(true);
  });

  it('strips only TYPE imports from the payment wall, never value ones', () => {
    // The mutation self-test on the narrowing itself. A type import of the
    // ledger repository is erased and passes; the SAME module imported as a
    // value still fires, which is what keeps `posting.service.ts` a seam rather
    // than an ordinary file.
    const typeOnly = "import type { LedgerEntryInput } from '../../../db/payments/ledgerRepository.js';\n";
    const value = "import { insertLedgerTransaction } from '../../../db/payments/ledgerRepository.js';\n";
    const wall = WALLS.find((candidate) => candidate.valueImportsOnly === true);
    expect(wall).toBeDefined();
    if (!wall) return;
    expect(wall.pattern.test(typeOnly.replace(/import\s+type\s+\{[\s\S]*?\}\s+from\s+['"][^'"]*['"];?/g, ''))).toBe(false);
    expect(wall.pattern.test(value)).toBe(true);
  });

  it('WRITES the ledger from exactly ONE file (#145)', () => {
    // The exemption #144's version of this file refused, granted by #145 with
    // its reconciliation sweep in the same change. An EXACT set: a second writer
    // is a build failure, not a review comment.
    const writers = [...REFERRAL_SERVICE_FILES, ...REFERRAL_DB_FILES].filter((path) =>
      /insertLedgerTransaction/.test(code(path)),
    );
    expect(writers).toEqual([POSTING_SEAM]);

    // …and the writer books through the posting BUILDERS rather than composing
    // entries itself, so the account boundary it asserts is the one it writes.
    const posting = code(POSTING_SEAM);
    expect(posting.includes('assertReferralPosting')).toBe(true);
    for (const forbidden of ['retail_cost_recovery', 'procurement_expense', 'commission_revenue']) {
      expect(posting.includes(forbidden), `the writer names ${forbidden}`).toBe(false);
    }
    // The mutation self-test: the same scan against a seeded positive fires.
    expect("account: 'retail_cost_recovery',".includes('retail_cost_recovery')).toBe(true);
  });

  it('never reads an order, a listing or a variant to compute a base', () => {
    // ADR 0005's reward-base contract: "rules receive a base, they never
    // receive an order". The `RealizeFundingInput` type has no member for one,
    // and this is the import-graph half of the same statement — a gross basket
    // value is only reachable by reading the thing that holds it.
    const pattern =
      /from\s+['"][^'"]*(db\/orders|schema\/orders|db\/catalog|schema\/catalog|orderRepository)[^'"]*['"]/;
    const offenders = [...REWARD_FILES, ...REFERRAL_DB_FILES, ...sourceFiles(EARNINGS_DIR)].filter(
      (path) => pattern.test(code(path)),
    );
    expect(offenders.map((path) => path.split('/').pop())).toEqual([]);
    expect(pattern.test("import { findOrder } from '../../../db/orders/orderRepository.js';")).toBe(
      true,
    );
  });
});
