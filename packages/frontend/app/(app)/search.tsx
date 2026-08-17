import { useCallback, useEffect, useMemo } from "react";
import { ActivityIndicator, View } from "react-native";
import Head from "expo-router/head";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Search } from "@oxyhq/bloom/search";
import {
  SearchClarification,
  SearchInterpretation,
  Text,
  type InterpretationChip,
} from "@mercaria/ui";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { useTranslation } from "@/lib/i18n";
import { useSearchIntent } from "@/lib/hooks/use-search-intent";
import type { SearchResultKind } from "@mercaria/shared-types";

/**
 * What each result KIND is called on screen.
 *
 * The row used to render `result.kind` directly, so a shopper saw the wire
 * value — `product_family`, underscore and all — in every language. There was
 * no string literal anywhere for a scanner to find, which is why neither the
 * i18n guard nor any census reported it.
 *
 * KEYS, and frozen on the NEXT line rather than `Object.freeze({ … })`: the
 * guard's key reader matches a `const X = { … }` initializer, and a call
 * expression is not one, so freezing inline would hide these five from its
 * referential check.
 */
const SEARCH_RESULT_KIND_KEYS: Readonly<Record<SearchResultKind, string>> = {
  product: "search.kind.product",
  brand: "search.kind.brand",
  product_family: "search.kind.productFamily",
  merchant: "search.kind.merchant",
  storefront: "search.kind.storefront",
};
Object.freeze(SEARCH_RESULT_KIND_KEYS);

/**
 * `/search` — natural-language shopping search (#95 "Client experience").
 *
 * ## The conversational box IS the ordinary box
 *
 * #95 client rule 1 asks that a conversational search box "coexist with
 * ordinary search and filters", and the cheapest correct reading of that is one
 * box: a shopper types whatever they type, the server interprets it, and what
 * they get back is a plain search plus an explanation of how it was read. There
 * is no mode switch to find and nothing to opt into — which also means there is
 * no state in which a shopper is talking to something that cannot answer.
 *
 * ## The URL carries the QUERY and nothing else (#95 client rule 6)
 *
 * "Preserve query state in a share-safe URL without exposing private
 * clarification history" is two requirements, and the second is why the session
 * id, the answers and the interpretation are NOT in the URL. A shared link
 * re-interprets from scratch, which is the same thing the recipient would have
 * got by typing the query — and it carries no record of what the sender was
 * asked or how they answered.
 *
 * ## What this screen does when the canonical surface is not rolled out
 *
 * `GET /search` answers 404 unless `CANONICAL_SEARCH=on` (#70's own lever), and
 * that is the SHIPPED default. The interpretation still renders — it is a
 * different endpoint with a different lever — so a shopper sees exactly what
 * Mercaria understood and a sentence saying results are not available here yet.
 * Rendering a spinner forever, or an empty-results message, would both be
 * saying something false about the catalogue.
 */
export default function SearchScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ q?: string }>();
  const initialQuery = typeof params.q === "string" ? params.q : "";
  const { term, setTerm, interpret, interpretation, removed, removeChip, dismiss, results } =
    useSearchIntent();

  // The URL is the source of the term on entry, so a shared link and a typed
  // query take the same path. `interpret` is a mutation rather than a query
  // precisely so this is the ONLY place it fires — a query keyed on the term
  // would re-parse on every focus, and a parse may call a provider.
  useEffect(() => {
    if (initialQuery.trim().length === 0) return;
    setTerm(initialQuery);
    interpret.mutate({ query: initialQuery });
    // `interpret` is stable per mutation instance and re-running on it would
    // re-parse on every render; the URL's query is the only real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  const submit = useCallback(
    (query: string) => {
      const trimmed = query.trim();
      if (trimmed.length === 0) return;
      // The URL first, so a reload and a share both reproduce this search.
      router.setParams({ q: trimmed });
      setTerm(trimmed);
      interpret.mutate({ query: trimmed });
    },
    [interpret, router, setTerm],
  );

  const answer = useCallback(
    (clarificationId: string, optionId: string) => {
      if (interpretation === undefined) return;
      interpret.mutate({
        query: term,
        ...(interpretation.sessionId === undefined ? {} : { sessionId: interpretation.sessionId }),
        answer: { clarificationId, optionId },
      });
    },
    [interpret, interpretation, term],
  );

  /**
   * The chips, derived from the plan.
   *
   * The ORIGIN comes from the interpretation's own map and the STRENGTH from the
   * constraint itself, so a chip cannot claim a voice or a severity the server
   * did not assign. A chip whose constraint the shopper has removed is dropped
   * rather than greyed: a control that renders a requirement no longer in force
   * is the thing that makes an interpretation untrustworthy.
   */
  const chips = useMemo<InterpretationChip[]>(() => {
    if (interpretation === undefined) return [];
    const removedIds = new Set(removed);
    return interpretation.interpretation.constraints.constraints
      .filter((constraint) => !removedIds.has(constraint.id))
      .map((constraint) => ({
        id: constraint.id,
        label: constraint.explanation,
        origin: interpretation.interpretation.origins[constraint.id] ?? "deterministic_rule",
        strength: constraint.strength,
        // A filter the shopper selected themselves is removed where they
        // selected it; a second control for one fact is how two views of it
        // start disagreeing.
        editable: interpretation.interpretation.origins[constraint.id] !== "user_explicit",
      }));
  }, [interpretation, removed]);

  const paraphrase = useMemo(
    () =>
      (interpretation?.paraphrase ?? []).map((line) => ({
        id: line.subjectId,
        text: line.text,
        origin: line.origin,
      })),
    [interpretation],
  );

  const gaps = useMemo(
    () =>
      (interpretation?.unresolved ?? []).map((entry, index) => ({
        id: entry.constraintId ?? `gap-${index}`,
        phrase: entry.phrase,
        explanation: entry.explanation,
      })),
    [interpretation],
  );

  const clarification = interpretation?.clarifications[0];

  return (
    <ScreenShell>
      <Head>
        <title>{t("search.headTitle")}</title>
      </Head>

      <View className="w-full max-w-3xl gap-4 self-center px-4 py-6">
        <Search
          label={t("search.box.label")}
          placeholder={t("search.box.placeholder")}
          value={term}
          onChangeText={setTerm}
          onClearText={() => setTerm("")}
          onSubmitEditing={() => submit(term)}
        />

        {interpret.isPending ? (
          <View className="items-center py-4">
            <ActivityIndicator />
          </View>
        ) : null}

        {interpret.isError ? (
          <Text className="text-sm text-muted-foreground">
            {/* The server's own refusal message names the requirement it could
                not narrow by, because the remedy is to drop or loosen that
                specific one — a code would leave a shopper with nothing to
                act on. */}
            {interpret.error instanceof Error
              ? interpret.error.message
              : t("search.readError")}
          </Text>
        ) : null}

        {interpretation !== undefined ? (
          <SearchInterpretation
            paraphrase={paraphrase}
            chips={chips}
            gaps={gaps}
            mode={interpretation.mode}
            onRemove={removeChip}
            onDismiss={dismiss}
            dismissLabel={t("search.dismissLabel")}
          />
        ) : null}

        {clarification !== undefined ? (
          <SearchClarification
            question={clarification.question}
            options={clarification.options}
            onAnswer={(optionId) => answer(clarification.id, optionId)}
            onSkip={() => undefined}
            skipLabel={t("search.skipLabel")}
          />
        ) : null}

        {results.isPending && term.trim().length > 0 ? (
          <View className="items-center py-6">
            <ActivityIndicator />
          </View>
        ) : null}

        {results.isError ? (
          <Text className="text-sm text-muted-foreground">{t("search.resultsUnavailable")}</Text>
        ) : null}

        {results.data !== undefined ? (
          <View className="gap-3">
            {results.data.results.length === 0 ? (
              <Text className="text-sm text-muted-foreground">{t("search.noMatches")}</Text>
            ) : null}
            {results.data.results.map((result) => (
              <View
                key={`${result.kind}-${
                  result.kind === "product"
                    ? result.canonicalProductId
                    : result.kind === "brand"
                      ? result.brandId
                      : result.kind === "product_family"
                        ? result.productFamilyId
                        : result.kind === "merchant"
                          ? result.merchantId
                          : result.storefrontId
                }`}
                className="rounded-xl border border-border bg-card px-4 py-3"
              >
                <Text className="text-sm text-foreground">{result.name}</Text>
                <Text className="text-xs text-muted-foreground">{t(SEARCH_RESULT_KIND_KEYS[result.kind])}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </ScreenShell>
  );
}
