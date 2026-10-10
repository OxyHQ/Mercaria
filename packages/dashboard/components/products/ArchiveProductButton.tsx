import React, { useState } from "react";
import { View } from "react-native";
import { Button } from "@oxy.so/bloom/button";
import { Dialog } from "@oxy.so/bloom/dialog";
import { Text } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";

/** The dialog keeps the editor mounted and inaccessible during its archive. */
export function ArchiveProductButton({ title, disabled, pending, failed, onOpen, onConfirm }: {
  title: string; disabled: boolean; pending: boolean; failed: boolean;
  onOpen: () => void; onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return <>
    <Button tone="danger" disabled={disabled || pending} onPress={() => { onOpen(); setOpen(true); }}>{t("products.detail.archive")}</Button>
    <Dialog open={open} title={t("products.detail.archive")} dismissOnBackdrop={!pending} onClose={() => { if (!pending) setOpen(false); }}>
      <View testID="merchant-archive-product" className="gap-3">
        <Text className="text-sm text-foreground">{t("products.detail.archiveConfirmation", { title })}</Text>
        <Text className="text-sm text-foreground">{t("products.detail.archiveUnsaved")}</Text>
        <View className="min-h-5" accessibilityLiveRegion="polite">
          {failed ? <Text className="text-sm text-destructive">{t("products.detail.archiveFailed")}</Text> : null}
        </View>
        <Button appearance="outline" disabled={pending} onPress={() => setOpen(false)}>{t("common.cancel")}</Button>
        <Button tone="danger" disabled={disabled} loading={pending} onPress={onConfirm}>{t("products.detail.archive")}</Button>
      </View>
    </Dialog>
  </>;
}
