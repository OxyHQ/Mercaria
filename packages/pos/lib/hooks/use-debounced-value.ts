import { useEffect, useState } from "react";

/**
 * Debounce a rapidly-changing value (e.g. a search box) so dependent queries
 * only refire after the value settles for `delayMs`. The lone `useEffect` is the
 * idiomatic debounce timer — it owns a side-effecting `setTimeout`, not data
 * fetching, so it is the correct tool here.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);

  return debounced;
}
