/**
 * Whether Peable takes FairCoin on a network right now — its deployment gate
 * (Peable ADR 0002, `PEABLE_SOCIAL_PAY_NETWORK`; ADR 0021 D5).
 *
 * Peable answers a FairCoin payment on a network it has not opened with
 * `409 faircoin_network_closed`, but only when the payment is CREATED — after
 * Mercaria has placed the orders and reserved the stock. A buyer must be told
 * before that (ADR 0019 D4), so this reads the same gate from the one place
 * Peable publishes it ahead of a payment: the `faircoin` entry of Mercaria's
 * own payment method configuration, whose `unavailable_reason` is
 * `faircoin_network_closed` exactly while the merchant's network is closed.
 * Peable checks the network BEFORE the wallet, so Mercaria's own wallet being
 * missing (`faircoin_wallet_missing`, the `oxy` organization's) says the
 * network is OPEN, and is not a seller's concern.
 *
 * The entry describes the MERCHANT's network — the environment's: `mainnet`
 * live, `testnet` otherwise. For any other network this cannot answer, and it
 * does not block: Peable's own refusal at creation is then the honest answer.
 *
 * Fails OPEN on a read failure, and that direction is deliberate: the gate is
 * not a money boundary (Peable refuses the payment itself if it is closed), and
 * a Peable read blip must not hide FairCoin from every buyer. Cached briefly,
 * because a checkout and a comparison page must not each cost a gateway call.
 */

import type { FaircoinNetwork } from '@mercaria/shared-types';
import { config } from '../../../config/index.js';
import { log } from '../../../lib/logger.js';
import { peableGateway } from './accounts.js';

/** How long one answer is reused. Peable's gate moves with a deployment, not a request. */
const CACHE_MS = 60_000;

let cached: { open: boolean; at: number } | undefined;

/** Test support: forget the cached answer. */
export function resetFaircoinNetworkCache(): void {
  cached = undefined;
}

/** Whether Peable takes FairCoin on `network` now, as far as it says ahead of a payment. */
export async function readFaircoinNetworkOpen(network: FaircoinNetwork): Promise<boolean> {
  const merchantNetwork: FaircoinNetwork = config.payments.peable.livemode ? 'mainnet' : 'testnet';
  if (network !== merchantNetwork) return true;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.open;

  let open = true;
  try {
    const page = await peableGateway().paymentMethodConfigurations.list({ limit: 10 });
    const configuration = page.data.find((entry) => entry.is_default) ?? page.data[0];
    open = configuration?.faircoin.unavailable_reason !== 'faircoin_network_closed';
  } catch (error) {
    log.general.warn(
      { err: error },
      '[Peable] could not read whether FairCoin is open on this network; not blocking it',
    );
    return true;
  }
  cached = { open, at: Date.now() };
  return open;
}
