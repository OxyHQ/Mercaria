import React, { useState } from "react";
import { View } from "react-native";
import type {
  LocationInventorySource,
  LocationPublicationState,
  MerchantLocationPublication,
  PickupIdentityRequirement,
} from "@mercaria/shared-types";
import { PICKUP_IDENTITY_REQUIREMENT_KEYS, Text } from "@mercaria/ui";
import { Badge } from "@oxy.so/bloom/badge";
import { Field } from "@oxy.so/bloom/field";
import { TextFieldInput } from "@oxy.so/bloom/text-field";
import { Textarea } from "@oxy.so/bloom/textarea";
import { Button } from "@oxy.so/bloom/button";
import { Switch } from "@oxy.so/bloom/switch";
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from "@oxy.so/bloom/segmented-control";
import { toast } from "@oxy.so/bloom/toast";
import {
  useSaveLocationPublication,
  useSetLocationPickupPause,
  useSetLocationPublicationState,
} from "@/lib/hooks/use-location-publication";
import { publicationErrorKey } from "@/lib/goway/errors";
import {
  publicationDraftOf,
  publicationInputOf,
  type PublicationDraft,
} from "@/lib/locations/publication-form";
import { useTranslation } from "@/lib/i18n";
import { EditorSection } from "./EditorSection";

const IDENTITY_REQUIREMENTS: PickupIdentityRequirement[] = [
  "collection_code",
  "collection_code_and_photo_id",
  "order_number_only",
];

const INVENTORY_SOURCES: LocationInventorySource[] = ["pos", "connector", "manual"];

const INVENTORY_SOURCE_KEYS: Record<LocationInventorySource, string> = {
  pos: "settings.locations.editor.publication.source.pos",
  connector: "settings.locations.editor.publication.source.connector",
  manual: "settings.locations.editor.publication.source.manual",
};

const STATE_KEYS: Record<LocationPublicationState, string> = {
  draft: "settings.locations.editor.publication.state.draft",
  published: "settings.locations.editor.publication.state.published",
  withdrawn: "settings.locations.editor.publication.state.withdrawn",
};

/**
 * Mercaria's half of a location: WHICH GoWay place it trades from, whether it
 * offers collection and on what terms, how fresh its stock claims are — and
 * whether it is published (#93, ADR 0013).
 *
 * Saving links the place chosen above (Mercaria checks GoWay knows it);
 * publishing runs Mercaria's trust rule and is refused, with the reasons in
 * the status card, until the place names this location back.
 */
export function PublicationCard({
  storeId,
  locationId,
  publication,
  goWayPlaceId,
}: {
  storeId: string;
  locationId: string;
  publication: MerchantLocationPublication | null;
  goWayPlaceId: string | undefined;
}) {
  const { t } = useTranslation();
  const save = useSaveLocationPublication(storeId, locationId);
  const setState = useSetLocationPublicationState(storeId, locationId);
  const setPause = useSetLocationPickupPause(storeId, locationId);
  const [draft, setDraft] = useState<PublicationDraft>(() => publicationDraftOf(publication));
  const [pauseReason, setPauseReason] = useState("");

  const patch = (next: Partial<PublicationDraft>) => setDraft((current) => ({ ...current, ...next }));

  const submit = () => {
    const built = publicationInputOf(draft, goWayPlaceId);
    if (!built.ok) {
      toast.error(t(built.errorKey));
      return;
    }
    save.mutate(built.input, {
      onSuccess: () => toast.success(t("settings.locations.editor.publication.saved")),
      onError: (error) => toast.error(t(publicationErrorKey(error))),
    });
  };

  const move = (state: LocationPublicationState) =>
    setState.mutate(state, {
      onSuccess: () => toast.success(t("settings.locations.editor.publication.stateChanged")),
      onError: (error) => toast.error(t(publicationErrorKey(error))),
    });

  const linkedElsewhere =
    publication?.goWayPlaceId !== undefined && goWayPlaceId !== undefined && publication.goWayPlaceId !== goWayPlaceId;

  return (
    <EditorSection
      title={t("settings.locations.editor.publication.title")}
      description={t("settings.locations.editor.publication.description")}
    >
      {linkedElsewhere ? (
        <Text className="text-xs text-muted-foreground">{t("settings.locations.editor.publication.unsavedPlace")}</Text>
      ) : null}
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-sm text-foreground">{t("settings.locations.editor.publication.pickupOffered")}</Text>
        <Switch
          checked={draft.pickupOffered}
          onCheckedChange={(pickupOffered) => patch({ pickupOffered })}
          accessibilityLabel={t("settings.locations.editor.publication.pickupOffered")}
        />
      </View>
      <Field label={t("settings.locations.editor.publication.instructions")}>
        <Textarea
          autoResize
          accessibilityLabel={t("settings.locations.editor.publication.instructions")}
          value={draft.pickupInstructions}
          onValueChange={(pickupInstructions) => patch({ pickupInstructions })}
          placeholder={t("settings.locations.editor.publication.instructionsPlaceholder")}
        />
      </Field>
      <Field label={t("settings.locations.editor.publication.identity")}>
        <SegmentedControl
          type="radio"
          value={draft.identityRequirement}
          onValueChange={(identityRequirement) => patch({ identityRequirement })}
        >
          {IDENTITY_REQUIREMENTS.map((requirement) => (
            <SegmentedControlItem key={requirement} value={requirement}>
              <SegmentedControlItemText>{t(PICKUP_IDENTITY_REQUIREMENT_KEYS[requirement])}</SegmentedControlItemText>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </Field>
      <Field label={t("settings.locations.editor.publication.inventorySource")}>
        <SegmentedControl
          type="radio"
          value={draft.inventorySource}
          onValueChange={(inventorySource) => patch({ inventorySource })}
        >
          {INVENTORY_SOURCES.map((source) => (
            <SegmentedControlItem key={source} value={source}>
              <SegmentedControlItemText>{t(INVENTORY_SOURCE_KEYS[source])}</SegmentedControlItemText>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </Field>
      <View className="flex-row gap-2">
        <View className="flex-1">
          <Field label={t("settings.locations.editor.publication.interval")}>
            <TextFieldInput
              label={t("settings.locations.editor.publication.interval")}
              keyboardType="number-pad"
              value={draft.stockIntervalMinutes}
              onValueChange={(stockIntervalMinutes) => patch({ stockIntervalMinutes })}
            />
          </Field>
        </View>
        <View className="flex-1">
          <Field label={t("settings.locations.editor.publication.lowStock")}>
            <TextFieldInput
              label={t("settings.locations.editor.publication.lowStock")}
              keyboardType="number-pad"
              value={draft.lowStockThreshold}
              onValueChange={(lowStockThreshold) => patch({ lowStockThreshold })}
            />
          </Field>
        </View>
      </View>
      <Text className="text-xs text-muted-foreground">{t("settings.locations.editor.publication.intervalHint")}</Text>
      <View className="flex-row items-center justify-between gap-3">
        <Text className="text-sm text-foreground">{t("settings.locations.editor.publication.exactStock")}</Text>
        <Switch
          checked={draft.disclosesExactStock}
          onCheckedChange={(disclosesExactStock) => patch({ disclosesExactStock })}
          accessibilityLabel={t("settings.locations.editor.publication.exactStock")}
        />
      </View>
      <Button tone="accent" loading={save.isPending} disabled={goWayPlaceId === undefined} onPress={submit}>
        {t("settings.locations.editor.publication.save")}
      </Button>

      {publication ? (
        <View className="gap-3 border-t border-border pt-3">
          <View className="flex-row items-center gap-2">
            <Badge
              size="label-small"
              variant="subtle"
              color={publication.publicationState === "published" ? "success" : "default"}
              content={t(STATE_KEYS[publication.publicationState])}
            />
            {publication.restricted ? (
              <Badge
                size="label-small"
                variant="subtle"
                color="error"
                content={t("settings.locations.editor.publication.restricted")}
              />
            ) : null}
          </View>
          {publication.restrictionReason ? (
            <Text className="text-xs text-muted-foreground">{publication.restrictionReason}</Text>
          ) : null}
          <View className="flex-row flex-wrap gap-2">
            {publication.publicationState === "published" ? (
              <Button tone="neutral" appearance="outline" loading={setState.isPending} onPress={() => move("withdrawn")}>
                {t("settings.locations.editor.publication.withdraw")}
              </Button>
            ) : (
              <Button tone="accent" loading={setState.isPending} onPress={() => move("published")}>
                {t("settings.locations.editor.publication.publish")}
              </Button>
            )}
            {publication.publicationState === "withdrawn" ? (
              <Button tone="neutral" appearance="outline" loading={setState.isPending} onPress={() => move("draft")}>
                {t("settings.locations.editor.publication.toDraft")}
              </Button>
            ) : null}
          </View>

          {publication.pickupPausedAt ? (
            <View className="gap-2">
              <Text className="text-sm text-foreground">
                {t("settings.locations.editor.publication.pausedBecause", {
                  reason: publication.pickupPauseReason ?? "",
                })}
              </Text>
              <Button
                tone="neutral"
                appearance="outline"
                loading={setPause.isPending}
                onPress={() =>
                  setPause.mutate(
                    { paused: false },
                    { onError: (error) => toast.error(t(publicationErrorKey(error))) },
                  )
                }
              >
                {t("settings.locations.editor.publication.resume")}
              </Button>
            </View>
          ) : (
            <View className="gap-2">
              <Field label={t("settings.locations.editor.publication.pauseReason")}>
                <TextFieldInput
                  label={t("settings.locations.editor.publication.pauseReason")}
                  value={pauseReason}
                  onValueChange={setPauseReason}
                />
              </Field>
              <Button
                tone="neutral"
                appearance="outline"
                disabled={pauseReason.trim() === ""}
                loading={setPause.isPending}
                onPress={() =>
                  setPause.mutate(
                    { paused: true, reason: pauseReason.trim() },
                    {
                      onSuccess: () => setPauseReason(""),
                      onError: (error) => toast.error(t(publicationErrorKey(error))),
                    },
                  )
                }
              >
                {t("settings.locations.editor.publication.pause")}
              </Button>
            </View>
          )}
        </View>
      ) : null}
    </EditorSection>
  );
}
