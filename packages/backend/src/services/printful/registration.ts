/**
 * Putting the Printful adapters in their registries (#125).
 *
 * Kept OUT of both adapter directories on purpose: `services/supplier-orders/adapters/`
 * and `services/ingestion/adapters/` are scanned walls that may import no
 * config, service or repository, which is exactly what makes the write boundary
 * meaningful for the adapters themselves. Registration reads configuration and
 * resolves credentials, so it lives here — `fake-adapter-registration.ts`'s
 * arrangement, one provider over.
 *
 * ## The credential resolver is the live gate's third layer, and it fails closed
 *
 * Mercaria stores a PATH (#118 `supplier_accounts.credential_reference`) and
 * never a secret. This resolver turns a Printful store id into a token by
 * finding the account and asking #124's credential PORT, whose default reader
 * refuses — so a deployment that has registered no secret reader resolves
 * nothing, and every call is refused with the reason named rather than
 * proceeding unauthenticated.
 *
 * There is deliberately no fallback to an environment variable. A token in the
 * process environment is a token in every core dump, every crash report and
 * every `printenv` an operator runs while debugging something else, and the one
 * it would authenticate is a live payment instrument.
 */

import { config } from '../../config/index.js';
import {
  findSupplierAccountByProviderAccount,
  readCredentialReference,
} from '../../db/procurement/supplierAccountRepository.js';
import { registerCatalogSourceAdapter } from '../ingestion/registry.js';
import { createPrintfulCatalogAdapter } from '../ingestion/adapters/printful-catalog.js';
import { registerSupplierAdapter } from '../supplier-preflight/registry.js';
import {
  createPrintfulOrderAdapter,
  PRINTFUL_PROVIDER,
} from '../supplier-orders/adapters/printful.js';
import { readSupplierCredential } from '../supplier-orders/credential.port.js';
import { createPrintfulTransport, type PrintfulCredentialResolver } from './transport.js';

/**
 * Find the token for one Printful store id.
 *
 * BOTH environments are tried, `test` first, because a store id is unique at
 * Printful and a deployment running a rehearsal account alongside a live one
 * must reach the right row. The account's own `environment` column — frozen by
 * trigger (#124) — is what the adapter and the transport then gate on; this
 * lookup only finds the credential.
 */
const resolvePrintfulCredential: PrintfulCredentialResolver = async (providerAccountId) => {
  if (providerAccountId === '') return null;
  for (const environment of ['test', 'live'] as const) {
    const account = await findSupplierAccountByProviderAccount({
      provider: PRINTFUL_PROVIDER,
      environment,
      providerAccountId,
    });
    if (!account) continue;
    const reference = await readCredentialReference(account.id);
    if (reference === undefined || reference === null) continue;
    const secret = await readSupplierCredential(reference);
    if (secret !== null) return secret;
  }
  return null;
};

/**
 * Register both Printful adapters.
 *
 * THROWS when the flag is off rather than no-opping, for
 * `registerFakeOrderAdapter`'s reason: a runbook that called this and got
 * silence would go on to assert against whatever the registries did hold, and
 * the failure would read as a missing supplier rather than as a missing flag.
 *
 * Both adapters share ONE transport, so they share one credential path, one
 * host allow-list and one `afterWrite` model. Two transports would be two
 * answers to "may this deployment talk to Printful".
 */
export function registerPrintfulAdapters(): void {
  if (!config.printful.enabled) {
    throw new Error(
      'PRINTFUL_ENABLED is off. The Printful adapters reach a real supplier that bills a real ' +
        'wallet, so they are registrable only where that is intended.',
    );
  }
  const transport = createPrintfulTransport({
    baseUrl: config.printful.baseUrl,
    resolveCredential: resolvePrintfulCredential,
  });
  registerSupplierAdapter(createPrintfulOrderAdapter(transport));
  registerCatalogSourceAdapter(createPrintfulCatalogAdapter(transport));
}
