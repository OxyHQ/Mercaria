import { Pressable, View } from "react-native";
import type {
  Money,
  ShoppingAgentFinding,
  ShoppingAgentSelectedLine,
} from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { PriceDisplay } from "../PriceDisplay";
import { conditionGroupLabelKey } from "../../lib/condition";
import { useSharedUiLocale, useSharedUiTranslation } from "../../i18n/ui-translation";
import { formatDateTime } from "../../lib/date";
import { formatMoney } from "../../lib/format";
import {
  SHOPPING_AGENT_COMPLETENESS_LABEL_KEYS,
  SHOPPING_AGENT_DELIVERY_FAILURE_KEYS,
  SHOPPING_AGENT_FRESHNESS_LABEL_KEYS,
  SHOPPING_AGENT_INCOMPLETE_REASON_KEYS,
  SHOPPING_AGENT_LIFECYCLE_EXPLANATION_KEYS,
  SHOPPING_AGENT_LIFECYCLE_LABEL_KEYS,
  SHOPPING_AGENT_NOTIFICATION_CHANNEL_LABEL_KEYS,
  SHOPPING_AGENT_NOTIFICATION_STATE_LABEL_KEYS,
  SHOPPING_AGENT_OBSERVATION_DISCLAIMER_KEY,
  SHOPPING_AGENT_OPTIMALITY_LABEL_KEYS,
  SHOPPING_AGENT_OUTCOME_EXPLANATION_KEYS,
  SHOPPING_AGENT_OUTCOME_LABEL_KEYS,
  SHOPPING_AGENT_SUMMARY_SOURCE_KEYS,
  SHOPPING_AGENT_SUPPRESSION_REASON_KEYS,
  SHOPPING_AGENT_TRIGGER_SOURCE_LABEL_KEYS,
} from "../../lib/shopping-agent-labels";

export interface ShoppingAgentFindingCardProps {
  finding: ShoppingAgentFinding;
  /**
   * The agent's own constraint explanations, keyed by constraint id.
   *
   * A finding cites requirement IDS, and the sentence belonging to each one is
   * composed once on the constraint set. Handing the map in rather than storing
   * a copy on the finding is what keeps ONE description of a requirement.
   */
  constraintExplanations?: Readonly<Record<string, string>>;
  onOpenProduct?: (canonicalProductId: string) => void;
}

/**
 * One appended observation about one agent (#97 UX rules 3, 4 and 7).
 *
 * ## A superseded or invalidated finding is SHOWN, and labelled as such
 *
 * Findings are append-only: a correction supersedes rather than rewriting, and
 * nothing is removed to tidy a history. So the lifecycle is rendered on every
 * row with the sentence saying why the row is still here — hiding the non-current
 * ones would make the timeline agree with whatever the latest look happened to
 * say, which is the one thing an append-only record exists to prevent.
 *
 * ## What is UNKNOWN is rendered beside what was satisfied
 *
 * `unknownConstraintIds` is not a smaller version of `failedConstraintIds`: a
 * requirement nobody could answer and a requirement that was answered "no" send
 * a shopper to opposite places, and a card that showed only the second would
 * report a confident verdict over missing data. UX rule 4 is those two lists
 * plus the summary's own sentences.
 *
 * ## The summary renders whatever produced it
 *
 * `source === 'deterministic_template'` is the NORMAL case (no provider is
 * registered anywhere), so nothing here is gated on a model having been
 * involved — the source only decides which provenance sentence sits under the
 * text (UX rule 10).
 */
export function ShoppingAgentFindingCard({
  finding,
  constraintExplanations,
  onOpenProduct,
}: ShoppingAgentFindingCardProps) {
  const locale = useSharedUiLocale();
  const t = useSharedUiTranslation();
  const recordLabels: Record<string, string> = {};
  for (const record of finding.records) {
    if (record.label !== undefined) recordLabels[record.ref] = record.label;
  }
  // Bound to a const so the union narrows inside the callbacks below; narrowing
  // a property access across a closure boundary is not something to lean on.
  const summary = finding.summary;
  const evaluatedAt = formatDateTime(finding.evaluatedAt, locale);

  return (
    <View className="gap-space-8 rounded-radius-16 border border-border-secondary bg-bg-fill p-space-12">
      <View className="gap-space-4">
        <Text className="text-bodyTitleSmall text-text">
          {t(SHOPPING_AGENT_OUTCOME_LABEL_KEYS[finding.outcome])} ·{" "}
          {t(SHOPPING_AGENT_LIFECYCLE_LABEL_KEYS[finding.lifecycle])}
        </Text>
        {/* The trigger source is a complete phrase on its own, so an
            unformattable instant drops the timestamp AND the separator rather
            than leaving a dangling middot. */}
        <Text className="text-caption text-text-tertiary">
          {evaluatedAt === null ? null : `${evaluatedAt} · `}
          {t(SHOPPING_AGENT_TRIGGER_SOURCE_LABEL_KEYS[finding.triggerSource])}
        </Text>
        <Text className="text-caption text-text-tertiary">
          {t(SHOPPING_AGENT_OUTCOME_EXPLANATION_KEYS[finding.outcome])}
        </Text>
        {/* UX rule 3 — a superseded or invalidated observation says so itself. */}
        {finding.lifecycle === "current" ? null : (
          <Text className="text-caption text-text-tertiary">
            {t(SHOPPING_AGENT_LIFECYCLE_EXPLANATION_KEYS[finding.lifecycle])}
          </Text>
        )}
      </View>

      {finding.objectiveValue ? (
        <View className="flex-row items-center gap-space-4">
          <PriceDisplay
            price={finding.objectiveValue}
            primaryClassName="text-bodyTitleSmall text-text"
          />
          {finding.objectiveDelta ? (
            <Text className="text-caption text-text-tertiary">
              {describeDelta(finding.objectiveDelta, locale)}
            </Text>
          ) : (
            <Text className="text-caption text-text-tertiary">
              nothing earlier to compare it against
            </Text>
          )}
        </View>
      ) : null}

      {/* UX rule 4, first half — WHY, in the sentences the finding itself carries. */}
      {summary && summary.sentences.length > 0 ? (
        <View className="gap-space-4">
          {summary.sentences.map((sentence, index) => (
            <Text key={`${index}-${sentence.text}`} className="text-caption text-text">
              {sentence.text}
            </Text>
          ))}
          <Text className="text-caption text-text-tertiary">
            {t(SHOPPING_AGENT_SUMMARY_SOURCE_KEYS[summary.source])}
          </Text>
        </View>
      ) : null}

      {/* UX rule 4, second half — what was met, and what nobody could answer. */}
      <Text className="text-caption text-text-tertiary">
        {finding.satisfiedConstraintIds.length} requirement(s) met ·{" "}
        {finding.failedConstraintIds.length} not met ·{" "}
        {finding.unknownConstraintIds.length} still unknown
      </Text>
      {finding.unknownConstraintIds.length > 0 ? (
        <View className="gap-space-4 rounded-radius-12 bg-bg-fill-secondary p-space-8">
          <Text className="text-caption text-text">
            Nobody could answer {finding.unknownConstraintIds.length} of your requirements, so this
            is not a complete verdict.
          </Text>
          {finding.unknownConstraintIds.map((constraintId) => (
            <Text key={constraintId} className="text-caption text-text-secondary">
              {constraintExplanations?.[constraintId] ?? constraintId}
            </Text>
          ))}
        </View>
      ) : null}

      {finding.incompleteReasons.length > 0 ? (
        <View className="gap-space-4">
          {finding.incompleteReasons.map((reason) => (
            <Text key={reason} className="text-caption text-text-secondary">
              {t(SHOPPING_AGENT_INCOMPLETE_REASON_KEYS[reason])}
            </Text>
          ))}
        </View>
      ) : null}

      <Text className="text-caption text-text-tertiary">
        {t(SHOPPING_AGENT_COMPLETENESS_LABEL_KEYS[finding.completeness])} ·{" "}
        {t(SHOPPING_AGENT_FRESHNESS_LABEL_KEYS[finding.freshness])}
        {finding.optimality ? ` · ${t(SHOPPING_AGENT_OPTIMALITY_LABEL_KEYS[finding.optimality])}` : ""}
      </Text>

      {finding.selection.length > 0 ? (
        <View className="gap-space-4">
          <Text className="text-caption text-text-tertiary">What it looked at</Text>
          {finding.selection.map((line) => (
            <SelectedLineRow
              key={line.lineId}
              line={line}
              label={recordLabels[line.offerRef]}
              onOpenProduct={onOpenProduct}
            />
          ))}
        </View>
      ) : null}

      {finding.notifications.length > 0 ? (
        <View className="gap-space-4">
          {finding.notifications.map((notification) => (
            <Text key={notification.id} className="text-caption text-text-tertiary">
              {t(SHOPPING_AGENT_NOTIFICATION_CHANNEL_LABEL_KEYS[notification.channel])}:{" "}
              {t(SHOPPING_AGENT_NOTIFICATION_STATE_LABEL_KEYS[notification.state])}
              {notification.suppressionReason
                ? ` — ${t(SHOPPING_AGENT_SUPPRESSION_REASON_KEYS[notification.suppressionReason])}`
                : ""}
              {notification.failureReason
                ? ` — ${t(SHOPPING_AGENT_DELIVERY_FAILURE_KEYS[notification.failureReason])}`
                : ""}
            </Text>
          ))}
        </View>
      ) : null}

      {/* UX rule 7 — beside the figure, because that is where the misreading is. */}
      <Text className="text-caption text-text-tertiary">
        {t(SHOPPING_AGENT_OBSERVATION_DISCLAIMER_KEY)}
      </Text>
    </View>
  );
}

function SelectedLineRow({
  line,
  label,
  onOpenProduct,
}: {
  line: ShoppingAgentSelectedLine;
  label?: string;
  onOpenProduct?: (canonicalProductId: string) => void;
}) {
  const t = useSharedUiTranslation();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? "Open this product"}
      onPress={() => onOpenProduct?.(line.canonicalProductId)}
      className="gap-space-4"
    >
      <Text className="text-caption text-text-secondary" numberOfLines={1}>
        {line.quantity} × {label ?? line.canonicalProductId}
      </Text>
      <View className="flex-row items-center gap-space-4">
        {line.unitItemPrice ? (
          <PriceDisplay price={line.unitItemPrice} primaryClassName="text-caption text-text" />
        ) : null}
        {line.conditionGroup ? (
          <Text className="text-caption text-text-tertiary">
            {t(conditionGroupLabelKey(line.conditionGroup))}
          </Text>
        ) : null}
        {line.officialChannel ? (
          <Text className="text-caption text-text-tertiary">verified official channel</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * How the objective moved against the previous comparable finding.
 *
 * Negative is cheaper, and the SIGN is rendered as a word rather than left on
 * the number: `formatMoney` puts the minus after the currency symbol, which
 * reads as a strange price rather than as a direction of travel.
 */
function describeDelta(delta: Money, locale: string): string {
  if (delta.amount === 0) return "unchanged since the last look";
  const magnitude = formatMoney({ amount: Math.abs(delta.amount), currency: delta.currency }, locale);
  return delta.amount < 0 ? `${magnitude} lower than before` : `${magnitude} higher than before`;
}
