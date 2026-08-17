import React from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Check, CloudOff, RefreshCw, TriangleAlert } from "lucide-react-native";
import { Text, useColorScheme } from "@mercaria/ui";
import { useTranslation } from "@/lib/i18n";
import type { WizardStepId } from "@/lib/authoring/findings";
import { STEP_LABEL_KEYS } from "@/lib/authoring/labels";
import type { StepCompleteness } from "@/lib/authoring/wizard-state";
import type { SaveState } from "@/lib/authoring/use-draft-wizard";

interface StepNavProps {
  readonly steps: readonly WizardStepId[];
  readonly current: WizardStepId;
  readonly onSelect: (step: WizardStepId) => void;
  readonly completeness: (step: WizardStepId) => StepCompleteness;
}

/**
 * The step rail.
 *
 * Every step is reachable at any time — a wizard that locks you out of step
 * four until step three is perfect is one you cannot use to check what step
 * four is going to ask for. Completeness is shown instead of enforced, and the
 * publish is what enforces.
 *
 * It scrolls horizontally, so six steps fit a phone without becoming three
 * lines of wrapped chips.
 */
export function StepNav({ steps, current, onSelect, completeness }: StepNavProps) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-2 pb-1"
      className="mb-4"
    >
      {steps.map((step, index) => {
        const state = completeness(step);
        const done = state.total > 0 && state.blocked === 0;
        const isCurrent = step === current;
        return (
          <Pressable
            key={step}
            accessibilityRole="tab"
            accessibilityState={{ selected: isCurrent }}
            accessibilityLabel={t(STEP_LABEL_KEYS[step])}
            onPress={() => onSelect(step)}
            className={[
              "flex-row items-center gap-2 rounded-full border px-3 py-2",
              isCurrent ? "border-primary bg-muted" : "border-border",
            ].join(" ")}
          >
            <Text
              className={
                isCurrent
                  ? "text-sm font-semibold text-foreground"
                  : "text-sm text-muted-foreground"
              }
            >
              {index + 1}. {t(STEP_LABEL_KEYS[step])}
            </Text>
            {done ? <Check size={14} color={colors.primary} /> : null}
            {!done && state.total > 0 ? (
              <Text className="text-xs text-muted-foreground">
                {state.answered}/{state.total}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

interface SaveStateBadgeProps {
  readonly state: SaveState;
  readonly onRetry: () => void;
  readonly onReload: () => void;
}

/**
 * What autosave is doing, said out loud.
 *
 * Six states rather than a spinner, because "we have not saved yet" and "we
 * tried and could not" are different things to tell somebody about to close the
 * tab — and because the remedy differs: a failure retries the same body, a
 * conflict cannot and offers a re-read instead.
 */
export function SaveStateBadge({ state, onRetry, onReload }: SaveStateBadgeProps) {
  const { t } = useTranslation();
  const { colors } = useColorScheme();

  if (state === "conflict") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("products.wizard.save.reload")}
        onPress={onReload}
        className="flex-row items-center gap-1.5 active:opacity-70"
      >
        <TriangleAlert size={14} color={colors.mutedForeground} />
        <Text className="text-xs font-medium text-destructive">
          {t("products.wizard.save.conflict")}
        </Text>
      </Pressable>
    );
  }
  if (state === "failed") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("products.wizard.save.retry")}
        onPress={onRetry}
        className="flex-row items-center gap-1.5 active:opacity-70"
      >
        <CloudOff size={14} color={colors.mutedForeground} />
        <Text className="text-xs font-medium text-destructive">
          {t("products.wizard.save.failed")}
        </Text>
      </Pressable>
    );
  }
  if (state === "saving") {
    return (
      <View className="flex-row items-center gap-1.5">
        <RefreshCw size={14} color={colors.mutedForeground} />
        <Text className="text-xs text-muted-foreground">{t("products.wizard.save.saving")}</Text>
      </View>
    );
  }
  if (state === "unsaved") {
    return (
      <Text className="text-xs text-muted-foreground">{t("products.wizard.save.unsaved")}</Text>
    );
  }
  if (state === "saved") {
    return (
      <View className="flex-row items-center gap-1.5">
        <Check size={14} color={colors.primary} />
        <Text className="text-xs text-muted-foreground">{t("products.wizard.save.saved")}</Text>
      </View>
    );
  }
  return <Text className="text-xs text-muted-foreground">{t("products.wizard.save.idle")}</Text>;
}
