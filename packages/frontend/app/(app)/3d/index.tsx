import { DigitalBrowseScreen } from '@/components/digital/DigitalBrowseScreen';

/**
 * `/3d` — the 3D vertical's landing surface (#1015 Workstream 5).
 *
 * The `three_d` member of `DIGITAL_VERTICALS`, which is the key
 * `DIGITAL_ENABLED_VERTICALS` allow-lists a deployment by. Everything this page
 * shows is `DigitalBrowseScreen`'s, and everything it can be FILTERED by is the
 * attribute registry's — there is no 3D-specific filter list in this tree
 * (#1015 acceptance criterion 18).
 */
export default function ThreeDScreen() {
  return <DigitalBrowseScreen surfaceKey="three_d" />;
}
