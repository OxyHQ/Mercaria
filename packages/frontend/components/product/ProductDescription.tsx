import { useMemo, useState } from "react";
import { Platform, View } from "react-native";
import { LinkButton } from "@oxy.so/bloom/button";
import { Text, MarketplaceSheet, ProductRichText, prepareProductDescription } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";

/** Shop's description preview is capped at 340 characters, with the complete
 * authored text in a sheet. Keep paragraphs and Unicode characters intact. */
const PREVIEW_LENGTH = 340;

export function ProductDescription({ description }: { description: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { html, full, preview, truncated } = useMemo(() => prepareProductDescription(description, PREVIEW_LENGTH), [description]);
  const more = truncated ? <>
    {"... "}
    {Platform.OS === "web" ? (
      <LinkButton linkTone="text" underline="none" textVariant="body-2-semibold"
        textStyle={{ fontSize: 14, letterSpacing: -0.2 }} onPress={() => setOpen(true)}>
        {t("product.readMoreDescription")}
      </LinkButton>
    ) : (
      <Text accessibilityRole="button" onPress={() => setOpen(true)} className="text-shop-bodyTitleSmall text-text">
        {t("product.readMoreDescription")}
      </Text>
    )}
  </> : null;

  return (
    <View testID="product-description">
      {html ? <ProductRichText nodes={preview} preview trailing={more} /> : (
        <Text className="text-shop-bodySmall text-text">{typeof preview[0] === "string" ? preview[0] : ""}{more}</Text>
      )}
      <MarketplaceSheet
        open={open}
        onClose={() => setOpen(false)}
        title={t("product.description")}
        testID="product-description-dialog"
      >
        {html ? <ProductRichText nodes={full} /> : <Text selectable className="text-shop-bodySmall text-text">{description}</Text>}
      </MarketplaceSheet>
    </View>
  );
}
