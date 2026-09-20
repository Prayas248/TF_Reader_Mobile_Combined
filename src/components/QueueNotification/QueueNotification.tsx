// QueueNotification — the in-app banner that offers a reader an Elite copy.
//
// A reader on the title's own detail screen already sees Accept and Reject:
// resolveAccess returns the `offered` state with `['acceptOffer', 'rejectOffer']`
// and ActionBar draws them. This banner is the same two actions for a reader who
// is somewhere else in the app, because an offer expires and cannot wait for them
// to navigate back.
//
// It knows nothing about licences, holds, stores or flambeau. It is told a title
// and how long is left, and it reports which button was pressed.
//
// IT USES ActionButton RATHER THAN DRAWING ITS OWN BUTTONS. `acceptOffer` and
// `rejectOffer` are two of the eight actions in the contract, and ActionButton
// already owns their labels, icons and emphasis. Drawing them again here would be
// a second implementation of the same two buttons (CONVENTIONS §7) and the two
// would drift the first time a label changed.
//
// UNLIKE OfflineBanner, THIS SETS NO POSITION OF ITS OWN. OfflineBanner overlays
// content and lets touches pass through it, so owning its own absolute position
// is what makes that guarantee enforceable. This banner has to be tapped, and
// design have not decided whether it sits at the top or rises from the bottom, so
// placement stays the caller's (CONVENTIONS §8).
import { StyleSheet, Text, View } from 'react-native';

import { ActionButton } from '@components/ActionButton';
import { color, radius, space, type } from '@theme/tokens';

/** Which of the two buttons is currently waiting on flambeau. */
export type QueueNotificationPending = 'accept' | 'reject';

export interface QueueNotificationProps {
  /** The title being offered, so the reader knows what they are accepting. */
  title: string;
  /**
   * Minutes left to answer, worked out by the caller from flambeau's
   * `offerExpiresAt` and their `serverTime`. Absent when no expiry was sent.
   *
   * A plain number rather than the two timestamps, so this component never reads
   * a clock: a device clock that is wrong would show a live offer as expired.
   */
  expiresInMinutes?: number;
  /** Omitted when nothing is in flight, which is the normal case. */
  pending?: QueueNotificationPending;
  /**
   * Set by the caller after a failed accept/reject, cleared on the next attempt. Previously
   * there was no such prop at all — a failure was `console.log`-only, so the banner just went
   * back to idle with nothing telling the reader anything went wrong.
   */
  errorMessage?: string;
  onAccept: () => void;
  onReject: () => void;
}

// Provisional copy. No mockup exists for this component and no wording has been
// agreed for the message — design see the built version this week, and their
// answer changes this one line.
const MESSAGE = 'A copy is ready for you';

function expiryLabel(minutes: number): string {
  if (minutes <= 0) return 'Expiring now';
  if (minutes === 1) return 'Expires in 1 minute';
  return `Expires in ${minutes} minutes`;
}

export default function QueueNotification({
  title,
  expiresInMinutes,
  pending,
  errorMessage,
  onAccept,
  onReject,
}: QueueNotificationProps) {
  const acceptIsPending = pending === 'accept';
  const rejectIsPending = pending === 'reject';

  return (
    <View style={styles.banner} testID="queue-notification">
      <Text style={styles.message}>{MESSAGE}</Text>

      {/* Two lines at most: this is a banner over other content, and a long
          title must not push the buttons off the bottom of it. */}
      <Text style={styles.title} numberOfLines={2}>
        {title}
      </Text>

      {expiresInMinutes !== undefined && (
        <Text style={styles.expiry}>{expiryLabel(expiresInMinutes)}</Text>
      )}

      {errorMessage !== undefined && (
        <Text style={styles.error} accessibilityRole="alert" testID="queue-notification-error">
          {errorMessage}
        </Text>
      )}

      {/* Each button is disabled while the OTHER one is in flight, so one offer
          cannot be answered twice. ActionButton makes the pending one inert by
          itself and shows the spinner. */}
      <View style={styles.row}>
        <View style={styles.slot}>
          <ActionButton
            action="acceptOffer"
            state={acceptIsPending ? 'loading' : 'idle'}
            disabled={rejectIsPending}
            onPress={onAccept}
          />
        </View>
        <View style={styles.slot}>
          <ActionButton
            action="rejectOffer"
            state={rejectIsPending ? 'loading' : 'idle'}
            disabled={acceptIsPending}
            onPress={onReject}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Amber marks the queue everywhere else in the app — tokens.ts lists `wait` as
  // "no licences free, queue position, the queue offer". It is a border here
  // rather than a fill so ActionButton's teal keeps the contrast it was designed
  // against.
  banner: {
    gap: space.sm,
    padding: space.md,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.wait,
    borderRadius: radius.card,
  },
  message: {
    fontWeight: type.sectionHeader.weight,
    fontFamily: type.sectionHeader.fontFamily,
    fontSize: type.sectionHeader.size,
    lineHeight: type.sectionHeader.lineHeight,
    color: color.textPrimary,
  },
  title: {
    fontWeight: type.body.weight,
    fontFamily: type.body.fontFamily,
    fontSize: type.body.size,
    lineHeight: type.body.lineHeight,
    color: color.textPrimary,
  },
  expiry: {
    fontWeight: type.meta.weight,
    fontFamily: type.meta.fontFamily,
    fontSize: type.meta.size,
    lineHeight: type.meta.lineHeight,
    color: color.wait,
  },
  error: {
    fontWeight: type.meta.weight,
    fontFamily: type.meta.fontFamily,
    fontSize: type.meta.size,
    lineHeight: type.meta.lineHeight,
    color: color.error,
  },
  row: {
    flexDirection: 'row',
    gap: space.sm,
  },
  // Both buttons share the width evenly — Accept and Reject are two answers to
  // one question and neither is the smaller choice.
  slot: {
    flex: 1,
  },
});
