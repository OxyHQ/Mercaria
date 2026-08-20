/**
 * The referral ENROLLMENT domain's structural boundaries (#146 increment 2),
 * asserted by SCAN rather than by fixture.
 *
 * Each of these is a claim about what enrollment CANNOT reach, and a
 * behavioural test can only ever say "it did not this time". That is the
 * argument `referral-attribution-isolation.test.ts` makes for the edge and
 * `cart-merge-isolation.test.ts` makes for the cart, and this scanner carries
 * the same two defences: a vacuity floor (a moved or emptied file fails the
 * gate instead of shrinking it silently) and a mutation self-test (each
 * detector runs against a seeded positive, so a broken regex cannot pass by
 * matching nothing).
 *
 * The walls, and the rule behind each:
 *
 *  1. **NO SECOND ANSWER to "may this account act for this store".** The one
 *     that matters, and increment 1's stated reason for leaving the tax
 *     questionnaire unmounted. The store half of the partner surface is
 *     mounted under `/admin/stores/:storeId`, where `loadStore` plus
 *     `requireStorePermission('store:manage')` have already answered it; no
 *     module in this domain may read a role, a permission array, a membership
 *     or the role matrix. Consuming the answer is a mount, not an import.
 *  2. **Enrollment GRANTS nothing** (#146 review rule 7).
 *     `REFERRAL_ENROLLMENT_FORBIDDEN_GRANTS` names six as VALUES, and the
 *     direction nobody would notice is that approving a partner is the natural
 *     place for somebody to also "just" add them to the store they named.
 *  3. **No payment rail and no ledger.** A partner's standing is not their
 *     money. The ONE exception is the readiness PORT, which is a published
 *     contract the join registers into — the seam #145 already exempted.
 *  4. **No ranking.** ADR 0005 D20/I1: a partner is one join from a
 *     commission-weighted ordering.
 *  5. **Nothing FETCHES a promotion URL.** The natural thing to do with a URL
 *     an applicant typed is check that it exists, and doing so turns the
 *     application form into an SSRF primitive aimed wherever they like.
 *  6. **A partner-facing projection carries no risk signal and no reviewer
 *     note** (#146 review rule 9), scanned here and walked at RUNTIME in
 *     `referral-enrollment.realdb.test.ts` — the #92 two-gate rule.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxyhq/db';
import {
  REFERRAL_APPLICATION_FORBIDDEN_DISCLOSURES,
  REFERRAL_APPLICATION_ITEMS,
  REFERRAL_APPLICATION_REJECTION_CODES,
  REFERRAL_ENROLLMENT_FORBIDDEN_GRANTS,
  REFERRAL_ENROLLMENT_MODES,
  REFERRAL_ENROLLMENT_MODE_RULES,
  REFERRAL_PARTNER_STATES,
} from '@mercaria/shared-types';
import {
  referralPartnerApplications,
  referralPartners,
  referralTaxProfiles,
} from '../../db/schema/referrals.js';
import { assertEachOf } from '../../__tests__/assert-each-of.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A directory entry, as `readdirSync(..., { withFileTypes: true })` reports one. */
type DirectoryEntry = { name: string; isDirectory: () => boolean; isFile: () => boolean };
type DirectoryReader = (relative: string) => DirectoryEntry[];

const readDirectory: DirectoryReader = (relative) =>
  readdirSync(join(SRC_ROOT, relative), { withFileTypes: true });

/**
 * Every `.ts` under `relative`, RECURSIVELY, excluding the domain's own tests.
 *
 * Takes its reader so the positive controls below can ask "would the derivation
 * get a module that does not exist yet?" of the REAL derivation rather than of a
 * re-spelling of it.
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

/** Anything whose name carries this domain. */
const DOMAIN_NAMED = /referral/i;

/**
 * The directories this domain OWNS outright, walked whole.
 *
 * The three `db/` sub-domain directories and `services/referral-pilot/` joined
 * this list in #460. Measured, all nineteen modules added here are clean against
 * every wall this file applies to the whole population, so leaving them out was
 * a gap rather than a decision. (`db/schema/referrals.ts` DECLARES
 * `reviewer_note` and so matches `REVIEWER_NOTE_LEAK` — which is not a
 * false wall, because that detector is applied to ONE named projection module
 * rather than to the population. The schema module defining a column is the
 * `merchantActivationCapabilityEvents` shape one gate over, and it is worth
 * knowing before anybody widens that wall to the domain.)
 */
const REFERRAL_OWNED_DIRECTORIES = [
  'services/referrals',
  'services/referral-pilot',
  'db/referrals',
  'db/referralEarnings',
  'db/referralIntegrity',
  'db/referralPilot',
] as const;

/**
 * The shared flat directories a referral module lives in under a domain NAME.
 *
 * `db/schema` joined this list in #460 — five referral schema modules were
 * scanned by nothing here — and `routes/admin` LEFT it, which is not a
 * narrowing: the sweep recurses now, so `walk('routes')` reaches it. That entry
 * was a hand-patch of exactly this defect, covering the one subdirectory
 * somebody thought of and no other.
 */
const REFERRAL_SHARED_DIRECTORIES = ['controllers', 'routes', 'middleware', 'db/schema'] as const;

/**
 * Every module in the tree whose PATH names this domain — the assertion that
 * closes the population against the NEXT mechanism, not only these two.
 *
 * Matched on the PATH, not the filename: the sixty modules under
 * `services/referrals/` name the domain nowhere in their own names, so a
 * filename sweep reports a fraction of the domain and an empty "outside" set,
 * which reads exactly like a clean pass.
 */
function domainNamedModules(readDir: DirectoryReader = readDirectory): string[] {
  return walk('', readDir).filter((path) => DOMAIN_NAMED.test(path));
}

/**
 * #344's partner PAYOUT rail — a referral-named sub-domain deliberately OUTSIDE
 * this population, with an EXACT count (#448).
 *
 * Measured rather than assumed: three of its five modules trip the payment
 * detector below, because reaching the payment rail is what a payout IS. The
 * alternative was widening `LEDGER_POSTING_DIRECTORY`, and an exemption widened
 * to cover a directory also covers whatever lands in that directory next.
 *
 * Asserted in BOTH directions below: the sweep must still reach each, and the
 * population must not have absorbed it.
 */
const PAYOUT_RAIL_PATHS = [
  'services/referral-payouts/beneficiary.ts',
  'services/referral-payouts/rail.ts',
  'services/referral-payouts/readiness.ts',
  'services/referral-payouts/register.ts',
  'services/referral-payouts/risk-payment-facts.ts',
];

/**
 * Every referral-NAMED module in a flat shared directory.
 *
 * RECURSES, via `walk`. It was `readdirSync(...).filter(entry.isFile())` — ONE
 * level — sitting beside a `walk` that recurses, so the file read as though it
 * recursed throughout and it did not. #460 measured that asymmetry in 27 gates.
 */
function referralNamed(directory: string, readDir: DirectoryReader = readDirectory): string[] {
  return walk(directory, readDir).filter((path) => DOMAIN_NAMED.test(path.split('/').pop() ?? ''));
}

/**
 * The whole referral domain. WALKED, never listed — and WIDER than the
 * enrollment path these walls used to be asserted over.
 *
 * This was fifteen hand-written paths called "every module #146 increment 2
 * added or owns", with a floor of fifteen underneath it. Measured on
 * `origin/main` at 4b30d5a2 the domain is 94 modules, and this gate plus
 * `referral-attribution-isolation.test.ts` covered 28 between them.
 *
 * The walls below are all TRUE of the whole domain, measured rather than
 * assumed — ranking trips on zero of the 94, the permission MATRIX on zero, the
 * outbound-client detector on zero once it stops matching a bare word (see
 * {@link OUTBOUND_FETCH}). The two that cannot span it, the merchant-claim grant
 * and the store-membership read, are narrowed EXPLICITLY below with the
 * assertion that justifies each, rather than by choosing a smaller population
 * and calling the difference out of scope.
 *
 * Wall 5's own test was called "makes no outbound call anywhere in the domain"
 * while scanning fifteen files of ninety-four, which is the shape worth naming:
 * the sentence was the claim, the list was the measurement, and only one of them
 * was true (#460).
 */
const ENROLLMENT_PATHS = [
  ...REFERRAL_OWNED_DIRECTORIES.flatMap((directory) => walk(directory)),
  ...REFERRAL_SHARED_DIRECTORIES.flatMap((directory) => referralNamed(directory)),
];

/**
 * `binding.service.ts` READS merchant claims; it grants none.
 *
 * Wall 2 forbids enrollment PERFORMING a forbidden grant, and the
 * `merchant_claim` detector cannot tell a read from a write — it matches the
 * repository module, and `findClaimsByClaimant` is how a partner binding checks
 * which merchants the caller has already proved they operate. Narrowing the
 * detector to writes was rejected: it is the permissive direction, and a
 * detector loosened to admit one legitimate reader is one that admits the write
 * somebody adds beside it. Excused by NAME instead, with the probe below.
 */
const MERCHANT_CLAIM_READER = 'services/referrals/binding.service.ts';

/**
 * `self-referral.service.ts` reads store MEMBERSHIP, and must.
 *
 * #144's self-referral check asks whether the partner claiming a conversion is a
 * member of the store that made the sale — which is a FACT it needs, not an
 * authorization it derives. Wall 1 is about deriving a PERMISSION, and that half
 * (`effectivePermissions`, `ROLE_PERMISSIONS`, `STORE_PERMISSIONS`, a
 * `.permissions` array) still holds over all 94; only the membership read is
 * excused, and only for this module.
 */
const MEMBERSHIP_READER = 'services/referrals/integrity/self-referral.service.ts';

/** #145's partner earnings — the modules that may reach the ledger. See below. */
const LEDGER_POSTING_DIRECTORY = 'services/referrals/earnings/';

function readEnrollmentSource(relative: string): string {
  const source = readFileSync(join(SRC_ROOT, relative), 'utf8');
  expect(source.length, `${relative} looks empty — did it move?`).toBeGreaterThan(200);
  return source;
}

/**
 * The same source with comments removed — what the REACHABILITY detectors scan.
 *
 * Not a convenience. Every module here documents what it refuses to do in
 * exactly the vocabulary these detectors look for — `enrollment.service.ts`
 * explains at length that it holds no permission answer, and
 * `application-answers.ts` says in prose that it fetches nothing — so scanning
 * comments would make every honest explanation a violation. A gate with known
 * false positives is one whoever hits it next disables.
 */
function readEnrollmentCode(relative: string): string {
  const stripped = readEnrollmentSource(relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  expect(
    stripped.replace(/\s+/g, '').length,
    `${relative} has almost no code left after comment stripping — check the stripper`,
  ).toBeGreaterThan(100);
  return stripped;
}

/**
 * WALL 1. A second answer to the store-permission question.
 *
 * `store-authz` and `effectivePermissions` are the middleware's; `permissions`
 * and `storeMembers` are the columns behind it; `ROLE_PERMISSIONS` is the
 * matrix. `requireStorePermission` is deliberately NOT here — `routes/admin/`
 * mounting it is exactly how the answer is consumed, and forbidding it would
 * make the correct code fail the gate.
 */
const PERMISSION_DERIVATION =
  /effectivePermissions|ROLE_PERMISSIONS|storeMembership|\.permissions\b|STORE_PERMISSIONS/;
/**
 * Reading store MEMBERSHIP — split out of {@link PERMISSION_DERIVATION} because
 * the two are different acts and only one of them spans the whole domain.
 *
 * Deriving a permission is forbidden everywhere. Reading whether an account
 * belongs to a store is a FACT, and #144's self-referral check legitimately
 * needs it; splitting keeps the stronger half at full width instead of dropping
 * both to accommodate one module.
 */
const MEMBERSHIP_READ = /findStoreMember|storeMembers\b/;
/**
 * WALL 2. The WRITE that would perform each forbidden grant.
 *
 * Derived from the ACTION, not from the value's spelling, and the first version
 * of this gate proves why: a pattern built by fuzzing
 * `REFERRAL_ENROLLMENT_FORBIDDEN_GRANTS`'s underscores fired on
 * `requireStorePermission('store:manage')` — the line that CONSUMES the answer
 * correctly. A gate whose cheapest green is deleting the right code is worse
 * than no gate (#67's host-comparison detector, measured).
 *
 * A `Record` over the tuple, so a grant added to the value list without a
 * detector fails `tsc` and the values stay load-bearing rather than becoming a
 * list nothing reads.
 */
const GRANT_DETECTORS: Readonly<Record<string, RegExp>> = {
  store_permission: /grantStorePermission|\.permissions\s*=|permissions:\s*\[/,
  store_membership: /addStoreMember|insertStoreMember|storeMemberRepository|createStoreMember/,
  merchant_claim: /merchant-claims\/|merchantClaimRepository|verifyMerchantClaim|claim_state/,
  payment_onboarding: /providerAccountRepository|insertProviderAccount|createOnboardingLink/,
  oxy_administrative_role: /setOxyRole|grantOxyRole|oxyAdmin|assignRole/,
  operator_allow_list: /operatorOxyUserIds\s*[=.]\s*\[|OPERATOR_OXY_USER_IDS\s*=/,
};
const PAYMENT_REFERENCE =
  /services\/payments\/|paymentRepository|ledgerRepository|ledger_entries|PaymentIntent|openCheckoutPayment|stripe|Stripe/;
const RANKING_REFERENCE =
  /services\/ranking\/|rankOffers|rankOfferComparison|OfferRankingFacts|ranking_policy_versions/;
/**
 * An outbound HTTP client, by IMPORT or by CALL — never as a bare word.
 *
 * `axios`, `got` and `undici` used to match anywhere in the text, which is fine
 * across fifteen files and wrong across the domain: `traffic.ts` carries a
 * BOT USER-AGENT list — `'wget/'`, `'python-requests'`, `'okhttp'`, `'axios/'`,
 * `'node-fetch'` — so the module whose job is to DETECT crawlers read as one.
 *
 * That is the failure this pattern must not have. A gate that fires on correct
 * code has its cheapest green in deleting the gate, and the wall here is real:
 * a promotion URL an applicant typed must never be fetched. So the client names
 * are matched as an import specifier or a member call, which is how an HTTP
 * client is actually reached, and both directions are pinned in the mutation
 * self-test below.
 */
const OUTBOUND_FETCH =
  /\bfetch\s*\(|safeFetch|\baxios\.|\bgot\s*\(|from\s+'(?:axios|got|undici|node-fetch)'|require\(\s*'(?:axios|got|undici|node-fetch)'\s*\)|node:https|node:http\b/;
const REVIEWER_NOTE_LEAK = /reviewerNote|reviewer_note/;

/**
 * The vacuity floors, PER SHAPE rather than one on the total.
 *
 * `MINIMUM_SCANNED_FILES = 15` used to sit here, compared against
 * `ENROLLMENT_PATHS.length`, which was 15 — a constant asserted against the list
 * it was derived from. It catches an entry being DELETED and can never see the
 * population being too small, which it was by 79 modules.
 *
 * Each number is today's count, and the six sources are floored separately
 * because they break independently: one total lets a walk collapse to zero while
 * the others carry its number.
 */
function assertReferralDomainIsWhole(): void {
  const from = (prefix: string) => ENROLLMENT_PATHS.filter((path) => path.startsWith(prefix)).length;
  expect(from('services/referrals/'), 'the referral service walk found too few modules').toBeGreaterThanOrEqual(48);
  expect(from('services/referral-pilot/'), 'the pilot walk found too few modules').toBeGreaterThanOrEqual(4);
  expect(from('db/referrals/'), 'the referral repository walk found too few modules').toBeGreaterThanOrEqual(17);
  expect(from('db/referralEarnings/'), 'the earnings repository walk found too few modules').toBeGreaterThanOrEqual(5);
  expect(from('db/referralIntegrity/'), 'the integrity repository walk found too few modules').toBeGreaterThanOrEqual(3);
  expect(from('db/referralPilot/'), 'the pilot repository walk found too few modules').toBeGreaterThanOrEqual(2);
  expect(from('controllers/'), 'no referral controller was derived').toBeGreaterThanOrEqual(7);
  expect(from('routes/'), 'no referral route was derived').toBeGreaterThanOrEqual(5);
  expect(from('middleware/'), 'no referral middleware module was derived').toBeGreaterThanOrEqual(5);
  expect(from('db/schema/'), 'no referral schema module was derived').toBeGreaterThanOrEqual(5);
  expect(ENROLLMENT_PATHS.filter((path) => path.includes('__tests__'))).toEqual([]);
  for (const path of ENROLLMENT_PATHS) {
    expect(statSync(join(SRC_ROOT, path)).isFile(), `${path} is not a file`).toBe(true);
  }
}

describe('the enrollment population is closed against the tree', () => {
  it('no referral-named module anywhere in src/ sits outside the population', () => {
    // #460's whole-tree assertion. This gate's population was already a walk
    // and still missed twenty-four modules — a walked population whose
    // DIRECTORY list is hand-written is still a hand list, and the miss lives
    // one level up. The evidence was in the list: a
    // `referralNamed('routes/admin')` line beside `referralNamed('routes')`.
    //
    // 94 -> 113, and the nineteen added are clean against every wall this file
    // applies to the whole population.
    const swept = domainNamedModules();

    // The sweep's OWN vacuity floor: a traversal that reached nothing reports no
    // module outside the population, the same answer a complete population
    // gives. MEASURED at 118.
    expect(
      swept.length,
      'the whole-tree sweep found almost nothing; it cannot report a module outside the ' +
        'population if it never reached one',
    ).toBeGreaterThanOrEqual(100);

    // EXACT, because an unbounded exclusion list lets any number of modules ride
    // in behind the five somebody justified (#448).
    expect(
      PAYOUT_RAIL_PATHS.length,
      'a sixth module was excused from this gate as payout-rail',
    ).toBe(5);

    const population = new Set(ENROLLMENT_PATHS);
    const excluded = new Set(PAYOUT_RAIL_PATHS);
    expect(
      swept.filter((path) => !population.has(path) && !excluded.has(path)),
      'names the referral domain but sits outside BOTH the population and the exclusion — add ' +
        'its directory to REFERRAL_OWNED_DIRECTORIES or REFERRAL_SHARED_DIRECTORIES, or add it ' +
        'to PAYOUT_RAIL_PATHS with its reason and move the count',
    ).toEqual([]);

    // Every exclusion, asserted in BOTH directions. An exemption is only safe
    // while it is still TRUE, and it stops being true in two opposite ways: the
    // sweep no longer REACHES the module (so the entry excuses nothing while
    // looking like a decision), or the population has ABSORBED it (so the entry
    // silently subtracts a module from every wall in this file).
    for (const path of PAYOUT_RAIL_PATHS) {
      expect(swept, `${path} is excused but the sweep no longer reaches it`).toContain(path);
      expect(
        population.has(path),
        `${path} is excused but is ALSO in the population; the exclusion now subtracts a module ` +
          'the walls would otherwise scan',
      ).toBe(false);
      expect(
        statSync(join(SRC_ROOT, path)).isFile(),
        `${path} no longer exists, so excusing it proves nothing`,
      ).toBe(true);
    }

    // THE POSITIVE CONTROL: `toEqual([])` is also what a sweep that reached
    // nothing produces, so the same sweep runs against a reader reporting a
    // referral-named module in a directory neither the population nor the
    // exclusion covers, and it must come back OUTSIDE.
    const planted = 'lib/referral-cache.ts';
    const seeded = domainNamedModules((relative) =>
      relative === 'lib'
        ? [...readDirectory(relative), { name: 'referral-cache.ts', isDirectory: () => false, isFile: () => true }]
        : readDirectory(relative),
    );
    expect(seeded, 'the sweep did not reach a planted module').toContain(planted);
    expect(
      seeded.filter((path) => !population.has(path) && !excluded.has(path)),
      'a module neither covered nor excused was NOT reported — the empty result above is a ' +
        'probe that cannot fail rather than a measurement',
    ).toEqual([planted]);
    expect(domainNamedModules()).not.toContain(planted);

    // And the POPULATION is still NARROW — the third world `toEqual([])` admits
    // and the one the plant cannot see, since a plant absent from the real sweep
    // is reported outside a population built FROM that sweep exactly as it is
    // outside a correct one.
    assertEachOf([
      'services/referral-payouts/rail.ts',
      'controllers/orders.controller.ts',
      'db/schema/orders.ts',
      'middleware/auth.ts',
    ], 4, (foreign) => {
      expect(ENROLLMENT_PATHS, `${foreign} belongs to another domain`).not.toContain(foreign);
      expect(
        statSync(join(SRC_ROOT, foreign)).isFile(),
        `${foreign} no longer exists, so excluding it proves nothing`,
      ).toBe(true);
    });
  });

  it('a module ADDED to the domain is scanned — the direction a hand list is blind in', () => {
    // Written against the DERIVATION rather than the filesystem: seeding a real
    // file would mutate a tree shared with every parallel suite.
    const seededWith = (directory: string, added: string): string[] =>
      referralNamed(directory, (relative) =>
        relative === directory
          ? [...readDirectory(relative), { name: added, isDirectory: () => false, isFile: () => true }]
          : readDirectory(relative),
      );

    expect(
      seededWith('db/schema', 'referralDisputes.ts'),
      'a new referral schema module does not enter the population',
    ).toContain('db/schema/referralDisputes.ts');
    expect(
      seededWith('middleware', 'referral-dispute-schemas.ts'),
      'a new referral middleware module does not enter the population',
    ).toContain('middleware/referral-dispute-schemas.ts');
    // … and ONLY by name, or these walls start firing at whoever edits an order.
    expect(
      seededWith('routes', 'orders.ts'),
      'a foreign route entered the population; the name rule has stopped narrowing',
    ).not.toContain('routes/orders.ts');

    // And the RECURSION, the other half of the #460 repair — the half this file
    // had hand-patched for `routes/admin` alone.
    expect(
      referralNamed('routes', (relative) =>
        relative === 'routes'
          ? [...readDirectory(relative), { name: 'internal', isDirectory: () => true, isFile: () => false }]
          : relative === 'routes/internal'
            ? [{ name: 'referral-audit.ts', isDirectory: () => false, isFile: () => true }]
            : readDirectory(relative),
      ),
      'a module in a SUBDIRECTORY of a shared directory is not admitted; the sweep beside the ' +
        'recursive walk is still one level deep',
    ).toContain('routes/internal/referral-audit.ts');
    // …and the real `routes/admin` module the hand-patched line used to cover is
    // still in the population, reached now by recursion rather than by name.
    expect(ENROLLMENT_PATHS).toContain('routes/admin/referral-partner.ts');
  });
});

describe('enrollment answers no permission question of its own', () => {
  it('reads no role, permission array or role matrix', () => {
    assertReferralDomainIsWhole();
    for (const path of ENROLLMENT_PATHS) {
      expect(
        readEnrollmentCode(path),
        `${path} derives a store permission — the MOUNT answers that question`,
      ).not.toMatch(PERMISSION_DERIVATION);
    }
  });

  it('reads store MEMBERSHIP in exactly one module, for a stated reason', () => {
    const readers = ENROLLMENT_PATHS.filter((path) => MEMBERSHIP_READ.test(readEnrollmentCode(path)));
    // EXACT, never a floor: a second module reading membership is a decision
    // somebody takes rather than one that quietly joins an excused set. And
    // asserting the reader is still HERE is what stops the exemption going
    // stale — a `toEqual([])` would pass just as well if #144's check were
    // deleted, and the separation being tested would be from nothing.
    expect(
      readers,
      'store membership is read outside the self-referral check; wall 1 permits a membership ' +
        'FACT only where #144 needs one, and nowhere else',
    ).toEqual([MEMBERSHIP_READER]);
  });

  it('scans a floor of modules per SHAPE, so a walk that collapsed cannot pass', () => {
    assertReferralDomainIsWhole();
    for (const path of ENROLLMENT_PATHS) expect(readEnrollmentSource(path).length).toBeGreaterThan(200);
  });

  /**
   * The POSITIVE half, and the reason this gate is not vacuous: the store mount
   * really does consume the answer, by naming the permission at the line that
   * mounts the router. A gate asserting only an absence would pass just as
   * happily if the store surface had no gate at all.
   */
  it('the store mount NAMES the permission it consumes', () => {
    const mount = readEnrollmentCode('routes/admin/referral-partner.ts');
    expect(mount).toMatch(/requireStorePermission\(\s*'store:manage'\s*\)/);
    // And it takes the owner from what that middleware loaded, never from the
    // request body.
    expect(mount).toMatch(/req\.store/);
    expect(mount).not.toMatch(/req\.body/);
  });

  it('the self mount takes the owner from the verified caller only', () => {
    const mount = readEnrollmentCode('routes/referral-partner.ts');
    expect(mount).toMatch(/getRequiredOxyUserId\(req\)/);
    expect(mount).not.toMatch(/req\.body|req\.query|req\.headers/);
  });
});

describe('enrollment grants nothing and reaches no money', () => {
  it('performs none of the forbidden grants', () => {
    // Every published prohibition has a detector, and every detector names a
    // published prohibition. Neither half alone is a gate: a value with no
    // detector is a rule nothing enforces, and a detector with no value is one
    // nobody wrote down.
    expect(Object.keys(GRANT_DETECTORS).sort()).toEqual([...REFERRAL_ENROLLMENT_FORBIDDEN_GRANTS].sort());

    assertReferralDomainIsWhole();
    for (const path of ENROLLMENT_PATHS) {
      const code = readEnrollmentCode(path);
      for (const [grant, detector] of Object.entries(GRANT_DETECTORS)) {
        // The one narrowing, and it is a module rather than a pattern: see
        // {@link MERCHANT_CLAIM_READER}. Every other grant detector still runs
        // over it, which is the point of excusing the pair rather than the file.
        if (grant === 'merchant_claim' && path === MERCHANT_CLAIM_READER) continue;
        expect(code, `${path} performs a ${grant} grant, which enrollment may not`).not.toMatch(
          detector,
        );
      }
    }
  });

  /**
   * The probe that makes the merchant-claim exemption safe rather than merely
   * justified: the excused module must STILL be the reader it was excused for,
   * and it must still be the ONLY one.
   */
  it('the merchant-claim exemption covers exactly one module, and it still reads', () => {
    const readers = ENROLLMENT_PATHS.filter((path) =>
      GRANT_DETECTORS['merchant_claim']?.test(readEnrollmentCode(path)),
    );
    expect(
      readers,
      'the merchant-claim exemption no longer matches — either the binding stopped reading ' +
        'claims, or a second module started',
    ).toEqual([MERCHANT_CLAIM_READER]);
    // And it is a READ: the repository's write entry points must not appear.
    expect(
      readEnrollmentCode(MERCHANT_CLAIM_READER),
      'the binding now WRITES a merchant claim, which is the grant wall 2 forbids',
    ).not.toMatch(/insertMerchantClaim|updateMerchantClaim|verifyMerchantClaim|setClaimState/);
  });

  it('names no payment rail or ledger, except through the published readiness port', () => {
    assertReferralDomainIsWhole();
    for (const path of ENROLLMENT_PATHS) {
      // #145's earnings modules post a partner's commission to the ledger by
      // design — real money Mercaria owes. Excused as a DIRECTORY so a fourth
      // one does not arrive outside a wall, and counted exactly below.
      if (path.startsWith(LEDGER_POSTING_DIRECTORY)) continue;
      const code = readEnrollmentCode(path);
      // The ONE exemption, and it is narrow: the readiness PORT is a contract
      // the `services/referral-payouts/` join registers into, so reading it is
      // an edge that runs join → domain rather than the reverse. #145's
      // `reward-funding-isolation.test.ts` exempts the same seam by name.
      const withoutPort = code.replace(/earnings\/partner-readiness\.port\.js/g, ' ');
      expect(withoutPort, `${path} reaches the payment rail`).not.toMatch(PAYMENT_REFERENCE);
    }
  });

  it('the earnings exemption excuses exactly the modules that really post', () => {
    const excused = ENROLLMENT_PATHS.filter(
      (path) => path.startsWith(LEDGER_POSTING_DIRECTORY) && PAYMENT_REFERENCE.test(readEnrollmentCode(path)),
    );
    expect(
      excused.sort(),
      'the ledger-posting exemption no longer matches — a module that stopped posting is ' +
        'still being excused, or a fourth one started',
    ).toEqual([
      'services/referrals/earnings/accounts.ts',
      'services/referrals/earnings/ledger-postings.ts',
      'services/referrals/earnings/posting.service.ts',
    ]);
    const inDirectory = ENROLLMENT_PATHS.filter((path) => path.startsWith(LEDGER_POSTING_DIRECTORY));
    expect(inDirectory.length, 'the earnings walk found nothing').toBeGreaterThanOrEqual(11);
    expect(
      inDirectory.length,
      'every module of `earnings/` now posts — the exemption has become a blanket one',
    ).toBeGreaterThan(excused.length);
  });

  it('names no ranking module or policy', () => {
    assertReferralDomainIsWhole();
    for (const path of ENROLLMENT_PATHS) {
      expect(readEnrollmentCode(path), `${path} reaches ranking`).not.toMatch(RANKING_REFERENCE);
    }
  });
});

describe('nothing fetches what an applicant typed', () => {
  it('makes no outbound call anywhere in the domain', () => {
    // The test NAME says "anywhere in the domain"; until #460 the body scanned
    // fifteen files of ninety-four, so the sentence was the claim and the list
    // was the measurement. It really is the whole domain now.
    assertReferralDomainIsWhole();
    for (const path of ENROLLMENT_PATHS) {
      expect(
        readEnrollmentCode(path),
        `${path} makes an outbound call — a promotion URL an applicant supplies must never be fetched`,
      ).not.toMatch(OUTBOUND_FETCH);
    }
  });

  /**
   * `new URL(...)` IS used — to PARSE and normalize, which is the opposite of
   * fetching — so the gate must not forbid it, and this pins that the parsing
   * is where it belongs rather than spread across the domain.
   */
  it('parses URLs in exactly one module, and composes one in exactly one other', () => {
    const parsers = ENROLLMENT_PATHS.filter((path) => /new URL\s*\(/.test(readEnrollmentCode(path)));
    // Two over the whole domain, and they do opposite things:
    // `application-answers.ts` PARSES an applicant's promotion URL to normalize
    // it, and `redirect.service.ts` COMPOSES the outbound destination behind an
    // origin check — which is `referral-attribution-isolation.test.ts`'s wall,
    // pinned there from the other side. EXACT, so a third is a decision.
    expect(parsers.sort()).toEqual([
      'services/referrals/application-answers.ts',
      'services/referrals/redirect.service.ts',
    ]);
  });
});

describe('a partner-facing projection carries no risk signal', () => {
  it('the partner projection module never reads the reviewer note', () => {
    const projection = readEnrollmentCode('services/referrals/partner-standing.service.ts');
    expect(projection).not.toMatch(REVIEWER_NOTE_LEAK);
    for (const forbidden of REFERRAL_APPLICATION_FORBIDDEN_DISCLOSURES) {
      expect(projection, `the partner projection names ${forbidden}`).not.toMatch(
        new RegExp(forbidden.replace(/_/g, '[_\\s]?'), 'i'),
      );
    }
  });

  /**
   * The positive control. The OPERATOR controller DOES read the note, and must
   * — otherwise the assertion above would pass just as well against a codebase
   * where nobody records one, and the separation being tested would be between
   * an operator and a field that does not exist.
   */
  it('the OPERATOR controller does read it', () => {
    expect(readEnrollmentCode('controllers/referral-enrollment-operator.controller.ts')).toMatch(
      REVIEWER_NOTE_LEAK,
    );
  });

  it('no rejection code could name a risk signal', () => {
    for (const code of REFERRAL_APPLICATION_REJECTION_CODES) {
      expect(REFERRAL_APPLICATION_FORBIDDEN_DISCLOSURES).not.toContain(code);
    }
    // Disjoint, and both non-empty — a containment check over an empty set is
    // a check that cannot fail.
    expect(REFERRAL_APPLICATION_REJECTION_CODES.length).toBeGreaterThanOrEqual(8);
    expect(REFERRAL_APPLICATION_FORBIDDEN_DISCLOSURES.length).toBeGreaterThanOrEqual(7);
  });
});

describe('the closed vocabularies are complete', () => {
  it('every enrollment mode has a rule, and every rule names a mode', () => {
    expect(Object.keys(REFERRAL_ENROLLMENT_MODE_RULES).sort()).toEqual(
      [...REFERRAL_ENROLLMENT_MODES].sort(),
    );
    expect(REFERRAL_ENROLLMENT_MODES).toHaveLength(8);
  });

  /**
   * Every field of the rule table does WORK, which is what stops it becoming a
   * table of constants nobody reads. If every mode answered the same, the
   * column would be a comment.
   */
  it('every rule column discriminates at least two modes', () => {
    const rules = Object.values(REFERRAL_ENROLLMENT_MODE_RULES);
    for (const key of [
      'selfServe',
      'requiresOperatorReview',
      'requiresOperatorEvidence',
      'earnsProductionRewards',
    ] as const) {
      const values = new Set(rules.map((rule) => rule[key]));
      expect(values.size, `${key} answers the same for every mode — it decides nothing`).toBe(2);
    }
    const ownerScopes = new Set(rules.map((rule) => [...rule.eligibleOwnerTypes].sort().join(',')));
    expect(ownerScopes.size).toBeGreaterThan(1);
  });

  it('exactly one mode earns no production rewards, and it is the test one', () => {
    const isolated = REFERRAL_ENROLLMENT_MODES.filter(
      (mode) => !REFERRAL_ENROLLMENT_MODE_RULES[mode].earnsProductionRewards,
    );
    expect(isolated).toEqual(['staff_test']);
  });

  it('keeps #142\'s five partner states and adds four', () => {
    // The MAPPING #146 recorded, asserted rather than described: `applied` IS
    // "submitted" and stays spelled `applied`, `invited` survives, and nothing
    // was removed. A narrowing here would strand every live row.
    for (const shipped of ['applied', 'invited', 'approved', 'suspended', 'terminated']) {
      expect(REFERRAL_PARTNER_STATES).toContain(shipped);
    }
    expect(REFERRAL_PARTNER_STATES).toHaveLength(9);
    expect(REFERRAL_PARTNER_STATES).not.toContain('submitted');
  });
});

/**
 * The application-item CENSUS.
 *
 * #146's "Application" group is ten numbered items and a hand-maintained map is
 * only a gate if being in NEITHER half fails. So: all ten present exactly once,
 * every `not_collected` and every off-table source carrying its REASON, and
 * every named column existing on the table it names — the last is what stops a
 * rename leaving a map that quietly points nowhere.
 */
describe('every one of #146\'s ten application items is accounted for', () => {
  const TABLES = {
    application: referralPartnerApplications,
    partner: referralPartners,
    tax_questionnaire: referralTaxProfiles,
  } as const;

  it('covers items 1 to 10 exactly once', () => {
    expect([...REFERRAL_APPLICATION_ITEMS].map((entry) => entry.item).sort((a, b) => a - b)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
  });

  it('names a real column for every item that claims one', () => {
    let checked = 0;
    for (const entry of REFERRAL_APPLICATION_ITEMS) {
      if (entry.source === 'not_collected' || entry.source === 'oxy_identity') continue;
      expect(entry.column, `item ${String(entry.item)} names no column`).toBeDefined();
      const columns = getTableConfig(TABLES[entry.source]).columns.map(sqlColumnName);
      expect(
        columns,
        `item ${String(entry.item)} names ${String(entry.column)}, which is not on ${entry.source}`,
      ).toContain(entry.column);
      checked += 1;
    }
    // A floor, so a map that resolved to nothing cannot report a clean census.
    expect(checked).toBeGreaterThanOrEqual(6);
  });

  it('states a REASON wherever the item lives outside the enrollment tables', () => {
    for (const entry of REFERRAL_APPLICATION_ITEMS) {
      // `application` and `partner` are both this domain's own tables, so an
      // item on either is collected where a reader would look for it and owes
      // no essay. The three that owe one are the three somebody would
      // otherwise have to go and find: another domain's table, Oxy, or nowhere.
      if (entry.source === 'application' || entry.source === 'partner') continue;
      expect(
        (entry.reason ?? '').length,
        `item ${String(entry.item)} is elsewhere and says nothing about why`,
      ).toBeGreaterThan(40);
    }
  });

  it('does not quietly skip everything', () => {
    const skipped = REFERRAL_APPLICATION_ITEMS.filter((entry) => entry.source === 'not_collected');
    // Exactly one, and naming it: a list of exemptions needs its own EXACT
    // count, not a floor — an ever-growing one is the gate switching itself off
    // a defensible line at a time.
    expect(skipped.map((entry) => entry.item)).toEqual([9]);
  });
});

/**
 * Each detector actually detects.
 *
 * Every regex above is run against a seeded positive, because a broken pattern
 * matches nothing and reads exactly like a clean domain — and against the real
 * sources, so a pattern that fires on what this domain legitimately does is
 * caught here rather than by whoever disables it later.
 */
describe('each detector actually detects (mutation self-test)', () => {
  it('fires on the thing it forbids', () => {
    expect('const held = effectivePermissions(membership);').toMatch(PERMISSION_DERIVATION);
    // Every grant detector, against the write it forbids. A `Record` of
    // patterns is exactly the shape where one broken entry hides silently.
    const grantPositives: Readonly<Record<string, string>> = {
      store_permission: "await grantStorePermission(store, 'products:write');",
      store_membership: 'await addStoreMember(tx, { storeId, oxyUserId });',
      merchant_claim: "import { verifyMerchantClaim } from '../merchant-claims/claim.js';",
      payment_onboarding: 'await insertProviderAccount(tx, { provider, ownerType, ownerId });',
      oxy_administrative_role: "await grantOxyRole(oxyUserId, 'admin');",
      operator_allow_list: 'config.referrals.operatorOxyUserIds = [...ids, partner.ownerId];',
    };
    expect(Object.keys(grantPositives).sort()).toEqual([...REFERRAL_ENROLLMENT_FORBIDDEN_GRANTS].sort());
    for (const [grant, positive] of Object.entries(grantPositives)) {
      expect(positive, `the ${grant} detector matches nothing`).toMatch(GRANT_DETECTORS[grant]!);
    }
    expect("import { insertLedgerTransaction } from '../payments/ledgerRepository.js';").toMatch(
      PAYMENT_REFERENCE,
    );
    expect("import { rankOffers } from '../ranking/score.js';").toMatch(RANKING_REFERENCE);
    expect('const head = await fetch(application.promotionUrls[0]);').toMatch(OUTBOUND_FETCH);
    expect('const res = await safeFetch(url);').toMatch(OUTBOUND_FETCH);
    // Every spelling the narrowed client pattern must still catch. A pattern
    // narrowed to fix a false positive is exactly where the fix silently
    // becomes a hole, so each is pinned rather than argued.
    expect("import axios from 'axios';").toMatch(OUTBOUND_FETCH);
    expect('const res = await axios.get(url);').toMatch(OUTBOUND_FETCH);
    expect("const got = require('got');").toMatch(OUTBOUND_FETCH);
    expect("import { request } from 'undici';").toMatch(OUTBOUND_FETCH);
    expect("import fetch from 'node-fetch';").toMatch(OUTBOUND_FETCH);
    expect("import { get } from 'node:https';").toMatch(OUTBOUND_FETCH);
    expect('reviewerNote: review.reviewerNote,').toMatch(REVIEWER_NOTE_LEAK);
  });

  it('does NOT fire on the things this domain legitimately does', () => {
    // The mount naming the permission it CONSUMES is the correct shape, and a
    // detector that flagged it would have its cheapest green be deleting the
    // gate — the failure mode #67's host-comparison detector was measured on.
    expect("router.use(requireStorePermission('store:manage'));").not.toMatch(PERMISSION_DERIVATION);
    for (const [grant, detector] of Object.entries(GRANT_DETECTORS)) {
      expect(
        "router.use(requireStorePermission('store:manage'));",
        `the ${grant} detector fires on the line that CONSUMES the permission answer`,
      ).not.toMatch(detector);
    }
    // Parsing a URL is the opposite of fetching one.
    expect('const parsed = new URL(trimmed);').not.toMatch(OUTBOUND_FETCH);
    // The real false positive that widening this wall to the whole domain
    // produced: `traffic.ts` carries a bot USER-AGENT list, so the module whose
    // job is to detect crawlers read as one. Pinned in both directions, on the
    // literal entries, so a later re-widening of the pattern breaks here rather
    // than in whoever hits it next and deletes the wall.
    expect("const BOT_AGENTS = ['wget/', 'okhttp', 'axios/', 'node-fetch'];").not.toMatch(
      OUTBOUND_FETCH,
    );
    expect("if (agent.includes('undici')) return 'bot';").not.toMatch(OUTBOUND_FETCH);
    // …and the membership split: deriving a permission is forbidden, reading a
    // membership row is a fact #144 needs, so the two must not be one detector.
    expect('const held = effectivePermissions(membership);').not.toMatch(MEMBERSHIP_READ);
    expect('.from(storeMembers)').toMatch(MEMBERSHIP_READ);
    expect('.from(storeMembers)').not.toMatch(PERMISSION_DERIVATION);
    // The readiness port is the exempted seam, and stripping it must not strip
    // a real payment import beside it.
    expect(
      "import { readReferralPartnerReadiness } from './earnings/partner-readiness.port.js';".replace(
        /earnings\/partner-readiness\.port\.js/g,
        ' ',
      ),
    ).not.toMatch(PAYMENT_REFERENCE);
    expect(
      "import { x } from '../payments/ledgerRepository.js';".replace(
        /earnings\/partner-readiness\.port\.js/g,
        ' ',
      ),
    ).toMatch(PAYMENT_REFERENCE);
  });
});
