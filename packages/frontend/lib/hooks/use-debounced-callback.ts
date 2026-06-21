import { useCallback, useEffect, useRef } from "react";

/**
 * Returns a debounced version of `callback`. The latest call within `delay`
 * wins; pending invocations are cancelled on unmount. The returned function is
 * stable, and a `flush` companion runs any pending call immediately (used to
 * commit an in-flight autosave when the editor unmounts/blurs).
 */
export function useDebouncedCallback<Args extends unknown[]>(
  callback: (...args: Args) => void,
  delay: number
): { run: (...args: Args) => void; flush: () => void; cancel: () => void } {
  const callbackRef = useRef(callback);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingArgsRef = useRef<Args | null>(null);

  callbackRef.current = callback;

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingArgsRef.current = null;
  }, []);

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingArgsRef.current) {
      const args = pendingArgsRef.current;
      pendingArgsRef.current = null;
      callbackRef.current(...args);
    }
  }, []);

  const run = useCallback(
    (...args: Args) => {
      pendingArgsRef.current = args;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const pending = pendingArgsRef.current;
        pendingArgsRef.current = null;
        if (pending) callbackRef.current(...pending);
      }, delay);
    },
    [delay]
  );

  useEffect(() => cancel, [cancel]);

  return { run, flush, cancel };
}
