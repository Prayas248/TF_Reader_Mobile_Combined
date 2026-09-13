// src/components/SectionHeader/SectionHeader.tsx
// The heading that opens a section: "Featured", "Browse by Subject" and
// "Recently Published" on screen 01, "Recently used" / "All Institutions" on
// 06, and the result groups on 09.
//
// THE TITLE WRAPS, THE ACTION STAYS PUT. The Foundation Spec's done-when clause
// for this component is "a long title wraps rather than pushing the action
// off-screen", so that is the one behaviour the layout exists to guarantee: the
// title takes the row's spare width and wraps inside it, while the action holds
// its intrinsic width against the right edge.
//
// THE ACTION NEEDS BOTH PROPS, NOT JUST A LABEL. An `actionLabel` with no
// `onAction` would render teal text that looks tappable and does nothing —
// the same dishonesty CategoryCard avoids by withholding its chevron when it
// has no `onPress`. Either both arrive, or no action is drawn.
//
// It sets no outer margin or padding: the parent owns where the header sits,
// the same rule that keeps CategoryCard from setting its own width.
//
// `emphasis="editorial"` swaps the title to Aleo (serif, via `cardTitle` —
// see that style's own comment for why not `editorialTitle`) for a screen
// that wants its section headings to read as editorial content rather than
// UI chrome — CatalogueScreen's shelves are the first caller. Defaults to
// the existing Open Sans treatment, so every other screen is unaffected.
//
// `icon` IS OPTIONAL AND UNDRAWN BY DEFAULT, on the same reasoning as
// `actionLabel`/`onAction`: every existing caller (Catalogue's shelves,
// Search's own sections, screen 06) omits it and renders exactly as before.
// The light rounded-square container is the same `rowIcon()` language
// ProfileScreen's own redesign established, promoted here once a THIRD
// caller (Accessibility/Reading Preferences' section family, several
// headings each) needed the identical treatment — CONVENTIONS §10's own
// threshold for a shared, not screen-local, home.
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { color, radius, space, type } from '@theme/tokens';

export type SectionHeaderEmphasis = 'default' | 'editorial';

export interface SectionHeaderProps {
  // The section's own label, rendered verbatim — a shelf title off the feed
  // ("New this term") or a screen's fixed heading ("Browse by Subject").
  // Never mapped through a lookup keyed by section.
  title: string;
  // Trailing action, "See all" in the design package. Absent on every section
  // of screen 01; the with_action variant belongs to screens 06 and 09.
  actionLabel?: string;
  onAction?: () => void;
  // A ready-made trailing element (e.g. FilterSortButton) for callers whose
  // action isn't a plain text link. Takes the same trailing slot as
  // actionLabel/onAction and wins if both are supplied — the two are not
  // meant to be combined on one header.
  action?: ReactNode;
  emphasis?: SectionHeaderEmphasis;
  /** A small glyph or short text (e.g. "Aa") in a light rounded-square box, leading the title. */
  icon?: ReactNode;
}

export default function SectionHeader({
  title,
  actionLabel,
  onAction,
  action,
  emphasis = 'default',
  icon,
}: SectionHeaderProps) {
  // Both, or neither — see the header.
  const showTextAction = actionLabel !== undefined && onAction !== undefined;

  return (
    <View testID="section-header" style={styles.header}>
      {icon !== undefined && <View style={styles.iconBox}>{icon}</View>}
      <Text
        testID="section-header-title"
        style={[styles.title, emphasis === 'editorial' && styles.titleEditorial]}
        // Announced as a heading so a screen reader can jump section to section
        // instead of reading the whole feed linearly.
        accessibilityRole="header"
      >
        {title}
      </Text>

      {action !== undefined ? (
        <View style={styles.actionSlot}>{action}</View>
      ) : (
        showTextAction && (
          <Pressable
            testID="section-header-action"
            style={styles.actionSlot}
            onPress={onAction}
            accessibilityRole="button"
            // Carries the section name: "See all" on its own tells a screen-reader
            // user which words are on screen but not which shelf they open.
            accessibilityLabel={`${actionLabel} ${title}`}
            // Grows the touch target without padding the text, which would pull
            // the label in from the row's right edge.
            hitSlop={space.sm}
          >
            <Text style={styles.action}>{actionLabel}</Text>
          </Pressable>
        )
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    // The two type styles have different line heights, so align on the box
    // rather than the baseline: the action centres against the title block.
    alignItems: 'center',
    gap: space.md,
  },
  // Same size/radius/tint as ProfileScreen's own `rowIconContainer` — one
  // "icon in a light box" language across the app rather than a second one
  // invented here.
  iconBox: {
    width: space.xl,
    height: space.xl,
    borderRadius: radius.tile,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    // Takes the spare width, which both pushes the action to the far edge and
    // makes a long title wrap inside the row instead of overflowing it.
    flex: 1,
    fontFamily: type.sectionHeader.fontFamily,
    fontSize: type.sectionHeader.size,
    lineHeight: type.sectionHeader.lineHeight,
    color: color.textPrimary,
  },
  // Overrides the family and tracking only — size, line height, colour and
  // everything else about the row stay identical to `default`. `cardTitle`,
  // not `editorialTitle`: the hero's own headline is this screen's primary
  // title and correctly stays Open Sans now (the brand guide's "Regular for
  // titles"), so borrowing its family here would make this a no-op — a
  // shelf heading is closer to the guide's "smaller/secondary titles or
  // headings", the same case `cardTitle`'s own note in tokens.ts already
  // makes for a book title, so this reaches for that token instead.
  // `letterSpacing` is the same negative tightening `cardTitle`'s own title
  // style takes, slightly less aggressive: a heading is a short label, not a
  // wrapped block of prose, so it can afford to sit closer to Aleo's own
  // (loose-reading) default tracking than a book title does.
  titleEditorial: {
    fontFamily: type.cardTitle.fontFamily,
    fontSize: type.sectionHeader.size,
    lineHeight: type.sectionHeader.lineHeight,
    letterSpacing: -0.2,
  },
  // Explicitly refuses to shrink, so the action keeps its full label however
  // long the title runs. This is the done-when clause, stated in one property.
  actionSlot: {
    flexShrink: 0,
  },
  action: {
    // The token meant for tappable text; the spec fixes the colour here and
    // leaves the size unstated.
    fontFamily: type.button.fontFamily,
    fontSize: type.button.size,
    lineHeight: type.button.lineHeight,
    color: color.primary,
  },
});
