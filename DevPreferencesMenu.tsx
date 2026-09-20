// DevPreferencesMenu.tsx — TEMP, same status as src/navigation/BookListScreen.tsx's fixture list
// (see its own header note).
//
// Replaces the earlier inline row of one-shot buttons in App.tsx with a hamburger ("☰") dropdown of
// TOGGLES, so Reader's live `applyAppearance` re-apply path (READER_PREFS_APPLICATION.md §5,
// triggers A/B) can be exercised without a real settings screen. Passed from
// `src/navigation/ReaderRouteScreen.tsx` into ReaderScreen's `toolbarExtra` slot, landing as the
// rightmost icon in ReaderScreen's own toolbar row, alongside Search/TTS. It used to be App.tsx's
// own header row (back when App.tsx mounted ReaderScreen directly), then briefly the Reader
// route's native-stack `headerRight` (clipped by react-native-screens' native header — dropdown
// opened but rendered nothing), then a same-tree absolute overlay (landed on top of and ate touches
// for the toolbar's own icons, since both anchored to the same corner). See `toolbarExtra`'s own
// doc in ReaderScreen.tsx and `ReaderRouteScreen.tsx`'s header note for the full history. Delete
// this file and its render site the moment Personalization (Vaishnavi) ships a real settings
// screen — this is not that screen, and does not preempt her ownership of
// src/features/personalization/.
//
// LIVE, NOT "ON RETURN": while the Reader route is on screen, the menu is an overlay drawn on top
// of the still-mounted ReaderScreen, so a toggle's effect is visible immediately through the SAME
// prefsStore.subscribe() path ReaderScreen already wires up — "apply without leaving the reader"
// falls out for free. Navigating back to BookList and into a different (or the same) book is a
// fresh ReaderScreen instance regardless, same as any other prop-driven remount.
//
// TOGGLE SEMANTICS: re-pressing the ALREADY-ACTIVE option reverts that field to DEFAULT_PREFS,
// rather than leaving it stuck once set — exactly the "click again to undo" behaviour asked for.
// Each patch replaces its whole top-level prefs group (typography/layout/etc.), matching
// PrefsPatch's own "merges at the top level" contract (PREFS_API_FOR_FRONTEND.md's "one rule that
// bites") — a flow toggle spreads the CURRENT layout group and overrides only `flow`, so it cannot
// clobber a `spread` the user already set, and vice versa.
//
// LAYOUT AND ZOOM ARE ALREADY APPLIED BY THE READER — this file adds no new reader-side behaviour.
// `flow`/`spread` (epub.entry.ts's `currentFlow`/`mapSpread`) and `zoom` (pdf.entry.ts's
// `currentZoom`) were part of `applyAppearance` from the first cut of this feature; what was missing
// was a way to CHANGE them without hand-editing SQLite, which is what the two new sections below are
// for. `PREFS_API_FOR_FRONTEND.md` (Personalization, 2026-08-20) is a field catalogue for a real
// settings screen — it documents these fields, it does not introduce them.
//
// ZOOM REMOVED FOR EPUB — NOT FORMAT APPLICABLE. `ReaderAppearance.zoom`'s own doc comment always
// said as much ("a reflowable EPUB scales through fontSizePt instead, so the EPUB renderer may
// ignore this"), and `epub.entry.ts` never reads `appearance.zoom` anywhere — it was already a
// no-op there, just not one the menu admitted to. The Zoom section below is hidden whenever the
// active book's format is `'EPUB'` (ReaderRouteScreen passes it down from the route's own params),
// rather than left visible and inert: a control with nothing to control is worse than no control, the same
// reasoning ReaderScreen already applies to the PDF-only page indicator. `zoom` stays in
// `ReaderAppearance`/the bridge payload regardless — PDF still needs it, and it is one payload for
// both renderers by design (see readerAppearance.ts's own header).
//
// TYPOGRAPHY REMOVED FOR PDF, same reasoning inverted: `pdf.entry.ts` ignores typography entirely
// (it rasterises pages — there is no text CSS to override), so the Typography section is hidden
// whenever the active book's format is `'PDF'`. `fontFamily`/`fontSizePt`/etc. stay in
// `ReaderAppearance` regardless — EPUB still needs them.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Dimensions, Modal, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import type { LayoutChangeEvent, View as RNView } from 'react-native';

import { color, radius, space } from '@theme/tokens';

import {
  READER_CAPTURE_KEY,
  allowScreenCaptureAsync,
  isScreenCaptureAvailable,
  preventScreenCaptureAsync,
} from '@/features/reader/captureProtection';
import { FONT_CATALOG } from '@/features/personalization/fontCatalog';
import { useOverrideDeclined } from '@/features/reader/a11yOverrideChoice';
import { flowOverrideApplied } from '@/features/reader/readerA11yLayout';
import { useScreenReaderEnabled } from '@/features/reader/useScreenReaderEnabled';
import { prefsStore } from '@/features/personalization/prefsStore';
import type { PrefsPatch } from '@/features/personalization/prefsStore';
import { DEFAULT_PREFS } from '@/shared/contracts';
import type { ContentFormat, LayoutPrefs, SharedPrefs, Theme } from '@/shared/contracts';

// Keeps the dropdown's clamped max width off both screen edges — see `toggleOpen`'s `maxWidth`
// computation and `styles.dropdown`'s own note.
const DROPDOWN_EDGE_MARGIN = 12;

const THEME_OPTIONS: readonly { label: string; theme: Theme }[] = [
  { label: 'Light', theme: 'light' },
  { label: 'Dark', theme: 'dark' },
  { label: 'Sepia', theme: 'sepia' },
];

/** Pressing the currently-active theme reverts to `'system'` (DEFAULT_PREFS.theme); pressing a
 * different one switches to it. Never leaves the segmented control able to select nothing. */
function toggleTheme(current: SharedPrefs, theme: Theme): PrefsPatch {
  return { theme: current.theme === theme ? DEFAULT_PREFS.theme : theme };
}

/**
 * `system` plus the 6 bundled fonts `fontCatalog.ts`/`fontFaceLoader.ts` ship — Reader's half of
 * CUSTOM_FONTS_WIRING.md now loads the selected family's bytes and injects them as an `@font-face`
 * (epub.entry.ts), so picking one of these actually changes the open EPUB's font, not just its name.
 */
const FAMILY_OPTIONS: readonly { label: string; family: string }[] = [
  { label: 'System', family: 'system' },
  ...FONT_CATALOG.map((entry) => ({ label: entry.label, family: entry.family as string })),
];

/** Same revert-on-reselect convention as `toggleTheme`. `customFontUri: undefined` clears the
 * separate, unused `FontPrefs.customFontUri` upload field on switch — the reader computes the data
 * URI for whichever family IS selected fresh, at apply time, via `loadFontFaceSrc`; it never reads
 * this stored field, but leaving a stale value here would mislead a future reader of the record. */
function toggleFontFamily(current: SharedPrefs, family: string): PrefsPatch {
  return {
    font: {
      family: current.font.family === family ? DEFAULT_PREFS.font.family : family,
      customFontUri: undefined,
    },
  };
}

const FLOW_OPTIONS: readonly { label: string; flow: LayoutPrefs['flow'] }[] = [
  { label: 'Paginated', flow: 'paginated' },
  { label: 'Scrolled', flow: 'scrolled-doc' },
];

const SPREAD_OPTIONS: readonly { label: string; spread: LayoutPrefs['spread'] }[] = [
  { label: 'Single', spread: 'single' },
  { label: 'Double', spread: 'double' },
];

/**
 * Matches `PDF_SPREAD_MIN_WIDTH` in `webview/src/pdfOutline.ts`, which itself matches epub.js's own
 * `layout.js` `minSpreadWidth` default (see that file's comment, and `WEBVIEW_BRIDGE.md`'s note on
 * `spread`). Duplicated rather than imported — this file is RN, that one is bundled into the
 * WebView, and every other value shared across that boundary in this codebase is duplicated with a
 * cross-referencing comment the same way (e.g. `epub.entry.ts`'s `mapSpread`) rather than factored
 * into a module both sides import.
 *
 * This is ONLY for deciding whether to warn AND revert here, in RN — the WebView is still the one
 * enforcing it against its own live viewport width at render time (`epub.entry.ts`'s `mapSpread`,
 * `pdfOutline.ts`'s `shouldRenderSpread`), so a mismatch between this copy and that one would only
 * make this warning/revert fire a little early or late, never make an actual page render wrong:
 * even if this check somehow let `double` through on a screen the WebView disagrees is wide
 * enough, the WebView's own check still makes it inert there rather than broken.
 */
const SPREAD_MIN_WIDTH = 800;

/** Spreads the CURRENT layout group so changing `flow` can never silently reset `spread` (or the
 * reverse) — the exact mistake PREFS_API_FOR_FRONTEND.md's "one rule that bites" warns about.
 * EXCEPT for the one combination below, where resetting the other field is deliberate, not a bug. */

/**
 * `flow: 'scrolled-doc'` plus `spread: 'double'` is not a state either renderer can honour: a
 * double-page spread is a PAGINATED concept (two page boundaries side by side), and continuous
 * scroll has no page boundaries to pair — epub.entry.ts's scrolled manager never reads
 * `appearance.spread` at all, and pdf.entry.ts's `scrollMode` branch is the same. Rather than
 * silently sending the WebView a combination it ignores half of, whichever field is ALREADY set
 * gets reverted to its default the instant the OTHER one would create the conflict — the field just
 * tapped always wins, since that is the choice the user is actively making right now — and an alert
 * says so, so "why did my spread setting disappear" has an answer on screen instead of only in this
 * comment.
 */
function warnScrolledDoubleSpreadConflict(revertedField: string, keptField: string): void {
  Alert.alert(
    'Layout updated',
    `Scrolled flow doesn't support a double-page spread. ${revertedField} has been reset to its ` +
      `default so ${keptField} could be applied.`,
  );
}

function toggleFlow(current: SharedPrefs, flow: LayoutPrefs['flow']): PrefsPatch {
  const nextFlow = current.layout.flow === flow ? DEFAULT_PREFS.layout.flow : flow;

  if (nextFlow === 'scrolled-doc' && current.layout.spread === 'double') {
    warnScrolledDoubleSpreadConflict('Spread', 'Scrolled flow');
    return { layout: { ...current.layout, flow: nextFlow, spread: DEFAULT_PREFS.layout.spread } };
  }

  return { layout: { ...current.layout, flow: nextFlow } };
}

/**
 * REVERTS `spread` back to its default (single), same as `warnScrolledDoubleSpreadConflict` does
 * for its own conflict — this used to be purely informational (double was still stored, on the
 * reasoning that rotating to landscape or opening the same account on a tablet could cross
 * `SPREAD_MIN_WIDTH` later without the user reselecting Double). That traded correctness for
 * convenience: it left a preference stored that could not apply on THIS screen at all, which is a
 * worse trade than asking the user to press Double again once the screen is actually wide enough.
 * Checked FIRST in `toggleSpread`, ahead of the scrolled-flow conflict below — a screen too narrow
 * for a double-page spread is true regardless of what `flow` currently is, so this can't be
 * allowed to depend on which check happens to run first or short-circuit the other.
 */
function warnSpreadTooNarrow(): void {
  Alert.alert(
    'Double spread',
    'This screen is too narrow for a double-page spread, so it will stay on Single. Try Double ' +
      'again once the screen is wider — landscape or a tablet.',
  );
}

function toggleSpread(
  current: SharedPrefs,
  spread: LayoutPrefs['spread'],
  windowWidth: number,
): PrefsPatch {
  const nextSpread = current.layout.spread === spread ? DEFAULT_PREFS.layout.spread : spread;

  // Checked BEFORE the scrolled-flow conflict below, and unconditionally on its own `return` —
  // double cannot apply on a screen this narrow no matter what `flow` is, so this can't be skipped
  // just because `current.layout.flow` happens to already be `'scrolled-doc'` (which used to make
  // the OTHER check return first, leaving `double` stored anyway on a screen that can't show it).
  if (nextSpread === 'double' && windowWidth < SPREAD_MIN_WIDTH) {
    warnSpreadTooNarrow();
    return { layout: { ...current.layout, spread: DEFAULT_PREFS.layout.spread } };
  }

  if (nextSpread === 'double' && current.layout.flow === 'scrolled-doc') {
    warnScrolledDoubleSpreadConflict('Flow', 'Double spread');
    return { layout: { ...current.layout, spread: nextSpread, flow: DEFAULT_PREFS.layout.flow } };
  }

  return { layout: { ...current.layout, spread: nextSpread } };
}

/**
 * Zoom bounds for the slider only — `ZoomPrefs.level` itself carries no documented range
 * (prefs.ts:70-72 just says "1.0 = 100%"). 50%–300% covers a PDF's useful reading range without
 * inviting a value so extreme `fit * dpr * zoom` (pdf.entry.ts) produces a degenerate canvas.
 */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
const ZOOM_STEP = 0.1;
const ZOOM_THUMB_SIZE = 20;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * The ratio (0-1 along the track) of every valid step value from `min` to `max` inclusive.
 *
 * Line height/letter spacing/margins have few enough steps (9-13) that drawing every one of them
 * as a tick mark is what tells a dragging finger "only these stops exist" BEFORE release, instead
 * of the value only visibly snapping once the finger lifts — which reads as the slider fighting the
 * drag rather than as the stepped control it actually is. Font size (21 steps) and zoom (26 steps)
 * are fine-grained enough that marking every stop would just be visual noise, which is why only the
 * three sliders that asked for this get it, not a change to every slider's shared track pieces.
 *
 * A pure ratio calculation, not a slider component — sharing it doesn't reopen the "one dev widget,
 * not a design system" call each slider component above already makes for itself.
 */
function stepTickRatios(min: number, max: number, step: number): number[] {
  const steps = Math.round((max - min) / step);
  return Array.from({ length: steps + 1 }, (_, i) => i / steps);
}

/** Rounds to the nearest step and away from float noise (e.g. 1.7000000000000002). */
function snapToZoomStep(value: number): number {
  return Math.round(clamp(value, ZOOM_MIN, ZOOM_MAX) / ZOOM_STEP) * ZOOM_STEP;
}

/**
 * A minimal drag slider, in RN core only (View/Pressable/PanResponder) — deliberately not a new
 * dependency for a TEMP dev widget. Visual position updates continuously while dragging (so the
 * marker tracks the finger and the number reads live); the actual `prefsStore.savePrefs` commit
 * fires only on release, so a drag does not flood the WebView with a re-render per pixel of finger
 * movement.
 */
function ZoomSlider({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (value: number) => void;
}): React.JSX.Element {
  const [trackWidth, setTrackWidth] = useState(0);
  const [dragValue, setDragValue] = useState<number | null>(null);

  // Closes over `trackWidth`/`value` directly (plain render-scope variables, not refs) rather than
  // the ref-sync-in-an-effect idiom used elsewhere in this codebase (e.g. ReaderScreen's
  // appearanceEnvRef) — the newer react-hooks/refs lint rule flags a ref read reachable from a
  // value constructed during render, which PanResponder.create's callbacks would be. Recreating
  // this per `[trackWidth, value]` change is cheap and, since neither changes mid-drag (trackWidth
  // only changes on layout/rotation, and `value` only changes when THIS component's own onCommit
  // below fires, i.e. after a drag ends), the PanResponder's identity is stable for the lifetime of
  // any single gesture — recreating it mid-touch is what would risk dropping the gesture, not this.
  const valueFromX = useCallback(
    (x: number): number => {
      if (trackWidth <= 0) return value;
      const ratio = clamp(x / trackWidth, 0, 1);
      return snapToZoomStep(ZOOM_MIN + ratio * (ZOOM_MAX - ZOOM_MIN));
    },
    [trackWidth, value],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderMove: (evt) => {
          setDragValue(valueFromX(evt.nativeEvent.locationX));
        },
        onPanResponderRelease: (evt) => {
          const next = valueFromX(evt.nativeEvent.locationX);
          setDragValue(null);
          onCommit(next);
        },
        onPanResponderTerminate: () => {
          setDragValue(null);
        },
      }),
    [valueFromX, onCommit],
  );

  const handleTrackLayout = useCallback((event: LayoutChangeEvent) => {
    setTrackWidth(event.nativeEvent.layout.width);
  }, []);

  const displayValue = dragValue ?? value;
  const ratio = (clamp(displayValue, ZOOM_MIN, ZOOM_MAX) - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN);
  const thumbLeft = ratio * trackWidth - ZOOM_THUMB_SIZE / 2;

  return (
    <View>
      <Text style={styles.zoomValue}>{Math.round(displayValue * 100)}%</Text>
      <View style={styles.zoomTrack} onLayout={handleTrackLayout} {...panResponder.panHandlers}>
        <View style={styles.zoomTrackBase} />
        <View style={[styles.zoomTrackFill, { width: `${ratio * 100}%` }]} />
        <View
          style={[
            styles.zoomThumb,
            { left: clamp(thumbLeft, -ZOOM_THUMB_SIZE / 2, trackWidth - ZOOM_THUMB_SIZE / 2) },
          ]}
        />
      </View>
    </View>
  );
}

/**
 * Font-size bounds for the slider only — `TypographyPrefs.size` itself carries no documented range
 * (it's absolute points; `readerMetrics.ts`'s ABSOLUTE_MIN/MAX_FONT_PX, 8/200, are a pathological-
 * value backstop, not a usable reading range). 12-32pt centers `DEFAULT_PREFS.typography.size` (16)
 * and comfortably covers the 28pt this slider replaces.
 */
const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 32;
const FONT_SIZE_STEP = 1;
const FONT_SIZE_THUMB_SIZE = 20;

function snapToFontSizeStep(value: number): number {
  return Math.round(clamp(value, FONT_SIZE_MIN, FONT_SIZE_MAX) / FONT_SIZE_STEP) * FONT_SIZE_STEP;
}

/** Same drag-live/commit-on-release shape as `ZoomSlider` above, adapted to `typography.size`'s own
 * bounds and a "12pt"-style label instead of a percentage. Kept as its own copy rather than a shared
 * generic slider — this file already treats each toggle as its own small function rather than a
 * shared abstraction (see `toggleFlow`/`toggleSpread`), matching its "one dev widget, not a design
 * system" scope. */
function FontSizeSlider({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (value: number) => void;
}): React.JSX.Element {
  const [trackWidth, setTrackWidth] = useState(0);
  const [dragValue, setDragValue] = useState<number | null>(null);

  const valueFromX = useCallback(
    (x: number): number => {
      if (trackWidth <= 0) return value;
      const ratio = clamp(x / trackWidth, 0, 1);
      return snapToFontSizeStep(FONT_SIZE_MIN + ratio * (FONT_SIZE_MAX - FONT_SIZE_MIN));
    },
    [trackWidth, value],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderMove: (evt) => {
          setDragValue(valueFromX(evt.nativeEvent.locationX));
        },
        onPanResponderRelease: (evt) => {
          const next = valueFromX(evt.nativeEvent.locationX);
          // Keep showing `next`, NOT the stale `value` prop, until it actually catches up (the
          // render-time check below clears it then — see that check's own comment). `onCommit`
          // persists asynchronously; clearing dragValue here instead used to fall back to the old
          // `value` for one paint, then jump to `next` once the async write resolved and
          // prefsStore's subscribe fired — a visible revert-then-jump on every single release,
          // which is what "glitching" was.
          setDragValue(next);
          onCommit(next);
        },
        onPanResponderTerminate: () => {
          setDragValue(null);
        },
      }),
    [valueFromX, onCommit],
  );

  // Adjusting state during render rather than in an effect — react.dev's "You Might Not Need an
  // Effect" names exactly this shape ("adjusting some state when a prop changes") as the preferred
  // form: React discards this render and re-renders synchronously with `dragValue` already cleared
  // before anything paints, where an effect would paint the stale render first and correct it one
  // frame later. Safe from a loop: this only fires while dragValue is non-null and equal to the
  // now-caught-up value, and clearing it makes the condition false on the very next render.
  if (dragValue !== null && value === dragValue) {
    setDragValue(null);
  }

  const handleTrackLayout = useCallback((event: LayoutChangeEvent) => {
    setTrackWidth(event.nativeEvent.layout.width);
  }, []);

  const displayValue = dragValue ?? value;
  const ratio =
    (clamp(displayValue, FONT_SIZE_MIN, FONT_SIZE_MAX) - FONT_SIZE_MIN) /
    (FONT_SIZE_MAX - FONT_SIZE_MIN);
  const thumbLeft = ratio * trackWidth - FONT_SIZE_THUMB_SIZE / 2;

  return (
    <View style={styles.fontSizeSlider}>
      <Text style={styles.zoomValue}>{Math.round(displayValue)}pt</Text>
      <View style={styles.zoomTrack} onLayout={handleTrackLayout} {...panResponder.panHandlers}>
        <View style={styles.zoomTrackBase} />
        <View style={[styles.zoomTrackFill, { width: `${ratio * 100}%` }]} />
        <View
          style={[
            styles.zoomThumb,
            {
              left: clamp(
                thumbLeft,
                -FONT_SIZE_THUMB_SIZE / 2,
                trackWidth - FONT_SIZE_THUMB_SIZE / 2,
              ),
            },
          ]}
        />
      </View>
    </View>
  );
}

/**
 * Line-height bounds for the slider only — `TypographyPrefs.lineHeight` itself carries no
 * documented range (prefs.ts:50 just says "multiplier, e.g. 1.5"). 1.0-2.2 covers single spacing
 * through a clearly loosened reading rhythm without letting the line grid in readerMetrics.ts
 * (which rounds `fontPx * lineHeight` to a whole-pixel grid unit) produce an absurdly tall line.
 */
const LINE_HEIGHT_MIN = 1.0;
const LINE_HEIGHT_MAX = 2.2;
const LINE_HEIGHT_STEP = 0.1;
const LINE_HEIGHT_THUMB_SIZE = 20;

function snapToLineHeightStep(value: number): number {
  return (
    Math.round(clamp(value, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX) / LINE_HEIGHT_STEP) *
    LINE_HEIGHT_STEP
  );
}

/** Same drag-live/commit-on-release shape as `FontSizeSlider` above, adapted to
 * `typography.lineHeight`'s own bounds and a "1.5×"-style label. Kept as its own copy rather than a
 * shared generic slider, for the same "one dev widget, not a design system" reason `FontSizeSlider`
 * already gives. */
function LineHeightSlider({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (value: number) => void;
}): React.JSX.Element {
  const [trackWidth, setTrackWidth] = useState(0);
  const [dragValue, setDragValue] = useState<number | null>(null);

  const valueFromX = useCallback(
    (x: number): number => {
      if (trackWidth <= 0) return value;
      const ratio = clamp(x / trackWidth, 0, 1);
      return snapToLineHeightStep(LINE_HEIGHT_MIN + ratio * (LINE_HEIGHT_MAX - LINE_HEIGHT_MIN));
    },
    [trackWidth, value],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderMove: (evt) => {
          setDragValue(valueFromX(evt.nativeEvent.locationX));
        },
        onPanResponderRelease: (evt) => {
          const next = valueFromX(evt.nativeEvent.locationX);
          setDragValue(null);
          onCommit(next);
        },
        onPanResponderTerminate: () => {
          setDragValue(null);
        },
      }),
    [valueFromX, onCommit],
  );

  const handleTrackLayout = useCallback((event: LayoutChangeEvent) => {
    setTrackWidth(event.nativeEvent.layout.width);
  }, []);

  const displayValue = dragValue ?? value;
  const ratio =
    (clamp(displayValue, LINE_HEIGHT_MIN, LINE_HEIGHT_MAX) - LINE_HEIGHT_MIN) /
    (LINE_HEIGHT_MAX - LINE_HEIGHT_MIN);
  const thumbLeft = ratio * trackWidth - LINE_HEIGHT_THUMB_SIZE / 2;

  return (
    <View style={styles.fontSizeSlider}>
      <Text style={styles.zoomValue}>{displayValue.toFixed(1)}×</Text>
      <View style={styles.zoomTrack} onLayout={handleTrackLayout} {...panResponder.panHandlers}>
        <View style={styles.zoomTrackBase} />
        <View style={[styles.zoomTrackFill, { width: `${ratio * 100}%` }]} />
        {stepTickRatios(LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, LINE_HEIGHT_STEP).map((tickRatio) => (
          <View key={tickRatio} style={[styles.sliderTick, { left: `${tickRatio * 100}%` }]} />
        ))}
        <View
          style={[
            styles.zoomThumb,
            {
              left: clamp(
                thumbLeft,
                -LINE_HEIGHT_THUMB_SIZE / 2,
                trackWidth - LINE_HEIGHT_THUMB_SIZE / 2,
              ),
            },
          ]}
        />
      </View>
    </View>
  );
}

/**
 * Letter-spacing bounds for the slider only — `TypographyPrefs.spacing` itself carries no
 * documented range beyond "0 = none" (prefs.ts:51-60). 0-4px covers no tracking through a clearly
 * widened one without spacing letters far enough apart to break word recognition.
 */
const LETTER_SPACING_MIN = 0;
const LETTER_SPACING_MAX = 4;
const LETTER_SPACING_STEP = 0.5;
const LETTER_SPACING_THUMB_SIZE = 20;

function snapToLetterSpacingStep(value: number): number {
  return (
    Math.round(clamp(value, LETTER_SPACING_MIN, LETTER_SPACING_MAX) / LETTER_SPACING_STEP) *
    LETTER_SPACING_STEP
  );
}

/** Same drag-live/commit-on-release shape as `FontSizeSlider` above, adapted to
 * `typography.spacing`'s own bounds and a "0.5px"-style label. Kept as its own copy for the same
 * reason `FontSizeSlider` and `LineHeightSlider` are. */
function LetterSpacingSlider({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (value: number) => void;
}): React.JSX.Element {
  const [trackWidth, setTrackWidth] = useState(0);
  const [dragValue, setDragValue] = useState<number | null>(null);

  const valueFromX = useCallback(
    (x: number): number => {
      if (trackWidth <= 0) return value;
      const ratio = clamp(x / trackWidth, 0, 1);
      return snapToLetterSpacingStep(
        LETTER_SPACING_MIN + ratio * (LETTER_SPACING_MAX - LETTER_SPACING_MIN),
      );
    },
    [trackWidth, value],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderMove: (evt) => {
          setDragValue(valueFromX(evt.nativeEvent.locationX));
        },
        onPanResponderRelease: (evt) => {
          const next = valueFromX(evt.nativeEvent.locationX);
          setDragValue(null);
          onCommit(next);
        },
        onPanResponderTerminate: () => {
          setDragValue(null);
        },
      }),
    [valueFromX, onCommit],
  );

  const handleTrackLayout = useCallback((event: LayoutChangeEvent) => {
    setTrackWidth(event.nativeEvent.layout.width);
  }, []);

  const displayValue = dragValue ?? value;
  const ratio =
    (clamp(displayValue, LETTER_SPACING_MIN, LETTER_SPACING_MAX) - LETTER_SPACING_MIN) /
    (LETTER_SPACING_MAX - LETTER_SPACING_MIN);
  const thumbLeft = ratio * trackWidth - LETTER_SPACING_THUMB_SIZE / 2;

  return (
    <View style={styles.fontSizeSlider}>
      <Text style={styles.zoomValue}>{displayValue.toFixed(1)}px</Text>
      <View style={styles.zoomTrack} onLayout={handleTrackLayout} {...panResponder.panHandlers}>
        <View style={styles.zoomTrackBase} />
        <View style={[styles.zoomTrackFill, { width: `${ratio * 100}%` }]} />
        {stepTickRatios(LETTER_SPACING_MIN, LETTER_SPACING_MAX, LETTER_SPACING_STEP).map(
          (tickRatio) => (
            <View key={tickRatio} style={[styles.sliderTick, { left: `${tickRatio * 100}%` }]} />
          ),
        )}
        <View
          style={[
            styles.zoomThumb,
            {
              left: clamp(
                thumbLeft,
                -LETTER_SPACING_THUMB_SIZE / 2,
                trackWidth - LETTER_SPACING_THUMB_SIZE / 2,
              ),
            },
          ]}
        />
      </View>
    </View>
  );
}

/**
 * Page-margin bounds for the slider only — `TypographyPrefs.margins` itself carries no documented
 * range (prefs.ts:62 just says "page margin, in px"). 0-48px covers edge-to-edge through a
 * generously wide margin; `readerMetrics.ts`'s `clampMargin()` separately caps the applied value at
 * a quarter of the viewport height at render time regardless of what this slider allows, so this
 * range is a comfortable UI range, not something that has to match that runtime clamp exactly.
 */
const MARGINS_MIN = 0;
const MARGINS_MAX = 48;
const MARGINS_STEP = 4;
const MARGINS_THUMB_SIZE = 20;

function snapToMarginsStep(value: number): number {
  return Math.round(clamp(value, MARGINS_MIN, MARGINS_MAX) / MARGINS_STEP) * MARGINS_STEP;
}

/** Same drag-live/commit-on-release shape as `FontSizeSlider` above, adapted to
 * `typography.margins`'s own bounds and an integer "16px"-style label. Kept as its own copy for the
 * same reason `FontSizeSlider`, `LineHeightSlider` and `LetterSpacingSlider` are. */
function PageMarginsSlider({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (value: number) => void;
}): React.JSX.Element {
  const [trackWidth, setTrackWidth] = useState(0);
  const [dragValue, setDragValue] = useState<number | null>(null);

  const valueFromX = useCallback(
    (x: number): number => {
      if (trackWidth <= 0) return value;
      const ratio = clamp(x / trackWidth, 0, 1);
      return snapToMarginsStep(MARGINS_MIN + ratio * (MARGINS_MAX - MARGINS_MIN));
    },
    [trackWidth, value],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderMove: (evt) => {
          setDragValue(valueFromX(evt.nativeEvent.locationX));
        },
        onPanResponderRelease: (evt) => {
          const next = valueFromX(evt.nativeEvent.locationX);
          setDragValue(null);
          onCommit(next);
        },
        onPanResponderTerminate: () => {
          setDragValue(null);
        },
      }),
    [valueFromX, onCommit],
  );

  const handleTrackLayout = useCallback((event: LayoutChangeEvent) => {
    setTrackWidth(event.nativeEvent.layout.width);
  }, []);

  const displayValue = dragValue ?? value;
  const ratio =
    (clamp(displayValue, MARGINS_MIN, MARGINS_MAX) - MARGINS_MIN) / (MARGINS_MAX - MARGINS_MIN);
  const thumbLeft = ratio * trackWidth - MARGINS_THUMB_SIZE / 2;

  return (
    <View style={styles.fontSizeSlider}>
      <Text style={styles.zoomValue}>{Math.round(displayValue)}px</Text>
      <View style={styles.zoomTrack} onLayout={handleTrackLayout} {...panResponder.panHandlers}>
        <View style={styles.zoomTrackBase} />
        <View style={[styles.zoomTrackFill, { width: `${ratio * 100}%` }]} />
        {stepTickRatios(MARGINS_MIN, MARGINS_MAX, MARGINS_STEP).map((tickRatio) => (
          <View key={tickRatio} style={[styles.sliderTick, { left: `${tickRatio * 100}%` }]} />
        ))}
        <View
          style={[
            styles.zoomThumb,
            {
              left: clamp(thumbLeft, -MARGINS_THUMB_SIZE / 2, trackWidth - MARGINS_THUMB_SIZE / 2),
            },
          ]}
        />
      </View>
    </View>
  );
}

export interface DevPreferencesMenuProps {
  /** The active book's format, so Zoom can be hidden for an EPUB — see the header note on why.
   * Optional only for callers with no format to hand; ReaderRouteScreen (the only render site)
   * always has one, since it comes straight off the Reader route's own params — BookListScreen's
   * fixture rows are never ambiguous about their own format. Undefined falls back to showing Zoom
   * rather than guessing it should hide. */
  format?: ContentFormat;
}

export function DevPreferencesMenu({ format }: DevPreferencesMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);

  /**
   * Where the dropdown paints, in SCREEN coordinates — required because the dropdown now renders
   * inside a `Modal` (see below) rather than as an absolutely-positioned sibling of the ☰ button.
   *
   * >>> WHY A MODAL AT ALL. <<< Confirmed on-device, Android only: this menu's `open` state is
   * local to this component (deliberately — see the file header on why `toolbarExtra` is a plain
   * prop slot with no callback into ReaderScreen). `ReaderScreen`'s `anyPanelOpen` — the switch that
   * hides `ReaderWebView` while TOC/Search/Bookmarks are open, which is the ONLY reason those panels
   * paint over the book without any zIndex — has no way to know this menu opened, so the WebView
   * stays mounted and visible. On Android, a WebView composites through its own hardware layer that
   * ignores sibling `elevation`/`zIndex` (a well-known react-native-webview limitation; not true on
   * iOS, where the equivalent overlay painted correctly). The result: the accessibility tree showed
   * the dropdown's controls existed and were focusable (`open` really did flip, `getPrefs()` really
   * did resolve), but nothing was visible on screen — indistinguishable from "the button does
   * nothing" to a user tapping it, which is exactly what was reported. A `Modal` renders in its own
   * native Android Window, which always paints above the Activity's entire view tree, WebView
   * included — the same fix this class of bug gets in every RN+WebView app, and it needs no change
   * to ReaderScreen or the `toolbarExtra` contract this file's header is careful to keep isolated.
   *
   * MEASURED, NOT HARDCODED: a `Modal`'s content positions against the whole screen, not against
   * this component's own small `container`, so the dropdown's on-screen position has to be
   * measured from the button rather than inherited from a relatively-positioned parent the way the
   * old absolute-overlay version could rely on.
   *
   * `open` ITSELF DOES NOT WAIT ON THE MEASUREMENT. `measureInWindow`'s callback is fire-and-forget
   * on a real device (next frame, imperceptibly late) but NEVER FIRES AT ALL against the test
   * renderer — `DevPreferencesMenu.test.tsx` presses the button and immediately queries for the
   * dropdown's contents, so gating `open` on the callback made every one of those queries fail
   * against a menu that (as far as the test tree is concerned) never opened. `anchor` starting
   * `null` and `styles.dropdown`'s own `top`/`right` staying as a fallback is what keeps this safe
   * either way: a real device repaints one frame later at the precise position, and the test
   * renderer — which never calls back — just keeps the fallback, which is fine, since no test
   * asserts on-screen pixel position.
   */
  const buttonRef = useRef<RNView>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number; maxWidth: number } | null>(
    null,
  );

  const toggleOpen = useCallback(() => {
    setOpen((wasOpen) => {
      const next = !wasOpen;
      if (next) {
        buttonRef.current?.measureInWindow((x, y, width, height) => {
          const windowWidth = Dimensions.get('window').width;
          const right = Math.max(0, windowWidth - (x + width));
          // The dropdown's right edge is pinned at `right` from the screen's right edge, so the
          // space actually available before it would run off the LEFT edge is `windowWidth -
          // right`, less a margin so it doesn't touch the edge exactly. Computed from the real
          // measurement (not a fixed constant) so it stays correct across phone/tablet widths and
          // portrait/landscape, and shrinks along with `right` if the button itself sits away from
          // the screen's right edge.
          setAnchor({
            top: y + height,
            right,
            maxWidth: Math.max(0, windowWidth - right - DROPDOWN_EDGE_MARGIN),
          });
        });
      }
      return next;
    });
  }, []);

  // Local, live copy of prefs — needed to know which toggle is currently "on" (so pressing it again
  // can revert rather than re-apply), same live channel ReaderScreen itself subscribes to.
  const [prefs, setPrefs] = useState<SharedPrefs | null>(null);

  useEffect(() => {
    let cancelled = false;
    void prefsStore.getPrefs().then((fresh) => {
      if (!cancelled) setPrefs(fresh);
    });

    const unsubscribe = prefsStore.subscribe((fresh) => {
      setPrefs(fresh);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Stable across every render of THIS component (empty deps — `zoom.level` is a single-field
  // group, so there is nothing to spread from current prefs), which is what lets ZoomSlider's own
  // PanResponder stay identical for the lifetime of a drag even if a prefs notification lands and
  // re-renders this menu mid-gesture.
  const commitZoom = useCallback((level: number) => {
    void prefsStore.savePrefs({ zoom: { level } });
  }, []);

  /**
   * Whether the Reader is currently overriding `layout.flow` for a screen reader — see
   * readerA11yLayout.ts for why it does, and ReaderScreen for the notice that says so.
   *
   * DERIVED FROM THE SAME THREE INPUTS ReaderScreen uses, rather than passed down, because this
   * component is not its child: it arrives through the `toolbarExtra` slot, constructed in
   * ReaderRouteScreen. The one input that could not be re-derived — whether the user declined — is
   * why `a11yOverrideChoice` is a module instead of local state.
   */
  const screenReaderEnabled = useScreenReaderEnabled();
  const overrideDeclined = useOverrideDeclined();
  const flowOverridden =
    prefs !== null && flowOverrideApplied(prefs.layout.flow, screenReaderEnabled && !overrideDeclined);

  // Unlike `commitZoom`, this spreads the CURRENT typography group rather than `DEFAULT_PREFS`'s —
  // `typography` has siblings (lineHeight/spacing/margins) a bare `{ size }` patch would silently
  // reset, the exact "one rule that bites" this file's header already warns about for layout. That
  // makes it depend on `prefs`, so (unlike `commitZoom`) its identity changes on every prefs update —
  // acceptable here since, unlike Zoom's PanResponder, a size change while mid-drag on THIS slider
  // can only come from `prefs.typography.size` itself changing, which only happens via this same
  // callback's own commit.
  const commitFontSize = useCallback(
    (size: number) => {
      if (!prefs) return;
      void prefsStore.savePrefs({ typography: { ...prefs.typography, size } });
    },
    [prefs],
  );

  // Same "spread the current typography group" shape as `commitFontSize` — and the same reason it
  // depends on `prefs` rather than being stable like `commitZoom`.
  const commitLineHeight = useCallback(
    (lineHeight: number) => {
      if (!prefs) return;
      void prefsStore.savePrefs({ typography: { ...prefs.typography, lineHeight } });
    },
    [prefs],
  );

  const commitLetterSpacing = useCallback(
    (spacing: number) => {
      if (!prefs) return;
      void prefsStore.savePrefs({ typography: { ...prefs.typography, spacing } });
    },
    [prefs],
  );

  const commitMargins = useCallback(
    (margins: number) => {
      if (!prefs) return;
      void prefsStore.savePrefs({ typography: { ...prefs.typography, margins } });
    },
    [prefs],
  );

  return (
    <View style={styles.container}>
      <Pressable
        ref={buttonRef}
        accessibilityRole="button"
        accessibilityLabel={open ? 'Close preferences menu' : 'Open preferences menu'}
        onPress={toggleOpen}
        style={styles.menuButton}
      >
        <Text style={styles.menuIcon}>☰</Text>
      </Pressable>

      {/* Guarded on `prefs` exactly like the old `{open && prefs && (...)}` was, so nothing inside
          ever reads a field off a null `prefs` — the Modal's own `visible` only toggles display
          once this subtree exists.
          `transparent` + no `animationType` so this reads as the same instant dropdown the
          absolutely-positioned version was, not a sheet/dialog — see the Modal note on `anchor`
          above for why this is a Modal at all. `onRequestClose` is Android's hardware/gesture back
          button; without it, back would fall through to whatever's under this screen instead of
          just closing the menu. */}
      {prefs && (
        <Modal transparent visible={open} onRequestClose={() => setOpen(false)}>
          {/* Full-screen backdrop, BEFORE the dropdown so the dropdown's own Pressables (rendered
              after, in document order) still receive their taps rather than this one swallowing
              them. Tapping outside the dropdown closes it — there was no such affordance before
              (only re-pressing ☰ closed it), but a Modal without one traps the user behind an
              invisible full-screen Pressable, which is worse than not having it. */}
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onPress={() => setOpen(false)}
          />
          <View
            style={[
              styles.dropdown,
              anchor && {
                position: 'absolute',
                top: anchor.top,
                right: anchor.right,
                maxWidth: anchor.maxWidth,
              },
            ]}
          >
          <Text style={styles.sectionLabel}>Theme</Text>
          <View style={styles.row}>
            {THEME_OPTIONS.map(({ label, theme }) => {
              const active = prefs.theme === theme;
              return (
                <Pressable
                  key={theme}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`Theme: ${label}${active ? ', selected' : ''}`}
                  onPress={() => {
                    void prefsStore.savePrefs(toggleTheme(prefs, theme));
                  }}
                  style={[styles.toggle, active && styles.toggleActive]}
                >
                  <Text style={[styles.toggleLabel, active && styles.toggleLabelActive]}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* TYPOGRAPHY REMOVED FOR PDF — NOT FORMAT APPLICABLE. pdf.entry.ts ignores typography
              entirely (it rasterises pages, so there is no text CSS to override); ReaderAppearance
              still carries fontFamily/fontSizePt/lineHeight/etc. regardless, one payload for both
              renderers by design. Same reasoning as the Zoom guard below, just the other format:
              a control with nothing to control is worse than no control. Shown for EPUB and for the
              unrecognised-fixture fallback (format undefined), hidden only for a known PDF. */}
          {format !== 'PDF' && (
            <>
              <Text style={styles.sectionLabel}>Typography</Text>
              <Text style={styles.sliderLabel}>Font size</Text>
              <FontSizeSlider value={prefs.typography.size} onCommit={commitFontSize} />
              <Text style={styles.sliderLabel}>Line height</Text>
              <LineHeightSlider value={prefs.typography.lineHeight} onCommit={commitLineHeight} />
              <Text style={styles.sliderLabel}>Letter spacing</Text>
              <LetterSpacingSlider
                value={prefs.typography.spacing}
                onCommit={commitLetterSpacing}
              />
              <Text style={styles.sliderLabel}>Page margins</Text>
              <PageMarginsSlider value={prefs.typography.margins} onCommit={commitMargins} />
              <View style={styles.row}>
                {FAMILY_OPTIONS.map(({ label, family }) => {
                  const active = prefs.font.family === family;
                  return (
                    <Pressable
                      key={family}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      accessibilityLabel={`Font: ${label}${active ? ', selected' : ''}`}
                      onPress={() => {
                        void prefsStore.savePrefs(toggleFontFamily(prefs, family));
                      }}
                      style={[styles.toggle, active && styles.toggleActive]}
                    >
                      <Text style={[styles.toggleLabel, active && styles.toggleLabelActive]}>
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          )}

          <Text style={styles.sectionLabel}>Layout</Text>
          {/*
            DISABLED, NOT HIDDEN, while the Reader is overriding `flow` for a screen reader
            (readerA11yLayout.ts). Both are the same principle this file already applies to Zoom on
            EPUB — a control with nothing to control is worse than no control — but the treatments
            differ deliberately: Zoom is hidden because it can NEVER apply to a reflowable book,
            while this is conditional and reversible, so the user has to be able to find out why
            their toggle stopped responding. It is also where the one-time alert ReaderScreen shows
            stays reachable after being dismissed. Choosing "Use pages anyway" there clears the
            override, and these rows come back.
          */}
          {flowOverridden && (
            <Text style={styles.sectionNote} testID="prefs-flow-override-note">
              Scrolled layout is on so screen readers can reach the text. Your saved preference is
              unchanged.
            </Text>
          )}
          <View style={styles.row}>
            {FLOW_OPTIONS.map(({ label, flow }) => {
              const active = prefs.layout.flow === flow;
              return (
                <Pressable
                  key={flow}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active, disabled: flowOverridden }}
                  accessibilityLabel={`Flow: ${label}${active ? ', selected' : ''}`}
                  disabled={flowOverridden}
                  onPress={() => {
                    void prefsStore.savePrefs(toggleFlow(prefs, flow));
                  }}
                  style={[
                    styles.toggle,
                    active && styles.toggleActive,
                    flowOverridden && styles.toggleDisabled,
                  ]}
                >
                  <Text style={[styles.toggleLabel, active && styles.toggleLabelActive]}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.row}>
            {SPREAD_OPTIONS.map(({ label, spread }) => {
              const active = prefs.layout.spread === spread;
              return (
                <Pressable
                  key={spread}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active, disabled: flowOverridden }}
                  accessibilityLabel={`Spread: ${label}${active ? ', selected' : ''}`}
                  disabled={flowOverridden}
                  onPress={() => {
                    // One-shot read at press time, same as `toggleOpen`'s own use of `Dimensions`
                    // above — this is an event handler, not a render-time computation, so it does
                    // not need the reactive `useWindowDimensions()` hook.
                    void prefsStore.savePrefs(
                      toggleSpread(prefs, spread, Dimensions.get('window').width),
                    );
                  }}
                  style={[
                    styles.toggle,
                    active && styles.toggleActive,
                    flowOverridden && styles.toggleDisabled,
                  ]}
                >
                  <Text style={[styles.toggleLabel, active && styles.toggleLabelActive]}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* ZOOM REMOVED FOR EPUB — NOT FORMAT APPLICABLE. See this file's header note: a
              reflowable EPUB scales via fontSizePt, epub.entry.ts never reads appearance.zoom, and
              a control with nothing to control is worse than no control. Shown for PDF and for the
              unrecognised-fixture fallback (format undefined), hidden only for a known EPUB. */}
          {format !== 'EPUB' && (
            <>
              <Text style={styles.sectionLabel}>Zoom</Text>
              <ZoomSlider value={prefs.zoom.level} onCommit={commitZoom} />
            </>
          )}

          {/* TEMP — delete with the rest of this file once a real settings screen lands. Exists
              ONLY to trigger the Week-4 Item 1 (screenshot restriction) device spike by hand: there
              is no other way to call `preventScreenCaptureAsync` on a device yet, since wiring it
              into ReaderScreen's real focus/blur lifecycle is Phase 1.4, deliberately deferred until
              after this spike passes. `READER_CAPTURE_KEY` (captureProtection.ts) is the SAME single
              key Phase 1.3's hook will use — the B3 finding is exactly that two different keys can
              corrupt iOS's native layer state, so this spike has to exercise the real key, not a
              throwaway string, or a pass here would not mean anything once 1.4 wires the real hook
              in. */}
          <Text style={styles.sectionLabel}>Screen Capture Spike</Text>
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                if (!isScreenCaptureAvailable()) {
                  Alert.alert(
                    'Native Module Unavailable',
                    'ExpoScreenCapture is not linked in this binary. Run `npx expo run:ios` or `npx expo run:android` to rebuild with native modules.'
                  );
                  return;
                }
                void preventScreenCaptureAsync(READER_CAPTURE_KEY);
              }}
              style={styles.toggle}
            >
              <Text style={styles.toggleLabel}>Prevent</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                if (!isScreenCaptureAvailable()) {
                  Alert.alert(
                    'Native Module Unavailable',
                    'ExpoScreenCapture is not linked in this binary. Run `npx expo run:ios` or `npx expo run:android` to rebuild with native modules.'
                  );
                  return;
                }
                void allowScreenCaptureAsync(READER_CAPTURE_KEY);
              }}
              style={styles.toggle}
            >
              <Text style={styles.toggleLabel}>Allow</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => Alert.alert('Spike test', 'Dismiss me, then check capture state')}
              style={styles.toggle}
            >
              <Text style={styles.toggleLabel}>Show Alert</Text>
            </Pressable>
          </View>
          </View>
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Anchors the dropdown to this button rather than the header, so it overlays the reader below
  // instead of pushing it down.
  container: { position: 'relative' },

  menuButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.card,
  },
  menuIcon: { fontSize: 22, color: color.textPrimary },

  // Matches the visual weight of a `disabled` Pressable elsewhere in the reader (ReaderScreen's
  // Prev/Next), so a row the screen-reader override has taken over reads as unavailable rather than
  // as broken.
  toggleDisabled: { opacity: 0.4 },
  sectionNote: { fontSize: 11, lineHeight: 15, color: color.textSecondary, marginBottom: 6 },

  // Floats over the reader — z-indexed above it and NOT part of the header's own layout flow, so
  // opening it never resizes the WebView underneath (which would re-paginate for no reason).
  //
  // RIGHT: this menu is rendered via ReaderScreen's `toolbarExtra` slot, the LAST (rightmost) child
  // of a right-aligned (`justifyContent: 'flex-end'`) row — see that prop's own doc in
  // ReaderScreen.tsx. `right: 0` opens the dropdown extending leftward from the button, staying
  // on-screen regardless of how close to the edge the row packs it.
  dropdown: {
    position: 'absolute',
    top: 48,
    right: 0,
    // `alignSelf: 'flex-start'` is load-bearing, not decorative: this View sits directly inside
    // Modal's own implicit `flex: 1` container (react-native's Modal.js), whose default
    // `alignItems: 'stretch'` otherwise governs the cross-axis size of an absolutely-positioned
    // child that pins only one horizontal edge (`right`, no `left`/`width` here). iOS's Yoga/host
    // resolution happens to shrink-wrap that case; Android's stretches it edge-to-edge across the
    // Dialog-backed window. Without this override the dropdown was full-screen-width on Android
    // and content-width on iOS from the same style object.
    alignSelf: 'flex-start',
    // No `maxWidth` here — the real one is computed per-open from the actual button position and
    // window width (`toggleOpen`'s `anchor.maxWidth`) and applied alongside `top`/`right` below, so
    // it stays correct across phone/tablet widths and portrait/landscape instead of a guessed
    // constant. This is only the pre-measurement/test-renderer fallback, same reasoning as the
    // `top: 48, right: 0` above it.
    minWidth: 220,
    backgroundColor: color.white,
    borderRadius: radius.tile,
    borderWidth: 1,
    borderColor: color.border,
    padding: 12,
    // RN's boxShadow is iOS/Android-agnostic as of RN 0.76+; elevation is the Android fallback for
    // engines that ignore it. Indigo (`color.navy`) rather than plain black, matching the elevation
    // shadows the shared component library already uses.
    boxShadow: '0px 4px 12px rgba(0, 34, 68, 0.12)',
    elevation: 6,
    zIndex: 10,
  },

  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: color.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  // Distinguishes the three typography sliders from each other under one shared "Typography"
  // section label — smaller and not uppercased, so it doesn't compete with sectionLabel above it.
  sliderLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: color.textPrimary,
    marginBottom: 4,
  },
  hint: {
    fontSize: 11,
    color: color.textSecondary,
    marginBottom: 8,
    fontStyle: 'italic',
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginBottom: 12 },

  toggle: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.white,
  },
  // `color.primary` — the brand's own "active tabs" colour, same call every other selected-chip
  // state in the reader makes.
  toggleActive: { backgroundColor: color.primary, borderColor: color.primary },
  toggleLabel: { fontSize: 13, fontWeight: '700', color: color.textPrimary },
  toggleLabelActive: { color: color.white },

  // Spacing between the font-size slider and the font-family row directly below it — the Zoom
  // slider needs no equivalent since nothing else follows it in that section.
  fontSizeSlider: { marginBottom: 8 },

  // The slider. A plain 6px track with a filled portion behind a round thumb — deliberately not
  // trying to look like either platform's native slider, since this is a dev tool, not UI the app
  // ships with.
  zoomValue: {
    fontSize: 13,
    fontWeight: '700',
    color: color.textPrimary,
    marginBottom: 8,
    fontVariant: ['tabular-nums'],
  },
  zoomTrack: {
    height: 28,
    justifyContent: 'center',
    // Padding, not margin, on the touch target — panHandlers are on THIS view, so the full 28px
    // height (not just the 6px visual track) is draggable, which is what makes the thumb catchable.
  },
  zoomTrackBase: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.border,
  },
  // The accent, not body text — same `color.primary` every other progress/selection fill in the
  // reader uses.
  zoomTrackFill: {
    position: 'absolute',
    left: 0,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.primary,
  },
  zoomThumb: {
    position: 'absolute',
    width: ZOOM_THUMB_SIZE,
    height: ZOOM_THUMB_SIZE,
    borderRadius: ZOOM_THUMB_SIZE / 2,
    backgroundColor: color.white,
    borderWidth: 2,
    borderColor: color.primary,
  },

  // A stop mark for every value `stepTickRatios` reports valid, on the line-height/letter-spacing/
  // margins sliders only (see that function's own comment on why not every slider gets these). No
  // `top` set — same reasoning as `zoomTrackBase`/`zoomTrackFill` above it: `zoomTrack`'s own
  // `justifyContent: 'center'` centers each of these independently, the same way it already
  // centers the 6px track inside the 28px touch target. Taller than the track (10 vs 6) so a tick
  // pokes past both edges of the fill/base bar, and outlined rather than solid so it stays visible
  // whether it lands on the light base or the dark filled portion.
  sliderTick: {
    position: 'absolute',
    width: 2,
    height: 10,
    marginLeft: -1,
    borderRadius: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
    // Indigo (`color.navy`), matching this file's other dark-overlay rgba values.
    borderColor: 'rgba(0, 34, 68, 0.35)',
    borderWidth: 1,
  },
});
