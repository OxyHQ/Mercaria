/**
 * The adapter conformance suite (#1016 Workstream 2, acceptance criterion 24).
 *
 * ## Why this is a FUNCTION and not a test file
 *
 * An adapter is verified twice in its life: once in CI against its own fixture,
 * and once against the provider's real sandbox account before anybody enables it
 * — and the second one happens on an operator's machine, in an ops script,
 * against credentials CI must never hold. A conformance suite written as
 * `describe`/`it` can only do the first. This returns FINDINGS, so the same
 * checks run in both places and the answers are comparable.
 *
 * ## What it checks, and what it deliberately cannot
 *
 * It checks the CONTRACT: that the declared capabilities are implemented, that
 * the required ones are present, that idempotency holds, that recovery
 * distinguishes "nothing was bought" from "I could not tell", that the bound is
 * refused rather than absorbed, and that no secret leaks into an error message or
 * into customer-facing instructions.
 *
 * It cannot check that a provider's key is VALID, that their stock is real, or
 * that their terms permit resale. Those are not properties of an adapter — the
 * first two are properties of a live account and the third is an agreement rider
 * a human approves. Saying so here is what keeps a green conformance run from
 * being read as permission to launch.
 */

import {
  REQUIRED_PROCUREMENT_CAPABILITIES,
  type DigitalSupplierApiCapability,
} from '@mercaria/shared-types';
import { adapterFailed, adapterSucceeded } from './adapter.js';
import type { AdapterContext, DigitalSupplierAdapter } from './adapter.js';

/** One thing that is wrong, or one thing that could not be checked. */
export interface ConformanceFinding {
  readonly check: string;
  readonly severity: 'fail' | 'warn';
  readonly detail: string;
}

export interface ConformanceOptions {
  /** A SKU the provider will sell in this environment. */
  readonly sku: string;
  readonly activationTerritory: string;
  readonly currency: string;
  readonly context: AdapterContext;
  /**
   * Whether the run may actually BUY. False in CI against a real account, and the
   * default, because a conformance run that spends money by accident is one
   * nobody will run twice.
   */
  readonly allowPurchase?: boolean;
}

/** Whether a string looks like it contains the secret handed over. */
function mentions(haystack: string | null | undefined, needle: string | null): boolean {
  if (!haystack || !needle || needle.length < 4) return false;
  return haystack.includes(needle);
}

/**
 * Run the suite. Returns every finding; an empty array is a pass.
 *
 * Ordered so the cheap structural checks run before anything touches the network,
 * and so a purchase — the only irreversible step — is last and opt-in.
 */
export async function runAdapterConformance(
  adapter: DigitalSupplierAdapter,
  options: ConformanceOptions,
): Promise<ConformanceFinding[]> {
  const findings: ConformanceFinding[] = [];
  const fail = (check: string, detail: string) =>
    findings.push({ check, severity: 'fail', detail });
  const warn = (check: string, detail: string) =>
    findings.push({ check, severity: 'warn', detail });

  /* ---- structural: the declaration matches the implementation ------------ */

  if (!/^[a-z0-9][a-z0-9_-]*$/.test(adapter.provider)) {
    fail('provider-slug', `"${adapter.provider}" is not a lower-case machine slug`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(adapter.version)) {
    fail('version', `"${adapter.version}" is not a semantic version`);
  }

  const declared = new Set<DigitalSupplierApiCapability>(adapter.capabilities);
  for (const required of REQUIRED_PROCUREMENT_CAPABILITIES) {
    if (!declared.has(required)) {
      fail(
        'required-capability',
        `${required} is required to procure at all — an adapter without ` +
          `purchase_recovery makes an ambiguous attempt unrecoverable`,
      );
    }
  }
  // A declared optional capability with no method is worse than an undeclared
  // one: the account's capability rows are created FROM this list, and a
  // capability row nothing implements is a kill switch over nothing.
  if (declared.has('cancel') && typeof adapter.cancel !== 'function') {
    fail('declared-not-implemented', 'cancel is declared but not implemented');
  }
  if (declared.has('credit_status') && typeof adapter.creditStatus !== 'function') {
    fail('declared-not-implemented', 'credit_status is declared but not implemented');
  }
  if (!declared.has('cancel') && typeof adapter.cancel === 'function') {
    warn('implemented-not-declared', 'cancel is implemented but not declared');
  }

  /* ---- health ------------------------------------------------------------ */

  const health = await adapter.health(options.context);
  if (adapterFailed(health)) {
    fail('health', `health returned ${health.failure.kind}: ${health.failure.messageRedacted}`);
    // Everything below needs a reachable provider; stopping here keeps the report
    // about the one thing that is wrong rather than about its consequences.
    return findings;
  }

  /* ---- preflight --------------------------------------------------------- */

  const preflight = await adapter.preflight(
    {
      supplierSku: options.sku,
      quantity: 1,
      activationTerritory: options.activationTerritory,
      expectedCapability: 'activation_key',
      expectedCurrency: options.currency,
    },
    options.context,
  );
  if (adapterFailed(preflight)) {
    fail('preflight', `preflight returned ${preflight.failure.kind}`);
    return findings;
  }
  if (preflight.value.costCurrency !== options.currency) {
    fail(
      'preflight-currency',
      `quoted ${preflight.value.costCurrency} for a request in ${options.currency}; ` +
        `a converted quote is a cost Mercaria cannot reconcile`,
    );
  }
  if (!Number.isInteger(preflight.value.costAmount) || preflight.value.costAmount <= 0) {
    fail('preflight-cost', 'cost must be a positive integer count of minor units');
  }
  if (preflight.value.activationTerritories.length === 0) {
    warn(
      'preflight-territories',
      'no activation territory reported; an offer built from this cannot be ' +
        'checked against the rider and will be refused as territory_not_permitted',
    );
  }

  /* ---- recovery of something that was never bought ----------------------- */

  const unknownKey = `dpo:conformance-${Date.now()}:1`;
  const recovery = await adapter.recoverPurchase(unknownKey, options.context);
  if (adapterFailed(recovery)) {
    fail(
      'recovery-unknown',
      `recoverPurchase failed for an unused key (${recovery.failure.kind}); it must ` +
        `answer "nothing was bought", which is a positive answer and not an error`,
    );
  } else if (adapterSucceeded(recovery) && recovery.value.found) {
    fail('recovery-unknown', 'recoverPurchase claimed an unused idempotency key exists');
  }

  if (options.allowPurchase !== true) {
    warn(
      'purchase',
      'purchase, idempotency, bound-refusal and fulfilment were NOT exercised ' +
        '(allowPurchase is off). A conformance run without them proves the shape, not the behaviour.',
    );
    return findings;
  }

  /* ---- the bound is refused, never absorbed ------------------------------ */

  const belowCost = Math.max(1, preflight.value.costAmount - 1);
  const refused = await adapter.purchase(
    {
      idempotencyKey: `dpo:conformance-bound-${Date.now()}:1`,
      supplierSku: options.sku,
      quantity: 1,
      activationTerritory: options.activationTerritory,
      maxAcceptedCostAmount: belowCost,
      currency: options.currency,
    },
    options.context,
  );
  if (adapterSucceeded(refused)) {
    fail(
      'bound-refusal',
      'a purchase above max_accepted_cost was ACCEPTED; the bound is what stops a ' +
        'cost increase reaching a customer who never agreed to it',
    );
  }

  /* ---- idempotency ------------------------------------------------------- */

  const key = `dpo:conformance-${Date.now()}:2`;
  const first = await adapter.purchase(
    {
      idempotencyKey: key,
      supplierSku: options.sku,
      quantity: 1,
      activationTerritory: options.activationTerritory,
      maxAcceptedCostAmount: preflight.value.costAmount,
      currency: options.currency,
    },
    options.context,
  );
  if (adapterFailed(first)) {
    fail('purchase', `purchase returned ${first.failure.kind}`);
    return findings;
  }
  const second = await adapter.purchase(
    {
      idempotencyKey: key,
      supplierSku: options.sku,
      quantity: 1,
      activationTerritory: options.activationTerritory,
      maxAcceptedCostAmount: preflight.value.costAmount,
      currency: options.currency,
    },
    options.context,
  );
  if (adapterFailed(second)) {
    fail('idempotency', `a replayed idempotency key returned ${second.failure.kind}`);
  } else if (adapterSucceeded(second) && second.value.providerOrderId !== first.value.providerOrderId) {
    fail(
      'idempotency',
      `a replayed idempotency key produced a SECOND order ` +
        `(${first.value.providerOrderId} then ${second.value.providerOrderId})`,
    );
  }

  /* ---- fulfilment, and the secret-leak checks ---------------------------- */

  const fulfilment = await adapter.getFulfilment(first.value.providerOrderId, options.context);
  if (adapterFailed(fulfilment)) {
    fail('fulfilment', `getFulfilment returned ${fulfilment.failure.kind}`);
    return findings;
  }
  const secret = fulfilment.value.secret;
  if (mentions(fulfilment.value.instructions, secret)) {
    fail(
      'secret-in-instructions',
      'the artifact secret appears in the customer-facing instructions, which are ' +
        'stored unsealed and rendered without a reveal',
    );
  }
  const recovered = await adapter.recoverPurchase(key, options.context);
  if (adapterSucceeded(recovered) && recovered.value.found === false) {
    fail(
      'recovery-known',
      'recoverPurchase did not find an order this run had just bought; an ' +
        'ambiguous attempt against this provider would be unrecoverable',
    );
  }
  if (adapterFailed(recovered) && mentions(recovered.failure.messageRedacted, secret)) {
    fail('secret-in-error', 'the artifact secret appears in a redacted error message');
  }

  return findings;
}
