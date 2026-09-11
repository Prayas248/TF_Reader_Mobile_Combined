// src/screens/ReaderPreferencesScreen.ZoomSection.tsx
// The Zoom section of the reader preferences screen — PDF only.
//
// A PART, NOT A SHARED COMPONENT (CONVENTIONS §1). Same shape as its four
// siblings: one consumer, one file, props in and callbacks out (§3). No store,
// no hook — the screen owns `useReaderPrefs` and hands down `prefs.zoom.level`
// and `onChangeZoom`.
//
// ALWAYS RENDERED, LABELLED "PDF only" — THE SAME PATTERN AS FONT AND
// TYPOGRAPHY'S "EPUB only" HINTS, NOT A DIFFERENT ONE. This screen is a global,
// per-user singleton settings surface (pushed from Profile — see
// RootNavigator.tsx), not opened from within an open book, so it has no
// "current reader mode" to condition visibility on the way the Personalization
// Settings UI requirements literally describe ("only show Zoom when reader is
// in PDF mode"). Hiding/showing this section would need the currently-open
// book's format threaded into a screen that today never receives one — a
// navigation change reaching into Reader's screens, not a Personalization-only
// edit. Until that plumbing exists (flag Ahana/Reader before adding it), this
// mirrors how every other format-scoped control on this screen already copes
// with the same gap: always visible, its applicability stated in text.
//
// SAVES ON RELEASE ONLY, same as Typography's sliders — `Slider` exposes only
// `onSlidingComplete`.
import { StyleSheet, Text, View } from 'react-native';

import { SectionHeader } from '@components/SectionHeader';
import { Slider } from '@components/Slider';
import { color, space, type as typeScale } from '@theme/tokens';

import { ZOOM_LEVEL } from '@/features/personalization/prefsOptions';

export interface ZoomSectionProps {
  level: number;
  onChangeZoom: (level: number) => void;
}

export default function ZoomSection({ level, onChangeZoom }: ZoomSectionProps) {
  return (
    <View style={styles.section} testID="zoom-section">
      <SectionHeader title="Zoom" />
      <Text style={styles.hint}>PDF only. EPUBs resize through font size instead.</Text>

      <Slider
        testID="zoom-level-slider"
        value={level}
        minimumValue={ZOOM_LEVEL.min}
        maximumValue={ZOOM_LEVEL.max}
        step={ZOOM_LEVEL.step}
        onSlidingComplete={onChangeZoom}
      />
      <Text style={styles.readout}>{Math.round(level * 100)}%</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // No outer margin — the screen owns where the section sits (§8).
  section: {
    gap: space.sm,
  },
  hint: {
    fontWeight: typeScale.smallLabel.weight,
    fontSize: typeScale.smallLabel.size,
    lineHeight: typeScale.smallLabel.lineHeight,
    color: color.textSecondary,
  },
  readout: {
    fontWeight: typeScale.meta.weight,
    fontSize: typeScale.meta.size,
    lineHeight: typeScale.meta.lineHeight,
    color: color.textSecondary,
  },
});
