import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import Head from "expo-router/head";
import { useRouter } from "expo-router";
import { Clock } from "lucide-react-native";
import { openAccountDialog, useOxy } from "@oxyhq/services";
import {
  SHOPPING_AGENT_OBSERVATION_DISCLAIMER,
  ShoppingAgentCard,
  ShoppingAgentFindingCard,
  Text,
} from "@mercaria/ui";
import type { ShoppingAgent, ShoppingAgentFinding } from "@mercaria/shared-types";
import { ScreenShell } from "@/components/shell/ScreenShell";
import {
  useDeleteShoppingAgent,
  useResolveShoppingAgentSplit,
  useRunShoppingAgentNow,
  useShoppingAgent,
  useShoppingAgentFindings,
  useShoppingAgents,
  useUpdateShoppingAgentState,
} from "@/lib/hooks/use-shopping-agents";

/** Icon size for the empty-state badge. */
const EMPTY_ICON_SIZE = 28;

/**
 * Saved shopping agents (#97) — what a shopper asked Mercaria to watch, and
 * everything it has seen since.
 *
 * ## An agent WATCHES and TELLS, and this screen has no control that does more
 *
 * Pause, resume, remove, ask for one look now, answer a catalogue split. That is
 * the whole surface, and it is the whole surface #97 grants: a saved agent
 * observes the catalogue on a shopper's behalf and reports what it saw. Nothing
 * on this screen commits a shopper to anything, and there is no callback on
 * either card through which something that did could be reached.
 *
 * ## A finding is an OBSERVATION and the screen says so before showing one
 *
 * The disclaimer sits under the title and again under every finding, because
 * the misreading — that a figure is held or promised — happens where the figure
 * is, not in a help page (UX rule 7).
 *
 * ## Findings render whatever produced their words
 *
 * No provider is registered anywhere in the deployment, so
 * `summary.source === 'deterministic_template'` is the normal case rather than a
 * degraded one. Nothing on this screen or in either card is gated on a model
 * having been involved (UX rule 10).
 *
 * ## One screen, no second route
 *
 * Opening an agent expands it in place and reads its findings, rather than
 * navigating: the timeline is a property of the agent above it, and a shopper
 * comparing two agents' recent findings would otherwise be paging back and
 * forth. It also keeps every navigation target on this screen down to the one
 * that genuinely exists.
 */
export default function ShoppingAgentsScreen() {
  const router = useRouter();
  const { isAuthenticated } = useOxy();
  const agents = useShoppingAgents();
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);

  const openAgent = useShoppingAgent(openAgentId ?? undefined);
  const findings = useShoppingAgentFindings(openAgentId ?? undefined);

  const updateState = useUpdateShoppingAgentState();
  const remove = useDeleteShoppingAgent();
  const runNow = useRunShoppingAgentNow();
  const resolveSplit = useResolveShoppingAgentSplit();

  const busy =
    updateState.isPending || remove.isPending || runNow.isPending || resolveSplit.isPending;

  const list = useMemo<ShoppingAgent[]>(() => agents.data ?? [], [agents.data]);

  /**
   * The open agent's requirement sentences, keyed by requirement id.
   *
   * A finding cites ids; the sentence belonging to each is composed once on the
   * constraint set and lives there. Building the map here rather than copying
   * sentences onto findings keeps ONE description of a requirement, which is
   * what makes "which requirements remain unknown" answerable at all.
   */
  const shownAgent = openAgent.data ?? list.find((agent) => agent.id === openAgentId);
  const constraintExplanations = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const constraint of shownAgent?.constraints.constraints ?? []) {
      map[constraint.id] = constraint.explanation;
    }
    return map;
  }, [shownAgent]);

  return (
    <ScreenShell>
      <Head>
        <title>Shopping agents · Mercaria</title>
      </Head>

      <View className="gap-space-16 px-space-16 py-space-20">
        <Text className="text-2xl font-bold text-foreground">Shopping agents</Text>
        <Text className="text-sm text-text-secondary">
          Things you asked Mercaria to keep an eye on. Each one watches the catalogue and tells you
          when what you asked for becomes true.
        </Text>
        <Text className="text-caption text-text-tertiary">
          {SHOPPING_AGENT_OBSERVATION_DISCLAIMER}
        </Text>

        {!isAuthenticated ? (
          <SignedOutInvitation />
        ) : (
          <>
            {agents.isPending ? (
              <View className="items-center py-space-24">
                <ActivityIndicator />
              </View>
            ) : null}

            {agents.isError ? (
              <Text className="text-sm text-text-secondary">
                We could not load your shopping agents. Check your connection and try again.
              </Text>
            ) : null}

            {!agents.isPending && !agents.isError && list.length === 0 ? <EmptyState /> : null}

            <View className="gap-space-12">
              {list.map((agent) => {
                const expanded = agent.id === openAgentId;
                // The open row is re-read on its own, so a manual look, a pause
                // or a split answer shows on the row the timeline belongs to.
                const row = expanded && shownAgent ? shownAgent : agent;
                return (
                  <View key={agent.id} className="gap-space-8">
                    <ShoppingAgentCard
                      agent={row}
                      expanded={expanded}
                      busy={busy}
                      onToggleExpanded={() =>
                        setOpenAgentId((current) => (current === agent.id ? null : agent.id))
                      }
                      onPause={() =>
                        updateState.mutate({ agentId: agent.id, state: "paused" })
                      }
                      onResume={() =>
                        updateState.mutate({ agentId: agent.id, state: "enabled" })
                      }
                      onDelete={() => remove.mutate(agent.id)}
                      onRunNow={() => runNow.mutate(agent.id)}
                      onResolveSplit={(_agent, resolution) =>
                        resolveSplit.mutate({ agentId: agent.id, resolution })
                      }
                      onOpenProduct={(canonicalProductId) =>
                        router.push(`/products/${canonicalProductId}`)
                      }
                    />

                    {expanded ? (
                      <FindingsTimeline
                        asking={runNow.isPending}
                        pending={findings.isPending}
                        failed={findings.isError}
                        findings={findings.data ?? []}
                        constraintExplanations={constraintExplanations}
                        onOpenProduct={(canonicalProductId) =>
                          router.push(`/products/${canonicalProductId}`)
                        }
                      />
                    ) : null}
                  </View>
                );
              })}
            </View>
          </>
        )}
      </View>
    </ScreenShell>
  );
}

/**
 * One agent's appended observations.
 *
 * Every finding is rendered, including the superseded and invalidated ones. A
 * timeline that showed only what is currently true would agree with whatever the
 * latest look happened to say, and a shopper who acted on an earlier one would
 * find no trace of it (UX rule 3).
 */
function FindingsTimeline({
  asking,
  pending,
  failed,
  findings,
  constraintExplanations,
  onOpenProduct,
}: {
  asking: boolean;
  pending: boolean;
  failed: boolean;
  findings: readonly ShoppingAgentFinding[];
  constraintExplanations: Record<string, string>;
  onOpenProduct: (canonicalProductId: string) => void;
}) {
  return (
    <View className="gap-space-8 pl-space-12">
      <Text className="text-caption text-text-tertiary">
        {asking
          ? "Asking for another look…"
          : "Everything this agent has seen, newest first. Older observations stay here even after a later one replaces them."}
      </Text>

      {pending ? (
        <View className="items-center py-space-16">
          <ActivityIndicator />
        </View>
      ) : null}

      {failed ? (
        <Text className="text-caption text-text-secondary">
          We could not load what this agent found. Your agent is unaffected.
        </Text>
      ) : null}

      {!pending && !failed && findings.length === 0 ? (
        <Text className="text-caption text-text-secondary">
          Nothing seen yet. The first observation appears here whenever this agent next looks.
        </Text>
      ) : null}

      {findings.map((finding) => (
        <ShoppingAgentFindingCard
          key={finding.id}
          finding={finding}
          constraintExplanations={constraintExplanations}
          onOpenProduct={onOpenProduct}
        />
      ))}
    </View>
  );
}

function EmptyState() {
  return (
    <View className="items-center gap-space-8 py-space-24">
      <View className="rounded-radius-max bg-bg-fill-secondary p-space-12">
        <Clock size={EMPTY_ICON_SIZE} className="text-text-tertiary" />
      </View>
      <Text className="text-bodyTitleSmall text-text">No shopping agents yet</Text>
      <Text className="text-caption text-text-tertiary">
        Save what you are looking for and Mercaria will watch the catalogue for it.
      </Text>
    </View>
  );
}

function SignedOutInvitation() {
  return (
    <View className="items-center gap-space-8 py-space-24">
      <View className="rounded-radius-max bg-bg-fill-secondary p-space-12">
        <Clock size={EMPTY_ICON_SIZE} className="text-text-tertiary" />
      </View>
      <Text className="text-bodyTitleSmall text-text">Sign in to save a shopping agent</Text>
      <Text className="text-caption text-text-tertiary">
        Agents live with your account, so they follow you between devices.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Sign in"
        onPress={() => openAccountDialog()}
        className="rounded-radius-max bg-bg-fill-secondary px-space-16 py-space-8"
      >
        <Text className="text-caption text-text">Sign in</Text>
      </Pressable>
    </View>
  );
}
