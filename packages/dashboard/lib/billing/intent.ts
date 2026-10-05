/** Persist only opaque intent keys, never hosted links, credentials or responses. */
export interface BillingIntentStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
export function secureBillingIntentKey(): string {
  const bytes = new Uint8Array(24);
  // Oxy's shared crypto initialization supplies native CSPRNG; fail closed if unavailable.
  globalThis.crypto.getRandomValues(bytes);
  return `billing-${Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("")}`;
}
export function createBillingIntentRunner(storage: BillingIntentStorage, generate = secureBillingIntentKey) {
  const pending = new Map<string, Promise<unknown>>();
  return function run<T>(subject: readonly string[], action: (key: string) => Promise<T>): Promise<T> {
    const address = `mercaria.billing.intent.v1:${JSON.stringify(subject)}`;
    const inflight = pending.get(address);
    if (inflight) return inflight as Promise<T>;
    const operation = (async () => {
      let key = await storage.getItem(address);
      if (!key) { key = generate(); await storage.setItem(address, key); }
      if (!/^[A-Za-z0-9:_-]{8,200}$/.test(key)) throw new Error("Invalid stored billing intent.");
      try {
        const result = await action(key);
        await storage.removeItem(address);
        return result;
      } catch (error) {
        const status = (error as { response?: { status?: number } })?.response?.status;
        // Validation (including a conclusively expired link) is terminal. Network,
        // auth, conflict/in-progress and server errors retain the same key.
        if (status === 400 || status === 422) await storage.removeItem(address);
        throw error;
      }
    })();
    pending.set(address, operation);
    void operation.finally(() => { if (pending.get(address) === operation) pending.delete(address); }).catch(() => {});
    return operation;
  };
}
