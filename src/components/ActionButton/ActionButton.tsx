// src/components/ActionButton/ActionButton.tsx
// One access action as one button: a label, an icon, and a callback.
//
// IT DOES NOT KNOW WHY IT EXISTS. It is handed an `action` and renders it. It
// never reads a tier, a session, a licence or an entitlement to decide its own
// label, its own weight, or whether it should be on screen at all — that is
// `src/access/resolveAccess` (CONVENTIONS §3, Design Spec §5.1 "the UI must
// never calculate access rights").
//
// This is what let the 12 August flow change and the 13 August Elite decisions
// land without touching this file: `borrow` stopped being a button, Elite lost
// its Download and started always queueing, and none of it is expressible here.
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Skeleton } from '@components/Skeleton';
import Spinner from '@components/Spinner';
import type { ActionId } from '@model/types';
import { color, radius, space, type } from '@theme/tokens';

// How much visual weight an action carries. `quiet` exists for exactly one
// action — see the ACTIONS table.
export type ActionEmphasis = 'filled' | 'outlined' | 'quiet';

// The lifecycle axis, kept separate from `action` so there is no
// `action="read-loading"` (CONVENTIONS §4).
//
// `done` is a spent action: tapped, accepted, and not to be tapped again.
//
// NOTHING DEFINES A `doneLabel` AS OF 16 AUG, and that is a consequence of the
// Elite flow change rather than an oversight. `addToQueue` was the only action
// that ever had one — it flipped to "Added to queue" in place, because the button
// had to stand in for its own aftermath. `grantAccess` does not: tapping it
// changes the RESOLVE (`requires_grant` becomes `queued` or `offered`), so the
// whole bar redraws and there is no spent button left to relabel.
//
// The mechanism stays because `done` still has a job — it renders a button inert,
// which is what stops a second tap landing on an offer that has already become a
// loan. It simply falls back to the normal label everywhere now, which is exactly
// what `doneLabel` being optional was for.
export type ActionButtonState = 'idle' | 'loading' | 'done' | 'skeleton';

export interface ActionButtonProps {
  /** Imported from the contract, never retyped as literals (CONVENTIONS §2). */
  action: ActionId;
  state?: ActionButtonState;
  /** Separate from `state`: an action can be disabled in any of them. */
  disabled?: boolean;
  onPress?: () => void;
}

// ONE TABLE, so a ninth action is a single compile error rather than four gaps.
// Same shape as `TIERS` in AccessTierBadge.
//
// Emphasis and icons are Akriti's call, 13 Aug — the eighteen design screens are
// reference only and they disagree with each other (screen 05 gives Read a book
// icon, screen 18 gives it none). `revokeLicence` is `quiet` because it is the
// only action that takes something away from the reader: it should be findable
// without competing with the button they came to press.
//
// WHY `rejectOffer` IS `outlined` AND NOT `quiet` — 16 Aug, and it is the one
// judgement call in this table worth arguing with. Reject also takes something
// away, so `quiet` looks right by analogy with `revokeLicence`. But `quiet` sends
// it to its own line beneath the row (see ActionBar), and Accept / Reject are two
// answers to one question: a reader offered a copy expects both choices at equal
// standing, side by side. Revoke is a rare action you should not hit by accident;
// Reject is one of exactly two expected replies. Different jobs, different weight.
// Flipping it back is one word here and nothing else.
const ACTIONS: Record<
  ActionId,
  {
    label: string;
    // Rendered instead of `label` at state 'done'. Optional on purpose: most
    // actions have no spent form.
    doneLabel?: string;
    icon: ComponentProps<typeof MaterialCommunityIcons>['name'];
    emphasis: ActionEmphasis;
  }
> = {
  read: { label: 'Read', icon: 'book-open-variant', emphasis: 'filled' },
  // Same emphasis and the same licence call as `read` (ItemDetailScreen
  // treats the two identically) — only the label and icon differ, because an
  // audiobook is pressed, not opened to a page. See `ACTION_IDS`'s own note
  // on why this is a wording choice and not a second access decision.
  play: { label: 'Play', icon: 'play-circle-outline', emphasis: 'filled' },
  download: { label: 'Download', icon: 'download', emphasis: 'outlined' },
  // The Elite entry point, and the only button a reader holding nothing sees. It
  // says nothing about the queue — see index.html §Access for why a queue length
  // shown before the reader has asked for anything is only a reason not to tap.
  grantAccess: { label: 'Request access', icon: 'key-outline', emphasis: 'filled' },
  // The two answers to an offer. Reached either straight from the Request access
  // tap, when nobody was ahead, or later from a notification — identical both
  // ways, which is the whole point of resolving them to one pair.
  acceptOffer: { label: 'Accept', icon: 'check', emphasis: 'filled' },
  rejectOffer: { label: 'Reject', icon: 'close', emphasis: 'outlined' },
  revokeLicence: { label: 'Revoke licence', icon: 'arrow-u-left-top', emphasis: 'quiet' },
  subscribe: { label: 'Subscribe', icon: 'lock-open-outline', emphasis: 'filled' },
  signIn: { label: 'Sign in', icon: 'login', emphasis: 'filled' },
};

/**
 * How heavy an action reads. Exported because ActionBar lays `quiet` actions out
 * on their own line rather than in the row, and the alternative was ActionBar
 * hardcoding `action === 'revokeLicence'` — which would mean two files to edit
 * the next time an action's weight changes.
 */
export function actionEmphasis(action: ActionId): ActionEmphasis {
  return ACTIONS[action].emphasis;
}

// The button's height, and therefore its skeleton's height. 48 is above the 44pt
// minimum touch target, and it is composed from the spacing scale so no bare
// number reaches the stylesheet (CONVENTIONS §5) — the same trick as
// `THUMB = space.xl * 2` in ContentCard.
const HEIGHT = space.xl + space.md;

export default function ActionButton({
  action,
  state = 'idle',
  disabled = false,
  onPress,
}: ActionButtonProps) {
  const { label, doneLabel, icon, emphasis } = ACTIONS[action];

  // A grey block at the real button's exact height, so nothing on the bar shifts
  // when the resolve lands. Reuses Skeleton rather than drawing its own box.
  //
  // No width: the parent slot is a View, whose default `alignItems: 'stretch'`
  // makes both this and the Pressable below fill it identically.
  //
  // Wrapped rather than given a testID directly — SkeletonProps has no testID,
  // and adding one means editing another author's component for our test's
  // convenience (CONVENTIONS §7).
  if (state === 'skeleton') {
    return (
      <View testID="action-button-skeleton">
        <Skeleton variant="block" height={HEIGHT} />
      </View>
    );
  }

  const done = state === 'done';
  const loading = state === 'loading';
  const shown = done ? (doneLabel ?? label) : label;

  // Three reasons not to accept a tap, and they must all disable the Pressable
  // rather than just clear onPress: clearing the handler alone leaves the
  // responder system live, so the button still reacts to touches and a test
  // firing a press still reaches the handler. Same note as ContentCard.
  const inert = disabled || loading || done;

  // A spent action is not a failure, so it greys rather than dims: secondary
  // colour plus a tick, which reads as "this is finished" instead of "this is
  // broken". `disabled` uses opacity, which is a different signal on purpose.
  const tint = done ? color.textSecondary : emphasis === 'filled' ? color.white : color.primary;

  return (
    <Pressable
      testID={`action-button-${action}`}
      onPress={inert ? undefined : onPress}
      disabled={inert}
      accessibilityRole="button"
      accessibilityLabel={shown}
      // `busy` is what a screen reader needs to stop announcing the button as
      // actionable while a licence call is in flight.
      accessibilityState={{ disabled: inert, busy: loading }}
      style={[
        styles.base,
        styles[emphasis],
        done && styles.done,
        disabled && styles.disabled,
      ]}
    >
      <View style={styles.content}>
        <MaterialCommunityIcons
          name={done ? 'check' : icon}
          size={type.button.size}
          color={tint}
        />
        <Text style={[styles.label, { color: tint }]} numberOfLines={1}>
          {shown}
        </Text>
        {/* Keeps the label and adds a spinner beside it — decided 13 Aug. The
            label staying put is the point: a button whose text vanishes changes
            width, and the whole bar jumps. */}
        {loading && <Spinner testID="action-button-spinner" size="small" color={tint} />}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.card,
    // Transparent rather than absent, so the filled and outlined branches below
    // both override a known starting point.
    borderWidth: 1,
    borderColor: 'transparent',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  filled: {
    backgroundColor: color.primary,
    borderColor: color.primary,
  },
  outlined: {
    borderColor: color.primary,
  },
  // No border and no fill: coloured text and an icon. Its own line in the bar.
  quiet: {},
  done: {
    borderColor: color.border,
    backgroundColor: color.white,
  },
  // Permitted by CONVENTIONS §5 as a layout primitive — opacity is the exception
  // to "no bare numbers", which is why disabled needs no new grey token.
  disabled: {
    opacity: 0.4,
  },
  label: {
    fontFamily: type.button.fontFamily,
    fontSize: type.button.size,
    lineHeight: type.button.lineHeight,
    textAlign: 'center',
  },
});
