import { MoreHorizontal, CircleAlert } from "lucide-react-native";
import { Button } from "@oxy.so/bloom/button";
import { useDialogControl } from "@oxy.so/bloom/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@oxy.so/bloom/dropdown-menu";
import type { Review } from "@mercaria/shared-types";
import { Text, useSharedUiTranslation } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";
import { AbuseReportDialog } from "./AbuseReportDialog";

/** The moderation subject is the review itself, never its product or author. */
export function ReviewActionsMenu({ review, iconColor }: { review: Review; iconColor?: string }) {
  const { t } = useTranslation();
  const control = useDialogControl();
  const uiT = useSharedUiTranslation();
  const subject = t("reviews.actions.subject", {
    author: review.author?.displayName ?? uiT("ui.review.fallbackAuthor"),
  });
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild label={t("reviews.actions.more")}>
          <Button material="flat" appearance="plain" size="sm" iconOnly
            accessibilityLabel={t("reviews.actions.more")}
            testID={`review-actions-${review.id}`}
            className="size-space-24 min-h-0 min-w-0 rounded-radius-max p-0"
            hitSlop={10}
          >
            <MoreHorizontal size={20} color={iconColor} className={iconColor ? undefined : "text-text-tertiary"} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent label={t("reviews.actions.more")} align="end" minWidth={224}>
          <DropdownMenuItem variant="destructive" onPress={control.open}
            accessibilityLabel={t("reviews.actions.report")}
            leading={<CircleAlert size={20} className="text-destructive" />}
          >
            <Text className="text-shop-bodySmall text-destructive">{t("reviews.actions.report")}</Text>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AbuseReportDialog reportedType="review" reportedId={review.id} displayName={subject} control={control} />
    </>
  );
}
