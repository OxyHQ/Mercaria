import type { ReactNode } from "react";
import { View } from "react-native";
import { Pin } from "lucide-react-native";
import {
  partitionPinnedFields,
  type PinnableConnectorField,
  type SyncSettings,
} from "@mercaria/shared-types";
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
   * What releasing a field means, in the APP's own words — rendered above the
   * pin list, where a merchant reads it before pressing anything.
   *
   * The sentence lives in the app rather than here because the dashboard's copy
   * is translated into eleven locales and this package's is not; and it is a
   * NODE rather than a string because that is what keeps it that way.
   */
  releaseNote?: ReactNode;
  /**
   * Optional trailing control for one pinned field — the app's release
   * affordance, rendered inside that field's own chip.
   *
   * A render prop, so this component keeps writing nothing (see the note below):
   * it decides WHERE a per-field control belongs and never what one does. The
   * argument is the pin key, so an app cannot attach a control to a field the
   * notice is not showing.
   */
  fieldAction?: (field: PinnableConnectorField) => ReactNode;
  /**
   * Optional control for the held keys this surface cannot NAME, rendered
   * beside their count.
   *
   * One control for the group rather than one per key: rendering them
   * individually would mean printing a raw column name to a merchant, and
   * leaving them out entirely would make them the only pins with no way out.
   */
  unnamedAction?: ReactNode;
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
 * This component still WRITES NOTHING, and a gate in the backend suite holds it
 * to that. #427 gave a merchant a way to release one field, and the control
 * arrives as `releaseNote` / `fieldAction` / `unnamedAction` — presentational
 * SLOTS the app fills — precisely so the mutation, the permission it needs and
 * the eleven translations of its copy all stay in the app that has them. A
 * `useMutation` here would hand every future consumer a write it never asked
 * for.
 *
 * What no slot may ever be labelled is a RESTORE. Nothing stores the platform's
 * previous per-field value, so releasing means "this field follows the platform
 * again from the next sync" and never "put back what it was" — the merchant's
 * current value stays until the platform sends one.
 *
 * Renders nothing when the listing has no pins, which is the overwhelmingly
 * common state.
 */
export function ConnectorPinNotice({
  overriddenFields,
  conflictPolicy,
  releaseNote,
  fieldAction,
  unnamedAction,
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

      {releaseNote}

      {pinned.length > 0 ? (
        <View className="flex-row flex-wrap gap-1.5">
          {pinned.map((field) => (
            <View
              key={field}
              className="flex-row items-center gap-1.5 rounded-full bg-muted px-2 py-1"
            >
              <Text className="text-xs font-medium text-foreground">
                {CONNECTOR_PIN_LABELS[field]}
              </Text>
              {fieldAction?.(field)}
            </View>
          ))}
        </View>
      ) : null}

      <Text className="text-xs text-muted-foreground">{CONNECTOR_PIN_EFFECT_TEXT[effect]}</Text>

      {unnamed.length > 0 ? (
        <View className="flex-row flex-wrap items-center gap-1.5">
          <Text className="text-xs text-muted-foreground">
            {connectorPinUnnamedText(unnamed.length)}
          </Text>
          {unnamedAction}
        </View>
      ) : null}

      {effect === "honoured" ? (
        <Text className="text-xs text-muted-foreground">{CONNECTOR_PIN_RELEASE_TEXT}</Text>
      ) : null}

      {action}
    </View>
  );
}
