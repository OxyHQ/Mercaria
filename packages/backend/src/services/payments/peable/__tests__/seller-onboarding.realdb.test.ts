/**
 * Seller onboarding on the Peable rail, end to end against a REAL Postgres and
 * the shared fake gateway: a seller becomes a Peable connected account, the
 * hosted link comes back, and readiness reaches `provider_accounts` only from a
 * READ of the account — through the signed `/webhooks/peable` ingress and the
 * seller's own refresh.
 *
 * What is mocked is only `peable/client.js` (the one module that reaches the
 * gateway) and the config flags that switch the rail on. The account adapter,
 * the readiness derivation, the repository's compare-and-swap, the outbox and
 * the signed ingress are the real code.
 *
 * `provider_accounts` carries no foreign key to `stores` (a provider account
 * outlives the record it names), so owners here are bare ids unique to the run.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, like } from 'drizzle-orm';

const WEBHOOK_SECRET = 'whsec_seller_onboarding_not_a_real_one';

const gateway = await vi.hoisted(async () =>
  (await import('../../__tests__/helpers/fake-peable-gateway.js')).createFakePeableGateway(),
);

vi.mock('../../../../config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../config/index.js')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      web: {
        ...actual.config.web,
        origin: 'https://mercaria.test',
        dashboardOrigin: 'https://dashboard.mercaria.test',
      },
      payments: {
        ...actual.config.payments,
        peable: {
          ...actual.config.payments.peable,
          enabled: true,
          webhookSecret: 'whsec_seller_onboarding_not_a_real_one',
          webhooksEnabled: true,
          livemode: false,
        },
      },
    },
  };
});

vi.mock('../client.js', () => gateway.clientModule());

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

type Database = import('../../../../db/postgres.js').Database;
let db: Database;
let closePostgres: typeof import('../../../../db/postgres.js').closePostgres;
let accounts: typeof import('../accounts.js');
let ingestPeableDelivery: typeof import('../ingress.js').ingestPeableDelivery;
let isSellerPaymentReady: typeof import('../../provider-account.service.js').isSellerPaymentReady;
let findProviderAccountByOwner: typeof import('../../../../db/payments/providerAccountRepository.js').findProviderAccountByOwner;
let renderAccount: typeof import('../../__tests__/helpers/fake-peable-gateway.js').renderAccount;
let paymentSchema: typeof import('../../../../db/schema/payments.js');

beforeAll(async () => {
  const postgres = await import('../../../../db/postgres.js');
  db = await postgres.connectPostgres();
  ({ closePostgres } = postgres);
  accounts = await import('../accounts.js');
  ({ ingestPeableDelivery } = await import('../ingress.js'));
  ({ isSellerPaymentReady } = await import('../../provider-account.service.js'));
  ({ findProviderAccountByOwner } = await import(
    '../../../../db/payments/providerAccountRepository.js'
  ));
  ({ renderAccount } = await import('../../__tests__/helpers/fake-peable-gateway.js'));
  paymentSchema = await import('../../../../db/schema/payments.js');
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  gateway.reset();
});

let sequence = 0;
/** A store owner unique to this run and case. */
function store(): { ownerType: 'store'; ownerId: string } {
  sequence += 1;
  return { ownerType: 'store', ownerId: `store_${RUN}_${String(sequence)}` };
}

async function rowFor(owner: { ownerType: 'store' | 'user'; ownerId: string }) {
  return await findProviderAccountByOwner(db, { provider: 'peable', ...owner });
}

/** The readiness audit events this account produced, oldest first. */
async function accountChanges(accountRowId: string) {
  const rows = await db
    .select()
    .from(paymentSchema.paymentOutboxes)
    .where(
      and(
        eq(paymentSchema.paymentOutboxes.eventType, 'provider_account_changed'),
        like(paymentSchema.paymentOutboxes.id, `%:${accountRowId}:%`),
      ),
    );
  return rows.map((row) => row.payload as Record<string, unknown>);
}

/** Deliver `connected_account.updated` through the real signed ingress. */
async function deliverAccountUpdated(object: Record<string, unknown>) {
  sequence += 1;
  const delivery = gateway.objectDelivery({
    eventId: `evt_${RUN}_${String(sequence)}`,
    type: 'connected_account.updated',
    object,
    secret: WEBHOOK_SECRET,
  });
  const result = await ingestPeableDelivery(delivery);
  expect(result.outcome).toBe('accepted');
  if (result.outcome !== 'accepted') throw new Error('not accepted');
  const [event] = await db
    .select()
    .from(paymentSchema.paymentProviderEvents)
    .where(eq(paymentSchema.paymentProviderEvents.id, result.storedEventId));
  return event;
}

describe('opening a seller account', () => {
  it('opens ONE card account for a store and hands back a link to its own settings screen', async () => {
    const owner = store();

    const link = await accounts.createSellerOnboardingLink({ owner, country: 'es' });

    expect(gateway.state.accountCalls).toHaveLength(1);
    expect(gateway.state.accountCalls[0]?.params).toEqual({
      external_ref: `store:${owner.ownerId}`,
      country: 'ES',
      business_type: 'company',
    });
    expect(gateway.state.accountCalls[0]?.idempotencyKey).toBe(`acct:store:${owner.ownerId}`);

    const row = await rowFor(owner);
    expect(row).toMatchObject({
      provider: 'peable',
      country: 'ES',
      onboardingState: 'action_required',
      payoutsEnabled: false,
      requirementsCurrentlyDue: 3,
    });
    expect(row?.providerAccountId).toMatch(/^ca_/);

    expect(link.url).toContain(String(row?.providerAccountId));
    expect(Date.parse(link.expiresAt)).toBeGreaterThan(Date.now());
    expect(gateway.state.linkCalls[0]?.params).toEqual({
      refresh_url: 'https://dashboard.mercaria.test/settings/payments',
      return_url: 'https://dashboard.mercaria.test/settings/payments',
      rail: 'card',
    });

    const changes = await accountChanges(String(row?.id));
    expect(changes).toEqual([
      expect.objectContaining({
        previousState: 'not_connected',
        onboardingState: 'action_required',
        reason: 'created',
      }),
    ]);
  });

  it('converges a second click on the same account and mints a fresh link', async () => {
    const owner = store();
    const first = await accounts.createSellerOnboardingLink({ owner, country: 'ES' });
    // The picker is still on screen; a later country is ignored, not refused.
    const second = await accounts.createSellerOnboardingLink({ owner, country: 'FR' });

    expect(gateway.state.accountCalls).toHaveLength(1);
    expect(gateway.state.linkCalls).toHaveLength(2);
    expect(second.url).not.toBe(first.url);
    expect((await rowFor(owner))?.country).toBe('ES');
  });

  it('opens a P2P seller as an individual, returning them to the storefront', async () => {
    sequence += 1;
    const owner = { ownerType: 'user' as const, ownerId: `oxy_${RUN}_${String(sequence)}` };

    await accounts.createSellerOnboardingLink({ owner, country: 'ES' });

    expect(gateway.state.accountCalls[0]?.params).toMatchObject({
      external_ref: `user:${owner.ownerId}`,
      business_type: 'individual',
    });
    expect(gateway.state.linkCalls[0]?.params).toMatchObject({
      return_url: 'https://mercaria.test/settings/payments',
    });
  });

  it('asks for a country before opening anything', async () => {
    const owner = store();
    await expect(accounts.createSellerOnboardingLink({ owner })).rejects.toMatchObject({
      httpStatus: 400,
    });
    expect(gateway.state.accountCalls).toHaveLength(0);
    expect(await rowFor(owner)).toBeUndefined();
  });

  it("passes on the gateway's refusal of a country, writing nothing", async () => {
    const owner = store();
    gateway.state.refusedCountries.add('KP');

    await expect(
      accounts.createSellerOnboardingLink({ owner, country: 'KP' }),
    ).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining('KP') });
    expect(await rowFor(owner)).toBeUndefined();
  });

  it('reports a not-connected seller as a real settings answer, not an error', async () => {
    const owner = store();
    const settings = await accounts.readSellerPaymentSettings(owner);
    expect(settings).toEqual({
      onboardingAvailable: true,
      account: expect.objectContaining({
        provider: 'peable',
        onboardingState: 'not_connected',
        paymentReady: false,
      }),
    });
    expect(settings.account).not.toHaveProperty('providerAccountId');
  });
});

describe('readiness comes from a READ of the account', () => {
  it('turns a seller ready on connected_account.updated, and checkout admits them', async () => {
    const owner = store();
    await accounts.createSellerOnboardingLink({ owner, country: 'ES' });
    const row = await rowFor(owner);
    const accountId = String(row?.providerAccountId);
    expect(await isSellerPaymentReady(`store:${owner.ownerId}`)).toBe(false);

    gateway.completeOnboarding(accountId);
    const event = await deliverAccountUpdated(renderAccount(gateway.account(accountId)));

    expect(event?.status).toBe('processed');
    const ready = await rowFor(owner);
    expect(ready).toMatchObject({
      onboardingState: 'ready',
      payoutsEnabled: true,
      transfersCapability: 'active',
      defaultCurrency: 'EUR',
      requirementsCurrentlyDue: 0,
    });
    expect(ready?.activatedAt).toBeInstanceOf(Date);
    expect(await isSellerPaymentReady(`store:${owner.ownerId}`)).toBe(true);
    expect(await accountChanges(String(row?.id))).toContainEqual(
      expect.objectContaining({
        previousState: 'action_required',
        onboardingState: 'ready',
        reason: 'synced',
      }),
    );
  });

  it('never applies the payload: a stale "ready" body for a restricted account stays restricted', async () => {
    const owner = store();
    await accounts.createSellerOnboardingLink({ owner, country: 'ES' });
    const accountId = String((await rowFor(owner))?.providerAccountId);
    gateway.completeOnboarding(accountId);
    const staleReadyBody = renderAccount(gateway.account(accountId));
    // Since that body was rendered, a requirement went past due.
    gateway.updateAccount(accountId, {
      pastDue: ['external_account'],
      payable: false,
      payoutsEnabled: false,
      disabledReason: 'requirements.past_due',
    });

    await deliverAccountUpdated(staleReadyBody);

    expect((await rowFor(owner))?.onboardingState).toBe('restricted');
    expect(await isSellerPaymentReady(`store:${owner.ownerId}`)).toBe(false);
  });

  it('ignores an account Mercaria never opened, without retrying it', async () => {
    const stranger = renderAccount({
      id: `ca_stranger_${RUN}`,
      externalRef: 'someone-else',
      country: 'DE',
      defaultCurrency: 'EUR',
      payable: true,
      payoutsEnabled: true,
      chargesEnabled: true,
      transfersCapability: 'active',
      currentlyDue: [],
      eventuallyDue: [],
      pastDue: [],
      pendingVerification: [],
      disabledReason: null,
    });
    const event = await deliverAccountUpdated(stranger);
    expect(event?.status).toBe('processed');
    expect(event?.processingNote).toContain('not a seller account Mercaria opened');
  });

  it("re-reads on the seller's own refresh after the hosted flow", async () => {
    const owner = store();
    await accounts.createSellerOnboardingLink({ owner, country: 'ES' });
    const accountId = String((await rowFor(owner))?.providerAccountId);
    gateway.updateAccount(accountId, {
      currentlyDue: [],
      pastDue: [],
      pendingVerification: ['individual.verification.document'],
      transfersCapability: 'pending',
      disabledReason: null,
    });

    const settings = await accounts.refreshSellerAccount(owner);

    expect(settings.account).toMatchObject({
      onboardingState: 'under_review',
      paymentReady: false,
      requirements: { currentlyDue: 0, pendingVerification: 1 },
    });
  });
});
