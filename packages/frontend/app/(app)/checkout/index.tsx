import { useMemo, useRef, useState } from "react";
import { View, Pressable } from "react-native";
import Head from "expo-router/head";
import { Link, useLocalSearchParams, useRouter } from "expo-router";
import { openAccountDialog, useOxy } from "@oxyhq/services";
import { Check, Plus } from "lucide-react-native";
import { nanoid } from "nanoid/non-secure";
import type {
  Address,
  CartGroup,
  CheckoutDestination,
  CheckoutPaymentHandoff,
  CheckoutPaymentStatus,
  Money,
} from "@mercaria/shared-types";
import {
  Button,
  Input,
  Label,
  PriceDisplay,
  SectionHeader,
  Text,
  formatMoney,
} from "@mercaria/ui";
import { ScreenShell } from "@/components/shell/ScreenShell";
import {
  CheckoutDestinationForm,
  EMPTY_CHECKOUT_DRAFT,
  cleanAddress,
  cleanContact,
  isDraftComplete,
  type CheckoutDestinationDraft,
} from "@/components/checkout/CheckoutDestinationForm";
import { toast } from "@oxyhq/bloom/toast";
import { useCart } from "@/lib/hooks/use-cart";
import { useAddresses } from "@/lib/hooks/use-addresses";
import { useCheckout, useCheckoutPaymentStatus } from "@/lib/hooks/use-checkout";
import { CardPaymentStep } from "@/components/payment/CardPaymentStep";

/** The stable seller-group key, matching the backend (`store:<id>` / `user:<id>`). */
function groupKey(group: CartGroup): string {
  return `${group.vendor.kind}:${group.vendor.id}`;
}

/**
 * The seller keys `?seller=` names — one, several (comma-separated), or none.
 *
 * A LIST because a mixed cart has to be separable (#112): a guest whose cart
 * holds both a shop and a person can check out the shop's group, and the cart
 * sends the keys that are actually checkout-able rather than the whole cart the
 * server would then refuse. A single key parses to a one-element list, so every
 * link that existed before behaves exactly as it did.
 */
function parseSellerKeys(seller: string | undefined): string[] {
  if (!seller) return [];
  return seller
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

/** Sum the subtotals of the groups being checked out (all share one currency). */
function sumSubtotals(groups: CartGroup[]): Money | null {
  if (groups.length === 0) return null;
  const currency = groups[0].subtotal.currency;
  const amount = groups.reduce((acc, g) => acc + g.subtotal.amount, 0);
  return { amount, currency };
}

function AddressOption({
  address,
  selected,
  onSelect,
}: {
  address: Address;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`Ship to ${address.recipientName}`}
      onPress={onSelect}
      className={`flex-row items-start gap-3 rounded-2xl border p-4 ${
        selected ? "border-primary bg-secondary/40" : "border-border bg-card"
      }`}
    >
      <View
        className={`mt-0.5 h-5 w-5 items-center justify-center rounded-full border ${
          selected ? "border-primary bg-primary" : "border-border"
        }`}
      >
        {selected ? <Check size={12} className="text-primary-foreground" /> : null}
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
          {address.label ?? address.recipientName}
        </Text>
        <Text className="text-sm text-muted-foreground">
          {address.line1}
          {address.line2 ? `, ${address.line2}` : ""}
        </Text>
        <Text className="text-sm text-muted-foreground">
          {address.city}
          {address.region ? `, ${address.region}` : ""} {address.postalCode}, {address.country}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * Signing in, offered as a BENEFIT rather than as a gate (#105 frontend rules
 * 1-3).
 *
 * Every capability named here exists today: saved addresses are the account's
 * address book (this screen renders them right below), the cart merge is #104's
 * `POST /cart/merge`, and account-owned order history is `GET /orders`. Nothing
 * is promised that a buyer could not go and use five seconds after signing in —
 * and nothing about a payment rail is mentioned at all, because which rails
 * exist is not a property of having an account.
 */
function SignInBenefit() {
  return (
    <View className="rounded-2xl border border-border bg-card p-4">
      <Text className="text-sm font-semibold text-foreground">Have an Oxy account?</Text>
      <Text className="mt-1 text-sm text-muted-foreground">
        Signing in brings your saved addresses, keeps this cart on your other devices, and keeps
        this order in your account&apos;s order history. You can also check out as a guest — it
        takes the same amount of typing.
      </Text>
      <Button variant="outline" className="mt-3 self-start" onPress={() => openAccountDialog()}>
        <Text className="text-sm font-medium text-foreground">Sign in</Text>
      </Button>
    </View>
  );
}

function OrderSummaryCard({ groups }: { groups: CartGroup[] }) {
  const subtotal = sumSubtotals(groups);
  return (
    <View className="rounded-2xl border border-border bg-card p-4">
      <Text className="mb-3 text-sm font-semibold text-foreground">Order summary</Text>
      <View className="gap-4">
        {groups.map((group) => (
          <View key={groupKey(group)} className="gap-2">
            <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group.vendor.name}
            </Text>
            {group.items.map((item) => (
              <View key={item.variantId} className="flex-row items-center justify-between gap-3">
                <View className="min-w-0 flex-1">
                  <Text className="text-sm text-foreground" numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text className="text-xs text-muted-foreground">
                    {item.variantTitle} · ×{item.quantity}
                  </Text>
                </View>
                <PriceDisplay price={item.lineTotal} primaryClassName="text-sm" />
              </View>
            ))}
          </View>
        ))}
        <View className="my-1 h-px bg-border" />
        <View className="flex-row items-center justify-between">
          <Text className="text-sm font-semibold text-foreground">Subtotal</Text>
          {subtotal ? <PriceDisplay price={subtotal} primaryClassName="text-base font-bold" /> : null}
        </View>
        <Text className="text-xs text-muted-foreground">
          Discounts, taxes and shipping are calculated when your order is placed.
        </Text>
      </View>
    </View>
  );
}

/**
 * The payment step — the second half of checkout, and the only place a buyer is
 * told what happened to their money.
 *
 * ## Every state here is REPORTED, never assumed
 *
 * `status` comes from the server's payment-status endpoint, which answers from
 * the payment aggregate — a value only a verified provider webhook can move. The
 * card sheet's own result decides only whether to START asking. That separation
 * is why a client cannot forge a paid order, and it is why "we are confirming
 * your payment" is a real state with its own screen rather than an optimistic
 * success message.
 *
 * `requires_action` and `processing` are shown as the same honest sentence: from
 * the buyer's side both mean the bank has not finished, and inventing a
 * difference would be describing a provider's internals to somebody who cannot
 * act on them.
 */
function PaymentStep({
  payment,
  status,
  awaiting,
  error,
  isGuest,
  orderNumbers,
  onCompleted,
  onCancelled,
  onFailed,
  onDone,
}: {
  payment: CheckoutPaymentHandoff;
  status: CheckoutPaymentStatus["status"];
  awaiting: boolean;
  error: string | null;
  /** Whether this purchase was placed without an Oxy account (#107 client rule 8). */
  isGuest: boolean;
  /** The placed orders' numbers — what a guest keeps instead of a link. */
  orderNumbers: string[];
  onCompleted: () => void;
  onCancelled: () => void;
  onFailed: (message: string) => void;
  onDone: () => void;
}) {
  if (status === "succeeded") {
    return (
      // A live region: this screen changes under the buyer while they are not
      // touching it (the poll answers), so a screen reader has to be told rather
      // than waiting to be asked.
      <View className="px-4" accessibilityLiveRegion="polite">
        <SectionHeader title="Payment received" />
        <View className="gap-4">
          <Text className="text-sm text-muted-foreground">
            Thank you. Your order is confirmed and the seller has been notified.
          </Text>
          {isGuest ? (
            /*
              A guest is still NOT sent to `/orders/...`: that route is
              account-authenticated and would answer 401 for the person who just
              paid (#107 client rule 8). What #108 added is the honest
              destination — a grant-scoped portal reached with a credential this
              device pulls for the group it just placed, which is a DIFFERENT
              credential from the cart token and carries only the bounded status
              view until the buyer confirms their address (ADR 0003 D17).

              The order number stays, and stays first: it is the thing a support
              conversation starts from, it works when a link does not, and — as
              ADR 0003 T6 says outright — it authorizes nothing, so printing it
              costs nothing either.
            */
            <>
              <View className="rounded-2xl border border-border bg-card p-4">
                <Text className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {orderNumbers.length > 1 ? "Your order numbers" : "Your order number"}
                </Text>
                <Text className="mt-1 text-base font-bold text-foreground" selectable>
                  {orderNumbers.join("  ·  ")}
                </Text>
                <Text className="mt-2 text-sm text-muted-foreground">
                  Keep this to hand — it identifies your purchase if you need to get in touch.
                </Text>
              </View>
              <Button variant="outline" onPress={onDone}>
                <Text className="text-sm font-medium text-foreground">Keep shopping</Text>
              </Button>
              <Link href="/guest-orders/recover" asChild>
                <Button variant="outline">
                  <Text className="text-sm font-medium text-foreground">
                    Email me a link to this order
                  </Text>
                </Button>
              </Link>
            </>
          ) : (
            <Button onPress={onDone}>
              <Text className="text-sm font-semibold text-primary-foreground">View your order</Text>
            </Button>
          )}
        </View>
      </View>
    );
  }

  if (status === "canceled") {
    return (
      <View className="px-4" accessibilityLiveRegion="polite">
        <SectionHeader title="Payment cancelled" />
        <View className="gap-4">
          <Text className="text-sm text-muted-foreground">
            This payment was cancelled and nothing was charged. Your items have been returned to
            the shop.
          </Text>
          <Button variant="outline" onPress={onDone}>
            <Text className="text-sm font-medium text-foreground">
              {isGuest ? "Keep shopping" : "Back to your orders"}
            </Text>
          </Button>
        </View>
      </View>
    );
  }

  if (awaiting) {
    return (
      <View className="px-4" accessibilityLiveRegion="polite">
        <SectionHeader title="Confirming your payment" />
        <View className="gap-4">
          <Text className="text-sm text-muted-foreground">
            {status === "requires_action" || status === "processing"
              ? "Your bank is still completing this payment. This can take a moment."
              : "We are confirming this with your bank. Your order is reserved meanwhile."}
          </Text>
          <Button variant="outline" onPress={onDone}>
            <Text className="text-sm font-medium text-foreground">
              {isGuest ? "Keep shopping" : "Check later from your orders"}
            </Text>
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View className="px-4">
      <SectionHeader title="Payment" />
      <View className="gap-4">
        <View className="flex-row items-baseline justify-between">
          <Text className="text-sm text-muted-foreground">Total to pay</Text>
          {/*
            `formatMoney` and NOT `PriceDisplay`: this figure is what the card
            will actually be charged, in the currency the payment was created in.
            `PriceDisplay` converts into whatever the shopper is browsing in,
            which is right for a catalogue price and wrong here — a buyer must
            see the amount their bank will show them (issue #47, client 4).
          */}
          <Text className="text-lg font-bold text-foreground">{formatMoney(payment.amount)}</Text>
        </View>
        {error ? (
          <View
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
            className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4"
          >
            <Text className="text-sm text-foreground">{error}</Text>
          </View>
        ) : null}
        <CardPaymentStep
          payment={payment}
          onCompleted={onCompleted}
          onCancelled={onCancelled}
          onFailed={onFailed}
        />
        <Text className="text-xs text-muted-foreground">
          Your card details go straight to our payment provider and never reach Mercaria.
        </Text>
      </View>
      <View className="h-24" />
    </View>
  );
}

function CheckoutBody() {
  const router = useRouter();
  const { seller } = useLocalSearchParams<{ seller?: string }>();
  const { isAuthenticated } = useOxy();
  const { data: cart, isLoading: cartLoading } = useCart();
  // Saved addresses are an ACCOUNT feature, and `useAddresses` is already
  // gated on `isAuthenticated` internally — a signed-out checkout issues no
  // request that would 401, and renders no saved-address list to select from
  // (#105 frontend rule 6).
  const { data: addresses, isLoading: addressesLoading } = useAddresses();
  const checkout = useCheckout();

  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [usingInlineAddress, setUsingInlineAddress] = useState(false);
  const [discountCode, setDiscountCode] = useState("");
  /**
   * The typed destination and contact.
   *
   * Lifted to the SCREEN, not held inside the form: a failed mutation re-renders
   * this component and does not unmount it, so every field survives an ordinary
   * validation error with no persistence anywhere (#105 frontend rule 9). It is
   * never written to a URL, to storage or to a log (rule 10) — it exists here
   * and in one request body.
   */
  const [draft, setDraft] = useState<CheckoutDestinationDraft>(EMPTY_CHECKOUT_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);
  // The placed group and its payment handoff, once the order exists. Holding
  // them here is what turns checkout into two steps without a second route:
  // orders are placed and reserved, and the buyer then pays for them.
  const [placed, setPlaced] = useState<{
    checkoutGroupId: string;
    firstOrderId: string | undefined;
    /** What a guest is handed instead of a link they cannot follow (#107). */
    orderNumbers: string[];
    payment: CheckoutPaymentHandoff;
  } | null>(null);
  const [sheetDone, setSheetDone] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);

  /**
   * ONE `Idempotency-Key` per "place order" press, stable across retries.
   *
   * Minted lazily and kept until a checkout completes: TanStack retries the
   * mutation on a network failure, and a key regenerated per attempt would let
   * a request that timed out AFTER the server placed the orders place them a
   * second time.
   */
  const idempotencyKey = useRef<string | null>(null);

  // Poll the SERVER for the outcome once the buyer has finished with the sheet.
  // The sheet's own result says what the buyer did; only a verified webhook
  // makes an order paid.
  const paymentStatus = useCheckoutPaymentStatus(placed?.checkoutGroupId, sheetDone);

  // Target groups: the sellers `?seller=` names, else the whole cart.
  const sellerKeys = useMemo(() => parseSellerKeys(seller), [seller]);
  const targetGroups = useMemo<CartGroup[]>(() => {
    const groups = cart?.groups ?? [];
    if (sellerKeys.length === 0) return groups;
    return groups.filter((g) => sellerKeys.includes(groupKey(g)));
  }, [cart, sellerKeys]);

  const savedAddresses = isAuthenticated ? (addresses ?? []) : [];
  const defaultAddressId = savedAddresses.find((a) => a.isDefault)?.id ?? savedAddresses[0]?.id;
  const effectiveAddressId = selectedAddressId ?? defaultAddressId;
  // A saved address is used when the buyer HAS one and has not chosen to type a
  // different one. Everyone else — every guest, and any signed-in buyer with an
  // empty address book — types one inline, through the same form.
  const usingSavedAddress =
    isAuthenticated && !usingInlineAddress && effectiveAddressId !== undefined;

  if (cartLoading && !cart) {
    return (
      <View className="px-4 py-16">
        <View className="mb-4 h-40 w-full rounded-3xl bg-muted" />
        <View className="h-40 w-full rounded-3xl bg-muted" />
      </View>
    );
  }

  if (isAuthenticated && addressesLoading && !addresses) {
    return (
      <View className="px-4 py-16">
        <View className="mb-4 h-40 w-full rounded-3xl bg-muted" />
        <View className="h-40 w-full rounded-3xl bg-muted" />
      </View>
    );
  }

  if (targetGroups.length === 0) {
    return (
      <View className="items-center px-8 py-24">
        <Text className="text-center text-lg font-bold text-foreground">Nothing to check out</Text>
        <Text className="mt-1 text-center text-sm text-muted-foreground">
          Your cart is empty or these items are no longer available.
        </Text>
        <Button variant="outline" className="mt-4" onPress={() => router.replace("/cart")}>
          <Text className="text-sm font-medium text-foreground">Back to cart</Text>
        </Button>
      </View>
    );
  }

  /**
   * Where a buyer goes when they leave this screen.
   *
   * `/orders` is ACCOUNT-authenticated, so a guest is sent to the storefront
   * instead: routing them to a page that would answer 401 is the "route to the
   * secure guest order experience rather than an authenticated-only order
   * route" rule failing closed while #108 builds the portal that replaces this.
   */
  const leaveCheckout = (orderId: string | undefined) => {
    if (!isAuthenticated) {
      router.replace("/" as Parameters<typeof router.replace>[0]);
      return;
    }
    router.replace(
      (orderId ? `/orders/${orderId}` : "/orders") as Parameters<typeof router.replace>[0],
    );
  };

  /** The destination this press will send, or `null` when it is incomplete. */
  const buildDestination = (): CheckoutDestination | null => {
    if (usingSavedAddress && effectiveAddressId) {
      return { type: "saved_address", addressId: effectiveAddressId };
    }
    if (!isDraftComplete(draft)) return null;
    return {
      type: "inline_shipping_address",
      address: cleanAddress(draft.address),
      // Opt-IN, and only ever true for a signed-in buyer — the form does not
      // render the control for anyone else.
      ...(isAuthenticated && draft.saveToAddressBook ? { saveToAddressBook: true } : {}),
    };
  };

  const onPlaceOrder = () => {
    const destination = buildDestination();
    if (!destination) {
      setFormError("Fill in your email and delivery address to continue.");
      return;
    }
    // A guest MUST supply contact; a signed-in buyer may, and it is sent when
    // they filled it in. The server re-checks both — this only avoids a round
    // trip for a form the buyer can see is incomplete.
    const contact = cleanContact(draft.contact);
    if (!isAuthenticated && contact.email.length === 0) {
      setFormError("Enter the email address your receipt should go to.");
      return;
    }
    setFormError(null);
    idempotencyKey.current ??= nanoid();
    checkout.mutate(
      {
        idempotencyKey: idempotencyKey.current,
        destination,
        ...(contact.email.length > 0 ? { contact } : {}),
        ...(draft.marketingOptIn ? { marketingOptIn: true } : {}),
        // The currency the buyer has been reading prices in, echoed back so a
        // GUEST is charged in it (#107). It leaves as a QUERY parameter, not a
        // body field — see `postCheckout` — and is ignored server-side for a
        // signed-in buyer, whose stored preference stays the one authority,
        // which is why it is sent unconditionally rather than behind an
        // `isAuthenticated` branch this screen would have to keep in step with.
        ...(cart?.currency ? { currency: cart.currency } : {}),
        ...(sellerKeys.length > 0 ? { sellerKeys } : {}),
        ...(discountCode.trim() ? { discountCodes: [discountCode.trim()] } : {}),
      },
      {
        onSuccess: (result) => {
          const first = result.orders[0];
          // No payment to make — this deployment has no card rail, or the dev
          // seam funds the group elsewhere. Behaviour is exactly what it was
          // before payments existed.
          if (!result.payment) {
            idempotencyKey.current = null;
            toast.success("Order placed");
            leaveCheckout(first?.id);
            return;
          }
          setPaymentError(null);
          setSheetDone(false);
          setPlaced({
            checkoutGroupId: result.checkoutGroupId,
            firstOrderId: first?.id,
            orderNumbers: result.orders.map((order) => order.orderNumber),
            payment: result.payment,
          });
        },
        // The server's message names a FIELD or a SELLER and never a value, so
        // it is safe to show and is more useful than a generic sentence.
        onError: (error) => setFormError(error.message),
      },
    );
  };

  // The payment step replaces the form once the orders exist: the address and
  // the contact are already snapshotted onto them, and editing either would
  // change nothing. This is also why no draft has to survive a bank redirect —
  // by then there is no draft left to lose.
  if (placed) {
    return (
      <PaymentStep
        payment={placed.payment}
        status={paymentStatus.data?.status}
        awaiting={sheetDone}
        error={paymentError}
        isGuest={!isAuthenticated}
        orderNumbers={placed.orderNumbers}
        onCompleted={() => {
          // The buyer finished the sheet. Nothing is marked paid here — the
          // poll above asks the server, which answers from a verified event.
          idempotencyKey.current = null;
          setSheetDone(true);
        }}
        onCancelled={() => {
          setPlaced(null);
          setSheetDone(false);
          toast.info(
            isAuthenticated
              ? "Your order is reserved. You can pay for it from your orders."
              : "Your order is reserved for a short while. Check out again to pay for it.",
          );
          leaveCheckout(placed.firstOrderId);
        }}
        onFailed={(message) => {
          setSheetDone(false);
          setPaymentError(message);
        }}
        onDone={() => {
          setPlaced(null);
          leaveCheckout(placed.firstOrderId);
        }}
      />
    );
  }

  return (
    <View className="px-4">
      <SectionHeader title="Checkout" />
      <View className="gap-5">
        {/*
          Signing in is offered ONCE, at the top, as an alternative to a path
          that is already open — never as a gate in front of it (#105 frontend
          rules 1-2). A guest reaches the form below by scrolling, not by
          dismissing anything.
        */}
        {isAuthenticated ? null : <SignInBenefit />}

        {/* Saved addresses: an account feature, rendered only for an account. */}
        {isAuthenticated && savedAddresses.length > 0 ? (
          <View className="gap-3">
            <Text className="text-sm font-semibold text-foreground">Shipping address</Text>
            {usingInlineAddress ? null : (
              <>
                {savedAddresses.map((address) => (
                  <AddressOption
                    key={address.id}
                    address={address}
                    selected={address.id === effectiveAddressId}
                    onSelect={() => setSelectedAddressId(address.id)}
                  />
                ))}
              </>
            )}
            <Button
              variant="outline"
              className="self-start"
              onPress={() => setUsingInlineAddress(!usingInlineAddress)}
            >
              <Plus size={16} className="text-foreground" />
              <Text className="ml-1 text-sm font-medium text-foreground">
                {usingInlineAddress ? "Use a saved address" : "Deliver somewhere else"}
              </Text>
            </Button>
          </View>
        ) : null}

        {/*
          ONE inline form for both actor kinds. A signed-in buyer sees it when
          they have no saved address or chose to type a different one; a guest
          always sees it. There is no guest-only variant to drift.
        */}
        {usingSavedAddress ? null : (
          <View className="gap-3">
            <Text className="text-sm font-semibold text-foreground">
              {isAuthenticated ? "Deliver to" : "Continue as guest"}
            </Text>
            {isAuthenticated ? null : (
              <Text className="text-sm text-muted-foreground">
                No account needed. Tell us where it goes and how to reach you about this order.
              </Text>
            )}
            <View className="rounded-2xl border border-border bg-card p-4">
              <CheckoutDestinationForm
                draft={draft}
                onChange={setDraft}
                canSaveToAddressBook={isAuthenticated}
              />
            </View>
          </View>
        )}

        {/* Discount code (optional) */}
        <View className="gap-1.5">
          <Label nativeID="checkout-discount">Discount code (optional)</Label>
          <Input
            aria-labelledby="checkout-discount"
            accessibilityLabel="Discount code"
            value={discountCode}
            onChangeText={setDiscountCode}
            placeholder="SAVE10"
            autoCapitalize="characters"
            autoCorrect={false}
          />
        </View>

        <OrderSummaryCard groups={targetGroups} />

        {formError ? (
          <View
            accessibilityRole="alert"
            className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4"
          >
            <Text className="text-sm text-foreground">{formError}</Text>
          </View>
        ) : null}

        <Button isLoading={checkout.isPending} onPress={onPlaceOrder}>
          <Text className="text-sm font-semibold text-primary-foreground">Place order</Text>
        </Button>
      </View>
      <View className="h-24" />
    </View>
  );
}

export default function CheckoutScreen() {
  return (
    <ScreenShell contentClassName="pt-5 web:max-w-[900px]">
      <Head>
        <title>Checkout — Mercaria</title>
      </Head>
      <CheckoutBody />
    </ScreenShell>
  );
}
