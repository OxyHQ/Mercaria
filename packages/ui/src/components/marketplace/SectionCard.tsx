import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { Text } from "../ui/text";
import { useColorScheme } from "../../lib/useColorScheme";

/** Trailing chevron icon size (px), inside the disc. */
const CHEVRON_ICON_SIZE = 20;

export interface SectionCardProps {
  title: string;
  onPress?: () => void;
  children: ReactNode;
}

/**
 * A bordered container holding a titled mini-shelf — the reference's
 * `container-section-card`. Renders two per row on wide screens via
 * `FeedGrid`'s slot classes; `children` is whatever shelf the caller nests.
 *
 * The header is one link: title and trailing chevron disc together, never a
 * separate pressable each. When `onPress` is absent the header renders as a
 * static row instead of a `Pressable`, the same branch `SectionHeader` takes.
 */
export function SectionCard({ title, onPress, children }: SectionCardProps) {
  const { colors } = useColorScheme();

  const header = (
    <>
      <Text
        numberOfLines={1}
        className="flex-1 font-headerBold text-headerBold text-text"
      >
        {title}
      </Text>
      <View className="size-space-36 shrink-0 items-center justify-center rounded-radius-max bg-bg-overlay-fixed-dark-04">
        <ChevronRight size={CHEVRON_ICON_SIZE} color={colors.foreground} />
      </View>
    </>
  );

  return (
    <View className="flex-col rounded-radius-28 border-[0.5px] border-border-image p-space-24 pb-space-0 shadow-s web:hover:shadow-m">
      {onPress ? (
        <Pressable
          accessibilityRole="link"
          onPress={onPress}
          className="mb-space-16 flex-row items-center justify-between gap-space-16 md:mb-space-24"
        >
          {header}
        </Pressable>
      ) : (
        <View className="mb-space-16 flex-row items-center justify-between gap-space-16 md:mb-space-24">
          {header}
        </View>
      )}
      {children}
    </View>
  );
}
