import React, { useState } from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import { Package } from "lucide-react-native";
import { useImageResolver } from "@oxy.so/bloom/image-resolver";
import { isOxyFileId } from "@mercaria/shared-types";
import { useColorScheme, useSharedUiTranslation } from "@mercaria/ui";

/** Product media only enters through an opaque Oxy ID, never a stored URL. */
export function OxyProductImage({ fileId, alt, size }: { fileId?: string; alt: string; size: number }) {
  const resolveImage = useImageResolver();
  const { colors } = useColorScheme();
  const t = useSharedUiTranslation();
  const [failed, setFailed] = useState<readonly string[]>([]);
  const id = isOxyFileId(fileId) ? fileId : undefined;
  const thumbnail = id ? resolveImage?.(id, "thumb") : undefined;
  const original = id ? resolveImage?.(id) : undefined;
  // A missing rendition must not hide a valid original of the SAME Oxy file.
  const uri = [thumbnail, original].find(candidate => candidate && !failed.includes(candidate));
  return <View style={{ width: size, height: size }} className="items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
    {uri ? <Image key={uri} source={{ uri }} style={{ width: size, height: size }} contentFit="contain"
      accessibilityLabel={alt} onError={() => setFailed(previous => previous.includes(uri) ? previous : [...previous, uri])} />
      : <View accessibilityRole="image" accessibilityLabel={t("ui.marketplace.noImage")}><Package size={Math.min(28, size / 2)} color={colors.mutedForeground} /></View>}
  </View>;
}
