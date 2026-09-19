/**
 * One open draft, its autosave, its concurrency and its publish.
 *
 * ## Autosave, and why the timer is the one effect here
 *
 * Everything else in this hook is derived — `dirty` is a comparison of two
 * signatures, completeness is a function of the form, the findings are a
 * function of the last validation. The debounce is not: it synchronises local
 * state with a server on a clock, which is what an effect is for. It is keyed
 * on the FORM, so every keystroke restarts the wait and a burst of typing costs
 * one request.
 *
 * ## What a save takes back, and what it does not
 *
 * A successful save takes the server's `version` — the compare-and-swap token —
 * and NOTHING else. Applying the server's echo of the draft would move the
 * cursor of anybody typing while a save is in flight, and the two copies agree
 * by construction anyway: the server stored what this state sent.
 *
 * ## A conflict stops the clock
 *
 * A 409 means the draft moved under this session: another device saved it, or
 * it was published, or it was discarded. Autosave STOPS — retrying would either
 * lose whatever the other device wrote or hammer a draft that cannot be written
 * at all — and the author is offered the one remedy that is safe, which is to
 * re-read. Their own edits stay on screen until they choose, so nothing is
 * thrown away by the machine.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import { nanoid } from "nanoid/non-secure";
import type {
  AuthoringDraft,
  AuthoringSchema,
  AuthoringValidationResult,
} from "@mercaria/shared-types";
import type { DraftPublishOutcome } from "./api";
import {
  usePublishProductDraft,
  useSaveProductDraft,
  useValidateProductDraft,
} from "./hooks";
import { composePatch, formSignature, hydrateForm, type WizardFormState } from "./wizard-state";
import { locateFindings, type LocatedFinding } from "./findings";

/** How long the wizard waits after the last keystroke before saving. */
export const AUTOSAVE_DELAY_MS = 1200;

/**
 * What the save indicator says.
 *
 * Six states and not a boolean, because "we have not saved yet" and "we tried
 * and could not" are different things to tell somebody who is about to close
 * the tab.
 */
export type SaveState = "idle" | "unsaved" | "saving" | "saved" | "conflict" | "failed";

export interface DraftWizard {
  readonly form: WizardFormState;
  readonly setForm: (next: WizardFormState | ((current: WizardFormState) => WizardFormState)) => void;
  readonly version: number;
  readonly saveState: SaveState;
  readonly dirty: boolean;
  /** Save now — what "Save and continue" and the publish path both call. */
  readonly saveNow: () => Promise<boolean>;
  readonly validation: AuthoringValidationResult | null;
  readonly findings: readonly LocatedFinding[];
  readonly validate: () => Promise<void>;
  readonly isValidating: boolean;
  readonly publish: () => Promise<DraftPublishOutcome | null>;
  readonly isPublishing: boolean;
  /** True once the draft has moved out of `open` under this session. */
  readonly conflicted: boolean;
}

export function useDraftWizard(params: {
  storeId: string;
  draftId: string;
  draft: AuthoringDraft;
  schema: AuthoringSchema;
  canEdit: boolean;
}): DraftWizard {
  const { storeId, draftId, draft, schema, canEdit } = params;

  const [form, setForm] = useState<WizardFormState>(() => hydrateForm(draft, schema));
  const [version, setVersion] = useState<number>(draft.version);
  const [savedSignature, setSavedSignature] = useState<string>(() =>
    formSignature(hydrateForm(draft, schema), schema, draft.version),
  );
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [validation, setValidation] = useState<AuthoringValidationResult | null>(null);

  /**
   * One key for the life of this wizard session.
   *
   * A retry after a timeout has to converge on the listing the first attempt
   * may already have created, so the key cannot be minted per request. It is
   * `nanoid/non-secure` because this is a collision-avoidance token between one
   * client's own retries, not a credential — the server scopes its uniqueness
   * per STORE anyway, so two merchants generating the same string do not
   * collide.
   */
  const [idempotencyKey] = useState<string>(() => nanoid());

  const saveDraft = useSaveProductDraft(storeId, draftId);
  const validateDraft = useValidateProductDraft(storeId, draftId);
  const publishDraft = usePublishProductDraft(storeId, draftId);

  const signature = useMemo(
    () => formSignature(form, schema, version),
    [form, schema, version],
  );
  const dirty = signature !== savedSignature;
  const conflicted = saveState === "conflict";

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (!canEdit || conflicted) return false;
    setSaveState("saving");
    try {
      const outcome = await saveDraft.mutateAsync(composePatch(form, schema, version));
      if (outcome.outcome === "conflict") {
        setSaveState("conflict");
        return false;
      }
      setVersion(outcome.draft.version);
      setSavedSignature(formSignature(form, schema, outcome.draft.version));
      setSaveState("saved");
      return true;
    } catch {
      // A transport failure. The local state is untouched and the debounce does
      // NOT re-fire — it is keyed on the form's content, which has not changed —
      // so this state persists until the author edits again or presses retry.
      // That is deliberate: a timer that kept retrying a failing request would
      // hammer an outage, and the author would have no way to tell a slow save
      // from a broken one.
      setSaveState("failed");
      return false;
    }
  }, [canEdit, conflicted, form, saveDraft, schema, version]);

  /**
   * The latest `saveNow`, held so the debounce can call it without listing it
   * as a dependency — a new closure every render would restart the timer every
   * render rather than every edit, and the wait would never elapse.
   *
   * Assigned in an effect and read only inside another effect's callback. Never
   * in a memoized position: the React Compiler is free to skip a `useMemo` body
   * that reads external mutable state, which is how a stale closure becomes a
   * save of somebody's previous keystroke.
   */
  const saveNowRef = useRef(saveNow);
  useEffect(() => {
    saveNowRef.current = saveNow;
  }, [saveNow]);

  // The debounce, restarted whenever the form's CONTENT changes, so a burst of
  // typing costs one request and the timer never fires mid-word.
  useEffect(() => {
    if (!dirty || !canEdit || conflicted) return;
    const timer = setTimeout(() => {
      void saveNowRef.current();
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [dirty, canEdit, conflicted, signature]);

  /**
   * The latest `dirty`, for the unmount flush below.
   *
   * The `saveNowRef` rule, for the same reason: assigned in an effect and read
   * only inside another effect's callback, never in a memoized position, so the
   * React Compiler cannot skip the body that reads it.
   */
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  /**
   * Save what is pending when the wizard goes away.
   *
   * `beforeunload` above covers a browser unload and nothing else. An IN-APP
   * navigation — back to the product list, or a back gesture on native — unmounts
   * this hook without any such event, and the debounce effect's cleanup then runs
   * `clearTimeout`, so up to `AUTOSAVE_DELAY_MS` of typing is discarded with no
   * warning and no request. There is no navigation guard anywhere in this
   * repository to lean on instead.
   *
   * ## Why this is its OWN effect, and why the dependency array is empty
   *
   * The obvious fix — flush in the debounce's cleanup instead of clearing —
   * is wrong and expensive. That effect lists `signature`, which changes on every
   * content change, so its cleanup runs on every keystroke and the `clearTimeout`
   * there IS the debounce. Saving from it would send one request per character.
   *
   * An effect with an EMPTY dependency array never re-runs, so its cleanup is an
   * unmount and nothing else. That is the distinction a single effect cannot make.
   *
   * Both values are read through refs because an empty array closes over the
   * FIRST render, where `dirty` is false by construction — `savedSignature` is
   * seeded from the same hydration `form` is. `saveNow` already refuses when
   * `canEdit` is false or the draft is `conflicted`, and `saveNowRef` holds the
   * latest closure, so this adds a dirtiness guard and no second copy of that
   * rule.
   *
   * The request outlives the component deliberately: nothing passes an
   * `AbortSignal` — React Query does not give mutations one and `apiClient` wires
   * none — so the save completes and only its `setState` calls are discarded,
   * which is the half that no longer matters.
   */
  useEffect(
    () => () => {
      if (dirtyRef.current) void saveNowRef.current();
    },
    [],
  );

  /**
   * What the indicator says, DERIVED rather than stored.
   *
   * `unsaved` is not a state anything writes: it is exactly "the form differs
   * from what was saved", which `dirty` already is. Writing it would make two
   * representations of one fact, and the case they disagree in is the one that
   * matters — an author who types while a save is in flight gets "Saved" the
   * moment that save lands, with their newest keystroke still unsent.
   *
   * The three states that OUTRANK it are the ones with their own remedy: a save
   * in flight, a failure to retry, and a conflict to re-read.
   */
  const displayedSaveState: SaveState =
    dirty && saveState !== "saving" && saveState !== "failed" && saveState !== "conflict"
      ? "unsaved"
      : saveState;

  // The browser's own "are you sure" — the only place an unsaved change can be
  // lost without the wizard being told first. Native has no equivalent event and
  // needs none: the app is not unloaded by a back gesture.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Setting `returnValue` is what makes Safari and older Chrome prompt at
      // all; the browser composes the sentence and ignores any string given, so
      // there is nothing here for a translator to own.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const validate = useCallback(async () => {
    // Saved FIRST, always: validation runs against what is stored, so
    // validating a dirty form would report on a draft the author is not looking
    // at — findings against values they already fixed.
    if (dirty && !(await saveNow())) return;
    const result = await validateDraft.mutateAsync();
    setValidation(result);
  }, [dirty, saveNow, validateDraft]);

  const publish = useCallback(async (): Promise<DraftPublishOutcome | null> => {
    if (dirty && !(await saveNow())) return null;
    const outcome = await publishDraft.mutateAsync({ idempotencyKey });
    if (outcome.outcome === "refused") setValidation(outcome.validation);
    return outcome;
  }, [dirty, idempotencyKey, publishDraft, saveNow]);

  const findings = useMemo(
    () => (validation === null ? [] : locateFindings(validation.findings)),
    [validation],
  );

  return {
    form,
    setForm,
    version,
    saveState: displayedSaveState,
    dirty,
    saveNow,
    validation,
    findings,
    validate,
    isValidating: validateDraft.isPending,
    publish,
    isPublishing: publishDraft.isPending,
    conflicted,
  };
}
