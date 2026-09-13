// src/screens/ReaderPreferencesScreen.LayoutSection.tsx
// The Layout section of the reader preferences screen — Keshav.
//
// A PART, NOT A SHARED COMPONENT (CONVENTIONS §1). One consumer, one file beside
// it. The split is what keeps three people from editing one function body on the
// same day: this file adds one import and one line to the screen.
//
// PROPS IN, CALLBACKS OUT (§3). No store, no hook — the screen owns
// `useReaderPrefs` and hands down the values and the `on<Event>` pair.
//
// TWO PICKERS, ONE SECTION. `flow` and `spread` are two fields on the same
// `LayoutPrefs` object, so they live in one section rather than two. The outer
// `View` carries the section `testID`; each picker is its own inner group with
// its own `SectionHeader`.
//
// THE CAST ON onChange IS SAFE. `FLOW_OPTIONS` and `SPREAD_OPTIONS` are typed
// with `satisfies` against the contract union, so the only ids the `Tabs` will
// ever emit are members of that union. The cast turns a `string` back into the
// typed member — the same pattern ThemeSection uses for `Theme`.
//
// "DOUBLE" IS SKIPPED ON A PHONE-SIZED SCREEN, NOT GREYED OUT. epub.js gates
// `rendition.spread('double')` at `minSpreadWidth` 800 (EPUB_SPREAD_MIN_WIDTH),
// so below that it is a silent no-op for EPUB — the Settings UI requirements
// name two acceptable fixes (grey it out with a note, or omit it) and this
// takes the omit path: `Tabs` has no per-item disabled state today, and adding
// one to a shared control used by Theme/Flow/Typography elsewhere is a bigger
// change than this section needs. PDF spread has no such gate and works at any
// width, so a phone reader who only ever opens PDFs cannot pick "Double" from
// here — a real trade-off both named options share, called out rather than
// hidden (see the note this renders).
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { SectionHeader } from '@components/SectionHeader';
import { Tabs } from '@components/Tabs';
import type { LayoutPrefs } from '@/shared/contracts';
import { color, radius, space, type as typeScale } from '@theme/tokens';

import {
  EPUB_SPREAD_MIN_WIDTH,
  FLOW_OPTIONS,
  SPREAD_OPTIONS,
} from '@/features/personalization/prefsOptions';

const SECTION_ICON_SIZE = space.md + space.xs;

export interface LayoutSectionProps {
  layout: LayoutPrefs;
  onSelectFlow: (flow: LayoutPrefs['flow']) => void;
  onSelectSpread: (spread: LayoutPrefs['spread']) => void;
}

export default function LayoutSection({ layout, onSelectFlow, onSelectSpread }: LayoutSectionProps) {
  const { width } = useWindowDimensions();
  const isPhoneWidth = width < EPUB_SPREAD_MIN_WIDTH;

  const spreadOptions = isPhoneWidth
    ? SPREAD_OPTIONS.filter((option) => option.id !== 'double')
    : SPREAD_OPTIONS;

  return (
    <View style={styles.section} testID="layout-section">
      {/* Every other section on this screen (Theme, Font, Typography) opens
          with its own top-level heading, icon included — this card was the
          one missing it, which read as a heading a level smaller than the
          others even though "Reading style"/"Page view" use the identical
          `SectionHeader` size. */}
      <SectionHeader
        title="Layout"
        icon={<Ionicons name="grid-outline" size={SECTION_ICON_SIZE} color={color.primary} />}
      />
      <View style={styles.group}>
        <SectionHeader
          title="Reading style"
          icon={<Ionicons name="book-outline" size={SECTION_ICON_SIZE} color={color.primary} />}
        />
        <Tabs
          tabs={[...FLOW_OPTIONS]}
          activeId={layout.flow}
          variant="segmented"
          onChange={(id) => onSelectFlow(id as LayoutPrefs['flow'])}
        />
      </View>

      <View style={styles.group}>
        <SectionHeader
          title="Page view"
          icon={<Ionicons name="document-outline" size={SECTION_ICON_SIZE} color={color.primary} />}
        />
        <Tabs
          tabs={[...spreadOptions]}
          activeId={layout.spread}
          variant="segmented"
          onChange={(id) => onSelectSpread(id as LayoutPrefs['spread'])}
        />
        {isPhoneWidth && (
          <Text style={styles.note}>
            Double needs an iPad-sized screen for EPUBs, so it&apos;s hidden here. PDFs support
            double at any size.
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // No outer margin — the screen owns where the section sits (§8). Bordered,
  // rounded card — see ThemeSection's own note. `lg`, matching the gap
  // `content` puts between this whole card and the next one: "Reading
  // style" and "Page view" are two distinct controls, not one split in two,
  // and a smaller gap here than between cards read as them belonging to
  // each other instead.
  section: {
    gap: space.lg,
    padding: space.md,
    backgroundColor: color.white,
    borderRadius: radius.sheet,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
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
});
