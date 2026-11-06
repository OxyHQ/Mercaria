/**
 * FairCoin on the marketplace, end to end against a real database (ADR 0019).
 *
 * A seller opens their FairCoin half (no key, their own Oxy account receives),
 * confirms it on Peable's page, and a buyer pricing in FAIR checks out: the
 * payment is an on-behalf FairCoin PaymentIntent paying THAT seller's wallet,
 * the order carries no marketplace fee, and its success pays the order while
 * booking nothing and transferring nothing — the coins are the seller's. Every
 * reason FairCoin cannot be paid is a refusal the buyer is shown, before any
 * stock is reserved.
 *
 * The gateway is the shared fake (`fake-peable-gateway.ts`); everything else —
 * the checkout, the readiness gate, the ingress, the outbox, settlement and the
 * ledger — is the real code on a real database.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../../queue/producers.js', () => ({
  enqueueOrderEvent: vi.fn(async () => undefined),
  enqueueFulfillmentPush: vi.fn(async () => undefined),
  enqueueLowInventoryAlert: vi.fn(async () => undefined),
  enqueueRecomputeAggregate: vi.fn(async () => undefined),
}));

const gateway = await vi.hoisted(async () =>
  (await import('../payments/__tests__/helpers/fake-peable-gateway.js')).createFakePeableGateway(),
);
vi.mock('../payments/peable/client.js', () => gateway.clientModule());

const WEBHOOK_SECRET = 'pwhsec_checkout_faircoin_not_a_real_one';
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

type Database = import('../../db/postgres.js').Database;
let db: Database;
let closePostgres: typeof import('../../db/postgres.js').closePostgres;
let checkout: typeof import('../checkout.service.js').checkout;
let ingestPeableDelivery: typeof import('../payments/peable/ingress.js').ingestPeableDelivery;
let accounts: typeof import('../payments/peable/accounts.js');
let resetFaircoinNetworkCache: typeof import('../payments/peable/faircoin-network.js').resetFaircoinNetworkCache;
let insertVariants: typeof import('../../db/catalog/variantRepository.js').insertVariants;
let insertAddress: typeof import('../../db/buyers/addressRepository.js').insertAddress;
let ensureCart: typeof import('../../db/buyers/cartRepository.js').ensureCart;
let upsertCartItem: typeof import('../../db/buyers/cartRepository.js').upsertCartItem;
let ensureSellerProfile: typeof import('../../db/buyers/sellerProfileRepository.js').ensureSellerProfile;
let upsertUserPreference: typeof import('../../db/buyers/userPreferenceRepository.js').upsertUserPreference;
let findNativePaymentByCheckoutGroupId: typeof import('../../db/payments/paymentRepository.js').findNativePaymentByCheckoutGroupId;
let findOrdersInCheckoutGroup: typeof import('../../db/orders/orderRepository.js').findOrdersInCheckoutGroup;
let catalogSchema: typeof import('../../db/schema/catalog.js');
let paymentSchema: typeof import('../../db/schema/payments.js');
let ledgerSchema: typeof import('../../db/schema/ledger.js');
let feeSchema: typeof import('../../db/schema/fees.js');

beforeAll(async () => {
  process.env.PEABLE_ENABLED = 'true';
  process.env.PEABLE_BASE_URL = 'https://api.peable.invalid';
  process.env.PEABLE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  delete process.env.PEABLE_WEBHOOK_SECRET_PREVIOUS;
  delete process.env.PEABLE_FAIRCOIN_NETWORK;
  process.env.PEABLE_PRESENTMENT_CURRENCIES = 'USD';
  process.env.FX_PROVIDER = 'static';

  const postgres = await import('../../db/postgres.js');
  closePostgres = postgres.closePostgres;
  db = await postgres.connectPostgres();

  ({ checkout } = await import('../checkout.service.js'));
  ({ ingestPeableDelivery } = await import('../payments/peable/ingress.js'));
  accounts = await import('../payments/peable/accounts.js');
  ({ resetFaircoinNetworkCache } = await import('../payments/peable/faircoin-network.js'));
  ({ insertVariants } = await import('../../db/catalog/variantRepository.js'));
  ({ insertAddress } = await import('../../db/buyers/addressRepository.js'));
  ({ ensureCart, upsertCartItem } = await import('../../db/buyers/cartRepository.js'));
  ({ ensureSellerProfile } = await import('../../db/buyers/sellerProfileRepository.js'));
  ({ upsertUserPreference } = await import('../../db/buyers/userPreferenceRepository.js'));
  ({ findNativePaymentByCheckoutGroupId } = await import('../../db/payments/paymentRepository.js'));
  ({ findOrdersInCheckoutGroup } = await import('../../db/orders/orderRepository.js'));
  catalogSchema = await import('../../db/schema/catalog.js');
  paymentSchema = await import('../../db/schema/payments.js');
  ledgerSchema = await import('../../db/schema/ledger.js');
  feeSchema = await import('../../db/schema/fees.js');
}, 120_000);

afterAll(async () => {
  await closePostgres();
});

beforeEach(() => {
  gateway.reset();
  resetFaircoinNetworkCache();
});

/** A P2P seller with one FAIR-priced listing, and no payment account yet. */
async function seedSeller(label: string) {
  const sellerId = `fair-seller-${RUN}-${label}`;
  await ensureSellerProfile(sellerId);
  const [listing] = await db
    .insert(catalogSchema.listings)
    .values({
      ownerType: 'user',
      oxyUserId: sellerId,
      title: `Fair thing ${label}`,
      description: '',
      condition: 'used_good',
      conditionAssertion: 'seller_declared',
      status: 'active',
    })
    .returning();
  if (!listing) throw new Error('listing insert returned nothing');
  const [variant] = await insertVariants(listing.id, [
    {
      title: 'Default',
      priceAmount: 250_000_000, // 2.5 ⊜
      priceCurrency: 'FAIR',
      inventoryTracked: true,
      inventoryAvailable: 5,
      position: 0,
      optionValues: [],
    },
  ]);
  if (!variant) throw new Error('variant insert returned nothing');
  return { sellerId, owner: { ownerType: 'user' as const, ownerId: sellerId }, listing, variant };
}

/** A buyer reading prices in FAIR — the marketplace's default — with that line in their cart. */
async function seedBuyer(
  label: string,
  lines: { listingId: string; variantId: string; quantity: number }[],
) {
  const buyerId = `fair-buyer-${RUN}-${label}`;
  await upsertUserPreference(buyerId, { preferredCurrency: 'FAIR' });
  const address = await insertAddress(buyerId, {
    recipientName: 'Buyer',
    line1: '1 Street',
    city: 'Barcelona',
    postalCode: '08001',
    country: 'ES',
  });
  const cart = await ensureCart({ kind: 'oxy_user', oxyUserId: buyerId });
  for (const line of lines) await upsertCartItem(cart.id, line);
  return { actor: { kind: 'oxy' as const, oxyUserId: buyerId }, addressId: address.id };
}

/** Open the seller's FairCoin half through the REAL onboarding path, and confirm it as the seller would. */
async function confirmedFaircoinSeller(label: string) {
  const seller = await seedSeller(label);
  await accounts.createSellerFaircoinLink({ owner: seller.owner, receiver: seller.sellerId });
  const [account] = await db
    .select()
    .from(paymentSchema.providerAccounts)
    .where(eq(paymentSchema.providerAccounts.ownerId, seller.sellerId));
  if (!account) throw new Error('no provider account row');
  gateway.confirmFaircoin(account.providerAccountId);
  await accounts.syncPeableAccount(account.providerAccountId);
  return { ...seller, providerAccountId: account.providerAccountId };
}

describe("a seller's FairCoin half (ADR 0019 D2)", () => {
  it("opens with the seller's own Oxy account, no key, and is payable only once the seller confirms", async () => {
    const seller = await seedSeller('onboard');

    const link = await accounts.createSellerFaircoinLink({
      owner: seller.owner,
      receiver: seller.sellerId,
    });
    expect(link.url).toMatch(/^https:\/\//);
    // The account names the receiving Oxy account and the chain; nothing else
    // about where the money goes is sent (there is no key, Peable ADR 0021 D5).
    expect(gateway.state.accountCalls.at(-1)?.params).toEqual({
      external_ref: `user:${seller.sellerId}`,
      faircoin: { network: 'testnet', oxy_user_id: seller.sellerId },
    });
    expect(gateway.state.linkCalls.at(-1)?.params).toMatchObject({ rail: 'faircoin' });

    const pending = await accounts.readSellerPaymentSettings(seller.owner);
    expect(pending.faircoin).toEqual({
      state: 'pending',
      network: 'testnet',
      payable: false,
      unavailableReason: 'seller_not_confirmed',
      receivingOxyAccountId: seller.sellerId,
    });
    // A FairCoin-only seller has no card half to be "in progress" on.
    expect(pending.account.onboardingState).toBe('not_connected');

    const [row] = await db
      .select()
      .from(paymentSchema.providerAccounts)
      .where(eq(paymentSchema.providerAccounts.ownerId, seller.sellerId));
    if (!row) throw new Error('no provider account row');
    expect(row.country).toBeNull();
    gateway.confirmFaircoin(row.providerAccountId);
    await accounts.syncPeableAccount(row.providerAccountId);

    const active = await accounts.readSellerPaymentSettings(seller.owner);
    expect(active.faircoin).toMatchObject({ state: 'active', payable: true });
    expect(active.faircoin.unavailableReason).toBeUndefined();
  });

  it('refuses to re-point an opened half at a different Oxy account', async () => {
    const seller = await seedSeller('repoint');
    await accounts.createSellerFaircoinLink({ owner: seller.owner, receiver: seller.sellerId });
    await expect(
      accounts.createSellerFaircoinLink({ owner: seller.owner, receiver: 'someone-else' }),
    ).rejects.toThrow(/different Oxy account/);
  });
});

describe('a FAIR checkout is paid in FairCoin, to the seller (ADR 0019 D1, D3)', () => {
  it("creates an on-behalf FairCoin payment to the seller's wallet, with no marketplace fee", async () => {
    const seller = await confirmedFaircoinSeller('pay');
    const buyer = await seedBuyer('pay', [
      { listingId: seller.listing.id, variantId: seller.variant.id, quantity: 1 },
    ]);

    const result = await checkout(buyer.actor, { addressId: buyer.addressId });

    expect(result.payment?.rail).toBe('faircoin');
    expect(result.payment?.provider).toBe('peable_faircoin');
    expect(result.payment?.methods).toEqual([]);
    expect(result.payment?.faircoin).toMatchObject({
      network: 'testnet',
      amount: { currency: 'FAIR' },
    });
    const [call] = gateway.state.intentCalls;
    expect(call?.params).toMatchObject({
      rail: 'faircoin',
      currency: 'FAIR',
      network: 'testnet',
      connected_account: seller.providerAccountId,
    });
    expect(call?.params).not.toHaveProperty('payment_method_types');

    // 0% on FairCoin (ADR 0018): the fee is selected in the order's currency,
    // and no schedule covers FAIR, so the snapshot records none — at pricing,
    // not as a refund afterwards.
    const orders = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    expect(orders).toHaveLength(1);
    const snapshots = await db
      .select()
      .from(feeSchema.orderFeeSnapshots)
      .where(eq(feeSchema.orderFeeSnapshots.orderId, orders[0]?.id ?? ''));
    for (const snapshot of snapshots) expect(snapshot.result).not.toBe('calculated');

    // The payment succeeds: the order is paid, and nothing is booked or
    // transferred — the coins are already in the seller's own wallet.
    const payment = await findNativePaymentByCheckoutGroupId(db, result.checkoutGroupId);
    if (!payment?.providerObjectId) throw new Error('no FairCoin payment opened');
    expect(payment.provider).toBe('peable_faircoin');
    gateway.succeed(payment.providerObjectId);
    await ingestPeableDelivery(
      gateway.intentDelivery({
        eventId: `evt_fair_paid_${RUN}`,
        type: 'payment_intent.succeeded',
        intentId: payment.providerObjectId,
        secret: WEBHOOK_SECRET,
      }),
    );

    const paid = await findOrdersInCheckoutGroup(result.checkoutGroupId);
    expect(paid.map((order) => order.status)).toEqual(['paid']);
    const ledger = await db
      .select()
      .from(ledgerSchema.ledgerTransactions)
      .where(eq(ledgerSchema.ledgerTransactions.paymentId, payment.id));
    expect(ledger).toEqual([]);
    const transfers = await db
      .select()
      .from(paymentSchema.transfers)
      .where(eq(paymentSchema.transfers.paymentId, payment.id));
    expect(transfers).toEqual([]);
    expect(gateway.state.transferCalls).toEqual([]);
  });

  it('refuses, before reserving, a seller who never opened FairCoin — naming why', async () => {
    const seller = await seedSeller('unopened');
    const buyer = await seedBuyer('unopened', [
      { listingId: seller.listing.id, variantId: seller.variant.id, quantity: 1 },
    ]);

    await expect(checkout(buyer.actor, { addressId: buyer.addressId })).rejects.toMatchObject({
      details: { reason: 'faircoin_unavailable', unavailableReason: 'seller_not_connected' },
    });
    expect(gateway.state.intentCalls).toEqual([]);
    const [variant] = await db
      .select()
      .from(catalogSchema.productVariants)
      .where(eq(catalogSchema.productVariants.id, seller.variant.id));
    expect(variant?.inventoryCommitted).toBe(0);
  });

  it("refuses while Peable's network gate is closed, and says so", async () => {
    const seller = await confirmedFaircoinSeller('closed');
    const buyer = await seedBuyer('closed', [
      { listingId: seller.listing.id, variantId: seller.variant.id, quantity: 1 },
    ]);
    gateway.state.faircoinConfigurationReason = 'faircoin_network_closed';

    await expect(checkout(buyer.actor, { addressId: buyer.addressId })).rejects.toMatchObject({
      details: { reason: 'faircoin_unavailable', unavailableReason: 'faircoin_network_closed' },
    });
    expect(gateway.state.intentCalls).toEqual([]);
    expect((await accounts.readSellerPaymentSettings(seller.owner)).faircoin).toMatchObject({
      payable: false,
      unavailableReason: 'faircoin_network_closed',
    });
  });

  it('refuses a FAIR cart of two sellers: one FairCoin payment pays one wallet', async () => {
    const first = await confirmedFaircoinSeller('two-a');
    const second = await confirmedFaircoinSeller('two-b');
    const buyer = await seedBuyer('two', [
      { listingId: first.listing.id, variantId: first.variant.id, quantity: 1 },
      { listingId: second.listing.id, variantId: second.variant.id, quantity: 1 },
    ]);

    await expect(checkout(buyer.actor, { addressId: buyer.addressId })).rejects.toMatchObject({
      details: { reason: 'faircoin_one_seller_per_checkout' },
    });
    expect(gateway.state.intentCalls).toEqual([]);
  });
});
