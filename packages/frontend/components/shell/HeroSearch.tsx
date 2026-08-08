import React, { useCallback, useState } from "react";
import { View } from "react-native";
import { Search } from "@oxyhq/bloom/search";
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

      {/* Bloom's `Search` owns the input chrome (pill radius, magnifier, clear
          button, hover/focus states) so this bar matches every other search
          field in the ecosystem instead of being a look-alike. `label` is the
          accessibility name; the shopping prompt is the visible placeholder. */}
      <View className="mt-3 w-full max-w-xl">
        <Search
          label="Search"
          placeholder="What are you shopping for today?"
          value={query}
          onChangeText={setQuery}
          onClearText={() => setQuery("")}
          onSubmitEditing={handleSubmit}
        />
      </View>
    </View>
  );
}
