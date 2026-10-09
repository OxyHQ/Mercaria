import { useState } from "react";
import { View } from "react-native";
import { Button } from "@oxy.so/bloom/button";
import { Dialog } from "@oxy.so/bloom/dialog";
import { Text } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";

/** Shop's description preview is capped at 340 characters, with the complete
 * authored text in a sheet. Keep paragraphs and Unicode characters intact. */
const PREVIEW_LENGTH = 340;

export function ProductDescription({ description }: { description: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const characters = Array.from(description);
  const truncated = characters.length > PREVIEW_LENGTH;
  const preview = truncated
    ? `${characters.slice(0, PREVIEW_LENGTH).join("").trimEnd()}…`
    : description;

  return (
    <View className="gap-space-8" testID="product-description">
      <Text className="text-bodySmall text-text">{preview}</Text>
      {truncated ? (
        <Button
          appearance="plain"
          material="flat"
          onPress={() => setOpen(true)}
          style={{ alignSelf: "flex-start", paddingHorizontal: 0, minHeight: 32 }}
        >
          {t("product.readMoreDescription")}
        </Button>
      ) : null}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        label={t("product.description")}
        header={{ title: t("product.description"), largeTitle: false }}
        placement={{ base: "bottom", md: "end" }}
        width={560}
        maxHeightRatio={0.94}
        testID="product-description-dialog"
      >
        <Text selectable className="text-bodySmall text-text">{description}</Text>
      </Dialog>
    </View>
  );
}
