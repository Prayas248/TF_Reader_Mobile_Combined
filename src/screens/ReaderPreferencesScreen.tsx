// src/screens/ReaderPreferencesScreen.tsx
// Reader preferences — how books look when they are read. Persistent, per user,
// applied to every book rather than scoped to one.
//
// WE WRITE, THE READER READS. This screen's only job is to put values into
// `prefsStore`. t4targaryen's reader subscribes to the same store and applies
// them to the epub.js rendition; nothing here calls the reader, and nothing here
// renders a live preview of the result. That boundary is why the Font section can
// offer faces this app has never loaded.
//
// ─── FOUR SECTIONS, FOUR OWNERS, FOUR FILES ──────────────────────────────────
//
// Theme and Font are mine and land with this file. Layout is Keshav's and
// Typography is Prayas's, and each is a SEPARATE FILE beside this one, imported
// and dropped into the numbered slot below.
//
// That is the whole point of the split. Three people editing one function body
// is the merge conflict the Week 3 plan sequences commits to avoid; three people
// each adding one import and one line is not. So:
//
//   Keshav  → ReaderPreferencesScreen.LayoutSection.tsx
//   Prayas  → ReaderPreferencesScreen.TypographySection.tsx
//
// Take `prefs` and the matching `on<Event>` from the hook, exactly as the two
// sections below do. Do not call `useReaderPrefs` inside a section — one hook
// instance per screen, or two sections will hold two copies of the same state.
// If your section needs a callback the hook does not expose, add it there rather
// than reaching for the store directly; the write rules live in that file.
//
// ─── STATES ──────────────────────────────────────────────────────────────────
//
// All four decided up front (CONVENTIONS §6, and the Week 3 definition of done),
// two of them real and two of them reasoned away:
//
//   loading  Skeletons at the sections' own heights, so nothing jumps.
//   error    The first read failed. ErrorState with a retry, nothing else.
//   empty    IMPOSSIBLE, not missing. Prefs are a per-user singleton with
//            DEFAULT_PREFS as a floor, so there is no "none yet" to render.
//   offline  NOT A BLOCKING STATE. Prefs are local-first: the client stamps
//            `updatedAt` at edit time, offline, before any sync, and LWW settles
//            it later. So the banner is informational and every control stays
//            live behind it. Disabling them would contradict the contract.
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { ErrorState } from '@components/ErrorState';
import { OfflineBanner } from '@components/OfflineBanner';
import { Skeleton } from '@components/Skeleton';
import { useNetworkStatus } from '@hooks/useNetworkStatus';
import { color, radius, space, type as typeScale } from '@theme/tokens';

import { useReaderPrefs, type PrefsSource } from '@/features/personalization/useReaderPrefs';

import FontSection from './ReaderPreferencesScreen.FontSection';
import LayoutSection from './ReaderPreferencesScreen.LayoutSection';
import ThemeSection from './ReaderPreferencesScreen.ThemeSection';
import TypographySection from './ReaderPreferencesScreen.TypographySection';

// Composed from the spacing scale (CONVENTIONS §5) — the Restore-defaults
// row's own leading icon.
const RESTORE_ICON_SIZE = space.md + space.xs;

const READ_FAILED_MESSAGE = "We couldn't load your reading preferences.";
const SAVE_FAILED_MESSAGE = "That change didn't save. Try again.";

// Four bars standing in for a header and its control, at roughly the height one
// section occupies, repeated per section so the page does not shorten when the
// values land.
const SKELETON_SECTIONS = ['theme', 'font', 'layout', 'typography'] as const;

export interface ReaderPreferencesScreenProps {
  /**
   * TEST SEAM, and the only reason this screen takes a prop at all.
   *
   * `useReaderPrefs` defaults to the real `prefsStore` when this is absent, so
   * every real navigation into this screen is propless. It is here so a test
   * can inject a fake source instead of touching AsyncStorage.
   */
  prefsSource?: PrefsSource;
}

export default function ReaderPreferencesScreen({
  prefsSource,
}: ReaderPreferencesScreenProps = {}) {
  const {
    state,
    prefs,
    saveFailed,
    onSelectTheme,
    onSelectFontFamily,
    onSelectFlow,
    onSelectSpread,
    onSelectTextSize,
    onChangeLineHeight,
    onChangeLetterSpacing,
    onChangeMargins,
    onRestoreDefaults,
    onRetry,
  } = useReaderPrefs({ source: prefsSource });

  const isOnline = useNetworkStatus();

  // Shown in every state — same reasoning as ProfileScreen's own
  // `pageTitle`/`pageSubtitle`. The subtitle is accurate for every control
  // on this screen (unlike a blanket claim would be on Accessibility, whose
  // controls are a mix of EPUB-only and app-wide ones): Theme, Font, Layout
  // and Typography are all confirmed EPUB-only in each section's own header
  // comment, so this is the one screen where the mockup's exact line holds.
  const pageHeader = (
    <View style={styles.pageHeader}>
      <Text style={styles.pageTitle}>Reading Preferences</Text>
      <Text style={styles.pageSubtitle}>
        Customise your reading experience. These settings apply to EPUB content only. PDFs use
        their own embedded settings.
      </Text>
    </View>
  );

  let body;

  if (state === 'loading') {
    body = (
      <>
        <View style={styles.pageHeaderStandalone}>{pageHeader}</View>
        <View style={styles.content} testID="reader-prefs-skeleton">
          {SKELETON_SECTIONS.map((section) => (
            <View key={section} style={styles.skeletonSection}>
              <Skeleton variant="text" width="40%" height={typeScale.sectionHeader.lineHeight} />
              <Skeleton variant="block" height={space.xl + space.sm} />
            </View>
          ))}
        </View>
      </>
    );
  } else if (state === 'error' || prefs === null) {
    // `prefs === null` is unreachable at `state: 'ready'` — the hook sets them
    // together. Kept so the compiler can narrow below, and so a future change
    // that breaks that pairing shows a retry rather than a blank screen.
    body = (
      <>
        <View style={styles.pageHeaderStandalone}>{pageHeader}</View>
        <View style={styles.centre}>
          <ErrorState variant="not_ready" message={READ_FAILED_MESSAGE} onRetry={onRetry} />
        </View>
      </>
    );
  } else {
    body = (
      <ScrollView contentContainerStyle={styles.content}>
        {pageHeader}

        {/* Reported inline rather than as a full-screen error: the values on
            screen are still correct — the hook rolled the failed one back — so
            replacing the whole page would throw away a working surface over one
            rejected write. */}
        {saveFailed && (
          <Text style={styles.saveFailed} accessibilityRole="alert">
            {SAVE_FAILED_MESSAGE}
          </Text>
        )}

        {/* ── 1 · Theme — Khushi ────────────────────────────────────────── */}
        <ThemeSection theme={prefs.theme} onSelectTheme={onSelectTheme} />

        {/* ── 2 · Font — Khushi ─────────────────────────────────────────── */}
        <FontSection family={prefs.font.family} onSelectFontFamily={onSelectFontFamily} />

        {/* ── 3 · Layout — Keshav ────────────────────────────────────────── */}
        <LayoutSection
          layout={prefs.layout}
          onSelectFlow={onSelectFlow}
          onSelectSpread={onSelectSpread}
        />

        {/* ── 4 · Typography — Prayas ────────────────────────────────────── */}
        <TypographySection
          typography={prefs.typography}
          onSelectTextSize={onSelectTextSize}
          onChangeLineHeight={onChangeLineHeight}
          onChangeLetterSpacing={onChangeLetterSpacing}
          onChangeMargins={onChangeMargins}
        />

        {/* ── Restore defaults ──────────────────────────────────────────────
            LAST, AND DELIBERATELY BELOW EVERY SECTION. It resets all eight
            controls, so it belongs after the things it resets rather than at the
            top where it can be hit while reaching for Theme.

            A light-red CARD, not `ListRow` — same reasoning and same
            `errorTint`/`error` pairing as ProfileScreen's own Sign-out
            treatment: this is a destructive action, so it reads as its own
            distinct block rather than a sixth control. Left-aligned (icon,
            then title+subtitle stacked), not centred like Profile's — a
            reset with a real consequence line beneath it needs the same
            reading order as any other settings row, not a single-line button.

            NO CONFIRMATION SHEET. Not an oversight: the reset is one write that
            the reader can immediately undo by re-picking. `BottomSheet`
            would put a modal in front of a reversible action. If the team wants
            one, it is a sheet around this callback and nothing else changes. */}
        <Pressable
          style={styles.restore}
          onPress={onRestoreDefaults}
          accessibilityRole="button"
          accessibilityLabel="Restore defaults"
        >
          <Ionicons name="refresh-outline" size={RESTORE_ICON_SIZE} color={color.error} />
          <View style={styles.restoreText}>
            <Text style={styles.restoreTitle}>Restore defaults</Text>
            <Text style={styles.restoreSubtitle}>
              Resets theme, font, layout, typography and accessibility
            </Text>
          </View>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <View style={styles.screen}>
      {/* Overlays whatever is above it, in every state, and disables nothing —
          see the states note in the header. */}
      <OfflineBanner visible={!isOnline} />
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: color.white,
  },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // `lg` between sections — each is its own distinct control (Theme, Font,
  // Layout, Typography, Restore), and a gap this size is what keeps them
  // reading as separate items rather than one continuous list.
  content: {
    padding: space.md,
    paddingBottom: space.xl,
    gap: space.lg,
  },
  skeletonSection: {
    gap: space.sm,
  },
  saveFailed: {
    fontWeight: typeScale.smallLabel.weight,
    fontSize: typeScale.smallLabel.size,
    lineHeight: typeScale.smallLabel.lineHeight,
    color: color.error,
  },
  // Cancels the content padding so the row runs edge to edge like every other
  // `ListRow` in the app — the row draws its own horizontal padding and its own
  // divider, both of which stop looking right when inset.
  // No longer cancels the content padding — this is now its own card, not an
  // edge-to-edge `ListRow`, so it keeps the same horizontal inset every
  // other section on this screen has.
  restore: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    padding: space.md,
    backgroundColor: color.errorTint,
    borderRadius: radius.sheet,
  },
  restoreText: {
    flex: 1,
    gap: space.xs / 2,
  },
  restoreTitle: {
    fontFamily: typeScale.body.fontFamily,
    fontSize: typeScale.body.size,
    lineHeight: typeScale.body.lineHeight,
    color: color.error,
  },
  restoreSubtitle: {
    fontFamily: typeScale.smallLabel.fontFamily,
    fontSize: typeScale.smallLabel.size,
    lineHeight: typeScale.smallLabel.lineHeight,
    color: color.textSecondary,
  },
  pageHeader: {
    gap: space.xs,
    // Matches ProfileScreen's own `pageHeader` — without this, the gap under
    // the title (just the `content` gap, 24) read as tighter than Profile's
    // header-to-first-section gap (32, from this padding stacking with the
    // section below it), even though both screens use the same `lg` gap
    // between their own sections.
    paddingBottom: space.sm,
  },
  pageHeaderStandalone: {
    paddingHorizontal: space.md,
    paddingTop: space.md,
  },
  pageTitle: {
    fontFamily: typeScale.editorialTitle.fontFamily,
    fontSize: typeScale.editorialTitle.size,
    lineHeight: typeScale.editorialTitle.lineHeight,
    color: color.textPrimary,
  },
  pageSubtitle: {
    fontFamily: typeScale.editorialMeta.fontFamily,
    fontSize: typeScale.body.size,
    lineHeight: typeScale.body.lineHeight,
    color: color.textSecondary,
  },
});
