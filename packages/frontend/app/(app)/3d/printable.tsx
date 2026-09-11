import { DigitalBrowseScreen } from '@/components/digital/DigitalBrowseScreen';

/**
 * `/3d/printable` — models prepared for 3D printing (#1015 Workstream 5).
 *
 * Still the `three_d` vertical: "printable" is a materially different DELIVERABLE
 * CONFIGURATION (ADR 0010 D2 — alongside `game-ready`, `rigged` and
 * `source-files`), which is a canonical VARIANT and, on the read side, a
 * refinement the registry expresses. `lib/digital/surfaces.ts` records why this
 * screen therefore names no attribute key of its own.
 *
 * It is a STATIC sibling of `/3d/[slug]`, and expo-router resolves a static
 * segment first — so this address reaches this screen and never the asset page.
 */
export default function PrintableModelsScreen() {
  return <DigitalBrowseScreen surfaceKey="printable" />;
}
