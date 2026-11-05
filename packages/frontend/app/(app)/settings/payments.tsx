import { createSettingsRoute } from '@/components/settings/SettingsRoute';

// Settings is a dialog; this address opens it (see `SettingsRoute`). It is also
// where Peable's hosted seller onboarding returns a P2P seller to.
export default createSettingsRoute('payments');
