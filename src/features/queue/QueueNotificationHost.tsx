// src/features/queue/QueueNotificationHost.tsx
// D16 — mounts the queue offer banner globally, once, at the app root. A reader who
// is not on the title's own detail screen still has to be able to answer an offer
// before it lapses, which is the whole reason `QueueNotification` and `offerStore`
// exist apart from `ItemDetailScreen`'s own accept/reject wiring.
//
// `QueueNotification` STAYS PURE — props in, callbacks out, same as every other
// component in `src/components/`. This file is where reading `offerStore` and calling
// the licence source actually happens, same split `ItemDetailScreen` already draws
// between itself and `ActionBar`.
//
// TOP PLACEMENT IS A CALL MADE HERE, NOT A DESIGN DECISION. `QueueNotification`'s own
// comment says design have not chosen top-vs-bottom. Anchoring under the safe area at
// the top means an offer is visible rather than invisible while that is unresolved —
// nothing about the component itself assumes where it sits, so moving it later is a
// one-line change to this file's style, not a rewrite.
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useOfferStore } from '@store/offerStore';
import { getLicenceSource } from '@config/licence';
import { getCatalogueSource } from '@config/catalogue';
import { isLicenceFailure, LicenceError } from '@/licence/LicenceSource';
import { WIRE_ERROR_COPY, ERROR_CODES } from '@model/errorCopy';
import type { ErrorCode } from '@model/types';
import { space } from '@theme/tokens';
import QueueNotification, { type QueueNotificationPending } from '@components/QueueNotification';

import { useOfferPolling } from './offerPolling';

const QUEUE_ACTION_GENERIC_MESSAGE = "That action couldn't be completed. Please try again.";

// Same lookup ItemDetailScreen.tsx/ReaderScreen.tsx use for a LicenceFailure: REFUSED carries
// flambeau's own errorCode in WIRE_ERROR_COPY's vocabulary; everything else gets transport-level
// copy. Kept local rather than shared — three near-identical three-line lookups is cheaper to
// read than a shared helper for something this small (see CLAUDE.md/STYLE's "no premature
// abstraction" — Ahana can promote it if a fourth caller needs it).
function messageFor(err: unknown): string {
  if (!isLicenceFailure(err)) return QUEUE_ACTION_GENERIC_MESSAGE;
  if (err.code === LicenceError.REFUSED) {
    const knownCode =
      err.errorCode !== undefined && (ERROR_CODES as readonly string[]).includes(err.errorCode)
        ? (err.errorCode as ErrorCode)
        : undefined;
    return knownCode !== undefined ? WIRE_ERROR_COPY[knownCode] : QUEUE_ACTION_GENERIC_MESSAGE;
  }
  if (err.code === LicenceError.NETWORK_UNAVAILABLE) {
    return 'You appear to be offline. Please check your connection and try again.';
  }
  if (err.code === LicenceError.TIMEOUT) {
    return 'This took too long to respond. Please try again.';
  }
  return QUEUE_ACTION_GENERIC_MESSAGE;
}

export default function QueueNotificationHost() {
  useOfferPolling();

  const offer = useOfferStore((state) => state.offer);
  const hasHydrated = useOfferStore((state) => state._hasHydrated);
  const minutesRemaining = useOfferStore((state) => state.minutesRemaining());
  const insets = useSafeAreaInsets();

  const itemId = offer?.itemId;
  // Keyed by the itemId it was resolved for, rather than reset in the effect below —
  // resetting there would be a synchronous `setState` in an effect body, which fires
  // a second render for no reason. Keeping the key alongside the title instead means
  // a stale title from the PREVIOUS offer is never shown for a new one: the render
  // below falls back to the raw id whenever `resolvedTitle.itemId` does not match.
  const [resolvedTitle, setResolvedTitle] = useState<{ itemId: string; title: string } | undefined>(
    undefined,
  );
  const [pending, setPending] = useState<QueueNotificationPending | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  // Resolved separately from the offer itself: the store knows the hold, not the
  // title, and `getItemsBatch` (F9) is the one call away the contract promises.
  useEffect(() => {
    if (itemId === undefined) return;
    let cancelled = false;
    getCatalogueSource()
      .getItemsBatch([itemId])
      .then((result) => {
        if (!cancelled) setResolvedTitle({ itemId, title: result.items[0]?.title ?? itemId });
      })
      .catch(() => {
        // A title that failed to resolve is not a reason to hide the offer — fall
        // back to the id so the reader can still act on it.
        if (!cancelled) setResolvedTitle({ itemId, title: itemId });
      });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  const title = itemId !== undefined && resolvedTitle?.itemId === itemId ? resolvedTitle.title : itemId;

  // `hasHydrated` and `minutesRemaining !== undefined` together are the same "is
  // there a live offer" question `offerStore.minutesRemaining` already answers for
  // rendering a countdown — checked again here rather than trusted, so `offer` narrows
  // to non-null below instead of relying on a boolean computed from it.
  if (!hasHydrated || offer === null || minutesRemaining === undefined) return null;

  const holdId = offer.holdId;
  // Present whenever `state` is 'offered', per `Hold`'s own contract — `minutesRemaining`
  // being defined already implies that state, so this is a defensive floor, not the
  // expected path.
  if (holdId === undefined) return null;

  // Arrow functions, not declarations — a declaration is hoisted, so TypeScript will
  // not carry the `holdId !== undefined` narrowing above into its body. A `const`
  // defined after the check keeps it.
  const handleAccept = () => {
    setPending('accept');
    setErrorMessage(undefined);
    getLicenceSource()
      .acceptOffer(holdId)
      .then(() => useOfferStore.getState().clear())
      .catch((error: unknown) => {
        // Previously: console.log only, no user-facing signal at all — a DEVICE_LIMIT_REACHED,
        // an OFFER_EXPIRED, or a plain timeout all produced the identical experience (spinner,
        // spinner stops, banner still there, nothing said). The offer stays in offerStore on
        // failure either way, so the banner reappears and the reader can retry.
        console.log('QueueNotificationHost: acceptOffer failed', error);
        setErrorMessage(messageFor(error));
      })
      .finally(() => setPending(undefined));
  };

  const handleReject = () => {
    setPending('reject');
    setErrorMessage(undefined);
    getLicenceSource()
      .cancelHold(holdId)
      .then(() => useOfferStore.getState().clear())
      .catch((error: unknown) => {
        console.log('QueueNotificationHost: cancelHold failed', error);
        setErrorMessage(messageFor(error));
      })
      .finally(() => setPending(undefined));
  };

  return (
    <View style={[styles.wrapper, { top: insets.top + space.sm }]} pointerEvents="box-none">
      <QueueNotification
        title={title ?? ''}
        expiresInMinutes={minutesRemaining}
        pending={pending}
        errorMessage={errorMessage}
        onAccept={handleAccept}
        onReject={handleReject}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: space.md,
    right: space.md,
  },
});
