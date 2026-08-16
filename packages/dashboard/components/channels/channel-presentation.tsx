/**
 * The shared vocabulary every channel screen renders (#87 UX 1 and 2).
 *
 * One set of badges, one set of labels, one limitation card — used by the list,
 * the wizard and the connection detail. #87 UX 1 asks for shared components
 * rather than provider-specific duplicate screens, and the reason it matters is
 * not tidiness: three copies of "what does `attention` mean" drift, and the one
 * that drifts is the screen a merchant reads during an incident.
 *
 * Provider-specific language survives in exactly one place — the AUTHENTICATION
 * step, where Shopify's consent screen and WooCommerce's key pair genuinely are
 * different things (#87 UX 2).
 */

import React from "react";
import { View } from "react-native";
import { AlertTriangle, Info, ShieldAlert } from "lucide-react-native";
import type {
  ChannelConnectionState,
  ChannelEntityAbsenceReason,
  ChannelEntityCaveat,
  ChannelEntityCoverage,
  ChannelLimitation,
  ChannelOrderHorizon,
  ChannelReadinessBlocker,
  ChannelSyncDirection,
  ChannelSyncEntity,
  ChannelTypeId,
  Connection,
  ConnectionWebhookFailure,
  ConnectorWebhookFailureReason,
} from "@mercaria/shared-types";
import { CONNECTOR_WEBHOOK_UNRETRYABLE_FAILURE_REASONS } from "@mercaria/shared-types";
import { Text, useColorScheme, type Translate } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";

/**
 * The five states a channel row can be in, and their colours.
 *
 * The dashboard has no `Badge` primitive; the convention is a `Record<State,
 * string>` of Tailwind classes on an inline `View`, which is what the products
 * list and the pre-#87 channels list both do.
 */
const STATE_STYLES: Record<ChannelConnectionState, string> = {
  healthy: "bg-primary/10 text-primary",
  attention: "bg-destructive/10 text-destructive",
  paused: "bg-muted text-muted-foreground",
  error: "bg-destructive/10 text-destructive",
  not_connected: "bg-muted text-muted-foreground",
};

/**
 * Translation KEYS rather than sentences (#398).
 *
 * This module is evaluated once at import, before the locale store has
 * rehydrated, so a resolved string here would freeze whatever language the first
 * render happened to see. `attention` and `error` deliberately share one key:
 * they are one sentence to a merchant, and two keys carrying identical English
 * are two things a translator can make disagree.
 */
const STATE_LABEL_KEYS: Record<ChannelConnectionState, string> = {
  healthy: "channels.state.connected",
  attention: "channels.state.needsAttention",
  paused: "channels.state.paused",
  error: "channels.state.needsAttention",
  not_connected: "channels.state.notConnected",
};

/** A channel's current state, as a pill. */
export function ChannelStateBadge({ state }: { state: ChannelConnectionState }) {
  const { t } = useTranslation();
  const classes = STATE_STYLES[state];
  return (
    <View className={`rounded-full px-2 py-0.5 ${classes}`}>
      <Text className={`text-[10px] font-semibold ${classes.split(" ")[1]}`}>
        {t(STATE_LABEL_KEYS[state])}
      </Text>
    </View>
  );
}

/**
 * "Can be bought on Mercaria" or "listed for comparison only" (#87 UX 3 and 6).
 *
 * Rendered from the server's `supportsNativeCheckout`, never from the channel
 * type — a client deciding this from a provider id is exactly the
 * provider-specific flag acceptance 7 replaces.
 */
export function NativeCheckoutBadge({ supported }: { supported: boolean }) {
  const { t } = useTranslation();
  return supported ? (
    <View className="rounded-full bg-primary/10 px-2 py-0.5">
      <Text className="text-[10px] font-semibold text-primary">
        {t("channels.badge.sellsOnMercaria")}
      </Text>
    </View>
  ) : (
    <View className="rounded-full bg-muted px-2 py-0.5">
      <Text className="text-[10px] font-semibold text-muted-foreground">
        {t("channels.badge.comparisonOnly")}
      </Text>
    </View>
  );
}

/**
 * One limitation, with its severity and — when there is one — the open issue.
 *
 * The issue number is SHOWN rather than kept in the code, and that is the
 * deliberate choice: a merchant walking into #218 (their WooCommerce webhooks
 * silently fail forever) deserves to know it is a known defect being worked on
 * rather than something they configured wrong.
 */
export function ChannelLimitationRow({ limitation }: { limitation: ChannelLimitation }) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const Icon =
    limitation.severity === "blocks_activation"
      ? ShieldAlert
      : limitation.severity === "degrades"
        ? AlertTriangle
        : Info;
  // `useColorScheme` exposes no destructive token, so a severity is carried by
  // the ICON and by the copy rather than by a colour this palette does not have.
  // Inventing a hex here would be a second, drifting source of the theme.
  const tint = colors.mutedForeground;

  return (
    <View className="flex-row items-start gap-2">
      <View className="pt-0.5">
        <Icon size={14} color={tint} />
      </View>
      <View className="flex-1">
        <Text className="text-xs text-muted-foreground">{limitation.summary}</Text>
        {limitation.openIssue !== undefined ? (
          <Text className="mt-0.5 text-[10px] font-medium text-muted-foreground">
            {t("channels.limitation.knownIssue", { issue: limitation.openIssue })}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * What each readiness blocker means, and what to do about it.
 *
 * A `Record` over the closed tuple rather than a `switch` with a default: adding
 * a blocker server-side then fails `tsc` here, which is how a new reason gets
 * copy instead of falling through to a generic sentence nobody can act on.
 */
export const READINESS_BLOCKER_COPY_KEYS: Record<ChannelReadinessBlocker, string> = {
  no_connected_channel: "channels.readinessBlocker.noConnectedChannel",
  no_native_checkout_channel: "channels.readinessBlocker.noNativeCheckoutChannel",
  no_successful_sync: "channels.readinessBlocker.noSuccessfulSync",
  no_publishable_listing: "channels.readinessBlocker.noPublishableListing",
  payments_not_ready: "channels.readinessBlocker.paymentsNotReady",
};

/**
 * What each entity is CALLED on a merchant's screen (#380).
 *
 * A `Record` over the closed tuple, for `READINESS_BLOCKER_COPY`'s reason and
 * with more weight behind it here: this package has no test runner, so `tsc` is
 * the only gate it has, and a `Record` over a shared-types tuple is how a
 * server-side addition becomes a dashboard build failure instead of a screen
 * quietly rendering a raw identifier. Adding an entity to
 * `CHANNEL_SYNC_ENTITIES` fails the Typecheck Dashboard job until it has a name.
 */
export const CHANNEL_SYNC_ENTITY_LABEL_KEYS: Record<ChannelSyncEntity, string> = {
  products: "channels.entity.products",
  inventory: "channels.entity.inventory",
  orders: "channels.entity.orders",
  collections: "channels.entity.collections",
  customers: "channels.entity.customers",
  discounts: "channels.entity.discounts",
  tax_rates: "channels.entity.taxRates",
  refunds: "channels.entity.refunds",
  gift_cards: "channels.entity.giftCards",
  shipping_rates: "channels.entity.shippingRates",
  product_reviews: "channels.entity.productReviews",
};

/**
 * Why an entity does not arrive, in words a merchant can act on.
 *
 * Each says what IS true rather than apologising for what is not — "Mercaria has
 * no gift card record" tells a merchant to stop waiting, where "not supported"
 * leaves them wondering whether they configured something wrong. None of them
 * promises a date: a sentence that implies work is planned is the thing that
 * generates the next report when it is not.
 */
export const CHANNEL_ENTITY_ABSENCE_COPY_KEYS: Record<ChannelEntityAbsenceReason, string> = {
  channel_not_implemented: "channels.entityAbsence.channelNotImplemented",
  native_catalog_is_not_a_sync: "channels.entityAbsence.nativeCatalogIsNotASync",
  channel_transports_products_only: "channels.entityAbsence.channelTransportsProductsOnly",
  not_built_for_this_channel: "channels.entityAbsence.notBuiltForThisChannel",
  not_modelled_by_mercaria: "channels.entityAbsence.notModelledByMercaria",
  owned_by_another_system: "channels.entityAbsence.ownedByAnotherSystem",
  imported_only_as_part_of_an_order: "channels.entityAbsence.importedOnlyAsPartOfAnOrder",
};

/** What a `partial` entry means — the record does not arrive, some of its data does. */
export const CHANNEL_ENTITY_CAVEAT_COPY_KEYS: Record<ChannelEntityCaveat, string> = {
  membership_only_through_a_mapping: "channels.entityCaveat.membershipOnlyThroughAMapping",
  breakdown_only_on_imported_orders: "channels.entityCaveat.breakdownOnlyOnImportedOrders",
};

/** Which way an entity moves, as a merchant reads it — the KEY, resolved by the caller. */
function directionSummaryKey(directions: readonly ChannelSyncDirection[]): string {
  const pull = directions.includes("pull");
  const push = directions.includes("push");
  if (pull && push) return "channels.direction.bothWays";
  if (push) return "channels.direction.push";
  return "channels.direction.pull";
}

/**
 * Everything a channel carries and everything it does not, in one block (#380).
 *
 * Rendered from the server's TOTAL `entityCoverage` rather than from a list of
 * what works: a merchant reading "products, stock and orders" cannot tell
 * whether discounts are missing, broken, or somewhere else in the app, and the
 * report that produced this issue is what that ambiguity costs. `compact` is the
 * pre-choice form on the channel list — the names only, no reasons — because the
 * full reasons belong where somebody is deciding rather than browsing.
 */
export function ChannelCoverage({
  coverage,
  compact = false,
}: {
  coverage: readonly ChannelEntityCoverage[];
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const carried = coverage.filter((entry) => entry.state !== "not_synced");
  const absent = coverage.filter((entry) => entry.state === "not_synced");

  if (compact) {
    return (
      <View className="gap-1">
        <Text className="text-xs text-muted-foreground">
          <Text className="text-xs font-semibold text-foreground">
            {t("channels.coverage.syncsLabel")}
          </Text>
          {carried.length === 0
            ? t("channels.coverage.nothing")
            : carried.map((entry) => t(CHANNEL_SYNC_ENTITY_LABEL_KEYS[entry.entity])).join(", ")}
        </Text>
        <Text className="text-xs text-muted-foreground">
          <Text className="text-xs font-semibold text-foreground">
            {t("channels.coverage.doesNotSyncLabel")}
          </Text>
          {absent.length === 0
            ? t("channels.coverage.nothing")
            : absent.map((entry) => t(CHANNEL_SYNC_ENTITY_LABEL_KEYS[entry.entity])).join(", ")}
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-3">
      {carried.length > 0 ? (
        <View className="gap-1.5">
          <Text className="text-[10px] font-semibold uppercase text-muted-foreground">
            {t("channels.coverage.syncsHeading")}
          </Text>
          {carried.map((entry) => (
            <View key={entry.entity} className="flex-row items-start gap-2">
              <Text className="text-xs font-medium text-foreground">
                {t(CHANNEL_SYNC_ENTITY_LABEL_KEYS[entry.entity])}
              </Text>
              <Text className="flex-1 text-xs text-muted-foreground">
                {entry.state === "partial"
                  ? t("channels.coverage.partial", {
                      direction: t(directionSummaryKey(entry.directions)),
                      caveat: t(CHANNEL_ENTITY_CAVEAT_COPY_KEYS[entry.caveat]),
                    })
                  : t(directionSummaryKey(entry.directions))}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {absent.length > 0 ? (
        <View className="gap-1.5">
          <Text className="text-[10px] font-semibold uppercase text-muted-foreground">
            {t("channels.coverage.doesNotSyncHeading")}
          </Text>
          {absent.map((entry) => (
            <View key={entry.entity} className="flex-row items-start gap-2">
              <Text className="text-xs font-medium text-foreground">
                {t(CHANNEL_SYNC_ENTITY_LABEL_KEYS[entry.entity])}
              </Text>
              <Text className="flex-1 text-xs text-muted-foreground">
                {entry.state === "not_synced"
                  ? t(CHANNEL_ENTITY_ABSENCE_COPY_KEYS[entry.reason])
                  : null}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * How far back this connection's orders reach, as a sentence (#380).
 *
 * The DATE is computed here from the server's `days` and this device's clock,
 * never sent: the bound is a rolling window applied at every fetch, so a date
 * baked into a response is stale the moment it is rendered. `complete` returns
 * null — "every order is imported" is what a merchant already assumes, and a
 * reassurance beside every healthy channel is noise that trains people to skip
 * the line that matters.
 *
 * `bounded` does NOT tell a merchant to grant a scope. `read_all_orders` is
 * granted to an APP on Shopify's written approval, so the action is Mercaria's
 * and asking the merchant for it would send them somewhere they cannot go.
 */
export function describeOrderHorizon(horizon: ChannelOrderHorizon, t: Translate): string | null {
  switch (horizon.kind) {
    case "complete":
      return null;
    case "not_synced":
      return t("channels.orderHorizon.notSynced");
    case "unknown":
      return t("channels.orderHorizon.unknown");
    case "bounded": {
      const before = new Date(Date.now() - horizon.days * 24 * 60 * 60 * 1000);
      return t("channels.orderHorizon.bounded", {
        count: horizon.days,
        before: before.toLocaleDateString(),
      });
    }
  }
}

/** Merchant-facing channel names, for a screen that has only the id. */
export const CHANNEL_TYPE_NAME_KEYS: Record<ChannelTypeId, string> = {
  shopify: "channels.type.shopify",
  woocommerce: "channels.type.woocommerce",
  woocommerce_plugin: "channels.type.woocommercePlugin",
  etsy: "channels.type.etsy",
  prestashop: "channels.type.prestashop",
  magento: "channels.type.magento",
  product_feed: "channels.type.productFeed",
  native: "channels.type.native",
};

/** A timestamp a merchant can read, or an honest absence. */
export function formatWhen(iso: string | undefined, absent: string): string {
  if (!iso) return absent;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return absent;
  return when.toLocaleString();
}

/**
 * Why one topic was refused, in words a merchant can act on (#218's reasons).
 *
 * A `Record` over the closed tuple for `READINESS_BLOCKER_COPY`'s reason: a
 * reason added server-side then fails `tsc` here rather than falling through to
 * a generic sentence. Each says what HAPPENED; what to DO about it is
 * {@link deriveWebhookDelivery}'s remedy, because the answer depends on whether
 * any retry could ever fix it rather than on the individual topic.
 */
export const WEBHOOK_FAILURE_REASON_COPY_KEYS: Record<ConnectorWebhookFailureReason, string> = {
  permission_denied: "channels.webhookFailureReason.permissionDenied",
  rate_limited: "channels.webhookFailureReason.rateLimited",
  topic_not_supported: "channels.webhookFailureReason.topicNotSupported",
  platform_error: "channels.webhookFailureReason.platformError",
  unexpected_response: "channels.webhookFailureReason.unexpectedResponse",
  transport_error: "channels.webhookFailureReason.transportError",
};

/** The five things a merchant's real-time sync can be doing (#262). */
export interface WebhookDeliveryPresentation {
  readonly state: "healthy" | "unregistered" | "retrying" | "refused" | "stopped";
  readonly headline: string;
  readonly detail: string;
  /** What the button says — "try now" while Mercaria is already retrying. */
  readonly actionLabel: string;
}

/**
 * Is this a refusal no number of retries can fix?
 *
 * Read from the shared tuple rather than re-listed, so the dashboard cannot
 * disagree with the sweep about which refusals are worth retrying. The local
 * annotation widens the const tuple's element type without an `as`.
 */
function isUnretryable(reason: ConnectorWebhookFailureReason): boolean {
  const unretryable: readonly ConnectorWebhookFailureReason[] =
    CONNECTOR_WEBHOOK_UNRETRYABLE_FAILURE_REASONS;
  return unretryable.includes(reason);
}

/**
 * What the merchant has to change before a retry can succeed.
 *
 * Named from the refusals ACTUALLY recorded rather than guessed at: a
 * `permission_denied` is a grant only they can widen and a `topic_not_supported`
 * is an event the platform will never send, so telling somebody to "check your
 * permissions" for the second wastes their afternoon on a setting that is fine.
 */
function remedyFor(
  failures: readonly ConnectionWebhookFailure[],
  providerName: string,
  t: Translate,
): string | undefined {
  const reasons = new Set(failures.map((failure) => failure.reason).filter(isUnretryable));
  const sentences: string[] = [];
  if (reasons.has("permission_denied")) {
    sentences.push(t("channels.webhooks.remedyPermissionDenied", { provider: providerName }));
  }
  if (reasons.has("topic_not_supported")) {
    sentences.push(t("channels.webhooks.remedyTopicNotSupported", { provider: providerName }));
  }
  return sentences.length > 0 ? sentences.join(" ") : undefined;
}

/**
 * What to tell a merchant about their channel's real-time updates, and what the
 * button should say (#262).
 *
 * The ORDER of these checks is load-bearing. `webhookRegistration` is the
 * authority on whether Mercaria is still trying, and `webhookFailures` is a
 * separate fact about which topics were refused — so keying the headline on the
 * refusals first renders a channel Mercaria has GIVEN UP on as healthy whenever
 * the failure went unrecorded, which is exactly what a credential that will not
 * decrypt produces: the registration is answered `retryable` with no per-topic
 * row to show, the attempt budget drains, and the connection dead-letters
 * carrying no refusals at all.
 *
 * The three unhealthy states are not one state with a counter, because the next
 * action differs. `stopped` means the automatic retries are over and pressing
 * the button against an unchanged platform will simply fail again. `retrying`
 * means Mercaria is already handling it and the button only brings it forward.
 * `refused` means the registration FINISHED and some topics were still refused —
 * nothing is scheduled, so neither of the other two sentences is true of it.
 */
export function deriveWebhookDelivery(
  connection: Connection,
  providerName: string,
  t: Translate,
  now: Date = new Date(),
): WebhookDeliveryPresentation {
  const failures = connection.webhookFailures ?? [];
  const registration = connection.webhookRegistration;
  const remedy = remedyFor(failures, providerName, t);

  if (registration?.state === "dead_letter") {
    // No failures recorded means the registration never got far enough to name a
    // topic — a credential Mercaria could not resolve is the case that produces
    // it, and reconnecting is the only thing that fixes that one.
    const cause =
      remedy ??
      (failures.length > 0
        ? t("channels.webhooks.causeUnreachable", { provider: providerName })
        : t("channels.webhooks.causeIncomplete"));
    return {
      state: "stopped",
      headline: t("channels.webhooks.stoppedHeadline"),
      detail: t("channels.webhooks.stoppedDetail", { count: registration.attempts, cause }),
      actionLabel: t("channels.webhooks.registerAgain"),
    };
  }

  // Mid-retry is `pending` WITH something spent or scheduled — not merely "a
  // registration object is present" (#297). Before the state had a success
  // value the server hid the field in the ordinary case, so presence alone was
  // a usable proxy for "something is wrong"; now that a healthy connection
  // reports `registered` and a fresh one reports `pending` with nothing spent,
  // that proxy would render both as "Mercaria is retrying automatically". A
  // channel nobody has registered yet falls through to the `webhookIds` branch,
  // which says so plainly and offers the button that starts it.
  if (
    registration?.state === "pending" &&
    (registration.attempts > 0 || registration.nextAttemptAt !== undefined)
  ) {
    // `nextAttemptAt` is absent on a claim that is in flight right now, and can
    // be in the PAST for one that is due — printing a past timestamp beside
    // "the next attempt is" reads as a stuck queue, so both say "due now".
    const scheduled = registration.nextAttemptAt;
    const dueNow = t("channels.webhooks.dueNow");
    const due =
      scheduled !== undefined && new Date(scheduled).getTime() > now.getTime()
        ? formatWhen(scheduled, dueNow)
        : dueNow;
    return {
      state: "retrying",
      headline: t("channels.webhooks.retryingHeadline"),
      detail: t("channels.webhooks.retryingDetail", {
        due,
        remedy: remedy ?? t("channels.webhooks.bringForward"),
      }),
      actionLabel: t("channels.webhooks.tryNow"),
    };
  }

  if (failures.length > 0) {
    return {
      state: "refused",
      headline: t("channels.webhooks.refusedHeadline"),
      detail:
        remedy ??
        // Every refusal here is one a retry could take (an unretryable one would
        // have produced a `remedy`), and such a connection IS in the sweep's
        // population — so the schedule can be promised rather than leaving the
        // merchant to think the button is the only thing that will ever try.
        t("channels.webhooks.refusedDetail", { provider: providerName }),
      actionLabel: t("channels.webhooks.registerAgain"),
    };
  }

  if (connection.webhookIds.length === 0) {
    return {
      state: "unregistered",
      headline: t("channels.webhooks.unregisteredHeadline"),
      detail: t("channels.webhooks.unregisteredDetail", { provider: providerName }),
      actionLabel: t("channels.webhooks.register"),
    };
  }

  return {
    state: "healthy",
    headline: t("channels.webhooks.healthyHeadline"),
    detail: t("channels.webhooks.healthyDetail", {
      count: connection.webhookIds.length,
      provider: providerName,
    }),
    actionLabel: t("channels.webhooks.registerAgain"),
  };
}
