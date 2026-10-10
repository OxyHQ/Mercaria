import React, { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { nanoid } from "nanoid/non-secure";
import type { MerchantOrder } from "@mercaria/shared-types";
import { Dialog } from "@oxy.so/bloom/dialog";
import { Button } from "@oxy.so/bloom/button";
import { Field } from "@oxy.so/bloom/field";
import { TextFieldInput } from "@oxy.so/bloom/text-field";
import { Loading } from "@oxy.so/bloom/loading";
import { Text } from "@mercaria/ui";
import { useCreateRefund, useOrderRefunds } from "@/lib/hooks/use-orders";
import { useActiveStoreContext } from "@/lib/hooks/use-stores";
import { useTranslation } from "@/lib/i18n";
import { remainingRefundQuantities, parseRefundQuantity } from "@/lib/refund-quantities";

export function RefundDialog({ storeId, order, open, onClose }: {
  storeId: string; order: MerchantOrder; open: boolean; onClose: () => void;
}) {
  const { t } = useTranslation();
  const { can } = useActiveStoreContext();
  const refunds = useOrderRefunds(storeId, order.id, open);
  const mutation = useCreateRefund(storeId, order.id);
  const [checked, setChecked] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const attempt = useRef<{ payload: string; key: string } | undefined>(undefined);
  const { refetch } = refunds;
  useEffect(() => {
    let current = true;
    setChecked(false);
    if (open) void refetch().then(() => { if (current) setChecked(true); });
    return () => { current = false; };
  }, [open, refetch]);
  const remaining = refunds.data ? remainingRefundQuantities(order.items, refunds.data) : undefined;
  const ready = checked && refunds.isSuccess && !refunds.isFetching;
  const hasPermission = can("refunds:write");
  const eligible = order.payment?.status === "paid" && order.status !== "refunded";
  const parsed = order.items.map(item => ({ variantId: item.variantId, quantity: parseRefundQuantity(quantities[item.variantId] ?? "", Number.MAX_SAFE_INTEGER) }));
  const malformed = parsed.some(line => line.quantity === null);
  const lineItems = parsed.flatMap(line => line.quantity !== null && line.quantity > 0 ? [{ variantId: line.variantId, quantity: line.quantity }] : []);
  const body = { lineItems, ...(reason.trim() ? { reason: reason.trim() } : {}) };
  const payload = JSON.stringify(body);
  // A lost response may already have consumed these units. The server replays
  // this exact key before checking current eligibility/remaining quantities.
  // An edited payload must pass today's limits and receive a new key instead.
  const replay = mutation.isError && !malformed && attempt.current?.payload === payload;
  const exceedsRemaining = parsed.some(line => line.quantity !== null && line.quantity > (remaining?.get(line.variantId) ?? 0));
  const invalid = malformed || (!replay && exceedsRemaining);
  const hasSelection = lineItems.length > 0;
  const canSubmit = hasPermission && (replay || (ready && eligible));
  const submit = () => {
    setSubmitted(true);
    if (!canSubmit || mutation.isPending || invalid || !hasSelection) return;
    if (attempt.current?.payload !== payload) attempt.current = { payload, key: nanoid() };
    mutation.mutate({ ...body, idempotencyKey: attempt.current.key }, { onSuccess: () => {
      onClose(); setQuantities({}); setReason(""); setSubmitted(false); attempt.current = undefined;
    } });
  };
  return <Dialog open={open} onClose={() => { if (!mutation.isPending) onClose(); }} title={t("orders.refund.dialogTitle")} dismissOnBackdrop={!mutation.isPending}>
    <View testID="merchant-refund-form" className="gap-3">
      <View className="min-h-7" accessibilityLiveRegion="polite">
        {!ready && !refunds.isError ? <Loading variant="inline" size="sm" accessibilityLabel={t("common.loading")} /> : null}
        {refunds.isError ? <View className="gap-2"><Text className="text-sm text-destructive">{t("orders.refund.loadFailed")}</Text>
          <Button size="sm" appearance="outline" material="flat" disabled={refunds.isFetching} onPress={() => { void refetch(); }}>{t("common.retry")}</Button></View> : null}
      </View>
      {order.items.map((item, index) => {
        const available = remaining?.get(item.variantId);
        return <View key={item.variantId} className="gap-1 rounded-xl border border-border p-3">
          <View className="flex-row items-center gap-3">
            <View className="min-w-0 flex-1"><Text className="text-sm font-medium text-foreground">{item.title}</Text>
              {available !== undefined ? <Text className="text-xs text-muted-foreground">{t("orders.refund.itemMax", { variant: item.variantTitle, quantity: available })}</Text> : null}
            </View>
            <View className="w-20"><TextFieldInput label={t("orders.refund.quantityLabel", { item: item.title })}
              value={quantities[item.variantId] ?? ""} onValueChange={value => setQuantities(previous => ({ ...previous, [item.variantId]: value }))}
              keyboardType="number-pad" placeholder="0" disabled={!hasPermission || !ready || !eligible || mutation.isPending || available === 0} />
            </View>
          </View>
          {ready && !replay && (parsed[index].quantity === null || parsed[index].quantity! > (available ?? 0)) ? <Text className="text-sm text-destructive">{t("orders.refund.quantityInvalid", { quantity: available })}</Text> : null}
        </View>;
      })}
      <Field label={t("orders.refund.reasonLabel")}><TextFieldInput label={t("orders.refund.reasonLabel")} value={reason} onValueChange={setReason}
        placeholder={t("orders.refund.reasonPlaceholder")} maxLength={2000} disabled={!hasPermission || !eligible || mutation.isPending} /></Field>
      <View className="min-h-5" accessibilityLiveRegion="polite">
        {!hasPermission || (!eligible && !replay) ? <Text className="text-sm text-muted-foreground">{t("orders.refund.unavailable")}</Text>
          : mutation.isError ? <Text className="text-sm text-destructive">{t("orders.refund.failed")}</Text>
            : submitted && !invalid && !hasSelection ? <Text className="text-sm text-destructive">{t("orders.refund.quantityRequired")}</Text> : null}
      </View>
      <Button appearance="outline" material="flat" disabled={mutation.isPending} onPress={onClose}>{t("common.cancel")}</Button>
      <Button tone="danger" onPress={submit} disabled={!canSubmit || invalid} loading={mutation.isPending}>{t("orders.refund.submit")}</Button>
    </View>
  </Dialog>;
}
