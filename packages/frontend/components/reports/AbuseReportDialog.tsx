import { useState } from "react";
import { Pressable, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { toast } from "@oxy.so/bloom/toast";
import { openAccountDialog, useOxy } from "@oxy.so/services";
import {
  ABUSE_REPORT_CATEGORIES,
  type AbuseReportCategory,
  type AbuseReportedType,
} from "@mercaria/shared-types";
import { Dialog, type DialogControlProps } from "@oxy.so/bloom/dialog";
import { Text } from "@mercaria/ui";
import { Textarea } from "@oxy.so/bloom/textarea";
import { submitAbuseReport } from "@/lib/api/reports";
import { useTranslation } from "@/lib/i18n";

/**
 * One abuse-report form for listings, reviews, sellers and stores, using the existing POST /reports
 * intake. A successful receipt means stored, never a promised moderation outcome.
 * The subject id belongs to its declared type: Oxy user id for a seller, Mercaria
 * store id for a store, listing id for a product offer, review id for a review.
 * Identity enforcement remains with Oxy.
 */

/**
 * Reader-facing wording for each category. Plain, and never an accusation.
 *
 * KEYS rather than sentences: this is module scope, so a `t()` here would run
 * before the locale store rehydrates and freeze whichever language loaded first.
 * Each key is a literal so the i18n guard can see it is referenced.
 */
const CATEGORY_LABEL_KEYS: Readonly<Record<AbuseReportCategory, string>> = {
  counterfeit: "sellers.report.category.counterfeit",
  prohibited_item: "sellers.report.category.prohibitedItem",
  misleading_listing: "sellers.report.category.misleadingListing",
  unsafe_product: "sellers.report.category.unsafeProduct",
  stolen_goods: "sellers.report.category.stolenGoods",
  scam: "sellers.report.category.scam",
  impersonation: "sellers.report.category.impersonation",
  spam: "sellers.report.category.spam",
  hateful_content: "sellers.report.category.hatefulContent",
  // `somethingElse`, not `other`: a leaf whose last segment is a CLDR plural
  // category makes its PARENT look pluralised to the bundle tooling, which
  // reads `sellers.report.category` as a resolvable key that is really an
  // object.
  other: "sellers.report.category.somethingElse",
};
Object.freeze(CATEGORY_LABEL_KEYS);

/** Matches the server's `details` bound, so the counter cannot promise more than it takes. */
const MAX_DETAILS = 2000;

export function AbuseReportDialog({
  reportedType,
  reportedId,
  displayName,
  control,
}: {
  reportedType: AbuseReportedType;
  reportedId: string;
  displayName: string;
  control: DialogControlProps;
}) {
  const { t } = useTranslation();
  const { isAuthenticated } = useOxy();
  const [selected, setSelected] = useState<AbuseReportCategory[]>([]);
  const [details, setDetails] = useState("");

  const submit = useMutation({
    mutationFn: () =>
      submitAbuseReport({
        reportedType,
        reportedId,
        categories: selected,
        ...(details.trim() ? { details: details.trim() } : {}),
      }),
    onSuccess: () => {
      // "Received", never "reviewed" — see the header.
      toast.success(t("sellers.report.received"));
      setSelected([]);
      setDetails("");
      control.close();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const toggle = (category: AbuseReportCategory) => {
    setSelected((current) =>
      current.includes(category)
        ? current.filter((value) => value !== category)
        : [...current, category],
    );
  };

  return (
    <Dialog
      control={control}
      title={t("sellers.report.title", { name: displayName })}
      description={t("sellers.report.description")}
      actions={
        isAuthenticated
          ? [
              {
                label: submit.isPending
                  ? t("sellers.report.sending")
                  : t("sellers.report.send"),
                disabled: selected.length === 0 || submit.isPending,
                // Stays open while the report is in flight; `onSuccess` closes it,
                // and a failure leaves the reader's choices where they were.
                shouldCloseOnPress: false,
                onPress: () => submit.mutate(),
              },
            ]
          : [
              // A report is attributed to its reporter server-side, so there is
              // nothing to send without a session — and the honest affordance is
              // the one that gets them one rather than a form that would 401 on
              // submit.
              {
                label: t("sellers.report.signIn"),
                onPress: () => openAccountDialog(),
              },
            ]
      }
    >
      {isAuthenticated ? (
        <View className="gap-4 pb-4">
          <View className="flex-row flex-wrap gap-2">
            {ABUSE_REPORT_CATEGORIES.map((category) => {
              const active = selected.includes(category);
              return (
                <Pressable
                  key={category}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: active }}
                  accessibilityLabel={t(CATEGORY_LABEL_KEYS[category])}
                  onPress={() => toggle(category)}
                  className={`rounded-full border px-4 py-2 ${
                    active ? "border-foreground bg-muted" : "border-border"
                  }`}
                >
                  <Text className="text-sm text-foreground">
                    {t(CATEGORY_LABEL_KEYS[category])}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Textarea
            value={details}
            onValueChange={setDetails}
            maxLength={MAX_DETAILS}
            placeholder={t("sellers.report.detailsPlaceholder")}
            rows={4}
            autoResize
          />
        </View>
      ) : null}
    </Dialog>
  );
}
