/**
 * Connected-account onboarding against a REAL PostgreSQL database.
 *
 * ## Why the database cannot be mocked here
 *
 * Every property under test is a property of a constraint or of a concurrent
 * UPDATE, and a mocked `insert` refuses nothing:
 *
 *  - "one account per owner per rail" is `UNIQUE(provider, owner_type, owner_id)`;
 *  - a concurrent second `ensureConnectedAccount` converging rather than
 *    exploding is `on conflict do nothing` plus a re-read, which only means
 *    anything against real row locks;
 *  - sync monotonicity is a compare-and-swap in a `where` clause.
 *
 * ## Stripe IS mocked, and only Stripe
 *
 * `client.ts` is replaced by a fake whose account calls read maps this file
 * controls, and which RECORDS what it was handed. That recording is the only way
 * to assert ADR 0001 D2's controller properties without a live Stripe account:
 * the properties are the decision, they are immutable at the provider once an
 * account exists, and getting one wrong is discovered months later by a seller
 * who cannot be paid.
 *
 * ## Fixtures are scoped, never truncated
 *
 * `*.realdb.test.ts` files share ONE throwaway database and run in PARALLEL, so
 * no file here may TRUNCATE a table another uses. Every owner id below carries a
 * per-run suffix instead, which is the stronger form anyway.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database } from '../../../../db/postgres.js';

/**
 * The fake Stripe API's state, hoisted so the `vi.mock` factory can close over
 * it — a factory is hoisted above every `const` in this file and would otherwise
 * reference an uninitialised binding.
 */
const stripeApi = vi.hoisted(() => ({
  /** Account id → what `retrieve` should answer with. */
  accounts: new Map<string, Record<string, unknown>>(),
  /** Every `accounts.create` this test provoked, params and idempotency key. */
  created: [] as { params: Record<string, unknown>; idempotencyKey: string }[],
  /** Every `accountLinks.create` this test provoked. */
  links: [] as Record<string, unknown>[],
  /** Every account id `retrieve` was asked for, so an EXCLUSION can be asserted. */
  retrieved: [] as string[],
  /** The next account id `create` will mint. */
  nextAccountId: 'acct_unset',
}));

vi.mock('../client.js', () => ({
  STRIPE_API_VERSION: '2026-07-29.dahlia',
  getStripeClient: () => {
    throw new Error('The realdb suite must not construct a real Stripe client.');
  },
  resetStripeClient: () => undefined,
  retrieveStripePaymentIntent: () => {
    throw new Error('No fake PaymentIntent in this suite.');
  },
  retrieveStripeTransfer: () => {
    throw new Error('No fake Transfer in this suite.');
  },
  createStripeConnectedAccount: (params: Record<string, unknown>, idempotencyKey: string) => {
    stripeApi.created.push({ params, idempotencyKey });
    const id = stripeApi.nextAccountId;
    const account = { id, object: 'account', ...NEW_ACCOUNT_STATE };
    stripeApi.accounts.set(id, account);
    return Promise.resolve(account);
  },
  retrieveStripeAccount: (accountId: string) => {
    stripeApi.retrieved.push(accountId);
    const account = stripeApi.accounts.get(accountId);
    if (!account) throw new Error(`No fake account registered for ${accountId}`);
    return Promise.resolve(account);
  },
  // #49's reads and writes. Present so the mocked module offers every export the
  // real one does — a named import missing from a mock factory fails at link
  // time — and each throws, which doubles as an assertion that the onboarding
  // suite reaches none of them.
  retrieveStripeChargeWithBalance: () => {
    throw new Error('The onboarding suite reads no charge.');
  },
  retrieveStripeChargeWithRefunds: () => {
    throw new Error('The onboarding suite reads no charge refunds.');
  },
  createStripeRefund: () => {
    throw new Error('The onboarding suite creates no refund.');
  },
  retrieveStripeRefund: () => {
    throw new Error('The onboarding suite reads no refund.');
  },
  createStripeTransfer: () => {
    throw new Error('The onboarding suite creates no transfer.');
  },
  createStripeTransferReversal: () => {
    throw new Error('The onboarding suite reverses no transfer.');
  },
  retrieveStripeDispute: () => {
    throw new Error('The onboarding suite reads no dispute.');
  },
  retrieveStripePayout: () => {
    throw new Error('The onboarding suite reads no payout.');
  },
  cancelStripePaymentIntent: () => {
    throw new Error('The onboarding suite cancels no PaymentIntent.');
  },
  createStripePaymentIntent: () => {
    throw new Error('The onboarding suite creates no PaymentIntent.');
  },
  createStripeAccountLink: (params: Record<string, unknown>) => {
    stripeApi.links.push(params);
    return Promise.resolve({
      object: 'account_link',
      url: `https://connect.stripe.test/setup/${String(params.account)}`,
      created: Math.floor(Date.now() / 1_000),
      expires_at: Math.floor(Date.now() / 1_000) + 300,
    });
  },
}));

/** What Stripe reports for an account nobody has onboarded yet. */
const NEW_ACCOUNT_STATE = {
  charges_enabled: false,
  payouts_enabled: false,
  capabilities: { transfers: 'inactive' },
  requirements: {
    currently_due: ['individual.first_name', 'external_account'],
    eventually_due: ['individual.first_name', 'external_account', 'tos_acceptance.date'],
    past_due: [],
    pending_verification: [],
    disabled_reason: 'requirements.past_due',
    current_deadline: null,
  },
};

/** Unique per run, so parallel files and repeated runs never collide on an owner. */
const RUN = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/** A requirements deadline, as a UTC instant both sides of the assertion derive from. */
const DEADLINE_EPOCH_MS = Date.UTC(2026, 8, 1, 0, 0, 0);

let db: Database;
let closePostgres: typeof import('../../../../db/postgres.js').closePostgres;
let schema: typeof import('../../../../db/schema/payments.js');
let accountService: typeof import('../account.service.js');
let providerAccounts: typeof import('../../provider-account.service.js');
let reconciler: typeof import('../account-reconciler.js');

beforeAll(async () => {
  // Set BEFORE importing anything that reads config: `config/index.ts` reads
  // process.env once at module load and freezes the result.
  process.env.STRIPE_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_account_platform_not_a_real_one';
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_account_connect_not_a_real_one';
  process.env.STRIPE_SELLER_COUNTRIES = 'ES,FR';
  process.env.STRIPE_ONBOARDING_BASE_URL = 'https://api.mercaria.test';
  process.env.STRIPE_ONBOARDING_RETURN_URL = 'https://dashboard.mercaria.test/settings/payments';
  process.env.STRIPE_ONBOARDING_STATE_SECRET = 'onboarding-state-secret-not-a-real-one';

  const postgres = await import('../../../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();

  schema = await import('../../../../db/schema/payments.js');
  accountService = await import('../account.service.js');
  providerAccounts = await import('../../provider-account.service.js');
  reconciler = await import('../account-reconciler.js');
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  stripeApi.created.length = 0;
  stripeApi.links.length = 0;
  stripeApi.retrieved.length = 0;
  // `accounts` is deliberately NOT cleared. Account ids are unique per test, and
  // the reconciliation cases below sweep every row this FILE has written — so
  // forgetting an earlier test's account would make the sweep fail on rows that
  // are not what the test is about, and drown the real assertion in noise.
});

/** An owner unique to one test. */
function owner(name: string, ownerType: 'store' | 'user' = 'store') {
  return { ownerType, ownerId: `${ownerType}-${RUN}-${name}` } as const;
}

/** Point the fake at a given account state and mint an id for it. */
function expectAccountId(name: string): string {
  const id = `acct_${RUN}_${name}`.replace(/-/g, '');
  stripeApi.nextAccountId = id;
  return id;
}

/** Overwrite what the fake Stripe answers for an account. */
function setAccountState(accountId: string, state: Record<string, unknown>): void {
  stripeApi.accounts.set(accountId, { id: accountId, object: 'account', ...state });
}

/** The Stripe state of a fully onboarded, payable seller. */
function readyState(): Record<string, unknown> {
  return {
    charges_enabled: true,
    payouts_enabled: true,
    default_currency: 'eur',
    capabilities: { transfers: 'active' },
    settings: { payouts: { schedule: { interval: 'daily', delay_days: 7 } } },
    requirements: {
      currently_due: [],
      eventually_due: [],
      past_due: [],
      pending_verification: [],
      disabled_reason: null,
      current_deadline: null,
    },
  };
}

/** The row as it stands now. */
async function readRow(accountRowId: string) {
  const [row] = await db
    .select()
    .from(schema.providerAccounts)
    .where(eq(schema.providerAccounts.id, accountRowId));
  return row;
}

describe('ensureConnectedAccount', () => {
  it('sends ADR 0001 D2 controller properties EXACTLY', async () => {
    const seller = owner('d2');
    expectAccountId('d2');
    await accountService.ensureConnectedAccount({ owner: seller, country: 'ES' });

    expect(stripeApi.created).toHaveLength(1);
    const [call] = stripeApi.created;
    // Compared whole, not field by field: an EXTRA controller property is as
    // wrong as a missing one, and `toMatchObject` would wave it through. These
    // are immutable at Stripe once an account exists — `stripe_dashboard.type`
    // explicitly so — which is why this is pinned rather than reviewed.
    expect(call?.params.controller).toEqual({
      losses: { payments: 'application' },
      fees: { payer: 'application' },
      requirement_collection: 'stripe',
      stripe_dashboard: { type: 'express' },
    });
    // `transfers` and NOTHING else. Requesting `card_payments` would couple both
    // capabilities' disablement, so a card-side problem would stop transfers.
    expect(call?.params.capabilities).toEqual({ transfers: { requested: true } });
    expect(call?.params.country).toBe('ES');
    expect(call?.params.business_type).toBe('company');
    expect(call?.params.metadata).toEqual({
      ownerType: seller.ownerType,
      ownerId: seller.ownerId,
    });
    // The legacy `type` field must never appear beside controller properties —
    // Stripe rejects the combination, and an account created with it is a
    // different account shape from the one the ADR decided on.
    expect(call?.params).not.toHaveProperty('type');
  });

  it('asks for an individual account for a P2P seller', async () => {
    const seller = owner('p2p', 'user');
    expectAccountId('p2p');
    await accountService.ensureConnectedAccount({ owner: seller, country: 'ES' });
    expect(stripeApi.created[0]?.params.business_type).toBe('individual');
  });

  it('derives the Stripe idempotency key from the owner, not from a fresh id', async () => {
    // The outer half of the duplicate-account defence: two racing callers mint
    // two different row ids, so a key derived from a row id would differ between
    // them and Stripe would create two accounts. Only an owner-derived key
    // collapses the race at the provider.
    const seller = owner('idem');
    expectAccountId('idem');
    await accountService.ensureConnectedAccount({ owner: seller, country: 'ES' });
    expect(stripeApi.created[0]?.idempotencyKey).toBe(`acct:store:${seller.ownerId}`);
  });

  it('reuses the existing row and calls Stripe once, however often it is asked', async () => {
    const seller = owner('reuse');
    expectAccountId('reuse');
    const first = await accountService.ensureConnectedAccount({ owner: seller, country: 'ES' });
    const second = await accountService.ensureConnectedAccount({ owner: seller, country: 'FR' });

    expect(second.id).toBe(first.id);
    expect(stripeApi.created).toHaveLength(1);
    // The country of an existing account is NOT updated: it is immutable at
    // Stripe, so accepting a new one would store a value the provider disagrees
    // with and settle money somewhere the row does not name.
    expect(second.country).toBe('ES');
  });

  it('converges on ONE row when two callers race', async () => {
    const seller = owner('race');
    expectAccountId('race');
    const [a, b, c] = await Promise.all([
      accountService.ensureConnectedAccount({ owner: seller, country: 'ES' }),
      accountService.ensureConnectedAccount({ owner: seller, country: 'ES' }),
      accountService.ensureConnectedAccount({ owner: seller, country: 'ES' }),
    ]);

    expect(b?.id).toBe(a?.id);
    expect(c?.id).toBe(a?.id);
    const rows = await db
      .select({ id: schema.providerAccounts.id })
      .from(schema.providerAccounts)
      .where(eq(schema.providerAccounts.ownerId, seller.ownerId));
    expect(rows).toHaveLength(1);
  });

  it('refuses a country outside the configured allow-list', async () => {
    const seller = owner('country');
    expectAccountId('country');
    await expect(
      accountService.ensureConnectedAccount({ owner: seller, country: 'US' }),
    ).rejects.toThrow(/cannot onboard sellers in US/i);
    // Nothing was created at Stripe, which is the half that matters: an account
    // in a country Mercaria cannot transfer to is not undoable.
    expect(stripeApi.created).toHaveLength(0);
  });

  it('stores what Stripe said about the new account rather than a row of defaults', async () => {
    const seller = owner('initial');
    expectAccountId('initial');
    const row = await accountService.ensureConnectedAccount({ owner: seller, country: 'ES' });

    expect(row.onboardingState).toBe('action_required');
    expect(row.requirementsCurrentlyDue).toBe(2);
    expect(row.requirementsEventuallyDue).toBe(3);
    expect(row.transfersCapability).toBe('inactive');
    expect(row.lastSyncedAt).not.toBeNull();
  });
});

describe('createOnboardingLink', () => {
  it('asks for hosted onboarding collecting eventually-due fields', async () => {
    const seller = owner('link');
    const accountId = expectAccountId('link');
    const link = await accountService.createOnboardingLink({ owner: seller, country: 'ES' });

    expect(stripeApi.links).toHaveLength(1);
    const [params] = stripeApi.links;
    expect(params?.account).toBe(accountId);
    expect(params?.type).toBe('account_onboarding');
    // ADR 0001 D2: collect everything up front so a payout is never interrupted
    // months later by a requirement falling due with nobody watching.
    expect(params?.collection_options).toEqual({ fields: 'eventually_due' });
    expect(link.url).toContain(accountId);
    expect(Date.parse(link.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('points both URLs at this API, carrying a signed state', async () => {
    const seller = owner('urls');
    expectAccountId('urls');
    await accountService.createOnboardingLink({ owner: seller, country: 'ES' });

    const [params] = stripeApi.links;
    const refresh = new URL(String(params?.refresh_url));
    const ret = new URL(String(params?.return_url));
    expect(refresh.origin).toBe('https://api.mercaria.test');
    expect(refresh.pathname).toBe('/stripe/onboarding/refresh');
    expect(ret.pathname).toBe('/stripe/onboarding/return');
    // The state is what a session-less return handler has instead of a
    // credential. Both URLs carry one and both are signed.
    expect(refresh.searchParams.get('state')).toBeTruthy();
    expect(ret.searchParams.get('state')).toBeTruthy();
  });

  it('mints a NEW link every time — Account Links are single-use', async () => {
    const seller = owner('remint');
    expectAccountId('remint');
    await accountService.createOnboardingLink({ owner: seller, country: 'ES' });
    await accountService.createOnboardingLink({ owner: seller, country: 'ES' });

    expect(stripeApi.links).toHaveLength(2);
    expect(stripeApi.created).toHaveLength(1);
    // Two links for one account must not share a state, or a captured one would
    // stay usable for the life of the second.
    const states = stripeApi.links.map((p) =>
      new URL(String(p.return_url)).searchParams.get('state'),
    );
    expect(states[0]).not.toBe(states[1]);
  });

  it('refuses to resume a revoked account', async () => {
    const seller = owner('revokedlink');
    const accountId = expectAccountId('revokedlink');
    await accountService.ensureConnectedAccount({ owner: seller, country: 'ES' });
    await accountService.revokeAccount(accountId);

    await expect(
      accountService.createOnboardingLink({ owner: seller, country: 'ES' }),
    ).rejects.toThrow(/disconnected from Mercaria/i);
  });
});

describe('syncAccountState', () => {
  it('flips a seller to ready when Stripe says the conjunction holds', async () => {
    const seller = owner('ready');
    const accountId = expectAccountId('ready');
    const created = await accountService.ensureConnectedAccount({ owner: seller, country: 'ES' });
    expect(created.onboardingState).toBe('action_required');
    expect(await providerAccounts.isSellerPaymentReady(`store:${seller.ownerId}`)).toBe(false);

    setAccountState(accountId, readyState());
    const synced = await accountService.syncAccountState(accountId);

    expect(synced?.onboardingState).toBe('ready');
    expect(synced?.payoutsEnabled).toBe(true);
    expect(synced?.transfersCapability).toBe('active');
    expect(synced?.defaultCurrency).toBe('EUR');
    expect(synced?.payoutScheduleInterval).toBe('daily');
    expect(synced?.payoutScheduleDelayDays).toBe(7);
    expect(synced?.activatedAt).not.toBeNull();
    expect(await providerAccounts.isSellerPaymentReady(`store:${seller.ownerId}`)).toBe(true);
  });

  it('takes readiness away when the account becomes restricted', async () => {
    // Issue #46, acceptance 5: a restricted account cannot silently keep
    // receiving new native orders.
    const seller = owner('restrict');
    const accountId = expectAccountId('restrict');
    await accountService.ensureConnectedAccount({ owner: seller, country: 'ES' });
    setAccountState(accountId, readyState());
    await accountService.syncAccountState(accountId);
    expect(await providerAccounts.isSellerPaymentReady(`store:${seller.ownerId}`)).toBe(true);

    setAccountState(accountId, {
      ...readyState(),
      payouts_enabled: false,
      requirements: {
        currently_due: ['company.tax_id'],
        eventually_due: ['company.tax_id'],
        past_due: ['company.tax_id'],
        pending_verification: [],
        disabled_reason: 'requirements.past_due',
        current_deadline: DEADLINE_EPOCH_MS / 1_000,
      },
    });
    const restricted = await accountService.syncAccountState(accountId);

    expect(restricted?.onboardingState).toBe('restricted');
    expect(restricted?.requirementsPastDue).toBe(1);
    expect(restricted?.disabledReasonCodes).toEqual(['requirements.past_due']);
    // Round-tripped through `timestamptz` — Stripe reports SECONDS, and reading
    // them as milliseconds puts every deadline in 1970 with nothing complaining.
    expect(restricted?.requirementsDeadlineAt?.toISOString()).toBe(
      new Date(DEADLINE_EPOCH_MS).toISOString(),
    );
    expect(await providerAccounts.isSellerPaymentReady(`store:${seller.ownerId}`)).toBe(false);
    // The activation date survives losing readiness: it records when the seller
    // FIRST became able to sell, which is the question a marketplace is asked.
    expect(restricted?.activatedAt).not.toBeNull();
  });

  it('refuses to apply an observation older than the one already stored', async () => {
    const seller = owner('monotonic');
    // Registers the id the fake will mint; this case drives the repository
    // directly afterwards, so it never needs the id itself.
    expectAccountId('monotonic');
    const created = await accountService.ensureConnectedAccount({ owner: seller, country: 'ES' });

    const { applyProviderAccountState } = await import(
      '../../../../db/payments/providerAccountRepository.js'
    );
    const base = {
      chargesEnabled: true,
      payoutsEnabled: true,
      transfersCapability: 'active' as const,
      requirementsCurrentlyDue: 0,
      requirementsEventuallyDue: 0,
      requirementsPastDue: 0,
      requirementsPendingVerification: 0,
      disabledReasonCodes: [],
    };
    const newer = new Date();
    const older = new Date(newer.getTime() - 60_000);

    const first = await applyProviderAccountState(db, {
      id: created.id,
      state: { ...base, onboardingState: 'ready', syncedAt: newer },
    });
    expect(first.applied).toBe(true);

    // A webhook whose Stripe read happened a minute earlier, delivered second.
    // Applying it would take readiness away on the strength of a stale snapshot.
    const stale = await applyProviderAccountState(db, {
      id: created.id,
      state: { ...base, payoutsEnabled: false, onboardingState: 'restricted', syncedAt: older },
    });
    expect(stale.applied).toBe(false);
    expect(stale.row.onboardingState).toBe('ready');
    expect((await readRow(created.id))?.onboardingState).toBe('ready');
  });

  it('ignores an account id Mercaria has no row for', async () => {
    // Another environment's account, or one a rebuilt database lost. Inventing a
    // row would attribute a stranger's account to nobody.
    expect(await accountService.syncAccountState('acct_not_ours_at_all')).toBeUndefined();
  });
});

describe('revokeAccount', () => {
  it('disables the seller and stops their checkout groups', async () => {
    const seller = owner('deauth');
    const accountId = expectAccountId('deauth');
    await accountService.ensureConnectedAccount({ owner: seller, country: 'ES' });
    setAccountState(accountId, readyState());
    await accountService.syncAccountState(accountId);
    expect(await providerAccounts.isSellerPaymentReady(`store:${seller.ownerId}`)).toBe(true);

    const revoked = await accountService.revokeAccount(accountId);

    expect(revoked?.onboardingState).toBe('disabled');
    expect(revoked?.revokedAt).not.toBeNull();
    expect(revoked?.payoutsEnabled).toBe(false);
    expect(await providerAccounts.isSellerPaymentReady(`store:${seller.ownerId}`)).toBe(false);
  });

  it('cannot be undone by a sync that starts afterwards', async () => {
    const seller = owner('deauthrace');
    const accountId = expectAccountId('deauthrace');
    await accountService.ensureConnectedAccount({ owner: seller, country: 'ES' });
    setAccountState(accountId, readyState());
    await accountService.revokeAccount(accountId);

    const resynced = await accountService.syncAccountState(accountId);

    expect(resynced?.onboardingState).toBe('disabled');
    expect(await providerAccounts.isSellerPaymentReady(`store:${seller.ownerId}`)).toBe(false);
  });

  it('cannot be undone by a sync that was ALREADY IN FLIGHT', async () => {
    // The harder half, and the one the timestamp guard alone does not cover.
    // `syncAccountRow` reads the row, calls Stripe (up to twenty seconds), then
    // applies. A deauthorization landing inside that window leaves the in-flight
    // task holding a row whose `revoked_at` is still NULL and a healthy account
    // from Stripe — and its `synced_at` is LATER than the revocation, so the
    // compare-and-swap on time would let it through. It would then write `ready`
    // beside a set `revoked_at`, and the checkout gate would sell for a seller
    // Mercaria cannot pay.
    //
    // Reproduced by applying an observation captured before the revocation and
    // stamped after it, which is exactly what that ordering produces.
    const seller = owner('deauthinflight');
    const accountId = expectAccountId('deauthinflight');
    const created = await accountService.ensureConnectedAccount({ owner: seller, country: 'ES' });
    setAccountState(accountId, readyState());

    await accountService.revokeAccount(accountId);

    const { applyProviderAccountState } = await import(
      '../../../../db/payments/providerAccountRepository.js'
    );
    const inFlight = await applyProviderAccountState(db, {
      id: created.id,
      state: {
        onboardingState: 'ready',
        chargesEnabled: true,
        payoutsEnabled: true,
        transfersCapability: 'active',
        requirementsCurrentlyDue: 0,
        requirementsEventuallyDue: 0,
        requirementsPastDue: 0,
        requirementsPendingVerification: 0,
        disabledReasonCodes: [],
        // Deliberately in the future, so the ONLY thing that can refuse this
        // write is the revocation guard.
        syncedAt: new Date(Date.now() + 60_000),
      },
    });

    expect(inFlight.applied).toBe(false);
    expect(inFlight.row.onboardingState).toBe('disabled');
    expect((await readRow(created.id))?.onboardingState).toBe('disabled');
    expect(await providerAccounts.isSellerPaymentReady(`store:${seller.ownerId}`)).toBe(false);
  });

  it('is idempotent — a redelivered deauthorization changes nothing', async () => {
    const seller = owner('deauthtwice');
    const accountId = expectAccountId('deauthtwice');
    await accountService.ensureConnectedAccount({ owner: seller, country: 'ES' });

    const first = await accountService.revokeAccount(accountId);
    const second = await accountService.revokeAccount(accountId);

    expect(second?.revokedAt?.getTime()).toBe(first?.revokedAt?.getTime());
  });
});

describe('reconciliation', () => {
  it('converges an account whose webhook never arrived', async () => {
    // Issue #46, acceptance 3: `account.updated` and periodic reconciliation
    // reach the SAME local readiness. Here the webhook is simply never
    // delivered, which is the case the sweep exists for and the one nothing
    // else can notice.
    const seller = owner('sweep');
    const accountId = expectAccountId('sweep');
    const created = await accountService.ensureConnectedAccount({ owner: seller, country: 'ES' });
    setAccountState(accountId, readyState());

    // Nothing told Mercaria, so the row still says what creation stored.
    expect((await readRow(created.id))?.onboardingState).toBe('action_required');

    // `staleAfterMs: -1` puts every account past its deadline, so the sweep
    // reaches this run's rows without waiting six hours.
    await reconciler.reconcileStaleAccounts({ staleAfterMs: -1, batchSize: 200 });

    expect((await readRow(created.id))?.onboardingState).toBe('ready');
    expect(await providerAccounts.isSellerPaymentReady(`store:${seller.ownerId}`)).toBe(true);
  });

  it('skips revoked accounts, which cannot be read any more', async () => {
    const seller = owner('sweeprevoked');
    const accountId = expectAccountId('sweeprevoked');
    const created = await accountService.ensureConnectedAccount({ owner: seller, country: 'ES' });
    setAccountState(accountId, readyState());
    await accountService.revokeAccount(accountId);
    stripeApi.retrieved.length = 0;

    await reconciler.reconcileStaleAccounts({ staleAfterMs: -1, batchSize: 500 });

    // The exclusion asserted directly, not inferred from a count: the sweep
    // never ASKED Stripe about it. Every call for a revoked account would fail
    // anyway — the platform's authorisation is gone — so a sweep that included
    // them would spend its whole budget on accounts that can never answer.
    expect(stripeApi.retrieved).not.toContain(accountId);
    // And the healthy state registered above did not sneak back in.
    expect((await readRow(created.id))?.onboardingState).toBe('disabled');
  });
});

describe('the status projection', () => {
  it('says nothing about a seller who never started', async () => {
    const status = await providerAccounts.readSellerAccountStatus(owner('none'));
    expect(status.onboardingState).toBe('not_connected');
    expect(status.paymentReady).toBe(false);
    expect(status.country).toBeUndefined();
  });

  it('never carries the provider account id, in any form', async () => {
    const seller = owner('projection');
    const accountId = expectAccountId('projection');
    await accountService.ensureConnectedAccount({ owner: seller, country: 'ES' });
    setAccountState(accountId, readyState());
    await accountService.syncAccountState(accountId);

    const settings = await accountService.readSellerPaymentSettings(seller);

    // Two assertions and both are needed: the first names the key that must not
    // exist, the second catches it arriving under any OTHER name — which is what
    // a future `...spread` of the row would do.
    expect(settings.account).not.toHaveProperty('providerAccountId');
    expect(JSON.stringify(settings)).not.toContain(accountId);

    expect(settings.account.paymentReady).toBe(true);
    expect(settings.account.payoutCurrency).toBe('EUR');
    expect(settings.account.payoutSchedule).toEqual({ interval: 'daily', delayDays: 7 });
    expect(settings.onboardingAvailable).toBe(true);
    expect(settings.supportedCountries).toEqual(['ES', 'FR']);
  });
});

describe('the checkout readiness gate', () => {
  it('refuses an unready seller and names their group', async () => {
    const ready = owner('gateready');
    const unready = owner('gateunready');
    const readyAccount = expectAccountId('gateready');
    await accountService.ensureConnectedAccount({ owner: ready, country: 'ES' });
    setAccountState(readyAccount, readyState());
    await accountService.syncAccountState(readyAccount);
    expectAccountId('gateunready');
    await accountService.ensureConnectedAccount({ owner: unready, country: 'ES' });

    const keys = [`store:${ready.ownerId}`, `store:${unready.ownerId}`];
    // The message is the only channel a MercariaError has, and the buyer needs
    // the KEY to deselect that group through the existing partial-checkout
    // mechanism — so naming it is a contract, not a nicety.
    await expect(providerAccounts.assertSellerGroupsPaymentReady(keys)).rejects.toThrow(
      new RegExp(`store:${unready.ownerId}`),
    );
  });

  it('permits a group whose sellers are all ready', async () => {
    const seller = owner('gatepass');
    const accountId = expectAccountId('gatepass');
    await accountService.ensureConnectedAccount({ owner: seller, country: 'ES' });
    setAccountState(accountId, readyState());
    await accountService.syncAccountState(accountId);

    await expect(
      providerAccounts.assertSellerGroupsPaymentReady([`store:${seller.ownerId}`]),
    ).resolves.toBeUndefined();
  });

  it('refuses a seller with no account at all', async () => {
    const seller = owner('gatenone');
    await expect(
      providerAccounts.assertSellerGroupsPaymentReady([`store:${seller.ownerId}`]),
    ).rejects.toThrow(/cannot accept payment/i);
  });

  it('refuses a seller key it cannot parse rather than looking one up', async () => {
    // A key shape this version does not understand is not a seller. Guessing
    // would turn malformed input into a lookup for the WRONG owner.
    await expect(
      providerAccounts.assertSellerGroupsPaymentReady(['definitely-not-a-seller-key']),
    ).rejects.toThrow(/cannot accept payment/i);
    expect(providerAccounts.parseSellerKey('definitely-not-a-seller-key')).toBeUndefined();
    expect(providerAccounts.parseSellerKey('store:')).toBeUndefined();
    expect(providerAccounts.parseSellerKey(':abc')).toBeUndefined();
    expect(providerAccounts.parseSellerKey('user:abc')).toEqual({
      ownerType: 'user',
      ownerId: 'abc',
    });
    // An Oxy id containing a colon still round-trips: the split is on the FIRST
    // separator, not every one.
    expect(providerAccounts.parseSellerKey('user:a:b')).toEqual({
      ownerType: 'user',
      ownerId: 'a:b',
    });
  });
});

describe('the audit trail', () => {
  it('records creation and every transition as outbox events', async () => {
    const seller = owner('audit');
    const accountId = expectAccountId('audit');
    const created = await accountService.ensureConnectedAccount({ owner: seller, country: 'ES' });
    setAccountState(accountId, readyState());
    await accountService.syncAccountState(accountId);
    await accountService.revokeAccount(accountId);

    const rows = await db
      .select({ id: schema.paymentOutboxes.id, payload: schema.paymentOutboxes.payload })
      .from(schema.paymentOutboxes)
      .where(eq(schema.paymentOutboxes.eventType, 'provider_account_changed'));
    const mine = rows.filter(
      (row) => (row.payload as { accountRowId?: string }).accountRowId === created.id,
    );

    // Created → ready → disabled. Three transitions, three durable records: an
    // id keyed only on the destination state could not represent a seller who
    // returns to one they have held before.
    expect(mine.map((row) => (row.payload as { onboardingState?: string }).onboardingState)).toEqual(
      expect.arrayContaining(['action_required', 'ready', 'disabled']),
    );
    // Ids, never a provider payload and never a contact value.
    for (const row of mine) {
      expect(JSON.stringify(row.payload)).not.toContain(accountId);
    }
  });
});
