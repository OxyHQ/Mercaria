import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import Head from "expo-router/head";
import { useLocalSearchParams, useRouter } from "expo-router";
import { openAccountDialog, useOxy } from "@oxy.so/services";
import {
  AiChatAssistantMessage,
  AiChatUserMessage,
  AiChatMessageLine,
} from "@oxy.so/bloom/ai-chat";
import { Button } from "@oxy.so/bloom/button";
import { Loading } from "@oxy.so/bloom/loading";
import { useQuery } from "@tanstack/react-query";
import { Text, ProductCard, toBloomIcon, useColorScheme } from "@mercaria/ui";
import { SquarePen, ArrowLeft } from "lucide-react-native";
import type { ApiResponse, ShoppingThreadReply } from "@mercaria/shared-types";
import { ScreenShell } from "@/components/shell/ScreenShell";
import { ShoppingComposer } from "@/components/shell/ShoppingComposer";
import { ThreadResults } from "@/components/search/ThreadResults";
import { runCanonicalSearch } from "@/lib/api/search-intent";
import { useFeed } from "@/lib/hooks/use-feed";
import apiClient from "@/lib/api/client";
import { useTranslation } from "@/lib/i18n";
import {
  useShoppingHistory,
  useShoppingHistoryOwner,
  type ThreadMessage,
} from "@/lib/stores/shopping-history";

/** Alia supplies replies. An unavailable deployment never substitutes a fake assistant. */
export default function ShoppingThreadScreen() {
  const params = useLocalSearchParams<{
    q?: string;
    preview?: string;
    conversationId?: string;
  }>();
  const owner = useShoppingHistoryOwner();
  const hydrated = useShoppingHistory((state) => state.hydrated);
  if (!hydrated) return <Loading variant="inline" />;
  return (
    <ShoppingThreadBody
      key={`${owner}:${params.conversationId ?? ""}:${params.q ?? ""}:${params.preview ?? ""}`}
      {...params}
      owner={owner}
    />
  );
}

function ShoppingThreadBody({
  q,
  preview,
  conversationId,
  owner,
}: {
  q?: string;
  preview?: string;
  conversationId?: string;
  owner: string;
}) {
  const saved = useRef(
    useShoppingHistory
      .getState()
      .threads.find(
        (item) => item.id === conversationId && item.owner === owner && (__DEV__ || !item.preview),
      ),
  ).current;
  const threadId = useRef(
    saved?.id ??
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  );
  // Explicit visual preview, compiled out in production; never an inference fallback.
  const isPreview = __DEV__ && (saved?.preview ?? preview === "1");
  const feed = useFeed();
  const initial =
    saved?.messages.find((message) => message.role === "user")?.content ??
    (typeof q === "string" ? q.trim() : "");
  const { t, locale } = useTranslation();
  const { isAuthenticated, canUsePrivateApi } = useOxy();
  const router = useRouter();
  const { isDarkColorScheme } = useColorScheme();
  const [messages, setMessages] = useState<ThreadMessage[]>(
    () =>
      saved?.messages ?? (initial ? [{ role: "user", content: initial }] : []),
  );
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [conversationVersion, setConversationVersion] = useState(0);
  const active = useRef<AbortController | null>(null);
  const started = useRef(Boolean(saved));
  const availability = useQuery({
    queryKey: ["shopping-thread", "availability"],
    queryFn: async () =>
      (
        await apiClient.get<ApiResponse<{ available: boolean }>>(
          "/shopping-thread",
        )
      ).data.data,
    retry: false,
  });
  const available = availability.data?.available === true;
  const catalogue = useQuery({
    queryKey: ["thread-catalogue", initial],
    queryFn: () => runCanonicalSearch(initial, {}, 8),
    enabled: Boolean(initial) && !available,
    retry: false,
  });
  useEffect(() => {
    if (!messages.length || messages === saved?.messages) return;
    useShoppingHistory
      .getState()
      .saveThread({
        id: threadId.current,
        owner,
        title:
          messages.find((message) => message.role === "user")?.content ?? "",
        updatedAt: new Date().toISOString(),
        preview: isPreview,
        messages,
      });
  }, [messages, owner, isPreview, saved]);
  useEffect(() => () => active.current?.abort(), []);

  const reply = useCallback(
    async (history: ThreadMessage[]) => {
      if (active.current) return;
      const controller = new AbortController();
      active.current = controller;
      setBusy(true);
      setFailed(false);
      try {
        if (isPreview) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 600);
            controller.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new Error("Cancelled preview"));
              },
              { once: true },
            );
          });
          const examples = (feed.data?.sections ?? [])
            .flatMap((section) =>
              section.kind === "products" ? section.products : [],
            )
            .filter(
              (product, index, all) =>
                all.findIndex((item) => item.id === product.id) === index,
            )
            .slice(0, 4);
          if (!controller.signal.aborted)
            setMessages([
              ...history,
              {
                role: "assistant",
                content: t("thread.previewReply"),
                examples,
              },
            ]);
          return;
        }
        const response = await apiClient.post<ApiResponse<ShoppingThreadReply>>(
          "/shopping-thread",
          {
            messages: history.map(({ role, content }) => ({ role, content })),
            locale,
          },
          { signal: controller.signal, timeout: 65_000 },
        );
        const result = response.data.data;
        if (!response.data.success || !result)
          throw new Error("Invalid assistant response");
        if (!controller.signal.aborted)
          setMessages([
            ...history,
            {
              role: "assistant",
              content: result.content,
              results: result.results,
            },
          ]);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      } finally {
        if (active.current === controller) {
          active.current = null;
          setBusy(false);
        }
      }
    },
    [locale, isPreview, feed.data, t],
  );

  useEffect(() => {
    if (
      started.current ||
      !initial ||
      (!isPreview && (!available || !canUsePrivateApi)) ||
      (isPreview && feed.isPending)
    )
      return;
    started.current = true;
    void reply([{ role: "user", content: initial }]);
  }, [initial, available, canUsePrivateApi, reply, isPreview, feed.isPending]);

  const send = (content: string) => {
    const history: ThreadMessage[] = [...messages, { role: "user", content }];
    setMessages(history);
    void reply(history);
  };
  const lastQuery =
    [...messages].reverse().find((message) => message.role === "user")
      ?.content ?? "";

  return (
    <ScreenShell
      key={`${conversationVersion}:${initial}`}
      composer={
        <ShoppingComposer
          onSubmit={send}
          busy={busy}
          disabled={
            (!isPreview && (!available || !canUsePrivateApi)) ||
            messages.length >= 24
          }
        />
      }
    >
      <Head>
        <title>{t("thread.title")}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <View
        className="flex-row items-center justify-between px-4 py-4 md:px-6"
        testID="thread-header"
      >
        <Button
          icon={toBloomIcon(ArrowLeft)}
          iconOnly
          appearance="plain"
          tone="neutral"
          accessibilityLabel={t("nav.home")}
          onPress={() => router.push("/")}
        />
        <Button
          icon={toBloomIcon(SquarePen)}
          iconOnly
          appearance="outline"
          tone="neutral"
          accessibilityLabel={t("thread.newConversation")}
          onPress={() => {
            active.current?.abort();
            router.replace({
              pathname: "/thread",
              params: isPreview ? { preview: "1" } : {},
            });
            setMessages([]);
            threadId.current = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            started.current = true;
            setFailed(false);
            setConversationVersion((version) => version + 1);
          }}
        />
      </View>
      <View
        className="mx-auto w-full max-w-4xl gap-6 px-4 pb-8 pt-6 md:px-7 md:pt-10"
        testID="shopping-thread"
      >
        {isPreview ? (
          <Text
            accessibilityLiveRegion="polite"
            className="text-center text-xs text-muted-foreground"
          >
            {t("thread.previewLabel")}
          </Text>
        ) : null}
        {messages.length === 0 ? (
          <View className="items-center py-20">
            <Text
              accessibilityRole="header"
              className="text-center text-[28px] font-semibold text-foreground"
            >
              {t("search.box.placeholder")}
            </Text>
          </View>
        ) : null}
        {messages.map((message, index) =>
          message.role === "user" ? (
            <AiChatUserMessage
              key={index}
              bubbleStyle={(width) => ({
                maxWidth: width - (width > 600 ? 112 : 24),
                marginInlineEnd: 0,
                borderRadius: 24,
                paddingLeft: 16,
                paddingRight: 16,
                paddingTop: 12,
                paddingBottom: 12,
                backgroundColor: isDarkColorScheme
                  ? "rgba(255,255,255,0.06)"
                  : "rgba(0,0,0,0.04)",
                boxShadow: "none",
              })}
            >
              <Text selectable className="text-base leading-6 text-foreground">
                {message.content}
              </Text>
            </AiChatUserMessage>
          ) : (
            <AiChatAssistantMessage key={index} feedback={false}>
              <AiChatMessageLine block>
                <Text
                  selectable
                  className="text-base leading-6 text-foreground"
                >
                  {message.content}
                </Text>
              </AiChatMessageLine>
              {message.results?.length ? (
                <ThreadResults results={message.results} />
              ) : null}
              {message.examples ? (
                <View
                  className="flex-row flex-wrap gap-3"
                  testID="thread-preview-products"
                >
                  {message.examples.map((product) => (
                    <View key={product.id} className="w-[47%] sm:w-[23%]">
                      <ProductCard
                        product={product}
                        onPress={(id) =>
                          router.push({
                            pathname: "/products/[id]",
                            params: { id },
                          })
                        }
                      />
                    </View>
                  ))}
                </View>
              ) : null}
            </AiChatAssistantMessage>
          ),
        )}
        {busy ? (
          <View className="gap-3">
            <Loading variant="inline" size="sm" />
            <Text
              accessibilityLiveRegion="polite"
              className="text-sm text-muted-foreground"
            >
              {t("thread.thinking")}
            </Text>
            <Button
              appearance="plain"
              tone="neutral"
              onPress={() => {
                active.current?.abort();
                setBusy(false);
              }}
            >
              {t("thread.stop")}
            </Button>
          </View>
        ) : null}
        {!isPreview && !availability.isPending && !available ? (
          <Text
            accessibilityLiveRegion="polite"
            className="text-muted-foreground"
          >
            {t("thread.unavailable")}
          </Text>
        ) : null}
        {!isPreview && available && !isAuthenticated ? (
          <Button onPress={() => openAccountDialog()}>
            {t("thread.signIn")}
          </Button>
        ) : null}
        {failed ? (
          <View className="gap-3">
            <Text accessibilityRole="alert" className="text-muted-foreground">
              {t("thread.unavailable")}
            </Text>
            <Button
              appearance="outline"
              tone="neutral"
              onPress={() => void reply(messages)}
            >
              {t("thread.retry")}
            </Button>
          </View>
        ) : null}
        {!isPreview && !available && catalogue.data?.results.length ? (
          <ThreadResults results={catalogue.data.results} />
        ) : null}
        {__DEV__ && !isPreview && !available ? (
          <View className="self-start">
            <Button
              appearance="plain"
              tone="neutral"
              onPress={() =>
                router.replace({
                  pathname: "/thread",
                  params: { q: initial, preview: "1" },
                })
              }
            >
              {t("thread.previewAction")}
            </Button>
          </View>
        ) : null}
        {lastQuery ? (
          <View className="self-start">
            <Button
              appearance="outline"
              tone="neutral"
              onPress={() =>
                router.push({ pathname: "/search", params: { q: lastQuery } })
              }
            >
              {t("thread.viewResults")}
            </Button>
          </View>
        ) : null}
      </View>
    </ScreenShell>
  );
}
