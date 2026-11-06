import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';

/**
 * Re-read something once the person comes BACK from a page the app opened.
 *
 * `WebBrowser.openBrowserAsync` resolves when the in-app browser closes on
 * native, but on web it opens a new tab and resolves at once — so a re-read
 * placed after the `await` runs before the person has done anything there. This
 * arms a one-shot re-read for the next time the app becomes active again
 * (`AppState` follows the document's visibility on web), which is when a person
 * who confirmed in another tab returns to this one.
 *
 * Returns `arm`; the caller arms it just before opening the page. A failed
 * re-read is swallowed: the screen still shows its last read, and the next
 * refetch or the gateway's own event corrects it.
 */
export function useRefreshOnReturn(refresh: () => Promise<void>): () => void {
  const armed = useRef(false);
  const latest = useRef(refresh);

  useEffect(() => {
    latest.current = refresh;
  }, [refresh]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !armed.current) return;
      armed.current = false;
      latest.current().catch(() => undefined);
    });
    return () => subscription.remove();
  }, []);

  return useCallback(() => {
    armed.current = true;
  }, []);
}
