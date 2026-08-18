#!/usr/bin/env bun

/**
 * Renders the #486 review pack as a page a native Arabic reader can actually
 * work in. Reads `extract-arabic-review.mjs --json`; derives nothing itself.
 *
 * ## Why this exists beside the markdown
 *
 * The markdown copy is the archival, diffable one. It is also close to unusable
 * for the actual job: an Arabic string in a markdown table sits beside a Latin
 * key and a `%{placeholder}`, and the bidi algorithm reorders the neutral
 * characters between them — so the pack asking somebody to check Arabic
 * rendering would itself render Arabic wrongly. Every cell here is its own
 * isolated bidi context with an explicit `dir` — the isolation #429 applied in
 * the app, applied here to the artefact instead.
 *
 * (Phrased to avoid `fix #429`: GitHub reads that as a closing keyword wherever
 * it appears, including in a commit message and a PR body, and #429 is open.)
 *
 * ## The three things it adds over a list
 *
 * Search (1,252 rows), per-row "reviewed" state kept in `localStorage` so the
 * work survives across sittings, and a progress count — because the review is
 * done in sittings by definition and a pack with no place to put a partial
 * answer gets restarted from the top.
 *
 * Usage:  bun scripts/extract-arabic-review.mjs --json \
 *           | bun scripts/build-arabic-review-page.mjs > page.html
 */

const raw = await Bun.stdin.text();
const report = JSON.parse(raw);

const escape = (value) => String(value ?? "")
  .replace(/&/gu, "&amp;")
  .replace(/</gu, "&lt;")
  .replace(/>/gu, "&gt;")
  .replace(/"/gu, "&quot;");

/** Latin-script content: key, file, placeholder, English. Isolated LTR. */
const ltr = (value, cls = "") =>
  `<span class="ltr ${cls}" dir="ltr">${escape(value)}</span>`;

/** Arabic content. Isolated RTL, and sized up — the script needs the room. */
const rtl = (value) => `<span class="ar" dir="rtl">${escape(value)}</span>`;

const forms = (value, render) => typeof value === "string"
  ? render(value)
  : Object.entries(value)
    .map(([category, text]) =>
      `<span class="form"><span class="cat" dir="ltr">${escape(category)}</span>${render(text)}</span>`)
    .join("");

const totals = (name) => report.packages.reduce((n, p) => n + p.groups[name].length, 0);
const allKeys = report.packages.reduce((n, p) => n + p.bundleKeys, 0);

const DOMAIN_TERMS = [
  ["product feed", "خلاصة المنتجات", "موجز / تغذية"],
  ["variant", "متغيّر", "التكوين — the storefront's word for configuration"],
  ["register (the till)", "الصندوق", "نقطة البيع — used for the channel name"],
  ["tender", "طريقة الدفع", "—"],
  ["payouts", "التحويلات المالية", "المدفوعات — collides with payments"],
  ["webhooks", "Webhooks (kept Latin)", "خطافات الويب"],
  ["charge (verb)", "تحصيل", "—"],
  ["combination (wizard)", "تركيبة", "تكوين for a canonical configuration"],
  ["collection", "مجموعة", "—"],
  ["fulfilment", "التنفيذ", "—"],
  ["pickup / collection", "الاستلام", "—"],
  ["override (handover)", "تجاوز", "—"],
];

const RTL_CHOICES = [
  ["Arrow direction is flipped",
    "<code>channels.direction.pull</code> reads <span class=\"ar\" dir=\"rtl\">منصّتك ← Mercaria</span>. "
    + "The bidi algorithm does not mirror arrow glyphs, so inside an RTL run “forward” points left. "
    + "The <span class=\"ar\" dir=\"rtl\">WooCommerce ← الإعدادات</span> breadcrumb does the same.",
    "Does the flipped arrow read as “from Mercaria to your platform”?"],
  ["The joining waw is spaced on both sides",
    "<code>channels.andJoin</code> is <span class=\"ar\" dir=\"rtl\">\" و \"</span>, which is not "
    + "idiomatic — the waw normally attaches to the word after it. It is spaced because the values "
    + "it joins are raw Latin identifiers (#485).",
    "Is the spaced waw the right compromise beside Latin text, or worse than attaching it?"],
  ["Example values stay Latin, following ru and ja",
    "Coupon codes, <code>Acme Supply Co.</code>, URLs and CSV column names stay Latin; names, "
    + "phones and titles are localized. The phone example <code>+971 50 123 4567</code> is an "
    + "arbitrary Gulf pick.",
    "Is +971 the right market to exemplify, and should the company name be localized?"],
];

const SECTIONS = [
  {
    id: "read", group: "complete", tone: "read",
    title: "Needs a native read",
    ask: "Does this say what it means, in Arabic, on this screen?",
    note: "The ordinary case. Grouped by screen, because tone and length depend on where a "
      + "string sits — a column header and a confirmation dialog are not the same register.",
  },
  {
    id: "plural", group: "plural", tone: "stop",
    title: "Plural — do not review, do not supply",
    ask: "Nothing. These are listed so they are not approved.",
    note: "Knowingly wrong for 3–10 and owned by #436. Each writes the singular in BOTH slots "
      + "deliberately: right for 11–99, wrong for 3–10, and no single form is right for both. "
      + "Arabic forms written now could not be shipped — the runtime pluralizer and the parity "
      + "guard have to land together. <strong>missing</strong> names the categories Arabic selects "
      + "that the bundle does not carry.",
  },
  {
    id: "interpolated", group: "interpolated", tone: "care",
    title: "Interpolated — the placeholders must survive",
    ask: "Does it read well, and is every placeholder still present and spelled the same?",
    note: "The failure here is a renamed or dropped placeholder, not wording. Word ORDER around "
      + "them is free, and in Arabic it is usually what needs to change.",
  },
  {
    id: "latin", group: "latinByDesign", tone: "confirm",
    title: "Identical to English by design",
    ask: "Is the policy right — should these stay Latin?",
    note: "Brand names, URLs, coupon codes and example values, following what ru and ja already "
      + "do. These are not misses. Same question as RTL choice 3.",
  },
];

const rows = (entries, group) => entries.map((e) => {
  const extra = group === "plural"
    ? `<td class="meta">${e.missingCategories.map((c) => `<span class="chip">${escape(c)}</span>`).join("")}</td>`
    : group === "interpolated"
      ? `<td class="meta">${e.placeholders.map((p) => `<code>%{${escape(p)}}</code>`).join(" ")}</td>`
      : "";
  const file = e.files[0] ?? "—";
  const more = e.files.length > 1 ? ` +${e.files.length - 1}` : "";
  return `<tr data-search="${escape(`${e.key} ${typeof e.en === "string" ? e.en : Object.values(e.en).join(" ")}`.toLowerCase())}">`
    + `<td class="tick"><input type="checkbox" aria-label="Mark reviewed" data-key="${escape(e.key)}"></td>`
    + `<td class="key">${ltr(e.key, "mono")}<span class="file">${ltr(file + more, "mono")}</span></td>`
    + `<td class="en">${forms(e.en, (t) => ltr(t))}</td>`
    + `<td class="arcell">${forms(e.ar, (t) => rtl(t))}</td>`
    + extra
    + "</tr>";
}).join("");

const sectionHtml = (section) => {
  const perPackage = report.packages.map((p) => {
    const entries = p.groups[section.group];
    if (entries.length === 0) return "";
    const byScreen = new Map();
    for (const entry of entries) {
      const label = entry.screens.length > 0 ? entry.screens.join(", ") : "(unplaced)";
      if (!byScreen.has(label)) byScreen.set(label, []);
      byScreen.get(label).push(entry);
    }
    const screens = [...byScreen].sort((a, b) => a[0].localeCompare(b[0])).map(([screen, list]) => `
      <details class="screen">
        <summary><span class="screen-name">${ltr(screen, "mono")}</span><span class="count">${list.length}</span></summary>
        <div class="scroll">
          <table>
            <thead><tr><th></th><th>key</th><th>English</th><th>Arabic</th>${
              section.group === "plural" ? "<th>missing</th>"
                : section.group === "interpolated" ? "<th>placeholders</th>" : ""
            }</tr></thead>
            <tbody>${rows(list, section.group)}</tbody>
          </table>
        </div>
      </details>`).join("");
    return `<h3 class="pkg">${escape(p.name)} <span class="count">${entries.length}</span></h3>${screens}`;
  }).join("");

  return `
  <section id="${section.id}" class="band band-${section.tone}">
    <div class="band-head">
      <h2>${escape(section.title)}</h2>
      <p class="ask"><strong>You are asked:</strong> ${section.ask}</p>
      <p class="note">${section.note}</p>
    </div>
    ${perPackage}
  </section>`;
};

const html = `<title>Mercaria Arabic Review</title>
<style>
  :root {
    --ground: #F6F7F9;
    --raised: #FFFFFF;
    --ink: #15171C;
    --ink-soft: #565D6B;
    --line: #DFE3EA;
    --accent: #2B4570;
    --accent-soft: #E7ECF5;
    --stop: #8A5320;
    --stop-soft: #F8EEE3;
    --care: #2F6B62;
    --care-soft: #E5F0EE;
    --confirm: #5A4A7A;
    --confirm-soft: #EEEAF4;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --latin: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --arabic: "Noto Naskh Arabic", "Geeza Pro", "Al Bayan", "Segoe UI", Tahoma, "Arial Unicode MS", serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #111318;
      --raised: #181B22;
      --ink: #E7EAF0;
      --ink-soft: #98A0AE;
      --line: #272C36;
      --accent: #90AEE0;
      --accent-soft: #1B2436;
      --stop: #D9A263;
      --stop-soft: #2B2116;
      --care: #7FBFB2;
      --care-soft: #16261F;
      --confirm: #AC9AD4;
      --confirm-soft: #221E30;
    }
  }
  :root[data-theme="dark"] {
    --ground: #111318; --raised: #181B22; --ink: #E7EAF0; --ink-soft: #98A0AE;
    --line: #272C36; --accent: #90AEE0; --accent-soft: #1B2436;
    --stop: #D9A263; --stop-soft: #2B2116; --care: #7FBFB2; --care-soft: #16261F;
    --confirm: #AC9AD4; --confirm-soft: #221E30;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--ground); color: var(--ink);
    font-family: var(--latin); font-size: 15px; line-height: 1.55;
    -webkit-text-size-adjust: 100%;
  }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 0 20px 96px; }

  header.top { border-bottom: 1px solid var(--line); background: var(--raised); }
  .top-inner { max-width: 1180px; margin: 0 auto; padding: 28px 20px 22px; }
  h1 { margin: 0 0 6px; font-size: 27px; letter-spacing: -0.02em; text-wrap: balance; }
  .sub { margin: 0; color: var(--ink-soft); font-size: 13.5px; }
  .sub code { font-family: var(--mono); font-size: 12.5px; }

  .stats { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
  .stat {
    border: 1px solid var(--line); border-radius: 8px; padding: 9px 13px;
    background: var(--ground); min-width: 108px;
  }
  .stat b { display: block; font-size: 19px; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
  .stat span { font-size: 11.5px; color: var(--ink-soft); text-transform: uppercase; letter-spacing: 0.06em; }
  .stat.stop b { color: var(--stop); }

  .tools { position: sticky; top: 0; z-index: 5; background: var(--raised);
    border-bottom: 1px solid var(--line); padding: 10px 0; }
  .tools-inner { max-width: 1180px; margin: 0 auto; padding: 0 20px;
    display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  input[type="search"] {
    flex: 1 1 260px; padding: 8px 12px; border-radius: 7px; font: inherit;
    border: 1px solid var(--line); background: var(--ground); color: var(--ink);
  }
  input[type="search"]:focus-visible, summary:focus-visible, a:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }
  .progress { font-size: 13px; color: var(--ink-soft); font-variant-numeric: tabular-nums; }
  .progress b { color: var(--ink); }

  .callout {
    margin: 26px 0; border: 1px solid var(--line); border-inline-start: 3px solid var(--accent);
    background: var(--raised); border-radius: 8px; padding: 18px 20px;
  }
  .callout h2 { margin: 0 0 10px; font-size: 16px; letter-spacing: -0.01em; }
  .callout ol { margin: 0; padding-inline-start: 20px; }
  .callout li { margin-bottom: 8px; }
  .callout li:last-child { margin-bottom: 0; }

  .band { margin-top: 34px; }
  .band-head { border-radius: 9px; padding: 16px 18px; border: 1px solid var(--line); background: var(--raised); }
  .band h2 { margin: 0 0 6px; font-size: 19px; letter-spacing: -0.015em; }
  .ask { margin: 0 0 8px; font-size: 14px; }
  .note { margin: 0; color: var(--ink-soft); font-size: 13.5px; }
  .band-read .band-head { border-inline-start: 3px solid var(--accent); background: var(--accent-soft); }
  .band-stop .band-head { border-inline-start: 3px solid var(--stop); background: var(--stop-soft); }
  .band-care .band-head { border-inline-start: 3px solid var(--care); background: var(--care-soft); }
  .band-confirm .band-head { border-inline-start: 3px solid var(--confirm); background: var(--confirm-soft); }

  h3.pkg { margin: 22px 0 8px; font-size: 13px; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--ink-soft); }
  .count { font-variant-numeric: tabular-nums; color: var(--ink-soft); font-size: 12.5px;
    border: 1px solid var(--line); border-radius: 20px; padding: 1px 9px; margin-inline-start: 8px; }

  details.screen { border: 1px solid var(--line); border-radius: 8px; background: var(--raised); margin-bottom: 8px; }
  details.screen > summary { cursor: pointer; padding: 11px 15px; display: flex;
    align-items: center; justify-content: space-between; gap: 12px; list-style: none; }
  details.screen > summary::-webkit-details-marker { display: none; }
  details.screen > summary::before { content: "▸"; color: var(--ink-soft); font-size: 12px; }
  details.screen[open] > summary::before { content: "▾"; }
  .screen-name { flex: 1; font-size: 13px; }

  .scroll { overflow-x: auto; border-top: 1px solid var(--line); }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th { text-align: start; font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em;
    color: var(--ink-soft); font-weight: 600; padding: 9px 12px; border-bottom: 1px solid var(--line); }
  td { padding: 11px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  tr.done td { opacity: 0.42; }
  td.tick { width: 30px; }
  td.key { width: 27%; min-width: 200px; }
  td.en { width: 30%; }
  td.arcell { width: 30%; }
  td.meta { white-space: nowrap; }

  /* Every cell is its own bidi context with an explicit direction. Without the
     isolation an Arabic string beside a Latin key reorders at the boundary —
     the exact bug this pack exists to have checked. */
  .ltr { unicode-bidi: isolate; direction: ltr; display: inline-block; }
  .ar {
    unicode-bidi: isolate; direction: rtl; display: inline-block;
    font-family: var(--arabic); font-size: 1.16em; line-height: 1.85;
  }
  .mono { font-family: var(--mono); font-size: 12.5px; }
  .file { display: block; color: var(--ink-soft); margin-top: 3px; }
  .form { display: block; margin-bottom: 4px; }
  .cat { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase;
    letter-spacing: 0.05em; color: var(--ink-soft); margin-inline-end: 7px; }
  .chip { display: inline-block; font-family: var(--mono); font-size: 11px;
    border: 1px solid var(--stop); color: var(--stop); border-radius: 4px;
    padding: 0 6px; margin: 0 4px 4px 0; }
  code { font-family: var(--mono); font-size: 12.5px; background: var(--accent-soft);
    padding: 1px 5px; border-radius: 4px; }

  table.terms { background: var(--raised); border: 1px solid var(--line); border-radius: 8px; }
  table.terms td, table.terms th { padding: 11px 13px; }
  .choice { border: 1px solid var(--line); border-radius: 8px; background: var(--raised);
    padding: 15px 17px; margin-bottom: 10px; }
  .choice h4 { margin: 0 0 7px; font-size: 15px; }
  .choice p { margin: 0 0 9px; color: var(--ink-soft); font-size: 13.5px; }
  .choice .q { margin: 0; color: var(--ink); font-weight: 600; font-size: 13.5px; }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>

<header class="top">
  <div class="top-inner">
    <h1>Arabic review — dashboard and point of sale</h1>
    <p class="sub">Generated from <code>${escape(report.generatedFor)}</code> · ${allKeys} strings ·
      no native speaker has read this copy yet</p>
    <div class="stats">
      <div class="stat"><b>${totals("complete")}</b><span>native read</span></div>
      <div class="stat stop"><b>${totals("plural")}</b><span>do not touch</span></div>
      <div class="stat"><b>${totals("interpolated")}</b><span>interpolated</span></div>
      <div class="stat"><b>${totals("latinByDesign")}</b><span>confirm policy</span></div>
      <div class="stat"><b>12 + 3</b><span>start here</span></div>
    </div>
  </div>
</header>

<div class="tools">
  <div class="tools-inner">
    <input type="search" id="q" placeholder="Filter by key or English text…" aria-label="Filter strings">
    <span class="progress"><b id="done">0</b> marked reviewed · saved in this browser</span>
  </div>
</div>

<div class="wrap">
  <div class="callout">
    <h2>What you are not being asked</h2>
    <ol>
      <li><strong>Not to supply Arabic plural forms.</strong> These bundles carry
        <code>one</code> and <code>other</code>; Arabic selects six categories. The missing forms
        are known, deliberate and owned by #436, which needs a runtime pluralizer and a
        parity-guard change to land together — forms written now could not be shipped.</li>
      <li><strong>Not whether Arabic is ready to ship.</strong> It is not: nothing has rendered on
        a device or in a foregrounded tab (#429 item 2). An approved section here does not mean
        Arabic is done.</li>
      <li><strong>Not the storefront.</strong> This is the merchant dashboard and the point of
        sale only. The storefront and the shared component library were translated separately.</li>
      <li><strong>Not to edit files.</strong> Answers come back as comments; each change is its
        own review.</li>
    </ol>
  </div>

  <section class="band band-read">
    <div class="band-head">
      <h2>Start here — twelve terms and three choices</h2>
      <p class="ask"><strong>You are asked:</strong> is the chosen word right, and is the
        authoring choice right?</p>
      <p class="note">These are the highest-value hour in the pack: specific questions with the
        alternative already considered, each affecting every screen the term appears on.
        “Appearances” counts strings containing that Arabic term, so a high count with a wrong
        word is a wide change.</p>
    </div>
    <h3 class="pkg">The twelve domain terms</h3>
    <div class="scroll">
      <table class="terms">
        <thead><tr><th>term</th><th>chosen</th><th>alternative considered</th><th>appearances</th><th>reachable from</th></tr></thead>
        <tbody>${DOMAIN_TERMS.map(([term, chosen, alternative]) => {
          const hits = report.packages.flatMap((p) => p.groups.domain.filter((d) => d.term === term));
          const screens = [...new Set(hits.flatMap((h) => h.screens))].sort();
          return `<tr><td>${ltr(term)}</td><td>${/[؀-ۿ]/u.test(chosen) ? rtl(chosen) : ltr(chosen)}</td>`
            + `<td>${/[؀-ۿ]/u.test(alternative) ? rtl(alternative) : ltr(alternative)}</td>`
            + `<td style="font-variant-numeric:tabular-nums">${hits.length}</td>`
            + `<td>${screens.slice(0, 4).map((s) => ltr(s, "mono")).join(" ")}`
            + `${screens.length > 4 ? ` <span class="count">+${screens.length - 4}</span>` : ""}</td></tr>`;
        }).join("")}</tbody>
      </table>
    </div>
    <p class="note" style="margin-top:10px">“Reachable from” is not “appears on”: a string in a
      shared component lists every screen that mounts it, which is the useful reading — changing
      it changes all of them.</p>
    <h3 class="pkg">The three RTL authoring choices</h3>
    ${RTL_CHOICES.map(([what, detail, question]) =>
      `<div class="choice"><h4>${escape(what)}</h4><p>${detail}</p><p class="q">${escape(question)}</p></div>`).join("")}
  </section>

  ${SECTIONS.map(sectionHtml).join("")}

  <p class="note" style="margin-top:34px">${totals("compositionOnly")} further strings are in no
    section: they contain no letters outside their placeholders, so there is nothing to translate.</p>
</div>

<script>
  const store = "mercaria-arabic-review-486";
  const saved = new Set(JSON.parse(localStorage.getItem(store) || "[]"));
  const boxes = [...document.querySelectorAll('input[type="checkbox"][data-key]')];
  const done = document.getElementById("done");

  const paint = () => { done.textContent = String(saved.size); };
  for (const box of boxes) {
    if (saved.has(box.dataset.key)) { box.checked = true; box.closest("tr").classList.add("done"); }
    box.addEventListener("change", () => {
      if (box.checked) saved.add(box.dataset.key); else saved.delete(box.dataset.key);
      box.closest("tr").classList.toggle("done", box.checked);
      localStorage.setItem(store, JSON.stringify([...saved]));
      paint();
    });
  }
  paint();

  const q = document.getElementById("q");
  q.addEventListener("input", () => {
    const needle = q.value.trim().toLowerCase();
    for (const row of document.querySelectorAll("tbody tr[data-search]")) {
      row.style.display = !needle || row.dataset.search.includes(needle) ? "" : "none";
    }
    if (needle) for (const d of document.querySelectorAll("details.screen")) d.open = true;
  });
</script>
`;

console.log(html);
