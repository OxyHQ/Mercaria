import { Button } from "@oxyhq/bloom/button";
import { FollowTargetButton, openAccountDialog, useOxy } from "@oxyhq/services";
import type { StoreSummary } from "@mercaria/shared-types";
import { useStoreFollowTarget } from "@/lib/hooks/use-store-follow";
import { useTranslation } from "@/lib/i18n";

/**
 * Follow a store, backed by Oxy's user-owned follow graph.
 *
 * The relationship belongs to the user, not to Mercaria: a shop followed here
 * is followed for the user, and turning it off in Mercaria leaves the follow
 * itself intact. `FollowTargetButton` owns all of that — including the
 * distinction between "not followed" and "followed but switched off here",
 * which is why nothing in this file reads a follow state of its own.
 *
 * The verb is `follow`, not the `subscribe` a shop would otherwise suggest:
 * "Subscribe" already means a recurring PURCHASE plan in this app, and the
 * product page renders one a few hundred pixels from this button. Two
 * different meanings for one word on one screen is the user's problem to
 * resolve, so it is settled here instead.
 *
 * Timed follows are switched off (`durations={false}`). They exist for things
 * with a natural end — an event tonight, a story running this week — and a shop
 * has none: you follow a shop to hear about new stock and sales, which is
 * open-ended. "Follow this shop for 24 hours" is not a thing anyone means.
 *
 * ## STORES ONLY — a seller is not a store
 *
 * This takes a `StoreSummary`, which is always a `Store`: a Mercaria-local
 * row with its own handle, brand and policies and NO Oxy account behind it
 * (`oxyUserId` appears on `Store` only inside `members[]`, the people who
 * operate it). That is what makes `mercaria.store` the right kind.
 *
 * Mercaria's OTHER merchant identity is not like that. A P2P `Seller` is an
 * Oxy account (`Seller.oxyUserId`, `Listing.ownerType: 'user'`), so following
 * one is `kind: 'oxy.user'` against the canonical Oxy user URI with
 * `localUserId` set — a platform kind owned by no application, which keeps the
 * account graph authoritative. Registering a person under `mercaria.*` would
 * fix that entity's kind at the wrong value forever (targets are idempotent on
 * URI) and permanently split their followers from every other Oxy app.
 *
 * The two identities already share one slot: `products/[id].tsx` resolves a
 * single `identity` store-first-then-seller and feeds it to `MerchantHeader`.
 * Do not put this button there. Add a separate seller control instead.
 */
export function StoreFollowButton({
  store,
  size = "medium",
}: {
  store: StoreSummary;
  size?: "small" | "medium" | "large";
}) {
  const { t } = useTranslation();
  const { canUsePrivateApi } = useOxy();
  const { data: followTargetId } = useStoreFollowTarget(store);

  if (followTargetId) {
    return (
      <FollowTargetButton
        targetId={followTargetId}
        verb="follow"
        applicationName="Mercaria"
        durations={false}
        size={size}
      />
    );
  }

  // Signed in, but the target is still resolving. Render nothing rather than a
  // button that cannot act yet — the alternative invites a press that fails.
  if (canUsePrivateApi) return null;

  // Signed out. Registering a target and following are both user-delegated, so
  // there is nothing to press until there is a session; the honest affordance
  // is the one that gets them one. Bloom's `Button` is what `FollowTargetButton`
  // renders too, so this is the same control in the same palette.
  return (
    <Button
      variant="primary"
      size={size}
      onPress={() => openAccountDialog()}
      accessibilityLabel={t("store.follow.followStore", { store: store.name })}
    >
      {t("store.follow.follow")}
    </Button>
  );
}
