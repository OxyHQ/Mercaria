/**
 * The guest order portal (#108, ADR 0003 D5/T4/T14).
 *
 * ## The token is in the FRAGMENT, and this screen is why that works
 *
 * A URL fragment is never sent to a server, so the `mgx_` token in an emailed
 * link cannot reach an access log, a proxy log or a `Referer` header. The cost
 * is that the SERVER cannot read it either — which is the whole point — so this
 * screen reads it in the browser and POSTs it to the exchange, and the durable
 * credential comes back in a `Set-Cookie` or a response header.
 *
 * Three client-side obligations follow from that, and all three are here
 * because nothing server-side can perform them:
 *
 *  1. **Strip it immediately.** `history.replaceState` removes the fragment
 *     from the address bar AND from the entry the back button would return to,
 *     before the exchange even resolves. The token is captured into a local
 *     variable first: replacing the URL is what makes it unreadable, so
 *     reading it has to come first.
 *  2. **Send no referrer.** `<meta name="referrer" content="no-referrer">`, so
 *     that even in the window before the strip, an image, a font or a script
 *     on this page cannot carry the URL to a third party.
 *  3. **Exchange ONCE.** A `useRef` guard, because an exchange CONSUMES the
 *     link — React's development double-invoke, a fast refresh or a re-render
 *     would each burn a grant and leave the buyer told their link is invalid.
 *     The mutation also sets `retry: false` for the same reason.
 *
 * ## Native arrives by verified universal link, not a custom scheme
 *
 * A custom scheme can be registered by any app on the device (T14); a verified
 * universal/app link cannot. expo-router hands the fragment through the same
 * route, so the code below is identical on both platforms — `window` is simply
 * absent on native, and the `params` path covers it.
 *
 * ## What this screen shows when there is no credential
 *
 * Nothing about any order. A person who arrives with an expired link, a
 * consumed one or no link at all is offered the recovery form — the same answer
 * in every case, because distinguishing them here would undo the uniform
 * rejection the server is careful to give.
 */

import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import Head from "expo-router/head";
import { Link, useLocalSearchParams } from "expo-router";
import { Button, SectionHeader, Text } from "@mercaria/ui";
import { ScreenShell } from "@/components/shell/ScreenShell";
import {
  useGuestPortalSession,
  useGuestPortalStatus,
  useGuestPortalView,
  useMagicLinkExchange,
  usePortalSignOut,
} from "@/lib/hooks/use-guest-portal";

/** The prefix an exchange token carries. Anything else is not one. */
const EXCHANGE_PREFIX = "mgx_";

/**
 * Read the token out of the URL and REMOVE it, in that order.
 *
 * Returns `null` on native and whenever there is no fragment — the caller falls
 * back to a route parameter, which is how a verified app link delivers it.
 */
function takeTokenFromFragment(): string | null {
  if (typeof window === "undefined") return null;
  const fragment = window.location.hash.replace(/^#/, "");
  if (!fragment.startsWith(EXCHANGE_PREFIX)) return null;
  // Captured BEFORE the strip: after `replaceState` the value is gone, so the
  // order of these two statements is the feature.
  const token = fragment;
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
  return token;
}

function PortalBody() {
  const params = useLocalSearchParams<{ token?: string; group?: string }>();
  const exchange = useMagicLinkExchange();
  const signOut = usePortalSignOut();
  const attempted = useRef(false);
  const [linkRefused, setLinkRefused] = useState(false);

  // The exchange is a one-shot side effect on arrival and genuinely needs an
  // effect: there is no user event to hang it on, and the token must be taken
  // out of the URL before anything renders a link the browser could follow.
  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    const token = takeTokenFromFragment() ?? params.token ?? null;
    if (token === null || !token.startsWith(EXCHANGE_PREFIX)) return;
    exchange.mutate(token, { onError: () => setLinkRefused(true) });
    // `exchange` is a stable mutation object and `params.token` is read once by
    // design — re-running this effect would consume a second link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const session = useGuestPortalSession(!exchange.isPending);
  const state = exchange.data ?? session.data;
  const group = state?.checkoutGroupId ?? params.group;
  const canReadOrders = state?.scopes.includes("orders:read") ?? false;

  const view = useGuestPortalView(group, Boolean(state) && canReadOrders);
  const status = useGuestPortalStatus(group, Boolean(state) && !canReadOrders);

  if (exchange.isPending || (session.isPending && !state)) {
    return (
      <View className="px-4" accessibilityLiveRegion="polite">
        <SectionHeader title="Opening your order" />
        <Text className="text-sm text-muted-foreground">One moment.</Text>
      </View>
    );
  }

  if (!state) {
    return (
      <View className="px-4" accessibilityLiveRegion="polite">
        <SectionHeader title={linkRefused ? "This link cannot be used" : "Find your order"} />
        <View className="gap-4">
          <Text className="text-sm text-muted-foreground">
            {linkRefused
              ? "Access links can only be used once and expire quickly. Ask for a new one and we will send it to the address the order was placed with."
              : "Ask for a secure access link and we will send it to the address the order was placed with."}
          </Text>
          <Link href="/guest-orders/recover" asChild>
            <Button>
              <Text className="text-sm font-semibold text-primary-foreground">
                Send me an access link
              </Text>
            </Button>
          </Link>
        </View>
      </View>
    );
  }

  return (
    <View className="px-4 gap-6" accessibilityLiveRegion="polite">
      <SectionHeader title="Your order" />

      {canReadOrders ? (
        <FullView loading={view.isPending} failed={view.isError} orders={view.data?.orders} />
      ) : (
        <BoundedView
          loading={status.isPending}
          failed={status.isError}
          entries={status.data?.orders}
        />
      )}

      <Button variant="outline" onPress={() => signOut.mutate()} disabled={signOut.isPending}>
        <Text className="text-sm font-medium text-foreground">Sign out of this order</Text>
      </Button>
    </View>
  );
}

/** The verified view: every sibling order, with the detail the buyer paid for. */
function FullView(props: {
  loading: boolean;
  failed: boolean;
  orders: { id: string; orderNumber: string; status: string }[] | undefined;
}) {
  if (props.loading) {
    return <Text className="text-sm text-muted-foreground">Loading your order.</Text>;
  }
  if (props.failed || !props.orders) {
    return (
      <Text className="text-sm text-muted-foreground" accessibilityRole="alert">
        We could not open this order from here. Ask for a new access link and try again.
      </Text>
    );
  }
  return (
    <View className="gap-3">
      {props.orders.map((order) => (
        <View key={order.id} className="gap-1">
          <Text className="text-sm font-semibold text-foreground">{order.orderNumber}</Text>
          <Text className="text-sm text-muted-foreground">{order.status}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The BOUNDED view a confirmation session sees: order number, seller and coarse
 * status, and deliberately no money, no address and no item titles. Confirming
 * the email address is what opens the rest — which is the line ADR 0003 D17
 * draws between what a device may see and what a proven inbox may.
 */
function BoundedView(props: {
  loading: boolean;
  failed: boolean;
  entries: { id: string; orderNumber: string; status: string; sellerLabel: string }[] | undefined;
}) {
  if (props.loading) {
    return <Text className="text-sm text-muted-foreground">Loading your order.</Text>;
  }
  if (props.failed || !props.entries) {
    return (
      <Text className="text-sm text-muted-foreground" accessibilityRole="alert">
        We could not read this order from here.
      </Text>
    );
  }
  return (
    <View className="gap-3">
      {props.entries.map((entry) => (
        <View key={entry.id} className="gap-1">
          <Text className="text-sm font-semibold text-foreground">{entry.orderNumber}</Text>
          <Text className="text-sm text-muted-foreground">
            {entry.sellerLabel} · {entry.status}
          </Text>
        </View>
      ))}
      <Text className="text-sm text-muted-foreground">
        Confirm your email address to see the full order, including what you paid and where it is
        going.
      </Text>
      <Link href="/guest-orders/recover" asChild>
        <Button variant="outline">
          <Text className="text-sm font-medium text-foreground">Confirm my email address</Text>
        </Button>
      </Link>
    </View>
  );
}

export default function GuestOrderPortalScreen() {
  return (
    <ScreenShell contentClassName="pt-5 web:max-w-[900px]">
      <Head>
        <title>Your order — Mercaria</title>
        {/*
          A STRICT referrer policy on the one page a credential ever reaches in
          a URL (#108 magic-link rule 5). Even in the window before the fragment
          is stripped, no subresource on this page may carry the location to a
          third party — and `no-referrer` is the only value that holds for a
          same-origin request too.
        */}
        <meta name="referrer" content="no-referrer" />
        {/* An access page has nothing a search engine should hold. */}
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <PortalBody />
    </ScreenShell>
  );
}
