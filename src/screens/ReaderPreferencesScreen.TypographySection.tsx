// src/screens/ReaderPreferencesScreen.TypographySection.tsx
// The Typography section of the reader preferences screen — Prayas.
//
// A PART, NOT A SHARED COMPONENT (CONVENTIONS §1), same reasoning as Keshav's
// Layout section beside it: one consumer, one file, one import and one line
// added to the screen rather than a shared function body three people edit.
//
// PROPS IN, CALLBACKS OUT (§3). No store, no hook — the screen owns
// `useReaderPrefs` and hands down `prefs.typography` and the four `on<Event>`
// callbacks below.
//
// THREE CONTROLS, EPUB ONLY. PDFs are fixed layout, so none of these reach a
// PDF — the hint under the header says so, the same way FontSection's does.
//
// FONT SIZE IS A SLIDER OVER 10-32PT, NOT PRESETS — per the Personalization
// Settings UI requirements (2026-09-11), which replaced the Week 3 plan's six
// fixed presets with a stepper/slider so the range design intends. Bounds
// come from `FONT_SIZE_PT`, shared with the hook's clamp so the two cannot
// drift apart.
//
// LINE HEIGHT IS NOT SHOWN. `prefs.typography.lineHeight` is explicitly listed
// as NOT WIRED in the reader WebView by the same requirements doc — showing a
// control for a value the reader does not yet apply would let a reader "set"
// something with no visible effect. The field itself, and its write path, are
// untouched in the contract/store; only this section's control is gone.
//
// ALL THREE ARE SLIDERS THAT SAVE ON RELEASE ONLY. `Slider` exposes only
// `onSlidingComplete`, so there is no per-tick handler here to wire by
// mistake. Clamping each value to its range happens in the hook's callbacks,
// not here — see the note above them in useReaderPrefs.ts — so this file only
// forwards what the control reports.
//
// LETTER SPACING READS "None" AT ZERO, NOT "0px" — the requirements are
// explicit that zero must not look like a numeric setting, since the reader
// omits the CSS rule entirely at that value rather than emitting `0px`.
import { StyleSheet, Text, View } from 'react-native';

import { SectionHeader } from '@components/SectionHeader';
import { Slider } from '@components/Slider';
import type { TypographyPrefs } from '@/shared/contracts';
import { color, space, type as typeScale } from '@theme/tokens';

import { FONT_SIZE_PT } from '@/features/personalization/prefsOptions';

export interface TypographySectionProps {
  typography: TypographyPrefs;
  onChangeFontSize: (size: number) => void;
  onChangeLetterSpacing: (spacing: number) => void;
  onChangeMargins: (margins: number) => void;
}

export default function TypographySection({
  typography,
  onChangeFontSize,
  onChangeLetterSpacing,
  onChangeMargins,
}: TypographySectionProps) {
  return (
    <View style={styles.section} testID="typography-section">
      <SectionHeader title="Typography" />
      <Text style={styles.hint}>EPUB only. PDFs use a fixed layout and ignore these.</Text>

      <View style={styles.group}>
        <SectionHeader title="Font size" />
        <Slider
          testID="typography-font-size-slider"
          value={typography.size}
          minimumValue={FONT_SIZE_PT.min}
          maximumValue={FONT_SIZE_PT.max}
          step={FONT_SIZE_PT.step}
          onSlidingComplete={onChangeFontSize}
        />
        <Text style={styles.readout}>{typography.size}pt</Text>
      </View>

      <View style={styles.group}>
        <SectionHeader title="Letter spacing" />
        <Slider
          testID="typography-letter-spacing-slider"
          value={typography.spacing}
          minimumValue={0}
          maximumValue={4}
          step={0.5}
          onSlidingComplete={onChangeLetterSpacing}
        />
        <Text style={styles.readout}>
          {typography.spacing === 0 ? 'None' : `${typography.spacing}px`}
        </Text>
      </View>

      <View style={styles.group}>
        <SectionHeader title="Page margins" />
        <Slider
          testID="typography-margins-slider"
          value={typography.margins}
          minimumValue={0}
          maximumValue={64}
          step={4}
          onSlidingComplete={onChangeMargins}
        />
        <Text style={styles.readout}>{typography.margins}px</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // No outer margin — the screen owns where the section sits (§8). `md`, not
  // `sm`: text size, line height, letter spacing and page margins are four
  // distinct controls, not one control split in four, so they need real
  // separation between them.
  section: {
    gap: space.md,
  },
  hint: {
    fontWeight: typeScale.smallLabel.weight,
    fontSize: typeScale.smallLabel.size,
    lineHeight: typeScale.smallLabel.lineHeight,
    color: color.textSecondary,
  },
  group: {
    gap: space.sm,
  },
  note: {
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
