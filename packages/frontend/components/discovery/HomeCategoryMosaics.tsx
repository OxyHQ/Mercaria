import type { ReactElement } from "react";
import { Link } from "expo-router";
import { CategoryMosaicShelf } from "@mercaria/ui";
import { useCatalogNavigation } from "@/lib/catalog/use-navigation";
import { useTranslation } from "@/lib/i18n";

export function HomeCategoryMosaics() {
  const { data } = useCatalogNavigation();
  const { t } = useTranslation();
  // Keep published destinations usable while their media is missing or importing.
  // Smaller category groups remain available from Explore.
  const groups = (data?.trees ?? [])
    .flatMap((tree) =>
      tree.entries.map((entry) => ({ treeKey: tree.key, entry })),
    )
    .filter(
      ({ entry }) =>
        entry.children.filter((child) => child.href).length >=
        4,
    )
    .map(({ treeKey, entry }) => ({
      key: `${treeKey}:${entry.key}`,
      label: entry.label,
      renderLink: entry.href ? (child: ReactElement) => <Link href={entry.href!} asChild>{child}</Link> : undefined,
      children: entry.children
        .filter((child) => child.href)
        .slice(0, 4)
        .map((child) => ({
          key: child.key,
          label: child.label,
          imageUrl: child.imageUrl,
          renderLink: (content: ReactElement) => <Link href={child.href!} asChild>{content}</Link>,
        })),
    }));
  return (
    <CategoryMosaicShelf
      groups={groups}
      accessibilityLabel={t("nav.explore")}
    />
  );
}
