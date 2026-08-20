import { Pressable, View } from "react-native";
import type {
  BasketPlanActions,
  BasketResult,
  BasketTotal,
} from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { useSharedUiTranslation } from "../../i18n/ui-translation";
import type { Translate } from "../../i18n/create-app-i18n";
import {
  BASKET_CARD_ADD_TO_CART_A11Y_KEY,
  BASKET_CARD_ADD_TO_CART_KEY,
  BASKET_CARD_AT_LEAST_KEY,
  BASKET_CARD_AT_LEAST_MISSING_KEY,
  BASKET_CARD_DELIVERY_MULTIPLE_KEY,
  BASKET_CARD_DELIVERY_ONE_KEY,
  BASKET_CARD_ITEM_PRICES_KEY,
  BASKET_CARD_MERCHANT_LINE_A11Y_KEY,
  BASKET_CARD_MERCHANT_LINE_KEY,
  BASKET_CARD_NOT_INCLUDED_KEY,
  BASKET_CARD_OPEN_RETAILERS_KEY,
  BASKET_CARD_OPEN_RETAILERS_NOTE_KEY,
  BASKET_CARD_PRICES_UNKNOWN_KEY,
  BASKET_CARD_REFUSED_KEY,
  BASKET_CARD_STALE_PRICES_KEY,
  BASKET_CARD_TALLY_KEY,
  BASKET_CARD_TAX_UNKNOWN_KEY,
  BASKET_OPTIMALITY_APPROXIMATE_KEY,
  BASKET_OPTIMALITY_PROVEN_KEY,
  COMPARISON_LIST_SEPARATOR_KEY,
  basketApproximationTextKey,
  basketReasonTextKey,
  basketResultDefinitionKey,
  basketResultTextKey,
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
  const t = useSharedUiTranslation();
  return (
    <View className="gap-space-8 rounded-radius-16 border border-border-secondary p-space-16">
      <View className="gap-space-2">
        <Text className="text-bodyBold text-text">{t(basketResultTextKey(result.kind))}</Text>
        <Text className="text-caption text-text-secondary">
          {t(basketResultDefinitionKey(result.kind))}
        </Text>
      </View>

      {result.state === "refused" ? (
        <View className="gap-space-4">
          <Text className="text-caption text-text">{t(BASKET_CARD_REFUSED_KEY)}</Text>
          {result.reasons.map((reason) => (
            <Text key={reason} className="text-caption text-text-secondary">
              · {t(basketReasonTextKey(reason))}
            </Text>
          ))}
        </View>
      ) : (
        <View className="gap-space-8">
          <View className="gap-space-2">
            <Text className="text-caption text-text-secondary">
              {t(BASKET_CARD_TALLY_KEY, {
                covered: result.plan.coveredLineIds.length,
                total: result.plan.coveredLineIds.length + result.plan.unresolved.length,
                merchants: result.plan.merchantCount,
              })}
            </Text>
            <Text className="text-bodyBold text-text">
              {totalText(t, result.plan.deliveredTotal, result.plan.merchantCount)}
            </Text>
            <Text className="text-caption text-text-secondary">
              {t(BASKET_CARD_ITEM_PRICES_KEY, {
                total: totalText(t, result.plan.itemSubtotal, result.plan.merchantCount),
              })}
            </Text>
          </View>

          {/* Two WHOLE sentences, and the approximate one carries its reason in
              a `%{}` slot rather than through a `${}` around a translated
              fragment: "Best plan found" and "too many offers to examine all of
              them" join with an em dash in English and with nothing like it in
              several of the other eleven. */}
          <Text className="text-caption text-text-secondary">
            {result.optimality.status === "proven_optimal"
              ? t(BASKET_OPTIMALITY_PROVEN_KEY)
              : t(BASKET_OPTIMALITY_APPROXIMATE_KEY, {
                  reason: t(basketApproximationTextKey(result.optimality.reason)),
                })}
          </Text>

          {result.plan.freshness === "current" ? null : (
            <Text className="text-caption text-text-secondary">
              {t(BASKET_CARD_STALE_PRICES_KEY)}
            </Text>
          )}

          {result.plan.unresolved.length > 0 ? (
            <View className="gap-space-2">
              <Text className="text-captionBold text-text">
                {t(BASKET_CARD_NOT_INCLUDED_KEY)}
              </Text>
              {result.plan.unresolved.map((unresolved) => (
                <Text key={unresolved.lineId} className="text-caption text-text-secondary">
                  ·{" "}
                  {unresolved.reasons
                    .map((reason) => t(basketReasonTextKey(reason)))
                    .join(t(COMPARISON_LIST_SEPARATOR_KEY))}
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
  const t = useSharedUiTranslation();
  return (
    <View className="gap-space-8 border-t border-border-secondary pt-space-8">
      {actions.nativeCart === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(BASKET_CARD_ADD_TO_CART_A11Y_KEY, {
            items: actions.nativeCart.lines.length,
          })}
          onPress={onAddNativeToCart}
          className="rounded-radius-max bg-bg-fill-primary px-space-16 py-space-10"
        >
          <Text className="text-captionBold text-text-inverted">
            {t(BASKET_CARD_ADD_TO_CART_KEY, { items: actions.nativeCart.lines.length })}
          </Text>
        </Pressable>
      )}

      {actions.externalMerchants.length === 0 ? null : (
        <View className="gap-space-4">
          <Text className="text-captionBold text-text">
            {t(BASKET_CARD_OPEN_RETAILERS_KEY)}
          </Text>
          <Text className="text-caption text-text-secondary">
            {t(BASKET_CARD_OPEN_RETAILERS_NOTE_KEY)}
          </Text>
          {actions.externalMerchants.map((merchant, index) => (
            <Pressable
              key={`${merchant.merchantLabel}-${String(index)}`}
              accessibilityRole="button"
              accessibilityLabel={t(BASKET_CARD_MERCHANT_LINE_A11Y_KEY, {
                merchant: merchant.merchantLabel,
                items: merchant.lineIds.length,
              })}
              onPress={() => onOpenExternalMerchant?.(index)}
              className="rounded-radius-12 border border-border-secondary px-space-12 py-space-8"
            >
              <Text className="text-caption text-text">
                {t(BASKET_CARD_MERCHANT_LINE_KEY, {
                  merchant: merchant.merchantLabel,
                  items: merchant.lineIds.length,
                })}
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
 * no explanation reads as a hedge and "210.40 EUR plus delivery from several
 * merchants" is an actionable statement about the same number.
 *
 * It takes `t` rather than reading a hook because it is a pure function called
 * twice from one render. Worth stating why it was extracted at all: a function
 * that RETURNS copy is in check A's own blind-spot list, so these five
 * sentences moved the guard's count by NOTHING while being as visible on the
 * screen as anything the tally line renders.
 */
function totalText(t: Translate, total: BasketTotal, merchantCount: number): string {
  if (total.state === "known") return total.rendered;
  const missing: string[] = [];
  if (total.missing.includes("delivery_cost")) {
    missing.push(
      t(merchantCount === 1 ? BASKET_CARD_DELIVERY_ONE_KEY : BASKET_CARD_DELIVERY_MULTIPLE_KEY),
    );
  }
  if (total.missing.includes("tax_inclusion")) missing.push(t(BASKET_CARD_TAX_UNKNOWN_KEY));
  if (total.missing.includes("item_price")) missing.push(t(BASKET_CARD_PRICES_UNKNOWN_KEY));
  return missing.length === 0
    ? t(BASKET_CARD_AT_LEAST_KEY, { floor: total.renderedFloor })
    : t(BASKET_CARD_AT_LEAST_MISSING_KEY, {
        floor: total.renderedFloor,
        missing: missing.join(t(COMPARISON_LIST_SEPARATOR_KEY)),
      });
}
