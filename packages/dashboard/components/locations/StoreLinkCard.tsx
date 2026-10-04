import React from "react";
import { View } from "react-native";
import type { Place } from "@goway.to/sdk";
import { Text } from "@mercaria/ui";
import { Badge } from "@oxy.so/bloom/badge";
import { Button } from "@oxy.so/bloom/button";
import { toast } from "@oxy.so/bloom/toast";
import { useAssertStoreLink } from "@/lib/goway/hooks";
import { goWayErrorKey } from "@/lib/goway/errors";
import { STORE_LINK_STATE_KEYS, storeLinkState } from "@/lib/goway/place-link";
import { useTranslation } from "@/lib/i18n";
import { EditorSection } from "./EditorSection";

/**
 * The place's half of the link: `commerce.mercaria.store` = this location's id,
 * written on the place in GoWay (ADR 0013).
 *
 * Written while the claim is pending it lands as a community report and proves
 * nothing; once the claim is approved, writing it again lands at
 * `business_asserted`, which is what Mercaria trusts. The button stays offered
 * until it is verified for exactly that reason.
 */
export function StoreLinkCard({ place, locationId }: { place: Place; locationId: string }) {
  const { t } = useTranslation();
  const assert = useAssertStoreLink(place.id);
  const state = storeLinkState(place, locationId);

  return (
    <EditorSection
      title={t("settings.locations.editor.storeLink.title")}
      description={t("settings.locations.editor.storeLink.description")}
    >
      <View className="flex-row items-center gap-2">
        <Badge
          size="label-small"
          variant="subtle"
          color={state === "verified" ? "success" : "warning"}
          content={t(STORE_LINK_STATE_KEYS[state])}
        />
      </View>
      {state === "verified" ? null : (
        <Button
          tone="accent"
          loading={assert.isPending}
          onPress={() =>
            assert.mutate(locationId, {
              onSuccess: () => toast.success(t("settings.locations.editor.storeLink.asserted")),
              onError: (error) => toast.error(t(goWayErrorKey(error))),
            })
          }
        >
          {t("settings.locations.editor.storeLink.assert")}
        </Button>
      )}
      {state === "unverified" ? (
        <Text className="text-xs text-muted-foreground">{t("settings.locations.editor.storeLink.unverifiedNote")}</Text>
      ) : null}
    </EditorSection>
  );
}
