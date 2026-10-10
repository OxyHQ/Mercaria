import { Pressable, View } from "react-native";
import { useState } from "react";
import { Image } from "expo-image";
import { Text } from "../ui/text";

/** A missing editorial cover falls back to an actual item in the collection. */
export function CurationImage({
  imageUrl,
  fallbackImageUrl,
}: {
  imageUrl?: string;
  fallbackImageUrl?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const uri =
    failedUrl === imageUrl ? fallbackImageUrl : (imageUrl ?? fallbackImageUrl);
  return uri ? (
    <Image
      source={{ uri }}
      contentFit="cover"
      onError={() => setFailedUrl(imageUrl)}
      className="absolute inset-0 h-full w-full web:transition-transform web:duration-300 web:group-hover:scale-[1.03] web:motion-reduce:transition-none"
    />
  ) : null;
}

/** The editorial entry card; its imagery and copy are supplied by the edition. */
export function CurationCard({
  title,
  imageUrl,
  fallbackImageUrl,
  onPress,
}: {
  title: string;
  imageUrl?: string;
  fallbackImageUrl?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={title}
      onPress={onPress}
      style={{ aspectRatio: 2.35 }}
      className="group overflow-hidden rounded-[28px] bg-muted"
    >
      <CurationImage imageUrl={imageUrl} fallbackImageUrl={fallbackImageUrl} />
      <View className="absolute inset-0 bg-black/35" />
      <View className="flex-1 justify-end p-5">
        <Text
          className="text-xl font-bold leading-[24px] text-white md:text-2xl md:leading-[28px]"
          numberOfLines={2}
        >
          {title}
        </Text>
      </View>
    </Pressable>
  );
}
