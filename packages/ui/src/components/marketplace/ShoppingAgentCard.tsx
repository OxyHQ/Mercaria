import { Pressable, View } from "react-native";
import { Bell, BellOff, ChevronDown, ChevronRight, RefreshCw, Trash2 } from "lucide-react-native";
import type {
  ProductConstraint,
  ShoppingAgent,
  ShoppingAgentSplitResolution,
} from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { PriceDisplay } from "../PriceDisplay";
import { conditionGroupLabelKey } from "../../lib/condition";
import { useSharedUiLocale, useSharedUiTranslation } from "../../i18n/ui-translation";
import { formatDateTime } from "../../lib/date";
import { useFormatters } from "../../lib/use-formatters";
import {
  SHOPPING_AGENT_CARD_ANY_CONDITION_KEY,
  SHOPPING_AGENT_CARD_CHANNEL_SEPARATOR_KEY,
  SHOPPING_AGENT_CARD_CONSTRAINT_HARD_KEY,
  SHOPPING_AGENT_CARD_CONSTRAINT_SOFT_KEY,
  SHOPPING_AGENT_CARD_HIDE_FINDINGS_KEY,
  SHOPPING_AGENT_CARD_IN_MARKET_KEY,
  SHOPPING_AGENT_CARD_KEEP_SOURCE_KEY,
  SHOPPING_AGENT_CARD_LAST_LOOKED_KEY,
  SHOPPING_AGENT_CARD_LAST_LOOKED_NEXT_KEY,
  SHOPPING_AGENT_CARD_LINE_KEY,
  SHOPPING_AGENT_CARD_MERCHANTS_EXCLUDED_KEY,
  SHOPPING_AGENT_CARD_MOVE_TO_TARGET_KEY,
  SHOPPING_AGENT_CARD_NEVER_LOOKED_KEY,
  SHOPPING_AGENT_CARD_NEVER_LOOKED_NEXT_KEY,
  SHOPPING_AGENT_CARD_NO_CHANNELS_KEY,
  SHOPPING_AGENT_CARD_NOTIFY_POLICY_KEY,
  SHOPPING_AGENT_CARD_NOTIFY_POLICY_QUIET_KEY,
  SHOPPING_AGENT_CARD_OPEN_PRODUCT_KEY,
  SHOPPING_AGENT_CARD_PAUSE_A11Y_KEY,
  SHOPPING_AGENT_CARD_PAUSE_KEY,
  SHOPPING_AGENT_CARD_PRICED_IN_KEY,
  SHOPPING_AGENT_CARD_REMOVE_A11Y_KEY,
  SHOPPING_AGENT_CARD_REMOVE_KEY,
  SHOPPING_AGENT_CARD_REQUIREMENTS_KEY,
  SHOPPING_AGENT_CARD_RESUME_A11Y_KEY,
  SHOPPING_AGENT_CARD_RESUME_KEY,
  SHOPPING_AGENT_CARD_RUN_NOW_A11Y_KEY,
  SHOPPING_AGENT_CARD_RUN_NOW_KEY,
  SHOPPING_AGENT_CARD_SCOPE_SEPARATOR_KEY,
  SHOPPING_AGENT_CARD_SHOW_FINDINGS_KEY,
  SHOPPING_AGENT_CARD_SPLIT_EXPLANATION_KEY,
  SHOPPING_AGENT_CARD_SPLIT_MOVES_A11Y_KEY,
  SHOPPING_AGENT_CARD_SPLIT_MOVES_KEY,
  SHOPPING_AGENT_CARD_SPLIT_STAYS_A11Y_KEY,
  SHOPPING_AGENT_CARD_SPLIT_STAYS_KEY,
  SHOPPING_AGENT_CARD_TARGET_PREFIX_KEY,
  SHOPPING_AGENT_CARD_WATCHING_KEY,
  SHOPPING_AGENT_CHANNEL_POLICY_LABEL_KEYS,
  SHOPPING_AGENT_JOB_EXPLANATION_KEYS,
  SHOPPING_AGENT_JOB_LABEL_KEYS,
  SHOPPING_AGENT_NOTIFICATION_CHANNEL_LABEL_KEYS,
  SHOPPING_AGENT_PRICE_BASIS_LABEL_KEYS,
  SHOPPING_AGENT_STATE_LABEL_KEYS,
} from "../../lib/shopping-agent-labels";

/** Icon size for the row's trailing affordances. */
const ICON_SIZE = 18;
/** Icon size for the open/closed marker on the header. */
const CHEVRON_SIZE = 16;

const MINUTES_PER_HOUR = 60;
/** Two digits, so `7:5` never renders where `07:05` was meant. */
const CLOCK_PAD = 2;

export interface ShoppingAgentCardProps {
  agent: ShoppingAgent;
  /** Whether the caller is showing this agent's findings underneath it. */
  expanded?: boolean;
  onToggleExpanded?: (agent: ShoppingAgent) => void;
  onPause?: (agent: ShoppingAgent) => void;
  onResume?: (agent: ShoppingAgent) => void;
  onDelete?: (agent: ShoppingAgent) => void;
  /** Ask for one evaluation now. Offered only while the agent is watching. */
  onRunNow?: (agent: ShoppingAgent) => void;
  /** Answer a catalogue split. Only ever called for an agent blocked by one. */
  onResolveSplit?: (agent: ShoppingAgent, resolution: ShoppingAgentSplitResolution) => void;
  /** Open one of the products this agent watches, or one split candidate. */
  onOpenProduct?: (canonicalProductId: string) => void;
  /** Disables the controls while one of the caller's writes is in flight. */
  busy?: boolean;
}

/**
 * One saved shopping agent (#97 UX rules 2, 5 and 8).
 *
 * ## Everything that decides an answer is ON the row
 *
 * The objective, the currency, the market, the seller scope, the condition
 * segments, the notification policy AND every active constraint with its own
 * one-line explanation. UX rule 2 asks for exactly that, and the reason is the
 * same one #79 records for a price alert: a row that showed only "under €500"
 * leaves a shopper unable to explain why the €480 one they can see did not
 * reach them.
 *
 * ## A blocked agent is a QUESTION, and it is the only way out
 *
 * A catalogue split divided the product this agent watched, and only the shopper
 * can say which half they meant. So a blocked agent renders the two candidates
 * and the two answers, and renders NO resume control — resuming would be an
 * answer to an ambiguity nobody resolved, which is precisely why `blocked` is a
 * different state from `paused` in the first place.
 *
 * ## This card has no control that could act on a shopper's behalf
 *
 * A saved agent watches and tells. Pause, resume, remove, ask for one look now
 * and answer a split are the whole of what any control here does, and there is
 * no branch, prop or callback through which a further one could be added without
 * changing this file's public shape.
 */
export function ShoppingAgentCard({
  agent,
  expanded,
  onToggleExpanded,
  onPause,
  onResume,
  onDelete,
  onRunNow,
  onResolveSplit,
  onOpenProduct,
  busy,
}: ShoppingAgentCardProps) {
  const t = useSharedUiTranslation();
  const locale = useSharedUiLocale();
  const { formatDuration } = useFormatters();
  const lastLooked =
    agent.lastEvaluatedAt === undefined ? null : formatDateTime(agent.lastEvaluatedAt, locale);
  const nextScheduled =
    agent.nextScheduledAt === undefined ? null : formatDateTime(agent.nextScheduledAt, locale);
  const ambiguous =
    agent.state === "blocked" && agent.ambiguityState === "ambiguous_after_split";
  const segments =
    agent.conditionGroups.length === 0
      ? t(SHOPPING_AGENT_CARD_ANY_CONDITION_KEY)
      : agent.conditionGroups
          .map((group) => t(conditionGroupLabelKey(group)))
          .join(t(SHOPPING_AGENT_CARD_CHANNEL_SEPARATOR_KEY));
  const scopeParts = [
    t(SHOPPING_AGENT_CARD_PRICED_IN_KEY, { currency: agent.displayCurrency }),
    t(SHOPPING_AGENT_CHANNEL_POLICY_LABEL_KEYS[agent.channelPolicy]),
    segments,
    agent.market ? t(SHOPPING_AGENT_CARD_IN_MARKET_KEY, { market: agent.market }) : undefined,
    agent.excludedMerchantIds.length > 0
      ? t(SHOPPING_AGENT_CARD_MERCHANTS_EXCLUDED_KEY, {
          merchants: agent.excludedMerchantIds.length,
        })
      : undefined,
  ].filter((part): part is string => part !== undefined);

  const channels =
    agent.notificationChannels.length === 0
      ? t(SHOPPING_AGENT_CARD_NO_CHANNELS_KEY)
      : agent.notificationChannels
          .map((channel) => t(SHOPPING_AGENT_NOTIFICATION_CHANNEL_LABEL_KEYS[channel]))
          .join(t(SHOPPING_AGENT_CARD_CHANNEL_SEPARATOR_KEY));

  const constraints = agent.constraints.constraints;
  const sourceProductId = agent.lines[0]?.canonicalProductId;

  return (
    <View className="gap-space-8 rounded-radius-16 border border-border-secondary bg-bg-fill p-space-12">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t(
          expanded
            ? SHOPPING_AGENT_CARD_HIDE_FINDINGS_KEY
            : SHOPPING_AGENT_CARD_SHOW_FINDINGS_KEY,
          { name: agent.name },
        )}
        onPress={() => onToggleExpanded?.(agent)}
        className="flex-row items-start gap-space-8"
      >
        <View className="flex-1 gap-space-4">
          <Text className="text-bodyTitleSmall text-text" numberOfLines={2}>
            {agent.name}
          </Text>
          <Text className="text-caption text-text-tertiary">
            {t(SHOPPING_AGENT_JOB_LABEL_KEYS[agent.kind])} · {t(SHOPPING_AGENT_STATE_LABEL_KEYS[agent.state])}
          </Text>
        </View>
        {expanded ? (
          <ChevronDown size={CHEVRON_SIZE} className="text-text-tertiary" />
        ) : (
          <ChevronRight size={CHEVRON_SIZE} className="text-text-tertiary" />
        )}
      </Pressable>

      {agent.description ? (
        <Text className="text-caption text-text-tertiary">{agent.description}</Text>
      ) : null}

      {/* UX rule 2 — the OBJECTIVE, and which cost it is measured against. */}
      {agent.target ? (
        <View className="flex-row items-center gap-space-4">
          <Text className="text-caption text-text-tertiary">
            {t(SHOPPING_AGENT_CARD_TARGET_PREFIX_KEY)}
          </Text>
          <PriceDisplay price={agent.target} primaryClassName="text-bodyTitleSmall text-text" />
          <Text className="text-caption text-text-tertiary">
            {t(SHOPPING_AGENT_PRICE_BASIS_LABEL_KEYS[agent.priceBasis])}
          </Text>
        </View>
      ) : (
        <Text className="text-caption text-text">
          {t(SHOPPING_AGENT_JOB_EXPLANATION_KEYS[agent.kind])}
        </Text>
      )}

      {/* UX rule 2 — the currency, the market and the scope that decide a match. */}
      <Text className="text-caption text-text-tertiary">
        {scopeParts.join(t(SHOPPING_AGENT_CARD_SCOPE_SEPARATOR_KEY))}
      </Text>

      {/* UX rule 2 — the notification policy, in plain words. Two whole frames
          rather than one plus a glued suffix: the quiet-hours clause carries its
          own separator, so a language that joins the two differently can say so. */}
      <Text className="text-caption text-text-tertiary">
        {agent.quietHours
          ? t(SHOPPING_AGENT_CARD_NOTIFY_POLICY_QUIET_KEY, {
              channels,
              cooldown: formatDuration(agent.cooldownSeconds),
              start: formatMinuteOfDay(agent.quietHours.startMinute),
              end: formatMinuteOfDay(agent.quietHours.endMinute),
              timeZone: agent.quietHours.timeZone,
            })
          : t(SHOPPING_AGENT_CARD_NOTIFY_POLICY_KEY, {
              channels,
              cooldown: formatDuration(agent.cooldownSeconds),
            })}
      </Text>

      {constraints.length > 0 ? (
        <View className="gap-space-4">
          <Text className="text-caption text-text-tertiary">
            {t(SHOPPING_AGENT_CARD_REQUIREMENTS_KEY)}
          </Text>
          {constraints.map((constraint) => (
            <ConstraintLine key={constraint.id} constraint={constraint} />
          ))}
        </View>
      ) : null}

      {agent.lines.length > 0 ? (
        <View className="gap-space-4">
          <Text className="text-caption text-text-tertiary">
            {t(SHOPPING_AGENT_CARD_WATCHING_KEY, { things: agent.lines.length })}
          </Text>
          {agent.lines.map((line) => (
            <Pressable
              key={line.id}
              accessibilityRole="button"
              accessibilityLabel={t(SHOPPING_AGENT_CARD_OPEN_PRODUCT_KEY)}
              onPress={() => onOpenProduct?.(line.canonicalProductId)}
            >
              <Text className="text-caption text-text-secondary" numberOfLines={1}>
                {t(SHOPPING_AGENT_CARD_LINE_KEY, {
                  quantity: line.quantity,
                  product: line.canonicalProductId,
                })}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {ambiguous ? (
        <View className="gap-space-4 rounded-radius-12 bg-bg-fill-secondary p-space-8">
          <Text className="text-caption text-text">
            {t(SHOPPING_AGENT_CARD_SPLIT_EXPLANATION_KEY)}
          </Text>
          <SplitCandidate
            lineKey={SHOPPING_AGENT_CARD_SPLIT_STAYS_KEY}
            a11yKey={SHOPPING_AGENT_CARD_SPLIT_STAYS_A11Y_KEY}
            canonicalProductId={sourceProductId}
            onOpenProduct={onOpenProduct}
          />
          <SplitCandidate
            lineKey={SHOPPING_AGENT_CARD_SPLIT_MOVES_KEY}
            a11yKey={SHOPPING_AGENT_CARD_SPLIT_MOVES_A11Y_KEY}
            canonicalProductId={agent.splitTargetCanonicalProductId}
            onOpenProduct={onOpenProduct}
          />
          <View className="flex-row gap-space-8">
            <SplitChoice
              label={t(SHOPPING_AGENT_CARD_KEEP_SOURCE_KEY)}
              disabled={busy}
              onPress={() => onResolveSplit?.(agent, "keep_source")}
            />
            <SplitChoice
              label={t(SHOPPING_AGENT_CARD_MOVE_TO_TARGET_KEY)}
              disabled={busy}
              onPress={() => onResolveSplit?.(agent, "move_to_target")}
            />
          </View>
        </View>
      ) : null}

      <View className="flex-row items-center gap-space-12">
        {/* One look now (UX rule 5). Only `enabled` is evaluable, so it is the
            only state where offering this would be telling the truth. */}
        {agent.state === "enabled" ? (
          <RowAction
            label={t(SHOPPING_AGENT_CARD_RUN_NOW_A11Y_KEY, { name: agent.name })}
            text={t(SHOPPING_AGENT_CARD_RUN_NOW_KEY)}
            disabled={busy}
            icon={<RefreshCw size={ICON_SIZE} className="text-text-secondary" />}
            onPress={() => onRunNow?.(agent)}
          />
        ) : null}
        {agent.state === "enabled" ? (
          <RowAction
            label={t(SHOPPING_AGENT_CARD_PAUSE_A11Y_KEY, { name: agent.name })}
            text={t(SHOPPING_AGENT_CARD_PAUSE_KEY)}
            disabled={busy}
            icon={<BellOff size={ICON_SIZE} className="text-text-secondary" />}
            onPress={() => onPause?.(agent)}
          />
        ) : null}
        {/* Resume is offered for a PAUSED agent and never for a blocked one. */}
        {agent.state === "paused" ? (
          <RowAction
            label={t(SHOPPING_AGENT_CARD_RESUME_A11Y_KEY, { name: agent.name })}
            text={t(SHOPPING_AGENT_CARD_RESUME_KEY)}
            disabled={busy}
            icon={<Bell size={ICON_SIZE} className="text-text-secondary" />}
            onPress={() => onResume?.(agent)}
          />
        ) : null}
        <RowAction
          label={t(SHOPPING_AGENT_CARD_REMOVE_A11Y_KEY, { name: agent.name })}
          text={t(SHOPPING_AGENT_CARD_REMOVE_KEY)}
          disabled={busy}
          icon={<Trash2 size={ICON_SIZE} className="text-text-secondary" />}
          onPress={() => onDelete?.(agent)}
        />
      </View>

      {/* Both halves NAME their timestamp, so an unformattable one falls back to
          the "never looked" copy rather than rendering a sentence with a hole in
          it, and the trailing clause disappears with its separator.

          Four whole frames rather than two plus a concatenation: the ` · next `
          that used to be glued on here carried the separator INSIDE the
          fragment, so no language could join the two clauses its own way and a
          right-to-left one got a `·` whose side the surrounding run decided. */}
      <Text className="text-caption text-text-tertiary">
        {lastLooked === null
          ? nextScheduled === null
            ? t(SHOPPING_AGENT_CARD_NEVER_LOOKED_KEY)
            : t(SHOPPING_AGENT_CARD_NEVER_LOOKED_NEXT_KEY, { next: nextScheduled })
          : nextScheduled === null
            ? t(SHOPPING_AGENT_CARD_LAST_LOOKED_KEY, { last: lastLooked })
            : t(SHOPPING_AGENT_CARD_LAST_LOOKED_NEXT_KEY, {
                last: lastLooked,
                next: nextScheduled,
              })}
      </Text>
    </View>
  );
}

/**
 * One requirement, in the words the constraint itself carries.
 *
 * `explanation` is composed once when the set is built and never re-derived
 * (#94), so this renders it verbatim rather than describing the predicate a
 * second time — two descriptions of one requirement are two things that can
 * disagree.
 */
function ConstraintLine({ constraint }: { constraint: ProductConstraint }) {
  const t = useSharedUiTranslation();
  return (
    <View className="flex-row items-start gap-space-4">
      <Text className="text-caption text-text-tertiary">
        {t(
          constraint.strength === "hard"
            ? SHOPPING_AGENT_CARD_CONSTRAINT_HARD_KEY
            : SHOPPING_AGENT_CARD_CONSTRAINT_SOFT_KEY,
        )}
      </Text>
      <Text className="flex-1 text-caption text-text-secondary">{constraint.explanation}</Text>
    </View>
  );
}

function RowAction({
  label,
  text,
  icon,
  disabled,
  onPress,
}: {
  label: string;
  text: string;
  icon: React.ReactNode;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      className="flex-row items-center gap-space-4"
    >
      {icon}
      <Text className="text-caption text-text-secondary">{text}</Text>
    </Pressable>
  );
}

function SplitChoice({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      className="rounded-radius-max bg-bg-fill px-space-12 py-space-4"
    >
      <Text className="text-caption text-text">{label}</Text>
    </Pressable>
  );
}

/** `1_320` becomes `22:00`. The agent stores minutes; a shopper reads a clock. */
function formatMinuteOfDay(minute: number): string {
  const hours = Math.floor(minute / MINUTES_PER_HOUR);
  const minutes = minute % MINUTES_PER_HOUR;
  return `${String(hours).padStart(CLOCK_PAD, "0")}:${String(minutes).padStart(CLOCK_PAD, "0")}`;
}

/**
 * One of the two products a split left behind.
 *
 * Rendered by its canonical id and opened rather than named: a product NAME is
 * the catalogue's to own, and a copy carried on an agent would be a second
 * representation of it (#79's reasoning about an alert's product name). Opening
 * each candidate is how a shopper actually tells them apart.
 */
function SplitCandidate({
  lineKey,
  a11yKey,
  canonicalProductId,
  onOpenProduct,
}: {
  /** The whole visible line, with the product as its slot. */
  lineKey: string;
  /** The whole spoken label. A separate frame, not the line with a suffix. */
  a11yKey: string;
  canonicalProductId?: string;
  onOpenProduct?: (canonicalProductId: string) => void;
}) {
  const t = useSharedUiTranslation();
  if (canonicalProductId === undefined) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t(a11yKey)}
      onPress={() => onOpenProduct?.(canonicalProductId)}
    >
      <Text className="text-caption text-text-secondary" numberOfLines={1}>
        {t(lineKey, { product: canonicalProductId })}
      </Text>
    </Pressable>
  );
}
