// Owner: Reader (Ahana).
//
// The reader screen: WebView + Prev/Next/Contents controls + a visible error
// banner, reading decrypted bytes through the ContentProvider seam.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Alert,
  AppState,
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';

import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';

import Spinner from '@components/Spinner';
import { color, radius, space } from '@theme/tokens';

import { AccessibilityInfoButton } from '@/features/accessibility/AccessibilityInfoButton';
import { AccessibilitySettingsPanel } from '@/features/accessibility/AccessibilitySettingsPanel';
import { loadDyslexiaFontFaceSrc } from '@/features/accessibility/dyslexiaFontLoader';
import { getHighContrastReaderColors } from '@/features/accessibility/highContrastColors';
import { TtsControls } from '@/features/accessibility/tts/TtsControls';
import { useTtsEnabled } from '@/features/accessibility/tts/useTtsEnabled';
import { useTtsSession } from '@/features/accessibility/tts/useTtsSession';
import { closeBook } from '@/features/encryption/contentProvider';
import { DownloadFailure } from '@/features/download/errors';
import { startAccessMonitor } from '@/features/download/readingAccessMonitor';
import type { AccessMonitorHandle } from '@/features/download/readingAccessMonitor';
import { loadFontFaceSrc } from '@/features/personalization/fontFaceLoader';
import { prefsStore } from '@/features/personalization/prefsStore';
import { toReaderAppearance } from '@/features/personalization/readerAppearance';
import type { AppearanceEnv, ReaderAppearance } from '@/features/personalization/readerAppearance';
import {
  addCurrentEpubBookmark,
  addCurrentPdfBookmark,
  loadBookmarks,
  removeBookmark,
  renameBookmark,
  subscribeToBookmarkChanges,
} from '@/features/personalization/readerBookmarks';
import type { ReaderBookmark } from '@/features/personalization/readerBookmarks';
import {
  addEpubHighlight,
  addPdfHighlight,
  loadReaderHighlights,
  removeHighlight,
} from '@/features/personalization/readerHighlights';
import type { ReaderHighlights } from '@/features/personalization/readerHighlights';
import { BookmarksPanel } from '@/features/reader/BookmarksPanel';
import { ReaderWebView } from '@/features/reader/ReaderWebView';
import {
  getBookBase64,
  getReaderHtmlUri,
  prepareBook,
  UnsupportedFormatError,
} from '@/features/reader/readerAssets';
import type {
  ReaderCommand,
  ReaderErrorCode,
  ReaderMessage,
  ReaderPosition,
  ReaderSection,
  ReaderSelection,
  ReaderTarget,
  ReaderTocItem,
} from '@/features/reader/readerBridge';
import { focusOn } from '@/features/reader/a11yFocus';
import { logEvent, logSpan, now } from '@/features/reader/readerTiming';
import { SearchMatchBar } from '@/features/reader/SearchMatchBar';
import { SearchPanel } from '@/features/reader/SearchPanel';
import {
  a11yFlowOverride,
  effectiveLayoutFlow,
  flowOverrideApplied,
} from '@/features/reader/readerA11yLayout';
import { announce } from '@/features/reader/a11yAnnounce';
import { setOverrideDeclined, useOverrideDeclined } from '@/features/reader/a11yOverrideChoice';
import {
  appearanceChangeAnnouncement,
  chapterChangeAnnouncement,
  pageChangeAnnouncement,
  tocLabelForHref,
} from '@/features/reader/readerAnnouncements';
import { useAppearanceEnv } from '@/features/reader/useAppearanceEnv';
import { useScreenReaderEnabled } from '@/features/reader/useScreenReaderEnabled';
import {
  createEpubReaderTextProvider,
  type EpubReaderTextProvider,
} from '@/features/reader/tts/realReaderTextProvider';
import { targetOf, useBookSearch } from '@/features/reader/useBookSearch';
import { useContentLock } from '@/features/reader/useContentLock';
import { searchMatchFor } from '@/features/search/readerSearchMatch';
import { ContentFailure, DEFAULT_PREFS } from '@/shared/contracts';
import type { BookId, ContentFormat, LayoutPrefs, SharedPrefs } from '@/shared/contracts';

interface ReaderError {
  code: ReaderErrorCode;
  message: string;
}

/**
 * How long to wait for the byte path before giving up on this open.
 *
 * WHY A BOUND IS NEEDED AT ALL. `getBookBase64` now begins with Download's per-open
 * access re-check (`verifyReadingAccess` → `POST /api/v1/reading-sessions`), and that
 * call has no timeout of its own — no `AbortSignal` anywhere in
 * `src/features/download/`. Airplane mode rejects fast, so that case is fine; a
 * reachable-but-unresponsive backend (captive portal, VPN, backend down) does not,
 * and blocks on iOS URLSession's ~60s default. Nothing else covers that window:
 * `READY_TIMEOUT` in ReaderWebView is cleared the moment the bridge reports `ready`,
 * which happens BEFORE this runs. So without this, a book whose bytes are already on
 * the device sits behind "Opening title…" for a minute with no error and no way to
 * tell it from a slow decrypt.
 *
 * 20s: comfortably above the worst measured warm open (~5s for a 20 MB book, ~93% of
 * it Encryption's decrypt) with room for a cold read and the access check, and well
 * under the platform timeout it exists to pre-empt.
 *
 * WHAT THIS DOES NOT DO, and the distinction matters: it does not CANCEL anything.
 * There is no cancellation to propagate — `fetch` here takes no signal and
 * `getBook`'s decrypt is not interruptible. This bounds what the READER WAITS FOR,
 * not what the system does. The work continues, and the consequences are recorded on
 * `withOpenTimeout` below.
 */
const OPEN_TIMEOUT_MS = 20_000;

/**
 * How many times the initial-target flush (see `pendingInitialVerifyRef`) will resend a `goTo` that
 * landed somewhere else, before giving up. MORE THAN ONE, DELIBERATELY: there are at least two
 * INDEPENDENT sources of the race this guards against — a resize mid-render, and a geometry-changing
 * `applyAppearance` arriving in the same narrow window and reanchoring to the book's stale start
 * position (Trigger C, `useAppearanceEnv`, can resolve asynchronously shortly after mount). On a
 * slow device or a genuinely bursty resize storm (the transition animation firing several layout
 * passes, each one a fresh chance to race), TWO is not always enough headroom either — raised from 3
 * to 8 after on-device reports of the badge landing wrong more often than a 3-attempt budget could
 * explain. Still bounded, not unbounded: every attempt here is provoked by a REAL WebView event
 * (never a tight self-driven loop), and it is abandoned the instant the reader takes over navigation
 * itself (`goTo`/`selectBookmark`/`prev`/`next` all clear `pendingInitialVerifyRef`) — so a generous
 * budget only ever spends itself racing the open, never fighting a deliberate page turn.
 */
const MAX_INITIAL_TARGET_RESENDS = 8;

/**
 * Raised only by `withOpenTimeout`. A distinct class rather than a flag on Error so
 * the catch below can tell "we stopped waiting" from "the open failed" without
 * matching on a message string.
 */
class OpenTimedOut extends Error {
  constructor() {
    super(`The byte path did not settle within ${OPEN_TIMEOUT_MS}ms.`);
    this.name = 'OpenTimedOut';
  }
}

/**
 * Resolve with `work`, or reject with OpenTimedOut once OPEN_TIMEOUT_MS has passed.
 *
 * `work.then(...)` IS THE POINT OF THIS SHAPE, not `Promise.race`. Handlers are
 * attached to `work` unconditionally and stay attached after the timeout has already
 * rejected, so when the abandoned open finally settles — and it will, minutes later
 * if the platform is waiting on a socket — a rejection has somewhere to go. A
 * `Promise.race` would leave that late rejection unhandled, which in React Native
 * surfaces as a redbox in dev pointing at code that gave up long ago.
 *
 * TWO CONSEQUENCES OF NOT CANCELLING, both deliberate:
 *  1. The decrypt finishes into nothing. A ~27 MB base64 string is built and dropped
 *     for a book nobody is reading. It is garbage after that; the peak, however, is
 *     real while it happens.
 *  2. The ContentStore session opens anyway, so the plaintext is resident even though
 *     the reader saw an error. `closeBook` on unmount is what reclaims it — the same
 *     teardown as a normal read. Calling closeBook here instead was considered and
 *     rejected: the decrypt may not have created the session yet, so a close would
 *     be a no-op and the session would then appear behind it, leaving the plaintext
 *     resident with nothing left to release it.
 */
function withOpenTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new OpenTimedOut());
    }, OPEN_TIMEOUT_MS);

    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause: unknown) => {
        clearTimeout(timer);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
  });
}

/**
 * The name the dyslexia face is declared under, in BOTH the `@font-face` rule and the `body` rule
 * `baselineCss` builds. It has to pass `sanitizeFontFamily`'s `/^[A-Za-z0-9 ,-]*$/` allow-list —
 * this does, unquoted — or the shell would drop it and render the fallback with no sign why.
 */
const DYSLEXIA_FONT_FAMILY = 'OpenDyslexic';

/**
 * `accessibility.text.dyslexiaFont` applied to the two font fields.
 *
 * SPLIT INTO A PREDICATE AND AN ASYNC APPLY, rather than one async function that early-returns.
 * `await`ing a function costs a microtask hop even when it does nothing, and this runs on EVERY
 * appearance apply — every prefs write and every OS appearance tick, for every reader, whether or
 * not the preference is on. The gate is still named once; `buildAppearanceWithFont` asks before it
 * awaits, so the common path costs nothing.
 *
 * >>> IT WINS OUTRIGHT OVER `font.family`, AND ONLY EPUB CAN HONOUR IT. <<<
 * The two cannot compose — there is one `@font-face` and one `font-family` — so this is a
 * precedence decision, not a merge, and it goes to the accessibility need for the same reason
 * `a11yFlowOverride` overrules `layout.flow`. `readerAnnouncements.ts` already encodes the same
 * ranking: it checks `dyslexiaFont` BEFORE `fontFamily`, so one toggle says "Dyslexia-friendly font
 * on" rather than "Font: OpenDyslexic". Changing the precedence here without changing that order
 * makes the reader announce the mechanism instead of the setting.
 *
 * >>> THE FAMILY IS SET, NOT JUST THE URI. <<< `baselineCss` emits `@font-face` only when BOTH are
 * non-empty, and `appearanceCssOptions()` drops a URI with no family to attach it to — so bytes
 * alone are inert.
 *
 * >>> AND THE FORMAT GATE IS NOT REDUNDANT WITH THE PANEL HIDING ITS OWN ROW. <<< The preference is
 * one per user, not one per book, so a `true` stored while reading an EPUB still arrives on a PDF's
 * payload. pdf.js rasterises pages and has no text CSS layer to override, so honouring it there
 * would buy nothing and cost ~330 KB of base64 on the bridge for every preference change.
 *
 * BEST-EFFORT, and that is the whole reason this is a separate function with its own `try`. Unlike
 * `loadFontFaceSrc`, `loadDyslexiaFontFaceSrc` CAN reject — it is two native calls. Letting that
 * reject escape would abort `buildAppearanceWithFont` inside `applyAppearanceWith`'s single catch,
 * and the WebView would then be sent NO appearance at all: no theme, no text size, no margins, no
 * flow, no announce gates. Losing one font is the correct failure; losing every preference is not.
 */
function wantsDyslexiaFont(
  resolved: ReaderAppearance,
  format: ContentFormat | null,
): boolean {
  return resolved.dyslexiaFont && format === 'EPUB';
}

async function withDyslexiaFont(resolved: ReaderAppearance): Promise<ReaderAppearance> {
  try {
    return {
      ...resolved,
      fontFamily: DYSLEXIA_FONT_FAMILY,
      customFontUri: await loadDyslexiaFontFaceSrc(),
    };
  } catch (cause) {
    console.warn('ReaderScreen: could not load the dyslexia font', cause);
    return resolved;
  }
}

/**
 * `accessibility.display.highContrast` applied to the three colours, or `resolved` untouched.
 *
 * The recipe itself is `highContrastColors.ts`'s (Hruthik's) — `readerAppearance.ts` leaves it
 * unspecified on purpose and `THEME_PALETTES` says so in as many words. This is only the wiring.
 *
 * >>> THE SCHEME STILL CHOOSES THE PAIR. <<< `highContrast` is deliberately independent of colour
 * scheme (dark + high contrast is a valid combination the deprecated `theme: 'highContrast'` could
 * not express), so the resolved scheme is passed through rather than collapsed to one palette.
 *
 * SPREADS RATHER THAN MUTATES, and that is load-bearing: `a11yFlowOverride` returns its input BY
 * REFERENCE when nothing changes, so editing `resolved` in place would also edit the object
 * `lastAppearanceRef` is holding — and `appearanceChangeAnnouncement` diffs against exactly that,
 * so the change would announce nothing.
 */
function withHighContrast(resolved: ReaderAppearance): ReaderAppearance {
  if (!resolved.highContrast) return resolved;
  return { ...resolved, ...getHighContrastReaderColors(resolved.colorScheme) };
}

/**
 * `toReaderAppearance`'s own `customFontUri` is a straight passthrough of `FontPrefs.customFontUri`
 * — a separate, still-unused upload-path field (see readerAppearance.ts). This overlays it with the
 * loaded bundled-font data URI for `prefs.font.family` instead (or `null` for `'system'`/unknown) —
 * Reader's chosen meaning for this field on the bridge, per CUSTOM_FONTS_WIRING.md. Both send sites
 * below (open/OS-change via `applyAppearanceWith`, and the prefs-subscribe re-apply) go through this
 * one function so neither can drift from the other. `loadFontFaceSrc` never throws.
 *
 * >>> THE THREE OVERRIDES BELOW ARE ORDERED, NOT INTERCHANGEABLE. <<< The dyslexia face replaces
 * whatever the bundled-font load just produced, so it has to run after it; the contrast recipe and
 * the flow override touch disjoint fields (colours vs. flow/spread) and so cannot collide, but
 * `a11yFlowOverride` stays outermost because it is documented as the last word on the payload.
 *
 * >>> NONE OF THEM ADDS A `ReaderAppearance` FIELD, AND THAT IS THE POINT. <<< Every one resolves
 * into a field that already exists, so `epubLayoutSignature.ts`'s classification does not move and
 * neither shell needs a line changed: the dyslexia face travels as `fontFamily`/`customFontUri`
 * (both already GeometryKey, so highlights re-measure for it for free) and the contrast pair as
 * `fg`/`bg`/`link`. Applying either INSIDE a shell instead would cost the whole nine-step new-field
 * checklist and would have to reclassify the key.
 */
async function buildAppearanceWithFont(
  prefs: SharedPrefs,
  env: AppearanceEnv,
  screenReaderEnabled: boolean,
  format: ContentFormat | null,
): Promise<ReaderAppearance> {
  const fontFaceSrc = await loadFontFaceSrc(prefs.font.family);
  const resolved: ReaderAppearance = {
    ...toReaderAppearance(prefs, env),
    customFontUri: fontFaceSrc,
  };
  // THE ONE PLACE THE READER OVERRULES A STORED PREFERENCE, and it is here rather than in
  // `toReaderAppearance` on purpose: that function is Personalization's, it RESOLVES prefs into
  // primitives, and whether a screen reader is running is not a preference to resolve. Its own
  // header says the apply-time meaning of these fields is Reader's. See readerA11yLayout.ts for
  // why paginated flow makes the book unreachable to TalkBack, and `flowOverrideActive` below for
  // the notice that stops this being a silent change. The same reasoning is what puts the dyslexia
  // and contrast overrides here rather than in `toReaderAppearance`.
  const withFace = wantsDyslexiaFont(resolved, format) ? await withDyslexiaFont(resolved) : resolved;
  return a11yFlowOverride(withHighContrast(withFace), screenReaderEnabled);
}

/**
 * ANNOTATION FAILURES — why the seven highlight/bookmark call-sites below carry handlers at all.
 *
 * `readerHighlights.ts` and `readerBookmarks.ts` write local-first: straight to SQLite via the
 * offline store, which enqueues the sync outbox in the same transaction, then nudge a sync. So a
 * write is durable the moment it returns and reaches the backend later on a drain — the edit never
 * depends on the network being up, and `annotationDurability.test.ts` pins that.
 *
 * WHICH MEANS A REJECTION HERE IS A LOCAL-STORE FAILURE, NOT A CONNECTIVITY ONE, and the copy below
 * says so. There is nothing to fall back to when SQLite itself refuses the write — the most these
 * handlers can do is make the failure visible instead of silent, and telling the user to check their
 * connection would send them after the wrong thing.
 *
 * Reads and writes get different answers because the cost is different:
 *
 *   READ  — nothing is lost. The panel stays empty and the next open retries, so a warning is the
 *           right weight; an Alert on every failed open would be unusable.
 *   WRITE — the edit did not persist, and nothing else on screen shows the user that, so it is said
 *           with an Alert. That is still the right weight even though the write is local: "saved"
 *           and "silently not saved" are indistinguishable on screen, which is the whole reason.
 *
 * `Alert.alert` for the same reason the layout notice above uses it: it is this app's idiom for
 * "something changed out from under you", and being native it is announced by a screen reader
 * without any work here.
 */
function warnAnnotationReadFailed(what: 'highlights' | 'bookmarks', cause: unknown): void {
  console.warn(`ReaderScreen: could not load ${what}`, cause);
}

/**
 * `title`/`body` rather than one operation enum: a failed ADD loses the edit, while a failed DELETE
 * leaves the row exactly where it was. Same handler, genuinely different thing to tell the user.
 */
function alertAnnotationWriteFailed(title: string, body: string, cause: unknown): void {
  console.warn(`ReaderScreen: ${title}`, cause);
  Alert.alert(title, body, [{ text: 'OK', style: 'default' }]);
}

/**
 * The one thing a caller may need to reach into this screen for from the outside: pausing an
 * active TTS session before doing something that needs the on-screen position to hold still (a
 * cross-device conflict prompt, currently the only caller — `ReaderRouteScreen.tsx`). Everything
 * else about the TTS session (`status`, `play`, `stop`, prefs) stays exactly where it already was,
 * internal to this file — this is a narrow, single-purpose escape hatch, not a general TTS
 * remote-control surface for this component.
 */
export interface ReaderScreenHandle {
  /** No-ops (and returns `false`) if TTS isn't currently speaking. Returns `true` if it paused. */
  pauseTtsIfSpeaking(): boolean;
}

interface ReaderScreenProps {
  /**
   * Identifies the ContentStore session `getBook(bookId)` opens and
   * `closeBook(bookId)` wipes.
   *
   * REQUIRED, deliberately: while it was optional the teardown effect below hit
   * an early return and never ran, so the "wipe on close" guarantee was dead
   * code. Making it required is what keeps that from silently regressing.
   *
   * >>> CALLERS MUST KEY THIS COMPONENT ON bookId: <ReaderScreen key={id} bookId={id} /> <<<
   * EVERY piece of state below belongs to one book — the resolved format, the shell URI,
   * the command sender, the TOC, the error banner. There is nothing worth carrying from
   * one book to the next, and carrying it is actively wrong: a stale `format` would send
   * `openEpub` to a PDF shell (which defines only `openPdf`, so it answers NOT_READY),
   * and a stale `toc` would list the previous book's chapters under the new one's
   * Contents button. Remounting resets all of it in one move, which is why this is a key
   * rather than a pile of resets in the effect below — React forbids those anyway
   * (`react-hooks/set-state-in-effect`), and it is the wrong idiom for "reset on prop
   * change". `src/navigation/RootNavigator.tsx` has now landed, and a navigator gives each route
   * its own instance for free on a genuinely new push — `ReaderRouteScreen.tsx` still passes this
   * key explicitly as defense-in-depth (a `navigate('Reader', ...)` to an already-mounted Reader
   * screen would otherwise reuse the instance rather than remount it).
   */
  bookId: BookId;

  /**
   * Where to `goTo` once, right after this open's first `rendered` — the resume half of reading
   * progress. Read ONCE, at mount: this component is already keyed on `bookId` (see above), so a
   * genuinely new target means a remount, not a prop change on a live instance. Omit it and the
   * book opens at its normal default location, same as before this prop existed.
   *
   * NOT this component's concern to source or persist — same division as `onRelocated` below. A
   * caller (`ReaderRouteScreen.tsx`) reads it from `progressStore.currentLocator()` and converts it
   * via `readerProgressStore.ts`'s `targetFromLocator`; this file just knows how to seek once,
   * having no opinion on where the target came from.
   */
  initialTarget?: ReaderTarget;

  /**
   * Mirrors every `relocated` position outward, so a caller can persist it without this component
   * knowing where or how. Fired from the SAME `relocated` branch that already updates local
   * `position` state — additive, not a second subscription.
   */
  onRelocated?: (position: ReaderPosition) => void;

  /**
   * Fired once, from `tearDownAndLock`, the moment this book's access ends while it is
   * open — a `content.lock` push (Sync's offline advisory) or `startAccessMonitor`'s own
   * poll finding an explicit, fail-closed denial (see that module's own doc comment).
   *
   * ADDITIVE TO THE INLINE `lockedState` BANNER BELOW, NOT A REPLACEMENT FOR IT. The banner
   * stays the source of truth for "why is there nothing here" if a caller ignores this or
   * navigation is for some reason delayed; this is only the louder, modal half a reader
   * expects for something as consequential as losing a book mid-read — CONVENTIONS-alike
   * to `ReaderRouteScreen.tsx`'s own cross-device-conflict `Alert.alert`, which this
   * mirrors rather than invents a second idiom for.
   *
   * NOT THIS COMPONENT'S CONCERN TO SHOW THE ALERT OR NAVIGATE, same division `onRelocated`
   * already draws: this file has no `navigation` prop and no business acquiring one just for
   * a single dialog. `ReaderRouteScreen.tsx` owns both.
   */
  onLocked?: (code: ReaderErrorCode, message: string) => void;

  /**
   * Rendered as the LAST child of the toolbar row (after Search and, when shown, TTS), so it lands
   * rightmost — nearest the screen edge — with the built-in icons to its left, all in one row.
   *
   * A slot rather than this file importing `DevPreferencesMenu` directly: that component is
   * `ReaderRouteScreen.tsx`'s temp scaffolding, not this screen's concern (see its own header
   * note). It used to float as an absolutely-positioned overlay from that caller instead, which put
   * it on TOP of this exact row rather than IN it — sharing the row's own flex layout is what
   * guarantees the two can never overlap, on any format, without either file hard-coding the
   * other's width.
   */
  toolbarExtra?: React.ReactNode;

  /**
   * Opens the publisher accessibility-metadata screen (`BookInfo`). Navigation-agnostic on the
   * same grounds as `onRelocated`: this file has no idea a route named "BookInfo" exists, only that
   * pressing "Accessibility information" inside the merged Accessibility dropdown should do
   * something. `ReaderRouteScreen.tsx` supplies `() => navigation.navigate('BookInfo', { bookId })`.
   * Omit it and that row still renders but does nothing — there is no standalone screen for it to
   * fall back to.
   */
  onOpenAccessibilityInfo?: () => void;
}

function ReaderScreenComponent(
  {
    bookId,
    initialTarget,
    onRelocated,
    onLocked,
    toolbarExtra,
    onOpenAccessibilityInfo,
  }: ReaderScreenProps,
  ref: React.ForwardedRef<ReaderScreenHandle>,
): React.JSX.Element {
  /**
   * The book's format and its matching shell — TAGGED WITH THE bookId THEY BELONG TO,
   * and set as ONE value so they can never disagree.
   *
   * Two reasons for the shape. First, atomicity: `format` picks the open command and
   * `htmlUri` picks the shell that implements it, so a render where one had updated and
   * the other had not would send `openEpub` to a PDF shell — which defines only
   * `openPdf` and answers NOT_READY.
   *
   * Second, the tag makes a stale value IMPOSSIBLE TO READ rather than merely unlikely.
   * Callers are told to key this component on bookId (see the prop doc), but a caller
   * that forgets would otherwise keep the previous book's renderer and open the wrong
   * one silently. Comparing the tag below costs nothing and turns that into a
   * guaranteed miss instead. Resetting in an effect would be the other way to do it,
   * and it is both the wrong idiom for "reset on prop change" and forbidden by
   * `react-hooks/set-state-in-effect`.
   */
  const [resolved, setResolved] = useState<{
    bookId: BookId;
    format: ContentFormat;
    htmlUri: string;
  } | null>(null);

  const current = resolved?.bookId === bookId ? resolved : null;
  const format = current?.format ?? null;
  const htmlUri = current?.htmlUri ?? null;

  const [send, setSend] = useState<((command: ReaderCommand) => void) | null>(null);
  const [toc, setToc] = useState<ReaderTocItem[]>([]);

  /**
   * Where the reader is, as last reported.
   *
   * NOT PERSISTED HERE, deliberately. `progressStore.savePosition()` (Sync's side) now IS wired up —
   * from `ReaderRouteScreen.tsx`'s `onRelocated` handler, via `readerProgressStore.ts`'s
   * conversions — but the write policy (throttling, unmount/backgrounding flush, what wins on
   * conflict) belongs to that caller, not to this component. Surfacing the position is Reader's
   * half; deciding when to store it is not, and doing both here would prejudge that for every caller.
   */
  const [position, setPosition] = useState<ReaderPosition | null>(null);

  /**
   * The edges of the current position, as last reported on `relocated` — carried separately from
   * `position` because both shells send them on every relocation regardless of format, where
   * `position` itself is discriminated. Used to disable Prev/Next at the ends: `next`/`prev` already
   * no-op at a boundary WebView-side (both entries clamp against it), so this is a UI-only
   * refinement — no behavior changes if it is wrong, only whether the button LOOKS tappable.
   *
   * Defaults to `atStart: true` because that is what "nothing has relocated yet" actually means —
   * the book opens on its first page/CFI, so Prev is correctly disabled before the first
   * `relocated` ever arrives, matching `send === null`'s own disablement over the same window.
   */
  const [bounds, setBounds] = useState({ atStart: true, atEnd: false });

  /**
   * The page-jump field: null when closed, the typed text when open.
   *
   * A STRING, not a number, and deliberately: the field has to be able to hold '' while the user
   * clears it and '1' on the way to '12', neither of which is a page. Parsing happens on submit.
   */
  const [pageJump, setPageJump] = useState<string | null>(null);
  const [showToc, setShowToc] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showAccessibility, setShowAccessibility] = useState(false);

  // Live (updates across a rotation while the dropdown is open, unlike a one-off `Dimensions.get`)
  // — bounds the Accessibility dropdown's ScrollView so it stays scrollable rather than growing
  // past the screen, which the panel's own toggle rows can do on a small phone in landscape.
  // `width` rides along on the same reactive hook so the height ratio below can branch on window
  // size too, rather than only reacting to height.
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const isAccessibilityDropdownCompactWidth = windowWidth < ACCESSIBILITY_DROPDOWN_COMPACT_MAX_WIDTH;

  /**
   * Whether ANY panel is covering the book. Drives the two-prop "hide from assistive tech" pair on
   * the background — the toolbar, the WebView container, the bottom row, and the two on-page badges.
   *
   * A panel is an absolute overlay, so sighted users already cannot reach what is behind it; without
   * this a screen reader still can, and swiping past the last row of the TOC walks straight into the
   * book text underneath. The panels themselves are siblings of the WebView inside `viewer`, which
   * is why this is a flag applied to several nodes rather than one wrapper around them — see
   * `ReaderWebView`'s `hidden` prop for why reparenting is not an option here.
   */
  const anyPanelOpen = showToc || showSearch || showBookmarks || showAccessibility;

  /**
   * The bottom row is hidden on a NARROWER condition than the rest of the background, and the
   * difference is not an oversight.
   *
   * Search, Bookmarks and Accessibility each carry their own close button inside the panel ("Close
   * search", "Close bookmarks", "Close accessibility"), so once one is open the row behind it is
   * pure background. **Contents does not.** Its close affordance is the Contents button in this very
   * row — the one whose label flips to "Close contents" while the panel is open. Hiding the row
   * along with everything else left a screen-reader user inside the TOC with no reachable way out of
   * it: every route back was a control that had just been removed from the focus order.
   *
   * Caught by `ReaderScreen.test.tsx`'s existing mutual-exclusion tests, which could no longer find
   * the Contents button. They were right to fail.
   */
  const controlsHidden = showSearch || showBookmarks || showAccessibility;

  /**
   * The bookmarks panel's own state — loaded once, after the first `rendered`, then kept current by
   * every add/remove call-site's returned fresh set (readerBookmarks.ts's own contract: each call
   * returns the authoritative full set, so this never needs to merge a delta in by hand).
   *
   * `bookmarksLoaded` distinguishes "still reading from storage" from "read storage and it's empty" —
   * without it, the panel would flash "No bookmarks yet" before the real list arrives.
   */
  const [bookmarks, setBookmarks] = useState<ReaderBookmark[]>([]);
  const [bookmarksLoaded, setBookmarksLoaded] = useState(false);
  const [skippedBookmarkCount, setSkippedBookmarkCount] = useState(0);


  /**
   * The user's saved highlights for this book, split per shell, plus how many stored rows could not
   * be made paintable.
   *
   * Held so the SAME set can be re-sent after a re-open (`send` transitions null -> non-null once,
   * but a WebView reload would give a second `rendered`), and so the count has somewhere to live.
   * `readerHighlights.ts`'s call-sites each return the fresh, full, authoritative set, so this is
   * only ever replaced wholesale — never merged into.
   */
  const [highlights, setHighlights] = useState<ReaderHighlights>({ epub: [], pdf: [] });
  const [skippedHighlightCount, setSkippedHighlightCount] = useState(0);

  /**
   * WHICH search match the shell said it could not pinpoint — not WHETHER it said so.
   *
   * SURFACED RATHER THAN LOGGED, on the same reasoning as `skippedHighlightCount` above: the
   * `goTo` that precedes every paint has already succeeded, so a match that never painted looks
   * exactly like one that painted off screen, and the reader is left hunting for a word they were
   * told is on the page.
   *
   * >>> A KEY RATHER THAN A BOOLEAN, SO THE NOTICE CANNOT OUTLIVE ITS MATCH. <<< The obvious shape
   * is a boolean cleared from the send effect — which is a `setState` in an effect body, the thing
   * `react-hooks/set-state-in-effect` refuses and `useBookSearch`'s own note already records losing
   * an argument with. Stamping the match the failure was ABOUT needs no retraction: the render
   * compares it against the current match, so stepping to the next hit hides it, and a reply that
   * arrives after the reader has already moved on stamps a key nothing is showing.
   */
  const [unpaintedMatchKey, setUnpaintedMatchKey] = useState<string | null>(null);

  /**
   * TTS is EPUB-only (readerTextProvider.ts's segmentation model is CFI-based) and gated on
   * Accessibility's one exported boolean — `useTtsEnabled()` is deliberately the ONLY check;
   * `useTtsSession`'s `play()` does not re-check it, on the grounds that mounting the controls IS
   * the decision (see TTS_PROVIDER.md's "one boolean that crosses" section).
   *
   * A `useMemo`, not state-in-an-effect — same reasoning as `panResponder` below: constructing a
   * provider has no side effect of its own (it sends nothing until a method is called), so it can
   * be recomputed as a plain function of its deps rather than pushed through setState.
   */
  const ttsEnabled = useTtsEnabled();
  const ttsProvider = useMemo<EpubReaderTextProvider | null>(() => {
    if (!ttsEnabled || format !== 'EPUB' || send === null) return null;
    return createEpubReaderTextProvider(bookId, send);
  }, [bookId, format, send, ttsEnabled]);

  /**
   * `handleMessage` and the closeBook effect below reach for THIS, not `ttsProvider` directly — a
   * ref because neither needs a re-render when it changes, only the latest value at the moment a
   * message or teardown arrives. Kept in sync via the same ref-mirroring pattern `appearanceEnvRef`
   * already uses in this file.
   */
  const ttsProviderRef = useRef(ttsProvider);
  useEffect(() => {
    ttsProviderRef.current = ttsProvider;
  }, [ttsProvider]);

  // NULL UNTIL TTS IS ACTUALLY ON. `useTtsSession` cannot be called conditionally (Rules of Hooks),
  // so it is always called — and it does nothing at all with a null provider. It used to be handed
  // an inert stand-in instead, which set up a whole session (engine listeners, AppState, a prefs
  // read) that could never speak, then tore it down and set up a second one the moment the real
  // provider arrived.
  const ttsSession = useTtsSession(ttsProvider);

  /**
   * THE PREFERENCE IS THE SWITCH. There is no in-reader button that opens this panel: turning TTS
   * on in the preferences menu is what puts the transport on screen, and turning it off is what
   * takes it away (and stops speech — see `useTtsEnabled`). A speaker button in the toolbar was a
   * SECOND control for a decision the preference already owns, and two switches for one mode is
   * how a user ends up with TTS "on" and no controls, or controls for a mode that is off.
   *
   * The panel REPLACES the page-navigation row rather than stacking above it. Both are transport
   * controls, and side by side the two Prev/Next pairs (page, and the match bar's) plus a
   * Play/Stop read as one undifferentiated bank of buttons — `SearchMatchBar.tsx`'s own note makes
   * the same point about the find bar's arrows.
   *
   * `ttsProvider` already carries every condition: the preference, `format === 'EPUB'`, and a live
   * bridge. Derived rather than mirrored into state, so nothing can disagree about whether the
   * panel is showing.
   */
  const ttsControlsVisible = ttsProvider !== null;

  /**
   * The layout half of prefs, mirrored into local state so the swipe overlay (paginated-only) and
   * `scrollEnabled` below can read it without an async round trip on every render.
   *
   * The TOGGLE UI for this lives in `DevPreferencesMenu.tsx` (the temp hamburger prefs menu, floated
   * over this screen's own body from `src/navigation/ReaderRouteScreen.tsx`) — this file only needs
   * to know the CURRENT value, not
   * offer a second way to set it. Seeded from DEFAULT_PREFS.layout until the initial `getPrefs()`
   * below resolves, and kept current by the SAME `prefsStore.subscribe` effect that already
   * re-sends `applyAppearance` (trigger B) — this is additive to that effect, not a second
   * subscription.
   */
  const [layoutPrefs, setLayoutPrefs] = useState<LayoutPrefs>(DEFAULT_PREFS.layout);

  /**
   * Whether `layoutPrefs` is the user's stored value yet, as opposed to the DEFAULT_PREFS fallback
   * it starts at. Distinguishes "still reading from storage" from "read storage and it says this",
   * exactly as `bookmarksLoaded` does above.
   *
   * IT EXISTS FOR THE OVERRIDE NOTICE, and the case it fixes is not hypothetical: the default flow
   * is `paginated`, so between mount and the seed effect below resolving, a user who chose SCROLLED
   * looks momentarily like a user who chose paginated — and the notice would tell them a preference
   * had been overridden when nothing had been. Caught by ReaderScreen.test.tsx.
   */
  const [layoutPrefsLoaded, setLayoutPrefsLoaded] = useState(false);
  const [isRendered, setIsRendered] = useState(false);
  const [error, setError] = useState<ReaderError | null>(null);

  // Search state lives ABOVE the panel, so closing and reopening it keeps the results
  // and the place you had reached in them.
  const search = useBookSearch(bookId);

  // Pulled out as its own binding so `tearDownAndLock` below can depend on THIS identifier
  // rather than on `search` itself — `search.clear` is stable (useBookSearch's own `useCallback`
  // chain), but `search` the wrapping object is a fresh literal every render, and putting the
  // whole object in a `useCallback` dependency array would recreate `tearDownAndLock` every
  // render for no reason (the same class of instability `ttsSessionRef` exists to route around).
  const clearSearch = search.clear;

  /**
   * Identifies the match a `searchMatchPainted` reply is about, so a stale reply cannot leave a
   * notice standing over a different one. The term is in it as well as the index because a new
   * search resets the index to -1 and can land back on 0 with entirely different hits.
   */
  const activeMatchKey = `${search.submittedTerm}#${String(search.activeIndex)}`;

  /**
   * A search hit selected while `send` was still null, queued rather than dropped.
   *
   * `selectHit` used to do `send?.({...})` unconditionally: if the WebView had not yet
   * reported `ready`, that optional-chained call was a silent no-op — the panel still
   * closed and the match bar still said "Match N of M" as if the jump had happened. A
   * ref rather than state because nothing needs to re-render off ITS value; `awaitingSeek`
   * below is the render-facing half.
   */
  const pendingSeekRef = useRef<ReaderTarget | null>(null);
  const [awaitingSeek, setAwaitingSeek] = useState(false);

  /**
   * The two toolbar/controls buttons that screen-reader focus is handed BACK to when the panel they
   * opened closes — without this, dismissing a panel leaves focus on an element that just unmounted
   * and the platform drops the user at the top of the screen.
   *
   * Only the panels whose close is a deliberate act have one. Bookmarks closes the same way and
   * could take another, but its own close path is not in this handoff's scope; add it when that item
   * comes round rather than guessing at the restore rule for it now.
   */
  const contentsButtonRef = useRef<View | null>(null);
  const searchButtonRef = useRef<View | null>(null);
  const accessibilityButtonRef = useRef<View | null>(null);

  /**
   * Where the merged Accessibility dropdown paints, in SCREEN coordinates — the same reason, and
   * the same shape, as `DevPreferencesMenu.tsx`'s own `anchor`: this panel now renders inside a
   * `Modal` rather than as an absolutely-positioned sibling of the ♿ button (see the Modal itself,
   * below, for why), and a `Modal`'s content positions against the whole screen, not against this
   * component's own toolbar row. MEASURED, NOT HARDCODED, via `measureInWindow` on open, so it
   * stays correct across phone/tablet widths and portrait/landscape. `null` until the first open —
   * `styles.accessibilityDropdown`'s own fallback position is fine either way, since no test
   * asserts on-screen pixel position.
   */
  const [accessibilityAnchor, setAccessibilityAnchor] = useState<{
    top: number;
    right: number;
    maxWidth: number;
  } | null>(null);

  /**
   * The MATCH BAR's counter button — where focus lands once a result is actually chosen. Item 6 of
   * `READER_FOCUS_ORDER_HANDOFF.md`. A ref into `SearchMatchBar`, not a prop it manages itself:
   * `SearchMatchBar` unmounts and remounts independently of a fresh selection (e.g. reopening the
   * results list from its own counter, then an explicit Close with nothing newly chosen), and a
   * component that outlives all of that is what lets `matchBarFocusSignal`'s effect (below) tell
   * "a genuine new bump" apart from "a stale value seen again on a fresh mount" — a comparison that
   * cannot be made correctly from inside the remounting component itself.
   */
  const matchBarCounterRef = useRef<View | null>(null);

  /**
   * A COUNTER, not a boolean or `showSearch` itself, because `selectHit` is also the target of
   * `stepHit` (the match bar's own Previous/Next arrows), which runs while the panel is ALREADY
   * closed and must NOT steal focus back to the counter on every step — that would yank a
   * screen-reader user off the arrow they are actively pressing. Bumped only at the two places
   * search genuinely CLOSES because of a selection (`selectHit`'s direct success path, and the
   * queued-seek flush effect below it).
   */
  const [matchBarFocusSignal, setMatchBarFocusSignal] = useState(0);

  // Fires only on a genuine bump — `ReaderScreen` itself never remounts, so comparing against the
  // previous render's value (React's default effect-dependency behavior) is reliable here in a way
  // it would not be inside `SearchMatchBar`. Deferred to an effect, not called inline in `selectHit`,
  // because the match bar is not mounted yet at the moment a result is tapped from the list — its
  // own render condition is `!showSearch`, which only flips true after that same event finishes
  // closing the panel. Same ordering `firstTocRowRef`'s entry effect relies on.
  useEffect(() => {
    if (matchBarFocusSignal > 0) focusOn(matchBarCounterRef);
  }, [matchBarFocusSignal]);

  /**
   * Where focus ENTERS the Contents panel — the first chapter row, and the counterpart to
   * `contentsButtonRef` above. See the effect next to `closeToc` for why it is the only entry ref
   * the panel needs and why it carries no `setTimeout`.
   *
   * Attached to the row at index 0 only. The rows are a `map`, so every other one gets `null`
   * rather than sharing this ref — a ref handed to N elements holds whichever mounted last, which
   * for a 40-chapter book would send focus to the bottom of a list the user has not scrolled.
   */
  const firstTocRowRef = useRef<View | null>(null);

  const cancelPendingSeek = useCallback((): void => {
    pendingSeekRef.current = null;
    setAwaitingSeek(false);
  }, []);

  /**
   * Which edges of the Contents list are currently faded.
   *
   * ONE STATE OBJECT OF TWO BOOLEANS, NOT THE SCROLL OFFSET. Keeping the offset in
   * state would re-render the whole panel — every row — on every scroll frame. These
   * flip at most twice per gesture, and setFades() below returns the previous object
   * unchanged when nothing flipped, so React bails out of the render entirely.
   */
  const [fades, setFades] = useState({ top: false, bottom: false });

  // Measurements behind the fades, in refs for the same reason: they are inputs to a
  // derived boolean, and nothing should re-render because a scroll offset moved.
  const listFrameRef = useRef(0);
  const listContentRef = useRef(0);
  const listOffsetRef = useRef(0);

  /**
   * Decide which edges get a fade from the three numbers above.
   *
   * Driven from THREE events, not just onScroll: a list too short to scroll never
   * emits a scroll event at all, so onLayout (frame) and onContentSizeChange (content)
   * are what stop a fade appearing over a list that has nothing hidden below it.
   */
  const recomputeFades = useCallback((): void => {
    const frame = listFrameRef.current;
    const content = listContentRef.current;
    const offset = listOffsetRef.current;
    const scrollable = content > frame + FADE_EPSILON_PX;

    const next = {
      top: scrollable && offset > FADE_EPSILON_PX,
      bottom: scrollable && offset + frame < content - FADE_EPSILON_PX,
    };

    setFades((prev) => (prev.top === next.top && prev.bottom === next.bottom ? prev : next));
  }, []);

  // The running periodic access re-check for the CURRENTLY OPEN book — started once
  // `getBookBase64` succeeds (readingAccessMonitor.ts's own doc comment on why it does not need an
  // immediate first tick), stopped by the same teardown effect that already calls closeBook(). A
  // ref, not state: nothing here should re-render off it, only read/replace the current handle.
  const accessMonitorRef = useRef<AccessMonitorHandle | null>(null);

  // When the `open` command was handed to injectJavaScript. A ref, not state: it is written on the
  // bridge path and read in the message handler, and re-rendering on it would perturb the very
  // interval being measured. `rendered - openSentAt` is the only view we get of bridge transfer +
  // atob + the charCodeAt loop + JSZip + epub.js, and it costs no change to the bridge itself.
  const openSentAtRef = useRef<number | null>(null);

  /**
   * The resume target, read ONCE at mount (lazy initialiser) — see `initialTarget`'s own prop doc
   * for why a prop change on a live instance is not a case this needs to handle. Cleared to null
   * once sent, so a second `rendered` (there is at most one per mount, but nothing enforces that
   * upstream) cannot re-seek.
   */
  const initialTargetRef = useRef<ReaderTarget | null>(initialTarget ?? null);

  /**
   * What the initial-target flush effect below just sent, so the first `relocated` after it can be
   * checked against what was actually requested — and resent, up to `MAX_INITIAL_TARGET_RESENDS`
   * times, if it doesn't match.
   *
   * WHY THIS EXISTS: both shells have a resize race that can silently override a `goTo` sent in the
   * first moments after `rendered`, while the screen's own push-transition is still resizing the
   * WebView's container. `pdf.entry.ts`'s `window.resize` handler re-renders whatever page was
   * "current" when it fires; if that fires before our goTo's render has finished updating it, the
   * resize's own render targets the stale pre-navigation page and wins the race (same `renderToken`
   * guard, later call). epub.js's OWN `Rendition.onResized` does the equivalent thing internally —
   * re-displaying `this.location` — which we cannot patch from here. Only the INITIAL flush needs
   * this: TOC/search/bookmark-panel taps happen well after open, in an already-settled viewport, so
   * they were never exposed to this race the way session-resume and a fresh bookmark-open are.
   *
   * Safe to compare exactly, not just "close enough": every value that ever reaches
   * `initialTargetRef` is already either an exact page number (`readerProgressStore.ts`'s
   * `targetFromLocator`, `readerBookmarks.ts`'s `toTarget`) or an exact CFI string — never a spine
   * href, which is the only case an exact compare would be the wrong question to ask.
   */
  const pendingInitialVerifyRef = useRef<{ target: ReaderTarget; attempts: number } | null>(null);

  /**
   * `onRelocated` mirrored into a ref for the same reason `appearanceEnvRef` is: `handleMessage`
   * below is memoised with an empty dep array (its identity must stay stable across the whole
   * lifetime — see its own note), so it reads the LATEST callback via a ref rather than closing over
   * a stale one. Synced every render, same pattern as `appearanceEnvRef`.
   */
  const onRelocatedRef = useRef(onRelocated);
  useEffect(() => {
    onRelocatedRef.current = onRelocated;
  });

  /** `send` mirrored into a ref for the same reason as `onRelocatedRef` right above — read inside
   * `handleMessage` (stable identity, empty dep array) to resend a mismatched initial target without
   * widening that callback's own deps. */
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  /**
   * Covers the rendered book while the app is not frontmost.
   *
   * NOT cosmetic — this closes a measured leak. iOS writes a full-screen capture of the app into
   * Library/SplashBoard/Snapshots/ when it backgrounds, to animate the app switcher. Verified on
   * 2026-08-13 by backgrounding with a 20 MB book open and decoding the resulting .ktx: it
   * contained fully legible body text, the page number and two figures. That is decrypted licensed
   * content at rest on disk, which is the one thing this feature must never produce — and it
   * bypasses every other control, because ContentStore is careful, the WebView is `incognito`, and
   * none of that matters when the window server photographs the screen.
   *
   * `inactive` matters as much as `background`: iOS snapshots during the inactive transition, so
   * gating on 'background' alone covers too late to be useful.
   *
   * Honest limitation: this is a race we usually win, not a guarantee. The real guarantee is
   * platform-level — Android has FLAG_SECURE (already a T4 dependency); iOS has no equivalent for
   * the switcher snapshot, so an opaque cover driven by AppState is the accepted mitigation.
   */
  const [isObscured, setIsObscured] = useState(false);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      setIsObscured(nextState !== 'active');

      // Pause the periodic access re-check while backgrounded — nobody is reading, and a timer
      // firing while the app can't render a fresh error banner would either be wasted or, worse,
      // resolve into a revocation the reader never sees delivered. Resuming restarts a FULL
      // interval (readingAccessMonitor.ts's own doc comment on why: not a resumed partial one) —
      // a book that was safe to read when it backgrounded does not need re-checking the instant
      // it returns to the foreground. A no-op before the monitor has started (ref still null).
      if (nextState === 'active') {
        accessMonitorRef.current?.resume();
      } else {
        accessMonitorRef.current?.pause();
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);

  const raiseError = useCallback((code: ReaderErrorCode, message: string): void => {
    setError({ code, message });
  }, []);

  /**
   * The OS half of `applyAppearance`'s inputs (color scheme, font scale, reduce motion).
   *
   * REF, NOT READ DIRECTLY, from `handleReady`'s closure: `handleReady` is memoised on
   * `[bookId, format, raiseError]` (see below) precisely so it does not change identity on every
   * appearance-env tick — `ReaderWebView` only reads its latest `onReady` via its own ref (see the
   * note there), so a stale env in the CLOSURE would matter even though a stale PROP would not.
   * Kept current by an effect with no dependency array, same pattern as `ReaderWebView`'s own
   * `onReadyRef`.
   */
  const appearanceEnv = useAppearanceEnv();
  const appearanceEnvRef = useRef(appearanceEnv);
  useEffect(() => {
    appearanceEnvRef.current = appearanceEnv;
  });

  /**
   * Live screen-reader state, and the user's answer to being told about the layout override.
   *
   * >>> WHY THE READER OVERRIDES `layout.flow` AT ALL <<<
   * epub.js paginates with a CSS multi-column strip that Android's WebView accessibility bridge
   * cannot compute usable bounds for — WEBVIEW_A11Y_SPIKE.md's F4/F6 recorded the whole book's text
   * present in the native accessibility tree at `bounds=[0,0][0,0]`, and TalkBack unable to reach a
   * single paragraph by any method tried. Scrolled flow is ordinary document flow and does not have
   * that problem. See readerA11yLayout.ts.
   *
   * >>> AND WHY IT IS NOT SILENT <<<
   * The user chose "Paginated". Overriding that without saying so is its own defect, however good
   * the reason, so `flowOverrideActive` drives a one-time notice with a way out — and while it is
   * in effect, DevPreferencesMenu disables and annotates its Flow/Spread rows so the explanation
   * stays reachable after the alert is gone.
   *
   * `overrideDeclined` IS SESSION-ONLY AND IN-MEMORY, deliberately. It is not written to prefs:
   * Reader does not own `accessibility.*`, and "ignore accessibility" is not a flag to persist by
   * accident. Module state, lasting only as long as this screen does — not written to disk and not
   * synced, unlike reading position, which now IS both (`progressStore`, via `ReaderRouteScreen.tsx`).
   * It is also the escape hatch if scrolled flow ever renders badly on some book.
   */
  const screenReaderEnabled = useScreenReaderEnabled();
  const overrideDeclined = useOverrideDeclined();

  // Reset on mount, so the choice is scoped to one reading session rather than to the app process:
  // reopening a book asks again, which is right for a decision whose point is to be reconsidered.
  // It lives in a module rather than in state here because `DevPreferencesMenu` has to read the
  // same value and is not this component's child — see a11yOverrideChoice.ts.
  useEffect(() => {
    setOverrideDeclined(false);
  }, []);

  /** What the appearance funnel and the RN half below are actually told. */
  const a11yLayoutEnabled = screenReaderEnabled && !overrideDeclined;

  /** True only while something was really taken from the user — false when they already chose
   * scrolled, because then nothing was overridden and there is nothing to explain. */
  const flowOverrideActive =
    layoutPrefsLoaded && flowOverrideApplied(layoutPrefs.flow, a11yLayoutEnabled);

  // Read from `applyAppearanceWith`'s closure, which is memoised on `[]` so it does not change
  // identity on every screen-reader tick — same reasoning as `appearanceEnvRef` above.
  const a11yLayoutEnabledRef = useRef(a11yLayoutEnabled);
  useEffect(() => {
    a11yLayoutEnabledRef.current = a11yLayoutEnabled;
  });

  /**
   * The open book's format, for the dyslexia override's EPUB gate.
   *
   * A REF FOR THE SAME REASON THE TWO ABOVE ARE: `applyAppearanceWith` is memoised on `[]`, and
   * `format` is null until `prepareBook` resolves. Reading it from the closure directly would pin
   * the funnel to `null` for the life of the screen, so a book opened as EPUB would never get the
   * dyslexia face. Trigger A runs after the format is known (`handleReady` cannot fire before the
   * shell for that format is mounted), and triggers B and C read whatever is current.
   */
  const formatRef = useRef(format);
  useEffect(() => {
    formatRef.current = format;
  });

  /**
   * The last appearance the WebView was actually sent, and the last position it reported.
   *
   * REFS, NOT STATE, and not because refs are cheaper: nothing renders from either, and state here
   * would re-render the whole screen on every OS appearance tick and every page turn. They exist so
   * an announcement can be built from a CHANGE — `readerAnnouncements.ts` returns null without a
   * previous value, which is what stops the reader narrating the act of opening a book.
   *
   * `lastAppearanceRef` is also how `announcePageChanges` becomes readable at `relocated` time.
   * Reader does not read `AccessibilityPrefs` (ACCESSIBILITY_ARCHITECTURE_MAP.md §2); the
   * preference arrives already resolved onto this payload, which is the sanctioned route.
   */
  const lastAppearanceRef = useRef<ReaderAppearance | null>(null);
  const lastPositionRef = useRef<ReaderPosition | null>(null);
  const lastSectionRef = useRef<ReaderSection | null>(null);

  /**
   * TTS's live status, mirrored for `handleMessage` and the appearance funnel.
   *
   * A REF RATHER THAN A DEPENDENCY, deliberately. `handleMessage`'s dep array is kept minimal on
   * purpose (see its own note); adding a value that changes on every utterance boundary would
   * rebuild the bridge's message handler several times a sentence. Nothing here renders from it.
   */
  const ttsStatusRef = useRef(ttsSession.status);
  useEffect(() => {
    ttsStatusRef.current = ttsSession.status;
  });

  /**
   * The WHOLE session object, mirrored the same way — not just `.status` above.
   *
   * `useTtsSession` returns a fresh object literal every render (no `useMemo`), so putting
   * `ttsSession` itself in an effect's dependency array re-runs that effect on every render —
   * and if the effect body calls `raiseError` (a `setState`), that is an infinite loop: render ->
   * effect -> setState -> render -> new `ttsSession` -> effect (dep changed) -> setState -> ...
   * `tearDownAndLock` below needs `ttsSession.stop()`, so it reads this ref instead of closing
   * over `ttsSession` directly, on the same reasoning `ttsStatusRef` already established.
   */
  const ttsSessionRef = useRef(ttsSession);
  useEffect(() => {
    ttsSessionRef.current = ttsSession;
  });

  // The one thing exposed outward — see `ReaderScreenHandle`'s own doc comment for why this is
  // narrow on purpose. Reads through `ttsSessionRef`, not `ttsSession` directly, for the same
  // reason `tearDownAndLock` does just above: closing over `ttsSession` itself would rebuild this
  // handle (and, via `useImperativeHandle`'s own contract, re-run it) on every render, since the
  // hook returns a fresh object each time — `ttsSessionRef` is already kept current for exactly
  // this kind of external, non-rendering read.
  useImperativeHandle(
    ref,
    () => ({
      pauseTtsIfSpeaking: () => {
        if (ttsSessionRef.current.status !== 'speaking') return false;
        ttsSessionRef.current.pause();
        return true;
      },
    }),
    [],
  );

  /**
   * The one reaction to "this book's access just ended, while it was open" — called from
   * `useContentLock`'s `onLock` callback below AND from `startAccessMonitor`'s ACCESS_REVOKED
   * callback inside `handleReady`. Same defect from two sources (a PUSH from Sync's bus, a POLL
   * from Download's monitor), one fix, so a future third source only has to call this too.
   *
   * REUSES THE EXISTING TEARDOWN rather than inventing a parallel one — every call here mirrors
   * a line the unmount effect above already makes, and every one of them is idempotent
   * (`stop()`: readingAccessMonitor.ts; `close()`: contentStore.ts early-returns on a missing
   * session), so this running now and the unmount effect running later, on the same book, costs
   * nothing extra.
   *
   * ALSO CLOSES THE OTHER BOOK-DERIVED SURFACES, not only the WebView: the TOC array and the
   * search hits are book text sitting in RN state (`SearchResult.snippet` is literal book text),
   * and an absolute-fill cover over the WebView alone would leave both live underneath it.
   * Bookmarks and Accessibility panels are deliberately NOT reset here — Bookmarks shows only
   * user-typed labels (falling back to a chapter id/page number, never book prose), and
   * Accessibility is settings UI with no book content in it at all — so there is nothing
   * sensitive in either to clear. Closing both anyway is simpler than special-casing which
   * panel to leave open next to a screen that is about to show nothing but a lock message.
   *
   * `setShowToc(false)` directly, NOT `closeToc(false)` — `closeToc` also restores
   * screen-reader focus to the Contents button, which is the wrong target here: the book is
   * gone and focus belongs on the locked-state banner that replaces it, not on a toolbar button
   * for a panel that no longer has anything to show.
   *
   * OWNS `lockedRef`/`locked` ITSELF, RATHER THAN READING THEM FROM `useContentLock` — a real
   * integration bug this fixed: the hook's own ref/state are wired ONLY to the bus, so the
   * ACCESS_REVOKED path (a POLL from `startAccessMonitor`, entirely separate from the bus) called
   * this function and raised the right error banner, but never flipped anything the WebView-gate
   * or the `handleReady` guards actually read — the WebView stayed mounted and rendering a
   * revoked book. Setting `lockedRef.current` HERE, synchronously, before anything else, is what
   * makes both sources authoritative through the one function that both of them call: a bus
   * signal reaches this via `useContentLock`'s `onLock` (itself called synchronously inside the
   * bus's own emit, so the ordering guarantee guards (a)/(b)/(c) below depend on is unchanged —
   * it is still one synchronous call stack from "signal observed" to "ref is true"), and a poll
   * reaches this directly from `startAccessMonitor`'s callback with no bus involved at all.
   *
   * DECLARED BEFORE `useContentLock` BELOW, DELIBERATELY — the compiler's manual-memoization
   * check rejects a forward reference to a `const` even though the runtime closure would resolve
   * it fine (the callback only ever runs later, once a lock actually arrives). Ordering this
   * ahead of the call that needs it is the fix, not a workaround.
   */
  const [locked, setLocked] = useState(false);
  const lockedRef = useRef(false);

  const tearDownAndLock = useCallback(
    (code: ReaderErrorCode, message: string): void => {
      // Re-entry guard: the bus push (`useContentLock`) and the poll (`startAccessMonitor`) can
      // both call this for the same revocation, per the class doc comment above — every other
      // line here already tolerates that (re-setting a ref, stopping an already-stopped monitor,
      // a caught `closeBook`), but `onLocked` is contracted to fire ONCE, so it alone needs the
      // guard the rest of this function doesn't.
      const alreadyLocked = lockedRef.current;
      lockedRef.current = true;
      setLocked(true);
      accessMonitorRef.current?.stop();
      accessMonitorRef.current = null;
      ttsSessionRef.current.stop();
      ttsProviderRef.current?.notifyClosed();
      setSend(null);
      setShowToc(false);
      setShowSearch(false);
      setShowBookmarks(false);
      setShowAccessibility(false);
      clearSearch();
      void closeBook(bookId).catch(() => {});
      raiseError(code, message);
      if (!alreadyLocked) onLocked?.(code, message);
    },
    [bookId, raiseError, clearSearch, onLocked],
  );

  /**
   * Sync's `content.lock` bus signal, for THIS open book. See CLAUDE.md's "Offline-lock gating
   * hook" section and readerLock.ts/useContentLock.ts for the seam.
   *
   * ONLY THE CALLBACK IS USED — the hook's own returned `lock`/`lockedRef` are not read here (see
   * the note above `tearDownAndLock`, which is this screen's single source of truth instead).
   * `useContentLock.test.ts` still pins the hook's own ref-timing guarantee at the unit level;
   * this callback is what carries it into this screen's teardown.
   *
   * THE CALLBACK, NOT A `useEffect([lock, ...])` WATCHING IT — `tearDownAndLock` calls
   * `raiseError`, a state setter, and this repo's `react-hooks/set-state-in-effect` rule refuses
   * a bare effect body that does that. Firing it from inside `useContentLock`'s own bus
   * subscription instead means the reaction is a direct consequence of the signal, the same shape
   * `startAccessMonitor`'s ACCESS_REVOKED callback already has. Safe to pass a fresh inline arrow
   * every render — `useContentLock` reads it from a ref at emit time (`OnContentLock`'s own doc).
   */
  useContentLock(bookId, (newLock) => {
    tearDownAndLock(newLock.code, newLock.message);
  });

  /**
   * The outline, for naming a chapter in an announcement.
   *
   * A REF FOR THE SAME REASON `ttsStatusRef` IS: `handleMessage` would otherwise have to depend on
   * `toc`, and `toc` is set BY `handleMessage` — a dependency on its own output rebuilds the handler
   * the moment the outline lands, mid-open.
   */
  const tocRef = useRef<ReaderTocItem[]>(toc);
  useEffect(() => {
    tocRef.current = toc;
  });

  /**
   * The notice. Fires at most once per mount, and only on a real override — re-resolving the same
   * appearance (trigger C fires on every OS appearance tick) must not re-alert.
   *
   * `Alert.alert` rather than an in-screen banner: it is the idiom this app already uses for
   * exactly this situation (DevPreferencesMenu's `warnScrolledDoubleSpreadConflict`, which tells
   * the user when a layout field was reset out from under them), and being native it is announced
   * by the screen reader that caused it without any work here.
   */
  const noticeShownRef = useRef(false);
  useEffect(() => {
    if (!flowOverrideActive || noticeShownRef.current) return;
    noticeShownRef.current = true;

    Alert.alert(
      'Layout changed for screen readers',
      'Page-by-page layout hides most of the book from VoiceOver and TalkBack, so this book is ' +
        'showing as one continuous scroll. Your saved layout preference has not been changed.',
      [
        { text: 'OK', style: 'default' },
        {
          text: 'Use pages anyway',
          style: 'cancel',
          onPress: () => {
            setOverrideDeclined(true);
          },
        },
      ],
    );
  }, [flowOverrideActive]);

  /**
   * Resolve the current prefs against `env` and send `applyAppearance` — the one seam both the
   * open-time send (trigger A) and the live re-apply effects below (triggers B/C) go through, so
   * "read prefs, resolve, send" is not duplicated three times.
   *
   * Best-effort: a failed prefs read must not block opening the book. The WebView already paints at
   * its DEFAULT_PREFS-derived baseline with no `applyAppearance` at all, which is exactly the
   * fallback this failure leaves it at.
   */
  const applyAppearanceWith = useCallback(
    async (
      sender: (command: ReaderCommand) => void,
      env = appearanceEnvRef.current,
      /** Trigger B already HAS the fresh record (`subscribe` hands it over); A and C do not. */
      record?: SharedPrefs,
    ): Promise<void> => {
      try {
        const prefs = record ?? (await prefsStore.getPrefs());
        const appearance = await buildAppearanceWithFont(
          prefs,
          env,
          a11yLayoutEnabledRef.current,
          formatRef.current,
        );
        sender({ type: 'applyAppearance', appearance });

        // Said AFTER the send, so what the reader hears cannot describe a change the renderer was
        // never told about. `appearanceChangeAnnouncement` diffs the RESOLVED payload — see its own
        // note for why that is what keeps trigger C's every-OS-tick re-send quiet.
        const said = appearanceChangeAnnouncement(lastAppearanceRef.current, appearance, {
          ttsSpeaking: ttsStatusRef.current === 'speaking',
        });
        lastAppearanceRef.current = appearance;
        if (said !== null) announce(said);
      } catch {
        // Best-effort — see the note above.
      }
    },
    [],
  );

  // Resolve the book's format and its matching shell before mounting the WebView.
  //
  // The `cancelled` flag is the standard unmount guard: without it, navigating
  // away mid-resolve sets state on an unmounted component. The `void` is now
  // REQUIRED, not stylistic — no-floating-promises is enabled for this directory
  // (see eslint.config.js) and removing it is a lint error. It marks "this
  // rejection is handled below" rather than "this promise was forgotten", and the
  // catch() is the only thing standing between an asset failure and a
  // permanently blank screen.
  //
  // FORMAT IS RESOLVED BEFORE THE WEBVIEW MOUNTS, and that ordering is forced by
  // there being one shell per format: the URI cannot be chosen without knowing which
  // renderer the book needs. The visible consequence is that a COLD seed now happens
  // before first paint rather than alongside it, so the very first open after install
  // shows the spinner slightly longer. The compensation is that READY_TIMEOUT's clock
  // starts when the WebView actually starts loading, which is what it was always
  // meant to measure.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const bookFormat = await prepareBook(bookId);
        // Same reasoning as `handleReady`'s guards below: a lock landing mid-resolve must not
        // let this book finish opening into a WebView that a moment later has to be torn back
        // down. `lockedRef`, not `cancelled` — a lock does not unmount this effect.
        if (cancelled || lockedRef.current) return;

        const uri = await getReaderHtmlUri(bookFormat);
        if (cancelled || lockedRef.current) return;

        // ONE setState, after BOTH are known — see the note on `resolved` above for why
        // a half-updated pair is the bug worth designing out.
        setResolved({ bookId, format: bookFormat, htmlUri: uri });
      } catch (cause) {
        if (cancelled || lockedRef.current) return;

        // A format with no renderer is not an asset failure — the asset is fine,
        // there just isn't one for this book. Reported under its own code so the
        // message can say something true instead of telling the reader to run a
        // build script.
        if (cause instanceof UnsupportedFormatError) {
          raiseError(
            'UNSUPPORTED_FORMAT',
            `This book is ${cause.format} content, which this reader cannot open yet. ` +
              `EPUB and PDF are supported.`,
          );
          return;
        }

        raiseError(
          'ASSET_LOAD_FAILED',
          `Could not prepare this book for reading. If the reader shell failed to resolve, ` +
            `run \`npm run reader:build-html\`. ` +
            `(${cause instanceof Error ? cause.message : String(cause)})`,
        );
      }
    })();

    return () => {
      cancelled = true;
    };
    // `lockedRef` is a stable object identity for the life of this component (its owner,
    // useContentLock, never recreates it) — listed to satisfy exhaustive-deps, not because
    // including it changes when this effect re-runs.
  }, [bookId, raiseError, lockedRef]);

  // LIFECYCLE, not optional — contentProvider.ts states it outright: closeBook()
  // MUST run when the reader view for a book closes, or the whole decrypted book
  // stays in RAM indefinitely.
  //
  // Its OWN effect keyed on [bookId], not folded into the htmlUri effect above,
  // so it also fires when the screen SWITCHES books rather than only on unmount.
  // Sharing that effect would tie teardown to `raiseError` and re-run it for
  // reasons unrelated to the session.
  //
  // Fire-and-forget with an explicit catch: React cleanups cannot be async, and a
  // rejected teardown must not surface as an unhandled rejection. There is also
  // nothing useful to show the user — the screen is already gone.
  useEffect(() => {
    return () => {
      // Stop the periodic access re-check FIRST — same reasoning as the TTS teardown right below:
      // once the session is closing, a tick that landed mid-teardown has nothing left to act on
      // (raiseError on an unmounting/switching screen), and closeBook() below is about to make the
      // whole question moot anyway. A no-op before the monitor ever started (ref still null).
      accessMonitorRef.current?.stop();
      accessMonitorRef.current = null;

      // BEFORE closeBook, same cleanup, so the ordering is guaranteed rather than dependent on
      // React's cross-effect cleanup order (which is not the same on an in-place book switch as on
      // a full unmount). A no-op while TTS was never active (ref is null).
      ttsProviderRef.current?.notifyClosed();

      void (async () => {
        try {
          await closeBook(bookId);
        } catch {
          // Teardown is best-effort: close() zeroes the session buffer itself, and
          // the screen has already unmounted, so there is no error state left to
          // render into.
        }
      })();
    };
  }, [bookId]);

  /**
   * Fires when the WebView reports `ready`. Only now is it safe to inject —
   * window.TFReader does not exist before this.
   *
   * setSend takes a FUNCTION because useState treats a function argument as a
   * lazy initialiser and would call it instead of storing it. Storing a callback
   * in state is exactly the case that trips on that.
   */
  const handleReady = useCallback(
    (sender: (command: ReaderCommand) => void): void => {
      setSend(() => sender);
      logEvent('ready');

      void (async () => {
        try {
          // Cannot be null in practice: the WebView is only rendered once `format`
          // is set (it is what chose the shell), and `ready` can only arrive from a
          // rendered WebView. Checked rather than asserted because a non-null
          // assertion here would be a promise the type system cannot keep.
          if (format === null) {
            raiseError(
              'UNSUPPORTED_FORMAT',
              'The reader became ready before its format was known.',
            );
            return;
          }

          // BEFORE the open command, not alongside it: PDF answers NOT_READY to anything sent
          // before open*, and EPUB's flow/spread only take effect if set before renderTo(). Awaited
          // (not fired-and-forgotten) so the order is guaranteed rather than merely likely — see
          // WEBVIEW_BRIDGE.md's "prefs-application design, as signed off".
          await applyAppearanceWith(sender);
          if (lockedRef.current) return; // (a) locked while appearance was being resolved/sent

          const base64 = await withOpenTimeout(getBookBase64(bookId, format));
          // (b) THE ONE THAT MATTERS. `base64` above may already be a fully valid decrypted
          // string by the time this line runs — zeroing the source buffer on lock does not
          // retroactively touch a copy `fromByteArray` already produced (readerAssets.ts). This
          // guard, not the buffer zeroing, is the only thing standing between a lock and a
          // decrypted book still reaching the WebView on the mid-open race.
          if (lockedRef.current) return;
          openSentAtRef.current = now();
          logEvent('open sent', { chars: base64.length, format });

          // Start re-verifying access on a timer NOW that the book has actually opened —
          // getBookBase64 above already ran the one-time open-time check (verifyReadingAccess),
          // this is what covers everything after it for as long as the book stays open. Stop any
          // prior monitor first: `handleReady` is a WebView `ready` handler, not a mount effect, so
          // nothing rules out a second `ready` (e.g. a WebView reload) firing before this screen
          // unmounts, and starting a second interval without stopping the first would leak it.
          accessMonitorRef.current?.stop();
          accessMonitorRef.current = startAccessMonitor(bookId, format, (failure) => {
            // Routed through the SAME reaction a `content.lock` push gets — a poll (this) and a
            // push (useContentLock) discovering the same kind of thing on different schedules is
            // one defect, not two, and `tearDownAndLock` is what stops the book after either.
            tearDownAndLock(
              'ACCESS_REVOKED',
              `Access to this book was revoked while reading: ${failure.code}. ` +
                `(${String(failure.cause ?? failure.message)})`,
            );
          });

          // EXHAUSTIVE ON PURPOSE. This switch is the entire seam where
          // ContentFormat becomes a bridge command, and the `never` default is what
          // makes adding a fourth ContentFormat member a COMPILE error here rather
          // than a book that silently opens in the wrong renderer. Do not replace it
          // with an if/else or a lookup table that has a fallback.
          switch (format) {
            case 'EPUB':
              sender({ type: 'openEpub', base64 });
              break;
            case 'PDF':
              sender({ type: 'openPdf', base64 });
              break;
            case 'AUDIO':
              // UNREACHABLE IN PRACTICE, TWICE OVER, AND KEPT ANYWAY — AUDIO PHASE 3.
              // getReaderHtmlUri already refused this format before any WebView could exist to be
              // ready (readerAssets.ts's READER_HTML_MODULES has no AUDIO entry), and — since
              // Phase 3 — BookListScreen's onPress now routes AUDIO to the AudioPlayer route at
              // tap time, so ReaderScreen never even mounts for an audio book on the path that
              // matters. This case is a deliberate BACKSTOP, not stale leftovers: the switch is
              // exhaustive on purpose (see the note above), and removing this arm would either
              // reintroduce a non-exhaustive switch or force a `never`-typed default to somehow
              // handle a real ContentFormat member. If some future caller ever DOES reach
              // ReaderScreen with an audio bookId (a hand-built deep link, a bug in a future
              // catalogue-driven routing decision), this is what stands between it and a blank
              // WebView instead of an explicit, understandable error.
              raiseError(
                'UNSUPPORTED_FORMAT',
                `This book is ${format} content, which this reader cannot open yet.`,
              );
              break;
            default: {
              const unhandled: never = format;
              throw new Error(`Unhandled ContentFormat: ${String(unhandled)}`);
            }
          }
        } catch (cause) {
          // (c) Don't overwrite CONTENT_LOCKED with CONTENT_LOAD_FAILED. A decrypt whose key was
          // destroyed mid-flight (by `contentStore.ts`'s own lock subscriber) rejects as
          // DECRYPTION_FAILED, and reporting that instead of the lock tells the reader their book
          // is corrupt when their access simply ended — `tearDownAndLock` already raised the
          // right error the moment `lockedRef` flipped, and this catch must leave it standing.
          if (lockedRef.current) return;

          if (cause instanceof OpenTimedOut) {
            raiseError(
              'CONTENT_LOAD_TIMEOUT',
              `Opening this book took longer than ${OPEN_TIMEOUT_MS / 1000}s and was given up on. ` +
                `The book's own bytes are already on this device, so this is usually the network: ` +
                `the per-open access check has no timeout of its own.`,
            );
            return;
          }

          // ContentFailure carries a typed ContentError discriminant (and the
          // bookId) that a bare message would throw away. Surfacing that code is
          // what lets "the licence expired" be told apart from "the ciphertext
          // was tampered with" on screen, which errors.ts requires be distinct
          // and explicit rather than one generic failure.
          // DownloadFailure (added 2026-08-14, verifyReadingAccess's per-open access re-check —
          // readerAssets.ts's getBookBase64) carries the same kind of typed `.code` ContentFailure
          // does, just from Download's own carrier (errors.ts) rather than Encryption's — checked
          // alongside it for the same reason: a bare message would throw away which access-
          // revocation code this was.
          raiseError(
            'CONTENT_LOAD_FAILED',
            cause instanceof ContentFailure
              ? `Could not open this book: ${cause.code}. (${String(cause.cause ?? cause.message)})`
              : cause instanceof DownloadFailure
                ? `Could not open this book: ${cause.code}. (${String(cause.cause ?? cause.message)})`
                : `Could not open this book. ` +
                  `(${cause instanceof Error ? cause.message : String(cause)})`,
          );
        }
      })();
    },
    // `lockedRef` is a stable object identity — see the note on the prepareBook effect's own
    // dependency array for why listing it does not change when this callback is rebuilt.
    [bookId, format, raiseError, applyAppearanceWith, tearDownAndLock, lockedRef],
  );

  /**
   * Trigger B (READER_PREFS_APPLICATION.md §5): a local prefs edit. `prefsStore.subscribe` hands
   * back the FRESH `SharedPrefs` record directly, so there is no `getPrefs()` round trip here —
   * unlike `applyAppearanceWith`, which reads it because trigger A/C have no record handed to them.
   *
   * `send === null` is checked inside the listener rather than skipped by not subscribing: `send`
   * transitions null -> non-null exactly once (see its own state comment), and the effect should
   * stay subscribed across that transition rather than resubscribing — same reasoning as the queued
   * search-seek effect below, which is keyed on `[send]` for the same class of problem.
   */
  useEffect(() => {
    return prefsStore.subscribe((freshPrefs) => {
      setLayoutPrefs(freshPrefs.layout);
      setLayoutPrefsLoaded(true);
      if (send === null) return;
      // Routed through the same funnel as triggers A and C rather than building the payload inline.
      // Four steps — resolve, override, send, announce — duplicated in two callbacks is four
      // chances for them to drift; `freshPrefs` is passed so this still costs no `getPrefs()` hop.
      void applyAppearanceWith(send, appearanceEnvRef.current, freshPrefs);
    });
  }, [send, applyAppearanceWith]);

  // Seed `layoutPrefs` once at mount — the subscribe effect above only fires on a SUBSEQUENT
  // savePrefs/resetPrefs, so without this the toggle and the swipe overlay would see the
  // DEFAULT_PREFS.layout fallback until the user's first edit, rather than their stored preference.
  useEffect(() => {
    let cancelled = false;
    void prefsStore.getPrefs().then((prefs) => {
      if (cancelled) return;
      setLayoutPrefs(prefs.layout);
      setLayoutPrefsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Trigger C (READER_PREFS_APPLICATION.md §5): an OS-level change (system dark mode, Dynamic Type,
   * Reduce Motion) — `useAppearanceEnv` re-renders this component with a new `env` whenever one of
   * those fires, and this effect is what turns that into a re-resolve-and-resend. Skipped while
   * `send` is null: trigger A already sends the FIRST appearance once `send` exists, so there is
   * nothing to re-apply until then.
   */
  useEffect(() => {
    if (send === null) return;
    void applyAppearanceWith(send, appearanceEnv);
    // `a11yLayoutEnabled` rides this same effect rather than getting its own: turning TalkBack on
    // inside an open book, and pressing "Use pages anyway", both need exactly what this already
    // does — re-resolve and re-send. A second effect would send the payload twice on any tick that
    // changed both.
  }, [send, appearanceEnv, a11yLayoutEnabled, applyAppearanceWith]);

  /**
   * Highlight what the reader just selected, in reply to `requestCurrentSelection`.
   *
   * No colour argument — highlights are single-colour by design, so plain last-write-wins behaves
   * as a union across devices (READER_HIGHLIGHTS_WIRING.md).
   *
   * Defined above `handleMessage`, which depends on this via its `useCallback` array.
   */
  const createHighlightFromSelection = useCallback(
    (selection: ReaderSelection): Promise<void> => {
      const add =
        selection.kind === 'cfiRange'
          ? addEpubHighlight(bookId, selection.startCfi, selection.endCfi)
          : addPdfHighlight(bookId, {
              page: selection.page,
              startOffset: selection.startOffset,
              endOffset: selection.endOffset,
            });

      return add
        .then(({ highlights: fresh, skippedIds }) => {
          setHighlights(fresh);
          setSkippedHighlightCount(skippedIds.length);
        })
        .catch((cause: unknown) => {
          // The selection is already gone — the WebView cleared it when the menu item fired — so
          // there is nothing left on screen to show the user what they lost.
          alertAnnotationWriteFailed(
            'Highlight not saved',
            'This highlight could not be saved to this device and has not been kept.',
            cause,
          );
        });
    },
    [bookId],
  );

  /**
   * Delete the highlight a "Delete Highlight" press was on, in reply to `confirmDeleteHighlight`.
   * By stored id — the shell already said which one the press landed on, so nothing here matches a
   * range against a selection. No separate RN confirmation step: choosing the item from a menu the
   * reader explicitly opened by pressing the highlight already is the confirmation.
   */
  const deleteHighlightById = useCallback(
    (id: string): Promise<void> =>
      removeHighlight(bookId, id)
        .then(({ highlights: fresh, skippedIds }) => {
          setHighlights(fresh);
          setSkippedHighlightCount(skippedIds.length);
        })
        .catch((cause: unknown) => {
          // Milder than a failed add: the highlight is still stored and still painted, so the
          // screen already agrees with the truth. Said anyway, because the user asked for it to go
          // and it did not.
          alertAnnotationWriteFailed(
            'Highlight not deleted',
            'This highlight could not be removed from this device and is still saved.',
            cause,
          );
        }),
    [bookId],
  );

  const handleMessage = useCallback((message: ReaderMessage): void => {
    switch (message.type) {
      case 'ready':
        // Handled by onReady, which also carries the sender.
        break;
      case 'rendered':
        if (openSentAtRef.current !== null) {
          logSpan('open -> rendered', openSentAtRef.current);
        }
        setIsRendered(true);
        break;
      case 'relocated': {
        setPosition(message.position);
        setBounds({ atStart: message.atStart, atEnd: message.atEnd });

        // Verify the initial-target flush landed where it was sent, and resend — up to
        // MAX_INITIAL_TARGET_RESENDS times — if a resize or appearance-reanchor race (see
        // `pendingInitialVerifyRef`'s own doc) silently carried it somewhere else.
        //
        // `isUnverifiedInitialRelocate` ALSO gates whether this relocate is reported outward
        // (`onRelocatedRef` below): a `relocated` fired inside this same race window can be the
        // WebView's own natural default landing (e.g. page 1), not wherever `initialTarget` asked
        // to resume — and unlike the resend loop here, `onRelocatedRef`'s caller
        // (`ReaderRouteScreen.tsx`) saves AND PUSHES to Sync on the very first call, unthrottled.
        // Reporting a wrong intermediate position outward durably overwrites a correct synced
        // position with a stale/default one, on every open, before the resume target even lands -
        // confirmed live, 2026-09-03: opening a book already at page 9 wrote page 1 to the server
        // within the first second, every time. `setPosition`/`setBounds` above stay unconditional -
        // they only drive this component's own display, which the resend loop already corrects.
        const pendingVerify = pendingInitialVerifyRef.current;
        let isUnverifiedInitialRelocate = false;
        if (pendingVerify !== null) {
          const { target, attempts } = pendingVerify;
          const landedCorrectly =
            target.kind === 'page'
              ? message.position.kind === 'page' && message.position.page === target.page
              : message.position.kind === 'cfi' && message.position.cfi === target.href;
          isUnverifiedInitialRelocate = !landedCorrectly;
          // Silent unless EXPO_PUBLIC_READER_TIMING=1 (readerTiming.ts) — real device evidence for
          // whatever keeps landing this wrong, rather than more guessing from a simulator.
          logEvent('initial-target relocated', {
            attempt: attempts,
            landedCorrectly: String(landedCorrectly),
            requested: target.kind === 'page' ? target.page : target.href,
            got: message.position.kind === 'page' ? message.position.page : message.position.cfi ?? 'null',
          });
          if (landedCorrectly || attempts >= MAX_INITIAL_TARGET_RESENDS) {
            if (!landedCorrectly) {
              logEvent('initial-target abandoned', { attempts });
            }
            pendingInitialVerifyRef.current = null;
          } else {
            pendingInitialVerifyRef.current = { target, attempts: attempts + 1 };
            sendRef.current?.({ type: 'goTo', target });
          }
        } else if (initialTargetRef.current !== null) {
          // `relocated` arrived before `rendered`: both pdf.entry.ts (renderCurrent(1) inside
          // openPdf) and epub.entry.ts (display() inside openEpub) post `relocated` before they
          // post `rendered`. `pendingInitialVerifyRef` is set by the effect that waits for
          // `isRendered`, so it is null here — the existing guard above cannot fire. But
          // `initialTargetRef` still holds the resume target, meaning the goTo has not been sent
          // yet and this `relocated` is the book's own default landing (page 1 / start CFI), not
          // the position the user should resume at. Suppress it exactly as the post-rendered case
          // does for a mid-resend wrong landing.
          isUnverifiedInitialRelocate = true;
        }

        // Every real `relocated` USED TO BE a navigation signal unconditionally — epub.js never
        // fired it for `setSpokenRange`, which only touched annotations — so this was the one call
        // site needed, not one at every next/prev/goTo send. TTS auto-follow's `rendition.display()`/
        // `scrollBy()` calls (and a font-size reflow's reanchor, and a flow rebuild's redisplay) now
        // live INSIDE handlers that used to only paint, so a `relocated` can originate from Reader's
        // own internal repositioning too — `message.internalReposition` is how the WebView says so.
        // Skipping `notifyRelocated()` for one is not skipping the relocation itself: `onRelocatedRef`
        // below (progress tracking) still runs unconditionally, cause-agnostic, exactly as before —
        // this gate is specifically about not telling the TTS session "the reader navigated away"
        // when they did not, which used to wipe the session's prefetched next sentence and clear the
        // highlight it had just centered on screen, silently stopping speech on the very first
        // auto-follow action every time. A no-op while TTS isn't active either way (ref is null).
        if (!message.internalReposition) {
          ttsProviderRef.current?.notifyRelocated();
        }
        if (!isUnverifiedInitialRelocate) {
          onRelocatedRef.current?.(message.position);
        }

        const ttsSpeaking = ttsStatusRef.current === 'speaking';

        // ONE RELOCATION, ONE UTTERANCE. The chapter is tried first and the page only if it said
        // nothing: crossing a chapter boundary is also a page change, and announcing both would
        // read out "Chapter: The Cave" and "Page 88 of 340" back to back for a single turn.
        const chapter = chapterChangeAnnouncement(
          lastSectionRef.current,
          message.section,
          message.section === null
            ? null
            : tocLabelForHref(tocRef.current, message.section.href),
          {
            enabled: lastAppearanceRef.current?.announceChapterChanges ?? false,
            ttsSpeaking,
          },
        );

        // Announced from the CHANGE, not from the message arriving. `pdf.entry.ts`'s scroll mode
        // posts `relocated` from a rAF-coalesced scroll listener, so a single flick delivers dozens
        // of these — `pageChangeAnnouncement` returns null unless the page number actually moved.
        // It also returns null for a reflowable EPUB, which has no page to name.
        const page =
          chapter !== null
            ? null
            : pageChangeAnnouncement(lastPositionRef.current, message.position, {
                enabled: lastAppearanceRef.current?.announcePageChanges ?? false,
                ttsSpeaking,
              });

        lastPositionRef.current = message.position;
        lastSectionRef.current = message.section;

        const said = chapter ?? page;
        if (said !== null) announce(said);
        break;
      }
      case 'toc':
        // TIMED, unlike the other post-open messages, because this is the one that can stall
        // invisibly: `rendered` has already fired, so the reader shows a page while Contents is
        // still unavailable. The PDF shell resolves every outline destination through the worker
        // (one or two round trips each), so a large book's outline is where that shows up.
        if (openSentAtRef.current !== null) {
          logSpan('open -> toc', openSentAtRef.current, { items: message.items.length });
        }
        setToc(message.items);
        break;
      case 'error':
        // Timed as well as rendered: on the large-payload smoke test a returning OPEN_FAILED is the
        // signal that the transport SURVIVED, so its elapsed time is a real measurement, not a
        // footnote to a failure.
        if (openSentAtRef.current !== null) {
          logSpan('open -> error', openSentAtRef.current, { code: message.code });
        }
        setError({ code: message.code, message: message.message });
        break;
      case 'ttsSentence':
        ttsProviderRef.current?.handleReply(message);
        break;
      case 'selection':
        // Reply to `requestCurrentSelection`. Null is a normal answer (selection cleared before
        // the reply arrived) and just does nothing.
        if (message.selection !== null) void createHighlightFromSelection(message.selection);
        break;
      case 'highlightPressed':
        // Reply to `confirmDeleteHighlight`, or to `requestCurrentSelection` when that gesture
        // turned out to meet an existing highlight (see readerBridge.ts's own note) — either way,
        // deletes directly, no RN confirmation step.
        void deleteHighlightById(message.id);
        break;
      case 'searchMatchPainted':
        // Sent only for a payload that asked for a paint, so this never has to distinguish "cleared"
        // from "failed". NOT routed through `raiseError`: navigation already worked, and a banner
        // over the book is the wrong size of response to a box that could not be measured.
        setUnpaintedMatchKey(message.painted ? null : activeMatchKey);
        break;
    }
  }, [activeMatchKey, createHighlightFromSelection, deleteHighlightById]);

  /**
   * Flush a search jump that was queued while `send` was still null.
   *
   * `send` only ever transitions null -> non-null (set once, from `handleReady`), so this
   * fires at most once per queued target. It is a separate effect rather than logic inside
   * `selectHit` because the queueing and the flushing happen at two different, unrelated
   * moments — a tap, and a bridge message — and nothing else should re-check the queue.
   */
  useEffect(() => {
    if (send === null) return;
    const target = pendingSeekRef.current;
    if (target === null) return;
    pendingSeekRef.current = null;
    setAwaitingSeek(false);
    setShowSearch(false);
    pendingInitialVerifyRef.current = null; // see `goTo`'s own note on why
    send({ type: 'goTo', target });
    // This flush only ever runs after `selectHit`'s queuing branch reopened search to show the
    // wait — so, same as that branch's own success path, this IS a selection closing the panel,
    // unconditionally. See `matchBarFocusSignal`'s own note.
    setMatchBarFocusSignal((n) => n + 1);
  }, [send]);

  /**
   * Flush the resume target once, after the FIRST `rendered` — not merely once `send` exists,
   * because a `goTo` before the rendition itself exists fails `NOT_READY` (both shells guard exactly
   * that in their own `goTo`). In practice `send` is already non-null by the time `rendered` arrives
   * (it is set synchronously in `handleReady`, before the awaited open-and-render sequence below it),
   * so the `send === null` guard here is a belt-and-braces ordering check, not the expected path.
   *
   * Records what it sent in `pendingInitialVerifyRef` — see that ref's own doc for why: this specific
   * send lands in the volatile window right after open, where a resize race in either shell, or an
   * appearance reanchor racing the same window, can silently carry it somewhere else, and
   * `handleMessage`'s `relocated` case uses this record to detect and resend (bounded by
   * `MAX_INITIAL_TARGET_RESENDS`).
   */
  useEffect(() => {
    if (!isRendered || send === null) return;
    const target = initialTargetRef.current;
    if (target === null) return;
    initialTargetRef.current = null;
    pendingInitialVerifyRef.current = { target, attempts: 0 };
    logEvent('initial-target sent', {
      target: target.kind === 'page' ? target.page : target.href,
    });
    send({ type: 'goTo', target });
  }, [isRendered, send]);

  /**
   * Close the Contents panel, optionally handing screen-reader focus back to the button that opened
   * it.
   *
   * THE ARGUMENT IS THE WHOLE POINT OF THE HELPER — it is not here because five call sites repeat
   * two lines, it is here because those five sites split into two cases that are easy to get wrong
   * and impossible to see from any one of them:
   *
   *   `true`  — the user finished with the TOC (chose a row). Nothing else is claiming focus, so
   *             leaving it where the now-unmounted row was strands it; send it back to Contents.
   *   `false` — the TOC is closing because ANOTHER panel is opening over it (Search or Bookmarks
   *             from the toolbar, a queued search seek, the match bar's "show all results"). That
   *             panel does its own entry focus, and restoring here would race it — the user would be
   *             moved to Contents a frame after arriving in the search field.
   *
   * The Contents toggle's own press needs neither: focus is already on it, and it is still mounted.
   */
  const closeToc = useCallback((restoreFocus: boolean): void => {
    setShowToc(false);
    if (restoreFocus) focusOn(contentsButtonRef);
  }, []);

  /**
   * The other half of that pair: ENTER the Contents panel when it opens, so a screen-reader user
   * lands on the first chapter instead of being left on the button behind a panel that just covered
   * the screen. Item 2 of `READER_FOCUS_ORDER_HANDOFF.md`.
   *
   * KEYED ON THE TRANSITION, NOT ON THE FLAG, which is what makes this a legitimate exception to
   * `a11yFocus.ts`'s warning against "is the panel open" effects. The early return leaves the CLOSE
   * half entirely to `closeToc`, whose whole argument is which of the two closes this is; and the
   * open half fires only from the Contents button's own press, since that is the one place that
   * OPENS it — the `setShowToc((open) => !open)` toggle at ~2682. (Do not go looking for a
   * `setShowToc(true)`: there is no such call, which is the point — one toggle is the whole
   * surface.) So there is no render this can steal focus on that the user did not cause, and
   * nothing here can race a panel opening over the TOC — that path goes through `closeToc(false)`
   * and returns above.
   *
   * NO `setTimeout`, and not by omission. `VoicePicker` needs one because a `Modal` attaches its
   * content on a native layer asynchronously, so focusing the instant `visible` flips no-ops. This
   * panel is a plain conditionally-rendered `View` in the same tree, so its host node is attached by
   * the time effects run for the commit that mounted it. Add one only with device evidence.
   *
   * ONE TARGET IS ENOUGH, though the handoff spec asks for two. It also names the empty-state
   * `Text`, but the panel cannot be opened empty: the Contents button is `disabled` while
   * `toc.length === 0` (pinned by "the Contents button reports disabled with no outline"), and that
   * press is the only way in. A second ref for the empty branch would be unreachable code, and
   * `focusOn` already no-ops silently if the row is somehow not mounted.
   */
  useEffect(() => {
    if (!showToc) return;
    focusOn(firstTocRowRef);
  }, [showToc]);

  // `target` is a `ReaderTarget` — discriminated by format, so the host never has to know whether a
  // Contents row addresses a spine href or a page number. It hands back exactly what the shell sent.
  const goTo = useCallback(
    (target: ReaderTarget): void => {
      // `false`, even though a Contents row is one of the things that reaches here. THIS FUNCTION IS
      // SHARED — the bookmarks panel and the page-jump field navigate through it too, and Contents
      // is always mounted (it lives in the bottom row, not inside the panel), so restoring focus
      // here would yank a bookmark-selecting user over to a button they never touched. The Contents
      // row restores focus at its own onPress instead, where "this was the TOC" is actually known.
      closeToc(false);
      setShowBookmarks(false);
      // A deliberate navigation elsewhere supersedes whatever the initial-target flush was still
      // trying to correct — see `pendingInitialVerifyRef`'s own doc for why fighting a real user
      // action to get back to the ORIGINAL target would be wrong, not merely redundant.
      pendingInitialVerifyRef.current = null;
      send?.({ type: 'goTo', target });
    },
    [closeToc, send],
  );

  /**
   * CALL-SITE 1, per READER_BOOKMARKS_WIRING.md: load this book's bookmarks once, after the first
   * `rendered` — matching the resume-target flush effect above, and for the same reason: nothing
   * downstream needs them before there is a page on screen, and `isRendered` only ever goes
   * false -> true once per mount (this component is keyed on `bookId`, see its own prop doc).
   *
   * ALSO RE-LOADS on `subscribeToBookmarkChanges` — the gap that store's own doc names: a delete
   * (or any other edit) that arrives via a PULL, not through this screen's own add/remove/rename,
   * used to sit unseen in an already-open panel until the book was reopened, because this effect
   * only ever ran once. A local edit through THIS screen does not need this path — `addCurrentBookmark`
   * /`deleteBookmark`/`submitBookmarkRename` already update `bookmarks` from their own return value —
   * but the subscription still fires for those too (`bookmarkStore.subscribe` notifies on every
   * write, local or pulled) and simply re-runs the same query redundantly; harmless, not a loop,
   * since a reload cannot itself trigger a further change.
   */
  useEffect(() => {
    if (!isRendered) return;
    let cancelled = false;

    const reload = () => {
      void loadBookmarks(bookId)
        .then(({ bookmarks: loaded, skippedIds }) => {
          if (cancelled) return;
          setBookmarks(loaded);
          setSkippedBookmarkCount(skippedIds.length);
          setBookmarksLoaded(true);
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          // `bookmarksLoaded` IS STILL SET. It distinguishes "still reading" from "finished
          // reading" (see its own note) — not "read successfully". Left false on a failure the
          // panel sits on its loading state forever, which reads as a hang rather than an empty
          // list.
          setBookmarksLoaded(true);
          warnAnnotationReadFailed('bookmarks', cause);
        });
    };

    reload();
    const unsubscribe = subscribeToBookmarkChanges(reload);

    return () => {
      cancelled = true;
      unsubscribe();
    };
    // bookId: bookmarks are now scoped to the open book (was the global BOOK_ID constant).
  }, [isRendered, bookId]);

  /**
   * Tap a bookmark: dismiss the panel and `goTo` its target — the whole navigation path, already
   * proven by TOC entries and search hits. A dedicated handler rather than reusing `goTo` because that
   * one closes the CONTENTS panel; this needs to close the BOOKMARKS one instead.
   */
  const selectBookmark = useCallback(
    (bookmark: ReaderBookmark): void => {
      setShowBookmarks(false);
      pendingInitialVerifyRef.current = null; // see `goTo`'s own note on why
      send?.({ type: 'goTo', target: bookmark.target });
    },
    [send],
  );

  /**
   * Whether the current position can be bookmarked. False before the first `relocated` — EPUB's `cfi`
   * starts `null` until epub.js resolves a location (the same nullability `readerProgressStore.ts`'s
   * `toLocator` guards against) — and while the WebView is not ready, matching `submitPageJump`'s
   * own guards on `send`.
   */
  const canAddCurrentBookmark =
    send !== null && position !== null && (position.kind === 'page' || position.cfi !== null);

  /**
   * CALL-SITE 2 (both formats): bookmark the current position, under the label the user typed in
   * `BookmarksPanel`'s add field (or `undefined` for a blank one, which falls through to
   * `labelFor`'s own fallback). `position` is exactly what the last `relocated` reported, so no
   * separate read of the WebView's state is needed — the same reasoning TTS's `ttsProvider` and the
   * page-jump control already lean on.
   */
  const addCurrentBookmark = useCallback(
    (name?: string): void => {
      if (position === null) return;
      const add =
        position.kind === 'page'
          ? addCurrentPdfBookmark(bookId, position.page, name)
          : position.cfi !== null
            ? addCurrentEpubBookmark(bookId, position.cfi, undefined, name)
            : null;
      if (add === null) return;

      void add
        .then(({ bookmarks: fresh, skippedIds }) => {
          setBookmarks(fresh);
          setSkippedBookmarkCount(skippedIds.length);
        })
        .catch((cause: unknown) => {
          alertAnnotationWriteFailed(
            'Bookmark not saved',
            'This bookmark could not be saved to this device and has not been kept.',
            cause,
          );
        });
    },
    [position, bookId],
  );

  /** CALL-SITE 3: tap-to-delete, by stored id. Re-renders from the returned fresh set. */
  const deleteBookmark = useCallback(
    (id: string): void => {
      void removeBookmark(bookId, id)
        .then(({ bookmarks: fresh, skippedIds }) => {
          setBookmarks(fresh);
          setSkippedBookmarkCount(skippedIds.length);
        })
        .catch((cause: unknown) => {
          alertAnnotationWriteFailed(
            'Bookmark not deleted',
            'This bookmark could not be removed from this device and is still saved.',
            cause,
          );
        });
    },
    [bookId],
  );

  /**
   * CALL-SITE 4: rename an existing bookmark in place. One write and one sync-outbox entry, and the
   * id and `target` are untouched — only the name changes, so the row keeps its place in the panel
   * and `isCurrentPositionBookmarked` below keeps matching it.
   *
   * TAKES AN ID, NOT THE WHOLE BOOKMARK. The panel used to hand over `bookmark.target` because this
   * function had to re-create the row at the same place; it does not any more.
   *
   * `name ?? ''` is the cleared-field case: `labelFor` (`readerBookmarks.ts`) treats an empty name as
   * absent and falls through to the chapter id, then to "Page N"/"Bookmark" — which is exactly what
   * the panel means by passing `undefined`. The facade's `name` is a required `string`, so the
   * conversion happens here rather than widening Personalization's signature for one caller.
   */
  const submitBookmarkRename = useCallback(
    (id: string, name?: string): void => {
      void renameBookmark(bookId, id, name ?? '')
        .then(({ bookmarks: fresh, skippedIds }) => {
          setBookmarks(fresh);
          setSkippedBookmarkCount(skippedIds.length);
        })
        .catch((cause: unknown) => {
          alertAnnotationWriteFailed(
            'Bookmark not renamed',
            'This bookmark could not be renamed on this device and is still saved under its old name.',
            cause,
          );
        });
    },
    [bookId],
  );

  /**
   * CALL-SITE 1, per READER_HIGHLIGHTS_WIRING.md: load this book's highlights once, after the first
   * `rendered`.
   *
   * AFTER `rendered`, NOT MERELY ONCE `send` EXISTS, and for a sharper reason than the bookmarks
   * effect beside it has: a bookmark is a list, but a highlight has to be PAINTED, and painting
   * needs a rendition to paint onto. The EPUB shell's `paintHighlights` is a no-op before
   * `openEpub` has built one, and the PDF shell has no page surface to measure against until its
   * first page is rasterised. Same gate `setSpokenRange` needs, for the same reason.
   */
  useEffect(() => {
    if (!isRendered) return;
    let cancelled = false;
    void loadReaderHighlights(bookId)
      .then(({ highlights: loaded, skippedIds }) => {
        if (cancelled) return;
        setHighlights(loaded);
        setSkippedHighlightCount(skippedIds.length);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // Left at the empty initial set, which is what the paint effect below then sends: a book
        // with no highlights painted, not a broken one. NOT routed into `skippedHighlightCount` —
        // that badge means "rows that would not map", and a load that returned nothing at all has
        // no count to report.
        warnAnnotationReadFailed('highlights', cause);
      });
    return () => {
      cancelled = true;
    };
  }, [isRendered, bookId]);

  /**
   * Paint whatever the current set is — the ONE place `paintHighlights` is sent from.
   *
   * DERIVED FROM STATE RATHER THAN SENT AT EACH CALL-SITE, which is what makes "load on open" and
   * "the user just added one" the same code path: every call-site replaces `highlights` with the
   * fresh authoritative set `readerHighlights.ts` hands back, and this effect re-sends it. A second
   * send from inside `highlightSelection` would be a second thing to keep in step with the first.
   *
   * The `switch` is exhaustive for the same reason `handleReady`'s is: choosing which array to send
   * IS the format routing (`toReaderHighlights` split them host-side precisely so no `ContentFormat`
   * value has to cross), so a fourth format must be a compile error here rather than a book whose
   * highlights silently never paint.
   */
  useEffect(() => {
    if (!isRendered || send === null || format === null) return;
    switch (format) {
      case 'EPUB':
        send({ type: 'paintHighlights', highlights: highlights.epub });
        break;
      case 'PDF':
        send({ type: 'paintHighlights', highlights: highlights.pdf });
        break;
      case 'AUDIO':
        // Unreachable — the same backstop `handleReady`'s switch carries, and for the same reason:
        // no WebView is mounted for an audio book at all, so there is nothing to paint onto.
        break;
      default: {
        const unhandled: never = format;
        throw new Error(`Unhandled ContentFormat: ${String(unhandled)}`);
      }
    }
  }, [isRendered, send, format, highlights]);

  /**
   * Paint the active search match — the ONE place `paintSearchMatch` is sent from.
   *
   * DERIVED FROM SEARCH STATE, exactly like the highlight effect above, and for the sharper
   * version of the same reason: `activeIndex` moves from the results panel, from the match bar's
   * arrows, from a fresh `submit()` and from `clear()`, and pushing a paint from each of those
   * would be four things to keep in step. One effect over the state they all write is one.
   *
   * >>> IT SELF-CLEARS, WHICH IS WHY THERE IS NO SECOND COMMAND AND NO TEARDOWN CALL. <<<
   * `searchMatchFor` answers `NO_SEARCH_MATCH` for `activeIndex === -1` and for an index past the
   * end of `hits`, and both `submit()` and `clear()` reset the index to -1. So closing the panel,
   * dismissing the match bar and swapping result sets all send one authoritative clear through this
   * same line.
   *
   * NO `switch (format)`, UNLIKE `paintHighlights` — and that is a real difference worth naming.
   * The payload is already partitioned per shell (`{epub, pdf}`, no `ContentFormat` anywhere), so
   * the partition IS the routing and there is nothing to choose here. The cost is that a fourth
   * format would not be a compile error at this line; the receiving shell reports a payload meant
   * for the other one instead. Splitting it here would be a second implementation of a split
   * `toReaderSearchMatch` already did.
   *
   * Gated on `isRendered` for the same reason as the highlights effect: a paint needs a rendition
   * (EPUB) or a rasterised page (PDF) to land on.
   */
  useEffect(() => {
    if (!isRendered || send === null || format === null) return;
    send({
      type: 'paintSearchMatch',
      match: searchMatchFor(search.hits, search.activeIndex, search.submittedTerm),
    });
  }, [isRendered, send, format, search.hits, search.activeIndex, search.submittedTerm]);

  /**
   * Gate manual swipe/drag in the WebView the instant TTS starts or stops speaking — see
   * `setTtsSpeaking`'s own doc comment in readerBridge.ts for scope (gestures only, not
   * `goTo`/TOC/search).
   *
   * DEPENDS ON `ttsSession.status`, A PRIMITIVE, NOT `ttsSession` ITSELF — `useTtsSession` returns a
   * fresh object every render (no `useMemo`, see `ttsStatusRef`'s own note above), so depending on
   * the object would resend this command on every render instead of only on an actual transition.
   */
  useEffect(() => {
    if (!isRendered || send === null || format === null) return;
    send({ type: 'setTtsSpeaking', speaking: ttsSession.status === 'speaking' });
  }, [isRendered, send, format, ttsSession.status]);

  /**
   * Jump to a typed page, or refuse without navigating.
   *
   * >>> VALIDATED HERE RATHER THAN IN THE SHELL, AND THAT IS THE WHOLE POINT OF CARRYING pageCount. <<<
   * The shell range-checks too and raises NAVIGATION_FAILED, but that surfaces as the reader's error
   * banner — the right response to a corrupt book and a wildly disproportionate one to a typo. Knowing
   * the bound host-side means the UI can simply decline, and can show the range up front.
   *
   * Only reachable when the position is a page, so an EPUB can never get here — there is no stable page
   * to jump to in a reflowable book.
   */
  const submitPageJump = useCallback((): void => {
    if (position?.kind !== 'page' || pageJump === null) return;

    const page = Number(pageJump.trim());
    if (!Number.isInteger(page) || page < 1 || page > position.pageCount) {
      // Left OPEN on a bad value rather than closed: the typed text stays visible so it can be
      // corrected, which is the difference between a rejection and losing your input.
      return;
    }

    setPageJump(null);
    pendingInitialVerifyRef.current = null; // see `goTo`'s own note on why
    send?.({ type: 'goTo', target: { kind: 'page', page } });
  }, [pageJump, position, send]);

  /**
   * Seek to a search hit and dismiss the results, leaving the match bar behind.
   *
   * Dismissing is the point: the panel covers the page, so staying open would hide the
   * text the jump just went to. The match bar floats, so stepping continues against
   * the book itself.
   *
   * Deliberately not `goTo`: that closes the Contents panel, which is the right
   * teardown for a TOC entry and the wrong one here.
   */
  const selectHit = useCallback(
    (index: number): void => {
      const hit = search.hits[index];
      if (!hit) return;
      // BOTH FORMATS SEEK NOW. A PDF hit used to be a dead row — listed, but tapping it did nothing —
      // because the only way to address a location was a bare string, and a page number could not be
      // told apart from a spine href in one. `targetOf` unwraps the frozen `Locator` into a
      // discriminated `ReaderTarget`, which is the one place that unwrap happens.
      const target = targetOf(hit);
      if (target === null) return;
      search.setActiveIndex(index);

      if (send === null) {
        // Search itself runs host-side over the decrypted index, so results can arrive well
        // before the WebView reports `ready` — `send` is still null here. `send?.({...})`
        // below would silently drop the jump: the panel would still close and the match bar
        // would still say "Match N of M" as if it had worked. Queue it and reopen the panel
        // (rather than leaving it wherever this was called from — the match bar's stepper
        // reaches this too) so the wait is visible; the effect above flushes it once `send`
        // exists.
        pendingSeekRef.current = target;
        setAwaitingSeek(true);
        closeToc(false); // Search is opening over it — see closeToc's own note.
        setShowBookmarks(false);
        setShowAccessibility(false);
        setShowSearch(true);
        return;
      }

      // CAPTURED BEFORE THE CLOSE, not after: this is what tells a genuine results-list
      // selection (panel was open) apart from `stepHit` calling back in here (panel is already
      // closed) — see `matchBarFocusSignal`'s own note for why that distinction matters.
      const wasOpen = showSearch;
      setShowSearch(false);
      setShowBookmarks(false);
      pendingInitialVerifyRef.current = null; // see `goTo`'s own note on why
      send({ type: 'goTo', target });
      if (wasOpen) setMatchBarFocusSignal((n) => n + 1);
    },
    [closeToc, search, send, showSearch],
  );

  const stepHit = useCallback(
    (delta: 1 | -1): void => {
      // With nothing selected, the first press lands on the first (or last) match.
      // Starting from activeIndex + delta would reach index 0 only by accident of
      // -1 + 1, and would skip the last match when stepping backwards.
      const from =
        search.activeIndex < 0
          ? delta === 1
            ? 0
            : search.hits.length - 1
          : search.activeIndex + delta;

      for (let i = from; i >= 0 && i < search.hits.length; i += delta) {
        // Every hit is navigable in both formats now, so in practice this skips nothing — it used to
        // skip every PDF hit, which made the match bar step straight past results it was counting.
        // Kept rather than dropped: it is what stops a future locator shape with no renderer from
        // being stepped onto and silently doing nothing.
        if (targetOf(search.hits[i]) !== null) {
          selectHit(i);
          return;
        }
      }
      // Nothing navigable that way. CLAMP rather than wrap: the arrows disable at the
      // ends, and wrapping would contradict what the UI is showing.
    },
    [search.activeIndex, search.hits, selectHit],
  );

  // GATED ON `locked` FIRST. Without it, a lock landing before `htmlUri` was ever set (the
  // mid-open case) leaves `htmlUri === null` true forever — `setResolved` never runs once
  // `lockedRef` has flipped (see the `prepareBook` effect's own guard) — so the rest of this
  // expression would stay stuck at `true` and "Opening title…" would show indefinitely over a
  // book that in fact failed CLOSED. A lock always has an answer to render (the locked-state
  // block below), so it is never "busy".
  const isBusy = !locked && (htmlUri === null || (!isRendered && error === null));

  /**
   * `bookmarks`, narrowed to the target kinds the open format can actually navigate to.
   *
   * REDUNDANT FOR CORRECTNESS, and kept on purpose. `loadBookmarks(bookId)` is scoped to the open
   * book (`readerBookmarks.ts` passes `bookId` through to `bookmarkStore.list`), and a book has one
   * format, so every row that reaches here already matches — an AUDIO locator cannot slip through
   * either, `toReaderBookmarks` sets those aside as `skippedIds` rather than emitting a target.
   *
   * What it still buys is a guard on the seam Reader does not own: both store methods default
   * `bookId` to the single `BOOK_ID` constant in `syncConfig.ts`, so a call-site that stops passing
   * it silently goes back to serving every book's bookmarks. That regression is invisible from this
   * file, and this filter catches its cross-format half at the point of use — for the price of one
   * `Array.filter` over a list the user is looking at.
   *
   * Same-format cross-book leakage is what it CANNOT catch, which is why this is a guard and not a
   * substitute for the scoping.
   */
  const bookmarksForOpenBook = useMemo(() => {
    if (format === null) return bookmarks;
    return bookmarks.filter((b) =>
      format === 'PDF' ? b.target.kind === 'page' : b.target.kind === 'href',
    );
  }, [bookmarks, format]);

  /**
   * Whether the CURRENT position has a bookmark on it, for the corner badge below.
   *
   * PDF matches by PAGE — the same whole-page granularity `addCurrentPdfBookmark` already writes at,
   * so "this page has a bookmark" is exactly what was asked for. EPUB matches by exact CFI, which is
   * an honest narrower claim: a CFI addresses a point, not a page, so the badge lights up only at the
   * precise spot that was bookmarked, not "somewhere in this pagination" — the same "exactness over a
   * comforting approximation" the search hints elsewhere in this file already commit to.
   *
   * Reads `bookmarksForOpenBook`, not raw `bookmarks`, so the badge and the panel list can never
   * disagree about which bookmarks belong to the open book — see that memo's own note for why the
   * filter is kept now that scoping makes it redundant.
   *
   * `useMemo`, not state-in-an-effect: this is a pure function of `bookmarksForOpenBook` and
   * `position`, both of which are already reactive state — nothing here has a side effect to push
   * through `setState`.
   */
  const isCurrentPositionBookmarked = useMemo(() => {
    if (position === null) return false;
    if (position.kind === 'page') {
      return bookmarksForOpenBook.some(
        (b) => b.target.kind === 'page' && b.target.page === position.page,
      );
    }
    return (
      position.cfi !== null &&
      bookmarksForOpenBook.some((b) => b.target.kind === 'href' && b.target.href === position.cfi)
    );
  }, [bookmarksForOpenBook, position]);

  /**
   * SWIPE-TO-TURN-PAGE NO LONGER LIVES IN THIS FILE, and the move is worth recording where the
   * PanResponder used to be.
   *
   * It was an RN overlay above the WebView (`reader-swipe-catcher`) with a `PanResponder` on it.
   * That overlay is the topmost hit-test target for every touch in the viewer, so the document
   * underneath never received a `touchstart` while it was mounted — fine for swipes, fatal for text
   * selection, which is the first half of making a highlight. The two could not both own the same
   * touches from opposite sides of the bridge.
   *
   * So both gestures are now recognised inside the WebView, where the whole touch is visible and
   * they can be told apart by SHAPE: hold still and the text selects, drag sideways and the page
   * turns. See `webview/src/touchGesture.ts`. Prev/Next below are unaffected — they were always
   * buttons, and they still send the same `next`/`prev` commands.
   */

  // Prev/Next are BUTTON-driven, discrete-page-turn controls, and neither concept applies in
  // continuous scroll: navigation there is native scrolling.
  // `bounds` is the UI-only refinement on top of that — `next`/`prev` already no-op at an edge
  // WebView-side, so disabling here only stops the button LOOKING tappable past the end; it changes
  // no behaviour if `bounds` is ever behind the WebView's own state.
  // EFFECTIVE, not stored: the WebView was told the overridden flow, and an RN half that disagrees
  // would leave the swipe affordances and the WebView's own scroll view set for a layout that is
  // not on screen. See readerA11yLayout.ts.
  const isScrolling = effectiveLayoutFlow(layoutPrefs.flow, a11yLayoutEnabled) === 'scrolled-doc';
  const prevDisabled = send === null || isScrolling || bounds.atStart;
  const nextDisabled = send === null || isScrolling || bounds.atEnd;

  return (
    <View style={styles.container}>
      {/* `alert` and the live region are both needed: the role is what iOS reads, the live region
          is what Android acts on. Together they are the one place in this screen allowed to
          interrupt — an error is the thing a reader must act on. */}
      {error !== null && (
        <View style={styles.errorBanner} accessibilityRole="alert" accessibilityLiveRegion="polite">
          <Text style={styles.errorCode}>{error.code}</Text>
          {/* `error.message` DIRECTLY, not `formatDiagnosticErrorMessage(error)`. That formatter is
              for CAUGHT THROWABLES — it digs a `cause` out of an Error and composes "CODE: detail".
              A `ReaderError` is neither: it is a structured `{code, message}` the bridge already
              parsed, with no `cause` to dig for. Passed through the formatter it matched no branch
              and fell to `String(error)`, which renders a plain object as "[object Object]" — the
              banner showed that instead of the message. The code is on its own line above, so
              composing it in here would duplicate it even once the formatter handles this shape. */}
          <Text style={styles.errorMessage}>{error.message}</Text>
        </View>
      )}

      {/* THE BACKGROUND, for `anyPanelOpen`'s purposes — this row, the book, the two on-page
          badges and the bottom row. Each carries the pair separately because a panel is a sibling
          of the book inside `viewer`; there is no single node that holds all of this and none of
          the panels. See `anyPanelOpen`'s own note. */}
      <View
        style={styles.toolbar}
        accessibilityElementsHidden={anyPanelOpen}
        importantForAccessibility={anyPanelOpen ? 'no-hide-descendants' : 'yes'}
      >
        <Pressable
          accessibilityRole="button"
          // Required rather than stylistic: a glyph child gives a screen reader nothing to say,
          // and every existing test finds buttons by accessible name.
          accessibilityLabel="Search this title"
          accessibilityState={{ expanded: showSearch }}
          ref={searchButtonRef}
          onPress={() => {
            // Mutual exclusion with Contents, Bookmarks (and TTS). A UI decision — one panel's
            // worth of the viewer is all there is room for. It no longer also carries the job of
            // keeping "Close" unambiguous: each panel now names its own ("Close search",
            // "Close bookmarks", "Close contents"), so the exclusion is free to change on its
            // own merits without renaming a control out from under the test suite.
            closeToc(false); // this panel is taking over — see closeToc's own note.
            setShowBookmarks(false);
            setShowAccessibility(false);
            setShowSearch((open) => !open);
          }}
          style={styles.toolbarButton}
        >
          <Ionicons name="search-outline" style={styles.toolbarIcon} />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Bookmarks"
          accessibilityState={{ expanded: showBookmarks }}
          onPress={() => {
            closeToc(false);
            setShowSearch(false);
            setShowAccessibility(false);
            setShowBookmarks((open) => !open);
          }}
          style={styles.toolbarButton}
        >
          <Ionicons
            name={isCurrentPositionBookmarked ? 'bookmark' : 'bookmark-outline'}
            style={[styles.toolbarIcon, isCurrentPositionBookmarked && styles.toolbarIconBookmarked]}
          />
        </Pressable>

        {/* NOT GATED ON `format`, unlike the panel's own Dyslexia Font row: High Contrast and
            Reduce Motion apply to every format, and to the shell before a book has even resolved.
            Gating the whole entry point on the one control that is EPUB-only would take the other
            two away from PDF and audio readers. */}
        <Pressable
          accessibilityRole="button"
          // Explicit for the same reason as Search and Bookmarks: the glyph gives a screen reader
          // nothing to say, and every test finds these buttons by accessible name. One merged
          // entry point now — this button opens both the settings toggles below AND, via a row
          // inside that same dropdown, the accessibility-information screen — so the label speaks
          // to the whole panel rather than just the toggles.
          accessibilityLabel="Accessibility"
          accessibilityState={{ expanded: showAccessibility }}
          ref={accessibilityButtonRef}
          onPress={() => {
            closeToc(false); // this panel is taking over — see closeToc's own note.
            setShowSearch(false);
            setShowBookmarks(false);
            setShowAccessibility((open) => {
              const next = !open;
              if (next) {
                // Same measure-on-open shape as DevPreferencesMenu.tsx's `toggleOpen` — see
                // `accessibilityAnchor`'s own doc for why this has to be measured rather than laid
                // out relatively, now that the dropdown renders inside a `Modal`. A one-shot read
                // here, not the reactive `windowWidth` above — an anchor position is a snapshot at
                // the moment the dropdown opens, unlike the ScrollView's height cap, which
                // deliberately DOES stay live across a rotation while it's already open. Named
                // `openWindowWidth` rather than `windowWidth` only to avoid shadowing that outer,
                // reactive one — same value shape, different lifetime.
                accessibilityButtonRef.current?.measureInWindow((x, y, width, height) => {
                  const openWindowWidth = Dimensions.get('window').width;
                  const right = Math.max(0, openWindowWidth - (x + width));
                  const rightBasedMaxWidth = Math.max(
                    0,
                    openWindowWidth - right - ACCESSIBILITY_DROPDOWN_EDGE_MARGIN,
                  );
                  // Phone-only ceiling, layered ON TOP of the existing formula rather than
                  // replacing it — above the compact-width threshold (tablet), `rightBasedMaxWidth`
                  // is unchanged from before, and is already effectively capped further by
                  // AccessibilitySettingsPanel's own `container.maxWidth: 560`. Below it,
                  // `rightBasedMaxWidth` alone is "almost the full screen width minus the button's
                  // own offset" — nearly edge-to-edge on a phone — so this caps it at 60% of the
                  // window's width instead, leaving a clearly visible strip of the reader beside it.
                  const maxWidth =
                    openWindowWidth < ACCESSIBILITY_DROPDOWN_COMPACT_MAX_WIDTH
                      ? Math.min(rightBasedMaxWidth, openWindowWidth * 0.6)
                      : rightBasedMaxWidth;
                  setAccessibilityAnchor({ top: y + height, right, maxWidth });
                });
              }
              return next;
            });
          }}
          style={styles.toolbarButton}
        >
          <Ionicons name="accessibility-outline" style={styles.toolbarIcon} />
        </Pressable>

        {/* LAST child, deliberately — see `toolbarExtra`'s own prop doc for why that makes this
            the rightmost item in the row rather than a floating overlay on top of it. */}
        {toolbarExtra}
      </View>

      <View testID="reader-viewer" style={styles.viewer}>
        {/*
          ReaderWebView is KEYED ON THE SHELL URI, so a different shell is a different
          component instance rather than the same one told to navigate. ReaderWebView
          holds `isReady` and arms the READY_TIMEOUT once; reusing it across a shell
          swap would leave it believing the bridge is already up, so the new document's
          `ready` would arrive at a component that had stopped waiting for it — and
          nothing would ever send the open command. Remounting is also what tears down
          the old document holding decrypted content.
        */}
        {/* ALSO GATED ON `!locked` — unmounting is what drops WebKit's OWN copy of the rendered
            book, and a cover placed over a still-mounted WebView would leave that copy live
            underneath it. */}
        {htmlUri !== null && !locked && (
          <ReaderWebView
            key={htmlUri}
            sourceUri={htmlUri}
            onMessage={handleMessage}
            onHostError={raiseError}
            onReady={handleReady}
            scrollEnabled={isScrolling}
            hidden={anyPanelOpen}
            // The named stop between the toolbar and the bottom row. Says what this IS, not what it
            // contains — the document's own structure lives in the WebView's accessibility tree,
            // which no React Native prop can reach or describe.
            accessibilityLabel="Book content"
            // Both highlight actions are native menu items now (see ReaderWebView.tsx) — the host
            // just asks the shell to act on whatever the press landed on.
            onHighlightRequested={() => {
              send?.({ type: 'requestCurrentSelection' });
            }}
            onDeleteHighlightRequested={() => {
              send?.({ type: 'confirmDeleteHighlight' });
            }}
            // TalkBack's native page-turn action (TALKBACK_GESTURE_FIX_PROPOSAL.md) — a third
            // trigger for the exact effect the toolbar Prev/Next buttons below already have, so it
            // gets the identical `pendingInitialVerifyRef` clear rather than skipping half of it.
            onPageTurnRequested={(direction) => {
              pendingInitialVerifyRef.current = null; // see `goTo`'s own note on why
              send?.({ type: direction });
            }}
          />
        )}

        {/*
          Stored highlights that could not be drawn, surfaced rather than only logged — same
          reasoning as the bookmarks panel's skipped count and the TOC hardeners: a highlight that
          cannot be painted is a bug worth seeing, and silence reads as "you never made one". There
          is no highlights panel to put it in (the menu is the whole UI), so it sits quietly at the
          bottom of the page and says nothing when the count is zero.
        */}
        {skippedHighlightCount > 0 && !anyPanelOpen && !isBusy && (
          <View style={styles.highlightNoticeWrap} pointerEvents="none">
            <Text style={styles.highlightNotice}>
              {`${String(skippedHighlightCount)} saved highlight(s) could not be shown`}
            </Text>
          </View>
        )}

        {/*
          THE "READING ALOUD" CUE. Purely a visual state indicator: no `onPress`, no `onLongPress`,
          and `pointerEvents="none"` so it cannot swallow a tap or a swipe meant for the page under
          it. TTS is driven from the transport panel and from the preference; this only reports that
          it is running.

          WHAT IT HONESTLY MEANS: "this book is being read aloud right now", anchored on the page
          so the state is visible where the user is looking. It does NOT mean "the sentence being
          spoken is on this page" — nothing host-side can know that. `setSpokenRange` paints into
          the WebView and the reader does not follow the voice (TTS_PROVIDER.md open item 2), so
          speech can run past the visible page, and a page turn moves the reader without moving the
          voice. Promising the stronger meaning would need the WebView to report whether a CFI is
          on screen, which is not on the bridge.

          Gated on 'speaking' alone, not 'paused': paused keeps the highlight but nothing is being
          read, and a speaker icon over a silent book is the kind of indicator people learn to
          distrust.
        */}
        {ttsSession.status === 'speaking' && (
          <View
            testID="reader-tts-cue"
            accessibilityRole="image"
            accessibilityLabel="Reading aloud"
            pointerEvents="none"
            // Announced, so it needs hiding behind a panel, same as the toolbar itself.
            accessibilityElementsHidden={anyPanelOpen}
            importantForAccessibility={anyPanelOpen ? 'no-hide-descendants' : 'yes'}
            style={styles.ttsCueWrap}
          >
            <Text style={styles.ttsCueIcon}>🔊</Text>
          </View>
        )}

        {isBusy && (
          <View style={styles.busy} pointerEvents="none">
            <Spinner />
            <Text style={styles.busyText}>Opening title…</Text>
          </View>
        )}

        {/*
          THE FAIL-CLOSED STATE — what REPLACES the book, not a banner ON TOP of it. The top-of-
          screen `errorBanner` above (driven by the SAME `raiseError` call `tearDownAndLock`
          makes — this reads `error`, not a separate value, so the two can never disagree) already
          announces this; this second occupant of `viewer` is what fills the space the WebView
          just vacated, so a locked book reads as "this is why there's nothing here" rather than
          as a blank page underneath a thin strip of red text.

          `alert` + the live region, same pair the top banner uses, for the same reason: this is
          the one thing on this screen a screen-reader user must be told about without hunting for
          it, and it is the thing focus should land on once the WebView it replaces has unmounted.
        */}
        {locked && error !== null && (
          <View
            style={styles.lockedState}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
          >
            <Text style={styles.errorCode}>{error.code}</Text>
            <Text style={styles.errorMessage}>{error.message}</Text>
          </View>
        )}

        {showToc && (
          <View style={styles.tocPanel}>
            <Text style={styles.tocTitle}>Contents</Text>
            {/*
              DO NOT ADD `flex: 1` HERE "so the list scrolls". It was tried, and it is a
              no-op: RN's ScrollView already carries flexGrow/flexShrink: 1 in its own
              base style (react-native/Libraries/Components/ScrollView/ScrollView.js:1881),
              so it is already bounded by this absolutely-filled panel. Measured on device
              2026-08-14 with the 22-entry fixture TOC and NO style here: frame 600pt,
              content 1054pt — i.e. already scrolling. Yoga's flexShrink: 0 default, which
              is the usual reason to reach for flex: 1, does not apply to ScrollView.
            */}
            {/*
              The fades anchor to THIS wrapper rather than to the panel, so their
              offsets are the list's own edges — no restating the panel's padding and
              no guessing the header's height. `flex: 1` IS needed here (unlike on the
              ScrollView, which brings its own base style): a plain View defaults to
              flexShrink: 0.
            */}
            <View style={styles.tocListWrap}>
              <ScrollView
                testID="reader-toc-list"
                // BOUNDING THE LIST, which is a different problem from scrolling it. The
                // panel's edge cuts whichever row happens to cross it, and a row sliced
                // by a straight edge reads as a broken layout rather than as "there is
                // more below". Four parts:
                //  - the fades below dissolve the cut instead of ending it on a line;
                //  - contentContainerStyle's paddingBottom lets the FINAL entry come
                //    fully clear of the edge rather than resting half-hidden under it;
                //  - the divider above the list closes the header off;
                //  - the scroll indicator is the affordance that says "scrollable".
                // The three handlers feed recomputeFades — see the note there for why a
                // short list needs all three and not just onScroll.
                style={styles.tocList}
                contentContainerStyle={styles.tocListContent}
                showsVerticalScrollIndicator
                scrollEventThrottle={16}
                onLayout={(event) => {
                  listFrameRef.current = event.nativeEvent.layout.height;
                  recomputeFades();
                }}
                onContentSizeChange={(_width, height) => {
                  listContentRef.current = height;
                  recomputeFades();
                }}
                onScroll={(event) => {
                  listOffsetRef.current = event.nativeEvent.contentOffset.y;
                  recomputeFades();
                }}
              >
                {toc.length === 0 ? (
                  <Text style={styles.tocEmpty}>No table of contents in this title.</Text>
                ) : (
                  // Index-composed key, NOT the target alone. A real book's TOC repeats targets: the
                  // 20 MB fixture's NCX has src="Accessed%2024" five times (malformed nav points the
                  // producer emitted from citation text), which collided and raised React's
                  // duplicate-key warning on device. Targets are not unique in the wild, so they
                  // cannot be identity here — and a PDF outline repeats page numbers by design, since
                  // several sections legitimately open on the same page.
                  toc.map((item, index) => {
                    // A nav point with no href (epubOutline.ts's flattenToc keeps a grouping
                    // heading rather than dropping it, as `{kind:'href', href:''}`) has nothing to
                    // navigate to. `disabled` stops onPress from firing at all, so this never
                    // reaches goTo -> epub.entry.ts's `rendition.display('')`, whose behavior is
                    // otherwise unverified.
                    const isNavigable = item.target.kind !== 'href' || item.target.href !== '';
                    return (
                      <Pressable
                        key={`${index}-${targetKey(item.target)}`}
                        // THE PANEL'S FOCUS ENTRY POINT, on this row and no other — see
                        // `firstTocRowRef`'s own note. `null` rather than `undefined` for the rest:
                        // both leave the element unref'd, but `null` says the omission is a choice.
                        //
                        // NOT SKIPPED WHEN THE ROW IS DISABLED. A grouping heading with no href is
                        // still a real, announceable stop in the traversal, and it is where a
                        // sighted user's eye lands too; sending focus past it to the first
                        // NAVIGABLE row would silently hide the outline's top level from a screen
                        // reader.
                        ref={index === 0 ? firstTocRowRef : null}
                        disabled={!isNavigable}
                        accessibilityState={{ disabled: !isNavigable }}
                        // NO HINT ON A DISABLED ROW. `disabled` already tells TalkBack/VoiceOver
                        // the row is non-interactive; a hint repeating that is noise, not signal.
                        accessibilityHint={isNavigable ? 'Navigates to this chapter' : undefined}
                        onPress={() => {
                          goTo(item.target);
                          // THE ONE "restore focus" CASE. `goTo` deliberately does not do this
                          // itself — it is shared with bookmarks and the page-jump field, where
                          // Contents is not where the user came from. Here it is.
                          focusOn(contentsButtonRef);
                        }}
                        // Indent, do not inset the row: paddingLeft keeps the whole
                        // width tappable at every depth, where marginLeft would shrink
                        // the touch target of the entries that are already hardest to
                        // hit. `depth` is clamped by parseReaderMessage, so this cannot
                        // run away.
                        // Two elements when navigable, matching every row before this change
                        // (pinned by the depth-indent test) — the disabled style only extends the
                        // array for a grouping heading, which that test never covers.
                        style={
                          isNavigable
                            ? [styles.tocItem, { paddingLeft: item.depth * TOC_INDENT_PX }]
                            : [
                                styles.tocItem,
                                { paddingLeft: item.depth * TOC_INDENT_PX },
                                styles.tocItemDisabled,
                              ]
                        }
                      >
                        <Text style={styles.tocItemText}>{item.label}</Text>
                      </Pressable>
                    );
                  })
                )}
              </ScrollView>

              {/*
              THE FADES. Rendered as siblings AFTER the ScrollView so they paint over
              it, and `pointerEvents="none"` so they never eat a tap meant for the row
              underneath — a fade that swallows touches is worse than the sliced row it
              replaced.

              Conditional rather than always-mounted with zero opacity: at the top of
              the list there is nothing above to fade, and a permanent white veil over
              the first row would be the same visual bug in a different place.

              The colour is the panel's own background (`color.white`), so the gradient
              dissolves the row into the panel rather than tinting it. If the panel ever
              moves to a dark reading theme, these two constants move with it — which is
              why they sit next to it rather than inline.
            */}
              {/* `pointerEvents="none"` keeps them out of the way of a finger; the two a11y props
                  keep them out of the way of a screen reader. Both are needed and neither implies
                  the other — a swipe-to-next-element walk visits nodes regardless of hit-testing,
                  so without these the traversal stops twice on a decorative gradient with nothing
                  to announce. Same pair as the swipe catcher and the privacy cover. */}
              {fades.top && (
                <LinearGradient
                  testID="reader-toc-fade-top"
                  pointerEvents="none"
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  colors={TOC_FADE_DOWN}
                  style={[styles.tocFade, styles.tocFadeTop]}
                />
              )}
              {fades.bottom && (
                <LinearGradient
                  testID="reader-toc-fade-bottom"
                  pointerEvents="none"
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  colors={TOC_FADE_UP}
                  style={[styles.tocFade, styles.tocFadeBottom]}
                />
              )}
            </View>
          </View>
        )}

        {/*
          Both search surfaces OVERLAY the viewer rather than sharing the column with
          it, and that is load-bearing rather than cosmetic: anything that changes the
          viewer's height resizes the WebView, epub.js re-paginates on resize, and a
          CFI resolved under one pagination points at a different page under another.
          Floating them keeps the viewer a fixed size, so a hit's CFI means the same
          thing when it is tapped as when it was indexed. See SearchMatchBar.tsx.
        */}
        {showSearch && (
          <SearchPanel
            query={search.query}
            onQueryChange={search.setQuery}
            onSubmit={() => {
              // A fresh search means the tapped hit's queued jump, if any, no longer
              // matches what is on screen — cancel rather than let it fire later against
              // a different result set.
              cancelPendingSeek();
              search.submit();
            }}
            onClose={() => {
              cancelPendingSeek();
              setShowSearch(false);
              // THE EXPLICIT-CLOSE PATH ONLY. The user dismissed the panel without choosing
              // anything, so the toolbar button they opened it from is where they were. Selecting a
              // result also closes this panel and deliberately does NOT restore focus here — that
              // journey ends somewhere else entirely (the match bar, or the book), which is its own
              // open question and not answered by sending the user back to the toolbar.
              focusOn(searchButtonRef);
            }}
            status={search.status}
            hits={search.hits}
            submittedTerm={search.submittedTerm}
            failure={search.failure}
            activeIndex={search.activeIndex}
            onSelectHit={selectHit}
            awaitingSeek={awaitingSeek}
            indexMissing={search.indexMissing}
          />
        )}

        {/*
          The match is on screen but the shell could not mark the exact words — an EPUB point CFI
          that would not expand to a range, a range the user's own highlight already owns, or a PDF
          offset that resolved to a page but not a phrase. Surfaced rather than only logged, the
          same reasoning as the skipped-highlights notice: navigation SUCCEEDED, so silence here
          leaves the reader scanning the page for a word they were told is on it.

          "Could not pinpoint" rather than "could not highlight" because it has to be true of both
          shells: the PDF side falls back to outlining the whole page, so something IS drawn — just
          not the word.

          Sits directly above the match bar rather than with the highlight notice at the foot of the
          page: it is about the match the bar is counting, and the two would otherwise stack on the
          same pixels. OVERLAYS, never reflows — SearchMatchBar.tsx's own header has why that rule
          binds everything search puts on screen.
        */}
        {!showSearch && search.hits.length > 0 && unpaintedMatchKey === activeMatchKey && (
          <View style={styles.searchNoticeWrap} pointerEvents="none">
            <Text style={styles.highlightNotice}>Could not pinpoint the match on the page</Text>
          </View>
        )}

        {/* The find bar you read against: only once there is something to step through,
            and only while the panel is closed, since the panel covers it anyway. */}
        {!showSearch && search.hits.length > 0 && (
          <SearchMatchBar
            ref={matchBarCounterRef}
            hits={search.hits}
            activeIndex={search.activeIndex}
            submittedTerm={search.submittedTerm}
            onStep={stepHit}
            onOpenResults={() => {
              closeToc(false); // the results panel is opening — see closeToc's own note.
              setShowBookmarks(false);
              setShowAccessibility(false);
              setShowSearch(true);
            }}
            onDismiss={() => {
              cancelPendingSeek();
              search.clear();
            }}
          />
        )}

        {/* Same overlay treatment as Contents/Search, for the same reason — see the note above
            SearchPanel. */}
        {showBookmarks && (
          <BookmarksPanel
            bookmarks={bookmarksForOpenBook}
            loaded={bookmarksLoaded}
            skippedBookmarkCount={skippedBookmarkCount}
            onSelect={selectBookmark}
            onDelete={deleteBookmark}
            onRename={submitBookmarkRename}
            onAddCurrent={addCurrentBookmark}
            canAddCurrent={canAddCurrentBookmark}
            onClose={() => {
              setShowBookmarks(false);
            }}
          />
        )}

        {/*
          A MODAL, not an absolute-fill sibling of the viewer like TOC/Search/Bookmarks — the one
          merged ♿ entry point is now a content-sized dropdown, not a full-bleed panel, and a
          content-sized box that merely SITS OVER a WebView doesn't actually hide it: `hidden` on
          `ReaderWebView` (driven by `anyPanelOpen` below) only removes it from the accessibility
          tree, not from the screen, and Android's WebView ignores sibling `elevation`/`zIndex`
          entirely — the exact bug `DevPreferencesMenu.tsx`'s own `Modal` exists to dodge (see that
          file's comment on `anchor`). A `Modal` paints in its own native window, above the WebView
          unconditionally, on both platforms.

          NO TITLE, NO NAMED CLOSE BUTTON, deliberately — matches `DevPreferencesMenu`'s dropdown
          exactly: dismiss by tapping outside, by pressing the ♿ toggle again, or (Android) the back
          button. `focusOn(accessibilityButtonRef)` still runs on every dismiss path below, so
          screen-reader focus still lands back on the button that opened this, same restore rule as
          every other panel here — only the visible "Close" affordance is gone, not the behaviour.
        */}
        {showAccessibility && (
          <Modal
            transparent
            visible={showAccessibility}
            onRequestClose={() => {
              setShowAccessibility(false);
              focusOn(accessibilityButtonRef);
            }}
          >
            <Pressable
              testID="accessibility-dropdown-backdrop"
              style={StyleSheet.absoluteFill}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              onPress={() => {
                setShowAccessibility(false);
                focusOn(accessibilityButtonRef);
              }}
            />
            <View
              style={[
                styles.accessibilityDropdown,
                accessibilityAnchor && {
                  top: accessibilityAnchor.top,
                  right: accessibilityAnchor.right,
                  maxWidth: accessibilityAnchor.maxWidth,
                },
              ]}
            >
              {/* BOUNDED, not flex: 1 — a `Modal`'s content sizes against the whole screen, so
                  without an explicit cap this box would grow as tall as its content on a small
                  phone in landscape, the exact overflow case the old full-bleed panel's own
                  ScrollView already had to cover. `windowHeight` (from `useWindowDimensions`, not a
                  one-off `Dimensions.get`) keeps that cap correct across a rotation while the
                  dropdown is open. 0.7 is unchanged above `ACCESSIBILITY_DROPDOWN_COMPACT_MAX_WIDTH`
                  (the tablet case that was already "perfect"); below it, 0.5 leaves roughly half a
                  phone's screen visible behind the dropdown instead of nearly all of it. */}
              <ScrollView
                style={{ maxHeight: windowHeight * (isAccessibilityDropdownCompactWidth ? 0.5 : 0.7) }}
                contentContainerStyle={styles.accessibilityContent}
              >
                {/* `undefined` rather than a guess while the book is still resolving: the prop's own
                    doc says omitting it means "not scoped to one open book", which shows every
                    control. That is the honest state — High Contrast and Reduce Motion are already
                    usable, and the Dyslexia Font row becomes accurate the moment `prepareBook`
                    lands. The dyslexia override itself is gated separately, host-side, in
                    `withDyslexiaFont`. */}
                <AccessibilitySettingsPanel format={format ?? undefined} />

                {/* The merged-in second entry point: was its own toolbar icon
                    ("Accessibility information"), now a row in this same dropdown. Closes the
                    dropdown and hands off to whatever `ReaderRouteScreen.tsx` wired up
                    (`navigation.navigate('BookInfo', ...)`) — no focus restore here, unlike the
                    dismiss paths above, since the screen is about to change entirely. */}
                <AccessibilityInfoButton
                  onPress={() => {
                    setShowAccessibility(false);
                    onOpenAccessibilityInfo?.();
                  }}
                />
              </ScrollView>
            </View>
          </Modal>
        )}

        {/* LAST child of `viewer`, deliberately: it must paint over the WebView, the busy overlay
            and the TOC panel, all of which can be showing book-derived content. */}
        {isObscured && (
          <View
            style={styles.privacyCover}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Text style={styles.privacyCoverText}>TF Reader</Text>
          </View>
        )}
      </View>

      {/* Docked below the viewer rather than an absolute overlay like the TOC/Search panels — its
          own styling already assumes ordinary document flow (a border-top separator, not a floating
          panel with fades). Shown on exactly the condition that gives `useTtsSession` something to
          drive, so a transport is never on screen over a session that cannot speak. */}
      {ttsControlsVisible && <TtsControls session={ttsSession} />}

      {!ttsControlsVisible && (
        <View
          style={styles.controls}
          accessibilityElementsHidden={controlsHidden}
          importantForAccessibility={controlsHidden ? 'no-hide-descendants' : 'yes'}
        >
          {/* Explicit label because the glyph carries no accessible name — "‹ Prev" reads as the
            guillemet plus an abbreviation. `accessibilityState` is explicit for the same reason it
            is on Next and Contents: `disabled` alone leaves it to the platform to synthesise, and
            this row's disabled states are load-bearing (see `prevDisabled`). */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Previous page"
            accessibilityState={{ disabled: prevDisabled }}
            disabled={prevDisabled}
            onPress={() => {
              pendingInitialVerifyRef.current = null; // see `goTo`'s own note on why
              send?.({ type: 'prev' });
            }}
            style={[styles.button, prevDisabled && styles.buttonDisabled]}
          >
            <Text style={styles.buttonText}>‹ Prev</Text>
          </Pressable>

          {/*
          THE COUNT STAYS OUT OF THE ACCESSIBLE NAME. The visible text carries it, but a name that
          changes from "Contents (0)" to "Contents (37)" when the `toc` message lands renames a
          control the user may already have focused. The name is stable; the count is decoration.

          `expanded` IS OMITTED WHEN THERE IS NO TOC, rather than reported as `false`. A control
          that can never open is not "collapsed" — pairing `expanded: false` with `disabled: true`
          invites VoiceOver's "collapsed, expandable" phrasing for a button that will never expand.
          Disabled is the whole truth in that state; expanded is the whole truth in the other.
        */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={showToc ? 'Close contents' : 'Contents'}
            accessibilityState={toc.length === 0 ? { disabled: true } : { expanded: showToc }}
            ref={contentsButtonRef}
            disabled={toc.length === 0}
            onPress={() => {
              setShowSearch(false); // mutual exclusion — see the toolbar button above
              setShowBookmarks(false);
              setShowAccessibility(false);
              setShowToc((open) => !open);
            }}
            style={[styles.button, toc.length === 0 && styles.buttonDisabled]}
          >
            <Text style={styles.buttonText}>{showToc ? 'Close' : `Contents (${toc.length})`}</Text>
          </Pressable>

          {/*
          THE PAGE INDICATOR, DOUBLING AS THE PAGE-JUMP AFFORDANCE. PDF-only by construction rather
          than by choice: `position` is discriminated by addressing scheme, and a reflowable book
          reports a CFI because it has no stable page. Rendering nothing for a CFI is the honest
          outcome — a fabricated "page 3 of 400" would be a number that changes with the font size.

          THE INDICATOR *IS* THE CONTROL, rather than a fourth item in this row. The row is already
          three buttons wide on a phone, and "tap where the page number is to change the page" needs no
          explaining. It also means the affordance appears exactly when it is usable, because both it
          and the number come from the same message.

          NOTE WHAT THIS IS NOT: a table of contents. A PDF with no outline has no contents, and
          Contents stays correctly disabled for it — most PDFs in the wild are that. This is the
          navigation such a book can actually offer.
        */}
          {position?.kind === 'page' &&
            (pageJump === null ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Page ${position.page} of ${position.pageCount}. Go to a page.`}
                onPress={() => setPageJump('')}
                testID="reader-page-indicator"
              >
                <Text style={styles.pageIndicator}>
                  {position.page} / {position.pageCount}
                </Text>
              </Pressable>
            ) : (
              <TextInput
                testID="reader-page-jump"
                // The placeholder carries the RANGE, which is the whole benefit of the host knowing
                // pageCount: the bound is visible before you type rather than discovered by being
                // refused. A placeholder is not a reliable accessible name on Android, so the label is
                // explicit as well.
                accessibilityLabel={`Go to page, 1 to ${position.pageCount}`}
                placeholder={`1–${position.pageCount}`}
                placeholderTextColor={color.textSecondary}
                style={styles.pageJump}
                value={pageJump}
                onChangeText={setPageJump}
                onSubmitEditing={submitPageJump}
                onBlur={() => setPageJump(null)}
                keyboardType="number-pad"
                returnKeyType="go"
                autoFocus
                maxLength={String(position.pageCount).length}
              />
            ))}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Next page"
            accessibilityState={{ disabled: nextDisabled }}
            disabled={nextDisabled}
            onPress={() => {
              pendingInitialVerifyRef.current = null; // see `goTo`'s own note on why
              send?.({ type: 'next' });
            }}
            style={[styles.button, nextDisabled && styles.buttonDisabled]}
          >
            <Text style={styles.buttonText}>Next ›</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

// `forwardRef` only for `ReaderScreenHandle` — see that type's own doc comment. Every existing
// caller keeps working unchanged: a `ref` prop is simply optional on a forwardRef component.
export const ReaderScreen = forwardRef(ReaderScreenComponent);
ReaderScreen.displayName = 'ReaderScreen';

/**
 * A target as a string, for React's key only.
 *
 * NOT for display and not for comparison: it exists because a key must be a string and `ReaderTarget`
 * is an object. Composed with the `kind` so the two addressing schemes cannot collide — an href of
 * `'12'` and page 12 are different rows.
 */
function targetKey(target: ReaderTarget): string {
  return target.kind === 'page' ? `p${target.page}` : `h${target.href}`;
}

/**
 * Indent per TOC nesting level. A book's navigation document is a tree; the bridge
 * flattens it and carries a `depth`, so this is the only place the tree is visible.
 */
const TOC_INDENT_PX = space.md;

/**
 * Slack, in points, before an edge counts as "scrolled away from".
 *
 * Not zero: contentOffset and contentSize are floats that rarely land on exactly the
 * same value (the fixture's list measures 1053.666…), so an equality test leaves the
 * bottom fade showing when the list IS at its end.
 */
const FADE_EPSILON_PX = 1;

// Transparent → panel background. Written as rgba rather than '#ffffff00' because
// Android's colour parser has historically been unreliable with 8-digit hex.
const TOC_FADE_UP = ['rgba(255, 255, 255, 0)', color.white] as const;
const TOC_FADE_DOWN = [color.white, 'rgba(255, 255, 255, 0)'] as const;

/** Overlay fill. See the note on `busy` below for why this is not absoluteFillObject. */
const FILL = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 } as const;

// Matches DevPreferencesMenu.tsx's own DROPDOWN_EDGE_MARGIN — same shape of anchor maths, same
// margin, so the two dropdowns feel like one family even though they're two components.
const ACCESSIBILITY_DROPDOWN_EDGE_MARGIN = 12;

// Google's Material Design "compact" window-size-class boundary (compact width < 600dp) — an
// authoritative phone/tablet width threshold. Deliberately NOT DevPreferencesMenu.tsx's own
// `SPREAD_MIN_WIDTH` (800): that number is calibrated to epub.js's two-page-spread fit, a
// different question, and reusing it here would misclassify an iPad mini's ~744pt portrait width
// as a "phone" — exactly the tablet case this threshold exists to leave alone. Below this width,
// the accessibility dropdown sizes down (see `isAccessibilityDropdownCompactWidth`'s use below and
// in `styles.accessibilityDropdown`'s anchor calc) so it never covers nearly the whole screen on a
// phone the way a flat percentage of window size did; at or above it, sizing is unchanged from
// before this threshold existed.
const ACCESSIBILITY_DROPDOWN_COMPACT_MAX_WIDTH = 600;

const styles = StyleSheet.create({
  // Reads as a status line rather than a control: no border, no press affordance. Tabular figures so
  // the row does not shift width as the page number gains a digit.
  pageIndicator: {
    fontSize: 13,
    color: color.textSecondary,
    fontVariant: ['tabular-nums'],
  },
  // Sized to the widest page number it can hold rather than to its content, so opening the field does
  // not reflow the controls row underneath the user's finger.
  pageJump: {
    minWidth: 54,
    fontSize: 13,
    color: color.textPrimary,
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: color.textSecondary,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  // flex:1 down to the WebView. See the note in ReaderWebView.tsx — epub.js
  // renders nothing at all into a zero-height container.
  container: { flex: 1, backgroundColor: color.white },
  viewer: { flex: 1 },

  // Right-aligned so the icon falls under the thumb rather than next to the native-stack header's
  // own title/back button above it. 44pt is the minimum comfortable touch target.
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: space.xs,
  },
  toolbarButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.card,
  },
  toolbarIcon: { fontSize: 20 },
  // Ultramarine (`color.primary`) — the same brand blue used for active tabs/links elsewhere, so a
  // bookmarked page reads as an active state rather than an arbitrary accent (CONVENTIONS §5).
  toolbarIconBookmarked: { color: color.primary },

  highlightNoticeWrap: { position: 'absolute', left: 8, right: 8, bottom: 8, alignItems: 'center' },
  // Clears the match bar (bottom 12, ~48 tall) so the two never overlap.
  searchNoticeWrap: { position: 'absolute', left: 8, right: 8, bottom: 68, alignItems: 'center' },
  highlightNotice: {
    // Indigo (`color.navy`), the brand's own "dark overlays" colour — rgba because RN has no alpha
    // channel prop separate from the colour itself.
    backgroundColor: 'rgba(0, 34, 68, 0.85)',
    color: color.white,
    fontSize: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.card,
    overflow: 'hidden',
    textAlign: 'center',
  },

  // Explicit inset rather than StyleSheet.absoluteFillObject: RN 0.86's types
  // export only `absoluteFill`, so the *Object form is a typecheck error here.
  busy: { ...FILL, alignItems: 'center', justifyContent: 'center' },
  busyText: { marginTop: 8, fontSize: 13, color: color.textSecondary },

  // Its own absolute element, inset from both edges the same way the removed bookmark badge was —
  // see the JSX's own note for why the page's top margin is where this belongs.
  ttsCueWrap: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    // Cornflower tint (`color.subscriptionTint`) / `color.subscription` border — the saturated blue
    // that tint is meant to sit against, distinct from the toolbar's own bookmark blue.
    backgroundColor: color.subscriptionTint,
    borderWidth: 1,
    borderColor: color.subscription,
    shadowColor: color.navy,
    shadowOpacity: 0.2,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  ttsCueIcon: { fontSize: 15 },

  errorBanner: {
    backgroundColor: color.errorTint,
    borderBottomWidth: 1,
    // No lighter/tint border token exists for error state, so this borrows `color.error` itself
    // rather than inventing an untracked hex (CONVENTIONS §5).
    borderBottomColor: color.error,
    padding: 12,
  },
  errorCode: { fontSize: 12, fontWeight: '700', color: color.error },
  errorMessage: { marginTop: 4, fontSize: 13, color: color.error },

  // Same explicit-inset FILL as `busy` — see that style's own note on why not
  // StyleSheet.absoluteFillObject. Centred rather than top-anchored like the banner: this is the
  // whole content of the viewer while it applies, not a strip alongside other content.
  lockedState: {
    ...FILL,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    backgroundColor: color.errorTint,
  },

  tocPanel: {
    ...FILL,
    backgroundColor: color.white,
    borderTopWidth: 1,
    borderTopColor: color.border,
    padding: space.md,
  },
  tocTitle: { fontSize: 18, fontWeight: '700', color: color.textPrimary, marginBottom: 12 },

  // The merged Accessibility dropdown's chrome — content-sized, not the opaque full-bleed overlay
  // TOC/Bookmarks use, since (unlike those) this panel holds no book-derived content that needs
  // hiding, only settings UI. `position: 'absolute'` + the anchored `top`/`right` (set inline, once
  // measured) is what lets it float near the ♿ button instead of centring on the Modal's own
  // full-screen layout. `alignSelf: 'flex-start'` mirrors DevPreferencesMenu.tsx's own dropdown
  // style for the same reason that file's comment gives: without it, Android's Modal-window flex
  // container stretches this box edge-to-edge, while iOS's Yoga resolution shrink-wraps it from the
  // same style object — so the two platforms would render two different widths from one style.
  accessibilityDropdown: {
    position: 'absolute',
    top: 48,
    right: 0,
    alignSelf: 'flex-start',
    minWidth: 220,
    backgroundColor: color.white,
    borderRadius: radius.tile,
    borderWidth: 1,
    borderColor: color.border,
    padding: 12,
    // Indigo (`color.navy`) rather than plain black, matching the elevation shadows the shared
    // component library already uses (`theme/tokens.ts`'s `elevation.card`/`elevation.raised`).
    boxShadow: '0px 4px 12px rgba(0, 34, 68, 0.12)',
    elevation: 6,
  },
  accessibilityContent: { paddingBottom: 4 },

  // Only a TOP hairline, to close the header off. There is deliberately no bottom
  // border any more: a hairline and a fade at the same edge fight each other — the
  // line reasserts the hard cut the fade exists to dissolve.
  tocList: { borderTopWidth: 1, borderTopColor: color.border },

  // Room for the last entry to scroll clear of the panel edge. One row's worth, so it
  // does not read as a gap when the list is short.
  tocListContent: { paddingBottom: 48 },

  tocListWrap: { flex: 1 },

  // Anchored to tocListWrap, so these offsets are the list's own edges. 40pt is about
  // one and a half rows: long enough that the dissolve is gradual rather than a
  // soft-edged band, short enough that it never obscures a whole entry.
  tocFade: { position: 'absolute', left: 0, right: 0, height: 40 },
  // 1, not 0: sits directly below the list's top hairline instead of washing it out.
  tocFadeTop: { top: 1 },
  tocFadeBottom: { bottom: 0 },
  tocEmpty: { fontSize: 14, color: color.textSecondary },
  tocItem: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: color.border },
  tocItemText: { fontSize: 15, color: color.textPrimary },
  // A grouping heading with no href — see the note at the TOC row's `isNavigable` check.
  tocItemDisabled: { opacity: 0.5 },

  // FULLY OPAQUE is the whole point — a translucent cover still photographs the text underneath.
  privacyCover: {
    ...FILL,
    backgroundColor: color.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  privacyCoverText: { fontSize: 17, fontWeight: '700', color: color.textSecondary },

  controls: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: color.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: space.sm,
  },
  button: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: radius.card,
    backgroundColor: color.surface,
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { fontSize: 14, fontWeight: '700', color: color.textPrimary },
});
