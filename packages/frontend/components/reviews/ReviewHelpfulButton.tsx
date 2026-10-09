import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { Button } from "@oxy.so/bloom/button";
import { useTheme } from "@oxy.so/bloom/theme";
import { toast } from "@oxy.so/bloom/toast";
import { openAccountDialog, useOxy } from "@oxy.so/services";
import type { Review, ReviewHelpfulness } from "@mercaria/shared-types";
import { Text, useFormatters } from "@mercaria/ui";
import { useUpdateReviewHelpfulness } from "@/lib/hooks/use-reviews";
import { useTranslation } from "@/lib/i18n";

/** Shop's public thumbs-up vector (Icon-BkBmvYUf.js), rendered at its 16px size. */
function HelpfulIcon({ color }: { color?: string }) {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" color={color ?? "currentColor"}>
      <Path d="M7 11H3V20H7M7 11V20M7 11L11 3H11.6156C12.843 3 13.7808 4.09535 13.5917 5.3081L13.0161 9H18.0631C19.8811 9 21.2813 10.6041 21.0356 12.4053L20.3538 17.4053C20.1511 18.8918 18.8815 20 17.3813 20H7" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
    </Svg>
  );
}

export function ReviewHelpfulButton({ review, vote, iconColor }: {
  review: Review;
  vote?: ReviewHelpfulness;
  iconColor?: string;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { formatReviewCount } = useFormatters();
  const { isAuthenticated, canUsePrivateApi } = useOxy();
  const mutation = useUpdateReviewHelpfulness(review.id);
  const personalVote = isAuthenticated ? vote : undefined;
  const count = personalVote?.helpfulnessCount ?? review.helpfulnessCount ?? 0;
  const marked = personalVote?.markedAsHelpfulByMe ?? false;
  const readOnly = isAuthenticated && vote?.canUpdateHelpfulness === false;
  const textClass = marked ? "text-text" : "text-text-tertiary";
  const label = t(marked ? "reviews.helpful.remove" : "reviews.helpful.mark");
  const countLabel = count > 0 ? t("reviews.helpful.count", { formattedCount: formatReviewCount(count) }) : "";
  const content = (
    <View className={`flex-row items-center gap-space-4 ${textClass}`}>
      <HelpfulIcon color={iconColor ?? (marked ? colors.text : colors.textTertiary)} />
      <Text className={`text-shop-captionMedium ${textClass}`} style={iconColor ? { color: iconColor } : undefined}>
        {t("reviews.helpful.label")}
      </Text>
      {count > 0 ? (
        <View className="rounded-radius-max bg-bg-fill-secondary px-space-6 py-space-2">
          <Text testID="review-helpful-count" className="text-shop-badgeBold text-text-tertiary">
            {formatReviewCount(count)}
          </Text>
        </View>
      ) : null}
    </View>
  );
  if (readOnly) return <View accessible accessibilityLabel={countLabel ? `${t("reviews.helpful.label")}. ${countLabel}` : t("reviews.helpful.label")}>{content}</View>;
  return (
    <Button
      testID={`review-helpful-${review.id}`}
      material="flat" appearance="plain" size="sm"
      className="min-h-0 min-w-0 rounded-radius-max bg-transparent p-0 web:hover:bg-transparent"
      hitSlop={10}
      pressed={marked}
      accessibilityLabel={countLabel ? `${label}. ${countLabel}` : label}
      disabled={mutation.isPending || (isAuthenticated && (!canUsePrivateApi || !vote))}
      onPress={() => {
        if (!isAuthenticated) { openAccountDialog(); return; }
        mutation.mutate(!marked, { onError: () => toast.error(t("reviews.helpful.error")) });
      }}
    >
      {content}
    </Button>
  );
}
