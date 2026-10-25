import { captureReferralFragment, referralCredential } from './stores/referral-credential-store';

if (typeof window !== 'undefined') {
  const capture = () =>
    captureReferralFragment(window.location, window.history, (token, expiry, generation) => {
      referralCredential.snapshot().accept(token, expiry, generation);
    });
  capture();
  window.addEventListener('hashchange', capture);
}
