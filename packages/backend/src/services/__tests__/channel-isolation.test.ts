/**
 * The walls around the channel domain (#87), asserted by SCAN and by a walk of
 * the real drizzle tables.
 *
 * The argument, the vacuity floor and the mutation self-test are
 * `retail-logistics-isolation.test.ts`'s and `fee-ranking-isolation.test.ts`'s,
 * reused rather than reinvented — a second scanner shape would be a second
 * thing to keep correct.
 *
 * Four walls, and why each is a scan rather than a branch:
 *
 *  1. **A connected catalogue can never become a brand claim** (#87 reconcile
 *     8). This is the wall that matters most, because the shortcut is
 *     genuinely tempting: a merchant has just proved they operate
 *     `nike.example`, and writing an `official store` relationship from that
 *     looks like joining two facts Mercaria already holds. It is not — #55's
 *     `SUFFICIENT_EVIDENCE_KINDS` deliberately excludes `domain_control` for
 *     exactly the badge-producing kinds, so deriving one here would route
 *     around a decision somebody made on purpose. #83 carries the identical
 *     gate for claiming, and this is its sibling for connecting.
 *
 *  2. **An onboarding session can never hold a credential.** A scan for the
 *     credential vocabulary across the domain AND a walk of the session table's
 *     real columns, because those catch different mistakes: the scan catches a
 *     service reading a consumer secret into a session patch, and the walk
 *     catches a column somebody added with a name the scan never anticipated.
 *
 *  3. **This domain decides no matches.** #58 owns identity. A matcher call
 *     here would be a second opinion about which product is which, and the two
 *     disagree in the direction that produces a false merge.
 *
 *  4. **A channel is not a ranking input.** The fee-domain precedent, applied
 *     to a channel: "products from a connected Shopify shop rank above crawled
 *     ones" is one join away, and it is the shape organic rank stops being
 *     organic.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName } from 'drizzle-orm';
import {
  CHANNEL_AUDIT_ACTIONS,
  CHANNEL_LIMITATION_CODES,
  CHANNEL_ONBOARDING_STEPS,
  CHANNEL_TYPE_IDS,
} from '@mercaria/shared-types';
import { channelAuditEvents, channelOnboardingSessions } from '../../db/schema/index.js';

import { walkOwnedDirectory } from '../../__tests__/domain-population.js';
import { assertEachOf } from '../../__tests__/assert-each-of.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Every module in the domain, DISCOVERED rather than listed.
 *
 * A hard-coded list protects the files somebody remembered, and the file that
 * breaks a wall is by definition the one nobody was thinking about.
 *
 * RECURSES (#460). It was a one-level `readdirSync`, and `services/channels/`
 * is flat today so this admits no module now — it stops a
 * `services/channels/onboarding/` being invisible to four walls on the day
 * somebody adds one.
 *
 * ## Why this population is NOT widened to every channel-named module
 *
 * #460's whole-tree assertion is deliberately NOT applied here, and the reason
 * is measured rather than argued. The tree holds 28 channel-named modules; this
 * population is 9. Probing the other 19 against these four detectors:
 * **five trip `CREDENTIAL_REFERENCE`** — `services/channel-key.service.ts`,
 * `middleware/channels-schemas.ts`, `routes/channels-webhooks.ts` and two admin
 * controllers — because handling a channel credential is precisely what they
 * exist to do.
 *
 * So "channel" names a FEATURE spanning six surfaces (the channels service
 * layer, ingest, keys, OAuth, webhooks, and the admin console) while these four
 * walls are about the service layer alone. Forcing every channel-named module
 * into the population or into an exclusion list would produce a nineteen-entry
 * list that mostly reads "handles credentials, which one of these walls forbids
 * and this module exists to do" — the list doing the narrowing the population
 * already expresses, and a false wall for anybody who removed an entry.
 *
 * The gate that SHOULD cover the credential surface is a different gate about
 * different walls, and it does not exist yet. That is a real gap and it is
 * recorded here rather than papered over with an exclusion list.
 */
function domainModules(): string[] {
  return [
    ...walkOwnedDirectory('services/channels').map((relative) => join(SRC_ROOT, relative)),
    // The domain's own tables. Measured clean against all four detectors, so
    // this is a widening rather than a false wall.
    join(SRC_ROOT, 'db', 'schema', 'channels.ts'),
  ];
}

/** The domain plus the files outside it that belong to the same walls. */
function scannedPaths(): string[] {
  return [
    ...domainModules(),
    join(SRC_ROOT, 'db', 'channels', 'channelOnboardingRepository.ts'),
    join(SRC_ROOT, 'db', 'channels', 'channelAuditRepository.ts'),
    join(SRC_ROOT, 'db', 'schema', 'channels.ts'),
    join(SRC_ROOT, 'controllers', 'admin', 'channels-catalog.controller.ts'),
  ];
}

/** Source with comments removed — what every REACHABILITY detector scans. */
function readCode(path: string): string {
  const source = readFileSync(path, 'utf8');
  expect(source.length, `${path} looks empty — did it move?`).toBeGreaterThan(200);
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  expect(
    stripped.replace(/\s+/g, '').length,
    `${path} has almost no code left after comment stripping — check the stripper`,
  ).toBeGreaterThan(150);
  return stripped;
}

/**
 * #55's relationship layer, by import or by identifier.
 *
 * The realistic violation is not a whole relationship service — it is one
 * `insertRelationship` call in the activation path, added because the merchant
 * had just proved a domain.
 */
const RELATIONSHIP_REFERENCE =
  /commerce-graph\/relationship|db\/schema\/relationships|\bcommerceRelationships\b|\brelationshipRepository\b|\bofficial_store\b|\bauthorized_reseller\b|insertRelationship|SUFFICIENT_EVIDENCE_KINDS/;

/**
 * A credential, in any spelling that could reach an onboarding session.
 *
 * `consumerSecret`/`consumerKey` are WooCommerce's pair, `accessToken` is
 * Shopify's, `mck_` is a channel key's prefix, and the envelope columns are
 * what a service reaching for a stored credential would name. `decryptSecret`
 * and `encryptSecret` are the two functions that would have to be called.
 */
const CREDENTIAL_REFERENCE =
  /consumerSecret|consumerKey|accessToken|\bmck_|credentialsCiphertext|webhookSecretCiphertext|findConnectionCredentials|findConnectionWebhookSecret|decryptSecret|encryptSecret|generateKey\b/;

/** #58's matcher — this domain reads its output and never calls it. */
const MATCHER_REFERENCE =
  /services\/matching\/|\brunMatch\b|\bevaluateMatch\b|matchSubject|requestCanonicalMatching|insertMatchDecision/;

/** #74's ranking — a channel must not weigh a result. */
const RANKING_REFERENCE =
  /services\/ranking\/|\.\.\/ranking\/|\brankOffers\b|\brankOfferComparison\b|rankingPolicyVersion|OFFER_RANKING_SIGNALS/;

describe('#87 — the walls around the channel domain', () => {
  it('scans every module in the domain, and there are some', () => {
    // The vacuity floor. `expect([]).toEqual([])` on a broken traversal is
    // exactly what a passing scan looks like, so the count is asserted first
    // and a new module raises it deliberately.
    const paths = scannedPaths();
    expect(paths.length).toBeGreaterThanOrEqual(9);
    expect(domainModules().some((path) => path.endsWith('channel-catalog.ts'))).toBe(true);
    expect(domainModules().some((path) => path.endsWith('channel-binding.ts'))).toBe(true);
  });

  it('never reaches the brand or relationship layer (#87 reconcile 8)', () => {
    for (const path of scannedPaths()) {
      expect(
        RELATIONSHIP_REFERENCE.test(readCode(path)),
        `${path} reaches the relationship layer — a connected catalogue is not evidence of a brand claim`,
      ).toBe(false);
    }
  });

  it('never handles a credential', () => {
    for (const path of scannedPaths()) {
      expect(
        CREDENTIAL_REFERENCE.test(readCode(path)),
        `${path} touches a credential — the provider flows own those, not the wizard`,
      ).toBe(false);
    }
  });

  it('decides no matches (#58 owns identity)', () => {
    for (const path of scannedPaths()) {
      expect(MATCHER_REFERENCE.test(readCode(path)), `${path} calls the matcher`).toBe(false);
    }
  });

  it('is not a ranking input (#74)', () => {
    for (const path of scannedPaths()) {
      expect(RANKING_REFERENCE.test(readCode(path)), `${path} reaches ranking`).toBe(false);
    }
  });

  it('mutation self-test: every detector fires on source that breaks its wall', () => {
    // Without this the four assertions above would pass identically against a
    // regex that matches nothing. Each probe is written in the shape the real
    // violation would take, and each is paired with a NEAR MISS that must NOT
    // fire — a detector that matches everything is as useless as one that
    // matches nothing, and it gets disabled by whoever hits it next.
    expect(
      RELATIONSHIP_REFERENCE.test(
        "import { insertRelationship } from '../commerce-graph/relationshipRepository.js';",
      ),
    ).toBe(true);
    expect(RELATIONSHIP_REFERENCE.test("const kind = 'official_store';")).toBe(true);
    expect(RELATIONSHIP_REFERENCE.test('const merchantId = binding.merchantId;')).toBe(false);

    expect(CREDENTIAL_REFERENCE.test('const { consumerSecret } = req.body;')).toBe(true);
    expect(CREDENTIAL_REFERENCE.test('await findConnectionCredentials(connection.id);')).toBe(true);
    expect(CREDENTIAL_REFERENCE.test('const connection = await findConnection(a, b);')).toBe(false);

    expect(MATCHER_REFERENCE.test("import { runMatch } from '../matching/match.service.js';")).toBe(
      true,
    );
    expect(MATCHER_REFERENCE.test('const pending = matchDecisions.reviewState;')).toBe(false);

    expect(RANKING_REFERENCE.test("import { rankOffers } from '../ranking/rank.js';")).toBe(true);
    expect(RANKING_REFERENCE.test('const overlaps = reconcileMerchantOfferOverlaps(all);')).toBe(
      false,
    );
  });
});

describe('#87 — no credential COLUMN on an onboarding session', () => {
  /**
   * A column that could hold a secret.
   *
   * Walked over the real table rather than grepped, because a column is the
   * durable half of the same mistake and the walk cannot be fooled by a name
   * the scan never anticipated. `key` alone is deliberately NOT in the pattern —
   * the word appears in legitimate names — so what is banned is anything that
   * would BE a credential: a secret, a token, a password, a ciphertext, an API
   * key, a consumer pair.
   *
   * `getTableColumns` reports the drizzle PROPERTY name (`consumerSecret`), not
   * the SQL name — `@oxyhq/db`'s `DATABASE_CASING` converts at statement time —
   * so the pattern is case-insensitive and matches both spellings of every
   * separator, or `api_key` would miss `apiKey`.
   */
  const FORBIDDEN_COLUMN =
    /secret|token|password|credential|ciphertext|api_?key|consumer_?(key|secret)|access_?key|private_?key|auth_?(token|secret|header)/i;

  const tables = [channelOnboardingSessions, channelAuditEvents];

  it('walks the real tables, and there are columns to walk', () => {
    const names = tables.flatMap((table) =>
      Object.values(getTableColumns(table)).map(
        (column) => `${getTableName(table)}.${column.name}`,
      ),
    );
    // The vacuity floor for the walk: a `getTableColumns` returning nothing
    // produces the same green as a clean schema.
    expect(names.length).toBeGreaterThanOrEqual(28);
    expect(names).toContain('channel_onboarding_sessions.channelType');

    const offenders = names.filter((name) => FORBIDDEN_COLUMN.test(name));
    expect(offenders, 'a channel table grew a credential-shaped column').toEqual([]);
  });

  it('mutation self-test: the column detector fires on a column that would hold one', () => {
    // Both spellings, because the walk sees the property name and a migration
    // reviewer sees the SQL one.
    expect(FORBIDDEN_COLUMN.test('channel_onboarding_sessions.consumerSecret')).toBe(true);
    expect(FORBIDDEN_COLUMN.test('channel_onboarding_sessions.consumer_secret')).toBe(true);
    expect(FORBIDDEN_COLUMN.test('channel_onboarding_sessions.accessToken')).toBe(true);
    expect(FORBIDDEN_COLUMN.test('channel_onboarding_sessions.apiKey')).toBe(true);
    expect(FORBIDDEN_COLUMN.test('channel_onboarding_sessions.credentialsCiphertext')).toBe(true);
    // The near misses that must NOT fire, or the gate cries wolf and gets
    // disabled: every one of these is a real column on one of the two tables.
    expect(FORBIDDEN_COLUMN.test('channel_onboarding_sessions.channelType')).toBe(false);
    expect(FORBIDDEN_COLUMN.test('channel_audit_events.actorOxyUserId')).toBe(false);
    expect(FORBIDDEN_COLUMN.test('channel_audit_events.changedFields')).toBe(false);
    expect(FORBIDDEN_COLUMN.test('channel_onboarding_sessions.feedConfigurationId')).toBe(false);
  });
});

describe('#87 — the vocabularies the schema is rendered from', () => {
  it('every CHECK tuple is non-empty and unique', () => {
    // A tuple that lost a member silently narrows a CHECK on the next
    // regeneration, which is the failure mode `db:generate` reading a stale
    // `dist/` produces. Asserting the sets are non-empty and duplicate-free is
    // the cheap half of catching it.
    assertEachOf([
      CHANNEL_TYPE_IDS,
      CHANNEL_ONBOARDING_STEPS,
      CHANNEL_AUDIT_ACTIONS,
      CHANNEL_LIMITATION_CODES,
    ], 4, (tuple) => {
      expect(tuple.length).toBeGreaterThan(0);
      expect(new Set(tuple).size).toBe(tuple.length);
    });
  });

  it('the audit vocabulary carries no value-bearing action', () => {
    // Every action names an ACT. None of them names a payload, a body or a
    // value, because an action like `credentials_recorded` is how somebody
    // justifies a `details` column next.
    for (const action of CHANNEL_AUDIT_ACTIONS) {
      expect(action).not.toMatch(/payload|body|value|secret|token/);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────── */
/* #454: the detector must match the IDIOM, not one spelling of it            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * These detectors named each forbidden domain by its `services/<domain>/` path
 * only, which is not the specifier a module inside this domain writes: a
 * sibling directory is one `../` away, so the real import is `'../<domain>/…'`
 * and it passed the wall untouched. MEASURED on `origin/main` by executing each
 * pattern against that spelling.
 *
 * One relative alternative per domain covers EVERY depth, because however many
 * `../` segments precede it the last always abuts the directory name.
 *
 * The probes below are written from the IDIOM rather than from the regex — a
 * self-test derived from the pattern can only confirm the pattern matches
 * itself. The imported SYMBOL is deliberately neutral in each: the sibling
 * probe in `freshness-isolation.test.ts` imported `rankOffers`, which its
 * pattern matches by function NAME, so it passed without ever exercising the
 * path alternative it appeared to cover.
 */
describe('#454: a relative import cannot walk around these detectors', () => {
  it('RANKING_REFERENCE sees a sibling-relative import', () => {
    expect(
      RANKING_REFERENCE.test("import { helper } from '../ranking/thing.service.js';"),
      "a module here reaches ranking as '../ranking/…' and that must not pass",
    ).toBe(true);
    expect(RANKING_REFERENCE.test("import { helper } from '../../services/ranking/thing.service.js';")).toBe(true);
    // The negative half, or the widening would fire on ordinary imports.
    expect(RANKING_REFERENCE.test("import { helper } from '../ranking-display/format.js';")).toBe(false);
    expect(RANKING_REFERENCE.test("import { getDb } from '../../db/postgres.js';")).toBe(false);
  });

});
