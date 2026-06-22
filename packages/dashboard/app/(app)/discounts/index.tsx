import React, { useState } from "react";
import { View, Pressable } from "react-native";
import Head from "expo-router/head";
import { Plus, Tag, Trash2 } from "lucide-react-native";
import type {
  Discount,
  DiscountMethod,
  DiscountValueType,
  CreateDiscountInput,
} from "@mercaria/shared-types";
import {
  Text,
  Button,
  Input,
  Label,
  ToggleGroup,
  ToggleGroupItem,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useColorScheme,
} from "@mercaria/ui";
import { toast } from "@/components/sonner";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { StoreSwitcher } from "@/components/shell/StoreSwitcher";
import { RequireStore } from "@/components/shell/RequireStore";
import { useDiscounts, useCreateDiscount, useDeleteDiscount } from "@/lib/hooks/use-discounts";
import { toFairMinor } from "@/lib/money";

/** Basis-points per percent (100% = 10000 bps). */
const BPS_PER_PERCENT = 100;

export default function DiscountsScreen() {
  return (
    <>
      <Head>
        <title>Discounts | Mercaria Dashboard</title>
      </Head>
      <RequireStore permission="discounts:write">
        {(storeId) => <DiscountsBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function DiscountsBody({ storeId }: { storeId: string }) {
  const { colors } = useColorScheme();
  const { data, isPending, isError } = useDiscounts(storeId);
  const deleteDiscount = useDeleteDiscount(storeId);
  const [createOpen, setCreateOpen] = useState(false);

  const action = (
    <View className="flex-row items-center gap-2">
      <StoreSwitcher />
      <Button onPress={() => setCreateOpen(true)}>
        <View className="flex-row items-center gap-2">
          <Plus size={16} color={colors.primaryForeground} />
          <Text className="font-semibold text-primary-foreground">New</Text>
        </View>
      </Button>
    </View>
  );

  return (
    <Screen title="Discounts" subtitle="Codes and automatic promotions" action={action}>
      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage title="Couldn't load discounts" body="Please try again." />
      ) : (data?.length ?? 0) === 0 ? (
        <ScreenMessage title="No discounts yet" body="Create a code or automatic discount." />
      ) : (
        <View className="gap-2">
          {data?.map((discount) => (
            <DiscountRow
              key={discount.id}
              discount={discount}
              onDelete={() =>
                deleteDiscount.mutate(discount.id, {
                  onSuccess: () => toast.success("Discount deleted"),
                  onError: () => toast.error("Couldn't delete the discount"),
                })
              }
            />
          ))}
        </View>
      )}

      <CreateDiscountDialog storeId={storeId} open={createOpen} onOpenChange={setCreateOpen} />
    </Screen>
  );
}

function describeValue(discount: Discount): string {
  if (discount.valueType === "percentage") {
    return `${discount.value / BPS_PER_PERCENT}% off`;
  }
  if (discount.valueType === "fixed_amount") {
    return "Fixed amount off";
  }
  return discount.valueType;
}

function DiscountRow({ discount, onDelete }: { discount: Discount; onDelete: () => void }) {
  const { colors } = useColorScheme();
  return (
    <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-3">
      <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted">
        <Tag size={18} color={colors.mutedForeground} />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-semibold text-foreground">{discount.title}</Text>
        <Text className="text-xs text-muted-foreground">
          {discount.method === "code"
            ? discount.codes.map((c) => c.code).join(", ") || "code"
            : "automatic"}{" "}
          · {describeValue(discount)} · {discount.isActive ? "active" : "inactive"}
        </Text>
      </View>
      <Pressable onPress={onDelete} className="p-2 active:opacity-70">
        <Trash2 size={16} color={colors.mutedForeground} />
      </Pressable>
    </View>
  );
}

function CreateDiscountDialog({
  storeId,
  open,
  onOpenChange,
}: {
  storeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createDiscount = useCreateDiscount(storeId);
  const [title, setTitle] = useState("");
  const [method, setMethod] = useState<DiscountMethod>("code");
  const [code, setCode] = useState("");
  const [valueType, setValueType] = useState<Extract<DiscountValueType, "percentage" | "fixed_amount">>(
    "percentage",
  );
  const [amount, setAmount] = useState("");

  const submit = () => {
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (method === "code" && !code.trim()) {
      toast.error("Enter a discount code");
      return;
    }

    let value: number;
    if (valueType === "percentage") {
      const pct = Number(amount);
      if (!Number.isFinite(pct) || pct <= 0) {
        toast.error("Enter a valid percentage");
        return;
      }
      value = Math.round(pct * BPS_PER_PERCENT);
    } else {
      const minor = toFairMinor(amount);
      if (minor === null || minor <= 0) {
        toast.error("Enter a valid amount");
        return;
      }
      value = minor;
    }

    const input: CreateDiscountInput = {
      title: title.trim(),
      method,
      ...(method === "code" ? { codes: [code.trim()] } : {}),
      valueType,
      value,
      appliesTo: { scope: "order" },
      isActive: true,
    };

    createDiscount.mutate(input, {
      onSuccess: () => {
        toast.success("Discount created");
        setTitle("");
        setCode("");
        setAmount("");
        onOpenChange(false);
      },
      onError: () => toast.error("Couldn't create the discount"),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New discount</DialogTitle>
        </DialogHeader>
        <View className="gap-4">
          <View className="gap-1.5">
            <Label>Title</Label>
            <Input value={title} onChangeText={setTitle} placeholder="Spring sale" />
          </View>
          <View className="gap-1.5">
            <Label>Method</Label>
            <ToggleGroup
              type="single"
              value={method}
              onValueChange={(v) => typeof v === "string" && v && setMethod(v as DiscountMethod)}
            >
              <ToggleGroupItem value="code">
                <Text className="text-sm text-foreground">Code</Text>
              </ToggleGroupItem>
              <ToggleGroupItem value="automatic">
                <Text className="text-sm text-foreground">Automatic</Text>
              </ToggleGroupItem>
            </ToggleGroup>
          </View>
          {method === "code" ? (
            <View className="gap-1.5">
              <Label>Code</Label>
              <Input value={code} onChangeText={setCode} placeholder="SPRING20" autoCapitalize="characters" />
            </View>
          ) : null}
          <View className="gap-1.5">
            <Label>Value type</Label>
            <ToggleGroup
              type="single"
              value={valueType}
              onValueChange={(v) =>
                typeof v === "string" && v && setValueType(v as "percentage" | "fixed_amount")
              }
            >
              <ToggleGroupItem value="percentage">
                <Text className="text-sm text-foreground">Percentage</Text>
              </ToggleGroupItem>
              <ToggleGroupItem value="fixed_amount">
                <Text className="text-sm text-foreground">Fixed (⊜)</Text>
              </ToggleGroupItem>
            </ToggleGroup>
          </View>
          <View className="gap-1.5">
            <Label>{valueType === "percentage" ? "Percent off" : "Amount off (⊜)"}</Label>
            <Input value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder={valueType === "percentage" ? "20" : "10.00"} />
          </View>
          <Button onPress={submit} isLoading={createDiscount.isPending} className="mt-1">
            <Text className="font-semibold text-primary-foreground">Create</Text>
          </Button>
        </View>
      </DialogContent>
    </Dialog>
  );
}
