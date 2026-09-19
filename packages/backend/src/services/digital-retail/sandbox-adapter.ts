/**
 * The sandbox adapter — a CONFORMANCE FIXTURE, not a pilot (#1016, ADR 0011).
 *
 * The epic forbids coding against guessed provider capabilities before an account
 * and its exact terms have been verified: *"do not code against guessed
 * capabilities before this review exists"*. So this repository ships no named
 * distributor integration, and what it ships instead is an adapter that
 * implements the port honestly — including every failure mode the orchestrator
 * has to survive — so the conformance suite, the exactly-once property and the
 * ambiguity recovery are exercised against something real.
 *
 * ## It is scripted, and the script is the point
 *
 * Every behaviour a real supplier produces is reachable by a `script` entry:
 * acceptance, rejection, an out-of-stock answer, a cost increase, a rate limit,
 * and — the one that matters most — a TIMEOUT whose purchase actually
 * SUCCEEDED on the supplier's side. That last case is what an ambiguous attempt
 * is, and it is the one a mocked adapter never produces: the recovery call finds
 * the order, so a fallback that had been allowed to run would have bought twice.
 *
 * ## Its ledger is in memory and its idempotency is real
 *
 * `purchase` keyed by idempotency key, `recoverPurchase` reading the same map. An
 * adapter whose idempotency is faked would let the orchestrator's own mechanisms
 * pass a test they do not actually satisfy.
 */

import { randomUUID } from 'node:crypto';
import type {
  DigitalFulfilmentCapability,
  DigitalProcurementErrorKind,
} from '@mercaria/shared-types';
import type {
  AdapterContext,
  AdapterResult,
  DigitalSupplierAdapter,
  FulfilmentArtifactPayload,
  PreflightRequest,
  PreflightResponse,
  PurchaseRequest,
  PurchaseResponse,
  RecoveryResponse,
} from './adapter.js';

/** What the sandbox should do for one SKU. Unlisted SKUs simply succeed. */
export interface SandboxScriptEntry {
  /** Refuse the preflight with this kind. */
  readonly preflightFails?: DigitalProcurementErrorKind;
  /** Report this availability rather than `in_stock`. */
  readonly availability?: PreflightResponse['available'];
  /** Quote this cost, in minor units. Default 1000. */
  readonly costAmount?: number;
  /** Refuse the purchase with this kind, having bought NOTHING. */
  readonly purchaseFails?: DigitalProcurementErrorKind;
  /**
   * Refuse the purchase with this kind, having ACTUALLY BOUGHT the thing.
   *
   * The ambiguous case, and the only honest way to test recovery: the caller sees
   * a failure, the supplier has an order, and `recoverPurchase` finds it.
   */
  readonly purchaseFailsAfterBuying?: DigitalProcurementErrorKind;
  /** Hand over this capability rather than `activation_key`. */
  readonly capability?: DigitalFulfilmentCapability;
  /** Deliver the artifact on a later `getFulfilment` rather than immediately. */
  readonly fulfilmentDeferred?: boolean;
}

export interface SandboxAdapterOptions {
  readonly provider?: string;
  readonly script?: Readonly<Record<string, SandboxScriptEntry>>;
  /** The artifact secret handed over. Deterministic, so a test can assert on it. */
  readonly secretFor?: (sku: string) => string;
}

interface SandboxOrder {
  readonly providerOrderId: string;
  readonly sku: string;
  readonly capability: DigitalFulfilmentCapability;
  readonly costAmount: number;
  readonly currency: string;
}

const DEFAULT_COST = 1_000;

/** Build a sandbox adapter with its own private ledger. */
export function createSandboxAdapter(options: SandboxAdapterOptions = {}): DigitalSupplierAdapter & {
  /** Every order the sandbox believes it has sold. Test-only. */
  readonly orders: ReadonlyMap<string, SandboxOrder>;
} {
  const script = options.script ?? {};
  const secretFor = options.secretFor ?? ((sku: string) => `SANDBOX-${sku.toUpperCase()}-KEY`);
  /** Keyed by IDEMPOTENCY KEY, which is what makes the idempotency real. */
  const orders = new Map<string, SandboxOrder>();

  const entry = (sku: string): SandboxScriptEntry => script[sku] ?? {};

  const adapter: DigitalSupplierAdapter & { readonly orders: ReadonlyMap<string, SandboxOrder> } = {
    provider: options.provider ?? 'sandbox',
    version: '1.0.0',
    capabilities: [
      'catalog_sync',
      'product_lookup',
      'stock_query',
      'quote',
      'preflight',
      'purchase',
      'purchase_recovery',
      'fulfilment_fetch',
      'order_status',
      'cancel',
      'health',
    ],
    orders,

    async preflight(
      request: PreflightRequest,
      _context: AdapterContext,
    ): Promise<AdapterResult<PreflightResponse>> {
      const scripted = entry(request.supplierSku);
      if (scripted.preflightFails) {
        return {
          ok: false,
          failure: {
            kind: scripted.preflightFails,
            messageRedacted: `sandbox refused preflight for ${request.supplierSku}`,
          },
        };
      }
      return {
        ok: true,
        value: {
          available: scripted.availability ?? 'in_stock',
          costAmount: scripted.costAmount ?? DEFAULT_COST,
          costCurrency: request.expectedCurrency,
          capability: scripted.capability ?? request.expectedCapability,
          productClass: 'digital_game',
          platform: 'pc',
          activationEcosystem: 'sandbox-store',
          edition: 'standard',
          activationTerritories: [request.activationTerritory.toUpperCase()],
          quoteTtlSeconds: 900,
          expectedFulfilmentSeconds: 5,
          fundingReady: true,
        },
      };
    },

    async purchase(
      request: PurchaseRequest,
      _context: AdapterContext,
    ): Promise<AdapterResult<PurchaseResponse>> {
      const scripted = entry(request.supplierSku);
      const existing = orders.get(request.idempotencyKey);
      if (existing) {
        // The provider's own idempotency: a replayed key returns the SAME order
        // rather than creating a second. Nothing in Mercaria should ever rely on
        // this alone, which is why the database carries its own two mechanisms —
        // but an adapter that did not do it would be a bad fixture.
        return {
          ok: true,
          value: {
            providerOrderId: existing.providerOrderId,
            accepted: true,
            finalCostAmount: existing.costAmount,
            finalCostCurrency: existing.currency,
            fulfilmentReady: !scripted.fulfilmentDeferred,
          },
        };
      }

      if (scripted.purchaseFails) {
        return {
          ok: false,
          failure: {
            kind: scripted.purchaseFails,
            messageRedacted: `sandbox refused purchase for ${request.supplierSku}`,
          },
        };
      }

      const cost = scripted.costAmount ?? DEFAULT_COST;
      if (cost > request.maxAcceptedCostAmount) {
        // The adapter REFUSES above the bound rather than absorbing the
        // difference — the contract's rule, and the reason a cost increase can
        // never reach a customer without consent.
        return {
          ok: false,
          failure: {
            kind: 'price_changed',
            messageRedacted: 'sandbox cost exceeds the accepted maximum',
          },
        };
      }

      const order: SandboxOrder = {
        providerOrderId: `sbx_${randomUUID()}`,
        sku: request.supplierSku,
        capability: scripted.capability ?? 'activation_key',
        costAmount: cost,
        currency: request.currency,
      };
      orders.set(request.idempotencyKey, order);

      if (scripted.purchaseFailsAfterBuying) {
        // BOUGHT, then failed to say so. This is the shape that makes a naive
        // fallback buy twice, and the only reason `recoverPurchase` exists.
        return {
          ok: false,
          failure: {
            kind: scripted.purchaseFailsAfterBuying,
            messageRedacted: 'sandbox lost the connection after allocating',
          },
        };
      }

      return {
        ok: true,
        value: {
          providerOrderId: order.providerOrderId,
          accepted: true,
          finalCostAmount: order.costAmount,
          finalCostCurrency: order.currency,
          fulfilmentReady: !scripted.fulfilmentDeferred,
        },
      };
    },

    async recoverPurchase(
      idempotencyKey: string,
      _context: AdapterContext,
    ): Promise<AdapterResult<RecoveryResponse>> {
      const existing = orders.get(idempotencyKey);
      if (!existing) return { ok: true, value: { found: false } };
      return {
        ok: true,
        value: {
          found: true,
          purchase: {
            providerOrderId: existing.providerOrderId,
            accepted: true,
            finalCostAmount: existing.costAmount,
            finalCostCurrency: existing.currency,
            fulfilmentReady: true,
          },
        },
      };
    },

    async getFulfilment(
      providerOrderId: string,
      _context: AdapterContext,
    ): Promise<AdapterResult<FulfilmentArtifactPayload>> {
      const order = [...orders.values()].find(
        (candidate) => candidate.providerOrderId === providerOrderId,
      );
      if (!order) {
        return {
          ok: false,
          failure: { kind: 'sku_unknown', messageRedacted: 'sandbox has no such order' },
        };
      }
      const secretBearing =
        order.capability === 'activation_key' ||
        order.capability === 'redemption_code' ||
        order.capability === 'licence_token';
      return {
        ok: true,
        value: {
          capability: order.capability,
          secret: secretBearing ? secretFor(order.sku) : null,
          instructions: 'Redeem this in the sandbox store.',
          providerArtifactId: `art_${order.providerOrderId}`,
          expiresAt: null,
        },
      };
    },

    async cancel(
      providerOrderId: string,
      _context: AdapterContext,
    ): Promise<AdapterResult<{ readonly cancelled: boolean }>> {
      for (const [key, order] of orders) {
        if (order.providerOrderId === providerOrderId) {
          orders.delete(key);
          return { ok: true, value: { cancelled: true } };
        }
      }
      return { ok: true, value: { cancelled: false } };
    },

    async health(_context: AdapterContext): Promise<AdapterResult<{ readonly ok: boolean }>> {
      return { ok: true, value: { ok: true } };
    },
  };

  return adapter;
}
