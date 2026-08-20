/**
 * The activation domain's structural boundaries (#85), asserted by SCAN.
 *
 * Each is a claim about what this domain CANNOT do, and a behavioural test can
 * only ever say "it did not this time":
 *
 *  - the DERIVATION reads nothing, so it cannot acquire a second input nobody
 *    stated (#121's `getRetailEligibility` rule);
 *  - nothing here reads the capability TRAIL, so a cached `granted` cannot
 *    survive the Stripe restriction that should have withdrawn it
 *    (`price_signal_evaluations`' rule);
 *  - the merchant WRITE path cannot reach the hold columns, so #85 permissions
 *    rule 11 ("a merchant cannot bypass a platform safety pause from the
 *    dashboard") is a property of the call graph rather than of a branch;
 *  - nothing here re-derives payment readiness, so #46's one stored verdict
 *    stays one — this is the place a second reading would admit an unpayable
 *    seller to a checkout;
 *  - nothing here reaches ranking, so a merchant's activation state cannot
 *    become a term in a scorer (#74's wall, both directions).
 *
 * Both defences from `~/Oxy/AGENTS.md`: a vacuity floor (a moved or emptied file
 * fails the gate rather than shrinking it silently) and a mutation self-test
 * (each detector runs against a seeded positive AND a seeded negative, so a
 * regex broken into matching nothing fails HERE rather than passing every scan).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** Anything whose PATH names this domain, in either spelling. */
const DOMAIN_NAMED = /merchant-activation|merchantActivation/i;

/**
 * The domain's HTTP surface, from the filename convention (#472's device).
 *
 * RECURSES, via `walk`. It used to be `readdirSync(...).filter(entry.isFile())`
 * — one level — sitting ten lines below a `walk` that recurses, so the file read
 * as though it recursed throughout and it did not. Measured (#460):
 * `routes/admin/merchant-activation.ts` exists, imports this domain's schemas
 * and controller, and was named NOWHERE in this gate, so every wall below ran
 * over a population missing it. That is #609's defect, which was fixed for the
 * analytics gate only.
 */
function httpSurface(): string[] {
  return ['controllers', 'routes', 'middleware'].flatMap((directory) =>
    walk(directory).filter((path) => DOMAIN_NAMED.test(path.split('/').pop() ?? '')),
  );
}

/**
 * Every module of the domain, WALKED rather than listed (#460).
 *
 * The list this replaces named 9 modules, all of them under
 * `services/merchant-activation/`. The derivation finds 14: the three
 * repositories and both HTTP modules were behind none of the walls below, which
 * is the hybrid shape #460 measured across the tree — walls complete exactly
 * where modules rarely appear and hand-maintained exactly where they do.
 */
const ACTIVATION_PATHS = [
  ...walk('services/merchant-activation'),
  ...walk('db/merchantActivation'),
  ...httpSurface(),
  'db/schema/merchantActivation.ts',
];

/**
 * Every module in the tree whose PATH names this domain — the assertion that
 * closes the population against the NEXT mechanism, not just this one.
 *
 * #609's device. A gate can be walk-only with no hand list anywhere and still
 * miss a module, because the miss lives in the DIRECTORY list the walk reads;
 * two different mechanisms produced misses here (a non-recursing HTTP sweep and
 * an unscanned `db/schema`) and this one assertion covers both, plus whatever is
 * found next.
 *
 * Matched on the PATH rather than the filename: a module inside
 * `services/merchant-activation/` names the domain nowhere in its own name, so a
 * filename sweep reports a fraction of the domain and an empty "outside" set,
 * which reads as a clean pass.
 */
function domainNamedModules(readDir: DirectoryReader = readDirectory): string[] {
  return walk('', readDir).filter((path) => DOMAIN_NAMED.test(path));
}

/**
 * The three that must stay PURE. `facts.ts` is the module that reads, and it is
 * ABSENT from this list rather than exempted inside it — an exemption inside a
 * list is how a second reader gets added without anybody noticing.
 */
const PURE_PATHS = [
  'services/merchant-activation/requirements.ts',
  'services/merchant-activation/capabilities.ts',
  'services/merchant-activation/onboarding.ts',
];
// #723: the loop below is its only reader, so emptying this list makes it a no-op and
// nothing goes red. The floor is today's count: an addition passes it freely, while a
// REMOVAL has to move this number in the same diff.
expect(
  PURE_PATHS.length,
  'PURE_PATHS shrank without this floor moving — the assertion below now defends less than it did',
).toBeGreaterThanOrEqual(3);

/** Anything that reads or writes storage, or reaches a service that does. */
const STORAGE_REFERENCE =
  /from '.*\/db\/|getDb\(|drizzle|\.select\(|\.insert\(|\.update\(|Repository|await\s+find[A-Z]|await\s+read[A-Z]|await\s+count[A-Z]/;

/**
 * The capability TRAIL, read by anything that decides.
 *
 * `merchant_activation_capability_events` says what the derivation said when
 * somebody last looked. A gate, a projection or a derivation reading it would be
 * reading a cached verdict — which is the one thing the recording must never
 * become. `transitions.service.ts` is the writer and the operator trace, and it
 * is exempted BY NAME below rather than by a pattern anybody could reuse.
 */
const CAPABILITY_TRAIL_REFERENCE =
  /readLatestCapabilityStates|listCapabilityEvents|merchantActivationCapabilityEvents|capabilityEventRepository/;

/** Files allowed to touch the trail: the writer, and nothing else. */
const TRAIL_READERS = [
  'services/merchant-activation/transitions.service.ts',
  // The repository that OWNS the table: it defines the very function names the
  // detector looks for, so scanning it would fail the wall on the module that
  // implements it. Named here for the same reason the writer is — by name, not
  // by a pattern anybody could reuse.
  'db/merchantActivation/capabilityEventRepository.ts',
  // The SCHEMA module, for the same reason one step further out: it DECLARES
  // `merchantActivationCapabilityEvents`, so the detector matches the table
  // definition itself. Brought into the population by #460's whole-tree
  // assertion; scanning it without this entry is a FALSE wall — the gate would
  // fail on the file that defines the thing it forbids reading.
  'db/schema/merchantActivation.ts',
];

/**
 * A hold column, a capability or a readiness verdict, named anywhere a MERCHANT
 * could put one.
 *
 * The two files scanned are the merchant boundary: the `.strict()` request
 * schema (a body cannot carry a field it does not declare) and the merchant
 * patch TYPE the service accepts. #85 permissions rule 11 and capability rule 2
 * are the same property read from two sides — a merchant cannot clear a hold and
 * cannot assert a capability — and both are held by the shape of what they may
 * send rather than by a check inside a handler.
 *
 * `settings.service.ts` as a WHOLE is deliberately not scanned: it legitimately
 * contains `applyPlatformHold`, which is the operator path. What is scanned is
 * the merchant patch interface, extracted by name.
 */
const MERCHANT_FORBIDDEN_FIELD_REFERENCE =
  /platformHold|platformHeld|capabilit|requirement|activated|nativeCheckoutState|guestCheckoutState|onboardingStep/i;

/** The merchant boundary: the request schema, and the patch type it produces. */
const MERCHANT_SCHEMA_PATH = 'middleware/merchant-activation-schemas.ts';

/** Extract one named interface's body — the patch type, and nothing around it. */
function readInterfaceBody(relative: string, name: string): string {
  const source = readDomainCode(relative);
  const start = source.indexOf(`interface ${name}`);
  expect(start, `${name} is not declared in ${relative} — did it move?`).toBeGreaterThan(-1);
  const open = source.indexOf('{', start);
  const close = source.indexOf('}', open);
  expect(close, `${name} in ${relative} has no closing brace`).toBeGreaterThan(open);
  const body = source.slice(open + 1, close);
  // The floor: an interface whose body extracted empty would satisfy every
  // detector below, which is the shape of a check that cannot fail.
  expect(body.replace(/\s+/g, '').length, `${name} extracted empty`).toBeGreaterThan(40);
  return body;
}

/**
 * A SECOND reading of payment readiness.
 *
 * ADR 0001 D9's conjunction is evaluated once, at synchronisation, and stored.
 * This domain calls `isSellerPaymentReady` and compares a stored verdict to one
 * literal; re-deriving it from `charges_enabled`, a requirements count or a
 * capability list would be a second implementation of the same rule, in the one
 * place where getting it wrong admits an unpayable seller to a checkout.
 */
const PAYMENT_REDERIVATION_REFERENCE =
  /charges_enabled|chargesEnabled|payouts_enabled|payoutsEnabled|requirementsCurrentlyDue|onboardingState\s*===/;

/**
 * Ranking, in either direction (#74's wall).
 *
 * A store's activation state is one join from "activated merchants rank higher",
 * which would be a commercial input to organic relevance arriving through a
 * readiness screen.
 */
const RANKING_REFERENCE =
  /services\/ranking|rankOffers|rankOfferComparison|rankingPolicy|OfferRankingFacts|services\/search\//;

/** Read a domain path, refusing an empty or moved file. */
function readDomainSource(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * The same source with comments removed — what every REACHABILITY detector
 * scans.
 *
 * These modules document what they refuse to do in exactly the vocabulary the
 * detectors look for (`requirements.ts` explains why it reads no table;
 * `capabilityEventRepository` explains why nothing may select from it), so
 * scanning prose would make every honest explanation a violation and the gate
 * would be switched off by whoever hit it next.
 */
function readDomainCode(relative: string): string {
  const stripped = readDomainSource(relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  expect(
    stripped.replace(/\s+/g, '').length,
    `${relative} has almost no code left after comment stripping — check the stripper`,
  ).toBeGreaterThan(150);
  return stripped;
}

describe('the activation domain cannot reach what it must not', () => {
  it('scans the whole domain — a module added and not listed fails here', () => {
    // Vacuity floors PER SHAPE rather than one on the total: the three sources
    // break independently, and one total would let a walk collapse to zero while
    // the others carried the number.
    const from = (prefix: string) =>
      ACTIVATION_PATHS.filter((path) => path.startsWith(prefix)).length;
    expect(from('services/merchant-activation/'), 'the service walk found nothing').toBeGreaterThanOrEqual(9);
    expect(from('db/merchantActivation/'), 'the repository walk found nothing').toBeGreaterThanOrEqual(3);
    expect(httpSurface().length, 'the HTTP surface derivation found nothing').toBeGreaterThanOrEqual(2);
    expect(ACTIVATION_PATHS.length).toBeGreaterThanOrEqual(14);

    // The whole-tree assertion (#609). Nothing whose PATH names this domain may
    // sit outside the derived population, whatever the reason it was missed.
    // Its own vacuity floor first: a sweep that reached nothing would report an
    // empty "outside" set, which is indistinguishable from a complete population.
    const named = domainNamedModules();
    expect(named.length, 'the domain-name sweep found nothing').toBeGreaterThanOrEqual(14);
    expect(
      named.filter((path) => !ACTIVATION_PATHS.includes(path)).sort(),
      'names this domain but is outside the population every wall below scans',
    ).toEqual([]);

    // THE POSITIVE CONTROL, added in #460's follow-up, and without it the
    // assertion above cannot fail: `toEqual([])` is satisfied by a correct
    // tree, by a sweep that reached nothing AND by a population containing
    // everything, and the vacuity floor covers only the second. So the same
    // sweep runs against a reader reporting a domain-named module in a
    // directory the population does NOT draw from, and it must come back
    // OUTSIDE.
    const planted = 'lib/merchant-activation-cache.ts';
    const seeded = domainNamedModules((relative) =>
      relative === 'lib'
        ? [...readDirectory(relative), { name: 'merchant-activation-cache.ts', isDirectory: () => false, isFile: () => true }]
        : readDirectory(relative),
    );
    expect(seeded, 'the sweep did not reach a planted module').toContain('lib/merchant-activation-cache.ts');
    expect(
      seeded.filter((path) => !ACTIVATION_PATHS.includes(path)).sort(),
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
      'controllers/orders.controller.ts',
      'routes/cart.ts',
      'db/schema/orders.ts',
      'middleware/auth.ts',
    ], 4, (foreign) => {
      expect(ACTIVATION_PATHS, `${foreign} belongs to another domain`).not.toContain(foreign);
      expect(
        statSync(join(SRC_ROOT, foreign)).isFile(),
        `${foreign} no longer exists, so excluding it proves nothing`,
      ).toBe(true);
    });
    // EXACT: an unbounded exemption list lets any number of readers ride in
    // behind the two somebody justified (#448).
    expect(TRAIL_READERS.length, 'a fourth trail reader was exempted').toBe(3);
    for (const path of ACTIVATION_PATHS) {
      expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} is not a file`).toBe(true);
    }
    expect(ACTIVATION_PATHS.filter((path) => path.includes('__tests__'))).toEqual([]);
    for (const path of TRAIL_READERS) {
      expect(ACTIVATION_PATHS, `${path} is exempted but is not in the domain`).toContain(path);
    }
    for (const relative of ACTIVATION_PATHS) {
      expect(readDomainSource(relative).length).toBeGreaterThan(200);
    }
  });

  it('the derivation, the capability map and the step map read nothing at all', () => {
    let scanned = 0;
    for (const relative of PURE_PATHS) {
      expect(
        STORAGE_REFERENCE.test(readDomainCode(relative)),
        `${relative} reaches storage; the derivation must stay pure (#121's rule)`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(PURE_PATHS.length);
  });

  it('only the writer touches the capability trail', () => {
    let scanned = 0;
    for (const relative of ACTIVATION_PATHS) {
      if (TRAIL_READERS.includes(relative)) continue;
      expect(
        CAPABILITY_TRAIL_REFERENCE.test(readDomainCode(relative)),
        `${relative} reads the capability trail; it is a RECORDING and never an authority`,
      ).toBe(false);
      scanned += 1;
    }
    // The floor matters more than usual here: an exemption list that grew to
    // cover everything would make this assertion vacuous, and the scan would
    // report clean having read nothing.
    expect(scanned).toBe(ACTIVATION_PATHS.length - TRAIL_READERS.length);
    expect(scanned).toBeGreaterThanOrEqual(8);
  });

  it('a merchant can send no hold, no capability and no verdict', () => {
    // The request schema. `.strict()` means a field it does not declare is
    // REFUSED rather than stripped, so the absence below is the enforcement.
    expect(
      MERCHANT_FORBIDDEN_FIELD_REFERENCE.test(readDomainCode(MERCHANT_SCHEMA_PATH)),
      'the merchant request schema declares a hold, a capability or a verdict field',
    ).toBe(false);

    // The patch type the service accepts, so a caller that bypassed the schema
    // still has nothing to pass.
    expect(
      MERCHANT_FORBIDDEN_FIELD_REFERENCE.test(
        readInterfaceBody(
          'services/merchant-activation/settings.service.ts',
          'MerchantActivationSettingsPatch',
        ),
      ),
      'the merchant patch type carries a hold, a capability or a verdict field',
    ).toBe(false);
  });

  it('nothing here re-derives payment readiness', () => {
    let scanned = 0;
    for (const relative of ACTIVATION_PATHS) {
      expect(
        PAYMENT_REDERIVATION_REFERENCE.test(readDomainCode(relative)),
        `${relative} re-derives payment readiness; #46's stored verdict is READ, never recomputed`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(ACTIVATION_PATHS.length);
  });

  it('nothing here reaches ranking or search', () => {
    let scanned = 0;
    for (const relative of ACTIVATION_PATHS) {
      expect(
        RANKING_REFERENCE.test(readDomainCode(relative)),
        `${relative} reaches ranking; activation state may not become a scoring term`,
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(ACTIVATION_PATHS.length);
  });

  /**
   * The mutation self-test. Every detector runs against text that SHOULD trip it
   * and against text that must NOT — a scanner nobody has seen fail is a scanner
   * nobody knows works, and the negative half is what catches a pattern so wide
   * it would flag the domain's own legitimate code.
   */
  it('each detector actually detects, and does not over-detect', () => {
    expect(STORAGE_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(true);
    expect(STORAGE_REFERENCE.test('const row = await findStoreById(id);')).toBe(true);
    expect(STORAGE_REFERENCE.test('const outcome = derive(facts);')).toBe(false);

    expect(CAPABILITY_TRAIL_REFERENCE.test('const seen = await readLatestCapabilityStates(tx, id);')).toBe(
      true,
    );
    expect(CAPABILITY_TRAIL_REFERENCE.test('const caps = deriveCapabilities(results, blocking);')).toBe(
      false,
    );

    expect(MERCHANT_FORBIDDEN_FIELD_REFERENCE.test('platformHoldReason?: string;')).toBe(true);
    expect(MERCHANT_FORBIDDEN_FIELD_REFERENCE.test('capabilities?: string[];')).toBe(true);
    expect(MERCHANT_FORBIDDEN_FIELD_REFERENCE.test('nativeCheckoutState?: string;')).toBe(true);
    // The two fields a merchant legitimately sends must NOT trip it.
    expect(MERCHANT_FORBIDDEN_FIELD_REFERENCE.test('nativeCheckoutIntent?: MerchantCheckoutIntent;')).toBe(
      false,
    );
    expect(MERCHANT_FORBIDDEN_FIELD_REFERENCE.test('supportEmail?: string | null;')).toBe(false);

    expect(PAYMENT_REDERIVATION_REFERENCE.test('if (account.chargesEnabled) return true;')).toBe(true);
    expect(PAYMENT_REDERIVATION_REFERENCE.test('const ready = await isSellerPaymentReady(key);')).toBe(
      false,
    );

    expect(RANKING_REFERENCE.test("import { rankOffers } from '../ranking/score.js';")).toBe(true);
    expect(RANKING_REFERENCE.test('const state = projectActivationState(derived);')).toBe(false);
  });
});
