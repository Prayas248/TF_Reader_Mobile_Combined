// The Reader route: reads `{ bookId, format }` from navigation params and renders ReaderScreen,
// replacing App.tsx's old inline mount (`<ReaderScreen key={bookId} bookId={bookId} />`) plus its
// header-row DevPreferencesMenu. This screen owns no book-selection state of its own — native-stack
// gives it a fresh instance (and a working back button to BookList) per navigate() call, which is
// exactly what ReaderScreen's own "callers must key on bookId" contract asks for; here that key
// comes from being a distinct route push rather than a hand-written `key` prop.
//
// PROGRESS WIRING LIVES HERE, NOT IN ReaderScreen. `progressStore` (durable, synced, via
// `readerProgressStore.ts`'s conversions) is a navigation-session concern, and ReaderScreen's own
// `initialTarget`/`onRelocated` props are deliberately ignorant of where a target comes from or
// where a position goes — see their doc comments in ReaderScreen.tsx. Mirrors
// AudioPlayerRouteScreen.tsx's shape for AUDIO exactly now — see below for why an earlier version
// of this file did not.
//
// THERE IS NO IN-MEMORY SESSION CACHE HERE ANY MORE, ON PURPOSE. An earlier version kept one
// (`sessionProgress.ts`, since deleted) as a same-app-run fast path, reasoning that `progressStore`
// was only needed as a cold-start/cross-device fallback. That was wrong for a reason worth stating
// so it doesn't come back: the cache had no way to learn about a fresher position written
// elsewhere — another device syncing in a further-along position while this book sat merely
// BACKGROUNDED (not relaunched) on this one — so a stale in-memory value could outrank the
// genuinely current row in `progressStore` for the rest of this app run. `progressStore` is the
// only source of truth now, matching AUDIO, at the cost of always paying its async read (and
// showing the loading gate below) rather than only on a cold start.
//
// AND THE LOCAL `progressStore` ROW ITSELF CAN BE STALE, WHICH IS WHY THE RESOLVE EFFECT BELOW
// ALSO CALLS `syncEngine.run()` FIRST. `src/features/sync/useAutoSync.ts` (mounted once, at the
// app root) only re-syncs on an actual NetInfo offline->online EDGE — backgrounding and
// foregrounding the app while the connection never actually drops (the common case) fires no such
// edge, so nothing pulls in a position another device wrote while this device was merely
// backgrounded. Awaiting `syncEngine.run()` here — before reading `currentLocator()`, not before
// rendering unconditionally — closes that gap at the one moment it actually matters: resolving a
// resume target. `syncEngine.run()` is public exactly for this (concurrent calls share one run
// rather than racing, so this costs nothing extra if `useAutoSync`'s own trigger already has one
// in flight) and never rejects (`execute()` catches internally), so no `.catch()` is needed. This
// calls `src/features/sync/`'s existing public API rather than changing anything inside it, but it
// is a new coupling Karthik should know about — noted in CLAUDE.md's "Reading-position resume"
// section rather than left to be discovered from a git blame.
//
// THAT GAP ALSO EXISTS *WHILE THIS SCREEN STAYS OPEN*, NOT JUST AT RESUME — same root cause
// (`useAutoSync`'s edge-only trigger), different moment: staying foregrounded the whole time while
// another device writes fires no NetInfo edge either. `READER_LIVE_SYNC_POLL_MS`'s effect below
// covers that with a foreground-edge pull plus a low-frequency poll, both Reader-only — see that
// constant's own comment for why Audio doesn't need the same thing.
//
// AN ALREADY-OPEN SCREEN IS ALSO COVERED NOW, BUT BY ASKING RATHER THAN BY JUMPING SILENTLY. Once
// resolved, this screen subscribes to `progressStore`'s change notifications (fired on every local
// write AND on every pulled server record that actually applied — `syncableTable.ts`'s own doc).
// On each one, it compares the freshly-read `currentLocator()` against what THIS device currently
// has on screen (`toLocator(lastPositionRef.current)`, not the last thing written — the two can
// differ inside the write throttle window, and it's what's DISPLAYED that a conflict is relative
// to). Equal (via `locatorsEqual`, not `===`) covers both "unchanged" and "that notification was
// just an echo of this device's own write" — nothing to do either way. Different means another
// device really did move this book while this one was open, and rather than silently relocating a
// reader who may already be several pages past either position, `Alert.alert` offers the choice:
// "Continue here" flushes the CURRENT on-screen position through (a fresh, later timestamp than the
// one that just arrived, so it wins the next comparison anywhere else this book syncs to);
// "Resume from there" adopts the incoming locator as a new `initialTarget` and forces a remount
// (`resumeGeneration` in the `key` below) — the same mechanism a cold-start resume already uses,
// since `ReaderScreen`'s own contract says a new `initialTarget` needs a remount, not a live prop
// change. Either choice goes through the SAME `progressStore`/outbox path every other write does,
// so a second device converges on it the ordinary way, next time IT syncs — no new wire format.
//
// DevPreferencesMenu GOES THROUGH `toolbarExtra`, NOT a sibling overlay. Two earlier shapes each
// broke something: `headerRight` got clipped by react-native-screens' native header (no visible
// dropdown), and a same-tree absolutely-positioned overlay landed on top of — and ate touches for —
// ReaderScreen's own right-aligned toolbar (search/TTS), since both anchored to the same corner.
// Passing it INTO ReaderScreen's own toolbar row is what makes "share one row, preferences
// rightmost" a layout guarantee instead of two files' pixel math staying in sync by luck.


import { useCallback, useEffect, useRef, useState } from 'react';

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Alert, AppState, StyleSheet, View } from 'react-native';

import Loader from '@components/Loader';
import type { ReaderPosition, ReaderTarget } from '@/features/reader/readerBridge';
import { ReaderScreen } from '@/features/reader/ReaderScreen';
import type { ReaderScreenHandle } from '@/features/reader/ReaderScreen';
import { locatorsEqual, targetFromLocator, toLocator } from '@/features/reader/readerProgressStore';
import { syncEngine } from '@/features/sync/syncEngine';
import { downloadStore } from '@/features/sync/stores/downloadStore';
import { progressStore } from '@/features/sync/stores/progressStore';
import type { BookId, Locator } from '@/shared/contracts';

import { color } from '@theme/tokens';

import { DevPreferencesMenu } from '../../DevPreferencesMenu';
import type { CatalogueStackParamList } from './types';

// Registered identically in both CatalogueStackParamList and SearchStackParamList (integration_ref.md
// Phase 2.1) — Catalogue's shape is used here for typing since the two are structurally identical
// for every route name this screen navigates to.
type Props = NativeStackScreenProps<CatalogueStackParamList, 'Reader'>;

// Reading is user-paced far below AUDIO's 250ms tick rate, but PDF's scroll-mode `virtualize()`
// (pdf.entry.ts) posts `relocated` on every rAF during a continuous drag — unthrottled writes there
// would be dozens of SQLite writes a second for a value nobody reads until the next launch or
// another device pulls it. 3s keeps it well under 1/s while still landing well inside a reader's
// dwell time on any position that matters.
const READER_PROGRESS_WRITE_THROTTLE_MS = 3_000;

// Closes a live-pull gap `useAutoSync.ts` leaves open: that hook only re-syncs on a NetInfo
// offline->online EDGE, mounted once at the app root, so staying foregrounded the whole time while
// another device writes (the common case for two devices on the same wifi) fires nothing at all.
// Reader-only, on purpose — AudioPlayerRouteScreen.tsx already re-checks synchronously at the one
// moment that matters (immediately before Play, its own `onBeforePlay` gate) and would
// false-positive against its own continuous position drift if it also polled in the background;
// see that file's header comment for why a subscription/poll shape was rejected there specifically.
const READER_LIVE_SYNC_POLL_MS = 120_000;

export function ReaderRouteScreen({ route, navigation }: Props): React.JSX.Element {
  const { bookId, format, title: routeTitle, initialTarget: routeTarget } = route.params;

  // The native-stack header is hidden for this route (see RootNavigator.tsx) — ReaderScreen draws
  // its own back button and title bar instead, matching AudioPlayerScreen's identical shape, so
  // this no longer needs to feed `navigation.setOptions({ title })` for a header that isn't shown.

  // Hides the shared four-tab bar for exactly this screen, same as ItemDetailScreen.tsx's identical
  // effect (see that file's own comment for the full mechanism) — a full-screen reader has no tab
  // bar to share space with.
  useEffect(() => {
    navigation.getParent()?.setOptions({ tabBarStyle: { display: 'none' } });
    return () => navigation.getParent()?.setOptions({ tabBarStyle: undefined });
  }, [navigation]);

  // Tagged with the bookId it resolved for, so a resolution in flight for a PREVIOUS book cannot
  // leak into this book's initialTarget — this screen persists across bookId param changes (see
  // ReaderScreen's own `key={bookId}` below), it does not remount. Same race-guard
  // AudioPlayerRouteScreen.tsx uses for its own `progressStore.currentLocator()` call, and the same
  // reason: setting state synchronously at the top of the effect body, before the query resolves,
  // is exactly what this repo's `react-hooks/set-state-in-effect` lint rule forbids.
  const [resolved, setResolved] = useState<{ bookId: BookId; target?: ReaderTarget } | null>(null);

  // Bumped only by "Resume from there" below, to force `ReaderScreen` to remount with the adopted
  // `initialTarget` — the same requirement a cold-start resume already has (see `initialTarget`'s
  // own doc comment in ReaderScreen.tsx: read once, at mount, a genuinely new target needs a new
  // instance). Not touched by anything else, so it never causes an unrelated remount.
  const [resumeGeneration, setResumeGeneration] = useState(0);

  // Shared by every `syncEngine.run()` call site below that cares about THIS book specifically —
  // the resume effect, and (see the live-pull effect further down) the foreground/poll triggers
  // too. The regular sweep inside `syncEngine.run()` only refreshes progress for books this device
  // has a local `downloads` row for (see `syncEngine.pullBook`'s own doc) — a book read online
  // without ever being downloaded is invisible to it, no matter how long another device has had a
  // position for it, and no matter how long BOTH devices stay online. Without this top-up, that
  // was true only at resume; putting it here too closes the same gap for the live poll, which
  // otherwise silently never refreshes such a book at all, indefinitely.
  const syncForThisBook = useCallback(async (): Promise<void> => {
    await syncEngine.run();
    const downloaded = await downloadStore.currentForBook(bookId);
    if (!downloaded) await syncEngine.pullBook(bookId);
  }, [bookId]);

  useEffect(() => {
    let cancelled = false;
    // A caller-supplied target (e.g. a tapped bookmark elsewhere in the app) is a deliberate
    // "go here" instruction, not a fallback to query around — skip the read entirely, but still
    // resolve it through a `.then()` rather than synchronously: `setState` directly in an effect
    // body is exactly what this repo's `react-hooks/set-state-in-effect` lint rule forbids, and
    // routing both branches through the same microtask keeps this one function, not two shapes.
    const target: Promise<ReaderTarget | undefined> =
      routeTarget !== undefined
        ? Promise.resolve(routeTarget)
        : syncForThisBook()
            .then(() => progressStore.currentLocator(undefined, bookId))
            .then((locator) => targetFromLocator(locator) ?? undefined);
    void target.then((resolvedTarget) => {
      if (cancelled) return;
      setResolved({ bookId, target: resolvedTarget });
    });
    return () => {
      cancelled = true;
    };
  }, [bookId, routeTarget, syncForThisBook]);

  const resolvedReady = resolved?.bookId === bookId;

  // The latest position, tracked outside React state so the throttle/flush logic below can read it
  // without re-rendering on every relocate.
  const lastPositionRef = useRef<ReaderPosition | null>(null);
  const lastWriteAtRef = useRef(0);
  // Guards against stacking a second cross-device conflict Alert — declared here, not beside the
  // effect that uses it below, so the per-book reset effect can clear it too. `latestIncomingRef`
  // sits beside it for the same reason: a notification that arrives while an Alert is already up
  // still needs somewhere to land, since `Alert.alert` has no imperative dismiss OR update — without
  // this, a user who leaves the dialog open through a second (or third) notification would have
  // "Resume from there" adopt the FIRST notification's locator, not the latest one.
  const conflictPendingRef = useRef(false);
  const latestIncomingRef = useRef<Locator | null>(null);
  // For pausing an active TTS session the instant a conflict is found — see the Alert-triggering
  // effect below and `ReaderScreenHandle`'s own doc comment for why this exists.
  const readerScreenRef = useRef<ReaderScreenHandle>(null);

  const flushProgress = useCallback(() => {
    const position = lastPositionRef.current;
    if (position === null) return;
    const locator = toLocator(position);
    if (locator === null) return; // an EPUB `relocated` before its rendition produced a CFI
    void progressStore.savePosition(locator, bookId);
  }, [bookId]);

  const handleRelocated = useCallback(
    (position: ReaderPosition) => {
      lastPositionRef.current = position;
      const now = Date.now();
      if (now - lastWriteAtRef.current < READER_PROGRESS_WRITE_THROTTLE_MS) return;
      lastWriteAtRef.current = now;
      flushProgress();
    },
    [flushProgress],
  );

  // `ReaderScreen`'s own `tearDownAndLock` already stopped the monitor, closed the book and
  // shown the inline banner by the time this fires — this is only the louder, modal half a
  // reader expects for losing a book mid-read, same idiom as the cross-device-conflict
  // `Alert.alert` above. Compulsory (`cancelable: false`), same reasoning as that one: the
  // book is already gone, so there is nothing to silently dismiss back into — the reader must
  // acknowledge it, which is also the moment this screen leaves (`navigation.goBack()`), since
  // staying on a permanently locked reader with nothing left to do is not a real option.
  const handleLocked = useCallback(() => {
    Alert.alert(
      'Access ended',
      'Your access to this title has ended, most likely because its licence expired. ' +
        'You can grant access again from its details page to continue.',
      [{ text: 'OK', onPress: () => navigation.goBack() }],
      { cancelable: false },
    );
  }, [navigation]);

  // Resets the throttle for a new book — a stale timestamp from a previous book must not swallow
  // this book's first write — and flushes on the way out, covering both a genuine unmount (normal
  // back-navigation) and a bookId change on this same persistent instance (switching books without
  // this screen itself being torn down).
  useEffect(() => {
    lastWriteAtRef.current = 0;
    lastPositionRef.current = null;
    // Also clears a conflict prompt left pending for the PREVIOUS book. React Native's `Alert` has
    // no imperative dismiss, so a dialog already on screen can briefly outlive the book it was
    // about if the user switches without answering — but its buttons already no-op via the
    // subscription effect's own `cancelled` guard, and this at least stops it from permanently
    // blocking a genuine conflict prompt for the NEW book.
    conflictPendingRef.current = false;
    latestIncomingRef.current = null;
    return () => {
      flushProgress();
    };
  }, [bookId, flushProgress]);

  // The backgrounding edge: catches a position recorded inside the current throttle window before
  // a possible force-quit. Text position cannot change once backgrounded, so — unlike
  // audioPlayerInstance.ts's equivalent — there is no "still playing" case to keep tracking, and no
  // reason to host this in a separate singleton module reachable after this screen is gone.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') flushProgress();
    });
    return () => subscription.remove();
  }, [flushProgress]);

  // Live pull while this screen stays open — see `READER_LIVE_SYNC_POLL_MS`'s own comment for why
  // this exists and why it's Reader-only. Gated on `resolvedReady` so it can't race the initial
  // resolve effect above, and it restarts cleanly on every book switch (this screen persists across
  // `bookId` changes; `resolvedReady` goes false for the instant in between).
  useEffect(() => {
    if (!resolvedReady) return;
    let wasActive = AppState.currentState === 'active';
    let pollId: ReturnType<typeof setInterval> | null = null;

    const startPoll = () => {
      if (pollId !== null) return;
      pollId = setInterval(() => {
        void syncForThisBook();
      }, READER_LIVE_SYNC_POLL_MS);
    };
    const stopPoll = () => {
      if (pollId === null) return;
      clearInterval(pollId);
      pollId = null;
    };

    if (wasActive) startPoll();

    const subscription = AppState.addEventListener('change', (state) => {
      const isActive = state === 'active';
      // The edge into active — not merely "is active" — mirrors `useAutoSync.ts`'s own
      // edge-detection shape: re-syncing on every unrelated re-render here would be a no-op given
      // `syncEngine.run()`'s dedup, but tracking the edge keeps this effect's intent legible.
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
      subscription.remove();
    };
  }, [resolvedReady, syncForThisBook]);

  const resolveConflictContinueHere = useCallback(() => {
    conflictPendingRef.current = false;
    latestIncomingRef.current = null;
    // Re-flushes the CURRENTLY DISPLAYED position (not the one that just arrived) with a fresh,
    // later timestamp, so it wins the next LWW comparison anywhere else this book syncs to —
    // same monotonic stamping every other write already relies on (syncableTable.ts's own note).
    flushProgress();
  }, [flushProgress]);

  const resolveConflictJumpThere = useCallback(
    (locator: Locator) => {
      conflictPendingRef.current = false;
      latestIncomingRef.current = null;
      // Cleared, not left stale: the remount below will report a fresh `relocated` for the
      // adopted position shortly, but until then there is nothing on screen to compare a NEW
      // notification against, and a stale pre-jump position would produce a false positive.
      lastPositionRef.current = null;
      setResolved({ bookId, target: targetFromLocator(locator) ?? undefined });
      setResumeGeneration((generation) => generation + 1);
    },
    [bookId],
  );

  // Cross-device conflict detection for an ALREADY-OPEN screen — see this file's header for the
  // full account of why this asks rather than jumps silently. Only starts once the initial resume
  // has resolved, so it never reacts to the very sync pull that fed that resolution.
  useEffect(() => {
    if (!resolvedReady) return;
    let cancelled = false;
    const unsubscribe = progressStore.subscribe(() => {
      if (cancelled) return;
      const displayed = lastPositionRef.current !== null ? toLocator(lastPositionRef.current) : null;
      if (displayed === null) return; // nothing on screen yet to compare against
      void progressStore.currentLocator(undefined, bookId).then((incoming) => {
        if (cancelled || incoming === null) return;
        if (locatorsEqual(incoming, displayed)) return; // unchanged, or an echo of our own write
        const incomingTarget = targetFromLocator(incoming);
        if (incomingTarget === null) return; // e.g. a corrupt/AUDIO-shaped row — nothing to offer
        // Keeps advancing even while an Alert is already up — `Alert.alert` can't be refreshed
        // once shown, so this is the only place a late answer can pick up a NEWER conflict than
        // the one that first triggered it.
        latestIncomingRef.current = incoming;
        if (conflictPendingRef.current) return;
        conflictPendingRef.current = true;
        // Freezes `lastPositionRef` before the user sees the dialog: an active TTS session
        // (`useTtsSession`'s `autoContinueChapter`) keeps turning pages while it reads, which
        // would otherwise make "the currently displayed position" a moving target for as long as
        // the Alert sits unanswered, and would have the voice talking over whatever a screen
        // reader announces for the dialog itself (CLAUDE.md's Reader-accessibility rule 3: TTS and
        // a screen reader share one output device and neither ducks). Left paused on either
        // answer, on purpose — same "never silently continue" reasoning as everything else in this
        // effect; the user presses Play again if they want to keep listening.
        const pausedTts = readerScreenRef.current?.pauseTtsIfSpeaking() ?? false;
        Alert.alert(
          'Reading progress updated',
          pausedTts
            ? 'Your progress in this title was updated on another device. Text-to-speech has been paused. Resume from there, or continue reading here?'
            : 'Your progress in this title was updated on another device. Resume from there, or continue reading here?',
          [
            {
              text: 'Continue here',
              style: 'cancel',
              onPress: () => {
                if (!cancelled) resolveConflictContinueHere();
              },
            },
            {
              text: 'Resume from there',
              onPress: () => {
                if (!cancelled) resolveConflictJumpThere(latestIncomingRef.current ?? incoming);
              },
            },
          ],
          // EXPLICIT, not relying on the platform default: Android's own default is already
          // `cancelable: false` when this option is omitted (RN's `Alert.js` hardcodes it unless
          // overridden), and iOS's `.alert`-style `UIAlertController` has no tap-outside-to-dismiss
          // gesture at all — but "resolving this is compulsory" is a real product requirement here,
          // not an accident of an unset default, so it is written down rather than left implicit
          // for the next person to accidentally flip by passing `cancelable: true`.
          { cancelable: false },
        );
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [resolvedReady, bookId, resolveConflictContinueHere, resolveConflictJumpThere]);

  if (!resolvedReady) {
    return <Loader testID="reader-route-loading" />;
  }

  return (
    <View style={styles.container}>
      <ReaderScreen
        ref={readerScreenRef}
        key={`${bookId}:${resumeGeneration}`}
        bookId={bookId}
        title={routeTitle ?? format}
        onBack={navigation.goBack}
        initialTarget={resolved.target}
        onRelocated={handleRelocated}
        onLocked={handleLocked}
        toolbarExtra={<DevPreferencesMenu format={format} />}
        onOpenAccessibilityInfo={() => navigation.navigate('BookInfo', { bookId })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.white },
});
