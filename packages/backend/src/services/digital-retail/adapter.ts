/**
 * The provider-neutral digital supplier adapter port (#1016 Workstream 2,
 * ADR 0011).
 *
 * The epic's acceptance criterion 24: *"no implementation depends on a specific
 * provider's schema outside its adapter"*. This file is where that is decided —
 * every type below is Mercaria's, every error is normalized into the closed
 * taxonomy, and nothing in the orchestrator, the selector or the fulfilment path
 * ever sees a provider's JSON.
 *
 * ## Every operation returns a RESULT, and none of them throws
 *
 * A thrown provider error is a stack trace at a call site that has to guess what
 * happened; a returned `AdapterFailure` carries a closed-set kind, and the ONE
 * judgement that matters — *did this leave the supplier's side unknown?* — is
 * made by `isAmbiguousProcurementError` from that kind, in one place. An adapter
 * that throws anyway is wrapped by `runAdapterOperation`, which converts the
 * throw into `other` rather than letting it escape into an orchestration that
 * would then have no idea whether a key was bought.
 *
 * ## `recoverPurchase` is not optional, and that is the contract's sharpest edge
 *
 * An adapter that can buy but cannot ask *"did my last request actually buy
 * something"* makes `ambiguous` unrecoverable, and an unrecoverable ambiguous
 * state converges on either double-buying or stranding a paid customer. So it is
 * in `REQUIRED_PROCUREMENT_CAPABILITIES` and the conformance suite refuses an
 * adapter without it.
 *
 * ## The plaintext crosses this boundary EXACTLY once
 *
 * `FulfilmentArtifactPayload.secret` is the only field in this file that ever
 * holds bearer secret material. It is handed straight to
 * `services/digital-retail/secrets.ts`, sealed, and never stored, logged or
 * returned anywhere else — which is why the type is marked and why the
 * conformance suite asserts an adapter never puts one in an error message.
 */

import {
  isAmbiguousProcurementError,
  type DigitalFulfilmentCapability,
  type DigitalProcurementErrorKind,
  type DigitalRetailProductClass,
  type DigitalSupplierApiCapability,
  type ProcurementAvailability,
} from '@mercaria/shared-types';

/** What every adapter call is given: who is asking, and under what account. */
export interface AdapterContext {
  /** The `supplier_accounts` row this call acts as. */
  readonly supplierAccountId: string;
  /** `test` or `live` — the account's own environment, never inferred here. */
  readonly environment: 'test' | 'live';
  /** A deadline, in milliseconds. An adapter that exceeds it must return `timeout`. */
  readonly timeoutMs: number;
}

/** A normalized failure. The provider's own message is REDACTED before it lands. */
export interface AdapterFailure {
  readonly kind: DigitalProcurementErrorKind;
  /**
   * A short, redacted description. Never a provider payload, never a credential,
   * and never an artifact — `redactProviderMessage` is what produces it.
   */
  readonly messageRedacted: string;
  /** The provider's own correlation id, kept privately for escalation. */
  readonly providerRequestId?: string | null;
}

/** A successful adapter call. */
export interface AdapterSuccess<T> {
  readonly ok: true;
  readonly value: T;
  readonly providerRequestId?: string | null;
}

/** A failed one, carrying the normalized kind rather than the provider's shape. */
export interface AdapterFailureResult {
  readonly ok: false;
  readonly failure: AdapterFailure;
}

/** Every adapter operation answers one of these. Nothing throws past the port. */
export type AdapterResult<T> = AdapterSuccess<T> | AdapterFailureResult;

/**
 * Narrow a result to its failure branch.
 *
 * A type GUARD rather than `if (!result.ok)`, and the reason is this package's
 * tsconfig: `strict` is off, so `strictNullChecks` is off, and narrowing a union
 * by the truthiness of a boolean-literal discriminant does not happen — every
 * `result.failure` after such a check is a TS2339 on the success branch. A guard
 * narrows regardless of that setting, so the port reads the same under either.
 */
export function adapterFailed<T>(result: AdapterResult<T>): result is AdapterFailureResult {
  return result.ok === false;
}

/** Narrow a result to its success branch. The sibling of {@link adapterFailed}. */
export function adapterSucceeded<T>(result: AdapterResult<T>): result is AdapterSuccess<T> {
  return result.ok === true;
}

/** Whether a failure left the supplier's side UNKNOWN (ADR 0011 D5). */
export function failureIsAmbiguous(failure: AdapterFailure): boolean {
  return isAmbiguousProcurementError(failure.kind);
}

/** What Mercaria asks before it commits: is this exact thing still buyable? */
export interface PreflightRequest {
  readonly supplierSku: string;
  readonly quantity: 1;
  /** ISO-3166-1 alpha-2 — the territory the buyer needs it to ACTIVATE in. */
  readonly activationTerritory: string;
  readonly expectedCapability: DigitalFulfilmentCapability;
  readonly expectedCurrency: string;
}

/** The supplier's authoritative answer. Every field is a fact Mercaria re-checks. */
export interface PreflightResponse {
  readonly available: ProcurementAvailability;
  readonly costAmount: number;
  readonly costCurrency: string;
  readonly capability: DigitalFulfilmentCapability;
  readonly productClass: DigitalRetailProductClass;
  readonly platform: string;
  readonly activationEcosystem: string;
  readonly edition: string;
  readonly activationTerritories: readonly string[];
  /** How long this quote is good for. NULL = the adapter states none. */
  readonly quoteTtlSeconds: number | null;
  readonly expectedFulfilmentSeconds: number | null;
  /** Whether the account can currently PAY for this (prefunded balance, credit). */
  readonly fundingReady: boolean;
}

/** The buy. `idempotencyKey` is Mercaria's derived key and is sent as-is. */
export interface PurchaseRequest {
  readonly idempotencyKey: string;
  readonly supplierSku: string;
  readonly quantity: 1;
  readonly activationTerritory: string;
  /** The most this order may pay. An adapter must REFUSE above it, never absorb. */
  readonly maxAcceptedCostAmount: number;
  readonly currency: string;
}

/** What the supplier says about an order of ours. */
export interface PurchaseResponse {
  readonly providerOrderId: string;
  readonly accepted: boolean;
  readonly finalCostAmount: number | null;
  readonly finalCostCurrency: string | null;
  /** Whether the artifact is ready now, or has to be fetched later. */
  readonly fulfilmentReady: boolean;
}

/**
 * What `recoverPurchase` found.
 *
 * `found: false` is a POSITIVE answer — the supplier has no record of this
 * idempotency key, so nothing was bought and a fallback is safe. It is not the
 * same as a failure, and conflating the two is how an ambiguous attempt becomes
 * a second key.
 */
export type RecoveryResponse =
  | { readonly found: true; readonly purchase: PurchaseResponse }
  | { readonly found: false };

/**
 * The artifact itself.
 *
 * `secret` is bearer material and crosses this boundary exactly once, into the
 * sealing function. `instructions` is customer-facing text and must never contain
 * the secret — the conformance suite checks that an adapter does not put one
 * there.
 */
export interface FulfilmentArtifactPayload {
  readonly capability: DigitalFulfilmentCapability;
  /** Plaintext, for sealing. NULL for a capability that hands over no secret. */
  readonly secret: string | null;
  readonly instructions: string | null;
  readonly providerArtifactId: string | null;
  readonly expiresAt: Date | null;
}

/** The adapter contract every digital supplier integration implements. */
export interface DigitalSupplierAdapter {
  /** The registry key: a lower-case machine slug, matching `supplier_accounts.provider`. */
  readonly provider: string;
  /** This integration's own version, recorded on the capability row it was verified against. */
  readonly version: string;
  /** What this integration implements. The conformance suite checks it against reality. */
  readonly capabilities: readonly DigitalSupplierApiCapability[];

  preflight(
    request: PreflightRequest,
    context: AdapterContext,
  ): Promise<AdapterResult<PreflightResponse>>;

  purchase(
    request: PurchaseRequest,
    context: AdapterContext,
  ): Promise<AdapterResult<PurchaseResponse>>;

  /** Ask whether an idempotency key already bought something. NEVER optional. */
  recoverPurchase(
    idempotencyKey: string,
    context: AdapterContext,
  ): Promise<AdapterResult<RecoveryResponse>>;

  getFulfilment(
    providerOrderId: string,
    context: AdapterContext,
  ): Promise<AdapterResult<FulfilmentArtifactPayload>>;

  health(context: AdapterContext): Promise<AdapterResult<{ readonly ok: boolean }>>;

  /** Optional, per provider capability. Absence is `unsupported`, never a failure. */
  cancel?(
    providerOrderId: string,
    context: AdapterContext,
  ): Promise<AdapterResult<{ readonly cancelled: boolean }>>;

  /** Optional. Whether the supplier has credited a returned or invalid artifact. */
  creditStatus?(
    providerOrderId: string,
    context: AdapterContext,
  ): Promise<AdapterResult<{ readonly credited: boolean; readonly amount: number | null }>>;
}

/** One word-ish run of key alphabet characters. Underscores split tokens. */
const TOKEN = /[A-Za-z0-9][A-Za-z0-9-]*/g;

/**
 * Whether a token looks like key material rather than like a word.
 *
 * The first version of this redacted every run of eight or more characters, which
 * is correct and useless: it turned `out of stock, order rejected` into
 * `out of stock, order [redacted]`, and a redaction nobody can read is one
 * somebody turns off.
 *
 * So the test is SHAPE, not length alone. A dash, a digit, an all-capitals run or
 * sixteen characters of anything are all things keys have and English words do
 * not. The residual gap — a lowercase, digit-free key under sixteen characters —
 * is stated rather than hidden, and it is narrow: this redacts a PROVIDER's
 * message, the artifact plaintext never passes through here, and the conformance
 * suite separately fails an adapter that puts a secret in one.
 */
function looksLikeKeyMaterial(token: string): boolean {
  if (token.length < 8) return false;
  if (token.length >= 16) return true;
  if (token.includes('-')) return true;
  if (/\d/.test(token)) return true;
  return token === token.toUpperCase() && /[A-Z]/.test(token);
}

/**
 * Redact a provider message before it is stored or logged.
 *
 * Two rules, both conservative: anything key-shaped goes, and the result is
 * truncated. The epic's Workstream 19 requirement 6 asks for redaction before
 * logging; doing it at the PORT rather than at each log site means a message that
 * was never redacted cannot exist in the first place.
 */
export function redactProviderMessage(message: unknown, limit = 200): string {
  const text = typeof message === 'string' ? message : String(message ?? '');
  return text
    .replace(TOKEN, (token) => (looksLikeKeyMaterial(token) ? '[redacted]' : token))
    .slice(0, limit);
}

/**
 * Run one adapter operation, converting a throw into a normalized failure.
 *
 * An adapter that throws is a bug in that adapter, and it must not become an
 * exception in an orchestration whose whole job is to know whether money was
 * spent. `other` is the honest kind for it: it is NOT in
 * `AMBIGUOUS_PROCUREMENT_ERROR_KINDS`, so a throw does not silently license a
 * fallback — the attempt fails, loudly, and a human looks at it.
 */
export async function runAdapterOperation<T>(
  operation: () => Promise<AdapterResult<T>>,
): Promise<AdapterResult<T>> {
  try {
    return await operation();
  } catch (error) {
    return {
      ok: false,
      failure: {
        kind: 'other',
        messageRedacted: redactProviderMessage(
          error instanceof Error ? error.message : error,
        ),
      },
    };
  }
}
