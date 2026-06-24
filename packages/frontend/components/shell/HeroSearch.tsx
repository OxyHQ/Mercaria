import React, { useCallback, useState } from "react";
import { View, Pressable, TextInput } from "react-native";
import { Search } from "lucide-react-native";
import { MercariaWordmark } from "@/components/ui/mercaria-wordmark";
import { useColorScheme } from "@mercaria/ui";

/* ================================================================
   HeroSearch — wordmark + large search bar (content-area header)
   ================================================================ */

export function HeroSearch() {
  const { colors } = useColorScheme();
  const [query, setQuery] = useState("");

  // A real submit handler that reads the query. There is no `/search` route
  // yet, so it does nothing harmful (no navigation to a missing route). Wire
  // the navigation here once the search screen exists.
  const handleSubmit = useCallback(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    // Intentionally a no-op until the search route is built.
  }, [query]);

  return (
    <View className="items-center px-4 pb-4 pt-6">
      <MercariaWordmark width={188} color={colors.foreground} />

      <View className="mt-3 w-full max-w-xl flex-row items-center rounded-full border border-border bg-secondary px-4 py-2 web:transition focus-within:border-primary">
        <Search size={18} color={colors.mutedForeground} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={handleSubmit}
          returnKeyType="search"
          placeholder="What are you shopping for today?"
          placeholderTextColor={colors.mutedForeground}
          className="ml-2 flex-1 text-sm text-foreground"
          accessibilityLabel="Search"
        />
        <Pressable
          onPress={handleSubmit}
          accessibilityRole="button"
          accessibilityLabel="Search"
          className="ml-2 h-8 w-8 items-center justify-center rounded-full bg-primary active:opacity-80 web:transition"
        >
          <Search size={16} color={colors.primaryForeground} />
        </Pressable>
      </View>
    </View>
  );
}
