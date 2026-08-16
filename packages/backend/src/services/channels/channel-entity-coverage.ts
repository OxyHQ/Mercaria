/**
 * What a channel carries, and — the half that did not exist — what it does not
 * (#380).
 *
 * ## The report this answers
 *
 * A merchant on a live Shopify store reported that "discounts and other things
 * are not syncing". Discounts were never built. Nothing anywhere told them, and
 * nothing could have: `descriptor.resources` names the three resources a sync
 * SETTING can address, the nine `CHANNEL_LIMITATION_CODES` name no entity at
 * all, and the merchant's whole statement of scope was one sentence — "imports
 * your products, stock and orders on a schedule" — which is accurate and silent
 * about everything it omits. A vocabulary that can only name what exists cannot
 * state an absence.
 *
 * ## The three ways this stays true
 *
 * **The carried half is DERIVED, never written down here.** The entries for
 * `products`, `inventory` and `orders` come from the descriptor's own
 * `resources`, which comes from `ConnectorProvider.capabilities`, which #69's
 * contract suite measures on both branches. There is no spelling of a push this
 * file could claim that the provider refuses.
 *
 * **The absent half is a DECISION, and silence is not one.** Every entity gets
 * an entry in {@link CHANNEL_ENTITY_POLICY}, a `Record` over the whole tuple —
 * so an entity added to `CHANNEL_SYNC_ENTITIES` fails `tsc` here until somebody
 * says what happens to it. That is the `MERGE_REHOMING_PLAN` shape
 * (`services/curation/merge-plan.ts`): a table that must NOT move is as much a
 * decision as one that must, and a map that could only express "we carry it"
 * would force whoever wrote it to leave the rest out.
 *
 * **A provider that grows a data path fails the build.**
 * `channel-entity-coverage.test.ts` walks the real provider objects' own members
 * and refuses any that is in neither the entity map nor the explicitly
 * non-entity one — so a `fetchDiscounts` landing beside a policy that still says
 * `not_built_for_this_channel` cannot ship. That interlock is what stops this
 * file rotting into the prose it replaces.
 *
 * ## What is deliberately NOT here
 *
 * The ORDER HORIZON. How far back an import reaches depends on the scopes ONE
 * connection was granted, not on the channel type — Shopify with
 * `read_all_orders` and Shopify without it are the same channel — so it is
 * derived per connection in `connector-sync.service.toConnectionDTO` and carried
 * beside the coverage rather than inside it.
 */

import type {
  ChannelEntityAbsenceReason,
  ChannelEntityCaveat,
  ChannelEntityCoverage,
  ChannelResourceSupport,
  ChannelSyncEntity,
  ChannelSyncResource,
  ChannelTypeDescriptor,
  ChannelTypeId,
} from '@mercaria/shared-types';
import { CHANNEL_SYNC_ENTITIES } from '@mercaria/shared-types';

/**
 * What Mercaria does with ONE entity, before the channel is taken into account.
 *
 * `sync_resource` delegates to the descriptor's `resources` and states nothing
 * itself. `partial_arrival` and `never_synced` are the two decisions this file
 * actually records.
 */
export type ChannelEntityPolicy =
  | {
      /** Answered by the descriptor's `resources`, so nothing is restated here. */
      readonly kind: 'sync_resource';
      readonly resource: ChannelSyncResource;
    }
  | {
      /**
       * Some of the entity's data arrives, and the record itself does not.
       * `channels` names which channels do it, because it is a fact about a
       * provider's normalizer rather than about Mercaria's model.
       */
      readonly kind: 'partial_arrival';
      readonly caveat: ChannelEntityCaveat;
      readonly directions: readonly ['pull'];
      readonly channels: readonly ChannelTypeId[];
      readonly note: string;
    }
  | {
      /** No channel carries it. The reason may be refined by the channel below. */
      readonly kind: 'never_synced';
      readonly reason: ChannelEntityAbsenceReason;
      readonly note: string;
    };

/**
 * Every entity, and what Mercaria does with it.
 *
 * A `Record` over the closed tuple rather than a partial map with a default:
 * a default is exactly the mechanism by which an entity nobody decided about
 * gets an answer, and the answer it would get is the flattering one. The `note`
 * is the reason the census insists on — it is quoted back in the failure message
 * and floored on length, so "untouched" cannot be spelled as an empty string.
 */
export const CHANNEL_ENTITY_POLICY: Readonly<Record<ChannelSyncEntity, ChannelEntityPolicy>> = {
  products: { kind: 'sync_resource', resource: 'products' },
  inventory: { kind: 'sync_resource', resource: 'inventory' },
  orders: { kind: 'sync_resource', resource: 'orders' },

  collections: {
    kind: 'partial_arrival',
    caveat: 'membership_only_through_a_mapping',
    directions: ['pull'],
    // Both implemented pull connectors fill `NormalizedProduct.collectionRefs`
    // — Shopify from `collects.json` plus the smart-collection product lists,
    // WooCommerce from a product's `categories` — and `connector-sync.service`
    // maps those through the connection's `collectionMapping` onto a listing's
    // Mercaria collections. No Mercaria collection is ever CREATED from a
    // platform collection. Reporting this as `synced` promises collections will
    // appear; reporting it as `not_synced` denies data that demonstrably
    // arrives. Both produce the next false report, which is why `partial` exists.
    channels: ['shopify', 'woocommerce'],
    note: 'The platform collection is not created in Mercaria; a product joins the Mercaria collections the connection maps its external ids onto.',
  },

  customers: {
    kind: 'never_synced',
    reason: 'imported_only_as_part_of_an_order',
    // `buildExternalOrderDoc` carries the buyer's name and shipping address onto
    // the imported ORDER and synthesises an `ext:` buyer id. No `Customer` row
    // is written: `customer.service.upsertOnPaid` runs from
    // `order.service.transition('paid')`, and a connector import inserts the
    // order in its already-settled status rather than transitioning it.
    note: "The platform's customer list is not imported. A buyer's name and address arrive on each imported order, and no Mercaria customer record is created from them.",
  },

  discounts: {
    kind: 'partial_arrival',
    caveat: 'breakdown_only_on_imported_orders',
    directions: ['pull'],
    // THE REPORT, and then its answer. Until #378 `buildExternalOrderDoc` wrote
    // `appliedDiscounts: []` and carried only `totals.discountTotal`, so the
    // discounted total was right and nothing said which rule produced it. It now
    // writes `toAppliedDiscounts(order)` — each allocation's title, amount, and
    // the code and value type where the platform stated one. What still does NOT
    // happen is a Mercaria `Discount` RECORD being created, which is why this is
    // `partial` and not `synced`: the rule is not here to edit, reuse or report
    // on, and saying `synced` would promise a merchant it is.
    channels: ['shopify', 'woocommerce'],
    note: 'An imported order carries its discount lines — title, amount, and the code where the platform sent one. No Mercaria discount rule is created from them, so the rule itself is not editable or reusable here.',
  },

  tax_rates: {
    kind: 'partial_arrival',
    caveat: 'breakdown_only_on_imported_orders',
    directions: ['pull'],
    // Same shape as discounts, same change in #378: `toOrderTaxLines(order)`
    // carries each rate's name, amount and — where the platform stated one — its
    // rate in basis points. Mercaria's own `TaxRate` per jurisdiction is a
    // separate record and is still neither imported nor published.
    channels: ['shopify', 'woocommerce'],
    note: 'An imported order carries its tax lines — the name and amount of each rate charged. No Mercaria tax rate is created from them; the rates used on Mercaria orders are configured here.',
  },

  refunds: {
    kind: 'never_synced',
    reason: 'imported_only_as_part_of_an_order',
    // Both providers map a refunded platform order onto `refunded` /
    // `partially_refunded` order STATUS. No `Refund` row is created and no money
    // moves — which matters, because a Mercaria refund restocks and posts to the
    // ledger, and a platform refund did neither of those here.
    note: 'A refund made on the platform shows as the order being refunded. No Mercaria refund record is created, so nothing is restocked and no payment is reversed here.',
  },

  gift_cards: {
    kind: 'never_synced',
    reason: 'not_modelled_by_mercaria',
    note: 'Mercaria has no gift card record, so there is nothing for one to be imported into.',
  },

  shipping_rates: {
    kind: 'never_synced',
    reason: 'owned_by_another_system',
    // Shipping UI is hidden everywhere and Moovo owns logistics entirely; the
    // backend keeps only the `order.shipping` snapshot at cost zero. Importing a
    // platform's rate table would be building the thing that is deliberately not
    // built.
    note: 'Delivery is handled by Moovo rather than by rates configured here, so a platform rate table is not imported.',
  },

  product_reviews: {
    kind: 'never_synced',
    reason: 'not_built_for_this_channel',
    // Mercaria has reviews (#76) and every one is tied to an order line that
    // proves the purchase. A platform review carries no such evidence, so
    // importing one would create a rating with no eligibility behind it.
    note: 'Reviews written on the platform are not imported. A Mercaria review is tied to an order placed through Mercaria.',
  },
};

/**
 * Provider members that MOVE one entity's data, and which entity.
 *
 * The census walks the real provider objects and requires every own member to
 * appear here or in {@link PROVIDER_NON_ENTITY_MEMBERS} — so a provider growing a
 * `fetchDiscounts` fails the build until somebody decides what the coverage
 * should say about it. That is the interlock that stops
 * {@link CHANNEL_ENTITY_POLICY} quietly outliving the code it describes.
 *
 * `pushFulfillment` maps to `orders` rather than to an entity of its own,
 * matching `resources.orders`, whose `push` direction it already IS. Two
 * spellings of "Mercaria reports a fulfilment back" could disagree.
 */
export const PROVIDER_ENTITY_MEMBERS: Readonly<
  Record<string, readonly [ChannelSyncEntity, ...ChannelSyncEntity[]]>
> = {
  fetchProducts: ['products'],
  // #376/#395. Lists the platform's own groupings so a merchant can MAP them
  // onto Mercaria collections they already made. It reaches the entity, which is
  // why it is here; it does not raise the entity to `synced`, because a mapping
  // TARGETS a manual Mercaria collection and creates none — the `partial` claim
  // this member arrived beside, unchanged and now actually reachable, since
  // before #395 no Mercaria client set a mapping at all.
  fetchCollections: ['collections'],
  normalizeProduct: ['products'],
  expandWebhookProduct: ['products'],
  pushProduct: ['products'],
  fetchInventory: ['inventory'],
  fetchOrders: ['orders'],
  // #378 made an imported order carry its discount allocations and tax lines,
  // so ONE member reaches three entities. The map held a single entity per
  // member until then, and the single-value shape was itself the bug: it could
  // not express what the normalizer actually does, so the coverage census and
  // the policy were forced to disagree with no honest way to reconcile them.
  normalizeOrder: ['orders', 'discounts', 'tax_rates'],
  pushFulfillment: ['orders'],
};

/**
 * Provider members that carry no entity's data, each with the reason.
 *
 * "Not an entity path" is a decision the census accepts and silence is not —
 * `MERGE_REHOMING_PLAN`'s `untouched` in another domain. The reasons are short
 * because the point is that somebody looked, not the prose.
 */
export const PROVIDER_NON_ENTITY_MEMBERS: Readonly<Record<string, string>> = {
  id: 'Identity, not a data path.',
  credentialStrategy: 'How the platform is authorized.',
  webhookSecretStrategy: 'How inbound deliveries are authenticated.',
  capabilities: 'The declaration the carried half is derived FROM.',
  externalTaxonomyNoun:
    "Names the collection taxonomy in the platform's own word; moves no data.",
  orderHistoryHorizon: 'How far back orders reach — a bound on an entity already covered.',
  buildAuthorizeUrl: 'OAuth handshake.',
  exchangeCode: 'OAuth handshake.',
  verifyConnection: 'Identifies the shop; imports nothing.',
  listWebhooks: 'Webhook subscription bookkeeping.',
  registerWebhooks: 'Webhook subscription bookkeeping.',
  deleteWebhooks: 'Webhook subscription bookkeeping.',
  webhookDeliveryUrl: 'Webhook subscription bookkeeping.',
};

/**
 * Why a channel does not carry an entity, refined by what the channel IS.
 *
 * Precedence matters and runs model-first: a fact about Mercaria's own model
 * (`not_modelled_by_mercaria`, `owned_by_another_system`,
 * `imported_only_as_part_of_an_order`) is true whichever channel is asking, so it
 * outranks the channel's state. Only `not_built_for_this_channel` — the one
 * reason that IS relative to a channel — is refined, and then by facts already on
 * the descriptor rather than by a second per-channel table nobody would maintain.
 */
function absenceReasonFor(
  channelType: ChannelTypeId,
  availability: ChannelTypeDescriptor['availability'],
  policyReason: ChannelEntityAbsenceReason | undefined,
): ChannelEntityAbsenceReason {
  if (policyReason !== undefined && policyReason !== 'not_built_for_this_channel') {
    return policyReason;
  }
  if (availability === 'not_implemented') return 'channel_not_implemented';
  if (channelType === 'native') return 'native_catalog_is_not_a_sync';
  if (channelType === 'product_feed') return 'channel_transports_products_only';
  return 'not_built_for_this_channel';
}

/**
 * Every entity, with what this channel does with it — in tuple order, one entry
 * each, no gaps and no extras.
 *
 * Takes `resources` rather than reading the descriptor back, because it is
 * called while the descriptor is being built and a second `describeChannelType`
 * call would recurse.
 */
export function deriveChannelEntityCoverage(
  channelType: ChannelTypeId,
  availability: ChannelTypeDescriptor['availability'],
  resources: ChannelResourceSupport,
): readonly ChannelEntityCoverage[] {
  return CHANNEL_SYNC_ENTITIES.map((entity): ChannelEntityCoverage => {
    const policy = CHANNEL_ENTITY_POLICY[entity];

    if (policy.kind === 'sync_resource') {
      const directions = resources[policy.resource];
      if (directions.length > 0) {
        return { entity, state: 'synced', directions };
      }
      return {
        entity,
        state: 'not_synced',
        reason: absenceReasonFor(channelType, availability, undefined),
      };
    }

    if (policy.kind === 'partial_arrival') {
      if (policy.channels.includes(channelType) && availability !== 'not_implemented') {
        return {
          entity,
          state: 'partial',
          directions: policy.directions,
          caveat: policy.caveat,
        };
      }
      return {
        entity,
        state: 'not_synced',
        reason: absenceReasonFor(channelType, availability, undefined),
      };
    }

    return {
      entity,
      state: 'not_synced',
      reason: absenceReasonFor(channelType, availability, policy.reason),
    };
  });
}
