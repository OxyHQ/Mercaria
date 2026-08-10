import { Pressable, View } from "react-native";
import { Bell, BellOff, Trash2 } from "lucide-react-native";
import type { PriceAlert, PriceAlertSplitResolution } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { PriceDisplay } from "../PriceDisplay";
import { CONDITION_GROUP_LABELS } from "../../lib/condition";

/** Icon size for the row's trailing affordances. */
const ICON_SIZE = 18;

export interface PriceAlertCardProps {
  alert: PriceAlert;
  /** The product's own name, when the caller has it. Never stored on the alert. */
  productName?: string;
  onOpen?: (alert: PriceAlert) => void;
  onPause?: (alert: PriceAlert) => void;
  onResume?: (alert: PriceAlert) => void;
  onDelete?: (alert: PriceAlert) => void;
  /** Answer a split ambiguity. Only ever called for an ambiguous alert. */
  onResolveSplit?: (alert: PriceAlert, resolution: PriceAlertSplitResolution) => void;
}

/**
 * One row of the price-alert list (#79 UX rules 4, 5 and 6).
 *
 * Three states this row is careful about, each because the alternative is a
 * plausible lie:
 *
 *  - **What counts** is stated on the row rather than hidden behind an edit
 *    screen: the condition segments, the seller scope and whether the target is
 *    an item price or a KNOWN total including delivery. A row that showed only
 *    "under €500" would leave a buyer unable to explain why a €480 used one did
 *    not notify them (UX rule 4).
 *  - **An ambiguous alert** renders a prompt and NOT a warning. A catalogue
 *    split divided the product and only the buyer can say which half they meant;
 *    the alert is paused in the meantime, which the row says (UX rule 5).
 *  - **A triggered `once` alert** says it has done its job rather than reading
 *    as paused. Those are different facts and a buyer deciding whether to set a
 *    new one needs to tell them apart.
 *
 * The product NAME is a prop and never a field of the alert: an alert names a
 * canonical product id and nothing else, so a copy of the name would be a second
 * representation of something the catalogue owns.
 */
export function PriceAlertCard({
  alert,
  productName,
  onOpen,
  onPause,
  onResume,
  onDelete,
  onResolveSplit,
}: PriceAlertCardProps) {
  const ambiguous = alert.resolution.state === "ambiguous_after_split";
  const basisText =
    alert.basis === "known_total" ? "including delivery" : "before delivery";
  const segments =
    alert.conditionGroups.length === 0
      ? "any condition"
      : alert.conditionGroups.map((group) => CONDITION_GROUP_LABELS[group]).join(", ");
  const sellers =
    alert.sellerScope === "native_only"
      ? "sellers on Mercaria"
      : alert.sellerScope === "external_only"
        ? "merchants outside Mercaria"
        : alert.sellerScope === "official_only"
          ? "verified official stores"
          : "any seller";

  return (
    <View className="gap-space-8 rounded-radius-16 border border-border-secondary bg-bg-fill p-space-12">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={productName ?? "Open the product this alert watches"}
        onPress={() => onOpen?.(alert)}
        className="gap-space-4"
      >
        <Text className="text-bodyTitleSmall text-text" numberOfLines={2}>
          {productName ?? "Saved product"}
        </Text>
        <View className="flex-row items-center gap-space-4">
          <Text className="text-caption text-text-tertiary">Tell me under</Text>
          <PriceDisplay price={alert.target} primaryClassName="text-bodyTitleSmall text-text" />
          <Text className="text-caption text-text-tertiary">{basisText}</Text>
        </View>
      </Pressable>

      {/* UX rule 4 — WHICH conditions and merchants count, on the row itself. */}
      <Text className="text-caption text-text-tertiary">
        {segments} · {sellers}
      </Text>

      {alert.state === "triggered" ? (
        <Text className="text-caption text-text-tertiary">
          Notified — this alert was set to tell you once.
        </Text>
      ) : null}

      {alert.state === "paused" && !ambiguous ? (
        <Text className="text-caption text-text-tertiary">Paused</Text>
      ) : null}

      {ambiguous ? (
        <View className="gap-space-4">
          <Text className="text-caption text-text">
            This product was split in two, so this alert is paused until you choose which one you
            meant.
          </Text>
          <View className="flex-row gap-space-8">
            <SplitChoice label="Keep this one" onPress={() => onResolveSplit?.(alert, "keep_source")} />
            <SplitChoice label="The other one" onPress={() => onResolveSplit?.(alert, "move_to_target")} />
            <SplitChoice label="Both" onPress={() => onResolveSplit?.(alert, "keep_both")} />
          </View>
        </View>
      ) : null}

      <View className="flex-row items-center gap-space-12">
        {/*
          One-tap pause and its undo (notification 8). A `triggered` alert shows
          neither: it is finished rather than paused, and offering "resume" would
          claim a `once` alert can fire again.
        */}
        {alert.state === "enabled" ? (
          <RowAction
            label="Pause this alert"
            text="Pause"
            icon={<BellOff size={ICON_SIZE} className="text-text-secondary" />}
            onPress={() => onPause?.(alert)}
          />
        ) : null}
        {alert.state === "paused" && !ambiguous ? (
          <RowAction
            label="Resume this alert"
            text="Resume"
            icon={<Bell size={ICON_SIZE} className="text-text-secondary" />}
            onPress={() => onResume?.(alert)}
          />
        ) : null}
        <RowAction
          label="Delete this alert"
          text="Delete"
          icon={<Trash2 size={ICON_SIZE} className="text-text-secondary" />}
          onPress={() => onDelete?.(alert)}
        />
      </View>
    </View>
  );
}

function RowAction({
  label,
  text,
  icon,
  onPress,
}: {
  label: string;
  text: string;
  icon: React.ReactNode;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="flex-row items-center gap-space-4"
    >
      {icon}
      <Text className="text-caption text-text-secondary">{text}</Text>
    </Pressable>
  );
}

function SplitChoice({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="rounded-radius-max bg-bg-fill-secondary px-space-12 py-space-4"
    >
      <Text className="text-caption text-text">{label}</Text>
    </Pressable>
  );
}
