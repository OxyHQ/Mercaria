/**
 * The buyer-request domain's structural boundaries (#110), asserted by SCAN.
 *
 * Every claim below is about what a path CANNOT do, and a behavioural test can
 * only ever say "it did not this time". The strongest of them — a buyer path
 * that cannot reach an order writer — is the whole of acceptance 2, and it is
 * checkable here by reading a list of imports rather than by tracing branches
 * through six services.
 *
 * Both defences from `~/Oxy/AGENTS.md` are present: a VACUITY FLOOR, so a moved
 * or emptied file fails the gate instead of shrinking it silently, and a
 * MUTATION SELF-TEST per detector, so a regex that matches nothing cannot pass
 * by being broken. `guest-portal-isolation.test.ts` is the precedent.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUYER_REQUEST_FORBIDDEN_IDENTIFIERS } from '@mercaria/shared-types';
import { SUPPORT_FORBIDDEN_AUTOMATIC_OUTCOMES } from '@mercaria/shared-types';
import {
  BUYER_REQUEST_DECISION_REFUSALS,
  BUYER_REQUEST_EVENT_KINDS,
  BUYER_REQUEST_TRANSITION_REFUSALS,
} from '@mercaria/shared-types';
import { buyerRequestBodySchemas } from '../../controllers/buyer-requests.schemas.js';
import { assertEachOf } from '../../__tests__/assert-each-of.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A directory entry, as `readdirSync(..., { withFileTypes: true })` reports one. */
type DirectoryEntry = { name: string; isDirectory: () => boolean; isFile: () => boolean };
type DirectoryReader = (relative: string) => DirectoryEntry[];

const readDirectory: DirectoryReader = (relative) =>
  readdirSync(join(SRC_ROOT, relative), { withFileTypes: true });

/**
 * Every `.ts` under `relative`, recursively, excluding the test tree.
 *
 * Takes its reader so the positive control below can ask "would the sweep get a
 * module that does not exist yet?" of the REAL sweep rather than of a
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

/**
 * The domain's HTTP surface, derived from the filename convention every module
 * in these flat directories already follows (#472's device).
 *
 * `buyer-request` rather than `buyer-requests.` so a singular sibling is caught
 * too: the cost of the looser prefix is nil here — nothing else in the tree is
 * named for a buyer request — and the cost of the tighter one is a module that
 * looks covered and is not.
 *
 * It deliberately does NOT reach `routes/orders.ts` or `routes/guest-orders.ts`,
 * the two files that MOUNT this domain's router. A route that mounts decides
 * nothing and its imports are the union of every surface on it, so scanning one
 * as a buyer-request module would fail this gate for a co-location — #483's
 * `AGGREGATOR_ROUTES` reasoning, reached here by the derivation never selecting
 * them rather than by an exclusion that would need its own count.
 */
/** Anything whose PATH names this domain, in either spelling. */
const DOMAIN_NAMED = /buyer-request|buyerRequest/i;

/**
 * RECURSES, via `walk`. This was `readdirSync(...).filter(entry.isFile())` — one
 * level — sitting below a `walk` that recurses, so the file read as though it
 * recursed throughout and did not (#460). `merchant-activation` had the same
 * asymmetry and a real module behind it; the whole-tree assertion below is what
 * makes the absence of one here a MEASUREMENT rather than a hope.
 */
function httpSurface(): string[] {
  return ['controllers', 'routes', 'middleware'].flatMap((directory) =>
    walk(directory).filter((path) => DOMAIN_NAMED.test(basename(path))),
  );
}

/**
 * Every module in the domain, WALKED rather than listed (#460).
 *
 * The hand list this replaces named all 20 modules and was complete on the day
 * it was written, which is exactly the defect: what a list omits is whatever
 * somebody adds next, and that is the module nobody has reviewed.
 */
const DOMAIN_PATHS = [
  ...walk('services/buyer-requests'),
  ...walk('db/buyerRequests'),
  ...httpSurface(),
  'db/schema/buyerRequests.ts',
];

/**
 * Every module in the tree whose PATH names this domain (#609's device).
 *
 * Closes the population against the NEXT mechanism rather than this one: two
 * different misses were possible here — a non-recursing HTTP sweep and an
 * unscanned `db/schema` — and one assertion covers both. Matched on the PATH,
 * not the filename, because a module inside `services/buyer-requests/` names the
 * domain nowhere in its own name and a filename sweep would report an empty
 * "outside" set, which reads as a clean pass.
 */
function domainNamedModules(readDir: DirectoryReader = readDirectory): string[] {
  return walk('', readDir).filter((path) => DOMAIN_NAMED.test(path));
}

/**
 * The modules that may reach an order writer or the refund service — the ONLY
 * crossings in the domain, each with the reason it is one.
 *
 * An EXACT count rather than a floor, because this is the one hand list left and
 * an unbounded exclusion list is a predicate rather than an identity (#448). The
 * positive half of the gate then asserts each of these genuinely DOES cross, so
 * a stale exclusion cannot go on excusing a module that stopped needing it.
 *
 * The direction matters: `BUYER_PATHS` is derived by SUBTRACTING these from the
 * domain walk, so a module added tomorrow lands in the buyer half by default and
 * is held to the STRICTER wall. The list this replaced named the buyer half
 * directly, so a new module landed in neither and was behind no wall at all —
 * and six modules already sat outside the buyer wall for no reason:
 * `notifications.ts`, `projection.ts`, `reconciler.ts`, both controllers and the
 * route, every one of which passes it.
 */
const CROSSING_PATHS = [
  {
    path: 'services/buyer-requests/cancellation-decision.service.ts',
    /** A seller's decision: transitions the order AND refunds. */
    crosses: 'order',
  },
  {
    path: 'services/buyer-requests/return-decision.service.ts',
    /** A seller's decision: refunds once the goods are `received`. */
    crosses: 'refund',
  },
  {
    path: 'services/buyer-requests/refund-bridge.ts',
    /** #110 refund rule 4's single crossing onto the payment domain. */
    crosses: 'refund',
  },
] as const;

/**
 * The BUYER path — everything a request travels through before a seller has
 * decided anything. DERIVED: the domain walk minus the counted crossings.
 *
 * These may not reach an order writer, a refund service, an inventory function
 * or the payment domain. That is #110 acceptance 2 ("a guest cannot mutate
 * status or provider payment directly") as a property of the import graph.
 */
const BUYER_PATHS = DOMAIN_PATHS.filter(
  (path) => !CROSSING_PATHS.some((entry) => entry.path === path),
);

/** An order STATUS writer. `transition` is the only lifecycle authority. */
const ORDER_WRITER_REFERENCE =
  /from\s+['"][^'"]*order\.service|setOrderStatus|transitionOrderStatus/;

/** The refund service and the bridge onto it. */
const REFUND_REFERENCE = /from\s+['"][^'"]*refund\.service|refundForBuyerRequest/;

/** Any inventory movement. Restock happens once, in the commerce path. */
const INVENTORY_REFERENCE =
  /from\s+['"][^'"]*inventory\.service|\b(?:restock|release|commit)\s*\(/;

/**
 * The payment domain. The buyer path never reads a provider, a payment
 * aggregate or a ledger — #110 refund rule 4 puts provider truth on the other
 * side of the seam, and `refund-bridge.ts` is the only crossing.
 *
 * `\.\./payments/` is the spelling a module in `services/buyer-requests/`
 * actually writes — the payment domain is one `../` away — and matching only
 * the absolute-looking `services/payments/` form missed it entirely. One
 * alternative covers every depth: however many `../` segments precede it, the
 * last always abuts the directory, so `../payments/`, `../../payments/` and
 * deeper all contain the literal `../payments/`.
 */
const PAYMENT_DOMAIN_REFERENCE = /services\/payments\/|\.\.\/payments\//;

/**
 * A REVIEW or a moderation case. #110 support rules 7 and 8: a support message
 * never becomes a public review or a CrowdSource case automatically, and abuse
 * reporting routes to the existing `POST /reports`.
 */
const REVIEW_OR_MODERATION_REFERENCE =
  /services\/reviews?\/|review\.service|services\/moderation\/|abuse_?[Rr]eports|reportIntake/;

/** Marketing consent. Communication rule 3 — this domain subscribes nobody. */
const MARKETING_REFERENCE = /marketingOptIn|marketing_opt_in|subscribe|mailingList/;

/** The plaintext contact decrypt. Only #108's send path may hold it. */
const DECRYPT_REFERENCE = /decryptGuestPii/;

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
 * detectors use — `cancellation-request.service.ts` explains that it imports no
 * refund service, `support.service.ts` explains that it writes no review — so a
 * scan over raw text would fail on the prose that proves the rule is
 * understood. The `checkout-contact-isolation.test.ts` decision, verbatim.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('buyer request isolation (static)', () => {
  it('scans every module in the domain', () => {
    // The vacuity floors, PER SHAPE rather than one on the total. The three
    // sources break independently — a renamed `db/buyerRequests` would empty one
    // walk while the other two carried the number, and a single total on 20
    // would still pass. Each floor is today's count, so a SHRINK stops the build
    // rather than quietly narrowing every assertion below.
    const from = (prefix: string) => DOMAIN_PATHS.filter((path) => path.startsWith(prefix)).length;
    expect(from('services/buyer-requests/'), 'the service walk found nothing').toBeGreaterThanOrEqual(
      13,
    );
    expect(from('db/buyerRequests/'), 'the repository walk found nothing').toBeGreaterThanOrEqual(4);
    expect(httpSurface().length, 'the HTTP surface derivation found nothing').toBeGreaterThanOrEqual(
      3,
    );
    expect(BUYER_PATHS.length).toBeGreaterThanOrEqual(17);

    // The whole-tree assertion (#609), with its own vacuity floor first: a sweep
    // that reached nothing produces the same empty "outside" set a complete
    // population does.
    const named = domainNamedModules();
    expect(named.length, 'the domain-name sweep found nothing').toBeGreaterThanOrEqual(17);
    expect(
      named.filter((path) => !DOMAIN_PATHS.includes(path)).sort(),
      'names this domain but is outside the population every wall below scans',
    ).toEqual([]);

    // THE POSITIVE CONTROL, added in #460's follow-up, and without it the
    // assertion above cannot fail: `toEqual([])` is satisfied by a correct
    // tree, by a sweep that reached nothing AND by a population containing
    // everything, and the vacuity floor covers only the second. So the same
    // sweep runs against a reader reporting a domain-named module in a
    // directory the population does NOT draw from, and it must come back
    // OUTSIDE.
    const planted = 'lib/buyer-request-cache.ts';
    const seeded = domainNamedModules((relative) =>
      relative === 'lib'
        ? [...readDirectory(relative), { name: 'buyer-request-cache.ts', isDirectory: () => false, isFile: () => true }]
        : readDirectory(relative),
    );
    expect(seeded, 'the sweep did not reach a planted module').toContain('lib/buyer-request-cache.ts');
    expect(
      seeded.filter((path) => !DOMAIN_PATHS.includes(path)).sort(),
      'a module the population does not cover was NOT reported outside it — the empty result ' +
        'above is a probe that cannot fail rather than a measurement',
    ).toEqual([planted]);
    // …and the plant is not on disk, or the control asserts about the tree
    // rather than about the sweep.
    expect(domainNamedModules()).not.toContain(planted);

    // And the POPULATION is still NARROW — the third world, and the one the
    // plant cannot see, because a plant absent from the real sweep is reported
    // outside a population built FROM that sweep exactly as it is outside a
    // correct one. MEASURED on `analytics-ranking-isolation.test.ts`, whose
    // comment claims its shared comparison closes this: replacing that wall's
    // population with `new Set(swept)` leaves all ten of its tests green. What
    // bites is naming modules that EXIST and belong to somebody else.
    assertEachOf([
      'routes/orders.ts',
      'routes/guest-orders.ts',
      'db/schema/orders.ts',
      'middleware/auth.ts',
    ], 4, (foreign) => {
      expect(DOMAIN_PATHS, `${foreign} belongs to another domain`).not.toContain(foreign);
      expect(
        statSync(join(SRC_ROOT, foreign)).isFile(),
        `${foreign} no longer exists, so excluding it proves nothing`,
      ).toBe(true);
    });

    // EXACT: an unbounded exclusion list lets any number of modules ride in
    // behind the ones somebody justified (#448).
    expect(CROSSING_PATHS.length, 'a fourth crossing was excluded from the buyer wall').toBe(3);

    // The walk really reads the disk, rather than a `readdirSync` that has
    // silently started returning a cached or empty result.
    for (const path of DOMAIN_PATHS) {
      expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} is not a file`).toBe(true);
      expect(readSource(path).length).toBeGreaterThan(200);
    }

    // No test file may enter the scanned set: a gate that scans its own probes
    // reports violations it wrote itself.
    expect(DOMAIN_PATHS.filter((path) => path.includes('__tests__'))).toEqual([]);

    // Every excluded crossing must still BE in the domain — an exclusion naming
    // a module the walk no longer finds excuses nothing while looking like a
    // decision.
    for (const { path } of CROSSING_PATHS) {
      expect(DOMAIN_PATHS, `${path} is excluded from the buyer wall but is not in the domain`,
      ).toContain(path);
    }
  });

  it('no BUYER path can write an order, refund, restock or reach the payment domain', () => {
    for (const path of BUYER_PATHS) {
      const source = stripComments(readSource(path));
      expect(
        ORDER_WRITER_REFERENCE.test(source),
        `${path} can move an order's status; a buyer files a REQUEST (acceptance 2)`,
      ).toBe(false);
      expect(
        REFUND_REFERENCE.test(source),
        `${path} can move money; only a decision service may`,
      ).toBe(false);
      expect(
        INVENTORY_REFERENCE.test(source),
        `${path} can move stock; restock happens once, in the commerce path`,
      ).toBe(false);
      expect(
        PAYMENT_DOMAIN_REFERENCE.test(source),
        `${path} reaches the payment domain; refund-bridge.ts is the only crossing`,
      ).toBe(false);
    }
  });

  it('every excluded crossing genuinely crosses', () => {
    // The positive half, and the thing that keeps the exclusion list honest.
    // Without it, every absence above would still hold if `order.service` and
    // `refund.service` had simply been renamed, and the gate would be measuring
    // nothing. With it, a module that stops crossing stops being excludable and
    // this test names it — so the buyer wall can only ever get wider by neglect,
    // never narrower.
    for (const { path, crosses } of CROSSING_PATHS) {
      const source = stripComments(readSource(path));
      const pattern = crosses === 'order' ? ORDER_WRITER_REFERENCE : REFUND_REFERENCE;
      expect(
        pattern.test(source),
        `${path} is excused from the buyer wall as a ${crosses} crossing, and no longer is one`,
      ).toBe(true);
    }
  });

  it('nothing in the domain writes a review, opens a moderation case or subscribes anybody', () => {
    for (const path of DOMAIN_PATHS) {
      const source = stripComments(readSource(path));
      expect(
        REVIEW_OR_MODERATION_REFERENCE.test(source),
        `${path} reaches the review or moderation domain; support rules 7 and 8 forbid it`,
      ).toBe(false);
      expect(
        MARKETING_REFERENCE.test(source),
        `${path} touches marketing consent; communication rule 3 forbids it`,
      ).toBe(false);
    }
  });

  it('nothing in the domain can decrypt a contact or name OxyPay/FairCoin', () => {
    for (const path of DOMAIN_PATHS) {
      const source = readSource(path);
      expect(
        DECRYPT_REFERENCE.test(stripComments(source)),
        `${path} reaches the plaintext decrypt; only #108's send path may`,
      ).toBe(false);
      // Scanned RAW, comments included: a copy change naming a rail Mercaria
      // does not have is as wrong as an import of one.
      expect(
        OXYPAY_OR_FAIRCOIN_REFERENCE.test(source),
        `${path} names OxyPay or FairCoin; neither is a payment rail here`,
      ).toBe(false);
    }
  });

  it('no request schema can carry a forbidden identifier', () => {
    // Authorization rule 6, checked against the vocabulary rather than against
    // a list somebody retyped here. An order number, an email or a cart token
    // arriving in a body is how "an order number plus an email is a password"
    // gets built by accident.
    const schemas = stripComments(readSource('controllers/buyer-requests.schemas.ts'));
    const forbiddenInBody = [
      /\bemail\s*:/,
      /\bphone\s*:/,
      /\borderNumber\s*:/,
      /\bguestSessionId\s*:/,
      /\bpaymentMethod\s*:/,
      /\bamount\s*:/,
      /\bstatus\s*:/,
    ];
    // #723: the loop below is its only reader, so emptying this list makes it a no-op and
    // nothing goes red. The floor is today's count: an addition passes it freely, while a
    // REMOVAL has to move this number in the same diff.
    expect(
      forbiddenInBody.length,
      'forbiddenInBody shrank without this floor moving — the assertion below now defends less than it did',
    ).toBeGreaterThanOrEqual(7);
    for (const pattern of forbiddenInBody) {
      expect(pattern.test(schemas), `a request body accepts ${pattern.source}`).toBe(false);
    }
    // The vocabulary exists and is non-trivial, so this assertion cannot pass
    // by the tuple having been emptied.
    expect(BUYER_REQUEST_FORBIDDEN_IDENTIFIERS.length).toBeGreaterThanOrEqual(10);
    expect(SUPPORT_FORBIDDEN_AUTOMATIC_OUTCOMES.length).toBeGreaterThanOrEqual(5);
  });

  it('mutation self-test: every detector fires on a seeded positive', () => {
    // Each pattern is run against text that DOES contain what it looks for. A
    // regex that matched nothing would pass every assertion above while
    // measuring nothing at all — the failure this repository keeps finding.
    expect(ORDER_WRITER_REFERENCE.test("import { transition } from '../order.service.js';")).toBe(
      true,
    );
    expect(ORDER_WRITER_REFERENCE.test('await setOrderStatus(orderId, "cancelled");')).toBe(true);
    expect(REFUND_REFERENCE.test("import { process } from '../refund.service.js';")).toBe(true);
    expect(INVENTORY_REFERENCE.test("import { restock } from '../inventory.service.js';")).toBe(
      true,
    );
    expect(INVENTORY_REFERENCE.test('await restock(variantId, 1);')).toBe(true);
    expect(
      PAYMENT_DOMAIN_REFERENCE.test("import { x } from '../services/payments/provider.js';"),
    ).toBe(true);
    // The RELATIVE specifier, which is what a module in `services/buyer-requests/`
    // would actually write — the payment domain is one `../` away from here.
    // The pattern above matched only the absolute-looking form until #454, so
    // this probe is the one that had to be written from the idiom rather than
    // copied out of the regex.
    expect(
      PAYMENT_DOMAIN_REFERENCE.test("import { paymentService } from '../payments/payment.service.js';"),
    ).toBe(true);
    expect(
      PAYMENT_DOMAIN_REFERENCE.test("import { bookLedger } from '../../payments/ledger-postings.js';"),
    ).toBe(true);
    // A neighbour that merely shares the prefix is not the payment domain.
    expect(PAYMENT_DOMAIN_REFERENCE.test("import { fmt } from '../payments-ui/format.js';")).toBe(
      false,
    );
    expect(REVIEW_OR_MODERATION_REFERENCE.test("import { y } from '../review.service.js';")).toBe(
      true,
    );
    expect(
      REVIEW_OR_MODERATION_REFERENCE.test("from '../services/moderation/report-intake.service.js'"),
    ).toBe(true);
    expect(MARKETING_REFERENCE.test('const marketingOptIn = true;')).toBe(true);
    expect(DECRYPT_REFERENCE.test('const email = await decryptGuestPii(row);')).toBe(true);
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test('// settled through OxyPay')).toBe(true);
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test('FairCoin')).toBe(true);
    // And the negative control the currency code needs: `FAIR` is Mercaria's
    // preferred presentment currency and appears legitimately wherever money
    // does, so the pattern must NOT match it.
    expect(OXYPAY_OR_FAIRCOIN_REFERENCE.test("currency: 'FAIR'")).toBe(false);
  });

  it('mutation self-test: stripComments removes prose but keeps code', () => {
    // The comment stripper is load-bearing for six assertions above — if it
    // removed too much, every detector would scan an empty string and pass.
    const source = [
      '/** transition() is deliberately not imported here. */',
      '// no restock in this file',
      "import { findOrderById } from '../../db/orders/orderRepository.js';",
    ].join('\n');
    const stripped = stripComments(source);
    expect(stripped).toContain('findOrderById');
    expect(stripped).not.toContain('deliberately not imported');
    expect(stripped).not.toContain('no restock in this file');
  });
});

/* -------------------------------------------------------------------------- */
/*  Every event kind has a producer (#743, #765)                               */
/* -------------------------------------------------------------------------- */

/**
 * The call whose `kind:` argument decides what a trail row says.
 *
 * TWO names, because the literal moved: `refuseTransition` takes its kind as a
 * PARAMETER, so its own `recordBuyerRequestEvent` call carries `input.kind` and
 * the literal lives at each call site. A census over the repository call alone
 * would report all five of #765's kinds as unproduced.
 */
const PRODUCER_CALLS = ['recordBuyerRequestEvent', 'refuseTransition'] as const;

/** The calls whose `reason:` argument becomes a row's bounded `detail`. */
const REASON_CALLS = ['refuseDecision', 'refuseTransition'] as const;

/**
 * The text of every `name(...)` call in `source`, parentheses balanced.
 *
 * Balanced rather than a fixed window, because #743's own method note records a
 * three-line window reporting `accepted` and `rejected` as unproduced: the
 * ternary that writes them sits further into the call than that. A window one
 * line too short invents defects, and no single length is right for every call
 * site.
 */
function callArguments(source: string, name: string): string[] {
  const found: string[] = [];
  const opener = new RegExp(`\\b${name}\\s*\\(`, 'g');
  for (let match = opener.exec(source); match !== null; match = opener.exec(source)) {
    // A DECLARATION shares the spelling of a call and contributes no literal,
    // so counting one would inflate the floor below with something no producer
    // wrote — a floor is only worth having if the number means what it says.
    if (/function\s+$/.test(source.slice(0, match.index))) continue;
    let depth = 0;
    let index = match.index + match[0].length - 1;
    const start = index;
    for (; index < source.length; index += 1) {
      const character = source[index];
      if (character === '(') depth += 1;
      else if (character === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    found.push(source.slice(start + 1, index));
  }
  return found;
}

/**
 * Every quoted literal on a `field:` line inside one call's arguments.
 *
 * The LINE rather than the token, so `kind: accepted ? 'accepted' : 'rejected'`
 * yields both — and anchored to the field name inside a producer call, so the
 * `existing.state === 'completed'` that appears three lines above one of them
 * does NOT. Six of the seventeen kinds share a spelling with a request state, so
 * an unanchored search for the bare literal would report every one of them
 * produced whether or not anything wrote it.
 */
function literalsOnField(argumentText: string, field: string): string[] {
  const found: string[] = [];
  for (const line of argumentText.split('\n')) {
    const at = line.indexOf(`${field}:`);
    if (at === -1) continue;
    for (const quoted of line.slice(at).matchAll(/'([a-z_]+)'/g)) found.push(quoted[1]);
  }
  return found;
}

/** Every kind, or every reason, the given sources actually write. */
function producedValues(
  sources: readonly string[],
  calls: readonly string[],
  field: string,
): { values: Set<string>; callSites: number } {
  const values = new Set<string>();
  let callSites = 0;
  for (const source of sources) {
    for (const name of calls) {
      for (const argumentText of callArguments(source, name)) {
        callSites += 1;
        for (const value of literalsOnField(argumentText, field)) values.add(value);
      }
    }
  }
  return { values, callSites };
}

/** The domain's modules, comments stripped — the census population. */
function domainSources(): string[] {
  return DOMAIN_PATHS.map((path) => stripComments(readSource(path)));
}

describe('every trail vocabulary member has a producer (#743, #765)', () => {
  it('writes every one of the seventeen event kinds', () => {
    const { values, callSites } = producedValues(domainSources(), PRODUCER_CALLS, 'kind');

    // THE VACUITY FLOOR. An extractor that matched nothing produces an empty
    // `values`, and `unproduced` would then be the whole tuple — loud. The
    // dangerous direction is the other one: a census that found SOME call sites
    // and silently stopped finding others reports a clean pass for whatever it
    // stopped at. Today's count, so a producer deleted with its kind still in
    // the tuple moves this number down in the same diff.
    expect(callSites, 'the producer sweep found no call sites at all').toBeGreaterThanOrEqual(29);

    const unproduced = BUYER_REQUEST_EVENT_KINDS.filter((kind) => !values.has(kind));
    expect(
      unproduced,
      'permitted by `buyer_request_events_kind_check` and written by nothing — the #743 defect',
    ).toEqual([]);
  });

  it('writes every bounded refusal reason', () => {
    const { values, callSites } = producedValues(domainSources(), REASON_CALLS, 'reason');
    expect(callSites, 'the refusal sweep found no call sites at all').toBeGreaterThanOrEqual(21);

    const reasons = [
      ...BUYER_REQUEST_DECISION_REFUSALS,
      ...BUYER_REQUEST_TRANSITION_REFUSALS,
    ];
    expect(
      reasons.filter((reason) => !values.has(reason)),
      'a bounded reason code no producer can write — a dead reason (#744, #753, #791)',
    ).toEqual([]);
  });

  it('mutation self-test: a removed producer is reported, and by name', () => {
    // The whole gate rests on `unproduced` being ABLE to be non-empty. So the
    // real sources are re-censused with ONE producer's literal rewritten, and
    // the kind it wrote must come back missing. Nothing is written to disk: the
    // mutation is the string the census reads.
    const sources = domainSources();
    const mutated = sources.map((source) =>
      source.replace(/kind: 'receipt_refused'/g, "kind: 'instructions_refused'"),
    );
    expect(
      mutated.join('\n'),
      'the mutation matched no producer — it would pass by changing nothing',
    ).not.toBe(sources.join('\n'));

    const { values } = producedValues(mutated, PRODUCER_CALLS, 'kind');
    expect(BUYER_REQUEST_EVENT_KINDS.filter((kind) => !values.has(kind))).toEqual([
      'receipt_refused',
    ]);
  });

  it('positive control: the extractor reads a ternary, and only inside a producer call', () => {
    // The ternary half is #743's own false-positive case, reproduced.
    const ternary = producedValues(
      ["await recordBuyerRequestEvent(tx, {\n  kind: accepted ? 'accepted' : 'rejected',\n});"],
      PRODUCER_CALLS,
      'kind',
    );
    expect([...ternary.values].sort()).toEqual(['accepted', 'rejected']);

    // The ANCHOR half, which is what stops six kinds passing on a state
    // comparison: the same literals outside a producer call count for nothing.
    const unanchored = producedValues(
      ["if (existing.state === 'completed') return;\nconst kind = 'cancelled';"],
      PRODUCER_CALLS,
      'kind',
    );
    expect([...unanchored.values]).toEqual([]);
    expect(unanchored.callSites).toBe(0);

    // And the comment half: a kind named only in prose is not a producer.
    const commented = producedValues(
      [stripComments("/** recordBuyerRequestEvent(tx, { kind: 'refund_settled' }) */\n")],
      PRODUCER_CALLS,
      'kind',
    );
    expect([...commented.values]).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  The root-handle exemption, and the two refusals deliberately NOT recorded   */
/* -------------------------------------------------------------------------- */

describe('refusal writes and their deliberate absences (#765)', () => {
  it('leaves `refusal.ts` the only module writing an event on the root handle', () => {
    // `eventRepository`'s docblock states this exemption, and a docblock that
    // states a count is a claim until something checks it. Every OTHER writer
    // passes a transaction handle, because an audit row that commits separately
    // from the fact it describes is a trail with holes; a refusal is the
    // opposite case and is the only one that may.
    const rootHandleWriters = DOMAIN_PATHS.filter((path) =>
      /recordBuyerRequestEvent\(\s*getDb\(\)/.test(stripComments(readSource(path))),
    );
    expect(rootHandleWriters).toEqual(['services/buyer-requests/refusal.ts']);

    // The floor and its positive control in one: the detector must find the two
    // writes that ARE there, or an empty result would read as a clean pass.
    const refusalSource = stripComments(readSource('services/buyer-requests/refusal.ts'));
    expect(refusalSource.match(/recordBuyerRequestEvent\(\s*getDb\(\)/g)?.length).toBe(2);
  });

  it('keeps the two unrecorded refusals shadowed by a layer that refuses first', () => {
    // #765's disposition for `Return instructions are required` and `Say why the
    // return was cancelled`: both are refused one layer up, BEFORE a request id
    // is resolved, so the refusal that actually happens has no subject to be
    // recorded against. Recording at the service would add reason codes no
    // production row could carry while making the trail look as though it
    // covered the case. Both premises are pinned here, because if either layer
    // stops refusing, the site below it becomes a real refusal that owes a row.
    const parsed = buyerRequestBodySchemas.instructions.safeParse({ instructions: '  x  ' });
    expect(parsed.success, 'the instructions schema stopped refusing a sub-3 value').toBe(false);
    expect(
      buyerRequestBodySchemas.instructions.safeParse({ instructions: '  abc  ' }).success,
    ).toBe(true);

    // The cancel-note guard is the HANDLER's, not the schema's, so it is read
    // out of the handler body — bounded to that function, and asserted to sit
    // BEFORE the service call it shadows.
    const controller = stripComments(readSource('controllers/buyer-requests.controller.ts'));
    const handler = controller.slice(controller.indexOf('export const cancelReturn'));
    const guardAt = handler.search(/\(\s*parsed\.data\.note\s*\?\?\s*''\s*\)\s*\.trim\(\)\.length\s*<\s*3/);
    const callAt = handler.indexOf('await cancelReturnRequest(');
    expect(guardAt, 'the cancelReturn handler no longer refuses a short note').toBeGreaterThan(-1);
    expect(callAt, 'the cancelReturn handler no longer calls the service').toBeGreaterThan(-1);
    expect(guardAt, 'the note guard no longer runs before the service call').toBeLessThan(callAt);
  });
});
