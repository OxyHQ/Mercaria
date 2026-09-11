/**
 * Which cart lines are DIGITAL, and whether a digital checkout is coherent
 * (#1015 W9, ADR 0010 D8/D9/D10/D11).
 *
 * ## "Is this line digital" is answered by a BINDING, not by a flag
 *
 * `asset_variant_bindings` maps one catalogue variant to one licence option. A
 * line whose variant has a binding is digital; one whose variant does not, is not.
 * There is no `is_digital` column on a listing or a variant, for the reason ADR
 * 0007 D15 refuses a `commerce_type` one: a flag and a binding are two
 * representations of one fact and can disagree, and the binding alone cannot.
 *
 * It also means a merchant cannot make a line digital by mislabelling it. The
 * binding is written by the creator publication path, which has an asset behind it.
 *
 * ## The server decides, and the refusals are ordered by what the buyer can fix
 *
 * A client names `destination: {type: 'digital_delivery'}`; this module decides
 * whether that was true. Every refusal below is a specific, actionable message —
 * "one of these needs an address" rather than "invalid destination" — because the
 * remedy is a deselection the client already implements for the guest-P2P refusal.
 */

import type { DigitalLicenceUpdatePolicy, DigitalVertical } from '@mercaria/shared-types';
import { ACQUIRABLE_ASSET_VERSION_STATES } from '@mercaria/shared-types';
import type { DatabaseOrTransaction } from '../../db/postgres.js';
import { findDigitalBindings } from '../../db/digital/bindingRepository.js';
import { config } from '../../config/index.js';
import { checkoutRefusal } from './refusal.js';
import type { ResolvedFulfilment } from './destination.js';

/** What one digital cart line resolves to, and what its order line will snapshot. */
export interface ResolvedDigitalLine {
  readonly variantId: string;
  readonly assetId: string;
  readonly packageId: string;
  /** The version a purchase PINS — the asset's currently acquirable one. */
  readonly assetVersionId: string;
  readonly licenceVersionId: string;
  readonly updatePolicy: DigitalLicenceUpdatePolicy;
  readonly vertical: DigitalVertical;
}

/**
 * Resolve every digital line among `variantIds`.
 *
 * Returns a map keyed by variant id; a variant absent from it is a physical line.
 * A binding whose option, licence version or acquirable asset version cannot be
 * read is left OUT rather than raising — which makes the line physical, and is the
 * wrong answer, so it is refused a step later by
 * {@link assertDigitalCheckoutCoherent} with a message about the item rather than
 * about the database. The alternative (raising here) would turn a creator's
 * half-configured asset into a 500 on somebody else's mixed cart.
 */
export async function resolveDigitalLines(
  variantIds: readonly string[],
  tx?: DatabaseOrTransaction,
): Promise<Map<string, ResolvedDigitalLine>> {
  const resolved = new Map<string, ResolvedDigitalLine>();
  if (variantIds.length === 0) return resolved;

  for (const row of await findDigitalBindings(variantIds, tx)) {
    // Every gate a NEW acquisition has to pass, applied here so a half-configured
    // or withdrawn asset simply does not resolve. The download authorizer reads a
    // DIFFERENT set (`DOWNLOADABLE_ASSET_VERSION_STATES`), deliberately: buying
    // and keeping are different questions, and conflating them is how withdrawing
    // an asset would revoke every historical purchase of it.
    if (!row.optionAcquirable) continue;
    if (row.licenceState !== 'published') continue;
    if (row.assetState !== 'listed') continue;
    if (!row.currentVersionId || !row.currentVersionState) continue;
    if (!ACQUIRABLE_ASSET_VERSION_STATES.includes(row.currentVersionState)) continue;

    resolved.set(row.variantId, {
      variantId: row.variantId,
      assetId: row.assetId,
      packageId: row.packageId,
      assetVersionId: row.currentVersionId,
      licenceVersionId: row.licenceVersionId,
      updatePolicy: row.updatePolicy,
      vertical: row.vertical,
    });
  }
  return resolved;
}

export interface DigitalCheckoutCoherenceInput {
  readonly fulfilment: ResolvedFulfilment;
  /** Every variant the checkout is placing, in cart order. */
  readonly variantIds: readonly string[];
  readonly digitalByVariant: ReadonlyMap<string, ResolvedDigitalLine>;
  /** Whether the buyer gave express consent to immediate supply. */
  readonly consent: boolean;
  /** Whether this checkout is charging money. A free claim needs no paid gate. */
  readonly chargesMoney: boolean;
}

/**
 * Refuse every incoherent combination of cart and destination.
 *
 * Five refusals, and the order is the #105 ordering: the most specific and most
 * fixable first.
 */
export function assertDigitalCheckoutCoherent(input: DigitalCheckoutCoherenceInput): void {
  const digitalCount = input.variantIds.filter((id) => input.digitalByVariant.has(id)).length;
  const physicalCount = input.variantIds.length - digitalCount;

  // 1. A `digital_delivery` destination with a physical line. The buyer asked for
  //    no address and there is something that needs one, so the remedy is either
  //    an address or a deselection — and the message says so rather than naming a
  //    destination type nobody typed.
  if (input.fulfilment.kind === 'digital' && physicalCount > 0) {
    throw checkoutRefusal(
      'destination_incomplete',
      `${physicalCount === 1 ? 'One item' : `${physicalCount} items`} in this order has to be ` +
        'delivered. Add a delivery address, or check out the downloads on their own.',
    );
  }

  // 2. A digital-only cart that named an address or a pickup is NOT refused. It is
  //    a legal, ordinary thing — a buyer with one saved address and a cart full of
  //    STL files — and the order simply fulfils as `standard` with an address
  //    nothing ships to. Refusing it would make the destination the buyer's
  //    problem to diagnose. What IS refused is the reverse, above.

  // 3. The deployment lever. AFTER the cart-shape refusals, so a buyer whose cart
  //    has a genuine problem is told about that rather than about an operator's
  //    switch — the ordering `assertGuestCheckoutRolloutAllowed` already follows.
  if (digitalCount > 0 && input.chargesMoney && !config.digital.paidCheckoutEnabled) {
    throw checkoutRefusal(
      'destination_unsupported',
      'Digital purchases are not available yet. Remove the downloads to place the rest of this order.',
    );
  }

  // 4. The per-vertical allow-list. An allow-list rather than a block-list, for
  //    `services/payments/redact.ts`'s reason: a block-list is correct only until a
  //    new vertical is added, and the new one would be live everywhere on the day
  //    it merged.
  if (digitalCount > 0) {
    const enabled = new Set(config.digital.enabledVerticals);
    const blocked = [...input.digitalByVariant.values()].filter(
      (line) => !enabled.has(line.vertical),
    );
    if (blocked.length > 0) {
      throw checkoutRefusal(
        'destination_unsupported',
        'One of the downloads in this order is not on sale in this region yet. Remove it to continue.',
      );
    }
  }

  // 5. The withdrawal waiver. LAST, because it is the only refusal the buyer fixes
  //    by ticking a box rather than by changing their cart — so telling them about
  //    it before the cart is coherent would be asking them to consent to something
  //    that was not going to happen.
  if (digitalCount > 0 && input.chargesMoney && !input.consent) {
    throw checkoutRefusal(
      'destination_incomplete',
      'Confirm that your download can start right away and that you accept losing the 14-day ' +
        'right to change your mind about it.',
    );
  }
}
