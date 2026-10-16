import type { ReactElement, ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { ShopDetailIcon } from './ShopDetailIcon';
import { Text } from '../ui/text';
import { useColorScheme } from '../../lib/useColorScheme';

/** Trailing chevron icon size (px). */
const CHEVRON_ICON_SIZE = 20;

export interface SectionHeaderProps {
  title: string;
  /** Use renderLink for navigation and onPress for an action. */
  renderLink?: (child: ReactElement) => ReactNode;
  onPress?: () => void;
  showChevron?: boolean;
  /** False when Bloom's Carousel header already owns the inset and spacing. */
  inset?: boolean;
  chevronPosition?: 'end' | 'after-title';
}

/**
 * Shared responsive shelf heading, optionally linked with a circular chevron.
 * The chevron can sit beside the title or at the row's end. Bloom carousel
 * headers own their padding; standalone headings keep the default inset.
 */
export function SectionHeader({
  title,
  onPress,
  renderLink,
  showChevron = false,
  inset = true,
  chevronPosition = 'end',
}: SectionHeaderProps) {
  const { colors } = useColorScheme();

  // Plain branch — matches the existing shelf heading exactly.
  if (!renderLink && !onPress && !showChevron) {
    return (
      <Text
        accessibilityRole="header"
        className={`${inset ? 'px-4 pb-3 md:px-5' : ''} text-shop-subtitle text-foreground md:text-shop-sectionTitle`}
      >
        {title}
      </Text>
    );
  }

  const inner = (
    <>
      <Text
        accessibilityRole="header"
        className={`${chevronPosition === 'end' ? 'flex-1' : 'shrink'} text-shop-subtitle text-foreground md:text-shop-sectionTitle`}
      >
        {title}
      </Text>
      {showChevron ? (
        <View className="h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-full bg-black/[0.04] dark:bg-white/[0.06]">
          <ShopDetailIcon name="chevron" size={CHEVRON_ICON_SIZE} color={colors.foreground} />
        </View>
      ) : null}
    </>
  );

  if (renderLink || onPress) {
    const control = (
      <Pressable
        accessibilityRole={renderLink ? 'link' : 'button'}
        accessibilityLabel={title}
        onPress={onPress}
        className={`flex-row items-center gap-2 ${inset ? 'justify-between px-4 pb-3 md:px-5' : ''}`}
      >
        {inner}
      </Pressable>
    );
    return renderLink ? renderLink(control) : control;
  }

  return (
    <View
      className={`flex-row items-center gap-2 ${inset ? 'justify-between px-4 pb-3 md:px-5' : ''}`}
    >
      {inner}
    </View>
  );
}
