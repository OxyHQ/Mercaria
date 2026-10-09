import { useState } from "react";
import { Platform, View } from "react-native";
import { LinkButton } from "@oxy.so/bloom/button";
import { Text, MarketplaceSheet } from "@mercaria/ui";
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
    <View testID="product-description">
      <Text className="text-shop-bodySmall text-text">
        {preview}
        {truncated ? (
          <>
            {" "}
            {Platform.OS === "web" ? (
              <LinkButton
                linkTone="text"
                underline="none"
                textVariant="body-2-semibold"
                textStyle={{ fontSize: 14, letterSpacing: -0.2 }}
                onPress={() => setOpen(true)}
              >
                {t("product.readMoreDescription")}
              </LinkButton>
            ) : (
              // A native paragraph needs a Text host: LinkButton is a View on
              // native, whose layout does not participate in the text flow.
              <Text
                accessibilityRole="button"
                onPress={() => setOpen(true)}
                className="text-shop-bodyTitleSmall text-text"
              >
                {t("product.readMoreDescription")}
              </Text>
            )}
          </>
        ) : null}
      </Text>
      <MarketplaceSheet
        open={open}
        onClose={() => setOpen(false)}
        title={t("product.description")}
        testID="product-description-dialog"
      >
        <Text selectable className="text-shop-bodySmall text-text">{description}</Text>
      </MarketplaceSheet>
    </View>
  );
}
