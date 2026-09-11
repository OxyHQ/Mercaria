import { View } from 'react-native';
import { formatDate, Text } from '@mercaria/ui';
import { useTranslation } from '@/lib/i18n';
import type { DigitalVersionEntry } from '@/lib/digital/source';

/**
 * A work's releases and what changed in each (#1015 Workstream 5).
 *
 * ## Why a buyer needs this on the PUBLIC page
 *
 * Because what they are buying is pinned to one of these rows. An order line
 * snapshots the asset VERSION (ADR 0010 D2), the right freezes the update policy
 * (D4), and `purchased_version_only` means "exactly the version bought, forever" —
 * so "which version is current, and what did the last one change" is a question
 * with a price attached, not a changelog for the curious.
 *
 * ## The label is the creator's own string, and that has a consequence worth knowing
 *
 * `major_version` is the leading integer of whatever the creator typed, or 0 — so
 * a creator numbering releases `spring-2026` gets 0 for all of them and
 * `same_major_version` behaves as `purchased_version_only` for them (ADR 0010 D4,
 * stated there rather than left to be discovered). This component renders the
 * label verbatim and derives nothing from it: parsing a version label to explain
 * an entitlement would be a second implementation of a rule
 * `services/digital/version-coverage.ts` owns, and the two would disagree exactly
 * where the creator's numbering is unusual.
 *
 * ## `current` is a flag from the read, not the first row
 *
 * Ordering is the server's, and "newest" is not the same question as "acquirable":
 * `ACQUIRABLE_ASSET_VERSION_STATES` has ONE member while three states remain
 * DOWNLOADABLE, so the version a new purchase gets is not always the last one
 * published (a creator may have withdrawn it). Reading position as state would put
 * the badge on the wrong row precisely when it matters.
 *
 * The version STATE is deliberately not rendered: `draft`, `review` and
 * `restricted` versions are not public facts, and a state name on a public page
 * would either leak moderation (`restricted` is moderation's — ADR 0010 D7) or be
 * a wire enum shown raw, which `validate:i18n-strings` check J counts as a defect.
 */

export interface DigitalVersionHistoryProps {
  versions: readonly DigitalVersionEntry[];
}

export function DigitalVersionHistory({ versions }: DigitalVersionHistoryProps) {
  const { t, locale } = useTranslation();

  if (versions.length === 0) return null;

  return (
    <View className="gap-space-8">
      {versions.map((version) => (
        <View
          key={version.versionId}
          className="gap-space-2 border-b border-border-secondary py-space-8"
        >
          <View className="flex-row items-center gap-space-8">
            {/* The creator's own label, verbatim — see the module note. */}
            <Text className="text-bodyTitleSmall text-text">{version.label}</Text>
            {version.current ? (
              <View className="rounded-radius-max bg-bg-fill-secondary px-space-8 py-space-4">
                <Text className="text-badge text-text">{t('digital.asset.currentVersion')}</Text>
              </View>
            ) : null}
          </View>
          {/* The APP's locale, never the device's (#488/#529: a bare
              `toLocaleDateString()` is check H's exact-count failure). */}
          <Text className="text-caption text-text-tertiary">
            {formatDate(version.releasedAt, locale)}
          </Text>
          {version.notes === undefined ? null : (
            <Text className="text-bodySmall text-text-secondary">{version.notes}</Text>
          )}
        </View>
      ))}
    </View>
  );
}
