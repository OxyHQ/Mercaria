import React from "react";
import { View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import type { PlaceClaim } from "@goway.to/sdk";
import { Text } from "@mercaria/ui";
import { Badge } from "@oxy.so/bloom/badge";
import { Button } from "@oxy.so/bloom/button";
import { useLocationPlaceLink } from "@/lib/hooks/use-location-publication";
import { CLAIM_STATE_KEYS, PLACE_LINK_GAP_KEYS } from "@/lib/goway/place-link";
import { useTranslation } from "@/lib/i18n";
import { EditorSection } from "./EditorSection";

/**
 * Whether this location is discoverable, as Mercaria's trust rule answers it
 * NOW (ADR 0013) — every missing condition in plain words, the store's claim
 * beside it, and the place on goway.to.
 *
 * The verdict comes from Mercaria's verify endpoint, which reads GoWay with no
 * session and so cannot see a pending claim; the claim is read by this screen
 * with the merchant's own session and shown here, because "your claim is
 * waiting for GoWay" is the answer to most "why is it not linked yet".
 */
export function PlaceLinkStatusCard({
  storeId,
  locationId,
  hasPlace,
  claim,
}: {
  storeId: string;
  locationId: string;
  hasPlace: boolean;
  claim: PlaceClaim | undefined;
}) {
  const { t } = useTranslation();
  const link = useLocationPlaceLink(storeId, locationId, hasPlace);

  return (
    <EditorSection
      title={t("settings.locations.editor.status.title")}
      description={t("settings.locations.editor.status.description")}
    >
      {!hasPlace ? (
        <Text className="text-sm text-muted-foreground">{t("settings.locations.editor.gaps.placeNotSet")}</Text>
      ) : link.isPending ? (
        <Text className="text-sm text-muted-foreground">{t("settings.locations.editor.status.checking")}</Text>
      ) : link.isError || link.data === undefined ? (
        <Text className="text-sm text-muted-foreground">{t("settings.locations.editor.status.checkFailed")}</Text>
      ) : (
        <View className="gap-2">
          <View className="flex-row items-center gap-2">
            <Badge
              size="label-small"
              variant="subtle"
              color={link.data.verdict === "linked" ? "success" : "warning"}
              content={t(
                link.data.verdict === "linked"
                  ? "settings.locations.editor.status.linked"
                  : "settings.locations.editor.status.unlinked",
              )}
            />
            {claim ? (
              <Text className="text-xs text-muted-foreground">
                {t("settings.locations.editor.status.claim", { state: t(CLAIM_STATE_KEYS[claim.state]) })}
              </Text>
            ) : null}
          </View>
          {link.data.followedMergeFrom ? (
            <Text className="text-xs text-muted-foreground">{t("settings.locations.editor.status.mergeFollowed")}</Text>
          ) : null}
          {link.data.missing.map((gap) => (
            <Text key={gap} className="text-sm text-foreground">
              {t("settings.locations.editor.status.missingItem", { reason: t(PLACE_LINK_GAP_KEYS[gap]) })}
            </Text>
          ))}
          {claim?.state === "pending" && link.data.missing.includes("store_link_unverified") ? (
            <Text className="text-xs text-muted-foreground">{t("settings.locations.editor.status.pendingClaimHint")}</Text>
          ) : null}
        </View>
      )}
      {hasPlace ? (
        <View className="flex-row flex-wrap gap-2">
          <Button size="sm" tone="neutral" appearance="outline" loading={link.isFetching} onPress={() => link.refetch()}>
            {t("settings.locations.editor.status.checkAgain")}
          </Button>
          {link.data?.place?.url ? (
            <Button
              size="sm"
              tone="neutral"
              appearance="outline"
              onPress={() => {
                const url = link.data?.place?.url;
                if (url) void WebBrowser.openBrowserAsync(url);
              }}
            >
              {t("settings.locations.editor.openOnGoWay")}
            </Button>
          ) : null}
        </View>
      ) : null}
    </EditorSection>
  );
}
