// src/features/queue/offerPolling.ts
// D16 — the queue offer poll. `LicenceSource.getChanges` is flambeau's sync feed;
// this is the one thing that reads it today, watching for `HOLD_PROMOTED` and turning
// it into a live offer in `offerStore`.
//
// A PROMOTION IS A TRIGGER, NOT A HOLD. The change feed's `ChangeEntry` carries no
// `offerId` and no expiry — see the note on it in model/types.ts. So seeing
// `HOLD_PROMOTED` means "go read `getLibrary`", never "here is the offer".
//
// 60 SECONDS, PER THE TASK. `offerLapse.ts` notes the offer window is 15 minutes, so
// a minute between polls spends a fifteenth of it — a real cost, but the one the task
// asked for, and this file does not invent a shorter cadence on top.
//
// `useOfferPolling` READS `getLicenceSource()` ITSELF, matching how the screens in
// this tree reach the licence layer (`ItemDetailScreen` calls it inline rather than
// taking it as a prop) — a test swaps it out with `jest.mock('@config/licence', ...)`,
// same seam those screens' own tests already use. `pollOfferChanges` below stays a
// plain function taking a `LicenceSource`, so it needs none of that to be tested.
import { useEffect } from 'react';
import { AppState } from 'react-native';
import type { LicenceSource } from '@/licence';
import { isLicenceFailure, LicenceError } from '@/licence/LicenceSource';
import { getLicenceSource } from '@config/licence';
import { useOfferStore } from '@store/offerStore';

export const POLL_INTERVAL_MS = 60_000;

/**
 * One tick of the poll: reads changes since `since`, and if any of them is a
 * promotion, reads the library and hands every currently-offered hold to
 * `offerStore.receiveOffer`. Returns the cursor for the next tick.
 *
 * Exported on its own — this is the part worth testing directly; the interval
 * wrapper around it is not.
 */
export async function pollOfferChanges(
  source: LicenceSource,
  since: string | undefined,
): Promise<string> {
  const page = await source.getChanges(since);
  const promoted = page.changes.some((entry) => entry.reason === 'HOLD_PROMOTED');

  if (promoted) {
    const library = await source.getLibrary();
    for (const hold of library.holds) {
      if (hold.state === 'offered') useOfferStore.getState().receiveOffer(hold);
    }
  }

  return page.nextCursor;
}

/**
 * Starts the 60-second poll for as long as the calling component is mounted.
 *
 * ALSO PULLS ON THE FOREGROUND EDGE, same shape as `ReaderRouteScreen.tsx`'s own
 * AppState-driven sync poll, and for the same reason: `setInterval` is throttled/paused
 * while the app is backgrounded, so without this, an offer promoted while the phone was
 * in the reader's pocket sat undelivered for the ENTIRE background duration, not just up
 * to 60s — the interval alone only ever closes the gap between two foreground ticks.
 */
export function useOfferPolling(): void {
  useEffect(() => {
    const source = getLicenceSource();
    let since: string | undefined;
    let stopped = false;

    async function tick() {
      let nextCursor: string;
      try {
        nextCursor = await pollOfferChanges(source, since);
      } catch (err) {
        // A network hiccup (NETWORK_UNAVAILABLE/TIMEOUT) is ordinary on mobile — leave
        // `since` where it was and try again next tick rather than losing the reader's
        // place in the feed. Silently.
        //
        // Anything else is not ordinary, and previously vanished into this same silent
        // return — including normalizeLicence.ts's OWN deliberately loud
        // `MALFORMED_RESPONSE` throw for a change-feed reason it doesn't recognise
        // ("loud rather than dropped", per that file's comment). Swallowing it here made
        // that throw pointless: `since` never advances past the bad page, so every future
        // tick re-fetches the identical page and fails identically, forever, with nobody
        // ever told. Not fixed by retrying differently — this needs a person, which is
        // why it's logged rather than silently worked around.
        //
        // ALSO ORDINARY: REFUSED for any auth-related reason. QueueNotificationHost (this poll's
        // only caller) mounts unconditionally at the app root (RootNavigator.tsx), alongside the
        // signed-out StartupGate flow — so this fires on a fixed 60s cadence for every reader who
        // simply hasn't signed in yet, or whose session lapsed. That is the normal, expected state
        // of a large fraction of app launches, not a contract violation.
        //
        // THREE DISTINCT CODES, NOT ONE — a first pass here only listed UNAUTHENTICATED/
        // TOKEN_EXPIRED and still logged loudly for every signed-out reader, because the backend's
        // OWN ErrorCode enum (common/error/ErrorCode.java) has a THIRD, separate code —
        // TOKEN_MISSING — specifically for "no bearer token was presented at all," which is
        // exactly what a signed-out client sends (there is no token to attach). `errorCode` here
        // is read as a raw wire string (ApiLicenceClient.ts's `refusal()`), not filtered through
        // this app's own ErrorCode union, so a backend code this app has no UI copy for still
        // compares correctly by name.
        const AUTH_REFUSAL_CODES = new Set(['UNAUTHENTICATED', 'TOKEN_EXPIRED', 'TOKEN_MISSING']);
        const isOrdinary =
          isLicenceFailure(err) &&
          (err.code === LicenceError.NETWORK_UNAVAILABLE ||
            err.code === LicenceError.TIMEOUT ||
            (err.code === LicenceError.REFUSED &&
              err.errorCode !== undefined &&
              AUTH_REFUSAL_CODES.has(err.errorCode)));
        if (!isOrdinary) {
          // errorCode logged explicitly, not just the LicenceFailure itself — its default
          // console rendering (`[LicenceFailure: REFUSED]`) hides the one field that actually
          // says why, which is exactly what made THIS gap take two rounds to pin down.
          console.error(
            '[offerPolling] unexpected failure reading the change feed — offers will stop updating until this is fixed:',
            isLicenceFailure(err) ? { code: err.code, errorCode: err.errorCode } : err,
          );
        }
        return;
      }
      if (!stopped) since = nextCursor;
    }

    let wasActive = AppState.currentState === 'active';
    let interval: ReturnType<typeof setInterval> | null = null;

    const startInterval = () => {
      if (interval !== null) return;
      interval = setInterval(tick, POLL_INTERVAL_MS);
    };
    const stopInterval = () => {
      if (interval === null) return;
      clearInterval(interval);
      interval = null;
    };

    tick();
    if (wasActive) startInterval();

    const subscription = AppState.addEventListener('change', (state) => {
      const isActive = state === 'active';
      if (isActive && !wasActive) {
        void tick();
        startInterval();
      } else if (!isActive && wasActive) {
        stopInterval();
      }
      wasActive = isActive;
    });

    return () => {
      stopped = true;
      stopInterval();
      subscription.remove();
    };
  }, []);
}
