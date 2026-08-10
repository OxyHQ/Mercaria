import { ActivityIndicator, Pressable, View } from "react-native";
import Head from "expo-router/head";
import { useRouter } from "expo-router";
import { openAccountDialog, useOxy } from "@oxyhq/services";
import { Text } from "@mercaria/ui";
import { WATCHLIST_MAX_LISTS_PER_OWNER } from "@mercaria/shared-types";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { useCreateWatchlist, useDuplicateWatchlist, useWatchlists } from "@/lib/hooks/use-watchlists";

/**
 * The buyer's watchlists (#81 UX rules 1 and 7).
 *
 * ## A list is PRIVATE and this page says nothing about anybody else
 *
 * There is no follower count, no share control and no "people also watch". #81
 * privacy rule 1 keeps a list private until an explicit sharing feature is
 * built, and the enforcement is that the server has no visibility to grant and
 * this page has no control to grant it with.
 *
 * ## Signed out, this page offers rather than gates
 *
 * A watchlist is stored under an Oxy account id, so there is genuinely nothing
 * to show a signed-out visitor — unlike the cart, which works for a guest. The
 * invitation says what signing in gets them and nothing about what they are
 * missing, because they are not missing anything they had.
 */
export default function WatchlistsScreen() {
  const router = useRouter();
  const { isAuthenticated } = useOxy();
  const watchlists = useWatchlists();
  const createList = useCreateWatchlist();
  const duplicateList = useDuplicateWatchlist();

  const lists = watchlists.data ?? [];
  const atLimit = lists.length >= WATCHLIST_MAX_LISTS_PER_OWNER;

  return (
    <ScreenShell>
      <Head>
        <title>Watchlists · Mercaria</title>
      </Head>

      <View className="gap-space-16 px-space-16 py-space-20">
        <Text className="text-2xl font-bold text-foreground">Watchlists</Text>
        <Text className="text-sm text-text-secondary">
          Group the things you are planning to buy and watch what the set would cost.
        </Text>

        {!isAuthenticated ? (
          <View className="gap-space-12 rounded-radius-lg border border-border-secondary p-space-16">
            <Text className="text-base text-foreground">
              Sign in to keep private lists and track what they cost over time.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Sign in"
              onPress={() => openAccountDialog()}
              className="items-center rounded-radius-max bg-primary py-space-12"
            >
              <Text className="text-buttonMedium text-primary-foreground">Sign in</Text>
            </Pressable>
          </View>
        ) : watchlists.isPending ? (
          <View className="py-24">
            <ActivityIndicator />
          </View>
        ) : watchlists.isError ? (
          <Text className="text-sm text-text-secondary">
            We could not load your watchlists. Check your connection and try again.
          </Text>
        ) : (
          <View className="gap-space-12">
            {lists.map((list) => (
              <Pressable
                key={list.id}
                accessibilityRole="button"
                accessibilityLabel={`Open ${list.name}`}
                onPress={() => router.push(`/watchlists/${list.id}`)}
                className="gap-space-4 rounded-radius-lg border border-border-secondary p-space-16"
              >
                <Text className="text-base font-semibold text-foreground">
                  {list.icon ? `${list.icon} ` : ""}
                  {list.name}
                </Text>
                <Text className="text-sm text-text-secondary">
                  {list.itemCount} item(s) · {list.displayCurrency}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Duplicate ${list.name}`}
                  onPress={() => duplicateList.mutate({ watchlistId: list.id })}
                >
                  <Text className="text-sm text-text-secondary">Duplicate</Text>
                </Pressable>
              </Pressable>
            ))}

            {lists.length === 0 ? (
              <Text className="text-sm text-text-secondary">
                No lists yet. Start one and add the products you are comparing.
              </Text>
            ) : null}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Create a watchlist"
              disabled={atLimit || createList.isPending}
              onPress={() =>
                createList.mutate({ name: "New list", displayCurrency: "EUR" })
              }
              className="items-center rounded-radius-max border border-border-secondary py-space-12"
            >
              <Text className="text-buttonMedium text-text">
                {atLimit
                  ? `You have the maximum of ${WATCHLIST_MAX_LISTS_PER_OWNER} lists`
                  : "New list"}
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    </ScreenShell>
  );
}
