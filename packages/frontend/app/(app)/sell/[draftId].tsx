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
 * second answer that goes stale. Every block reason has its own sentence here;
 * the server sends codes precisely so they can be translated and tested.
 */

const BLOCK_MESSAGES: Record<SellerDraftBlockReason, string> = {
  title_missing: "Give your listing a title.",
  description_missing: "Describe what you are selling.",
  category_missing: "Choose a category.",
  condition_missing: "Say what condition your item is in.",
  item_photos_missing: "Add photographs of your actual item.",
  defects_not_acknowledged: "Confirm you have disclosed any defects and missing parts.",
  refurbisher_not_named: "Say who refurbished the item.",
  price_missing: "Set a price.",
  quantity_invalid: "Quantity must be at least one.",
  match_variant_missing: "Choose which exact version of the product you are selling.",
  match_review_required:
    "We could not confirm this is the same product. Change or remove the product match to continue.",
  pickup_not_supported: "Collection is not available yet — remove it to publish.",
  category_forbids_condition: "This category does not accept that condition.",
  already_published: "This listing is already published.",
  draft_discarded: "This draft was discarded.",
};

const WARNING_MESSAGES: Record<string, string> = {
  price_far_above_guidance:
    "Your price is well above what similar items are selling for. You can still publish it.",
  price_far_below_guidance:
    "Your price is well below what similar items are selling for. You can still publish it.",
};

export default function SellDraftScreen() {
  const router = useRouter();
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
          <Text className="text-lg font-medium">We could not open this draft</Text>
          <Text className="text-center text-muted-foreground">
            {preview.error?.message ?? "It may have been published or discarded."}
          </Text>
        </View>
      </ScreenShell>
    );
  }

  const { draft, readiness, placement, guidance } = preview.data;

  return (
    <ScreenShell>
      <Head>
        <title>{draft.title ?? "Your listing"} · Mercaria</title>
      </Head>

      <View className="gap-6 py-6">
        {draft.prefill ? (
          <View className="gap-1 rounded-2xl border border-border p-4">
            <Text className="text-base font-medium">The product</Text>
            <Text className="text-xs text-muted-foreground">
              These come from Mercaria&apos;s catalogue. They identify the model — they say
              nothing about the condition, the accessories or the authenticity of your item.
            </Text>
            <InheritedFact
              label="Title"
              value={draft.prefill.title.value}
              origin={draft.prefill.title.origin}
              confirmed={draft.prefill.title.confirmed}
            />
            {draft.prefill.brand ? (
              <InheritedFact
                label="Brand"
                value={draft.prefill.brand.value}
                origin={draft.prefill.brand.origin}
                confirmed={draft.prefill.brand.confirmed}
              />
            ) : null}
            {draft.prefill.model ? (
              <InheritedFact
                label="Model"
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
              <Text className="text-sm">This is not my product</Text>
            </Pressable>
          </View>
        ) : null}

        <View className="gap-4 rounded-2xl border border-border p-4">
          <Text className="text-base font-medium">Your item</Text>

          <View className="gap-2">
            <Text className="text-sm font-medium">Listing title</Text>
            <TextInput
              accessibilityLabel="Listing title"
              className="rounded-xl border border-border px-4 py-3"
              value={title ?? draft.title ?? ""}
              onChangeText={setTitle}
              onBlur={() => {
                if (title !== null && title !== draft.title) patch.mutate({ title });
              }}
            />
            {draft.titleOverridesCanonical ? (
              <Text className="text-xs text-muted-foreground">
                Your title is shown on your listing. It does not change the product.
              </Text>
            ) : null}
          </View>

          <View className="gap-2">
            <Text className="text-sm font-medium">Description</Text>
            <TextInput
              accessibilityLabel="Description"
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
            <Text className="text-sm font-medium">Condition</Text>
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
                This condition needs at least {readiness.requiredItemPhotos} photograph
                {readiness.requiredItemPhotos === 1 ? "" : "s"} of your actual item. Catalogue and
                manufacturer pictures cannot stand in for them.
              </Text>
            ) : null}
          </View>
        </View>

        {guidance ? <PriceGuidancePanel guidance={guidance} /> : null}

        <View className="gap-2 rounded-2xl border border-border p-4">
          <Text className="text-base font-medium">Where it will appear</Text>
          <Text className="text-sm text-muted-foreground">
            {placement.onCanonicalProduct
              ? "On the product page, alongside other sellers"
              : "In search and on your seller profile — not on a product page"}
          </Text>
          {placement.inLocalResults ? (
            <Text className="text-sm text-muted-foreground">
              In local results, at the rough area you chose
            </Text>
          ) : null}
        </View>

        {readiness.warnings.map((warning) => (
          <Text key={warning} className="text-sm text-muted-foreground">
            {WARNING_MESSAGES[warning] ?? ""}
          </Text>
        ))}

        {readiness.blockReasons.map((reason) => (
          <Text key={reason} className="text-sm text-destructive">
            {BLOCK_MESSAGES[reason]}
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
            {publish.isPending ? "Publishing…" : "Publish listing"}
          </Text>
        </Pressable>

        {publish.isError ? (
          <Text className="text-sm text-destructive">{publish.error.message}</Text>
        ) : null}
      </View>
    </ScreenShell>
  );
}
