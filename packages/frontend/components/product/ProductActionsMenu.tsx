import { Pressable } from "react-native";
import { CircleAlert, MoreHorizontal } from "lucide-react-native";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@oxy.so/bloom/dropdown-menu";
import { useDialogControl } from "@oxy.so/bloom/dialog";
import { Text } from "@mercaria/ui";
import { AbuseReportDialog } from "@/components/reports/AbuseReportDialog";
import { useTranslation } from "@/lib/i18n";

/** Actions belong to the displayed listing, including a person's secondhand item.
 * Contact is omitted until the public catalog carries published contact details.
 * Canonical products are not moderation listing subjects and cannot use this menu.
 */
export function ProductActionsMenu({ listingId, title }: { listingId: string; title: string }) {
  const { t } = useTranslation();
  const reportControl = useDialogControl();

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild label={t("product.moreActions")}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("product.moreActions")}
            hitSlop={8}
            className="min-h-11 min-w-11 items-center justify-center rounded-full border border-border-image bg-bg-fill lg:-my-1.5 lg:border-0 lg:bg-transparent web:hover:bg-muted active:bg-muted"
          >
            <MoreHorizontal size={24} className="text-text-tertiary" />
          </Pressable>
        </DropdownMenuTrigger>
        <DropdownMenuContent label={t("product.moreActions")} align="end" minWidth={224}>
          <DropdownMenuItem
            variant="destructive"
            leading={<CircleAlert size={24} className="text-destructive" />}
            accessibilityLabel={t("product.reportProduct")}
            onPress={reportControl.open}
          >
            <Text className="text-base leading-[22px] tracking-[-0.5px] text-destructive">
              {t("product.reportProduct")}
            </Text>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AbuseReportDialog
        key={listingId}
        reportedType="listing"
        reportedId={listingId}
        displayName={title}
        control={reportControl}
      />
    </>
  );
}
