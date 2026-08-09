/**
 * The fake supplier adapter and its failure-injection tooling (#122 operations
 * 7–8).
 *
 * #122 asks for tooling that can produce a timeout, a cost change, a stock loss
 * and a reservation expiry on demand, and for test mode to be clearly separated
 * from production. Both are the same requirement seen from two sides: the only
 * way to rehearse those four failures is to make a supplier produce them, and
 * the only safe way to do that is an adapter that cannot reach a live account.
 *
 * ## Two independent gates, and neither is sufficient alone
 *
 * 1. `SUPPLIER_PREFLIGHT_FAKE_ADAPTER_ENABLED` must be on for the adapter to be
 *    registrable at all. Default false, so a production deployment that never
 *    sets it has no fake adapter in its registry.
 * 2. The adapter REFUSES a `live` supplier account at call time, whatever the
 *    flag says. So a staging flag accidentally set in production still cannot
 *    fabricate an answer for a real supplier account, and the refusal is a
 *    `contract_violation` an operator sees rather than a silent fallback.
 *
 * The second gate is the load-bearing one, because a flag is exactly the thing
 * that gets copied between environments.
 *
 * ## Injection is process-local, and that is stated rather than hidden
 *
 * The scenario map lives in this module, so it applies to ONE ECS task. That is
 * correct for a rehearsal tool driven from a test or a single-task staging
 * environment, and it is why this is not exposed on the operator surface: an
 * operator flipping a scenario in production would affect whichever task
 * happened to serve their request, which is worse than not offering it.
 */

import { randomUUID } from 'node:crypto';
import type { CurrencyCode, SupplierPreflightAnswer } from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import {
  type SupplierAdapterQuoteInput,
  type SupplierAdapterReleaseInput,
  type SupplierPreflightAdapter,
} from './adapter.js';
import { registerSupplierAdapter } from './registry.js';

/** The slug a `supplier_accounts.provider` must carry to reach this adapter. */
export const FAKE_SUPPLIER_PROVIDER = 'mercaria-fake';

/** The four failures #122 operations 8 names, plus the two transport ones. */
export type FakeSupplierScenario =
  | 'healthy'
  | 'timeout'
  | 'cost_change'
  | 'stock_loss'
  | 'reservation_expiry'
  | 'rate_limited'
  | 'provider_error'
  /** Claims a reservation WITHOUT declaring the capability — the honesty probe. */
  | 'undeclared_reservation';

/** Everything the fake adapter answers with, when it is being healthy. */
export interface FakeSupplierBaseline {
  unitCostMinor: number;
  shippingCostMinor: number;
  currency: CurrencyCode;
  availableQuantity: number;
  deliveryDaysMin: number;
  deliveryDaysMax: number;
}

const DEFAULT_BASELINE: FakeSupplierBaseline = {
  unitCostMinor: 1_000,
  shippingCostMinor: 499,
  currency: 'EUR',
  availableQuantity: 50,
  deliveryDaysMin: 2,
  deliveryDaysMax: 5,
};

/** SKU → the scenario that SKU produces. Process-local; see the module docblock. */
const scenarios = new Map<string, FakeSupplierScenario>();
let baseline: FakeSupplierBaseline = DEFAULT_BASELINE;

/** Make one SKU produce one failure. */
export function injectFakeSupplierScenario(
  supplierSku: string,
  scenario: FakeSupplierScenario,
): void {
  scenarios.set(supplierSku, scenario);
}

/** Change what a healthy answer looks like — the cost-change rehearsal's other half. */
export function setFakeSupplierBaseline(next: Partial<FakeSupplierBaseline>): void {
  baseline = { ...baseline, ...next };
}

/** Forget every injected scenario and restore the default baseline. */
export function clearFakeSupplierScenarios(): void {
  scenarios.clear();
  baseline = DEFAULT_BASELINE;
}

/**
 * The capabilities the fake adapter declares.
 *
 * All twelve, deliberately: the point of a rehearsal adapter is to exercise the
 * paths a fully-capable supplier takes, and an adapter declaring less would
 * make the capability boundary untestable from here. The `undeclared_reservation`
 * scenario is how the OTHER direction is exercised — it answers with a
 * reservation while the runner passes a narrowed capability list, so
 * `applyDeclaredCapabilities` has something real to refuse.
 */
const FAKE_CAPABILITIES = [
  'live_product_lookup',
  'live_stock_lookup',
  'destination_shipping_quote',
  'order_draft_validation',
  'inventory_reservation',
  'quote_expiry',
  'price_guarantee',
  'address_validation',
  'delivery_estimate',
  'tax_duty_estimate',
  'cancellation_before_submission',
  'update_notifications',
] as const;

/** The error a caller sees when a scenario means "the provider did not answer". */
export class FakeSupplierFailure extends Error {
  constructor(readonly scenario: FakeSupplierScenario) {
    super(`Fake supplier adapter injected \`${scenario}\`.`);
    this.name = 'FakeSupplierFailure';
  }
}

const fakeAdapter: SupplierPreflightAdapter = {
  provider: FAKE_SUPPLIER_PROVIDER,
  capabilities: [...FAKE_CAPABILITIES],

  async quote(input: SupplierAdapterQuoteInput): Promise<SupplierPreflightAnswer> {
    assertNotLive(input.environment);

    const scenario = scenarios.get(input.supplierSku) ?? 'healthy';
    if (scenario === 'timeout' || scenario === 'rate_limited' || scenario === 'provider_error') {
      // Thrown rather than returned: these are calls that did not produce an
      // answer, and the runner's catch is what maps them onto `unknown`. A
      // returned answer would rehearse the wrong path.
      throw new FakeSupplierFailure(scenario);
    }

    const available = scenario === 'stock_loss' ? 0 : baseline.availableQuantity;
    const unitCostMinor =
      scenario === 'cost_change' ? Math.round(baseline.unitCostMinor * 1.25) : baseline.unitCostMinor;
    const currency = baseline.currency;
    const serviceCode = 'fake-standard';

    return {
      identity: 'confirmed',
      availability: available > 0 ? 'orderable' : 'unavailable',
      maxOrderableQuantity: available,
      minimumOrderQuantity: 1,
      packSize: 1,
      // PER UNIT, as `SupplierPreflightAnswer.unitCost` declares — the caller
      // multiplies by the quantity. Returning a line total here would make
      // every consumer of a fake quote silently disagree with a real one.
      unitCost: { amount: unitCostMinor, currency },
      supplierFees: null,
      shipping: {
        basis: 'basket',
        cost: { amount: baseline.shippingCostMinor, currency },
        serviceCode,
        guaranteed: true,
      },
      shippingOptions: [
        {
          serviceCode,
          carrier: 'fake-carrier',
          serviceName: 'Standard',
          cost: { amount: baseline.shippingCostMinor, currency },
          basis: 'basket',
          deliveryDaysMin: baseline.deliveryDaysMin,
          deliveryDaysMax: baseline.deliveryDaysMax,
          guaranteed: true,
        },
      ],
      handlingDaysMin: 1,
      handlingDaysMax: 2,
      dispatchDaysMin: 1,
      dispatchDaysMax: 2,
      deliveryDaysMin: baseline.deliveryDaysMin,
      deliveryDaysMax: baseline.deliveryDaysMax,
      tax: null,
      duty: null,
      importResponsibility: 'supplier',
      fulfilmentOriginCountry: 'ES',
      destinationRestrictions: [],
      providerQuoteReference: `fake-quote-${randomUUID()}`,
      providerExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      priceGuarantee: 'guaranteed',
      stockGuarantee: 'guaranteed',
      reservation: buildReservation(input, scenario, available),
      reasonCodes: available > 0 ? [] : ['out_of_stock'],
      sourceRecordRef: null,
    };
  },

  async releaseReservation(input: SupplierAdapterReleaseInput): Promise<void> {
    assertNotLive(input.environment);
    // A release against a fake hold always succeeds. There is deliberately no
    // `release_failure` scenario: the sweep's bounded-retry path is exercised
    // by a real adapter throwing, and a fake one that refused its own holds
    // would only rehearse this module's arithmetic.
  },
};

function buildReservation(
  input: SupplierAdapterQuoteInput,
  scenario: FakeSupplierScenario,
  available: number,
): SupplierPreflightAnswer['reservation'] {
  // An `undeclared_reservation` answers with a hold whatever was asked, so the
  // capability boundary has something to refuse when the runner narrows the
  // declared set. Every other scenario respects the request.
  if (scenario !== 'undeclared_reservation' && (!input.requestReservation || available <= 0)) {
    return { supported: false, reason: 'not_requested' };
  }
  const expiresInMs = scenario === 'reservation_expiry' ? 1_000 : 10 * 60_000;
  return {
    supported: true,
    state: 'reserved',
    providerReservationId: `fake-hold-${randomUUID()}`,
    providerExpiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    singleUse: true,
  };
}

/**
 * The gate that a flag cannot defeat.
 *
 * A `live` supplier account is never served a fabricated answer, whatever
 * `SUPPLIER_PREFLIGHT_FAKE_ADAPTER_ENABLED` says — because a flag is exactly
 * the thing that gets copied between environments, and the consequence here is
 * a customer charged against stock that was never checked.
 */
function assertNotLive(environment: 'test' | 'live'): void {
  if (environment === 'live') {
    throw new Error(
      'The fake supplier adapter refuses a `live` supplier account. It fabricates answers, ' +
        'and a fabricated answer against a live account is a customer charged for stock ' +
        'nobody checked.',
    );
  }
}

/**
 * Put the fake adapter in the registry.
 *
 * Throws when the flag is off rather than no-opping: a test or a staging
 * runbook that called this and got silence would go on to assert against
 * whatever the registry did hold, and the failure would read as a missing
 * supplier rather than as a missing flag.
 */
export function registerFakeSupplierAdapter(): void {
  if (!config.supplierPreflight.fakeAdapterEnabled) {
    throw new Error(
      'SUPPLIER_PREFLIGHT_FAKE_ADAPTER_ENABLED is off. The fake supplier adapter fabricates ' +
        'stock, cost and reservation answers and is registrable only where that is intended.',
    );
  }
  registerSupplierAdapter(fakeAdapter);
}

/** The adapter itself, for a test that wants to drive it without the registry. */
export function fakeSupplierAdapter(): SupplierPreflightAdapter {
  return fakeAdapter;
}
