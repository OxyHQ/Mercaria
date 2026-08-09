/**
 * Guest sessions against a REAL PostgreSQL server (#103, ADR 0003 D3).
 *
 * The properties pinned here CANNOT be pinned by a mock, because each one IS a
 * database behaviour: the unique token-hash index refusing a duplicate, the
 * single-statement compare-and-swap letting exactly one of two concurrent
 * rotations (or revocations) win, CHECK constraints refusing malformed
 * lifecycle states, and the rotation grace being a real second lookup path.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres serves the whole suite and vitest runs files in
 * parallel workers. Every row this file creates is tracked by id and deleted
 * in `afterEach`; no assertion counts the whole table. The expiry SWEEP cases
 * for guest sessions live in `db/__tests__/expirySweeper.realdb.test.ts`
 * beside every other target — running the sweep from two files concurrently
 * would let one file delete the other's fixtures mid-assertion.
 *
 * ## Env is set BEFORE any import of the code under test
 *
 * `config/index.ts` reads the environment once at module load and freezes it,
 * and `issueGuestSession` refuses when guest commerce is off — so everything
 * is imported dynamically after `beforeAll` sets the three variables the M8
 * half-configuration rule requires.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';

let db: import('../../db/postgres.js').Database;
let closePostgres: typeof import('../../db/postgres.js').closePostgres;
let guestSessions: typeof import('../../db/schema/guests.js').guestSessions;
let repo: typeof import('../../db/guests/guestSessionRepository.js');
let svc: typeof import('../guest-session.service.js');

const createdIds: string[] = [];

/** Track a session for cleanup. Returns its argument for chaining. */
function track<T extends { id: string }>(session: T): T {
  createdIds.push(session.id);
  return session;
}

async function issueTracked(): Promise<{
  session: import('../../db/guests/guestSessionRepository.js').GuestSessionRow;
  token: string;
}> {
  const issued = await svc.issueGuestSession({ clientClass: 'other', now: new Date() });
  track(issued.session);
  return issued;
}

beforeAll(async () => {
  process.env.GUEST_COMMERCE_ENABLED = 'true';
  process.env.GUEST_PII_ENCRYPTION_KEY = 'realdb-test-pii-key';
  process.env.GUEST_EMAIL_HASH_KEY = 'realdb-test-email-hash-key';
  // Explicit, not assumed: vitest may run several files in one worker thread,
  // and the kill-switch file sets this to 'false' — env leaks, configs do not.
  process.env.GUEST_SESSION_ISSUANCE_ENABLED = 'true';

  const postgres = await import('../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();
  ({ guestSessions } = await import('../../db/schema/guests.js'));
  repo = await import('../../db/guests/guestSessionRepository.js');
  svc = await import('../guest-session.service.js');
}, 120_000);

afterEach(async () => {
  const ids = createdIds.splice(0);
  if (ids.length > 0) {
    await db.delete(guestSessions).where(inArray(guestSessions.id, ids));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('issuance and resolution (acceptance 1)', () => {
  it('issues one session and every subsequent presentation resolves the SAME actor', async () => {
    const { session, token } = await issueTracked();

    const first = await svc.resolveGuestSessionByToken(token, new Date());
    const second = await svc.resolveGuestSessionByToken(token, new Date());

    expect(first?.session.id).toBe(session.id);
    expect(second?.session.id).toBe(session.id);
    expect(first?.matchedPrevious).toBe(false);
  });

  it('stores ONLY the SHA-256 of the token — the plaintext appears nowhere in the row', async () => {
    const { session, token } = await issueTracked();

    // The whole-row assertion, not a column one: a later column addition that
    // accidentally carried the plaintext would fail here without a new test.
    const serialized = JSON.stringify(session);
    expect(serialized).not.toContain(token);
    expect(session.tokenHash).toBe(svc.hashGuestToken(token));
    expect(session.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a second row with the same token hash — the unique index, not convention', async () => {
    const { session } = await issueTracked();

    await expect(
      repo.insertGuestSession(db, {
        tokenHash: session.tokenHash,
        clientClass: 'web',
        expiresAt: new Date(Date.now() + 60_000),
        lastSeenAt: new Date(),
      }),
    ).rejects.toThrowError();
  });

  it('two CONCURRENT resolutions of one presented token settle on ONE session, no extra row', async () => {
    // "Concurrent first writes for one valid presented token" (issue #103,
    // abuse rule 5): both racers resolve; neither mints.
    const { session, token } = await issueTracked();

    const [a, b] = await Promise.all([
      svc.resolveGuestSessionByToken(token, new Date()),
      svc.resolveGuestSessionByToken(token, new Date()),
    ]);

    expect(a?.session.id).toBe(session.id);
    expect(b?.session.id).toBe(session.id);
  });
});

describe('uniform rejection (acceptance 5)', () => {
  it('resolves expired, idle-expired, revoked, converted, unknown and malformed IDENTICALLY', async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 1_000);
    const future = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1_000);

    // Absolute expiry.
    const expired = await issueTracked();
    await db
      .update(guestSessions)
      .set({ expiresAt: past })
      .where(inArray(guestSessions.id, [expired.session.id]));

    // Idle expiry: last seen 31 days ago, absolute deadline still ahead.
    const idle = await issueTracked();
    await db
      .update(guestSessions)
      .set({ lastSeenAt: new Date(now.getTime() - 31 * 24 * 60 * 60 * 1_000) })
      .where(inArray(guestSessions.id, [idle.session.id]));

    // Revoked.
    const revoked = await issueTracked();
    await svc.revokeGuestSession(revoked.session.id, now);

    // Converted (the #104 seam): converted implies revoked, per CHECK.
    const converted = await issueTracked();
    await db
      .update(guestSessions)
      .set({
        convertedAt: now,
        convertedToOxyUserId: 'oxy-user-realdb-test',
        revokedAt: now,
        expiresAt: future,
      })
      .where(inArray(guestSessions.id, [converted.session.id]));

    const outcomes = await Promise.all([
      svc.resolveGuestSessionByToken(expired.token, now),
      svc.resolveGuestSessionByToken(idle.token, now),
      svc.resolveGuestSessionByToken(revoked.token, now),
      svc.resolveGuestSessionByToken(converted.token, now),
      // Well-formed but unknown: minted and never inserted.
      svc.resolveGuestSessionByToken(svc.mintGuestToken().token, now),
      svc.resolveGuestSessionByToken('mgs_not-a-real-token', now),
      svc.resolveGuestSessionByToken('x'.repeat(10_000), now),
    ]);

    // The SAME observable for every failure mode — not merely "some falsy
    // value" per mode. `null` carries no reason; the reason lives in logs.
    expect(outcomes).toEqual([null, null, null, null, null, null, null]);
  });

  it('derives status from the timestamp set (no stored status column to disagree)', async () => {
    const now = new Date();
    const { session } = await issueTracked();

    expect(svc.guestSessionStatus(session, now)).toBe('active');
    expect(
      svc.guestSessionStatus({ ...session, revokedAt: now }, now),
    ).toBe('revoked');
    expect(
      svc.guestSessionStatus(
        { ...session, revokedAt: now, convertedAt: now, convertedToOxyUserId: 'u1' },
        now,
      ),
    ).toBe('converted');
    expect(
      svc.guestSessionStatus({ ...session, expiresAt: new Date(now.getTime() - 1) }, now),
    ).toBe('expired');
  });
});

describe('lifecycle CHECK constraints — the database refuses what the service never writes', () => {
  it('refuses an unknown client class', async () => {
    await expect(
      db.insert(guestSessions).values({
        tokenHash: `check-client-${Date.now()}-${Math.random()}`,
        // The cast exists to get an out-of-union value PAST tsc and INTO the
        // server, which is the layer under test here.
        clientClass: 'toaster' as unknown as 'web',
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrowError();
  });

  it('refuses a converted session that is not revoked, and a half conversion pair', async () => {
    const base = {
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      clientClass: 'other' as const,
    };

    await expect(
      db.insert(guestSessions).values({
        ...base,
        tokenHash: `check-conv-${Date.now()}-a`,
        convertedAt: new Date(),
        convertedToOxyUserId: 'u1',
        // revokedAt missing — conversion without revocation is unrepresentable.
      }),
    ).rejects.toThrowError();

    await expect(
      db.insert(guestSessions).values({
        ...base,
        tokenHash: `check-conv-${Date.now()}-b`,
        convertedAt: new Date(),
        revokedAt: new Date(),
        // convertedToOxyUserId missing — the audit pair travels together.
      }),
    ).rejects.toThrowError();
  });

  it('refuses a parked previous hash without its grace deadline', async () => {
    await expect(
      db.insert(guestSessions).values({
        tokenHash: `check-prev-${Date.now()}`,
        previousTokenHash: 'abc',
        clientClass: 'other',
        lastSeenAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrowError();
  });
});

describe('rotation and the 60-second grace (D3)', () => {
  it('rotates in place: the new token resolves, the OLD one keeps resolving inside the grace', async () => {
    const { session, token: oldToken } = await issueTracked();
    const now = new Date();

    const rotated = await svc.rotateGuestSession(session, now);
    expect(rotated).not.toBeNull();
    if (!rotated) return;

    const viaNew = await svc.resolveGuestSessionByToken(rotated.token, new Date());
    expect(viaNew?.session.id).toBe(session.id);
    expect(viaNew?.matchedPrevious).toBe(false);

    // The in-flight request that raced the swap: same session, marked as the
    // outgoing credential.
    const viaOld = await svc.resolveGuestSessionByToken(oldToken, new Date());
    expect(viaOld?.session.id).toBe(session.id);
    expect(viaOld?.matchedPrevious).toBe(true);
  });

  it('stops honouring the old token the moment the grace deadline passes', async () => {
    const { session, token: oldToken } = await issueTracked();
    const rotated = await svc.rotateGuestSession(session, new Date());
    expect(rotated).not.toBeNull();

    // Collapse the grace instead of waiting it out.
    await db
      .update(guestSessions)
      .set({ previousTokenExpiresAt: new Date(Date.now() - 1_000) })
      .where(inArray(guestSessions.id, [session.id]));

    expect(await svc.resolveGuestSessionByToken(oldToken, new Date())).toBeNull();
    const viaNew = await svc.resolveGuestSessionByToken(rotated?.token ?? '', new Date());
    expect(viaNew?.session.id).toBe(session.id);
  });

  it('lets exactly ONE of two concurrent rotations win — the CAS, not luck', async () => {
    const { session } = await issueTracked();
    const now = new Date();

    const [a, b] = await Promise.all([
      svc.rotateGuestSession(session, now),
      svc.rotateGuestSession(session, now),
    ]);

    const winners = [a, b].filter((outcome) => outcome !== null);
    expect(winners).toHaveLength(1);
  });

  it('the 7-day activity cadence is measured from the LAST rotation, else creation', async () => {
    const now = new Date();
    const { session } = await issueTracked();

    expect(svc.rotationDue(session, now)).toBe(false);
    expect(
      svc.rotationDue(
        { ...session, createdAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1_000) },
        now,
      ),
    ).toBe(true);
    expect(
      svc.rotationDue(
        {
          ...session,
          createdAt: new Date(now.getTime() - 8 * 24 * 60 * 60 * 1_000),
          rotatedAt: new Date(now.getTime() - 60_000),
        },
        now,
      ),
    ).toBe(false);
  });
});

describe('revocation', () => {
  it('revokes idempotently: one winner across two concurrent calls, then uniform rejection', async () => {
    const { session, token } = await issueTracked();
    const now = new Date();

    const [a, b] = await Promise.all([
      svc.revokeGuestSession(session.id, now),
      svc.revokeGuestSession(session.id, now),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);

    expect(await svc.resolveGuestSessionByToken(token, new Date())).toBeNull();
  });
});

describe('last-seen granularity (D3 write-amplification bound)', () => {
  it('advances last_seen_at when stale, and writes NOTHING inside the 60 s window', async () => {
    const { session, token } = await issueTracked();
    const stale = new Date(Date.now() - 10 * 60_000);
    await db
      .update(guestSessions)
      .set({ lastSeenAt: stale })
      .where(inArray(guestSessions.id, [session.id]));

    const first = await svc.resolveGuestSessionByToken(token, new Date());
    expect(first?.session).toBeDefined();
    const afterFirst = await repo.findGuestSessionById(db, session.id);
    expect(afterFirst?.lastSeenAt.getTime()).toBeGreaterThan(stale.getTime());

    // Immediately again: within granularity, so the stored value must not move.
    await svc.resolveGuestSessionByToken(token, new Date());
    const afterSecond = await repo.findGuestSessionById(db, session.id);
    expect(afterSecond?.lastSeenAt.getTime()).toBe(afterFirst?.lastSeenAt.getTime());
  });
});
