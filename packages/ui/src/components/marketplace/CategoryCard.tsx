import { View, Pressable } from "react-native";
import { Image } from "expo-image";
import { ChevronRight } from "lucide-react-native";
import { Text } from "../ui/text";
import { useColorScheme } from "../../lib/useColorScheme";
import type { Category, CategoryTile } from "@mercaria/shared-types";

/** Diameter (px) of the header's circular chevron affordance. */
const CHEVRON_CIRCLE_SIZE = 30;
/** Chevron icon size (px). */
const CHEVRON_ICON_SIZE = 20;
/** White inverse label over a tile image (documented allowed constant). */
const LABEL_COLOR = "#FFFFFF";
/**
 * Square grid-card edge length (px), matching the carousel slot width. Set
 * explicitly (rather than via `aspect-square`) so the 2×2 rows and cells always
 * resolve to a concrete height — an absolute-fill tile image needs a sized
 * parent to render into.
 */
const GRID_SIZE = 330;

export interface CategoryCardProps {
  category: Category;
  onPressCategory?: (id: string, slug: string) => void;
  onPressTile?: (categoryId: string, tile: CategoryTile) => void;
}

/**
 * A category carousel item: a header link (name + circular chevron) above a
 * square card holding a 2×2 grid of subcategory tiles. Each tile bleeds a cover
 * image with a bottom-left white label (text-shadowed for legibility over any
 * image), and is its OWN sibling link.
 *
 * No nested interactives: the card root is a plain `View`; the header is one
 * link; each grid tile is a separate sibling link (never nested inside another),
 * so web renders no `<a>`/`<button>` inside another.
 */
export function CategoryCard({
  category,
  onPressCategory,
  onPressTile,
}: CategoryCardProps) {
  const { colors } = useColorScheme();
  // Defensive: tolerate a partial/in-transition category payload.
  const tiles = category.subcategories ?? [];

  return (
    <View className="w-full">
      {/* Header — a single link to the category. */}
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`Browse ${category.name}`}
        onPress={() => onPressCategory?.(category.id, category.slug)}
        className="flex-row items-center gap-2 px-1"
      >
        <Text className="text-xl font-bold text-foreground" numberOfLines={1}>
          {category.name}
        </Text>
        <View
          className="items-center justify-center rounded-full bg-secondary"
          style={{ height: CHEVRON_CIRCLE_SIZE, width: CHEVRON_CIRCLE_SIZE }}
        >
          <ChevronRight size={CHEVRON_ICON_SIZE} color={colors.foreground} />
        </View>
      </Pressable>

      {/* Grid card — fixed square, holds the 2×2 grid of tile links. */}
      <View
        className="mt-3 w-full overflow-hidden rounded-2xl bg-card"
        style={{ height: GRID_SIZE }}
      >
        <View className="h-full w-full gap-0.5">
          {/* Row 1 */}
          <View className="flex-1 flex-row gap-0.5">
            <CategoryTileCell
              categoryId={category.id}
              tile={tiles[0]}
              onPressTile={onPressTile}
            />
            <CategoryTileCell
              categoryId={category.id}
              tile={tiles[1]}
              onPressTile={onPressTile}
            />
          </View>
          {/* Row 2 */}
          <View className="flex-1 flex-row gap-0.5">
            <CategoryTileCell
              categoryId={category.id}
              tile={tiles[2]}
              onPressTile={onPressTile}
            />
            <CategoryTileCell
              categoryId={category.id}
              tile={tiles[3]}
              onPressTile={onPressTile}
            />
          </View>
        </View>

        {/* 1px inset border over the grid card (non-interactive). */}
        <View
          pointerEvents="none"
          className="absolute inset-0 rounded-2xl border border-border"
        />
      </View>
    </View>
  );
}

interface CategoryTileCellProps {
  categoryId: string;
  tile: CategoryTile | undefined;
  onPressTile?: (categoryId: string, tile: CategoryTile) => void;
}

/**
 * One grid cell: a sibling link bleeding the tile cover with a bottom-left
 * white label. Renders a muted fill when the tile is absent (partial payload)
 * so the grid never collapses. Per-tile `group` so the image scales on hover
 * on web only.
 */
function CategoryTileCell({
  categoryId,
  tile,
  onPressTile,
}: CategoryTileCellProps) {
  if (!tile) {
    return <View className="flex-1 bg-secondary" />;
  }
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={tile.name}
      onPress={() => onPressTile?.(categoryId, tile)}
      className="group relative flex-1 overflow-hidden bg-secondary"
    >
      <Image
        source={{ uri: tile.imageUrl }}
        contentFit="cover"
        className="absolute inset-0 h-full w-full web:transition-transform web:duration-300 web:group-hover:scale-110"
      />
      <View className="absolute inset-0 justify-end p-2">
        <Text
          numberOfLines={1}
          className="text-[13px] font-bold"
          style={{
            color: LABEL_COLOR,
            textShadowColor: "rgba(0,0,0,0.5)",
            textShadowOffset: { width: 0, height: 1 },
            textShadowRadius: 3,
          }}
        >
          {tile.name}
        </Text>
      </View>
    </Pressable>
  );
}
