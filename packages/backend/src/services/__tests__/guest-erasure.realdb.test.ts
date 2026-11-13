/**
 * A data subject's erasure, and the abuse counter, against a REAL Postgres
 * server — the M8 review's M8-01 and M8-03.
 *
 * M8-01 was a receipt that claimed a row per class while the request changed
 * nothing. The property pinned here is therefore not "the receipt has the right
 * shape" — the old code had that — but that every number on the receipt is
 * what the database shows afterwards: the contact columns are NULL, the
 * credentials are revoked, the session and its cart are gone, and a second
 * request reports zero because there is nothing left to erase. None of that
 * has a mocked counterpart; the anonymization CHECK and the D4 trigger are
 * exactly what a mock would wave through.
 *
 * M8-03 was a counter that was never written while friction was off. The
 * property here is the row in `guest_abuse_counters`.
 *
 * ## Scoping, because this database is SHARED
 *
 * Every fixture is created here, tracked, and deleted in `afterAll`; no
 * assertion counts a whole table.
 *
 * ## Env before any import of the code under test
 *
 * `config/index.ts` reads the environment once at module load, so the keys are
 * set in `beforeAll` and everything is imported dynamically afterwards.
 * `GUEST_ABUSE_CONTROLS_ENABLED` is deliberately NOT set: the counting case is
 * the friction-off one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';

let db: import('../../db/postgres.js').Database;
let closePostgres: typeof import('../../db/postgres.js').closePostgres;
let guests: typeof import('../../db/schema/guests.js');
let buyers: typeof import('../../db/schema/buyers.js');
let portal: typeof import('../../db/schema/guestPortal.js');
let governance: typeof import('../../db/schema/guestGovernance.js');
let sessionRepo: typeof import('../../db/guests/guestSessionRepository.js');
let grantRepo: typeof import('../../db/guestPortal/grantRepository.js');
let retentionRepo: typeof import('../../db/guestGovernance/retentionRepository.js');
let tokens: typeof import('../guest-portal/grant-token.js');
let dataRequests: typeof import('../guest-governance/data-request.service.js');
let abuse: typeof import('../guest-governance/abuse.service.js');
let subject: typeof import('../guest-governance/subject.js');

const MARKER = randomUUID().slice(0, 8);
const DAY_MS = 24 * 60 * 60 * 1_000;

const checkoutIds: string[] = [];
const sessionIds: string[] = [];
const groupIds: string[] = [];

/** A guest who put something in a cart and reached checkout, with two credentials. */
async function placeGuestCheckout(): Promise<{
  checkoutGroupId: string;
  guestCheckoutId: string;
  guestSessionId: string;
  cartId: string;
  grantIds: string[];
}> {
  const session = await sessionRepo.insertGuestSession(db, {
    tokenHash: `erasure-${MARKER}-${randomUUID()}`,
    clientClass: 'other',
    expiresAt: new Date(Date.now() + 90 * DAY_MS),
    lastSeenAt: new Date(),
  });
  sessionIds.push(session.id);
  const [cart] = await db
    .insert(buyers.carts)
    .values({ guestSessionId: session.id })
    .returning({ id: buyers.carts.id });
  if (!cart) throw new Error('fixture cart insert returned no row');

  const checkoutGroupId = `grp-erasure-${MARKER}-${randomUUID().slice(0, 8)}`;
  groupIds.push(checkoutGroupId);
  const [checkout] = await db
    .insert(guests.guestCheckouts)
    .values({
      checkoutGroupId,
      guestSessionId: session.id,
      emailCiphertext: 'v1:aaa:bbb:ccc',
      emailHash: `hash-${MARKER}-${randomUUID()}`,
      emailRedacted: 'j***@example.com',
      phoneCiphertext: 'v1:ddd:eee:fff',
      phoneRedacted: '***42',
      marketingOptIn: false,
    })
    .returning({ id: guests.guestCheckouts.id });
  if (!checkout) throw new Error('fixture guest_checkouts insert returned no row');
  checkoutIds.push(checkout.id);

  const grantIds: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const expiresAt = new Date(Date.now() + DAY_MS);
    const grant = await grantRepo.insertGuestOrderAccessGrant(db, {
      checkoutGroupId,
      guestCheckoutId: checkout.id,
      tokenHash: tokens.hashPortalToken(tokens.mintPortalToken().token),
      purpose: 'portal',
      createdVia: 'magic_link',
      scopes: ['orders:read'],
      emailVerifiedAt: new Date(),
      expiresAt,
      purgeAt: new Date(expiresAt.getTime() + DAY_MS),
    });
    grantIds.push(grant.id);
  }
  return {
    checkoutGroupId,
    guestCheckoutId: checkout.id,
    guestSessionId: session.id,
    cartId: cart.id,
    grantIds,
  };
}

/** The receipt's answer for one class. */
function outcomeFor(
  receipt: import('@mercaria/shared-types').GuestDataRequestReceipt,
  dataClass: string,
): { disposition: string; retainedReason?: string } | undefined {
  return receipt.outcomes.find((entry) => entry.dataClass === dataClass);
}

/** The STORED disposition rows for one request, keyed by class. */
async function storedCounts(requestId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({
      dataClass: governance.guestDataClassDispositions.dataClass,
      affected: governance.guestDataClassDispositions.affectedRowCount,
    })
    .from(governance.guestDataClassDispositions)
    .where(eq(governance.guestDataClassDispositions.requestId, requestId));
  return new Map(rows.map((row) => [row.dataClass, row.affected]));
}

beforeAll(async () => {
  process.env.GUEST_COMMERCE_ENABLED = 'true';
  process.env.GUEST_PII_ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.GUEST_EMAIL_HASH_KEY = 'b'.repeat(64);
  process.env.GUEST_ABUSE_SUBJECT_HASH_KEY = 'c'.repeat(64);
  process.env.GUEST_MAGIC_LINK_BASE_URL = 'https://mercaria.co/guest-orders/portal';

  const postgres = await import('../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();
  guests = await import('../../db/schema/guests.js');
  buyers = await import('../../db/schema/buyers.js');
  portal = await import('../../db/schema/guestPortal.js');
  governance = await import('../../db/schema/guestGovernance.js');
  sessionRepo = await import('../../db/guests/guestSessionRepository.js');
  grantRepo = await import('../../db/guestPortal/grantRepository.js');
  retentionRepo = await import('../../db/guestGovernance/retentionRepository.js');
  tokens = await import('../guest-portal/grant-token.js');
  dataRequests = await import('../guest-governance/data-request.service.js');
  abuse = await import('../guest-governance/abuse.service.js');
  subject = await import('../guest-governance/subject.js');
}, 120_000);

afterAll(async () => {
  if (groupIds.length > 0) {
    const requests = await db
      .select({ id: governance.guestDataRequests.id })
      .from(governance.guestDataRequests)
      .where(inArray(governance.guestDataRequests.checkoutGroupId, groupIds));
    if (requests.length > 0) {
      await db.delete(governance.guestDataRequests).where(
        inArray(
          governance.guestDataRequests.id,
          requests.map((row) => row.id),
        ),
      );
    }
    await db
      .delete(governance.guestLegalHolds)
      .where(inArray(governance.guestLegalHolds.checkoutGroupId, groupIds));
    await db
      .delete(portal.guestOrderAccessGrants)
      .where(inArray(portal.guestOrderAccessGrants.checkoutGroupId, groupIds));
  }
  if (checkoutIds.length > 0) {
    await db.delete(guests.guestCheckouts).where(inArray(guests.guestCheckouts.id, checkoutIds));
  }
  if (sessionIds.length > 0) {
    await db.delete(guests.guestSessions).where(inArray(guests.guestSessions.id, sessionIds));
  }
  await closePostgres();
});

describe('an erasure request erases what its receipt says it erased (M8-01, ADR 0003 D15)', () => {
  it('anonymizes the contact, revokes every credential, and deletes the session and its cart', async () => {
    const placed = await placeGuestCheckout();
    const outcome = await dataRequests.requestGuestData({
      subject: {
        proof: 'verified_portal_grant',
        grantId: placed.grantIds[0] as string,
        checkoutGroupId: placed.checkoutGroupId,
      },
      kind: 'deletion',
      now: new Date(),
    });
    expect(outcome.outcome).toBe('completed');
    if (outcome.outcome !== 'completed') return;
    const receipt = outcome.receipt;

    // The database, first — the receipt is only worth reading if this holds.
    const [contact] = await db
      .select()
      .from(guests.guestCheckouts)
      .where(eq(guests.guestCheckouts.id, placed.guestCheckoutId));
    expect(contact?.emailCiphertext).toBeNull();
    expect(contact?.emailHash).toBeNull();
    expect(contact?.phoneCiphertext).toBeNull();
    expect(contact?.phoneRedacted).toBeNull();
    expect(contact?.emailRedacted).toBe('deleted');
    expect(contact?.anonymizedAt).not.toBeNull();

    const grants = await db
      .select({ revokedAt: portal.guestOrderAccessGrants.revokedAt })
      .from(portal.guestOrderAccessGrants)
      .where(eq(portal.guestOrderAccessGrants.checkoutGroupId, placed.checkoutGroupId));
    expect(grants).toHaveLength(2);
    for (const grant of grants) expect(grant.revokedAt).not.toBeNull();

    const sessions = await db
      .select({ id: guests.guestSessions.id })
      .from(guests.guestSessions)
      .where(eq(guests.guestSessions.id, placed.guestSessionId));
    expect(sessions).toEqual([]);
    const carts = await db
      .select({ id: buyers.carts.id })
      .from(buyers.carts)
      .where(eq(buyers.carts.id, placed.cartId));
    expect(carts).toEqual([]);

    // …and the receipt says exactly that, with the numbers the database shows.
    expect(outcomeFor(receipt, 'pending_guest_checkout')?.disposition).toBe('minimized');
    expect(outcomeFor(receipt, 'paid_guest_checkout')?.disposition).toBe('not_stored');
    expect(outcomeFor(receipt, 'guest_session_metadata')?.disposition).toBe('deleted');
    expect(outcomeFor(receipt, 'cart_and_discount_intent')?.disposition).toBe('deleted');
    expect(outcomeFor(receipt, 'access_grants_and_portal_sessions')).toEqual({
      dataClass: 'access_grants_and_portal_sessions',
      disposition: 'retained_under_obligation',
      retainedReason: 'security_audit',
    });
    expect(receipt.state).toBe('partially_completed');

    const counts = await storedCounts(receipt.requestId);
    expect(counts.get('pending_guest_checkout')).toBe(1);
    expect(counts.get('paid_guest_checkout')).toBe(0);
    expect(counts.get('guest_session_metadata')).toBe(1);
    expect(counts.get('cart_and_discount_intent')).toBe(1);
    expect(counts.get('access_grants_and_portal_sessions')).toBe(2);
    // The classes the request cannot reach report NOTHING affected — the
    // exact line the M8 review found reporting one row each.
    for (const dataClass of [
      'transactional_notification_events',
      'product_analytics_and_experimentation',
      'merchant_facing_aggregates',
      'security_and_audit_events',
      'destination_snapshot',
    ]) {
      expect(counts.get(dataClass), dataClass).toBe(0);
    }
  });

  it('a SECOND request reports zero, because there is nothing left to erase', async () => {
    const placed = await placeGuestCheckout();
    const ask = () =>
      dataRequests.requestGuestData({
        subject: {
          proof: 'verified_portal_grant',
          grantId: placed.grantIds[0] as string,
          checkoutGroupId: placed.checkoutGroupId,
        },
        kind: 'minimization',
        now: new Date(),
      });
    await ask();
    const second = await ask();
    expect(second.outcome).toBe('completed');
    if (second.outcome !== 'completed') return;
    const counts = await storedCounts(second.receipt.requestId);
    expect(counts.get('pending_guest_checkout')).toBe(0);
    expect(counts.get('guest_session_metadata')).toBe(0);
    expect(counts.get('cart_and_discount_intent')).toBe(0);
    expect(counts.get('access_grants_and_portal_sessions')).toBe(0);
  });

  it('a legal hold on the contact keeps the contact — and nothing else', async () => {
    const placed = await placeGuestCheckout();
    await retentionRepo.raiseLegalHold(db, {
      checkoutGroupId: placed.checkoutGroupId,
      retentionClass: 'unpaid_pending_checkout',
      reason: 'open_dispute',
      raisedByOxyUserId: 'oxy-legal-1',
    });
    const outcome = await dataRequests.requestGuestData({
      subject: {
        proof: 'verified_portal_grant',
        grantId: placed.grantIds[0] as string,
        checkoutGroupId: placed.checkoutGroupId,
      },
      kind: 'deletion',
      now: new Date(),
    });
    if (outcome.outcome !== 'completed') throw new Error('the request was refused');

    const [contact] = await db
      .select({
        emailCiphertext: guests.guestCheckouts.emailCiphertext,
        anonymizedAt: guests.guestCheckouts.anonymizedAt,
      })
      .from(guests.guestCheckouts)
      .where(eq(guests.guestCheckouts.id, placed.guestCheckoutId));
    expect(contact?.emailCiphertext).not.toBeNull();
    expect(contact?.anonymizedAt).toBeNull();
    expect(outcomeFor(outcome.receipt, 'pending_guest_checkout')).toEqual({
      dataClass: 'pending_guest_checkout',
      disposition: 'retained_under_obligation',
      retainedReason: 'legal_hold',
    });

    // The session and its credentials are NOT pausable classes, so they go.
    const sessions = await db
      .select({ id: guests.guestSessions.id })
      .from(guests.guestSessions)
      .where(eq(guests.guestSessions.id, placed.guestSessionId));
    expect(sessions).toEqual([]);
  });

  it('refuses a group with no guest checkout, and writes nothing', async () => {
    const outcome = await dataRequests.requestGuestData({
      subject: {
        proof: 'verified_portal_grant',
        grantId: `grant-${MARKER}`,
        checkoutGroupId: `grp-missing-${MARKER}`,
      },
      kind: 'deletion',
      now: new Date(),
    });
    expect(outcome).toEqual({ outcome: 'refused', refusal: 'unknown_checkout' });
  });
});

describe('the abuse counter is written while friction is OFF (M8-03)', () => {
  it('counts every attempt and refuses none', async () => {
    const range = `10.${String(Math.floor(Math.random() * 250))}.${MARKER.length}.0/24-${MARKER}`;
    const now = new Date();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const verdict = await abuse.checkGuestAbuse({
        scope: 'session_issuance',
        subjectValue: range,
        now,
      });
      expect(verdict.outcome).toBe('permitted');
    }
    const subjectHash = subject.abuseSubjectHash({
      scope: 'session_issuance',
      axis: 'network_range',
      value: range,
    });
    const rows = await db
      .select({ count: governance.guestAbuseCounters.attemptCount })
      .from(governance.guestAbuseCounters)
      .where(
        and(
          eq(governance.guestAbuseCounters.scope, 'session_issuance'),
          eq(governance.guestAbuseCounters.subjectHash, subjectHash),
        ),
      );
    // The positive control the review asked for: with friction off the old
    // code returned before this table was touched, so this read was EMPTY.
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.count)).toBe(3);

    const interventions = await db
      .select({ id: governance.guestAbuseInterventions.id })
      .from(governance.guestAbuseInterventions)
      .where(eq(governance.guestAbuseInterventions.subjectHash, subjectHash));
    expect(interventions).toEqual([]);

    await db
      .delete(governance.guestAbuseCounters)
      .where(eq(governance.guestAbuseCounters.subjectHash, subjectHash));
  });
});
