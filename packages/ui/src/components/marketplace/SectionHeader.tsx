import { Pressable, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { Text } from "../ui/text";
import { useColorScheme } from "../../lib/useColorScheme";

/** Trailing chevron icon size (px). */
const CHEVRON_ICON_SIZE = 18;

export interface SectionHeaderProps {
  title: string;
  onPress?: () => void;
  showChevron?: boolean;
}

/**
 * Shelf section heading. Three modes:
 *
 * 1. Plain (no `onPress`, no `showChevron`): renders the exact same Text node
 *    that existing shelves use — byte-identical layout to the old inline heading
 *    so the refactor is visually safe.
 * 2. Interactive (has `onPress`): wraps the heading row in a Pressable link.
 * 3. With chevron (has `showChevron`): adds a bordered icon button at the end.
 *
 * When `onPress` or `showChevron` is present the row switches to a `flex-row
 * items-center justify-between` wrapper and the title's own padding moves to the
 * outer View; in the plain branch the padding stays on the Text element itself,
 * matching the existing shelves exactly.
 */
export function SectionHeader({ title, onPress, showChevron = false }: SectionHeaderProps) {
  const { colors } = useColorScheme();

  // Plain branch — matches the existing shelf heading exactly.
  if (!onPress && !showChevron) {
    return (
      <Text
        className="px-4 pb-3 text-lg font-semibold text-foreground md:px-5 md:text-[22px] md:font-bold md:leading-7"
        numberOfLines={1}
      >
        {title}
      </Text>
    );
  }

  const inner = (
    <>
      <Text
        className="flex-1 text-lg font-semibold text-foreground md:text-[22px] md:font-bold md:leading-7"
        numberOfLines={1}
      >
        {title}
      </Text>
      {showChevron ? (
        <View className="h-8 w-8 items-center justify-center rounded-full border border-border">
          <ChevronRight size={CHEVRON_ICON_SIZE} color={colors.foreground} />
        </View>
      ) : null}
    </>
  );

  if (onPress) {
    return (
      <Pressable
        accessibilityRole="link"
        onPress={onPress}
        className="flex-row items-center justify-between px-4 pb-3 md:px-5"
      >
        {inner}
      </Pressable>
    );
  }

  return (
    <View className="flex-row items-center justify-between px-4 pb-3 md:px-5">
      {inner}
    </View>
  );
}
