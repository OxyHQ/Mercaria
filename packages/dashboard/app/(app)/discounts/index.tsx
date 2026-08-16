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
  type Translate,
} from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
import { Screen, ScreenLoading, ScreenMessage } from "@/components/shell/Screen";
import { StoreSwitcher } from "@/components/shell/StoreSwitcher";
import { RequireStore } from "@/components/shell/RequireStore";
import { useDiscounts, useCreateDiscount, useDeleteDiscount } from "@/lib/hooks/use-discounts";
import { useTranslation } from "@/lib/i18n";
import { toFairMinor } from "@/lib/money";

/** Basis-points per percent (100% = 10000 bps). */
const BPS_PER_PERCENT = 100;

export default function DiscountsScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("discounts.documentTitle")}</title>
      </Head>
      <RequireStore permission="discounts:write">
        {(storeId) => <DiscountsBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

function DiscountsBody({ storeId }: { storeId: string }) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const { data, isPending, isError } = useDiscounts(storeId);
  const deleteDiscount = useDeleteDiscount(storeId);
  const [createOpen, setCreateOpen] = useState(false);

  const action = (
    <View className="flex-row items-center gap-2">
      <StoreSwitcher />
      <Button onPress={() => setCreateOpen(true)}>
        <View className="flex-row items-center gap-2">
          <Plus size={16} color={colors.primaryForeground} />
          <Text className="font-semibold text-primary-foreground">{t("common.new")}</Text>
        </View>
      </Button>
    </View>
  );

  return (
    <Screen title={t("nav.discounts")} subtitle={t("discounts.subtitle")} action={action}>
      {isPending ? (
        <ScreenLoading />
      ) : isError ? (
        <ScreenMessage title={t("discounts.loadError")} body={t("common.pleaseTryAgain")} />
      ) : (data?.length ?? 0) === 0 ? (
        <ScreenMessage title={t("discounts.empty.title")} body={t("discounts.empty.body")} />
      ) : (
        <View className="gap-2">
          {data?.map((discount) => (
            <DiscountRow
              key={discount.id}
              discount={discount}
              onDelete={() =>
                deleteDiscount.mutate(discount.id, {
                  onSuccess: () => toast.success(t("discounts.deleted")),
                  onError: () => toast.error(t("discounts.deleteError")),
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

/**
 * `t` is a parameter rather than a hook call: this is a plain helper, not a
 * component, so it cannot hold one. Its caller passes the same `t` it renders
 * with, which is what makes this line re-derive when the locale changes.
 *
 * The final branch returns the raw `valueType` — an unmapped identifier for a
 * value set this dialog cannot create (e.g. `buy_x_get_y`), left exactly as it
 * was rather than given copy nobody has written.
 */
function describeValue(discount: Discount, t: Translate): string {
  if (discount.valueType === "percentage") {
    return t("discounts.percentOff", { percent: discount.value / BPS_PER_PERCENT });
  }
  if (discount.valueType === "fixed_amount") {
    return t("discounts.fixedAmountOff");
  }
  return discount.valueType;
}

function DiscountRow({ discount, onDelete }: { discount: Discount; onDelete: () => void }) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  // Three independently-translated facts joined by one key, so a locale can
  // reorder them. `method`/`value`/`state`, never `count` — i18n-js pluralizes
  // any key called with a `count` option.
  const methodLabel =
    discount.method === "code"
      ? discount.codes.map((c) => c.code).join(", ") || t("discounts.methodCode")
      : t("discounts.methodAutomatic");
  const stateLabel = t(discount.isActive ? "discounts.state.active" : "discounts.state.inactive");
  return (
    <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-3">
      <View className="h-10 w-10 items-center justify-center rounded-xl bg-muted">
        <Tag size={18} color={colors.mutedForeground} />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-semibold text-foreground">{discount.title}</Text>
        <Text className="text-xs text-muted-foreground">
          {t("discounts.rowMeta", {
            method: methodLabel,
            value: describeValue(discount, t),
            state: stateLabel,
          })}
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
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [method, setMethod] = useState<DiscountMethod>("code");
  const [code, setCode] = useState("");
  const [valueType, setValueType] = useState<Extract<DiscountValueType, "percentage" | "fixed_amount">>(
    "percentage",
  );
  const [amount, setAmount] = useState("");

  const submit = () => {
    if (!title.trim()) {
      toast.error(t("discounts.create.titleRequired"));
      return;
    }
    if (method === "code" && !code.trim()) {
      toast.error(t("discounts.create.codeRequired"));
      return;
    }

    let value: number;
    if (valueType === "percentage") {
      const pct = Number(amount);
      if (!Number.isFinite(pct) || pct <= 0) {
        toast.error(t("discounts.create.invalidPercentage"));
        return;
      }
      value = Math.round(pct * BPS_PER_PERCENT);
    } else {
      const minor = toFairMinor(amount);
      if (minor === null || minor <= 0) {
        toast.error(t("discounts.create.invalidAmount"));
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
        toast.success(t("discounts.create.success"));
        setTitle("");
        setCode("");
        setAmount("");
        onOpenChange(false);
      },
      onError: () => toast.error(t("discounts.create.error")),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("discounts.create.dialogTitle")}</DialogTitle>
        </DialogHeader>
        <View className="gap-4">
          <View className="gap-1.5">
            <Label>{t("common.title")}</Label>
            <Input
              value={title}
              onChangeText={setTitle}
              placeholder={t("discounts.create.titlePlaceholder")}
            />
          </View>
          <View className="gap-1.5">
            <Label>{t("discounts.create.methodLabel")}</Label>
            <ToggleGroup
              type="single"
              value={method}
              onValueChange={(v) => typeof v === "string" && v && setMethod(v as DiscountMethod)}
            >
              <ToggleGroupItem value="code">
                <Text className="text-sm text-foreground">
                  {t("discounts.create.methodCode")}
                </Text>
              </ToggleGroupItem>
              <ToggleGroupItem value="automatic">
                <Text className="text-sm text-foreground">
                  {t("discounts.create.methodAutomatic")}
                </Text>
              </ToggleGroupItem>
            </ToggleGroup>
          </View>
          {method === "code" ? (
            <View className="gap-1.5">
              <Label>{t("discounts.create.codeLabel")}</Label>
              <Input
                value={code}
                onChangeText={setCode}
                placeholder={t("discounts.create.codePlaceholder")}
                autoCapitalize="characters"
              />
            </View>
          ) : null}
          <View className="gap-1.5">
            <Label>{t("discounts.create.valueTypeLabel")}</Label>
            <ToggleGroup
              type="single"
              value={valueType}
              onValueChange={(v) =>
                typeof v === "string" && v && setValueType(v as "percentage" | "fixed_amount")
              }
            >
              <ToggleGroupItem value="percentage">
                <Text className="text-sm text-foreground">
                  {t("discounts.create.valueTypePercentage")}
                </Text>
              </ToggleGroupItem>
              <ToggleGroupItem value="fixed_amount">
                <Text className="text-sm text-foreground">
                  {t("discounts.create.valueTypeFixed")}
                </Text>
              </ToggleGroupItem>
            </ToggleGroup>
          </View>
          <View className="gap-1.5">
            <Label>
              {valueType === "percentage"
                ? t("discounts.create.percentOffLabel")
                : t("discounts.create.amountOffLabel")}
            </Label>
            <Input value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder={valueType === "percentage" ? "20" : "10.00"} />
          </View>
          <Button onPress={submit} isLoading={createDiscount.isPending} className="mt-1">
            <Text className="font-semibold text-primary-foreground">{t("common.create")}</Text>
          </Button>
        </View>
      </DialogContent>
    </Dialog>
  );
}
