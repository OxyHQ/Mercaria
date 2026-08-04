import { Button } from "@oxyhq/bloom/button";
import { FollowTargetButton, openAccountDialog, useOxy } from "@oxyhq/services";
import type { MerchantSummary } from "@mercaria/shared-types";
import { useStoreFollowTarget } from "@/lib/hooks/use-store-follow";

/**
 * Subscribe to a store, backed by Oxy's user-owned follow graph.
 *
 * The relationship belongs to the user, not to Mercaria: a shop subscribed to
 * here is subscribed to for the user, and turning it off in Mercaria leaves the
 * follow itself intact. `FollowTargetButton` owns all of that — including the
 * distinction between "not followed" and "followed but switched off here",
 * which is why nothing in this file reads a follow state of its own.
 *
 * Timed follows are switched off (`durations={false}`). They exist for things
 * with a natural end — an event tonight, a story running this week — and a shop
 * has none: you subscribe to hear about new stock and sales, which is
 * open-ended. "Subscribe to this shop for 24 hours" is not a thing anyone
 * means.
 */
export function StoreFollowButton({
  store,
  size = "medium",
}: {
  store: MerchantSummary;
  size?: "small" | "medium" | "large";
}) {
  const { canUsePrivateApi } = useOxy();
  const { data: followTargetId } = useStoreFollowTarget(store);

  if (followTargetId) {
    return (
      <FollowTargetButton
        targetId={followTargetId}
        verb="subscribe"
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
      accessibilityLabel={`Subscribe to ${store.name}`}
    >
      Subscribe
    </Button>
  );
}
