import { View } from "react-native";
import { useRouter } from "expo-router";
import { useOxy } from "@oxy.so/services";
import { CanonicalProductCard } from "@mercaria/ui";
import type { SearchResult, CatalogPriceConditionScope } from "@mercaria/shared-types";
import { SearchResultRow } from "./SearchResultRow";

/** Conversation results reuse the catalogue's image, price and offer semantics. */
export function ThreadResults({ results }: { results: readonly SearchResult[] }) {
  const router = useRouter();
  const { oxyServices } = useOxy();
  return <View className="flex-row flex-wrap gap-3" testID="thread-results">
    {results.map(result => {
      if (result.kind !== "product") return <View key={`${result.kind}-${result.slug}`} className="min-w-40 grow"><SearchResultRow result={result} /></View>;
      const hasNew = result.conditionGroups.includes("new");
      const hasUsed = result.conditionGroups.some(group => group !== "new");
      const conditionScope: CatalogPriceConditionScope = hasNew ? hasUsed ? "mixed" : "new" : hasUsed ? "used" : "unknown";
      return <View key={result.canonicalProductId} className="w-[47%] sm:w-[23%]">
        <CanonicalProductCard product={{
          canonicalProductId: result.canonicalProductId, slug: result.slug, name: result.name,
          // Search media carries no display-rights assessment. The canonical
          // card keeps its placeholder until the product page verifies it.
          offers: result.offerSummary ? { summary: result.offerSummary, conditionGroups: result.conditionGroups, conditionScope } : undefined,
        }} resolveImage={fileId => oxyServices.assets.publicUrl(fileId, "thumb") || undefined}
          onPress={() => router.push({ pathname: "/p/[handle]", params: { handle: result.slug || result.canonicalProductId } })} />
      </View>;
    })}
  </View>;
}
