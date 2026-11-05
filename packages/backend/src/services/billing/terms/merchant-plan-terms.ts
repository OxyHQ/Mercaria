/**
 * The Mercaria Merchant Plan Terms, by version (#89 production-readiness step 6).
 *
 * A plan version names the terms version a merchant accepts
 * (`merchant_plans.terms_version`), and the acceptance records it. So the text
 * of a version is IMMUTABLE once a plan names it: a change is a NEW entry here,
 * named by a new plan version, accepted afresh — the fee-schedule and plan
 * versioning rule applied to prose. `merchant-plan-terms.test.ts` pins each
 * version's SHA-256, so an edit to a published version fails the build instead
 * of silently rewriting what somebody agreed to.
 *
 * Served as a page at `GET /legal/merchant-plan-terms/:version` (routes/legal.ts)
 * and linked from the dashboard's plan screen before a merchant chooses a plan.
 *
 * DRAFTED BY ENGINEERING on 2026-11-05 at the owner's instruction to make the
 * remaining decisions; the owner and legal must review it. The owner confirmed
 * Oxy Platforms, Inc. as the contracting entity and seller of record. Two
 * facts have NO authoritative source in the repositories and are explicit
 * placeholders the owner must complete: the company's registered address and
 * the governing law / jurisdiction (oxy `docs/products/oxy-one-launch-readiness.md`
 * says only that its incorporation is in progress). Completing them is a NEW
 * version, not an edit of this one. The publish script reports any placeholder
 * the current version still carries (`merchantPlanTermsPlaceholders`), so the
 * gap is visible every time the catalogue is published.
 */

export interface MerchantPlanTermsVersion {
  readonly version: string;
  /** The first day the version can be accepted (ISO date). */
  readonly effectiveOn: string;
  readonly title: string;
  /** Plain text: `## ` headings, `- ` list items, blank-line paragraphs. */
  readonly body: string;
}

const V2026_11_05: MerchantPlanTermsVersion = {
  version: 'merchant-plans-2026-11-05',
  effectiveOn: '2026-11-05',
  title: 'Mercaria Merchant Plan Terms',
  body: `These terms apply when a Mercaria store chooses a paid Mercaria plan (Mercaria Go, Mercaria Creator, Mercaria Plus or Mercaria Ultra). They add to Oxy's Terms of Service (https://oxy.so/transparency/legal), which continue to apply.

"We" means Oxy Platforms, Inc., [REGISTERED ADDRESS — TO BE COMPLETED BY THE OWNER], which is the contracting party and the seller of record for Mercaria plans. "You" means the store and the store owner who accepts these terms.

## 1. What a plan is

A plan adds optional tools to your store, for example automation rules, scheduled exports, advanced analytics, merchandising rules, replenishment planning, competitive price analytics or additional point-of-sale registers. The plan comparison shown before you buy lists exactly what each plan includes and its limits.

Selling on Mercaria does not require a plan. Maintaining your catalogue, receiving and fulfilling orders, issuing refunds, reading your own sales, payout, fee and tax records, exporting your data, member management and account security are free for every store and are never part of a plan.

No plan changes how your listings are found, ranked or displayed in Mercaria search or comparison, buys a verified or official status, changes reviews, reputation or moderation, or changes the marketplace fees your orders pay.

## 2. Prices and taxes

The price is the one shown when you choose the plan, per month or per year, in the currency shown. Yearly billing costs ten times the monthly price.

Prices do not include taxes. Where we are required to collect a tax on a plan, it is shown on the invoice. You are responsible for any tax you must account for yourself, for example under a reverse-charge rule.

## 3. Billing and renewal

You pay in advance for each billing period. Payments are processed by Peable, Oxy's payment platform, with the payment method you provide on Peable's checkout page. Mercaria never receives your card details.

Your plan renews automatically at the end of each period, at the price of the plan version you are on, until you cancel. There is no free trial.

## 4. Changing plan

You can move to another plan or between monthly and yearly billing at any time from your dashboard. The change takes effect immediately. The unused part of your current period is credited and the remaining part of the new period is charged at once on a single invoice. A credit that exceeds the charge is kept on your account and used for your next invoices; it is not paid out.

## 5. Cancelling

You can cancel at any time from your dashboard or the billing portal. The cancellation takes effect at the end of the period you have already paid for, and you keep the plan's tools until then.

## 6. Refunds

Payments are not refundable, including for unused time in a period, except where the law requires a refund or where we decide to issue a credit. Nothing in these terms limits the rights consumer law gives you where it applies.

## 7. Failed payments

If a renewal payment fails, we try again over the following days. Your plan's tools keep working during a grace period of 16 days from the failed payment. If no payment succeeds by then, the plan's tools stop and the subscription ends. Your store, catalogue, orders, refunds, records and data export are not affected at any point.

## 8. Limits

Some tools have limits, for example a number of rules or a number of export runs in each billing period. The limits of each plan are shown in the plan comparison. Allowances measured per billing period start again with each period. When you reach a limit, the tool stops creating new work until the next period or until you free some of the allowance; nothing you already created is deleted.

## 9. When a plan ends

When a plan ends, its tools stop doing new work. Everything you created with them, such as rules, schedules, registers and their history, stays in your store, where you can read and export it for free.

## 10. Price changes and plan versions

The price and contents of the plan version you subscribe to do not change while you stay on it. If we stop offering that version, we will tell you at least 30 days before your subscription would have to move to another version, and you can cancel before then. You move to a new version only when you choose to.

## 11. Changes to these terms

If we change these terms, the new version applies only when you next choose or change a plan and accept it. The version you accepted is recorded with your subscription.

## 12. Governing law

These terms are governed by [GOVERNING LAW AND JURISDICTION — TO BE COMPLETED BY THE OWNER]. Nothing in this section removes protections that the law of the country where you are established gives you and that cannot be excluded by contract.

## 13. Contact

Questions about a plan or an invoice: contact Mercaria support from your dashboard, or write to Oxy Platforms, Inc. at the address above.`,
};

/** Every published version, by its id. Append only. */
export const MERCHANT_PLAN_TERMS: Readonly<Record<string, MerchantPlanTermsVersion>> = {
  [V2026_11_05.version]: V2026_11_05,
};

/** The version new plan versions name. */
export const CURRENT_MERCHANT_PLAN_TERMS_VERSION = V2026_11_05.version;

/** The `[… TO BE COMPLETED …]` placeholders a version still carries. */
export function merchantPlanTermsPlaceholders(terms: MerchantPlanTermsVersion): string[] {
  return [...terms.body.matchAll(/\[[^\]]*TO BE COMPLETED[^\]]*\]/g)].map((match) => match[0]);
}

export function findMerchantPlanTerms(version: string): MerchantPlanTermsVersion | undefined {
  return Object.hasOwn(MERCHANT_PLAN_TERMS, version) ? MERCHANT_PLAN_TERMS[version] : undefined;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
/**
 * The only links a terms text carries, made clickable by exact match — never
 * by a pattern over the text, so nothing a version says can become markup.
 */
const LINKS = ['https://oxy.so/transparency/legal'] as const;
const linkify = (escaped: string) =>
  LINKS.reduce((text, url) => text.split(url).join(`<a href="${url}">${url}</a>`), escaped);

/**
 * The terms as a self-contained HTML page. Every byte of text is escaped before
 * the only markup this adds (headings, paragraphs, lists, https links).
 */
export function renderMerchantPlanTermsHtml(terms: MerchantPlanTermsVersion): string {
  const blocks = terms.body.split(/\n{2,}/).map((block) => {
    if (block.startsWith('## ')) return `<h2>${escapeHtml(block.slice(3))}</h2>`;
    const lines = block.split('\n');
    if (lines.every((line) => line.startsWith('- '))) {
      return `<ul>${lines.map((line) => `<li>${linkify(escapeHtml(line.slice(2)))}</li>`).join('')}</ul>`;
    }
    return `<p>${linkify(escapeHtml(block))}</p>`;
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(terms.title)}</title>
<style>
:root{color-scheme:light dark}
body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:44rem;margin:0 auto;padding:2rem 1rem;background:Canvas;color:CanvasText}
h1{font-size:1.6rem;margin:0 0 .25rem}h2{font-size:1.1rem;margin:2rem 0 .5rem}.meta{opacity:.7;margin:0 0 1.5rem}
a{color:LinkText}
</style>
</head>
<body>
<h1>${escapeHtml(terms.title)}</h1>
<p class="meta">Version ${escapeHtml(terms.version)} · effective ${escapeHtml(terms.effectiveOn)}</p>
${blocks.join('\n')}
</body>
</html>
`;
}
