import {
  type ComponentRef,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { TextInput } from 'react-native';
import { useAskAgent } from '@alia.onl/sdk/ask';
import { useOxy } from '@oxy.so/services/ui/client';
import { useLocalSearchParams } from 'expo-router';
import { ChatComposer } from '@oxy.so/bloom/chat-composer';
import { PageFooter } from '@oxy.so/bloom/page-footer';
import Animated, {
  Easing,
  FadeInDown,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  withTiming,
} from 'react-native-reanimated';
import { ArrowRight } from 'lucide-react-native';
import { toBloomIcon } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';
import { useFeed } from '@/lib/hooks/use-feed';

const ARRIVAL = FadeInDown.duration(200)
  .easing(Easing.bezier(0.2, 0, 0, 1))
  .reduceMotion(ReduceMotion.System);

const DraftContext = createContext<{
  query: string;
  setQuery: (value: string) => void;
} | null>(null);

/** The home field and its floating continuation edit the same draft. */
export function ShoppingComposerProvider({ children }: { children: ReactNode }) {
  const { q } = useLocalSearchParams<{ q?: string }>();
  const routeQuery = typeof q === 'string' ? q : '';
  const [query, setQuery] = useState(routeQuery);
  useEffect(() => {
    setQuery(routeQuery);
  }, [routeQuery]);
  const value = useMemo(() => ({ query, setQuery }), [query]);
  return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

/**
 * Bloom owns the input, autosizing, keyboard suggestions, focus and send transitions.
 *
 * Sending asks Alia in her one sheet (`components/alia/MercariaAskProvider.tsx`)
 * with the words as the first turn. Signed out, the SDK opens Oxy's sign-in and
 * the words stay in the field, to send again once signed in.
 */
export function ShoppingComposer({ inline = false }: { inline?: boolean }) {
  const { t } = useTranslation();
  const { ask } = useAskAgent();
  const { canUsePrivateApi } = useOxy();
  const draft = useContext(DraftContext);
  if (!draft) throw new Error('ShoppingComposer requires ShoppingComposerProvider');
  const { query, setQuery } = draft;
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const feed = useFeed();
  const reducedMotion = useReducedMotion();
  const expansion = useAnimatedStyle(
    () => ({
      maxWidth: reducedMotion
        ? inline
          ? 600
          : focused
            ? 600
            : 512
        : withTiming(inline ? 600 : focused ? 600 : 512, {
            duration: 320,
            easing: Easing.bezier(0.2, 0, 0, 1),
          }),
    }),
    [focused, reducedMotion, inline],
  );

  const suggestions = useMemo(() => {
    if (!focused) return [];
    const pills = feed.data?.sections.find((section) => section.kind === 'category-pills');
    if (pills?.kind !== 'category-pills') return [];
    return pills.pills
      .filter((pill) => pill.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
      .slice(0, 5)
      .map((pill) => ({ id: pill.id, label: pill.name }));
  }, [feed.data, focused, query]);

  const submit = useCallback(
    (value: string) => {
      const term = value.trim();
      if (!term) {
        inputRef.current?.focus();
        return;
      }
      setFocused(false);
      inputRef.current?.blur();
      ask(undefined, { text: term });
      if (canUsePrivateApi) setQuery('');
    },
    [ask, canUsePrivateApi, setQuery],
  );

  const composer = (
    <Animated.View entering={ARRIVAL} className="w-full self-center" style={expansion}>
      <ChatComposer
        testID="shopping-composer"
        inputRef={inputRef}
        accessibilityLabel={t('search.box.label')}
        labels={{ input: t('search.box.label'), send: t('search.box.label') }}
        placeholder={t('search.box.placeholder')}
        value={query}
        onValueChange={(value) => {
          setQuery(value);
          setActiveIndex(-1);
        }}
        onSend={submit}
        canSend={Boolean(query.trim())}
        maxLines={4}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onEscape={() => {
          setFocused(false);
          inputRef.current?.blur();
        }}
        suggestions={suggestions}
        suggestionKind="command"
        activeIndex={activeIndex}
        onActiveIndexChange={setActiveIndex}
        onSelectSuggestion={(suggestion) => submit(suggestion.label)}
        sendIcon={toBloomIcon(ArrowRight)}
        inputStyle={{ fontSize: 16, lineHeight: 24 }}
        barStyle={{
          minHeight: 64,
          borderRadius: 32,
          paddingLeft: 20,
          paddingRight: 12,
          paddingTop: 12,
          paddingBottom: 12,
          boxShadow: '0 8px 40px rgba(0, 0, 0, 0.12)',
        }}
      />
    </Animated.View>
  );
  return inline ? (
    composer
  ) : (
    <PageFooter
      position="document"
      scrim="none"
      safeArea
      testID="shopping-composer-footer"
      style={{ paddingBottom: 28 }}
    >
      {composer}
    </PageFooter>
  );
}
