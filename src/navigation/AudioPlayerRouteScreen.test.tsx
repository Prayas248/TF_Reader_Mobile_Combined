// Owner: Reader (Ahana).
//
// Covers AudioPlayerRouteScreen's own contract — wiring route params into AudioPlayerScreen's
// `bookId`/`title` and the progressStore-backed resume/commit/play-gate props — not
// AudioPlayerScreen's own behaviour, which has its own test file. Mocked to an inert stub so this
// only exercises the glue, same pattern ReaderRouteScreen.test.tsx uses for ReaderScreen.
//
// progressStore itself is mocked rather than exercised against real SQLite: this file is testing
// AudioPlayerRouteScreen's wiring (does it call currentLocator/savePosition with the right
// arguments, does it gate on the async read), not progressStore's own correctness — that lives in
// src/features/sync/contractConformance.test.ts. syncEngine.run() is mocked too, for the same
// reason — this file checks that it is awaited BEFORE the local read, not that a real sync does
// anything.
//
// `Alert.alert` auto-presses a configured button synchronously (not a captured closure re-invoked
// later, outside any `act()` scope) — see ReaderRouteScreen.test.tsx's header for why that specific
// shape is load-bearing, not a style choice.
//
// `progressStore.subscribe` IS covered here now, unlike before this file's live-conflict-while-
// playing effect existed — faked with a real listener registry, same shape ReaderRouteScreen's own
// test file uses, so a test can fire a notification the way a completed sync pull would.

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert, AppState } from 'react-native';

import type { Locator } from '@/shared/contracts';
import { useAudioQueueStore } from '@/features/reader/audio/audioQueueStore';

import { AudioPlayerRouteScreen } from './AudioPlayerRouteScreen';

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

const mockPullBook = jest.fn().mockResolvedValue(undefined);

jest.mock('@/features/sync/syncEngine', () => ({
  syncEngine: {
    run: () => {
      callOrder.push('run');
      return mockSyncRun();
    },
    pullBook: (...args: unknown[]) => mockPullBook(...args),
  },
}));

const mockCurrentForBook = jest.fn().mockResolvedValue(null);

jest.mock('@/features/sync/stores/downloadStore', () => ({
  downloadStore: {
    currentForBook: (...args: unknown[]) => mockCurrentForBook(...args),
  },
}));

// `mock`-prefixed, per babel-plugin-jest-hoist's naming exception — see ReaderRouteScreen.test.tsx's
// own comment on why this can't just be a plain top-level array.
const mockReceivedProps: { bookId?: string; title?: string; initialPosition?: number }[] = [];
// Controls what the mocked `AudioPlayerScreenHandle` reports — `false`/`0` by default (paused,
// nothing to compare live against), overridden per test to exercise the live-conflict effect.
const mockIsPlaying = jest.fn<boolean, []>();
const mockCurrentPositionSeconds = jest.fn<number, []>();
const mockPause = jest.fn();

jest.mock('@/features/reader/audio/AudioPlayerScreen', () => {
  // require(), not a top-level import: babel-plugin-jest-hoist forbids a jest.mock() factory from
  // closing over any out-of-scope import binding (only `mock`-prefixed variables and a handful of
  // globals are allowed) — same reasoning as mockReceivedProps's naming above.
  /* eslint-disable-next-line @typescript-eslint/no-require-imports -- see comment above */
  const { forwardRef, useImperativeHandle } = require('react');
  return {
    AudioPlayerScreen: forwardRef(function MockAudioPlayerScreen(
      props: {
        bookId: string;
        title: string;
        initialPosition?: number;
        onPositionChange?: (p: number) => void;
        onPositionCommit?: (p: number) => void;
        onBeforePlay?: () => Promise<boolean>;
      },
      ref: unknown,
    ) {
      mockReceivedProps.push({
        bookId: props.bookId,
        title: props.title,
        initialPosition: props.initialPosition,
      });
      useImperativeHandle(ref, () => ({
        isPlaying: mockIsPlaying,
        currentPositionSeconds: mockCurrentPositionSeconds,
        pause: mockPause,
      }));
      /* eslint-disable-next-line @typescript-eslint/no-require-imports -- see comment above */
      const { View, Text: RNText } = require('react-native');
      return (
        <View>
          <RNText>{`playing ${props.bookId}`}</RNText>
          <RNText onPress={() => props.onPositionChange?.(42)}>advance</RNText>
          <RNText onPress={() => props.onPositionCommit?.(99)}>commit</RNText>
          <RNText onPress={() => void props.onBeforePlay?.()}>play</RNText>
        </View>
      );
    }),
  };
});

// Mirrors ItemDetailScreen.test.tsx's/ReaderRouteScreen.test.tsx's own `mockGetParent` —
// AudioPlayerRouteScreen now hides the shared tab bar the same way those screens do.
const mockGetParent = jest.fn(() => ({ setOptions: jest.fn() }));

// `render` is ASYNC in @testing-library/react-native v14 — see App.test.tsx's own note.
function renderAudioPlayerRoute(bookId: string, title = 'Audiobook') {
  return render(
    <AudioPlayerRouteScreen
      navigation={{ setOptions: jest.fn(), getParent: mockGetParent } as never}
      route={{ key: 'AudioPlayer', name: 'AudioPlayer', params: { bookId, title } } as never}
    />,
  );
}

// Which button (by text) to auto-press the MOMENT `Alert.alert` is called — see this file's header.
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

describe('AudioPlayerRouteScreen', () => {
  beforeEach(() => {
    mockReceivedProps.length = 0;
    callOrder.length = 0;
    mockProgressListeners = [];
    mockAlertAutoPress = null;
    mockCurrentLocator.mockReset();
    mockSavePosition.mockReset();
    mockSyncRun.mockReset();
    mockAlert.mockClear();
    mockIsPlaying.mockReset();
    mockCurrentPositionSeconds.mockReset();
    mockPause.mockReset();
    mockPullBook.mockReset();
    mockCurrentForBook.mockReset();
    mockGetParent.mockClear();
    mockCurrentLocator.mockResolvedValue(null);
    mockSyncRun.mockResolvedValue(undefined);
    mockIsPlaying.mockReturnValue(false);
    mockCurrentPositionSeconds.mockReturnValue(0);
    mockPullBook.mockResolvedValue(undefined);
    mockCurrentForBook.mockResolvedValue(null);
    useAudioQueueStore.getState().clearQueue();
  });

  it('passes the route bookId and title through to AudioPlayerScreen once resolved, after awaiting a sync run first', async () => {
    const { getByText } = await renderAudioPlayerRoute('dev-sample-audio', 'Audiobook');
    await waitFor(() => expect(getByText('playing dev-sample-audio')).toBeTruthy());
    expect(mockReceivedProps[0]).toEqual({
      bookId: 'dev-sample-audio',
      title: 'Audiobook',
      initialPosition: undefined,
    });
    expect(mockCurrentLocator).toHaveBeenCalledWith(undefined, 'dev-sample-audio');
    // ORDER MATTERS: a local read before the sync lands would resume from a position another
    // device may have already advanced past while this device was merely backgrounded, not
    // relaunched — see AudioPlayerRouteScreen.tsx's header for the full account of that gap.
    expect(callOrder).toEqual(['run', 'currentLocator']);
  });

  describe('an audiobook read online without ever being downloaded', () => {
    it('tops up via pullBook before reading the local resume position', async () => {
      mockCurrentForBook.mockResolvedValue(null); // not downloaded

      await renderAudioPlayerRoute('dev-sample-audio-undownloaded');

      expect(mockCurrentForBook).toHaveBeenCalledWith('dev-sample-audio-undownloaded');
      expect(mockPullBook).toHaveBeenCalledWith('dev-sample-audio-undownloaded');
      expect(mockCurrentLocator).toHaveBeenCalledWith(undefined, 'dev-sample-audio-undownloaded');
    });

    it('does not call pullBook for an audiobook this device already has downloaded', async () => {
      mockCurrentForBook.mockResolvedValue({ id: 'dl-1', book_id: 'dev-sample-audio-downloaded' });

      await renderAudioPlayerRoute('dev-sample-audio-downloaded');

      expect(mockPullBook).not.toHaveBeenCalled();
    });
  });

  it('resumes at the AUDIO position stored in progressStore, converted from ms to seconds', async () => {
    mockCurrentLocator.mockResolvedValue({ type: 'AUDIO', positionMs: 90_000 });

    const { getByText } = await renderAudioPlayerRoute('dev-sample-audio-resume');

    await waitFor(() => expect(getByText('playing dev-sample-audio-resume')).toBeTruthy());
    expect(mockReceivedProps[0]).toEqual({
      bookId: 'dev-sample-audio-resume',
      title: 'Audiobook',
      initialPosition: 90,
    });
  });

  it('ignores a stored locator that is not AUDIO-shaped', async () => {
    mockCurrentLocator.mockResolvedValue({ type: 'PDF', page: 4 });

    const { getByText } = await renderAudioPlayerRoute('dev-sample-audio-pdf-locator');

    await waitFor(() => expect(getByText('playing dev-sample-audio-pdf-locator')).toBeTruthy());
    expect(mockReceivedProps[0]?.initialPosition).toBeUndefined();
  });

  it('writes a position change into progressStore as an AUDIO locator in milliseconds', async () => {
    const { getByText } = await renderAudioPlayerRoute('dev-sample-audio-mirror');
    await waitFor(() => expect(getByText('playing dev-sample-audio-mirror')).toBeTruthy());

    await act(async () => {
      await fireEvent.press(getByText('advance'));
    });

    expect(mockSavePosition).toHaveBeenCalledWith(
      { type: 'AUDIO', positionMs: 42_000 },
      'dev-sample-audio-mirror',
    );
  });

  it('commit bypasses the write throttle', async () => {
    const { getByText } = await renderAudioPlayerRoute('dev-sample-audio-commit');
    await waitFor(() => expect(getByText('playing dev-sample-audio-commit')).toBeTruthy());

    await act(async () => {
      await fireEvent.press(getByText('advance'));
    });
    mockSavePosition.mockClear();

    // A second onPositionChange inside the throttle window is dropped...
    await act(async () => {
      await fireEvent.press(getByText('advance'));
    });
    expect(mockSavePosition).not.toHaveBeenCalled();

    // ...but a commit at the same moment always writes through.
    await act(async () => {
      await fireEvent.press(getByText('commit'));
    });
    expect(mockSavePosition).toHaveBeenCalledWith(
      { type: 'AUDIO', positionMs: 99_000 },
      'dev-sample-audio-commit',
    );
  });

  describe('the play-gate (onBeforePlay)', () => {
    it('allows play immediately when nothing paused-and-known exists yet — a fresh book', async () => {
      mockCurrentLocator.mockResolvedValueOnce(null);
      const { getByText } = await renderAudioPlayerRoute('dev-sample-audio-gate-fresh');
      await waitFor(() => expect(getByText('play')).toBeTruthy());
      callOrder.length = 0; // clear the resolve effect's own run/currentLocator pair

      await act(async () => {
        await fireEvent.press(getByText('play'));
      });

      // No paused position is known yet, so the gate never re-syncs or re-reads — it just allows.
      expect(callOrder).toEqual([]);
      expect(mockAlert).not.toHaveBeenCalled();
    });

    it('allows play when the fresh read is within the 5s tolerance of the paused position', async () => {
      mockCurrentLocator.mockResolvedValueOnce({ type: 'AUDIO', positionMs: 90_000 });
      const { getByText } = await renderAudioPlayerRoute('dev-sample-audio-gate-close');
      await waitFor(() => expect(getByText('play')).toBeTruthy());

      mockCurrentLocator.mockResolvedValueOnce({ type: 'AUDIO', positionMs: 93_000 }); // 3s off
      await act(async () => {
        await fireEvent.press(getByText('play'));
      });

      expect(mockAlert).not.toHaveBeenCalled();
    });

    it('silently adopts a within-tolerance read as the new baseline for the NEXT check', async () => {
      mockCurrentLocator.mockResolvedValueOnce({ type: 'AUDIO', positionMs: 90_000 });
      const { getByText, unmount } = await renderAudioPlayerRoute('dev-sample-audio-gate-drift');
      await waitFor(() => expect(getByText('play')).toBeTruthy());

      // First press: 3s off (within tolerance) — resolved silently, no alert, but the LWW-resolved
      // 93s becomes this device's confirmed position going forward.
      mockCurrentLocator.mockResolvedValueOnce({ type: 'AUDIO', positionMs: 93_000 });
      await act(async () => {
        await fireEvent.press(getByText('play'));
      });
      expect(mockAlert).not.toHaveBeenCalled();

      // Second press: a real conflict, far enough from the ADOPTED 93s (not the original 90s) to
      // prompt. If the silent adoption above hadn't updated the baseline, this would still compare
      // against 90s and "Continue here" would push the stale value.
      mockCurrentLocator.mockResolvedValueOnce({ type: 'AUDIO', positionMs: 200_000 });
      mockAlertAutoPress = 'Continue here';
      await act(async () => {
        await fireEvent.press(getByText('play'));
      });

      expect(mockSavePosition).toHaveBeenCalledWith(
        { type: 'AUDIO', positionMs: 93_000 },
        'dev-sample-audio-gate-drift',
      );
      await act(async () => {
        unmount();
      });
    });

    it('prompts when the fresh read diverges by more than 5s, and pushes the paused position through on "Continue here"', async () => {
      mockCurrentLocator.mockResolvedValueOnce({ type: 'AUDIO', positionMs: 90_000 });
      const { getByText, unmount } = await renderAudioPlayerRoute('dev-sample-audio-gate-continue');
      await waitFor(() => expect(getByText('play')).toBeTruthy());

      mockCurrentLocator.mockResolvedValueOnce({ type: 'AUDIO', positionMs: 200_000 });
      mockAlertAutoPress = 'Continue here';
      await act(async () => {
        await fireEvent.press(getByText('play'));
      });

      expect(mockAlert).toHaveBeenCalledWith(
        'Playback progress updated',
        expect.any(String),
        expect.any(Array),
        // Compulsory to resolve — not dismissible by tapping outside or the Android back button.
        { cancelable: false },
      );
      // Re-confirms THIS device's (paused) position — 90s, not the incoming 200s.
      expect(mockSavePosition).toHaveBeenCalledWith(
        { type: 'AUDIO', positionMs: 90_000 },
        'dev-sample-audio-gate-continue',
      );
      // No remount: the resolved position for this screen is unchanged.
      expect(mockReceivedProps[mockReceivedProps.length - 1]).toEqual({
        bookId: 'dev-sample-audio-gate-continue',
        title: 'Audiobook',
        initialPosition: 90,
      });
      await act(async () => {
        unmount();
      });
    });

    it('adopts the incoming position and remounts on "Resume from there", without writing', async () => {
      mockCurrentLocator.mockResolvedValueOnce({ type: 'AUDIO', positionMs: 90_000 });
      const { getByText, unmount } = await renderAudioPlayerRoute('dev-sample-audio-gate-jump');
      await waitFor(() => expect(getByText('play')).toBeTruthy());

      mockCurrentLocator.mockResolvedValueOnce({ type: 'AUDIO', positionMs: 200_000 });
      mockAlertAutoPress = 'Resume from there';
      await act(async () => {
        await fireEvent.press(getByText('play'));
      });

      expect(mockReceivedProps[mockReceivedProps.length - 1]).toEqual({
        bookId: 'dev-sample-audio-gate-jump',
        title: 'Audiobook',
        initialPosition: 200,
      });
      // Adopting is not itself a write — it's a read the user chose to trust.
      expect(mockSavePosition).not.toHaveBeenCalled();
      await act(async () => {
        unmount();
      });
    });
  });

  describe('live cross-device conflict while playing', () => {
    it('does nothing while paused — that case belongs to the play-gate, not this effect', async () => {
      mockCurrentLocator.mockResolvedValueOnce(null);
      const { getByText, unmount } = await renderAudioPlayerRoute('dev-sample-audio-live-paused');
      await waitFor(() => expect(getByText('play')).toBeTruthy());

      mockIsPlaying.mockReturnValue(false);
      mockCurrentLocator.mockResolvedValueOnce({ type: 'AUDIO', positionMs: 200_000 });
      await act(async () => {
        notifyProgressChanged();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockPause).not.toHaveBeenCalled();
      expect(mockAlert).not.toHaveBeenCalled();
      await act(async () => {
        unmount();
      });
    });

    it('ignores a within-threshold difference while playing — an echo of its own throttled write', async () => {
      mockCurrentLocator.mockResolvedValueOnce(null);
      const { getByText, unmount } = await renderAudioPlayerRoute('dev-sample-audio-live-echo');
      await waitFor(() => expect(getByText('play')).toBeTruthy());

      mockIsPlaying.mockReturnValue(true);
      mockCurrentPositionSeconds.mockReturnValue(100);
      mockCurrentLocator.mockResolvedValueOnce({ type: 'AUDIO', positionMs: 102_000 }); // 2s diff
      await act(async () => {
        notifyProgressChanged();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockPause).not.toHaveBeenCalled();
      expect(mockAlert).not.toHaveBeenCalled();
      await act(async () => {
        unmount();
      });
    });

    it('pauses and prompts on a genuine divergence while playing, using the POST-pause position for "Continue here"', async () => {
      mockCurrentLocator.mockResolvedValueOnce(null);
      const { getByText, unmount } = await renderAudioPlayerRoute('dev-sample-audio-live-conflict');
      await waitFor(() => expect(getByText('play')).toBeTruthy());

      mockIsPlaying.mockReturnValue(true);
      // First read (pre-await, for the threshold check) vs. second read (post-pause, for "Continue
      // here") deliberately differ — the player kept moving during the `currentLocator()` await.
      mockCurrentPositionSeconds.mockReturnValueOnce(100).mockReturnValueOnce(100.5);
      mockCurrentLocator.mockResolvedValueOnce({ type: 'AUDIO', positionMs: 500_000 }); // far off
      mockAlertAutoPress = 'Continue here';
      await act(async () => {
        notifyProgressChanged();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockPause).toHaveBeenCalledTimes(1);
      expect(mockAlert).toHaveBeenCalledWith(
        'Playback progress updated',
        expect.stringContaining('Playback has been paused'),
        expect.any(Array),
        { cancelable: false },
      );
      expect(mockSavePosition).toHaveBeenCalledWith(
        { type: 'AUDIO', positionMs: 100_500 }, // the POST-pause read, not the pre-await one
        'dev-sample-audio-live-conflict',
      );
      await act(async () => {
        unmount();
      });
    });

    it('adopts the incoming position and remounts on "Resume from there", while playing', async () => {
      mockCurrentLocator.mockResolvedValueOnce(null);
      const { getByText, unmount } = await renderAudioPlayerRoute('dev-sample-audio-live-jump');
      await waitFor(() => expect(getByText('play')).toBeTruthy());

      mockIsPlaying.mockReturnValue(true);
      mockCurrentPositionSeconds.mockReturnValue(100);
      mockCurrentLocator.mockResolvedValueOnce({ type: 'AUDIO', positionMs: 500_000 });
      mockAlertAutoPress = 'Resume from there';
      await act(async () => {
        notifyProgressChanged();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockPause).toHaveBeenCalledTimes(1);
      expect(mockReceivedProps[mockReceivedProps.length - 1]).toEqual({
        bookId: 'dev-sample-audio-live-jump',
        title: 'Audiobook',
        initialPosition: 500,
      });
      expect(mockSavePosition).not.toHaveBeenCalled();
      await act(async () => {
        unmount();
      });
    });

    it('adopts the LATEST incoming position when a second notification lands before the dialog is answered', async () => {
      mockCurrentLocator.mockResolvedValueOnce(null);
      const { getByText, unmount } = await renderAudioPlayerRoute('dev-sample-audio-live-stale');
      await waitFor(() => expect(getByText('play')).toBeTruthy());

      // Deliberately left `true` for BOTH notifications below: the mock does not simulate `pause()`
      // actually flipping playback state (that is real player behaviour, not this test's concern),
      // and the point of this test is specifically that `latestIncomingRef` keeps advancing even
      // while `conflictPendingRef` is already set — the `isPlaying()` gate is orthogonal to that.
      mockIsPlaying.mockReturnValue(true);
      mockCurrentPositionSeconds.mockReturnValue(100);

      // First notification triggers the Alert, left unanswered (mockAlertAutoPress stays null).
      mockCurrentLocator.mockResolvedValueOnce({ type: 'AUDIO', positionMs: 500_000 });
      await act(async () => {
        notifyProgressChanged();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockAlert).toHaveBeenCalledTimes(1);
      expect(mockPause).toHaveBeenCalledTimes(1);

      // A second, even newer write arrives before the dialog is answered. No second Alert (one is
      // already up) — but the value the eventual answer acts on must move.
      mockCurrentLocator.mockResolvedValueOnce({ type: 'AUDIO', positionMs: 700_000 });
      await act(async () => {
        notifyProgressChanged();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockAlert).toHaveBeenCalledTimes(1); // still just the one dialog

      // The user finally answers the still-showing (first) dialog.
      const buttons = mockAlert.mock.calls[0][2] as { text: string; onPress?: () => void }[];
      const resumeButton = buttons.find((candidate) => candidate.text === 'Resume from there');
      await act(async () => {
        resumeButton?.onPress?.();
      });

      expect(mockReceivedProps[mockReceivedProps.length - 1]).toEqual({
        bookId: 'dev-sample-audio-live-stale',
        title: 'Audiobook',
        initialPosition: 700,
      });
      await act(async () => {
        unmount();
      });
    });
  });

  describe('the pull half of live conflict detection', () => {
    let appStateSpy: jest.SpyInstance;

    // Same shape as ReaderRouteScreen.test.tsx's own helper — grabs the LAST registered listener,
    // which is this effect's, since it is the only `AppState.addEventListener` call in this file.
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
      jest.useRealTimers();
    });

    it('pulls again on the edge into active, not on every AppState change', async () => {
      const { getByText, unmount } = await renderAudioPlayerRoute('dev-sample-audio-pull-fg');
      await waitFor(() => expect(getByText('play')).toBeTruthy());
      expect(mockSyncRun).toHaveBeenCalledTimes(1); // the resume-time run

      await act(async () => {
        emitAppStateChange('background');
      });
      expect(mockSyncRun).toHaveBeenCalledTimes(1);

      await act(async () => {
        emitAppStateChange('active');
      });
      expect(mockSyncRun).toHaveBeenCalledTimes(2);

      await act(async () => {
        unmount();
      });
    });

    it('tops up an undownloaded audiobook on the foreground edge too, not only at resume', async () => {
      mockCurrentForBook.mockResolvedValue(null); // not downloaded, for the whole test
      const { getByText, unmount } = await renderAudioPlayerRoute('dev-sample-audio-pull-undownloaded');
      await waitFor(() => expect(getByText('play')).toBeTruthy());
      expect(mockPullBook).toHaveBeenCalledTimes(1); // the resume-time top-up

      await act(async () => {
        emitAppStateChange('active');
      });

      // syncEngine.run()'s own regular sweep never refreshes progress for a book with no local
      // `downloads` row — without this, neither the poll nor the play-gate would ever learn of a
      // cross-device write for a streamed-without-downloading audiobook.
      expect(mockPullBook).toHaveBeenCalledTimes(2);
      await act(async () => {
        unmount();
      });
    });

    it('polls every AUDIO_LIVE_SYNC_POLL_MS while foregrounded, and stops while backgrounded', async () => {
      const { getByText, unmount } = await renderAudioPlayerRoute('dev-sample-audio-pull-interval');
      await waitFor(() => expect(getByText('play')).toBeTruthy());
      expect(mockSyncRun).toHaveBeenCalledTimes(1);

      // See ReaderRouteScreen.test.tsx's identical test for why the interval must be re-armed
      // under fake timers rather than advanced directly — the one created at mount runs under
      // REAL timers, which `waitFor` above depends on.
      await act(async () => {
        emitAppStateChange('background');
      });
      jest.useFakeTimers();
      await act(async () => {
        emitAppStateChange('active');
      });
      expect(mockSyncRun).toHaveBeenCalledTimes(2);

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

  describe('queue synchronization', () => {
    it('updates route params when the audio queue advances to a different book', async () => {
      const mockSetParams = jest.fn();
      useAudioQueueStore.getState().setQueue(
        [
          { bookId: 'book-current' as never, title: 'Current Title' },
          { bookId: 'book-next' as never, title: 'Next Title' },
        ],
        0,
      );

      const { getByText, unmount } = await render(
        <AudioPlayerRouteScreen
          navigation={{ setOptions: jest.fn(), setParams: mockSetParams, getParent: mockGetParent } as never}
          route={
            {
              key: 'AudioPlayer',
              name: 'AudioPlayer',
              params: { bookId: 'book-current', title: 'Current Title' },
            } as never
          }
        />,
      );
      await waitFor(() => expect(getByText('playing book-current')).toBeTruthy());

      await act(async () => {
        useAudioQueueStore.getState().skipToNext();
      });

      expect(mockSetParams).toHaveBeenCalledWith({
        bookId: 'book-next',
        title: 'Next Title',
      });

      await act(async () => {
        unmount();
      });
    });

    it('preserves existing queue items when opened with a new book not in queue', async () => {
      useAudioQueueStore.getState().setQueue(
        [
          { bookId: 'book-1' as never, title: 'Book 1' },
          { bookId: 'book-2' as never, title: 'Book 2' },
        ],
        0,
      );

      const { getByText, unmount } = await render(
        <AudioPlayerRouteScreen
          navigation={{ setOptions: jest.fn(), setParams: jest.fn(), getParent: mockGetParent } as never}
          route={
            {
              key: 'AudioPlayer',
              name: 'AudioPlayer',
              params: { bookId: 'book-3', title: 'Book 3' },
            } as never
          }
        />,
      );
      await waitFor(() => expect(getByText('playing book-3')).toBeTruthy());

      const state = useAudioQueueStore.getState();
      expect(state.items).toHaveLength(3);
      expect(state.items[0].bookId).toBe('book-1');
      expect(state.items[1].bookId).toBe('book-2');
      expect(state.items[2].bookId).toBe('book-3');
      expect(state.currentIndex).toBe(2);

      await act(async () => {
        unmount();
      });
    });
  });
});
