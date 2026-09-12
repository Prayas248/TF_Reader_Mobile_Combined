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
// FOUR CONTROLS, EPUB ONLY. PDFs are fixed layout, so none of these reach a
// PDF — the hint under the header says so, the same way FontSection's does.
//
// TEXT SIZE IS SIX FIXED PRESETS, NOT A FREE SLIDER — the one point the Week 3
// plan calls out explicitly. It uses `Tabs`, the same segmented control Theme,
// Font and Layout already use, rather than a new one (§10). A stored value
// outside the six presets is handled the same way Theme handles `highContrast`
// and Font handles an unlisted face: nothing highlighted, plus a note saying
// so, rather than a picker that looks broken.
//
// THE OTHER THREE ARE SLIDERS THAT SAVE ON RELEASE ONLY. `Slider` exposes only
// `onSlidingComplete`, so there is no per-tick handler here to wire by mistake.
// Constraining the value — snapping text size to its nearest preset, clamping
// each slider to its range — happens in the hook's callbacks, not here — see
// the note above them in useReaderPrefs.ts — so this file only forwards what
// the control reports.
import { StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { SectionHeader } from '@components/SectionHeader';
import { Slider } from '@components/Slider';
import { Tabs } from '@components/Tabs';
import type { TypographyPrefs } from '@/shared/contracts';
import { color, radius, space, type as typeScale } from '@theme/tokens';

import { TEXT_SIZE_OPTIONS } from '@/features/personalization/prefsOptions';

const SECTION_ICON_SIZE = space.md + space.xs;
// Letterform glyphs, not Ionicons — "Tt" (text size) and "VA" (letter
// spacing, the classic kerning-pair glyph) name the setting more directly
// than a generic type icon would, the same call FontSection's own "Aa" makes.
const TEXT_SIZE_ICON_LABEL = 'Tt';
const LETTER_SPACING_ICON_LABEL = 'VA';

export interface TypographySectionProps {
  typography: TypographyPrefs;
  onSelectTextSize: (size: number) => void;
  onChangeLineHeight: (lineHeight: number) => void;
  onChangeLetterSpacing: (spacing: number) => void;
  onChangeMargins: (margins: number) => void;
}

export default function TypographySection({
  typography,
  onSelectTextSize,
  onChangeLineHeight,
  onChangeLetterSpacing,
  onChangeMargins,
}: TypographySectionProps) {
  // A value from outside the six presets — another device, or a value this
  // picker predates. Same handling as Theme's `highContrast` and Font's
  // unlisted faces: `Tabs` already renders nothing active, which is honest,
  // but a picker with no selection and no explanation reads as broken rather
  // than as "your current size lives somewhere else."
  const unmatchedTextSize = !TEXT_SIZE_OPTIONS.some(
    (option) => option.id === String(typography.size),
  );

  return (
    <View style={styles.section} testID="typography-section">
      {/* Own tight-gap wrapper, not a direct child of `section` — `section`'s
          `lg` gap is sized for the space BETWEEN the four distinct controls
          below, and applying it here too would put as much air under the
          title as between two whole controls. Also gains the icon Theme and
          Font's own top-level headings already carry — this was the one
          heading on the screen without one. */}
      <View style={styles.header}>
        <SectionHeader
          title="Typography"
          icon={<Ionicons name="text-outline" size={SECTION_ICON_SIZE} color={color.primary} />}
        />
        <Text style={styles.hint}>EPUB only. PDFs use a fixed layout and ignore these.</Text>
      </View>

      <View style={styles.group}>
        <SectionHeader
          title="Text size"
          icon={<Text style={styles.iconLabel}>{TEXT_SIZE_ICON_LABEL}</Text>}
        />
        <Tabs
          tabs={[...TEXT_SIZE_OPTIONS]}
          activeId={String(typography.size)}
          variant="segmented"
          onChange={(id) => onSelectTextSize(Number(id))}
        />
        {unmatchedTextSize && (
          <Text style={styles.note}>
            Your current text size was set elsewhere and is not one of these presets.
          </Text>
        )}
      </View>

      <View style={styles.group}>
        <SectionHeader
          title="Line height"
          icon={<Ionicons name="reorder-four-outline" size={SECTION_ICON_SIZE} color={color.primary} />}
        />
        <Slider
          testID="typography-line-height-slider"
          value={typography.lineHeight}
          minimumValue={1.0}
          maximumValue={2.0}
          step={0.1}
          onSlidingComplete={onChangeLineHeight}
        />
        <Text style={styles.readout}>{typography.lineHeight.toFixed(1)}×</Text>
      </View>

      <View style={styles.group}>
        <SectionHeader
          title="Letter spacing"
          icon={<Text style={styles.iconLabel}>{LETTER_SPACING_ICON_LABEL}</Text>}
        />
        <Slider
          testID="typography-letter-spacing-slider"
          value={typography.spacing}
          minimumValue={0}
          maximumValue={4}
          step={0.5}
          onSlidingComplete={onChangeLetterSpacing}
        />
        <Text style={styles.readout}>{typography.spacing}px</Text>
      </View>

      <View style={styles.group}>
        <SectionHeader
          title="Page margins"
          icon={<Ionicons name="square-outline" size={SECTION_ICON_SIZE} color={color.primary} />}
        />
        <Slider
          testID="typography-margins-slider"
          value={typography.margins}
          minimumValue={0}
          maximumValue={48}
          step={4}
          onSlidingComplete={onChangeMargins}
        />
        <Text style={styles.readout}>{typography.margins}px</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // No outer margin — the screen owns where the section sits (§8). Bordered,
  // rounded card — see ThemeSection's own note. `lg`, matching the gap
  // `content` puts between this whole card and the next one: text size,
  // line height, letter spacing and page margins are four distinct
  // controls, not one control split in four, and a smaller gap here than
  // between cards read as them belonging to each other instead.
  section: {
    gap: space.lg,
    padding: space.md,
    backgroundColor: color.white,
    borderRadius: radius.sheet,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  // `sm`, the same title-to-hint gap FontSection's own header uses — see the
  // note beside this element's own JSX for why it needs a gap distinct from
  // `section`'s.
  header: {
    gap: space.sm,
  },
  iconLabel: {
    fontFamily: typeScale.button.fontFamily,
    fontSize: typeScale.button.size,
    lineHeight: typeScale.button.lineHeight,
    color: color.primary,
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
