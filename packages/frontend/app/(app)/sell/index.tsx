import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, TextInput, View } from "react-native";
import Head from "expo-router/head";
import { useLocalSearchParams, useRouter } from "expo-router";
import { openAccountDialog, useOxy } from "@oxyhq/services";
import { Text } from "@mercaria/ui";
import type { SellerDraftEntryPath } from "@mercaria/shared-types";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { useTranslation } from "@/lib/i18n";
import {
  useMatchCandidates,
  useSellerDrafts,
  useStartSellerDraft,
} from "@/lib/hooks/use-sell-yours";

/**
 * The IDENTIFY step (#91 entry paths 1–6).
 *
 * ## The client mints the flow's key once, on mount
 *
 * `clientDraftKey` is what makes a retried "start selling" tap resume rather
 * than open a second draft, and only the client knows that two taps are the same
 * INTENT. It is generated when this screen mounts and kept for its life, so a
 * double tap and a retry after a lost response both land on one draft.
 *
 * ## Arriving from a product page starts the flow AUTOMATICALLY; nothing else does
 *
 * A seller who tapped `Sell yours` has already chosen; asking again would be the
 * extra step the issue exists to remove. Every other path — a scan, a search,
 * "something unique" — waits for an explicit choice, because starting a draft is
 * a WRITE and a page view must never create one.
 *
 * ## An unmatched item is a first-class start, not a fallback
 *
 * "Something unique" sits beside the search box rather than under a "can't find
 * it?" link: a handmade chair is not a failed search, and #91 acceptance 5 is
 * that it publishes exactly as well as a matched phone.
 */
export default function SellIndexScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { isAuthenticated } = useOxy();
  const params = useLocalSearchParams<{
    canonicalProductId?: string;
    canonicalVariantId?: string;
    entryPath?: string;
  }>();

  // One key for the life of this screen — see the header.
  const clientDraftKey = useMemo(
    () => `sell-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    [],
  );
  const [query, setQuery] = useState("");
  const [scanned, setScanned] = useState("");

  const start = useStartSellerDraft();
  const drafts = useSellerDrafts();
  const candidates = useMatchCandidates(
    scanned ? { identifier: scanned } : query.length >= 2 ? { q: query } : {},
  );

  const arrivedFromProduct = Boolean(params.canonicalProductId);

  useEffect(() => {
    if (!isAuthenticated || !arrivedFromProduct || start.isPending || start.isSuccess) return;
    start.mutate(
      {
        clientDraftKey,
        entryPath: (params.entryPath as SellerDraftEntryPath | undefined) ?? "canonical_product",
        canonicalProductId: params.canonicalProductId,
        ...(params.canonicalVariantId ? { canonicalVariantId: params.canonicalVariantId } : {}),
      },
      { onSuccess: (draft) => router.replace(`/sell/${draft.id}`) },
    );
  }, [
    isAuthenticated,
    arrivedFromProduct,
    clientDraftKey,
    params.canonicalProductId,
    params.canonicalVariantId,
    params.entryPath,
    router,
    start,
  ]);

  if (!isAuthenticated) {
    return (
      <ScreenShell>
        <Head>
          <title>{t("sell.index.documentTitle")}</title>
        </Head>
        <View className="items-center gap-4 py-16">
          <Text className="text-lg font-medium">{t("sell.index.signIn.heading")}</Text>
          <Text className="text-center text-muted-foreground">
            {t("sell.index.signIn.body")}
          </Text>
          <Pressable
            accessibilityRole="button"
            className="rounded-full bg-primary px-5 py-3"
            onPress={() => openAccountDialog()}
          >
            <Text className="text-primary-foreground">{t("sell.index.signIn.action")}</Text>
          </Pressable>
        </View>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell>
      <Head>
        <title>{t("sell.index.documentTitle")}</title>
      </Head>

      <View className="gap-6 py-6">
        <Text className="text-2xl font-semibold">{t("sell.index.heading")}</Text>

        {arrivedFromProduct ? (
          <View className="flex-row items-center gap-3">
            <ActivityIndicator />
            <Text className="text-muted-foreground">{t("sell.index.startingDraft")}</Text>
          </View>
        ) : null}

        <View className="gap-2">
          <Text className="text-sm font-medium">{t("sell.index.scan.label")}</Text>
          <TextInput
            accessibilityLabel={t("sell.index.scan.accessibilityLabel")}
            className="rounded-xl border border-border px-4 py-3"
            placeholder={t("sell.index.scan.placeholder")}
            value={scanned}
            onChangeText={(next) => {
              setScanned(next);
              if (next) setQuery("");
            }}
          />
        </View>

        <View className="gap-2">
          <Text className="text-sm font-medium">{t("sell.index.search.label")}</Text>
          <TextInput
            accessibilityLabel={t("sell.index.search.accessibilityLabel")}
            className="rounded-xl border border-border px-4 py-3"
            placeholder={t("sell.index.search.placeholder")}
            value={query}
            onChangeText={(next) => {
              setQuery(next);
              if (next) setScanned("");
            }}
          />
        </View>

        {candidates.isFetching ? <ActivityIndicator /> : null}

        {(candidates.data ?? []).map((candidate) => (
          <Pressable
            key={`${candidate.canonicalProductId}:${candidate.canonicalVariantId ?? ""}`}
            accessibilityRole="button"
            className="rounded-xl border border-border p-4"
            onPress={() =>
              start.mutate(
                {
                  clientDraftKey,
                  entryPath: scanned ? "identifier_scan" : "catalog_search",
                  canonicalProductId: candidate.canonicalProductId,
                  ...(candidate.canonicalVariantId
                    ? { canonicalVariantId: candidate.canonicalVariantId }
                    : {}),
                },
                { onSuccess: (draft) => router.push(`/sell/${draft.id}`) },
              )
            }
          >
            <Text className="text-base font-medium">{candidate.title}</Text>
            {candidate.brand ? (
              <Text className="text-sm text-muted-foreground">{candidate.brand}</Text>
            ) : null}
            <Text className="text-xs text-muted-foreground">
              {candidate.foundBy === "identifier"
                ? t("sell.index.candidate.matchedByBarcode")
                : t("sell.index.candidate.foundBySearch")}
            </Text>
          </Pressable>
        ))}

        {/* An unmatched item is a first-class start — see the header. */}
        <Pressable
          accessibilityRole="button"
          className="rounded-xl border border-border p-4"
          onPress={() =>
            start.mutate(
              { clientDraftKey, entryPath: "unmatched" },
              { onSuccess: (draft) => router.push(`/sell/${draft.id}`) },
            )
          }
        >
          <Text className="text-base font-medium">{t("sell.index.unmatched.heading")}</Text>
          <Text className="text-sm text-muted-foreground">
            {t("sell.index.unmatched.body")}
          </Text>
        </Pressable>

        {(drafts.data ?? []).length > 0 ? (
          <View className="gap-2 pt-4">
            <Text className="text-sm font-medium">{t("sell.index.drafts.heading")}</Text>
            {(drafts.data ?? []).map((draft) => (
              <Pressable
                key={draft.id}
                accessibilityRole="button"
                className="rounded-xl border border-border p-4"
                onPress={() => router.push(`/sell/${draft.id}`)}
              >
                <Text className="text-base">{draft.title ?? t("sell.index.drafts.untitled")}</Text>
                <Text className="text-xs text-muted-foreground">
                  {t("sell.index.drafts.savedAt", {
                    when: new Date(draft.updatedAt).toLocaleString(),
                    step: draft.currentStep,
                  })}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {start.isError ? (
          <Text className="text-sm text-destructive">{start.error.message}</Text>
        ) : null}
      </View>
    </ScreenShell>
  );
}
