import { useMemo, useState } from "react";
import { View, Pressable } from "react-native";
import Head from "expo-router/head";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useOxy } from "@oxyhq/services";
import { Check, Plus } from "lucide-react-native";
import type { Address, CartGroup, CreateAddressInput, Money } from "@mercaria/shared-types";
import { Button, Input, Label, PriceDisplay, SectionHeader, Text } from "@mercaria/ui";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { AddressForm } from "@/components/address/AddressForm";
import { toast } from "@/components/sonner";
import { useCart } from "@/lib/hooks/use-cart";
import { useAddresses, useCreateAddress } from "@/lib/hooks/use-addresses";
import { useCheckout } from "@/lib/hooks/use-checkout";

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
    return (
      <View className="items-center px-8 py-24">
        <Text className="text-center text-lg font-bold text-foreground">Sign in to check out</Text>
        <Text className="mt-1 text-center text-sm text-muted-foreground">
          You need an account to place an order.
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

  const onPlaceOrder = () => {
    if (!effectiveAddressId) {
      toast.error("Add a shipping address first");
      return;
    }
    checkout.mutate(
      {
        addressId: effectiveAddressId,
        ...(seller ? { sellerKeys: [seller] } : {}),
        ...(discountCode.trim() ? { discountCodes: [discountCode.trim()] } : {}),
      },
      {
        onSuccess: (result) => {
          toast.success("Order placed");
          const first = result.orders[0];
          router.replace(
            (first ? `/orders/${first.id}` : "/orders") as Parameters<typeof router.replace>[0],
          );
        },
        onError: () => toast.error("Couldn't place your order"),
      },
    );
  };

  const needsAddress = list.length === 0 || addingAddress;

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
