import React from "react";
import { Pressable, View } from "react-native";
import { AlertTriangle, CircleAlert } from "lucide-react-native";
import { Text, useColorScheme } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";
import { findingMessageKey, type LocatedFinding } from "@/lib/authoring/findings";
import { STEP_LABEL_KEYS } from "@/lib/authoring/labels";

interface ErrorSummaryProps {
  readonly findings: readonly LocatedFinding[];
  /**
   * Jump to one finding. The WHOLE finding, not just its step: the step is what
   * every platform can act on and the anchor is what web adds, and splitting
   * them would put the second decision in a component that has no reason to
   * make it.
   */
  readonly onNavigate: (finding: LocatedFinding) => void;
}

/**
 * Everything blocking the publish, in one list, each line a link to the step
 * that owns it.
 *
 * ## Errors and warnings in ONE list
 *
 * `error` blocks publication and `warning` does not, and both are shown
 * together because that split is what makes `recommended` a real requirement
 * level: a recommended field left empty is reported, visibly, and still
 * publishes. Hiding the warnings would make `recommended` a synonym for
 * `optional`.
 *
 * ## Every line is actionable
 *
 * A finding whose path this app cannot parse still appears — attached to the
 * review step rather than to a control — because a publish that fails for a
 * reason nobody is shown is the failure this summary exists to prevent.
 *
 * The heading carries `accessibilityRole="alert"` so a screen reader announces
 * the count when a validation lands, which is the moment the author needs it.
 */
export function ErrorSummary({ findings, onNavigate }: ErrorSummaryProps) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  if (findings.length === 0) return null;

  const errors = findings.filter((finding) => finding.severity === "error");
  const warnings = findings.filter((finding) => finding.severity === "warning");

  return (
    <View className="gap-2 rounded-2xl border border-border bg-surface p-4">
      <View className="flex-row items-center gap-2">
        {errors.length > 0 ? (
          <CircleAlert size={16} color={colors.mutedForeground} />
        ) : (
          <AlertTriangle size={16} color={colors.mutedForeground} />
        )}
        <Text
          accessibilityRole="alert"
          className="flex-1 text-sm font-semibold text-foreground"
        >
          {errors.length > 0
            ? t("products.wizard.summary.errors", { count: errors.length })
            : t("products.wizard.summary.warnings", { count: warnings.length })}
        </Text>
      </View>

      <View className="gap-1">
        {findings.map((finding, index) => (
          <Pressable
            key={`${finding.code}-${finding.path}-${index}`}
            accessibilityRole="link"
            accessibilityLabel={t(findingMessageKey(finding.code))}
            onPress={() => onNavigate(finding)}
            className="flex-row items-start gap-2 rounded-lg px-1 py-1 active:bg-muted"
          >
            <Text
              className={
                finding.severity === "error"
                  ? "text-xs font-semibold text-destructive"
                  : "text-xs font-semibold text-muted-foreground"
              }
            >
              {t(STEP_LABEL_KEYS[finding.step])}
            </Text>
            <Text className="flex-1 text-xs text-foreground">
              {t(findingMessageKey(finding.code))}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
