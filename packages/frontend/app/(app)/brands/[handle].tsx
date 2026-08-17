import { useEffect } from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import Head from "expo-router/head";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useOxy } from "@oxyhq/services";
import type { CatalogStructuredData } from "@mercaria/shared-types";
import { SectionHeader, Skeleton, Text } from "@mercaria/ui";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { OfficialChannelSection } from "@/components/brand/OfficialChannelSection";
import { CatalogProductGrid } from "@/components/brand/CatalogProductGrid";
import { useTranslation } from "@/lib/i18n";
import { useBrandPage, useBrandProducts } from "@/lib/hooks/use-catalog-pages";

/**
 * The BRAND page (#72).
 *
 * A brand page is not a merchant storefront and this screen renders nothing
 * that would suggest otherwise: no inventory, no seller of record, no "buy
 * from this brand". A merchant appears only in one of the two verified channel
 * lists, and an ordinary retailer selling the brand appears in neither — which
 * is the normal state, so both lists say so rather than disappearing.
 *
 * ## Three things this screen owns that the server cannot
 *
 * 1. **The redirect.** A merged brand answers with the winner and reports the
 *    old handle; the client rewrites its address bar. The server returns a 200
 *    with the page rather than a 301 precisely so this costs no round trip.
 * 2. **The canonical URL and the metadata.** `Head` is web-only in expo-router
 *    and is what a crawler reads.
 * 3. **`noindex`.** The server publishes the VERDICT (`indexability`) and this
 *    screen is where it becomes a meta tag — including for a `no_index_right`
 *    page, where a source contractually refused to have its facts indexed.
 */

/** Brand logo edge length (px) in the page header. */
const LOGO_SIZE = 72;

export default function BrandPageScreen() {
  const { handle } = useLocalSearchParams<{ handle: string }>();
  const router = useRouter();
  const { t } = useTranslation();
  const { oxyServices } = useOxy();

  const { data: brand, isLoading, isError } = useBrandPage(handle);
  const products = useBrandProducts(handle);

  // The redirect a merge or an alias produced. `replace`, never `push`: the old
  // handle is not a place a reader should be able to go BACK to.
  //
  // The SLUG travels, never `canonicalPath`. The server composes that path from
  // this screen's own route (`/brands/${slug}`), so consuming it would make the
  // API the authority on the client's route table — an arrangement in which
  // moving this file breaks navigation at runtime and nothing at build time.
  // `canonicalPath` stays what it is below: a URL for `rel=canonical` and the
  // structured data, which is a different question from where to navigate.
  const redirectTo = brand?.redirect === undefined ? undefined : brand.slug;
  useEffect(() => {
    if (redirectTo !== undefined) {
      router.replace({ pathname: '/brands/[handle]', params: { handle: redirectTo } });
    }
  }, [redirectTo, router]);

  if (isLoading) {
    return (
      <ScreenShell>
        <View className="flex flex-col gap-4 p-4">
          <Skeleton className="h-20 w-20 rounded-2xl" />
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full" />
        </View>
      </ScreenShell>
    );
  }

  if (isError || !brand) {
    return (
      <ScreenShell>
        <View className="flex flex-col gap-2 p-4">
          <Text className="text-lg font-semibold">{t("brands.notFound.title")}</Text>
          <Text className="text-sm text-muted-foreground">{t("brands.notFound.body")}</Text>
        </View>
      </ScreenShell>
    );
  }

  const logoUrl =
    brand.logo.state === "displayable"
      ? oxyServices.getFileDownloadUrl(brand.logo.fileId, "thumb")
      : undefined;

  return (
    <>
      <Head>
        <title>{t("brands.meta.title", { name: brand.name })}</title>
        <link rel="canonical" href={brand.canonicalPath} />
        {brand.indexability === "indexable" ? null : (
          <meta name="robots" content="noindex,follow" />
        )}
        {brand.description.state === "displayable" ? (
          <meta name="description" content={brand.description.text} />
        ) : null}
        {brand.structuredData.kind === "none" ? null : (
          // Emitted ONLY when the server said the visible facts support it —
          // the derivation is the server's and this is its rendering.
          <script
            type="application/ld+json"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{
              __html: toJsonLd(brand.structuredData, brand.canonicalPath),
            }}
          />
        )}
      </Head>
      <ScreenShell>
        <View className="flex flex-col gap-8 p-4">
          <View className="flex-row items-center gap-4">
            {logoUrl ? (
              <Image
                source={{ uri: logoUrl }}
                contentFit="contain"
                style={{ width: LOGO_SIZE, height: LOGO_SIZE }}
                className="rounded-2xl bg-card"
              />
            ) : null}
            <View className="flex flex-1 flex-col gap-1">
              <Text className="text-2xl font-semibold">{brand.name}</Text>
              {brand.owningOrganization === undefined ? null : (
                // Shown ONLY from a verified `organization_owns_brand`
                // relationship. Most brands in a crawled catalogue have none,
                // and printing a legal entity from a name match is the exact
                // inference #55 exists to prevent.
                <Text className="text-sm text-muted-foreground">
                  {t("brands.ownedBy", { organization: brand.owningOrganization.name })}
                </Text>
              )}
              <Text className="text-xs text-muted-foreground">
                {t("brands.productCount", { count: brand.productCount })}
              </Text>
            </View>
          </View>

          {brand.description.state === "displayable" ? (
            <View className="flex flex-col gap-1">
              <Text className="text-sm">{brand.description.text}</Text>
              {brand.description.provenance?.attribution === undefined ? null : (
                // The source demanded attribution; showing the text without it
                // would be using the licence without meeting its condition.
                <Text className="text-xs text-muted-foreground">
                  {t("brands.descriptionSource", {
                    attribution: brand.description.provenance.attribution,
                  })}
                </Text>
              )}
            </View>
          ) : null}

          <OfficialChannelSection
            title={t("brands.officialStores.title")}
            description={t("brands.officialStores.description")}
            entries={brand.channels.officialStores}
            emptyText={t("brands.officialStores.empty")}
          />

          <OfficialChannelSection
            title={t("brands.authorizedResellers.title")}
            description={t("brands.authorizedResellers.description")}
            entries={brand.channels.authorizedResellers}
            emptyText={t("brands.authorizedResellers.empty")}
          />

          {brand.families.length === 0 ? null : (
            <View className="flex flex-col gap-3">
              <SectionHeader title={t("brands.families.title")} />
              <View className="flex-row flex-wrap gap-2">
                {brand.families.map((family) => (
                  <Text
                    key={family.familyId}
                    accessibilityRole="link"
                    onPress={() => router.push(`/families/${family.slug}`)}
                    className="rounded-full bg-muted px-3 py-1 text-sm"
                  >
                    {family.name}
                  </Text>
                ))}
              </View>
            </View>
          )}

          {brand.categories.length === 0 ? null : (
            <View className="flex flex-col gap-3">
              <SectionHeader title={t("brands.categories.title")} />
              <View className="flex-row flex-wrap gap-2">
                {brand.categories.map((category) => (
                  <Text
                    key={category.categoryId}
                    className="rounded-full bg-muted px-3 py-1 text-sm text-muted-foreground"
                  >
                    {category.name} · {category.productCount}
                  </Text>
                ))}
              </View>
            </View>
          )}

          <View className="flex flex-col gap-3">
            <SectionHeader title={t("brands.products.title")} />
            <CatalogProductGrid
              pages={products.data}
              isLoading={products.isLoading}
              hasNextPage={products.hasNextPage}
              isFetchingNextPage={products.isFetchingNextPage}
              onLoadMore={() => void products.fetchNextPage()}
              filtered={false}
            />
          </View>
        </View>
      </ScreenShell>
    </>
  );
}

/**
 * The JSON-LD body, from the server's own verdict.
 *
 * The mapping is one-to-one and adds NOTHING: every field is a fact the page
 * above renders, which is what "structured data only when visible facts support
 * it" means. A field composed here and not shown would be a claim addressed to
 * a crawler and to nobody else.
 *
 * ## The escaping is load-bearing, not hygiene
 *
 * A brand's NAME and DESCRIPTION come from a crawled catalogue, so they are
 * attacker-influenced text — and `JSON.stringify` does not escape `<` or `>`.
 * A brand named `</script><script>…` would therefore close this tag and open
 * one of its own. Escaping the three characters that can terminate a script
 * element into their `\uXXXX` forms produces byte-identical JSON to a parser
 * and inert text to an HTML tokenizer, which is the standard safe embedding.
 */
function toJsonLd(data: CatalogStructuredData, canonicalPath: string): string {
  const body: Record<string, unknown> =
    data.kind === "organization"
      ? {
          "@context": "https://schema.org",
          "@type": "Organization",
          name: data.name,
          url: canonicalPath,
          brand: { "@type": "Brand", name: data.brandName },
        }
      : {
          "@context": "https://schema.org",
          "@type": "Brand",
          name: data.kind === "brand" ? data.name : "",
          url: canonicalPath,
          ...(data.kind === "brand" && data.description !== undefined
            ? { description: data.description }
            : {}),
          ...(data.kind === "brand" && data.sameAs !== undefined
            ? { sameAs: [...data.sameAs] }
            : {}),
        };

  return JSON.stringify(body)
    .replace(/</gu, "\\u003c")
    .replace(/>/gu, "\\u003e")
    .replace(/&/gu, "\\u0026");
}
