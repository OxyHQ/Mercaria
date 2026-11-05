/**
 * Seller onboarding on the Peable rail: a store or a P2P seller becomes a
 * Peable CONNECTED ACCOUNT of Mercaria's merchant (Peable ADR 0012), and
 * Mercaria's `provider_accounts` row mirrors it.
 *
 * This is the only module that knows what a Peable connected account looks
 * like. It reduces one to an {@link AccountSnapshot}; the verdict is derived in
 * `../account-readiness.ts` and written through `providerAccountRepository`, and
 * everything downstream — the checkout gate, the dashboard projection, the
 * payout records — reads the verdict and never the account.
 *
 * ## Mercaria opens the account; the SELLER onboards it
 *
 * Mercaria creates the account and mints a single-use hosted-onboarding link
 * with its own merchant identity. The seller completes the acquirer's hosted
 * flow in their own browser: identity data is collected and held there (ADR
 * 0001 D2) and never passes through Mercaria. Only the CARD half is opened. A
 * seller's FairCoin key may come only from the seller's own Oxy session
 * (Peable ADR 0012), and Mercaria's checkout has no FairCoin rail, so the
 * FairCoin half is never requested here.
 *
 * ## Every writer re-reads; none applies a payload
 *
 * `connected_account.updated`, the create path and the seller's own refresh
 * all end at {@link applyAccount} with an account READ from the gateway. An
 * event body is a snapshot of a moment that has passed and deliveries are
 * unordered, so applying a retried delivery's payload would restore
 * requirements the seller has since satisfied. The repository's
 * compare-and-swap on the observation time keeps a slower read from
 * overwriting a fresher one.
 *
 * ## The one thing a unique index cannot undo
 *
 * An account at the gateway cannot be deleted. Peable converges a repeated
 * create on `external_ref` (the seller key, `store:<id>` / `user:<id>`), so two
 * racing onboarding clicks are answered with ONE account, and the
 * `provider_accounts` owner index is the second line rather than the first.
 *
 * ## A return to `return_url` proves nothing
 *
 * The link sends the seller back to Mercaria's own settings screen, composed
 * here from configuration and never from a request. Arriving there means the
 * browser came back; readiness comes only from a read of the account.
 */

import type {
  ProviderCapabilityStatus,
  ProviderOnboardingLink,
  ProviderOnboardingState,
  SellerPaymentSettings,
} from '@mercaria/shared-types';
import { type ConnectedAccount, type Peable, PeableError } from '@peable.to/sdk';
import { config } from '../../../config/index.js';
import { getDb } from '../../../db/postgres.js';
import {
  applyProviderAccountState,
  findProviderAccountByOwner,
  findProviderAccountByProviderId,
  insertProviderAccount,
  type ProviderAccountRow,
} from '../../../db/payments/providerAccountRepository.js';
import { serviceUnavailable, validationError } from '../../../lib/errors/error-codes.js';
import { log } from '../../../lib/logger.js';
import { type AccountSnapshot, safeReasonCodes, toAccountState } from '../account-readiness.js';
import { enqueuePaymentEvent, providerAccountChangedEventId } from '../payment-outbox.service.js';
import {
  readSellerAccountStatus,
  type SellerAccountOwner,
  sellerKeyFor,
} from '../provider-account.service.js';
import { callPeable } from './errors.js';
import { createPeableClient } from './client.js';

let client: Peable | undefined;

/**
 * The one Peable client the marketplace's non-payment calls share — seller
 * accounts here, and the event handlers that re-read payouts, refunds and
 * disputes (`marketplace-events.ts`).
 *
 * Built on first use from `createPeableClient()` (the one module that reaches
 * the gateway, which suites replace with the fake gateway), so a deployment
 * without the rail never builds it. `PeablePaymentProvider` holds its own
 * instance from the same factory.
 */
export function peableGateway(): Peable {
  client ??= createPeableClient();
  return client;
}

/** A capability status, or `undefined` for one that was never requested. */
function capability(value: string | null): ProviderCapabilityStatus | undefined {
  return value === 'active' || value === 'inactive' || value === 'pending' ? value : undefined;
}

/**
 * Reduce a Peable connected account to what Mercaria stores.
 *
 * The requirement ARRAYS are counted and thrown away — a count says "three
 * things are outstanding" and the hosted flow says which three, in the one
 * place that is allowed to know (ADR 0001 D2).
 */
export function snapshotPeableAccount(account: ConnectedAccount): AccountSnapshot {
  const transfers = capability(account.transfers_capability);
  return {
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    ...(transfers ? { transfersCapability: transfers } : {}),
    payable: account.payable,
    currentlyDue: account.requirements.currently_due.length,
    eventuallyDue: account.requirements.eventually_due.length,
    pastDue: account.requirements.past_due.length,
    pendingVerification: account.requirements.pending_verification.length,
    disabledReasonCodes: safeReasonCodes(account.requirements.disabled_reason),
    ...(account.default_currency
      ? { defaultCurrency: account.default_currency.toUpperCase() }
      : {}),
  };
}

/**
 * The gateway's account id as it may appear in a log line: `ca_…a1b2`.
 *
 * Not a secret, and still shortened — a full id in an aggregated log is a
 * durable link between a log store and one seller's finances (#46, security 4).
 */
export function redactAccountId(accountId: string): string {
  return accountId.length <= 4 ? accountId : `${accountId.slice(0, 3)}…${accountId.slice(-4)}`;
}

/** Where the hosted flow sends this seller back to — server-composed, never a client's. */
function returnUrlFor(owner: SellerAccountOwner): string {
  return owner.ownerType === 'store'
    ? `${config.web.dashboardOrigin}/settings/payments`
    : `${config.web.origin.replace(/\/+$/, '')}/settings/payments`;
}

/**
 * A gateway failure, as the seller-facing surface reports it.
 *
 * A country the gateway cannot onboard is the seller's to change and is said
 * plainly; everything else is the gateway's, and the seller is told to try
 * again rather than shown the gateway's own message, which is written for an
 * integrator.
 */
function refusal(error: unknown, country?: string): Error {
  if (error instanceof PeableError && error.statusCode === 400 && error.param === 'country') {
    return validationError(
      `Sellers in ${country ?? 'this country'} cannot be onboarded for payments yet.`,
    );
  }
  log.general.error(
    {
      statusCode: error instanceof PeableError ? error.statusCode : undefined,
      code: error instanceof PeableError ? error.code : undefined,
    },
    '[Peable] a connected-account call failed',
  );
  return serviceUnavailable('The payment gateway could not be reached; try again shortly.');
}

/** The durable audit record of a readiness change (`provider_account_changed`). */
async function recordAccountChange(input: {
  row: ProviderAccountRow;
  previousState: ProviderOnboardingState;
  reason: 'created' | 'synced';
  at: Date;
}): Promise<void> {
  await enqueuePaymentEvent(getDb(), {
    id: providerAccountChangedEventId(input.row.id, input.row.onboardingState, input.at),
    eventType: 'provider_account_changed',
    payload: {
      accountRowId: input.row.id,
      ownerType: input.row.ownerType,
      ownerId: input.row.ownerId,
      previousState: input.previousState,
      onboardingState: input.row.onboardingState,
      reason: input.reason,
    },
  });
}

/**
 * Apply an account READ from the gateway to its row, announcing a change of
 * verdict.
 *
 * Announced only when THIS observation was applied and moved the verdict: a
 * concurrent, fresher read that won the compare-and-swap has already announced
 * whatever it changed.
 */
async function applyAccount(input: {
  row: ProviderAccountRow;
  account: ConnectedAccount;
  syncedAt: Date;
  reason: 'created' | 'synced';
}): Promise<ProviderAccountRow> {
  const { row, applied } = await applyProviderAccountState(getDb(), {
    id: input.row.id,
    state: toAccountState(snapshotPeableAccount(input.account), input.syncedAt),
  });
  const previousState = input.reason === 'created' ? 'not_connected' : input.row.onboardingState;
  if (applied && row.onboardingState !== previousState) {
    log.general.info(
      {
        accountRowId: row.id,
        ownerType: row.ownerType,
        ownerId: row.ownerId,
        providerAccountId: redactAccountId(row.providerAccountId),
        from: previousState,
        to: row.onboardingState,
      },
      '[Peable] seller payment readiness changed',
    );
    await recordAccountChange({ row, previousState, reason: input.reason, at: input.syncedAt });
  }
  return row;
}

/**
 * The seller's connected account, opening one only if they have none.
 *
 * @param country Required only when no account exists; ignored afterwards —
 *   it is immutable at the acquirer, and quietly "updating" it would be a lie
 *   the row could not act on.
 */
async function ensureSellerAccount(
  owner: SellerAccountOwner,
  country: string | undefined,
): Promise<ProviderAccountRow> {
  const db = getDb();
  const existing = await findProviderAccountByOwner(db, { provider: 'peable', ...owner });
  if (existing) return existing;

  if (country === undefined) {
    throw validationError('Choose the country your business is based in to start onboarding.');
  }
  const normalized = country.trim().toUpperCase();

  let account: ConnectedAccount;
  try {
    account = await peableGateway().connectedAccounts.create(
      {
        external_ref: sellerKeyFor(owner),
        country: normalized,
        // A store is a business and a P2P seller is a person. The hosted flow
        // refines this (a sole trader may end up an individual either way), so
        // it shortens the flow rather than asserting anything.
        business_type: owner.ownerType === 'store' ? 'company' : 'individual',
      },
      // Peable converges on `external_ref` whatever the key; the key makes a
      // retried request replay the same answer within its window too.
      { idempotencyKey: `acct:${sellerKeyFor(owner)}` },
    );
  } catch (error) {
    throw refusal(error, normalized);
  }

  const syncedAt = new Date();
  const row = await insertProviderAccount(db, {
    provider: 'peable',
    ownerType: owner.ownerType,
    ownerId: owner.ownerId,
    providerAccountId: account.id,
    // The account's own answer, which is what the acquirer created it in.
    country: account.country ?? normalized,
  });
  log.general.info(
    {
      accountRowId: row.id,
      ownerType: row.ownerType,
      providerAccountId: redactAccountId(row.providerAccountId),
      country: row.country,
    },
    '[Peable] seller connected account opened',
  );
  // The create's answer IS a read of the account, so the first render is the
  // real requirements rather than a row of defaults an event corrects later.
  return await applyAccount({ row, account, syncedAt, reason: 'created' });
}

/**
 * Whether this deployment can start or resume onboarding at all.
 *
 * The rail must be on: an account opened on a deployment that cannot charge
 * would show the seller "ready" for a checkout that does not exist.
 */
function onboardingAvailable(): boolean {
  return config.payments.peable.enabled;
}

/** The seller-facing payments settings: their standing plus what this deployment can do. */
export async function readSellerPaymentSettings(
  owner: SellerAccountOwner,
): Promise<SellerPaymentSettings> {
  return {
    account: await readSellerAccountStatus(owner),
    onboardingAvailable: onboardingAvailable(),
  };
}

/**
 * A fresh hosted-onboarding link for this seller, opening their account first
 * if this is the first time.
 *
 * Minted per request and never stored: single-use and minutes long. Both URLs
 * are the seller's own settings screen — `refresh_url` (the link expired) and
 * `return_url` (they left the flow) are the same answer, a screen that re-reads
 * the account and offers to mint another link.
 */
export async function createSellerOnboardingLink(input: {
  owner: SellerAccountOwner;
  country?: string;
}): Promise<ProviderOnboardingLink> {
  if (!onboardingAvailable()) {
    throw serviceUnavailable('Card payments are not available on this deployment yet.');
  }
  const row = await ensureSellerAccount(input.owner, input.country);
  const url = returnUrlFor(input.owner);
  try {
    const link = await peableGateway().connectedAccounts.createAccountLink(
      row.providerAccountId,
      { refresh_url: url, return_url: url, rail: 'card' },
      // Deliberately NO durable key: a link is single-use, so a retry must mint
      // a new one rather than replay a link that may already have been opened.
    );
    log.general.info(
      {
        accountRowId: row.id,
        ownerType: row.ownerType,
        providerAccountId: redactAccountId(row.providerAccountId),
      },
      '[Peable] seller onboarding link minted',
    );
    return { url: link.url, expiresAt: new Date(link.expires_at * 1_000).toISOString() };
  } catch (error) {
    throw refusal(error);
  }
}

/**
 * Re-read the seller's account NOW, for a seller watching their settings
 * screen after coming back from the hosted flow.
 *
 * `refresh` asks the gateway to read the acquirer rather than answer from its
 * own copy — the same read its sweep and inbound events make, on demand.
 */
export async function refreshSellerAccount(
  owner: SellerAccountOwner,
): Promise<SellerPaymentSettings> {
  const row = await findProviderAccountByOwner(getDb(), { provider: 'peable', ...owner });
  if (row && onboardingAvailable()) {
    let account: ConnectedAccount;
    try {
      account = await peableGateway().connectedAccounts.refresh(row.providerAccountId, {});
    } catch (error) {
      throw refusal(error);
    }
    await applyAccount({ row, account, syncedAt: new Date(), reason: 'synced' });
  }
  return await readSellerPaymentSettings(owner);
}

/**
 * Re-read one connected account and apply what it says — the
 * `connected_account.updated` path.
 *
 * An id Mercaria has no row for is `undefined`, not an error: an account the
 * gateway opened for another environment, or one whose create answer this task
 * has not finished recording — and that create path applies its own read, so
 * nothing is lost by not inventing a row here.
 *
 * A gateway failure is classified like every other Peable call, so the event
 * drain retries what can succeed and dead-letters what cannot.
 */
export async function syncPeableAccount(
  providerAccountId: string,
): Promise<ProviderAccountRow | undefined> {
  const row = await findProviderAccountByProviderId(getDb(), 'peable', providerAccountId);
  if (!row) return undefined;
  const account = await callPeable('getStatus', () =>
    peableGateway().connectedAccounts.retrieve(providerAccountId),
  );
  // Read AFTER the call returns, so the ordering key never claims an
  // observation is fresher than it is.
  return await applyAccount({ row, account, syncedAt: new Date(), reason: 'synced' });
}
