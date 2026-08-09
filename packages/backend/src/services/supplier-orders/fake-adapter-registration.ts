/**
 * Registering the fake order adapter — the FIRST of its two gates.
 *
 * Kept out of `adapters/` on purpose: that directory is scanned by
 * `supplier-order-isolation.test.ts` and may import no config, no service and
 * no repository, which is exactly what makes the wall meaningful for #125's
 * real adapter. Registration reads `config`, so it lives here, one level up.
 *
 * The SECOND gate — the refusal of any `live` supplier account at call time — is
 * inside the adapter itself and is not conditional on this one. A flag is
 * exactly the thing that gets copied between environments.
 */

import { config } from '../../config/index.js';
import { registerSupplierAdapter } from '../supplier-preflight/registry.js';
import { fakeOrderAdapterInstance } from './adapters/fake-order-adapter.js';

/**
 * Put the fake order adapter in the registry.
 *
 * Throws when the flag is off rather than no-opping: a test or a staging
 * runbook that called this and got silence would go on to assert against
 * whatever the registry did hold, and the failure would read as a missing
 * supplier rather than as a missing flag — #122's `registerFakeSupplierAdapter`
 * reasoning, verbatim.
 */
export function registerFakeOrderAdapter(): void {
  if (!config.procurement.fakeAdapterEnabled) {
    throw new Error(
      'PROCUREMENT_FAKE_ADAPTER_ENABLED is off. The fake supplier order adapter fabricates ' +
        'acceptances, shipments and cancellations, and is registrable only where that is ' +
        'intended.',
    );
  }
  registerSupplierAdapter(fakeOrderAdapterInstance());
}
