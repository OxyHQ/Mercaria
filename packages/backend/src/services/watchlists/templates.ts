/**
 * Watchlist templates (#81 UX rule 8) — a starting shape for a PRIVATE list.
 *
 * A template supplies a name, an icon and a description and NOTHING else. Two
 * things it deliberately does not do:
 *
 *  - **It names no products.** A template shipping canonical product ids would
 *    be deployment data pretending to be code — wrong for every market on the
 *    day it was written, and stale for every catalogue change afterwards. What
 *    somebody wants in a PC build is a decision they make against the catalogue
 *    they can actually buy from.
 *  - **It cannot make a list public.** `WatchlistVisibility` has one member, so
 *    "without making them public in this issue" is structural rather than a rule
 *    a template author has to remember.
 *
 * A CODE constant rather than a table, for `CATALOG_BACKFILL_MAPPING_VERSION`'s
 * reason: a table would let somebody publish a template whose defaults nobody
 * shipped, and the defaults are copy.
 *
 * Item-level template semantics — "a PC build needs exactly one CPU and at least
 * one storage device" — need #94's category attribute registry to say what a CPU
 * IS. That is a named seam, not an omission: guessing it from a product name is
 * the shape of every false match #58 exists to prevent.
 */

import type { WatchlistTemplate, WatchlistTemplateKey } from '@mercaria/shared-types';

/**
 * Every template, by key. A `Record` over the union rather than a list, so a key
 * added to `WATCHLIST_TEMPLATE_KEYS` without defaults fails `tsc` here instead
 * of resolving to `undefined` at the one moment somebody uses it.
 */
export const WATCHLIST_TEMPLATES: Readonly<Record<WatchlistTemplateKey, WatchlistTemplate>> = {
  pc_build: {
    key: 'pc_build',
    name: 'PC build',
    description: 'Parts for one machine, tracked together while prices move.',
    icon: '🖥️',
  },
  home_office: {
    key: 'home_office',
    name: 'Home office',
    description: 'Desk, chair, screen and everything that goes on them.',
    icon: '🪑',
  },
  nursery: {
    key: 'nursery',
    name: 'Nursery',
    description: 'What a new arrival needs, priced as one basket.',
    icon: '🍼',
  },
  kitchen_restock: {
    key: 'kitchen_restock',
    name: 'Kitchen restock',
    description: 'The things that run out, watched together.',
    icon: '🍳',
  },
  travel_kit: {
    key: 'travel_kit',
    name: 'Travel kit',
    description: 'Luggage, adapters and the small things that get forgotten.',
    icon: '🧳',
  },
};
