/**
 * The walls around the affiliate outbound domain (#67).
 *
 * Six scanned prohibitions plus two structural ones, each with a VACUITY FLOOR
 * (so a scan that read nothing cannot pass) and a MUTATION SELF-TEST (so a
 * detector that matches nothing cannot pass either). The domain is enumerated
 * from the real directories rather than from a list of names, because a file
 * that moves out shrinks the scanned set silently and a shrinking scan looks
 * exactly like a clean one.
 *
 * The wall that matters most is #3. `/out/:token` exists to send a visitor to
 * somebody else's site, so a host comparison written with `endsWith` — under
 * which `example.com.evil.test` matches `example.com` — is the single change
 * that would turn this route into an open redirect while every functional test
 * stayed green.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import {
  AFFILIATE_CLICK_RECORDED_FACTS,
  AFFILIATE_FORBIDDEN_CLICK_FACTS,
  OUTBOUND_REDIRECT_REFUSAL_REASONS,
} from '@mercaria/shared-types';
import * as affiliateSchema from '../../../db/schema/affiliateOutbound.js';
import { OUTBOUND_REFUSAL_REASONS } from '../../offer-freshness/outbound-gate.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every file of the domain, enumerated from the real directories. */
function enumerateDomain(): string[] {
  const roots = [join(SRC_ROOT, 'services', 'outbound'), join(SRC_ROOT, 'db', 'affiliateOutbound')];
  const files: string[] = [];
  /**
   * RECURSIVE, and that is a correction rather than a flourish.
   *
   * The first version of this walk skipped directories, which silently left
   * `services/outbound/reconciliation/` — nine modules, the entire commission
   * half — outside every wall below. A scan that reads a subset reports exactly
   * what a clean domain reports, and the subset it happened to omit was the
   * half that talks to affiliate networks and writes to the ledger.
   *
   * `__tests__` is excluded deliberately: a test file names the things it
   * asserts are absent, so scanning it would flag this very file.
   */
  const walk = (root: string): void => {
    for (const entry of readdirSync(root)) {
      const full = join(root, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== '__tests__') walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      files.push(full);
    }
  };
  for (const root of roots) walk(root);
  files.push(join(SRC_ROOT, 'controllers', 'outbound.controller.ts'));
  files.push(join(SRC_ROOT, 'routes', 'outbound.ts'));
  files.push(join(SRC_ROOT, 'db', 'schema', 'affiliateOutbound.ts'));
  return files;
}

/**
 * See the docblock — raising this when the domain grows is the point.
 *
 * The domain enumerates 23 files today (20 under `services/outbound/` and
 * `db/affiliateOutbound/`, plus the controller, the route and the schema). A
 * floor of 8 was three times below that, which is enough slack for two thirds
 * of the domain to stop being scanned while every wall still reported clean —
 * and a wall that scans nothing passes. 20 keeps real headroom for a refactor
 * that merges a few modules without leaving room for a silent collapse.
 */
const MINIMUM_DOMAIN_FILES = 20;

/** Strip comments, so a module that DESCRIBES what it refuses is not read as doing it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const DOMAIN_FILES = enumerateDomain();

interface ScannedFile {
  readonly path: string;
  readonly code: string;
}

function readDomain(): readonly ScannedFile[] {
  return DOMAIN_FILES.map((path) => {
    const raw = readFileSync(path, 'utf8');
    // A vacuity floor per FILE: an empty or unreadable module would satisfy
    // every pattern below by having nothing in it.
    expect(raw.length).toBeGreaterThan(200);
    const code = stripComments(raw);
    expect(code.replace(/\s/g, '').length).toBeGreaterThan(100);
    return { path, code };
  });
}

/* -------------------------------------------------------------------------- */
/*  The detectors                                                              */
/* -------------------------------------------------------------------------- */

/**
 * WALL 1 — composing or mutating an affiliate link.
 *
 * #65's `EBAY_FORBIDDEN_LINK_OPERATIONS` and #66's "Mercaria never CONSTRUCTS a
 * tracking URL", enforced over the one domain that legitimately HOLDS a
 * destination. Attribution lives in the link's own parameters; a rebuilt link is
 * indistinguishable from a working one until a month of revenue is missing.
 *
 * ## The domain is PARTITIONED, and the reconciliation half EARNS its exemption
 *
 * `reconciliation/` legitimately builds URLs — they are Mercaria's own API
 * requests TO a network (`?startDate=…&timezone=UTC`), which is the opposite of
 * composing a shopper's destination. Exempting the directory outright would be
 * the weakening this gate exists to prevent, so instead it is held to a
 * DIFFERENT and stronger rule: no module under `reconciliation/` may reference a
 * destination AT ALL ({@link DESTINATION_REFERENCE}). Once that holds, a
 * `searchParams.set` there provably cannot touch one.
 *
 * So the exemption is earned by an assertion rather than granted by a path, and
 * the day somebody reads an offer's `destinationUrl` in the poll, the build
 * fails — which is exactly when it should.
 *
 * Each network parameter name must appear in a URL QUERY (`?clickref=`) or as
 * the first argument to a parameter SETTER (`set('campid', …)`). Never as a
 * bare or merely-quoted identifier.
 *
 * That precision was bought three times, each by the same class of false
 * positive — a detector matching a name being READ rather than a URL being
 * BUILT:
 *
 *  1. `networkClickRef`, the COLUMN recording what a network reported.
 *  2. `readonly networkClickRef: string | null`, its type.
 *  3. `record['clickRef']`, the field read out of Awin's own API response —
 *     which is the reconciliation half's entire subject.
 *
 * All three are the opposite of Mercaria composing a parameter, and a gate whose
 * cheapest green is to delete the code that reads a provider's answer is a gate
 * pushing toward the hazard. The narrowing makes the detector name the shape
 * that is actually dangerous; the self-tests below pin both directions.
 */
const LINK_COMPOSITION =
  /searchParams\.(set|append|delete)|\.replace\(\s*['"`]?\{destination\}|[?&](campid|mkcid|mkrid|toolid|customid|mkevt|clickref|awinaffid)=|(set|append)\(\s*['"`](campid|mkcid|mkrid|toolid|customid|mkevt|clickref|awinaffid)['"`]|buildAffiliateUrl|composeTrackedUrl/i;

/**
 * The composition shapes that are wrong ANYWHERE, reconciliation included.
 *
 * `LINK_COMPOSITION` minus the bare `searchParams` mutation, which is the only
 * member the reconciliation half legitimately uses.
 */
const UNCONDITIONAL_LINK_COMPOSITION =
  /\.replace\(\s*['"`]?\{destination\}|[?&](campid|mkcid|mkrid|toolid|customid|mkevt|clickref|awinaffid)=|(set|append)\(\s*['"`](campid|mkcid|mkrid|toolid|customid|mkevt|clickref|awinaffid)['"`]|buildAffiliateUrl|composeTrackedUrl/i;

/**
 * A DESTINATION, in any spelling. What the reconciliation half must not touch.
 *
 * `network_click_ref` is deliberately not here: it is what a network REPORTED,
 * which is the reconciliation half's whole subject.
 */
const DESTINATION_REFERENCE =
  /destinationUrl|destination_url|affiliateTrackingTemplate|affiliate_tracking_template|selectOutboundUrl|admitOutboundDestination/;

/**
 * WALL 2 — a destination derived from the REQUEST.
 *
 * The token has no destination member and the route reads no query and no body;
 * this is what keeps it that way for code nobody has written yet.
 */
const REQUEST_DERIVED_DESTINATION =
  /req\.(headers\.)?(host|hostname)\b|x-forwarded-host|req\.get\(\s*['"](host|origin|referer)|req\.(body|query)\b/i;

/**
 * WALL 3 — a host comparison that is not EXACT.
 *
 * `endsWith` admits `example.com.evil.test`; `includes` and `startsWith` are
 * worse.
 *
 * ## The RECEIVER is what makes it wrong, not the method
 *
 * The detector fires only when a HOST is the receiver of a substring test —
 * `host.endsWith(x)`, `hostname.includes(x)`. It deliberately does NOT fire on
 * `arrayOfHosts.includes(host)`, which is the opposite operation and the
 * CORRECT one: an exact membership test over a closed set, with the host as the
 * ARGUMENT. That is what `admitOutboundDestination` does twice.
 *
 * This was measured rather than assumed. The first version of this pattern also
 * flagged `.includes(host)` and went red on the two lines that implement the
 * rule it exists to enforce — a gate whose cheapest green is to weaken the
 * correct code. The narrowing makes it MORE precise: it now names the shape
 * that is actually dangerous, and the mutation self-test below pins both
 * directions so nobody can widen it back.
 *
 * `token.startsWith(AFFILIATE_OUTBOUND_TOKEN_PREFIX)` is also untouched — a
 * credential SHAPE gate on a Mercaria-minted string, not a host comparison.
 */
const LOOSE_HOST_MATCH =
  /\b\w*(host|hostname|Host|Hostname)\s*\.\s*(endsWith|includes|startsWith|indexOf|match|search)\s*\(/;

/**
 * WALL 4 — reaching a ranking module, in either direction.
 *
 * #74's wall. A measured outbound click is one join away from "offers that earn
 * commission rank higher", which is the thing the whole ranking domain is built
 * so nobody can do.
 */
const RANKING_REFERENCE =
  /services\/ranking\/|\.\.\/ranking\/|rankOffers|rankOfferComparison|OfferRankingFacts|ranking_policy_versions/;

/**
 * WALL 5 — a local freshness rule, TTL or staleness derivation.
 *
 * #68's per-source policy is the ONE authority. The tempting bug is local: this
 * domain knows an affiliate price moves hourly, so a private constant reads as
 * diligence rather than as a second authority — and a second TTL does not
 * announce itself, it silently wins wherever it is consulted. The domain's own
 * `clickRetentionDays` is a RETENTION deadline on Mercaria's own rows and is
 * not a content-freshness lifetime, which is why the detector names the shapes
 * a freshness rule takes rather than the word "days".
 */
const LOCAL_FRESHNESS_REFERENCE =
  /const\s+\w*(TTL|Ttl|StaleSeconds|FRESHNESS_SECONDS|OFFER_LIFETIME)\w*\s*=|function\s+isStale|assessOfferFreshness\s*\(|mayAppearInComparison\s*\(/;

/**
 * WALL 6 — the referral domain, except the ONE classifier seam.
 *
 * #143 owns traffic classification and this domain reuses it rather than
 * writing a second answer to "is this a person". Everything ELSE in the
 * referral domain — its tokens, its state carrier, its attribution, its
 * partners — is off limits: a referral is about how somebody ARRIVED at
 * Mercaria and an outbound click is about them leaving, and joining the two
 * would be building the cross-domain identity graph neither is allowed to have.
 *
 * The `services/ranking/facts.ts` precedent: a named single-module seam rather
 * than a blanket prohibition.
 */
const REFERRAL_REFERENCE = /referrals\//;

/**
 * The TWO named modules this domain may reach in the referral tree, and no
 * others.
 *
 * `traffic.js` is the classifier — a pure function over three self-declared
 * headers, reused rather than re-answered.
 *
 * `rewards/funding.js` is #144's PORT, and the edge points the other way: this
 * domain HANDS the referral domain a reader for reconciled commission
 * (`registerAffiliateCommissionReader`, which #144 shipped with no default so
 * that every deployment refuses until #67 lands). Registering it is the whole
 * of the seam; nothing here READS a referral row.
 *
 * Widened from one module to two when the funding registration landed, with the
 * reason recorded here rather than by deleting the wall — which is the shape
 * this check exists to force.
 */
const REFERRAL_SEAMS = [/referrals\/traffic\.js/, /referrals\/rewards\/funding\.js/];

/** WALL 7 — a FairCoin or OxyPay assumption, in code OR in copy. */
const FAIRCOIN_REFERENCE = /FairCoin|faircoin|OxyPay|oxy_pay|oxyPay|⊜/;

describe('outbound isolation (#67)', () => {
  const files = readDomain();

  it('enumerates the whole domain', () => {
    expect(files.length).toBeGreaterThanOrEqual(MINIMUM_DOMAIN_FILES);
  });

  const walls: readonly { name: string; pattern: RegExp }[] = [
    { name: 'composes or mutates an affiliate link', pattern: LINK_COMPOSITION },
    { name: 'derives a destination from the request', pattern: REQUEST_DERIVED_DESTINATION },
    { name: 'compares a host loosely', pattern: LOOSE_HOST_MATCH },
    { name: 'reaches a ranking module', pattern: RANKING_REFERENCE },
    { name: 'defines a local freshness rule', pattern: LOCAL_FRESHNESS_REFERENCE },
    { name: 'names FairCoin or OxyPay', pattern: FAIRCOIN_REFERENCE },
  ];

  const isReconciliation = (path: string) => path.includes('/reconciliation/');
  const redirectHalf = files.filter((f) => !isReconciliation(f.path));
  const reconciliationHalf = files.filter((f) => isReconciliation(f.path));

  it('both halves of the domain are non-empty', () => {
    // A mis-partition would make one of the two walls below vacuous while the
    // other still passed, which reads exactly like a clean domain.
    expect(redirectHalf.length).toBeGreaterThanOrEqual(6);
    expect(reconciliationHalf.length).toBeGreaterThanOrEqual(5);
    expect(redirectHalf.length + reconciliationHalf.length).toBe(files.length);
  });

  for (const wall of walls) {
    it(`no module ${wall.name}`, () => {
      // The link-composition wall applies IN FULL to the redirect half only;
      // the reconciliation half answers to the pair below. Every other wall
      // applies to the whole domain.
      const subject =
        wall.pattern === LINK_COMPOSITION ? redirectHalf : files;
      let scanned = 0;
      for (const file of subject) {
        scanned += 1;
        expect({ path: file.path, hit: wall.pattern.test(file.code) }).toEqual({
          path: file.path,
          hit: false,
        });
      }
      // The scan's own vacuity floor: zero offenders out of zero files is what
      // a broken enumeration reports.
      expect(scanned).toBe(subject.length);
      expect(scanned).toBeGreaterThan(0);
    });
  }

  it('the reconciliation half touches no destination, which is what earns its exemption', () => {
    let scanned = 0;
    for (const file of reconciliationHalf) {
      scanned += 1;
      expect({
        path: file.path,
        destination: DESTINATION_REFERENCE.test(file.code),
        composition: UNCONDITIONAL_LINK_COMPOSITION.test(file.code),
      }).toEqual({ path: file.path, destination: false, composition: false });
    }
    expect(scanned).toBe(reconciliationHalf.length);
    expect(scanned).toBeGreaterThan(0);
    // Both detectors must fire on what they look for.
    expect(DESTINATION_REFERENCE.test('const url = offer.destinationUrl;')).toBe(true);
    expect(DESTINATION_REFERENCE.test('row.affiliate_tracking_template')).toBe(true);
    expect(UNCONDITIONAL_LINK_COMPOSITION.test('const u = `${d}?clickref=${id}`;')).toBe(true);
    expect(UNCONDITIONAL_LINK_COMPOSITION.test("params.set('clickref', clickId)")).toBe(true);
    expect(UNCONDITIONAL_LINK_COMPOSITION.test("readRef(record['clickRef'])")).toBe(false);
    // ...and the API request the poll legitimately builds is NOT flagged.
    expect(UNCONDITIONAL_LINK_COMPOSITION.test("url.searchParams.set('startDate', d)")).toBe(
      false,
    );
    expect(DESTINATION_REFERENCE.test('networkClickRef: row.clickRef ?? null,')).toBe(false);
  });

  it('reaches the referral domain only through the traffic classifier', () => {
    let scanned = 0;
    for (const file of files) {
      scanned += 1;
      for (const line of file.code.split('\n')) {
        if (!REFERRAL_REFERENCE.test(line)) continue;
        // ONE assertion carrying the path and the line, so a failure NAMES the
        // offender. The first draft asserted an object against itself before
        // this check — which can never fail, so the message named no file and
        // the real assertion below reported a bare `expected false to be true`.
        expect({
          path: file.path,
          line: line.trim(),
          permitted: REFERRAL_SEAMS.some((seam) => seam.test(line)),
        }).toEqual({ path: file.path, line: line.trim(), permitted: true });
      }
    }
    expect(scanned).toBe(files.length);
  });

  /* ------------------------------------------------------------------ */
  /*  The mutation self-tests                                            */
  /* ------------------------------------------------------------------ */

  it('every detector fires on the thing it is looking for', () => {
    // Each probe is a line a future edit might plausibly write. A detector that
    // matched nothing would report the same clean pass as a clean domain.
    expect(LINK_COMPOSITION.test("url.searchParams.set('campid', id)")).toBe(true);
    expect(LINK_COMPOSITION.test('const u = `${base}?clickref=${clickId}`;')).toBe(true);
    expect(LINK_COMPOSITION.test("append('awinaffid', publisherRef)")).toBe(true);
    expect(LINK_COMPOSITION.test("params.set('clickref', clickId)")).toBe(true);
    // ...and READING a provider's own field of that name is not composing one.
    expect(LINK_COMPOSITION.test("readRef(record['clickRef'])")).toBe(false);
    // The NEGATIVE control: the column that records what a NETWORK reported is
    // not Mercaria composing a parameter.
    expect(LINK_COMPOSITION.test('networkClickRef: text(),')).toBe(false);
    expect(LINK_COMPOSITION.test('readonly networkClickRef: string | null;')).toBe(false);
    expect(LINK_COMPOSITION.test('template.replace(`{destination}`, target)')).toBe(true);
    expect(LINK_COMPOSITION.test('const tracked = buildAffiliateUrl(offer);')).toBe(true);
    expect(REQUEST_DERIVED_DESTINATION.test('const to = req.query.url;')).toBe(true);
    expect(REQUEST_DERIVED_DESTINATION.test("const h = req.get('host');")).toBe(true);
    expect(LOOSE_HOST_MATCH.test("if (host.endsWith('.awin1.com')) return true;")).toBe(true);
    expect(LOOSE_HOST_MATCH.test('if (hostname.includes(approved)) return true;')).toBe(true);
    expect(LOOSE_HOST_MATCH.test('if (parsed.hostname.startsWith(prefix)) return true;')).toBe(
      true,
    );
    // The NEGATIVE control, and the reason the pattern is receiver-scoped: an
    // exact membership test over a closed set is the CORRECT shape and must not
    // be flagged, or the cheapest way to green this gate is to break the rule.
    expect(LOOSE_HOST_MATCH.test('if (approvedHosts.includes(host)) return true;')).toBe(false);
    expect(LOOSE_HOST_MATCH.test('if (redirectors.includes(host)) return true;')).toBe(false);
    expect(RANKING_REFERENCE.test("import { rankOffers } from '../ranking/rank.js';")).toBe(true);
    expect(LOCAL_FRESHNESS_REFERENCE.test('const OUTBOUND_TTL_SECONDS = 3600;')).toBe(true);
    expect(FAIRCOIN_REFERENCE.test('// settles in FairCoin')).toBe(true);
    expect(REFERRAL_REFERENCE.test("import { attribute } from '../referrals/attribution.service.js';")).toBe(
      true,
    );
    // ...and the seam allowance really does distinguish the one permitted import.
    const permitted = (line: string) => REFERRAL_SEAMS.some((seam) => seam.test(line));
    expect(permitted("import { classifyReferralTraffic } from '../referrals/traffic.js';")).toBe(
      true,
    );
    expect(
      permitted("import { registerAffiliateCommissionReader } from '../referrals/rewards/funding.js';"),
    ).toBe(true);
    // ...and everything else in the referral tree is still refused.
    expect(permitted("import { attribute } from '../referrals/attribution.service.js';")).toBe(
      false,
    );
    expect(permitted("import { bindTouch } from '../referrals/binding.service.js';")).toBe(false);
    // The prefix check the host detector must NOT flag — the one legitimate
    // `startsWith` in the domain.
    expect(LOOSE_HOST_MATCH.test('token.startsWith(AFFILIATE_OUTBOUND_TOKEN_PREFIX)')).toBe(false);
  });

  /* ------------------------------------------------------------------ */
  /*  The structural walls                                               */
  /* ------------------------------------------------------------------ */

  it('records no identifying fact, in the vocabulary or in the real tables', () => {
    // (a) The two tuples are DISJOINT — the `RETAIL_FORBIDDEN_COMPONENT_KINDS`
    //     device. A widening that collided would fail here rather than pass.
    const recorded = new Set<string>(AFFILIATE_CLICK_RECORDED_FACTS);
    for (const forbidden of AFFILIATE_FORBIDDEN_CLICK_FACTS) {
      expect(recorded.has(forbidden)).toBe(false);
    }
    expect(AFFILIATE_FORBIDDEN_CLICK_FACTS.length).toBeGreaterThanOrEqual(10);

    // (b) A WALK of the real drizzle tables, because a value list can go stale
    //     while a column is added. Every column of every table in the domain is
    //     checked against the forbidden names.
    const tables = Object.values(affiliateSchema).flatMap((value) =>
      is(value, PgTable) ? [value] : [],
    );
    expect(tables.length).toBe(6);
    let columnsSeen = 0;
    for (const table of tables) {
      for (const column of Object.values(getTableColumns(table))) {
        columnsSeen += 1;
        const name = column.name.toLowerCase();
        for (const forbidden of AFFILIATE_FORBIDDEN_CLICK_FACTS) {
          expect({ table: getTableName(table), column: name, forbidden, hit: name === forbidden })
            .toEqual({ table: getTableName(table), column: name, forbidden, hit: false });
        }
      }
    }
    // A column floor: walking zero columns reports the same clean pass.
    expect(columnsSeen).toBeGreaterThan(60);
  });

  it('carries no actor column of any kind', () => {
    // Stronger than the forbidden-facts list and stated separately, because the
    // omission is the whole privacy design: nothing this domain reports needs to
    // know WHO clicked, so no per-person handle exists on any of the six tables.
    // The two operator stamps on the allow-list are the deliberate exception —
    // approving a destination is a decision that must be attributable.
    const actorish = /oxy_user_id|guest_session_id|pseudonymous|actor_|buyer_|customer_id/;
    const tables = Object.values(affiliateSchema).flatMap((value) =>
      is(value, PgTable) ? [value] : [],
    );
    const allowed = new Set(['approved_by_oxy_user_id', 'revoked_by_oxy_user_id']);
    let checked = 0;
    for (const table of tables) {
      for (const column of Object.values(getTableColumns(table))) {
        const name = column.name.toLowerCase();
        if (allowed.has(name)) continue;
        checked += 1;
        expect({ table: getTableName(table), column: name, hit: actorish.test(name) }).toEqual({
          table: getTableName(table),
          column: name,
          hit: false,
        });
      }
    }
    expect(checked).toBeGreaterThan(60);
    // The detector must fire on what it is looking for.
    expect(actorish.test('oxy_user_id')).toBe(true);
    expect(actorish.test('guest_session_id')).toBe(true);
  });

  it('the refusal tuple is a SUPERSET of the gate #68 owns', () => {
    // A reason added to #68's gate and not here would be written into a column
    // whose CHECK refuses it — at runtime, on the refusing path, which is the
    // path nobody exercises by hand.
    const mine = new Set<string>(OUTBOUND_REDIRECT_REFUSAL_REASONS);
    for (const reason of OUTBOUND_REFUSAL_REASONS) {
      expect({ reason, covered: mine.has(reason) }).toEqual({ reason, covered: true });
    }
    expect(OUTBOUND_REFUSAL_REASONS.length).toBeGreaterThanOrEqual(5);
    expect(OUTBOUND_REDIRECT_REFUSAL_REASONS.length).toBeGreaterThan(
      OUTBOUND_REFUSAL_REASONS.length,
    );
  });
});
