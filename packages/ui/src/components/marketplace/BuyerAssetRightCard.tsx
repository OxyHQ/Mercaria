import { Pressable, View } from "react-native";
import {
  DOWNLOAD_AUTHORIZING_ASSET_RIGHT_STATUSES,
  type BuyerAssetRightSummary,
} from "@mercaria/shared-types";
import { Text } from "../ui/text";
import { useSharedUiLocale, useSharedUiTranslation } from "../../i18n/ui-translation";
import { formatByteSize } from "../../lib/byte-size";
import { formatDate } from "../../lib/date";
import {
  ASSET_LIBRARY_AVAILABLE_VERSION_KEY,
  ASSET_LIBRARY_DOWNLOADS_PAUSED_KEY,
  ASSET_LIBRARY_DOWNLOAD_A11Y_KEY,
  ASSET_LIBRARY_DOWNLOAD_ACTION_KEY,
  ASSET_LIBRARY_FILES_TITLE_KEY,
  ASSET_LIBRARY_GRANTED_ON_KEY,
  ASSET_LIBRARY_LICENCE_KEY,
  ASSET_LIBRARY_NOT_DOWNLOADABLE_KEY,
  ASSET_LIBRARY_PURCHASED_VERSION_KEY,
  ASSET_LIBRARY_UPDATE_AVAILABLE_KEY,
  ASSET_RIGHT_STATUS_KEYS,
} from "../../lib/digital-asset-labels";

/**
 * One line of the buyer's digital library (#1015 Workstream 9).
 *
 * Renders a `BuyerAssetRightSummary` — the DTO's own projection, whole — and
 * nothing else. The four things W9 requires a buyer be able to see before
 * fetching anything are the four this card renders per file: the NAME, the
 * FORMAT, the BYTE SIZE, and whether it is downloadable at all.
 *
 * ## The card shows what is OWNED, and a right is not a URL
 *
 * #1015 boundary 3/4: a payment does not authorize a download and neither does a
 * link. `BuyerAssetRightSummary` deliberately carries no storage reference of any
 * kind — *"a DTO that leaked one would make the authorization step optional for
 * anybody reading a response body"* — so this card cannot link to a file. It
 * calls `onDownload` with a `fileId`, and the app asks the server, which runs the
 * six checks and mints a five-minute grant (ADR 0010 D5). That is why the control
 * is a button and not an anchor: there is no address to put in one.
 *
 * ## Two versions, and showing only one of them would be the bug
 *
 * `purchasedVersionLabel` is what the purchase PINNED and `availableVersionLabel`
 * is the newest the right's update policy covers — they are different facts and
 * ADR 0010 D4 is the reason: `purchased_version_only` keeps them apart forever,
 * and a card showing only the newest would tell a buyer they have something they
 * do not. `updateAvailable` is the DTO's own comparison, rendered as its own
 * badge rather than recomputed here from the two labels: a label is a creator's
 * string and comparing two of them client-side is a second answer to a question
 * the server already answered with the version graph.
 *
 * ## A non-`active` right stays ON the screen
 *
 * ADR 0010 D6 gives `asset_rights` no delete path, so a refunded, disputed,
 * revoked or superseded purchase still exists — and still appears here, with its
 * status stated and its download controls gone. Dropping the row would leave a
 * buyer unable to tell a reversed purchase from one that never happened, which is
 * exactly the history W2's closing rule refuses to erase.
 *
 * Whether downloads are authorized is read from
 * `DOWNLOAD_AUTHORIZING_ASSET_RIGHT_STATUSES` — the shared one-member list — and
 * never from `status === "active"` written out here, so this card and the
 * authorizer cannot disagree about what a held right may do. The control is
 * ABSENT rather than disabled: a disabled download button invites a buyer to
 * keep pressing it, while a sentence says what to do instead.
 */

export interface BuyerAssetRightCardProps {
  right: BuyerAssetRightSummary;
  /**
   * Ask the server for a download grant for one file.
   *
   * Absent on a surface that only LISTS a library (an order confirmation, say),
   * and the card then renders the inventory with no controls — which is a
   * complete rendering rather than a degraded one, because the file list is the
   * part W9 requires.
   */
  onDownload?: (fileId: string) => void;
  /** Open the asset's page — the creator, the versions, what changed. */
  onOpenAsset?: (assetId: string) => void;
}

export function BuyerAssetRightCard({
  right,
  onDownload,
  onOpenAsset,
}: BuyerAssetRightCardProps) {
  const t = useSharedUiTranslation();
  const locale = useSharedUiLocale();

  const statusText = t(ASSET_RIGHT_STATUS_KEYS[right.status]);
  const downloadsAuthorized = DOWNLOAD_AUTHORIZING_ASSET_RIGHT_STATUSES.includes(right.status);

  return (
    <View className="gap-space-12 rounded-radius-16 border border-border-secondary p-space-16">
      <View className="gap-space-4">
        {onOpenAsset === undefined ? (
          <Text className="text-bodyTitleSmall text-text">{right.assetTitle}</Text>
        ) : (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={right.assetTitle}
            onPress={() => onOpenAsset(right.assetId)}
          >
            <Text className="text-bodyTitleSmall text-text-brand">{right.assetTitle}</Text>
          </Pressable>
        )}
        {/* The PACKAGE is what was actually bought — a subset of one version's
            files, and the thing the licence option is over. */}
        <Text className="text-bodySmall text-text-secondary">{right.packageName}</Text>
        <Text className="text-caption text-text-tertiary">
          {t(ASSET_LIBRARY_LICENCE_KEY, { licence: right.licenceName })}
        </Text>
        <Text className="text-caption text-text-tertiary">
          {t(ASSET_LIBRARY_GRANTED_ON_KEY, { date: formatDate(right.grantedAt, locale) })}
        </Text>
      </View>

      <View className="flex-row flex-wrap items-center gap-space-8">
        {/* The status is a TERM, not a colour: it is spelled out, and it is
            spelled out for `active` too, so a reader never has to infer the
            ordinary state from the absence of a badge. */}
        <View className="rounded-radius-max bg-bg-fill-secondary px-space-8 py-space-4">
          <Text className="text-badge text-text">{statusText}</Text>
        </View>
        {right.updateAvailable ? (
          <View className="rounded-radius-max bg-bg-fill-secondary px-space-8 py-space-4">
            <Text className="text-badge text-text">{t(ASSET_LIBRARY_UPDATE_AVAILABLE_KEY)}</Text>
          </View>
        ) : null}
      </View>

      <View className="gap-space-2">
        <Text className="text-caption text-text-secondary">
          {t(ASSET_LIBRARY_PURCHASED_VERSION_KEY, { version: right.purchasedVersionLabel })}
        </Text>
        <Text className="text-caption text-text-secondary">
          {t(ASSET_LIBRARY_AVAILABLE_VERSION_KEY, { version: right.availableVersionLabel })}
        </Text>
      </View>

      <View className="gap-space-8">
        <Text className="text-captionBold text-text" accessibilityRole="header">
          {t(ASSET_LIBRARY_FILES_TITLE_KEY)}
        </Text>

        {downloadsAuthorized ? null : (
          <Text className="text-caption text-text-tertiary">
            {/* The status reads as a TERM inside this frame, which is the
                appositive case check F measured as correct — a badge is not an
                action control's label. */}
            {t(ASSET_LIBRARY_DOWNLOADS_PAUSED_KEY, { status: statusText })}
          </Text>
        )}

        {right.files.map((file) => (
          <View
            key={file.fileId}
            className="flex-row items-center justify-between gap-space-12 border-b border-border-secondary py-space-8"
          >
            <View className="flex-1 gap-space-2">
              {/* The creator's own file name, verbatim. */}
              <Text className="text-bodySmall text-text">{file.fileName}</Text>
              {/*
                The format key and the size, on one line. `format` is a registry
                key (`stl`, `glb`) — an identifier with no localized form, shown
                verbatim for the reason an ISO currency code is, and the reason
                `format` is absent from the i18n guard's `WIRE_ENUM_FIELDS`. The
                SIZE is localized, because a number is not an identifier.
              */}
              <Text className="text-caption text-text-tertiary">
                {file.format} · {formatByteSize(file.byteSize, locale)}
              </Text>
            </View>

            {/*
              `downloadable` is the FILE's own answer and is independent of the
              right's status: a `preview_only` derivative is streamed and no grant
              will ever hand it over (ADR 0010; `ASSET_FILE_VISIBILITIES`), so it
              is listed — a buyer should see what the package contains — and says
              why it has no button.
            */}
            {!file.downloadable ? (
              <Text className="text-caption text-text-tertiary">
                {t(ASSET_LIBRARY_NOT_DOWNLOADABLE_KEY)}
              </Text>
            ) : downloadsAuthorized && onDownload !== undefined ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t(ASSET_LIBRARY_DOWNLOAD_A11Y_KEY, { file: file.fileName })}
                onPress={() => onDownload(file.fileId)}
                className="rounded-radius-max border border-border-secondary px-space-12 py-space-6"
              >
                <Text className="text-buttonSmall text-text">
                  {t(ASSET_LIBRARY_DOWNLOAD_ACTION_KEY)}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}
