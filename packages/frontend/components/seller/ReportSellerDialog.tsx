import { useState } from "react";
import { Pressable, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { toast } from "@oxyhq/bloom/toast";
import { openAccountDialog, useOxy } from "@oxyhq/services";
import {
  ABUSE_REPORT_CATEGORIES,
  type AbuseReportCategory,
} from "@mercaria/shared-types";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Text,
  Textarea,
} from "@mercaria/ui";
import { submitAbuseReport } from "@/lib/api/reports";
import { useTranslation } from "@/lib/i18n";

/**
 * Report a SELLER — the moderation flow, not a trust one (#92 public-route
 * rule 8).
 *
 * `POST /reports` with `reportedType: 'seller'` is the correct destination and
 * the only one. Mercaria's report intake stores the row durably; whether it
 * also leaves for CrowdSource is decided server-side by the subject-provider
 * registry, and `seller` deliberately has no provider today — a `SellerProfile`
 * carries no user-authored identity to pin into a case snapshot, and a case
 * naming an object only Oxy can act on would open in the wrong tenant.
 *
 * That distinction is invisible here ON PURPOSE. The server's receipt does not
 * say whether a report will be reviewed, because a reporter who learns that a
 * noun is not wired to a jury has learned what is not watched — an invitation
 * to route around it. So the confirmation says "we have it" and never promises
 * an outcome.
 *
 * Reporting Oxy-side ABUSE by the person (not by their selling) belongs to Oxy's
 * own report and block surfaces, which the account dialog reaches; duplicating
 * them here would create a second place to block somebody that Oxy's graph does
 * not know about.
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

export function ReportSellerDialog({
  oxyUserId,
  displayName,
  open,
  onOpenChange,
}: {
  oxyUserId: string;
  displayName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { isAuthenticated } = useOxy();
  const [selected, setSelected] = useState<AbuseReportCategory[]>([]);
  const [details, setDetails] = useState("");

  const submit = useMutation({
    mutationFn: () =>
      submitAbuseReport({
        reportedType: "seller",
        reportedId: oxyUserId,
        categories: selected,
        ...(details.trim() ? { details: details.trim() } : {}),
      }),
    onSuccess: () => {
      // "Received", never "reviewed" — see the header.
      toast.success(t("sellers.report.received"));
      setSelected([]);
      setDetails("");
      onOpenChange(false);
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-4">
        <DialogHeader>
          <DialogTitle>{t("sellers.report.title", { name: displayName })}</DialogTitle>
          <DialogDescription>{t("sellers.report.description")}</DialogDescription>
        </DialogHeader>

        {isAuthenticated ? (
          <>
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
                      active ? "border-foreground bg-secondary" : "border-border"
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
              onChangeText={setDetails}
              maxLength={MAX_DETAILS}
              placeholder={t("sellers.report.detailsPlaceholder")}
              className="min-h-24"
            />

            <DialogFooter>
              <Button
                variant="default"
                disabled={selected.length === 0 || submit.isPending}
                onPress={() => submit.mutate()}
              >
                <Text>
                  {submit.isPending ? t("sellers.report.sending") : t("sellers.report.send")}
                </Text>
              </Button>
            </DialogFooter>
          </>
        ) : (
          // A report is attributed to its reporter server-side, so there is
          // nothing to send without a session — and the honest affordance is the
          // one that gets them one rather than a form that would 401 on submit.
          <DialogFooter>
            <Button variant="default" onPress={() => openAccountDialog()}>
              <Text>{t("sellers.report.signIn")}</Text>
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
