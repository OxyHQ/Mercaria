/**
 * #77's ten identity and correlation rules, one test each.
 *
 * The issue asks for each to be enforced structurally and pinned by its own
 * test. Where the enforcement is a CHECK it is pinned in
 * `db/analytics/__tests__/analytics.realdb.test.ts` (a mocked insert accepts a
 * statement the server refuses, so a CHECK has no mocked counterpart); where it
 * is a type, a projection or an absence, it is pinned here.
 *
 * Several assertions look odd because they assert something does NOT EXIST.
 * That is the point: the strongest form of "email is never a general analytics
 * user id" is that no function takes an email and no column holds one, and the
 * only way to test an absence is to enumerate what is present and check the
 * thing is not in it.
 */

import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns } from 'drizzle-orm';
import {
  ANALYTICS_ACTOR_KINDS,
  ANALYTICS_BUYER_ORIGINS,
  ANALYTICS_BUYER_ORIGIN_EVENT_TYPES,
  ANALYTICS_CLIENT_EMITTABLE_EVENT_TYPES,
  ANALYTICS_COMMERCE_CORRELATED_EVENT_TYPES,
  ANALYTICS_EVENT_TYPES,
  ANALYTICS_FINANCIAL_METRIC_SOURCES,
  ANALYTICS_METRICS,
} from '@mercaria/shared-types';
import { analyticsEvents, analyticsSearchQueries } from '../../../db/schema/analytics.js';
import {
  analyticsActorKind,
  hashHandle,
  isWellFormedSurfaceSessionId,
  resetPseudonymSaltCache,
} from '../identity.js';
import {
  buildAnalyticsEvent,
  eventClassFor,
  mayCarryBuyerOrigin,
  mayCarryCommerceCorrelation,
} from '../envelope.js';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Strip block and line comments before any census over source. These modules
 * state what they refuse to do in exactly the vocabulary the detectors match,
 * so a comment quoting a forbidden statement would count as one — most
 * dangerously in a comment written to CORRECT somebody.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * An UPDATE or DELETE of the analytics event table, in every spelling a module
 * in `db/analytics` can actually write it.
 *
 * Three idioms, because a detector that knows one of them is not a detector:
 * the drizzle BUILDER call on either handle (`db`/`tx`), the raw statement
 * naming the drizzle table object (`delete from ${analyticsEvents}` — how every
 * raw statement in this directory refers to a table), and the raw statement
 * naming the SQL identifier (`delete from analytics_events`).
 *
 * INSERT and SELECT are deliberately absent: an insert is the one write this
 * table exists for, and a read is what every module here legitimately does.
 */
const EVENTS_TABLE_WRITE =
  /\.(?:update|delete)\(\s*analyticsEvents\b|\b(?:update|delete\s+from)\s+(?:\$\{\s*)?analytics(?:Events|_events)\b/i;

vi.mock('../../../config/index.js', () => ({
  config: { analytics: { enabled: true, collectionMode: 'full', pseudonymRotationHours: 24 } },
}));

/** Every column name in the analytics event table, as SQL names. */
function eventColumnSqlNames(): readonly string[] {
  return Object.values(getTableColumns(analyticsEvents)).map((column) => column.name);
}

describe('#77 identity rule 1 — a pseudonymous session is not an Oxy user', () => {
  it('the two identity fields are separate and an actor kind maps one-to-one', () => {
    expect(analyticsActorKind({ kind: 'oxy', oxyUserId: 'u1' })).toBe('oxy');
    expect(analyticsActorKind({ kind: 'guest', guestSessionId: 'g1', transport: 'cookie' })).toBe(
      'guest',
    );
    expect(analyticsActorKind({ kind: 'anonymous' })).toBe('anonymous');
    // The union the actor kinds mirror. If `CommerceActor` ever grew a fourth
    // kind, this fails rather than silently mapping it to `anonymous`.
    expect([...ANALYTICS_ACTOR_KINDS].sort()).toEqual(['anonymous', 'guest', 'oxy']);
  });

  it('an envelope built from a pseudonymous identity carries NO oxy user id', () => {
    const row = buildAnalyticsEvent(
      {
        eventType: 'product_page_view',
        identity: {
          kind: 'pseudonymous',
          actorKind: 'guest',
          pseudonymousSessionId: 'abc',
          pseudonymEpoch: 1,
        },
        clientSurface: 'storefront_web',
        trafficClass: 'human',
        consentState: 'granted',
      },
      new Date(),
    );
    expect(row.oxyUserId).toBeNull();
    expect(row.pseudonymousSessionId).toBe('abc');
    expect(row.actorKind).toBe('guest');
  });

  it('an envelope built from an Oxy identity carries NO pseudonym', () => {
    const row = buildAnalyticsEvent(
      {
        eventType: 'product_page_view',
        identity: { kind: 'oxy', oxyUserId: 'oxy-1' },
        clientSurface: 'storefront_web',
        trafficClass: 'human',
        consentState: 'granted',
      },
      new Date(),
    );
    expect(row.oxyUserId).toBe('oxy-1');
    expect(row.pseudonymousSessionId).toBeNull();
    expect(row.pseudonymEpoch).toBeNull();
  });
});

describe('#77 identity rule 2 — a guest checkout is not a durable person profile', () => {
  it('the analytics domain never imports the guest checkout or session store', () => {
    // `guest_checkouts` is where contact lives (ADR 0003 D4). The pseudonym is
    // derived from a SESSION handle, which is itself purged on D11's clock — so
    // there is no durable person record here to build.
    const sources = [
      'services/analytics/identity.ts',
      'services/analytics/envelope.ts',
      'services/analytics/emit.ts',
      'services/analytics/sink.ts',
    ].map((relative) => readFileSync(join(SRC_ROOT, relative), 'utf8'));
    // IMPORTS, not prose: `identity.ts` names `guest_checkouts` in its docblock
    // precisely to say it never reads one, and a scanner that failed on the
    // sentence explaining the rule would be the definition of crying wolf.
    const GUEST_STORE_IMPORT =
      /from\s+'[^']*(?:db\/guests\/|schema\/guests|guest-session\.service|guest-checkout)[^']*'/;
    for (const source of sources) {
      expect(source.length).toBeGreaterThan(200);
      expect(GUEST_STORE_IMPORT.test(source)).toBe(false);
    }

    // The mutation self-test: a scanner whose regex rotted would pass the loop
    // above vacuously and fail here loudly.
    expect(
      GUEST_STORE_IMPORT.test(
        "import { findGuestCheckout } from '../../db/guests/guestCheckoutRepository.js';",
      ),
    ).toBe(true);
    expect(
      GUEST_STORE_IMPORT.test("import { config } from '../../config/index.js';"),
    ).toBe(false);
  });
});

describe('#77 identity rule 3 — contact, payment, network and device are never a user id', () => {
  it('no column in the event table could hold one', () => {
    const forbidden =
      /email|phone|contact|card|fingerprint|stripe|customer|wallet|\bip\b|ip_address|device|user_agent|useragent|token|address|note/i;
    const offenders = eventColumnSqlNames().filter((name) => forbidden.test(name));
    expect(offenders).toEqual([]);
    // The vacuity floor — a table read that returned nothing would pass above.
    expect(eventColumnSqlNames().length).toBeGreaterThan(30);
  });

  it('the detector actually detects — the mutation self-test', () => {
    const forbidden =
      /email|phone|contact|card|fingerprint|stripe|customer|wallet|\bip\b|ip_address|device|user_agent|useragent|token|address|note/i;
    expect(forbidden.test('buyer_email')).toBe(true);
    expect(forbidden.test('card_fingerprint')).toBe(true);
    expect(forbidden.test('ip_address')).toBe(true);
    expect(forbidden.test('stripe_customer_id')).toBe(true);
    expect(forbidden.test('pseudonymous_session_id')).toBe(false);
  });

  it('the surface session handle must be OPAQUE, so an address cannot be hashed as one', () => {
    expect(isWellFormedSurfaceSessionId('a'.repeat(32))).toBe(true);
    expect(isWellFormedSurfaceSessionId('nate@example.com')).toBe(false);
    expect(isWellFormedSurfaceSessionId('+34600123456')).toBe(false);
    expect(isWellFormedSurfaceSessionId('short')).toBe(false);
  });
});

describe('#77 identity rule 4 — separate guest checkouts cannot be joined by matching details', () => {
  it('the pseudonym depends ONLY on the salt and the session handle', () => {
    // Two different sessions produce two different pseudonyms whatever else is
    // true of them — there is no contact or payment input to collide on, so two
    // checkouts paid with one card are two unrelated pseudonyms.
    const salt = 'a'.repeat(64);
    expect(hashHandle(salt, 'session-a')).not.toBe(hashHandle(salt, 'session-b'));
    // And the SAME session under two epochs is unlinkable, which is what makes
    // "short-lived" true rather than aspirational.
    expect(hashHandle('a'.repeat(64), 'session-a')).not.toBe(
      hashHandle('b'.repeat(64), 'session-a'),
    );
  });

  it('the derivation is not reversible and not guessable without the salt', () => {
    const hash = hashHandle('a'.repeat(64), 'session-a');
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).not.toContain('session-a');
  });
});

describe('#77 identity rule 5 — a claim connects only its own checkout', () => {
  it('the event repository has NO update path for a stored event', () => {
    // "Cannot retroactively absorb unrelated guest activity" is the absence of
    // a statement, not a rule somebody follows. The migration also installs an
    // append-only trigger, so even a hand-written UPDATE is refused.
    const source = readFileSync(join(SRC_ROOT, 'db/analytics/eventRepository.ts'), 'utf8');
    expect(source.length).toBeGreaterThan(200);
    expect(/\.update\(/.test(source)).toBe(false);
    expect(/\.delete\(/.test(source)).toBe(false);
  });

  it('NO module in db/analytics writes the events table, in any spelling', () => {
    // The check above is the strongest form of the rule for the ONE file it
    // reads, and it is blind twice over. It matches the drizzle BUILDER call
    // only, so `db.execute(sql`delete from ${analyticsEvents}`)` walks through
    // it; and it reads a single hand-named path, so a new module beside it is
    // never scanned at all.
    //
    // DELETE is the half that matters. UPDATE is backstopped by the append-only
    // trigger the migration installs, so a hand-written UPDATE is refused by the
    // server whatever this gate says. DELETE is deliberately PERMITTED on
    // `analytics_events` — erasure on a schedule is the retention policy — so
    // for a stray delete there is no trigger behind this gate and nothing else
    // catches it.
    const directory = join(SRC_ROOT, 'db/analytics');
    const modules = readdirSync(directory).filter((name) => name.endsWith('.ts'));

    // Vacuity floor: an emptied or moved directory must fail here rather than
    // pass by having nothing to scan.
    expect(modules.length, 'db/analytics looks empty — did it move?').toBeGreaterThanOrEqual(5);

    let scanned = 0;
    for (const name of modules) {
      const source = withoutComments(readFileSync(join(directory, name), 'utf8'));
      expect(
        EVENTS_TABLE_WRITE.test(source),
        `db/analytics/${name} writes the analytics_events table; the event log is append-only ` +
          'and its only permitted removal is the retention sweep',
      ).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(modules.length);
  });

  it('the events-table detector actually detects — the mutation self-test', () => {
    // Written from the IDIOM: each probe is a line one of these repositories
    // could plausibly contain. A probe copied out of the pattern would only
    // confirm the pattern matches itself, which is how the single-spelling
    // version of this gate stayed green.
    expect(EVENTS_TABLE_WRITE.test('await db.delete(analyticsEvents).where(lt(a, b));')).toBe(true);
    expect(EVENTS_TABLE_WRITE.test('await tx.update(analyticsEvents).set({ market: null });')).toBe(
      true,
    );
    // The two raw spellings — the drizzle-interpolated table reference, which is
    // how every raw statement in this directory names a table, and the bare
    // SQL identifier.
    expect(
      EVENTS_TABLE_WRITE.test('await db.execute(sql`delete from ${analyticsEvents}`);'),
    ).toBe(true);
    expect(
      EVENTS_TABLE_WRITE.test(
        "await db.execute(sql`delete from analytics_events where occurred_at < ${cutoff}`);",
      ),
    ).toBe(true);
    expect(
      EVENTS_TABLE_WRITE.test('await db.execute(sql`update analytics_events set market = null`);'),
    ).toBe(true);

    // The negative half. A SELECT over the same table is what every read in
    // this directory does, and a detector that fired on one would be loosened
    // by whoever hit it next — which is how a gate stops meaning anything.
    expect(EVENTS_TABLE_WRITE.test('await db.select().from(analyticsEvents);')).toBe(false);
    expect(
      EVENTS_TABLE_WRITE.test('await db.execute(sql`select count(*) from ${analyticsEvents}`);'),
    ).toBe(false);
    // And the insert, which is the one write this table exists for.
    expect(EVENTS_TABLE_WRITE.test('await db.insert(analyticsEvents).values(rows);')).toBe(false);

    // The comment stripper is load-bearing: these modules document what they
    // refuse to do in the same vocabulary the detector matches.
    expect(EVENTS_TABLE_WRITE.test(withoutComments('// never delete from analytics_events'))).toBe(
      false,
    );
  });
});

describe('#77 identity rule 6 — a claim decline is a valid outcome, not an error', () => {
  it('decline has its own event type and its own reason code', () => {
    expect(ANALYTICS_EVENT_TYPES).toContain('guest_claim_declined');
    // And it is NOT `surface_error`, which is the operational class an error
    // would land in. A metric that counted declines as errors would make a
    // successful guest purchase look like a failure.
    expect(eventClassFor('guest_claim_declined')).toBe('commerce_funnel');
    expect(eventClassFor('surface_error')).toBe('operational');
  });
});

describe('#77 identity rule 7 — merchant analytics never expose a guest origin for a named user', () => {
  it('there is no `claimed` buyer origin to record one', () => {
    expect([...ANALYTICS_BUYER_ORIGINS].sort()).toEqual(['authenticated', 'guest']);
  });

  it('buyer origin is admitted on the funnel events only', () => {
    for (const type of ANALYTICS_BUYER_ORIGIN_EVENT_TYPES) {
      expect(mayCarryBuyerOrigin(type)).toBe(true);
    }
    // A discovery event carrying it would let a merchant-facing query report be
    // sliced by whether the searcher was a guest.
    expect(mayCarryBuyerOrigin('search_submitted')).toBe(false);
    expect(mayCarryBuyerOrigin('product_page_view')).toBe(false);
  });

  it('the envelope DROPS a buyer origin an event type may not carry', () => {
    const row = buildAnalyticsEvent(
      {
        eventType: 'search_submitted',
        identity: { kind: 'unidentified', actorKind: 'anonymous' },
        clientSurface: 'storefront_web',
        trafficClass: 'human',
        consentState: 'granted',
        buyerOrigin: 'guest',
      },
      new Date(),
    );
    expect(row.buyerOrigin).toBeNull();
  });
});

describe('#77 identity rule 8 — financial truth comes from payments, orders, refunds', () => {
  it('every money metric names a durable source', () => {
    const financial = new Set<string>(ANALYTICS_FINANCIAL_METRIC_SOURCES);
    const moneyMetrics = ANALYTICS_METRICS.filter((m) =>
      /gmv|revenue|commission|conversion|payment/.test(m.key),
    );
    // Vacuity floor: a filter matching nothing would pass the loop below.
    expect(moneyMetrics.length).toBeGreaterThanOrEqual(5);
    for (const metric of moneyMetrics) {
      expect(financial.has(metric.source), `${metric.key} is sourced from ${metric.source}`).toBe(
        true,
      );
    }
  });

  it('no event type asserts that money moved', () => {
    // There is deliberately no `order_paid`, `payment_succeeded` or
    // `purchase_completed` in the vocabulary. `guest_payment_verified` exists
    // and is SERVER-only (#107's seam) — see the client-emittable test below.
    const asserts = ANALYTICS_EVENT_TYPES.filter((t) =>
      /order_paid|payment_succeeded|purchase_completed|revenue|gmv/.test(t),
    );
    expect(asserts).toEqual([]);
  });

  it('a client cannot emit any event that asserts a payment', () => {
    // Acceptance 3, structurally: the ingest endpoint's allow-list contains no
    // payment, session, merge, eligibility or claim event.
    const emittable = new Set<string>(ANALYTICS_CLIENT_EMITTABLE_EVENT_TYPES);
    for (const forbidden of [
      'guest_payment_verified',
      'guest_session_issued',
      'guest_cart_merged',
      'guest_claim_completed',
      'guest_eligibility_accepted',
      'checkout_started',
      'native_add_to_cart',
    ]) {
      expect(emittable.has(forbidden), `${forbidden} must not be client-emittable`).toBe(false);
    }
    // Vacuity floor: the allow-list is not empty.
    expect(emittable.size).toBeGreaterThanOrEqual(10);
  });
});

describe('#77 identity rule 9 — portal and recovery use bounded ids, never bearer tokens', () => {
  it('the redaction pass destroys every Mercaria token prefix on sight', async () => {
    const { redactSearchQuery } = await import('../redact-query.js');
    for (const prefix of ['mgs_', 'mgp_', 'mgx_']) {
      const token = `${prefix}${'A'.repeat(30)}`;
      const result = redactSearchQuery(`why does ${token} not work`);
      expect(result.redactedText).not.toContain(token);
      expect(result.redactionKinds).toContain('secret_token');
    }
  });
});

describe('#77 identity rule 10 — internal, crawler and preview traffic classified separately', () => {
  it('every automated class is distinguishable from a human', async () => {
    const { classifyTraffic } = await import('../traffic-classification.js');
    expect(classifyTraffic({ userAgent: 'Mozilla/5.0 Chrome/120' })).toBe('human');
    expect(classifyTraffic({ userAgent: 'Googlebot/2.1' })).toBe('crawler');
    expect(classifyTraffic({ userAgent: 'facebookexternalhit/1.1' })).toBe('link_preview');
    expect(classifyTraffic({ userAgent: 'GoogleImageProxy' })).toBe('email_scanner');
    expect(classifyTraffic({ userAgent: 'curl/8.0' })).toBe('automated_client');
    // An unidentifiable client is `unknown`, NEVER `human`: defaulting it into
    // the cohort every quality metric is computed over is how a bot problem
    // becomes invisible.
    expect(classifyTraffic({})).toBe('unknown');
  });
});

describe('envelope field 5 — the RESTRICTED commerce correlation', () => {
  it('is admitted only on the documented commerce event types', () => {
    for (const type of ANALYTICS_COMMERCE_CORRELATED_EVENT_TYPES) {
      expect(mayCarryCommerceCorrelation(type)).toBe(true);
    }
    // Every discovery event BEFORE checkout begins — which is where "after
    // checkout begins" actually bites.
    for (const type of ['search_submitted', 'product_page_view', 'offer_impression'] as const) {
      expect(mayCarryCommerceCorrelation(type)).toBe(false);
    }
  });

  it('the envelope DROPS a correlation an event type may not carry', () => {
    const row = buildAnalyticsEvent(
      {
        eventType: 'product_page_view',
        identity: { kind: 'unidentified', actorKind: 'anonymous' },
        clientSurface: 'storefront_web',
        trafficClass: 'human',
        consentState: 'granted',
        checkoutGroupId: 'grp-1',
        orderId: 'ord-1',
      },
      new Date(),
    );
    expect(row.checkoutGroupId).toBeNull();
    expect(row.orderId).toBeNull();
  });
});

describe('the search-query table is structurally apart from identity', () => {
  it('has no actor column of any kind', () => {
    // Privacy rule 3 ("keep normalized query tokens separate from user
    // identity"): a nullable actor column with a rule about when to populate it
    // would be a rule; a table with no such column is a fact.
    const names = Object.values(getTableColumns(analyticsSearchQueries)).map((c) => c.name);
    const identityish = names.filter((name) =>
      /oxy|user|actor|pseudonym|session|guest|email|contact/.test(name),
    );
    // `query_event_id` is the ONLY id here and it names a search, not a person.
    expect(identityish).toEqual([]);
    expect(names.length).toBeGreaterThan(10);
  });
});

describe('the pseudonym salt cache resets cleanly', () => {
  it('exposes a reset so a test never reads another test’s epoch', () => {
    expect(() => {
      resetPseudonymSaltCache();
    }).not.toThrow();
  });
});
