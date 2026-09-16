import type { ReactNode } from 'react';
import { View, Text, TouchableOpacity, Image, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { color, space, type } from '@theme/tokens';

// Bar height excluding the safe-area inset above it.
const BAR_HEIGHT = 56;

// The Nexus mark — transparent background, square aspect. Rendered alone
// (no wordmark text) on the bar itself.
const BRAND_LOGO = require('../../../assets/nexus-3.png');
// Bumped up from 28 for visibility — still well within BAR_HEIGHT (56) with
// `inner`'s own `alignItems: 'center'` centering it, so neither the bar's
// height nor anything else in it moves.
const BRAND_LOGO_HEIGHT = 36;

// ─── Props ───────────────────────────────────────────────────────────────────

/**
 * Variants are implied by which props are present:
 *  - title only               → `title`
 *  - title + onBack           → `title_with_back`
 *  - title + onSearch         → `title_with_search`
 *  - title + onBack + action  → `title_with_back_and_action`
 */
interface TopAppBarProps {
  /** Screen or brand title, always visible. Truncates to one line. */
  title: string;
  /** Presence renders the back chevron on the left. */
  onBack?: () => void;
  /** Presence renders the search icon on the right. */
  onSearch?: () => void;
  /** Optional trailing node rendered to the right (e.g. share, overflow). */
  action?: ReactNode;
  /**
   * Safe-area top inset in logical pixels.
   * The navigator wrapper reads this from useSafeAreaInsets and passes it in.
   * Gallery entries pass nothing (defaults to 0).
   */
  topInset?: number;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function TopAppBar({
  title,
  onBack,
  onSearch,
  action,
  topInset = 0,
}: TopAppBarProps) {
  return (
    <View style={[styles.bar, { paddingTop: topInset }]}>
      <View style={styles.inner}>
        {/* Left — back chevron + title on pushed screens, the Nexus
            logo lockup on tab roots. */}
        <View style={[styles.leftSlot, !onBack && styles.leftSlotBrand]}>
          {onBack ? (
            <TouchableOpacity
              style={styles.iconBtn}
              onPress={onBack}
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <Ionicons name="chevron-back" size={24} color={color.white} />
            </TouchableOpacity>
          ) : (
            <View accessibilityRole="image" accessibilityLabel="Nexus">
              <Image source={BRAND_LOGO} style={styles.brandLogo} resizeMode="contain" />
            </View>
          )}

          {onBack && (
            <Text style={styles.title} numberOfLines={1} ellipsizeMode="tail">
              {title}
            </Text>
          )}
        </View>

        {/* Right — search icon and/or action node */}
        <View style={styles.rightSlot}>
          {onSearch && (
            <TouchableOpacity
              style={styles.iconBtn}
              onPress={onSearch}
              accessibilityRole="button"
              accessibilityLabel="Open search"
            >
              <Ionicons name="search" size={22} color={color.white} />
            </TouchableOpacity>
          )}
          {action}
        </View>
      </View>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  bar: {
    backgroundColor: color.navy,
  },
  inner: {
    height: BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
  },
  leftSlot: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: space.sm,
  },
  leftSlotBrand: {
    alignSelf: 'center',
  },
  brandLogo: {
    height: BRAND_LOGO_HEIGHT,
    width: BRAND_LOGO_HEIGHT,
  },
  iconBtn: {
    padding: space.xs,
    marginRight: space.xs,
  },
  title: {
    fontFamily: type.sectionHeader.fontFamily,
    fontSize: type.sectionHeader.size,
    lineHeight: type.sectionHeader.lineHeight,
    color: color.white,
    flex: 1,
  },
  rightSlot: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
