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
  useColorScheme,
  type Translate,
  toBloomIcon,
} from "@mercaria/ui";
import { Field } from "@oxy.so/bloom/field";
import { TextFieldInput } from "@oxy.so/bloom/text-field";
import { Button } from "@oxy.so/bloom/button";
import { Dialog, useDialogControl, type DialogControlProps } from "@oxy.so/bloom/dialog";
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from "@oxy.so/bloom/segmented-control";
import { toast } from "@oxy.so/bloom/toast";
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
  const { t } = useTranslation();
  const { data, isPending, isError } = useDiscounts(storeId);
  const deleteDiscount = useDeleteDiscount(storeId);
  const createControl = useDialogControl();

  const action = (
    <View className="flex-row items-center gap-2">
      <StoreSwitcher />
      <Button
        tone="accent"
        leadingIcon={toBloomIcon(Plus)}
        onPress={() => createControl.open()}
      >
        {t("common.new")}
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

      <CreateDiscountDialog storeId={storeId} control={createControl} />
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
  control,
}: {
  storeId: string;
  control: DialogControlProps;
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
        control.close();
      },
      onError: () => toast.error(t("discounts.create.error")),
    });
  };

  const amountLabel =
    valueType === "percentage"
      ? t("discounts.create.percentOffLabel")
      : t("discounts.create.amountOffLabel");

  return (
    <Dialog control={control} title={t("discounts.create.dialogTitle")}>
      <View className="gap-4">
        <Field label={t("common.title")}>
          <TextFieldInput
            label={t("common.title")}
            value={title}
            onValueChange={setTitle}
            placeholder={t("discounts.create.titlePlaceholder")}
          />
        </Field>
        <Field label={t("discounts.create.methodLabel")}>
          <SegmentedControl
            type="radio"
            value={method}
            onValueChange={setMethod}
          >
            <SegmentedControlItem value="code">
              <SegmentedControlItemText>{t("discounts.create.methodCode")}</SegmentedControlItemText>
            </SegmentedControlItem>
            <SegmentedControlItem value="automatic">
              <SegmentedControlItemText>
                {t("discounts.create.methodAutomatic")}
              </SegmentedControlItemText>
            </SegmentedControlItem>
          </SegmentedControl>
        </Field>
        {method === "code" ? (
          <Field label={t("discounts.create.codeLabel")}>
            <TextFieldInput
              label={t("discounts.create.codeLabel")}
              value={code}
              onValueChange={setCode}
              placeholder={t("discounts.create.codePlaceholder")}
              autoCapitalize="characters"
            />
          </Field>
        ) : null}
        <Field label={t("discounts.create.valueTypeLabel")}>
          <SegmentedControl
            type="radio"
            value={valueType}
            onValueChange={setValueType}
          >
            <SegmentedControlItem value="percentage">
              <SegmentedControlItemText>
                {t("discounts.create.valueTypePercentage")}
              </SegmentedControlItemText>
            </SegmentedControlItem>
            <SegmentedControlItem value="fixed_amount">
              <SegmentedControlItemText>{t("discounts.create.valueTypeFixed")}</SegmentedControlItemText>
            </SegmentedControlItem>
          </SegmentedControl>
        </Field>
        <Field label={amountLabel}>
          <TextFieldInput
            label={amountLabel}
            value={amount}
            onValueChange={setAmount}
            keyboardType="decimal-pad"
            placeholder={valueType === "percentage" ? "20" : "10.00"}
          />
        </Field>
        <Button tone="accent" onPress={submit} loading={createDiscount.isPending} className="mt-1">
          {t("common.create")}
        </Button>
      </View>
    </Dialog>
  );
}
