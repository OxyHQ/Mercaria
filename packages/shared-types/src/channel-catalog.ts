/**
 * The channel catalog, channel readiness and channel onboarding (#87).
 *
 * A merchant supplies Mercaria with a catalogue through several very different
 * mechanisms — an OAuth connector, a static API key, a WordPress plugin pushing
 * in, a file at a URL, or by typing products into Mercaria itself. Before this
 * issue each of those was described in a different place, and the merchant-facing
 * one was a hard-coded table in the dashboard: `PROVIDERS` in
 * `app/(app)/channels/index.tsx`, carrying `available: true` for Shopify and
 * WooCommerce and nothing else. That table is what #87 acceptance 7 names — "one
 * authoritative channel-readiness result rather than provider-specific client
 * flags" — and it is what this module replaces.
 *
 * ## Why a channel TYPE is not a connector provider id
 *
 * `ConnectorProviderId` answers "which platform's API is this", and two of the
 * six channel types share one answer: the WooCommerce pull connector and the
 * WooCommerce push plugin are both `provider: 'woocommerce'`, distinguished only
 * by `connections.mode`. They authenticate differently (an API key pair the
 * merchant pastes vs a channel key Mercaria mints), they support different
 * resources, and they carry different limitations. A merchant choosing between
 * them is choosing between two channels, so the catalog is keyed on a channel
 * type and the provider id is one of its fields. Two of the types — a product
 * feed and the native catalogue — have no provider id at all.
 *
 * ## Why the catalog is a code constant and not a table
 *
 * Everything a descriptor claims is a fact about code that shipped: whether
 * `pushProduct` is implemented, whether the transport retries a 429, whether the
 * offers a channel produces can enter a cart. A table would let somebody publish
 * a descriptor saying WooCommerce handles rate limits, which it does not — the
 * `CATALOG_BACKFILL_MAPPING_VERSION` reasoning (#60), one domain over: the
 * mapping is a procedure, and a version of it nobody shipped is a claim rather
 * than a configuration.
 *
 * The one claim that could still drift is the connector capability set, so it is
 * not restated here at all: `ConnectorProvider.capabilities` is the single
 * declaration, the contract suite (#69) measures the REFUSAL on every capability
 * it declares absent, and the backend descriptor reads the same constant. A
 * descriptor that lied about a push would turn the contract suite red.
 */

import type { ConnectorProviderId, SyncResourceDirection, SyncRunCounts } from './integration';

/**
 * The channel types a merchant can choose between.
 *
 * `woocommerce` (the pull connector) and `woocommerce_plugin` (the push plugin)
 * are separate members for the reason in the module header. `native` is here so
 * the list a merchant reads is complete: typing a product into Mercaria is how
 * most stores start, and a channel list that omits it implies a store with no
 * connector has no catalogue.
 */
export const CHANNEL_TYPE_IDS = [
  'shopify',
  'woocommerce',
  'woocommerce_plugin',
  'etsy',
  'prestashop',
  'magento',
  'product_feed',
  'native',
] as const;

export type ChannelTypeId = (typeof CHANNEL_TYPE_IDS)[number];

/**
 * How a channel moves catalogue, which is what decides the shape of its
 * onboarding rather than which company runs the platform.
 *
 * `connector_pull` — Mercaria calls the platform's API on a schedule.
 * `connector_push` — the platform (or a plugin on it) calls Mercaria.
 * `product_feed`   — a file at a URL, or one the merchant uploads (#63).
 * `native`         — the merchant's own Mercaria listings; nothing to connect.
 */
export const CHANNEL_TYPE_KINDS = [
  'connector_pull',
  'connector_push',
  'product_feed',
  'native',
] as const;

export type ChannelTypeKind = (typeof CHANNEL_TYPE_KINDS)[number];

/**
 * How credentials are collected — the ONE thing a wizard must not improvise.
 *
 * Issue security 1 and wizard step 4 both say credentials are collected only
 * through the provider-specific secure flow, so the descriptor states which flow
 * rather than leaving a screen to decide. `none` is the native catalogue and
 * `channel_key` is a secret Mercaria MINTS rather than one the merchant pastes,
 * which is why it is a separate member: the two have opposite handling rules
 * (a minted key is shown once and never again; a pasted key is never echoed at
 * all).
 */
export const CHANNEL_CREDENTIAL_STRATEGIES = [
  'oauth',
  'api_key',
  'channel_key',
  'feed_url',
  'none',
] as const;

export type ChannelCredentialStrategy = (typeof CHANNEL_CREDENTIAL_STRATEGIES)[number];

/**
 * A direction a channel can actually move one resource in.
 *
 * Deliberately NOT `SyncResourceDirection`, which carries `bidirectional` and
 * `off`. Support for `bidirectional` is the presence of BOTH members and `off`
 * is always available, so representing either here would be a second spelling of
 * a fact the array already states — and two spellings of one fact can disagree.
 * {@link channelSupportsDirection} is the one place the two vocabularies meet.
 */
export const CHANNEL_SYNC_DIRECTIONS = ['pull', 'push'] as const;

export type ChannelSyncDirection = (typeof CHANNEL_SYNC_DIRECTIONS)[number];

/** Which directions a channel implements for each resource. Empty = unsupported. */
export interface ChannelResourceSupport {
  readonly products: readonly ChannelSyncDirection[];
  readonly inventory: readonly ChannelSyncDirection[];
  readonly orders: readonly ChannelSyncDirection[];
}

/** The resources a channel's sync settings can address. */
export const CHANNEL_SYNC_RESOURCES = ['products', 'inventory', 'orders'] as const;

export type ChannelSyncResource = (typeof CHANNEL_SYNC_RESOURCES)[number];

/**
 * Whether a channel supports a requested `SyncSettings` direction.
 *
 * `off` is always supported — turning a resource off is not a capability — and
 * `bidirectional` requires both members, which is the whole reason
 * {@link ChannelSyncDirection} omits it.
 */
export function channelSupportsDirection(
  support: ChannelResourceSupport,
  resource: ChannelSyncResource,
  direction: SyncResourceDirection,
): boolean {
  if (direction === 'off') return true;
  const directions = support[resource];
  if (direction === 'bidirectional') {
    return directions.includes('pull') && directions.includes('push');
  }
  return directions.includes(direction);
}

/**
 * The closed set of limitations a channel can carry.
 *
 * A code rather than free text because the dashboard renders a different
 * explanation per code and because a limitation that blocks activation has to be
 * checkable — a sentence is not. Four of these name an OPEN defect
 * (#218–#221, found by #69 while building the connector contract suite) and the
 * descriptor carries the issue number so the merchant-facing copy can say which
 * one, rather than describing a healthy channel and letting them find out.
 */
export const CHANNEL_LIMITATION_CODES = [
  /** The provider implements no `pushProduct`, so Mercaria cannot publish out. */
  'no_product_push',
  /** The provider implements no `pushFulfillment`. */
  'no_fulfilment_push',
  /** The transport turns an HTTP 429 into a failed run instead of retrying. */
  'no_rate_limit_retry',
  /** The platform has no inventory webhook; stock moves only on a scheduled pull. */
  'no_inventory_webhook',
  /** `connections` is unique on `(store_id, provider)` — one connection per platform. */
  'single_connection_per_provider',
  /** A `product.*` webhook collapses a variable product to one variant, permanently. */
  'variable_product_collapsed_on_webhook',
  /** Creating a listing and stamping its provenance are separate statements. */
  'listing_stamp_not_atomic',
  /** A no-change resync is tallied as `updated` rather than `skipped`. */
  'resync_counts_unchanged_as_updated',
  /** The channel produces external offers only; they cannot enter a cart. */
  'external_offers_only',
  /** An uploaded feed lives on one task's disk and can be reported `missing`. */
  'upload_not_durable',
  /** The channel type exists in the vocabulary and has no implementation. */
  'not_implemented',
] as const;

export type ChannelLimitationCode = (typeof CHANNEL_LIMITATION_CODES)[number];

/**
 * How much a limitation costs the merchant.
 *
 * `blocks_activation` is the only one the onboarding gate reads. `degrades`
 * means the channel works and something a merchant would reasonably expect does
 * not — every open connector defect is here, because each leaves a channel that
 * connects successfully and then misbehaves, which is exactly the shape a
 * wizard would otherwise hide.
 */
export const CHANNEL_LIMITATION_SEVERITIES = [
  'blocks_activation',
  'degrades',
  'informational',
] as const;

export type ChannelLimitationSeverity = (typeof CHANNEL_LIMITATION_SEVERITIES)[number];

/** One limitation, with the open issue that would remove it when there is one. */
export interface ChannelLimitation {
  readonly code: ChannelLimitationCode;
  readonly severity: ChannelLimitationSeverity;
  /** One sentence a merchant can act on. Never a stack trace, never a URL. */
  readonly summary: string;
  /** The Mercaria issue that would remove this limitation, when one is open. */
  readonly openIssue?: number;
}

/**
 * What a merchant must have before a channel type can be connected at all.
 *
 * A closed set for the same reason limitations are: the wizard's first step
 * checks these, and a check needs something more than prose to compare against.
 */
export const CHANNEL_REQUIREMENT_CODES = [
  /** `channels:write` on the store — denied to `staff` by the role matrix. */
  'store_channels_permission',
  /** A live storefront on the platform, with an administrator account. */
  'platform_admin_account',
  /** The merchant pastes a key pair generated in the platform's own admin. */
  'platform_api_key_pair',
  /** Mercaria's plugin installed on the merchant's WordPress site. */
  'mercaria_plugin_installed',
  /** A feed reachable over HTTPS, or a file to upload. */
  'reachable_feed_or_upload',
  /** The store has at least one location to receive imported stock. */
  'store_location',
  /** Mercaria's OAuth app is configured for this deployment. */
  'platform_oauth_app_configured',
] as const;

export type ChannelRequirementCode = (typeof CHANNEL_REQUIREMENT_CODES)[number];

/** One requirement, and whether this store currently meets it. */
export interface ChannelRequirement {
  readonly code: ChannelRequirementCode;
  readonly summary: string;
  /**
   * Whether the store meets it, when the server can tell.
   *
   * `undefined` is not "no": it means the fact lives with the merchant (whether
   * they have a WooCommerce administrator account, whether the plugin is
   * installed) and Mercaria has no way to observe it. Rendering an unobservable
   * requirement as unmet would refuse a merchant who has it.
   */
  readonly met?: boolean;
}

/** Why a channel type cannot be connected on this deployment right now. */
export const CHANNEL_AVAILABILITY_STATES = [
  /** Implemented and configured — the wizard can run. */
  'available',
  /** Implemented, but this deployment has not configured it (no OAuth app, flag off). */
  'not_configured',
  /** In the vocabulary, with no implementation behind it. */
  'not_implemented',
] as const;

export type ChannelAvailabilityState = (typeof CHANNEL_AVAILABILITY_STATES)[number];

/**
 * Everything the merchant surface knows about ONE channel type.
 *
 * Names every field, the `provider_accounts` (#46) projection convention: a
 * descriptor is composed from a code constant plus deployment configuration, and
 * a spread would carry whatever a future field happens to be called.
 */
export interface ChannelTypeDescriptor {
  readonly channelType: ChannelTypeId;
  readonly kind: ChannelTypeKind;
  /** The connector provider behind it, when it has one. */
  readonly providerId?: ConnectorProviderId;
  readonly name: string;
  /** One sentence: what connecting this actually does. */
  readonly summary: string;
  readonly credentialStrategy: ChannelCredentialStrategy;
  readonly availability: ChannelAvailabilityState;
  readonly resources: ChannelResourceSupport;
  readonly requirements: readonly ChannelRequirement[];
  readonly limitations: readonly ChannelLimitation[];
  /**
   * Whether a catalogue arriving through this channel can be bought on
   * Mercaria's own checkout.
   *
   * A connector writes NATIVE listings the store owns, so yes. A product feed
   * produces EXTERNAL offers, which `offers_kind_shape_check` forbids from
   * carrying a `product_variant_id` — there is no id a cart line could hold, so
   * no. UX requirement 3 ("explain when a sync imports products but cannot
   * support orders or inventory") is this field plus {@link resources}.
   */
  readonly supportsNativeCheckout: boolean;
}

// ── Readiness: the one authoritative result (#87 acceptance 7) ───────────────

/**
 * Why native checkout is not yet available for a store.
 *
 * A closed set because #85 consumes it: an activation surface deciding whether
 * to offer a merchant the switch needs to say WHICH thing is missing, and a
 * sentence cannot be branched on. Ordered by how early in onboarding it bites.
 */
export const CHANNEL_READINESS_BLOCKERS = [
  /** Nothing is supplying a catalogue: no connection, no feed, no listing. */
  'no_connected_channel',
  /** Every connected channel produces external offers only. */
  'no_native_checkout_channel',
  /** A connected channel exists and has never completed a successful sync. */
  'no_successful_sync',
  /** The store has no listing a buyer could put in a cart. */
  'no_publishable_listing',
  /** The seller cannot be paid — #46's stored `onboarding_state` is not `ready`. */
  'payments_not_ready',
] as const;

export type ChannelReadinessBlocker = (typeof CHANNEL_READINESS_BLOCKERS)[number];

/** The health of one axis, three-valued so `unknown` is never a soft yes. */
export const CHANNEL_HEALTH_STATES = ['healthy', 'degraded', 'blocked'] as const;

export type ChannelHealthState = (typeof CHANNEL_HEALTH_STATES)[number];

/**
 * One store's channel readiness — DERIVED at read time, never stored.
 *
 * This is the deliberate divergence from the one-stored-verdict rule, and it is
 * the `deriveNativeCheckoutEligibility` (#57) precedent rather than a new one:
 * the inputs sit on `connections`, `sync_runs`, `feed_configurations`,
 * `listings` and `provider_accounts` — five tables in four domains, none of
 * which this one owns. A stored verdict would be a sixth representation that
 * goes stale the moment a seller's Stripe account is restricted, and the place
 * that must not happen is an activation gate telling a merchant they can sell.
 *
 * The three axes are separate because UX requirements 5 and 6 ask for exactly
 * that: a connected catalogue is not payment readiness, and a healthy sync is
 * not native-checkout activation. Collapsing them into one boolean is what makes
 * a merchant with a perfect Shopify sync wonder why nothing can be bought.
 */
export interface ChannelReadiness {
  readonly storeId: string;
  /** Is anything supplying a catalogue, and is it working? */
  readonly catalog: {
    readonly state: ChannelHealthState;
    /** Channel types currently connected and not paused for fetch. */
    readonly connectedChannelTypes: readonly ChannelTypeId[];
    /** How many of those can support native checkout. */
    readonly nativeCheckoutCapableCount: number;
    readonly lastSuccessfulSyncAt?: string;
  };
  /** Can this seller be paid? Read from #46 and nothing else. */
  readonly payments: {
    readonly state: ChannelHealthState;
    /** False when the rail is disabled for the deployment, so nobody can be ready. */
    readonly railEnabled: boolean;
  };
  /** The conjunction #85 consumes. */
  readonly nativeCheckout: {
    readonly state: ChannelHealthState;
    readonly blockers: readonly ChannelReadinessBlocker[];
  };
}

// ── The unified channel list (#87 connection management 1) ───────────────────

/**
 * Whether a channel is fetching, publishing, both or neither.
 *
 * Management requirement 4 asks that publication be pausable separately from
 * fetch, and they are genuinely two facts: a merchant investigating bad prices
 * wants to stop the catalogue reaching buyers while still letting the connector
 * observe, and a merchant whose platform is rate-limiting wants the opposite.
 * One tri-state column could not express "both paused" without a fourth value
 * that means the same as two flags, so they stay two.
 */
export const CHANNEL_PAUSE_SCOPES = ['fetch', 'publication'] as const;

export type ChannelPauseScope = (typeof CHANNEL_PAUSE_SCOPES)[number];

/** What a channel is doing right now, across connectors, feeds and the native catalogue. */
export const CHANNEL_CONNECTION_STATES = [
  /** Connected, not paused, last run did not fail. */
  'healthy',
  /** Connected, and the last run failed or a `degrades` limitation applies. */
  'attention',
  /** Connected, with fetch or publication deliberately paused. */
  'paused',
  /** Configured but never successfully verified. */
  'error',
  /** Nothing connected for this channel type. */
  'not_connected',
] as const;

export type ChannelConnectionState = (typeof CHANNEL_CONNECTION_STATES)[number];

/**
 * One row of the merchant's channel list — a connector connection, a feed
 * configuration, or the native catalogue, in ONE shape.
 *
 * The three have genuinely different underlying rows, and rendering them from
 * three DTOs is what produced three screens. What a merchant asks of each is the
 * same question: is it on, when did it last run, how much did it move, and can
 * I sell through it.
 */
export interface ChannelSummary {
  /** Stable within a store: the connection id, the feed configuration id, or `native`. */
  readonly id: string;
  readonly channelType: ChannelTypeId;
  readonly state: ChannelConnectionState;
  /** A merchant-recognisable name: the shop domain, the feed label, or the store name. */
  readonly label: string;
  readonly pausedScopes: readonly ChannelPauseScope[];
  readonly lastSyncAt?: string;
  readonly lastRunStatus?: 'running' | 'completed' | 'failed';
  readonly lastRunCounts?: SyncRunCounts;
  /**
   * When the next scheduled pass is expected, when the channel has a schedule.
   *
   * Absent rather than a guess for a push channel: nothing is scheduled, the
   * platform calls when it has something, and rendering a time would be an
   * invented promise.
   */
  readonly nextScheduledSyncAt?: string;
  readonly supportsNativeCheckout: boolean;
}

// ── Onboarding (#87 wizard) ─────────────────────────────────────────────────

/**
 * The wizard's steps, in the order the issue lists them.
 *
 * Stored as the session's current step so the flow is resumable (wizard
 * requirement 12). Collapsed from the issue's twelve into seven because several
 * of the issue's numbered items are one screen — selecting a target location,
 * auto-publish, price rules and the conflict policy are one form over
 * `SyncSettings` — and a step a merchant cannot see is a step that cannot be
 * resumed onto.
 */
export const CHANNEL_ONBOARDING_STEPS = [
  /** Verify store permission and merchant/storefront scope. */
  'scope',
  /** Choose the channel type and read its authentication path. */
  'select_channel',
  /** Complete the provider-specific credential flow. */
  'connect',
  /** Sync directions, target location, auto-publish, price rules, conflict policy. */
  'configure',
  /** Map categories or collections. */
  'map',
  /** A bounded preview or sample sync, with counts. */
  'preview',
  /** Activated — the terminal state. */
  'activate',
] as const;

export type ChannelOnboardingStep = (typeof CHANNEL_ONBOARDING_STEPS)[number];

/** Where a session is in its life, independent of which step it sits on. */
export const CHANNEL_ONBOARDING_STATES = ['in_progress', 'activated', 'abandoned'] as const;

export type ChannelOnboardingState = (typeof CHANNEL_ONBOARDING_STATES)[number];

/**
 * What a bounded preview found, in the vocabulary #87 wizard step 10 asks for.
 *
 * `matched`/`created`/`review`/`invalid`/`duplicate` are the five the issue
 * names. They are counts of RECORDS, never of money, and a preview writes
 * nothing — so a duplicate here is a record the preview would have collided,
 * not a row somebody has to clean up.
 */
export interface ChannelPreviewCounts {
  readonly scanned: number;
  readonly matched: number;
  readonly created: number;
  readonly review: number;
  readonly invalid: number;
  readonly duplicate: number;
}

/**
 * Why a preview does not permit activation.
 *
 * Wizard requirement 11 ("activate only after the preview meets validation
 * requirements") needs a reason a merchant can fix, and a boolean cannot say
 * which record to look at.
 */
export const CHANNEL_ACTIVATION_BLOCKERS = [
  /** No preview has been run for the current configuration. */
  'no_preview',
  /** The preview read zero records — a mapping that matches nothing looks identical to a clean run. */
  'preview_scanned_nothing',
  /** Every record the preview read was invalid. */
  'preview_all_invalid',
  /** The channel type carries a `blocks_activation` limitation. */
  'channel_limitation',
  /** The configuration asks for a direction the channel does not implement. */
  'unsupported_direction',
  /** The connection the session refers to is no longer connected. */
  'connection_not_connected',
] as const;

export type ChannelActivationBlocker = (typeof CHANNEL_ACTIVATION_BLOCKERS)[number];

/**
 * A resumable onboarding session.
 *
 * There is deliberately NO credential field, in the type and in the table: the
 * credential flows write to `connections` (encrypted) or mint a channel key, and
 * a session that could hold one would be a second place a consumer secret
 * lives — one with no encryption envelope and a much longer life, since a
 * session survives being abandoned. Wizard step 4's "collect credentials only
 * through the secure provider-specific flow" is that absence, not a rule
 * somebody follows.
 */
export interface ChannelOnboardingSession {
  readonly id: string;
  readonly storeId: string;
  readonly channelType: ChannelTypeId;
  readonly state: ChannelOnboardingState;
  readonly step: ChannelOnboardingStep;
  /** The connection this session created or reused, once the connect step completes. */
  readonly connectionId?: string;
  /** The feed configuration this session created, for a `product_feed` session. */
  readonly feedConfigurationId?: string;
  /** The merchant and storefront the session is bound to (#83/#84), when proven. */
  readonly merchantId?: string;
  readonly storefrontId?: string;
  readonly previewCounts?: ChannelPreviewCounts;
  readonly previewedAt?: string;
  readonly activationBlockers: readonly ChannelActivationBlocker[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── Disconnect (#87 management 7, acceptance 4) ──────────────────────────────

/**
 * What happens to what a channel produced when the merchant disconnects it.
 *
 * The issue asks for an EXPLICIT policy, and the reason it must be explicit is
 * that the three answers are all defensible and the merchant is the only one who
 * knows which they mean. A merchant switching from Shopify to native editing
 * wants their listings kept; one who connected the wrong store wants them gone.
 *
 * None of the three touches another channel's records — acceptance 4's
 * "source-scoped" — because every policy is applied through
 * `listings.source_connection_id`, and a listing another connection stamped
 * carries another id. There is deliberately no `delete_everything`: source
 * records, clicks and price history are #57/#78's append-only observation chain
 * and reconcile requirement 3 says to preserve them.
 */
export const CHANNEL_DISCONNECT_POLICIES = [
  /** Stop syncing; leave every listing exactly as it stands. */
  'keep_listings',
  /** Stop syncing and unpublish this connection's listings, keeping them editable. */
  'unpublish_listings',
  /** Stop syncing and archive this connection's listings. */
  'archive_listings',
] as const;

export type ChannelDisconnectPolicy = (typeof CHANNEL_DISCONNECT_POLICIES)[number];

/** What a disconnect did, so the merchant sees the count before and after. */
export interface ChannelDisconnectResult {
  readonly connectionId: string;
  readonly policy: ChannelDisconnectPolicy;
  /** Listings this connection stamped, that the policy applied to. */
  readonly listingsAffected: number;
  /**
   * External offers left untouched.
   *
   * Reported rather than acted on: reconcile requirement 3 preserves them and
   * acceptance 3 asks that they remain historically intact, so the number exists
   * to show the merchant that disconnecting did NOT delete their price history.
   */
  readonly externalOffersPreserved: number;
}

// ── Reconciliation with an already-indexed catalogue (#87 reconcile) ─────────

/**
 * How a channel's catalogue relates to what Mercaria already indexed for this
 * merchant.
 *
 * The situation is the one #84 built `reconcileMerchantOfferOverlaps` for: a
 * merchant's shop was crawled before they ever heard of Mercaria, so their
 * products are already external offers on their own storefront. Connecting the
 * channel adds NATIVE offers beside them. Nothing is deleted, converted or
 * merged — reconcile requirements 3 and 4, and #84 acceptance 3 — so what a
 * merchant gets is a REPORT, in the `payment_discrepancies` shape: a thing to
 * look at, with no destructive effect of its own.
 */
export interface ChannelReconciliationSummary {
  readonly storeId: string;
  readonly connectionId: string;
  /** The verified merchant this connection is bound to (#83), when there is one. */
  readonly merchantId?: string;
  /** The exact storefront the channel's shop domain resolves to (#84), when there is one. */
  readonly storefrontId?: string;
  /** Why the binding could not be made, when it could not. */
  readonly bindingGap?: ChannelBindingGap;
  /** External offers already indexed for that storefront. */
  readonly existingExternalOffers: number;
  /** Native offers this store's listings currently materialize. */
  readonly nativeOffers: number;
  /** Canonical variants where both exist — one real sale, two rows. */
  readonly overlaps: readonly ChannelOverlapRow[];
  /** Records a matcher could not resolve, which a merchant may review (#59). */
  readonly awaitingReview: number;
}

/** Why a connection could not be bound to a verified merchant and storefront. */
export const CHANNEL_BINDING_GAPS = [
  /** No merchant claim has been verified for this store's merchant (#83). */
  'merchant_not_claimed',
  /** The store is not linked to a merchant (#84). */
  'store_not_linked',
  /** The merchant is linked, and no storefront matches the channel's shop domain. */
  'storefront_not_matched',
  /** The channel has no shop domain to match on — a feed, or the native catalogue. */
  'channel_has_no_domain',
] as const;

export type ChannelBindingGap = (typeof CHANNEL_BINDING_GAPS)[number];

/** One canonical variant carrying both an external and a native representation. */
export interface ChannelOverlapRow {
  readonly canonicalVariantId: string;
  readonly primaryOfferId: string;
  readonly duplicateOfferId: string;
  /** Which of #84's four deterministic rules demoted the duplicate. */
  readonly rule: string;
}

// ── Audit (#87 security 7) ──────────────────────────────────────────────────

/**
 * The channel acts worth an audit line.
 *
 * A closed set, and the reason it is closed rather than a free-text action
 * string is the same reason the analytics domain has no property bag (#77): an
 * audit row is composed by Mercaria's own code, so an open vocabulary is not a
 * defence against a field nobody anticipated — it is the mechanism by which a
 * consumer secret reaches a table nobody thought of as sensitive.
 */
export const CHANNEL_AUDIT_ACTIONS = [
  'connection_created',
  'connection_reconnected',
  'credentials_rotated',
  'settings_updated',
  'fetch_paused',
  'fetch_resumed',
  'publication_paused',
  'publication_resumed',
  'sync_requested',
  'disconnected',
  'channel_key_minted',
  'channel_key_revoked',
  'onboarding_started',
  'onboarding_activated',
  'onboarding_abandoned',
] as const;

export type ChannelAuditAction = (typeof CHANNEL_AUDIT_ACTIONS)[number];

/**
 * One audit entry.
 *
 * `changedFields` carries FIELD NAMES and never values — the #63 error-report
 * rule ("an error report carries no VALUES"), applied to an audit trail for a
 * stronger reason: the values a channel settings change carries include a
 * consumer secret, and a trail that recorded "before" and "after" would be a
 * plaintext credential store with a retention policy nobody wrote.
 */
export interface ChannelAuditEntry {
  readonly id: string;
  readonly storeId: string;
  readonly action: ChannelAuditAction;
  readonly channelType?: ChannelTypeId;
  readonly connectionId?: string;
  readonly feedConfigurationId?: string;
  readonly actorOxyUserId: string;
  /** The names of the fields that changed. Never their values. */
  readonly changedFields: readonly string[];
  readonly createdAt: string;
}
