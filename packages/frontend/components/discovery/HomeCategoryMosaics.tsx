import { useRouter } from "expo-router";
import { CategoryMosaicShelf } from "@mercaria/ui";
import { useCatalogNavigation } from "@/lib/catalog/use-navigation";
import { useTranslation } from "@/lib/i18n";

export function HomeCategoryMosaics() {
  const { data } = useCatalogNavigation();
  const router = useRouter();
  const { t } = useTranslation();
  // This visual shelf needs four illustrated destinations. All other published
  // categories remain available from Explore; no local category list is invented.
  const groups = (data?.trees ?? [])
    .flatMap((tree) =>
      tree.entries.map((entry) => ({ treeKey: tree.key, entry })),
    )
    .filter(
      ({ entry }) =>
        entry.children.filter((child) => child.href && child.imageUrl).length >=
        4,
    )
    .map(({ treeKey, entry }) => ({
      key: `${treeKey}:${entry.key}`,
      label: entry.label,
      onPress: entry.href ? () => router.push(entry.href!) : undefined,
      children: entry.children
        .filter((child) => child.href && child.imageUrl)
        .slice(0, 4)
        .map((child) => ({
          key: child.key,
          label: child.label,
          imageUrl: child.imageUrl,
          onPress: () => router.push(child.href!),
        })),
    }));
  return (
    <CategoryMosaicShelf
      groups={groups}
      accessibilityLabel={t("nav.explore")}
    />
  );
}
