/**
 * The shopping thread: a conversation with Alia, drawn by Alia's SDK.
 *
 * Mercaria brings only what is Mercaria's — the product cards
 * (`MERCARIA_TOOL_RENDERERS`), the words and the screen's context. The
 * conversation, its history, titles, voice, attachments and streaming are
 * Alia's, and so is the bill: the person present pays with their own Alia
 * credits (Alia ADR 0020). Alia reaches the catalogue through Mercaria's
 * capability catalogue (`oxy_mercaria__searchProducts`).
 *
 * This route owns the address of the conversation: `/thread?q=…` opens a new
 * one with that first turn, and the conversation the turn makes replaces the
 * address (`/thread?conversationId=…`), which is what "Keep shopping" opens.
 *
 * Signed out there is no conversation to have, so the screen shows what the
 * query finds in the catalogue and offers sign-in.
 */

import {
  ALIA_CHARACTER_RUNTIME_URL,
  AliaChatContent,
  type AliaChatState,
  type AliaRuntimeHost,
} from '@alia.onl/sdk';
import { AgentAvatarProvider } from '@oxy.so/bloom/agent-avatar';
import { Button } from '@oxy.so/bloom/button';
import { openAccountDialog, useOxy } from '@oxy.so/services';
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { ArrowLeft, SquarePen } from 'lucide-react-native';
import { useCallback, useMemo } from 'react';
import { View } from 'react-native';
import { Text, toBloomIcon, useColorScheme } from '@mercaria/ui';
import { ThreadResults } from '@/components/search/ThreadResults';
import { ScreenShell } from '@/components/shell/ScreenShell';
import { MERCARIA_TOOL_RENDERERS } from '@/components/thread/mercariaToolRenderers';
import { runCanonicalSearch } from '@/lib/api/search-intent';
import { useTranslation } from '@/lib/i18n';

export default function ShoppingThreadScreen() {
  const { q, conversationId } = useLocalSearchParams<{ q?: string; conversationId?: string }>();
  const { canUsePrivateApi } = useOxy();
  const query = typeof q === 'string' ? q.trim() : '';
  return canUsePrivateApi ? (
    <AliaThread query={query} conversationId={conversationId} />
  ) : (
    <SignedOutThread query={query} />
  );
}

function ThreadHeader({ onNewConversation }: { onNewConversation?: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <View
      className="flex-row items-center justify-between px-4 py-4 md:px-6"
      testID="thread-header"
    >
      <Button
        icon={toBloomIcon(ArrowLeft)}
        iconOnly
        appearance="plain"
        tone="neutral"
        accessibilityLabel={t('nav.home')}
        onPress={() => router.push('/')}
      />
      {onNewConversation ? (
        <Button
          icon={toBloomIcon(SquarePen)}
          iconOnly
          appearance="outline"
          tone="neutral"
          accessibilityLabel={t('thread.newConversation')}
          onPress={onNewConversation}
        />
      ) : null}
    </View>
  );
}

function AliaThread({ query, conversationId }: { query: string; conversationId?: string }) {
  const { t, locale } = useTranslation();
  const router = useRouter();
  const { isDarkColorScheme } = useColorScheme();

  const runtime = useMemo<AliaRuntimeHost>(
    () => ({
      // The conversation the first turn made replaces the address; the SDK hands
      // that turn to the conversation's own mount.
      openConversation: (id) => {
        if (id !== conversationId)
          router.replace({ pathname: '/thread', params: { conversationId: id } });
      },
      closeConversation: () => router.replace('/thread'),
    }),
    [conversationId, router],
  );

  const newConversation = useCallback(() => router.replace('/thread'), [router]);
  const chrome = useCallback(
    (_state: AliaChatState) => ({ header: <ThreadHeader onNewConversation={newConversation} /> }),
    [newConversation],
  );

  const initialTurn = useMemo(
    () => (!conversationId && query ? { text: query } : undefined),
    [conversationId, query],
  );

  return (
    <ScreenShell scroll={false} hideComposer>
      <Head>
        <title>{t('thread.title')}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <View className="flex-1" testID="shopping-thread">
        <AgentAvatarProvider runtimeUrl={ALIA_CHARACTER_RUNTIME_URL}>
          <AliaChatContent
            key={conversationId ?? 'new'}
            conversationId={conversationId}
            runtime={runtime}
            toolRenderers={MERCARIA_TOOL_RENDERERS}
            clientContext={`Mercaria, Oxy's marketplace — the shopping thread. Locale: ${locale}. Search Mercaria's catalogue for products; the app draws the products the search returns, so name them without repeating their details.`}
            welcomeGreeting={t('search.box.placeholder')}
            chrome={chrome}
            initialTurn={initialTurn}
            onSignInRequired={() => openAccountDialog()}
            isDarkMode={isDarkColorScheme}
          />
        </AgentAvatarProvider>
      </View>
    </ScreenShell>
  );
}

function SignedOutThread({ query }: { query: string }) {
  const { t } = useTranslation();
  const catalogue = useQuery({
    queryKey: ['thread-catalogue', query],
    queryFn: () => runCanonicalSearch(query, {}, 8),
    enabled: Boolean(query),
    retry: false,
  });
  return (
    <ScreenShell>
      <Head>
        <title>{t('thread.title')}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <ThreadHeader />
      <View
        className="mx-auto w-full max-w-4xl gap-6 px-4 pb-8 pt-6 md:px-7 md:pt-10"
        testID="shopping-thread"
      >
        {query ? (
          <Text selectable className="text-base leading-[24px] text-foreground">
            {query}
          </Text>
        ) : (
          <Text
            accessibilityRole="header"
            className="py-20 text-center text-[28px] font-semibold text-foreground"
          >
            {t('search.box.placeholder')}
          </Text>
        )}
        <View className="self-start">
          <Button onPress={() => openAccountDialog()}>{t('thread.signIn')}</Button>
        </View>
        {catalogue.data?.results.length ? <ThreadResults results={catalogue.data.results} /> : null}
      </View>
    </ScreenShell>
  );
}
