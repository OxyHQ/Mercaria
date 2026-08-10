import { Pressable, View } from "react-native";
import type {
  BasketPlanActions,
  BasketResult,
  BasketTotal,
} from "@mercaria/shared-types";
import { Text } from "../ui/text";
import {
  basketApproximationText,
  basketReasonText,
  basketResultDefinition,
  basketResultText,
} from "../../lib/comparison-labels";

export interface BasketPlanCardProps {
  result: BasketResult;
  /** The transactions this plan needs. Absent for a refused result. */
  actions?: BasketPlanActions;
  /** Add the plan's native lines to the Mercaria cart. One action, one cart. */
  onAddNativeToCart?: () => void;
  /**
   * Open ONE external merchant.
   *
   * One callback per merchant and never a "open them all": UX rule 6 asks for
   * external destinations to be confirmed individually or in a safe bounded
   * sequence, and a component with no bulk affordance cannot offer one.
   */
  onOpenExternalMerchant?: (merchantIndex: number) => void;
}

/**
 * One named basket alternative (#96 §"Result types", UX rules 4–7).
 *
 * ## The card renders a REFUSAL as prominently as a plan
 *
 * A surface that only rendered what succeeded would make "we cannot plan nearby
 * pickup" indistinguishable from "you did not ask for it", and would hide the
 * reason a shopper most needs — that the cheapest known TOTAL could not be
 * established because a merchant publishes no delivery cost.
 *
 * ## Two actions, never one
 *
 * `onAddNativeToCart` and `onOpenExternalMerchant` are separate props with no
 * combined affordance between them, which is #96 solver design rule 8 held by
 * the component's own shape. The external side says out loud that Mercaria does
 * not guarantee the retailer's final total (UX rule 7), and shows the
 * destination HOST rather than a link — the destination is resolved when the
 * shopper confirms, never at render time.
 *
 * ## Every figure says what it includes
 *
 * A `known` total is printed; an `unknown` one prints the FLOOR and names what
 * is missing. "At least 210.40 EUR, plus delivery from 2 merchants" is a true
 * sentence; "210.40 EUR" would not be.
 */
export function BasketPlanCard({
  result,
  actions,
  onAddNativeToCart,
  onOpenExternalMerchant,
}: BasketPlanCardProps) {
  return (
    <View className="gap-space-8 rounded-radius-16 border border-border-secondary p-space-16">
      <View className="gap-space-2">
        <Text className="text-bodyBold text-text">{basketResultText(result.kind)}</Text>
        <Text className="text-caption text-text-secondary">
          {basketResultDefinition(result.kind)}
        </Text>
      </View>

      {result.state === "refused" ? (
        <View className="gap-space-4">
          <Text className="text-caption text-text">Not available for this basket.</Text>
          {result.reasons.map((reason) => (
            <Text key={reason} className="text-caption text-text-secondary">
              · {basketReasonText(reason)}
            </Text>
          ))}
        </View>
      ) : (
        <View className="gap-space-8">
          <View className="gap-space-2">
            <Text className="text-caption text-text-secondary">
              {result.plan.coveredLineIds.length} of{" "}
              {result.plan.coveredLineIds.length + result.plan.unresolved.length} items ·{" "}
              {result.plan.merchantCount}{" "}
              {result.plan.merchantCount === 1 ? "merchant" : "merchants"}
            </Text>
            <Text className="text-bodyBold text-text">
              {totalText(result.plan.deliveredTotal, result.plan.merchantCount)}
            </Text>
            <Text className="text-caption text-text-secondary">
              Item prices: {totalText(result.plan.itemSubtotal, result.plan.merchantCount)}
            </Text>
          </View>

          <Text className="text-caption text-text-secondary">
            {result.optimality.status === "proven_optimal"
              ? "Best possible plan from the offers we can see."
              : `Best plan found — ${basketApproximationText(result.optimality.reason)}.`}
          </Text>

          {result.plan.freshness === "current" ? null : (
            <Text className="text-caption text-text-secondary">
              Some prices were last confirmed a while ago.
            </Text>
          )}

          {result.plan.unresolved.length > 0 ? (
            <View className="gap-space-2">
              <Text className="text-captionBold text-text">Not included</Text>
              {result.plan.unresolved.map((unresolved) => (
                <Text key={unresolved.lineId} className="text-caption text-text-secondary">
                  · {unresolved.reasons.map(basketReasonText).join("; ")}
                </Text>
              ))}
            </View>
          ) : null}

          {actions === undefined ? null : (
            <PlanActions
              actions={actions}
              onAddNativeToCart={onAddNativeToCart}
              onOpenExternalMerchant={onOpenExternalMerchant}
            />
          )}
        </View>
      )}
    </View>
  );
}

/** The native cart action and one row per external merchant. Never combined. */
function PlanActions({
  actions,
  onAddNativeToCart,
  onOpenExternalMerchant,
}: {
  actions: BasketPlanActions;
  onAddNativeToCart?: () => void;
  onOpenExternalMerchant?: (merchantIndex: number) => void;
}) {
  return (
    <View className="gap-space-8 border-t border-border-secondary pt-space-8">
      {actions.nativeCart === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Add ${actions.nativeCart.lines.length} items to the Mercaria cart`}
          onPress={onAddNativeToCart}
          className="rounded-radius-max bg-bg-fill-primary px-space-16 py-space-10"
        >
          <Text className="text-captionBold text-text-inverted">
            Add {actions.nativeCart.lines.length}{" "}
            {actions.nativeCart.lines.length === 1 ? "item" : "items"} to Mercaria cart
          </Text>
        </Pressable>
      )}

      {actions.externalMerchants.length === 0 ? null : (
        <View className="gap-space-4">
          <Text className="text-captionBold text-text">Open external retailers</Text>
          <Text className="text-caption text-text-secondary">
            You will buy these on each retailer&rsquo;s own site. Mercaria does not guarantee
            their final checkout total.
          </Text>
          {actions.externalMerchants.map((merchant, index) => (
            <Pressable
              key={`${merchant.merchantLabel}-${String(index)}`}
              accessibilityRole="button"
              accessibilityLabel={`Open ${merchant.merchantLabel} for ${merchant.lineIds.length} items`}
              onPress={() => onOpenExternalMerchant?.(index)}
              className="rounded-radius-12 border border-border-secondary px-space-12 py-space-8"
            >
              <Text className="text-caption text-text">
                {merchant.merchantLabel} · {merchant.lineIds.length}{" "}
                {merchant.lineIds.length === 1 ? "item" : "items"}
              </Text>
              {merchant.destinationHost === undefined ? null : (
                <Text className="text-caption text-text-secondary">
                  {merchant.destinationHost}
                </Text>
              )}
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * A total, or a floor plus what is missing.
 *
 * The unknown branch NAMES the components, because "at least 210.40 EUR" with
 * no explanation reads as a hedge and "210.40 EUR plus delivery from two
 * merchants" is an actionable statement about the same number.
 */
function totalText(total: BasketTotal, merchantCount: number): string {
  if (total.state === "known") return total.rendered;
  const missing: string[] = [];
  if (total.missing.includes("delivery_cost")) {
    missing.push(
      merchantCount === 1 ? "plus delivery" : `plus delivery from ${merchantCount} merchants`,
    );
  }
  if (total.missing.includes("tax_inclusion")) missing.push("tax treatment not published");
  if (total.missing.includes("item_price")) missing.push("some prices unknown");
  return `At least ${total.renderedFloor}${missing.length === 0 ? "" : ` — ${missing.join(", ")}`}`;
}
