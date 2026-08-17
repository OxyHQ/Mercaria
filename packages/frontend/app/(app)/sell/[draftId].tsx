import { useState } from "react";
import { ActivityIndicator, Pressable, TextInput, View } from "react-native";
import Head from "expo-router/head";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Text } from "@mercaria/ui";
import type { ItemConditionKey, SellerDraftBlockReason } from "@mercaria/shared-types";
import { ITEM_CONDITION_KEYS } from "@mercaria/shared-types";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { InheritedFact } from "@/components/sell/InheritedFact";
import { PriceGuidancePanel } from "@/components/sell/PriceGuidancePanel";
import { useTranslation } from "@/lib/i18n";
import {
  usePatchSellerDraft,
  usePublishSellerDraft,
  useSellerDraftPreview,
} from "@/lib/hooks/use-sell-yours";

/**
 * The sell form — one screen over the server's own step state (#91 UX 1–8).
 *
 * ## Progress lives on the SERVER, so another Oxy client resumes exactly here
 *
 * `currentStep` and `completedSteps` are columns, not component state. That is
 * what makes "resume on another Oxy client" work at all, and it is why every
 * navigation between steps is a PATCH rather than a `setState`.
 *
 * ## Product facts and `your item` facts are visibly different things
 *
 * Everything the canonical product supplied renders through `InheritedFact`,
 * muted and labelled "From the product — not a statement about your item". The
 * seller's own answers sit in their own block. The distinction is the issue's
 * whole safety argument, and the server carries the `origin` so this screen
 * cannot get it wrong by deciding for itself.
 *
 * ## The publish button reads the server's readiness and nothing else
 *
 * Whether a draft may be published is DERIVED from four tables in three domains
 * — including a category's condition restrictions and whether the match gate
 * refused a declaration — so a client-side "is it complete" check would be a
 * second answer that goes stale. Every block reason has its own key here and its
 * own sentence in the bundles; the server sends codes precisely so they can be
 * translated and tested.
 */

const BLOCK_MESSAGE_KEYS: Record<SellerDraftBlockReason, string> = {
  title_missing: "sell.draft.blocked.titleMissing",
  description_missing: "sell.draft.blocked.descriptionMissing",
  category_missing: "sell.draft.blocked.categoryMissing",
  condition_missing: "sell.draft.blocked.conditionMissing",
  item_photos_missing: "sell.draft.blocked.itemPhotosMissing",
  defects_not_acknowledged: "sell.draft.blocked.defectsNotAcknowledged",
  refurbisher_not_named: "sell.draft.blocked.refurbisherNotNamed",
  price_missing: "sell.draft.blocked.priceMissing",
  quantity_invalid: "sell.draft.blocked.quantityInvalid",
  match_variant_missing: "sell.draft.blocked.matchVariantMissing",
  match_review_required: "sell.draft.blocked.matchReviewRequired",
  pickup_not_supported: "sell.draft.blocked.pickupNotSupported",
  category_forbids_condition: "sell.draft.blocked.categoryForbidsCondition",
  already_published: "sell.draft.blocked.alreadyPublished",
  draft_discarded: "sell.draft.blocked.draftDiscarded",
};

const WARNING_MESSAGE_KEYS: Record<string, string> = {
  price_far_above_guidance: "sell.draft.warning.priceFarAboveGuidance",
  price_far_below_guidance: "sell.draft.warning.priceFarBelowGuidance",
};

export default function SellDraftScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { draftId } = useLocalSearchParams<{ draftId: string }>();
  const preview = useSellerDraftPreview(draftId);
  const patch = usePatchSellerDraft(draftId);
  const publish = usePublishSellerDraft();

  const [title, setTitle] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);

  if (preview.isPending) {
    return (
      <ScreenShell>
        <View className="items-center py-16">
          <ActivityIndicator />
        </View>
      </ScreenShell>
    );
  }

  if (preview.isError || !preview.data) {
    return (
      <ScreenShell>
        <View className="items-center gap-3 py-16">
          <Text className="text-lg font-medium">{t("sell.draft.loadError.title")}</Text>
          <Text className="text-center text-muted-foreground">
            {preview.error?.message ?? t("sell.draft.loadError.body")}
          </Text>
        </View>
      </ScreenShell>
    );
  }

  const { draft, readiness, placement, guidance } = preview.data;

  return (
    <ScreenShell>
      <Head>
        <title>
          {t("sell.draft.documentTitle", { title: draft.title ?? t("sell.draft.untitled") })}
        </title>
      </Head>

      <View className="gap-6 py-6">
        {draft.prefill ? (
          <View className="gap-1 rounded-2xl border border-border p-4">
            <Text className="text-base font-medium">{t("sell.draft.product.heading")}</Text>
            <Text className="text-xs text-muted-foreground">
              {t("sell.draft.product.explanation")}
            </Text>
            <InheritedFact
              label={t("sell.draft.product.titleLabel")}
              value={draft.prefill.title.value}
              origin={draft.prefill.title.origin}
              confirmed={draft.prefill.title.confirmed}
            />
            {draft.prefill.brand ? (
              <InheritedFact
                label={t("sell.draft.product.brandLabel")}
                value={draft.prefill.brand.value}
                origin={draft.prefill.brand.origin}
                confirmed={draft.prefill.brand.confirmed}
              />
            ) : null}
            {draft.prefill.model ? (
              <InheritedFact
                label={t("sell.draft.product.modelLabel")}
                value={draft.prefill.model.value}
                origin={draft.prefill.model.origin}
                confirmed={draft.prefill.model.confirmed}
              />
            ) : null}
            {draft.prefill.variantAttributes.map((attribute) => (
              <InheritedFact
                key={attribute.value.key}
                label={attribute.value.key}
                value={attribute.value.value}
                origin={attribute.origin}
                confirmed={attribute.confirmed}
              />
            ))}
            <Pressable
              accessibilityRole="button"
              className="mt-2 self-start rounded-full border border-border px-4 py-2"
              onPress={() => patch.mutate({ canonicalProductId: null })}
            >
              <Text className="text-sm">{t("sell.draft.product.notMine")}</Text>
            </Pressable>
          </View>
        ) : null}

        <View className="gap-4 rounded-2xl border border-border p-4">
          <Text className="text-base font-medium">{t("sell.draft.item.heading")}</Text>

          <View className="gap-2">
            <Text className="text-sm font-medium">{t("sell.draft.item.titleLabel")}</Text>
            <TextInput
              accessibilityLabel={t("sell.draft.item.titleLabel")}
              className="rounded-xl border border-border px-4 py-3"
              value={title ?? draft.title ?? ""}
              onChangeText={setTitle}
              onBlur={() => {
                if (title !== null && title !== draft.title) patch.mutate({ title });
              }}
            />
            {draft.titleOverridesCanonical ? (
              <Text className="text-xs text-muted-foreground">
                {t("sell.draft.item.titleOverrideNote")}
              </Text>
            ) : null}
          </View>

          <View className="gap-2">
            <Text className="text-sm font-medium">{t("sell.draft.item.descriptionLabel")}</Text>
            <TextInput
              accessibilityLabel={t("sell.draft.item.descriptionLabel")}
              className="min-h-24 rounded-xl border border-border px-4 py-3"
              multiline
              value={description ?? draft.description ?? ""}
              onChangeText={setDescription}
              onBlur={() => {
                if (description !== null && description !== draft.description) {
                  patch.mutate({ description });
                }
              }}
            />
          </View>

          <View className="gap-2">
            <Text className="text-sm font-medium">{t("sell.draft.item.conditionLabel")}</Text>
            <View className="flex-row flex-wrap gap-2">
              {ITEM_CONDITION_KEYS.map((key: ItemConditionKey) => (
                <Pressable
                  key={key}
                  accessibilityRole="button"
                  className={
                    draft.conditionKey === key
                      ? "rounded-full bg-primary px-3 py-2"
                      : "rounded-full border border-border px-3 py-2"
                  }
                  onPress={() => patch.mutate({ conditionKey: key })}
                >
                  <Text
                    className={draft.conditionKey === key ? "text-primary-foreground text-sm" : "text-sm"}
                  >
                    {key.replace(/_/g, " ")}
                  </Text>
                </Pressable>
              ))}
            </View>
            {readiness.requiredItemPhotos > 0 ? (
              <Text className="text-xs text-muted-foreground">
                {t("sell.draft.item.photoRequirement", {
                  count: readiness.requiredItemPhotos,
                })}
              </Text>
            ) : null}
          </View>
        </View>

        {guidance ? <PriceGuidancePanel guidance={guidance} /> : null}

        <View className="gap-2 rounded-2xl border border-border p-4">
          <Text className="text-base font-medium">{t("sell.draft.placement.heading")}</Text>
          <Text className="text-sm text-muted-foreground">
            {placement.onCanonicalProduct
              ? t("sell.draft.placement.onProductPage")
              : t("sell.draft.placement.ownSurfacesOnly")}
          </Text>
          {placement.inLocalResults ? (
            <Text className="text-sm text-muted-foreground">
              {t("sell.draft.placement.localResults")}
            </Text>
          ) : null}
        </View>

        {readiness.warnings.map((warning) => (
          <Text key={warning} className="text-sm text-muted-foreground">
            {WARNING_MESSAGE_KEYS[warning] ? t(WARNING_MESSAGE_KEYS[warning]) : ""}
          </Text>
        ))}

        {readiness.blockReasons.map((reason) => (
          <Text key={reason} className="text-sm text-destructive">
            {t(BLOCK_MESSAGE_KEYS[reason])}
          </Text>
        ))}

        <Pressable
          accessibilityRole="button"
          disabled={!readiness.publishable || publish.isPending}
          className={
            readiness.publishable
              ? "items-center rounded-full bg-primary px-5 py-4"
              : "items-center rounded-full bg-muted px-5 py-4"
          }
          onPress={() =>
            publish.mutate(draftId, {
              onSuccess: (result) => router.replace(`/products/${result.listingId}`),
            })
          }
        >
          <Text className={readiness.publishable ? "text-primary-foreground" : "text-muted-foreground"}>
            {publish.isPending ? t("sell.draft.publishing") : t("sell.draft.publish")}
          </Text>
        </Pressable>

        {publish.isError ? (
          <Text className="text-sm text-destructive">{publish.error.message}</Text>
        ) : null}
      </View>
    </ScreenShell>
  );
}
