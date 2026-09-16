// Owner: Accessibility (Hruthik).
//
// The entry point into AccessibilityInfoScreen. Navigation-agnostic on purpose — `onPress` is the
// only prop, so this file has no idea a route named "BookInfo" exists. Formerly its own toolbar
// icon (wired through `ReaderRouteScreen.tsx`'s `toolbarExtra`, the same seam `DevPreferencesMenu`
// goes through); now mounted directly by `ReaderScreen.tsx` as a row inside the merged
// Accessibility dropdown, alongside `AccessibilitySettingsPanel`'s toggles, so there is one ♿ entry
// point instead of two. Rendered as a full-width row rather than an icon-only square for that
// reason — it now reads as one option among several in a menu, not a standalone toolbar button.
//
// Height floors at MIN_TOUCH_TARGET rather than ReaderScreen's own hard-coded 44 — see
// a11yConstants.ts's header for why these stay two separate copies.

import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, StyleSheet, Text } from 'react-native';

import { color, space } from '@theme/tokens';

import { MIN_TOUCH_TARGET } from './a11yConstants';

export interface AccessibilityInfoButtonProps {
  onPress: () => void;
}

export function AccessibilityInfoButton({
  onPress,
}: AccessibilityInfoButtonProps): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Accessibility information"
      onPress={onPress}
      style={styles.row}
    >
      <Ionicons name="accessibility-outline" style={styles.icon} />
      <Text style={styles.label}>Accessibility information</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: MIN_TOUCH_TARGET,
    // Matches AccessibilitySettingsPanel's own `paddingHorizontal: 12` container inset, ON TOP OF
    // the dropdown box's own padding — this row is a sibling of that panel, not its child, so
    // without its own copy it would sit flush against the dropdown's edge while the toggles above
    // it stay inset.
    paddingHorizontal: 12,
    // A top hairline, matching the ONE-edge-only convention `ReaderScreen.tsx`'s own panels use
    // (see e.g. `tocList`'s comment): separates this button from the toggle rows above it without
    // adding a second, fighting line at the bottom.
    borderTopWidth: 1,
    borderTopColor: color.border,
    marginTop: 10,
    paddingTop: 10,
  },
  icon: { fontSize: 18 },
  label: { fontSize: 14, fontWeight: '700', color: color.textPrimary },
});
