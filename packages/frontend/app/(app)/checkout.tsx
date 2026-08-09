import { useMemo, useRef, useState } from "react";
import { View, Pressable } from "react-native";
import Head from "expo-router/head";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useOxy } from "@oxyhq/services";
import { Check, Plus } from "lucide-react-native";
import { nanoid } from "nanoid/non-secure";
import type {
  Address,
  CartGroup,
  CheckoutPaymentHandoff,
  CheckoutPaymentStatus,
  CreateAddressInput,
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
import { AddressForm } from "@/components/address/AddressForm";
import { toast } from "@oxyhq/bloom/toast";
import { useCart } from "@/lib/hooks/use-cart";
import { useAddresses, useCreateAddress } from "@/lib/hooks/use-addresses";
import { useCheckout, useCheckoutPaymentStatus } from "@/lib/hooks/use-checkout";
import { CardPaymentStep } from "@/components/payment/CardPaymentStep";

/** The stable seller-group key, matching the backend (`store:<id>` / `user:<id>`). */
function groupKey(group: CartGroup): string {
  return `${group.vendor.kind}:${group.vendor.id}`;
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
  onCompleted,
  onCancelled,
  onFailed,
  onDone,
}: {
  payment: CheckoutPaymentHandoff;
  status: CheckoutPaymentStatus["status"];
  awaiting: boolean;
  error: string | null;
  onCompleted: () => void;
  onCancelled: () => void;
  onFailed: (message: string) => void;
  onDone: () => void;
}) {
  if (status === "succeeded") {
    return (
      <View className="px-4">
        <SectionHeader title="Payment received" />
        <View className="gap-4">
          <Text className="text-sm text-muted-foreground">
            Thank you. Your order is confirmed and the seller has been notified.
          </Text>
          <Button onPress={onDone}>
            <Text className="text-sm font-semibold text-primary-foreground">View your order</Text>
          </Button>
        </View>
      </View>
    );
  }

  if (status === "canceled") {
    return (
      <View className="px-4">
        <SectionHeader title="Payment cancelled" />
        <View className="gap-4">
          <Text className="text-sm text-muted-foreground">
            This payment was cancelled and nothing was charged. Your items have been returned to
            the shop.
          </Text>
          <Button variant="outline" onPress={onDone}>
            <Text className="text-sm font-medium text-foreground">Back to your orders</Text>
          </Button>
        </View>
      </View>
    );
  }

  if (awaiting) {
    return (
      <View className="px-4">
        <SectionHeader title="Confirming your payment" />
        <View className="gap-4">
          <Text className="text-sm text-muted-foreground">
            {status === "requires_action" || status === "processing"
              ? "Your bank is still completing this payment. This can take a moment."
              : "We are confirming this with your bank. Your order is reserved meanwhile."}
          </Text>
          <Button variant="outline" onPress={onDone}>
            <Text className="text-sm font-medium text-foreground">Check later from your orders</Text>
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
          <View className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4">
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
  const { data: addresses, isLoading: addressesLoading } = useAddresses();
  const createAddress = useCreateAddress();
  const checkout = useCheckout();

  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [addingAddress, setAddingAddress] = useState(false);
  const [discountCode, setDiscountCode] = useState("");
  // The placed group and its payment handoff, once the order exists. Holding
  // them here is what turns checkout into two steps without a second route:
  // orders are placed and reserved, and the buyer then pays for them.
  const [placed, setPlaced] = useState<{
    checkoutGroupId: string;
    firstOrderId: string | undefined;
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

  // Target groups: a single seller when `?seller=` is present, else the whole cart.
  const targetGroups = useMemo<CartGroup[]>(() => {
    const groups = cart?.groups ?? [];
    if (!seller) return groups;
    return groups.filter((g) => groupKey(g) === seller);
  }, [cart, seller]);

  // Effective address: the explicit selection, else the default, else the first.
  const list = addresses ?? [];
  const defaultAddressId = list.find((a) => a.isDefault)?.id ?? list[0]?.id;
  const effectiveAddressId = selectedAddressId ?? defaultAddressId;

  if (!isAuthenticated) {
    // Guest CHECKOUT is #105–#107; #104 stops at the cart. The copy says so
    // plainly and, crucially, tells the buyer their cart survives — because it
    // does: signing in merges it into the account's cart, exactly once.
    return (
      <View className="items-center px-8 py-24">
        <Text className="text-center text-lg font-bold text-foreground">Sign in to check out</Text>
        <Text className="mt-1 text-center text-sm text-muted-foreground">
          Placing an order needs an account for now. Your cart is saved — sign in and it comes
          with you.
        </Text>
      </View>
    );
  }

  if ((cartLoading && !cart) || (addressesLoading && !addresses)) {
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

  const onCreateAddress = (input: CreateAddressInput) => {
    createAddress.mutate(input, {
      onSuccess: (created) => {
        setSelectedAddressId(created.id);
        setAddingAddress(false);
        toast.success("Address saved");
      },
      onError: () => toast.error("Couldn't save the address"),
    });
  };

  const goToOrder = (orderId: string | undefined) =>
    router.replace(
      (orderId ? `/orders/${orderId}` : "/orders") as Parameters<typeof router.replace>[0],
    );

  const onPlaceOrder = () => {
    if (!effectiveAddressId) {
      toast.error("Add a shipping address first");
      return;
    }
    idempotencyKey.current ??= nanoid();
    checkout.mutate(
      {
        idempotencyKey: idempotencyKey.current,
        addressId: effectiveAddressId,
        ...(seller ? { sellerKeys: [seller] } : {}),
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
            goToOrder(first?.id);
            return;
          }
          setPaymentError(null);
          setSheetDone(false);
          setPlaced({
            checkoutGroupId: result.checkoutGroupId,
            firstOrderId: first?.id,
            payment: result.payment,
          });
        },
        onError: () => toast.error("Couldn't place your order"),
      },
    );
  };

  const needsAddress = list.length === 0 || addingAddress;

  // The payment step replaces the form once the orders exist: the address and
  // the discount are already snapshotted onto them and editing either would
  // change nothing.
  if (placed) {
    return (
      <PaymentStep
        payment={placed.payment}
        status={paymentStatus.data?.status}
        awaiting={sheetDone}
        error={paymentError}
        onCompleted={() => {
          // The buyer finished the sheet. Nothing is marked paid here — the
          // poll above asks the server, which answers from a verified event.
          idempotencyKey.current = null;
          setSheetDone(true);
        }}
        onCancelled={() => {
          setPlaced(null);
          setSheetDone(false);
          toast.info("Your order is reserved. You can pay for it from your orders.");
          goToOrder(placed.firstOrderId);
        }}
        onFailed={(message) => {
          setSheetDone(false);
          setPaymentError(message);
        }}
        onDone={() => {
          setPlaced(null);
          goToOrder(placed.firstOrderId);
        }}
      />
    );
  }

  return (
    <View className="px-4">
      <SectionHeader title="Checkout" />
      <View className="gap-5">
        {/* Shipping address */}
        <View className="gap-3">
          <Text className="text-sm font-semibold text-foreground">Shipping address</Text>
          {needsAddress ? (
            <View className="rounded-2xl border border-border bg-card p-4">
              <AddressForm
                onSubmit={onCreateAddress}
                onCancel={list.length > 0 ? () => setAddingAddress(false) : undefined}
                isSubmitting={createAddress.isPending}
                submitLabel="Use this address"
              />
            </View>
          ) : (
            <>
              {list.map((address) => (
                <AddressOption
                  key={address.id}
                  address={address}
                  selected={address.id === effectiveAddressId}
                  onSelect={() => setSelectedAddressId(address.id)}
                />
              ))}
              <Button variant="outline" className="self-start" onPress={() => setAddingAddress(true)}>
                <Plus size={16} className="text-foreground" />
                <Text className="ml-1 text-sm font-medium text-foreground">Add a new address</Text>
              </Button>
            </>
          )}
        </View>

        {/* Discount code (optional) */}
        <View className="gap-1.5">
          <Label>Discount code (optional)</Label>
          <Input
            value={discountCode}
            onChangeText={setDiscountCode}
            placeholder="SAVE10"
            autoCapitalize="characters"
          />
        </View>

        <OrderSummaryCard groups={targetGroups} />

        <Button
          disabled={!effectiveAddressId}
          isLoading={checkout.isPending}
          onPress={onPlaceOrder}
        >
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
