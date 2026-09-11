// src/features/personalization/useReaderPrefs.ts
// The one seam between the reader-preferences screen and `prefsStore`.
//
// ─── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
//
// The screen never imports `prefsStore` directly. It calls this hook, and the
// hook calls whatever `PrefsSource` it was handed — `PrefsSource` below is an
// interface THIS file owns, which `prefsStore` satisfies structurally (same
// four function names, same signatures, no shared base type).
//
// INJECTED, NOT IMPORTED, and the reason is the one `useCatalogueSearch` already
// gives for injecting its pipeline: "so a test or a gallery entry can drive this
// with latency, an injected failure, or a stub, without touching a process-wide
// singleton." Every test in useReaderPrefs.test.ts passes a fake source; none of
// them touches AsyncStorage. The default below is the real store — see
// `UseReaderPrefsOptions.source`.
//
// ─── WHAT THE HOOK GUARANTEES, SO NO SECTION HAS TO ──────────────────────────
//
// NESTED GROUPS ARE SPREAD BEFORE THEY ARE PATCHED, AT TWO LEVELS.
// `SharedPrefs.font` is an object, and `savePrefs({ font: { family } })` would
// drop `customFontUri` — the store replaces a group wholesale rather than
// merging into it. That rule is easy to get right once and easy to forget at
// the fourth call site, so the spread happens in here and a section only ever
// names the field it changed. The same protection is available to Keshav's
// Layout and Prayas's Typography sections if they route their writes through
// this hook.
//
// THE SECOND LEVEL IS FOR ACCESSIBILITY. Hruthik's contract (v1.1 §1) states the
// same rule and notes it "bites twice" for that group: `accessibility` is a
// group, and `text` / `display` / `announce` are groups inside it, so a patch
// naming one field can wipe a sibling at either depth. `write` now expands a
// patch against the current values at both levels — see `expandPatch`.
//
// TWO LEVELS, NOT ARBITRARY DEPTH, and that is the contract's shape rather than
// a limitation worth removing. A general deep merge would also quietly merge a
// value that was meant to replace, which is the harder bug to see.
//
// WRITES ARE OPTIMISTIC AND REVERT ON FAILURE. A settings control that waits on
// a promise before moving feels broken, and prefs are local-first by contract —
// the client stamps `updatedAt` at edit time, offline, before any sync. So the
// value moves immediately and rolls back if the write rejects, with `saveFailed`
// raised for the screen to report. The alternative — awaiting each write — makes
// every tap feel like a network call for data that never leaves the device.
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  DEFAULT_PREFS,
  type LayoutPrefs,
  type ReduceMotion,
  type SharedPrefs,
  type Theme,
} from '@/shared/contracts';

import * as prefsStore from './prefsStore';

import { FONT_SCALE_MULTIPLIER, FONT_SIZE_PT, ZOOM_LEVEL } from './prefsOptions';

// ─── The values, without the plumbing ────────────────────────────────────────

/**
 * Everything on `SharedPrefs` except the identity and sync fields.
 *
 * `id`, `userId`, `updatedAt`, `isDeleted` and `synced` come from
 * `SyncRecordBase` and belong to the store and the sync layer. The screen must
 * never render them and must never write them — `updatedAt` in particular is the
 * LWW resolution key, stamped by whoever performs the write, not by the UI that
 * asked for it. Omitting them here means a section cannot reach one by accident.
 *
 * This is the same Omit `DEFAULT_PREFS` is typed against, so the contract's own
 * defaults are a valid `PrefsValues` with no cast.
 */
export type PrefsValues = Omit<SharedPrefs, 'id' | 'userId' | 'updatedAt' | 'isDeleted' | 'synced'>;

/**
 * A patch naming only the fields that changed, at up to two levels.
 *
 * A caller may hand over a scalar (`{ theme }`), a partial group
 * (`{ font: { family } }`), or a partial group inside a group
 * (`{ accessibility: { display: { boldText: true } } }`). `write` expands
 * whichever it gets against the current values before the store sees it, so no
 * section has to remember either spread.
 *
 * DERIVED FROM `PrefsValues`, never hand-listed — the moment the accessibility
 * contract lands with its `text` / `display` / `announce` sub-blocks, this type
 * follows it with no edit here.
 */
export type PrefsPatchInput = {
  [K in keyof PrefsValues]?: PrefsValues[K] extends object
    ? {
        [S in keyof PrefsValues[K]]?: PrefsValues[K][S] extends object
          ? Partial<PrefsValues[K][S]>
          : PrefsValues[K][S];
      }
    : PrefsValues[K];
};

// Arrays and `null` are values to replace, not groups to merge into. Nothing on
// `SharedPrefs` is either today; the guard is here so that stops being a silent
// assumption the first time one is added.
function isMergeableGroup(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Expands a two-level patch into the WHOLE-GROUP values `savePrefs` expects.
 *
 * Returns only the top-level keys the patch named, each carrying a complete
 * group — which is exactly what the store's replace-wholesale semantics need,
 * and what a caller spreading by hand was producing already. Passing a fully
 * spread group still works and still produces the same payload, so the existing
 * callbacks below are unaffected.
 *
 * A KEY SET TO `undefined` IS SKIPPED RATHER THAN WRITTEN. "Absent" and
 * "present but undefined" collapse to one representation, matching how
 * `searchState.ts` removes optional keys instead of blanking them. To clear an
 * optional field, write the whole group.
 */
function expandPatch(previous: PrefsValues, patch: PrefsPatchInput): Partial<PrefsValues> {
  const expanded: Record<string, unknown> = {};

  for (const [key, incoming] of Object.entries(patch)) {
    if (incoming === undefined) continue;

    const current = (previous as Record<string, unknown>)[key];

    // A scalar such as `theme`, or a group with nothing to merge into.
    if (!isMergeableGroup(incoming) || !isMergeableGroup(current)) {
      expanded[key] = incoming;
      continue;
    }

    const group: Record<string, unknown> = { ...current };
    for (const [subKey, subIncoming] of Object.entries(incoming)) {
      if (subIncoming === undefined) continue;

      const subCurrent = group[subKey];
      group[subKey] =
        isMergeableGroup(subIncoming) && isMergeableGroup(subCurrent)
          ? { ...subCurrent, ...subIncoming }
          : subIncoming;
    }
    expanded[key] = group;
  }

  return expanded as Partial<PrefsValues>;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

// ─── The seam ────────────────────────────────────────────────────────────────

/**
 * What this hook needs from a preferences store. Keshav's `prefsStore` satisfies
 * it structurally — there is no base class to extend and nothing to register.
 */
export interface PrefsSource {
  /** Resolves the current values. Rejects if they cannot be read. */
  getPrefs: () => Promise<PrefsValues>;
  /**
   * Merges a patch. Top-level keys replace wholesale, which is why this hook
   * spreads nested groups before calling — see the header.
   */
  savePrefs: (patch: Partial<PrefsValues>) => Promise<void>;
  /** Back to `DEFAULT_PREFS`. A rewrite plus an `updatedAt` bump, not a delete. */
  resetPrefs: () => Promise<void>;
  /**
   * Notifies on any change, including one this hook did not make — a second
   * device settling LWW, or Keshav's Layout section writing its own group.
   * Returns its own unsubscribe.
   */
  subscribe: (listener: (next: PrefsValues) => void) => () => void;
}

// ─── The hook ────────────────────────────────────────────────────────────────

export interface UseReaderPrefsOptions {
  /**
   * The store to read and write through. Defaults to the real `prefsStore`
   * (AsyncStorage-backed, LWW on `updatedAt`) — pass a fake here only in a
   * test or a gallery entry that needs to drive this with latency, an
   * injected failure, or a stub, without touching real storage.
   */
  source?: PrefsSource;
}

export interface UseReaderPrefs {
  /**
   * Lifecycle. `state`, not `status`, to match the component convention.
   *
   * THERE IS NO 'empty', and it is not an omission (CONVENTIONS §6 — "if a state
   * is impossible, say so"). Prefs are a per-user singleton with `DEFAULT_PREFS`
   * as a floor, so "no preferences yet" cannot occur: a first read either
   * resolves values or fails.
   *
   * THERE IS NO 'offline' EITHER. Offline is not a state of this data. Prefs are
   * written locally and reconciled later by LWW on `updatedAt`, so the screen
   * stays fully usable with no connection — the banner is informational and
   * nothing is disabled behind it. The screen owns that banner via
   * `useNetworkStatus`; this hook has no opinion on connectivity.
   */
  state: 'loading' | 'ready' | 'error';
  /** Null while loading, and after a failed read. Never null at `state: 'ready'`. */
  prefs: PrefsValues | null;
  /** A write is in flight. Controls stay live — see the optimism note in the header. */
  saving: boolean;
  /** The last write rejected and its value was rolled back. Cleared by the next write. */
  saveFailed: boolean;
  onSelectTheme: (theme: Theme) => void;
  /**
   * `string`, not a union, because `FontPrefs.family` is a string in the
   * contract — the reader accepts faces our picker does not list.
   */
  onSelectFontFamily: (family: string) => void;
  onSelectFlow: (flow: LayoutPrefs['flow']) => void;
  onSelectSpread: (spread: LayoutPrefs['spread']) => void;
  /** Clamped to 10–32pt before it is saved. */
  onChangeFontSize: (size: number) => void;
  /** Clamped to 0–4px before it is saved. */
  onChangeLetterSpacing: (spacing: number) => void;
  /** Clamped to 0–64px before it is saved. */
  onChangeMargins: (margins: number) => void;
  /** Clamped to 0.5–3.0 before it is saved. PDF only — see ZoomSection. */
  onChangeZoom: (level: number) => void;
  // ─── Accessibility (Hruthik's contract, FINAL 2026-09-02) ──────────────────
  //
  // ONE CALLBACK PER CONTROL, rather than a single `onChangeAccessibility`
  // taking a path. The four sections above already work this way, a named
  // callback is what CONVENTIONS §3 asks for, and it is what lets each one
  // carry its own guard — only `fontScaleMultiplier` clamps, and only
  // `reduceMotion` has a union to respect.
  //
  // TWELVE, NOT NINETEEN. The seven `accessibility.tts.*` fields are Ahana's,
  // driven from the in-reader TtsControls panel. Nothing here reads or writes
  // them.
  onToggleDyslexiaFont: (enabled: boolean) => void;
  onToggleRespectOsFontScale: (enabled: boolean) => void;
  onToggleReadableSpacing: (enabled: boolean) => void;
  /** Clamped to 0.8–1.5 before it is saved. Stored as a number. */
  onChangeFontScaleMultiplier: (multiplier: number) => void;
  onToggleBoldText: (enabled: boolean) => void;
  onToggleHighContrast: (enabled: boolean) => void;
  onToggleLargeTouchTargets: (enabled: boolean) => void;
  onToggleLargeAudioControls: (enabled: boolean) => void;
  /**
   * Stores the raw tri-state. NEVER coerced to a boolean — 'system' is a
   * distinct answer from 'off' and cannot be recovered once collapsed.
   */
  onSelectReduceMotion: (reduceMotion: ReduceMotion) => void;
  onToggleAnnouncePageChanges: (enabled: boolean) => void;
  onToggleAnnounceChapterChanges: (enabled: boolean) => void;
  onToggleScreenReaderHints: (enabled: boolean) => void;
  onRestoreDefaults: () => void;
  /** Resets only the accessibility group, leaving theme/font/layout/typography alone. */
  onRestoreAccessibilityDefaults: () => void;
  /** Re-reads after a failed read. */
  onRetry: () => void;
}

export function useReaderPrefs({ source }: UseReaderPrefsOptions = {}): UseReaderPrefs {
  // A PLAIN VALUE, NOT A REF. Writing `sourceRef.current` during render is what
  // `react-hooks/refs` flags, and it is a real hazard rather than a lint
  // preference — a ref mutated in render is not part of the render's own output.
  //
  // The consequence is that `source` MUST BE STABLE ACROSS RENDERS. A caller
  // that builds one inline (`source={{ getPrefs: ... }}`) re-subscribes on every
  // render. Every real caller passes a module singleton — the store, or one fake
  // built once per test — so this is a documented requirement, not a trap.
  const activeSource = source ?? prefsStore;

  const [prefs, setPrefs] = useState<PrefsValues | null>(null);
  const [state, setState] = useState<UseReaderPrefs['state']>('loading');
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  // Guards every `setState` in an async continuation. Without it, a read that
  // resolves after the screen is popped warns about updating an unmounted tree.
  const mounted = useRef(true);

  // NO SYNCHRONOUS setState IN HERE — only inside the async continuations, which
  // is why this is separate from `onRetry` below. `react-hooks/set-state-in-effect`
  // rejects a `setState` in an effect body, and the initial 'loading' does not
  // need one: that is already the initial state. Same split, and the same
  // reasoning, as ItemDetailScreen's `fetchItem` versus its `retry`.
  const load = useCallback(() => {
    activeSource
      .getPrefs()
      .then((next) => {
        if (!mounted.current) return;
        setPrefs(next);
        setState('ready');
      })
      .catch(() => {
        if (!mounted.current) return;
        setPrefs(null);
        setState('error');
      });
  }, [activeSource]);

  // The one path that resets to 'loading', and it runs from a press handler
  // rather than an effect — which is what makes the synchronous setState legal
  // here and not above.
  const onRetry = useCallback(() => {
    setState('loading');
    setPrefs(null);
    load();
  }, [load]);

  useEffect(() => {
    mounted.current = true;
    load();

    // Picks up writes this hook did not make: another device settling LWW, or a
    // sibling section writing its own group. Nothing here re-reads — the
    // listener is handed the new values directly.
    const unsubscribe = activeSource.subscribe((next) => {
      if (!mounted.current) return;
      setPrefs(next);
      setState('ready');
    });

    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [activeSource, load]);

  // THE ONE WRITE PATH. Every callback below goes through here, so the optimistic
  // update, the rollback, the `saving` flag AND the nested-group spread are each
  // defined once.
  //
  // `patch` names only what changed, at either level. `expandPatch` fills in the
  // rest from the current values, so what reaches the store is always complete
  // groups — the shape its replace-wholesale semantics require.
  const write = useCallback(
    (patch: PrefsPatchInput) => {
      const previous = prefs;
      if (previous === null) return;

      // Expanded once, BEFORE the optimistic update, so the screen and the store
      // are never shown two different versions of the same write.
      const groups = expandPatch(previous, patch);

      setPrefs({ ...previous, ...groups });
      setSaving(true);
      setSaveFailed(false);

      activeSource
        .savePrefs(groups)
        .then(() => {
          if (!mounted.current) return;
          setSaving(false);
        })
        .catch(() => {
          if (!mounted.current) return;
          // Back to exactly what was on screen before the tap. Reverting to the
          // whole previous object rather than the one field keeps this correct if
          // a second write landed in between.
          setPrefs(previous);
          setSaving(false);
          setSaveFailed(true);
        });
    },
    [activeSource, prefs],
  );

  const onSelectTheme = useCallback(
    (theme: Theme) => {
      // A top-level scalar, so there is no group to spread.
      write({ theme });
    },
    [write],
  );

  const onSelectFontFamily = useCallback(
    (family: string) => {
      if (prefs === null) return;
      // SPREAD FIRST. `font` also carries `customFontUri`, and a patch of
      // `{ font: { family } }` would drop it — the store replaces the group, it
      // does not merge into it.
      write({ font: { ...prefs.font, family } });
    },
    [prefs, write],
  );

  const onSelectFlow = useCallback(
    (flow: LayoutPrefs['flow']) => {
      if (prefs === null) return;
      // SPREAD FIRST — same rule as onSelectFontFamily: `layout` also carries
      // `spread`, and a patch of `{ layout: { flow } }` would drop it.
      write({ layout: { ...prefs.layout, flow } });
    },
    [prefs, write],
  );

  const onSelectSpread = useCallback(
    (spread: LayoutPrefs['spread']) => {
      if (prefs === null) return;
      write({ layout: { ...prefs.layout, spread } });
    },
    [prefs, write],
  );

  // THE RANGES ARE ENFORCED HERE, NOT BY THE STORE. `savePrefs` accepts any
  // number the caller hands it — the Week 3 plan is explicit that the UI is
  // the only guard, so each Typography callback constrains its value before
  // writing rather than trusting the section (or a future caller of this
  // hook) to have done so already. Each slider clamps to its own min/max,
  // because a slider's own `step` already keeps it on the grid.
  const onChangeFontSize = useCallback(
    (size: number) => {
      if (prefs === null) return;
      write({
        typography: { ...prefs.typography, size: clamp(size, FONT_SIZE_PT.min, FONT_SIZE_PT.max) },
      });
    },
    [prefs, write],
  );

  const onChangeLetterSpacing = useCallback(
    (spacing: number) => {
      if (prefs === null) return;
      write({ typography: { ...prefs.typography, spacing: clamp(spacing, 0, 4) } });
    },
    [prefs, write],
  );

  const onChangeMargins = useCallback(
    (margins: number) => {
      if (prefs === null) return;
      write({ typography: { ...prefs.typography, margins: clamp(margins, 0, 64) } });
    },
    [prefs, write],
  );

  // ZOOM IS A ONE-FIELD GROUP, SO NO SPREAD. Unlike font/layout/typography,
  // `ZoomPrefs` has only `level` — there is no sibling field a patch could
  // drop, so this writes the group directly, the same way `onSelectTheme`
  // writes a top-level scalar with nothing to spread.
  const onChangeZoom = useCallback(
    (level: number) => write({ zoom: { level: clamp(level, ZOOM_LEVEL.min, ZOOM_LEVEL.max) } }),
    [write],
  );

  // ─── Accessibility ─────────────────────────────────────────────────────────
  //
  // NO MANUAL SPREADING BELOW, AT EITHER LEVEL, and that is the whole reason
  // `expandPatch` exists. Hruthik's contract warns the top-level-merge rule
  // "bites twice" here: a patch of `{ accessibility: { display: { boldText } } }`
  // would, written straight to the store, wipe the other four `display` fields
  // AND the sibling `text` / `announce` / `tts` groups. Each callback names only
  // the field it owns; `write` reconstructs both levels from current values.
  //
  // These do not guard on `prefs === null` the way the Typography callbacks do:
  // those need `prefs` to read the sibling fields they spread, and these read
  // nothing. `write` already returns early when there is nothing to patch.
  const onToggleDyslexiaFont = useCallback(
    (dyslexiaFont: boolean) => write({ accessibility: { text: { dyslexiaFont } } }),
    [write],
  );

  const onToggleRespectOsFontScale = useCallback(
    (respectOsFontScale: boolean) => write({ accessibility: { text: { respectOsFontScale } } }),
    [write],
  );

  const onToggleReadableSpacing = useCallback(
    (readableSpacing: boolean) => write({ accessibility: { text: { readableSpacing } } }),
    [write],
  );

  // CLAMPED HERE, NOT BY THE SLIDER. The contract types the field as an
  // unbounded number and says so; the slider's own min/max only constrain what a
  // drag can produce, and nothing stops another caller — a test, a future
  // preset button, a restored value from a device with different bounds — from
  // handing over 4.0. Same rule the three Typography sliders already follow.
  const onChangeFontScaleMultiplier = useCallback(
    (fontScaleMultiplier: number) =>
      write({
        accessibility: {
          text: {
            fontScaleMultiplier: clamp(
              fontScaleMultiplier,
              FONT_SCALE_MULTIPLIER.min,
              FONT_SCALE_MULTIPLIER.max,
            ),
          },
        },
      }),
    [write],
  );

  const onToggleBoldText = useCallback(
    (boldText: boolean) => write({ accessibility: { display: { boldText } } }),
    [write],
  );

  const onToggleHighContrast = useCallback(
    (highContrast: boolean) => write({ accessibility: { display: { highContrast } } }),
    [write],
  );

  const onToggleLargeTouchTargets = useCallback(
    (largeTouchTargets: boolean) => write({ accessibility: { display: { largeTouchTargets } } }),
    [write],
  );

  const onToggleLargeAudioControls = useCallback(
    (largeAudioControls: boolean) => write({ accessibility: { display: { largeAudioControls } } }),
    [write],
  );

  // STORED VERBATIM. No clamp, no fallback, no boolean anywhere on this path —
  // `ReduceMotion` is a closed union, so the type is the only guard needed and
  // an invalid value cannot reach here without a cast.
  const onSelectReduceMotion = useCallback(
    (reduceMotion: ReduceMotion) => write({ accessibility: { display: { reduceMotion } } }),
    [write],
  );

  const onToggleAnnouncePageChanges = useCallback(
    (pageChanges: boolean) => write({ accessibility: { announce: { pageChanges } } }),
    [write],
  );

  const onToggleAnnounceChapterChanges = useCallback(
    (chapterChanges: boolean) => write({ accessibility: { announce: { chapterChanges } } }),
    [write],
  );

  // The one accessibility field that is NOT inside a sub-block, so this is a
  // one-level patch like `theme` — `expandPatch` handles both shapes.
  const onToggleScreenReaderHints = useCallback(
    (screenReaderHints: boolean) => write({ accessibility: { screenReaderHints } }),
    [write],
  );

  const onRestoreDefaults = useCallback(() => {
    const previous = prefs;
    if (previous === null) return;

    // NOT eight `savePrefs` calls. `resetPrefs` is one write and therefore one
    // `updatedAt` stamp, which is what LWW compares; eight writes would be eight
    // stamps and a partial reset if one failed.
    setPrefs({ ...DEFAULT_PREFS });
    setSaving(true);
    setSaveFailed(false);

    activeSource
      .resetPrefs()
      .then(() => {
        if (!mounted.current) return;
        setSaving(false);
      })
      .catch(() => {
        if (!mounted.current) return;
        setPrefs(previous);
        setSaving(false);
        setSaveFailed(true);
      });
  }, [activeSource, prefs]);

  // SCOPED TO ACCESSIBILITY ONLY, unlike `onRestoreDefaults` above. That one
  // calls `resetPrefs()` because it means "reset the whole screen", but a
  // caller of this hook that only renders the accessibility group (the
  // Accessibility screen) resetting theme/font/layout/typography alongside it
  // would be surprising — those controls are not on screen to show the
  // reader what just changed. `write` already gives every other callback this
  // group-scoped shape, so reset takes it too rather than inventing a second
  // path to the store.
  const onRestoreAccessibilityDefaults = useCallback(
    () => write({ accessibility: DEFAULT_PREFS.accessibility }),
    [write],
  );

  return {
    state,
    prefs,
    saving,
    saveFailed,
    onSelectTheme,
    onSelectFontFamily,
    onSelectFlow,
    onSelectSpread,
    onChangeFontSize,
    onChangeLetterSpacing,
    onChangeMargins,
    onChangeZoom,
    onToggleDyslexiaFont,
    onToggleRespectOsFontScale,
    onToggleReadableSpacing,
    onChangeFontScaleMultiplier,
    onToggleBoldText,
    onToggleHighContrast,
    onToggleLargeTouchTargets,
    onToggleLargeAudioControls,
    onSelectReduceMotion,
    onToggleAnnouncePageChanges,
    onToggleAnnounceChapterChanges,
    onToggleScreenReaderHints,
    onRestoreDefaults,
    onRestoreAccessibilityDefaults,
    onRetry,
  };
}

export default useReaderPrefs;
