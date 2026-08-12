/**
 * The channel catalog (#87 "Channel catalog") — what a merchant may connect,
 * what it can carry, and what is wrong with it today.
 *
 * ## Why this exists at all
 *
 * The dashboard used to hold a local `PROVIDERS` table with an `available`
 * boolean per connector, and it described neither the product feed (#63) nor the
 * native catalogue nor a single limitation. Three consequences followed and #87
 * names all three: a merchant could not compare channels, the WooCommerce plugin
 * was invisible, and acceptance 7 — one authoritative readiness result rather
 * than provider-specific client flags — had nothing to be authoritative about.
 *
 * ## Two rules keep this file honest
 *
 * **Nothing here restates a capability.** `ConnectorProvider.capabilities` is
 * the one declaration and this module READS it, so a descriptor cannot claim a
 * push the provider refuses — #69's contract suite reads the same constant and
 * measures both branches of every capability, which is what makes that claim
 * checkable rather than merely stated.
 *
 * **Availability is resolved per deployment, at read time.** Whether Shopify can
 * be connected depends on whether this deployment configured an OAuth app, and
 * whether a feed can be depends on `FEED_IMPORT_ENABLED`. A descriptor frozen at
 * import would tell a merchant to start a flow that fails on its first step.
 */

import type {
  ChannelLimitation,
  ChannelRequirement,
  ChannelTypeDescriptor,
  ChannelTypeId,
  ConnectionMode,
  ConnectorProviderId,
} from '@mercaria/shared-types';
import { config } from '../../config/index.js';
import { getConnectorProvider, isImplementedProvider } from '../../connectors/registry.js';
import { hasShopifyCredentials } from '../../connectors/shopify/config.js';
import { getConnectorRedirectBase } from '../../connectors/config.js';

/**
 * Which channel type a stored connection IS.
 *
 * `connections` is keyed on `(store_id, provider)` and distinguishes the
 * WooCommerce pull connector from the WooCommerce plugin by `mode` alone, so
 * this is the one function that reads a row as a channel type. A single
 * expression rather than a map, because the mapping is the identity everywhere
 * except the one place it is not.
 */
export function channelTypeForConnection(connection: {
  provider: string;
  mode: ConnectionMode;
}): ChannelTypeId {
  if (connection.provider === 'woocommerce' && connection.mode === 'push_in') {
    return 'woocommerce_plugin';
  }
  return isChannelTypeId(connection.provider) ? connection.provider : 'native';
}

/** Whether a string names a channel type. Route params and stored rows both need it. */
export function isChannelTypeId(value: string): value is ChannelTypeId {
  return CHANNEL_TYPE_ID_SET.has(value);
}

const CHANNEL_TYPE_ID_SET: ReadonlySet<string> = new Set<ChannelTypeId>([
  'shopify',
  'woocommerce',
  'woocommerce_plugin',
  'etsy',
  'prestashop',
  'magento',
  'product_feed',
  'native',
]);

/**
 * The connector provider a channel type talks to, or `undefined`.
 *
 * `product_feed` and `native` have none, which is exactly why the catalog is
 * keyed on a channel type: a merchant's list of ways to supply a catalogue is
 * longer than the list of platforms Mercaria has a connector for.
 */
export function providerForChannelType(
  channelType: ChannelTypeId,
): ConnectorProviderId | undefined {
  switch (channelType) {
    case 'shopify':
      return 'shopify';
    case 'woocommerce':
    case 'woocommerce_plugin':
      return 'woocommerce';
    case 'etsy':
      return 'etsy';
    case 'prestashop':
      return 'prestashop';
    case 'magento':
      return 'magento';
    case 'product_feed':
    case 'native':
      return undefined;
  }
}

/**
 * The connector defects #69 filed that are still OPEN.
 *
 * They are carried as DATA, per channel type, with the issue number attached,
 * because #87's whole point is one place a merchant reads before connecting —
 * and a wizard that walks somebody into a known defect without mentioning it is
 * worse than no wizard. Each summary says what the merchant will observe, not
 * what the code does wrong: "live updates will not arrive" is actionable and
 * "`registerWebhooks` discards its ids" is not.
 *
 * They leave when the issues close, and two have. #218: registration is now
 * per-topic fault tolerant, reconciled against the platform's own subscription
 * list, and persists the ids, the secret and the refused topics in ONE write —
 * so a partial registration is disconnectable, retryable, and names the events
 * that will not arrive instead of looking healthy. #219: the WooCommerce
 * transport retries a 429, so its entry became a CAPABILITY-derived limitation
 * (below) rather than a defect — which is where it belonged all along, since
 * "does this transport retry a rate limit" is a fact about shipped code and
 * `ConnectorProvider.capabilities` is where this module reads those.
 *
 * Nothing derives what remains, so nothing can silently stop reporting one.
 */
const WOOCOMMERCE_OPEN_DEFECTS: readonly ChannelLimitation[] = [
  {
    code: 'variable_product_collapsed_on_webhook',
    severity: 'degrades',
    summary:
      'A product with several variations that Mercaria first sees through a webhook is imported with a single variant at the lowest price and no stock, permanently. Running a full sync before relying on webhooks avoids it.',
    openIssue: 220,
  },
  {
    code: 'listing_stamp_not_atomic',
    severity: 'degrades',
    summary:
      'If an import fails between creating a listing and recording where it came from, that listing is stranded: later syncs cannot match it and re-importing the same product fails on its handle. It has to be deleted by hand.',
    openIssue: 221,
  },
];

/**
 * The limitation every connector carries because of how `connections` is keyed.
 *
 * `connections_store_id_provider_key` is `UNIQUE(store_id, provider)`, so one
 * store connects one shop per platform — and for WooCommerce that unique is
 * shared with the plugin, so choosing one excludes the other. A merchant with
 * two Shopify stores hits it immediately, which is why it is stated rather than
 * discovered from a 409.
 */
const ONE_CONNECTION_PER_PROVIDER: ChannelLimitation = {
  code: 'single_connection_per_provider',
  severity: 'informational',
  summary:
    'One connection per platform per store. Connecting a second shop on the same platform means a second Mercaria store.',
};

/** A no-change resync is tallied as `updated` — runbook §8.5, not a defect. */
const RESYNC_COUNTS_UNCHANGED: ChannelLimitation = {
  code: 'resync_counts_unchanged_as_updated',
  severity: 'informational',
  summary:
    'A sync that changed nothing still reports its products as updated. The count is how many were examined, not how many differed.',
};

/** Requirements every merchant-managed channel shares. */
const CHANNELS_PERMISSION: ChannelRequirement = {
  code: 'store_channels_permission',
  summary: 'Permission to manage sales channels for this store.',
  met: true,
};

/**
 * Whether the deployment configured everything a channel type needs.
 *
 * Read at request time, never frozen: a descriptor built at import would keep
 * offering Shopify after somebody removed the credentials, and would keep
 * refusing it for the whole life of a task that started before they were added.
 */
function availabilityFor(channelType: ChannelTypeId): ChannelTypeDescriptor['availability'] {
  const providerId = providerForChannelType(channelType);
  if (providerId !== undefined && !isImplementedProvider(providerId)) {
    return 'not_implemented';
  }
  switch (channelType) {
    case 'shopify':
      // Both halves: the app credentials AND the public base URL every callback
      // and webhook address is built from. Either missing means the merchant
      // reaches the platform's consent screen and comes back to nothing.
      return hasShopifyCredentials() && getConnectorRedirectBase() !== undefined
        ? 'available'
        : 'not_configured';
    case 'woocommerce':
    case 'woocommerce_plugin':
      // A key pair the merchant pastes needs no Mercaria app, but the plugin
      // and the pull connector both register webhooks against a public address.
      return getConnectorRedirectBase() !== undefined ? 'available' : 'not_configured';
    case 'product_feed':
      return config.feedImport.enabled ? 'available' : 'not_configured';
    case 'native':
      return 'available';
    case 'etsy':
    case 'prestashop':
    case 'magento':
      return 'not_implemented';
  }
}

/**
 * Build one channel type's descriptor.
 *
 * The connector branches read `provider.capabilities` and translate it into the
 * merchant's vocabulary — a missing `pushesProducts` becomes both an absent
 * `push` direction on `resources.products` AND a named limitation, because those
 * answer different questions: the first is what a settings form may offer, the
 * second is what a merchant should know before choosing the channel.
 */
function describeChannelType(channelType: ChannelTypeId): ChannelTypeDescriptor {
  const availability = availabilityFor(channelType);
  const providerId = providerForChannelType(channelType);

  if (channelType === 'native') {
    return {
      channelType,
      kind: 'native',
      name: 'Mercaria catalog',
      summary:
        'Products you create in Mercaria. Always on, nothing to connect, and the only channel where you edit prices and stock directly.',
      credentialStrategy: 'none',
      availability,
      resources: { products: [], inventory: [], orders: [] },
      requirements: [CHANNELS_PERMISSION],
      limitations: [],
      supportsNativeCheckout: true,
    };
  }

  if (channelType === 'product_feed') {
    return {
      channelType,
      kind: 'product_feed',
      name: 'Product feed',
      summary:
        'A CSV, TSV, XML, JSON or JSONL file at an HTTPS URL, or one you upload. Mercaria reads it on a schedule and lists what it finds for comparison.',
      credentialStrategy: 'feed_url',
      availability,
      resources: { products: ['pull'], inventory: [], orders: [] },
      requirements: [
        CHANNELS_PERMISSION,
        {
          code: 'reachable_feed_or_upload',
          summary: 'A feed reachable over HTTPS, or a file to upload.',
        },
      ],
      limitations: [
        {
          code: 'external_offers_only',
          severity: 'informational',
          summary:
            'A feed lists your products for buyers to compare and links them to your own shop. It does not create Mercaria listings, so these products cannot be bought through Mercaria checkout and their stock and orders stay with you.',
        },
        {
          code: 'upload_not_durable',
          severity: 'informational',
          summary:
            'An uploaded file is held on the server that received it and may need re-uploading. A feed at an HTTPS URL has no such limit.',
        },
      ],
      supportsNativeCheckout: false,
    };
  }

  // Every remaining member is a connector. An unimplemented one has no provider
  // to read a capability from, so it is described from the vocabulary alone —
  // which is the honest thing to show for a platform nobody has built.
  if (providerId === undefined || availability === 'not_implemented') {
    return {
      channelType,
      kind: 'connector_pull',
      name: CONNECTOR_NAMES[channelType],
      summary: `Importing from ${CONNECTOR_NAMES[channelType]} is not built yet.`,
      credentialStrategy: 'api_key',
      availability: 'not_implemented',
      resources: { products: [], inventory: [], orders: [] },
      requirements: [CHANNELS_PERMISSION],
      limitations: [
        {
          code: 'not_implemented',
          severity: 'blocks_activation',
          summary: `Mercaria has no ${CONNECTOR_NAMES[channelType]} connector yet.`,
        },
      ],
      supportsNativeCheckout: false,
    };
  }

  const capabilities = getConnectorProvider(providerId).capabilities;

  if (channelType === 'woocommerce_plugin') {
    return {
      channelType,
      kind: 'connector_push',
      name: 'WooCommerce plugin',
      summary:
        'Mercaria mints a channel key, you paste it into the Mercaria plugin on your WordPress site, and the plugin pushes products and stock to Mercaria as they change.',
      credentialStrategy: 'channel_key',
      availability,
      // The plugin PUSHES to Mercaria, so from Mercaria's side both resources
      // arrive rather than being fetched. There is no order direction at all:
      // `channel-ingest.service` implements products and inventory and nothing
      // else.
      resources: { products: ['pull'], inventory: ['pull'], orders: [] },
      requirements: [
        CHANNELS_PERMISSION,
        {
          code: 'mercaria_plugin_installed',
          summary: 'The Mercaria plugin installed on your WordPress site.',
        },
        {
          code: 'store_location',
          summary: 'A location in this store for the stock the plugin sends.',
        },
      ],
      limitations: [
        ONE_CONNECTION_PER_PROVIDER,
        {
          code: 'no_fulfilment_push',
          severity: 'informational',
          summary:
            'Orders are not exchanged in either direction. Sales made in WooCommerce stay in WooCommerce, and sales made on Mercaria are not reported back to it.',
        },
      ],
      supportsNativeCheckout: true,
    };
  }

  const connectorLimitations: ChannelLimitation[] = [ONE_CONNECTION_PER_PROVIDER];
  if (!capabilities.pushesProducts) {
    connectorLimitations.push({
      code: 'no_product_push',
      severity: 'degrades',
      summary: `Products move from ${CONNECTOR_NAMES[channelType]} into Mercaria only. A product created in Mercaria is not published back.`,
    });
  }
  if (!capabilities.pushesFulfillment) {
    connectorLimitations.push({
      code: 'no_fulfilment_push',
      severity: 'degrades',
      summary: `Fulfilling a ${CONNECTOR_NAMES[channelType]} order in Mercaria does not mark it fulfilled on ${CONNECTOR_NAMES[channelType]}.`,
    });
  }
  if (!capabilities.inventoryWebhook) {
    connectorLimitations.push({
      code: 'no_inventory_webhook',
      severity: 'informational',
      summary: `${CONNECTOR_NAMES[channelType]} does not notify Mercaria when stock changes, so stock is refreshed on the scheduled sync rather than immediately.`,
    });
  }
  if (!capabilities.retriesRateLimit) {
    // #219 landed this as a DERIVATION rather than leaving it a hardcoded
    // WooCommerce defect: both shipped transports retry a 429 today, so this
    // branch reports nothing — and a third platform that arrives without a
    // retry gets the limitation automatically instead of by somebody
    // remembering to add a row.
    connectorLimitations.push({
      code: 'no_rate_limit_retry',
      severity: 'degrades',
      summary: `A sync fails outright if ${CONNECTOR_NAMES[channelType]} rate-limits it. The failure is safe — nothing is archived or changed — but the sync must be retried by hand.`,
    });
  }
  connectorLimitations.push(RESYNC_COUNTS_UNCHANGED);
  if (channelType === 'woocommerce') {
    connectorLimitations.push(...WOOCOMMERCE_OPEN_DEFECTS);
  }

  const oauth = getConnectorProvider(providerId).credentialStrategy === 'oauth';

  return {
    channelType,
    kind: 'connector_pull',
    name: CONNECTOR_NAMES[channelType],
    summary: oauth
      ? `Authorize Mercaria on ${CONNECTOR_NAMES[channelType]} and it imports your products, stock and orders on a schedule.`
      : `Paste a read/write API key pair from ${CONNECTOR_NAMES[channelType]} and Mercaria imports your products, stock and orders on a schedule.`,
    credentialStrategy: oauth ? 'oauth' : 'api_key',
    availability,
    resources: {
      products: capabilities.pushesProducts ? ['pull', 'push'] : ['pull'],
      inventory: ['pull'],
      orders: capabilities.pushesFulfillment ? ['pull', 'push'] : ['pull'],
    },
    requirements: [
      CHANNELS_PERMISSION,
      {
        code: 'platform_admin_account',
        summary: `An administrator account on the ${CONNECTOR_NAMES[channelType]} store you want to connect.`,
      },
      oauth
        ? {
            code: 'platform_oauth_app_configured',
            summary: `Mercaria's ${CONNECTOR_NAMES[channelType]} app, configured on this deployment.`,
            met: availability === 'available',
          }
        : {
            code: 'platform_api_key_pair',
            summary: `A REST API key pair generated in your ${CONNECTOR_NAMES[channelType]} admin.`,
          },
      {
        code: 'store_location',
        summary: 'A location in this store for the imported stock.',
      },
    ],
    limitations: connectorLimitations,
    supportsNativeCheckout: true,
  };
}

/** Merchant-facing platform names. Not derived from the id — `magento` is not a name. */
const CONNECTOR_NAMES: Readonly<Record<ChannelTypeId, string>> = {
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
  woocommerce_plugin: 'WooCommerce plugin',
  etsy: 'Etsy',
  prestashop: 'PrestaShop',
  magento: 'Magento',
  product_feed: 'Product feed',
  native: 'Mercaria catalog',
};

/**
 * Every channel type, in the order a merchant should read them.
 *
 * Available first, then configurable-but-not-configured, then unbuilt — so the
 * list leads with what can actually be done rather than with an alphabet.
 */
export function listChannelTypes(): ChannelTypeDescriptor[] {
  const order: Readonly<Record<ChannelTypeDescriptor['availability'], number>> = {
    available: 0,
    not_configured: 1,
    not_implemented: 2,
  };
  return (
    [
      'native',
      'shopify',
      'woocommerce',
      'woocommerce_plugin',
      'product_feed',
      'etsy',
      'prestashop',
      'magento',
    ] as const
  )
    .map(describeChannelType)
    .sort((a, b) => order[a.availability] - order[b.availability]);
}

/** One channel type's descriptor. */
export function describeChannel(channelType: ChannelTypeId): ChannelTypeDescriptor {
  return describeChannelType(channelType);
}

/**
 * The limitations that stop a channel being activated, if any.
 *
 * Read by the onboarding gate. Separated from the descriptor rather than being a
 * boolean on it, because "why" is what the merchant needs and a blocked channel
 * with no reason is a dead end.
 */
export function activationBlockingLimitations(
  channelType: ChannelTypeId,
): readonly ChannelLimitation[] {
  return describeChannelType(channelType).limitations.filter(
    (limitation) => limitation.severity === 'blocks_activation',
  );
}
