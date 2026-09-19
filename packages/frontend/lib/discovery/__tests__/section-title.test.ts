import { describe, expect, it } from 'vitest';
import { DISCOVERY_SIGNALS } from '@mercaria/shared-types';
import { sectionTitleKey } from '../section-title';

describe('sectionTitleKey', () => {
  it('maps every signal in the closed set to a key', () => {
    // The set is closed and rendered into a database CHECK. A signal with no
    // key would render as raw `discovery.shelf.undefined` on a live shelf.
    for (const signal of DISCOVERY_SIGNALS) {
      expect(sectionTitleKey(signal)).toMatch(/^discovery\.shelf\./);
    }
  });

  it('gives each signal a DISTINCT key', () => {
    // Two signals sharing a key is how "Top rated" ends up over the
    // best-selling shelf — visible only to someone reading both at once.
    const keys = DISCOVERY_SIGNALS.map(sectionTitleKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
