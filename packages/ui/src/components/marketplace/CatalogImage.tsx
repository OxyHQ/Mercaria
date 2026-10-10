import { useState } from "react";
import { View } from "react-native";
import { Image, type ImageProps } from "../ui/image";
import { useImageResolver } from "@oxy.so/bloom/image-resolver";
import { resolveCatalogImage } from "../../lib/stored-image-url";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import { Text } from "../ui/text";

type CatalogImageProps = Pick<ImageProps, "className" | "contentFit" | "accessibilityLabel"> & {
  fileId?: string;
  /** Only persisted, older DTOs need the verified Oxy URL compatibility path. */
  legacyUrl?: string;
};

function ResolvedCatalogImage({ uri, className, contentFit = "cover", accessibilityLabel }: {
  uri?: string;
} & Omit<CatalogImageProps, "fileId" | "legacyUrl">) {
  const [failed, setFailed] = useState(false);
  const t = useSharedUiTranslation();
  return (
    <View className={className}>
      {uri && !failed ? (
        <Image source={{ uri }} recyclingKey={uri} contentFit={contentFit}
          accessibilityLabel={accessibilityLabel} className="h-full w-full"
          onError={() => setFailed(true)} />
      ) : (
        <View className="h-full w-full items-center justify-center bg-muted">
          <Text className="text-xs text-muted-foreground">{t("ui.marketplace.noImage")}</Text>
        </View>
      )}
    </View>
  );
}

/** Keep failures and recycled pixels tied to their source. Rotating the hero
 * or refreshing a shelf never shows the previous product's photo/error state.
 * The animated card itself remains mounted; only the image changes identity. */
export function CatalogImage({ fileId, legacyUrl, ...props }: CatalogImageProps) {
  const uri = resolveCatalogImage(fileId, legacyUrl, useImageResolver());
  return <ResolvedCatalogImage key={uri ?? "missing"} uri={uri} {...props} />;
}
