import { useMemo, useState } from "react";
import { ActivityIndicator, Linking, Pressable, View } from "react-native";
import Head from "expo-router/head";
import { useLocalSearchParams } from "expo-router";
import {
  BasketPlanCard,
  ComparisonExplanationBlock,
  ComparisonTableView,
  Text,
  CONDITION_A11Y_LABEL_KEY,
  conditionGroupLabelKey,
} from "@mercaria/ui";
import type {
  BasketChannelPolicy,
  BasketObjective,
  BasketResult,
  ConditionGroup,
} from "@mercaria/shared-types";
import {
  BASKET_CHANNEL_POLICIES,
  BASKET_OBJECTIVES,
  CONDITION_GROUPS,
} from "@mercaria/shared-types";
import { ScreenShell } from "@/components/shell/ScreenShell";
import {
  useBasketSolution,
  useProductComparison,
  useRevalidateBasketPlan,
} from "@/lib/hooks/use-comparison";
import { assessComparability, parseComparisonSubjects } from "@/lib/catalog/comparison";
import { useTranslation } from "@/lib/i18n";

/**
 * The KEY of the words a shopper reads for each member of a server-owned
 * vocabulary.
 *
 * A `Record` over the union, never an ARRAY of `{value, label}` pairs, and the
 * difference is enforceable rather than stylistic: a `Record<Union, string>`
 * cannot omit a member, so adding one to `BasketChannelPolicy` fails `tsc`
 * here. An array is a SUBSET that goes on compiling while the control silently
 * stops offering the new choice — which is the drift
 * `scripts/validate-storefront-catalog-driven.mjs` wall 5 refuses, and which
 * both of these lists had.
 *
 * The ORDER a shopper sees is the tuple's own, so the copy carries no ordering
 * decision either.
 *
 * These hold KEYS rather than sentences. A `const` evaluated at import cannot
 * call `t()` — the locale store has not rehydrated — so English here would
 * freeze whichever language loaded first, and `ChoiceRow` resolves each at the
 * render site instead. The keys stay literal so the i18n guard can see every
 * leaf is referenced.
 */
const CHANNEL_LABEL_KEYS: Readonly<Record<BasketChannelPolicy, string>> = {
  mixed: "compare.channel.mixed",
  native_only: "compare.channel.nativeOnly",
  external_only: "compare.channel.externalOnly",
  official_only: "compare.channel.officialOnly",
};
Object.freeze(CHANNEL_LABEL_KEYS);

const OBJECTIVE_LABEL_KEYS: Readonly<Record<BasketObjective, string>> = {
  cheapest_known_item_prices: "compare.objective.cheapestKnownItemPrices",
  cheapest_known_total: "compare.objective.cheapestKnownTotal",
  fewest_merchants: "compare.objective.fewestMerchants",
  all_native: "compare.objective.allNative",
  fastest_known_delivery: "compare.objective.fastestKnownDelivery",
};
Object.freeze(OBJECTIVE_LABEL_KEYS);

/**
 * Compare products and plan a basket (#96 §"User experience").
 *
 * ## The deterministic table comes FIRST, always
 *
 * The table is rendered above the narrative and does not depend on it (UX
 * rule 3). `ComparisonTableView` takes no explanation prop at all, so this
 * screen could not make the comparison conditional on a model having answered
 * even if it wanted to.
 *
 * ## The two actions are separate and the external one is confirmed per merchant
 *
 * `BasketPlanCard` exposes one native-cart callback and one
 * `onOpenExternalMerchant(index)`, with no bulk affordance between them — UX
 * rules 5 and 6 held by the component's shape rather than by this screen's
 * discipline. Both go through REVALIDATION first: the plan is re-checked
 * against live offers and the action is refused if anything moved (solver
 * design rule 7).
 *
 * ## Reached WITH products, never from a picker
 *
 * `?p=` carries the handles, so search, a product page and a watchlist all
 * arrive here having already chosen what to compare (UX rule 1). #81 supplies
 * the watchlist half through `?watchlist=`, which the server resolves through
 * its own port and refuses when no watchlist source is registered.
 */
export default function CompareScreen() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ p?: string | string[]; watchlist?: string }>();
  // `?p=handle` compares the MODEL and `?p=handle:variantId` compares that exact
  // configuration — #367 workstream 9's "compare exact variants when a fact is
  // variant-specific". Both spellings are legal in one list, so a shopper can
  // compare one phone's 256 GB against another phone as a whole.
  const subjects = useMemo(() => parseComparisonSubjects(params.p), [params.p]);
  const handles = useMemo(() => subjects.map((subject) => subject.handle), [subjects]);
  const watchlistId = typeof params.watchlist === "string" ? params.watchlist : undefined;

  const [channelPolicy, setChannelPolicy] = useState<BasketChannelPolicy>("mixed");
  const [objective, setObjective] = useState<BasketObjective>("cheapest_known_item_prices");
  const [conditionGroups, setConditionGroups] = useState<readonly ConditionGroup[]>([]);
  const [actionNotice, setActionNotice] = useState<string | undefined>(undefined);

  const comparison = useProductComparison(
    subjects.length >= 2
      ? {
          subjects,
          ...(conditionGroups.length === 0 ? {} : { conditionGroups }),
        }
      : undefined,
  );

  /**
   * Whether these subjects can be compared, and on what.
   *
   * Derived from the server's own grounded package rather than from the
   * categories a client guessed at: a shared row is one every subject has a
   * STATED value on, and zero of them means the table is a grid of dashes. #367
   * asks for comparable types decided by explicit rules, and
   * `lib/catalog/comparison.ts` is where the four of them are written down.
   */
  const comparability = useMemo(
    () => (comparison.data === undefined ? undefined : assessComparability(comparison.data.input)),
    [comparison.data],
  );

  const basket = useBasketSolution(
    watchlistId === undefined
      ? handles.length > 0
        ? {
            lines: handles.map((handle, index) => ({
              lineId: `l${String(index)}`,
              canonicalProductId: handle,
              quantity: 1,
            })),
            channelPolicy,
            // ONE value for the whole basket rather than the same array copied
            // onto every line — a line keeps its own segments when it has them,
            // and #95 produces exactly one preference for a whole query.
            ...(conditionGroups.length === 0 ? {} : { conditionGroups }),
            objectives: [objective],
          }
        : undefined
      : {
          watchlistId,
          channelPolicy,
          ...(conditionGroups.length === 0 ? {} : { conditionGroups }),
          objectives: [objective],
        },
  );

  const revalidate = useRevalidateBasketPlan();

  const namesByRef = useMemo<Record<string, string>>(() => {
    const names: Record<string, string> = {};
    for (const subject of comparison.data?.input.subjects ?? []) {
      names[subject.ref] = subject.name;
    }
    return names;
  }, [comparison.data]);

  /**
   * Re-check the plan, then act — or say what moved and do nothing.
   *
   * The order is the whole point: nothing navigates or adds to a cart before
   * the server has confirmed the plan still describes what a shopper would pay.
   */
  async function actOnPlan(result: BasketResult, act: () => void): Promise<void> {
    if (result.state !== "produced" || basket.data === undefined) return;
    setActionNotice(undefined);
    const answer = await revalidate.mutateAsync({
      snapshot: basket.data.snapshot,
      plan: result.plan,
      records: basket.data.records,
    });
    if (!answer.mayProceed) {
      setActionNotice(t("compare.notice.pricesChanged"));
      await basket.refetch();
      return;
    }
    act();
  }

  return (
    <ScreenShell>
      <Head>
        <title>{t("compare.pageTitle")}</title>
      </Head>

      <View className="gap-space-20 px-space-16 py-space-20">
        <Text className="text-2xl font-bold text-foreground">{t("compare.heading")}</Text>

        {handles.length < 2 && watchlistId === undefined ? (
          <Text className="text-body text-text-secondary">{t("compare.pickTwo")}</Text>
        ) : null}

        {comparison.isLoading ? (
          <ActivityIndicator accessibilityLabel={t("compare.comparingA11y")} />
        ) : null}
        {comparison.error ? (
          <Text className="text-body text-text-secondary">
            {comparison.error instanceof Error
              ? comparison.error.message
              : t("compare.comparisonFailed")}
          </Text>
        ) : null}

        {comparison.data ? (
          <View className="gap-space-16">
            {/*
              What this comparison can and cannot say, BEFORE the table.

              `no_shared_facts` renders instead of the table: a grid whose every
              cell says "not recorded" is not a comparison, and presenting one
              under the heading "Compare" implies these products were measured
              against each other. `comparable_across_categories` renders WITH
              the table and a caveat — comparing a laptop against a tablet is a
              legitimate question whose answer has fewer shared rows.
            */}
            {comparability?.kind === "no_shared_facts" ? (
              <Text className="text-body text-text-secondary">{t("compare.noSharedFacts")}</Text>
            ) : null}
            {comparability?.kind === "comparable_across_categories" ? (
              <Text className="text-caption text-text-secondary">
                {t("compare.acrossCategories", { count: comparability.sharedRowCount })}
              </Text>
            ) : null}

            {/* The DETERMINISTIC table first, and the narrative after it. */}
            {comparability?.kind === "no_shared_facts" ? null : (
              <ComparisonTableView
                table={comparison.data.input.table}
                namesByRef={namesByRef}
              />
            )}
            <ComparisonExplanationBlock explanation={comparison.data.explanation} />
            {comparison.data.input.gaps.length === 0 ? null : (
              <Text className="text-caption text-text-secondary">
                {t("compare.gaps", { count: comparison.data.input.gaps.length })}
              </Text>
            )}
          </View>
        ) : null}

        <View className="gap-space-8">
          <Text className="text-bodyBold text-text">{t("compare.whereToBuy")}</Text>
          <ChoiceRow
            label={t("compare.channelLabel")}
            values={BASKET_CHANNEL_POLICIES}
            labelKeys={CHANNEL_LABEL_KEYS}
            value={channelPolicy}
            onChange={setChannelPolicy}
          />
          <ChoiceRow
            label={t("compare.objectiveLabel")}
            values={BASKET_OBJECTIVES}
            labelKeys={OBJECTIVE_LABEL_KEYS}
            value={objective}
            onChange={setObjective}
          />
          <ConditionRow value={conditionGroups} onChange={setConditionGroups} />
        </View>

        {actionNotice === undefined ? null : (
          <Text className="text-caption text-text-secondary">{actionNotice}</Text>
        )}

        {basket.isLoading ? (
          <ActivityIndicator accessibilityLabel={t("compare.planningA11y")} />
        ) : null}
        {basket.error ? (
          <Text className="text-body text-text-secondary">
            {basket.error instanceof Error ? basket.error.message : t("compare.basketFailed")}
          </Text>
        ) : null}

        {(basket.data?.results ?? []).map((result) => (
          <BasketPlanCard
            key={result.kind}
            result={result}
            {...(result.state === "produced" && basket.data?.actions[result.kind] !== undefined
              ? { actions: basket.data.actions[result.kind] }
              : {})}
            onAddNativeToCart={() => {
              void actOnPlan(result, () => {
                setActionNotice(t("compare.notice.addingToCart"));
              });
            }}
            onOpenExternalMerchant={(index) => {
              void actOnPlan(result, () => {
                const merchant = basket.data?.actions[result.kind]?.externalMerchants[index];
                if (merchant?.destinationHost === undefined) {
                  setActionNotice(t("compare.notice.noDestination"));
                  return;
                }
                // The HOST is what the server discloses; the destination itself
                // is #37's redirect, which is not built. Until it is, this
                // opens the retailer's own home page rather than composing a
                // deep link Mercaria never validated.
                void Linking.openURL(`https://${merchant.destinationHost}`);
              });
            }}
          />
        ))}
      </View>
    </ScreenShell>
  );
}

/** One row of mutually exclusive choices, as text buttons. No colour coding. */
function ChoiceRow<T extends string>({
  label,
  values,
  labelKeys,
  value,
  onChange,
}: {
  /** Already-translated: the row's own caption, and the a11y frame's subject. */
  label: string;
  /** The vocabulary's own tuple. The order a shopper sees is the tuple's. */
  values: readonly T[];
  /** A copy KEY per member. A `Record` over the union, so it cannot omit one. */
  labelKeys: Readonly<Record<T, string>>;
  value: T;
  onChange: (next: T) => void;
}) {
  const { t } = useTranslation();
  const choices = values.map((member) => ({ value: member, label: t(labelKeys[member]) }));
  return (
    <View className="gap-space-4">
      <Text className="text-caption text-text-secondary">{label}</Text>
      <View className="flex-row flex-wrap gap-space-8">
        {choices.map((choice) => (
          <Pressable
            key={choice.value}
            accessibilityRole="button"
            accessibilityState={{ selected: choice.value === value }}
            // `%{label}: %{choice}` from the bundle, never composed here — the
            // reason `CONDITION_A11Y_LABEL_KEY` gives one component down:
            // French puts a space before the colon and Chinese uses a full-width
            // one, and a screen reader reads what the string says.
            accessibilityLabel={t("compare.choiceA11y", {
              label,
              choice: choice.label,
            })}
            onPress={() => onChange(choice.value)}
            className={
              choice.value === value
                ? "rounded-radius-max bg-bg-fill-primary px-space-12 py-space-6"
                : "rounded-radius-max border border-border-secondary px-space-12 py-space-6"
            }
          >
            <Text
              className={
                choice.value === value
                  ? "text-captionBold text-text-inverted"
                  : "text-caption text-text"
              }
            >
              {/* The selected state is announced AND spelled, never colour alone. */}
              {choice.value === value ? `${choice.label} ✓` : choice.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** The condition segments, as an additive filter rather than one choice. */
function ConditionRow({
  value,
  onChange,
}: {
  value: readonly ConditionGroup[];
  onChange: (next: readonly ConditionGroup[]) => void;
}) {
  // The SEGMENT labels are `@mercaria/ui`'s, localized, under the reserved `ui`
  // namespace — never an English map written here. #90 keeps the copy in the UI
  // package "precisely so it can change without touching a stored value", and a
  // second copy in this screen would be one that stops agreeing with the badge
  // rendered three lines above it.
  const { t } = useTranslation();
  return (
    <View className="gap-space-4">
      <Text className="text-caption text-text-secondary">{t("compare.conditionLabel")}</Text>
      <View className="flex-row flex-wrap gap-space-8">
        {CONDITION_GROUPS.map((group) => {
          const selected = value.includes(group);
          return (
            <Pressable
              key={group}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: selected }}
              // `Condition: %{label}` from the shared bundle, never composed
              // here: French puts a space before the colon and Chinese uses a
              // full-width one, and a screen reader reads what the string says.
              accessibilityLabel={t(CONDITION_A11Y_LABEL_KEY, {
                label: t(conditionGroupLabelKey(group)),
              })}
              onPress={() =>
                onChange(
                  selected ? value.filter((entry) => entry !== group) : [...value, group],
                )
              }
              className={
                selected
                  ? "rounded-radius-max bg-bg-fill-secondary px-space-12 py-space-6"
                  : "rounded-radius-max border border-border-secondary px-space-12 py-space-6"
              }
            >
              <Text className="text-caption text-text">
                {selected ? `${t(conditionGroupLabelKey(group))} ✓` : t(conditionGroupLabelKey(group))}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

