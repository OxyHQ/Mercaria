/** Acknowledging a saved snapshot must not erase edits made while it was in flight. */
export function retainLaterEdits<T extends object>(
  current: Partial<T>,
  submitted: Partial<T>,
): Partial<T> {
  const remaining = { ...current };
  for (const key of Object.keys(submitted) as (keyof T)[]) {
    if (current[key] === submitted[key]) delete remaining[key];
  }
  return remaining;
}
