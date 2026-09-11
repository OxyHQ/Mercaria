import { DigitalBrowseScreen } from '@/components/digital/DigitalBrowseScreen';

/**
 * `/3d/game-assets` — models prepared for engines and real-time rendering
 * (#1015 Workstream 5).
 *
 * The `game_asset` member of `DIGITAL_VERTICALS`, so this surface is gated by its
 * own key in `DIGITAL_ENABLED_VERTICALS` rather than by `three_d`'s — which is
 * what lets one launch without the other.
 */
export default function GameAssetsScreen() {
  return <DigitalBrowseScreen surfaceKey="game_assets" />;
}
