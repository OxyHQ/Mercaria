/**
 * The walls around the referral partner dashboard (#147 acceptance 3 and 8).
 *
 * Six of them, each with a VACUITY FLOOR (a scan that read nothing reports the
 * same clean zero as a scan that found nothing) and a MUTATION SELF-TEST (a
 * detector that cannot fire is coverage nobody has).
 *
 * The failure this exists to prevent is the one a referral dashboard invites:
 * "who did I refer" becoming a list of people. It never arrives as a leaked
 * column — it arrives as a projection somebody spread, a dimension somebody
 * added, or an operator read somebody reused because the numbers were already
 * there.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DirectoryReader,
  assertNothingOutsideDomainPopulation,
  namedInSharedDirectories,
  readSrcDirectory,
  walkOwnedDirectory,
} from '../../../__tests__/domain-population.js';
import { join } from 'node:path';
import {
  REFERRAL_FORBIDDEN_PERFORMANCE_DIMENSIONS,
  REFERRAL_METRIC_DEFINITIONS,
  REFERRAL_METRIC_KEYS,
  REFERRAL_PARTNER_FORBIDDEN_FIELDS,
  REFERRAL_PERFORMANCE_DIMENSIONS,
  REFERRAL_PERFORMANCE_DIMENSION_ELSEWHERE,
} from '@mercaria/shared-types';
import { findForbiddenPartnerFields } from '../dashboard/partner-projection.js';
import { assertEachOf } from '../../../__tests__/assert-each-of.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DASHBOARD_DIR = join(SRC_ROOT, 'services/referrals/dashboard');
const PARTNER_CONTROLLER = join(SRC_ROOT, 'controllers/referral-partner.controller.ts');

/**
 * What a module of THIS sub-domain is called.
 *
 * `services/referrals/` hosts four sub-domains with four gates, so a bare
 * `referral` here would pull earnings, integrity, rewards and the partner
 * surface into this population — 118 modules against this one's ten. The
 * pattern names the dashboard specifically, in both spellings that exist:
 * the directory segment and the hyphenated middleware filename.
 */
const DASHBOARD_NAME_PATTERN = /referrals?[/-]dashboard|referralDashboard/i;

/** The one directory this sub-domain owns outright. */
const OWNED_DIRECTORY = 'services/referrals/dashboard';

/** The flat directories a module of this sub-domain lives in under its own NAME. */
const SHARED_DIRECTORIES = ['routes', 'controllers', 'middleware', 'db/schema'] as const;

/**
 * Every module of the dashboard sub-domain, RELATIVE to `src/`.
 *
 * It was the owned directory and nothing else (#460), so
 * `middleware/referral-dashboard-schemas.ts` — the request schemas, which decide
 * what a partner may ASK the dashboard for — sat behind none of the walls below.
 *
 * The path also stops being a function of `process.cwd()`: it was
 * `join(process.cwd(), 'src/...')`, which is correct only when vitest is invoked
 * from the package root.
 */
function domainRelativePaths(readDir: DirectoryReader = readSrcDirectory): string[] {
  return [
    ...walkOwnedDirectory(OWNED_DIRECTORY, readDir),
    ...namedInSharedDirectories(SHARED_DIRECTORIES, DASHBOARD_NAME_PATTERN, readDir),
  ];
}

/** Every `.ts` of the sub-domain, so the walls hold for files nobody has written. */
function dashboardFiles(): { path: string; source: string }[] {
  return domainRelativePaths().map((relative) => ({
    path: join(SRC_ROOT, relative),
    source: readFileSync(join(SRC_ROOT, relative), 'utf8'),
  }));
}

/**
 * Source with block and line comments removed.
 *
 * Every module here documents what it refuses to do in the same vocabulary the
 * detectors match, so a prose-inclusive scan would implicate the safest files —
 * the ones explaining the prohibition — and nothing else.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

describe('WALL 1 — the partner path cannot reach the operator-only utilization read', () => {
  it('is imported by no partner-facing module', () => {
    const files = dashboardFiles();
    // Vacuity floor: a walk that found no files reports the same clean pass.
    expect(files.length).toBeGreaterThanOrEqual(7);

    const offenders = files.filter(({ path, source }) => {
      if (path.endsWith('utilization.service.ts')) return false;
      return /from '\.\/utilization\.service\.js'/u.test(stripComments(source));
    });
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('mutation self-test: the detector fires on a real import', () => {
    const injected = "import { readProgramUtilization } from './utilization.service.js';";
    expect(/from '\.\/utilization\.service\.js'/u.test(stripComments(injected))).toBe(true);
  });

  it('and the operator surface DOES import it, so the wall is not vacuous', () => {
    // A wall asserting only an absence passes just as happily against a
    // capability nobody built. The controller that may reach it must.
    const controller = readFileSync(
      join(process.cwd(), 'src/controllers/referral-program-operator.controller.ts'),
      'utf8',
    );
    expect(controller).toContain('utilization.service.js');
  });
});

describe('WALL 2 — no partner-facing module reads a buyer-shaped field', () => {
  it('names no forbidden field in its own code', () => {
    const files = dashboardFiles();
    expect(files.length).toBeGreaterThanOrEqual(7);

    // `campaignRef` and friends are fine; these are the names that could only
    // ever be a person or their purchase.
    const forbidden = [
      'buyerOxyUserId',
      'buyerEmail',
      'subjectRef',
      'guestSessionRef',
      'orderNumber',
      'cardFingerprint',
    ];
    const offenders: string[] = [];
    for (const { path, source } of files) {
      const code = stripComments(source);
      for (const name of forbidden) {
        // The projection walker legitimately NAMES the prohibition as data, so
        // the file that holds the list is excluded BY PATH — the same
        // narrowing #164's service-auth gate takes for `auth.ts`.
        if (path.endsWith('partner-projection.ts')) continue;
        if (new RegExp(`\\b${name}\\b`, 'u').test(code)) offenders.push(`${path}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('mutation self-test: the detector fires on a real read', () => {
    const injected = 'const who = row.buyerOxyUserId;';
    expect(/\bbuyerOxyUserId\b/u.test(stripComments(injected))).toBe(true);
  });
});

describe('WALL 3 — the runtime projection walk', () => {
  it('finds a forbidden field at any depth', () => {
    const leaky = {
      earnings: { recentRewards: [{ date: '2026-08-01', orderId: 'ord_1' }] },
    };
    expect(findForbiddenPartnerFields(leaky)).toEqual(['$.earnings.recentRewards[0].orderId']);
  });

  it('is CASE-INSENSITIVE, because a serializer emits what it likes', () => {
    // Measured in the Moovo client: a redactor that lower-cased its own output
    // made a case-sensitive assertion pass vacuously.
    expect(findForbiddenPartnerFields({ BuyerEmail: 'x' })).toHaveLength(1);
    expect(findForbiddenPartnerFields({ ORDERID: 'x' })).toHaveLength(1);
  });

  it('passes a projection that carries only what A5 permits', () => {
    const safe = {
      performance: { rows: [{ key: 'ES', label: 'ES', humanClicks: 40, qualifiedConversions: 11 }] },
      earnings: {
        recentRewards: [
          { date: '2026-08-01', state: 'held', netAmountMinor: 1200, currency: 'EUR', campaignRef: 'summer' },
        ],
      },
    };
    expect(findForbiddenPartnerFields(safe)).toEqual([]);
  });

  it('has a non-empty list to check against', () => {
    // Vacuity floor: an empty list makes every walk above pass by finding
    // nothing to find.
    expect(REFERRAL_PARTNER_FORBIDDEN_FIELDS.length).toBeGreaterThanOrEqual(20);
  });
});

describe('WALL 4 — the performance dimensions are a closed, disjoint set', () => {
  it('is disjoint from the forbidden list', () => {
    const allowed = new Set<string>(REFERRAL_PERFORMANCE_DIMENSIONS);
    const overlap = REFERRAL_FORBIDDEN_PERFORMANCE_DIMENSIONS.filter((name) => allowed.has(name));
    expect(overlap).toEqual([]);
    // Both floors: a wall between two empty sets is a wall between nothing.
    expect(REFERRAL_PERFORMANCE_DIMENSIONS.length).toBe(6);
    expect(REFERRAL_FORBIDDEN_PERFORMANCE_DIMENSIONS.length).toBeGreaterThanOrEqual(14);
  });

  it('accounts for the three #147 lists that a click cannot carry', () => {
    // A census, not a paragraph: a dimension dropped from the vocabulary and
    // not named here is one somebody forgot rather than decided about.
    expect(Object.keys(REFERRAL_PERFORMANCE_DIMENSION_ELSEWHERE).sort()).toEqual([
      'commission_state',
      'conversion_type',
      'payout_period',
    ]);
    for (const reason of Object.values(REFERRAL_PERFORMANCE_DIMENSION_ELSEWHERE)) {
      expect(reason.length).toBeGreaterThan(40);
    }
  });
});

describe('WALL 5 — every published figure names its own definition', () => {
  it('has a definition for every key, and no orphan definition', () => {
    expect([...REFERRAL_METRIC_KEYS].sort()).toEqual(Object.keys(REFERRAL_METRIC_DEFINITIONS).sort());
    expect(REFERRAL_METRIC_KEYS.length).toBeGreaterThanOrEqual(9);
  });

  it('states a numerator, a window, a source and an ATTRIBUTION LIMIT', () => {
    // #77's rule. `attributionLimit` is the field that earns its place: it is
    // where a figure says what it CANNOT see, which is the half a partner
    // reconciling their own earnings needs and the half nobody writes.
    for (const key of REFERRAL_METRIC_KEYS) {
      const definition = REFERRAL_METRIC_DEFINITIONS[key];
      expect(definition.key).toBe(key);
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.numerator.length).toBeGreaterThan(30);
      expect(definition.window.length).toBeGreaterThan(5);
      expect(definition.source.length).toBeGreaterThan(3);
      expect(definition.attributionLimit.length).toBeGreaterThan(40);
    }
  });

  it('publishes NO conversion rate', () => {
    // #37 acceptance 3 forbids dividing clicks by conversions, and #67 gives
    // the reason: a conversion is revisable for weeks while a click is not, so
    // the ratio moves without either input being wrong. A metric key named for
    // a rate would be the first place one appeared.
    for (const key of REFERRAL_METRIC_KEYS) {
      expect(key).not.toMatch(/_rate$/u);
    }
    const source = readFileSync(join(DASHBOARD_DIR, 'performance.service.ts'), 'utf8');
    expect(stripComments(source)).not.toMatch(/conversionRate|clickThroughRate/u);
  });
});

describe('WALL 6 — no partner route can name a partner', () => {
  it('reads no partner id off a request', () => {
    const source = stripComments(readFileSync(PARTNER_CONTROLLER, 'utf8'));
    // Vacuity floor: the file must be the one that mounts the routes.
    expect(source).toContain('makeReferralPartnerRouter');
    expect(source.length).toBeGreaterThan(4000);

    assertEachOf([
      /req\.params\.partnerId/u,
      /req\.query\.partnerId/u,
      /req\.body\.partnerId/u,
      /params\.ownerId/u,
      /query\.ownerType/u,
    ], 5, (pattern) => {
      expect(source).not.toMatch(pattern);
    });
  });

  it('resolves every owner through the mount-supplied resolver', () => {
    const source = stripComments(readFileSync(PARTNER_CONTROLLER, 'utf8'));
    // Every handler that needs an owner calls `resolveOwner(req)`. The count is
    // a floor rather than an equality: routes are added, and a floor that could
    // never move would forbid the next one.
    const calls = source.match(/resolveOwner\(req\)/gu) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(14);
  });

  it('mutation self-test: the detector fires on a real read', () => {
    expect(/req\.params\.partnerId/u.test('const id = req.params.partnerId;')).toBe(true);
  });
});


describe('the population every wall above is applied to (#460)', () => {
  it('nothing naming this sub-domain sits outside it', () => {
    assertNothingOutsideDomainPopulation({
      population: domainRelativePaths,
      pattern: DASHBOARD_NAME_PATTERN,
      // Deliberately empty, and the assertion is what makes that a measurement:
      // every module the whole-tree sweep finds under this sub-domain's own name
      // is this sub-domain's.
      notThisDomain: [],
      // Below today's 10 so a routine deletion does not fail the build, and far
      // enough above zero that a traversal which reached nothing does.
      sweepFloor: 8,
      plantIn: 'lib',
      plantName: 'referral-dashboard-cache.ts',
    });
  });

  it('the module the owned-directory population could not reach is in it', () => {
    // An identity assertion, not a floor. A floor set below 10 is met without
    // it.
    const population = domainRelativePaths();
    for (const named of ['middleware/referral-dashboard-schemas.ts']) {
      expect(population, `${named} is outside every wall again`).toContain(named);
      expect(
        statSync(join(SRC_ROOT, named)).isFile(),
        `${named} no longer exists, so naming it proves nothing`,
      ).toBe(true);
    }
  });

  it('the SIBLING sub-domains stay out — `services/referrals/` hosts four', () => {
    // The hazard this narrow pattern exists for. A bare `referral` matches 118
    // modules across four sub-domains, each with its own gate and its own walls,
    // and a population that swallowed them would apply THIS gate's walls to code
    // three other issues own. Each sibling is asserted to exist, so the
    // exclusion cannot go vacuous on a rename.
    const population = domainRelativePaths();
    assertEachOf(['services/referrals/earnings/posting.service.ts', 'services/referrals/integrity/effects.ts', 'services/referrals/rewards/funding.ts'], 3, (sibling) => {
      expect(
        statSync(join(SRC_ROOT, sibling)).isFile(),
        `${sibling} no longer exists, so excluding it proves nothing`,
      ).toBe(true);
      expect(DASHBOARD_NAME_PATTERN.test(sibling), `${sibling} matches this sub-domain's name`).toBe(false);
      expect(population, `${sibling} belongs to a sibling sub-domain`).not.toContain(sibling);
    });
    // …and the vacuity floor on the loop itself.
    expect(['services/referrals/earnings/posting.service.ts', 'services/referrals/integrity/effects.ts', 'services/referrals/rewards/funding.ts'].length).toBeGreaterThanOrEqual(3);
  });

  it('floors PER SHAPE, because the sources break independently', () => {
    const owned = walkOwnedDirectory(OWNED_DIRECTORY);
    const shared = namedInSharedDirectories(SHARED_DIRECTORIES, DASHBOARD_NAME_PATTERN);
    expect(owned.length, 'the owned-directory walk reached nothing').toBeGreaterThanOrEqual(7);
    expect(shared.length, 'the shared-directory name sweep reached nothing').toBeGreaterThanOrEqual(
      1,
    );
  });
});
