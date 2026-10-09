import { useState } from "react";
import { ScrollView, View } from "react-native";
import { Button } from "@oxy.so/bloom/button";
import { Rating } from "@oxy.so/bloom/rating";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
} from "@oxy.so/bloom/dropdown-menu";
import { REVIEW_SORT_ORDERS, type ReviewSortOrder } from "@mercaria/shared-types";
import { Text, useColorScheme, useFormatters } from "@mercaria/ui";
import { ChevronDown } from "lucide-react-native";
import { useTranslation } from "@/lib/i18n";

const SORT_LABELS: Record<ReviewSortOrder, string> = {
  newest: "reviews.filters.newest",
  oldest: "reviews.filters.oldest",
  rating_asc: "reviews.filters.ratingAscending",
  rating_desc: "reviews.filters.ratingDescending",
};

/** Shop's horizontal review filter pills, using Bloom's menu semantics. */
export function ReviewFilters({ sortBy, ratings, onSortChange, onRatingsChange }: {
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
  const sortActive = sortOpen || sortBy !== "newest";
  const ratingActive = ratingOpen || ratings.length > 0;
  const pillClassName = "h-space-40 rounded-radius-max border-[0.5px] px-space-16 py-space-8 shadow-shop-s";
  const activeClassName = "border-transparent bg-[#121212] dark:bg-white";
  const inactiveClassName = "border-[#05294d1a] bg-[#f2f4f5] dark:border-[#ffffff26] dark:bg-[#2a2a2a]";
  const footer = (resetDisabled: boolean, applyDisabled: boolean, reset: () => void, apply: () => void) => (
    <View className="flex-row gap-space-8 pt-space-12">
      <DropdownMenuItem keepOpen className="h-space-40 flex-1 rounded-radius-max" style={{ backgroundColor: isDarkColorScheme ? "#2a2a2a" : "#f2f4f5" }} disabled={resetDisabled} onPress={reset}>{t("reviews.filters.reset")}</DropdownMenuItem>
      <DropdownMenuItem className="h-space-40 flex-1 rounded-radius-max" style={{ backgroundColor: isDarkColorScheme ? "#ffffff" : "#121212" }} accessibilityLabel={t("reviews.filters.apply")} disabled={applyDisabled} onPress={apply}>
        <Text className="text-shop-buttonMedium text-white dark:text-black">{t("reviews.filters.apply")}</Text>
      </DropdownMenuItem>
    </View>
  );
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} testID="review-filters">
      <View className="flex-row gap-space-8">
        <DropdownMenu open={sortOpen} onOpenChange={(open) => { setDraftSort(sortBy); setSortOpen(open); }}>
          <DropdownMenuTrigger asChild label={t("reviews.filters.sort")}>
            <Button material="flat" className={`${pillClassName} ${sortActive ? activeClassName : inactiveClassName}`} accessibilityLabel={t("reviews.filters.sort")}>
              <View className="flex-row items-center gap-space-8">
                <Text className={`text-shop-buttonMedium ${sortActive ? "text-white dark:text-black" : "text-text"}`}>{t("reviews.filters.sort")}</Text>
                <ChevronDown size={16} className={sortActive ? "text-white dark:text-black" : "text-text"} />
              </View>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent label={t("reviews.filters.sort")} minWidth={300} maxWidth={300} className="rounded-radius-28 bg-white px-space-12 pt-space-8 pb-space-12 dark:bg-[#121212]">
            <DropdownMenuRadioGroup value={draftSort} onValueChange={(value) => {
              const order = REVIEW_SORT_ORDERS.find((candidate) => candidate === value);
              if (order) setDraftSort(order);
            }}>
              {REVIEW_SORT_ORDERS.map((order) => (
                <DropdownMenuRadioItem key={order} value={order} keepOpen>{t(SORT_LABELS[order])}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            {footer(draftSort === "newest", draftSort === sortBy,
              () => setDraftSort("newest"),
              () => { onSortChange(draftSort); setSortOpen(false); })}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu open={ratingOpen} onOpenChange={(open) => { setDraftRatings(ratings); setRatingOpen(open); }}>
          <DropdownMenuTrigger asChild label={t("reviews.filters.rating")}>
            <Button material="flat" className={`${pillClassName} ${ratingActive ? activeClassName : inactiveClassName}`} accessibilityLabel={t("reviews.filters.rating")}>
              <View className="flex-row items-center gap-space-8">
                <Text className={`text-shop-buttonMedium ${ratingActive ? "text-white dark:text-black" : "text-text"}`}>
                  {t("reviews.filters.rating")}
                </Text>
                <ChevronDown size={16} className={ratingActive ? "text-white dark:text-black" : "text-text"} />
              </View>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent label={t("reviews.filters.rating")} minWidth={300} maxWidth={300} className="rounded-radius-28 bg-white px-space-12 pt-space-8 pb-space-12 dark:bg-[#121212]">
            {[5, 4, 3, 2, 1].map((rating) => (
              <DropdownMenuCheckboxItem key={rating} keepOpen checked={draftRatings.includes(rating)}
                accessibilityLabel={t("reviews.filters.stars", { count: rating })}
                onCheckedChange={(checked) => setDraftRatings(checked
                  ? [...draftRatings, rating].sort()
                  : draftRatings.filter((value) => value !== rating))}>
                <View className="flex-row items-center gap-space-8" pointerEvents="none">
                  <Rating value={rating} variant="stars" showValue={false} starSize={16} color={isDarkColorScheme ? "#ffffff" : "#000000"} />
                  <Text className="text-shop-bodySmall text-text">{formatReviewCount(rating)}</Text>
                </View>
              </DropdownMenuCheckboxItem>
            ))}
            {footer(draftRatings.length === 0, draftRatings.join(",") === ratings.join(","),
              () => setDraftRatings([]),
              () => { onRatingsChange(draftRatings); setRatingOpen(false); })}
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
    </ScrollView>
  );
}
