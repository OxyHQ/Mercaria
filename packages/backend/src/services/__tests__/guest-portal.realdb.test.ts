/**
 * The guest order portal against a REAL PostgreSQL server (#108, ADR 0003 D5).
 *
 * Every property pinned here IS a database behaviour and has no mocked
 * counterpart: the two CHECKs that carry the verification model, the unique
 * token-hash index, the single-statement compare-and-swap that makes an
 * exchange single-use under concurrency, the partial unique that makes two
 * operators reacting to one bounce converge, and the `ON CONFLICT DO NOTHING`
 * that makes a duplicate webhook a genuine no-op down to the row's `xmin`.
 *
 * A mocked `insert` accepts any statement, including one the server rejects
 * outright — which is precisely the class of bug these cases exist to catch.
 *
 * ## Scoping, because this database is SHARED
 *
 * One throwaway Postgres serves the whole suite and vitest runs files in
 * parallel workers. Every row created here is tracked and deleted in
 * `afterEach`; no assertion counts a whole table.
 *
 * ## Env before any import of the code under test
 *
 * `config/index.ts` reads the environment once at module load and freezes it,
 * so the keys and the link base are set in `beforeAll` and everything is
 * imported dynamically afterwards.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';

let db: import('../../db/postgres.js').Database;
let closePostgres: typeof import('../../db/postgres.js').closePostgres;
let schema: typeof import('../../db/schema/guestPortal.js');
let guests: typeof import('../../db/schema/guests.js');
let grantRepo: typeof import('../../db/guestPortal/grantRepository.js');
let messageRepo: typeof import('../../db/guestPortal/messageRepository.js');
let suppressionRepo: typeof import('../../db/guestPortal/suppressionRepository.js');
let recoveryRepo: typeof import('../../db/guestPortal/recoveryAttemptRepository.js');
let grantSvc: typeof import('../guest-portal/grant.service.js');
let tokens: typeof import('../guest-portal/grant-token.js');

const createdCheckoutIds: string[] = [];
const createdGrantIds: string[] = [];
const createdMessageIds: string[] = [];
const createdSuppressionHashes: string[] = [];

const DAY_MS = 24 * 60 * 60 * 1_000;

/** A `guest_checkouts` row every grant below hangs off. */
async function createCheckout(
  overrides: { emailHash?: string; guestSessionId?: string } = {},
): Promise<{ id: string; checkoutGroupId: string; guestSessionId: string }> {
  const checkoutGroupId = `grp-${Math.random().toString(36).slice(2, 12)}`;
  const guestSessionId = overrides.guestSessionId ?? `ses-${Math.random().toString(36).slice(2, 12)}`;
  const [row] = await db
    .insert(guests.guestCheckouts)
    .values({
      checkoutGroupId,
      guestSessionId,
      emailCiphertext: 'v1:aaa:bbb:ccc',
      emailHash: overrides.emailHash ?? `hash-${Math.random().toString(36).slice(2, 12)}`,
      emailRedacted: 'j***@example.com',
      marketingOptIn: false,
    })
    .returning();
  if (!row) throw new Error('fixture guest_checkouts insert returned no row');
  createdCheckoutIds.push(row.id);
  return { id: row.id, checkoutGroupId, guestSessionId };
}

/** Insert a grant, tracked, with the caller supplying only what the case is about. */
async function insertGrant(
  contact: { id: string; checkoutGroupId: string },
  input: Partial<Parameters<typeof grantRepo.insertGuestOrderAccessGrant>[1]> = {},
): Promise<import('../../db/guestPortal/grantRepository.js').GuestOrderAccessGrantRow> {
  const expiresAt = input.expiresAt ?? new Date(Date.now() + DAY_MS);
  const row = await grantRepo.insertGuestOrderAccessGrant(db, {
    checkoutGroupId: contact.checkoutGroupId,
    guestCheckoutId: contact.id,
    tokenHash: tokens.hashPortalToken(tokens.mintPortalToken().token),
    purpose: 'portal',
    createdVia: 'magic_link',
    scopes: ['orders:read'],
    emailVerifiedAt: new Date(),
    expiresAt,
    purgeAt: new Date(expiresAt.getTime() + DAY_MS),
    ...input,
  });
  createdGrantIds.push(row.id);
  return row;
}


/**
 * Assert a statement is refused by a NAMED constraint.
 *
 * postgres.js puts the driver error under `cause` and the thrown message is a
 * generic "Failed query: …", so `rejects.toThrowError(/name/)` passes on ANY
 * failure — a typo in a column, a missing fixture, a dropped connection. That
 * is the vacuous shape `~/Oxy/AGENTS.md` (C) warns about: a check that cannot
 * tell success from failure. This reads `constraint_name` off the driver error,
 * so a case can only pass when the constraint it names is the one that fired.
 */
async function expectConstraintViolation(
  run: () => Promise<unknown>,
  constraintName: string,
): Promise<void> {
  let raised: unknown;
  try {
    await run();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected ${constraintName} to refuse the statement`).toBeDefined();
  const cause = (raised as { cause?: { constraint_name?: string } }).cause;
  const named =
    cause?.constraint_name ?? (raised as { constraint_name?: string }).constraint_name;
  expect(named).toBe(constraintName);
}

/** Insert a grant row DIRECTLY, bypassing the repository's input type. */
async function rawGrantInsert(
  contact: { id: string; checkoutGroupId: string },
  overrides: Record<string, unknown>,
): Promise<void> {
  const expiresAt = new Date(Date.now() + DAY_MS);
  await db.insert(schema.guestOrderAccessGrants).values({
    checkoutGroupId: contact.checkoutGroupId,
    guestCheckoutId: contact.id,
    tokenHash: tokens.hashPortalToken(tokens.mintPortalToken().token),
    purpose: 'portal',
    createdVia: 'magic_link',
    scopes: ['orders:read'],
    emailVerifiedAt: new Date(),
    expiresAt,
    purgeAt: new Date(expiresAt.getTime() + DAY_MS),
    ...overrides,
  } as never);
}

beforeAll(async () => {
  process.env.GUEST_COMMERCE_ENABLED = 'true';
  process.env.GUEST_PII_ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.GUEST_EMAIL_HASH_KEY = 'b'.repeat(64);
  process.env.GUEST_MAGIC_LINK_BASE_URL = 'https://mercaria.co/guest-orders/portal';

  const postgres = await import('../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();
  schema = await import('../../db/schema/guestPortal.js');
  guests = await import('../../db/schema/guests.js');
  grantRepo = await import('../../db/guestPortal/grantRepository.js');
  messageRepo = await import('../../db/guestPortal/messageRepository.js');
  suppressionRepo = await import('../../db/guestPortal/suppressionRepository.js');
  recoveryRepo = await import('../../db/guestPortal/recoveryAttemptRepository.js');
  grantSvc = await import('../guest-portal/grant.service.js');
  tokens = await import('../guest-portal/grant-token.js');
}, 120_000);

afterEach(async () => {
  // Children first, and by their PARENT rather than by tracked ids: the
  // exchange mints portal grants inside the service, so a case cannot always
  // name every row it caused. Deleting by `guest_checkout_id` is exhaustive by
  // construction and stays scoped to this file's own fixtures — which matters,
  // because this database is shared with every other realdb file.
  createdMessageIds.splice(0);
  createdGrantIds.splice(0);
  const checkoutIds = createdCheckoutIds.splice(0);
  if (checkoutIds.length > 0) {
    await db
      .delete(schema.guestPortalMessages)
      .where(inArray(schema.guestPortalMessages.guestCheckoutId, checkoutIds));
    await db
      .delete(schema.guestOrderAccessGrants)
      .where(inArray(schema.guestOrderAccessGrants.guestCheckoutId, checkoutIds));
  }
  const hashes = createdSuppressionHashes.splice(0);
  if (hashes.length > 0) {
    await db
      .delete(schema.guestContactSuppressions)
      .where(inArray(schema.guestContactSuppressions.emailHash, hashes));
  }
  if (checkoutIds.length > 0) {
    await db.delete(guests.guestCheckouts).where(inArray(guests.guestCheckouts.id, checkoutIds));
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('the two CHECKs that carry the verification model', () => {
  it('refuses a verification instant on a post_checkout grant (rules 2 and 3)', async () => {
    // "Payment success alone does not verify email ownership", and neither does
    // a card, a wallet or Stripe Link — made structural. A `post_checkout` row
    // is the one paying produces, and it has nowhere to record a proof.
    const contact = await createCheckout();
    await expectConstraintViolation(
      () =>
        rawGrantInsert(contact, {
          createdVia: 'post_checkout',
          emailVerifiedAt: new Date(),
          scopes: ['tracking:read'],
        }),
      'guest_order_access_grants_verification_origin_check',
    );
  });

  it('refuses orders:read on an UNVERIFIED grant (ADR 0003 D17)', async () => {
    const contact = await createCheckout();
    await expectConstraintViolation(
      () =>
        rawGrantInsert(contact, {
          createdVia: 'post_checkout',
          emailVerifiedAt: null,
          scopes: ['orders:read'],
        }),
      'guest_order_access_grants_unverified_scope_check',
    );
  });

  it('ACCEPTS the shapes the two CHECKs exist to permit', async () => {
    // The positive control. Without it both cases above would pass against a
    // table that refused everything — which is the vacuous form of a
    // constraint test.
    const contact = await createCheckout();
    const unverified = await insertGrant(contact, {
      createdVia: 'post_checkout',
      emailVerifiedAt: undefined,
      scopes: ['tracking:read'],
    });
    expect(unverified.emailVerifiedAt).toBeNull();

    const verified = await insertGrant(contact, { scopes: ['orders:read', 'claim:write'] });
    expect(verified.emailVerifiedAt).not.toBeNull();
  });

  it('refuses a scope nobody defined, and an EMPTY scope set', async () => {
    const contact = await createCheckout();
    // A scope outside the tuple has no row shape — a service bug, a replay or
    // `psql` all hit the same wall.
    await expectConstraintViolation(
      () => rawGrantInsert(contact, { scopes: ['orders:write'] }),
      'guest_order_access_grants_scopes_check',
    );
    await expectConstraintViolation(
      () => rawGrantInsert(contact, { scopes: [] }),
      'guest_order_access_grants_scopes_present_check',
    );
  });

  it('refuses a consumed PORTAL row and a post_checkout EXCHANGE row', async () => {
    const contact = await createCheckout();
    await expectConstraintViolation(
      () => rawGrantInsert(contact, { consumedAt: new Date() }),
      'guest_order_access_grants_consumed_shape_check',
    );
    await expectConstraintViolation(
      () =>
        rawGrantInsert(contact, {
          purpose: 'exchange',
          createdVia: 'post_checkout',
          exchangeReason: 'recovery',
          emailVerifiedAt: null,
          scopes: ['tracking:read'],
        }),
      'guest_order_access_grants_exchange_origin_check',
    );
  });
});

describe('the exchange is single-use under CONCURRENCY (test case 3)', () => {
  it('two simultaneous consumes of one link produce exactly ONE portal credential', async () => {
    const contact = await createCheckout();
    const minted = tokens.mintExchangeToken();
    await insertGrant(contact, {
      tokenHash: minted.tokenHash,
      purpose: 'exchange',
      createdVia: 'magic_link',
      exchangeReason: 'recovery',
      emailVerifiedAt: undefined,
      scopes: ['orders:read'],
      expiresAt: new Date(Date.now() + 60_000),
      purgeAt: new Date(Date.now() + DAY_MS),
    });

    const [first, second] = await Promise.all([
      grantSvc.exchangeMagicLinkToken({ presented: minted.token, now: new Date() }),
      grantSvc.exchangeMagicLinkToken({ presented: minted.token, now: new Date() }),
    ]);

    const winners = [first, second].filter((result) => result !== null);
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    if (!winner) throw new Error('no winner');
    createdGrantIds.push(winner.grant.id);
    expect(winner.grant.purpose).toBe('portal');
    expect(winner.grant.createdVia).toBe('magic_link');
    expect(winner.grant.emailVerifiedAt).not.toBeNull();
  });

  it('a LINK-PREVIEW fetch cannot consume the grant (test case 2, ADR 0003 T4)', async () => {
    // The token rides in the URL FRAGMENT, which a scanner never sends to a
    // server — so the only way to burn a link is the exchange STATEMENT, and
    // nothing but a real POST reaches it. The database half of that promise is
    // what this asserts: a grant that nobody exchanged is still live and still
    // unconsumed after any number of reads.
    const contact = await createCheckout();
    const minted = tokens.mintExchangeToken();
    const grant = await insertGrant(contact, {
      tokenHash: minted.tokenHash,
      purpose: 'exchange',
      createdVia: 'magic_link',
      exchangeReason: 'initial_confirmation',
      emailVerifiedAt: undefined,
      scopes: ['orders:read'],
    });

    for (let i = 0; i < 3; i += 1) {
      await grantRepo.findLiveGrantByTokenHash(db, minted.tokenHash, 'exchange', new Date());
    }

    const [after] = await db
      .select({ consumedAt: schema.guestOrderAccessGrants.consumedAt })
      .from(schema.guestOrderAccessGrants)
      .where(eq(schema.guestOrderAccessGrants.id, grant.id));
    expect(after?.consumedAt).toBeNull();

    const exchanged = await grantSvc.exchangeMagicLinkToken({
      presented: minted.token,
      now: new Date(),
    });
    expect(exchanged).not.toBeNull();
    if (exchanged) createdGrantIds.push(exchanged.grant.id);
  });

  it('a DUPLICATE exchange, an EXPIRED grant and a REVOKED one are all the same answer', async () => {
    // Test cases 3 and 4, and the uniform-rejection rule: the service cannot
    // tell them apart, so neither can a caller.
    const contact = await createCheckout();

    const used = tokens.mintExchangeToken();
    await insertGrant(contact, {
      tokenHash: used.tokenHash,
      purpose: 'exchange',
      createdVia: 'magic_link',
      exchangeReason: 'recovery',
      emailVerifiedAt: undefined,
      scopes: ['orders:read'],
    });
    const first = await grantSvc.exchangeMagicLinkToken({ presented: used.token, now: new Date() });
    if (first) createdGrantIds.push(first.grant.id);
    expect(await grantSvc.exchangeMagicLinkToken({ presented: used.token, now: new Date() })).toBeNull();

    const expired = tokens.mintExchangeToken();
    const past = new Date(Date.now() - 60_000);
    await insertGrant(contact, {
      tokenHash: expired.tokenHash,
      purpose: 'exchange',
      createdVia: 'magic_link',
      exchangeReason: 'recovery',
      emailVerifiedAt: undefined,
      scopes: ['orders:read'],
      expiresAt: past,
      purgeAt: new Date(past.getTime() + DAY_MS),
    });
    expect(
      await grantSvc.exchangeMagicLinkToken({ presented: expired.token, now: new Date() }),
    ).toBeNull();

    const revoked = tokens.mintExchangeToken();
    const revokedGrant = await insertGrant(contact, {
      tokenHash: revoked.tokenHash,
      purpose: 'exchange',
      createdVia: 'magic_link',
      exchangeReason: 'recovery',
      emailVerifiedAt: undefined,
      scopes: ['orders:read'],
    });
    await grantRepo.revokeGrant(db, revokedGrant.id, new Date());
    expect(
      await grantSvc.exchangeMagicLinkToken({ presented: revoked.token, now: new Date() }),
    ).toBeNull();

    // And a well-formed token nobody ever issued.
    expect(
      await grantSvc.exchangeMagicLinkToken({
        presented: tokens.mintExchangeToken().token,
        now: new Date(),
      }),
    ).toBeNull();
  });
});

describe('scope is ONE checkout group (test cases 8 and 9, ADR 0003 T7/T11)', () => {
  it('two independent checkouts sharing an inbox get two unrelated credentials', async () => {
    const sharedHash = `shared-${Math.random().toString(36).slice(2, 12)}`;
    const first = await createCheckout({ emailHash: sharedHash });
    const second = await createCheckout({ emailHash: sharedHash });

    const firstGrant = await insertGrant(first);
    const secondGrant = await insertGrant(second);

    // The whole security property, at the row: neither credential names the
    // other's group, and there is no column on either that could.
    expect(firstGrant.checkoutGroupId).toBe(first.checkoutGroupId);
    expect(secondGrant.checkoutGroupId).toBe(second.checkoutGroupId);
    expect(firstGrant.checkoutGroupId).not.toBe(secondGrant.checkoutGroupId);

    // And a revoke-all on one leaves the other's credential untouched.
    const revoked = await grantRepo.revokeGroupGrants(db, first.checkoutGroupId, new Date());
    expect(revoked).toEqual([firstGrant.id]);
    const [stillLive] = await db
      .select({ revokedAt: schema.guestOrderAccessGrants.revokedAt })
      .from(schema.guestOrderAccessGrants)
      .where(eq(schema.guestOrderAccessGrants.id, secondGrant.id));
    expect(stillLive?.revokedAt).toBeNull();
  });

  it('"secure my access" revokes every OTHER credential and keeps the presenting one', async () => {
    const contact = await createCheckout();
    const keep = await insertGrant(contact);
    const other = await insertGrant(contact);
    const third = await insertGrant(contact);

    const revoked = await grantSvc.secureGroupAccess({
      checkoutGroupId: contact.checkoutGroupId,
      keepGrantId: keep.id,
      now: new Date(),
    });
    expect(revoked.sort()).toEqual([other.id, third.id].sort());

    const rows = await db
      .select({
        id: schema.guestOrderAccessGrants.id,
        revokedAt: schema.guestOrderAccessGrants.revokedAt,
      })
      .from(schema.guestOrderAccessGrants)
      .where(eq(schema.guestOrderAccessGrants.checkoutGroupId, contact.checkoutGroupId));
    expect(rows.find((row) => row.id === keep.id)?.revokedAt).toBeNull();
    expect(rows.find((row) => row.id === other.id)?.revokedAt).not.toBeNull();
  });
});

describe('the token is stored only as a digest, and the digest is unique', () => {
  it('the row carries no plaintext anywhere, and the hash is a SHA-256', async () => {
    const contact = await createCheckout();
    const minted = tokens.mintPortalToken();
    const grant = await insertGrant(contact, { tokenHash: minted.tokenHash });

    // The whole-row assertion, not a column one: a later column addition that
    // accidentally carried the plaintext fails here without a new test.
    expect(JSON.stringify(grant)).not.toContain(minted.token);
    expect(grant.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(grant.tokenHash).toBe(tokens.hashPortalToken(minted.token));
  });

  it('refuses a second grant with the same digest — the unique index, not convention', async () => {
    const contact = await createCheckout();
    const grant = await insertGrant(contact);
    await expect(insertGrant(contact, { tokenHash: grant.tokenHash })).rejects.toThrowError();
  });

  it('a cart token presented to the portal resolver is refused by SHAPE', async () => {
    // ADR 0003 I3: scope is structural. A `mgs_` credential never reaches a
    // hash or a lookup, because `readPortalToken` has an anchored pattern.
    expect(await grantSvc.resolvePortalGrant('mgs_' + 'A'.repeat(43), new Date())).toBeNull();
    expect(await grantSvc.resolvePortalGrant('mgx_' + 'A'.repeat(43), new Date())).toBeNull();
    expect(await grantSvc.resolvePortalGrant('nonsense', new Date())).toBeNull();
  });
});

describe('the message queue converges on a duplicate (initial-confirmation rule 7)', () => {
  it('a repeated enqueue writes NOTHING — not a timestamp, not a tuple version', async () => {
    const contact = await createCheckout();
    const id = messageRepo.guestPortalMessageId('order_confirmation', contact.checkoutGroupId);
    createdMessageIds.push(id);
    const now = new Date();

    const first = await messageRepo.enqueueGuestPortalMessage(db, {
      id,
      checkoutGroupId: contact.checkoutGroupId,
      guestCheckoutId: contact.id,
      kind: 'order_confirmation',
      availableAt: now,
      expiresAt: new Date(now.getTime() + DAY_MS),
    });
    expect(first).toBe(true);

    const before = await readMessageVersion(id);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const second = await messageRepo.enqueueGuestPortalMessage(db, {
      id,
      checkoutGroupId: contact.checkoutGroupId,
      guestCheckoutId: contact.id,
      kind: 'order_confirmation',
      availableAt: new Date(),
      expiresAt: new Date(Date.now() + DAY_MS),
    });
    expect(second).toBe(false);

    const after = await readMessageVersion(id);
    // `updated_at` catches a `DO UPDATE` that rewrote the same values (drizzle
    // applies `$onUpdate` to a conflict branch's `set`); `xmin` catches one
    // careful enough to leave every column alone. Both, because either alone
    // has a way past it.
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.xmin).toBe(before.xmin);
  });
});

describe('suppression is a fact about an ADDRESS', () => {
  it('two workers reacting to one bounce converge on ONE live row', async () => {
    const emailHash = `sup-${Math.random().toString(36).slice(2, 12)}`;
    createdSuppressionHashes.push(emailHash);

    const [first, second] = await Promise.all([
      suppressionRepo.suppressGuestContact(db, { emailHash, reason: 'hard_bounce' }),
      suppressionRepo.suppressGuestContact(db, { emailHash, reason: 'complaint' }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);

    const live = await suppressionRepo.findLiveSuppression(db, emailHash);
    expect(live).not.toBeNull();

    // A LIFTED row frees the partial unique, so an address can be suppressed
    // again later — and the lift is attributable, dated and explained or the
    // CHECK refuses it.
    await suppressionRepo.liftGuestContactSuppression(db, {
      emailHash,
      actorOxyUserId: 'oxy-operator',
      reason: 'confirmed a typo, address is valid',
      now: new Date(),
    });
    expect(await suppressionRepo.findLiveSuppression(db, emailHash)).toBeNull();
    expect(
      await suppressionRepo.suppressGuestContact(db, { emailHash, reason: 'complaint' }),
    ).toBe(true);
  });

  it('refuses a half-recorded lift', async () => {
    const emailHash = `sup-${Math.random().toString(36).slice(2, 12)}`;
    createdSuppressionHashes.push(emailHash);
    await suppressionRepo.suppressGuestContact(db, { emailHash, reason: 'hard_bounce' });

    await expectConstraintViolation(
      () =>
        db
          .update(schema.guestContactSuppressions)
          .set({ liftedAt: new Date() })
          .where(eq(schema.guestContactSuppressions.emailHash, emailHash)),
      'guest_contact_suppressions_lift_check',
    );
  });
});

describe('the recovery throttle counts across tasks', () => {
  it('concurrent attempts on one axis all count — no read-then-write to race', async () => {
    const subjectHash = `axis-${Math.random().toString(36).slice(2, 12)}`;
    const windowStartedAt = new Date(Math.floor(Date.now() / 60_000) * 60_000);

    const totals = await Promise.all(
      Array.from({ length: 5 }, () =>
        recoveryRepo.countRecoveryAttempt(db, {
          axis: 'email_hash',
          subjectHash,
          windowStartedAt,
        }),
      ),
    );
    // Every attempt saw a distinct running total, which is what a read-then-
    // write cannot promise: five racers would each read 0 and all pass a
    // ceiling of 1.
    expect(new Set(totals).size).toBe(5);
    expect(Math.max(...totals)).toBe(5);
    expect(
      await recoveryRepo.readRecoveryAttempts(db, {
        axis: 'email_hash',
        subjectHash,
        windowStartedAt,
      }),
    ).toBe(5);

    await db
      .delete(schema.guestRecoveryAttempts)
      .where(eq(schema.guestRecoveryAttempts.subjectHash, subjectHash));
  });
});

describe('the operator audit records refusals', () => {
  it('refuses a performed row carrying a refusal code, and a refused row without one', async () => {
    const contact = await createCheckout();
    await expectConstraintViolation(
      () =>
        db.insert(schema.guestPortalOperatorActions).values({
          checkoutGroupId: contact.checkoutGroupId,
          action: 'resend_access_link',
          actorOxyUserId: 'oxy-operator',
          reason: 'buyer says nothing arrived',
          outcome: 'performed',
          refusalCode: 'contact_suppressed',
        }),
      'guest_portal_operator_actions_refusal_check',
    );

    await expectConstraintViolation(
      () =>
        db.insert(schema.guestPortalOperatorActions).values({
          checkoutGroupId: contact.checkoutGroupId,
          action: 'resend_access_link',
          actorOxyUserId: 'oxy-operator',
          reason: 'buyer says nothing arrived',
          outcome: 'refused',
        }),
      'guest_portal_operator_actions_refusal_check',
    );

    // And an empty reason, because an audit row with no reason records that
    // something happened and not why.
    await expectConstraintViolation(
      () =>
        db.insert(schema.guestPortalOperatorActions).values({
          checkoutGroupId: contact.checkoutGroupId,
          action: 'revoke_group_access',
          actorOxyUserId: 'oxy-operator',
          reason: '  ',
          outcome: 'performed',
        }),
      'guest_portal_operator_actions_reason_check',
    );

    await db
      .delete(schema.guestPortalOperatorActions)
      .where(eq(schema.guestPortalOperatorActions.checkoutGroupId, contact.checkoutGroupId));
  });
});

/** `updated_at` and the tuple version, for the no-op assertions above. */
async function readMessageVersion(id: string): Promise<{ updatedAt: Date; xmin: string }> {
  const [row] = await db
    .select({
      updatedAt: schema.guestPortalMessages.updatedAt,
      xmin: sql<string>`${schema.guestPortalMessages}.xmin::text`,
    })
    .from(schema.guestPortalMessages)
    .where(eq(schema.guestPortalMessages.id, id));
  if (!row) throw new Error(`message ${id} not found`);
  return row;
}
