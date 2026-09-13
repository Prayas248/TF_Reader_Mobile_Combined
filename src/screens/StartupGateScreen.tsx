// Screen 00b — the startup sign-in gate. Raised once, right after splash,
// when RootNavigator finds nobody signed in (see RootNavigator's own
// `useEffect`). transparentModal, not BottomSheet — same z-index reason as
// SignInScreen/AccessGateScreen: nesting a Modal inside transparentModal
// causes z-index issues on Android.
//
// NOT AccessGateScreen. That screen is raised reactively, mid-flow, over a
// specific locked item (it takes itemId/title/authors and remembers a pending
// intent to resume after sign-in). This one has no item behind it — it is a
// one-time startup choice, not an interruption of an in-progress read — so it
// carries no item context and records no pending intent.
//
// No auth here — navigation only. "Sign In" hands off to SignInMethodScreen,
// the same institution-vs-personal chooser AccessGate itself draws from, so a
// reader who taps through does not land on a form the account picker skips
// straight past. "Continue without signing in" just dismisses the sheet back
// onto whatever the splash would have shown anyway.
import { useCallback, useEffect, useState } from 'react';
import { Animated, Dimensions, Pressable, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { PrimaryButton } from '@components/PrimaryButton';
import { color, radius, space, type as typeScale } from '@theme/tokens';
import type { RootStackParamList } from '@navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'StartupGate'>;

const WINDOW_HEIGHT = Dimensions.get('window').height;

export default function StartupGateScreen({ navigation }: Props) {
  const [translateY] = useState(() => new Animated.Value(WINDOW_HEIGHT));
  useEffect(() => {
    Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
  }, [translateY]);

  // `replace`, not `goBack`/`navigate` — this screen is RootNavigator's
  // `initialRouteName` for a signed-out cold start (see RootNavigator.tsx),
  // so there is nothing underneath it to go back to, and `replace` (rather
  // than pushing a second entry with `navigate`) keeps this sheet out of the
  // back-stack afterward either way.
  const handleDismiss = useCallback(() => {
    navigation.replace('Main');
  }, [navigation]);

  const handleSignIn = useCallback(() => {
    // `initial: false` is load-bearing, not decoration. This is the reader's
    // very first visit to the Profile tab (they haven't pressed the tab bar
    // yet), so without it React Navigation initializes ProfileStack's whole
    // history as JUST ['SignInMethod'] — no 'ProfileHome' underneath. That
    // left SignInMethodScreen's own `if (isAuthenticated) navigation.popToTop()`
    // popping to itself (already at index 0) once sign-in succeeded, a no-op,
    // so the Profile tab stayed stuck showing the sign-in chooser forever
    // after. `initial: false` makes ProfileStack push 'SignInMethod' on top
    // of its normal 'ProfileHome' start instead, so that same popToTop()
    // actually lands on Profile's real home screen.
    navigation.replace('Main', {
      screen: 'Profile',
      params: { screen: 'SignInMethod', initial: false },
    });
  }, [navigation]);

  return (
    <View style={styles.overlay}>
      <View style={styles.backdrop} />
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={handleDismiss}
        accessibilityLabel="Dismiss"
      />
      {/* Stop taps on the sheet itself from bubbling up to the dismiss pressable —
          same reason AccessGateScreen's own sheet claims the touch this way. */}
      <Animated.View
        testID="startup-gate-sheet"
        style={[styles.sheet, { transform: [{ translateY }] }]}
        onStartShouldSetResponder={() => true}
      >
        <View style={styles.handleArea}>
          <View style={styles.handle} />
        </View>

        <View style={styles.body}>
          <Text style={styles.heading}>Sign in for the full experience</Text>
          <Text style={styles.subtitle}>
            Sign in with your institution or a personal account to access your library,
            downloads and reading progress.
          </Text>

          <PrimaryButton
            testID="startup-gate-sign-in"
            label="Sign In"
            onPress={handleSignIn}
          />

          <Pressable
            testID="startup-gate-continue"
            style={styles.laterButton}
            onPress={handleDismiss}
            accessibilityRole="button"
          >
            <Text style={styles.laterLabel}>Continue without signing in</Text>
          </Pressable>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: color.navy,
    opacity: 0.5,
  },
  sheet: {
    backgroundColor: color.white,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingBottom: space.xl,
  },
  handleArea: {
    alignItems: 'center',
    paddingVertical: space.sm,
  },
  handle: {
    width: space.xl + space.md,
    height: space.xs,
    borderRadius: radius.pill,
    backgroundColor: color.border,
  },
  body: {
    paddingHorizontal: space.lg,
    gap: space.md,
  },
  heading: {
    fontWeight: typeScale.sectionHeader.weight,
    fontFamily: typeScale.sectionHeader.fontFamily,
    fontSize: typeScale.sectionHeader.size,
    lineHeight: typeScale.sectionHeader.lineHeight,
    color: color.textPrimary,
  },
  subtitle: {
    fontWeight: typeScale.body.weight,
    fontFamily: typeScale.body.fontFamily,
    fontSize: typeScale.body.size,
    lineHeight: typeScale.body.lineHeight,
    color: color.textSecondary,
  },
  laterButton: {
    alignItems: 'center',
    paddingVertical: space.sm,
  },
  laterLabel: {
    fontWeight: typeScale.body.weight,
    fontFamily: typeScale.body.fontFamily,
    fontSize: typeScale.body.size,
    lineHeight: typeScale.body.lineHeight,
    color: color.textSecondary,
  },
});
