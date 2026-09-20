// The AudioPlayer route: reads `{ bookId, title }` from navigation params and renders
// AudioPlayerScreen — same split ReaderRouteScreen.tsx uses for the WebView reader (this file
// owns navigation concerns, AudioPlayerScreen.tsx owns none). Progress wiring lives HERE, not in
// AudioPlayerScreen, for the same reason ReaderRouteScreen.tsx's own header gives: resuming a book
// is a routing concern (which position does THIS push start at), and AudioPlayerScreen's own
// initialPosition/onPositionChange/onPositionCommit props are deliberately ignorant of where a
// position comes from or where it goes.
//
// AUDIO PHASE 4, TASK B — LANDED. Progress now goes through `progressStore` (SQLite + the sync
// outbox) — the same durable, synced store EPUB/PDF use — instead of the local, unsynced JSON file
// `audioSessionProgress.ts` used to be (deleted with this change). See
// CONTRACTS_GATE_PROPOSAL_AUDIO_PROGRESS.md for why that file existed and what unblocked this.
//
// WHY THIS SCREEN NOW HAS A LOADING GATE, WHEN IT DIDN'T BEFORE: `progressStore.currentLocator()`
// queries SQLite and is genuinely async, unlike the old JSON file's synchronous `textSync()`. A
// render-time read is no longer possible, so `AudioPlayerScreen` cannot mount with a resume
// position until the query resolves — the same reason `AudioPlayerScreen` itself already gates on
// `audioAssetResolver.resolveAudioAssetUri()` before mounting a player.
//
// WHY THE RESOLVED POSITION CARRIES ITS OWN `bookId` INSTEAD OF BEING RESET WHEN `bookId` CHANGES:
// this screen does NOT remount per book — navigating to a different audiobook while already on this
// route updates `route.params` on the SAME instance (that is exactly why `AudioPlayerScreen` below
// needs its own `key={bookId}`). Resetting state synchronously at the top of the effect body, before
// the query resolves, is exactly what this repo's `react-hooks/set-state-in-effect` lint rule
// forbids. Tagging the resolved value with the `bookId` it belongs to and comparing against the
// current `bookId` avoids that: the only `setState` call is the one inside the (async) `.then()`.
//
// WHY THE RESOLVE EFFECT AWAITS `syncEngine.run()` BEFORE READING `currentLocator()`: the local
// SQLite row can itself be stale. `src/features/sync/useAutoSync.ts` (mounted once, at the app
// root) only re-syncs on an actual NetInfo offline->online EDGE — backgrounding and foregrounding
// this app while the connection never drops (the common case) fires no such edge, so nothing pulls
// in a position another device wrote while this device was merely backgrounded, not relaunched.
// `syncEngine.run()` is public for exactly this (concurrent calls share one run rather than racing,
// so this costs nothing extra if `useAutoSync`'s own trigger already has one in flight) and never
// rejects (`execute()` catches internally). Same fix, same reasoning, as
// `ReaderRouteScreen.tsx`'s equivalent effect for EPUB/PDF.
//
// AND, SEPARATELY, `syncForThisBook` (below) TOPS UP AN UNDOWNLOADED AUDIOBOOK — A GAP THIS FILE
// HAD FROM THE START, NOT JUST IN THE MECHANISMS ADDED LATER. `syncEngine.run()`'s regular sweep
// only refreshes progress for books with a local `downloads` row (`syncEngine.ts`'s own
// `pullBook` doc); a streamed-without-downloading audiobook was invisible to it, no matter how
// long either device stayed online — every one of this file's `syncEngine.run()` call sites
// (resume, the play-gate, and the live-pull effects further down) inherited that gap until this
// fixed it in one place. `audioAssetResolver.ts` supports the streamed case same as EPUB/PDF's
// download flow — this was reachable, not theoretical.
//
// THE PLAY-BUTTON GATE HANDLES "AM I ABOUT TO RESUME ONTO A STALE POSITION." IT DOES NOT, AND
// CANNOT, HANDLE "ANOTHER DEVICE WROTE A NEWER POSITION WHILE THIS ONE IS ACTIVELY PLAYING" — THAT
// IS A SEPARATE MECHANISM, BELOW. An early design for that second case considered subscribing to
// `progressStore.subscribe()` and comparing on every notification, the same shape
// `ReaderRouteScreen.tsx` uses for EPUB/PDF, and rejected it — but for a specific, narrower reason
// than "audio can't do this at all": the comparison it had in mind measured against a value that
// only updates at pause/seek/unmount (what is now `lastPausedPositionSecondsRef`), and that value
// is stale THE INSTANT playback resumes — so comparing against it while playing would flag this
// device's own advancing playback as a conflict roughly every throttle interval, and a genuinely
// idle SECOND device with the same book open would see the SAME false alarms every time its own
// sync engine happened to pull. That specific failure mode does not apply to a comparison against
// the PLAYER'S OWN live position (`AudioPlayerScreenHandle.currentPositionSeconds()`, a fresh read
// of the native player, not a snapshot) — which is what the live-conflict effect below does
// instead, gated on `isPlaying()` so it only ever runs while there is something to compare a live
// position against, and reusing the exact same `CONFLICT_THRESHOLD_MS` tolerance the play-gate
// already proved: a genuine echo of this device's own throttled write is always within a few
// hundred milliseconds of the live position, comfortably inside the threshold, while a real
// cross-device divergence is not.
//
// SO THERE ARE NOW TWO PATHS TO THE SAME PROMPT, EACH OWNING A DIFFERENT MOMENT. `handleBeforePlay`
// owns "resuming from a paused, at-rest position" (unchanged from before). The live-conflict effect
// owns "a fresher record landed while this device is already playing" — it PAUSES the player
// (`AudioPlayerScreenHandle.pause()`) the instant it finds a genuine divergence, both so the
// compared position stops moving and so the reader is not left listening to audio that no longer
// matches where the app is about to say it is, then shows the identical `Alert.alert`. Both share
// one `conflictPendingRef` guard so only one dialog can ever be up at a time — in practice this
// never races in the first place, since a non-cancelable `Alert.alert` blocks the Play button
// underneath it, but the guard costs nothing and matches `ReaderRouteScreen.tsx`'s own shape.
//
// THE IN-APP GATE ABOVE IS NOT THE ONLY WAY PLAYBACK CAN RESUME, AND THE OTHER ONE BYPASSES IT
// ENTIRELY. `AudioPlayerScreen.tsx`'s `setActiveForLockScreen` wires the OS lock-screen/
// Control-Center/media-notification Play and Toggle commands to expo-audio's NATIVE player
// directly — resuming from there never calls `beginPlayback`, so `onBeforePlay` never runs. A
// conflict written by another device while this device sits paused can start playing again from
// the lock screen with no check and no prompt. Confirmed present, not fixed: closing it needs
// either patching expo-audio to route the remote command through JS first, or dropping lock-screen
// transport controls — both are product trade-offs on top of this file, not something to change
// here unilaterally. See CLAUDE.md's "Reading-position resume" section.

import { useCallback, useEffect, useRef, useState } from 'react';

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Alert, AppState, StyleSheet, View } from 'react-native';

import Loader from '@components/Loader';
import { AudioPlayerScreen } from '@/features/reader/audio/AudioPlayerScreen';
import type { AudioPlayerScreenHandle } from '@/features/reader/audio/AudioPlayerScreen';
import { audioQueueStore } from '@/features/reader/audio/audioQueueStore';
import { syncEngine } from '@/features/sync/syncEngine';
import { downloadStore } from '@/features/sync/stores/downloadStore';
import { progressStore } from '@/features/sync/stores/progressStore';
import { color } from '@theme/tokens';

import type { Locator } from '@/shared/contracts';
import type { CatalogueStackParamList } from './types';

// Registered in RootNavigator's Catalogue/Search/Library stacks (Phase 4.4 of
// integration_ref.md — landed) — see ItemDetailScreen's 'read'/'play' branch,
// which pushes this instead of 'Reader' for an AUDIO item. Typed against
// `CatalogueStackParamList`, the same convention `ReaderRouteScreen.tsx` uses
// for its own 'Reader' registration, even though both routes are registered
// identically in all three stacks — the param shape is the same everywhere.
type Props = NativeStackScreenProps<CatalogueStackParamList, 'AudioPlayer'>;

// Ticks arrive every 250ms (audioPlayerInstance.ts's updateInterval). Writing to SQLite (and
// enqueueing an outbox row) on each one would be ~4 writes a second for a value nobody reads until
// the next launch or another device pulls it. The throttle only gates onPositionChange — the
// pause/seek/unmount edge (onPositionCommit) always writes through immediately, same as before.
const AUDIO_PROGRESS_WRITE_THROTTLE_MS = 5_000;

// Below this, two positions count as "the same place" — clock/rounding noise between devices, not
// a real divergence. Chosen to be well above the ~1s round-trip a seek+commit can introduce, and
// well below anything a listener would notice as "picked up somewhere I didn't leave off."
const CONFLICT_THRESHOLD_MS = 5_000;

// Same gap `READER_LIVE_SYNC_POLL_MS` closes for EPUB/PDF, and the same reason it's needed here
// too: the live-conflict effect below only REACTS to a `progressStore` change — it does not, by
// itself, cause one. `useAutoSync.ts` only re-syncs on a NetInfo offline->online EDGE, so on stable
// wifi (the common case) nothing would ever pull in another device's write while this screen sits
// open, playing or not — the subscription would have nothing to react to. Same 2-minute interval as
// Reader's, for the same accepted trade-off (see CLAUDE.md's "Reading-position resume" section).
const AUDIO_LIVE_SYNC_POLL_MS = 120_000;

export function AudioPlayerRouteScreen({ route, navigation }: Props): React.JSX.Element {
  const { bookId, title, coverUrl } = route.params;

  // Hides the shared four-tab bar for exactly this screen, same mechanism (and same reason) as
  // ItemDetailScreen.tsx's and ReaderRouteScreen.tsx's identical effect — a full-screen player has
  // no tab bar to share space with. The native-stack header is hidden too (RootNavigator.tsx):
  // AudioPlayerScreen draws its own back button and title, matching ReaderScreen's identical shape.
  useEffect(() => {
    navigation.getParent()?.setOptions({ tabBarStyle: { display: 'none' } });
    return () => navigation.getParent()?.setOptions({ tabBarStyle: undefined });
  }, [navigation]);

  // Initialize or align the audio queue with route params on mount or route update
  useEffect(() => {
    const queue = audioQueueStore.getState();
    const itemIndex = queue.items.findIndex((item) => item.bookId === bookId);
    if (itemIndex === -1) {
      if (queue.items.length === 0) {
        queue.setQueue([{ bookId, title }], 0);
      } else {
        queue.enqueue({ bookId, title });
        const newIndex = audioQueueStore.getState().items.findIndex((item) => item.bookId === bookId);
        if (newIndex !== -1) {
          queue.skipToIndex(newIndex);
        }
      }
    } else if (queue.currentIndex !== itemIndex) {
      queue.skipToIndex(itemIndex);
    }
  }, [bookId, title]);

  // Synchronize route.params when the audio queue advances to a different track
  useEffect(() => {
    const unsubscribe = audioQueueStore.subscribe((state) => {
      const current = state.items[state.currentIndex];
      if (current && current.bookId !== bookId && navigation?.setParams) {
        navigation.setParams({ bookId: current.bookId, title: current.title });
      }
    });
    return unsubscribe;
  }, [bookId, navigation]);

  const [resolved, setResolved] = useState<{ bookId: string; positionSeconds?: number } | null>(
    null,
  );
  // Bumped only by "Resume from there" below, to force `AudioPlayerScreen` to remount with the
  // adopted `initialPosition` — its own `key={bookId}` already forces one on a genuine book change,
  // this extends that to "the same book, a newly adopted position."
  const [resumeGeneration, setResumeGeneration] = useState(0);
  const lastWriteAtRef = useRef(0);
  // The freshest PAUSED/settled position this device knows — set by onPositionCommit only (pause,
  // seek, unmount), NOT by the continuous onPositionChange ticks. This is deliberately narrower
  // than ReaderRouteScreen's equivalent ref: `onBeforePlay` only ever fires while paused (Play is
  // only reachable from a paused state), so this is always "the position about to be resumed from"
  // when it matters, never a live-playing value the comparison would need to unwind.
  const lastPausedPositionSecondsRef = useRef<number | null>(null);
  // Shared between `handleBeforePlay` and the live-conflict effect below, so only one Alert can
  // ever be up at a time — see this file's header for why that race is not actually reachable
  // today (a non-cancelable Alert blocks the Play button underneath it) but is guarded anyway.
  const conflictPendingRef = useRef(false);
  // Mirrors ReaderRouteScreen.tsx's own fix: a notification that arrives while the live-conflict
  // Alert is already up still needs somewhere to land, since `Alert.alert` cannot be refreshed
  // once shown.
  const latestIncomingRef = useRef<(Locator & { type: 'AUDIO' }) | null>(null);
  // For the live-conflict effect's `isPlaying()`/`currentPositionSeconds()`/`pause()` — see
  // `AudioPlayerScreenHandle`'s own doc comment.
  const audioPlayerScreenRef = useRef<AudioPlayerScreenHandle>(null);

  // Shared by every `syncEngine.run()` call site in this file that cares about THIS book
  // specifically — see this file's header for why an undownloaded audiobook needs the same
  // per-book top-up EPUB/PDF's equivalent already had.
  const syncForThisBook = useCallback(async (): Promise<void> => {
    await syncEngine.run();
    const downloaded = await downloadStore.currentForBook(bookId);
    if (!downloaded) await syncEngine.pullBook(bookId);
  }, [bookId]);

  useEffect(() => {
    let cancelled = false;
    // Reset to "not yet written this run" for the NEW book — the throttle is per-book, and a stale
    // timestamp from a previous book must not swallow this book's first write.
    lastWriteAtRef.current = 0;
    lastPausedPositionSecondsRef.current = null;
    conflictPendingRef.current = false;
    latestIncomingRef.current = null;

    void syncForThisBook()
      .then(() => progressStore.currentLocator(undefined, bookId))
      .then((locator) => {
        if (cancelled) return;
        const positionSeconds = locator?.type === 'AUDIO' ? locator.positionMs / 1000 : undefined;
        lastPausedPositionSecondsRef.current = positionSeconds ?? null;
        setResolved({ bookId, positionSeconds });
      });

    return () => {
      cancelled = true;
    };
  }, [bookId, syncForThisBook]);

  const writeProgress = useCallback(
    (positionSeconds: number) => {
      void progressStore.savePosition(
        { type: 'AUDIO', positionMs: Math.round(positionSeconds * 1000) },
        bookId,
      );
    },
    [bookId],
  );

  const handlePositionChange = useCallback(
    (positionSeconds: number) => {
      const now = Date.now();
      if (now - lastWriteAtRef.current < AUDIO_PROGRESS_WRITE_THROTTLE_MS) return;
      lastWriteAtRef.current = now;
      writeProgress(positionSeconds);
    },
    [writeProgress],
  );

  // The pause/seek/unmount edges: a tick may never arrive to report this position, so this bypasses
  // the throttle rather than waiting for it. Also the ONLY place `lastPausedPositionSecondsRef`
  // updates — see that ref's own comment for why tracking every tick would be the wrong signal.
  const handlePositionCommit = useCallback(
    (positionSeconds: number) => {
      lastPausedPositionSecondsRef.current = positionSeconds;
      lastWriteAtRef.current = Date.now();
      writeProgress(positionSeconds);
    },
    [writeProgress],
  );

  // Shared by both conflict paths below (the play-gate's Alert and the live-conflict effect's) —
  // re-confirms THIS device's position with a fresh, later timestamp, so it wins the next
  // comparison anywhere else this book syncs to, same reasoning as ReaderRouteScreen.tsx's own
  // "Continue here".
  const resolveConflictContinueHere = useCallback(
    (positionSeconds: number) => {
      conflictPendingRef.current = false;
      latestIncomingRef.current = null;
      writeProgress(positionSeconds);
    },
    [writeProgress],
  );

  const resolveConflictJumpThere = useCallback(
    (locator: Locator & { type: 'AUDIO' }) => {
      conflictPendingRef.current = false;
      latestIncomingRef.current = null;
      // Cleared, not left stale: this resolves to a REMOUNT below, and nothing has reported a
      // fresh paused position for the new instance yet.
      lastPausedPositionSecondsRef.current = null;
      setResolved({ bookId, positionSeconds: locator.positionMs / 1000 });
      setResumeGeneration((generation) => generation + 1);
    },
    [bookId],
  );

  // The play-gate: see this file's header for why this replaces a background subscription for
  // AUDIO specifically. Runs a fresh sync + read on every Play press — cheap relative to the
  // alternative (playing from a position another device has already moved past) — and only
  // escalates past `CONFLICT_THRESHOLD_MS`.
  const handleBeforePlay = useCallback(async (): Promise<boolean> => {
    const displayedSeconds = lastPausedPositionSecondsRef.current;
    if (displayedSeconds === null) return true; // nothing paused-and-known yet to compare against

    await syncForThisBook();
    const incoming = await progressStore.currentLocator(undefined, bookId);
    if (incoming === null || incoming.type !== 'AUDIO') return true;

    const displayedMs = Math.round(displayedSeconds * 1000);
    const diffMs = Math.abs(incoming.positionMs - displayedMs);

    if (diffMs <= CONFLICT_THRESHOLD_MS) {
      // Last-write-wins, SILENTLY, for a difference too small to bother a listener over.
      // `incoming` is not a guess — the `syncEngine.run()` above already resolved local-vs-remote
      // for this exact row (`syncableTable.ts`'s own row-level LWW), so it IS the correct value;
      // the only thing left undone was updating THIS device's bookkeeping to match. Adopting it
      // here (rather than leaving `displayedSeconds` on record) is what makes the NEXT play-gate
      // check, and the NEXT write, compare against/build on the winning position instead of the
      // one that just lost. No reseek, no remount — a sub-5s difference is inaudible on resume,
      // so playback proceeds from wherever the player already sits paused.
      lastPausedPositionSecondsRef.current = incoming.positionMs / 1000;
      return true;
    }

    conflictPendingRef.current = true;
    return new Promise<boolean>((resolve) => {
      Alert.alert(
        'Playback progress updated',
        'Your progress in this title was updated on another device. Resume from there, or continue playing here?',
        [
          {
            text: 'Continue here',
            style: 'cancel',
            onPress: () => {
              resolveConflictContinueHere(displayedSeconds);
              resolve(true);
            },
          },
          {
            text: 'Resume from there',
            onPress: () => {
              resolveConflictJumpThere(incoming);
              // The screen is about to remount at the adopted position — this specific Play press
              // targets a position that is going away, so it does not proceed.
              resolve(false);
            },
          },
        ],
        // EXPLICIT — see ReaderRouteScreen.tsx's identical option for why this is written down
        // rather than left to Android's already-`false` default and iOS's lack of a tap-outside
        // gesture: resolving this is compulsory before playback can proceed either way, since the
        // `Promise<boolean>` this dialog resolves is what `onBeforePlay` is waiting on.
        { cancelable: false },
      );
    });
  }, [bookId, syncForThisBook, resolveConflictContinueHere, resolveConflictJumpThere]);

  const positionReady = resolved?.bookId === bookId;

  // The pull half of live conflict detection — see `AUDIO_LIVE_SYNC_POLL_MS`'s own comment for why
  // the subscribe-based effect below needs this. Identical shape to ReaderRouteScreen.tsx's own
  // foreground-edge + poll pair, just renamed to this file's constant.
  useEffect(() => {
    if (!positionReady) return;
    let wasActive = AppState.currentState === 'active';
    let pollId: ReturnType<typeof setInterval> | null = null;

    const startPoll = () => {
      if (pollId !== null) return;
      pollId = setInterval(() => {
        void syncForThisBook();
      }, AUDIO_LIVE_SYNC_POLL_MS);
    };
    const stopPoll = () => {
      if (pollId === null) return;
      clearInterval(pollId);
      pollId = null;
    };

    if (wasActive) startPoll();

    const subscription = AppState.addEventListener('change', (state) => {
      const isActive = state === 'active';
      if (isActive && !wasActive) {
        void syncForThisBook();
        startPoll();
      } else if (!isActive) {
        stopPoll();
      }
      wasActive = isActive;
    });

    return () => {
      stopPoll();
      subscription?.remove?.();
    };
  }, [positionReady, syncForThisBook]);

  // Live cross-device conflict detection WHILE PLAYING — see this file's header for the full
  // account of why this is safe where an early design for the same idea was not. Only starts once
  // the initial resume has resolved, so it never reacts to the very sync pull that fed it.
  useEffect(() => {
    if (!positionReady) return;
    let cancelled = false;
    const unsubscribe = progressStore.subscribe(() => {
      if (cancelled) return;
      const handle = audioPlayerScreenRef.current;
      if (!handle?.isPlaying()) return; // paused case is handleBeforePlay's job, not this effect's
      const displayedSeconds = handle.currentPositionSeconds();
      void progressStore.currentLocator(undefined, bookId).then((incoming) => {
        if (cancelled || incoming === null || incoming.type !== 'AUDIO') return;
        const diffMs = Math.abs(incoming.positionMs - Math.round(displayedSeconds * 1000));
        if (diffMs <= CONFLICT_THRESHOLD_MS) return; // this device's own echo, or clock noise
        latestIncomingRef.current = incoming;
        if (conflictPendingRef.current) return;
        conflictPendingRef.current = true;
        // Pauses BEFORE the Alert shows, both so the compared position stops moving and so the
        // reader is not left listening to audio that no longer matches where the app is about to
        // say it is. Re-reads the position AFTER pausing, not the pre-await `displayedSeconds`
        // above, since the player kept playing for however long the `currentLocator()` read took.
        handle.pause();
        const pausedAtSeconds = handle.currentPositionSeconds();
        Alert.alert(
          'Playback progress updated',
          'Playback has been paused — your progress in this title was updated on another ' +
            'device. Resume from there, or continue playing here?',
          [
            {
              text: 'Continue here',
              style: 'cancel',
              onPress: () => {
                if (!cancelled) resolveConflictContinueHere(pausedAtSeconds);
              },
            },
            {
              text: 'Resume from there',
              onPress: () => {
                if (!cancelled) resolveConflictJumpThere(latestIncomingRef.current ?? incoming);
              },
            },
          ],
          { cancelable: false },
        );
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [positionReady, bookId, resolveConflictContinueHere, resolveConflictJumpThere]);

  if (!positionReady) {
    return <Loader testID="audio-route-loading" />;
  }

  return (
    <View style={styles.container}>
      <AudioPlayerScreen
        ref={audioPlayerScreenRef}
        key={`${bookId}:${resumeGeneration}`}
        bookId={bookId}
        title={title}
        coverUrl={coverUrl}
        onBack={navigation.goBack}
        initialPosition={resolved.positionSeconds}
        onPositionChange={handlePositionChange}
        onPositionCommit={handlePositionCommit}
        onBeforePlay={handleBeforePlay}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.white },
});
