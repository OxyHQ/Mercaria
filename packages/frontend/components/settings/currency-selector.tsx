import { View, Pressable } from "react-native";
import { useOxy } from "@oxyhq/services";
import { Coins, Check } from "lucide-react-native";
import {
  ALL_CURRENCY_CODES,
  CURRENCY_SYMBOLS,
  type CurrencyCode,
} from "@mercaria/shared-types";
import { Text } from "@mercaria/ui";
import { cn } from "@/lib/utils";
import { toast } from "@/components/sonner";
import {
  useCurrencyPreferenceQuery,
  useUpdateCurrencyPreference,
} from "@/lib/fx";

/** Canonical default when the shopper has not chosen a display currency. */
const DEFAULT_DISPLAY_CURRENCY: CurrencyCode = "FAIR";

/**
 * Storefront display-currency picker. Lets the shopper choose the PRIMARY
 * currency prices are shown in (FAIR by default), persisting the choice via
 * `PUT /me/currency-preference`. Selecting a currency primes the preference
 * query cache, so every `PriceDisplay` re-renders in the new currency live —
 * no reload, no effect. Presentation-only: the stored amounts never change.
 */
export function CurrencySelector() {
  const { isAuthenticated } = useOxy();
  const { data: preference } = useCurrencyPreferenceQuery();
  const updatePreference = useUpdateCurrencyPreference();

  const selected: CurrencyCode =
    preference?.preferredCurrency ?? DEFAULT_DISPLAY_CURRENCY;

  const onSelect = (code: CurrencyCode) => {
    if (code === selected || updatePreference.isPending) {
      return;
    }
    updatePreference.mutate(
      { preferredCurrency: code },
      { onError: () => toast.error("Couldn't update your display currency") },
    );
  };

  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <Coins size={20} className="text-primary" />
        <Text className="text-base font-semibold">Display currency</Text>
      </View>
      <Text className="text-sm text-muted-foreground">
        Choose the currency prices are shown in. FairCoin (⊜) is the default.
      </Text>

      {isAuthenticated ? (
        <View className="flex-row flex-wrap gap-2">
          {ALL_CURRENCY_CODES.map((code) => {
            const isSelected = code === selected;
            return (
              <Pressable
                key={code}
                disabled={updatePreference.isPending}
                onPress={() => onSelect(code)}
                className={cn(
                  "flex-row items-center gap-1.5 rounded-full border px-3.5 py-2",
                  isSelected
                    ? "border-primary bg-primary/10"
                    : "border-border bg-background",
                  updatePreference.isPending ? "opacity-60" : "",
                )}
              >
                <Text
                  className={cn(
                    "text-sm font-medium",
                    isSelected ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {`${CURRENCY_SYMBOLS[code]} ${code}`}
                </Text>
                {isSelected ? <Check size={14} className="text-primary" /> : null}
              </Pressable>
            );
          })}
        </View>
      ) : (
        <Text className="text-sm text-muted-foreground">
          Sign in to save your preferred display currency.
        </Text>
      )}
    </View>
  );
}
