import { View, Pressable } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { ArrowRight } from "lucide-react-native";
import { Text } from "../ui/text";
import type { HeroCard } from "@mercaria/shared-types";

/** Card aspect ratio (width ÷ height) — the reference's `feed-action-card-hero`. */
const HERO_ASPECT_RATIO = 2.35;
/** Arrow-disc icon size (px). */
const ARROW_ICON_SIZE = 16;
/** Fixed light foreground over the hero image (documented constant, mirrors `text-fixed-light`). */
const FIXED_LIGHT = "#ffffff";

export interface ActionHeroCardProps {
  card: HeroCard;
  onPress?: (card: HeroCard) => void;
}

/**
 * A single 2.35:1 hero action card: a full-bleed cover image, a bottom dark
 * gradient scrim, and a title/subtitle pinned bottom-left beside a round
 * arrow affordance bottom-right. One press target — the whole card is the
 * link.
 *
 * `aspectRatio` is set via `style` (React Native has no `aspect-[2.35]`
 * utility); the carousel/grid slot supplies the width and this ratio derives
 * the height, with `min-h-[140px]` as a floor for a very narrow slot.
 */
export function ActionHeroCard({ card, onPress }: ActionHeroCardProps) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={card.title}
      onPress={() => onPress?.(card)}
      className="group relative w-full overflow-hidden rounded-radius-28 min-h-[140px]"
      style={{ aspectRatio: HERO_ASPECT_RATIO }}
    >
      {card.imageUrl ? (
        <Image
          source={{ uri: card.imageUrl }}
          contentFit="cover"
          className="absolute inset-0 size-full web:transition-transform web:group-hover:scale-105"
        />
      ) : (
        <View pointerEvents="none" className="absolute inset-0 size-full bg-bg-fill-tertiary" />
      )}

      {/* Bottom scrim so the light title/subtitle stay legible over any image. */}
      <LinearGradient
        pointerEvents="none"
        colors={["transparent", "rgba(0,0,0,0.314)"]}
        locations={[0, 0.85]}
        className="absolute inset-0"
      />

      <View className="absolute inset-x-0 bottom-0 flex-row items-end justify-between p-space-20">
        <View className="min-w-0 flex-1 flex-col gap-space-4">
          <Text numberOfLines={1} className="font-subtitle text-subtitle text-text-fixed-light">
            {card.title}
          </Text>
          {card.subtitle ? (
            <Text numberOfLines={1} className="font-caption text-caption text-text-fixed-light">
              {card.subtitle}
            </Text>
          ) : null}
        </View>
        <View className="size-space-32 shrink-0 items-center justify-center rounded-full bg-overlay-fixed-light-20">
          <ArrowRight size={ARROW_ICON_SIZE} color={FIXED_LIGHT} />
        </View>
      </View>
    </Pressable>
  );
}
