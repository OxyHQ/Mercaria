/**
 * A fake laid over the REAL `oxyClient`: whatever the fake defines answers, and
 * everything else is the real client's — the pure helpers a test has no reason
 * to fake (`assets.publicUrl`, `cloudURL`) keep their production behaviour.
 * Nested namespaces merge the same way, so a fake `assets` that only knows
 * `importAppFile` still builds public URLs for real.
 */
export function overOxyClient<T extends object>(real: T, fake: unknown): T {
  if (fake === null || typeof fake !== 'object') return real;
  return new Proxy(real, {
    get(target, key, receiver) {
      if (key in fake) {
        const value = Reflect.get(fake, key);
        const underlying = Reflect.get(target, key, receiver);
        if (
          value !== null &&
          typeof value === 'object' &&
          underlying !== null &&
          typeof underlying === 'object'
        ) {
          return overOxyClient(underlying, value);
        }
        return value;
      }
      return Reflect.get(target, key, receiver);
    },
  });
}
