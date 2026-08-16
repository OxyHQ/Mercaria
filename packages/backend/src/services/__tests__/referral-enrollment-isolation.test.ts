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
import { readFileSync } from 'node:fs';
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

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Every module #146 increment 2 added or owns.
 *
 * A new module in the enrollment path belongs on this list; the vacuity floor
 * below is what forces whoever adds one to look here. #142's partner service is
 * INCLUDED because #146 widened two of its state sets and mounted all three of
 * its standing transitions — it is part of this surface now.
 */
const ENROLLMENT_PATHS = [
  'services/referrals/enrollment.service.ts',
  'services/referrals/application-review.service.ts',
  'services/referrals/application-answers.ts',
  'services/referrals/partner-standing.service.ts',
  'services/referrals/partner-agreement.ts',
  'services/referrals/terms.service.ts',
  'services/referrals/duplicate-signals.ts',
  'services/referrals/partner.service.ts',
  'db/referrals/applicationRepository.ts',
  'db/referrals/termsAcceptanceRepository.ts',
  'controllers/referral-partner.controller.ts',
  'controllers/referral-enrollment-operator.controller.ts',
  'middleware/referral-partner-schemas.ts',
  'routes/referral-partner.ts',
  'routes/admin/referral-partner.ts',
];

/** The vacuity floor. A domain that shrank to nothing must fail, not pass. */
const MINIMUM_SCANNED_FILES = 15;

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
  /effectivePermissions|ROLE_PERMISSIONS|findStoreMember|storeMembers\b|storeMembership|\.permissions\b|STORE_PERMISSIONS/;
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
const OUTBOUND_FETCH = /\bfetch\s*\(|safeFetch|axios|node:https|node:http\b|got\s*\(|undici/;
const REVIEWER_NOTE_LEAK = /reviewerNote|reviewer_note/;

describe('enrollment answers no permission question of its own', () => {
  it('reads no role, permission array, membership or role matrix', () => {
    for (const path of ENROLLMENT_PATHS) {
      expect(
        readEnrollmentCode(path),
        `${path} derives a store permission — the MOUNT answers that question`,
      ).not.toMatch(PERMISSION_DERIVATION);
    }
  });

  it('scanned every file it claims to', () => {
    expect(ENROLLMENT_PATHS.length).toBeGreaterThanOrEqual(MINIMUM_SCANNED_FILES);
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

    for (const path of ENROLLMENT_PATHS) {
      const code = readEnrollmentCode(path);
      for (const [grant, detector] of Object.entries(GRANT_DETECTORS)) {
        expect(code, `${path} performs a ${grant} grant, which enrollment may not`).not.toMatch(
          detector,
        );
      }
    }
  });

  it('names no payment rail or ledger, except through the published readiness port', () => {
    for (const path of ENROLLMENT_PATHS) {
      const code = readEnrollmentCode(path);
      // The ONE exemption, and it is narrow: the readiness PORT is a contract
      // the `services/referral-payouts/` join registers into, so reading it is
      // an edge that runs join → domain rather than the reverse. #145's
      // `reward-funding-isolation.test.ts` exempts the same seam by name.
      const withoutPort = code.replace(/earnings\/partner-readiness\.port\.js/g, ' ');
      expect(withoutPort, `${path} reaches the payment rail`).not.toMatch(PAYMENT_REFERENCE);
    }
  });

  it('names no ranking module or policy', () => {
    for (const path of ENROLLMENT_PATHS) {
      expect(readEnrollmentCode(path), `${path} reaches ranking`).not.toMatch(RANKING_REFERENCE);
    }
  });
});

describe('nothing fetches what an applicant typed', () => {
  it('makes no outbound call anywhere in the domain', () => {
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
  it('parses URLs in exactly one module', () => {
    const parsers = ENROLLMENT_PATHS.filter((path) => /new URL\s*\(/.test(readEnrollmentCode(path)));
    expect(parsers).toEqual(['services/referrals/application-answers.ts']);
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
