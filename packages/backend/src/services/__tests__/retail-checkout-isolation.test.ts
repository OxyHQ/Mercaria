/**
 * The Mercaria-retail checkout path's structural boundaries (#123, ADR 0004),
 * asserted by SCAN rather than by fixture.
 *
 * Each is a claim about what the path CANNOT do, and a behavioural test can
 * only ever say "it did not this time". The argument, the vacuity floor and the
 * mutation self-test are `checkout-contact-isolation.test.ts`'s, reused
 * deliberately rather than reinvented — a second scanner shape would be a
 * second thing to keep correct.
 *
 * Five walls, and the reason each is a scan rather than a branch:
 *
 *  1. **The checkout path still imports no Stripe module.** ADR 0001's last
 *     consequence, unchanged by #123: a Stripe import in `checkout.service`
 *     would make the card rail structural to placing an order, and the retail
 *     work touches that file more than anything since #105.
 *  2. **The retail path adds no markup, margin or surcharge.** ADR 0004 D3/D8.4
 *     — the vocabulary makes those unrepresentable, and this makes the WORDS
 *     unwritable in the modules that compose an amount, so a future author
 *     cannot introduce one under a plausible name.
 *  3. **No feature flag gates a durable record.** ADR 0004 D4 concern 13:
 *     `MERCARIA_RETAIL_ENABLED` gates checkout ENTRY, and a rollback must leave
 *     procurement, refunds and reconciliation draining. The modules that finish
 *     an order already placed must be unable to read the lever.
 *  4. **A supplier is never a Connect transfer recipient.** ADR 0004 D6.8 — the
 *     retail path must not reach the transfer machinery at all.
 *  5. **The retail engine cannot reach the fee domain, and no retail order can
 *     book a commission.** ADR 0004 D7 proof 1, and #120's existing rule
 *     extended to the checkout half.
 *
 * Plus the disjointness the vocabularies rest on, and no OxyPay or FairCoin
 * anywhere (ADR 0004 D11 — the words appear in this initiative only as
 * prohibitions).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEDGER_ACCOUNTS,
  RETAIL_CHECKOUT_REFUSALS,
  RETAIL_COST_VARIANCE_DIRECTIONS,
  RETAIL_FORBIDDEN_ACCOUNTS,
  RETAIL_FORBIDDEN_CHECKOUT_OUTCOMES,
  RETAIL_PROCUREMENT_FAILURE_KINDS,
  RETAIL_REVENUE_SIDE_ACCOUNTS,
} from '@mercaria/shared-types';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A directory entry, as `readdirSync(..., { withFileTypes: true })` reports one. */
type DirectoryEntry = { name: string; isDirectory: () => boolean; isFile: () => boolean };
type DirectoryReader = (relative: string) => DirectoryEntry[];

const readDirectory: DirectoryReader = (relative) =>
  readdirSync(join(SRC_ROOT, relative), { withFileTypes: true });

/**
 * Every `.ts` under `relative`, recursively, excluding the test tree.
 *
 * Takes its reader so the positive controls below can ask "would the derivation
 * get a module that does not exist yet?" of the REAL derivation rather than of a
 * re-spelling of it. Walking `''` yields paths with no leading slash, which is
 * what makes the whole-tree sweep comparable with the population.
 */
function walk(relative: string, readDir: DirectoryReader = readDirectory): string[] {
  const found: string[] = [];
  for (const entry of readDir(relative)) {
    if (entry.name === '__tests__') continue;
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(child, readDir));
    else if (entry.name.endsWith('.ts')) found.push(child);
  }
  return found;
}

/** Anything whose name carries this domain, in either spelling. */
const DOMAIN_NAMED = /retail-checkout|retailCheckout/i;

/**
 * The shared flat directories a retail-checkout module lives in under a domain
 * NAME.
 *
 * `db/schema` is the one that had a module and no scan: the domain owns
 * `db/schema/retailCheckout.ts` — the four tables, the append-only procurement
 * intent and the variance record that BOOKS NOTHING — and no wall in this file
 * reached it. The HTTP directories hold no retail-checkout module today and are
 * listed for the mechanism, not for a count: the whole-tree assertion is what
 * reports one the day it appears.
 */
const RETAIL_SHARED_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'] as const;

/**
 * Every retail-checkout-NAMED module in a shared flat directory.
 *
 * RECURSES, via `walk` — the asymmetry #460 measured in 27 gates is a
 * one-level `readdirSync` sitting beside a recursive walk, ten lines apart, so
 * the file reads as though it recurses throughout. It is live rather than
 * latent: `routes/admin/merchant-activation.ts` is the module it dropped in a
 * sibling gate.
 */
function sharedSurface(readDir: DirectoryReader = readDirectory): string[] {
  return RETAIL_SHARED_DIRECTORIES.flatMap((directory) =>
    walk(directory, readDir).filter((path) => DOMAIN_NAMED.test(path.split('/').pop() ?? '')),
  );
}

/**
 * Every module in the tree whose PATH names this domain — the assertion that
 * closes the population against the NEXT mechanism, not only this one.
 *
 * Matched on the PATH, not the filename: a module inside
 * `services/retail-checkout/` names the domain nowhere in its own name, so a
 * filename sweep reports a fraction of the domain and an empty "outside" set,
 * which reads exactly like a clean pass.
 *
 * Note the two `ENTRY_PATHS` are in the population and NOT in this sweep — they
 * are named for checkout rather than for retail checkout. The assertion is
 * one-directional on purpose: everything the tree calls this domain must be
 * covered, and the population may additionally cover modules it names itself.
 */
function domainNamedModules(readDir: DirectoryReader = readDirectory): string[] {
  return walk('', readDir).filter((path) => DOMAIN_NAMED.test(path));
}

/**
 * The two entry modules that live outside this domain's directories.
 *
 * `services/checkout/retail.ts` sits in #105's checkout directory and
 * `services/checkout.service.ts` is the marketplace shell — walking either root
 * here would pull in the whole of another gate's population. Kept as a hand list
 * with an EXACT count and a comment claiming only what the list IS (#460's other
 * sanctioned resolution).
 */
const ENTRY_PATHS = ['services/checkout/retail.ts', 'services/checkout.service.ts'];

/**
 * The retail checkout path, end to end — WALKED plus the two counted entry
 * modules (#460).
 *
 * The list this replaces named the same six and was complete on the day it was
 * written; what it could not cover is the seventh.
 */
const RETAIL_PATHS = [
  ...walk('services/retail-checkout'),
  ...walk('db/retailCheckout'),
  ...sharedSurface(),
  ...ENTRY_PATHS,
];

/**
 * The modules #123 AUTHORED, which must not mention OxyPay or FairCoin in code
 * OR in prose (ADR 0004 D11: "the words appear in this document only as
 * prohibitions").
 *
 * `checkout.service.ts` is deliberately absent and is scanned against
 * COMMENT-STRIPPED source instead. It carries a pre-existing note explaining
 * that the `oxy_pay` provider default was RETIRED — which is exactly the kind
 * of honest historical record that must survive, and banning it would delete
 * the explanation of why a column has no default. The distinction is real
 * rather than a concession: a new module has no history to record, so a mention
 * in one can only be an intention.
 */
const RETAIL_AUTHORED_PATHS = RETAIL_PATHS.filter(
  (relative) => relative !== 'services/checkout.service.ts',
);

/**
 * The modules that FINISH an order already placed — ADR 0004 D4 concern 13's
 * "the flag gates entry only".
 *
 * `checkout.service` and `services/checkout/retail.ts` are deliberately NOT
 * here: they ARE the entry, and gating them is what the flag is for.
 */
const POST_ENTRY_PATHS = [
  'services/retail-checkout/authorization.ts',
  'services/retail-checkout/fulfilment.service.ts',
  'services/payments/outbox-handlers.ts',
  'services/supplier-orders/procurement-outcome.port.ts',
  'services/supplier-orders/outbox-handlers.ts',
];

/** ADR 0004 D11: the words appear in this initiative only as prohibitions. */
const OXYPAY_OR_FAIRCOIN_REFERENCE = /oxy_?[Pp]ay|OxyPay|[Ff]air[Cc]oin/;

/**
 * A Stripe module reached from the checkout path — ADR 0001's last consequence.
 *
 * The pattern names the IMPORT rather than the word: `checkout.service`'s own
 * prose says "a Stripe import in the checkout path would make the card rail
 * structural to placing an order", and a detector that banned the word would
 * make that sentence a violation.
 */
const STRIPE_IMPORT_REFERENCE = /from\s+['"][^'"]*stripe[^'"]*['"]|require\(['"]stripe/i;

/**
 * A markup, a margin target or a surcharge, by any plausible name — ADR 0004
 * D3's seven prohibitions and D8.4's "there is no surcharge mechanism, no
 * follow-up invoice, no price correction path; nothing in #123–#128 may build
 * one".
 *
 * Scanned against COMMENT-STRIPPED source, because these modules document what
 * they refuse to do in exactly this vocabulary — the false-positive class
 * `~/Oxy/AGENTS.md` says to fix BEFORE a scanner becomes a gate.
 */
const MARKUP_REFERENCE =
  /markupMinor|marginTarget|marginBps|markupBps|profitMinor|upliftMinor|surchargeMinor|applyMarkup|addMargin|priceCorrection|supplementalCharge/;

/** The retail entry lever, which nothing past entry may read. */
const RETAIL_FLAG_REFERENCE = /config\.retail\b|MERCARIA_RETAIL_ENABLED/;

/**
 * The Connect transfer machinery — ADR 0004 D6.8, "procurement is Mercaria
 * BUYING; it stays on bank rails".
 */
const TRANSFER_REFERENCE =
  /settlePaymentTransfers|createOrGetTransfer|transferCreated|settlement\.service|createTransfer/;

/** The fee domain and the commission account — ADR 0004 D7 proof 1. */
const FEE_DOMAIN_REFERENCE = /\/fees\/|calculateFee|feeScheduleRepository|commission_revenue/;

/**
 * The modules the fee wall applies to — DERIVED by subtracting the ONE module
 * that legitimately prices a marketplace fee.
 *
 * `services/checkout.service.ts` is the marketplace shell and reaches the fee
 * domain by design; nothing else in the retail path does (measured). The list
 * this replaces named four of six directly, so `registration.ts` sat outside the
 * wall with no reason recorded — and it passes. Deriving the EXCLUSION rather
 * than the inclusion means a module added tomorrow is held to this wall by
 * default, which matters here because ADR 0004 D7 proof 1 is that a
 * zero-markup retail sale must never post `commission_revenue`.
 */
const FEE_PRICING_MODULES = ['services/checkout.service.ts'];

const NO_FEE_DOMAIN_PATHS = RETAIL_PATHS.filter(
  (relative) => !FEE_PRICING_MODULES.includes(relative),
);

/** Read a path in the retail set, refusing an empty or moved file. */
function readRetailSource(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/** The same source with comments removed — what the REACHABILITY detectors scan. */
function readRetailCode(relative: string): string {
  const stripped = readRetailSource(relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  expect(
    stripped.replace(/\s+/g, '').length,
    `${relative} has almost no code left after comment stripping — check the stripper`,
  ).toBeGreaterThan(200);
  return stripped;
}

describe('the Mercaria-retail checkout path cannot reach what it must not', () => {
  it('no module #123 authored names OxyPay or FairCoin, in code or prose (ADR 0004 D11)', () => {
    let scanned = 0;
    for (const relative of RETAIL_AUTHORED_PATHS) {
      expect(
        OXYPAY_OR_FAIRCOIN_REFERENCE.test(readRetailSource(relative)),
        `${relative} names OxyPay or FairCoin; ADR 0004 D11 excludes both outright`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(RETAIL_AUTHORED_PATHS.length);
    // Vacuity floor: a filter that emptied the list would pass the loop above.
    expect(scanned).toBeGreaterThanOrEqual(5);
  });

  it('no retail path can REACH an OxyPay or FairCoin rail in code', () => {
    let scanned = 0;
    for (const relative of RETAIL_PATHS) {
      expect(
        OXYPAY_OR_FAIRCOIN_REFERENCE.test(readRetailCode(relative)),
        `${relative} reaches an OxyPay or FairCoin rail; ADR 0004 D11 forbids one existing`,
      ).toBe(false);
      scanned += 1;
    }
    // Vacuity floors PER SHAPE rather than one on the total: the three sources
    // break independently, and one total would let a walk collapse to zero while
    // the others carried the number. `scanned === RETAIL_PATHS.length` is kept
    // but is NOT a floor — it is circular, holding for any list including an
    // empty one.
    const from = (prefix: string) => RETAIL_PATHS.filter((path) => path.startsWith(prefix)).length;
    expect(from('services/retail-checkout/'), 'the service walk found nothing').toBeGreaterThanOrEqual(3);
    expect(from('db/retailCheckout/'), 'the repository walk found nothing').toBeGreaterThanOrEqual(1);
    expect(from('db/schema/'), 'the schema module left the population').toBeGreaterThanOrEqual(1);
    // EXACT: both hand lists are identities, not predicates (#448).
    expect(ENTRY_PATHS.length, 'the entry list changed size').toBe(2);
    expect(FEE_PRICING_MODULES.length, 'a second fee-pricing module was excused').toBe(1);
    expect(POST_ENTRY_PATHS.length, 'the post-entry list changed size').toBe(5);
    expect(RETAIL_PATHS.length, 'the retail path derivation found nothing').toBeGreaterThanOrEqual(7);
    for (const path of RETAIL_PATHS) {
      expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} is not a file`).toBe(true);
    }
    expect(RETAIL_PATHS.filter((path) => path.includes('__tests__'))).toEqual([]);
    for (const path of FEE_PRICING_MODULES) {
      expect(RETAIL_PATHS, `${path} is excused from the fee wall but is not in the path`).toContain(path);
    }
    expect(scanned).toBe(RETAIL_PATHS.length);
  });

  it('no retail-checkout-named module anywhere in src/ sits outside the population', () => {
    // #460's whole-tree assertion. This gate had no shared-directory scan at
    // all, so `db/schema/retailCheckout.ts` — the four tables, the append-only
    // procurement intent, the variance record that books nothing — sat outside
    // every wall in this file. Deriving the EXCLUSION rather than the inclusion
    // is what makes a new bag directory bring its modules under the walls with
    // no edit here.
    const swept = domainNamedModules();

    // The sweep's OWN vacuity floor: a traversal that reached nothing reports no
    // module outside the population, which is the same answer a complete
    // population gives. MEASURED at 5.
    expect(
      swept.length,
      'the whole-tree sweep found almost nothing; it cannot report a module outside the ' +
        'population if it never reached one',
    ).toBeGreaterThanOrEqual(4);

    // EXACT and empty, and empty because MEASURED empty rather than guessed.
    const population = new Set(RETAIL_PATHS);
    expect(
      swept.filter((path) => !population.has(path)),
      'names retail checkout but sits outside the population every wall here scans — add its ' +
        'directory to RETAIL_SHARED_DIRECTORIES, or excuse it here with a reason and move the count',
    ).toEqual([]);

    // THE POSITIVE CONTROL: `toEqual([])` is also what a sweep that reached
    // nothing produces, so the same sweep runs against a reader reporting a
    // retail-checkout-named module in a directory the population does NOT draw
    // from, and it must come back OUTSIDE.
    const planted = 'lib/retail-checkout-cache.ts';
    const seeded = domainNamedModules((relative) =>
      relative === 'lib'
        ? [...readDirectory(relative), { name: 'retail-checkout-cache.ts', isDirectory: () => false, isFile: () => true }]
        : readDirectory(relative),
    );
    expect(seeded, 'the sweep did not reach a planted module').toContain(planted);
    expect(
      seeded.filter((path) => !population.has(path)),
      'a module the population does not cover was NOT reported outside it — the empty result ' +
        'above is a probe that cannot fail rather than a measurement',
    ).toEqual([planted]);
    expect(domainNamedModules()).not.toContain(planted);

    // And the POPULATION is still NARROW — the third world `toEqual([])` admits
    // and the one the plant cannot see, since a plant absent from the real sweep
    // is reported outside a population built FROM that sweep exactly as it is
    // outside a correct one. This matters more here than in most gates: this
    // population's walls forbid reaching the FEE domain and Connect transfers,
    // and half the payment tree would trip them.
    for (const foreign of [
      'controllers/orders.controller.ts',
      'db/schema/orders.ts',
      'services/payments/settlement.service.ts',
      'middleware/auth.ts',
    ]) {
      expect(RETAIL_PATHS, `${foreign} belongs to another domain`).not.toContain(foreign);
      expect(
        statSync(join(SRC_ROOT, foreign)).isFile(),
        `${foreign} no longer exists, so excluding it proves nothing`,
      ).toBe(true);
    }
  });

  it('a module ADDED to the domain is scanned — the direction a hand list is blind in', () => {
    // The probe that justifies the conversion, kept as a test rather than as a
    // claim that one was run once. Written against the DERIVATION rather than
    // the filesystem: seeding a real file would mutate a tree shared with every
    // parallel suite.
    const seededWith = (directory: string, added: string): string[] =>
      sharedSurface((relative) =>
        relative === directory
          ? [...readDirectory(relative), { name: added, isDirectory: () => false, isFile: () => true }]
          : readDirectory(relative),
      );

    expect(
      seededWith('db/schema', 'retailCheckoutArchive.ts'),
      'a new retail-checkout schema module does not enter the population',
    ).toContain('db/schema/retailCheckoutArchive.ts');
    expect(
      seededWith('routes', 'retail-checkout.ts'),
      'a new retail-checkout route does not enter the population; it would sit behind no wall',
    ).toContain('routes/retail-checkout.ts');
    // … and ONLY by name, or these walls start firing at whoever edits an order.
    expect(
      seededWith('routes', 'orders.ts'),
      'a foreign route entered the population; the name rule has stopped narrowing',
    ).not.toContain('routes/orders.ts');

    // And the RECURSION, the other half of the #460 repair.
    expect(
      sharedSurface((relative) =>
        relative === 'routes'
          ? [...readDirectory(relative), { name: 'admin', isDirectory: () => true, isFile: () => false }]
          : relative === 'routes/admin'
            ? [{ name: 'retail-checkout.ts', isDirectory: () => false, isFile: () => true }]
            : readDirectory(relative),
      ),
      'a module in a SUBDIRECTORY of a shared directory is not admitted; the sweep beside the ' +
        'recursive walk is still one level deep',
    ).toContain('routes/admin/retail-checkout.ts');
  });

  it('checkout.service still imports no Stripe module (ADR 0001)', () => {
    for (const relative of ['services/checkout.service.ts', 'services/checkout/retail.ts']) {
      expect(
        STRIPE_IMPORT_REFERENCE.test(readRetailCode(relative)),
        `${relative} imports a Stripe module; the rail must stay behind services/payments/`,
      ).toBe(false);
    }
  });

  it('no retail module can name a markup, a margin target or a surcharge', () => {
    let scanned = 0;
    for (const relative of RETAIL_PATHS) {
      expect(
        MARKUP_REFERENCE.test(readRetailCode(relative)),
        `${relative} names a markup, margin or surcharge; ADR 0004 D3/D8.4 forbid all of them`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(RETAIL_PATHS.length);
  });

  it('nothing past checkout entry reads the retail feature flag (ADR 0004 D4 concern 13)', () => {
    let scanned = 0;
    for (const relative of POST_ENTRY_PATHS) {
      expect(
        RETAIL_FLAG_REFERENCE.test(readRetailCode(relative)),
        `${relative} reads the retail entry flag; a rollback must leave in-flight orders draining`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(POST_ENTRY_PATHS.length);
  });

  it('the retail path never reaches Connect transfer creation (ADR 0004 D6.8)', () => {
    let scanned = 0;
    for (const relative of NO_FEE_DOMAIN_PATHS) {
      expect(
        TRANSFER_REFERENCE.test(readRetailCode(relative)),
        `${relative} reaches transfer creation; a supplier is never a connected account`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(NO_FEE_DOMAIN_PATHS.length);
  });

  it('the retail engine cannot reach the fee domain or the commission account', () => {
    let scanned = 0;
    for (const relative of NO_FEE_DOMAIN_PATHS) {
      expect(
        FEE_DOMAIN_REFERENCE.test(readRetailCode(relative)),
        `${relative} reaches the fee domain; a mercaria_retail order pays no marketplace fee`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(NO_FEE_DOMAIN_PATHS.length);
  });

  /**
   * The mutation self-test, run against SEEDED positives.
   *
   * Without it a broken regex passes by matching nothing, and every assertion
   * above would read as a proven wall while proving only that the scanner ran.
   * Each detector is given text that MUST trip it.
   */
  it('every detector above trips on a seeded positive', () => {
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test('await payWithOxyPay(order)')).toBe(true);
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test('// settles in FairCoin')).toBe(true);
    expect(STRIPE_IMPORT_REFERENCE.test("import Stripe from 'stripe';")).toBe(true);
    expect(STRIPE_IMPORT_REFERENCE.test("from './payments/stripe/client.js'")).toBe(true);
    expect(MARKUP_REFERENCE.test('const markupMinor = base * 0.1;')).toBe(true);
    expect(MARKUP_REFERENCE.test('applyMarkup(total)')).toBe(true);
    expect(MARKUP_REFERENCE.test('await supplementalCharge(order)')).toBe(true);
    expect(RETAIL_FLAG_REFERENCE.test('if (config.retail.enabled) return;')).toBe(true);
    expect(TRANSFER_REFERENCE.test('await settlePaymentTransfers(paymentId)')).toBe(true);
    expect(FEE_DOMAIN_REFERENCE.test("from '../fees/fee-calculation.js'")).toBe(true);
    expect(FEE_DOMAIN_REFERENCE.test("account: 'commission_revenue'")).toBe(true);
  });
});

describe('the retail vocabularies are disjoint and closed', () => {
  it('no forbidden outcome is spelled the same as a real refusal or failure', () => {
    const real = new Set<string>([
      ...RETAIL_CHECKOUT_REFUSALS,
      ...RETAIL_PROCUREMENT_FAILURE_KINDS,
      ...RETAIL_COST_VARIANCE_DIRECTIONS,
    ]);
    expect(real.size).toBeGreaterThan(10);
    for (const forbidden of RETAIL_FORBIDDEN_CHECKOUT_OUTCOMES) {
      expect(real.has(forbidden), `${forbidden} is both forbidden and representable`).toBe(false);
    }
    expect(RETAIL_FORBIDDEN_CHECKOUT_OUTCOMES.length).toBeGreaterThan(5);
  });

  /**
   * ADR 0004 D7 proof 1, as a value rather than a paragraph: the accounts a
   * retail order's money may be credited to, and the ones it may never touch,
   * are disjoint — and `commission_revenue` is on the second list.
   */
  it('retail revenue-side and forbidden accounts are disjoint, and both are real accounts', () => {
    const revenue = new Set<string>(RETAIL_REVENUE_SIDE_ACCOUNTS);
    expect(revenue.size).toBeGreaterThan(0);
    for (const forbidden of RETAIL_FORBIDDEN_ACCOUNTS) {
      expect(revenue.has(forbidden), `${forbidden} is both permitted and forbidden`).toBe(false);
      expect(
        (LEDGER_ACCOUNTS as readonly string[]).includes(forbidden),
        `${forbidden} is not a real ledger account; the prohibition names nothing`,
      ).toBe(true);
    }
    expect(RETAIL_FORBIDDEN_ACCOUNTS).toContain('commission_revenue');
    expect(RETAIL_REVENUE_SIDE_ACCOUNTS).toContain('retail_cost_recovery');
  });

  /**
   * There is NO account a retail margin could accumulate in — ADR 0004 D7's
   * closing sentence, checked against the chart itself rather than asserted.
   */
  it('the chart of accounts holds nothing a retail margin could sit in', () => {
    for (const account of LEDGER_ACCOUNTS) {
      expect(
        /retail_(margin|profit|revenue)\b/.test(account),
        `${account} is an account a retail margin could accumulate in`,
      ).toBe(false);
    }
    // Vacuity floor: a chart that had been emptied would pass the loop above.
    expect(LEDGER_ACCOUNTS.length).toBeGreaterThanOrEqual(8);
  });
});
