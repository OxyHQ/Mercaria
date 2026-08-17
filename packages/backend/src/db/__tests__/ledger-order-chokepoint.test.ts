/**
 * Every read that orders `ledger_entries` or `ledger_transactions` uses the
 * PUBLISHED order, or is a named exception with a stated disposition.
 *
 * ## What this protects, and why the realdb gate cannot
 *
 * `ledger.realdb.test.ts` proves the published order is TOTAL — no two rows
 * compare equal on it, so PostgreSQL has exactly one valid answer and the
 * planner cannot decide the sequence. That is a property of the tuple, and it
 * says nothing whatever about a reader that does not use the tuple.
 *
 * Issue #466 is what that costs. Three readers each spelled the ordering for
 * themselves — the operator trace twice and a test helper once — and all three
 * spelled it as a timestamp, which ties: every leg of a ledger transaction is
 * written by ONE `insert ... values` statement and `now()` is the transaction's,
 * so they share an instant to the microsecond. A tied `ORDER BY` is unspecified
 * in PostgreSQL, so the assertion over that helper passed or failed by luck. It
 * failed CI once during PR #462 and passed on the immediate re-run with no
 * change, which is how the defect survived every previous encounter.
 *
 * A fourth reader would reintroduce it in silence: nothing errors, nothing logs,
 * and the sequence is right almost every time. So the durable half of the
 * property is a census, and a new local ordering fails THIS test until somebody
 * decides what it is for — which is the point. A gate that skips what is missing
 * from its own map is not a gate, so a hit must be either compliant or named;
 * being in neither fails.
 *
 * ## Two things this deliberately does not do
 *
 * It does NOT strip comments, following `listing-publication-chokepoint.test.ts`:
 * the failure direction of scanning raw source is a false POSITIVE, corrected in
 * one line, while comment stripping truncates at a `//` inside a string literal
 * and can hide a real call.
 *
 * It does NOT scan only production. The defect #466 reports was IN A TEST, and a
 * fixture that orders the ledger for itself produces exactly the intermittent
 * red that started this. Tests are held to the same rule.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..', '..');

/**
 * The ledger tables' drizzle bindings, assembled rather than quoted.
 *
 * `listing-publication-chokepoint.test.ts`'s device: a census whose own probe is
 * written out becomes the offender it looks for. Concatenation keeps the literal
 * `ledgerEntries.` out of this file entirely, so the scan below can be pointed at
 * this file without a false hit — which matters, because the self-test at the
 * bottom builds offending source and a scanner that found it in its own fixture
 * would report a defect that is a test string.
 */
const LEDGER_BINDINGS = ['ledger' + 'Entries', 'ledger' + 'Transactions'] as const;

/** The exported tuples in `db/payments/ledgerRepository.ts` — the published order. */
const PUBLISHED_ORDERS = ['LEDGER_' + 'ENTRY_ORDER', 'LEDGER_' + 'TRANSACTION_ORDER'] as const;

/**
 * This file, excluded by NAME.
 *
 * Stated rather than left to the assembled bindings above: two independent
 * defences against a census implicating its own fixtures, because the cost of
 * getting it wrong is a permanently red gate somebody disables.
 */
const SELF = basename(fileURLToPath(import.meta.url));

/**
 * One `orderBy(...)` call site: the file it is in and its ARGUMENT text.
 *
 * The arguments are extracted with a balanced-parenthesis scan rather than a
 * regex. A regex bounded by the first `)` truncates on the very shape the
 * compliant spelling uses — `orderBy(...LEDGER_ENTRY_ORDER)` is fine but
 * `orderBy(desc(col), desc(col2))` is not — and a truncated argument list reads
 * as "names no ledger column", which is a false CLEAN.
 */
interface OrderBySite {
  readonly file: string;
  readonly args: string;
}

/** Every `.orderBy(` in one source text, with its balanced argument text. */
function orderBySites(file: string, source: string): OrderBySite[] {
  const sites: OrderBySite[] = [];
  const opener = /\.\s*orderBy\s*\(/gu;
  let match = opener.exec(source);
  while (match !== null) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < source.length && depth > 0) {
      const character = source[index];
      if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
      index += 1;
    }
    // An unbalanced tail means the scan ran off the end of the file, which can
    // only happen on source that does not parse. Recording it as a site with the
    // remaining text keeps the failure LOUD rather than silently dropping it.
    sites.push({ file, args: source.slice(start, depth === 0 ? index - 1 : source.length) });
    match = opener.exec(source);
  }
  return sites;
}

/** Does it order through the published tuple? */
function usesPublishedOrder(args: string): boolean {
  return PUBLISHED_ORDERS.some((order) => args.includes(order));
}

/**
 * Is this argument text ordering a ledger table at all?
 *
 * Either spelling counts, and the tuple half is not optional: the COMPLIANT
 * spelling is `orderBy(...LEDGER_ENTRY_ORDER)`, whose arguments never mention a
 * ledger column at all. Matching only on a column therefore filters every
 * compliant site out of the census BEFORE it is classified — so the floor below
 * counts two, the compliant count is zero, and a gate that could see only
 * offenders would report the codebase clean the moment the last one was fixed.
 * Caught by that floor on this file's first run, which is what it is for.
 */
function ordersLedger(args: string): boolean {
  return (
    usesPublishedOrder(args) || LEDGER_BINDINGS.some((binding) => args.includes(`${binding}.`))
  );
}

/** Every `.ts` under `src/`, excluding this file. */
function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts') || entry === SELF) continue;
    found.push(full);
  }
  return found;
}

/**
 * The readers that order a ledger table WITHOUT the published tuple, and why
 * each is right to.
 *
 * An exact array, and its exact length is asserted below: a list that only ever
 * grows is a gate that eventually permits everything, and a directory rule would
 * quietly cover a file nobody looked at.
 */
const PERMITTED_LOCAL_ORDERINGS: readonly {
  readonly path: string;
  readonly disposition: string;
}[] = [
  {
    path: join('db', 'payments', 'ledgerRepository.ts'),
    disposition:
      'the OWNER, and `findOpenMerchantPayables` orders by its own GROUP KEY `(order_id, currency)` rather than by the entry order — an aggregate has no entry rows to order, and the group key is total by definition of `GROUP BY`',
  },
  {
    path: join('db', 'referrals', 'commissionBaseRepository.ts'),
    disposition:
      'the DESC reading of the same key — `desc(created_at), desc(id)` with `limit 1`, to take the LATEST commission posting. It is total and it carries the uuid-v7 note; the published tuples are ASC, so it cannot spread them, and a DESC tuple exported for one caller would be an alias rather than a contract',
  },
];

describe('the ledger read order has one spelling', () => {
  const sites = sourceFiles(SRC_ROOT)
    .flatMap((file) => orderBySites(relative(SRC_ROOT, file), readFileSync(file, 'utf8')))
    .filter((site) => ordersLedger(site.args));

  it('finds ledger orderings at all', () => {
    // The vacuity floor. Every assertion below is also what ZERO sites would
    // report — a broken scanner, a moved directory or a renamed binding all
    // produce a clean, confident, meaningless green.
    expect(sites.length).toBeGreaterThanOrEqual(4);
    expect(sites.filter((site) => usesPublishedOrder(site.args)).length).toBeGreaterThanOrEqual(2);
  });

  it('lists every exception exactly, with no room left over', () => {
    // The exemption list needs its own exact count, or a fifth entry appended in
    // a hurry is indistinguishable from a decision.
    expect(PERMITTED_LOCAL_ORDERINGS).toHaveLength(2);
    for (const exception of PERMITTED_LOCAL_ORDERINGS) {
      expect(exception.disposition.length).toBeGreaterThan(40);
      // A named exception for a file that no longer orders the ledger is a stale
      // permission, and the direction it fails in is permissive.
      expect(sites.map((site) => site.file)).toContain(exception.path);
    }
  });

  it('has no ordering that is neither published nor named', () => {
    const permitted = new Set(PERMITTED_LOCAL_ORDERINGS.map((exception) => exception.path));
    const offenders = sites
      .filter((site) => !usesPublishedOrder(site.args) && !permitted.has(site.file))
      .map((site) => `${site.file}: orderBy(${site.args.replace(/\s+/gu, ' ').trim()})`);

    // The message is the whole value of this gate: whoever trips it needs to know
    // that the ledger's timestamps tie, not merely that a list did not match.
    expect(
      offenders,
      'Order the ledger through LEDGER_ENTRY_ORDER / LEDGER_TRANSACTION_ORDER ' +
        '(db/payments/ledgerRepository.ts). Its timestamps TIE — every leg of a ' +
        'transaction is written by one statement — and a tied ORDER BY is ' +
        'unspecified in PostgreSQL, which is issue #466. If this ordering is ' +
        'deliberately different, add it to PERMITTED_LOCAL_ORDERINGS with a reason.',
    ).toEqual([]);
  });

  it('self-test: the scanner sees an offending ordering, and passes a compliant one', () => {
    // Built by concatenation so neither fixture appears literally in this file —
    // the scan is pointed at `src/` and this file lives there.
    const column = `${LEDGER_BINDINGS[0]}.createdAt`;
    const offending = orderBySites('synthetic.ts', `db.select().orderBy(${column}, foo(bar));`);
    expect(offending).toHaveLength(1);
    expect(ordersLedger(offending[0].args)).toBe(true);
    expect(usesPublishedOrder(offending[0].args)).toBe(false);

    // The balanced scan is what makes the nested call above readable at all: a
    // regex stopping at the first `)` would cut after `foo(bar` and still see the
    // column, but on `orderBy(desc(a), desc(b))` it cuts after `desc(a` — so the
    // compliant-detection half is the one a truncating scanner gets wrong.
    const compliant = orderBySites(
      'synthetic.ts',
      `db.select().orderBy(...${PUBLISHED_ORDERS[0]}, other(${column}));`,
    );
    expect(compliant).toHaveLength(1);
    expect(ordersLedger(compliant[0].args)).toBe(true);
    expect(usesPublishedOrder(compliant[0].args)).toBe(true);

    // And an ordering that names no ledger table is invisible to the census.
    const unrelated = orderBySites('synthetic.ts', 'db.select().orderBy(payments.createdAt);');
    expect(unrelated).toHaveLength(1);
    expect(ordersLedger(unrelated[0].args)).toBe(false);
  });
});
