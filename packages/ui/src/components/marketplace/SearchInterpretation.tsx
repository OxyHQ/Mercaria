import { Pressable, Text, View } from "react-native";
import { X } from "lucide-react-native";
import { useColorScheme } from "../../lib/useColorScheme";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import {
  SEARCH_CHIP_KEY,
  SEARCH_CHIP_PREFERENCE_KEY,
  SEARCH_CHIP_REMOVE_KEY,
  SEARCH_MODE_MODEL_KEY,
  SEARCH_MODE_RULES_KEY,
} from "../../lib/marketplace-labels";
import { cn } from "../../lib/cn";

/**
 * What Mercaria understood from a natural-language search (#95 client rules
 * 2–4 and 7).
 *
 * PRESENTATIONAL: DTOs in, classes out. It fetches nothing, routes nowhere and
 * decides nothing — which is why the "remove" affordance is a CALLBACK rather
 * than a mutation. Whether removing a chip re-parses, re-searches or does both
 * is the app's decision, and a component that made it would make the same
 * decision for the dashboard and the POS.
 *
 * ## The three voices are the point
 *
 * `origin` is not decoration. #95 clarification rule 6 says the system must
 * never pretend a model inference was explicitly stated by the user, and the
 * backend carries an origin on every interpreted element precisely so a client
 * can render three different voices. Collapsing them into one chip style is the
 * one change to this file that would break that rule, so the styling is keyed
 * on `origin` directly and the labels say which is which.
 *
 * ## An element the shopper did not state is REMOVABLE; one they did is not
 *
 * A filter somebody selected themselves is removed where they selected it. A
 * chip offering to undo it here would be a second control for one fact, and the
 * two would disagree the moment one of them was re-rendered from stale state.
 */

/** Where one interpreted element came from. Mirrors `IntentElementOrigin`. */
export type InterpretationOrigin =
  | "user_explicit"
  | "deterministic_rule"
  | "model_inferred";

/** One interpreted element, as a chip. */
export interface InterpretationChip {
  /** The constraint, budget or preference id — what a removal names. */
  readonly id: string;
  /** One short line a shopper reads. Composed by the server, never by a model. */
  readonly label: string;
  readonly origin: InterpretationOrigin;
  /** Whether this element excludes products, or only leans. */
  readonly strength: "hard" | "preference";
  /** Whether the shopper may drop it in one tap. */
  readonly editable: boolean;
}

/** One thing Mercaria could not use, and why. */
export interface InterpretationGap {
  readonly id: string;
  /** The shopper's own words, bounded by the server. */
  readonly phrase: string;
  /** One sentence composed by the server. */
  readonly explanation: string;
}

export interface SearchInterpretationProps {
  /** The paraphrase lines, in the order the server composed them. */
  readonly paraphrase: readonly { readonly id: string; readonly text: string; readonly origin: InterpretationOrigin }[];
  readonly chips: readonly InterpretationChip[];
  /** Phrases reported unresolved — never hidden (#95 client rule 4). */
  readonly gaps: readonly InterpretationGap[];
  /** Which interpreter produced this. Shown, because the two differ in kind. */
  readonly mode: "model" | "deterministic";
  /** Remove one interpreted element. */
  readonly onRemove: (chipId: string) => void;
  /** Drop the whole interpretation and search the raw text (#95 client rule 5). */
  readonly onDismiss: () => void;
  /** Accessible label for the dismiss control. The app owns its language. */
  readonly dismissLabel: string;
}

/** The chip styling for each origin. See the module docblock. */
const ORIGIN_CLASSES: Readonly<Record<InterpretationOrigin, string>> = {
  user_explicit: "bg-primary/10 border-primary/30",
  deterministic_rule: "bg-muted border-border",
  model_inferred: "border-dashed bg-muted/50 border-border",
};

/** One word naming the voice, so the distinction survives a screen reader. */
const ORIGIN_LABELS: Readonly<Record<InterpretationOrigin, string>> = {
  user_explicit: "you asked for",
  deterministic_rule: "we read",
  model_inferred: "we guessed",
};

export function SearchInterpretation({
  paraphrase,
  chips,
  gaps,
  mode,
  onRemove,
  onDismiss,
  dismissLabel,
}: SearchInterpretationProps) {
  const { colors } = useColorScheme();
  const t = useSharedUiTranslation();
  if (paraphrase.length === 0 && chips.length === 0 && gaps.length === 0) return null;

  return (
    <View className="w-full rounded-2xl border border-border bg-card p-4">
      {/* The paraphrase FIRST and above the chips — #95 client rule 3 asks for
          the understanding before or with results, and a chip row alone is a
          filter bar rather than an explanation. */}
      <View className="gap-1">
        {paraphrase.map((line) => (
          <Text
            key={line.id}
            className={cn(
              "text-sm",
              line.origin === "model_inferred" ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {line.text}
          </Text>
        ))}
      </View>

      {chips.length > 0 ? (
        <View className="mt-3 flex-row flex-wrap gap-2">
          {chips.map((chip) => (
            <View
              key={chip.id}
              className={cn(
                "flex-row items-center gap-1.5 rounded-full border px-3 py-1.5",
                ORIGIN_CLASSES[chip.origin],
              )}
            >
              <Text className="text-xs text-foreground">
                {/* A preference does not exclude anything, and a shopper
                    correcting an interpretation needs to know which of their
                    requirements is actually narrowing the results. Two WHOLE
                    frames rather than a glued ` · preference`, whose separator
                    was inside the fragment. */}
                {t(
                  chip.strength === "preference" ? SEARCH_CHIP_PREFERENCE_KEY : SEARCH_CHIP_KEY,
                  { label: chip.label },
                )}
              </Text>
              {chip.editable ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t(SEARCH_CHIP_REMOVE_KEY, {
                    origin: ORIGIN_LABELS[chip.origin],
                    label: chip.label,
                  })}
                  hitSlop={8}
                  onPress={() => onRemove(chip.id)}
                >
                  <X size={12} color={colors.mutedForeground} />
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {gaps.length > 0 ? (
        <View className="mt-3 gap-1 border-t border-border pt-3">
          {gaps.map((gap) => (
            <Text key={gap.id} className="text-xs text-muted-foreground">
              {gap.explanation}
            </Text>
          ))}
        </View>
      ) : null}

      <View className="mt-3 flex-row items-center justify-between">
        <Text className="text-[11px] text-muted-foreground">
          {t(mode === "model" ? SEARCH_MODE_MODEL_KEY : SEARCH_MODE_RULES_KEY)}
        </Text>
        <Pressable accessibilityRole="button" onPress={onDismiss} hitSlop={8}>
          <Text className="text-xs font-medium text-primary">{dismissLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export interface SearchClarificationProps {
  readonly question: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly onAnswer: (optionId: string) => void;
  /** "Search anyway" — always present, never a dead end (#95 clarification 8). */
  readonly onSkip: () => void;
  readonly skipLabel: string;
}

/**
 * One clarification, with its bounded options and an always-present escape.
 *
 * There is no free-text answer field, matching the wire contract: an answer
 * names an OPTION, so a second round of natural language cannot enter through
 * the clarification path and bypass the parse budget. A shopper who wants to say
 * something else edits the query, which is an ordinary new interpretation.
 */
export function SearchClarification({
  question,
  options,
  onAnswer,
  onSkip,
  skipLabel,
}: SearchClarificationProps) {
  return (
    <View className="mt-3 w-full rounded-2xl border border-border bg-muted/40 p-4">
      <Text className="text-sm font-medium text-foreground">{question}</Text>
      <View className="mt-3 flex-row flex-wrap gap-2">
        {options.map((option) => (
          <Pressable
            key={option.id}
            accessibilityRole="button"
            className="rounded-full border border-border bg-card px-3 py-1.5"
            onPress={() => onAnswer(option.id)}
          >
            <Text className="text-xs text-foreground">{option.label}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable accessibilityRole="button" className="mt-3" onPress={onSkip} hitSlop={8}>
        <Text className="text-xs font-medium text-primary">{skipLabel}</Text>
      </Pressable>
    </View>
  );
}
