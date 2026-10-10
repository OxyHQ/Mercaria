import { useState, type ReactNode } from 'react';
import { Platform, ScrollView, View, useWindowDimensions } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { Checkbox } from '@oxy.so/bloom/checkbox';
import { RadioGroup } from '@oxy.so/bloom/radio';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Rating } from '@oxy.so/bloom/rating';
import { surfaceStyle } from '@oxy.so/bloom/shapes';
import { useIsRtl } from '@oxy.so/bloom/hooks';
import { Popover, PopoverTrigger, PopoverContent } from '@oxy.so/bloom/popover';
import { REVIEW_SORT_ORDERS, type ReviewSortOrder } from '@mercaria/shared-types';
import { Text, useColorScheme, useFormatters } from '@mercaria/ui';
import { ChevronDown } from 'lucide-react-native';
import { useTranslation } from '@/lib/i18n';

const SORT_LABELS: Record<ReviewSortOrder, string> = {
  newest: 'reviews.filters.newest',
  oldest: 'reviews.filters.oldest',
  rating_asc: 'reviews.filters.ratingAscending',
  rating_desc: 'reviews.filters.ratingDescending',
};

/** The same form opens beside its trigger on desktop and in a sheet on mobile. */
function ReviewFilterPanel({
  label,
  open,
  active,
  onOpenChange,
  children,
  footer,
}: {
  label: string;
  open: boolean;
  active: boolean;
  onOpenChange: (value: boolean) => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const { width, height } = useWindowDimensions();
  const { isDarkColorScheme } = useColorScheme();
  const rtl = useIsRtl();
  const panelFill = isDarkColorScheme ? '#121212' : '#ffffff';
  const desktop = Platform.OS === 'web' && width >= 768;
  const trigger = (
    <Button
      material="flat"
      className={`h-space-40 rounded-radius-max border-[0.5px] ps-space-16 pe-space-8 py-space-8 shadow-shop-s ${
        active
          ? 'border-transparent bg-[#121212] dark:bg-white'
          : 'border-[#05294d1a] bg-[#f2f4f5] dark:border-[#ffffff26] dark:bg-[#2a2a2a]'
      }`}
      accessibilityLabel={label}
      aria-expanded={open}
      aria-haspopup="dialog"
      onPress={desktop ? undefined : () => onOpenChange(true)}
    >
      <View className="flex-row items-center gap-space-4">
        <Text
          className={`text-shop-buttonMedium ${active ? 'text-white dark:text-black' : 'text-text'}`}
        >
          {label}
        </Text>
        <ChevronDown size={16} className={active ? 'text-white dark:text-black' : 'text-text'} />
      </View>
    </Button>
  );
  const content = (
    <View className={desktop ? 'gap-space-12' : 'gap-space-12 px-space-16 pb-space-16'}>
      <ScrollView
        style={{ maxHeight: desktop ? 300 : Math.max(100, height * 0.5), flexGrow: 0 }}
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
      {footer}
    </View>
  );
  return desktop ? (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild label={label}>
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        material="flat"
        style={[surfaceStyle({ curve: 'round' }), { backgroundColor: panelFill }]}
        label={label}
        side="bottom"
        align={rtl ? 'end' : 'start'}
        sideOffset={5}
        minWidth={300}
        maxWidth={300}
        testID="review-filter-panel"
        className="rounded-radius-28 border-[0.5px] border-border-image bg-white px-space-12 pt-space-8 pb-space-12 shadow-shop-s dark:bg-[#121212]"
      >
        {content}
      </PopoverContent>
    </Popover>
  ) : (
    <View>
      {trigger}
      <Dialog
        material="flat"
        panelStyle={{ backgroundColor: panelFill }}
        open={open}
        onClose={() => onOpenChange(false)}
        placement="bottom"
        label={label}
        header={{ title: label, largeTitle: false }}
        contentPadding={0}
        scrollable={false}
        maxHeightRatio={0.9}
        testID="review-filter-panel"
      >
        {content}
      </Dialog>
    </View>
  );
}

/** Review filter forms keep edits local until Apply, on every screen size. */
export function ReviewFilters({
  sortBy,
  ratings,
  onSortChange,
  onRatingsChange,
}: {
  sortBy: ReviewSortOrder;
  ratings: number[];
  onSortChange: (value: ReviewSortOrder) => void;
  onRatingsChange: (value: number[]) => void;
}) {
  const { t } = useTranslation();
  const { isDarkColorScheme } = useColorScheme();
  const { formatReviewCount } = useFormatters();
  const [sortOpen, setSortOpen] = useState(false);
  const [ratingOpen, setRatingOpen] = useState(false);
  const [draftSort, setDraftSort] = useState(sortBy);
  const [draftRatings, setDraftRatings] = useState(ratings);
  const footer = (
    resetDisabled: boolean,
    applyDisabled: boolean,
    reset: () => void,
    apply: () => void,
  ) => (
    <View className="flex-row gap-space-8">
      <Button
        material="flat"
        className="h-space-40 flex-1 rounded-radius-max border-0 bg-[#f2f4f5] dark:bg-[#2a2a2a]"
        disabled={resetDisabled}
        onPress={reset}
        accessibilityLabel={t('reviews.filters.reset')}
      >
        <Text className="text-shop-buttonMedium text-text">{t('reviews.filters.reset')}</Text>
      </Button>
      <Button
        material="flat"
        className="h-space-40 flex-1 rounded-radius-max border-0 bg-[#121212] dark:bg-white"
        disabled={applyDisabled}
        onPress={apply}
        accessibilityLabel={t('reviews.filters.apply')}
      >
        <Text className="text-shop-buttonMedium text-white dark:text-black">
          {t('reviews.filters.apply')}
        </Text>
      </Button>
    </View>
  );
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} testID="review-filters">
      <View className="flex-row gap-space-8">
        <ReviewFilterPanel
          label={t('reviews.filters.sort')}
          open={sortOpen}
          active={sortOpen || sortBy !== 'newest'}
          onOpenChange={(open) => {
            setDraftSort(sortBy);
            setSortOpen(open);
          }}
          footer={footer(
            draftSort === 'newest',
            draftSort === sortBy,
            () => setDraftSort('newest'),
            () => {
              onSortChange(draftSort);
              setSortOpen(false);
            },
          )}
        >
          <RadioGroup
            label={t('reviews.filters.sort')}
            value={draftSort}
            onValueChange={setDraftSort}
            tone="neutral"
            labelStyle={{ fontSize: 14, lineHeight: 20 }}
            optionStyle={{ minHeight: 44, paddingHorizontal: 12, paddingVertical: 8 }}
            options={REVIEW_SORT_ORDERS.map((order) => ({
              value: order,
              label: t(SORT_LABELS[order]),
            }))}
          />
        </ReviewFilterPanel>
        <ReviewFilterPanel
          label={t('reviews.filters.rating')}
          open={ratingOpen}
          active={ratingOpen || ratings.length > 0}
          onOpenChange={(open) => {
            setDraftRatings(ratings);
            setRatingOpen(open);
          }}
          footer={footer(
            draftRatings.length === 0,
            draftRatings.join(',') === ratings.join(','),
            () => setDraftRatings([]),
            () => {
              onRatingsChange(draftRatings);
              setRatingOpen(false);
            },
          )}
        >
          {[5, 4, 3, 2, 1].map((rating) => (
            <Checkbox
              key={rating}
              checked={draftRatings.includes(rating)}
              tone="neutral"
              style={{ minHeight: 44, paddingHorizontal: 12, paddingVertical: 8 }}
              label={t('reviews.filters.stars', { count: rating })}
              labelContent={
                <View className="flex-row items-center gap-space-8">
                  <Rating
                    value={rating}
                    variant="stars"
                    showValue={false}
                    starSize={16}
                    color={isDarkColorScheme ? '#ffffff' : '#000000'}
                  />
                  <Text className="text-shop-bodySmall text-text">{formatReviewCount(rating)}</Text>
                </View>
              }
              onCheckedChange={(checked) =>
                setDraftRatings(
                  checked
                    ? [...draftRatings, rating].sort()
                    : draftRatings.filter((value) => value !== rating),
                )
              }
            />
          ))}
        </ReviewFilterPanel>
      </View>
    </ScrollView>
  );
}
