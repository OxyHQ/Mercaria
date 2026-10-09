import { Pressable, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { Carousel, CarouselItem } from "@oxy.so/bloom/carousel";
import { LinearGradient } from "expo-linear-gradient";
import { Text } from "../ui/text";
import { SectionHeader } from "./SectionHeader";
import { useShelfCarouselProps } from "../../lib/shelf-carousel";
import { categoryImageSource } from "../../lib/shop-category-images";

export interface CategoryMosaicItem {
  key: string;
  label: string;
  imageUrl?: string;
  onPress: () => void;
}
export interface CategoryMosaicGroup {
  key: string;
  label: string;
  onPress?: () => void;
  children: CategoryMosaicItem[];
}
/** Four independent category links in each 330px merchandising tile. */
export function CategoryMosaicShelf({
  groups,
  accessibilityLabel,
}: {
  groups: CategoryMosaicGroup[];
  accessibilityLabel: string;
}) {
  const shelf = useShelfCarouselProps();
  const { width } = useWindowDimensions();
  if (!groups.length) return null;
  return (
    <View testID="category-mosaic-shelf" className="mb-3 md:mb-6">
      <Carousel
        {...shelf}
        testID="home-category-carousel"
        accessibilityLabel={accessibilityLabel}
        arrowsPlacement="overlay"
        showArrows={shelf.showArrows && width >= 640}
      >
        {groups.map((group) => (
          <CarouselItem key={group.key} width={330}>
            <View className="gap-3 pb-8 xl:gap-4 xl:pb-[38px]">
              <SectionHeader
                title={group.label}
                onPress={group.onPress}
                showChevron={Boolean(group.onPress)}
                chevronPosition="after-title"
                inset={false}
              />
              <View
                testID="category-mosaic"
                className="overflow-hidden rounded-[20px] bg-card web:shadow-md xl:rounded-[28px]"
                style={{ aspectRatio: width >= 1280 ? 374 / 340 : 1 }}
              >
                <View
                  pointerEvents="none"
                  className="absolute inset-0 z-10 rounded-[20px] border-[0.5px] border-black/10 dark:border-white/15 xl:rounded-[28px]"
                />
                {[0, 1].map((row) => (
                  <View
                    key={row}
                    className={`flex-1 flex-row gap-0.5 ${row ? "mt-0.5" : ""}`}
                  >
                    {group.children.slice(row * 2, row * 2 + 2).map((item) => (
                      <Pressable
                        key={item.key}
                        accessibilityRole="link"
                        accessibilityLabel={item.label}
                        onPress={item.onPress}
                        className="group relative flex-1 justify-end overflow-hidden bg-muted"
                      >
                        {item.imageUrl ? (
                          <Image
                            source={categoryImageSource(item.imageUrl)}
                            contentFit="cover"
                            className="absolute inset-0 h-full w-full web:transition-transform web:duration-150 web:group-hover:scale-110 web:motion-reduce:transition-none web:motion-reduce:transform-none"
                          />
                        ) : null}
                        <LinearGradient
                          colors={["transparent", "rgba(0,0,0,0.25)"]}
                          className="absolute inset-0"
                          pointerEvents="none"
                        />
                        <Text className="m-2 text-xs font-bold leading-tight text-white xl:m-3 xl:text-sm">
                          {item.label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ))}
              </View>
            </View>
          </CarouselItem>
        ))}
      </Carousel>
    </View>
  );
}
