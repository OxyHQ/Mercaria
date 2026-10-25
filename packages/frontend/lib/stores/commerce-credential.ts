import { createStore } from 'zustand/vanilla';

export interface CredentialStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
  compareWrite?(expected: string | null, value: string | null): Promise<boolean>;
  exclusive?<T>(operation: () => Promise<T>): Promise<T>;
  subscribe?(listener: (value: string | null) => void): () => void;
}
export interface CommerceCredentialState {
  token: string | null;
  expiresAt: number | null;
  generation: number | null;
  hydrated: boolean;
  storageAvailable: boolean;
  revision: number;
  externalRevision: number;
  cleared: boolean;
}

/** Independent commerce authority. Oxy switches fence requests, not these grants. */
export function createCommerceCredential(
  storage: CredentialStorage,
  now = Date.now,
  retainClearMarker = false,
) {
  const empty = { token: null, expiresAt: null, generation: null, cleared: false };
  const store = createStore<CommerceCredentialState>(() => ({
    ...empty,
    hydrated: false,
    storageAvailable: true,
    revision: 0,
    externalRevision: 0,
  }));
  let writes = Promise.resolve(true);
  let stored: string | null = null;
  let issuance: Promise<unknown> = Promise.resolve();
  function decode(raw: string | null) {
    if (!raw) return empty;
    // Preserve existing native opaque tokens until the server validates them.
    const record = raw.startsWith('{')
      ? JSON.parse(raw)
      : { token: raw, expiresAt: null, generation: null };
    if (
      record.token === null &&
      record.cleared === true &&
      record.expiresAt === null &&
      record.generation === null
    )
      return { ...empty, cleared: true };
    if (
      typeof record.token !== 'string' ||
      !record.token ||
      (record.expiresAt !== null &&
        (!Number.isFinite(record.expiresAt) || record.expiresAt <= now())) ||
      (record.generation !== null &&
        (!Number.isSafeInteger(record.generation) || record.generation < 0))
    )
      return null;
    return {
      token: record.token as string,
      expiresAt: record.expiresAt as number | null,
      generation: record.generation as number | null,
      cleared: false,
    };
  }
  function external(raw: string | null, force = false) {
    if (!force && stored === raw) return;
    stored = raw;
    let record: ReturnType<typeof decode>;
    try {
      record = decode(raw);
    } catch {
      record = null;
    }
    store.setState((state) => ({
      ...(record ?? empty),
      revision: state.revision + 1,
      externalRevision: state.externalRevision + 1,
    }));
  }
  const unsubscribe = storage.subscribe?.((raw) => external(raw));
  function persist(value: string | null) {
    const revision = store.getState().revision;
    writes = writes
      .then(async () => {
        await ready;
        if (store.getState().revision !== revision) return false;
        if (storage.compareWrite) {
          if (!(await storage.compareWrite(stored, value))) {
            external(await storage.read(), true);
            return false;
          }
        } else if (value === null) await storage.remove();
        else await storage.write(value);
        stored = value;
        store.setState({ storageAvailable: true });
        return true;
      })
      .catch(() => {
        store.setState({ storageAvailable: false });
        return false;
      });
  }
  function clear() {
    store.setState((state) => ({ ...empty, cleared: true, revision: state.revision + 1 }));
    persist(retainClearMarker ? JSON.stringify({ ...empty, cleared: true }) : null);
  }
  const ready = (async () => {
    const initial = store.getState();
    try {
      const raw = await storage.read();
      if (store.getState().externalRevision === initial.externalRevision) stored = raw;
      if (store.getState().revision !== initial.revision) return;
      const record = decode(raw);
      if (!record) {
        clear();
        return;
      }
      store.setState(record);
    } catch {
      store.setState({ storageAvailable: false });
    } finally {
      store.setState({ hydrated: true });
    }
  })();
  function current() {
    const state = store.getState();
    if (state.expiresAt !== null && state.expiresAt <= now()) clear();
    return store.getState();
  }
  function snapshot() {
    const state = current();
    return {
      token: state.token,
      revision: state.revision,
      accept(token: string | null, expiry: string | null, generation: string | null) {
        if (store.getState().revision !== state.revision || token === null) return;
        if (!token) {
          clear();
          return;
        }
        const expiresAt = expiry === null ? NaN : Date.parse(expiry);
        const version = generation !== null && /^\d+$/.test(generation) ? Number(generation) : NaN;
        if (
          !Number.isFinite(expiresAt) ||
          expiresAt <= now() ||
          !Number.isSafeInteger(version) ||
          version < 0 ||
          (state.generation !== null && version < state.generation)
        )
          return;
        store.setState({
          token,
          expiresAt,
          generation: version,
          cleared: false,
          revision: state.revision + 1,
        });
        persist(JSON.stringify({ token, expiresAt, generation: version }));
      },
    };
  }
  return {
    store,
    ready,
    current,
    snapshot,
    clear,
    settled: () => writes,
    async synchronize() {
      await ready;
      await writes;
      const revision = store.getState().revision;
      try {
        const raw = await storage.read();
        if (store.getState().revision === revision) external(raw);
      } catch {
        store.setState({ storageAvailable: false });
      }
    },
    exclusive<T>(operation: () => Promise<T>): Promise<T> {
      const queued = issuance
        .catch(() => {})
        .then(() => (storage.exclusive ? storage.exclusive(operation) : operation()));
      issuance = queued;
      return queued;
    },
    async persisted(revision = store.getState().revision) {
      return (
        (await writes) &&
        store.getState().revision === revision &&
        store.getState().storageAvailable
      );
    },
    dispose: () => unsubscribe?.(),
  };
}

/** Web Locks serialize compare-and-write across tabs; unsupported storage stays non-durable. */
export function webCredentialStorage(
  key: string,
  getStorage = () => globalThis.localStorage,
): CredentialStorage {
  return {
    async read() {
      if (!globalThis.navigator?.locks) throw new Error('Durable commerce storage is unavailable');
      return navigator.locks.request(`mercaria-storage:${key}`, () => {
        const storage = getStorage();
        // Detect disabled/full storage before a request can consume a single-use link
        // or create a cart. This probe contains no credential and is removed immediately.
        const probe = `${key}.writable`;
        storage.setItem(probe, '1');
        storage.removeItem(probe);
        return storage.getItem(key);
      });
    },
    async write(value) {
      getStorage().setItem(key, value);
    },
    async remove() {
      getStorage().removeItem(key);
    },
    async exclusive(operation) {
      if (!globalThis.navigator?.locks) throw new Error('Durable commerce storage is unavailable');
      return navigator.locks.request(`mercaria-issuance:${key}`, operation);
    },
    async compareWrite(expected, value) {
      if (!globalThis.navigator?.locks) throw new Error('Durable commerce storage is unavailable');
      return navigator.locks.request(`mercaria-storage:${key}`, () => {
        const storage = getStorage();
        if (storage.getItem(key) !== expected) return false;
        if (value === null) storage.removeItem(key);
        else storage.setItem(key, value);
        return true;
      });
    },
    subscribe(listener) {
      if (typeof window === 'undefined') return () => {};
      const changed = (event: StorageEvent) => {
        if (event.key !== key && event.key !== null) return;
        try {
          const storage = getStorage();
          if (event.storageArea === storage) listener(storage.getItem(key));
        } catch {
          /* No new authority is inferred from unavailable storage. */
        }
      };
      window.addEventListener('storage', changed);
      return () => window.removeEventListener('storage', changed);
    },
  };
}
