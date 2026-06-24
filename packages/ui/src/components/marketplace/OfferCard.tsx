import { Pressable, View } from "react-native";
import { ChevronRight, Sparkles } from "lucide-react-native";
import { Text } from "../ui/text";

/** Leading badge + trailing chevron icon size (px). */
const OFFER_ICON_SIZE = 18;

export interface OfferCardProps {
  /** Brand-colored headline (e.g. "Unlock exclusive pricing"). */
  label: string;
  /** Muted caption under the headline (e.g. "Sign in to view your exclusive offer"). */
  caption: string;
  /** Optional tap handler (e.g. navigate to sign-in / the cart). */
  onPress?: () => void;
}

/**
 * Exclusive-offer teaser card: a circular brand-tinted sparkle badge, a
 * brand-colored headline + muted caption, and a trailing chevron — a bordered
 * card pill. Decorative — no real promotion is applied; the caller supplies the
 * copy and tap target.
 */
export function OfferCard({ label, caption, onPress }: OfferCardProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="flex-row items-center gap-space-12 rounded-radius-16 border border-border-secondary bg-bg-fill py-space-12 pl-space-16 pr-space-12"
    >
      <View className="size-space-32 items-center justify-center rounded-radius-max bg-bg-fill-brand/10">
        <Sparkles size={OFFER_ICON_SIZE} className="text-text-brand" />
      </View>
      <View className="flex-1">
        <Text className="text-bodyTitleSmall text-text-brand">{label}</Text>
        <Text className="text-caption text-text-tertiary">{caption}</Text>
      </View>
      <ChevronRight size={OFFER_ICON_SIZE} className="text-text-brand" />
    </Pressable>
  );
}
