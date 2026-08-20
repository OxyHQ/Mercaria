import React, { useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import Head from "expo-router/head";
import { ChevronRight, Sparkles } from "lucide-react-native";
import type {
  AuthoringCanonicalCandidate,
  AuthoringCategoryOption,
  AuthoringProductTypeOption,
} from "@mercaria/shared-types";
import { Button, Input, Label, Skeleton, Text, useColorScheme } from "@mercaria/ui";
import { toast } from "@oxyhq/bloom/toast";
import { Screen, ScreenMessage } from "@/components/shell/Screen";
import { RequireStore } from "@/components/shell/RequireStore";
import { CanonicalSearchPanel } from "@/components/catalog-authoring/CanonicalSearchPanel";
import { CategoryBrowser } from "@/components/catalog-authoring/CategoryBrowser";
import { useTranslation } from "@/lib/i18n";
import {
  useAuthoringAvailability,
  useAuthoringProductTypes,
  useCreateProductDraft,
  useProductDrafts,
} from "@/lib/authoring/hooks";
import { patchProductDraft } from "@/lib/authoring/api";
import { deviceMarket, isValidMarket, normalizeMarket } from "@/lib/authoring/market";
import { authoringLabel } from "@/lib/authoring/untranslated";

export default function ProductWizardStartScreen() {
  const { t } = useTranslation();
  return (
    <>
      <Head>
        <title>{t("products.wizard.start.documentTitle")}</title>
      </Head>
      <RequireStore permission="products:write">
        {(storeId) => <StartBody storeId={storeId} />}
      </RequireStore>
    </>
  );
}

/**
 * Step 1 — identify what is being sold.
 *
 * ## Two lanes that converge
 *
 * A merchant either RECOGNISES the thing in the canonical catalogue or is
 * describing something new. Both lanes end at the same place, because a draft
 * pins a category and a product-type version and cannot be created without one:
 * `AuthoringCanonicalCandidate` is deliberately thin — an id, a name, a brand
 * and the identifiers that tell two regional models apart — and carries no
 * category to skip the step with.
 *
 * That is stated on screen rather than hidden behind a spinner, because a
 * merchant who has just found their exact product and is then asked to classify
 * it deserves to know why.
 *
 * ## Progress survives a locale change
 *
 * Every choice here is component state keyed on ids: the picked candidate, the
 * category trail, the chosen category and type, the market. The locale is only
 * a query PARAMETER, so switching language refetches the names and leaves all
 * of it standing.
 */
function StartBody({ storeId }: { storeId: string }) {
  const router = useRouter();
  const { t, locale } = useTranslation();
  const { colors } = useColorScheme();

  const availability = useAuthoringAvailability(locale);
  const drafts = useProductDrafts(storeId, "open");
  const createDraft = useCreateProductDraft(storeId);

  const [candidate, setCandidate] = useState<AuthoringCanonicalCandidate | null>(null);
  const [category, setCategory] = useState<AuthoringCategoryOption | null>(null);
  const [productType, setProductType] = useState<AuthoringProductTypeOption | null>(null);
  const [market, setMarket] = useState<string>(() => deviceMarket());

  const productTypes = useAuthoringProductTypes(category?.id ?? null, locale);

  if (availability.isPending) {
    return (
      <Screen title={t("products.wizard.start.title")}>
        <View className="gap-3">
          <Skeleton className="h-24 w-full rounded-2xl" />
          <Skeleton className="h-24 w-full rounded-2xl" />
        </View>
      </Screen>
    );
  }

  // The surface is not mounted on this deployment (`CATALOG_AUTHORING_ENABLED`).
  // The legacy form is still there and is where the merchant is sent, which is
  // what makes turning the wizard on a deployment decision rather than a
  // release.
  if (availability.data?.outcome === "unavailable") {
    return (
      <Screen title={t("products.wizard.start.title")}>
        <ScreenMessage
          title={t("products.wizard.start.unavailableTitle")}
          body={t("products.wizard.start.unavailableBody")}
        />
        <Button className="self-center" onPress={() => router.replace("/products/new")}>
          <Text className="font-semibold text-primary-foreground">
            {t("products.wizard.start.useLegacy")}
          </Text>
        </Button>
      </Screen>
    );
  }

  if (availability.isError) {
    return (
      <Screen title={t("products.wizard.start.title")}>
        <ScreenMessage
          title={t("common.somethingWentWrong")}
          body={t("common.pleaseTryAgain")}
        />
      </Screen>
    );
  }

  const marketValid = isValidMarket(market);
  const canCreate = category !== null && productType !== null && marketValid;

  /**
   * Create the draft, then attach the chosen identity to it.
   *
   * The attachment is a SECOND request rather than a field on the create,
   * because `POST /product-drafts` takes no canonical selection — the pin is a
   * property of an existing draft, and inventing a create-time parameter would
   * be a shape the server does not accept. A failure there is reported and the
   * wizard is still opened: the canonical step re-offers the search, and
   * refusing to navigate would strand a draft that was successfully created.
   */
  const start = async () => {
    if (category === null || productType === null || !marketValid) return;
    let draft;
    try {
      draft = await createDraft.mutateAsync({
        categoryId: category.id,
        productTypeKey: productType.key,
        version: productType.version,
        locale,
        market: normalizeMarket(market),
      });
    } catch {
      toast.error(t("products.wizard.start.createFailed"));
      return;
    }

    if (candidate !== null) {
      const canonicalProductId =
        candidate.kind === "canonical_product" ? candidate.id : candidate.canonicalProductId;
      if (canonicalProductId !== null) {
        const outcome = await patchProductDraft(storeId, draft.id, {
          version: draft.version,
          selectedCanonicalProductId: canonicalProductId,
        }).catch(() => null);
        if (outcome === null || outcome.outcome !== "saved") {
          toast.error(t("products.wizard.start.linkFailed"));
        }
      }
    }
    router.push({ pathname: "/products/wizard/[draftId]", params: { draftId: draft.id } });
  };

  return (
    <Screen title={t("products.wizard.start.title")} subtitle={t("products.wizard.start.subtitle")}>
      <View className="gap-6">
        {(drafts.data ?? []).length > 0 ? (
          <View className="gap-2 rounded-2xl border border-border bg-surface p-4">
            <Text className="text-sm font-semibold text-foreground">
              {t("products.wizard.start.resumeTitle")}
            </Text>
            {(drafts.data ?? []).slice(0, 5).map((draft) => (
              <Pressable
                key={draft.id}
                accessibilityRole="link"
                accessibilityLabel={
                  draft.title === null || draft.title.length === 0
                    ? t("products.wizard.start.untitledDraft")
                    : draft.title
                }
                onPress={() =>
                  router.push({
                    pathname: "/products/wizard/[draftId]",
                    params: { draftId: draft.id },
                  })
                }
                className="flex-row items-center justify-between gap-3 rounded-xl px-2 py-2 active:bg-muted"
              >
                <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
                  {draft.title === null || draft.title.length === 0
                    ? t("products.wizard.start.untitledDraft")
                    : draft.title}
                </Text>
                <ChevronRight size={16} color={colors.mutedForeground} />
              </Pressable>
            ))}
          </View>
        ) : null}

        <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
          <View className="flex-row items-center gap-2">
            <Sparkles size={16} color={colors.primary} />
            <Text className="flex-1 text-sm font-semibold text-foreground">
              {t("products.wizard.start.findTitle")}
            </Text>
          </View>
          <Text className="text-xs text-muted-foreground">
            {t("products.wizard.start.findBody")}
          </Text>
          <CanonicalSearchPanel
            selectedId={candidate?.id ?? null}
            onSelect={setCandidate}
            onClear={() => setCandidate(null)}
          />
          {candidate === null ? null : (
            <Text className="text-xs text-muted-foreground">
              {t("products.wizard.start.classifyAnyway")}
            </Text>
          )}
        </View>

        <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
          <Text className="text-sm font-semibold text-foreground">
            {t("products.wizard.start.categoryTitle")}
          </Text>
          <CategoryBrowser
            locale={locale}
            selectedId={category?.id ?? null}
            onSelect={(next) => {
              setCategory(next);
              setProductType(null);
            }}
          />
        </View>

        {category === null ? null : (
          <View className="gap-3 rounded-2xl border border-border bg-surface p-4">
            <Text className="text-sm font-semibold text-foreground">
              {t("products.wizard.start.typeTitle")}
            </Text>
            {productTypes.isPending ? <Skeleton className="h-11 w-full rounded-xl" /> : null}
            {productTypes.data !== undefined && productTypes.data.length === 0 ? (
              <Text className="text-sm text-muted-foreground">
                {t("products.wizard.start.noProductTypes")}
              </Text>
            ) : null}
            <View className="gap-2">
              {(productTypes.data ?? []).map((option) => {
                const isSelected = option.definitionId === productType?.definitionId;
                // #740. Derived ONCE: the visible text and the accessibility
                // label are the same fact, and two `??` chains for one fact is
                // how they drift.
                const name = authoringLabel(option.name, { kind: "key", key: option.key }, t).text;
                return (
                  <Pressable
                    key={option.definitionId}
                    accessibilityRole="button"
                    accessibilityLabel={name}
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => setProductType(option)}
                    className={[
                      "rounded-xl border px-3 py-3 active:opacity-80",
                      isSelected ? "border-primary bg-muted" : "border-border",
                    ].join(" ")}
                  >
                    <Text className="text-base text-foreground">{name}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}

        <View className="gap-1.5 rounded-2xl border border-border bg-surface p-4">
          <Label>{t("products.wizard.start.marketLabel")}</Label>
          <Text className="text-xs text-muted-foreground">
            {t("products.wizard.start.marketHelp")}
          </Text>
          <Input
            value={market}
            onChangeText={setMarket}
            placeholder={t("products.wizard.start.marketPlaceholder")}
            accessibilityLabel={t("products.wizard.start.marketLabel")}
            autoCapitalize="characters"
            maxLength={2}
            className="w-24"
          />
          {market.length > 0 && !marketValid ? (
            <Text className="text-xs text-destructive">
              {t("products.wizard.start.marketInvalid")}
            </Text>
          ) : null}
        </View>

        <Button
          onPress={() => {
            void start();
          }}
          disabled={!canCreate}
          isLoading={createDraft.isPending}
        >
          <Text className="font-semibold text-primary-foreground">
            {t("products.wizard.start.begin")}
          </Text>
        </Button>
      </View>
    </Screen>
  );
}
