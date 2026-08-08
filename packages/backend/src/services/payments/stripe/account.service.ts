/**
 * Connected accounts: creating one, onboarding into it, and keeping Mercaria's
 * copy of its state honest.
 *
 * This is the only module that knows what a Stripe account looks like. It maps
 * Stripe's vocabulary onto the closed sets in `@mercaria/shared-types` and
 * writes the result through `providerAccountRepository`; everything downstream —
 * the checkout gate, the dashboard projection, #49's payout records — reads the
 * verdict and never the account.
 *
 * ## Three writers, one shape
 *
 * `account.updated`, `account.external_account.updated` and the reconciliation
 * sweep all end at {@link syncAccountState}, which re-reads Stripe and applies
 * what it finds. That is what makes ADR 0001's sequence 6 converge: a webhook
 * Mercaria never received is indistinguishable, after the sweep, from one it
 * did. It is also why none of them interprets a webhook PAYLOAD — an
 * `account.updated` body is a snapshot of a moment that has passed, and Stripe
 * orders nothing, so applying a retried delivery's payload would restore
 * requirements the seller has since satisfied.
 *
 * ## The one thing that is NOT idempotent by retry, and what covers it
 *
 * A Mercaria row can be deduplicated by a unique index. An ACCOUNT AT STRIPE
 * cannot be un-created. So the duplicate-account defence is a Stripe idempotency
 * key derived from the OWNER (ADR 0001 D11 — a Mercaria durable id, never
 * request-scoped randomness): two concurrent onboarding clicks send the same key
 * and Stripe answers both with one account. The unique index is the second line,
 * not the first, and it is why the key is the owner rather than a freshly-minted
 * row id — two racing callers would mint two different row ids and therefore two
 * different keys, which is exactly the case the key exists to stop.
 */

import type Stripe from 'stripe';
import type {
  ProviderCapabilityStatus,
  ProviderOnboardingLink,
  ProviderOnboardingState,
  SellerPaymentSettings,
} from '@mercaria/shared-types';
import { config } from '../../../config/index.js';
import { getDb } from '../../../db/postgres.js';
import {
  applyProviderAccountState,
  findProviderAccountByOwner,
  findProviderAccountByProviderId,
  insertProviderAccount,
  revokeProviderAccount,
  type ProviderAccountRow,
  type ProviderAccountState,
} from '../../../db/payments/providerAccountRepository.js';
import { validationError } from '../../../lib/errors/error-codes.js';
import { log } from '../../../lib/logger.js';
import { enqueuePaymentEvent, providerAccountChangedEventId } from '../payment-outbox.service.js';
import {
  readSellerAccountStatus,
  type SellerAccountOwner,
} from '../provider-account.service.js';
import {
  createStripeAccountLink,
  createStripeConnectedAccount,
  retrieveStripeAccount,
} from './client.js';
import { isStripeOnboardingConfigured, stripeOnboardingConfig } from './onboarding-config.js';
import { createOnboardingState } from './onboarding-state.js';

/**
 * A Stripe account reduced to what Mercaria stores.
 *
 * The boundary between Stripe's vocabulary and Mercaria's: everything above this
 * type is Stripe, everything below it is the payment domain. Split out as a
 * plain value so the two derivations below are pure functions with a truth table
 * rather than something only reachable through an API call.
 */
export interface StripeAccountSnapshot {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  transfersCapability?: ProviderCapabilityStatus;
  currentlyDue: number;
  eventuallyDue: number;
  pastDue: number;
  pendingVerification: number;
  deadlineAt?: Date;
  disabledReasonCodes: readonly string[];
  defaultCurrency?: string;
  payoutScheduleInterval?: string;
  payoutScheduleDelayDays?: number;
}

/**
 * `requirements.disabled_reason` values from which an account does not recover
 * by finishing onboarding.
 *
 * Every `rejected.*` is matched by PREFIX rather than enumerated, so a value
 * Stripe adds later lands on the safe side: a rejection Mercaria does not
 * recognise is still a rejection, and treating it as `action_required` would
 * send the seller round a hosted flow that cannot help them.
 */
const TERMINAL_DISABLED_REASONS: ReadonlySet<string> = new Set([
  'listed',
  'platform_paused',
  'other',
]);

/** Reasons that mean the provider is deciding — nothing for the seller to do. */
const REVIEW_DISABLED_REASONS: ReadonlySet<string> = new Set([
  'under_review',
  'requirements.pending_verification',
]);

/**
 * A machine token, and nothing that could be a sentence or a name.
 *
 * Applied to every reason code before it is stored, because these are shown to
 * the account's owner and Stripe's field is a string whose value set is theirs.
 * Anything that does not match this shape becomes `other` — information is lost
 * deliberately, and the alternative is forwarding whatever a provider decided to
 * put in a free-text-capable field into Mercaria's database and UI.
 */
const REASON_CODE_SHAPE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

/** Whether an account with these reason codes is beyond the seller's help. */
function isTerminallyDisabled(codes: readonly string[]): boolean {
  return codes.some((code) => code.startsWith('rejected.') || TERMINAL_DISABLED_REASONS.has(code));
}

/**
 * ADR 0001 D9's readiness conjunction, and the ONLY place it is written.
 *
 * Payouts enabled, the transfers capability active, nothing due and nothing past
 * due, and no disabling reason. `charges_enabled` is deliberately not a conjunct
 * — under separate charges and transfers (D3) the connected account never
 * charges anything, so a seller whose account cannot charge is not thereby
 * unable to sell.
 *
 * `currentlyDue === 0` is stricter than the ADR's own summary line, which names
 * only `past_due`. It is deliberate: a requirement that is merely `currently_due`
 * becomes `past_due` on a deadline nobody is watching, and the difference
 * between the two readings is a seller who is ready on Monday and has failing
 * checkouts on Tuesday morning.
 */
export function isPaymentReady(snapshot: StripeAccountSnapshot): boolean {
  return (
    snapshot.payoutsEnabled &&
    snapshot.transfersCapability === 'active' &&
    snapshot.pastDue === 0 &&
    snapshot.currentlyDue === 0 &&
    snapshot.disabledReasonCodes.length === 0
  );
}

/**
 * The single stored verdict, derived in a fixed order.
 *
 * The order is the decision, and each step is ahead of the next for a reason:
 *
 *  1. `revoked` first — the platform cannot read this account at all any more,
 *     so nothing observed about it can outrank that.
 *  2. a rejection — terminal, and the seller must not be sent back into a hosted
 *     flow that will not change it.
 *  3. `past_due` — this is the one that must beat `ready`, and it does not
 *     merely because readiness already excludes it: an account can be past due
 *     AND under review, and `restricted` is the more actionable of the two.
 *  4. readiness — the D9 conjunction.
 *  5. review — the provider is deciding; telling someone to act here opens a
 *     support ticket about an action that does not exist.
 *  6. everything else is the seller's move.
 */
export function deriveOnboardingState(
  snapshot: StripeAccountSnapshot,
  options: { revoked: boolean },
): ProviderOnboardingState {
  if (options.revoked) return 'disabled';
  if (isTerminallyDisabled(snapshot.disabledReasonCodes)) return 'disabled';
  if (snapshot.pastDue > 0) return 'restricted';
  if (isPaymentReady(snapshot)) return 'ready';
  if (snapshot.disabledReasonCodes.some((code) => REVIEW_DISABLED_REASONS.has(code))) {
    return 'under_review';
  }
  // Nothing asked of the seller, and the provider still working: review, not a
  // call to action. The capability check matters on its own because a submitted
  // account clears its requirements before `transfers` goes active.
  if (snapshot.currentlyDue === 0 && snapshot.pastDue === 0) {
    if (snapshot.pendingVerification > 0 || snapshot.transfersCapability === 'pending') {
      return 'under_review';
    }
  }
  return 'action_required';
}

/** A Stripe capability status, or `undefined` for one that was never requested. */
function capabilityStatus(value: unknown): ProviderCapabilityStatus | undefined {
  return value === 'active' || value === 'inactive' || value === 'pending' ? value : undefined;
}

/**
 * Stripe's `requirements.disabled_reason`, reduced to a safe machine token.
 *
 * Widened to `string` on the way in, deliberately: the SDK types this as a union
 * of the literals it knew about when it was published, and the whole reason
 * {@link REASON_CODE_SHAPE} exists is that the value arrives over the wire from
 * an API whose set grows. Reading it at the declared type would make the shape
 * check look unreachable to the compiler while doing real work at runtime.
 *
 * An ARRAY column for a single value, because a rail is entitled to more than
 * one reason and the DTO should not change shape when one does.
 */
function reasonCodes(account: Stripe.Account): readonly string[] {
  const reason: string | null | undefined = account.requirements?.disabled_reason;
  if (typeof reason !== 'string' || reason.trim() === '') return [];
  return [REASON_CODE_SHAPE.test(reason) ? reason : 'other'];
}

/**
 * Reduce a Stripe account to what Mercaria stores.
 *
 * The requirement ARRAYS are counted and thrown away. That is the whole of
 * Mercaria's identity-data position (ADR 0001 D2): a count says "three things
 * are outstanding" and the hosted flow says which three, in the one place that
 * is allowed to know.
 */
export function snapshotStripeAccount(account: Stripe.Account): StripeAccountSnapshot {
  const requirements = account.requirements;
  const deadline = requirements?.current_deadline;
  const schedule = account.settings?.payouts?.schedule;
  const transfers = capabilityStatus(account.capabilities?.transfers);

  return {
    chargesEnabled: account.charges_enabled === true,
    payoutsEnabled: account.payouts_enabled === true,
    ...(transfers ? { transfersCapability: transfers } : {}),
    currentlyDue: requirements?.currently_due?.length ?? 0,
    eventuallyDue: requirements?.eventually_due?.length ?? 0,
    pastDue: requirements?.past_due?.length ?? 0,
    pendingVerification: requirements?.pending_verification?.length ?? 0,
    // Stripe reports the deadline in epoch SECONDS; a `Date` built from it
    // without the multiplication lands in January 1970 and reads as "overdue by
    // fifty years" in every surface that renders it.
    ...(typeof deadline === 'number' ? { deadlineAt: new Date(deadline * 1_000) } : {}),
    disabledReasonCodes: reasonCodes(account),
    ...(typeof account.default_currency === 'string' && account.default_currency !== ''
      ? { defaultCurrency: account.default_currency.toUpperCase() }
      : {}),
    ...(typeof schedule?.interval === 'string' ? { payoutScheduleInterval: schedule.interval } : {}),
    ...(typeof schedule?.delay_days === 'number'
      ? { payoutScheduleDelayDays: schedule.delay_days }
      : {}),
  };
}

/** The snapshot as the repository's state input, with its observation time. */
function toAccountState(
  snapshot: StripeAccountSnapshot,
  options: { revoked: boolean; syncedAt: Date },
): ProviderAccountState {
  return {
    onboardingState: deriveOnboardingState(snapshot, { revoked: options.revoked }),
    chargesEnabled: snapshot.chargesEnabled,
    payoutsEnabled: snapshot.payoutsEnabled,
    ...(snapshot.transfersCapability ? { transfersCapability: snapshot.transfersCapability } : {}),
    requirementsCurrentlyDue: snapshot.currentlyDue,
    requirementsEventuallyDue: snapshot.eventuallyDue,
    requirementsPastDue: snapshot.pastDue,
    requirementsPendingVerification: snapshot.pendingVerification,
    ...(snapshot.deadlineAt ? { requirementsDeadlineAt: snapshot.deadlineAt } : {}),
    disabledReasonCodes: snapshot.disabledReasonCodes,
    ...(snapshot.defaultCurrency ? { defaultCurrency: snapshot.defaultCurrency } : {}),
    ...(snapshot.payoutScheduleInterval
      ? { payoutScheduleInterval: snapshot.payoutScheduleInterval }
      : {}),
    ...(snapshot.payoutScheduleDelayDays !== undefined
      ? { payoutScheduleDelayDays: snapshot.payoutScheduleDelayDays }
      : {}),
    syncedAt: options.syncedAt,
  };
}

/**
 * A connected-account id as it may appear in a log line.
 *
 * `acct_1QxYzAbCdEfGhIjK` becomes `acct_…IjK`. Not a secret, and still redacted:
 * a full account id in an aggregated log is a durable, greppable link between a
 * log store and a specific merchant's finances, and nothing an operator does
 * with these lines needs more than enough to tell two accounts apart (#46,
 * security 4).
 */
export function redactAccountId(accountId: string): string {
  return accountId.length <= 4 ? accountId : `acct_…${accountId.slice(-4)}`;
}

/** The Stripe idempotency key for creating this owner's account — ADR 0001 D11. */
function accountCreateIdempotencyKey(owner: SellerAccountOwner): string {
  return `acct:${owner.ownerType}:${owner.ownerId}`;
}

/**
 * The country an account will be created in, validated against the allow-list.
 *
 * ADR 0001 D8 constrains sellers to the configured set, which is configuration
 * because the transfer region is Stripe's and moves on their schedule. Refused
 * here rather than at Stripe so the seller gets a Mercaria answer naming the
 * countries Mercaria supports, instead of a provider error about a region.
 */
function validateSellerCountry(country: string): string {
  const normalized = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw validationError('Country must be a two-letter ISO-3166-1 code');
  }
  if (!config.payments.stripe.sellerCountries.includes(normalized)) {
    throw validationError(
      `Mercaria cannot onboard sellers in ${normalized} yet. Supported: ` +
        `${config.payments.stripe.sellerCountries.join(', ')}.`,
    );
  }
  return normalized;
}

/**
 * ADR 0001 D2's controller properties, written out where they can be read
 * against the ADR.
 *
 * Every line is a decision, and three of them are the kind that look like
 * boilerplate until they are wrong:
 *
 *  - `losses.payments = application` is REQUIRED by D3's separate charges and
 *    transfers; Stripe only recommends that charge model to platforms that take
 *    the losses.
 *  - `requirement_collection = stripe` is what keeps identity data out of
 *    Mercaria entirely, and it is also why no `account_update` link exists —
 *    post-onboarding changes go through the seller's Express dashboard.
 *  - `stripe_dashboard.type = express` is IMMUTABLE. Changing it later means a
 *    new account and a seller re-onboarding from scratch.
 *
 * `card_payments` is deliberately not requested: connected accounts never charge
 * cards under this model, and requesting it would couple both capabilities'
 * disablement so a card-side problem would stop transfers too.
 *
 * `debit_negative_balances` is likewise not sent, though ADR 0001 lists it under
 * connected-account defaults: with `losses.payments = application` it is not an
 * independent setting, and sending a redundant field on a path that cannot be
 * exercised without a live Stripe account is a deploy-time failure for no gain.
 */
function accountCreateParams(input: {
  owner: SellerAccountOwner;
  country: string;
}): Stripe.AccountCreateParams {
  return {
    country: input.country,
    controller: {
      losses: { payments: 'application' },
      fees: { payer: 'application' },
      requirement_collection: 'stripe',
      stripe_dashboard: { type: 'express' },
    },
    capabilities: { transfers: { requested: true } },
    // A store is a business and a P2P seller is a person. Stripe refines this
    // during onboarding (a sole trader may end up `individual` either way), so
    // it is a starting point that shortens the hosted flow, not an assertion.
    business_type: input.owner.ownerType === 'store' ? 'company' : 'individual',
    // The owner, and NOT the `provider_accounts` row id. Two racing callers mint
    // two row ids and Stripe replays the first request's metadata, so a row id
    // here would name the loser's row on one of the two paths — a pointer that
    // is wrong exactly when someone is debugging a race. The owner is the same
    // on both paths, and the row is one indexed lookup away from it.
    metadata: { ownerType: input.owner.ownerType, ownerId: input.owner.ownerId },
  };
}

/**
 * The seller's connected account, creating one only if they have none.
 *
 * Idempotent on both sides of the boundary: an existing row short-circuits
 * before any Stripe call, and a concurrent caller that gets past that check
 * sends the same idempotency key and receives the same account (see the file
 * docblock).
 *
 * @param country Ignored when an account already exists — country is immutable
 *   at Stripe, and quietly "updating" it would be a lie the row could not act on.
 */
export async function ensureConnectedAccount(input: {
  owner: SellerAccountOwner;
  country: string;
}): Promise<ProviderAccountRow> {
  const db = getDb();
  const existing = await findProviderAccountByOwner(db, { provider: 'stripe', ...input.owner });
  if (existing) return existing;

  const country = validateSellerCountry(input.country);
  const account = await createStripeConnectedAccount(
    accountCreateParams({ owner: input.owner, country }),
    accountCreateIdempotencyKey(input.owner),
  );

  const row = await insertProviderAccount(db, {
    provider: 'stripe',
    ownerType: input.owner.ownerType,
    ownerId: input.owner.ownerId,
    providerAccountId: account.id,
    country,
  });

  log.general.info(
    {
      accountRowId: row.id,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      providerAccountId: redactAccountId(row.providerAccountId),
      country,
    },
    '[Stripe] connected account created',
  );
  await recordAccountChange({ row, previousState: 'not_connected', reason: 'created' });

  // The account Stripe just described is already worth storing: it carries the
  // capability's initial state and the requirements the seller will be asked
  // for, so the dashboard's first render is the real thing rather than a row of
  // defaults that a webhook will correct in a few seconds.
  const synced = await applyAccountSnapshot({
    row,
    snapshot: snapshotStripeAccount(account),
    syncedAt: new Date(),
  });
  return synced;
}

/**
 * A fresh hosted-onboarding link for this seller, creating their account if this
 * is the first time.
 *
 * `collection_options.fields = 'eventually_due'` per ADR 0001 D2: collecting
 * everything up front costs the seller one longer session instead of an
 * interrupted payout months later, when the requirement falls due and nobody is
 * watching.
 *
 * Both URLs point back at this API rather than at an app. A `return_url` hit
 * proves the browser came back and nothing else — not that onboarding finished,
 * not that anything was submitted — so the API receives the round trip, verifies
 * the state it signed, and readiness continues to come only from
 * `account.updated` and reconciliation.
 */
export async function createOnboardingLink(input: {
  owner: SellerAccountOwner;
  country: string;
}): Promise<ProviderOnboardingLink> {
  const onboarding = stripeOnboardingConfig();
  const row = await ensureConnectedAccount(input);

  if (row.revokedAt !== null) {
    throw validationError(
      'This connected account was disconnected from Mercaria and cannot be resumed. ' +
        'Contact support to start again.',
    );
  }

  const state = createOnboardingState({
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    accountRowId: row.id,
  });
  const query = `?state=${encodeURIComponent(state)}`;

  const link = await createStripeAccountLink({
    account: row.providerAccountId,
    type: 'account_onboarding',
    collection_options: { fields: 'eventually_due' },
    refresh_url: `${onboarding.baseUrl}/stripe/onboarding/refresh${query}`,
    return_url: `${onboarding.baseUrl}/stripe/onboarding/return${query}`,
  });

  log.general.info(
    {
      accountRowId: row.id,
      ownerType: row.ownerType,
      providerAccountId: redactAccountId(row.providerAccountId),
    },
    '[Stripe] onboarding link minted',
  );

  return { url: link.url, expiresAt: new Date(link.expires_at * 1_000).toISOString() };
}

/**
 * The seller-facing payments settings surface — status plus what this
 * deployment can actually do.
 *
 * It lives HERE and not in `provider-account.service.ts` because two of its
 * three fields are facts about the RAIL: whether onboarding is configured, and
 * which countries it accepts. The provider-neutral module deliberately knows
 * neither, since the one thing it must stay importable by is `checkout.service`.
 */
export async function readSellerPaymentSettings(
  owner: SellerAccountOwner,
): Promise<SellerPaymentSettings> {
  return {
    account: await readSellerAccountStatus(owner),
    onboardingAvailable: isStripeOnboardingConfigured(),
    supportedCountries: config.payments.stripe.sellerCountries,
  };
}

/**
 * Apply a snapshot to a row, emitting a domain event when the verdict moved.
 *
 * The event is emitted only on a CHANGE of `onboarding_state`, and only when
 * this observation was the one applied — a concurrent, fresher sync that won the
 * compare-and-swap has already emitted whatever it changed, and a second event
 * describing a transition that did not happen is worse than none.
 */
async function applyAccountSnapshot(input: {
  row: ProviderAccountRow;
  snapshot: StripeAccountSnapshot;
  syncedAt: Date;
  revoked?: boolean;
}): Promise<ProviderAccountRow> {
  const state = toAccountState(input.snapshot, {
    revoked: input.revoked ?? input.row.revokedAt !== null,
    syncedAt: input.syncedAt,
  });
  const { row, applied } = await applyProviderAccountState(getDb(), {
    id: input.row.id,
    state,
  });

  if (applied && row.onboardingState !== input.row.onboardingState) {
    log.general.info(
      {
        accountRowId: row.id,
        ownerType: row.ownerType,
        ownerId: row.ownerId,
        providerAccountId: redactAccountId(row.providerAccountId),
        from: input.row.onboardingState,
        to: row.onboardingState,
        payoutsEnabled: row.payoutsEnabled,
        transfersCapability: row.transfersCapability,
        currentlyDue: row.requirementsCurrentlyDue,
        pastDue: row.requirementsPastDue,
        disabledReasonCodes: row.disabledReasonCodes,
      },
      '[Stripe] connected-account readiness changed',
    );
    await recordAccountChange({
      row,
      previousState: input.row.onboardingState,
      reason: 'synced',
      at: input.syncedAt,
    });
  }

  return row;
}

/**
 * The durable audit record of a state change — see
 * `@mercaria/shared-types`'s `provider_account_changed`.
 *
 * The id carries the OBSERVATION TIME, which makes it deterministic for one
 * observation (so an outbox retry re-derives it and is a genuine no-op) without
 * collapsing two real transitions into one — a seller who goes
 * `ready → restricted → ready` has three events, which an id keyed only on the
 * destination state could not represent. Two DIFFERENT observations of the same
 * transition (a webhook and the sweep racing) do produce two rows; the outbox is
 * at-least-once and the handler is a log, so that is the cheap side of the
 * trade rather than a defect.
 */
async function recordAccountChange(input: {
  row: ProviderAccountRow;
  previousState: ProviderOnboardingState;
  reason: 'created' | 'synced' | 'revoked';
  at?: Date;
}): Promise<void> {
  const at = input.at ?? new Date();
  await enqueuePaymentEvent(getDb(), {
    id: providerAccountChangedEventId(input.row.id, input.row.onboardingState, at),
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
 * Re-read one connected account from Stripe and apply what it says.
 *
 * The single entry point for `account.updated`,
 * `account.external_account.updated` and the reconciliation sweep. An account id
 * Mercaria has no row for is logged and ignored: it is an account from another
 * environment, or one whose row a rebuilt database lost, and inventing a row for
 * it would attribute a stranger's account to nobody.
 *
 * @returns The row as it now stands, or `undefined` when the id is unknown here.
 */
export async function syncAccountState(providerAccountId: string): Promise<ProviderAccountRow | undefined> {
  const row = await findProviderAccountByProviderId(getDb(), 'stripe', providerAccountId);
  if (!row) {
    log.general.warn(
      { providerAccountId: redactAccountId(providerAccountId) },
      '[Stripe] account event names a connected account Mercaria has no record of',
    );
    return undefined;
  }
  return await syncAccountRow(row);
}

/** {@link syncAccountState} starting from a row already in hand. */
export async function syncAccountRow(row: ProviderAccountRow): Promise<ProviderAccountRow> {
  const account = await retrieveStripeAccount(row.providerAccountId);
  return await applyAccountSnapshot({
    row,
    snapshot: snapshotStripeAccount(account),
    // Read AFTER the call returns, so the ordering key can never claim an
    // observation is fresher than it is.
    syncedAt: new Date(),
  });
}

/**
 * The seller revoked Mercaria's access to their account.
 *
 * Terminal and applied without re-reading Stripe, because there is nothing left
 * to read: the platform's authorisation is gone and every subsequent call would
 * fail. The row survives — the account may still hold a balance, `payouts` rows
 * name it, and a marketplace has to be able to say that a seller WAS onboarded
 * (ADR 0001 D10).
 *
 * @returns The row, or `undefined` when the account is unknown here.
 */
export async function revokeAccount(providerAccountId: string): Promise<ProviderAccountRow | undefined> {
  const db = getDb();
  const row = await findProviderAccountByProviderId(db, 'stripe', providerAccountId);
  if (!row) {
    log.general.warn(
      { providerAccountId: redactAccountId(providerAccountId) },
      '[Stripe] deauthorization names a connected account Mercaria has no record of',
    );
    return undefined;
  }

  const at = new Date();
  const revoked = await revokeProviderAccount(db, { id: row.id, at });
  if (!revoked) return row;

  const updated = await findProviderAccountByProviderId(db, 'stripe', providerAccountId);
  if (!updated) {
    throw new Error(`provider_accounts row ${row.id} disappeared during revocation.`);
  }

  log.general.warn(
    {
      accountRowId: updated.id,
      ownerType: updated.ownerType,
      ownerId: updated.ownerId,
      providerAccountId: redactAccountId(updated.providerAccountId),
      from: row.onboardingState,
    },
    '[Stripe] connected account deauthorized; the seller can no longer be paid',
  );
  await recordAccountChange({
    row: updated,
    previousState: row.onboardingState,
    reason: 'revoked',
    at,
  });
  return updated;
}
