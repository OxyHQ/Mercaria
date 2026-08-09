/**
 * The ONE chokepoint every provider call in this domain goes through.
 *
 * Every gate, every lease, every attempt row and every error normalization
 * lives here, so a new operation (a return, an invoice retrieval, #125's first
 * real adapter) gets all of it by construction rather than by whoever writes
 * the call site remembering. `supplier-order-isolation.test.ts` fails the build
 * if any module in this domain invokes an adapter method directly.
 *
 * ## What runs, in order, and why the order matters
 *
 *  1. **The account.** Its state, credential status and kill switch (#118).
 *     Read FIRST because a killed account must not consume a provider lease
 *     slot that a healthy account is waiting for.
 *  2. **The suppression.** #122's operator stop, reused rather than duplicated:
 *     one kill-switch mechanism for the whole supply side, so an operator who
 *     stops a supplier stops it for quoting and for ordering with one act.
 *  3. **The capability.** An operation whose capability the adapter did not
 *     declare is REFUSED and recorded, never simulated.
 *  4. **The fetch lever.** Read-only operations are gated by
 *     `PROCUREMENT_PROVIDER_FETCH_ENABLED`; a SUBMISSION and a CANCELLATION are
 *     deliberately not, because those are consequences of money that has
 *     already moved and pausing them silently would strand a paid order.
 *  5. **The provider lease** (#122's `supplier_call_leases`), so the outbound
 *     rate this domain adds is counted in the same budget the preflight spends
 *     from. Two independent limiters against one supplier's published limit is
 *     how a supplier starts refusing Mercaria at checkout time.
 *  6. **The attempt row**, committed `in_flight` BEFORE the call.
 *  7. **The call**, with its deadline.
 *  8. **The attempt row's terminal outcome**, and the lease released.
 *
 * ## A refusal is an OUTCOME, not a skipped call
 *
 * Every gate above writes an attempt row with `outcome: 'refused'` and a named
 * reason. "We never asked" and "we asked and it failed" lead an operator to
 * opposite conclusions, and a gate that returned early without a trace would
 * make the first invisible.
 */

import { randomUUID } from 'node:crypto';
import type {
  SupplierAdapterCapability,
  SupplierOrderOperation,
  SupplierOrderRefusalReason,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { log } from '../../lib/logger.js';
import {
  findSupplierAccountById,
  readCredentialReference,
  type SupplierAccountRecord,
} from '../../db/procurement/supplierAccountRepository.js';
import {
  claimSupplierCallLease,
  releaseSupplierCallLease,
} from '../../db/supplierPreflight/callLeaseRepository.js';
import { findLiveSupplierPreflightSuppression } from '../../db/supplierPreflight/suppressionRepository.js';
import {
  closeSupplierOrderAttempt,
  openSupplierOrderAttempt,
  type PublicSupplierOrderAttempt,
} from '../../db/supplierOrders/attemptRepository.js';
import type { SupplierPreflightAdapter } from '../supplier-preflight/adapter.js';
import { findSupplierAdapter } from '../supplier-preflight/registry.js';
import type { SupplierOrderAdapter } from './adapter.js';
import { readSupplierCredential } from './credential.port.js';
import { normalizeProviderFailure } from './provider-error.js';
import { redactSupplierOrderMessage, redactSupplierReference } from './redact.js';

/** Default provider budget when the account states none — deliberately modest. */
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_CALLS_PER_MINUTE = 60;

/** The operations that READ rather than change anything at the provider. */
const READ_ONLY_OPERATIONS: readonly SupplierOrderOperation[] = [
  'reference_lookup',
  'read',
  'shipments',
  'invoice',
  'credit_note',
  'return_read',
  'draft_validate',
];

/** Which declared capability each operation requires. */
const OPERATION_CAPABILITY: Readonly<Record<SupplierOrderOperation, SupplierAdapterCapability>> = {
  draft_validate: 'order_draft_validation',
  submit: 'order_draft_submission',
  reference_lookup: 'order_reference_lookup',
  read: 'order_state_read',
  cancel: 'order_cancellation',
  shipments: 'shipment_read',
  invoice: 'invoice_retrieval',
  credit_note: 'credit_note_retrieval',
  return_create: 'return_authorization',
  return_read: 'return_authorization',
};

/** What a caller hands the chokepoint. */
export interface SupplierProviderCallInput<T> {
  purchaseOrderId: string;
  supplierAccountId: string;
  supplierId: string;
  operation: SupplierOrderOperation;
  /** The digest of the canonical request — committed before the call. */
  requestHash: string;
  /** The call itself. Receives the adapter and the resolved account context. */
  invoke: (context: SupplierAdapterInvocation) => Promise<T>;
  /** Pull the provider object id out of the answer, for the attempt row. */
  providerObjectIdOf?: (answer: T) => string | null;
  now?: Date;
}

/** What the invocation is handed. */
export interface SupplierAdapterInvocation {
  adapter: SupplierOrderAdapter;
  providerAccountId: string;
  environment: 'test' | 'live';
  /** Resolved per call from the approved secret system — never cached here. */
  credential: string;
  timeoutMs: number;
}

/**
 * A provider call's outcome.
 *
 * Three branches and no common field, so a caller cannot read `answer` without
 * having established which branch it is in — the `CommerceActor` rule (ADR 0003
 * I1) applied to something that costs money. `ambiguous` is deliberately NOT a
 * flavour of `failed`: they route in opposite directions, one to a lookup and
 * one to a retry.
 */
export type SupplierProviderCallResult<T> =
  | { outcome: 'succeeded'; answer: T; attempt: PublicSupplierOrderAttempt; adapter: SupplierOrderAdapter }
  | {
      outcome: 'failed';
      attempt: PublicSupplierOrderAttempt;
      errorClass: string;
      retryable: boolean;
      message: string;
    }
  | { outcome: 'ambiguous'; attempt: PublicSupplierOrderAttempt; message: string }
  | { outcome: 'refused'; attempt: PublicSupplierOrderAttempt; reason: SupplierOrderRefusalReason };

/**
 * Make one provider call, with every gate, the lease and the attempt log.
 *
 * Never throws for a provider failure — a failure is a RESULT here, because the
 * caller has to decide what it means for the purchase order and a thrown error
 * would route that decision into the outbox's generic retry instead.
 */
export async function callSupplierProvider<T>(
  input: SupplierProviderCallInput<T>,
): Promise<SupplierProviderCallResult<T>> {
  const now = input.now ?? new Date();

  const account = await findSupplierAccountById(input.supplierAccountId);
  if (!account) {
    return await refuse(input, 'account_not_active', now);
  }
  if (account.state === 'killed') {
    return await refuse(input, 'account_kill_switched', now);
  }
  if (account.state !== 'active') {
    return await refuse(input, 'account_not_active', now);
  }
  if (account.credentialStatus !== 'valid') {
    return await refuse(input, 'credential_not_valid', now);
  }
  // The account's own credential column is a PATH; the value behind it comes
  // from the approved secret system through a port whose default refuses. A
  // deployment with no secret reader therefore places no supplier orders and
  // records WHY, rather than calling a provider unauthenticated.
  const reference = await readCredentialReference(account.id);
  const credential = await readSupplierCredential(reference ?? null);
  if (credential === null) {
    return await refuse(input, 'credential_not_valid', now);
  }

  const suppression = await findLiveSupplierPreflightSuppression({
    scope: 'supplier_account',
    supplierId: null,
    supplierAccountId: account.id,
    marketCountry: null,
    kind: 'kill_switch',
  });
  if (suppression) {
    return await refuse(input, 'supplier_suppressed', now);
  }

  const adapter = resolveOrderAdapter(account.provider);
  if (!adapter) {
    return await refuse(input, 'provider_unconfigured', now);
  }
  if (!adapter.capabilities.includes(OPERATION_CAPABILITY[input.operation])) {
    return await refuse(input, 'capability_not_declared', now);
  }
  if (READ_ONLY_OPERATIONS.includes(input.operation) && !config.procurement.providerFetchEnabled) {
    return await refuse(input, 'provider_fetch_disabled', now);
  }

  const leaseOwner = `procurement:${String(process.pid)}:${randomUUID()}`;
  const lease = await claimSupplierCallLease({
    budget: {
      supplierAccountId: account.id,
      maxConcurrency: DEFAULT_MAX_CONCURRENCY,
      maxCallsPerMinute: account.rateLimitPerMinute ?? DEFAULT_MAX_CALLS_PER_MINUTE,
    },
    leaseOwner,
    leaseMs: config.procurement.callTimeoutMs * 2,
    now,
  });
  if (!lease.granted) {
    return await refuse(input, 'provider_lease_unavailable', now);
  }

  const attempt = await openSupplierOrderAttempt({
    purchaseOrderId: input.purchaseOrderId,
    supplierAccountId: account.id,
    operation: input.operation,
    requestHash: input.requestHash,
    startedAt: now,
  });

  try {
    const answer = await input.invoke({
      adapter,
      providerAccountId: account.providerAccountId,
      environment: account.environment,
      credential,
      timeoutMs: config.procurement.callTimeoutMs,
    });
    const providerObjectId = input.providerObjectIdOf?.(answer) ?? null;
    const closed = await closeSupplierOrderAttempt({
      attemptId: attempt.id,
      outcome: 'succeeded',
      stateMappingVersion: adapter.stateMappingVersion,
      ...(providerObjectId ? { providerObjectId } : {}),
    });
    return { outcome: 'succeeded', answer, attempt: closed ?? attempt, adapter };
  } catch (error: unknown) {
    const failure = normalizeProviderFailure(error);
    const message = redactSupplierOrderMessage(failure.message);
    // The ambiguity rule, in ONE place: anything that is not a definite
    // "nothing was written" is ambiguous. See `provider-error.ts`.
    const ambiguous = failure.afterWriteFlag !== 'no' && !READ_ONLY_OPERATIONS.includes(input.operation);
    const closed = await closeSupplierOrderAttempt({
      attemptId: attempt.id,
      outcome: ambiguous ? 'ambiguous' : 'failed',
      providerErrorClass: failure.errorClass,
      providerErrorAfterWrite: ambiguous ? 'yes' : failure.afterWriteFlag,
      ...(failure.providerCode ? { providerErrorCode: failure.providerCode } : {}),
      providerMessage: message,
    });
    log.general.warn(
      {
        purchaseOrderId: input.purchaseOrderId,
        operation: input.operation,
        supplierAccount: redactSupplierReference(account.providerAccountId),
        errorClass: failure.errorClass,
        afterWrite: failure.afterWriteFlag,
      },
      ambiguous ? '[Procurement] provider call AMBIGUOUS' : '[Procurement] provider call failed',
    );
    return ambiguous
      ? { outcome: 'ambiguous', attempt: closed ?? attempt, message }
      : {
          outcome: 'failed',
          attempt: closed ?? attempt,
          errorClass: failure.errorClass,
          retryable: failure.errorClass === 'retryable' || failure.errorClass === 'quota',
          message,
        };
  } finally {
    await releaseSupplierCallLease({ leaseId: lease.leaseId, leaseOwner });
  }
}

/**
 * Record a refusal and return it.
 *
 * The attempt row is written even though no call was made, which is the point:
 * an operator reading a purchase order that never moved needs to see WHY
 * nothing was sent, and a gate that returned early would leave the trace
 * looking as though the dispatcher never ran.
 */
async function refuse<T>(
  input: SupplierProviderCallInput<T>,
  reason: SupplierOrderRefusalReason,
  now: Date,
): Promise<SupplierProviderCallResult<T>> {
  const attempt = await openSupplierOrderAttempt({
    purchaseOrderId: input.purchaseOrderId,
    supplierAccountId: input.supplierAccountId,
    operation: input.operation,
    requestHash: input.requestHash,
    startedAt: now,
  });
  const closed = await closeSupplierOrderAttempt({
    attemptId: attempt.id,
    outcome: 'refused',
    refusalReason: reason,
    completedAt: now,
  });
  return { outcome: 'refused', attempt: closed ?? attempt, reason };
}

/**
 * The registered adapter for one provider slug, narrowed to the order contract.
 *
 * A preflight-only adapter is a legitimate registration (#122 shipped before
 * #124), so the narrowing is a real question rather than a formality: an
 * adapter with no `stateMappingVersion` and no `mapProviderState` cannot serve
 * an order operation, and answering `undefined` here routes that to
 * `provider_unconfigured` — a refusal an operator can act on, rather than a
 * `TypeError` in a dispatcher.
 */
export function resolveOrderAdapter(provider: string): SupplierOrderAdapter | undefined {
  const adapter = findSupplierAdapter(provider);
  if (!adapter) return undefined;
  return isSupplierOrderAdapter(adapter) ? adapter : undefined;
}

/** Whether a registered preflight adapter also carries the order contract. */
function isSupplierOrderAdapter(adapter: SupplierPreflightAdapter): adapter is SupplierOrderAdapter {
  const mapState: unknown = Reflect.get(adapter, 'mapProviderState');
  const version: unknown = Reflect.get(adapter, 'stateMappingVersion');
  return typeof mapState === 'function' && typeof version === 'number';
}

/** The account behind one purchase order, for a caller that needs its context. */
export async function readSupplierAccountForCall(
  supplierAccountId: string,
): Promise<SupplierAccountRecord | undefined> {
  return await findSupplierAccountById(supplierAccountId);
}
