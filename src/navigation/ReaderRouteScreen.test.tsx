// Owner: Reader (Ahana).
//
// Covers ReaderRouteScreen's own contract — wiring route params into ReaderScreen's `bookId` and
// the progressStore-backed resume/write props — not ReaderScreen's or DevPreferencesMenu's own
// behaviour, which have their own test files. Both are mocked to inert stubs so this only exercises
// the glue, same pattern AudioPlayerRouteScreen.test.tsx uses.
//
// progressStore itself is mocked rather than exercised against real SQLite: this file tests
// ReaderRouteScreen's wiring (does it call currentLocator/savePosition with the right arguments),
// not progressStore's own correctness — that lives in src/features/sync/contractConformance.test.ts.
// syncEngine.run() is mocked too, for the same reason — this file checks that it is awaited BEFORE
// the local read, not that a real sync actually does anything.
//
// There is no in-session cache to test here any more — every resume read goes through
// progressStore, including the caller-supplied-target case, which is why every test below awaits
// the resolved state rather than asserting synchronously. See ReaderRouteScreen.tsx's header for
// why an earlier, faster-looking version of this file's subject was wrong to keep one.
//
// `progressStore.subscribe` is faked with a real listener registry (not a bare jest.fn()) so a
// test can actually fire a notification the way a completed sync pull would — the cross-device
// conflict tests below drive it directly rather than going through a real syncEngine.

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert, AppState } from 'react-native';

import { downloadStore } from '@/features/sync/stores/downloadStore';
import { syncEngine } from '@/features/sync/syncEngine';
import type { Locator } from '@/shared/contracts';

import { ReaderRouteScreen } from './ReaderRouteScreen';

const mockCurrentForBook = downloadStore.currentForBook as jest.Mock;
const mockPullBook = syncEngine.pullBook as jest.Mock;

const mockCurrentLocator = jest.fn<Promise<Locator | null>, [string?, string?]>();
const mockSavePosition = jest.fn();
const mockSyncRun = jest.fn<Promise<void>, []>();
// Records call order across both mocks, so a test can prove `run()` happened BEFORE
// `currentLocator()` rather than merely that both happened.
const callOrder: string[] = [];

let mockProgressListeners: (() => void)[] = [];
/** Simulates a `progressStore` change notification — a local write OR a pulled record applying. */
function notifyProgressChanged() {
  for (const listener of [...mockProgressListeners]) listener();
}

jest.mock('@/features/sync/stores/progressStore', () => ({
  progressStore: {
    currentLocator: (...args: [string?, string?]) => {
      callOrder.push('currentLocator');
      return mockCurrentLocator(...args);
    },
    savePosition: (...args: unknown[]) => mockSavePosition(...args),
    subscribe: (listener: () => void) => {
      mockProgressListeners.push(listener);
      return () => {
        mockProgressListeners = mockProgressListeners.filter((l) => l !== listener);
      };
    },
  },
}));

jest.mock('@/features/sync/syncEngine', () => ({
  syncEngine: {
    run: () => {
      callOrder.push('run');
      return mockSyncRun();
    },
    pullBook: jest.fn().mockResolvedValue(undefined),
  },
}));

// Not downloaded, for every book in this file's fixtures - the simplest default, since none of
// them are ever actually downloaded here. This is what routes every test through the SAME
// pullBook() branch pullBook's own describe block below exercises deliberately; the other tests
// in this file are not testing that branch, just tolerating it the way a real undownloaded book
// would.
jest.mock('@/features/sync/stores/downloadStore', () => ({
  downloadStore: {
    currentForBook: jest.fn().mockResolvedValue(null),
  },
}));

// `mock`-prefixed, per babel-plugin-jest-hoist's naming exception: jest.mock() factories may not
// otherwise close over an out-of-scope variable, since the mock call is hoisted above this file's
// other top-level statements.
const mockReceivedProps: { bookId?: string; initialTarget?: unknown }[] = [];
// Controls what the mocked `ReaderScreenHandle.pauseTtsIfSpeaking()` returns — the real
// implementation's own contract (see `ReaderScreenHandle`'s doc comment): `false` when nothing was
// speaking, `true` when it paused something.
const mockPauseTtsIfSpeaking = jest.fn<boolean, []>();

jest.mock('@/features/reader/ReaderScreen', () => {
  // require(), not a top-level import: babel-plugin-jest-hoist forbids a jest.mock() factory from
  // closing over any out-of-scope import binding (only `mock`-prefixed variables and a handful of
  // globals are allowed) — same reasoning as mockReceivedProps's naming above.
  /* eslint-disable-next-line @typescript-eslint/no-require-imports -- see comment above */
  const { forwardRef, useImperativeHandle } = require('react');
  return {
    ReaderScreen: forwardRef(function MockReaderScreen(
      props: {
        bookId: string;
        initialTarget?: unknown;
        onRelocated?: (p: unknown) => void;
        onLocked?: (code: string, message: string) => void;
        onOpenAccessibilityInfo?: () => void;
      },
      ref: unknown,
    ) {
      mockReceivedProps.push({ bookId: props.bookId, initialTarget: props.initialTarget });
      useImperativeHandle(ref, () => ({ pauseTtsIfSpeaking: mockPauseTtsIfSpeaking }));
      /* eslint-disable-next-line @typescript-eslint/no-require-imports -- see comment above */
      const { View, Text: RNText } = require('react-native');
      return (
        <View>
          <RNText>{`reading ${props.bookId}`}</RNText>
          <RNText onPress={() => props.onRelocated?.({ kind: 'page', page: 7, pageCount: 20 })}>
            relocate
          </RNText>
          <RNText onPress={() => props.onLocked?.('ACCESS_REVOKED', 'test lock message')}>
            lock
          </RNText>
          <RNText onPress={() => props.onOpenAccessibilityInfo?.()}>
            open accessibility info
          </RNText>
        </View>
      );
    }),
  };
});

jest.mock('../../DevPreferencesMenu', () => ({
  DevPreferencesMenu: () => null,
}));

const mockGoBack = jest.fn();
// Mirrors ItemDetailScreen.test.tsx's own `mockGetParent` — ReaderRouteScreen now hides the shared
// tab bar the same way that screen does (see its own `getParent()?.setOptions` effect).
const mockGetParent = jest.fn(() => ({ setOptions: jest.fn() }));

// `render` is ASYNC in @testing-library/react-native v14 — see App.test.tsx's own note.
function renderReaderRoute(bookId: string, initialTarget?: unknown) {
  return render(
    <ReaderRouteScreen
      navigation={{ setOptions: jest.fn(), goBack: mockGoBack, getParent: mockGetParent } as never}
      route={
        { key: 'Reader', name: 'Reader', params: { bookId, format: 'EPUB', initialTarget } } as never
      }
    />,
  );
}

// Which button (by text) to auto-press the MOMENT `Alert.alert` is called, or null to leave the
// dialog "showing" (unanswered). Auto-pressing synchronously, inside `Alert.alert`'s own mocked
// call, is deliberate: it keeps the press inside the SAME microtask as the `currentLocator().then()`
// that triggered it, which is itself flushed by `waitFor`'s own `act()` wrapping below — a button
// press captured and re-invoked later, from outside any `act()` scope, is a real native dialog's
// behaviour but not one React Test Renderer resolves the same way.
let mockAlertAutoPress: string | null = null;
const mockAlert = jest
  .spyOn(Alert, 'alert')
  .mockImplementation((_title, _message, buttons) => {
    if (mockAlertAutoPress === null) return;
    const button = (buttons as { text: string; onPress?: () => void }[] | undefined)?.find(
      (candidate) => candidate.text === mockAlertAutoPress,
    );
    button?.onPress?.();
  });

describe('ReaderRouteScreen', () => {
  beforeEach(() => {
    mockReceivedProps.length = 0;
    callOrder.length = 0;
    mockProgressListeners = [];
    mockAlertAutoPress = null;
    mockCurrentLocator.mockReset();
    mockSavePosition.mockReset();
    mockSyncRun.mockReset();
    mockAlert.mockClear();
    mockCurrentForBook.mockReset();
    mockPullBook.mockReset();
    mockPauseTtsIfSpeaking.mockReset();
    mockGoBack.mockReset();
    mockGetParent.mockClear();
    mockCurrentLocator.mockResolvedValue(null);
    mockSyncRun.mockResolvedValue(undefined);
    mockCurrentForBook.mockResolvedValue(null);
    mockPullBook.mockResolvedValue(undefined);
    mockPauseTtsIfSpeaking.mockReturnValue(false);
  });

  describe('onOpenAccessibilityInfo', () => {
    it('wires ReaderScreen straight to navigation.navigate("BookInfo", { bookId })', async () => {
      const mockNavigate = jest.fn();
      const { getByText } = await render(
        <ReaderRouteScreen
          navigation={{ setOptions: jest.fn(), navigate: mockNavigate, getParent: mockGetParent } as never}
          route={
            {
              key: 'Reader',
              name: 'Reader',
              params: { bookId: 'test-book', format: 'EPUB' },
            } as never
          }
        />,
      );

      await waitFor(() => expect(getByText('open accessibility info')).toBeTruthy());
      await fireEvent.press(getByText('open accessibility info'));

      expect(mockNavigate).toHaveBeenCalledWith('BookInfo', { bookId: 'test-book' });
    });
  });

  describe('a book read online without ever being downloaded', () => {
    it('tops up just this book via pullBook before reading the local resume position', async () => {
      mockCurrentForBook.mockResolvedValue(null); // not downloaded

      await renderReaderRoute('dev-sample-epub-undownloaded');

      expect(mockCurrentForBook).toHaveBeenCalledWith('dev-sample-epub-undownloaded');
      expect(mockPullBook).toHaveBeenCalledWith('dev-sample-epub-undownloaded');
      // Still resolves through the same local read afterward - pullBook is a top-up, not a
      // replacement for it.
      expect(mockCurrentLocator).toHaveBeenCalledWith(undefined, 'dev-sample-epub-undownloaded');
    });

    it('does not call pullBook for a book this device already has downloaded', async () => {
      mockCurrentForBook.mockResolvedValue({ id: 'dl-1', book_id: 'dev-sample-epub-downloaded' });

      await renderReaderRoute('dev-sample-epub-downloaded');

      expect(mockPullBook).not.toHaveBeenCalled();
    });
  });

  it('resumes at the locator stored in progressStore, after awaiting a sync run first', async () => {
    mockCurrentLocator.mockResolvedValue({ type: 'PDF', page: 12 });

    const { getByText } = await renderReaderRoute('dev-sample-epub-durable');

    await waitFor(() => expect(getByText('reading dev-sample-epub-durable')).toBeTruthy());
    expect(mockCurrentLocator).toHaveBeenCalledWith(undefined, 'dev-sample-epub-durable');
    // ORDER MATTERS: a local read before the sync lands would resume from a position another
    // device may have already advanced past while this device was merely backgrounded, not
    // relaunched — see ReaderRouteScreen.tsx's header for the full account of that gap.
    expect(callOrder).toEqual(['run', 'currentLocator']);
    expect(mockReceivedProps[0]).toEqual({
      bookId: 'dev-sample-epub-durable',
      initialTarget: { kind: 'page', page: 12 },
    });
  });

  it('prefers a route-supplied initial target and skips both the sync run and the progressStore read', async () => {
    const { getByText } = await renderReaderRoute('dev-sample-epub-bookmark', {
      kind: 'href',
      href: 'epubcfi(/6/10)',
    });

    await waitFor(() => expect(getByText('reading dev-sample-epub-bookmark')).toBeTruthy());
    expect(mockReceivedProps[0]).toEqual({
      bookId: 'dev-sample-epub-bookmark',
      initialTarget: { kind: 'href', href: 'epubcfi(/6/10)' },
    });
    expect(mockCurrentLocator).not.toHaveBeenCalled();
    expect(mockSyncRun).not.toHaveBeenCalled();
  });

  it('opens with no initial target for a book with nothing stored', async () => {
    const { getByText } = await renderReaderRoute('dev-sample-epub-fresh');

    await waitFor(() => expect(getByText('reading dev-sample-epub-fresh')).toBeTruthy());
    expect(mockReceivedProps[0]).toEqual({
      bookId: 'dev-sample-epub-fresh',
      initialTarget: undefined,
    });
  });

  it('ignores a stored locator that belongs to an AUDIO book', async () => {
    mockCurrentLocator.mockResolvedValue({ type: 'AUDIO', positionMs: 90_000 });

    const { getByText } = await renderReaderRoute('dev-sample-epub-audio-locator');

    await waitFor(() => expect(getByText('reading dev-sample-epub-audio-locator')).toBeTruthy());
    expect(mockReceivedProps[0]?.initialTarget).toBeUndefined();
  });

  it('writes a relocated position into progressStore as a PDF-shaped locator', async () => {
    const { getByText } = await renderReaderRoute('dev-sample-epub-mirror');
    await waitFor(() => expect(getByText('relocate')).toBeTruthy());

    // AWAITED, AND THAT IS LOAD-BEARING. `fireEvent` is awaitable in @testing-library/react-native
    // v14 and does its own `act()` wrapping (same note ReaderScreen.test.tsx carries). Dropped, the
    // act scope never closes, and every test that runs AFTER this one renders NOTHING — the mocked
    // screen is simply never called, so the failures read as "unable to find text" rather than as
    // anything to do with this line. Invisible in declaration order because this is the last test
    // in the file, and `jest --randomize` is what surfaced it. Type-aware `no-floating-promises`
    // would have caught it, but it is scoped to `src/features/reader/**` (eslint.config.js) and
    // this file is `src/navigation/`.
    await fireEvent.press(getByText('relocate'));

    expect(mockSavePosition).toHaveBeenCalledWith(
      { type: 'PDF', page: 7 },
      'dev-sample-epub-mirror',
    );
  });

  it('drops a relocated write inside the throttle window, but still flushes it on unmount', async () => {
    const { getByText, unmount } = await renderReaderRoute('dev-sample-epub-throttle');
    await waitFor(() => expect(getByText('relocate')).toBeTruthy());

    await fireEvent.press(getByText('relocate'));
    expect(mockSavePosition).toHaveBeenCalledTimes(1);
    mockSavePosition.mockClear();

    // A second relocate inside the throttle window is dropped...
    await fireEvent.press(getByText('relocate'));
    expect(mockSavePosition).not.toHaveBeenCalled();

    // ...but unmounting (e.g. navigating back) flushes the latest position through regardless.
    await act(async () => {
      unmount();
    });
    expect(mockSavePosition).toHaveBeenCalledWith(
      { type: 'PDF', page: 7 },
      'dev-sample-epub-throttle',
    );
  });

  // `ReaderScreen`'s own `tearDownAndLock` already did its half (stopped the monitor, closed
  // the book, shown the inline banner) by the time `onLocked` fires here — this only covers
  // this screen's own reaction: the modal Alert, and leaving on acknowledgement.
  describe('access ending mid-read', () => {
    it('shows a compulsory alert and leaves the reader once acknowledged', async () => {
      mockAlertAutoPress = 'OK';
      const { getByText } = await renderReaderRoute('dev-sample-epub-locked');
      await waitFor(() => expect(getByText('lock')).toBeTruthy());

      await fireEvent.press(getByText('lock'));

      expect(mockAlert).toHaveBeenCalledWith(
        'Access ended',
        expect.stringContaining('licence expired'),
        expect.anything(),
        { cancelable: false },
      );
      expect(mockGoBack).toHaveBeenCalledTimes(1);
    });

    it('does not leave the reader while the alert sits unanswered', async () => {
      mockAlertAutoPress = null;
      const { getByText } = await renderReaderRoute('dev-sample-epub-locked-pending');
      await waitFor(() => expect(getByText('lock')).toBeTruthy());

      await fireEvent.press(getByText('lock'));

      expect(mockAlert).toHaveBeenCalled();
      expect(mockGoBack).not.toHaveBeenCalled();
    });
  });

  describe('cross-device conflict while the screen is open', () => {
    it('does not prompt when a progressStore notification reflects what is already displayed', async () => {
      mockCurrentLocator.mockResolvedValueOnce(null);
      const { getByText, unmount } = await renderReaderRoute('dev-sample-epub-conflict-echo');
      await waitFor(() => expect(getByText('relocate')).toBeTruthy());

      await fireEvent.press(getByText('relocate')); // displayed becomes { type: 'PDF', page: 7 }

      // Same as displayed — an unchanged row, or an echo of this device's own write.
      mockCurrentLocator.mockResolvedValueOnce({ type: 'PDF', page: 7 });
      await act(async () => {
        notifyProgressChanged();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockAlert).not.toHaveBeenCalled();
      await act(async () => {
        unmount();
      });
    });

    it('prompts and adopts the incoming position as a new initialTarget on "Resume from there"', async () => {
      mockCurrentLocator.mockResolvedValueOnce(null);
      const { getByText, unmount } = await renderReaderRoute('dev-sample-epub-conflict-jump');
      await waitFor(() => expect(getByText('relocate')).toBeTruthy());

      await fireEvent.press(getByText('relocate')); // displayed becomes { type: 'PDF', page: 7 }
      mockSavePosition.mockClear();

      mockCurrentLocator.mockResolvedValueOnce({ type: 'PDF', page: 20 });
      mockAlertAutoPress = 'Resume from there';
      await act(async () => {
        notifyProgressChanged();
        await Promise.resolve();
        await Promise.resolve();
      });

      // A remount with the adopted target — the mocked ReaderScreen renders again and pushes a
      // fresh entry, distinct from the one recorded at initial mount.
      expect(mockReceivedProps[mockReceivedProps.length - 1]).toEqual({
        bookId: 'dev-sample-epub-conflict-jump',
        initialTarget: { kind: 'page', page: 20 },
      });
      expect(mockAlert).toHaveBeenCalledWith(
        'Reading progress updated',
        expect.any(String),
        expect.any(Array),
        // Compulsory to resolve — not dismissible by tapping outside or the Android back button.
        { cancelable: false },
      );
      // Adopting is not itself a write — it's a read the user chose to trust.
      expect(mockSavePosition).not.toHaveBeenCalled();
      await act(async () => {
        unmount();
      });
    });

    it('pauses TTS before showing the Alert, and names it in the message when it was speaking', async () => {
      mockCurrentLocator.mockResolvedValueOnce(null);
      const { getByText, unmount } = await renderReaderRoute('dev-sample-epub-conflict-tts');
      await waitFor(() => expect(getByText('relocate')).toBeTruthy());
      await fireEvent.press(getByText('relocate'));

      mockPauseTtsIfSpeaking.mockReturnValue(true);
      mockCurrentLocator.mockResolvedValueOnce({ type: 'PDF', page: 20 });
      await act(async () => {
        notifyProgressChanged();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockPauseTtsIfSpeaking).toHaveBeenCalledTimes(1);
      expect(mockAlert).toHaveBeenCalledWith(
        'Reading progress updated',
        expect.stringContaining('Text-to-speech has been paused'),
        expect.any(Array),
        { cancelable: false },
      );
      await act(async () => {
        unmount();
      });
    });

    it('does not mention TTS in the message when nothing was speaking', async () => {
      mockCurrentLocator.mockResolvedValueOnce(null);
      const { getByText, unmount } = await renderReaderRoute('dev-sample-epub-conflict-no-tts');
      await waitFor(() => expect(getByText('relocate')).toBeTruthy());
      await fireEvent.press(getByText('relocate'));

      mockPauseTtsIfSpeaking.mockReturnValue(false);
      mockCurrentLocator.mockResolvedValueOnce({ type: 'PDF', page: 20 });
      await act(async () => {
        notifyProgressChanged();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockPauseTtsIfSpeaking).toHaveBeenCalledTimes(1);
      expect(mockAlert).toHaveBeenCalledWith(
        'Reading progress updated',
        expect.not.stringContaining('Text-to-speech'),
        expect.any(Array),
        { cancelable: false },
      );
      await act(async () => {
        unmount();
      });
    });

    it('pushes the current on-screen position back out, unchanged, on "Continue here"', async () => {
      mockCurrentLocator.mockResolvedValueOnce(null);
      const { getByText, unmount } = await renderReaderRoute('dev-sample-epub-conflict-stay');
      await waitFor(() => expect(getByText('relocate')).toBeTruthy());

      await fireEvent.press(getByText('relocate')); // displayed becomes { type: 'PDF', page: 7 }
      mockSavePosition.mockClear();
      const lastReceivedBeforeAnswer = mockReceivedProps[mockReceivedProps.length - 1];

      mockCurrentLocator.mockResolvedValueOnce({ type: 'PDF', page: 20 });
      mockAlertAutoPress = 'Continue here';
      await act(async () => {
        notifyProgressChanged();
        await Promise.resolve();
        await Promise.resolve();
      });

      // Pushes THIS device's displayed position — not the incoming page 20 — with a fresh
      // timestamp, so it wins the next comparison anywhere else this book syncs to.
      expect(mockSavePosition).toHaveBeenCalledWith(
        { type: 'PDF', page: 7 },
        'dev-sample-epub-conflict-stay',
      );
      // No remount: the screen keeps showing what it already had.
      expect(mockReceivedProps[mockReceivedProps.length - 1]).toEqual(lastReceivedBeforeAnswer);
      await act(async () => {
        unmount();
      });
    });

    it('adopts the LATEST incoming locator, not the first, when a dialog is left open through a second notification', async () => {
      mockCurrentLocator.mockResolvedValueOnce(null);
      const { getByText, unmount } = await renderReaderRoute('dev-sample-epub-conflict-stale');
      await waitFor(() => expect(getByText('relocate')).toBeTruthy());

      await fireEvent.press(getByText('relocate')); // displayed becomes { type: 'PDF', page: 7 }

      // First notification shows the Alert, left unanswered (mockAlertAutoPress stays null).
      mockCurrentLocator.mockResolvedValueOnce({ type: 'PDF', page: 20 });
      await act(async () => {
        notifyProgressChanged();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockAlert).toHaveBeenCalledTimes(1);

      // A second device write arrives before the user answers. No second Alert (one is already
      // up) — but the value the eventual answer acts on must move.
      mockCurrentLocator.mockResolvedValueOnce({ type: 'PDF', page: 35 });
      await act(async () => {
        notifyProgressChanged();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockAlert).toHaveBeenCalledTimes(1);

      // The user finally answers the still-showing (first) dialog.
      const buttons = mockAlert.mock.calls[0][2] as { text: string; onPress?: () => void }[];
      const resumeButton = buttons.find((candidate) => candidate.text === 'Resume from there');
      await act(async () => {
        resumeButton?.onPress?.();
      });

      expect(mockReceivedProps[mockReceivedProps.length - 1]).toEqual({
        bookId: 'dev-sample-epub-conflict-stale',
        initialTarget: { kind: 'page', page: 35 },
      });
      await act(async () => {
        unmount();
      });
    });
  });

  describe('live sync while the screen is open and foregrounded', () => {
    let appStateSpy: jest.SpyInstance;

    // Same shape as src/features/reader/audio/audioScratchReclaimer.test.ts's own helper — grabs
    // the LAST registered listener by design: the background-flush effect above registers its own
    // listener at mount (index 0) and is never the one these tests are driving.
    function emitAppStateChange(state: 'active' | 'background'): void {
      const calls = (AppState.addEventListener as jest.Mock).mock.calls;
      const handler = calls[calls.length - 1][1] as (s: string) => void;
      handler(state);
    }

    beforeEach(() => {
      appStateSpy = jest
        .spyOn(AppState, 'addEventListener')
        .mockReturnValue({ remove: jest.fn() } as never);
    });

    afterEach(() => {
      appStateSpy.mockRestore();
      // Unconditional, not just at the end of the interval test below: a test that throws before
      // its own cleanup must not leak fake timers into another file in the same Jest worker — see
      // commit 4752229's own note on why ReaderScreen.test.tsx needed this same safety net.
      jest.useRealTimers();
    });

    it('pulls again on the edge into active, not on every AppState change', async () => {
      const { unmount } = await renderReaderRoute('dev-sample-epub-live-pull-foreground');
      await waitFor(() => expect(mockSyncRun).toHaveBeenCalledTimes(1)); // the resume-time run

      await act(async () => {
        emitAppStateChange('background');
      });
      expect(mockSyncRun).toHaveBeenCalledTimes(1); // backgrounding alone must not pull

      await act(async () => {
        emitAppStateChange('active');
      });
      expect(mockSyncRun).toHaveBeenCalledTimes(2);

      await act(async () => {
        unmount();
      });
    });

    it('tops up an undownloaded book on the foreground edge too, not only at resume', async () => {
      mockCurrentForBook.mockResolvedValue(null); // not downloaded, for the whole test
      const { unmount } = await renderReaderRoute('dev-sample-epub-live-pull-undownloaded');
      await waitFor(() => expect(mockPullBook).toHaveBeenCalledTimes(1)); // the resume-time top-up

      await act(async () => {
        emitAppStateChange('active');
      });

      // `syncEngine.run()`'s own regular sweep never refreshes progress for a book with no local
      // `downloads` row (see syncEngine.ts's `pullBook` doc) — without this, the live poll would
      // silently never learn of a cross-device write for this book, no matter how long it ran.
      expect(mockPullBook).toHaveBeenCalledTimes(2);
      await act(async () => {
        unmount();
      });
    });

    it('polls every READER_LIVE_SYNC_POLL_MS while foregrounded, and stops while backgrounded', async () => {
      const { unmount } = await renderReaderRoute('dev-sample-epub-live-pull-interval');
      await waitFor(() => expect(mockSyncRun).toHaveBeenCalledTimes(1));

      // The interval created at mount runs under REAL timers — `waitFor` above depends on real
      // `setTimeout` to poll, so fake timers can't be active yet. Stop that interval, switch to
      // fake timers, then drive the same active edge a real foreground would: `startPoll()`
      // creates a FRESH `setInterval`, this time inside `jest.useFakeTimers()`'s clock, which is
      // the one `advanceTimersByTime` below can actually see.
      await act(async () => {
        emitAppStateChange('background');
      });
      jest.useFakeTimers();
      await act(async () => {
        emitAppStateChange('active');
      });
      expect(mockSyncRun).toHaveBeenCalledTimes(2); // the foreground-edge pull itself

      await act(async () => {
        jest.advanceTimersByTime(120_000);
      });
      expect(mockSyncRun).toHaveBeenCalledTimes(3);

      await act(async () => {
        emitAppStateChange('background');
      });
      await act(async () => {
        jest.advanceTimersByTime(120_000);
      });
      expect(mockSyncRun).toHaveBeenCalledTimes(3); // no poll while backgrounded

      jest.useRealTimers();
      await act(async () => {
        unmount();
      });
    });
  });

});
