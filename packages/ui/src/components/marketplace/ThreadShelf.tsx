import { Pressable, View, useWindowDimensions } from 'react-native';
import { Carousel, CarouselItem } from '@oxy.so/bloom/carousel';
import { Text } from '../ui/text';
import { SectionHeader } from './SectionHeader';
import { ShopDetailIcon } from './ShopDetailIcon';
import { useShelfCarouselProps } from '../../lib/shelf-carousel';
import { useColorScheme } from '../../lib/useColorScheme';

export interface ThreadShelfItem {
  id: string;
  title: string;
  dateLabel: string;
}
export function ThreadShelf({
  title,
  items,
  onPress,
}: {
  title: string;
  items: ThreadShelfItem[];
  onPress: (id: string) => void;
}) {
  const shelf = useShelfCarouselProps();
  const { width } = useWindowDimensions();
  const { colors } = useColorScheme();
  if (!items.length) return null;
  return (
    <View className="mb-3 md:mb-6" testID="thread-shelf">
      <Carousel
        {...shelf}
        showArrows={false}
        style={{ gap: 16 }}
        accessibilityLabel={title}
        header={<SectionHeader title={title} inset={false} />}
      >
        {items.map((item) => (
          <CarouselItem key={item.id} width={width >= 768 ? 289 : 239}>
            <Pressable
              testID="feed-thread-card"
              accessibilityRole="link"
              accessibilityLabel={item.title}
              onPress={() => onPress(item.id)}
              className="relative flex-row items-center gap-3 rounded-[20px] bg-card p-2 web:transition-all web:duration-200 web:hover:bg-muted active:scale-[0.98] web:motion-reduce:transition-none"
              style={{ boxShadow: '0px 2px 8px rgba(0,0,0,0.06)' }}
            >
              <View
                pointerEvents="none"
                className="absolute inset-0 rounded-[20px] border-[0.5px] border-black/10 dark:border-white/15"
              />
              <View className="h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-card web:shadow-sm">
                <ShopDetailIcon name="thread" size={16} color={colors.mutedForeground} />
              </View>
              <View className="min-w-0 flex-1">
                <Text numberOfLines={1} className="text-sm leading-[18px]">
                  {item.title}
                </Text>
                <Text className="text-[10px] leading-[14px] text-muted-foreground">
                  {item.dateLabel}
                </Text>
              </View>
            </Pressable>
          </CarouselItem>
        ))}
      </Carousel>
    </View>
  );
}
