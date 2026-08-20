import { Pressable, View } from "react-native";
import { Minus, Plus, Trash2 } from "lucide-react-native";
import { Text } from "../ui/text";
import { useColorScheme } from "../../lib/useColorScheme";

/** Icon size for stepper buttons (px). */
const STEPPER_ICON_SIZE = 16;
/** Fixed square size Tailwind class for each stepper button. */
const BUTTON_CLASS = "h-9 w-9 items-center justify-center";

export interface QuantityStepperProps {
  quantity: number;
  available?: number;
  onDecrement: () => void;
  onIncrement: () => void;
  onRemove?: () => void;
}

/**
 * Quantity stepper pill. When `quantity <= 1` and `onRemove` is provided the
 * decrement button becomes a trash/remove button. The increment button is
 * disabled when `available !== undefined && quantity >= available`.
 *
 * No nested interactives — the three buttons are siblings inside the pill row.
 */
export function QuantityStepper({
  quantity,
  available,
  onDecrement,
  onIncrement,
  onRemove,
}: QuantityStepperProps) {
  const { colors } = useColorScheme();

  const atMin = quantity <= 1;
  const atMax = available !== undefined && quantity >= available;

  const showRemove = atMin && onRemove !== undefined;
  const decrementDisabled = atMin && !onRemove;

  return (
    <View className="flex-row items-center rounded-full bg-secondary md:border md:border-border md:bg-card">
      {/* Left button: Trash when at minimum and onRemove provided; Minus otherwise. */}
      {showRemove ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Remove item"
          onPress={onRemove}
          className={BUTTON_CLASS}
        >
          <Trash2 size={STEPPER_ICON_SIZE} color={colors.foreground} />
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Decrease quantity"
          onPress={decrementDisabled ? undefined : onDecrement}
          disabled={decrementDisabled}
          className={`${BUTTON_CLASS}${decrementDisabled ? " opacity-40" : ""}`}
        >
          <Minus size={STEPPER_ICON_SIZE} color={colors.foreground} />
        </Pressable>
      )}

      {/* Center quantity label. */}
      <Text className="min-w-[24px] text-center text-sm font-semibold text-foreground">
        {quantity}
      </Text>

      {/* Right button: Plus, disabled at max. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Increase quantity"
        onPress={atMax ? undefined : onIncrement}
        disabled={atMax}
        className={`${BUTTON_CLASS}${atMax ? " opacity-40" : ""}`}
      >
        <Plus size={STEPPER_ICON_SIZE} color={colors.foreground} />
      </Pressable>
    </View>
  );
}
