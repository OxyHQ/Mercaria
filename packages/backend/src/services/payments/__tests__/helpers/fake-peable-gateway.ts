/**
 * THE in-memory Peable gateway for the payment realdb suites — one definition
 * of the fake, so the suites that open payments (checkout) and the ones that
 * move money back (refunds, reconciliation, repairs, holds) cannot drift into
 * two different pictures of one SDK.
 *
 * It stands in for `createPeableClient()` — the one module that reaches the
 * gateway — so EVERYTHING above it is the real code: `PeablePaymentProvider`
 * maps these answers exactly as it maps the real gateway's, and the payment
 * domain, the ledger, the outbox, the signed ingress and the sweeps run
 * unchanged against a real Postgres. A suite wires it in with:
 *
 * ```ts
 * const gateway = await vi.hoisted(async () =>
 *   (await import('…/helpers/fake-peable-gateway.js')).createFakePeableGateway(),
 * );
 * vi.mock('…/peable/client.js', () => gateway.clientModule());
 * ```
 *
 * ## It answers in the WIRE's shapes, and honours the wire's idempotency
 *
 * One renderer per object ({@link renderIntent}, `renderTransfer`) with the
 * published contract's field names: amounts are canonical integer STRINGS, every
 * intent carries its own `client_secret` (the payer's), a payable card intent
 * also carries `client_action: { kind: 'client_secret' }` (the acquirer's), a
 * transfer carries the cumulative `amount_reversed` and the `reversal` that leg
 * created, and a refund list carries `remaining_refundable`. One
 * `Idempotency-Key` produces one object however often it is presented — a
 * replayed create answers the intent it made, and a released hold or a retried
 * refund re-enters with the same `tr:` / `re:` / `trr:` key — because a fake
 * that minted a second object would hide the one mistake this domain cannot
 * recover from.
 *
 * ## Refusals are the gateway's own error classes
 *
 * The adapter classifies a failure by `PeableError.statusCode`: a 4xx other than
 * 408/429 is permanent, anything without a status is retryable. So an armed
 * refusal throws a real `PeableInvalidRequestError` with a 400, and an
 * unreachable intent or a lost create answer throws a plain `Error`, which is
 * what a dropped connection looks like from above the SDK.
 *
 * ## Every minted id carries a per-instance nonce
 *
 * The ids land in `provider_object_id` columns, and Mercaria resolves a
 * delivery by `(provider, provider_object_id)`. The realdb files share ONE
 * database in parallel, so two files both minting `pi_…_1` would settle each
 * other's payments — which is exactly what happened before the nonce.
 *
 * ## Deliveries are signed longhand
 *
 * {@link signPeablePayload} is the gateway's scheme
 * (`t=<unix>,v1=<hex hmac-sha256 of "<t>.<rawBody>">`) written out, never
 * `verify.ts`, so a suite cannot agree with the code under test by
 * construction.
 *
 * It is NOT a gateway. It does not settle, convert or charge fees, and nothing
 * here stands in for a real call (ADR 0009 D18).
 */

import { createHmac, randomUUID } from 'node:crypto';
import { PEABLE_API_VERSION, PeableInvalidRequestError, type Peable } from '@peable.to/sdk';

/** The gateway's PaymentIntent statuses this fake can hold an intent in. */
export type FakeIntentStatus =
  | 'requires_payment_method'
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'canceled';

/** One card PaymentIntent, as the gateway's books hold it. */
export interface FakeIntent {
  id: string;
  status: FakeIntentStatus;
  amount: bigint;
  currency: string;
  /** The sum of SUCCEEDED refunds — the gateway's `amount_refunded`. */
  refunded: bigint;
  /** Set to render a declined attempt (`last_payment_error`); still payable. */
  declined?: boolean;
  metadata: Record<string, string>;
  /**
   * The ACQUIRER's confirmation secret: what `client_action.value` carries while
   * the intent is payable. Mercaria never hands it to a buyer.
   */
  clientSecret: string;
  /**
   * The intent's own `client_secret` — the PAYER's capability over it, which
   * the storefront's payer SDK mounts on. Distinct from {@link clientSecret} so
   * a suite can tell which of the two reached a handoff.
   */
  payerSecret?: string;
}

/** One transfer to a seller's connected account. */
export interface FakeTransfer {
  id: string;
  intentId: string;
  connectedAccount: string;
  amount: bigint;
  reversed: bigint;
}

/**
 * One seller's connected account, as the gateway's books hold it — the card
 * half only (Mercaria never opens a FairCoin half).
 */
export interface FakeAccount {
  id: string;
  externalRef: string;
  country: string;
  defaultCurrency: string | null;
  payable: boolean;
  payoutsEnabled: boolean;
  chargesEnabled: boolean;
  transfersCapability: 'active' | 'inactive' | 'pending' | null;
  currentlyDue: string[];
  eventuallyDue: string[];
  pastDue: string[];
  pendingVerification: string[];
  disabledReason: string | null;
}

/** What one recorded mutating call carried. */
export interface FakeCall {
  params: Record<string, unknown>;
  idempotencyKey: string | undefined;
}

/** What one recorded reversal carried. */
export interface FakeReversalCall extends FakeCall {
  transferId: string;
}

interface IdempotencyOptions {
  idempotencyKey?: string;
}

/** A Mercaria minor-unit amount as the gateway's canonical integer string. */
function minor(value: bigint): string {
  return value.toString();
}

/** A permanent refusal, in the gateway's own error class. */
function refusal(message: string, code: string): PeableInvalidRequestError {
  return new PeableInvalidRequestError(message, { statusCode: 400, code });
}

/**
 * An intent as the gateway renders it — THE renderer, for API answers and for
 * event payloads alike.
 *
 * `client_action` is what a create and a merchant retrieve carry for a card
 * payment that can still be paid; an event never carries it.
 */
export function renderIntent(
  intent: FakeIntent,
  options: { clientAction: boolean },
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const payable = intent.status !== 'succeeded' && intent.status !== 'canceled';
  return {
    id: intent.id,
    object: 'payment_intent',
    livemode: false,
    rail: 'card',
    status: intent.status,
    amount: minor(intent.amount),
    amount_received: minor(intent.status === 'succeeded' ? intent.amount : 0n),
    amount_refunded: minor(intent.refunded),
    currency: intent.currency,
    merchant_id: 'merch_fixture',
    faircoin: null,
    client_secret: intent.payerSecret ?? `${intent.id}_payer_secret_fixture`,
    metadata: { ...intent.metadata },
    last_payment_error: intent.declined
      ? { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' }
      : null,
    ...(options.clientAction && payable
      ? { client_action: { kind: 'client_secret', value: intent.clientSecret } }
      : {}),
    expires_at: now + 3_600,
    created: now,
    updated_at: now,
  };
}

function renderTransfer(transfer: FakeTransfer): Record<string, unknown> {
  return {
    id: transfer.id,
    object: 'transfer',
    livemode: false,
    payment_intent: transfer.intentId,
    connected_account: transfer.connectedAccount,
    amount: minor(transfer.amount),
    amount_reversed: minor(transfer.reversed),
    status:
      transfer.reversed === 0n
        ? 'paid'
        : transfer.reversed >= transfer.amount
          ? 'reversed'
          : 'partially_reversed',
  };
}

/** A connected account as the gateway renders it — for API answers and event payloads alike. */
export function renderAccount(account: FakeAccount): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: account.id,
    object: 'connected_account',
    livemode: false,
    external_ref: account.externalRef,
    rails: ['card'],
    faircoin: null,
    country: account.country,
    default_currency: account.defaultCurrency,
    payable: account.payable,
    payouts_enabled: account.payoutsEnabled,
    charges_enabled: account.chargesEnabled,
    transfers_capability: account.transfersCapability,
    card_payments_capability: account.chargesEnabled ? 'active' : 'pending',
    requirements: {
      currently_due: [...account.currentlyDue],
      eventually_due: [...account.eventuallyDue],
      past_due: [...account.pastDue],
      pending_verification: [...account.pendingVerification],
      disabled_reason: account.disabledReason,
    },
    last_synced_at: now,
    created: now,
    updated_at: now,
  };
}

/**
 * Sign a raw delivery body the way the GATEWAY does — THE signing helper.
 *
 * Longhand on purpose; see this file's docblock.
 */
export function signPeablePayload(
  payload: string,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  const signature = createHmac('sha256', secret)
    .update(`${String(timestamp)}.${payload}`)
    .digest('hex');
  return `t=${String(timestamp)},v1=${signature}`;
}

/** Build one fake gateway. Each suite holds its own, reset between cases. */
export function createFakePeableGateway() {
  const tag = randomUUID().replaceAll('-', '').slice(0, 12);
  const intents = new Map<string, FakeIntent>();
  const transfers = new Map<string, FakeTransfer>();
  const accounts = new Map<string, FakeAccount>();
  /** A create's `Idempotency-Key` → the intent it made, re-rendered on replay. */
  const intentsByKey = new Map<string, string>();
  /** Every other mutating call's `Idempotency-Key` → the answer it produced. */
  const byKey = new Map<string, Record<string, unknown>>();

  const state = {
    intents,
    transfers,
    intentsByKey,
    intentCalls: [] as FakeCall[],
    cancelCalls: [] as string[],
    /** Every intent id `paymentIntents.retrieve` was asked for, in order. */
    retrieves: [] as string[],
    refundCalls: [] as FakeCall[],
    transferCalls: [] as FakeCall[],
    reversalCalls: [] as FakeReversalCall[],
    /** Every `connectedAccounts.create` call, in order. */
    accountCalls: [] as FakeCall[],
    /** Every account link minted: which account, and the URLs it carried. */
    linkCalls: [] as { accountId: string; params: Record<string, unknown> }[],
    /** Countries the gateway refuses to open a card account in (a 400 on `country`). */
    refusedCountries: new Set<string>(),
    /** Intents whose refunds the gateway REFUSES (a 400). */
    refundFailures: new Set<string>(),
    /** Transfers whose reversals the gateway REFUSES — per seller, as D7's failure is. */
    reversalFailures: new Set<string>(),
    /** Intents the gateway cannot be reached for. */
    unreadableIntents: new Set<string>(),
    /**
     * The next create is ACCEPTED by the gateway and its answer is lost — the
     * ambiguous timeout a durable idempotency key exists to recover from.
     */
    acceptThenTimeout: false,
    nextId: 0,
  };

  function nextId(prefix: string): string {
    state.nextId += 1;
    return `${prefix}_fake_${tag}_${String(state.nextId)}`;
  }

  function intentOf(id: string): FakeIntent {
    const intent = intents.get(id);
    if (!intent) throw refusal(`No such payment_intent: '${id}'`, 'resource_missing');
    return intent;
  }

  function accountOf(id: string): FakeAccount {
    const account = accounts.get(id);
    if (!account) throw refusal(`No such connected_account: '${id}'`, 'resource_missing');
    return account;
  }

  function replay(key: string | undefined): Record<string, unknown> | undefined {
    return key === undefined ? undefined : byKey.get(key);
  }

  function remember(key: string | undefined, answer: Record<string, unknown>) {
    if (key !== undefined) byKey.set(key, answer);
    return answer;
  }

  const client = {
    paymentIntents: {
      create: (
        params: { amount: string; currency: string; metadata?: Record<string, string> },
        options?: IdempotencyOptions,
      ) => {
        const idempotencyKey = options?.idempotencyKey;
        state.intentCalls.push({ params, idempotencyKey });
        const existing = idempotencyKey ? intentsByKey.get(idempotencyKey) : undefined;
        if (existing) {
          return Promise.resolve(renderIntent(intentOf(existing), { clientAction: true }));
        }
        const id = nextId('pi');
        const intent: FakeIntent = {
          id,
          status: 'requires_payment_method',
          amount: BigInt(params.amount),
          currency: params.currency,
          refunded: 0n,
          metadata: { ...params.metadata },
          clientSecret: `${id}_secret_fixture`,
          payerSecret: `${id}_payer_secret_fixture`,
        };
        intents.set(id, intent);
        if (idempotencyKey) intentsByKey.set(idempotencyKey, id);
        if (state.acceptThenTimeout) {
          state.acceptThenTimeout = false;
          return Promise.reject(new Error('gateway response lost after acceptance'));
        }
        return Promise.resolve(renderIntent(intent, { clientAction: true }));
      },
      retrieve: (id: string) => {
        state.retrieves.push(id);
        if (state.unreadableIntents.has(id)) {
          return Promise.reject(new Error(`the gateway is unreachable for ${id}`));
        }
        return Promise.resolve(renderIntent(intentOf(id), { clientAction: true }));
      },
      cancel: (id: string, _params: unknown, options?: IdempotencyOptions) => {
        state.cancelCalls.push(id);
        const existing = replay(options?.idempotencyKey);
        if (existing) return Promise.resolve(existing);
        const intent = intentOf(id);
        if (intent.status === 'succeeded') {
          return Promise.reject(
            refusal(
              'A succeeded payment intent cannot be canceled.',
              'payment_intent_unexpected_state',
            ),
          );
        }
        intent.status = 'canceled';
        return Promise.resolve(
          remember(options?.idempotencyKey, renderIntent(intent, { clientAction: false })),
        );
      },
    },
    refunds: {
      create: (
        params: { payment_intent: string; external_ref?: string; amount?: string },
        options?: IdempotencyOptions,
      ) => {
        state.refundCalls.push({ params, idempotencyKey: options?.idempotencyKey });
        const existing = replay(options?.idempotencyKey);
        if (existing) return Promise.resolve(existing);
        if (state.refundFailures.has(params.payment_intent)) {
          return Promise.reject(
            refusal('This payment has already been refunded.', 'charge_already_refunded'),
          );
        }
        const intent = intentOf(params.payment_intent);
        const amount = BigInt(params.amount ?? minor(intent.amount - intent.refunded));
        intent.refunded += amount;
        return Promise.resolve(
          remember(options?.idempotencyKey, {
            id: nextId('re'),
            object: 'refund',
            livemode: false,
            payment_intent: intent.id,
            amount: minor(amount),
            currency: intent.currency,
            status: 'succeeded',
            failure_code: null,
            external_ref: params.external_ref ?? null,
          }),
        );
      },
      listForPaymentIntent: (intentId: string) => {
        const intent = intentOf(intentId);
        return Promise.resolve({
          object: 'list',
          data: [],
          has_more: false,
          remaining_refundable: minor(intent.amount - intent.refunded),
        });
      },
    },
    connectedAccounts: {
      create: (
        params: { external_ref: string; country?: string; business_type?: string },
        options?: IdempotencyOptions,
      ) => {
        state.accountCalls.push({ params, idempotencyKey: options?.idempotencyKey });
        // The gateway converges on `external_ref`, whatever the key says.
        const existing = [...accounts.values()].find(
          (account) => account.externalRef === params.external_ref,
        );
        if (existing) return Promise.resolve(renderAccount(existing));
        const country = (params.country ?? '').toUpperCase();
        if (state.refusedCountries.has(country)) {
          return Promise.reject(
            new PeableInvalidRequestError(`cannot open a card account in ${country}`, {
              statusCode: 400,
              code: 'parameter_invalid',
              param: 'country',
            }),
          );
        }
        const account: FakeAccount = {
          id: nextId('ca'),
          externalRef: params.external_ref,
          country,
          defaultCurrency: null,
          payable: false,
          payoutsEnabled: false,
          chargesEnabled: false,
          transfersCapability: 'inactive',
          currentlyDue: ['business_profile.url', 'external_account', 'tos_acceptance.date'],
          eventuallyDue: ['business_profile.url', 'external_account', 'tos_acceptance.date'],
          pastDue: [],
          pendingVerification: [],
          disabledReason: 'requirements.past_due',
        };
        accounts.set(account.id, account);
        return Promise.resolve(renderAccount(account));
      },
      retrieve: (id: string) => Promise.resolve(renderAccount(accountOf(id))),
      refresh: (id: string) => Promise.resolve(renderAccount(accountOf(id))),
      createAccountLink: (id: string, params: Record<string, unknown>) => {
        accountOf(id);
        state.linkCalls.push({ accountId: id, params });
        return Promise.resolve({
          object: 'account_link',
          livemode: false,
          url: `https://connect.peable.test/onboarding/${id}/${String(state.linkCalls.length)}`,
          expires_at: Math.floor(Date.now() / 1000) + 300,
        });
      },
    },
    transfers: {
      create: (
        params: { payment_intent: string; connected_account: string; amount: string },
        options?: IdempotencyOptions,
      ) => {
        state.transferCalls.push({ params, idempotencyKey: options?.idempotencyKey });
        const existing = replay(options?.idempotencyKey);
        if (existing) return Promise.resolve(existing);
        const transfer: FakeTransfer = {
          id: nextId('tr'),
          intentId: params.payment_intent,
          connectedAccount: params.connected_account,
          amount: BigInt(params.amount),
          reversed: 0n,
        };
        transfers.set(transfer.id, transfer);
        return Promise.resolve(remember(options?.idempotencyKey, renderTransfer(transfer)));
      },
      reverse: (
        transferId: string,
        params: { amount?: string; external_ref?: string },
        options?: IdempotencyOptions,
      ) => {
        state.reversalCalls.push({ transferId, params, idempotencyKey: options?.idempotencyKey });
        const existing = replay(options?.idempotencyKey);
        if (existing) return Promise.resolve(existing);
        if (state.reversalFailures.has(transferId)) {
          return Promise.reject(
            refusal(
              'Insufficient funds in the connected account to complete this reversal.',
              'balance_insufficient',
            ),
          );
        }
        const transfer = transfers.get(transferId);
        if (!transfer) {
          return Promise.reject(refusal(`No such transfer: '${transferId}'`, 'resource_missing'));
        }
        transfer.reversed += BigInt(params.amount ?? minor(transfer.amount - transfer.reversed));
        return Promise.resolve(
          remember(options?.idempotencyKey, {
            ...renderTransfer(transfer),
            reversal: { id: nextId('trr'), object: 'transfer_reversal' },
          }),
        );
      },
    },
  };

  const gateway = {
    state,

    /** Register an intent the gateway already holds (a payment opened elsewhere). */
    putIntent(
      intent: Omit<FakeIntent, 'refunded' | 'metadata' | 'clientSecret'> &
        Partial<Pick<FakeIntent, 'refunded' | 'metadata' | 'clientSecret'>>,
    ): FakeIntent {
      const stored: FakeIntent = {
        ...intent,
        refunded: intent.refunded ?? 0n,
        metadata: intent.metadata ?? {},
        clientSecret: intent.clientSecret ?? `${intent.id}_secret_fixture`,
      };
      intents.set(stored.id, stored);
      return stored;
    },

    /** The gateway's record of one intent; throws for one it never made. */
    intent(id: string): FakeIntent {
      return intentOf(id);
    },

    /** The gateway's record of one connected account; throws for one it never opened. */
    account(id: string): FakeAccount {
      return accountOf(id);
    },

    /** The seller finished the hosted flow and the acquirer enabled everything. */
    completeOnboarding(id: string, defaultCurrency = 'EUR'): void {
      Object.assign(accountOf(id), {
        defaultCurrency,
        payable: true,
        payoutsEnabled: true,
        chargesEnabled: true,
        transfersCapability: 'active',
        currentlyDue: [],
        eventuallyDue: [],
        pastDue: [],
        pendingVerification: [],
        disabledReason: null,
      } satisfies Partial<FakeAccount>);
    },

    /** Change what the acquirer reports for one account (a later restriction, a review). */
    updateAccount(id: string, patch: Partial<Omit<FakeAccount, 'id' | 'externalRef'>>): void {
      Object.assign(accountOf(id), patch);
    },

    /**
     * A signed delivery about any object, as the gateway would send it — the
     * object already rendered (e.g. {@link renderAccount}).
     */
    objectDelivery(input: {
      eventId: string;
      type: string;
      object: Record<string, unknown>;
      secret: string;
    }): { payload: Buffer; signature: string } {
      const created = Math.floor(Date.now() / 1000);
      const payload = JSON.stringify({
        id: input.eventId,
        object: 'event',
        api_version: PEABLE_API_VERSION,
        livemode: false,
        type: input.type,
        created,
        request: { id: null, idempotency_key: null },
        data: { object: input.object },
      });
      return {
        payload: Buffer.from(payload, 'utf8'),
        signature: signPeablePayload(payload, input.secret, created),
      };
    },

    /** The buyer confirmed and the acquirer captured (ADR 0001 D3: immediately). */
    succeed(id: string): void {
      const intent = intentOf(id);
      intent.status = 'succeeded';
      intent.declined = false;
    },

    /** A declined attempt: back to `requires_payment_method`, still payable. */
    decline(id: string): void {
      const intent = intentOf(id);
      intent.status = 'requires_payment_method';
      intent.declined = true;
    },

    /**
     * A signed delivery about one intent, as the gateway would send it: the
     * intent's CURRENT rendering, no client action, signed with
     * {@link signPeablePayload}.
     */
    intentDelivery(input: { eventId: string; type: string; intentId: string; secret: string }): {
      payload: Buffer;
      signature: string;
    } {
      return gateway.objectDelivery({
        eventId: input.eventId,
        type: input.type,
        object: renderIntent(intentOf(input.intentId), { clientAction: false }),
        secret: input.secret,
      });
    },

    /** Forget every object and every recorded call — between cases, never mid-case. */
    reset(): void {
      intents.clear();
      transfers.clear();
      accounts.clear();
      intentsByKey.clear();
      byKey.clear();
      state.intentCalls.length = 0;
      state.cancelCalls.length = 0;
      state.retrieves.length = 0;
      state.refundCalls.length = 0;
      state.transferCalls.length = 0;
      state.reversalCalls.length = 0;
      state.accountCalls.length = 0;
      state.linkCalls.length = 0;
      state.refusedCountries.clear();
      state.refundFailures.clear();
      state.reversalFailures.clear();
      state.unreadableIntents.clear();
      state.acceptThenTimeout = false;
    },

    /**
     * The `services/payments/peable/client.js` module, mocked: the real
     * transport constants and a client that is this fake.
     *
     * The cast is the one place the fake meets the SDK's type: it implements
     * only the methods `PeablePaymentProvider` calls, which is the point — a
     * method the adapter starts calling that is not here fails loudly as
     * `is not a function` rather than reaching a network.
     */
    clientModule() {
      return {
        PEABLE_TRANSPORT: { timeout: 20_000, maxNetworkRetries: 0 } as const,
        createPeableClient: (): Peable => client as unknown as Peable,
      };
    },
  };
  return gateway;
}

/** The gateway one suite holds. */
export type FakePeableGateway = ReturnType<typeof createFakePeableGateway>;
