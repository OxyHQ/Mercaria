/**
 * `/thread` is not a page: it is an old address of the shopping thread, which
 * is now Alia's one sheet (`components/alia/MercariaAskProvider.tsx`). The
 * storefront links here no more, but browsers, bookmarks and shared links
 * still carry `/thread?q=…` and `/thread?conversationId=…`, so the address
 * opens the sheet on what it named — a first turn, or the conversation — over
 * the home page, and leaves itself. Signed out, the SDK opens Oxy's sign-in.
 */

import { useAskAgent } from '@alia.onl/sdk/ask';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Head from 'expo-router/head';
import { useEffect, useRef } from 'react';

export default function ThreadAddress() {
  const { q, conversationId } = useLocalSearchParams<{ q?: string; conversationId?: string }>();
  const router = useRouter();
  const { ask, resume } = useAskAgent();
  const opened = useRef(false);

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    router.replace('/');
    if (typeof conversationId === 'string' && conversationId !== '') {
      resume(undefined, conversationId);
      return;
    }
    const text = typeof q === 'string' ? q.trim() : '';
    ask(undefined, text ? { text } : undefined);
  }, [ask, conversationId, q, resume, router]);

  return (
    <Head>
      <meta name="robots" content="noindex" />
    </Head>
  );
}
