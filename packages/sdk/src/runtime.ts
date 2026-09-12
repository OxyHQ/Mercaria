/**
 * The platform surface the SDK needs, typed STRUCTURALLY.
 *
 * `src/` compiles without the DOM lib (see `tsconfig.json`), so `fetch`,
 * `AbortSignal` and the timers are described here by the few members the SDK
 * actually touches. That buys two things: the same code type-checks against
 * Node's undici, Bun, browsers and React Native's whatwg-fetch alike, and the
 * published `.d.ts` never forces `lib: ["DOM"]` on a server consumer.
 */

/** The subset of `Headers` the SDK reads. */
export interface MercariaHeadersLike {
  get(name: string): string | null;
}

/** The subset of a fetch `Response` the SDK reads. */
export interface MercariaFetchResponse {
  readonly status: number;
  readonly headers: MercariaHeadersLike;
  text(): Promise<string>;
}

/** The subset of `AbortSignal` the SDK reads. */
export interface MercariaAbortSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/** What the SDK passes to `fetch`. */
export interface MercariaFetchInit {
  method: 'GET';
  headers: Record<string, string>;
  /**
   * The request's `AbortSignal` (a {@link MercariaAbortSignal} at runtime).
   *
   * Typed `any` deliberately. A `fetch` parameter is checked contravariantly,
   * so this field must be assignable to the platform's own `RequestInit.signal`
   * — the DOM's, undici's or node-fetch's `AbortSignal`, each a different
   * declaration — for `fetch: globalThis.fetch` to type-check. No structural
   * type can be assignable to all of them without importing one of them, and
   * importing one would force that lib on every consumer.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signal?: any;
  credentials: 'omit';
  redirect: 'follow';
}

/**
 * A `fetch` implementation. The global `fetch` of every supported runtime
 * satisfies this, and so does a test double.
 */
export type MercariaFetch = (url: string, init: MercariaFetchInit) => Promise<MercariaFetchResponse>;

interface AbortControllerLike {
  readonly signal: MercariaAbortSignal;
  abort(): void;
}

type TimerHandle = unknown;

interface RuntimeGlobals {
  fetch?: MercariaFetch;
  AbortController?: new () => AbortControllerLike;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const runtime = globalThis as unknown as RuntimeGlobals;

/**
 * The global `fetch`, resolved at CALL time rather than at import time (a test
 * or a polyfill may install it later) and bound to `globalThis`, because a
 * browser's `fetch` throws "Illegal invocation" when called off its receiver.
 */
export function globalFetch(): MercariaFetch | undefined {
  const candidate = runtime.fetch;
  return typeof candidate === 'function' ? candidate.bind(globalThis) : undefined;
}

export function createAbortController(): AbortControllerLike | undefined {
  const Controller = runtime.AbortController;
  return typeof Controller === 'function' ? new Controller() : undefined;
}

export function startTimer(callback: () => void, ms: number): TimerHandle {
  return runtime.setTimeout(callback, ms);
}

export function stopTimer(handle: TimerHandle): void {
  runtime.clearTimeout(handle);
}
