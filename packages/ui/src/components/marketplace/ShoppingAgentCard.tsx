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
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import {
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

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
const SECONDS_PER_DAY = SECONDS_PER_HOUR * HOURS_PER_DAY;
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
  const ambiguous =
    agent.state === "blocked" && agent.ambiguityState === "ambiguous_after_split";
  const segments =
    agent.conditionGroups.length === 0
      ? "any condition"
      : agent.conditionGroups.map((group) => t(conditionGroupLabelKey(group))).join(", ");
  const scopeParts = [
    `priced in ${agent.displayCurrency}`,
    t(SHOPPING_AGENT_CHANNEL_POLICY_LABEL_KEYS[agent.channelPolicy]),
    segments,
    agent.market ? `in ${agent.market}` : undefined,
    agent.excludedMerchantIds.length > 0
      ? `${agent.excludedMerchantIds.length} merchant(s) excluded`
      : undefined,
  ].filter((part): part is string => part !== undefined);

  const channels =
    agent.notificationChannels.length === 0
      ? "nowhere yet"
      : agent.notificationChannels
          .map((channel) => t(SHOPPING_AGENT_NOTIFICATION_CHANNEL_LABEL_KEYS[channel]))
          .join(", ");

  const constraints = agent.constraints.constraints;
  const sourceProductId = agent.lines[0]?.canonicalProductId;

  return (
    <View className="gap-space-8 rounded-radius-16 border border-border-secondary bg-bg-fill p-space-12">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          expanded ? `Hide what ${agent.name} found` : `Show what ${agent.name} found`
        }
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
          <Text className="text-caption text-text-tertiary">Tell me under</Text>
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
      <Text className="text-caption text-text-tertiary">{scopeParts.join(" · ")}</Text>

      {/* UX rule 2 — the notification policy, in plain words. */}
      <Text className="text-caption text-text-tertiary">
        Told through {channels}, at most once every {formatDuration(agent.cooldownSeconds)}
        {agent.quietHours
          ? ` · quiet ${formatMinuteOfDay(agent.quietHours.startMinute)}–${formatMinuteOfDay(
              agent.quietHours.endMinute,
            )} (${agent.quietHours.timeZone})`
          : ""}
      </Text>

      {constraints.length > 0 ? (
        <View className="gap-space-4">
          <Text className="text-caption text-text-tertiary">What has to be true</Text>
          {constraints.map((constraint) => (
            <ConstraintLine key={constraint.id} constraint={constraint} />
          ))}
        </View>
      ) : null}

      {agent.lines.length > 0 ? (
        <View className="gap-space-4">
          <Text className="text-caption text-text-tertiary">
            {agent.lines.length === 1 ? "Watching" : `Watching ${agent.lines.length} things`}
          </Text>
          {agent.lines.map((line) => (
            <Pressable
              key={line.id}
              accessibilityRole="button"
              accessibilityLabel="Open this product"
              onPress={() => onOpenProduct?.(line.canonicalProductId)}
            >
              <Text className="text-caption text-text-secondary" numberOfLines={1}>
                {line.quantity} × {line.canonicalProductId}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {ambiguous ? (
        <View className="gap-space-4 rounded-radius-12 bg-bg-fill-secondary p-space-8">
          <Text className="text-caption text-text">
            This product was split in two, so this agent is waiting until you say which one you
            meant. Open either to compare them.
          </Text>
          <SplitCandidate
            prefix="Stays as"
            canonicalProductId={sourceProductId}
            onOpenProduct={onOpenProduct}
          />
          <SplitCandidate
            prefix="Moves to"
            canonicalProductId={agent.splitTargetCanonicalProductId}
            onOpenProduct={onOpenProduct}
          />
          <View className="flex-row gap-space-8">
            <SplitChoice
              label="Keep this one"
              disabled={busy}
              onPress={() => onResolveSplit?.(agent, "keep_source")}
            />
            <SplitChoice
              label="The other one"
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
            label={`Look again now for ${agent.name}`}
            text="Run now"
            disabled={busy}
            icon={<RefreshCw size={ICON_SIZE} className="text-text-secondary" />}
            onPress={() => onRunNow?.(agent)}
          />
        ) : null}
        {agent.state === "enabled" ? (
          <RowAction
            label={`Pause ${agent.name}`}
            text="Pause"
            disabled={busy}
            icon={<BellOff size={ICON_SIZE} className="text-text-secondary" />}
            onPress={() => onPause?.(agent)}
          />
        ) : null}
        {/* Resume is offered for a PAUSED agent and never for a blocked one. */}
        {agent.state === "paused" ? (
          <RowAction
            label={`Resume ${agent.name}`}
            text="Resume"
            disabled={busy}
            icon={<Bell size={ICON_SIZE} className="text-text-secondary" />}
            onPress={() => onResume?.(agent)}
          />
        ) : null}
        <RowAction
          label={`Remove ${agent.name}`}
          text="Remove"
          disabled={busy}
          icon={<Trash2 size={ICON_SIZE} className="text-text-secondary" />}
          onPress={() => onDelete?.(agent)}
        />
      </View>

      <Text className="text-caption text-text-tertiary">
        {agent.lastEvaluatedAt
          ? `Last looked ${new Date(agent.lastEvaluatedAt).toLocaleString()}`
          : "Not looked yet"}
        {agent.nextScheduledAt
          ? ` · next ${new Date(agent.nextScheduledAt).toLocaleString()}`
          : ""}
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
  return (
    <View className="flex-row items-start gap-space-4">
      <Text className="text-caption text-text-tertiary">
        {constraint.strength === "hard" ? "Must:" : "Prefers:"}
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

/** A cooldown in the coarsest unit that still describes it exactly enough. */
function formatDuration(seconds: number): string {
  if (seconds < SECONDS_PER_MINUTE) return `${seconds} seconds`;
  if (seconds < SECONDS_PER_HOUR) return `${Math.round(seconds / SECONDS_PER_MINUTE)} minutes`;
  if (seconds < SECONDS_PER_DAY) return `${Math.round(seconds / SECONDS_PER_HOUR)} hours`;
  return `${Math.round(seconds / SECONDS_PER_DAY)} days`;
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
  prefix,
  canonicalProductId,
  onOpenProduct,
}: {
  prefix: string;
  canonicalProductId?: string;
  onOpenProduct?: (canonicalProductId: string) => void;
}) {
  if (canonicalProductId === undefined) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${prefix}: open this product`}
      onPress={() => onOpenProduct?.(canonicalProductId)}
    >
      <Text className="text-caption text-text-secondary" numberOfLines={1}>
        {prefix}: {canonicalProductId}
      </Text>
    </Pressable>
  );
}
