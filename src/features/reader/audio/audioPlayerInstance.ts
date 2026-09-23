// Owner: Reader (Ahana).
//
// AUDIO PHASE 3 — REAL-DEVICE FIX. A module-level singleton audio player, DELIBERATELY NOT owned
// by AudioPlayerScreen's own component lifecycle.
//
// WHY THIS FILE EXISTS AT ALL: `useAudioPlayer` (the hook) auto-releases its underlying native
// player the moment the component that called it unmounts (its own doc: "ensures it's properly
// disposed when no longer needed"). That is exactly backwards for background playback — the whole
// point of `shouldPlayInBackground` (useAudioPlayerSetup.ts) is that navigating back to BookList
// while a book is still playing must NOT stop it. Using the hook meant the native player, and the
// audio session it owned, were torn down the instant AudioPlayerScreen unmounted — confirmed on a
// real device as `ERR_NATIVE_SHARED_OBJECT_NOT_FOUND` when this file's own unmount cleanup then
// tried to call a method on the now-gone object, but the REAL bug was one level up: even without
// that crash, background playback would have silently stopped on every "back" navigation, which
// defeats this phase's entire point.
//
// `createAudioPlayer()` — expo-audio's own "doesn't release automatically" variant, explicitly
// documented as the escape hatch from `useAudioPlayer`'s auto-release — is the fix. Held here, at
// module scope, it survives exactly as long as the JS process does, independent of which screen
// (if any) is currently mounted.
//
// ONE PLAYER AT A TIME, matching this phase's explicit single-file scope (no queue, no chapters).
// Opening a DIFFERENT book releases whatever was playing before. Reopening the SAME book — leave
// the screen while it plays, come back — returns the SAME player, still mid-playback, rather than
// restarting it: that is what a real audiobook app does, and is also what makes "isNew" below
// necessary (AudioPlayerScreen must not re-seek to a stale resume position on top of a player
// that has been quietly continuing to play the whole time it was away).

import { createAudioPlayer, type AudioPlayer, type AudioStatus } from 'expo-audio';

import { progressStore } from '@/features/sync/stores/progressStore';
import type { BookId } from '@/shared/contracts';

import { registerAudioPauseHandler, registerAudioPlaybackBridge, stopActiveTts } from './audioTtsCoordinator';
import { audioQueueStore } from './audioQueueStore';
import { ensureAudioModeConfigured } from './useAudioPlayerSetup';

let current: { bookId: BookId; player: AudioPlayer } | null = null;
let pendingResumePosition: number | null = null;

type TrackCompletionHandler = () => void | Promise<unknown>;
let onTrackCompletionHandler: TrackCompletionHandler | null = null;

/**
 * Registers a callback to be invoked when the current track finishes playing.
 * Used by the audio queue coordinator to advance to the next track automatically.
 */
export function registerTrackCompletionHandler(handler: TrackCompletionHandler | null): void {
  onTrackCompletionHandler = handler;
}

export function _resetTrackCompletionHandlerForTests(): void {
  onTrackCompletionHandler = null;
}

// Registers the module singleton's pause action with the coordinator so TTS playback
// automatically pauses active audiobook sound.
registerAudioPauseHandler(pauseCurrentAudioPlayer);

// Registers the singleton's playback query + resume action for audioTtsCoordinator.ts's TTS-side
// callers (the sleep timer's guardTtsEnableForSleepTimer/resumeAudioIfPausedForSleepTimerTts, and
// pauseActiveAudioForTtsPlay's own-audio-alert check) — see that file's header for why this is a
// registration rather than a direct import back into it. `ensureAudioModeConfigured(true)`
// re-asserts the audio session before resuming, since TTS may have touched AVAudioSession in
// between; `true` forces a fresh call rather than reusing a possibly-stale memoized one, same as
// AudioPlayerScreen.tsx's own beginPlayback() does.
registerAudioPlaybackBridge({
  isAudioPlaying,
  resumeAudioAfterTts: () => {
    void ensureAudioModeConfigured(true).then(() => resumeCurrentAudioPlayer());
  },
});

/**
 * AUDIO PHASE 4, TASK B. Records the LIVE player's position for whichever book it is holding.
 *
 * Reads the singleton rather than taking a position argument on purpose: the callers that need this
 * (backgrounding, switching books) run when no `AudioPlayerScreen` is necessarily mounted, so there
 * is no component-held `status.currentTime` to trust — background playback outlives the screen, and
 * the position it has reached is only knowable from the player itself.
 *
 * A no-op when nothing is playing or the source has not loaded, so callers need no guard of their
 * own; `currentTime` on an unloaded player is 0, and persisting that would overwrite a real stored
 * position with the top of the book.
 *
 * KNOWINGLY BEST-EFFORT AT THE BACKGROUNDING EDGE, where this used to be a guarantee. Before this
 * migration, the write was a synchronous file write (`textSync()`/`write()`) specifically because
 * useAudioPlayerSetup.ts's AppState listener calls this at "the last reliable callback before the
 * OS may terminate the process" — a synchronous call is guaranteed to finish before that happens; a
 * `progressStore.savePosition()` call is a promise (SQLite write + outbox enqueue) that is not
 * awaited here and could in principle lose a race with process suspension. Accepted trade-off for
 * landing cross-device sync: the write is fire-and-forget, not fire-and-guaranteed. If this proves
 * to lose positions in practice, the fix is awaiting it from a place that can (React Native does not
 * give this listener a way to hold the process open), not reverting the store choice.
 */
export function commitCurrentPlayerPosition(): void {
  if (current && current.player.isLoaded) {
    void progressStore.savePosition(
      { type: 'AUDIO', positionMs: Math.round(current.player.currentTime * 1000) },
      current.bookId,
    );
  }
}

/**
 * Returns the player for `bookId` — the existing one if it's already the active book (still
 * mid-playback, or paused where it was left), or a fresh one (releasing whatever was active
 * before) otherwise.
 *
 * `isNew` tells the caller whether this is a brand-new player, safe to seek to a resume position,
 * or a reused, possibly-still-playing one that must NOT be seeked — see this file's header.
 */
/**
 * The book the singleton is currently holding, or `null` if nothing has been opened this run.
 *
 * Exists so callers that clean up per-book resources can spare whatever is actually playing.
 * Background playback means "a book is live" and "a screen is mounted" are independent facts, so
 * the singleton is the only thing that can answer this — see audioScratchReclaimer.ts, its one
 * consumer.
 *
 * Reports the book the player was created FOR, not whether it is still playing: a paused or
 * finished player still holds its source open, so treating it as live is the conservative answer
 * for anything deciding whether a file is safe to delete.
 */
export function currentAudioBookId(): BookId | null {
  return current?.bookId ?? null;
}

/**
 * Whether the singleton is actually producing sound right now.
 *
 * The distinction from `currentAudioBookId()` is the whole point: that one reports the book the
 * player HOLDS (paused and finished included), this one reports whether anything would break if its
 * source file vanished. `audioScratchReclaimer.ts` needs the second question, because the decrypted
 * audio in the scratch directory is worth keeping for exactly as long as something is reading it
 * and not one moment longer.
 *
 * False when nothing is loaded, so a player mid-`replace()` is treated as "not playing" — the
 * conservative answer for a cleanup decision, since a source that has not loaded yet is one the
 * resolver is about to rewrite anyway.
 */
export function isAudioPlaying(): boolean {
  return current !== null && current.player.isLoaded && current.player.playing;
}

/**
 * Pauses the live player if one is active and producing sound, and commits its live position.
 * Called by audioTtsCoordinator when TTS begins playback so the two never overlap.
 * Idempotent, and a safe no-op when nothing is loaded or playing.
 */
export function pauseCurrentAudioPlayer(): void {
  if (current && current.player.isLoaded && current.player.playing) {
    current.player.pause();
    commitCurrentPlayerPosition();
    audioQueueStore.getState().setIsPlaying(false);
  }
}

/**
 * Resumes the live player if one is loaded and not already playing. Mirrors
 * `pauseCurrentAudioPlayer()`'s own shape exactly. The one caller today is
 * `audioTtsCoordinator.ts`'s `resumeAudioIfPausedForSleepTimerTts()`, undoing a pause THAT SAME
 * module made when TTS switched on while a sleep timer was running (SLEEP_TIMER_PLAN.md §7).
 * Idempotent, and a safe no-op when nothing is loaded or already playing.
 */
export function resumeCurrentAudioPlayer(): void {
  if (current && current.player.isLoaded && !current.player.playing) {
    current.player.play();
    audioQueueStore.getState().setIsPlaying(true);
  }
}

/**
 * Stops playback and drops the native player, if there is one.
 *
 * The ONE caller today is entitlement loss (`audioScratchReclaimer.ts`, on Sync's `content.lock`),
 * and that is deliberate rather than incidental: this file's header is explicit that there is no
 * general "stop and release" path in scope, because the player is meant to outlive every screen.
 * Losing the right to the content is the exception — carrying on playing a book whose licence was
 * revoked is the one case where continuing is worse than stopping.
 *
 * Commits the position first, for the same reason the book-swap path does: `remove()` is terminal,
 * so this is the last moment the position can be read at all. Local progress for a book the user
 * can no longer open is harmless, and losing it while keeping every other book's would be a
 * confusing inconsistency.
 *
 * Idempotent, and safe to call when nothing is playing.
 */
export function releaseCurrentAudioPlayer(): void {
  if (!current) return;
  commitCurrentPlayerPosition();
  current.player.remove();
  current = null;
  pendingResumePosition = null;
  audioQueueStore.getState().setIsPlaying(false);
}

export function getCurrentAudioPlayer(): AudioPlayer | null {
  return current?.player ?? null;
}

/**
 * Switches the active singleton player to a new audio track (e.g. queue progression)
 * without tearing down the native player object or audio session.
 * Restores saved progress via optional initialPositionSeconds and guards against finished tracks.
 */
export function switchActiveAudioTrack(
  bookId: BookId,
  uri: string,
  title: string,
  artist: string = 'Nexus',
  initialPositionSeconds?: number,
): void {
  const seekPos =
    initialPositionSeconds && initialPositionSeconds > 0 ? initialPositionSeconds : null;

  if (!current) {
    const { player } = getAudioPlayerFor(bookId);
    pendingResumePosition = seekPos;
    player.replace({ uri });
    if (player.isLoaded && pendingResumePosition !== null) {
      const pos = pendingResumePosition;
      pendingResumePosition = null;
      const target = player.duration > 0 && pos >= player.duration - 2 ? 0 : pos;
      if (target > 0) {
        void player.seekTo(target);
      }
    }
    player.setActiveForLockScreen(
      true,
      { title, artist },
      { showSeekForward: true, showSeekBackward: true },
    );
    player.play();
    audioQueueStore.getState().setIsPlaying(true);
    return;
  }

  // If the same book is already loaded, avoid reloading source (which resets to 0:00)
  if (current.bookId === bookId && current.player.isLoaded) {
    if (!current.player.playing) {
      if (seekPos !== null) {
        const target =
          current.player.duration > 0 && seekPos >= current.player.duration - 2 ? 0 : seekPos;
        if (target > 0) {
          void current.player.seekTo(target);
        }
      }
      current.player.play();
      audioQueueStore.getState().setIsPlaying(true);
    }
    return;
  }

  commitCurrentPlayerPosition();
  current.bookId = bookId;
  pendingResumePosition = seekPos;
  current.player.replace({ uri });
  if (current.player.isLoaded && pendingResumePosition !== null) {
    const pos = pendingResumePosition;
    pendingResumePosition = null;
    const target = current.player.duration > 0 && pos >= current.player.duration - 2 ? 0 : pos;
    if (target > 0) {
      void current.player.seekTo(target);
    }
  }
  current.player.setActiveForLockScreen(
    true,
    { title, artist },
    { showSeekForward: true, showSeekBackward: true },
  );
  current.player.play();
  audioQueueStore.getState().setIsPlaying(true);
}

export function getAudioPlayerFor(bookId: BookId): { player: AudioPlayer; isNew: boolean } {
  if (current && current.bookId === bookId) {
    return { player: current.player, isNew: false };
  }

  // AUDIO PHASE 4: the outgoing book's position is captured from the LIVE player before it is
  // released, not left to whatever the last 250ms tick happened to record. `remove()` is terminal
  // (it drops the native object), so this is the last moment its position can be read at all — and
  // switching books is precisely when no screen is mounted to notice on its behalf.
  commitCurrentPlayerPosition();
  current?.player.remove();
  // `keepAudioSessionActive: true` is LOCK-SCREEN CORRECTNESS, not a performance knob. Left at its
  // default of `false`, expo-audio's own `Function("pause")` calls `deactivateSession()` on every
  // pause, and the constructor's `onPlaybackComplete` does the same at end of track
  // (AudioModule.swift). Deactivating the AVAudioSession tears down the Now Playing card, so an
  // audiobook — where pausing is constant and the card must survive it — must opt out. iOS-only
  // per expo-audio's own types; a no-op elsewhere.
  const player = createAudioPlayer(null, { updateInterval: 250, keepAudioSessionActive: true });
  let wasPlaying = false;
  player.addListener('playbackStatusUpdate', (status: AudioStatus) => {
    if (status.playing && !wasPlaying) {
      stopActiveTts();
    }
    wasPlaying = status.playing;
    audioQueueStore.getState().setIsPlaying(status.playing);
    if (status.isLoaded) {
      audioQueueStore.getState().setPlaybackProgress({
        positionSeconds: status.currentTime,
        durationSeconds: status.duration,
      });

      if (pendingResumePosition !== null) {
        const pos = pendingResumePosition;
        pendingResumePosition = null;
        const target = status.duration > 0 && pos >= status.duration - 2 ? 0 : pos;
        if (target > 0) {
          void player.seekTo(target);
        }
      }
    }

    if (status.didJustFinish) {
      if (onTrackCompletionHandler) {
        void onTrackCompletionHandler();
      }
    }
  });
  current = { bookId, player };
  return { player, isNew: true };
}
