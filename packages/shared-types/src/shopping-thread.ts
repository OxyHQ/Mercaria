import type { SearchResult } from './search';

export const SHOPPING_THREAD_ROLES = ['user', 'assistant'] as const;
export interface ShoppingThreadMessage {
  readonly role: (typeof SHOPPING_THREAD_ROLES)[number];
  readonly content: string;
}
export interface ShoppingThreadRequest {
  readonly messages: readonly ShoppingThreadMessage[];
  readonly locale: string;
}
export interface ShoppingThreadReply {
  readonly content: string;
  readonly results: readonly SearchResult[];
}
