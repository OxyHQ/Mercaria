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
import type { OrderStatus } from "@mercaria/shared-types";
import { Button, PickupCollectionPanel, SectionHeader, Text } from "@mercaria/ui";
import { ScreenShell } from "@/components/shell/ScreenShell";
import {
  useGuestPortalSession,
  useGuestPortalStatus,
  useGuestPortalView,
  useMagicLinkExchange,
  usePortalSignOut,
} from "@/lib/hooks/use-guest-portal";
import { useGuestOrderCollection } from "@/lib/hooks/use-nearby";
import { ORDER_STATUS_LABEL_KEYS } from "@/lib/order-status";
import { useTranslation } from "@/lib/i18n";

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
  const { t } = useTranslation();
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
  // #109: `claim:write` is granted only to a credential whose inbox is proven,
  // so this is the same line ADR 0003 D17 draws — a device may watch the order,
  // a proven inbox may move it into an account.
  const canClaim = state?.scopes.includes("claim:write") ?? false;

  const view = useGuestPortalView(group, Boolean(state) && canReadOrders);
  const status = useGuestPortalStatus(group, Boolean(state) && !canReadOrders);

  if (exchange.isPending || (session.isPending && !state)) {
    return (
      <View className="px-4" accessibilityLiveRegion="polite">
        <SectionHeader title={t("guestOrders.portal.openingTitle")} />
        <Text className="text-sm text-muted-foreground">{t("guestOrders.oneMoment")}</Text>
      </View>
    );
  }

  if (!state) {
    return (
      <View className="px-4" accessibilityLiveRegion="polite">
        <SectionHeader
          title={
            linkRefused
              ? t("guestOrders.portal.linkRefusedTitle")
              : t("guestOrders.portal.noCredentialTitle")
          }
        />
        <View className="gap-4">
          <Text className="text-sm text-muted-foreground">
            {linkRefused
              ? t("guestOrders.portal.linkRefusedBody")
              : t("guestOrders.portal.noCredentialBody")}
          </Text>
          <Link href="/guest-orders/recover" asChild>
            <Button>
              <Text className="text-sm font-semibold text-primary-foreground">
                {t("guestOrders.sendAccessLink")}
              </Text>
            </Button>
          </Link>
        </View>
      </View>
    );
  }

  return (
    <View className="px-4 gap-6" accessibilityLiveRegion="polite">
      <SectionHeader title={t("guestOrders.portal.title")} />

      {canReadOrders ? (
        <FullView
          loading={view.isPending}
          failed={view.isError}
          orders={view.data?.orders}
          checkoutGroupId={group}
        />
      ) : (
        <BoundedView
          loading={status.isPending}
          failed={status.isError}
          entries={status.data?.orders}
          checkoutGroupId={group}
        />
      )}

      {/*
        #109 UX rule 1: the OFFER, on the portal. It is a LINK to the review
        screen and not a claim button, because a claim needs a confirmation and
        a signed-in account, and offering the action from here would make the
        press ambiguous — UX rule 10's "never auto-submit" starts at the point
        the person decides, not at the point the request is sent.

        Shown only to a credential that could actually claim (`claim:write` is
        a verified-credential scope), so nobody is offered something the server
        would refuse. The order is unaffected either way, which the review
        screen says outright.
      */}
      {canClaim && group ? (
        <Link href={{ pathname: "/guest-orders/claim", params: { group } }} asChild>
          <Button variant="outline">
            <Text className="text-sm font-medium text-foreground">
              {t("guestOrders.portal.claimAction")}
            </Text>
          </Button>
        </Link>
      ) : null}

      <Button variant="outline" onPress={() => signOut.mutate()} disabled={signOut.isPending}>
        <Text className="text-sm font-medium text-foreground">
          {t("guestOrders.portal.signOut")}
        </Text>
      </Button>
    </View>
  );
}

/** The verified view: every sibling order, with the detail the buyer paid for. */
function FullView(props: {
  loading: boolean;
  failed: boolean;
  orders: { id: string; orderNumber: string; status: OrderStatus }[] | undefined;
  checkoutGroupId: string | undefined;
}) {
  const { t } = useTranslation();
  if (props.loading) {
    return <Text className="text-sm text-muted-foreground">{t("guestOrders.portal.loading")}</Text>;
  }
  if (props.failed || !props.orders) {
    return (
      <Text className="text-sm text-muted-foreground" accessibilityRole="alert">
        {t("guestOrders.portal.fullFailed")}
      </Text>
    );
  }
  return (
    <View className="gap-3">
      {props.orders.map((order) => (
        <View key={order.id} className="gap-1">
          <Text className="text-sm font-semibold text-foreground">{order.orderNumber}</Text>
          <Text className="text-sm text-muted-foreground">
            {t(ORDER_STATUS_LABEL_KEYS[order.status])}
          </Text>
          {props.checkoutGroupId === undefined ? null : (
            <GuestOrderCollection checkoutGroupId={props.checkoutGroupId} orderId={order.id} />
          )}
        </View>
      ))}
    </View>
  );
}

/**
 * One order's collection, inside the portal (#93 client rule 13).
 *
 * A child component because each order needs its OWN query and a hook cannot be
 * called in a loop — and because the collection read is deliberately separate
 * from the order read, so the code is never a field of a cached order DTO.
 *
 * Rendered on BOTH portal views, including the bounded one a just-paid device
 * holds. That is the point rather than an oversight: #93 client rule 13 says
 * the code is shown inside an authorized order surface, and #93 pickup rule 13
 * says a guest must not have to claim the order into Oxy to collect it. The
 * server agrees — the collection route requires a portal session and a matching
 * group, and no scope beyond it — so demanding a proven inbox here would be the
 * client inventing a gate the whole design refuses.
 *
 * An order with no collection renders NOTHING. A delivered order having no
 * pickup is the ordinary case, not a failure worth apologising for.
 */
function GuestOrderCollection({
  checkoutGroupId,
  orderId,
}: {
  checkoutGroupId: string;
  orderId: string;
}) {
  const collection = useGuestOrderCollection({ checkoutGroupId, orderId });
  if (collection.data === undefined) return null;
  return (
    <PickupCollectionPanel
      pickup={collection.data.pickup}
      {...(collection.data.code === undefined ? {} : { code: collection.data.code })}
    />
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
  entries:
    | { id: string; orderNumber: string; status: OrderStatus; sellerLabel: string }[]
    | undefined;
  checkoutGroupId: string | undefined;
}) {
  const { t } = useTranslation();
  if (props.loading) {
    return <Text className="text-sm text-muted-foreground">{t("guestOrders.portal.loading")}</Text>;
  }
  if (props.failed || !props.entries) {
    return (
      <Text className="text-sm text-muted-foreground" accessibilityRole="alert">
        {t("guestOrders.portal.boundedFailed")}
      </Text>
    );
  }
  return (
    <View className="gap-3">
      {props.entries.map((entry) => (
        <View key={entry.id} className="gap-1">
          <Text className="text-sm font-semibold text-foreground">{entry.orderNumber}</Text>
          <Text className="text-sm text-muted-foreground">
            {entry.sellerLabel} · {t(ORDER_STATUS_LABEL_KEYS[entry.status])}
          </Text>
          {props.checkoutGroupId === undefined ? null : (
            <GuestOrderCollection checkoutGroupId={props.checkoutGroupId} orderId={entry.id} />
          )}
        </View>
      ))}
      <Text className="text-sm text-muted-foreground">
        {t("guestOrders.portal.confirmEmailBody")}
      </Text>
      <Link href="/guest-orders/recover" asChild>
        <Button variant="outline">
          <Text className="text-sm font-medium text-foreground">
            {t("guestOrders.portal.confirmEmailAction")}
          </Text>
        </Button>
      </Link>
    </View>
  );
}

export default function GuestOrderPortalScreen() {
  const { t } = useTranslation();
  return (
    <ScreenShell contentClassName="pt-5 web:max-w-[900px]">
      <Head>
        <title>{t("guestOrders.portal.pageTitle")}</title>
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
