/**
 * Mercaria's drawings of its own catalogue tools' results, inside Alia's sheet.
 *
 * Keyed `mercaria:<tool>`: the SDK parses the key from the tool's canonical
 * name (`oxy_mercaria__searchProducts`), never from anything the model wrote.
 * The products come from the tool's structured output (`searchOfResult`) and
 * are drawn with the same cards as the search page.
 */

import type { AliaToolRenderers, AliaToolResult } from '@alia.onl/sdk';
import { useAskAgent } from '@alia.onl/sdk/ask';
import { Button } from '@oxy.so/bloom/button';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { ThreadResults } from '@/components/search/ThreadResults';
import { useTranslation } from '@/lib/i18n';
import { searchOfResult } from '@/lib/thread/search-result';

/** How many cards one search shows in the sheet; the rest are one tap away on the search page. */
export const THREAD_RESULTS_MAX = 8;

function SearchProducts({ result }: { result: AliaToolResult }) {
  const { t } = useTranslation();
  const router = useRouter();
  const { dismiss } = useAskAgent();
  const { query, results } = searchOfResult(result);
  if (results.length === 0) return null;
  return (
    <View className="gap-3" testID="thread-results-card">
      <ThreadResults results={results.slice(0, THREAD_RESULTS_MAX)} />
      {query ? (
        <View className="self-start">
          <Button
            appearance="outline"
            tone="neutral"
            onPress={() => {
              // The search page opens under the sheet: close it, so it is not covered.
              dismiss();
              router.push({ pathname: '/search', params: { q: query } });
            }}
          >
            {t('alia.viewResults')}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

export const MERCARIA_TOOL_RENDERERS: AliaToolRenderers = {
  'mercaria:searchProducts': (result) => <SearchProducts result={result} />,
};
