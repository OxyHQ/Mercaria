/**
 * Every interactive control in the authoring surface has an accessible name.
 *
 * Epic #367 line 1080 asks that accessibility tests pass. Measured before this
 * landed: **128 client files across `frontend`, `dashboard`, `pos` and `ui`
 * declare `accessibilityLabel`, and the only test in the repository that
 * asserts one is `merchant-page-isolation.test.ts`**, which names three
 * storefront files by hand for #73's acceptance criterion 7. The authoring
 * surface — the wizard a merchant actually creates a product in — was covered
 * by nothing.
 *
 * ## What this does NOT cover, and why that half is not a wiring gap
 *
 * Focus order, focus management on a dialog, keyboard operability and
 * screen-reader traversal are **not asserted here and cannot be**. That is a
 * measured decision recorded in `packages/frontend/vitest.config.ts` under
 * #469, not an omission: importing the simplest component in the storefront
 * fails at `react-native/index.js` with `Parse failure: Expected 'from', got
 * 'typeOf'` — React Native ships Flow source Rollup does not parse — and every
 * component in all three apps reaches `react-native` directly or through
 * `@mercaria/ui`, `@oxyhq/bloom` or `expo-router`. Clearing it means aliasing
 * to `react-native-web`, adding a Flow-stripping transform and reproducing
 * Metro's platform-extension resolution inside vitest, producing a THIRD module
 * graph that is neither the native build nor the Workers build. That config's
 * own words for the result: *"a check that passes while measuring something
 * production does not run."*
 *
 * `react-test-renderer` in `packages/frontend/package.json` is not a latent
 * capability either — the same file records it as imported by nothing and
 * pinned at 19.1.0 against React 19.2.3, template scaffolding rather than a
 * chosen shape.
 *
 * So that config's closing sentence — *"Layout, styling and accessibility …
 * remain covered by the scanning gates and by review, and that gap is stated
 * rather than closed"* — is what this file half-closes. `validate:rtl-classes`
 * and `validate:bidi-isolation` already cover direction and bidi in CI. Label
 * PRESENCE was covered by nothing. It is now.
 *
 * **This does not tick line 1080.** That line is eight test families, and
 * accessibility's interaction half stays declined with measurement.
 *
 * ## What counts as an interactive control, and what does not
 *
 * {@link CONTROL_ELEMENTS} is the vocabulary, and it is deliberately mixed:
 * five members the surface uses today (`Pressable`, `Button`, `Input`,
 * `Textarea`, `Switch`) and three with zero current instances
 * (`TouchableOpacity`, `TouchableHighlight`, `TextInput`) that are the React
 * Native primitives an author reaches for next. A vocabulary arm with no
 * instance is an arm nothing exercises, so the self-test drives **every one of
 * the eight** rather than trusting the tuple.
 *
 * Deliberately OUT, each for a reason rather than by oversight:
 *
 * - **`Dialog` / `DialogContent`** — a container. Its name is not what a
 *   listener needs; the controls inside it are, and those are matched on their
 *   own. Its dismissal affordance belongs to Bloom, outside this surface.
 * - **`ScrollView`** — scrollable, not a control that announces a name.
 * - **Every icon component** (`X`, `Check`, `Plus`, `ChevronRight`, …) — an
 *   icon is a CHILD. The name belongs to the control wrapping it, which is
 *   exactly the case this gate exists to catch.
 * - **`Label`** — it renders the visible text; it is not the control.
 *
 * ## The rule, and why it is a disjunction rather than "declare a label"
 *
 * A control has an accessible name if it declares a non-empty
 * `accessibilityLabel` (or `aria-label`) **or** renders text among its
 * children. Both branches are load-bearing, and dropping the second would make
 * this gate actively wrong.
 *
 * `@mercaria/ui`'s `Button` renders `children` inside a `Pressable` carrying
 * `role="button"` (`packages/ui/src/components/ui/button.tsx`), so
 * `<Button><Text>Publish</Text></Button>` is named by its own text. Requiring a
 * label there would fail **sixteen** correct controls and be fixed by adding
 * sixteen redundant labels — a screen reader announcing the sentence twice.
 *
 * The defect the disjunction leaves reachable is the real one: an icon-only
 * control, which renders no text and announces nothing.
 *
 * Measured on the tree this landed against: 62 controls, of which 29 are named
 * by a label alone, 16 by text alone, 17 by both, and **0 by neither**. So this
 * gate is green on arrival by design — it pins a property that holds today and
 * fails the day somebody adds an unlabelled icon button, which is what a gate
 * is for. The floors below are what stop "green" and "measured nothing" reading
 * the same.
 *
 * ## Limits, stated rather than implied
 *
 * A label arriving through a spread (`{...props}`) is invisible to a text scan
 * and would read as missing; no control in this surface does that today. A
 * label bound to an expression is accepted without evaluating it, so
 * `accessibilityLabel={maybeUndefined}` passes. And this asserts a name EXISTS,
 * never that it is good copy — `merchant-page-isolation.test.ts` goes one step
 * further for its three files by requiring the key resolve in the locale
 * bundle, which matters because i18n `missingBehavior: 'guess'` renders a
 * missing key to a screen reader as a humanised spelling of the key itself.
 * Doing that here needs a key→bundle resolution over a surface whose labels are
 * frequently derived from schema text rather than from `t()`, and it is left
 * out rather than half-applied.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The two directories that ARE the authoring surface, walked rather than
 * listed. A component added to either is in the population automatically —
 * a hand-maintained list of files-to-check is the defect this shape avoids,
 * because a new unlabelled control would join it by not being written down.
 */
const SURFACE_DIRECTORIES = [
  new URL('../../../components/catalog-authoring', import.meta.url).pathname,
  new URL('../../../app/(app)/products/wizard', import.meta.url).pathname,
] as const;

/** @see the docblock — five kinds in use, three declared as a forward guard. */
const CONTROL_ELEMENTS = [
  'Pressable',
  'TouchableOpacity',
  'TouchableHighlight',
  'TextInput',
  'Button',
  'Input',
  'Textarea',
  'Switch',
] as const;

const OPENING_TAG = new RegExp(`<(${CONTROL_ELEMENTS.join('|')})(?=[\\s/>])`, 'gu');

interface Control {
  readonly file: string;
  readonly line: number;
  readonly element: string;
  readonly tag: string;
  readonly children: string;
}

/**
 * Comments are stripped because this surface DISCUSSES its own controls, and
 * a commented-out `<Pressable>` is not a control anybody can press.
 *
 * A block comment is replaced by its OWN newlines rather than removed, so every
 * offset after it still lands on the line it came from. Deleting them shifts
 * every later line up — measured here, a mutation on line 109 of `SchemaField`
 * was reported at line 94, which sends whoever reads the failure to the wrong
 * control. A gate whose message points somewhere else is a gate people learn to
 * distrust.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, (block) => '\n'.repeat((block.match(/\n/gu) ?? []).length))
    .replace(/^([ \t]*)\/\/.*$/gmu, '$1');
}

function tsxFilesIn(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__') out.push(...tsxFilesIn(full));
      continue;
    }
    if (entry.endsWith('.tsx')) out.push(full);
  }
  return out.sort();
}

/**
 * The index of the `>` closing an opening tag, tracking brace depth so that a
 * `>` inside an embedded expression — `onPress={() => x > 1 ? a : b}`, an arrow
 * function, a generic — does not end the tag early. Getting this wrong reads a
 * truncated tag and reports a labelled control as unlabelled.
 */
function openingTagEnd(code: string, from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i += 1) {
    const c = code[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (depth === 0 && c === '>') return i;
  }
  return code.length - 1;
}

/** The children source of `<name …>…</name>`, or `''` when self-closing. */
function childrenOf(code: string, name: string, tagEnd: number): string {
  if (code[tagEnd - 1] === '/') return '';
  const close = `</${name}>`;
  const opener = new RegExp(`<${name}(?=[\\s/>])`, 'gu');
  const start = tagEnd + 1;
  let depth = 1;
  let i = start;
  while (i < code.length) {
    if (code.startsWith(close, i)) {
      depth -= 1;
      if (depth === 0) return code.slice(start, i);
      i += close.length;
      continue;
    }
    opener.lastIndex = i;
    const nested = opener.exec(code);
    if (nested?.index === i) {
      const end = openingTagEnd(code, nested.index + nested[0].length);
      if (code[end - 1] !== '/') depth += 1;
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return code.slice(start);
}

/** Every control occurrence in one file's source. Exported shape is the test's. */
function controlsIn(file: string, source: string): Control[] {
  const code = stripComments(source);
  const found: Control[] = [];
  OPENING_TAG.lastIndex = 0;
  let match = OPENING_TAG.exec(code);
  while (match !== null) {
    const element = match[1];
    const end = openingTagEnd(code, match.index + match[0].length);
    found.push({
      file,
      line: code.slice(0, match.index).split('\n').length,
      element,
      tag: code.slice(match.index, end + 1),
      children: childrenOf(code, element, end),
    });
    OPENING_TAG.lastIndex = end + 1;
    match = OPENING_TAG.exec(code);
  }
  return found;
}

/** A declared label that is not the empty string. */
function declaresLabel(tag: string): boolean {
  if (/(?:accessibilityLabel|aria-label)\s*=\s*(?:""|''|\{\s*(?:""|''|``)\s*\})/u.test(tag)) {
    return false;
  }
  return /(?:accessibilityLabel|aria-label)\s*=/u.test(tag);
}

/** Text among the children: a `<Text>` element, or a bare non-whitespace string. */
function rendersText(children: string): boolean {
  if (/<Text(?=[\s/>])/u.test(children)) return true;
  return /(^|>)\s*[^<>{}\s][^<>{}]*(?=<|$)/u.test(children);
}

function everyControl(): Control[] {
  return SURFACE_DIRECTORIES.flatMap((directory) =>
    tsxFilesIn(directory).flatMap((file) => controlsIn(file, readFileSync(file, 'utf8'))),
  );
}

function shortPath(file: string): string {
  const at = file.indexOf('/packages/dashboard/');
  return at === -1 ? file : file.slice(at + '/packages/dashboard/'.length);
}

describe('the authoring surface traverses a real population', () => {
  it('finds files in BOTH surface directories', () => {
    // One broken path resolves to an empty directory, halves the population and
    // still clears a total floor. Each half is asserted on its own.
    for (const directory of SURFACE_DIRECTORIES) {
      const files = tsxFilesIn(directory);
      expect(files.length, `${directory} contributed no .tsx files`).toBeGreaterThan(0);
    }
  });

  it('traverses at least as many files as the surface had when this landed', () => {
    const files = SURFACE_DIRECTORIES.flatMap((directory) => tsxFilesIn(directory));
    // 14 on the tree this landed against. A floor, not a pin: components get
    // added. It fires if a glob breaks or the surface is moved out from under
    // this file, which are the two ways "clean" and "nothing examined" converge.
    expect(files.length, `only ${String(files.length)} .tsx files traversed`).toBeGreaterThanOrEqual(
      14,
    );
  });

  it('finds controls, and finds each kind the surface actually uses', () => {
    const controls = everyControl();
    // 62 when this landed. A tag regex that stopped matching finds zero and
    // reports zero failures, which is the shape of a gate measuring nothing.
    expect(controls.length, `only ${String(controls.length)} controls found`).toBeGreaterThanOrEqual(
      55,
    );
    // And per kind, so losing ONE arm of the alternation cannot hide behind the
    // total. Only the kinds in use are floored; the other three are guards with
    // no instances, and are driven in the self-test instead.
    for (const element of ['Pressable', 'Button', 'Input', 'Textarea', 'Switch']) {
      expect(
        controls.filter((control) => control.element === element).length,
        `no <${element}> found anywhere in the authoring surface — the tag pattern lost an arm`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('every interactive control in the authoring surface has an accessible name', () => {
  it('declares accessibilityLabel, or renders text', () => {
    const unnamed = everyControl().filter(
      (control) => !declaresLabel(control.tag) && !rendersText(control.children),
    );
    expect(
      unnamed.map(
        (control) =>
          `no accessibilityLabel and no text child on <${control.element}> at ` +
          `${shortPath(control.file)}:${String(control.line)}`,
      ),
      'an unnamed control announces nothing to a screen reader; give it an ' +
        '`accessibilityLabel`, or render its name as text inside it',
    ).toEqual([]);
  });
});

describe('the detector, driven (self-test)', () => {
  it('reports an icon-only control of EVERY kind in the vocabulary', () => {
    // Eight arms, eight cases. Three of them have no instance in the surface,
    // so this is the only thing that proves those arms work at all.
    for (const element of CONTROL_ELEMENTS) {
      const selfClosing = controlsIn('x.tsx', `<${element} onPress={go} />`);
      expect(selfClosing.length, `<${element} />` + ' was not matched').toBe(1);
      expect(
        declaresLabel(selfClosing[0].tag) || rendersText(selfClosing[0].children),
        `a self-closing <${element}> with no label read as named`,
      ).toBe(false);

      const iconOnly = controlsIn('x.tsx', `<${element} onPress={go}><X /></${element}>`);
      expect(iconOnly.length, `<${element}>…</${element}> was not matched`).toBe(1);
      expect(
        declaresLabel(iconOnly[0].tag) || rendersText(iconOnly[0].children),
        `an icon-only <${element}> read as named`,
      ).toBe(false);
    }
  });

  it('does NOT report a control named by its text child', () => {
    // The false-positive direction, and the reason the rule is a disjunction.
    // Without this case the gate demands sixteen redundant labels on correct
    // `<Button>`s, and the "fix" makes a screen reader say the word twice.
    const [button] = controlsIn('x.tsx', '<Button onPress={go}><Text>Publish</Text></Button>');
    expect(rendersText(button.children), 'a <Text> child did not read as a name').toBe(true);

    const [bare] = controlsIn('x.tsx', '<Button onPress={go}>Publish</Button>');
    expect(rendersText(bare.children), 'a bare string child did not read as a name').toBe(true);
  });

  it('treats an EMPTY label as no label', () => {
    for (const empty of ['accessibilityLabel=""', 'accessibilityLabel={""}', "aria-label=''"]) {
      const [control] = controlsIn('x.tsx', `<Pressable ${empty} />`);
      expect(declaresLabel(control.tag), `${empty} read as a name`).toBe(false);
    }
    const [labelled] = controlsIn('x.tsx', '<Pressable accessibilityLabel={t("a.b")} />');
    expect(declaresLabel(labelled.tag), 'a real label did not read as one').toBe(true);
  });

  it('does not end an opening tag on a `>` inside an embedded expression', () => {
    // `count > 0` inside a prop is the case that truncates a tag and turns a
    // labelled control into a reported failure.
    const [control] = controlsIn(
      'x.tsx',
      '<Pressable disabled={count > 0} accessibilityLabel={label}><X /></Pressable>',
    );
    expect(control.tag, 'the tag was truncated at a `>` inside braces').toContain(
      'accessibilityLabel',
    );
    expect(declaresLabel(control.tag)).toBe(true);
  });

  it('matches nested controls of the same name to their own children', () => {
    const controls = controlsIn(
      'x.tsx',
      '<Pressable accessibilityLabel={a}><Pressable onPress={b}><X /></Pressable></Pressable>',
    );
    expect(controls.length, 'a nested control of the same name was lost').toBe(2);
    expect(declaresLabel(controls[0].tag)).toBe(true);
    // The inner one is the unnamed one, and the outer one's children must not
    // launder it — a naive close-tag search attributes the inner text outward.
    expect(
      declaresLabel(controls[1].tag) || rendersText(controls[1].children),
      'the nested unnamed control read as named',
    ).toBe(false);
  });

  it('matches an element name WHOLE, not as a prefix of a longer one', () => {
    // What the `(?=[\\s/>])` boundary is actually for: a component whose name
    // BEGINS with a control's. `<ButtonRow>` and `<InputGroup>` are layout, and
    // reading them as controls demands labels on wrappers that announce
    // nothing. The count floor cannot see this — it is a LOWER bound, and this
    // failure inflates.
    //
    // Driven: removing the boundary lookahead turns this case red. The
    // neighbouring `<Text>`/`<Label>` case does NOT test the lookahead and is
    // not claimed to — no control name is a prefix of `Text`, so those pass on
    // the tuple's contents instead. Measured: dropping the lookahead left them
    // green.
    for (const wrapper of ['<ButtonRow>x</ButtonRow>', '<InputGroup>x</InputGroup>', '<SwitchRail />']) {
      expect(controlsIn('x.tsx', wrapper).length, `${wrapper} read as a control`).toBe(0);
    }
    // The same names, whole, still match — so this is not passing by the
    // pattern having stopped working altogether.
    expect(controlsIn('x.tsx', '<Button>x</Button>').length).toBe(1);
    expect(controlsIn('x.tsx', '<Input />').length).toBe(1);
    expect(controlsIn('x.tsx', '<Switch />').length).toBe(1);
  });

  it('does not read a NON-control element as a control', () => {
    // `<Text>` is the commonest element in this surface (104 of them) and
    // `<Label>` renders the visible text; neither is a thing a listener
    // operates. This pins the TUPLE's contents, not the boundary above.
    for (const notAControl of ['<Text>x</Text>', '<Label>x</Label>', '<View />']) {
      expect(controlsIn('x.tsx', notAControl).length, `${notAControl} read as a control`).toBe(0);
    }
    // …while the two control names that happen to START with `Text` do match.
    expect(controlsIn('x.tsx', '<TextInput />').length).toBe(1);
    expect(controlsIn('x.tsx', '<Textarea />').length).toBe(1);
  });

  it('reports the line the control is really on, comments included', () => {
    // The failure message is the whole product of a source gate, and a line
    // number that drifts is worse than none: it points at a DIFFERENT control,
    // which reads as the gate being wrong rather than the code. Found by the
    // mutation run for this file — a control on line 109 was reported at 94.
    const source = ['/**', ' * four', ' * line', ' */', '<Pressable onPress={go} />'].join('\n');
    const [control] = controlsIn('x.tsx', source);
    expect(control.line, 'the line number drifted past a block comment').toBe(5);

    const afterLineComment = ['// one', '// two', '<Pressable onPress={go} />'].join('\n');
    expect(controlsIn('x.tsx', afterLineComment)[0].line).toBe(3);
  });

  it('ignores a control that is only mentioned in a comment', () => {
    expect(controlsIn('x.tsx', '// <Pressable onPress={go} />\n').length).toBe(0);
    expect(controlsIn('x.tsx', '/* <Pressable onPress={go} /> */\n').length).toBe(0);
    // …and the same text uncommented IS found, so the strip is not just eating
    // everything.
    expect(controlsIn('x.tsx', '<Pressable onPress={go} />\n').length).toBe(1);
  });
});
