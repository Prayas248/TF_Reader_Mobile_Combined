// Owner: Reader (Ahana).
//
// AUDIO PHASE 3. Exercises AudioPlayerScreen's own contract: the resolve -> play flow (loading,
// error, and loaded states), transport wiring (play/pause, skip ±15s, speed), and the lock-screen/
// position-change side effects — against a fully controllable fake player, not the generic
// "proves reachable" root mock (__mocks__/expo-audio.js) that file's own header says is NOT meant
// to prove correctness. audioAssetResolver/audioPlayerInstance are mocked too — this
// is a unit test of AudioPlayerScreen's own wiring, not of the acquisition path
// (audioAssetResolver.test.ts already covers that, for real,
// against real contentStore/file I/O).
//
// audioPlayerInstance.getAudioPlayerFor IS MOCKED, NOT expo-audio's useAudioPlayer — a REAL-DEVICE
// FIX changed AudioPlayerScreen.tsx to get its player from a module-level singleton
// (audioPlayerInstance.ts) rather than the auto-releasing useAudioPlayer hook (see that file's own
// header for why: the hook tore down the native player on every "back" navigation, which is
// backwards for background playback and crashed as ERR_NATIVE_SHARED_OBJECT_NOT_FOUND on a real
// device). This file's fake mirrors that shape: one fake player object, and a controllable
// `mockIsNewAudioPlayer` flag for the "reused, already-playing player must not be re-seeked" case.
//
// NO MANUAL rerender() ANYWHERE IN THIS FILE, DELIBERATELY. Calling RTL's rerender() more than
// once across this file's tests reliably corrupted every LATER test's ability to see
// mockResolveAudioAssetUri's own calls at all (not slow — genuinely never, even at a 5s timeout) —
// a real instability in this exact React/RNTL/Jest combination, not a logic bug in the component.
// The fix is structural, not a workaround: set fakePlayer.isLoaded = true (and any other status
// fields a test needs) BEFORE calling render(), so the component's OWN natural re-render — the one
// `setUri(...)` already triggers once the mocked resolver's promise resolves — picks up the
// already-true value with no manual re-render step at all. Each test also exercises exactly ONE
// interaction, for the same reason: chaining "press A, observe, press B" needs a re-render between
// them, and manufacturing one safely turned out not to be possible here.

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

import {
  allowScreenCaptureAsync,
  preventScreenCaptureAsync,
  READER_CAPTURE_KEY,
} from '@/features/reader/captureProtection';
import { OFFLINE_LOCK_EVENTS } from '@/shared/contracts';
import type { BookId } from '@/shared/contracts';
import { eventBus, resetEventBusForTests } from '@/shared/eventBus';

import { AudioPlayerScreen } from './AudioPlayerScreen';
import { useAudioQueueStore } from './audioQueueStore';
import {
  _resetAudioTtsCoordinatorForTests,
  registerActiveTtsSession,
} from './audioTtsCoordinator';

// `mock`-prefixed, per babel-plugin-jest-hoist's naming exception — see ReaderRouteScreen.test.tsx
// for the same convention.
const mockResolveAudioAssetUri = jest.fn();
let mockIsNewAudioPlayer = true;

// A single shared, plain-object fake player, module-scoped so both jest.mock() factories below
// (expo-audio's useAudioPlayerStatus, and audioPlayerInstance's getAudioPlayerFor) can hand back
// the exact same object AudioPlayerScreen.tsx will read from and call methods on. Tests set its
// fields BEFORE render() — see this file's header for why mutating it mid-test is avoided.
const mockFakePlayer = {
  playing: false,
  currentTime: 0,
  duration: 0,
  isLoaded: false,
  playbackRate: 1,
  play: jest.fn(() => {
    mockFakePlayer.playing = true;
  }),
  pause: jest.fn(() => {
    mockFakePlayer.playing = false;
  }),
  seekTo: jest.fn((seconds: number) => {
    mockFakePlayer.currentTime = seconds;
    return Promise.resolve();
  }),
  setPlaybackRate: jest.fn((rate: number) => {
    mockFakePlayer.playbackRate = rate;
  }),
  replace: jest.fn(),
  setActiveForLockScreen: jest.fn(),
  updateLockScreenMetadata: jest.fn(),
  clearLockScreenControls: jest.fn(),
  remove: jest.fn(),
};


jest.mock('./audioAssetResolver', () => ({
  audioAssetResolver: {
    resolveAudioAssetUri: (...args: unknown[]) => mockResolveAudioAssetUri(...args),
  },
}));

jest.mock('./audioPlayerInstance', () => ({
  getAudioPlayerFor: () => ({ player: mockFakePlayer, isNew: mockIsNewAudioPlayer }),
  getCurrentAudioPlayer: () => mockFakePlayer,
  registerTrackCompletionHandler: jest.fn(),
  switchActiveAudioTrack: jest.fn(),
}));

const mockSkipToNextTrack = jest.fn();
const mockSkipToPreviousTrack = jest.fn();
const mockJumpToQueueIndex = jest.fn();

jest.mock('./audioQueueCoordinator', () => ({
  skipToNextTrack: (...args: unknown[]) => mockSkipToNextTrack(...args),
  skipToPreviousTrack: (...args: unknown[]) => mockSkipToPreviousTrack(...args),
  jumpToQueueIndex: (...args: unknown[]) => mockJumpToQueueIndex(...args),
}));

// setAudioModeAsync is here because AudioPlayerScreen now imports ensureAudioModeConfigured
// (useAudioPlayerSetup.ts) to order itself after the global audio-session config — that module
// reaches expo-audio for this one call, so a factory returning only useAudioPlayerStatus would
// throw "not a function" the moment the load effect runs.
jest.mock('expo-audio', () => ({
  __esModule: true,
  useAudioPlayerStatus: (player: typeof mockFakePlayer) => ({ ...player }),
  setAudioModeAsync: jest.fn(() => Promise.resolve()),
}));

// Same seam ReaderScreen.test.tsx mocks, same reason — see that file's own comment on
// captureProtection.ts's real implementation lazily requiring a native module Jest can't load.
jest.mock('@/features/reader/captureProtection', () => ({
  READER_CAPTURE_KEY: 'reader-content',
  preventScreenCaptureAsync: jest.fn(() => Promise.resolve()),
  allowScreenCaptureAsync: jest.fn(() => Promise.resolve()),
}));

function getFakePlayer() {
  return mockFakePlayer;
}

describe('AudioPlayerScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsNewAudioPlayer = true;
    const fakePlayer = getFakePlayer();
    fakePlayer.playing = false;
    fakePlayer.currentTime = 0;
    fakePlayer.duration = 120;
    // Loaded by default — the resolver-still-pending test below is the one exception, and sets
    // this back to false itself. Every other test wants to land straight on the loaded UI without
    // a mid-test re-render step (see this file's header).
    fakePlayer.isLoaded = true;
    fakePlayer.playbackRate = 1;
    mockResolveAudioAssetUri.mockResolvedValue('file:///tf-reader-audio-scratch/book.wav');
    // The lock tests emit on the REAL bus (not mocked, same reasoning as useContentLock.test.ts).
    // It is a module singleton, so every test starts from zero subscribers regardless of whether
    // it touches locking at all.
    resetEventBusForTests();
    _resetAudioTtsCoordinatorForTests();
    useAudioQueueStore.getState().clearQueue();
    useAudioQueueStore.getState().setRepeatMode('off');
  });

  it('renders a distinct "access ended" state on a content.lock signal, not the generic load-error heading', async () => {
    const { getByText, queryByText } = await render(
      <AudioPlayerScreen bookId="dev-sample-audio" title="My Audiobook" />,
    );
    await waitFor(() => expect(getByText('My Audiobook')).toBeTruthy());

    await act(async () => {
      eventBus.emit(OFFLINE_LOCK_EVENTS.LOCK, {
        type: OFFLINE_LOCK_EVENTS.LOCK,
        bookId: 'dev-sample-audio',
        reason: 'revoked',
        observedAt: Date.now(),
      });
    });

    expect(getByText('Access to this title ended')).toBeTruthy();
    expect(getByText('CONTENT_LOCKED: Your access to this book has ended.')).toBeTruthy();
    // NOT the generic load-error heading — this is the whole point of N3's fix.
    expect(queryByText("Couldn't load this title")).toBeNull();
  });

  it('ignores a lock for a different bookId', async () => {
    const { getByText, queryByText } = await render(
      <AudioPlayerScreen bookId="dev-sample-audio" title="My Audiobook" />,
    );
    await waitFor(() => expect(getByText('My Audiobook')).toBeTruthy());

    await act(async () => {
      eventBus.emit(OFFLINE_LOCK_EVENTS.LOCK, {
        type: OFFLINE_LOCK_EVENTS.LOCK,
        bookId: 'some-other-book',
        reason: 'revoked',
        observedAt: Date.now(),
      });
    });

    expect(queryByText('Access to this title ended')).toBeNull();
    expect(getByText('My Audiobook')).toBeTruthy();
  });

  it('shows a loading state while the resolver is still resolving', async () => {
    getFakePlayer().isLoaded = false;
    // Never resolves within this test — pins the loading state, not just its absence.
    mockResolveAudioAssetUri.mockReturnValue(new Promise(() => {}));

    const { getByText } = await render(
      <AudioPlayerScreen bookId="dev-sample-audio" title="My Audiobook" />,
    );

    await waitFor(() => expect(getByText('Loading My Audiobook…')).toBeTruthy());
  });

  it('shows an error state, not a blank screen, when acquisition is refused', async () => {
    // The resolver runs openBook() — the licence gate — so an unentitled or revoked audiobook now
    // fails HERE rather than playing from a local seed. This screen's job is to render that refusal
    // instead of a silent blank player.
    mockResolveAudioAssetUri.mockRejectedValue(
      new Error('LICENSE_DENIED for dev-sample-audio-encrypted'),
    );

    const { getByText } = await render(
      <AudioPlayerScreen bookId="dev-sample-audio-encrypted" title="My Audiobook" />,
    );

    await waitFor(() => expect(getByText("Couldn't load this title")).toBeTruthy());
    expect(getByText('LICENSE_DENIED for dev-sample-audio-encrypted')).toBeTruthy();
  });

  it('shows an error state when the resolver itself rejects', async () => {
    mockResolveAudioAssetUri.mockRejectedValue(new Error('resolver exploded'));

    const { getByText } = await render(
      <AudioPlayerScreen bookId="dev-sample-audio" title="My Audiobook" />,
    );

    await waitFor(() => expect(getByText('resolver exploded')).toBeTruthy());
  });

  it('resolves via audioAssetResolver alone — no seeding step, never a bundled require()', async () => {
    // There used to be an ensureSeeded() call before this one. The audio dev seed is gone; the
    // resolver acquires from the backend itself, so this screen has exactly one dependency for
    // getting playable bytes and no ordering constraint to get wrong.
    await render(<AudioPlayerScreen bookId="dev-sample-audio-encrypted" title="My Audiobook" />);

    await waitFor(() =>
      expect(mockResolveAudioAssetUri).toHaveBeenCalledWith('dev-sample-audio-encrypted'),
    );
  });

  it('points the SAME player at the resolved uri via replace(), never a changing source', async () => {
    const fakePlayer = getFakePlayer();
    await render(<AudioPlayerScreen bookId="dev-sample-audio" title="My Audiobook" />);

    await waitFor(() =>
      expect(fakePlayer.replace).toHaveBeenCalledWith('file:///tf-reader-audio-scratch/book.wav'),
    );
  });

  // REGRESSION for a real-device bug (two symptoms, one cause): AudioPlayerScreen used to own its
  // player via `useAudioPlayer`, which auto-releases the native player when the component
  // unmounts. Navigating back to BookList while a book was playing tore down the native player
  // mid-playback — silently killing background audio (the actual bug) and throwing
  // ERR_NATIVE_SHARED_OBJECT_NOT_FOUND when this screen's own cleanup then touched the
  // already-gone object (the crash that surfaced it). The fix moved player ownership to
  // audioPlayerInstance.ts's module-level singleton and removed the unmount cleanup entirely —
  // this pins BOTH halves: unmounting doesn't throw, AND lock-screen controls are NOT cleared
  // (proving the Now Playing state is left alone, not torn down, when you navigate away).
  it('does not throw on unmount, and does NOT clear lock screen controls (playback must survive navigating away)', async () => {
    const fakePlayer = getFakePlayer();
    const { unmount } = await render(
      <AudioPlayerScreen bookId="dev-sample-audio" title="My Audiobook" />,
    );

    await waitFor(() => expect(fakePlayer.replace).toHaveBeenCalled());

    expect(() => unmount()).not.toThrow();
    expect(fakePlayer.clearLockScreenControls).not.toHaveBeenCalled();
    expect(fakePlayer.remove).not.toHaveBeenCalled();
  });

  it('prevents screen capture for as long as this book is open, and re-allows it on unmount', async () => {
    const { unmount } = await render(
      <AudioPlayerScreen bookId="dev-sample-audio" title="My Audiobook" />,
    );
    await waitFor(() => expect(getFakePlayer().replace).toHaveBeenCalled());

    expect(preventScreenCaptureAsync).toHaveBeenCalledWith(READER_CAPTURE_KEY);
    expect(allowScreenCaptureAsync).not.toHaveBeenCalled();

    // act(), not a bare unmount() — see this file's own note above on why unmount alone does not
    // flush effect cleanups synchronously here.
    await act(async () => {
      await unmount();
    });

    expect(allowScreenCaptureAsync).toHaveBeenCalledWith(READER_CAPTURE_KEY);
  });

  // REGRESSION for a real-device bug: reopening a still-playing book restarted it from the
  // beginning. Cause: AudioPlayerScreen is a fresh component instance every time you navigate to
  // it, so `uri` always starts at `null` and resolves again — even when getAudioPlayerFor returned
  // the SAME, already-playing, already-loaded player. `player.replace(uri)` used to run
  // unconditionally on that resolution, which reloads the source from position 0 even when the
  // "new" uri is identical to what's already loaded and playing. Gating replace() (not just the
  // resume-seek) on `isNew` is the fix — this pins BOTH halves the reused-player path must get
  // right: no replace(), and no seekTo() on top of wherever it actually is.
  it('does not replace() or seek a REUSED (already-playing) player — reopening must not restart it', async () => {
    mockIsNewAudioPlayer = false;
    const fakePlayer = getFakePlayer();
    fakePlayer.currentTime = 88; // wherever the still-playing book has actually gotten to

    await render(
      <AudioPlayerScreen bookId="dev-sample-audio" title="My Audiobook" initialPosition={5} />,
    );

    await waitFor(() => expect(mockResolveAudioAssetUri).toHaveBeenCalled());
    expect(fakePlayer.replace).not.toHaveBeenCalled();
    expect(fakePlayer.seekTo).not.toHaveBeenCalled();
    expect(fakePlayer.currentTime).toBe(88);
  });

  it('renders the title and a Play button once loaded, and pressing it calls play()', async () => {
    const fakePlayer = getFakePlayer();
    const { getByText, findByLabelText } = await render(
      <AudioPlayerScreen bookId="dev-sample-audio" title="My Audiobook" />,
    );

    expect(getByText('My Audiobook')).toBeTruthy();
    await fireEvent.press(await findByLabelText('Play'));
    expect(fakePlayer.play).toHaveBeenCalled();
  });

  it('stops active TTS when Play is pressed', async () => {
    const ttsStopMock = jest.fn();
    registerActiveTtsSession({
      stop: ttsStopMock,
      isSpeaking: () => true,
      isActive: () => true,
    });

    const fakePlayer = getFakePlayer();
    const { findByLabelText } = await render(
      <AudioPlayerScreen bookId="dev-sample-audio" title="My Audiobook" />,
    );

    await fireEvent.press(await findByLabelText('Play'));
    expect(ttsStopMock).toHaveBeenCalledTimes(1);
    expect(fakePlayer.play).toHaveBeenCalled();
  });

  it('shows a Pause button once playing, and pressing it calls pause()', async () => {
    const fakePlayer = getFakePlayer();
    fakePlayer.playing = true;
    const { findByLabelText } = await render(
      <AudioPlayerScreen bookId="dev-sample-audio" title="My Audiobook" />,
    );

    await fireEvent.press(await findByLabelText('Pause'));
    expect(fakePlayer.pause).toHaveBeenCalled();
  });

  it('does not call play() when onBeforePlay refuses', async () => {
    const fakePlayer = getFakePlayer();
    const { findByLabelText } = await render(
      <AudioPlayerScreen
        bookId="dev-sample-audio"
        title="My Audiobook"
        onBeforePlay={() => Promise.resolve(false)}
      />,
    );

    await fireEvent.press(await findByLabelText('Play'));
    expect(fakePlayer.play).not.toHaveBeenCalled();
  });

  it('calls play() once onBeforePlay resolves true', async () => {
    const fakePlayer = getFakePlayer();
    const { findByLabelText } = await render(
      <AudioPlayerScreen
        bookId="dev-sample-audio"
        title="My Audiobook"
        onBeforePlay={() => Promise.resolve(true)}
      />,
    );

    await fireEvent.press(await findByLabelText('Play'));
    expect(fakePlayer.play).toHaveBeenCalled();
  });

  it('disables the button and shows a checking state while onBeforePlay is pending', async () => {
    const fakePlayer = getFakePlayer();
    let resolveGate: (allowed: boolean) => void = () => {};
    const gate = new Promise<boolean>((resolve) => {
      resolveGate = resolve;
    });
    const { findByLabelText } = await render(
      <AudioPlayerScreen
        bookId="dev-sample-audio"
        title="My Audiobook"
        onBeforePlay={() => gate}
      />,
    );

    const playButton = await findByLabelText('Play');
    void fireEvent.press(playButton); // not awaited — the gate has not resolved yet
    await waitFor(() => expect(findByLabelText('Checking progress')).resolves.toBeTruthy());
    expect(fakePlayer.play).not.toHaveBeenCalled();

    await act(async () => {
      resolveGate(true);
      await gate;
    });
    expect(fakePlayer.play).toHaveBeenCalled();
  });

  it('restarts from 0 and commits position 0 when pressing play at the end of a track', async () => {
    const fakePlayer = getFakePlayer();
    fakePlayer.currentTime = 120;
    fakePlayer.duration = 120;
    fakePlayer.playing = false;
    const onPositionCommit = jest.fn();

    const { findByLabelText } = await render(
      <AudioPlayerScreen
        bookId="dev-sample-audio"
        title="My Audiobook"
        onPositionCommit={onPositionCommit}
      />,
    );

    await fireEvent.press(await findByLabelText('Play'));

    expect(fakePlayer.seekTo).toHaveBeenCalledWith(0);
    expect(onPositionCommit).toHaveBeenCalledWith(0);
    expect(fakePlayer.play).toHaveBeenCalled();
  });

  it('reads live player position, restarting from 0 even if rendered status is stale', async () => {
    const fakePlayer = getFakePlayer();
    fakePlayer.currentTime = 100;
    fakePlayer.duration = 120;
    fakePlayer.playing = false;
    const onPositionCommit = jest.fn();

    const { findByLabelText } = await render(
      <AudioPlayerScreen
        bookId="dev-sample-audio"
        title="My Audiobook"
        onPositionCommit={onPositionCommit}
      />,
    );

    // Track finishes on the native player before the next 250ms status tick
    fakePlayer.currentTime = 120;

    await fireEvent.press(await findByLabelText('Play'));

    expect(fakePlayer.seekTo).toHaveBeenCalledWith(0);
    expect(onPositionCommit).toHaveBeenCalledWith(0);
    expect(fakePlayer.play).toHaveBeenCalled();
  });

  it('plays unhindered when TTS is registered but idle (TTS is ON, but not playing)', async () => {
    const fakePlayer = getFakePlayer();
    const ttsStopMock = jest.fn();
    const unregister = registerActiveTtsSession({
      stop: ttsStopMock,
      isSpeaking: () => false,
      isActive: () => false, // idle
    });

    const { findByLabelText } = await render(
      <AudioPlayerScreen bookId="dev-sample-audio" title="My Audiobook" />,
    );

    await fireEvent.press(await findByLabelText('Play'));

    // stop() not called because TTS is not playing
    expect(ttsStopMock).not.toHaveBeenCalled();
    expect(fakePlayer.play).toHaveBeenCalled();

    unregister();
  });

  it('stops active TTS when playing audiobook while TTS is actively speaking', async () => {
    const fakePlayer = getFakePlayer();
    const ttsStopMock = jest.fn();
    const unregister = registerActiveTtsSession({
      stop: ttsStopMock,
      isSpeaking: () => true,
      isActive: () => true, // speaking
    });

    const { findByLabelText } = await render(
      <AudioPlayerScreen bookId="dev-sample-audio" title="My Audiobook" />,
    );

    await fireEvent.press(await findByLabelText('Play'));

    expect(ttsStopMock).toHaveBeenCalledTimes(1);
    expect(fakePlayer.play).toHaveBeenCalled();

    unregister();
  });

  it('skip back calls seekTo clamped to 0, not negative', async () => {
    const fakePlayer = getFakePlayer();
    fakePlayer.currentTime = 5;
    const { findByLabelText } = await render(
      <AudioPlayerScreen bookId="dev-sample-audio" title="My Audiobook" />,
    );

    await fireEvent.press(await findByLabelText('Skip back 15 seconds'));
    // currentTime (5) - 15 clamps to 0, not a negative number.
    expect(fakePlayer.seekTo).toHaveBeenCalledWith(0);
  });

  it('skip forward calls seekTo clamped to duration, not past the end', async () => {
    const fakePlayer = getFakePlayer();
    fakePlayer.currentTime = 110;
    fakePlayer.duration = 120;
    const { findByLabelText } = await render(
      <AudioPlayerScreen bookId="dev-sample-audio" title="My Audiobook" />,
    );

    await fireEvent.press(await findByLabelText('Skip forward 15 seconds'));
    // currentTime (110) + 15 clamps to duration (120), not past the end.
    expect(fakePlayer.seekTo).toHaveBeenCalledWith(120);
  });

  it('speed buttons call setPlaybackRate with the tapped rate', async () => {
    const fakePlayer = getFakePlayer();
    const { findByLabelText } = await render(
      <AudioPlayerScreen bookId="dev-sample-audio" title="My Audiobook" />,
    );

    await fireEvent.press(await findByLabelText('Playback speed 1.5x'));
    expect(fakePlayer.setPlaybackRate).toHaveBeenCalledWith(1.5);
  });

  it('sets this player active for lock screen controls with seek forward/backward, not next/prev', async () => {
    const fakePlayer = getFakePlayer();
    // Lock screen registration only fires once status.playing is true (see AudioPlayerScreen.tsx
    // comment on why: iOS ignores MPNowPlayingInfoCenter registrations that arrive with rate=0).
    // Set before render() so the component's first re-render after resolver resolves already sees
    // playing:true — same "set fields before render" pattern the file header mandates.
    fakePlayer.playing = true;
    await render(<AudioPlayerScreen bookId="dev-sample-audio" title="My Audiobook" />);

    await waitFor(() =>
      expect(fakePlayer.setActiveForLockScreen).toHaveBeenCalledWith(
        true,
        { title: 'My Audiobook', artist: 'Nexus' },
        { showSeekForward: true, showSeekBackward: true },
      ),
    );
  });

  it('resumes at initialPosition once loaded, exactly once', async () => {
    const fakePlayer = getFakePlayer();
    await render(
      <AudioPlayerScreen bookId="dev-sample-audio" title="My Audiobook" initialPosition={42} />,
    );

    await waitFor(() => expect(fakePlayer.seekTo).toHaveBeenCalledWith(42));
    expect(fakePlayer.seekTo).toHaveBeenCalledTimes(1);
  });

  it('reports position changes via onPositionChange once loaded', async () => {
    const fakePlayer = getFakePlayer();
    fakePlayer.currentTime = 7;
    const onPositionChange = jest.fn();
    await render(
      <AudioPlayerScreen
        bookId="dev-sample-audio"
        title="My Audiobook"
        onPositionChange={onPositionChange}
      />,
    );

    await waitFor(() => expect(onPositionChange).toHaveBeenCalledWith(7));
  });

  // Regression pin: when a new player loads at currentTime=0 and a seekTo(initialPosition) is
  // about to run, both the seek effect and the onPositionChange effect fire on the same
  // status.isLoaded transition. The seek is async — currentTime is still 0 at this point — so
  // without the guard, handlePositionChange writes positionMs=0 unthrottled and pushes it to
  // the server before the correct position lands, triggering false conflict alerts on Device 1.
  it('does not report position 0 via onPositionChange when a new player has not yet seeked to initialPosition', async () => {
    // currentTime starts at 0 (default) — the player just loaded, seek hasn't run yet.
    const onPositionChange = jest.fn();
    await render(
      <AudioPlayerScreen
        bookId="dev-sample-audio"
        title="My Audiobook"
        initialPosition={60}
        onPositionChange={onPositionChange}
      />,
    );

    // Position 0 must not reach onPositionChange — it is the player's default load state,
    // not the real starting position. The post-seek position (60) is the correct first report.
    expect(onPositionChange).not.toHaveBeenCalledWith(0);
    await waitFor(() => expect(onPositionChange).toHaveBeenCalledWith(60));
  });

  it('does report position 0 via onPositionChange for a fresh book with no saved position', async () => {
    // No initialPosition — there is no seek pending, so position 0 IS the correct starting
    // point and must be reported.
    const onPositionChange = jest.fn();
    await render(
      <AudioPlayerScreen
        bookId="dev-sample-audio"
        title="My Audiobook"
        onPositionChange={onPositionChange}
      />,
    );

    await waitFor(() => expect(onPositionChange).toHaveBeenCalledWith(0));
  });

  // AUDIO PHASE 4. onPositionCommit marks the edges where the next tick may never arrive. These
  // stay one-interaction-per-test, per this file's header — unmount() is not rerender() and is not
  // affected by the instability that rule exists for.

  it('commits the position on pause, not just on the next tick', async () => {
    const fakePlayer = getFakePlayer();
    fakePlayer.playing = true;
    fakePlayer.currentTime = 63;
    const onPositionCommit = jest.fn();

    const { findByLabelText } = await render(
      <AudioPlayerScreen
        bookId="dev-sample-audio"
        title="My Audiobook"
        onPositionCommit={onPositionCommit}
      />,
    );

    await fireEvent.press(await findByLabelText('Pause'));
    expect(onPositionCommit).toHaveBeenCalledWith(63);
  });

  it('commits the seeked-to position on skip, not the position it skipped from', async () => {
    const fakePlayer = getFakePlayer();
    fakePlayer.currentTime = 30;
    const onPositionCommit = jest.fn();

    const { findByLabelText } = await render(
      <AudioPlayerScreen
        bookId="dev-sample-audio"
        title="My Audiobook"
        onPositionCommit={onPositionCommit}
      />,
    );

    await fireEvent.press(await findByLabelText('Skip forward 15 seconds'));
    expect(onPositionCommit).toHaveBeenCalledWith(45);
  });

  it('commits the live player position on unmount, not the last rendered status', async () => {
    const fakePlayer = getFakePlayer();
    fakePlayer.currentTime = 12;
    const onPositionCommit = jest.fn();

    const { unmount } = await render(
      <AudioPlayerScreen
        bookId="dev-sample-audio"
        title="My Audiobook"
        onPositionCommit={onPositionCommit}
      />,
    );
    await waitFor(() => expect(fakePlayer.replace).toHaveBeenCalled());

    // Playback continues in the background after the screen goes away, so the player has moved on
    // from whatever the last render saw. Committing the stale rendered value would lose it.
    fakePlayer.currentTime = 99;
    // act(), not a bare unmount(): unmount alone does not flush effect CLEANUPS synchronously here,
    // so the assertion ran before the teardown it is about (confirmed — the cleanup fired after the
    // failure). This is the same class of problem as this file's header note on rerender(), and the
    // same shape of answer: let React finish rather than assert into the middle of it.
    await act(async () => {
      await unmount();
    });

    expect(onPositionCommit).toHaveBeenCalledWith(99);
  });

  it('does not commit a position on unmount when nothing ever loaded', async () => {
    const fakePlayer = getFakePlayer();
    fakePlayer.isLoaded = false;
    mockResolveAudioAssetUri.mockReturnValue(new Promise(() => {}));
    const onPositionCommit = jest.fn();

    const { unmount, getByText } = await render(
      <AudioPlayerScreen
        bookId="dev-sample-audio"
        title="My Audiobook"
        onPositionCommit={onPositionCommit}
      />,
    );
    await waitFor(() => expect(getByText('Loading My Audiobook…')).toBeTruthy());

    await act(async () => {
      await unmount();
    });

    // currentTime on an unloaded player is 0; persisting it would overwrite a real stored position
    // with the top of the book just because the user opened and immediately left.
    expect(onPositionCommit).not.toHaveBeenCalled();
  });

  it('calls skipToNextTrack when Next track button is pressed', async () => {
    useAudioQueueStore.getState().setQueue(
      [
        { bookId: 'dev-sample-audio' as BookId, title: 'My Audiobook' },
        { bookId: 'book-next' as BookId, title: 'Next Book' },
      ],
      0,
    );

    const { getByLabelText } = await render(
      <AudioPlayerScreen bookId="dev-sample-audio" title="My Audiobook" />,
    );

    const nextBtn = getByLabelText('Next track');
    await fireEvent.press(nextBtn);

    expect(mockSkipToNextTrack).toHaveBeenCalledTimes(1);
  });

  it('calls skipToPreviousTrack when Previous track button is pressed', async () => {
    useAudioQueueStore.getState().setQueue(
      [
        { bookId: 'book-prev' as BookId, title: 'Prev Book' },
        { bookId: 'dev-sample-audio' as BookId, title: 'My Audiobook' },
      ],
      1,
    );

    const { getByLabelText } = await render(
      <AudioPlayerScreen bookId="dev-sample-audio" title="My Audiobook" />,
    );

    const prevBtn = getByLabelText('Previous track');
    await fireEvent.press(prevBtn);

    expect(mockSkipToPreviousTrack).toHaveBeenCalledTimes(1);
  });

  it('opens queue modal when Queue button is pressed', async () => {
    useAudioQueueStore.getState().setQueue(
      [{ bookId: 'dev-sample-audio' as BookId, title: 'My Audiobook' }],
      0,
    );

    const { getByLabelText, getByText } = await render(
      <AudioPlayerScreen bookId="dev-sample-audio" title="My Audiobook" />,
    );

    const queueBtn = getByLabelText('Open queue, 1 track');
    await fireEvent.press(queueBtn);

    await waitFor(() => expect(getByText('Clear Queue')).toBeTruthy());
  });
});
