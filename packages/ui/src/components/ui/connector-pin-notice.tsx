import type { ReactNode } from "react";
import { View } from "react-native";
import { Pin } from "lucide-react-native";
import { partitionPinnedFields, type SyncSettings } from "@mercaria/shared-types";
import { cn } from "../../lib/cn";
import {
  CONNECTOR_PIN_EFFECT_TEXT,
  CONNECTOR_PIN_LABELS,
  CONNECTOR_PIN_RELEASE_TEXT,
  CONNECTOR_PIN_TITLE,
  connectorPinUnnamedText,
  type ConnectorPinEffect,
} from "../../lib/connector-labels";
import { Text } from "./text";
import { Icon } from "./icon";

export interface ConnectorPinNoticeProps {
  /**
   * The listing's `overriddenFields`, exactly as the admin hydration path served
   * it. Absent and empty are one value and both render nothing.
   */
  overriddenFields?: string[];
  /**
   * The owning connection's `conflictPolicy`, or `undefined` when this viewer
   * cannot read the channel (its routes are behind `channels:write`).
   *
   * The wire value rather than a boolean, so a caller cannot invert the
   * derivation on the way in.
   */
  conflictPolicy?: SyncSettings["conflictPolicy"];
  /**
   * Optional trailing node — the app's own link to the channel screen. Routing
   * is never this package's, and whether that screen is reachable depends on a
   * permission only the app has resolved.
   */
  action?: ReactNode;
  className?: string;
}

function effectOf(policy: SyncSettings["conflictPolicy"] | undefined): ConnectorPinEffect {
  if (policy === "respect_overrides") return "honoured";
  if (policy === "connector_wins") return "channel_wins";
  return "unknown";
}

/**
 * Which of a connector-sourced listing's fields have stopped tracking the
 * platform, and what that currently means (#420).
 *
 * A pin is written by an ordinary edit and removed by nothing, so its only
 * symptom is a field that quietly stops following the platform — which looks
 * exactly like a broken sync. Rendering the set is what lets a merchant tell
 * "my Shopify title change isn't arriving" from "I edited that title six weeks
 * ago", and it is the whole of this component's job.
 *
 * READ-ONLY, deliberately. There is no pin/unpin control here and none may be
 * added: an explicit pinning control was considered and rejected in #416, and
 * per-field release is a separate piece of work with a different shape —
 * nothing stores the platform's previous value, so "unpin" can only ever mean
 * "resume tracking from the next sync", never "restore what it was".
 *
 * Renders nothing when the listing has no pins, which is the overwhelmingly
 * common state.
 */
export function ConnectorPinNotice({
  overriddenFields,
  conflictPolicy,
  action,
  className,
}: ConnectorPinNoticeProps) {
  const { pinned, unnamed } = partitionPinnedFields(overriddenFields);
  if (pinned.length === 0 && unnamed.length === 0) {
    return null;
  }
  const effect = effectOf(conflictPolicy);

  return (
    <View className={cn("gap-2 rounded-2xl border border-border bg-surface p-4", className)}>
      <View className="flex-row items-center gap-2">
        <Icon as={Pin} size={14} className="text-muted-foreground" />
        <Text className="text-sm font-semibold text-foreground">{CONNECTOR_PIN_TITLE}</Text>
      </View>

      {pinned.length > 0 ? (
        <View className="flex-row flex-wrap gap-1.5">
          {pinned.map((field) => (
            <View key={field} className="rounded-full bg-muted px-2 py-1">
              <Text className="text-xs font-medium text-foreground">
                {CONNECTOR_PIN_LABELS[field]}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      <Text className="text-xs text-muted-foreground">{CONNECTOR_PIN_EFFECT_TEXT[effect]}</Text>

      {unnamed.length > 0 ? (
        <Text className="text-xs text-muted-foreground">
          {connectorPinUnnamedText(unnamed.length)}
        </Text>
      ) : null}

      {effect === "honoured" ? (
        <Text className="text-xs text-muted-foreground">{CONNECTOR_PIN_RELEASE_TEXT}</Text>
      ) : null}

      {action}
    </View>
  );
}
