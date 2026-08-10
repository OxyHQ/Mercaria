import { useMemo, useState } from "react";
import { ActivityIndicator, Linking, Pressable, View } from "react-native";
import Head from "expo-router/head";
import { useLocalSearchParams } from "expo-router";
import {
  BasketPlanCard,
  ComparisonExplanationBlock,
  ComparisonTableView,
  Text,
} from "@mercaria/ui";
import type {
  BasketChannelPolicy,
  BasketObjective,
  BasketResult,
  ConditionGroup,
} from "@mercaria/shared-types";
import { ScreenShell } from "@/components/shell/ScreenShell";
import {
  useBasketSolution,
  useProductComparison,
  useRevalidateBasketPlan,
} from "@/lib/hooks/use-comparison";

/** The channel choices a shopper can make, with the words they read. */
const CHANNEL_CHOICES: readonly { value: BasketChannelPolicy; label: string }[] = [
  { value: "mixed", label: "Anywhere" },
  { value: "native_only", label: "Mercaria only" },
  { value: "external_only", label: "Retailers only" },
  { value: "official_only", label: "Official channels only" },
];

/** The objectives a shopper can choose between. */
const OBJECTIVE_CHOICES: readonly { value: BasketObjective; label: string }[] = [
  { value: "cheapest_known_item_prices", label: "Cheapest items" },
  { value: "cheapest_known_total", label: "Cheapest delivered" },
  { value: "fewest_merchants", label: "Fewest merchants" },
  { value: "all_native", label: "Buy on Mercaria" },
  { value: "fastest_known_delivery", label: "Fastest delivery" },
];

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
  const params = useLocalSearchParams<{ p?: string | string[]; watchlist?: string }>();
  const handles = useMemo(() => normalizeHandles(params.p), [params.p]);
  const watchlistId = typeof params.watchlist === "string" ? params.watchlist : undefined;

  const [channelPolicy, setChannelPolicy] = useState<BasketChannelPolicy>("mixed");
  const [objective, setObjective] = useState<BasketObjective>("cheapest_known_item_prices");
  const [conditionGroups, setConditionGroups] = useState<readonly ConditionGroup[]>([]);
  const [actionNotice, setActionNotice] = useState<string | undefined>(undefined);

  const comparison = useProductComparison(
    handles.length >= 2
      ? {
          subjects: handles.map((handle) => ({ handle })),
          ...(conditionGroups.length === 0 ? {} : { conditionGroups }),
        }
      : undefined,
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
      setActionNotice("Prices changed while you were reading. Recalculating.");
      await basket.refetch();
      return;
    }
    act();
  }

  return (
    <ScreenShell>
      <Head>
        <title>Compare · Mercaria</title>
      </Head>

      <View className="gap-space-20 px-space-16 py-space-20">
        <Text className="text-2xl font-bold text-foreground">Compare</Text>

        {handles.length < 2 && watchlistId === undefined ? (
          <Text className="text-body text-text-secondary">
            Pick at least two products to compare, from search or from a product page.
          </Text>
        ) : null}

        {comparison.isLoading ? <ActivityIndicator accessibilityLabel="Comparing" /> : null}
        {comparison.error ? (
          <Text className="text-body text-text-secondary">
            {comparison.error instanceof Error
              ? comparison.error.message
              : "This comparison could not be built."}
          </Text>
        ) : null}

        {comparison.data ? (
          <View className="gap-space-16">
            {/* The DETERMINISTIC table first, and the narrative after it. */}
            <ComparisonTableView
              table={comparison.data.input.table}
              namesByRef={namesByRef}
            />
            <ComparisonExplanationBlock explanation={comparison.data.explanation} />
            {comparison.data.input.gaps.length === 0 ? null : (
              <Text className="text-caption text-text-secondary">
                {comparison.data.input.gaps.length} facts are not recorded for these products.
              </Text>
            )}
          </View>
        ) : null}

        <View className="gap-space-8">
          <Text className="text-bodyBold text-text">Where to buy</Text>
          <ChoiceRow
            label="Channel"
            choices={CHANNEL_CHOICES}
            value={channelPolicy}
            onChange={setChannelPolicy}
          />
          <ChoiceRow
            label="Objective"
            choices={OBJECTIVE_CHOICES}
            value={objective}
            onChange={setObjective}
          />
          <ConditionRow value={conditionGroups} onChange={setConditionGroups} />
        </View>

        {actionNotice === undefined ? null : (
          <Text className="text-caption text-text-secondary">{actionNotice}</Text>
        )}

        {basket.isLoading ? <ActivityIndicator accessibilityLabel="Planning" /> : null}
        {basket.error ? (
          <Text className="text-body text-text-secondary">
            {basket.error instanceof Error
              ? basket.error.message
              : "This basket could not be planned."}
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
                setActionNotice("Checked. Adding these items to your Mercaria cart.");
              });
            }}
            onOpenExternalMerchant={(index) => {
              void actOnPlan(result, () => {
                const merchant = basket.data?.actions[result.kind]?.externalMerchants[index];
                if (merchant?.destinationHost === undefined) {
                  setActionNotice("We do not have a destination for that retailer yet.");
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
  choices,
  value,
  onChange,
}: {
  label: string;
  choices: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <View className="gap-space-4">
      <Text className="text-caption text-text-secondary">{label}</Text>
      <View className="flex-row flex-wrap gap-space-8">
        {choices.map((choice) => (
          <Pressable
            key={choice.value}
            accessibilityRole="button"
            accessibilityState={{ selected: choice.value === value }}
            accessibilityLabel={`${label}: ${choice.label}`}
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
  const groups: readonly ConditionGroup[] = ["new", "open_box", "refurbished", "used"];
  return (
    <View className="gap-space-4">
      <Text className="text-caption text-text-secondary">Condition</Text>
      <View className="flex-row flex-wrap gap-space-8">
        {groups.map((group) => {
          const selected = value.includes(group);
          return (
            <Pressable
              key={group}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: selected }}
              accessibilityLabel={`Condition: ${group}`}
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
                {selected ? `${group} ✓` : group}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** `?p=a&p=b` and `?p=a,b` both mean the same thing to a shopper. */
function normalizeHandles(raw: string | string[] | undefined): readonly string[] {
  if (raw === undefined) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}
