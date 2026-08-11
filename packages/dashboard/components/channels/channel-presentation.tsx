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
  ChannelLimitation,
  ChannelReadinessBlocker,
  ChannelTypeId,
} from "@mercaria/shared-types";
import { Text, useColorScheme } from "@mercaria/ui";

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

const STATE_LABEL: Record<ChannelConnectionState, string> = {
  healthy: "Connected",
  attention: "Needs attention",
  paused: "Paused",
  error: "Needs attention",
  not_connected: "Not connected",
};

/** A channel's current state, as a pill. */
export function ChannelStateBadge({ state }: { state: ChannelConnectionState }) {
  const classes = STATE_STYLES[state];
  return (
    <View className={`rounded-full px-2 py-0.5 ${classes}`}>
      <Text className={`text-[10px] font-semibold ${classes.split(" ")[1]}`}>
        {STATE_LABEL[state]}
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
  return supported ? (
    <View className="rounded-full bg-primary/10 px-2 py-0.5">
      <Text className="text-[10px] font-semibold text-primary">Sells on Mercaria</Text>
    </View>
  ) : (
    <View className="rounded-full bg-muted px-2 py-0.5">
      <Text className="text-[10px] font-semibold text-muted-foreground">Comparison only</Text>
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
            Known issue #{limitation.openIssue} — being worked on
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
export const READINESS_BLOCKER_COPY: Record<ChannelReadinessBlocker, string> = {
  no_connected_channel: "Nothing is supplying a catalog yet — connect a channel or add a product.",
  no_native_checkout_channel:
    "Your connected channels list products for comparison but cannot sell through Mercaria checkout. Connect a store, or add products directly.",
  no_successful_sync: "A channel is connected but has not completed a sync yet.",
  no_publishable_listing: "No active products — buyers have nothing to add to a cart.",
  payments_not_ready: "Payouts are not set up, so orders cannot be taken.",
};

/** Merchant-facing channel names, for a screen that has only the id. */
export const CHANNEL_TYPE_NAME: Record<ChannelTypeId, string> = {
  shopify: "Shopify",
  woocommerce: "WooCommerce",
  woocommerce_plugin: "WooCommerce plugin",
  etsy: "Etsy",
  prestashop: "PrestaShop",
  magento: "Magento",
  product_feed: "Product feed",
  native: "Mercaria catalog",
};

/** A timestamp a merchant can read, or an honest absence. */
export function formatWhen(iso: string | undefined, absent: string): string {
  if (!iso) return absent;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return absent;
  return when.toLocaleString();
}
