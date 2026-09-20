// Owner: Reader (Ahana).
//
// Coverage for the parts of ReaderScreen a unit test can actually reach: the
// Contents panel and the chrome around it. The reader itself — epub.js,
// pagination, anything visual — only exists on a device. jest.setup.js replaces
// react-native-webview with an inert <View>, so nothing here asserts against a
// rendition, and a test that pretended otherwise would be asserting against the
// mock.
//
// What it DOES assert is that the host half handles a `toc` message the way a
// real book delivers one: dozens of entries, nested, with duplicate hrefs.
//
// NOT ASSERTED, AND DELIBERATELY: that the list scrolls. It was suspected of not
// scrolling and it does — measured on the iPhone 17 Pro simulator on 2026-08-14
// against the 22-entry fixture TOC, with no flex style on the ScrollView at all:
// frame 600pt against 1054pt of content. RN's ScrollView carries
// flexGrow/flexShrink: 1 in its own base style, so it is bounded by its parent
// already. Jest has no layout engine, so no test here could have told us that
// either way — the number came from the device, and it is recorded next to the
// ScrollView so the no-op "fix" is not reattempted.
//
// WHY THE TWO SEAMS ARE MOCKED: getReaderHtmlUri() resolves a bundled asset
// through expo-asset, and under Jest `require('*.html')` is a numeric stub that
// Asset.fromModule cannot resolve — the screen would sit on ASSET_LOAD_FAILED and
// never mount a WebView to send messages to. Mocking readerAssets also keeps the
// whole encryption stack out of a chrome test; the bytes path has its own
// coverage in wholeBookBudget.test.ts. Only the seams are mocked, never the logic
// under test.

import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { AccessibilityInfo, Alert, StyleSheet } from 'react-native';

import Ionicons from '@expo/vector-icons/Ionicons';
import { color } from '@theme/tokens';

import { closeBook, getIndex } from '@/features/encryption/contentProvider';
import { loadDyslexiaFontFaceSrc } from '@/features/accessibility/dyslexiaFontLoader';
import { DownloadError, DownloadFailure } from '@/features/download/errors';
import { startAccessMonitor } from '@/features/download/readingAccessMonitor';
import { loadFontFaceSrc } from '@/features/personalization/fontFaceLoader';
import { prefsStore } from '@/features/personalization/prefsStore';
import { toReaderAppearance } from '@/features/personalization/readerAppearance';
import type { AppearanceEnv } from '@/features/personalization/readerAppearance';
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
import { focusOn } from '@/features/reader/a11yFocus';
import { ReaderScreen } from '@/features/reader/ReaderScreen';
import {
  getBookBase64,
  getReaderHtmlUri,
  prepareBook,
  UnsupportedFormatError,
} from '@/features/reader/readerAssets';
import { buildCommandScript } from '@/features/reader/readerBridge';
import type { ReaderTocItem } from '@/features/reader/readerBridge';
import { useAppearanceEnv } from '@/features/reader/useAppearanceEnv';
import { useScreenReaderEnabled } from '@/features/reader/useScreenReaderEnabled';
import { queryBookIndex } from '@/features/search/queryBookIndex';
import type { ReaderSearchMatch } from '@/features/search/readerSearchMatch';
import { DEFAULT_PREFS, OFFLINE_LOCK_EVENTS } from '@/shared/contracts';
import type { ContentFormat, LockSignal, SearchHit, SharedPrefs } from '@/shared/contracts';
import { eventBus, resetEventBusForTests } from '@/shared/eventBus';

/**
 * The byte/asset seam. `prepareBook` decides the format, which decides BOTH the shell
 * URI and the open command, so it is the one mock a format test has to move.
 *
 * `UnsupportedFormatError` is the real class, not a stub: ReaderScreen maps it to
 * UNSUPPORTED_FORMAT with `instanceof`, so a stubbed one would never match and the
 * AUDIO test would pass through the generic ASSET_LOAD_FAILED branch instead —
 * green, and testing the wrong path.
 */
jest.mock('@/features/reader/readerAssets', () => {
  const actual = jest.requireActual<typeof import('@/features/reader/readerAssets')>(
    '@/features/reader/readerAssets',
  );
  return {
    UnsupportedFormatError: actual.UnsupportedFormatError,
    prepareBook: jest.fn(() => Promise.resolve('EPUB')),
    getReaderHtmlUri: jest.fn((format: string) =>
      Promise.resolve(`file:///reader-${format.toLowerCase()}.html`),
    ),
    getBookBase64: jest.fn(() => Promise.resolve('UEsDBA==')),
  };
});

jest.mock('@/features/encryption/contentProvider', () => ({
  closeBook: jest.fn(() => Promise.resolve()),
  // `useBookSearch` asks this after an EMPTY result, to tell "no matches" apart from "this book
  // ships no index". Bytes by default, so an ordinary empty search reads as "no matches" — the
  // no-index case sets it to null per test.
  getIndex: jest.fn(() => Promise.resolve(new Uint8Array([1]))),
}));

/**
 * The periodic re-check seam. Real by default (nothing here ever mocked it, and it costs
 * nothing — a 5-minute interval and a `verifyReadingAccess()` fetch that fails open under Jest),
 * but the offline-lock tests below need to fire ACCESS_REVOKED on demand rather than waiting on a
 * real network call, so it is mocked file-wide and given a default no-op handle. Mocking this was
 * never going to change any EXISTING test's outcome: nothing here asserted on it, and a
 * 5-minute interval that never fires within a test's lifetime is indistinguishable from a
 * `jest.fn()` that returns an inert handle.
 */
jest.mock('@/features/download/readingAccessMonitor', () => ({
  startAccessMonitor: jest.fn(() => ({
    stop: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
  })),
}));

/**
 * The TTS native-module seam. `ReaderScreen` now calls `useTtsSession` unconditionally (Rules of
 * Hooks — see its own note), and `useTtsSession` imports `@iternio/react-native-tts` via
 * `ttsEngine.ts`. That package ships ES module syntax Jest's default transform does not parse, so
 * every test here needs this mocked regardless of whether it exercises TTS — same seam
 * `useTtsSession.test.ts` mocks, at the same path, for the same reason.
 */
jest.mock('@/features/accessibility/tts/ttsEngine', () => ({
  __esModule: true,
  default: {
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    speak: jest.fn(() => Promise.resolve('utterance-1')),
    stop: jest.fn(() => Promise.resolve(true)),
    pause: jest.fn(() => Promise.resolve(true)),
    resume: jest.fn(() => Promise.resolve(true)),
    setDefaultRate: jest.fn(() => Promise.resolve(true)),
    setDefaultPitch: jest.fn(() => Promise.resolve(true)),
    setDefaultVoice: jest.fn(() => Promise.resolve(true)),
    setIgnoreSilentSwitch: jest.fn(() => Promise.resolve(true)),
    voices: jest.fn(() => Promise.resolve([])),
  },
}));

/**
 * Mock the SEARCH SEAM, not contentProvider's getIndex behind it.
 *
 * Required, not merely convenient: the real queryBookIndex imports getIndex from
 * contentProvider, and the factory above deliberately supplies only closeBook — so an
 * unmocked search call dies with "getIndex is not a function", which reads like a
 * search bug rather than a missing mock. Widening that factory instead would drag
 * contentStore, expo-file-system and the keychain into a chrome test.
 */
jest.mock('@/features/search/queryBookIndex', () => ({
  queryBookIndex: jest.fn(() => Promise.resolve([])),
}));

/**
 * The BOOKMARKS SEAM (Personalization's readerBookmarks.ts), not the sync store behind it — same
 * reasoning as mocking queryBookIndex above rather than getIndex: this file is chrome coverage, and
 * bookmarkStore's own SQLite round-tripping has its own tests in readerBookmarks.test.ts. Every call
 * defaults to an empty set; individual tests override with mockResolvedValueOnce/mockResolvedValue.
 */
jest.mock('@/features/personalization/readerBookmarks', () => ({
  loadBookmarks: jest.fn(() => Promise.resolve({ bookmarks: [], skippedIds: [] })),
  addCurrentEpubBookmark: jest.fn(() => Promise.resolve({ bookmarks: [], skippedIds: [] })),
  addCurrentPdfBookmark: jest.fn(() => Promise.resolve({ bookmarks: [], skippedIds: [] })),
  removeBookmark: jest.fn(() => Promise.resolve({ bookmarks: [], skippedIds: [] })),
  renameBookmark: jest.fn(() => Promise.resolve({ bookmarks: [], skippedIds: [] })),
  // Inert by default: real behaviour (re-loading on a pulled change) is covered by its own
  // describe block below, which overrides this per test.
  subscribeToBookmarkChanges: jest.fn(() => () => {}),
}));

/**
 * The highlights writes half. Mocked at the same seam as bookmarks and search's `queryBookIndex`,
 * for the same reason: `readerHighlights.ts` is Personalization's, is unit-tested there, and reaches
 * SQLite — what this file covers is what the READER does with what it hands back.
 */
jest.mock('@/features/personalization/readerHighlights', () => ({
  loadReaderHighlights: jest.fn(() =>
    Promise.resolve({ highlights: { epub: [], pdf: [] }, skippedIds: [] }),
  ),
  addEpubHighlight: jest.fn(() =>
    Promise.resolve({ highlights: { epub: [], pdf: [] }, skippedIds: [] }),
  ),
  addPdfHighlight: jest.fn(() =>
    Promise.resolve({ highlights: { epub: [], pdf: [] }, skippedIds: [] }),
  ),
  removeHighlight: jest.fn(() =>
    Promise.resolve({ highlights: { epub: [], pdf: [] }, skippedIds: [] }),
  ),
}));

/**
 * A named alias, not an inline `(prefs: SharedPrefs) => void` inside the factory below:
 * babel-plugin-jest-hoist's out-of-scope-variable check mis-parses an inline function-type
 * parameter name as a variable reference (a known quirk, not a real scope violation), and fails
 * the whole factory. Declaring it here, outside jest.mock()'s callback, avoids the parameter name
 * ever appearing inside the checked scope.
 */
type PrefsListener = (prefs: SharedPrefs) => void;

/**
 * The prefs-application seam. Mocked rather than exercised through the real (SQLite-backed)
 * store for the same reason the byte path is mocked above: this file is chrome coverage, and
 * `prefsStore`'s own contract (subscribe/notify semantics, SQLite round-tripping) has its own
 * tests in prefsStore.test.ts. `__emitPrefsChange` mirrors the `__injectJavaScript` convention
 * below — the one hook a test needs to drive the mock from outside.
 */
jest.mock('@/features/personalization/prefsStore', () => {
  const listeners = new Set<PrefsListener>();
  return {
    prefsStore: {
      getPrefs: jest.fn(),
      subscribe: jest.fn((listener: PrefsListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    },
    __emitPrefsChange: (prefs: SharedPrefs) => {
      for (const listener of listeners) listener(prefs);
    },
  };
});

const { __emitPrefsChange } = jest.requireMock('@/features/personalization/prefsStore') as {
  __emitPrefsChange: (prefs: SharedPrefs) => void;
};

/**
 * The OS half of `applyAppearance`'s inputs. Mocked for determinism: the real hook reads RN's
 * `Appearance`/`AccessibilityInfo`/`PixelRatio`, none of which this chrome test has any reason to
 * depend on the actual jest-preset defaults for.
 */
jest.mock('@/features/reader/useAppearanceEnv', () => ({
  useAppearanceEnv: jest.fn(),
}));

/**
 * Live screen-reader state. Mocked for the same reason `useAppearanceEnv` is, and defaulted to
 * FALSE so every other test in this file exercises the ordinary paginated path — the override is
 * opt-in by device state, and a test file where it was always on would be testing a configuration
 * almost no run of the app is in.
 */
jest.mock('@/features/reader/useScreenReaderEnabled', () => ({
  useScreenReaderEnabled: jest.fn(() => false),
}));

/**
 * Focus movement. Mocked because Jest has no native view tree for `findNodeHandle` to resolve — see
 * the note in the focus-order describe below for why that would silently invalidate its assertions.
 */
jest.mock('@/features/reader/a11yFocus', () => ({
  focusOn: jest.fn(),
}));

/**
 * The custom-font byte-loading seam. Mocked for the same reason `readerAssets` is: the real
 * implementation is native (expo-asset/expo-file-system), and its own contract ("null for
 * 'system'/unknown, a data: URI otherwise, never throws") is this mock's job to honour, not to
 * re-verify — that's fontFaceLoader's own concern. Defaults to `null`, matching every test's default
 * `font.family: 'system'`, so the existing `applyAppearance` assertions below (which compare against
 * `toReaderAppearance` directly) are unaffected unless a test opts into a real family.
 */
jest.mock('@/features/personalization/fontFaceLoader', () => ({
  loadFontFaceSrc: jest.fn(() => Promise.resolve(null)),
}));

/**
 * The dyslexia-font byte-loading seam. Mocked for the same reason `fontFaceLoader` is — the real
 * one is expo-asset + expo-file-system — but with one difference that matters: unlike
 * `loadFontFaceSrc`, the real `loadDyslexiaFontFaceSrc` CAN reject, and the screen's fallback for
 * that is the whole point of one of the tests below. So this mock is left rejectable rather than
 * being given a never-throws contract.
 */
jest.mock('@/features/accessibility/dyslexiaFontLoader', () => ({
  loadDyslexiaFontFaceSrc: jest.fn(() => Promise.resolve('data:font/ttf;base64,RFlTTA==')),
}));

const LIGHT_ENV: AppearanceEnv = {
  osColorScheme: 'light',
  osFontScale: 1,
  osReduceMotionEnabled: false,
};

/** A complete SharedPrefs, so toReaderAppearance never sees a partial record. Fresh identity
 * fields and a structuredClone of DEFAULT_PREFS per call, guarding against cross-test mutation. */
function makePrefs(overrides: Partial<SharedPrefs> = {}): SharedPrefs {
  return {
    ...structuredClone(DEFAULT_PREFS),
    id: 'prefs-1',
    userId: 'user-1',
    updatedAt: 0,
    isDeleted: false,
    synced: false,
    ...overrides,
  };
}

// Sane defaults for every test in this file, most of which have no opinion on appearance at all —
// without this, `prefsStore.getPrefs()` resolves `undefined` and `applyAppearanceWith`'s catch
// swallows the resulting throw, which happens to leave every existing assertion (all of which read
// the LAST or a RELATIVE injectJavaScript call, never an absolute count) unaffected either way. Set
// explicitly anyway so the applyAppearance-specific tests below have a real baseline to diff from.
beforeEach(() => {
  // Real timers for every test. `describe('the bounded wait on the byte path')` at line 884
  // installs fake timers in its own beforeEach; if its afterEach is skipped (test throws before
  // cleanup, or a prior file in the same Jest worker leaked fake timers), `screen.findByTestId`
  // hangs indefinitely because waitFor's internal setTimeout never fires. Restoring here is a
  // no-op when timers are already real and a safety net when they are not.
  jest.useRealTimers();
  jest.mocked(useAppearanceEnv).mockReturnValue(LIGHT_ENV);
  jest.mocked(useScreenReaderEnabled).mockReturnValue(false);
  jest.mocked(prefsStore.getPrefs).mockResolvedValue(makePrefs());
  jest.mocked(loadFontFaceSrc).mockResolvedValue(null);
  jest.mocked(loadDyslexiaFontFaceSrc).mockResolvedValue('data:font/ttf;base64,RFlTTA==');

  // THE ASSET SEAM IS RESTORED FOR EVERY TEST, not left to whichever block last touched it. Any
  // PDF test anywhere in this file has to point these three somewhere else, and `mockResolvedValue`
  // replaces the factory's IMPLEMENTATION for the rest of the run — so a block that overrode them
  // silently handed a PDF shell (and PDF bytes) to every later EPUB test. That is invisible in
  // declaration order and only shows up under `jest --randomize`, as an assertion that says
  // "openEpub was never sent" rather than anything about formats.
  //
  // Global rather than one afterEach per block: a per-block restore has to be remembered by the
  // NEXT person adding a PDF case, and the two blocks that already reset `prepareBook` defensively
  // are evidence that it was not. Blocks may still override — an outer beforeEach runs first.
  jest.mocked(prepareBook).mockResolvedValue('EPUB');
  jest
    .mocked(getReaderHtmlUri)
    .mockImplementation((format) => Promise.resolve(`file:///reader-${format.toLowerCase()}.html`));
  jest.mocked(getBookBase64).mockResolvedValue('UEsDBA==');

  // Same reasoning as the asset seam above: restored for every test rather than left to whichever
  // block last overrode it (the ACCESS_REVOKED block does, to capture `onRevoked`).
  jest.mocked(startAccessMonitor).mockReturnValue({
    stop: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
  });

  // The offline-lock tests emit on the REAL bus (not mocked — see useContentLock.test.ts's own
  // reasoning for why). It is a module singleton that outlives any one test, so every test starts
  // from zero subscribers regardless of whether it touches locking at all.
  resetEventBusForTests();

  // AND THE COMMAND LOG, for the same reason. Assertions here locate a command by `indexOf` over
  // `__injectJavaScript.mock.calls`, which finds the FIRST match — so calls left by an earlier test
  // do not just pad the array, they can win the lookup and make an ordering assertion compare two
  // different tests' commands. Roughly half the blocks below already clear it in their own
  // beforeEach; the ones that forgot are the ones that fail under `--randomize`.
  //
  // Declared below this beforeEach (the WebView mock is further down the file) and referenced here
  // through the closure, which is evaluated at call time, long after the module has finished.
  __injectJavaScript.mockClear();
});

/**
 * A WebView mock with a usable ref, overriding the inert one in jest.setup.js.
 *
 * The global mock is a bare <View>, whose host instance has no injectJavaScript — so
 * `send` optional-chains to nothing and every command vanishes silently. That is fine
 * for the Contents tests, which assert on rendered chrome, but it would make "tapping
 * a search hit navigates" untestable. This keeps the same testID and prop spreading,
 * and adds the two ref methods ReaderWebView actually calls.
 */
jest.mock('react-native-webview', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  const injectJavaScript = jest.fn();

  const WebView = ReactModule.forwardRef(function MockWebView(
    props: Record<string, unknown>,
    ref: React.Ref<unknown>,
  ) {
    ReactModule.useImperativeHandle(ref, () => ({ injectJavaScript, stopLoading: jest.fn() }));
    return ReactModule.createElement(View, { testID: 'reader-webview', ...props });
  });

  return { WebView, __injectJavaScript: injectJavaScript };
});

const { __injectJavaScript } = jest.requireMock('react-native-webview') as {
  __injectJavaScript: jest.Mock;
};

/**
 * Deliver a bridge message the way the device does: as a raw JSON string through
 * the WebView's onMessage. That routes through the real ReaderWebView handler and
 * the real parseReaderMessage, so a payload this test can build but the parser
 * would reject fails here rather than passing on a hand-made object.
 */
async function deliver(message: unknown): Promise<void> {
  // `includeHiddenElements`: this is the BRIDGE, not a user traversal. While a panel is open the
  // WebView's container is deliberately hidden from assistive tech (see `anyPanelOpen`), but the
  // WebView is still mounted and still delivering messages — a `relocated` does not stop arriving
  // because a screen reader cannot reach the book.
  const webView = screen.getByTestId('reader-webview', { includeHiddenElements: true });
  await act(async () => {
    webView.props.onMessage({ nativeEvent: { data: JSON.stringify(message) } });
  });
}

/**
 * Report `ready` the way the WebView does once its IIFE has defined window.TFReader.
 *
 * REQUIRED BEFORE ANYTHING TOUCHES THE BYTE PATH: `getBookBase64` is called from
 * `onReady`, so without this the open never starts at all — and a test that asserts
 * "no timeout fired" would pass for the wrong reason.
 */
async function reportReady(): Promise<void> {
  await deliver({ type: 'ready' });
}

async function mountReader(props?: { onOpenAccessibilityInfo?: () => void }): Promise<void> {
  await render(<ReaderScreen bookId="test-book" {...props} />);
  // The WebView only mounts once getReaderHtmlUri() resolves.
  await screen.findByTestId('reader-webview');
}

/**
 * Press the Contents button. Targets the Pressable by role rather than its inner
 * Text: `press` needs the element that owns the touch responder, and the label is
 * a child of it.
 */
async function openContents(): Promise<void> {
  // `fireEvent` is awaitable in @testing-library/react-native v14 — it does its own
  // act() wrapping and returns a promise, so dropping the await is a lint error
  // here (no-floating-promises is on for this directory) as well as a race.
  //
  // No chapter count in the query: the count lives in the visible text but deliberately not in
  // the accessible name, so that the name does not change under a focused control when the `toc`
  // message lands. See the Contents button in ReaderScreen.tsx.
  // `includeHiddenElements`: while Search or Bookmarks is open this button is hidden from assistive
  // tech (those panels carry their own close, so the row behind them is background) but is still
  // visible and tappable — which is what a press simulates. That it IS hidden in that state is
  // asserted on its own, in the background-hiding tests below, rather than implied here.
  await fireEvent.press(
    screen.getByRole('button', { name: 'Contents', includeHiddenElements: true }),
  );
}

function flatToc(count: number): ReaderTocItem[] {
  return Array.from({ length: count }, (_, i) => ({
    label: `Chapter ${i + 1}`,
    target: { kind: 'href', href: `ch${i + 1}.xhtml` },
    depth: 0,
  }));
}

/** A PDF Contents row, for the cases that used to be unrepresentable in one shared string. */
function pdfToc(pages: number[]): ReaderTocItem[] {
  return pages.map((page) => ({
    label: `Page ${page}`,
    target: { kind: 'page', page },
    depth: 0,
  }));
}

describe('a PDF Contents row', () => {
  // THE CASE THAT USED TO BE UNREPRESENTABLE IN A SHARED STRING. A PDF outline row arrived as
  // `href: '12'` and went back as the string '12', which the PDF shell parseInt'd. The host had to
  // carry a value in a vocabulary it could not name. It now carries a `{kind:'page', page}` target end
  // to end and never has to know what PDF addressing looks like.
  // Bumped from jest's 5000ms default: under CI worker contention this full-mount test
  // (ReaderScreen + several delivered bridge messages + a panel open + a press) has been
  // observed to exceed 5s despite passing in well under that locally; the test itself does
  // nothing slow. See PR discussion for the flake report before removing this.
  it(
    'navigates with the page target the shell sent, unmodified',
    async () => {
      await mountReader();
      await reportReady();
      await deliver({ type: 'toc', items: pdfToc([1, 12, 40]) });
      await openContents();

      await fireEvent.press(screen.getByText('Page 12'));

      expect(__injectJavaScript).toHaveBeenLastCalledWith(
        buildCommandScript({ type: 'goTo', target: { kind: 'page', page: 12 } }),
      );
    },
    15000,
  );

  // A PDF outline repeats page numbers BY DESIGN — several sections legitimately open on the same
  // page, and the sample fixture has exactly that. Rows must stay distinct anyway, which is why the
  // React key is index-composed rather than target-derived.
  it('lists every row when several sections open on the same page', async () => {
    await mountReader();
    await reportReady();
    await deliver({
      type: 'toc',
      items: [
        { label: 'Section A', target: { kind: 'page', page: 2 }, depth: 0 },
        { label: 'Section B', target: { kind: 'page', page: 2 }, depth: 1 },
      ],
    });
    await openContents();

    expect(screen.getByText('Section A')).toBeTruthy();
    expect(screen.getByText('Section B')).toBeTruthy();
  });
});

describe('an EPUB grouping heading with no href', () => {
  // epubOutline.ts's flattenToc keeps a nav point with no href rather than dropping it (a heading
  // that only groups its subitems), emitting `{kind:'href', href:''}` so the row still appears and
  // its children keep their depth. Tapping it must not reach goTo -> epub.entry.ts's
  // `rendition.display('')`, whose behavior is unverified — the row has nothing to navigate to.
  it('does not navigate when tapped', async () => {
    await mountReader();
    await reportReady();
    await deliver({
      type: 'toc',
      items: [
        { label: 'Grouping heading', target: { kind: 'href', href: '' }, depth: 0 },
        { label: 'Chapter 1', target: { kind: 'href', href: 'ch1.xhtml' }, depth: 1 },
      ],
    });
    await openContents();
    const before = __injectJavaScript.mock.calls.length;

    await fireEvent.press(screen.getByText('Grouping heading'));

    expect(__injectJavaScript.mock.calls.length).toBe(before);
  });

  it('is marked disabled for assistive tech, unlike a real chapter row', async () => {
    await mountReader();
    await reportReady();
    await deliver({
      type: 'toc',
      items: [
        { label: 'Grouping heading', target: { kind: 'href', href: '' }, depth: 0 },
        { label: 'Chapter 1', target: { kind: 'href', href: 'ch1.xhtml' }, depth: 1 },
      ],
    });
    await openContents();

    expect(screen.getByText('Grouping heading').parent?.props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect(screen.getByText('Chapter 1').parent?.props.accessibilityState).not.toMatchObject({
      disabled: true,
    });
  });

  it('gets no accessibilityHint, unlike a navigable row', async () => {
    await mountReader();
    await reportReady();
    await deliver({
      type: 'toc',
      items: [
        { label: 'Grouping heading', target: { kind: 'href', href: '' }, depth: 0 },
        { label: 'Chapter 1', target: { kind: 'href', href: 'ch1.xhtml' }, depth: 1 },
      ],
    });
    await openContents();

    expect(screen.getByText('Grouping heading').parent?.props.accessibilityHint).toBeUndefined();
    expect(screen.getByText('Chapter 1').parent?.props.accessibilityHint).toBe(
      'Navigates to this chapter',
    );
  });
});

describe('Prev/Next navigation controls', () => {
  function prevButton() {
    return screen.getByRole('button', { name: 'Previous page' });
  }

  function nextButton() {
    return screen.getByRole('button', { name: 'Next page' });
  }

  async function relocate(atStart: boolean, atEnd: boolean): Promise<void> {
    await deliver({
      type: 'relocated',
      position: { kind: 'cfi', cfi: 'epubcfi(/6/4[chap01]!/4/2/2)' },
      atStart,
      atEnd,
    });
  }

  // Same reasoning as ReaderWebView's own READY_TIMEOUT window: before the first `relocated`
  // arrives, "the book opens on its first page" is what Prev being disabled already means, and
  // this is the state a fresh open sits in for however long the WebView takes to report it.
  it('disables Prev before any position has arrived, matching a book opening on its first page', async () => {
    await mountReader();
    await reportReady();

    expect(prevButton().props.accessibilityState).toMatchObject({ disabled: true });
    expect(nextButton().props.accessibilityState).toMatchObject({ disabled: false });
  });

  it('disables Prev at the start and Next at the end, independently', async () => {
    await mountReader();
    await reportReady();

    await relocate(true, false);
    expect(prevButton().props.accessibilityState).toMatchObject({ disabled: true });
    expect(nextButton().props.accessibilityState).toMatchObject({ disabled: false });

    await relocate(false, true);
    expect(prevButton().props.accessibilityState).toMatchObject({ disabled: false });
    expect(nextButton().props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('re-enables both once neither edge applies any more', async () => {
    await mountReader();
    await reportReady();
    await relocate(true, false);

    await relocate(false, false);

    expect(prevButton().props.accessibilityState).toMatchObject({ disabled: false });
    expect(nextButton().props.accessibilityState).toMatchObject({ disabled: false });
  });

  // CONTINUOUS SCROLL IS NAVIGATED BY SCROLLING, NOT BY THESE BUTTONS — so both are disabled
  // unconditionally in that flow, independent of atStart/atEnd (which the WebView still reports,
  // scrolled by whatever "one screenful" means there — see epub.entry.ts/pdf.entry.ts).
  it('disables both in continuous scroll, regardless of position', async () => {
    await mountReader();
    await reportReady();
    await relocate(false, false); // clearly not at either edge

    await act(async () => {
      __emitPrefsChange(makePrefs({ layout: { flow: 'scrolled-doc', spread: 'single' } }));
    });

    expect(prevButton().props.accessibilityState).toMatchObject({ disabled: true });
    expect(nextButton().props.accessibilityState).toMatchObject({ disabled: true });
  });

  it('re-enables on returning to paginated flow, honouring the last reported edges', async () => {
    await mountReader();
    await reportReady();
    await relocate(false, false);
    await act(async () => {
      __emitPrefsChange(makePrefs({ layout: { flow: 'scrolled-doc', spread: 'single' } }));
    });

    await act(async () => {
      __emitPrefsChange(makePrefs({ layout: { flow: 'paginated', spread: 'single' } }));
    });

    expect(prevButton().props.accessibilityState).toMatchObject({ disabled: false });
    expect(nextButton().props.accessibilityState).toMatchObject({ disabled: false });
  });
});

describe('the page indicator', () => {
  // PDF-ONLY BY CONSTRUCTION, not by choice. `ReaderPosition` is discriminated by format, and an EPUB
  // reports a CFI because a reflowable book has no stable page. Showing a number derived from a CFI
  // would be a number that changes with the font size, which is worse than showing none.
  async function relocateTo(position: unknown): Promise<void> {
    await deliver({ type: 'relocated', position, atStart: false, atEnd: false });
  }

  it('shows nothing until a position arrives', async () => {
    await mountReader();
    await reportReady();

    expect(screen.queryByTestId('reader-page-indicator')).toBeNull();
  });

  it('reports the page and the page count for a PDF', async () => {
    await mountReader();
    await reportReady();
    await relocateTo({ kind: 'page', page: 4, pageCount: 50 });

    expect(screen.getByLabelText('Page 4 of 50. Go to a page.')).toBeTruthy();
    expect(screen.getByText('4 / 50')).toBeTruthy();
  });

  it('follows the position as it moves', async () => {
    await mountReader();
    await reportReady();
    await relocateTo({ kind: 'page', page: 1, pageCount: 3 });
    await relocateTo({ kind: 'page', page: 3, pageCount: 3 });

    expect(screen.getByLabelText('Page 3 of 3. Go to a page.')).toBeTruthy();
    expect(screen.queryByText('1 / 3')).toBeNull();
  });

  it('shows no indicator for an EPUB, which has no stable page', async () => {
    await mountReader();
    await reportReady();
    await relocateTo({ kind: 'cfi', cfi: 'epubcfi(/6/4[chap01]!/4/2/2)' });

    expect(screen.queryByTestId('reader-page-indicator')).toBeNull();
  });

  // AN IMPOSSIBLE POSITION IS REFUSED LOUDLY, NOT SMOOTHED OVER — and that is deliberate, so it is
  // worth saying why the harsher option is the right one here.
  //
  // "page 9 of 3" cannot come from book content. `pageCount` is `doc.numPages` and `currentPage` only
  // moves through next/prev/goTo, all of which bound it. So a position like this means OUR OWN SHELL is
  // broken, and a shell that miscounts pages is not one whose other messages should be trusted either.
  // errors.ts requires that class of thing fail loudly rather than degrade.
  //
  // Contrast the TOC hardeners, which drop one bad row and keep the panel: a mis-indented Contents entry
  // really can come from a malformed book, and losing a chapter is worse than mis-indenting one.
  it('refuses an impossible position rather than displaying it', async () => {
    await mountReader();
    await reportReady();
    await relocateTo({ kind: 'page', page: 2, pageCount: 3 });
    await relocateTo({ kind: 'page', page: 9, pageCount: 3 });

    expect(screen.getByText('BRIDGE_PARSE_FAILED')).toBeTruthy();
  });

  it('shows the error MESSAGE, not a stringified object', async () => {
    // This assertion is the one the test above was missing. It asserted only the code, so when the
    // banner was switched to run `error` through `formatDiagnosticErrorMessage` — a formatter built
    // for caught throwables, which a structured `{code, message}` is not — it rendered
    // "[object Object]" underneath a correct-looking code and every suite stayed green.
    await mountReader();
    await reportReady();
    await deliver({ type: 'error', code: 'BRIDGE_PARSE_FAILED', message: 'could not parse' });

    expect(screen.getByText('could not parse')).toBeTruthy();
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  });
});

describe('the page jump', () => {
  // WHAT THIS IS FOR: a PDF with no outline has no Contents to offer — and most PDFs in the wild are
  // that, including the 15 MB measurement fixture. Contents stays correctly disabled for them; this is
  // the navigation such a book CAN offer, and it is only possible because `pageCount` now reaches the
  // host.
  async function atPage(page: number, pageCount: number): Promise<void> {
    await mountReader();
    await reportReady();
    await deliver({
      type: 'relocated',
      position: { kind: 'page', page, pageCount },
      atStart: false,
      atEnd: false,
    });
  }

  async function openJump(): Promise<void> {
    await fireEvent.press(screen.getByTestId('reader-page-indicator'));
  }

  async function type(text: string): Promise<void> {
    await fireEvent.changeText(screen.getByTestId('reader-page-jump'), text);
  }

  async function submit(): Promise<void> {
    await fireEvent(screen.getByTestId('reader-page-jump'), 'submitEditing');
  }

  it('opens from the page indicator', async () => {
    await atPage(3, 50);

    expect(screen.queryByTestId('reader-page-jump')).toBeNull();
    await openJump();

    expect(screen.getByTestId('reader-page-jump')).toBeTruthy();
    // The RANGE is on the field, which is the point of the host knowing pageCount: the bound is
    // visible before you type rather than discovered by being refused.
    expect(screen.getByPlaceholderText('1–50')).toBeTruthy();
  });

  it('sends a page target for a page inside the document', async () => {
    await atPage(3, 50);
    await openJump();
    await type('42');
    await submit();

    expect(__injectJavaScript).toHaveBeenLastCalledWith(
      buildCommandScript({ type: 'goTo', target: { kind: 'page', page: 42 } }),
    );
    // Closes on success, so the row goes back to reporting where you are.
    expect(screen.queryByTestId('reader-page-jump')).toBeNull();
  });

  it.each([
    ['past the last page', '51'],
    ['zero', '0'],
    ['a negative', '-4'],
    ['a fraction', '2.5'],
    ['not a number', 'abc'],
    ['empty', ''],
  ])('declines %s without navigating, and keeps the field open', async (_label, text) => {
    await atPage(3, 50);
    const before = __injectJavaScript.mock.calls.length;
    await openJump();
    await type(text);
    await submit();

    // NOT an error banner. The shell would range-check too and raise NAVIGATION_FAILED, which is the
    // right response to a corrupt book and a wildly disproportionate one to a typo — so the host
    // declines silently instead.
    expect(__injectJavaScript.mock.calls.length).toBe(before);
    expect(screen.queryByTestId('reader-error')).toBeNull();
    // Left open with the text intact: a rejection should not also lose what you typed.
    expect(screen.getByTestId('reader-page-jump')).toBeTruthy();
  });

  it('accepts the first and last page exactly', async () => {
    await atPage(3, 50);
    await openJump();
    await type('1');
    await submit();
    expect(__injectJavaScript).toHaveBeenLastCalledWith(
      buildCommandScript({ type: 'goTo', target: { kind: 'page', page: 1 } }),
    );

    await openJump();
    await type('50');
    await submit();
    expect(__injectJavaScript).toHaveBeenLastCalledWith(
      buildCommandScript({ type: 'goTo', target: { kind: 'page', page: 50 } }),
    );
  });

  // A reflowable book has no stable page, so there is nothing to jump to and no indicator to open.
  it('is unreachable for an EPUB', async () => {
    await mountReader();
    await reportReady();
    await deliver({
      type: 'relocated',
      position: { kind: 'cfi', cfi: 'epubcfi(/6/4!/2)' },
      atStart: false,
      atEnd: false,
    });

    expect(screen.queryByTestId('reader-page-indicator')).toBeNull();
    expect(screen.queryByTestId('reader-page-jump')).toBeNull();
  });

  it('is unreachable before any position has arrived', async () => {
    await mountReader();
    await reportReady();

    expect(screen.queryByTestId('reader-page-indicator')).toBeNull();
  });
});

describe('the outline timing probe', () => {
  // WHY THIS IS TIMED AT ALL: on the PDF shell every outline destination is resolved through the
  // pdf.js worker, so a large book's Contents can lag well behind `rendered`. That window is
  // invisible from the outside — a page is on screen and the Contents button is simply still
  // disabled — so it needs a number rather than an impression.
  const original = process.env.EXPO_PUBLIC_READER_TIMING;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (original === undefined) {
      delete process.env.EXPO_PUBLIC_READER_TIMING;
    } else {
      process.env.EXPO_PUBLIC_READER_TIMING = original;
    }
  });

  function tfperfLines(): string[] {
    return logSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('[TFPERF]'));
  }

  it('reports how long the outline took, and how many entries it carried', async () => {
    process.env.EXPO_PUBLIC_READER_TIMING = '1';

    await mountReader();
    await reportReady();
    await deliver({ type: 'rendered' });
    await deliver({ type: 'toc', items: flatToc(22) });

    // The count is the load-bearing extra: a slow outline and a huge outline are the same
    // millisecond figure, and only one of them is a bug in this code.
    expect(tfperfLines()).toContainEqual(expect.stringMatching(/^\[TFPERF\] open -> toc \d+ms/));
    expect(tfperfLines()).toContainEqual(expect.stringContaining('items=22'));
  });

  // Off-by-default is a security property here, not a preference — these lines report payload sizes
  // from a path holding decrypted licensed content. Same guarantee readerTiming.test.ts pins for the
  // probes themselves, asserted once through a real open so a stray unconditional log would show up.
  it('emits nothing at all when timing is not switched on', async () => {
    delete process.env.EXPO_PUBLIC_READER_TIMING;

    await mountReader();
    await reportReady();
    await deliver({ type: 'rendered' });
    await deliver({ type: 'toc', items: flatToc(3) });

    expect(tfperfLines()).toEqual([]);
  });

  // An empty outline is the NORMAL case for a PDF, so the span must still land — otherwise the one
  // book whose Contents is legitimately empty is also the one with no timing for it.
  it('still reports the span for a book with no outline', async () => {
    process.env.EXPO_PUBLIC_READER_TIMING = '1';

    await mountReader();
    await reportReady();
    await deliver({ type: 'rendered' });
    await deliver({ type: 'toc', items: [] });

    expect(tfperfLines()).toContainEqual(expect.stringContaining('items=0'));
  });
});

describe('the bounded wait on the byte path', () => {
  // Fake timers, because the real bound is 20s and no test should take 20s. Set up
  // per-test rather than for the file: the panel tests above rely on real
  // microtask/timer behaviour through @testing-library's async helpers.
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.mocked(getBookBase64).mockResolvedValue('UEsDBA==');
  });

  it('surfaces a timeout as its own code once the wait elapses', async () => {
    // A byte path that never settles is exactly what a reachable-but-unresponsive
    // backend produces: verifyReadingAccess's fetch has no AbortSignal, so it hangs
    // on the socket rather than rejecting. Before the bound, this presented as
    // "Opening title…" forever with no error at all.
    jest.mocked(getBookBase64).mockReturnValue(new Promise<string>(() => {}));

    await mountReader();
    await reportReady();

    await act(async () => {
      jest.advanceTimersByTime(20_000);
    });

    expect(screen.getByText('CONTENT_LOAD_TIMEOUT')).toBeTruthy();
    // NOT the generic failure code: "could not open this book" would send a reader
    // looking at the book when the problem is the network.
    expect(screen.queryByText('CONTENT_LOAD_FAILED')).toBeNull();
  });

  it('does not fire once the bytes have arrived', async () => {
    // The timer has to be cleared on success. If it is not, every successful open
    // raises a timeout banner over an already-rendered book 20s later.
    await mountReader();
    await reportReady();
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });

    expect(screen.queryByText('CONTENT_LOAD_TIMEOUT')).toBeNull();
  });

  it('reports a real failure as a failure, not as a timeout', async () => {
    // The bound must not swallow the distinction it was added to preserve: a byte
    // path that settles with an error is a different problem from one that never
    // settles, and only the second is about the network.
    jest.mocked(getBookBase64).mockRejectedValue(new Error('ciphertext is corrupt'));

    await mountReader();
    await reportReady();
    await act(async () => {
      jest.advanceTimersByTime(20_000);
    });

    expect(screen.getByText('CONTENT_LOAD_FAILED')).toBeTruthy();
    expect(screen.queryByText('CONTENT_LOAD_TIMEOUT')).toBeNull();
  });
});

/** A `content.lock` signal for `bookId` — `mountReader()`'s fixed "test-book" by default. */
function lockSignal(bookId = 'test-book', reason: 'revoked' | 'expired' = 'revoked'): LockSignal {
  return { type: OFFLINE_LOCK_EVENTS.LOCK, bookId, reason, observedAt: Date.now() };
}

/**
 * A locked/revoked code is DELIBERATELY shown twice — the top `errorBanner` and the dedicated
 * `lockedState` view that replaces the WebView both read the same `error` state (see
 * ReaderScreen.tsx's own note on why that duplication is intentional, not a bug) — so
 * `getByText` (which requires exactly one match) is the wrong query for it.
 */
function expectCodeShownTwice(code: string): void {
  expect(screen.getAllByText(code)).toHaveLength(2);
}

describe('the offline-lock gating hook', () => {
  // THE HEADLINE REGRESSION TEST FOR B2. A version of useContentLock that set `lockedRef` from a
  // `useEffect` keyed on `lock` (one React commit late) would pass every OTHER test in this file —
  // including "lock while reading" below — and still let a fully decrypted book reach the WebView
  // here, because the race this pins is a microtask race with no guaranteed ordering against a
  // React commit. Only holding `getBookBase64` open and resolving it AFTER the lock proves the ref
  // was already `true` before the `sender({ type: 'openEpub', ... })` call had a chance to run.
  it('never sends openEpub once a lock lands while getBookBase64 is still pending', async () => {
    let resolveBase64: (value: string) => void = () => {};
    jest.mocked(getBookBase64).mockReturnValue(
      new Promise<string>((resolve) => {
        resolveBase64 = resolve;
      }),
    );

    await mountReader();
    await reportReady(); // handleReady is now paused at `await withOpenTimeout(getBookBase64(...))`

    await act(async () => {
      eventBus.emit(OFFLINE_LOCK_EVENTS.LOCK, lockSignal());
    });
    expectCodeShownTwice('CONTENT_LOCKED');

    // NOW let the held promise resolve, with a fully valid decrypted payload — the exact shape of
    // the mid-open race the plan's B2 fix exists for (readerAssets.ts's `fromByteArray` may already
    // have produced this string; zeroing the source buffer would not touch it).
    await act(async () => {
      resolveBase64('UEsDBA==');
      await Promise.resolve();
    });

    expect(__injectJavaScript).not.toHaveBeenCalledWith(
      buildCommandScript({ type: 'openEpub', base64: 'UEsDBA==' }),
    );
    // The lock must still be the thing on screen — not overwritten by whatever the resumed
    // continuation did next.
    expectCodeShownTwice('CONTENT_LOCKED');
    expect(screen.queryByTestId('reader-webview')).toBeNull();
  });

  it('locks a book that is already open and reading: tears down, closes panels, drops the WebView', async () => {
    await mountReader();
    await reportReady();
    expect(__injectJavaScript).toHaveBeenCalledWith(
      buildCommandScript({ type: 'openEpub', base64: 'UEsDBA==' }),
    );

    // A panel is open when the lock lands — N2's own claim is that this closes too, not only the
    // WebView.
    await deliver({ type: 'toc', items: flatToc(1) });
    await openContents();
    expect(screen.getByText('Chapter 1')).toBeTruthy();

    await act(async () => {
      eventBus.emit(OFFLINE_LOCK_EVENTS.LOCK, lockSignal());
    });

    expectCodeShownTwice('CONTENT_LOCKED');
    expect(screen.queryByTestId('reader-webview', { includeHiddenElements: true })).toBeNull();
    expect(screen.queryByText('Chapter 1')).toBeNull();
    expect(closeBook).toHaveBeenCalledWith('test-book');
  });

  it('ignores a lock for a different bookId', async () => {
    await mountReader();
    await reportReady();

    await act(async () => {
      eventBus.emit(OFFLINE_LOCK_EVENTS.LOCK, lockSignal('some-other-book'));
    });

    expect(screen.queryByText('CONTENT_LOCKED')).toBeNull();
    expect(screen.getByTestId('reader-webview')).toBeTruthy();
  });

  it('does not let a subsequent CONTENT_LOAD_FAILED overwrite an already-shown lock (guard c)', async () => {
    let rejectBase64: (cause: unknown) => void = () => {};
    jest.mocked(getBookBase64).mockReturnValue(
      new Promise<string>((_resolve, reject) => {
        rejectBase64 = reject;
      }),
    );

    await mountReader();
    await reportReady();

    await act(async () => {
      eventBus.emit(OFFLINE_LOCK_EVENTS.LOCK, lockSignal());
    });
    expectCodeShownTwice('CONTENT_LOCKED');

    // The decrypt whose key `contentStore.ts`'s own lock subscriber just destroyed now rejects —
    // exactly what a real revocation produces mid-flight.
    await act(async () => {
      rejectBase64(new Error('DECRYPTION_FAILED'));
      await Promise.resolve();
    });

    expectCodeShownTwice('CONTENT_LOCKED');
    expect(screen.queryByText('CONTENT_LOAD_FAILED')).toBeNull();
  });

  it('never shows "Opening title…" for a lock that lands before the shell ever resolved (N1)', async () => {
    // Held open, deliberately — `prepareBook` never resolves, so `htmlUri` never leaves `null`
    // and `isBusy`'s OLD formula would stay stuck at `true` forever once the lock arrives.
    jest.mocked(prepareBook).mockReturnValue(new Promise<ContentFormat>(() => {}));

    await render(<ReaderScreen bookId="test-book" />);
    expect(screen.getByText('Opening title…')).toBeTruthy();

    await act(async () => {
      eventBus.emit(OFFLINE_LOCK_EVENTS.LOCK, lockSignal());
    });

    expectCodeShownTwice('CONTENT_LOCKED');
    expect(screen.queryByText('Opening title…')).toBeNull();
  });

  it('routes ACCESS_REVOKED through the SAME teardown a content.lock gets', async () => {
    let capturedOnRevoked: ((failure: DownloadFailure) => void) | null = null;
    jest.mocked(startAccessMonitor).mockImplementation((_bookId, _format, onRevoked) => {
      capturedOnRevoked = onRevoked;
      return { stop: jest.fn(), pause: jest.fn(), resume: jest.fn() };
    });

    await mountReader();
    await reportReady(); // starts the monitor, capturing its onRevoked callback
    expect(capturedOnRevoked).not.toBeNull();

    await act(async () => {
      capturedOnRevoked?.(
        new DownloadFailure(DownloadError.ENTITLEMENT_EXPIRED, 'test-book', 'server said no'),
      );
    });

    expectCodeShownTwice('ACCESS_REVOKED');
    expect(screen.queryByTestId('reader-webview', { includeHiddenElements: true })).toBeNull();
    expect(closeBook).toHaveBeenCalledWith('test-book');
  });
});

describe('routing ContentFormat to a renderer', () => {
  afterEach(() => {
    jest.mocked(prepareBook).mockResolvedValue('EPUB');
    jest.mocked(getBookBase64).mockResolvedValue('UEsDBA==');
  });

  it('loads the EPUB shell and sends openEpub for an EPUB book', async () => {
    await mountReader();
    await reportReady();

    expect(jest.mocked(getReaderHtmlUri)).toHaveBeenCalledWith('EPUB');
    expect(__injectJavaScript).toHaveBeenLastCalledWith(
      buildCommandScript({ type: 'openEpub', base64: 'UEsDBA==' }),
    );
  });

  it('loads the PDF shell and sends openPdf for a PDF book', async () => {
    // The two halves have to move together. Loading the PDF shell but sending
    // openEpub would answer NOT_READY — the shell defines only openPdf — which is a
    // confusing way to discover a routing bug, so both are asserted here.
    jest.mocked(prepareBook).mockResolvedValue('PDF');
    jest.mocked(getBookBase64).mockResolvedValue('JVBERi0xLjQK');

    await mountReader();
    await reportReady();

    expect(jest.mocked(getReaderHtmlUri)).toHaveBeenCalledWith('PDF');
    expect(__injectJavaScript).toHaveBeenLastCalledWith(
      buildCommandScript({ type: 'openPdf', base64: 'JVBERi0xLjQK' }),
    );

    jest.mocked(getBookBase64).mockResolvedValue('UEsDBA==');
  });

  it('passes the resolved format to the access check, not a hardcoded EPUB', async () => {
    // readerAssets.ts:125 used to send a literal 'EPUB' to verifyReadingAccess. That
    // is finding B12, and this is the assertion that keeps it closed on Reader's side.
    jest.mocked(prepareBook).mockResolvedValue('PDF');

    await mountReader();
    await reportReady();

    expect(jest.mocked(getBookBase64)).toHaveBeenCalledWith('test-book', 'PDF');
  });

  it('re-resolves the shell and the open command when the book switches format', async () => {
    // What App.tsx's dev picker does, and what RootNavigator will do with real books:
    // change ONLY the bookId. Nothing hands the reader a format, so this is also the
    // proof that runtime format switching needs no routing change — it falls out of
    // resolving the format per book.
    jest.mocked(prepareBook).mockResolvedValue('EPUB');
    const view = await render(<ReaderScreen key="book-epub" bookId="book-epub" />);
    await screen.findByTestId('reader-webview');
    await reportReady();

    expect(jest.mocked(getReaderHtmlUri)).toHaveBeenLastCalledWith('EPUB');
    expect(__injectJavaScript).toHaveBeenLastCalledWith(
      buildCommandScript({ type: 'openEpub', base64: 'UEsDBA==' }),
    );

    jest.mocked(prepareBook).mockResolvedValue('PDF');
    jest.mocked(getBookBase64).mockResolvedValue('JVBERi0xLjQK');

    // KEYED, exactly as App.tsx and any navigator must do — ReaderScreen's prop doc
    // requires it, so a test that rerendered without a key would be exercising a usage
    // the component does not support and would pass for the wrong reason.
    await act(async () => {
      await view.rerender(<ReaderScreen key="book-pdf" bookId="book-pdf" />);
    });
    await screen.findByTestId('reader-webview');
    await reportReady();

    expect(jest.mocked(getReaderHtmlUri)).toHaveBeenLastCalledWith('PDF');
    expect(__injectJavaScript).toHaveBeenLastCalledWith(
      buildCommandScript({ type: 'openPdf', base64: 'JVBERi0xLjQK' }),
    );

    // The outgoing book's decrypted bytes must be released. Without this the reader
    // leaks a whole book per switch, which is exactly what closeBook exists to stop.
    expect(jest.mocked(closeBook)).toHaveBeenCalledWith('book-epub');
  });

  it('does not send the previous format’s open command after a switch', async () => {
    // The stale-state failure this guards: if `format` survived the bookId change,
    // handleReady would send openEpub into the PDF shell, which defines only openPdf
    // and would answer NOT_READY — a confusing way to find a routing bug.
    jest.mocked(prepareBook).mockResolvedValue('EPUB');
    const view = await render(<ReaderScreen key="book-epub" bookId="book-epub" />);
    await screen.findByTestId('reader-webview');
    await reportReady();

    jest.mocked(prepareBook).mockResolvedValue('PDF');
    __injectJavaScript.mockClear();

    // KEYED, exactly as App.tsx and any navigator must do — ReaderScreen's prop doc
    // requires it, so a test that rerendered without a key would be exercising a usage
    // the component does not support and would pass for the wrong reason.
    await act(async () => {
      await view.rerender(<ReaderScreen key="book-pdf" bookId="book-pdf" />);
    });
    await screen.findByTestId('reader-webview');
    await reportReady();

    const sent = __injectJavaScript.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sent).toContain('window.TFReader.openPdf');
    expect(sent).not.toContain('window.TFReader.openEpub');
  });

  it('never opens the previous renderer even when the caller forgets the key', async () => {
    // The prop doc REQUIRES callers to key on bookId, and both switch tests above do.
    // This one deliberately does NOT, because "the caller forgot" must fail safe rather
    // than silently opening the wrong renderer: the resolved format/shell pair is tagged
    // with its bookId, so a mismatched tag reads as "not resolved yet" instead of as the
    // previous book's answer. Without that tag this test sends openEpub into a PDF shell.
    jest.mocked(prepareBook).mockResolvedValue('EPUB');
    const view = await render(<ReaderScreen bookId="book-epub" />);
    await screen.findByTestId('reader-webview');
    await reportReady();

    // Make the new book's resolution never settle, so the ONLY thing that could be
    // rendered is whatever survived from the previous book.
    jest.mocked(prepareBook).mockReturnValue(new Promise<ContentFormat>(() => {}));
    __injectJavaScript.mockClear();

    await act(async () => {
      await view.rerender(<ReaderScreen bookId="book-pdf" />);
    });

    // Stale shell is gone rather than reused, so there is nothing to be ready.
    expect(screen.queryByTestId('reader-webview')).toBeNull();
    expect(__injectJavaScript).not.toHaveBeenCalled();
  });

  it('refuses AUDIO with its own code and never mounts a WebView', async () => {
    // AUDIO is a real member of the frozen enum and is never encrypted, so it can
    // reach this screen. There is no shell for it, and the important half of this is
    // the SECOND assertion: silently loading the EPUB shell for an audiobook would
    // fail much later, inside epub.js, as an unreadable error.
    jest
      .mocked(prepareBook)
      .mockRejectedValue(new UnsupportedFormatError('AUDIO' as ContentFormat));

    await render(<ReaderScreen bookId="test-book" />);

    expect(await screen.findByText('UNSUPPORTED_FORMAT')).toBeTruthy();
    expect(screen.queryByTestId('reader-webview')).toBeNull();
    // NOT the asset code: the shells are fine, there just isn't one for this book,
    // and telling the reader to run a build script would be a lie.
    expect(screen.queryByText('ASSET_LOAD_FAILED')).toBeNull();
  });
});

describe('applyAppearance — the accessibility overrides', () => {
  /** The last appearance the WebView was told about, decoded back out of the injected script. */
  function lastAppearance(): Record<string, unknown> {
    const calls = __injectJavaScript.mock.calls.map((call) => String(call[0]));
    const script = calls.reverse().find((call) => call.includes('applyAppearance('));
    expect(script).toBeDefined();
    const json = /applyAppearance\((\{.*?\})\);/s.exec(String(script))?.[1];
    expect(json).toBeDefined();
    // The script embeds the payload as an escaped JSON string literal inside JS source.
    return JSON.parse(String(json).replace(/\\"/g, '"')) as Record<string, unknown>;
  }

  function withA11y(overrides: {
    dyslexiaFont?: boolean;
    highContrast?: boolean;
  }): SharedPrefs {
    const base = makePrefs();
    return {
      ...base,
      accessibility: {
        ...base.accessibility,
        text: { ...base.accessibility.text, dyslexiaFont: overrides.dyslexiaFont ?? false },
        display: { ...base.accessibility.display, highContrast: overrides.highContrast ?? false },
      },
    };
  }

  afterEach(() => {
    jest.mocked(prefsStore.getPrefs).mockResolvedValue(makePrefs());
    jest.mocked(prepareBook).mockResolvedValue('EPUB' as ContentFormat);
  });

  it('lets the dyslexia face beat the chosen bundled font, on both fields at once', async () => {
    // `baselineCss` emits @font-face only when the family AND the bytes are both present, and the
    // shell drops a URI with no family to attach it to — so setting one without the other is inert.
    jest.mocked(loadFontFaceSrc).mockResolvedValue('data:font/ttf;base64,QkJCQg==');
    jest.mocked(prefsStore.getPrefs).mockResolvedValue({
      ...withA11y({ dyslexiaFont: true }),
      font: { ...makePrefs().font, family: 'Poppins' },
    });

    await mountReader();
    await reportReady();

    const appearance = lastAppearance();
    expect(appearance.fontFamily).toBe('OpenDyslexic');
    expect(appearance.customFontUri).toBe('data:font/ttf;base64,RFlTTA==');
  });

  it('still sends every other preference when the dyslexia font fails to load', async () => {
    // THE REGRESSION THIS EXISTS FOR: the load is awaited inside `buildAppearanceWithFont`, which
    // runs inside `applyAppearanceWith`'s single catch. Without its own try/catch a reject aborts
    // the whole payload, and the book silently loses theme, text size, margins, flow and every
    // announce gate — for a font. Losing the face is the correct failure; losing the rest is not.
    jest.mocked(loadDyslexiaFontFaceSrc).mockRejectedValue(new Error('asset unavailable'));
    jest.mocked(prefsStore.getPrefs).mockResolvedValue({
      ...withA11y({ dyslexiaFont: true }),
      theme: 'dark',
    });

    await mountReader();
    await reportReady();

    const appearance = lastAppearance();
    // The theme survived, which is the whole point.
    expect(appearance.colorScheme).toBe('dark');
    expect(appearance.bg).toBe('#121212');
    // And the face fell back rather than half-applying.
    expect(appearance.fontFamily).not.toBe('OpenDyslexic');
    expect(appearance.customFontUri).toBeNull();
  });

  it('ignores a stored dyslexiaFont on a PDF, which has no text layer to restyle', async () => {
    // The preference is one per USER, not per book, so a `true` set while reading an EPUB still
    // arrives on a PDF's payload. The panel hides its own row for PDFs; this is the host-side half.
    jest.mocked(prepareBook).mockResolvedValue('PDF' as ContentFormat);
    jest.mocked(prefsStore.getPrefs).mockResolvedValue(withA11y({ dyslexiaFont: true }));
    // Cleared HERE rather than relying on a global: this file deliberately has no blanket
    // clearAllMocks (see the note further down), so the earlier tests in this block have already
    // called the loader and a bare `not.toHaveBeenCalled()` would be counting their calls.
    jest.mocked(loadDyslexiaFontFaceSrc).mockClear();

    await mountReader();
    await reportReady();

    expect(lastAppearance().fontFamily).not.toBe('OpenDyslexic');
    // Not merely unused — never loaded. The gate is what stops a PDF paying ~330 KB of base64 on
    // the bridge for a face pdf.js could not render if it arrived.
    expect(loadDyslexiaFontFaceSrc).not.toHaveBeenCalled();
  });

  it('overrides the theme palette with the high-contrast pair for the resolved scheme', async () => {
    jest.mocked(prefsStore.getPrefs).mockResolvedValue(withA11y({ highContrast: true }));

    await mountReader();
    await reportReady();

    const appearance = lastAppearance();
    expect(appearance.fg).toBe('#000000');
    expect(appearance.bg).toBe('#FFFFFF');
    expect(appearance.link).toBe('#0000EE');
    // The FLAG still rides along — the shells and `appearanceChangeAnnouncement` both read it.
    expect(appearance.highContrast).toBe(true);
  });

  it('keeps dark + high contrast a valid combination rather than collapsing to one palette', async () => {
    // `highContrast` is deliberately independent of colour scheme — the deprecated
    // `theme: 'highContrast'` could not express this pair, which is why the flag replaced it.
    jest
      .mocked(prefsStore.getPrefs)
      .mockResolvedValue({ ...withA11y({ highContrast: true }), theme: 'dark' });

    await mountReader();
    await reportReady();

    const appearance = lastAppearance();
    expect(appearance.colorScheme).toBe('dark');
    expect(appearance.fg).toBe('#FFFFFF');
    expect(appearance.bg).toBe('#000000');
    expect(appearance.link).toBe('#FFFF00');
  });

  it('leaves the palette alone when high contrast is off', async () => {
    await mountReader();
    await reportReady();

    expect(lastAppearance().bg).toBe('#ffffff');
    expect(lastAppearance().link).toBe('#1a4f8b');
  });
});

describe('the merged accessibility dropdown', () => {
  it('opens from one ♿ toolbar button, with no title or named close row', async () => {
    await mountReader();

    await fireEvent.press(screen.getByLabelText('Accessibility'));
    expect(screen.getByLabelText('High contrast: Off')).toBeTruthy();

    // No header any more — matches DevPreferencesMenu's own headerless dropdown. Dismiss is
    // tap-outside/back/re-press only, not a named "Close accessibility" control.
    expect(screen.queryByText('Accessibility')).toBeNull();
    expect(screen.queryByLabelText('Close accessibility')).toBeNull();
  });

  it('dismisses on a backdrop tap and restores focus to the toolbar button', async () => {
    await mountReader();
    await fireEvent.press(screen.getByLabelText('Accessibility'));
    expect(screen.getByLabelText('High contrast: Off')).toBeTruthy();

    await fireEvent.press(
      screen.getByTestId('accessibility-dropdown-backdrop', { includeHiddenElements: true }),
    );
    expect(screen.queryByLabelText('High contrast: Off')).toBeNull();
    // Focus goes back where the user was — same restore rule as SearchPanel's own close.
    expect(focusOn).toHaveBeenCalled();
  });

  it('is mutually exclusive with Search and Bookmarks, both ways round', async () => {
    // `includeHiddenElements`, same reasoning as `openSearch`/`openContents` elsewhere in this
    // file: with a panel open the toolbar is hidden from assistive tech but stays visible and
    // tappable, and a press is a touch. That hidden state is asserted separately.
    const toolbar = async (name: string): Promise<void> => {
      await fireEvent.press(screen.getByRole('button', { name, includeHiddenElements: true }));
    };

    await mountReader();

    await toolbar('Accessibility');
    expect(screen.getByLabelText('High contrast: Off')).toBeTruthy();

    await toolbar('Search this title');
    expect(screen.queryByLabelText('High contrast: Off')).toBeNull();

    await toolbar('Accessibility');
    expect(screen.queryByLabelText('Close search')).toBeNull();
    expect(screen.getByLabelText('High contrast: Off')).toBeTruthy();

    await toolbar('Bookmarks');
    expect(screen.queryByLabelText('High contrast: Off')).toBeNull();
    expect(screen.getByLabelText('Close bookmarks')).toBeTruthy();
  });

  it('shows the Dyslexia Font row for an EPUB', async () => {
    await mountReader();
    await fireEvent.press(screen.getByLabelText('Accessibility'));

    expect(screen.getByLabelText('Dyslexia font: Off')).toBeTruthy();
  });

  it('passes the format through, so a PDF loses the row it cannot honour', async () => {
    jest.mocked(prepareBook).mockResolvedValue('PDF' as ContentFormat);
    await mountReader();
    await fireEvent.press(screen.getByLabelText('Accessibility'));

    expect(screen.queryByLabelText(/Dyslexia font/)).toBeNull();
    // The other two apply to every format, which is why the ENTRY POINT is not format-gated.
    expect(screen.getByLabelText('High contrast: Off')).toBeTruthy();
  });

  it('renders "Accessibility information" as a plain button, not a toggle, inside the dropdown', async () => {
    await mountReader();
    await fireEvent.press(screen.getByLabelText('Accessibility'));

    const infoButton = screen.getByLabelText('Accessibility information');
    expect(infoButton.props.accessibilityState?.selected).toBeUndefined();
  });

  it('pressing "Accessibility information" closes the dropdown and calls onOpenAccessibilityInfo', async () => {
    const onOpenAccessibilityInfo = jest.fn();
    await mountReader({ onOpenAccessibilityInfo });

    await fireEvent.press(screen.getByLabelText('Accessibility'));
    await fireEvent.press(screen.getByLabelText('Accessibility information'));

    expect(onOpenAccessibilityInfo).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('High contrast: Off')).toBeNull();
  });
});

describe('applyAppearance — the prefs-application wiring', () => {
  afterEach(() => {
    jest.mocked(useAppearanceEnv).mockReturnValue(LIGHT_ENV);
    jest.mocked(prefsStore.getPrefs).mockResolvedValue(makePrefs());
  });

  it('sends applyAppearance before the open command, not alongside or after it', async () => {
    await mountReader();
    await reportReady();

    const calls = __injectJavaScript.mock.calls.map((call) => String(call[0]));
    const appearanceIndex = calls.indexOf(
      buildCommandScript({
        type: 'applyAppearance',
        appearance: toReaderAppearance(makePrefs(), LIGHT_ENV),
      }),
    );
    const openIndex = calls.indexOf(buildCommandScript({ type: 'openEpub', base64: 'UEsDBA==' }));

    // Both must actually have been sent (index -1 would mean "never called", not "called first").
    expect(appearanceIndex).toBeGreaterThanOrEqual(0);
    expect(openIndex).toBeGreaterThan(appearanceIndex);
  });

  it('re-sends applyAppearance when prefsStore notifies, without reopening the book', async () => {
    await mountReader();
    await reportReady();
    __injectJavaScript.mockClear();

    // NOT wrapped in act(): the listener calls `send`, a ref method call
    // (webViewRef.current.injectJavaScript), not a React state update — there is nothing for act()
    // to flush, and wrapping it anyway was found to corrupt the test-act environment for every test
    // that ran afterward in this file (an unrelated `act()` call landing while React's own internal
    // act tracking was mid-flight from the preceding reportReady()).
    const changed = makePrefs({ theme: 'dark' });
    __emitPrefsChange(changed);
    // The listener's send is now behind two microtask hops (buildAppearanceWithFont's own await of
    // loadFontFaceSrc, then the listener's await of buildAppearanceWithFont itself) — a bare double
    // await, not act(), per the note above.
    await Promise.resolve();
    await Promise.resolve();

    expect(__injectJavaScript).toHaveBeenCalledWith(
      buildCommandScript({
        type: 'applyAppearance',
        appearance: toReaderAppearance(changed, LIGHT_ENV),
      }),
    );
    // NOT a reopen: `openEpub` carries the book's bytes and nothing about a theme change should
    // touch them.
    expect(__injectJavaScript).not.toHaveBeenCalledWith(
      buildCommandScript({ type: 'openEpub', base64: 'UEsDBA==' }),
    );
  });

  it('re-sends applyAppearance when the OS-level appearance changes', async () => {
    const view = await render(<ReaderScreen bookId="test-book" />);
    await screen.findByTestId('reader-webview');
    await reportReady();
    __injectJavaScript.mockClear();

    const darkEnv: AppearanceEnv = { ...LIGHT_ENV, osColorScheme: 'dark' };
    jest.mocked(useAppearanceEnv).mockReturnValue(darkEnv);
    await act(async () => {
      await view.rerender(<ReaderScreen bookId="test-book" />);
    });

    expect(__injectJavaScript).toHaveBeenCalledWith(
      buildCommandScript({
        type: 'applyAppearance',
        appearance: toReaderAppearance(makePrefs(), darkEnv),
      }),
    );

    // Explicit, rather than relying on auto-cleanup between tests: this component is the one
    // subscriber in the whole file that registers with a SHARED module-level mock registry
    // (prefsStore's `listeners` Set), so a tree left mounted here is externally observable by a
    // later test in a way nothing else in this file is — see the unmount test below for exactly
    // that failure mode.
    await view.unmount();
  });

  it('stops re-applying after unmount', async () => {
    const view = await render(<ReaderScreen bookId="test-book" />);
    await screen.findByTestId('reader-webview');
    await reportReady();
    __injectJavaScript.mockClear();

    await view.unmount();
    // Not act()-wrapped — see the note in the test above.
    __emitPrefsChange(makePrefs({ theme: 'dark' }));

    expect(__injectJavaScript).not.toHaveBeenCalled();
  });

  it("overlays the loaded font-face bytes onto customFontUri, not toReaderAppearance's own passthrough", async () => {
    const fontDataUri = 'data:font/ttf;base64,AAAA';
    jest.mocked(loadFontFaceSrc).mockResolvedValue(fontDataUri);
    const withInter = makePrefs({ font: { family: 'Inter' } });
    jest.mocked(prefsStore.getPrefs).mockResolvedValue(withInter);

    await mountReader();
    await reportReady();

    // toReaderAppearance's own resolveFont carries customFontUri through unresolved (undefined on
    // this prefs record) — the sent payload must have the LOADED bytes instead, not that passthrough.
    expect(__injectJavaScript).toHaveBeenCalledWith(
      buildCommandScript({
        type: 'applyAppearance',
        appearance: { ...toReaderAppearance(withInter, LIGHT_ENV), customFontUri: fontDataUri },
      }),
    );
    expect(jest.mocked(loadFontFaceSrc)).toHaveBeenCalledWith('Inter');
  });

  it('overlays the loaded font-face bytes on the prefs-subscribe re-apply too', async () => {
    await mountReader();
    await reportReady();
    __injectJavaScript.mockClear();

    const fontDataUri = 'data:font/ttf;base64,BBBB';
    jest.mocked(loadFontFaceSrc).mockResolvedValue(fontDataUri);
    const withPoppins = makePrefs({ font: { family: 'Poppins' } });

    // Not act()-wrapped — see the note on the theme-change test above; two microtask hops, same
    // reasoning as there.
    __emitPrefsChange(withPoppins);
    await Promise.resolve();
    await Promise.resolve();

    expect(__injectJavaScript).toHaveBeenCalledWith(
      buildCommandScript({
        type: 'applyAppearance',
        appearance: { ...toReaderAppearance(withPoppins, LIGHT_ENV), customFontUri: fontDataUri },
      }),
    );
  });
});

describe('ReaderScreen Contents panel', () => {
  it('opens on the Contents button and lists every entry the book sent', async () => {
    await mountReader();
    await deliver({ type: 'toc', items: flatToc(40) });

    // The count in the label is the only signal that the TOC arrived at all.
    await openContents();

    // The LAST entry, not the first: a clipped list still renders its head.
    expect(screen.getByText('Chapter 40')).toBeTruthy();
  });

  it('indents nested chapters by depth and still lists them', async () => {
    // A real book's nav document is a tree: the top level is often just parts, and
    // the chapters hang off it. Until the template flattened `subitems`, everything
    // below the top level was absent from this panel — not below the fold, absent.
    await mountReader();
    await deliver({
      type: 'toc',
      items: [
        { label: 'Part One', target: { kind: 'href', href: 'part1.xhtml' }, depth: 0 },
        { label: 'Chapter 1', target: { kind: 'href', href: 'ch1.xhtml' }, depth: 1 },
        { label: 'Section 1.1', target: { kind: 'href', href: 'ch1.xhtml#s1' }, depth: 2 },
      ],
    });
    await openContents();

    // Present at all — the point of the flatten.
    expect(screen.getByText('Section 1.1')).toBeTruthy();

    // And visibly nested. paddingLeft, not marginLeft: the row stays fully
    // tappable at depth.
    const rowFor = (label: string) => screen.getByText(label).parent;
    expect(rowFor('Part One')?.props.style).toMatchObject([{}, { paddingLeft: 0 }]);
    expect(rowFor('Chapter 1')?.props.style).toMatchObject([{}, { paddingLeft: 16 }]);
    expect(rowFor('Section 1.1')?.props.style).toMatchObject([{}, { paddingLeft: 32 }]);
  });

  it('fades only the edges the list actually continues past', async () => {
    // The numbers are the ones measured on the device with this fixture's 22-entry
    // TOC (frame 600pt, content 1054pt), so this test describes a real geometry rather
    // than a convenient one.
    await mountReader();
    await deliver({ type: 'toc', items: flatToc(40) });
    await openContents();

    const list = screen.getByTestId('reader-toc-list');
    // Awaited individually rather than batched inside act(): fireEvent does its own
    // act() wrapping in v14, so nesting them logs "overlapping act() calls".
    await fireEvent(list, 'layout', { nativeEvent: { layout: { height: 600 } } });
    await fireEvent(list, 'contentSizeChange', 0, 1054);

    // At the top: entries continue below, nothing is hidden above.
    expect(
      screen.queryByTestId('reader-toc-fade-bottom', { includeHiddenElements: true }),
    ).toBeTruthy();
    expect(screen.queryByTestId('reader-toc-fade-top', { includeHiddenElements: true })).toBeNull();

    // Scrolled to the very end: the mirror image. Getting this wrong leaves a white
    // veil over the last entry, which is the same defect the fade exists to fix.
    await fireEvent.scroll(list, { nativeEvent: { contentOffset: { y: 454 } } });
    expect(
      screen.queryByTestId('reader-toc-fade-bottom', { includeHiddenElements: true }),
    ).toBeNull();
    expect(
      screen.queryByTestId('reader-toc-fade-top', { includeHiddenElements: true }),
    ).toBeTruthy();
  });

  it('fades neither edge when the whole list fits', async () => {
    // A short TOC emits no scroll event at all, so this case is only reachable through
    // onLayout/onContentSizeChange — and it is the common one: most books' TOCs fit.
    await mountReader();
    await deliver({ type: 'toc', items: flatToc(3) });
    await openContents();

    const list = screen.getByTestId('reader-toc-list');
    await fireEvent(list, 'layout', { nativeEvent: { layout: { height: 600 } } });
    await fireEvent(list, 'contentSizeChange', 0, 180);

    expect(screen.queryByTestId('reader-toc-fade-top', { includeHiddenElements: true })).toBeNull();
    expect(
      screen.queryByTestId('reader-toc-fade-bottom', { includeHiddenElements: true }),
    ).toBeNull();
  });

  it('keeps the Contents button disabled until a TOC arrives', async () => {
    await mountReader();

    // A book with no navigation document is legitimate; the panel must not be
    // openable onto an empty list.
    expect(screen.getByRole('button', { name: 'Contents' }).props.accessibilityState).toMatchObject(
      { disabled: true },
    );
  });

  it('reports disabled WITHOUT expanded while there is no TOC, and expanded once there is', async () => {
    // A control that can never open is not "collapsed" — reporting `expanded: false` alongside
    // `disabled: true` is what makes a screen reader offer "collapsed, expandable" for a button
    // that will never expand. Each state is the whole truth in its own case.
    await mountReader();

    // `undefined`, not `false`. Pressable normalises its accessibilityState so every key is
    // present, so the assertion is on the VALUE — undefined is what RN's bridge drops on the way
    // to the platform, and `false` is what it would forward as a real "collapsed".
    expect(
      screen.getByRole('button', { name: 'Contents' }).props.accessibilityState.expanded,
    ).toBeUndefined();

    await deliver({ type: 'toc', items: flatToc(3) });

    expect(screen.getByRole('button', { name: 'Contents' }).props.accessibilityState).toMatchObject(
      { expanded: false },
    );

    await openContents();

    expect(
      screen.getByRole('button', { name: 'Close contents' }).props.accessibilityState,
    ).toMatchObject({ expanded: true });
  });
});

describe('ReaderScreen in-book search', () => {
  beforeEach(() => {
    jest.mocked(queryBookIndex).mockReset().mockResolvedValue([]);
    jest.mocked(getIndex).mockReset().mockResolvedValue(new Uint8Array([1]));
    __injectJavaScript.mockClear();
  });

  function epubHit(n: number, chapterId = 'ch1'): SearchHit {
    return {
      bookId: 'test-book',
      chapterId,
      locator: { type: 'EPUB', cfi: `epubcfi(/6/2[${chapterId}]!/4/4/1:${n})` },
      snippet: `…the grey wolf number ${n} moved…`,
    };
  }

  async function openSearch(): Promise<void> {
    // `includeHiddenElements`, same reasoning as `openContents`: with a panel already open the
    // toolbar is hidden from assistive tech but remains visible and tappable, and a press is a
    // touch. The hidden state itself is asserted separately.
    await fireEvent.press(
      screen.getByRole('button', { name: 'Search this title', includeHiddenElements: true }),
    );
  }

  /** Type a term and press the panel's Search button. */
  async function runSearch(term: string): Promise<void> {
    await fireEvent.changeText(screen.getByTestId('reader-search-input'), term);
    await fireEvent.press(screen.getByRole('button', { name: 'Search' }));
  }

  it('opens and closes the panel from the toolbar', async () => {
    await mountReader();

    await openSearch();
    expect(screen.getByTestId('reader-search-input')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Close search' }));
    expect(screen.queryByTestId('reader-search-input')).toBeNull();
  });

  it('keeps Contents and Search mutually exclusive', async () => {
    // A UI decision, tested on its own merits: there is one panel's worth of room over the
    // viewer. It used to be load-bearing for this suite as well, because both toggles read
    // "Close" and two of them would have made every `name: 'Close'` query ambiguous. Each panel
    // now names its own close affordance, so that second job is gone and this test covers only
    // what it says.
    await mountReader();
    await deliver({ type: 'toc', items: flatToc(3) });

    await openSearch();
    expect(screen.getByTestId('reader-search-input')).toBeTruthy();

    await openContents();
    expect(screen.queryByTestId('reader-search-input')).toBeNull();
    expect(screen.getByTestId('reader-toc-list')).toBeTruthy();

    await openSearch();
    expect(screen.queryByTestId('reader-toc-list')).toBeNull();
  });

  it('queries only on submit, and passes the raw typed text through', async () => {
    await mountReader();
    await openSearch();

    const input = screen.getByTestId('reader-search-input');
    await fireEvent.changeText(input, 'Tur');
    await fireEvent.changeText(input, 'Turbo');
    await fireEvent.changeText(input, 'Turbocharger!');

    // Not once per keystroke: every call re-parses the whole index, and Search caches
    // nothing.
    expect(queryBookIndex).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('button', { name: 'Search' }));

    // Raw, uncleaned. Search's termTokens lowercases and strips punctuation itself;
    // normalising here would be a second, divergent implementation of that.
    expect(queryBookIndex).toHaveBeenCalledTimes(1);
    expect(queryBookIndex).toHaveBeenCalledWith('test-book', 'Turbocharger!');
  });

  it('lists a row per occurrence and reports the count', async () => {
    jest.mocked(queryBookIndex).mockResolvedValue([epubHit(1), epubHit(2), epubHit(3, 'ch2')]);
    await mountReader();
    await openSearch();
    await runSearch('wolf');

    expect(screen.getByText('3 matches for “wolf”.')).toBeTruthy();
    expect(screen.getByText('…the grey wolf number 3 moved…')).toBeTruthy();
    // Chapter run headers, emitted only where the chapter changes.
    expect(screen.getByText('ch2')).toBeTruthy();
  });

  it('bounds the results list so it can scroll past the first screenful', async () => {
    // A PROXY, and worth saying so: Jest has no layout engine, so "the list scrolls"
    // cannot be asserted here any more than it can for the Contents list (see this
    // file's header). What CAN be pinned is the structure whose absence caused the
    // clipping — the ScrollView needs a parent with `flex: 1`, because a plain View
    // defaults to flexShrink: 0 and otherwise grows to its content height, letting the
    // panel clip everything past the first screenful. Note the flex belongs to the
    // WRAPPER, not the ScrollView, which brings flexGrow/flexShrink: 1 of its own.
    jest
      .mocked(queryBookIndex)
      .mockResolvedValue(Array.from({ length: 60 }, (_, i) => epubHit(i + 1)));
    await mountReader();
    await openSearch();
    await runSearch('wolf');

    const wrapper = screen.getByTestId('reader-search-results').parent;
    expect(StyleSheet.flatten(wrapper?.props.style as never)).toMatchObject({ flex: 1 });

    // And the tail of the list is rendered at all — clipping and not-rendering are
    // different bugs with the same symptom, so rule the second one out.
    expect(screen.getByText('…the grey wolf number 60 moved…')).toBeTruthy();
  });

  it('explains that a multi-word search is not a phrase search', async () => {
    // Without this the count is actively misleading. Measured against the real sample
    // index, "chapter 9" returns 91 hits — 88 of them the word "chapter" alone —
    // because Search ANDs the tokens at CHAPTER granularity and then returns every
    // posting of EVERY query word in the qualifying chapters. Adding a word makes the
    // list LONGER, which is the opposite of what typing a second word implies.
    jest.mocked(queryBookIndex).mockResolvedValue([epubHit(1), epubHit(2)]);
    await mountReader();
    await openSearch();
    await runSearch('chapter 9');

    expect(
      screen.getByText(
        'Not a phrase search: this lists every occurrence of “chapter” and “9” in chapters that contain all of them.',
      ),
    ).toBeTruthy();
  });

  it('does not claim phrase semantics for a single-word search', async () => {
    jest.mocked(queryBookIndex).mockResolvedValue([epubHit(1)]);
    await mountReader();
    await openSearch();
    await runSearch('chapter');

    expect(screen.queryByText(/Not a phrase search/)).toBeNull();
  });

  it('reports an empty result without making the book look broken', async () => {
    // THE STATE THE APP IS IN whenever a book ships no index: queryBookIndex returns
    // [] for that and for "no matches" alike.
    await mountReader();
    await openSearch();
    await runSearch('wolf');

    expect(screen.getByText('No matches for “wolf” in this title.')).toBeTruthy();
    // The top banner is for ReaderErrorCodes and means the BOOK failed. Search finding
    // nothing must never light it up.
    expect(screen.queryByText('CONTENT_LOAD_FAILED')).toBeNull();
    expect(screen.queryByText('BRIDGE_PARSE_FAILED')).toBeNull();
  });

  it('keeps a thrown query inside the panel, leaving the book readable', async () => {
    jest
      .mocked(queryBookIndex)
      .mockRejectedValue(
        new Error(
          'queryBookIndex: failed to decode search index for "test-book" — Unexpected token',
        ),
      );

    await mountReader();
    await deliver({ type: 'toc', items: flatToc(3) });
    await openSearch();
    await runSearch('wolf');

    expect(screen.getByText('Search is unavailable for this title.')).toBeTruthy();
    expect(screen.getByText(/failed to decode search index/)).toBeTruthy();
    expect(screen.queryByText('CONTENT_LOAD_FAILED')).toBeNull();

    // The book itself is untouched by a search failure.
    await openContents();
    expect(screen.getByTestId('reader-toc-list')).toBeTruthy();
  });

  it('sends goTo carrying a bare CFI string when a result is tapped', async () => {
    // THE LOAD-BEARING ONE. WEBVIEW_BRIDGE.md's claim that search trips no conversion
    // trigger holds only while the host unwraps SearchHit.locator to a string. Pinning
    // the injected script against buildCommandScript means widening the bridge to
    // carry the Locator union breaks this test rather than the bridge.
    jest.mocked(queryBookIndex).mockResolvedValue([epubHit(1), epubHit(2)]);
    await mountReader();
    await reportReady();
    await openSearch();
    await runSearch('wolf');

    await fireEvent.press(screen.getByText('…the grey wolf number 2 moved…'));

    expect(__injectJavaScript).toHaveBeenLastCalledWith(
      buildCommandScript({
        type: 'goTo',
        target: { kind: 'href', href: 'epubcfi(/6/2[ch1]!/4/4/1:2)' },
      }),
    );
    // The panel DISMISSES on select — it covers the page, so staying open would hide
    // the text the jump just went to. The floating match bar is what remains.
    expect(screen.queryByTestId('reader-search-input')).toBeNull();
    expect(screen.getByTestId('reader-search-match-bar')).toBeTruthy();
    expect(screen.getByText('Match 2 of 2')).toBeTruthy();
  });

  it('queues a tapped hit while the book is still loading, then jumps once ready', async () => {
    // THE FAILSAFE. `send` stays null until the WebView reports `ready` — but search
    // runs host-side over the decrypted index (queryBookIndex), so results can be back
    // and tapped well before that. `send?.({...})` used to silently drop the jump here:
    // the panel closed and the match bar claimed "Match 2 of 2" as if it had worked.
    jest.mocked(queryBookIndex).mockResolvedValue([epubHit(1), epubHit(2)]);
    await mountReader();
    await openSearch();
    await runSearch('wolf');

    // No reportReady() yet — send is still null.
    await fireEvent.press(screen.getByText('…the grey wolf number 2 moved…'));

    const goTo = buildCommandScript({
      type: 'goTo',
      target: { kind: 'href', href: 'epubcfi(/6/2[ch1]!/4/4/1:2)' },
    });

    // Not dropped, and not pretending it happened: the panel stays open with a visible
    // notice instead of closing onto a match bar that lied about the jump.
    expect(screen.getByTestId('reader-search-input')).toBeTruthy();
    expect(screen.getByTestId('reader-search-awaiting-seek')).toBeTruthy();
    expect(__injectJavaScript).not.toHaveBeenCalledWith(goTo);

    await reportReady();

    // Queued jump fires the moment `send` exists, alongside (not instead of) the open
    // command that `ready` also triggers.
    expect(__injectJavaScript).toHaveBeenCalledWith(goTo);
    expect(screen.queryByTestId('reader-search-input')).toBeNull();
    expect(screen.getByTestId('reader-search-match-bar')).toBeTruthy();
    expect(screen.getByText('Match 2 of 2')).toBeTruthy();
  });

  it('cancels a queued jump when a new search is submitted before the book is ready', async () => {
    // A queued target is only meaningful against the result set it was tapped from.
    // Running a new search before the book becomes ready must not leave a stale jump
    // waiting to fire into whatever the reader shows once it is.
    jest
      .mocked(queryBookIndex)
      .mockResolvedValueOnce([epubHit(1)])
      .mockResolvedValueOnce([epubHit(5)]);
    await mountReader();
    await openSearch();
    await runSearch('wolf');
    await fireEvent.press(screen.getByText('…the grey wolf number 1 moved…'));

    expect(screen.getByTestId('reader-search-awaiting-seek')).toBeTruthy();

    await runSearch('bear');
    expect(screen.queryByTestId('reader-search-awaiting-seek')).toBeNull();

    await reportReady();
    expect(__injectJavaScript).not.toHaveBeenCalledWith(
      buildCommandScript({
        type: 'goTo',
        target: { kind: 'href', href: 'epubcfi(/6/2[ch1]!/4/4/1:1)' },
      }),
    );
  });

  it('cancels a queued jump when the panel is closed', async () => {
    jest.mocked(queryBookIndex).mockResolvedValue([epubHit(1)]);
    await mountReader();
    await openSearch();
    await runSearch('wolf');
    await fireEvent.press(screen.getByText('…the grey wolf number 1 moved…'));

    expect(screen.getByTestId('reader-search-awaiting-seek')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Close search' }));
    await reportReady();

    expect(__injectJavaScript).not.toHaveBeenCalledWith(
      buildCommandScript({
        type: 'goTo',
        target: { kind: 'href', href: 'epubcfi(/6/2[ch1]!/4/4/1:1)' },
      }),
    );
  });

  it('leaves the viewer mounted and unresized while searching', async () => {
    // THE REGRESSION THIS GUARDS. Both search surfaces overlay the viewer instead of
    // sharing the column with it. A sibling that occupies layout changes the viewer's
    // height, which resizes the WebView, which makes epub.js re-paginate — and a CFI
    // resolved under one pagination points at a different page under another, so every
    // jump lands off by a page. Asserting the WebView is continuously mounted with an
    // unchanged style is the closest a layout-engine-less test can get to that.
    jest.mocked(queryBookIndex).mockResolvedValue([epubHit(1)]);
    await mountReader();
    await reportReady();

    const styleBefore = screen.getByTestId('reader-webview', { includeHiddenElements: true }).props
      .style;

    await openSearch();
    expect(screen.getByTestId('reader-webview', { includeHiddenElements: true })).toBeTruthy();
    await runSearch('wolf');
    await fireEvent.press(screen.getByText('…the grey wolf number 1 moved…'));

    expect(
      screen.getByTestId('reader-webview', { includeHiddenElements: true }).props.style,
    ).toEqual(styleBefore);
  });

  it('reopens the results from the match bar', async () => {
    jest.mocked(queryBookIndex).mockResolvedValue([epubHit(1), epubHit(2)]);
    await mountReader();
    await reportReady();
    await openSearch();
    await runSearch('wolf');
    await fireEvent.press(screen.getByText('…the grey wolf number 1 moved…'));

    // The counter doubles as the way back in — it is the widest target in the bar and
    // already names what tapping it shows.
    await fireEvent.press(
      screen.getByRole('button', { name: 'Match 1 of 2 for wolf. Show all results.' }),
    );

    expect(screen.getByTestId('reader-search-input')).toBeTruthy();
    // Reopening must not re-run the query or lose the place in the results.
    expect(queryBookIndex).toHaveBeenCalledTimes(1);
    expect(screen.getByText('…the grey wolf number 2 moved…')).toBeTruthy();
  });

  it('steps through matches from the match bar and clamps at both ends', async () => {
    jest.mocked(queryBookIndex).mockResolvedValue([epubHit(1), epubHit(2), epubHit(3)]);
    await mountReader();
    await reportReady();
    await openSearch();
    await runSearch('wolf');

    // Dismiss the panel to get at the match bar — stepping is something you do while
    // looking at the page, which is why the arrows live there and not in the results.
    await fireEvent.press(screen.getByRole('button', { name: 'Close search' }));

    // Nothing selected yet, so the count reads as a total rather than a position.
    expect(screen.getByText('3 matches')).toBeTruthy();

    const next = (): Promise<void> =>
      fireEvent.press(screen.getByRole('button', { name: 'Next match' }));

    await next();
    expect(screen.getByText('Match 1 of 3')).toBeTruthy();
    await next();
    await next();
    expect(screen.getByText('Match 3 of 3')).toBeTruthy();

    // Clamp, not wrap — the arrow disables rather than looping back to the first hit.
    expect(
      screen.getByRole('button', { name: 'Next match' }).props.accessibilityState,
    ).toMatchObject({ disabled: true });
  });

  // REPLACES "lists a PDF hit but never navigates to it", which pinned a dead row.
  //
  // That was never a decision about whether PDF results should be navigable — `cfiOf` unwrapped
  // `locator.cfi`, which only an EPUB locator has, so a PDF hit had nowhere to be sent while `goTo`
  // took a bare string. A discriminated `ReaderTarget` can carry a page, so `targetOf` sends one and
  // the row stops being a dead end.
  it('seeks to a PDF hit by page, not just an EPUB hit by CFI', async () => {
    const pdfHit: SearchHit = {
      bookId: 'test-book',
      chapterId: 'ch1',
      locator: { type: 'PDF', page: 4 },
      snippet: '…a page-addressed hit…',
    };
    jest.mocked(queryBookIndex).mockResolvedValue([epubHit(1), pdfHit, epubHit(3)]);

    await mountReader();
    await reportReady();
    await openSearch();
    await runSearch('wolf');

    // Still LISTED rather than filtered, for the reason it always was: dropping a hit would
    // desynchronise the ordinals from "Match n of m".
    expect(screen.getByText('…a page-addressed hit…')).toBeTruthy();
    // And no longer labelled unavailable, because it is not.
    expect(screen.queryByText('Not available in this reader')).toBeNull();

    await fireEvent.press(screen.getByText('…a page-addressed hit…'));

    expect(__injectJavaScript).toHaveBeenLastCalledWith(
      buildCommandScript({ type: 'goTo', target: { kind: 'page', page: 4 } }),
    );
  });

  it('steps onto a PDF hit instead of skipping past it', async () => {
    // The match bar used to step straight over every PDF hit while still counting it, so "Match 2 of
    // 3" was unreachable — the ordinals described a list the arrows could not visit.
    const pdfHit: SearchHit = {
      bookId: 'test-book',
      chapterId: 'ch1',
      locator: { type: 'PDF', page: 7 },
      snippet: '…the middle hit…',
    };
    jest.mocked(queryBookIndex).mockResolvedValue([epubHit(1), pdfHit, epubHit(3)]);

    await mountReader();
    await reportReady();
    await openSearch();
    await runSearch('wolf');
    await fireEvent.press(screen.getByRole('button', { name: 'Close search' }));

    await fireEvent.press(screen.getByRole('button', { name: 'Next match' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Next match' }));

    expect(screen.getByText('Match 2 of 3')).toBeTruthy();
    expect(__injectJavaScript).toHaveBeenLastCalledWith(
      buildCommandScript({ type: 'goTo', target: { kind: 'page', page: 7 } }),
    );
  });

  // THE MATCH BAR'S ARROWS USED TO BE PERMANENTLY DISABLED FOR AN ALL-PDF RESULT SET, even though
  // every hit was genuinely navigable. `hasNavigableFrom` (useBookSearch.ts) checked an EPUB-only
  // unwrap that returns null for every PDF locator, so a mixed EPUB+PDF list (the other tests above)
  // still found an EPUB hit and reported navigable — the bug was invisible there. A PDF-only book
  // failed every check, so `canStepBack`/`canStepForward` were false from the first render. Asserting
  // on `accessibilityState.disabled` is the point: the earlier tests only checked that pressing the
  // button worked, and RNTL's fireEvent.press does not itself respect a `disabled` prop the way a
  // real device's Pressable does — so this is the check that would actually have caught it.
  it('does not disable the match bar arrows for an all-PDF result set', async () => {
    jest.mocked(queryBookIndex).mockResolvedValue([
      {
        bookId: 'test-book',
        chapterId: 'ch1',
        locator: { type: 'PDF', page: 3 },
        snippet: '…one…',
      },
      {
        bookId: 'test-book',
        chapterId: 'ch1',
        locator: { type: 'PDF', page: 7 },
        snippet: '…two…',
      },
    ]);

    await mountReader();
    await reportReady();
    await openSearch();
    await runSearch('wolf');
    await fireEvent.press(screen.getByRole('button', { name: 'Close search' }));

    expect(
      screen.getByRole('button', { name: 'Next match' }).props.accessibilityState,
    ).toMatchObject({ disabled: false });

    await fireEvent.press(screen.getByRole('button', { name: 'Next match' }));

    expect(screen.getByText('Match 1 of 2')).toBeTruthy();
    // Landed on the FIRST hit — "Previous" is correctly disabled (nothing before it), but "Next"
    // must still be enabled since there is a second PDF hit ahead of it.
    expect(
      screen.getByRole('button', { name: 'Previous match' }).props.accessibilityState,
    ).toMatchObject({ disabled: true });
    expect(
      screen.getByRole('button', { name: 'Next match' }).props.accessibilityState,
    ).toMatchObject({ disabled: false });
    expect(__injectJavaScript).toHaveBeenLastCalledWith(
      buildCommandScript({ type: 'goTo', target: { kind: 'page', page: 3 } }),
    );
  });

  it('drops a stale response that lands after a newer search', async () => {
    // Justifies the sequence guard in useBookSearch: queryBookIndex takes no
    // AbortSignal, so a slow broad search can still be parsing when a narrower one has
    // already returned.
    function deferred(): { promise: Promise<SearchHit[]>; resolve: (v: SearchHit[]) => void } {
      let resolve!: (value: SearchHit[]) => void;
      const promise = new Promise<SearchHit[]>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    const slow = deferred();
    const fast = deferred();
    jest.mocked(queryBookIndex).mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);

    await mountReader();
    await openSearch();
    await runSearch('wolf');
    await runSearch('bear');

    await act(async () => {
      fast.resolve([epubHit(2)]);
    });
    await act(async () => {
      slow.resolve([epubHit(1), epubHit(3)]); // arrives late, for the abandoned term
    });

    expect(screen.getByText('…the grey wolf number 2 moved…')).toBeTruthy();
    expect(screen.queryByText('…the grey wolf number 1 moved…')).toBeNull();
    expect(screen.getByText('1 match for “bear”.')).toBeTruthy();
  });

  // --- the two empty answers -------------------------------------------------------------------
  //
  // `queryBookIndex` returns [] both for "that word is not in the book" and for "this book has no
  // index at all", and says nothing about which. The panel could therefore only ever claim the
  // first — a lie for a book that was never indexed, and one that reads exactly like a broken
  // feature. Both `Big` fixtures ship `searchIndex: null`, so this is reachable from the book list.

  it('says the book has no index, rather than blaming the word', async () => {
    jest.mocked(queryBookIndex).mockResolvedValue([]);
    jest.mocked(getIndex).mockResolvedValue(null);

    await mountReader();
    await openSearch();
    await runSearch('chapter');

    expect(screen.getByText('This title has no search index.')).toBeTruthy();
    expect(screen.queryByText(/No matches for/)).toBeNull();
    // And the hint underneath stops explaining whole-word matching, which is not why this is empty.
    expect(screen.queryByText(/Whole words only/)).toBeNull();
    expect(screen.getByText(/No text was indexed for this title/)).toBeTruthy();
  });

  it('still blames the word when the book DOES have an index', async () => {
    jest.mocked(queryBookIndex).mockResolvedValue([]);
    jest.mocked(getIndex).mockResolvedValue(new Uint8Array([1]));

    await mountReader();
    await openSearch();
    await runSearch('chapter');

    expect(screen.getByText('No matches for “chapter” in this title.')).toBeTruthy();
    expect(screen.queryByText('This title has no search index.')).toBeNull();
  });

  it('does not ask about the index when the search found something', async () => {
    // A hit proves the index exists. Paying a session round-trip to confirm it would be a decrypt
    // on the successful path, which is the one path that has no question to answer.
    jest.mocked(queryBookIndex).mockResolvedValue([epubHit(1)]);
    jest.mocked(getIndex).mockClear();

    await mountReader();
    await openSearch();
    await runSearch('wolf');

    expect(getIndex).not.toHaveBeenCalled();
  });

  it('keeps the failure box for a thrown search, rather than claiming no index', async () => {
    // A throw already explains itself, and says nothing about whether an index exists. Two
    // contradictory reasons on screen is worse than one.
    jest.mocked(queryBookIndex).mockRejectedValue(new Error('boom'));
    jest.mocked(getIndex).mockResolvedValue(null);

    await mountReader();
    await openSearch();
    await runSearch('chapter');

    expect(screen.getByText('Search is unavailable for this title.')).toBeTruthy();
    expect(screen.queryByText('This title has no search index.')).toBeNull();
  });

  it('dismisses the match bar and forgets the results', async () => {
    jest.mocked(queryBookIndex).mockResolvedValue([epubHit(1), epubHit(2)]);
    await mountReader();
    await openSearch();
    await runSearch('wolf');
    await fireEvent.press(screen.getByRole('button', { name: 'Close search' }));

    await fireEvent.press(screen.getByRole('button', { name: 'Dismiss search' }));

    expect(screen.queryByTestId('reader-search-match-bar')).toBeNull();
    // Reopening the panel starts clean rather than restoring the dismissed hits.
    await openSearch();
    expect(screen.queryByText('…the grey wolf number 1 moved…')).toBeNull();
  });

  // --- painting the match -----------------------------------------------------------------------
  //
  // The applies half of search-match painting. These deliver `rendered` (the others in this file do
  // not need to) because painting is gated on it for the same reason `paintHighlights` is: there is
  // no rendition to paint onto before it.

  /** Every `paintSearchMatch` payload sent so far, in order. */
  function sentMatches(): ReaderSearchMatch[] {
    return __injectJavaScript.mock.calls
      .map(([script]: [string]) => /paintSearchMatch\((.*)\);\n/.exec(script as string))
      .filter((found): found is RegExpExecArray => found !== null)
      .map((found) => JSON.parse(found[1]) as ReaderSearchMatch);
  }

  it('paints the active hit, and only the active one', async () => {
    jest.mocked(queryBookIndex).mockResolvedValue([epubHit(1), epubHit(2)]);
    await mountReader();
    await reportReady();
    await deliver({ type: 'rendered' });
    await openSearch();
    await runSearch('wolf');

    // A search with nothing selected paints nothing: `activeIndex` is -1 until a hit is tapped.
    expect(sentMatches().at(-1)).toEqual({ epub: null, pdf: null });

    await fireEvent.press(screen.getByText('…the grey wolf number 2 moved…'));

    expect(sentMatches().at(-1)).toEqual({
      epub: { startCfi: 'epubcfi(/6/2[ch1]!/4/4/1:2)', matchText: 'wolf' },
      pdf: null,
    });
  });

  it('sends the paint AFTER the jump, and both from one tap', async () => {
    // Ordering is not load-bearing — an EPUB annotation is CFI-addressed and survives navigation,
    // and the PDF shell restores the outline whenever a page is rasterised — but it is worth
    // pinning that the tap does both, since a reader who sees the jump assumes the mark came with
    // it.
    jest.mocked(queryBookIndex).mockResolvedValue([epubHit(1)]);
    await mountReader();
    await reportReady();
    await deliver({ type: 'rendered' });
    await openSearch();
    await runSearch('wolf');
    __injectJavaScript.mockClear();

    await fireEvent.press(screen.getByText('…the grey wolf number 1 moved…'));

    const scripts = __injectJavaScript.mock.calls.map(([script]: [string]) => script);
    const jump = scripts.findIndex((script: string) => script.includes('TFReader.goTo('));
    const paint = scripts.findIndex((script: string) => script.includes('TFReader.paintSearchMatch('));
    expect(jump).toBeGreaterThan(-1);
    expect(paint).toBeGreaterThan(jump);
  });

  it('routes a PDF hit to the pdf side, with no format anywhere on the wire', async () => {
    // The bridge rule, at the send site rather than in a unit test of the mapper: the partition IS
    // the routing, so a `ContentFormat` literal must not appear in what crosses even though
    // `SearchHit.locator` is tagged with one.
    const pdfHit: SearchHit = {
      bookId: 'test-book',
      chapterId: 'ch1',
      locator: { type: 'PDF', page: 4, offset: 120 },
      snippet: '…a page-addressed hit…',
    };
    jest.mocked(queryBookIndex).mockResolvedValue([pdfHit]);
    await mountReader();
    await reportReady();
    await deliver({ type: 'rendered' });
    await openSearch();
    await runSearch('wolf');
    await fireEvent.press(screen.getByText('…a page-addressed hit…'));

    expect(sentMatches().at(-1)).toEqual({
      epub: null,
      pdf: { page: 4, startOffset: 120, matchText: 'wolf' },
    });
    const last = __injectJavaScript.mock.calls.at(-1)?.[0] as string;
    for (const format of ['EPUB', 'PDF', 'AUDIO']) {
      expect(last).not.toContain(`"${format}"`);
    }
  });

  it('clears the match when the bar is dismissed, without a second command to do it', async () => {
    // `searchMatchFor` answers NO_SEARCH_MATCH for `activeIndex === -1`, and `clear()` resets it —
    // so the clear rides the same effect and the same command as every paint.
    jest.mocked(queryBookIndex).mockResolvedValue([epubHit(1)]);
    await mountReader();
    await reportReady();
    await deliver({ type: 'rendered' });
    await openSearch();
    await runSearch('wolf');
    await fireEvent.press(screen.getByText('…the grey wolf number 1 moved…'));
    expect(sentMatches().at(-1)?.epub).not.toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'Dismiss search' }));

    expect(sentMatches().at(-1)).toEqual({ epub: null, pdf: null });
  });

  it('does not paint before the book has rendered', async () => {
    // `send` exists from `ready`, but a paint needs something to paint onto — the same gate the
    // highlights effect carries, and the reason it is `isRendered` rather than `send !== null`.
    jest.mocked(queryBookIndex).mockResolvedValue([epubHit(1)]);
    await mountReader();
    await reportReady();
    await openSearch();
    await runSearch('wolf');
    await fireEvent.press(screen.getByText('…the grey wolf number 1 moved…'));

    expect(sentMatches()).toEqual([]);
  });

  it('surfaces a match the shell could not pinpoint, and retracts it on the next one', async () => {
    // The notice exists because the failure is otherwise INVISIBLE: the jump succeeded, so an
    // unpainted match looks exactly like one that painted off screen.
    jest.mocked(queryBookIndex).mockResolvedValue([epubHit(1), epubHit(2)]);
    await mountReader();
    await reportReady();
    await deliver({ type: 'rendered' });
    await openSearch();
    await runSearch('wolf');
    await fireEvent.press(screen.getByText('…the grey wolf number 1 moved…'));

    expect(screen.queryByText('Could not pinpoint the match on the page')).toBeNull();
    await deliver({ type: 'searchMatchPainted', painted: false });
    expect(screen.getByText('Could not pinpoint the match on the page')).toBeTruthy();

    // Stepping to the next match retracts it WITHOUT a reply, because the notice is keyed to the
    // match it was about rather than being a standing boolean someone has to remember to clear.
    await fireEvent.press(screen.getByRole('button', { name: 'Next match' }));
    expect(screen.queryByText('Could not pinpoint the match on the page')).toBeNull();
  });

  it('does not raise the reader error banner for an unpaintable match', async () => {
    // Navigation worked. A banner over the book — the response to a corrupt book — would be wildly
    // out of proportion, which is why this is its own message type rather than a `fail()`.
    jest.mocked(queryBookIndex).mockResolvedValue([epubHit(1)]);
    await mountReader();
    await reportReady();
    await deliver({ type: 'rendered' });
    await openSearch();
    await runSearch('wolf');
    await fireEvent.press(screen.getByText('…the grey wolf number 1 moved…'));
    await deliver({ type: 'searchMatchPainted', painted: false });

    expect(screen.queryByText(/Could not open this book/)).toBeNull();
    expect(screen.getByTestId('reader-search-match-bar')).toBeTruthy();
  });
});

describe('ReaderScreen bookmarks panel', () => {
  function bookmark(overrides: Partial<ReaderBookmark> = {}): ReaderBookmark {
    return {
      id: 'b1',
      label: 'Chapter 1',
      target: { kind: 'href', href: 'epubcfi(/6/4[chap01]!/4/2/2)' },
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.mocked(loadBookmarks).mockReset().mockResolvedValue({ bookmarks: [], skippedIds: [] });
    jest
      .mocked(addCurrentEpubBookmark)
      .mockReset()
      .mockResolvedValue({ bookmarks: [], skippedIds: [] });
    jest
      .mocked(addCurrentPdfBookmark)
      .mockReset()
      .mockResolvedValue({ bookmarks: [], skippedIds: [] });
    jest.mocked(removeBookmark).mockReset().mockResolvedValue({ bookmarks: [], skippedIds: [] });
    jest.mocked(renameBookmark).mockReset().mockResolvedValue({ bookmarks: [], skippedIds: [] });
    // Redundant with the file-level beforeEach, which now resets the whole asset seam and the
    // command log for every test — kept because `bookmarksForOpenBook` (ReaderScreen.tsx) filters
    // the panel's list by `format`, so this block breaks in a particularly confusing way (every
    // EPUB-shaped `bookmark()` fixture silently vanishes) if that reset is ever narrowed.
    jest.mocked(prepareBook).mockResolvedValue('EPUB');
    __injectJavaScript.mockClear();
  });

  async function openBookmarks(): Promise<void> {
    await fireEvent.press(screen.getByRole('button', { name: 'Bookmarks' }));
  }

  async function relocateCfi(cfi: string | null): Promise<void> {
    await deliver({
      type: 'relocated',
      position: { kind: 'cfi', cfi },
      atStart: true,
      atEnd: false,
    });
  }

  it('does not load until the book has rendered', async () => {
    await mountReader();
    await openBookmarks();

    expect(loadBookmarks).not.toHaveBeenCalled();
    expect(screen.getByText('Loading bookmarks…')).toBeTruthy();
  });

  it('loads once the book renders and lists what came back', async () => {
    jest.mocked(loadBookmarks).mockResolvedValue({
      bookmarks: [bookmark({ id: 'a', label: 'The good bit' })],
      skippedIds: [],
    });
    await mountReader();
    await deliver({ type: 'rendered' });
    await openBookmarks();

    expect(loadBookmarks).toHaveBeenCalledTimes(1);
    expect(screen.getByText('The good bit')).toBeTruthy();
  });

  it('reports rows it could not read rather than silently shrinking the list', async () => {
    jest
      .mocked(loadBookmarks)
      .mockResolvedValue({ bookmarks: [bookmark({ id: 'a' })], skippedIds: ['bad-1', 'bad-2'] });
    await mountReader();
    await deliver({ type: 'rendered' });
    await openBookmarks();

    expect(screen.getByText('2 bookmarks could not be read and were left out.')).toBeTruthy();
  });

  it('shows an empty state once loaded with nothing stored', async () => {
    await mountReader();
    await deliver({ type: 'rendered' });
    await openBookmarks();

    expect(screen.getByText('No bookmarks yet. Add one from the button above.')).toBeTruthy();
  });

  it('navigates to a tapped bookmark and closes the panel — the same goTo every TOC entry and search hit uses', async () => {
    jest.mocked(loadBookmarks).mockResolvedValue({
      bookmarks: [
        bookmark({ id: 'a', label: 'Chapter 3', target: { kind: 'href', href: 'epubcfi(/6/10)' } }),
      ],
      skippedIds: [],
    });
    await mountReader();
    await reportReady();
    await deliver({ type: 'rendered' });
    await openBookmarks();

    await fireEvent.press(screen.getByText('Chapter 3'));

    expect(__injectJavaScript).toHaveBeenLastCalledWith(
      buildCommandScript({ type: 'goTo', target: { kind: 'href', href: 'epubcfi(/6/10)' } }),
    );
    expect(screen.queryByTestId('reader-bookmarks-list')).toBeNull();
  });

  it('disables adding the current position until a real location has arrived', async () => {
    await mountReader();
    await reportReady();
    await deliver({ type: 'rendered' });
    await openBookmarks();

    // Before the first `relocated`: no position at all.
    expect(
      screen.getByRole('button', { name: 'Bookmark this page' }).props.accessibilityState,
    ).toMatchObject({ disabled: true });

    // epub.js's own null-until-resolved CFI (see readerProgressStore.ts's `toLocator` guard).
    await relocateCfi(null);
    expect(
      screen.getByRole('button', { name: 'Bookmark this page' }).props.accessibilityState,
    ).toMatchObject({ disabled: true });

    await relocateCfi('epubcfi(/6/4[chap01]!/4/2/2)');
    expect(
      screen.getByRole('button', { name: 'Bookmark this page' }).props.accessibilityState,
    ).toMatchObject({ disabled: false });
  });

  it('bookmarks the current EPUB position and re-renders from the returned fresh set', async () => {
    jest.mocked(addCurrentEpubBookmark).mockResolvedValue({
      bookmarks: [bookmark({ id: 'new', label: 'Just added' })],
      skippedIds: [],
    });
    await mountReader();
    await reportReady();
    await deliver({ type: 'rendered' });
    await relocateCfi('epubcfi(/6/4[chap01]!/4/2/2)');
    await openBookmarks();

    await fireEvent.press(screen.getByRole('button', { name: 'Bookmark this page' }));

    // A blank label field is `undefined`, not `''` — falls through to `labelFor`'s own fallback
    // rather than this panel inventing a second empty-label convention.
    expect(addCurrentEpubBookmark).toHaveBeenCalledWith(
      'test-book',
      'epubcfi(/6/4[chap01]!/4/2/2)',
      undefined,
      undefined,
    );
    await screen.findByText('Just added');
  });

  it('carries the typed label through to the EPUB add call-site, trimmed', async () => {
    jest.mocked(addCurrentEpubBookmark).mockResolvedValue({
      bookmarks: [bookmark({ id: 'new', label: 'The good bit' })],
      skippedIds: [],
    });
    await mountReader();
    await reportReady();
    await deliver({ type: 'rendered' });
    await relocateCfi('epubcfi(/6/4[chap01]!/4/2/2)');
    await openBookmarks();

    await fireEvent.changeText(
      screen.getByTestId('reader-bookmark-label-input'),
      '  The good bit  ',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Bookmark this page' }));

    expect(addCurrentEpubBookmark).toHaveBeenCalledWith(
      'test-book',
      'epubcfi(/6/4[chap01]!/4/2/2)',
      undefined,
      'The good bit',
    );
    // The field clears once used, rather than re-offering the just-submitted text for the next add.
    expect(screen.getByTestId('reader-bookmark-label-input').props.value).toBe('');
  });

  it('bookmarks the current PDF page through addCurrentPdfBookmark, not the EPUB call-site', async () => {
    jest.mocked(prepareBook).mockResolvedValue('PDF');
    jest.mocked(getReaderHtmlUri).mockResolvedValue('file:///reader-pdf.html');
    jest.mocked(getBookBase64).mockResolvedValue('JVBERi0xLjQK');
    jest
      .mocked(addCurrentPdfBookmark)
      .mockResolvedValue({ bookmarks: [bookmark({ id: 'new', label: 'Page 7' })], skippedIds: [] });
    await mountReader();
    await reportReady();
    await deliver({ type: 'rendered' });
    await deliver({
      type: 'relocated',
      position: { kind: 'page', page: 7, pageCount: 100 },
      atStart: false,
      atEnd: false,
    });
    await openBookmarks();

    await fireEvent.press(screen.getByRole('button', { name: 'Bookmark this page' }));

    expect(addCurrentPdfBookmark).toHaveBeenCalledWith('test-book', 7, undefined);
    expect(addCurrentEpubBookmark).not.toHaveBeenCalled();
  });

  it('deletes by id and re-renders from the returned fresh set', async () => {
    jest.mocked(loadBookmarks).mockResolvedValue({
      bookmarks: [bookmark({ id: 'victim', label: 'To be deleted' })],
      skippedIds: [],
    });
    jest.mocked(removeBookmark).mockResolvedValue({
      bookmarks: [bookmark({ id: 'survivor', label: 'Still here' })],
      skippedIds: [],
    });
    await mountReader();
    await deliver({ type: 'rendered' });
    await openBookmarks();

    await fireEvent.press(screen.getByRole('button', { name: 'Delete bookmark: To be deleted' }));

    expect(removeBookmark).toHaveBeenCalledWith('test-book', 'victim');
    await screen.findByText('Still here');
    expect(screen.queryByText('To be deleted')).toBeNull();
  });

  it('keeps Bookmarks mutually exclusive with Contents and Search', async () => {
    await mountReader();
    await deliver({ type: 'toc', items: flatToc(3) });
    await deliver({ type: 'rendered' });

    await openBookmarks();
    expect(screen.getByText('No bookmarks yet. Add one from the button above.')).toBeTruthy();

    await openContents();
    expect(screen.queryByRole('button', { name: 'Close contents' })).toBeTruthy();
    // Bookmarks' own "Bookmark this page" affordance is gone once Contents took over the panel.
    expect(screen.queryByRole('button', { name: 'Bookmark this page' })).toBeNull();

    await fireEvent.press(
      screen.getByRole('button', { name: 'Search this title', includeHiddenElements: true }),
    );
    expect(screen.queryByTestId('reader-toc-list')).toBeNull();
  });

  describe('renaming a bookmark', () => {
    // A rename is ONE update-in-place write, not a composed create-then-delete. These tests pin the
    // two things that distinguishes: neither add call-site is touched, and the row keeps its id —
    // which is what lets the panel's ordering and the corner badge survive a rename untouched.
    it('renames in place by id, without touching either add call-site', async () => {
      jest.mocked(loadBookmarks).mockResolvedValue({
        bookmarks: [
          bookmark({
            id: 'old',
            label: 'Untitled',
            target: { kind: 'href', href: 'epubcfi(/6/10)' },
          }),
        ],
        skippedIds: [],
      });
      jest.mocked(renameBookmark).mockResolvedValue({
        bookmarks: [
          bookmark({
            id: 'old',
            label: 'Renamed',
            target: { kind: 'href', href: 'epubcfi(/6/10)' },
          }),
        ],
        skippedIds: [],
      });
      await mountReader();
      await deliver({ type: 'rendered' });
      await openBookmarks();

      await fireEvent.press(screen.getByRole('button', { name: 'Edit bookmark: Untitled' }));
      await fireEvent.changeText(screen.getByTestId('reader-bookmark-edit-input-old'), 'Renamed');
      await fireEvent.press(screen.getByRole('button', { name: 'Save bookmark name: Untitled' }));

      expect(renameBookmark).toHaveBeenCalledWith('test-book', 'old', 'Renamed');
      expect(addCurrentEpubBookmark).not.toHaveBeenCalled();
      expect(removeBookmark).not.toHaveBeenCalled();
      await screen.findByText('Renamed');
      expect(screen.queryByText('Untitled')).toBeNull();
    });

    it('keeps the id, so the renamed row is the same row', async () => {
      // The behavioural win over the old create-then-delete stand-in, and the reason it matters
      // here rather than only in readerBookmarks.test.ts: the panel keys its edit input on the id,
      // so a rename that minted a new one would leave `reader-bookmark-edit-input-old` addressing
      // a row that no longer exists.
      jest.mocked(loadBookmarks).mockResolvedValue({
        bookmarks: [bookmark({ id: 'old', label: 'Untitled' })],
        skippedIds: [],
      });
      jest.mocked(renameBookmark).mockResolvedValue({
        bookmarks: [bookmark({ id: 'old', label: 'Renamed' })],
        skippedIds: [],
      });
      await mountReader();
      await deliver({ type: 'rendered' });
      await openBookmarks();

      await fireEvent.press(screen.getByRole('button', { name: 'Edit bookmark: Untitled' }));
      await fireEvent.changeText(screen.getByTestId('reader-bookmark-edit-input-old'), 'Renamed');
      await fireEvent.press(screen.getByRole('button', { name: 'Save bookmark name: Untitled' }));

      await screen.findByText('Renamed');
      // Same id, so the row is editable again straight away under its new label.
      await fireEvent.press(screen.getByRole('button', { name: 'Edit bookmark: Renamed' }));
      expect(screen.getByTestId('reader-bookmark-edit-input-old')).toBeTruthy();
    });

    it('takes the identical path for a PDF bookmark — there is no per-format rename', async () => {
      // A page-shaped bookmark only survives `bookmarksForOpenBook`'s format filter for a PDF book.
      jest.mocked(prepareBook).mockResolvedValue('PDF');
      jest.mocked(getReaderHtmlUri).mockResolvedValue('file:///reader-pdf.html');
      jest.mocked(getBookBase64).mockResolvedValue('JVBERi0xLjQK');
      jest.mocked(loadBookmarks).mockResolvedValue({
        bookmarks: [bookmark({ id: 'old', label: 'Page 7', target: { kind: 'page', page: 7 } })],
        skippedIds: [],
      });
      jest.mocked(renameBookmark).mockResolvedValue({
        bookmarks: [
          bookmark({ id: 'old', label: 'Turning point', target: { kind: 'page', page: 7 } }),
        ],
        skippedIds: [],
      });
      await mountReader();
      await deliver({ type: 'rendered' });
      await openBookmarks();

      await fireEvent.press(screen.getByRole('button', { name: 'Edit bookmark: Page 7' }));
      await fireEvent.changeText(
        screen.getByTestId('reader-bookmark-edit-input-old'),
        'Turning point',
      );
      await fireEvent.press(screen.getByRole('button', { name: 'Save bookmark name: Page 7' }));

      expect(renameBookmark).toHaveBeenCalledWith('test-book', 'old', 'Turning point');
      expect(addCurrentPdfBookmark).not.toHaveBeenCalled();
      await screen.findByText('Turning point');
    });

    it('discards the edit on Cancel without writing anything', async () => {
      jest.mocked(loadBookmarks).mockResolvedValue({
        bookmarks: [bookmark({ id: 'a', label: 'Original' })],
        skippedIds: [],
      });
      await mountReader();
      await deliver({ type: 'rendered' });
      await openBookmarks();

      await fireEvent.press(screen.getByRole('button', { name: 'Edit bookmark: Original' }));
      await fireEvent.changeText(
        screen.getByTestId('reader-bookmark-edit-input-a'),
        'Changed my mind',
      );
      await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));

      expect(renameBookmark).not.toHaveBeenCalled();
      expect(screen.getByText('Original')).toBeTruthy();
      expect(screen.queryByTestId('reader-bookmark-edit-input-a')).toBeNull();
    });

    it('clearing the field back to blank resets to the fallback label, not a literal empty name', async () => {
      // The panel reports a cleared field as `undefined`; ReaderScreen forwards it as `''`, which
      // `labelFor` (readerBookmarks.ts) reads as absent and replaces with the chapter id or
      // "Bookmark"/"Page N". Passing `undefined` straight through is not an option — the facade's
      // `name` is a required string.
      jest.mocked(loadBookmarks).mockResolvedValue({
        bookmarks: [bookmark({ id: 'a', label: 'Custom name' })],
        skippedIds: [],
      });
      await mountReader();
      await deliver({ type: 'rendered' });
      await openBookmarks();

      await fireEvent.press(screen.getByRole('button', { name: 'Edit bookmark: Custom name' }));
      await fireEvent.changeText(screen.getByTestId('reader-bookmark-edit-input-a'), '   ');
      await fireEvent.press(screen.getByRole('button', { name: 'Save bookmark name: Custom name' }));

      expect(renameBookmark).toHaveBeenCalledWith('test-book', 'a', '');
    });
  });

  describe("filtering by the open book's format", () => {
    // A GUARD, NOT A MITIGATION, since bookmarks became per-book — see `bookmarksForOpenBook`'s own
    // note in ReaderScreen.tsx. `loadBookmarks(bookId)` already returns only the open book's rows,
    // so a wrong-kind bookmark cannot reach the panel in practice; these tests pin that the filter
    // still catches one if the store's `bookId` default ever silently comes back. A same-format
    // cross-book leak (two different EPUBs) is what it cannot catch, then as now.
    it('hides page-shaped (PDF) bookmarks while an EPUB is open', async () => {
      jest.mocked(loadBookmarks).mockResolvedValue({
        bookmarks: [
          bookmark({
            id: 'epub-1',
            label: 'Epub spot',
            target: { kind: 'href', href: 'epubcfi(/6/10)' },
          }),
          bookmark({ id: 'pdf-1', label: 'Foreign PDF page', target: { kind: 'page', page: 3 } }),
        ],
        skippedIds: [],
      });
      await mountReader(); // defaults to EPUB, per this describe's beforeEach
      await deliver({ type: 'rendered' });
      await openBookmarks();

      expect(screen.getByText('Epub spot')).toBeTruthy();
      expect(screen.queryByText('Foreign PDF page')).toBeNull();
    });

    it('hides href-shaped (EPUB) bookmarks while a PDF is open', async () => {
      jest.mocked(prepareBook).mockResolvedValue('PDF');
      jest.mocked(getReaderHtmlUri).mockResolvedValue('file:///reader-pdf.html');
      jest.mocked(getBookBase64).mockResolvedValue('JVBERi0xLjQK');
      jest.mocked(loadBookmarks).mockResolvedValue({
        bookmarks: [
          bookmark({ id: 'pdf-1', label: 'Pdf spot', target: { kind: 'page', page: 3 } }),
          bookmark({
            id: 'epub-1',
            label: 'Foreign EPUB spot',
            target: { kind: 'href', href: 'epubcfi(/6/10)' },
          }),
        ],
        skippedIds: [],
      });
      await mountReader();
      await deliver({ type: 'rendered' });
      await openBookmarks();

      expect(screen.getByText('Pdf spot')).toBeTruthy();
      expect(screen.queryByText('Foreign EPUB spot')).toBeNull();
    });
  });

  describe('the toolbar bookmark icon', () => {
    // The corner badge that used to carry this signal is REMOVED (2026-09-16) — see
    // READER_BOOKMARKS_WIRING.md item 7. The toolbar's own Bookmarks icon now carries it instead:
    // filled, in the brand blue, exactly when `isCurrentPositionBookmarked` is true.
    //
    // RNTL v14 only renders host elements (no `UNSAFE_getByType`), and `name`/`color` never reach
    // the underlying `Text` node as their own props — Ionicons resolves `name` to a private-use-area
    // glyph character and folds `color` into `style` before spreading onto `Text`. So icon IDENTITY
    // is asserted by the rendered glyph text (via Ionicons' own `getRawGlyphMap`), and icon COLOUR by
    // the flattened style, rather than by inspecting `props.name`/`props.color` directly.
    function glyphFor(name: 'bookmark' | 'bookmark-outline'): string {
      const glyph = Ionicons.getRawGlyphMap()[name];
      return typeof glyph === 'number' ? String.fromCodePoint(glyph) : String(glyph);
    }

    function bookmarksButton() {
      return within(screen.getByRole('button', { name: 'Bookmarks' }));
    }

    it("is outline in white (the toolbar's own colour) when the current position is not bookmarked", async () => {
      await mountReader();
      await deliver({ type: 'rendered' });

      const icon = bookmarksButton().getByText(glyphFor('bookmark-outline'));
      expect(StyleSheet.flatten(icon.props.style).color).toBe(color.white);
    });

    it('fills in, in blue, once the current position matches a stored bookmark', async () => {
      jest.mocked(loadBookmarks).mockResolvedValue({
        bookmarks: [bookmark({ target: { kind: 'href', href: 'epubcfi(/6/10)' } })],
        skippedIds: [],
      });
      await mountReader();
      await deliver({ type: 'rendered' });
      await relocateCfi('epubcfi(/6/10)');

      const icon = bookmarksButton().getByText(glyphFor('bookmark'));
      expect(StyleSheet.flatten(icon.props.style).color).toBe(color.primary);
    });

    it('reverts to outline when a pulled change removes the matching bookmark, with no reopen', async () => {
      // Replaces the deleted badge's own version of this test — the reload path
      // (`subscribeToBookmarkChanges`) is unchanged, only what renders off its result moved.
      let pulledChangeListener: (() => void) | undefined;
      jest.mocked(subscribeToBookmarkChanges).mockImplementation((listener) => {
        pulledChangeListener = listener;
        return () => {
          pulledChangeListener = undefined;
        };
      });

      jest.mocked(loadBookmarks).mockResolvedValueOnce({
        bookmarks: [bookmark({ target: { kind: 'href', href: 'epubcfi(/6/10)' } })],
        skippedIds: [],
      });
      await mountReader();
      await deliver({ type: 'rendered' });
      await relocateCfi('epubcfi(/6/10)');

      expect(bookmarksButton().getByText(glyphFor('bookmark'))).toBeTruthy();

      jest.mocked(loadBookmarks).mockResolvedValueOnce({ bookmarks: [], skippedIds: [] });
      await act(async () => {
        pulledChangeListener?.();
        await Promise.resolve();
      });

      expect(bookmarksButton().getByText(glyphFor('bookmark-outline'))).toBeTruthy();

      jest.mocked(subscribeToBookmarkChanges).mockReset().mockReturnValue(() => {});
    });
  });
});

describe('TTS is driven by the preference, not by a button in the reader', () => {
  // `useTtsEnabled` seeds from readSharedPrefs then tracks `prefsStore.subscribe`. This file
  // already mocks the store with a live listener set (`__emitPrefsChange`), so a change here drives
  // the real hook exactly as the preferences menu's toggle does on device.
  // This file never clears mocks globally, so `addListener.mock.calls` otherwise accumulates every
  // session every earlier test mounted — and `startSpeaking` below picks the newest `tts-start`
  // handler out of it. Without this the helper reaches a handler belonging to a long-unmounted
  // session, which is inert, and the cue never appears. Scoped to this block rather than made
  // global: a blanket clearAllMocks here would wipe the module-level defaults the rest of the file
  // sets up once.
  beforeEach(() => {
    // EXPLICIT, because this file never clears mocks between tests and several earlier ones leave
    // `prepareBook` resolving 'PDF'. TTS is EPUB-only, so an inherited PDF silently means no
    // transport and every assertion below fails for the wrong reason. Same convention the rest of
    // the file follows — whoever needs a format states it.
    jest.mocked(prepareBook).mockResolvedValue('EPUB');
    jest.mocked(getBookBase64).mockResolvedValue('UEsDBA==');

    // `addListener.mock.calls` likewise accumulates every session every earlier test mounted, and
    // `startSpeaking` below picks the newest `tts-start` handler out of it. Stale handlers belong
    // to unmounted sessions and are inert, so the cue would never appear.
    const engine = jest.requireMock('@/features/accessibility/tts/ttsEngine') as {
      default: { addListener: jest.Mock; speak: jest.Mock };
    };
    engine.default.addListener.mockClear();
    engine.default.speak.mockClear();
  });

  function ttsPrefs(enabled: boolean): SharedPrefs {
    const prefs = makePrefs();
    prefs.accessibility.tts.enabled = enabled;
    return prefs;
  }

  async function setTtsPref(enabled: boolean): Promise<void> {
    await act(async () => {
      __emitPrefsChange(ttsPrefs(enabled));
    });
  }

  function navRowShowing(): boolean {
    return screen.queryByRole('button', { name: 'Next page' }) !== null;
  }

  /** The `requestId` the provider just put on the wire, read back out of the injected script. */
  function lastRequestId(): number {
    const calls = __injectJavaScript.mock.calls;
    for (let i = calls.length - 1; i >= 0; i -= 1) {
      // The payload is a JSON object literal in the injected script, not a bare argument —
      // `window.TFReader.requestTtsSentence({"requestId":1,...})`. See buildCommandScript.
      const match = /requestTtsSentence\(\{"requestId":(\d+)/.exec(String(calls[i][0]));
      if (match) return Number(match[1]);
    }
    throw new Error('no requestTtsSentence command was sent');
  }

  /** Drive the session all the way to 'speaking', which is what the on-page cue is gated on. */
  async function startSpeaking(): Promise<void> {
    await fireEvent.press(screen.getByRole('button', { name: 'Play' }));
    await deliver({
      type: 'ttsSentence',
      requestId: lastRequestId(),
      result: {
        status: 'ok',
        sentence: {
          text: 'The grey wolf moved through the trees.',
          cfi: 'epubcfi(/6/4[chap01]!/4/2,/1:0,/1:37)',
          spineIndex: 0,
          sentenceIndex: 0,
          lastInSection: false,
        },
      },
    });
    // The engine's tts-start event is what flips the session to 'speaking' — the session is
    // event-driven rather than action-driven on purpose (see useTtsSession's header).
    // Let the session's fetch -> speak chain settle: resolving the bridge reply is one microtask,
    // the session's await continuation another, and Tts.speak is called from the second.
    await act(async () => {
      await Promise.resolve();
    });
    const ttsEngine = (
      jest.requireMock('@/features/accessibility/tts/ttsEngine') as {
        default: { addListener: jest.Mock };
      }
    ).default;
    // EXACTLY ONE, and asserting that is the point. `useTtsSession` used to be handed an inert
    // stand-in provider before the real one existed, so it built a whole session that could never
    // speak and then a second one — leaving two `tts-start` handlers, of which the first was dead.
    // It now takes null and does nothing until there is a real provider.
    const starts = ttsEngine.addListener.mock.calls.filter(
      (call: unknown[]) => call[0] === 'tts-start',
    );
    expect(starts).toHaveLength(1);
    const start = starts[0];
    await act(async () => {
      (start[1] as () => void)();
    });
  }

  it('shows the transport as soon as the preference goes on, with no button press', async () => {
    await mountReader();
    await reportReady();

    expect(screen.queryByTestId('tts-speed-row')).toBeNull();
    expect(navRowShowing()).toBe(true);

    await setTtsPref(true);

    expect(screen.getByTestId('tts-speed-row')).toBeTruthy();
    expect(navRowShowing()).toBe(false);
  });

  it('wires the REAL EPUB provider, so Play goes out over the bridge as requestTtsSentence', async () => {
    // The chain this pins, end to end: prefsStore notifies -> useTtsEnabled flips -> ReaderScreen's
    // ttsProvider memo calls createEpubReaderTextProvider(bookId, send) -> useTtsSession drives it.
    // A wrong link anywhere here (the fake provider, a stale `send`, the old inert stand-in) still
    // renders a working-looking transport whose Play button does nothing observable, so asserting
    // the command actually reaches the WebView is what makes the wiring falsifiable.
    await mountReader();
    await reportReady();
    await setTtsPref(true);
    __injectJavaScript.mockClear();

    await fireEvent.press(screen.getByRole('button', { name: 'Play' }));

    const script = String(__injectJavaScript.mock.calls.at(-1)?.[0]);
    expect(script).toContain('window.TFReader.requestTtsSentence(');
    // `from: null` + `mode: 'current'` is `current(null)` — "start from wherever the reader is",
    // which is what play() from idle means. Anything else would be resuming from a stale anchor.
    expect(script).toContain('"from":null');
    expect(script).toContain('"mode":"current"');
  });

  it('has no speaker button in the toolbar — the preference is the only switch', async () => {
    await mountReader();
    await reportReady();
    await setTtsPref(true);

    expect(screen.queryByRole('button', { name: 'Listen to this book' })).toBeNull();
  });

  it('takes the transport away and restores the navigation row when the preference goes off', async () => {
    await mountReader();
    await reportReady();
    await setTtsPref(true);
    expect(screen.getByTestId('tts-speed-row')).toBeTruthy();

    await setTtsPref(false);

    expect(screen.queryByTestId('tts-speed-row')).toBeNull();
    expect(navRowShowing()).toBe(true);
  });

  it('never mounts the transport for a PDF, however the preference is set', async () => {
    // The seam is CFI-based; a PDF has no CFI to segment against.
    jest.mocked(prepareBook).mockResolvedValue('PDF');
    jest.mocked(getBookBase64).mockResolvedValue('JVBERi0xLjQK');

    await mountReader();
    await reportReady();
    await setTtsPref(true);

    expect(screen.queryByTestId('tts-speed-row')).toBeNull();
    expect(navRowShowing()).toBe(true);
  });

  describe('the on-page "reading aloud" cue', () => {
    it('appears only while speech is actually playing', async () => {
      await mountReader();
      await reportReady();
      await setTtsPref(true);

      // Enabled but idle: the transport is up, nothing is being read.
      expect(screen.queryByTestId('reader-tts-cue')).toBeNull();

      await startSpeaking();

      expect(screen.getByTestId('reader-tts-cue')).toBeTruthy();
    });

    it('is inert — a visual cue, not a control', async () => {
      await mountReader();
      await reportReady();
      await setTtsPref(true);
      await startSpeaking();

      const cue = screen.getByTestId('reader-tts-cue');
      // No press handlers at all, and pointer events off, so it cannot eat a swipe meant for the
      // page underneath it.
      expect(cue.props.onPress).toBeUndefined();
      expect(cue.props.onLongPress).toBeUndefined();
      expect(cue.props.pointerEvents).toBe('none');
      expect(cue.props.accessibilityRole).toBe('image');
    });
  });

  describe('page turns while TTS is running', () => {
    it('leaves the book reachable to touch — the transport replaces the row, so swipe is the way on', async () => {
      await mountReader();
      await reportReady();
      await deliver({ type: 'rendered' });
      await setTtsPref(true);
      await startSpeaking();

      // The button row is gone by design, so swipe is the page-turn affordance while listening.
      //
      // WHAT THIS ASSERTS CHANGED WHEN SWIPE MOVED INTO THE WEBVIEW. It used to find
      // `reader-swipe-catcher` — the RN overlay that recognised the swipe — and its point was that
      // the transport being up must not suppress it (an earlier version gated `swipeEnabled` on the
      // TTS flag alongside the real overlays, which are the only things that legitimately suppress
      // page turns). The gesture is recognised inside the document now, so the equivalent claim is
      // that nothing is covering the book and the WebView is still mounted and reachable: an
      // overlay here, or a `hidden` WebView, would swallow the swipe exactly as the old flag did.
      const webView = screen.getByTestId('reader-webview', { includeHiddenElements: true });
      expect(webView).toBeTruthy();
      expect(
        screen.queryByTestId('reader-swipe-catcher', { includeHiddenElements: true }),
      ).toBeNull();
    });

    it('clears the spoken highlight on a page turn without silencing the cue', async () => {
      // `notifyRelocated` clears the highlight and fires 'navigated', which is NOT a teardown —
      // speech continues. The cue tracks the session, so it stays up, which is the honest report:
      // the book is still being read aloud even though the reader has moved.
      await mountReader();
      await reportReady();
      await setTtsPref(true);
      await startSpeaking();
      __injectJavaScript.mockClear();

      await deliver({
        type: 'relocated',
        position: { kind: 'cfi', cfi: 'epubcfi(/6/4[chap01]!/4/8/2)' },
        atStart: false,
        atEnd: false,
      });

      expect(screen.getByTestId('reader-tts-cue')).toBeTruthy();
      // notifyRelocated() really did fire for this genuine page turn — confirmed by its own visible
      // effect (setSpokenRange(null) clearing the highlight), not just inferred from the cue.
      const scripts = __injectJavaScript.mock.calls.map((call) => String(call[0]));
      expect(scripts.some((script) => script.includes('setSpokenRange'))).toBe(true);
    });

    it('does NOT clear the highlight or interrupt TTS for an internal reposition (auto-follow, a reflow reanchor, a flow rebuild)', async () => {
      // The bug this guards against, found on-device: TTS auto-follow's own rendition.display()/
      // scrollBy() calls fire a genuine `relocated` event too. Before `internalReposition` existed,
      // ReaderScreen.tsx could not tell that apart from a real page turn — notifyRelocated() ran
      // unconditionally, clearing the highlight it had just centered on screen and wiping the
      // session's prefetched next sentence, which silently stopped TTS the moment the current
      // (auto-follow-triggered) sentence finished speaking. A relocated message the WebView marks
      // `internalReposition: true` must not reach notifyRelocated() at all.
      await mountReader();
      await reportReady();
      await setTtsPref(true);
      await startSpeaking();
      __injectJavaScript.mockClear();

      await deliver({
        type: 'relocated',
        position: { kind: 'cfi', cfi: 'epubcfi(/6/4[chap01]!/4/8/2)' },
        atStart: false,
        atEnd: false,
        internalReposition: true,
      });

      expect(screen.getByTestId('reader-tts-cue')).toBeTruthy();
      const scripts = __injectJavaScript.mock.calls.map((call) => String(call[0]));
      expect(scripts.some((script) => script.includes('setSpokenRange'))).toBe(false);
    });

    it('tells the WebView to lock manual scroll the moment speech starts, and unlock it when it stops', async () => {
      // The reader must not be able to fight auto-follow with a raw swipe/drag while TTS speaks —
      // see setTtsSpeaking's own doc comment in readerBridge.ts for scope (gestures only).
      await mountReader();
      await reportReady();
      await deliver({ type: 'rendered' });
      await setTtsPref(true);
      __injectJavaScript.mockClear();

      await startSpeaking();

      const scriptsWhileSpeaking = __injectJavaScript.mock.calls.map((call) => String(call[0]));
      expect(
        scriptsWhileSpeaking.some((script) => script.includes('setTtsSpeaking(true)')),
      ).toBe(true);
      __injectJavaScript.mockClear();

      await fireEvent.press(screen.getByRole('button', { name: 'Pause' }));
      // pause() is event-driven, same as startSpeaking()'s tts-start above — status only actually
      // moves to 'paused' once the native (or Android stop-and-remember) tts-pause event arrives.
      const ttsEngine = (
        jest.requireMock('@/features/accessibility/tts/ttsEngine') as {
          default: { addListener: jest.Mock };
        }
      ).default;
      const pauseHandler = ttsEngine.addListener.mock.calls
        .filter((call: unknown[]) => call[0] === 'tts-pause')
        .at(-1)?.[1] as (() => void) | undefined;
      if (pauseHandler) {
        await act(async () => {
          pauseHandler();
        });
      }

      const scriptsAfterPause = __injectJavaScript.mock.calls.map((call) => String(call[0]));
      expect(
        scriptsAfterPause.some((script) => script.includes('setTtsSpeaking(false)')),
      ).toBe(true);
    });
  });

  describe('nothing announces over the read-aloud', () => {
    it('suppresses a settings announcement while a sentence is being spoken', async () => {
      // react-native-tts and the screen reader share one output device and neither ducks for the
      // other, so an announcement lands ON TOP of the sentence being read. `SearchMatchBar.tsx`
      // already declines a live region in writing for this exact reason.
      //
      // A SETTINGS CHANGE IS THE CASE THAT CAN ACTUALLY HAPPEN HERE. TTS is EPUB-only
      // (`ttsProvider` requires it), and a reflowable EPUB announces no page number at all — so
      // there is no page announcement to collide with today. The collision that matters is the
      // chapter announcement, which is EPUB's unit; this test covers the same gate through the one
      // path that is reachable now.
      const spoken = jest
        .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
        .mockImplementation(() => undefined);

      await mountReader();
      await reportReady();
      await setTtsPref(true);
      await startSpeaking();
      spoken.mockClear();

      const dark = ttsPrefs(true);
      dark.theme = 'dark';
      __emitPrefsChange(dark);
      await act(async () => {
        await Promise.resolve();
      });

      expect(spoken).not.toHaveBeenCalled();
      spoken.mockRestore();
    });
  });
});

describe('screen-reader focus order', () => {
  // `setAccessibilityFocus` is a native call with no observable effect in jsdom, so it is spied on
  // rather than mocked wholesale — the rest of AccessibilityInfo (useAppearanceEnv reads
  // isReduceMotionEnabled) has to keep working.
  // `focusOn` IS MOCKED, not driven through to AccessibilityInfo, and that is the right seam for
  // these tests. There is no native view tree under Jest, so the real `findNodeHandle` returns null
  // for every test instance and `focusOn` would correctly no-op on all of them — every assertion
  // here would pass for the wrong reason. What ReaderScreen owns is the DECISION (restore focus
  // after a TOC row, not after Search opens); the native mechanics are `a11yFocus.test.ts`'s.
  const focusOnMock = jest.mocked(focusOn);

  beforeEach(() => {
    jest.mocked(prepareBook).mockResolvedValue('EPUB');
    jest.mocked(getBookBase64).mockResolvedValue('UEsDBA==');
    focusOnMock.mockClear();
  });

  // Local copies: the search block's own `openSearch`/`runSearch`/`epubHit` are scoped to that
  // describe. Kept minimal — this block cares about focus and reachability, not about search.
  async function openSearchPanel(): Promise<void> {
    await fireEvent.press(
      screen.getByRole('button', { name: 'Search this title', includeHiddenElements: true }),
    );
  }

  function oneHit(): SearchHit {
    return {
      bookId: 'test-book',
      chapterId: 'ch1',
      locator: { type: 'EPUB', cfi: 'epubcfi(/6/2[ch1]!/4/4/1:1)' },
      snippet: '…the grey wolf moved…',
    };
  }

  function twoHits(): SearchHit[] {
    return [
      oneHit(),
      {
        bookId: 'test-book',
        chapterId: 'ch1',
        locator: { type: 'EPUB', cfi: 'epubcfi(/6/2[ch1]!/4/4/2:1)' },
        snippet: '…a second wolf appeared…',
      },
    ];
  }

  describe('toggle buttons report expanded state', () => {
    it('Search reports collapsed, then expanded, then collapsed again', async () => {
      await mountReader();
      const search = (): ReturnType<typeof screen.getByRole> =>
        screen.getByRole('button', { name: 'Search this title', includeHiddenElements: true });

      expect(search().props.accessibilityState).toMatchObject({ expanded: false });
      await openSearchPanel();
      expect(search().props.accessibilityState).toMatchObject({ expanded: true });
      await fireEvent.press(screen.getByRole('button', { name: 'Close search' }));
      expect(search().props.accessibilityState).toMatchObject({ expanded: false });
    });

    it('Bookmarks reports collapsed, then expanded', async () => {
      await mountReader();
      const bookmarks = (): ReturnType<typeof screen.getByRole> =>
        screen.getByRole('button', { name: 'Bookmarks', includeHiddenElements: true });

      expect(bookmarks().props.accessibilityState).toMatchObject({ expanded: false });
      await fireEvent.press(bookmarks());
      expect(bookmarks().props.accessibilityState).toMatchObject({ expanded: true });
    });
  });

  describe('the background leaves the focus order while a panel covers it', () => {
    function hiddenFlags(testID: string): { hidden: unknown; important: unknown } {
      const node = screen.getByTestId(testID, { includeHiddenElements: true });
      return {
        hidden: node.props.accessibilityElementsHidden,
        important: node.props.importantForAccessibility,
      };
    }

    it('leaves the book reachable when no panel is open', async () => {
      await mountReader();
      await reportReady();

      expect(hiddenFlags('reader-webview-container')).toEqual({
        hidden: false,
        important: 'yes',
      });
    });

    it('hides the book behind an open panel', async () => {
      await mountReader();
      await reportReady();
      await deliver({ type: 'toc', items: flatToc(3) });
      await openContents();

      expect(hiddenFlags('reader-webview-container')).toEqual({
        hidden: true,
        important: 'no-hide-descendants',
      });
    });

    it('keeps the Contents button reachable while the TOC is open — it is the way out', async () => {
      // THE ONE ASYMMETRY, and it is deliberate. Search and Bookmarks each close from a button
      // inside their own panel, so the bottom row behind them is background. Contents does not: the
      // button in that row IS its close affordance. Hiding the row with everything else left a
      // screen-reader user inside the TOC with no reachable way out.
      await mountReader();
      await reportReady();
      await deliver({ type: 'toc', items: flatToc(3) });
      await openContents();

      expect(screen.getByRole('button', { name: 'Close contents' })).toBeTruthy();
    });

    it('hides the bottom row behind Search, which carries its own close', async () => {
      await mountReader();
      await reportReady();
      await deliver({ type: 'toc', items: flatToc(3) });
      await openSearchPanel();

      expect(screen.queryByRole('button', { name: 'Contents' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Close search' })).toBeTruthy();
    });

    it('hides the decorative TOC fades from assistive tech', async () => {
      await mountReader();
      await reportReady();
      await deliver({ type: 'toc', items: flatToc(40) });
      await openContents();
      const list = screen.getByTestId('reader-toc-list');
      await fireEvent(list, 'layout', { nativeEvent: { layout: { height: 100 } } });
      await fireEvent(list, 'contentSizeChange', 0, 900);

      expect(hiddenFlags('reader-toc-fade-bottom')).toEqual({
        hidden: true,
        important: 'no-hide-descendants',
      });
    });
  });

  describe('focus entry', () => {
    // WHAT THESE CAN AND CANNOT SEE. `focusOn` is mocked (see the note at the top of this block), so
    // there is no way to ask "did the first row get focus" directly — under react-test-renderer a
    // host ref's `current` stays null anyway. What IS observable is the ref OBJECT each call was
    // handed, and that is enough to pin the two decisions this code actually makes: the panel's
    // entry target is not the button focus is restored to, and it is stable across reopens.

    // Not `openContents()` again: it is the same Pressable, but its accessible name flips to
    // "Close contents" while the panel is open (so a screen reader announces what the press will
    // actually do), and the shared helper queries by the open-state name.
    async function closeContents(): Promise<void> {
      await fireEvent.press(
        screen.getByRole('button', { name: 'Close contents', includeHiddenElements: true }),
      );
    }

    it('moves focus into the panel when Contents opens', async () => {
      await mountReader();
      await reportReady();
      await deliver({ type: 'toc', items: flatToc(3) });

      await openContents();

      expect(focusOnMock).toHaveBeenCalledTimes(1);
    });

    it('sends it somewhere other than the button focus is restored to', async () => {
      // Entry and restore are opposite ends of the same journey; if they resolved to the same ref
      // the panel would "open" with the cursor still outside it, which is the defect item 2 names.
      await mountReader();
      await reportReady();
      await deliver({ type: 'toc', items: flatToc(3) });

      await openContents(); // entry
      await fireEvent.press(screen.getByText('Chapter 2')); // restore, via the row's own onPress

      expect(focusOnMock).toHaveBeenCalledTimes(2);
      expect(focusOnMock.mock.calls[0][0]).not.toBe(focusOnMock.mock.calls[1][0]);
    });

    it('enters the same target every time the panel is reopened', async () => {
      // The ref is attached to the row at index 0 only. Sharing one ref across the whole `map` would
      // leave it holding whichever row mounted last, so this would drift with the chapter count —
      // 40 rows here rather than the 3 the case above uses, for exactly that reason.
      await mountReader();
      await reportReady();
      await deliver({ type: 'toc', items: flatToc(40) });

      await openContents();
      await closeContents(); // the toggle's own close — focus is already on it, so it moves nothing
      await openContents();

      expect(focusOnMock).toHaveBeenCalledTimes(2);
      expect(focusOnMock.mock.calls[0][0]).toBe(focusOnMock.mock.calls[1][0]);
    });

    it('does not move focus when the panel is closed from the Contents toggle', async () => {
      await mountReader();
      await reportReady();
      await deliver({ type: 'toc', items: flatToc(3) });
      await openContents();
      focusOnMock.mockClear();

      await closeContents(); // same button, now labelled "Close contents" — this is the close

      expect(focusOnMock).not.toHaveBeenCalled();
    });

    it('does not re-enter when a fresh outline lands while the panel is open', async () => {
      // The effect is keyed on `showToc` ALONE. Adding `toc` to its deps would re-fire here and yank
      // a reader who has already scrolled the list back to its first row.
      await mountReader();
      await reportReady();
      await deliver({ type: 'toc', items: flatToc(3) });
      await openContents();
      focusOnMock.mockClear();

      await deliver({ type: 'toc', items: flatToc(6) });

      expect(focusOnMock).not.toHaveBeenCalled();
    });

    it('never enters an empty panel, because an empty TOC cannot be opened', async () => {
      // The premise behind having ONE entry ref rather than a second for the empty-state `Text` the
      // handoff spec also names. No `toc` message here, so the button is disabled and the press is
      // inert — the empty branch is unreachable, not merely unlikely. The disabled state itself is
      // pinned separately, by "the Contents button reports disabled with no outline".
      await mountReader();
      await reportReady();

      await openContents();

      expect(screen.queryByTestId('reader-toc-list')).toBeNull();
      expect(focusOnMock).not.toHaveBeenCalled();
    });

    it('does not enter the TOC when a different panel is what opened', async () => {
      await mountReader();
      await reportReady();
      await deliver({ type: 'toc', items: flatToc(3) });

      await openSearchPanel();

      // Search brings its own entry focus (`autoFocus` on its field), so nothing here should fire.
      expect(focusOnMock).not.toHaveBeenCalled();
    });
  });

  describe('focus restoration', () => {
    it('returns focus to Contents when a TOC row is chosen', async () => {
      await mountReader();
      await reportReady();
      await deliver({ type: 'toc', items: flatToc(3) });
      await openContents();
      focusOnMock.mockClear();

      await fireEvent.press(screen.getByText('Chapter 2'));

      expect(focusOnMock).toHaveBeenCalledTimes(1);
    });

    it('does NOT move focus when the TOC closes because Search is opening', async () => {
      // Search does its own entry focus (`autoFocus` on its field). Restoring to Contents here
      // would race it and pull the user back out of the field they just landed in.
      await mountReader();
      await reportReady();
      await deliver({ type: 'toc', items: flatToc(3) });
      await openContents();
      focusOnMock.mockClear();

      await openSearchPanel();

      expect(focusOnMock).not.toHaveBeenCalled();
    });

    it('does NOT move focus when the TOC closes because Bookmarks is opening', async () => {
      await mountReader();
      await reportReady();
      await deliver({ type: 'toc', items: flatToc(3) });
      await openContents();
      focusOnMock.mockClear();

      await fireEvent.press(
        screen.getByRole('button', { name: 'Bookmarks', includeHiddenElements: true }),
      );

      expect(focusOnMock).not.toHaveBeenCalled();
    });

    it('returns focus to the Search button when the panel is closed explicitly', async () => {
      await mountReader();
      await reportReady();
      await openSearchPanel();
      focusOnMock.mockClear();

      await fireEvent.press(screen.getByRole('button', { name: 'Close search' }));

      expect(focusOnMock).toHaveBeenCalledTimes(1);
    });

    it('moves focus to the match bar, not back to Search, when a result is selected', async () => {
      // Selecting a result closes the panel too, but the user's journey ends at the book, not back
      // at the toolbar — item 6 of READER_FOCUS_ORDER_HANDOFF.md.
      jest.mocked(queryBookIndex).mockResolvedValue([oneHit()]);
      await mountReader();
      await reportReady();
      await openSearchPanel();
      await fireEvent.changeText(screen.getByTestId('reader-search-input'), 'wolf');
      await fireEvent.press(screen.getByRole('button', { name: 'Search' }));
      focusOnMock.mockClear();

      await fireEvent.press(screen.getByRole('button', { name: /^Result 1 of 1:/ }));

      expect(focusOnMock).toHaveBeenCalledTimes(1);
      const matchBarRef = focusOnMock.mock.calls[0][0];

      // Not the same ref Search's own explicit-close restores to.
      focusOnMock.mockClear();
      await fireEvent.press(screen.getByRole('button', { name: 'Search this title' }));
      await fireEvent.press(screen.getByRole('button', { name: 'Close search' }));
      expect(focusOnMock.mock.calls[0][0]).not.toBe(matchBarRef);
    });

    it('does NOT move focus again when stepping via the match bar arrows', async () => {
      // `stepHit` reaches the same `selectHit` a results-list tap does, but the match bar is
      // already mounted and the user is already focused on the arrow they just pressed —
      // re-focusing the counter on every step would yank them off it.
      jest.mocked(queryBookIndex).mockResolvedValue(twoHits());
      await mountReader();
      await reportReady();
      await openSearchPanel();
      await fireEvent.changeText(screen.getByTestId('reader-search-input'), 'wolf');
      await fireEvent.press(screen.getByRole('button', { name: 'Search' }));
      await fireEvent.press(screen.getByRole('button', { name: /^Result 1 of 2:/ }));
      focusOnMock.mockClear();

      await fireEvent.press(screen.getByRole('button', { name: 'Next match' }));

      expect(focusOnMock).not.toHaveBeenCalled();
    });

    it('moves focus to the match bar once a queued selection finally resolves', async () => {
      // Tapped before `send` exists — the queued-seek flush effect closes search on the book's
      // behalf, later, and needs the same signal the direct path bumps.
      jest.mocked(queryBookIndex).mockResolvedValue([oneHit()]);
      await mountReader();
      // No reportReady() yet — send is still null.
      await openSearchPanel();
      await fireEvent.changeText(screen.getByTestId('reader-search-input'), 'wolf');
      await fireEvent.press(screen.getByRole('button', { name: 'Search' }));
      await fireEvent.press(screen.getByRole('button', { name: /^Result 1 of 1:/ }));

      expect(focusOnMock).not.toHaveBeenCalled();

      await reportReady();

      expect(focusOnMock).toHaveBeenCalledTimes(1);
    });

    it('does not signal the match bar when Search is closed explicitly with stale hits present', async () => {
      jest.mocked(queryBookIndex).mockResolvedValue([oneHit()]);
      await mountReader();
      await reportReady();
      await openSearchPanel();
      await fireEvent.changeText(screen.getByTestId('reader-search-input'), 'wolf');
      await fireEvent.press(screen.getByRole('button', { name: 'Search' }));
      await fireEvent.press(screen.getByRole('button', { name: /^Result 1 of 1:/ }));
      // Reopen the list from the match bar's own counter, without selecting anything new.
      await fireEvent.press(screen.getByRole('button', { name: /^Match 1 of 1/ }));
      focusOnMock.mockClear();

      await fireEvent.press(screen.getByRole('button', { name: 'Close search' }));

      // Only the toolbar-restore call — not a second one to the match bar.
      expect(focusOnMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe('ReaderScreen highlights', () => {
  const EPUB_HL = {
    id: 'h1',
    startCfi: 'epubcfi(/6/4[chap01]!/4/2/2/1:0)',
    endCfi: 'epubcfi(/6/4[chap01]!/4/2/6/1:10)',
    color: 'yellow',
  };
  const PDF_HL = { id: 'h2', page: 4, startOffset: 10, endOffset: 25, color: 'yellow' };

  function loaded(highlights: Partial<ReaderHighlights>, skippedIds: string[] = []) {
    return { highlights: { epub: [], pdf: [], ...highlights }, skippedIds };
  }

  beforeEach(() => {
    jest.mocked(loadReaderHighlights).mockReset().mockResolvedValue(loaded({}));
    jest.mocked(addEpubHighlight).mockReset().mockResolvedValue(loaded({}));
    jest.mocked(addPdfHighlight).mockReset().mockResolvedValue(loaded({}));
    jest.mocked(removeHighlight).mockReset().mockResolvedValue(loaded({}));
    // Same reasoning as the bookmarks block's: redundant with the file-level reset, kept as the
    // local statement of what these EPUB fixtures need.
    jest.mocked(prepareBook).mockResolvedValue('EPUB');
    __injectJavaScript.mockClear();
  });

  const EPUB_SELECTION = {
    kind: 'cfiRange',
    startCfi: EPUB_HL.startCfi,
    endCfi: EPUB_HL.endCfi,
  };

  /**
   * The reader tapping the native "Highlight" menu item over a selection — WKWebView's own
   * `onCustomMenuSelection`, not a bridge message. `ReaderWebView`'s real handler is what's under
   * test here (the mock only replaces `react-native-webview`'s `WebView`), so this exercises the
   * same code path a real long-press-then-tap does.
   */
  async function requestHighlight(): Promise<void> {
    const webView = screen.getByTestId('reader-webview', { includeHiddenElements: true });
    await act(async () => {
      webView.props.onCustomMenuSelection({
        nativeEvent: { key: 'highlight', label: 'Highlight', selectedText: 'some text' },
      });
    });
  }

  /** Same as `requestHighlight`, for the native "Delete Highlight" item. */
  async function requestDeleteHighlight(): Promise<void> {
    const webView = screen.getByTestId('reader-webview', { includeHiddenElements: true });
    await act(async () => {
      webView.props.onCustomMenuSelection({
        nativeEvent: { key: 'delete-highlight', label: 'Delete Highlight', selectedText: '' },
      });
    });
  }

  /**
   * The shell's reply to `requestCurrentSelection` — what `deliver`s a `selection` message meant
   * NOW, since nothing sends one passively any more (see `ReaderMessage`'s own note). Every arrival
   * is a create instruction, so this alone is enough to drive the store call-sites below; nothing
   * in this file needs to go through `requestHighlight` first to test that half.
   */
  async function replyWithSelection(selection: unknown = EPUB_SELECTION): Promise<void> {
    await deliver({ type: 'selection', selection });
  }

  /**
   * The shell's reply to `confirmDeleteHighlight` — the reader chose "Delete Highlight" for a press
   * that landed on this id. No anchor any more: there is no RN popup left for one to position.
   */
  async function replyHighlightPressed(id: string): Promise<void> {
    await deliver({ type: 'highlightPressed', id });
  }

  async function openBook(format: ContentFormat = 'EPUB'): Promise<void> {
    jest.mocked(prepareBook).mockResolvedValue(format);
    await mountReader();
    await reportReady();
    await deliver({ type: 'rendered' });
  }

  it('does not load until the book has rendered', async () => {
    // Highlights have to be PAINTED, and painting needs a rendition — `paintHighlights` is a no-op
    // in the EPUB shell before openEpub has built one. A sharper version of the bookmarks gate.
    await mountReader();
    await reportReady();

    expect(loadReaderHighlights).not.toHaveBeenCalled();
  });

  it('loads this book and paints what came back, once it renders', async () => {
    jest.mocked(loadReaderHighlights).mockResolvedValue(loaded({ epub: [EPUB_HL] }));
    await openBook();

    expect(loadReaderHighlights).toHaveBeenCalledWith('test-book');
    expect(__injectJavaScript).toHaveBeenLastCalledWith(
      buildCommandScript({ type: 'paintHighlights', highlights: [EPUB_HL] }),
    );
  });

  it('sends the PDF array for a PDF book, which IS the format routing', async () => {
    // `toReaderHighlights` splits the set host-side so no ContentFormat value crosses the bridge;
    // choosing which half to send is what replaces the discriminant. Sending the wrong one would
    // reach a shell that refuses it, so this is the assertion that keeps the split honest.
    jest.mocked(loadReaderHighlights).mockResolvedValue(loaded({ pdf: [PDF_HL] }));
    await openBook('PDF');

    expect(__injectJavaScript).toHaveBeenLastCalledWith(
      buildCommandScript({ type: 'paintHighlights', highlights: [PDF_HL] }),
    );
  });

  it('offers both highlight actions only through the native WebView menu, never an RN popup', async () => {
    // Both creating AND deleting used to be (or, for delete, could have been) a floating RN button.
    // Replaced because an RN view can never reliably win screen space against, or stay reachable
    // under, WKWebView's own native selection callout (always drawn above the whole app). Both are
    // native `menuItems` entries on the WebView itself now (see `ReaderWebView.tsx`).
    await openBook();

    expect(screen.queryByRole('button', { name: 'Highlight' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete highlight' })).toBeNull();
  });

  it('offers "Highlight" by default, and switches to "Delete Highlight" while highlightTouchActive', async () => {
    // Best-effort display only (see `CREATE_MENU_ITEMS`'s own note in ReaderWebView.tsx) — this
    // pins that `ReaderWebView` actually reads the signal and toggles `menuItems`, not that the
    // signal always arrives in time on a real device. `patches/react-native-webview+13.16.1.patch`
    // widens the native long-press timer to give the round trip more margin, but nothing at this
    // layer can pin a native timing race — that is exactly why `requestCurrentSelection`/
    // `confirmDeleteHighlight` re-decide for themselves at tap time regardless of this toggle.
    await openBook();

    const getMenuItems = () =>
      screen.getByTestId('reader-webview', { includeHiddenElements: true }).props.menuItems;

    expect(getMenuItems()).toEqual([{ label: 'Highlight', key: 'highlight' }]);

    await deliver({ type: 'highlightTouchActive', active: true });
    expect(getMenuItems()).toEqual([{ label: 'Delete Highlight', key: 'delete-highlight' }]);

    await deliver({ type: 'highlightTouchActive', active: false });
    expect(getMenuItems()).toEqual([{ label: 'Highlight', key: 'highlight' }]);
  });

  it('sends requestCurrentSelection when the native "Highlight" menu item is tapped', async () => {
    await openBook();
    await requestHighlight();

    expect(__injectJavaScript).toHaveBeenLastCalledWith(
      buildCommandScript({ type: 'requestCurrentSelection' }),
    );
  });

  it('sends confirmDeleteHighlight when the native "Delete Highlight" menu item is tapped', async () => {
    await openBook();
    await requestDeleteHighlight();

    expect(__injectJavaScript).toHaveBeenLastCalledWith(
      buildCommandScript({ type: 'confirmDeleteHighlight' }),
    );
  });

  it('forwards an EPUB selection to addEpubHighlight verbatim, and repaints the fresh set', async () => {
    jest.mocked(addEpubHighlight).mockResolvedValue(loaded({ epub: [EPUB_HL] }));
    await openBook();
    await replyWithSelection();

    // No colour argument: highlights are single-colour by design, so the store's own default is the
    // one colour. A picker here would be a sync-model change, not a UI addition.
    expect(addEpubHighlight).toHaveBeenCalledWith('test-book', EPUB_HL.startCfi, EPUB_HL.endCfi);
    expect(__injectJavaScript).toHaveBeenLastCalledWith(
      buildCommandScript({ type: 'paintHighlights', highlights: [EPUB_HL] }),
    );
  });

  it('forwards a PDF selection as the SelectionRange the store takes', async () => {
    await openBook('PDF');
    await replyWithSelection({ kind: 'pageRange', page: 4, startOffset: 10, endOffset: 25 });

    expect(addPdfHighlight).toHaveBeenCalledWith('test-book', {
      page: 4,
      startOffset: 10,
      endOffset: 25,
    });
  });

  it('does nothing when the reply says nothing was selected', async () => {
    // A legitimate answer, not a failure — the selection could have cleared between the tap and the
    // reply. Nothing to create, and nothing to surface an error about.
    await openBook();
    await replyWithSelection(null);

    expect(addEpubHighlight).not.toHaveBeenCalled();
    expect(addPdfHighlight).not.toHaveBeenCalled();
  });

  it('deletes by stored id when the shell confirms a highlight press', async () => {
    // `highlightPressed` arrives in reply to `confirmDeleteHighlight` (the reader chose "Delete
    // Highlight" from the native menu), OR in reply to `requestCurrentSelection` when that gesture
    // turned out to meet an existing highlight (readerBridge.ts's own note) — ReaderScreen does not,
    // and must not, care which: both carry only an id, and the same `deleteHighlightById` runs
    // either way, with no separate RN confirmation step, because choosing an explicit menu item IS
    // the confirmation. See `deleteHighlightById`'s own note in ReaderScreen.tsx.
    await openBook();
    await replyHighlightPressed('h1');

    expect(removeHighlight).toHaveBeenCalledWith('test-book', 'h1');
  });

  it('surfaces highlights that could not be made paintable, rather than only logging them', async () => {
    // Same reasoning as the bookmarks panel's skipped count and the TOC hardeners: a stored
    // highlight that cannot be drawn is a bug worth seeing, and silence reads as "you never made one".
    jest.mocked(loadReaderHighlights).mockResolvedValue(loaded({}, ['bad-1', 'bad-2']));
    await openBook();

    expect(screen.getByText(/2 saved highlight\(s\) could not be shown/)).toBeTruthy();
  });

  it('has no highlight MODE to enter — the gesture is the whole interface', async () => {
    // The toolbar toggle this feature briefly had is gone: page turns and text selection are told
    // apart by gesture shape inside the WebView now, so there is nothing left for a mode to switch.
    await openBook();

    expect(screen.queryByRole('button', { name: 'Highlight mode' })).toBeNull();
  });

  it('leaves no RN overlay over the book to swallow the long press', async () => {
    // THE REASON THE MODE COULD GO. `reader-swipe-catcher` was the topmost hit-test target for every
    // touch in the viewer, so the document underneath never saw a `touchstart` and could not select
    // text. Swipes are recognised in the WebView now (webview/src/touchGesture.ts); if this overlay
    // ever comes back, long-press-to-highlight stops working on a device and no other test notices.
    await openBook();

    expect(
      screen.queryByTestId('reader-swipe-catcher', { includeHiddenElements: true }),
    ).toBeNull();
  });
});

/**
 * CONTAINMENT for a rejected annotation call. `annotationDurability.test.ts` pins the guarantee
 * these call-sites lean on — the write reaches SQLite and the outbox before it returns, so the
 * network being down cannot lose an edit. What is left is the local store itself failing, which is
 * rarer and which Reader can do nothing to recover from.
 *
 * So what is asserted here is only what Reader can actually do about it: a rejection must not become
 * an unhandled promise (a LogBox warning in dev, nothing at all in release), the book must stay
 * usable, and a failed WRITE must be said out loud, because "saved" and "silently not saved" look
 * identical on screen.
 *
 * Every rejection below is mocked at the FACADE, not at a network layer — that is the seam that can
 * actually reject now, and it is why the copy under test says "on this device" rather than telling
 * the user to check their connection.
 */
describe('a rejected annotation call is contained, not swallowed', () => {
  let alert: jest.SpyInstance;
  let warn: jest.SpyInstance;

  const REJECTION = new Error('/api/v1/highlights: Network request failed');

  function loaded(highlights: Partial<ReaderHighlights> = {}) {
    return { highlights: { epub: [], pdf: [], ...highlights }, skippedIds: [] };
  }

  beforeEach(() => {
    jest.mocked(loadReaderHighlights).mockReset().mockResolvedValue(loaded());
    jest.mocked(addEpubHighlight).mockReset().mockResolvedValue(loaded());
    jest.mocked(removeHighlight).mockReset().mockResolvedValue(loaded());
    jest.mocked(loadBookmarks).mockReset().mockResolvedValue({ bookmarks: [], skippedIds: [] });
    jest
      .mocked(addCurrentEpubBookmark)
      .mockReset()
      .mockResolvedValue({ bookmarks: [], skippedIds: [] });
    jest.mocked(removeBookmark).mockReset().mockResolvedValue({ bookmarks: [], skippedIds: [] });
    jest.mocked(renameBookmark).mockReset().mockResolvedValue({ bookmarks: [], skippedIds: [] });
    jest.mocked(prepareBook).mockResolvedValue('EPUB');
    alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    // Asserted on, not merely silenced: "it warned" is half of what containment means here, and an
    // unmocked console.warn would also print this file's deliberate failures as if they were real.
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    alert.mockRestore();
    warn.mockRestore();
  });

  async function openBook(): Promise<void> {
    await mountReader();
    await reportReady();
    await deliver({ type: 'rendered' });
  }

  async function requestHighlightFor(selection: unknown): Promise<void> {
    await deliver({ type: 'selection', selection });
  }

  const EPUB_SELECTION = {
    kind: 'cfiRange',
    startCfi: 'epubcfi(/6/4[chap01]!/4/2/2/1:0)',
    endCfi: 'epubcfi(/6/4[chap01]!/4/2/6/1:10)',
  };

  it('a failed highlight LOAD leaves the book readable and says nothing to the user', async () => {
    jest.mocked(loadReaderHighlights).mockRejectedValue(REJECTION);

    await openBook();

    // The book is still there. Nothing about a highlight fetch should blank the reader.
    expect(screen.getByTestId('reader-webview', { includeHiddenElements: true })).toBeTruthy();
    // Quiet on purpose: nothing was lost, the next open retries, and an Alert on every open with
    // the backend down would make the app unusable. See warnAnnotationReadFailed's own note.
    expect(alert).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not load highlights'),
      REJECTION,
    );
  });

  it('a failed highlight ADD tells the user the highlight was not kept', async () => {
    jest.mocked(addEpubHighlight).mockRejectedValue(REJECTION);
    await openBook();

    await requestHighlightFor(EPUB_SELECTION);

    // The wording has to say it was NOT KEPT, not merely that something went wrong: the selection
    // is already cleared, so this Alert is the only evidence the user ever gets.
    expect(alert).toHaveBeenCalledWith(
      'Highlight not saved',
      expect.stringContaining('has not been kept'),
      expect.anything(),
    );
  });

  it('a failed highlight DELETE says it is still saved, not that it was lost', async () => {
    jest.mocked(removeHighlight).mockRejectedValue(REJECTION);
    await openBook();

    await deliver({ type: 'highlightPressed', id: 'h1' });

    expect(alert).toHaveBeenCalledWith(
      'Highlight not deleted',
      expect.stringContaining('is still saved'),
      expect.anything(),
    );
  });

  it('a failed bookmark LOAD resolves the panel out of its loading state', async () => {
    // The specific trap this pins: `bookmarksLoaded` means "finished reading", not "read
    // successfully". Left false on a rejection the panel sits on "Loading bookmarks…" forever,
    // which reads as a hang rather than as an empty list.
    jest.mocked(loadBookmarks).mockRejectedValue(REJECTION);
    await openBook();

    await fireEvent.press(screen.getByRole('button', { name: 'Bookmarks' }));

    expect(screen.queryByText('Loading bookmarks…')).toBeNull();
    expect(alert).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not load bookmarks'),
      REJECTION,
    );
  });

  it('a failed bookmark ADD tells the user it was not kept', async () => {
    jest.mocked(addCurrentEpubBookmark).mockRejectedValue(REJECTION);
    await openBook();
    await deliver({
      type: 'relocated',
      position: { kind: 'cfi', cfi: 'epubcfi(/6/4[chap01]!/4/2/2)' },
      atStart: true,
      atEnd: false,
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Bookmarks' }));

    await fireEvent.press(screen.getByRole('button', { name: 'Bookmark this page' }));

    expect(alert).toHaveBeenCalledWith(
      'Bookmark not saved',
      expect.stringContaining('has not been kept'),
      expect.anything(),
    );
  });

  /**
   * FORMAT COVERAGE. There is no format branch inside any of the six handlers — `createHighlight
   * FromSelection` and `addCurrentBookmark` each pick the EPUB or PDF call-site and then share ONE
   * `.then().catch()` — so these are not a second code path. They are here because that sharing is
   * the thing worth pinning: a future split into per-format chains would have to keep both halves
   * handled, and this is what would notice.
   */
  it('a failed PDF highlight ADD takes the same handler as the EPUB one', async () => {
    jest.mocked(addPdfHighlight).mockRejectedValue(REJECTION);
    jest.mocked(prepareBook).mockResolvedValue('PDF');
    jest.mocked(getReaderHtmlUri).mockResolvedValue('file:///reader-pdf.html');
    jest.mocked(getBookBase64).mockResolvedValue('JVBERi0xLjQK');
    await openBook();

    await requestHighlightFor({ kind: 'pageRange', page: 4, startOffset: 10, endOffset: 25 });

    expect(addPdfHighlight).toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(
      'Highlight not saved',
      expect.stringContaining('has not been kept'),
      expect.anything(),
    );
  });

  it('a failed PDF bookmark ADD takes the same handler as the EPUB one', async () => {
    jest.mocked(addCurrentPdfBookmark).mockRejectedValue(REJECTION);
    jest.mocked(prepareBook).mockResolvedValue('PDF');
    jest.mocked(getReaderHtmlUri).mockResolvedValue('file:///reader-pdf.html');
    jest.mocked(getBookBase64).mockResolvedValue('JVBERi0xLjQK');
    await openBook();
    await deliver({
      type: 'relocated',
      position: { kind: 'page', page: 7, pageCount: 100 },
      atStart: false,
      atEnd: false,
    });
    await fireEvent.press(screen.getByRole('button', { name: 'Bookmarks' }));

    await fireEvent.press(screen.getByRole('button', { name: 'Bookmark this page' }));

    expect(addCurrentPdfBookmark).toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(
      'Bookmark not saved',
      expect.stringContaining('has not been kept'),
      expect.anything(),
    );
  });

  it('AUDIO never reaches either handler, because it never renders', async () => {
    // The third format has no WebView at all — `getReaderHtmlUri` refuses it before one can exist,
    // so `rendered` never arrives and both load effects stay gated behind `isRendered`. Pinned as a
    // NEGATIVE because the failure it guards against is noisy: an audio book popping a "could not
    // load highlights" warning for a reader that was never going to paint any.
    jest.mocked(loadReaderHighlights).mockRejectedValue(REJECTION);
    jest.mocked(loadBookmarks).mockRejectedValue(REJECTION);
    jest.mocked(prepareBook).mockResolvedValue('AUDIO');
    jest.mocked(getReaderHtmlUri).mockRejectedValue(new UnsupportedFormatError('AUDIO'));

    await render(<ReaderScreen bookId="test-book" />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(loadReaderHighlights).not.toHaveBeenCalled();
    expect(loadBookmarks).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a failed bookmark DELETE says it is still saved', async () => {
    jest.mocked(loadBookmarks).mockResolvedValue({
      bookmarks: [
        {
          id: 'victim',
          label: 'To be deleted',
          target: { kind: 'href', href: 'epubcfi(/6/4[chap01]!/4/2/2)' },
        },
      ],
      skippedIds: [],
    });
    jest.mocked(removeBookmark).mockRejectedValue(REJECTION);
    await openBook();
    await fireEvent.press(screen.getByRole('button', { name: 'Bookmarks' }));

    await fireEvent.press(screen.getByRole('button', { name: 'Delete bookmark: To be deleted' }));

    expect(alert).toHaveBeenCalledWith(
      'Bookmark not deleted',
      expect.stringContaining('is still saved'),
      expect.anything(),
    );
  });

  it('a failed bookmark RENAME says the old name is still saved', async () => {
    // The call-site this file could not cover while the rename was a composed add-then-remove: that
    // stand-in had no `.catch()` at all, so a rejection was an unhandled promise rather than an
    // Alert. It is one write now, contained like the other five.
    jest.mocked(loadBookmarks).mockResolvedValue({
      bookmarks: [
        {
          id: 'victim',
          label: 'Old name',
          target: { kind: 'href', href: 'epubcfi(/6/4[chap01]!/4/2/2)' },
        },
      ],
      skippedIds: [],
    });
    jest.mocked(renameBookmark).mockRejectedValue(REJECTION);
    await openBook();
    await fireEvent.press(screen.getByRole('button', { name: 'Bookmarks' }));

    await fireEvent.press(screen.getByRole('button', { name: 'Edit bookmark: Old name' }));
    await fireEvent.changeText(
      screen.getByTestId('reader-bookmark-edit-input-victim'),
      'New name',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Save bookmark name: Old name' }));

    expect(alert).toHaveBeenCalledWith(
      'Bookmark not renamed',
      expect.stringContaining('is still saved'),
      expect.anything(),
    );
  });
});

/**
 * The two halves of F4 (WEBVIEW_A11Y_SPIKE.md): the native container must not swallow the WebView's
 * own accessibility tree, and paginated flow must not be what a screen-reader user is given.
 */
describe('the screen-reader layout override', () => {
  function container(): ReturnType<typeof screen.getByTestId> {
    return screen.getByTestId('reader-webview-container', { includeHiddenElements: true });
  }

  describe('the WebView container does not merge the book away', () => {
    it('carries no accessibilityLabel of its own', async () => {
      // THE REGRESSION THIS EXISTS TO CATCH. On Android `accessibilityLabel` is a
      // contentDescription, and a contentDescription on the ViewGroup wrapping a WebView makes it a
      // screen-reader focus leaf — TalkBack announces "Book content" and never descends into the
      // DOM, so no heading, paragraph or link in the book is reachable. It reads like a helpful
      // label and it is the single most expensive line anyone could re-add here.
      await mountReader();

      expect(container().props.accessibilityLabel).toBeUndefined();
    });

    it('still offers a named stop, as a sibling of the WebView', async () => {
      await mountReader();

      const stop = screen.getByTestId('reader-webview-a11y-stop', { includeHiddenElements: true });
      expect(stop.props.accessibilityLabel).toBe('Book content');
      expect(stop.props.accessibilityRole).toBe('header');
      // Inside the container, so the panel-open hiding above still covers it.
      expect(stop.props.pointerEvents).toBe('none');
    });
  });

  describe('what gets sent over the bridge', () => {
    it('leaves paginated flow alone with no screen reader running', async () => {
      await mountReader();
      await reportReady();

      expect(__injectJavaScript).toHaveBeenCalledWith(
        buildCommandScript({
          type: 'applyAppearance',
          appearance: toReaderAppearance(makePrefs(), LIGHT_ENV),
        }),
      );
    });

    it('switches to scrolled flow and a single spread when a screen reader is running', async () => {
      jest.mocked(useScreenReaderEnabled).mockReturnValue(true);
      jest
        .mocked(prefsStore.getPrefs)
        .mockResolvedValue(makePrefs({ layout: { flow: 'paginated', spread: 'double' } }));

      await mountReader();
      await reportReady();

      const sent = __injectJavaScript.mock.calls
        .map((call) => String(call[0]))
        .filter((script) => script.includes('applyAppearance'));

      expect(sent.length).toBeGreaterThan(0);
      expect(sent[sent.length - 1]).toContain('"flow":"scrolled-doc"');
      expect(sent[sent.length - 1]).toContain('"spread":"single"');
    });
  });

  describe('the user is told, and can decline', () => {
    let alert: jest.SpyInstance;

    beforeEach(() => {
      alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    });

    afterEach(() => {
      alert.mockRestore();
    });

    it('says nothing when nothing was overridden', async () => {
      await mountReader();
      await reportReady();

      expect(alert).not.toHaveBeenCalled();
    });

    it('says nothing when the user already chose scrolled flow', async () => {
      // Nothing was taken from them, so there is nothing to explain. Announcing here would tell a
      // scrolled-by-choice reader their preference had been overridden, which is false.
      jest.mocked(useScreenReaderEnabled).mockReturnValue(true);
      jest
        .mocked(prefsStore.getPrefs)
        .mockResolvedValue(makePrefs({ layout: { flow: 'scrolled-doc', spread: 'single' } }));

      await mountReader();
      await reportReady();
      __emitPrefsChange(makePrefs({ layout: { flow: 'scrolled-doc', spread: 'single' } }));
      await act(async () => {
        await Promise.resolve();
      });

      expect(alert).not.toHaveBeenCalled();
    });

    it('explains the override once, and not again on a later re-apply', async () => {
      jest.mocked(useScreenReaderEnabled).mockReturnValue(true);
      const view = await render(<ReaderScreen bookId="test-book" />);
      await screen.findByTestId('reader-webview');
      await reportReady();

      // The stored preference has to reach `layoutPrefs` before the override can be detected as
      // one — until then the screen is still on its DEFAULT_PREFS-derived fallback.
      __emitPrefsChange(makePrefs({ layout: { flow: 'paginated', spread: 'single' } }));
      await act(async () => {
        await Promise.resolve();
      });

      expect(alert).toHaveBeenCalledTimes(1);
      expect(String(alert.mock.calls[0][0])).toContain('Layout changed');

      // Trigger C fires on every OS appearance tick. Re-alerting on each one would make a theme
      // change re-explain a layout decision the user already answered.
      jest.mocked(useAppearanceEnv).mockReturnValue({ ...LIGHT_ENV, osColorScheme: 'dark' });
      await act(async () => {
        await view.rerender(<ReaderScreen bookId="test-book" />);
      });

      expect(alert).toHaveBeenCalledTimes(1);
    });

    it('goes back to paginated when the user chooses "Use pages anyway"', async () => {
      jest.mocked(useScreenReaderEnabled).mockReturnValue(true);
      await mountReader();
      await reportReady();

      __emitPrefsChange(makePrefs({ layout: { flow: 'paginated', spread: 'single' } }));
      await act(async () => {
        await Promise.resolve();
      });

      const buttons = alert.mock.calls[0][2] as { text: string; onPress?: () => void }[];
      const decline = buttons.find((button) => button.text === 'Use pages anyway');
      expect(decline).toBeDefined();

      __injectJavaScript.mockClear();
      await act(async () => {
        decline?.onPress?.();
        await Promise.resolve();
      });

      const sent = __injectJavaScript.mock.calls
        .map((call) => String(call[0]))
        .filter((script) => script.includes('applyAppearance'));

      expect(sent.length).toBeGreaterThan(0);
      expect(sent[sent.length - 1]).toContain('"flow":"paginated"');
    });
  });
});

/**
 * WHEN the reader speaks. The wording and the gate rules are `readerAnnouncements.test.ts`'s; what
 * needs a mounted screen is that the right values reach them — `announcePageChanges` is only
 * readable at `relocated` time through the appearance the WebView was last sent, and a previous
 * position only exists if something retained it.
 */
describe('screen-reader announcements', () => {
  let spoken: jest.SpyInstance;

  // EXPLICIT, for the reason the TTS block above states: this file never clears mocks between
  // tests and several earlier ones leave `prepareBook` resolving 'PDF'.
  beforeEach(() => {
    jest.mocked(prepareBook).mockResolvedValue('EPUB');
    jest.mocked(getBookBase64).mockResolvedValue('UEsDBA==');
    spoken = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    spoken.mockRestore();
  });

  function said(): string[] {
    return spoken.mock.calls.map((call) => String(call[0]));
  }

  describe('page changes', () => {
    async function openPdf(): Promise<void> {
      jest.mocked(prepareBook).mockResolvedValue('PDF');
      await mountReader();
      await reportReady();
    }

    it('says nothing for the first position after an open', async () => {
      await openPdf();
      spoken.mockClear();

      await deliver({ type: 'relocated', position: { kind: 'page', page: 1, pageCount: 340 } });

      expect(said()).toEqual([]);
    });

    it('names the new page once it actually moves', async () => {
      await openPdf();
      await deliver({ type: 'relocated', position: { kind: 'page', page: 1, pageCount: 340 } });
      spoken.mockClear();

      await deliver({ type: 'relocated', position: { kind: 'page', page: 2, pageCount: 340 } });

      expect(said()).toEqual(['Page 2 of 340']);
    });

    it('stays silent while the page number is unchanged', async () => {
      // The PDF scroll path posts `relocated` from a rAF-coalesced scroll listener, so one flick
      // delivers dozens of these. This is the difference between one announcement per page turn and
      // one per animation frame.
      await openPdf();
      await deliver({ type: 'relocated', position: { kind: 'page', page: 4, pageCount: 340 } });
      spoken.mockClear();

      await deliver({ type: 'relocated', position: { kind: 'page', page: 4, pageCount: 340 } });
      await deliver({ type: 'relocated', position: { kind: 'page', page: 4, pageCount: 340 } });

      expect(said()).toEqual([]);
    });

    it('respects announce.pageChanges', async () => {
      // Read off the appearance the WebView was last sent, not from AccessibilityPrefs directly —
      // that route is the standing rule in ACCESSIBILITY_ARCHITECTURE_MAP.md §2, and this is the
      // test that it is actually the route taken.
      const prefs = makePrefs();
      prefs.accessibility.announce.pageChanges = false;
      jest.mocked(prefsStore.getPrefs).mockResolvedValue(prefs);

      await openPdf();
      await deliver({ type: 'relocated', position: { kind: 'page', page: 1, pageCount: 9 } });
      spoken.mockClear();

      await deliver({ type: 'relocated', position: { kind: 'page', page: 2, pageCount: 9 } });

      expect(said()).toEqual([]);

      jest.mocked(prefsStore.getPrefs).mockResolvedValue(makePrefs());
    });

    it('says nothing for a reflowable EPUB, which has no page to name', async () => {
      await mountReader();
      await reportReady();
      await deliver({ type: 'relocated', position: { kind: 'cfi', cfi: 'epubcfi(/6/4!/4/2)' } });
      spoken.mockClear();

      await deliver({ type: 'relocated', position: { kind: 'cfi', cfi: 'epubcfi(/6/6!/4/2)' } });

      expect(said()).toEqual([]);
    });
  });

  describe('chapter changes', () => {
    const chapterToc = [
      { label: 'The Cave', target: { kind: 'href', href: 'ch1.xhtml' }, depth: 0 },
      { label: 'The Road', target: { kind: 'href', href: 'ch2.xhtml' }, depth: 0 },
    ];

    async function openEpubAt(href: string, index: number): Promise<void> {
      await mountReader();
      await reportReady();
      await deliver({ type: 'toc', items: chapterToc });
      await deliver({
        type: 'relocated',
        position: { kind: 'cfi', cfi: 'epubcfi(/6/4!/4/2)' },
        section: { index, href },
      });
      spoken.mockClear();
    }

    it('names the chapter using the outline the reader can see', async () => {
      await openEpubAt('ch1.xhtml', 0);

      await deliver({
        type: 'relocated',
        position: { kind: 'cfi', cfi: 'epubcfi(/6/6!/4/2)' },
        section: { index: 1, href: 'ch2.xhtml' },
      });

      expect(said()).toEqual(['Chapter: The Road']);
    });

    it('falls back to the spine position when the outline names nothing', async () => {
      await openEpubAt('ch1.xhtml', 0);

      await deliver({
        type: 'relocated',
        position: { kind: 'cfi', cfi: 'epubcfi(/6/8!/4/2)' },
        section: { index: 4, href: 'appendix.xhtml' },
      });

      expect(said()).toEqual(['Chapter 5']);
    });

    it('says nothing while the reader stays inside one chapter', async () => {
      // Every page turn within a chapter reports the same href. Announcing on arrival rather than
      // on change would name the chapter on every single page.
      await openEpubAt('ch1.xhtml', 0);

      await deliver({
        type: 'relocated',
        position: { kind: 'cfi', cfi: 'epubcfi(/6/4!/4/40)' },
        section: { index: 0, href: 'ch1.xhtml' },
      });

      expect(said()).toEqual([]);
    });

    it('says nothing for the first chapter after an open', async () => {
      await mountReader();
      await reportReady();
      await deliver({ type: 'toc', items: chapterToc });
      spoken.mockClear();

      await deliver({
        type: 'relocated',
        position: { kind: 'cfi', cfi: 'epubcfi(/6/4!/4/2)' },
        section: { index: 0, href: 'ch1.xhtml' },
      });

      expect(said()).toEqual([]);
    });

    it('respects announce.chapterChanges independently of pageChanges', async () => {
      const prefs = makePrefs();
      prefs.accessibility.announce.chapterChanges = false;
      jest.mocked(prefsStore.getPrefs).mockResolvedValue(prefs);

      await openEpubAt('ch1.xhtml', 0);
      await deliver({
        type: 'relocated',
        position: { kind: 'cfi', cfi: 'epubcfi(/6/6!/4/2)' },
        section: { index: 1, href: 'ch2.xhtml' },
      });

      expect(said()).toEqual([]);

      jest.mocked(prefsStore.getPrefs).mockResolvedValue(makePrefs());
    });

    it('never announces both a chapter and a page for one relocation', async () => {
      // Crossing a chapter boundary is also a page change. Two utterances for one turn is the
      // over-announcement the whole seam exists to avoid.
      jest.mocked(prepareBook).mockResolvedValue('PDF');
      await mountReader();
      await reportReady();
      await deliver({
        type: 'relocated',
        position: { kind: 'page', page: 1, pageCount: 9 },
        section: { index: 0, href: 'ch1.xhtml' },
      });
      spoken.mockClear();

      await deliver({
        type: 'relocated',
        position: { kind: 'page', page: 2, pageCount: 9 },
        section: { index: 1, href: 'ch2.xhtml' },
      });

      expect(said()).toEqual(['Chapter 2']);
    });
  });

  describe('appearance changes', () => {
    it('says nothing for the first appearance of a session', async () => {
      // Opening a book is not a settings change, and narrating it is the over-announcement this
      // whole seam exists to avoid.
      await mountReader();
      await reportReady();

      expect(said()).toEqual([]);
    });

    it('names the field the user changed', async () => {
      await mountReader();
      await reportReady();
      spoken.mockClear();

      __emitPrefsChange(makePrefs({ theme: 'dark' }));
      await act(async () => {
        await Promise.resolve();
      });

      expect(said()).toEqual(['Dark theme']);
    });

    it('says nothing when a re-resolve produces the same payload', async () => {
      // Trigger C re-resolves on every OS appearance tick. Diffing the RESOLVED appearance rather
      // than the prefs edit is what keeps that silent.
      const view = await render(<ReaderScreen bookId="test-book" />);
      await screen.findByTestId('reader-webview');
      await reportReady();
      spoken.mockClear();

      await act(async () => {
        await view.rerender(<ReaderScreen bookId="test-book" />);
      });

      expect(said()).toEqual([]);
    });
  });
});

// Both the PDF shell's `window.resize` handler and epub.js's own `Rendition.onResized` can
// silently re-navigate over a `goTo` sent in the first moments after `rendered` — the volatile
// window while the screen's own push-transition is still resizing the WebView's container, or an
// `applyAppearance` reanchor lands in that same window. This pins the host-side safety net: verify
// every `relocated` after an `initialTarget` flush against what was requested, and resend — up to
// `MAX_INITIAL_TARGET_RESENDS` times — if it landed somewhere else. More than one resend matters
// because those two races are INDEPENDENT and can both land wrong in the same open.
describe('the initial-target flush verifies and resends on a mismatch', () => {
  /** How many times `goTo` was sent for this exact target, across the whole test. */
  function goToCallCount(target: { kind: 'page'; page: number }): number {
    const script = buildCommandScript({ type: 'goTo', target });
    return __injectJavaScript.mock.calls.filter(([sent]) => sent === script).length;
  }

  it('resends when the first relocated lands somewhere else', async () => {
    await render(
      <ReaderScreen bookId="test-book-verify-mismatch" initialTarget={{ kind: 'page', page: 5 }} />,
    );
    await screen.findByTestId('reader-webview');
    await reportReady();
    await deliver({ type: 'rendered' });

    // The resize-race case this guards against: the shell reports page 1 instead of the requested 5.
    await deliver({ type: 'relocated', position: { kind: 'page', page: 1, pageCount: 20 } });

    expect(goToCallCount({ kind: 'page', page: 5 })).toBe(2); // the original flush, plus one resend
  });

  it('does not resend when the first relocated already matches', async () => {
    await render(
      <ReaderScreen bookId="test-book-verify-match" initialTarget={{ kind: 'page', page: 5 }} />,
    );
    await screen.findByTestId('reader-webview');
    await reportReady();
    await deliver({ type: 'rendered' });

    await deliver({ type: 'relocated', position: { kind: 'page', page: 5, pageCount: 20 } });

    expect(goToCallCount({ kind: 'page', page: 5 })).toBe(1); // only the original flush
  });

  it('corrects TWO independent mismatches in the same open, not just one', async () => {
    // The case a one-shot retry could not cover: a resize race lands wrong, the resend corrects it
    // to... also wrong (a SEPARATE appearance-reanchor race), and a second resend finally lands right.
    await render(
      <ReaderScreen bookId="test-book-verify-two-mismatches" initialTarget={{ kind: 'page', page: 5 }} />,
    );
    await screen.findByTestId('reader-webview');
    await reportReady();
    await deliver({ type: 'rendered' });

    await deliver({ type: 'relocated', position: { kind: 'page', page: 1, pageCount: 20 } });
    await deliver({ type: 'relocated', position: { kind: 'page', page: 2, pageCount: 20 } });
    await deliver({ type: 'relocated', position: { kind: 'page', page: 5, pageCount: 20 } });

    expect(goToCallCount({ kind: 'page', page: 5 })).toBe(3); // flush + two resends
  });

  it('gives up eventually rather than retrying forever', async () => {
    await render(
      <ReaderScreen bookId="test-book-verify-retry-cap" initialTarget={{ kind: 'page', page: 5 }} />,
    );
    await screen.findByTestId('reader-webview');
    await reportReady();
    await deliver({ type: 'rendered' });

    // Comfortably more mismatches than any reasonable retry budget — deliberately not asserting the
    // exact cap value here, so this test doesn't need editing every time MAX_INITIAL_TARGET_RESENDS
    // is retuned. What matters is that it STOPS, not the precise number of attempts it took.
    for (let page = 1; page <= 20; page++) {
      await deliver({ type: 'relocated', position: { kind: 'page', page, pageCount: 20 } });
    }
    const totalAfterBudgetSpent = goToCallCount({ kind: 'page', page: 5 });

    // One more mismatch, once the budget is already spent, must not provoke yet another resend.
    await deliver({ type: 'relocated', position: { kind: 'page', page: 999, pageCount: 20 } });

    expect(goToCallCount({ kind: 'page', page: 5 })).toBe(totalAfterBudgetSpent);
  });

  it('stops correcting once the reader takes over navigation, rather than fighting a real page turn', async () => {
    await render(
      <ReaderScreen bookId="test-book-verify-user-takes-over" initialTarget={{ kind: 'page', page: 5 }} />,
    );
    await screen.findByTestId('reader-webview');
    await reportReady();
    await deliver({ type: 'rendered' });

    // The flush landed wrong once — still well within budget, so this alone would normally resend.
    await deliver({ type: 'relocated', position: { kind: 'page', page: 1, pageCount: 20 } });
    const sendsBeforeUserAction = goToCallCount({ kind: 'page', page: 5 });

    // The reader taps Next themselves — a deliberate navigation, not a race to correct.
    await fireEvent.press(screen.getByRole('button', { name: 'Next page' }));
    await deliver({ type: 'relocated', position: { kind: 'page', page: 2, pageCount: 20 } });

    // No further attempt to correct back to page 5 — the reader's own navigation wins.
    expect(goToCallCount({ kind: 'page', page: 5 })).toBe(sendsBeforeUserAction);
  });

  // Mirrors the test above, but through TalkBack's native page-turn action
  // (TALKBACK_GESTURE_FIX_PROPOSAL.md) instead of the toolbar Prev/Next Pressables — pinning that
  // ReaderScreen's onPageTurnRequested wiring clears pendingInitialVerifyRef exactly like the
  // toolbar buttons do, not a partial copy that skips the race-guard half of the effect.
  it('a TalkBack page-turn action also stops the resend loop, same as the toolbar buttons', async () => {
    await render(
      <ReaderScreen bookId="test-book-verify-talkback-pageturn" initialTarget={{ kind: 'page', page: 5 }} />,
    );
    await screen.findByTestId('reader-webview');
    await reportReady();
    await deliver({ type: 'rendered' });

    await deliver({ type: 'relocated', position: { kind: 'page', page: 1, pageCount: 20 } });
    const sendsBeforeTalkBackAction = goToCallCount({ kind: 'page', page: 5 });

    const pageTurn = screen.getByTestId('reader-webview-a11y-pageturn');
    await act(async () => {
      pageTurn.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } });
    });
    await deliver({ type: 'relocated', position: { kind: 'page', page: 2, pageCount: 20 } });

    expect(goToCallCount({ kind: 'page', page: 5 })).toBe(sendsBeforeTalkBackAction);
  });

  // Regression pin, found live on-device 2026-09-03: `onRelocated` (ReaderRouteScreen.tsx's save
  // path, which pushes to Sync unthrottled on its very first call) used to fire for EVERY
  // `relocated`, including a wrong intermediate one still being corrected by the resend logic
  // above. Opening a book already at page 9 durably overwrote the synced position with page 1
  // within the first second, every time - the resend loop fixed what was on screen, but the wrong
  // page had already been saved and pushed before it did.
  it('does not report a relocate outward to onRelocated until the initial target actually lands', async () => {
    const onRelocated = jest.fn();
    await render(
      <ReaderScreen
        bookId="test-book-verify-no-premature-report"
        initialTarget={{ kind: 'page', page: 5 }}
        onRelocated={onRelocated}
      />,
    );
    await screen.findByTestId('reader-webview');
    await reportReady();
    await deliver({ type: 'rendered' });

    // The wrong intermediate landing - must not reach onRelocated, or a real resume position gets
    // clobbered by whatever the shell opened to by default.
    await deliver({ type: 'relocated', position: { kind: 'page', page: 1, pageCount: 20 } });
    expect(onRelocated).not.toHaveBeenCalled();

    // The resend lands correctly - THIS one must reach onRelocated, with the real target.
    await deliver({ type: 'relocated', position: { kind: 'page', page: 5, pageCount: 20 } });
    expect(onRelocated).toHaveBeenCalledTimes(1);
    expect(onRelocated).toHaveBeenCalledWith({ kind: 'page', page: 5, pageCount: 20 });
  });

  // Regression pin: both pdf.entry.ts (renderCurrent(1) inside openPdf) and epub.entry.ts
  // (display() inside openEpub) post `relocated` BEFORE they post `rendered`. The effect that
  // sets pendingInitialVerifyRef waits for isRendered, so when the pre-rendered `relocated`
  // arrives, pendingInitialVerifyRef is null and the existing post-rendered guard cannot fire.
  // Without the fix, that pre-rendered `relocated` (page 1 / beginning CFI) reached
  // onRelocated unthrottled — durably overwriting a correct synced resume position with the
  // book's default landing on every open.
  it('does not report a relocate outward for a pre-rendered relocated (before rendered fires)', async () => {
    const onRelocated = jest.fn();
    await render(
      <ReaderScreen
        bookId="test-book-pre-rendered-relocated"
        initialTarget={{ kind: 'page', page: 5 }}
        onRelocated={onRelocated}
      />,
    );
    await screen.findByTestId('reader-webview');
    await reportReady();

    // Pre-rendered relocated: arrives before `rendered`, the real-WebView order for both shells.
    // This is the book's natural default landing (page 1), not the resume target.
    await deliver({ type: 'relocated', position: { kind: 'page', page: 1, pageCount: 20 } });
    expect(onRelocated).not.toHaveBeenCalled();

    // Now rendered fires, the goTo effect runs, and the target lands.
    await deliver({ type: 'rendered' });
    await deliver({ type: 'relocated', position: { kind: 'page', page: 5, pageCount: 20 } });
    expect(onRelocated).toHaveBeenCalledTimes(1);
    expect(onRelocated).toHaveBeenCalledWith({ kind: 'page', page: 5, pageCount: 20 });
  });

  it('reports a relocate outward once verification gives up, not just once it lands correctly', async () => {
    const onRelocated = jest.fn();
    await render(
      <ReaderScreen
        bookId="test-book-verify-report-after-abandon"
        initialTarget={{ kind: 'page', page: 5 }}
        onRelocated={onRelocated}
      />,
    );
    await screen.findByTestId('reader-webview');
    await reportReady();
    await deliver({ type: 'rendered' });

    // Comfortably more mismatches than any reasonable retry budget — same style and same reason
    // as "gives up eventually" above, deliberately not pinned to the exact cap value. Starting well
    // past the target (5), with a generous pageCount, so none of these ever accidentally match it
    // or get discarded as an out-of-range position.
    for (let page = 100; page <= 149; page++) {
      await deliver({ type: 'relocated', position: { kind: 'page', page, pageCount: 200 } });
    }

    // Verification has certainly given up by now (pendingInitialVerifyRef is null again) - one
    // more relocate is ordinary navigation from here on, and must reach onRelocated with its own
    // position rather than being silently dropped forever.
    await deliver({ type: 'relocated', position: { kind: 'page', page: 150, pageCount: 200 } });
    expect(onRelocated).toHaveBeenCalledWith({ kind: 'page', page: 150, pageCount: 200 });
  });
});

// Neither non-default appearance nor existing highlights had a test combined with `initialTarget`
// before this — each was proven correct in isolation (appearance ordering in "applyAppearance — the
// prefs-application wiring", highlight painting in "ReaderScreen highlights"), but never together
// with a bookmark-style open. This pins that the three don't interfere: a non-default layout is
// still applied BEFORE the book opens, the initial target still lands, and highlights still paint.
describe('opening to an initial target with a non-default appearance and existing highlights', () => {
  const EPUB_HL = {
    id: 'h1',
    startCfi: 'epubcfi(/6/4[chap01]!/4/2/2/1:0)',
    endCfi: 'epubcfi(/6/4[chap01]!/4/2/6/1:10)',
    color: 'yellow',
  };

  it('applies the non-default layout before open, lands on the target, and paints the highlight', async () => {
    jest
      .mocked(prefsStore.getPrefs)
      .mockResolvedValue(makePrefs({ layout: { flow: 'scrolled-doc', spread: 'double' } }));
    jest
      .mocked(loadReaderHighlights)
      .mockResolvedValue({ highlights: { epub: [EPUB_HL], pdf: [] }, skippedIds: [] });

    await render(
      <ReaderScreen
        bookId="test-book-appearance-and-highlights"
        initialTarget={{ kind: 'href', href: 'epubcfi(/6/4[chap01]!/4/2/4/1:0)' }}
      />,
    );
    await screen.findByTestId('reader-webview');
    await reportReady();

    // applyAppearance must be sent, and land, BEFORE openEpub — the signed-off ordering
    // (WEBVIEW_BRIDGE.md) that lets the book open directly into the right layout.
    const scripts = __injectJavaScript.mock.calls.map(([script]: [string]) => script as string);
    const appearanceIndex = scripts.findIndex((s) => s.includes('"flow":"scrolled-doc"'));
    const openIndex = scripts.findIndex((s) => s.includes('openEpub('));
    expect(appearanceIndex).toBeGreaterThanOrEqual(0);
    expect(openIndex).toBeGreaterThan(appearanceIndex);

    await deliver({ type: 'rendered' });
    await deliver({
      type: 'relocated',
      position: { kind: 'cfi', cfi: 'epubcfi(/6/4[chap01]!/4/2/4/1:0)' },
    });

    // The initial target landed on the first try — no resend needed — despite the non-default
    // layout already in effect.
    expect(
      __injectJavaScript.mock.calls.filter(
        ([sent]) =>
          sent ===
          buildCommandScript({
            type: 'goTo',
            target: { kind: 'href', href: 'epubcfi(/6/4[chap01]!/4/2/4/1:0)' },
          }),
      ).length,
    ).toBe(1);

    // Highlights still load and paint for this book, unaffected by the bookmark-style open.
    expect(loadReaderHighlights).toHaveBeenCalledWith('test-book-appearance-and-highlights');
    expect(__injectJavaScript).toHaveBeenCalledWith(
      buildCommandScript({ type: 'paintHighlights', highlights: [EPUB_HL] }),
    );
  });
});
