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
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { ListRow } from '@components/ListRow';
import { ErrorState } from '@components/ErrorState';
import { OfflineBanner } from '@components/OfflineBanner';
import { Skeleton } from '@components/Skeleton';
import { useNetworkStatus } from '@hooks/useNetworkStatus';
import { color, space, type as typeScale } from '@theme/tokens';

import { useReaderPrefs, type PrefsSource } from '@/features/personalization/useReaderPrefs';

import FontSection from './ReaderPreferencesScreen.FontSection';
import LayoutSection from './ReaderPreferencesScreen.LayoutSection';
import ThemeSection from './ReaderPreferencesScreen.ThemeSection';
import TypographySection from './ReaderPreferencesScreen.TypographySection';
import ZoomSection from './ReaderPreferencesScreen.ZoomSection';

const READ_FAILED_MESSAGE = "We couldn't load your reading preferences.";
const SAVE_FAILED_MESSAGE = "That change didn't save. Try again.";

// Bars standing in for a header and its control, at roughly the height one
// section occupies, repeated per section so the page does not shorten when the
// values land.
const SKELETON_SECTIONS = ['theme', 'font', 'layout', 'typography', 'zoom'] as const;

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
    onChangeFontSize,
    onChangeLetterSpacing,
    onChangeMargins,
    onChangeZoom,
    onRestoreDefaults,
    onRetry,
  } = useReaderPrefs({ source: prefsSource });

  const isOnline = useNetworkStatus();

  let body;

  if (state === 'loading') {
    body = (
      <View style={styles.content} testID="reader-prefs-skeleton">
        {SKELETON_SECTIONS.map((section) => (
          <View key={section} style={styles.skeletonSection}>
            <Skeleton variant="text" width="40%" height={typeScale.sectionHeader.lineHeight} />
            <Skeleton variant="block" height={space.xl + space.sm} />
          </View>
        ))}
      </View>
    );
  } else if (state === 'error' || prefs === null) {
    // `prefs === null` is unreachable at `state: 'ready'` — the hook sets them
    // together. Kept so the compiler can narrow below, and so a future change
    // that breaks that pairing shows a retry rather than a blank screen.
    body = (
      <View style={styles.centre}>
        <ErrorState variant="not_ready" message={READ_FAILED_MESSAGE} onRetry={onRetry} />
      </View>
    );
  } else {
    body = (
      <ScrollView contentContainerStyle={styles.content}>
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
          onChangeFontSize={onChangeFontSize}
          onChangeLetterSpacing={onChangeLetterSpacing}
          onChangeMargins={onChangeMargins}
        />

        {/* ── 5 · Zoom — PDF only, see ZoomSection's header note ──────────── */}
        <ZoomSection level={prefs.zoom.level} onChangeZoom={onChangeZoom} />

        {/* ── Restore defaults ──────────────────────────────────────────────
            LAST, AND DELIBERATELY BELOW EVERY SECTION. It resets all eight
            controls, so it belongs after the things it resets rather than at the
            top where it can be hit while reaching for Theme.

            `destructive`, matching the Sign out row on screen 10 — the same
            "this discards something you chose" weight, drawn the same way, so a
            reader meets one affordance rather than two.

            NO CONFIRMATION SHEET. Not an oversight: the reset is one write that
            the reader can immediately undo by re-picking, and `BottomSheet`
            would put a modal in front of a reversible action. If the team wants
            one, it is a sheet around this callback and nothing else changes. */}
        <View style={styles.restore}>
          <ListRow
            title="Restore defaults"
            subtitle="Resets theme, font, layout, typography, zoom and accessibility"
            variant="destructive"
            onPress={onRestoreDefaults}
          />
        </View>
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
    paddingBottom: space.lg,
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
  restore: {
    marginHorizontal: -space.md,
    marginTop: space.sm,
  },
});
