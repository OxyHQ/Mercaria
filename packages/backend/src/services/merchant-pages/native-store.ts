/**
 * What a merchant page does about a verified native store
 * (#73 native-store requirements 1–6).
 *
 * ## The decision is LINK, and it is a value rather than a paragraph
 *
 * `MERCHANT_NATIVE_STORE_PRESENTATIONS` has one member. A REDIRECT would make
 * the merchant route unreachable and with it every external channel, the offer
 * mix, the brand standings and the claim action — the merchant would BE the
 * store, which is the collapse the issue's title forbids. An EMBED would be a
 * second rendering of an experience the store APIs own (members, collections,
 * policies, theme, inventory, orders), and two renderings of one thing disagree
 * the moment either changes.
 *
 * ## The follow identity is protected by ABSENCE, not by a check
 *
 * Requirement 3 ("never create a second follow identity for the same native
 * store") and requirement 6 ("unclaimed external merchants are not
 * automatically registered as Oxy follow targets") are the same guarantee from
 * two directions, and both hold because nothing in this domain can register a
 * follow target: no module under `services/merchant-pages/` imports
 * `ensureFollowTarget`, `registerFollowKind` or any follow client, and no
 * merchant-page screen renders a follow control.
 * `merchant-page-isolation.test.ts` fails the build on either, scanning BOTH
 * packages — the same shape #92 used, and for the same reason: the one file
 * that could make this mistake is a storefront file and the storefront has no
 * test runner of its own.
 *
 * ## And the page writes nothing
 *
 * Requirement 5 says external merchant data may not overwrite merchant-managed
 * native-store profile fields without a reviewed merge policy. There is no
 * merge policy here because there is no write: this domain contains no update
 * statement against `stores`, `merchants` or `storefronts`, which the same
 * isolation gate asserts. The handle, the name and the link's verification
 * instant are read and republished verbatim.
 */

import type { MerchantPageNativeStore } from '@mercaria/shared-types';

/**
 * Build the native-store reference from the verified link and the store's own
 * three public identity columns.
 *
 * The parameter list IS the privacy boundary: there is no members array, no
 * policy object, no inventory figure and no order count to pass, so a future
 * caller cannot widen what appears by widening what it fetches.
 */
export function toMerchantPageNativeStore(input: {
  storeId: string;
  handle: string;
  name: string;
  linkedAt: Date;
}): MerchantPageNativeStore {
  return {
    storeId: input.storeId,
    handle: input.handle,
    name: input.name,
    presentation: 'link',
    linkedAt: input.linkedAt.toISOString(),
  };
}
