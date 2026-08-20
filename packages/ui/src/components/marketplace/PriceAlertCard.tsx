import { Pressable, View } from "react-native";
import { Bell, BellOff, Trash2 } from "lucide-react-native";
import type { PriceAlert, PriceAlertSplitResolution } from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { PriceDisplay } from "../PriceDisplay";
import { conditionGroupLabelKey } from "../../lib/condition";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import {
  PRICE_ALERT_ANY_CONDITION_KEY,
  PRICE_ALERT_BASIS_LABEL_KEYS,
  PRICE_ALERT_DELETE_A11Y_KEY,
  PRICE_ALERT_DELETE_KEY,
  PRICE_ALERT_KEEP_BOTH_KEY,
  PRICE_ALERT_KEEP_SOURCE_KEY,
  PRICE_ALERT_LIST_SEPARATOR_KEY,
  PRICE_ALERT_MOVE_TO_TARGET_KEY,
  PRICE_ALERT_NOTIFIED_KEY,
  PRICE_ALERT_OPEN_PRODUCT_KEY,
  PRICE_ALERT_PAUSE_A11Y_KEY,
  PRICE_ALERT_PAUSE_KEY,
  PRICE_ALERT_PAUSED_KEY,
  PRICE_ALERT_RESUME_A11Y_KEY,
  PRICE_ALERT_RESUME_KEY,
  PRICE_ALERT_SAVED_PRODUCT_KEY,
  PRICE_ALERT_SCOPE_LINE_KEY,
  PRICE_ALERT_SELLER_SCOPE_LABEL_KEYS,
  PRICE_ALERT_SPLIT_EXPLANATION_KEY,
  PRICE_ALERT_TARGET_PREFIX_KEY,
} from "../../lib/price-alert-labels";

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
  const t = useSharedUiTranslation();
  const ambiguous = alert.resolution.state === "ambiguous_after_split";
  const basisText = t(PRICE_ALERT_BASIS_LABEL_KEYS[alert.basis]);
  const segments =
    alert.conditionGroups.length === 0
      ? t(PRICE_ALERT_ANY_CONDITION_KEY)
      : alert.conditionGroups
          .map((group) => t(conditionGroupLabelKey(group)))
          .join(t(PRICE_ALERT_LIST_SEPARATOR_KEY));
  const sellers = t(PRICE_ALERT_SELLER_SCOPE_LABEL_KEYS[alert.sellerScope]);

  return (
    <View className="gap-space-8 rounded-radius-16 border border-border-secondary bg-bg-fill p-space-12">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={productName ?? t(PRICE_ALERT_OPEN_PRODUCT_KEY)}
        onPress={() => onOpen?.(alert)}
        className="gap-space-4"
      >
        <Text className="text-bodyTitleSmall text-text" numberOfLines={2}>
          {productName ?? t(PRICE_ALERT_SAVED_PRODUCT_KEY)}
        </Text>
        <View className="flex-row items-center gap-space-4">
          <Text className="text-caption text-text-tertiary">
            {t(PRICE_ALERT_TARGET_PREFIX_KEY)}
          </Text>
          <PriceDisplay price={alert.target} primaryClassName="text-bodyTitleSmall text-text" />
          <Text className="text-caption text-text-tertiary">{basisText}</Text>
        </View>
      </Pressable>

      {/* UX rule 4 — WHICH conditions and merchants count, on the row itself. */}
      <Text className="text-caption text-text-tertiary">
        {t(PRICE_ALERT_SCOPE_LINE_KEY, { segments, sellers })}
      </Text>

      {alert.state === "triggered" ? (
        <Text className="text-caption text-text-tertiary">{t(PRICE_ALERT_NOTIFIED_KEY)}</Text>
      ) : null}

      {alert.state === "paused" && !ambiguous ? (
        <Text className="text-caption text-text-tertiary">{t(PRICE_ALERT_PAUSED_KEY)}</Text>
      ) : null}

      {ambiguous ? (
        <View className="gap-space-4">
          <Text className="text-caption text-text">
            {t(PRICE_ALERT_SPLIT_EXPLANATION_KEY)}
          </Text>
          <View className="flex-row gap-space-8">
            <SplitChoice
              label={t(PRICE_ALERT_KEEP_SOURCE_KEY)}
              onPress={() => onResolveSplit?.(alert, "keep_source")}
            />
            <SplitChoice
              label={t(PRICE_ALERT_MOVE_TO_TARGET_KEY)}
              onPress={() => onResolveSplit?.(alert, "move_to_target")}
            />
            <SplitChoice
              label={t(PRICE_ALERT_KEEP_BOTH_KEY)}
              onPress={() => onResolveSplit?.(alert, "keep_both")}
            />
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
            label={t(PRICE_ALERT_PAUSE_A11Y_KEY)}
            text={t(PRICE_ALERT_PAUSE_KEY)}
            icon={<BellOff size={ICON_SIZE} className="text-text-secondary" />}
            onPress={() => onPause?.(alert)}
          />
        ) : null}
        {alert.state === "paused" && !ambiguous ? (
          <RowAction
            label={t(PRICE_ALERT_RESUME_A11Y_KEY)}
            text={t(PRICE_ALERT_RESUME_KEY)}
            icon={<Bell size={ICON_SIZE} className="text-text-secondary" />}
            onPress={() => onResume?.(alert)}
          />
        ) : null}
        <RowAction
          label={t(PRICE_ALERT_DELETE_A11Y_KEY)}
          text={t(PRICE_ALERT_DELETE_KEY)}
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
