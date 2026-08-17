import React, { useCallback, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Search } from "@oxyhq/bloom/search";
import { MercariaWordmark } from "@/components/ui/mercaria-wordmark";
import { useColorScheme } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";

/* ================================================================
   HeroSearch — wordmark + large search bar (content-area header)
   ================================================================ */

export function HeroSearch() {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  const router = useRouter();
  const [query, setQuery] = useState("");

  // The query travels in the URL and nothing else does (#95 client rule 6):
  // `/search` re-interprets from the term, so a shared link reproduces the
  // search without carrying a session id or anybody's clarification history.
  const handleSubmit = useCallback(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    router.push({ pathname: "/search", params: { q: trimmed } });
  }, [query, router]);

  return (
    <View className="items-center px-4 pb-4 pt-6">
      <MercariaWordmark width={188} color={colors.foreground} />

      {/* Bloom's `Search` owns the input chrome (pill radius, magnifier, clear
          button, hover/focus states) so this bar matches every other search
          field in the ecosystem instead of being a look-alike. `label` is the
          accessibility name; the shopping prompt is the visible placeholder. */}
      <View className="mt-3 w-full max-w-xl">
        <Search
          label={t("search.box.label")}
          placeholder={t("search.box.placeholder")}
          value={query}
          onChangeText={setQuery}
          onClearText={() => setQuery("")}
          onSubmitEditing={handleSubmit}
        />
      </View>
    </View>
  );
}
