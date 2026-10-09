import { Pressable, View } from "react-native";
import { Link, type Href } from "expo-router";
import { Text } from "@mercaria/ui";
import type { SearchResult, SearchResultKind } from "@mercaria/shared-types";
import { useTranslation } from "@/lib/i18n";

/**
 * What each result KIND is called on screen.
 *
 * The row used to render `result.kind` directly, so a shopper saw the wire
 * value — `product_family`, underscore and all — in every language. There was
 * no string literal anywhere for a scanner to find, which is why neither the
 * i18n guard nor any census reported it.
 *
 * KEYS, and frozen on the NEXT line rather than `Object.freeze({ … })`: the
 * guard's key reader matches a `const X = { … }` initializer, and a call
 * expression is not one, so freezing inline would hide these five from its
 * referential check.
 */
const SEARCH_RESULT_KIND_KEYS: Readonly<Record<SearchResultKind, string>> = {
  product: "search.kind.product",
  brand: "search.kind.brand",
  product_family: "search.kind.productFamily",
  merchant: "search.kind.merchant",
  storefront: "search.kind.storefront",
};
Object.freeze(SEARCH_RESULT_KIND_KEYS);

function resultHref(result: SearchResult): Href | undefined {
  switch (result.kind) {
    case "product": return { pathname: "/p/[handle]", params: { handle: result.slug || result.canonicalProductId } };
    case "brand": return { pathname: "/brands/[handle]", params: { handle: result.slug || result.brandId } };
    case "product_family": return { pathname: "/families/[handle]", params: { handle: result.slug || result.productFamilyId } };
    case "merchant": return { pathname: "/merchants/[idOrSlug]", params: { idOrSlug: result.slug || result.merchantId } };
    // A canonical storefront is a channel, not a Mercaria store. It has no
    // standalone app route; never send its slug to the unrelated /stores API.
    case "storefront": return undefined;
  }
}

export function SearchResultRow({ result }: { result: SearchResult }) {
  const { t } = useTranslation();
  const href = resultHref(result);
  const content = (
    <View className="rounded-[20px] border border-border bg-card px-4 py-4 web:transition-colors web:duration-150 web:group-hover:bg-muted web:motion-reduce:transition-none">
      <Text className="text-sm font-semibold text-foreground">{result.name}</Text>
      <Text className="mt-1 text-xs text-muted-foreground">{t(SEARCH_RESULT_KIND_KEYS[result.kind])}</Text>
    </View>
  );
  return href ? <Link href={href} asChild><Pressable className="group" accessibilityRole="link">{content}</Pressable></Link> : content;
}
