// src/screens/AccessibilityScreen.tsx
// Accessibility settings — Hruthik's contract (accessibility-frontend-
// integration-contract.md, v1.1), pushed from the "Accessibility" row on
// screen 10, next to (not inside) Reading Preferences.
//
// A SEPARATE SCREEN, NOT A FIFTH ReaderPreferencesScreen SECTION. Both this
// screen and Reading Preferences write through the same `prefsStore`, via the
// same `useReaderPrefs` hook — "same store, same rules, one more group to
// render", per the contract's own framing (§0). They are two screens because
// they are two destinations from Profile, not because the underlying write
// path differs.
//
// WE WRITE, THE READER READS. Same boundary as ReaderPreferencesScreen: this
// screen's only job is to put values into `prefsStore`. Reader (Ahana)
// subscribes to the same store and applies the resolved values live — nothing
// here calls the reader or previews the result.
//
// FOUR GROUPS, TWELVE CONTROLS, AND NO TTS. `accessibility.tts` is declared on
// the contract and is Ahana's, driven from the in-reader `TtsControls` panel
// (contract §0, §2.3, §5). This screen must not render a TTS section or read
// any of its seven fields.
//
// REDUCE MOTION STAYS A STRING ON THIS SURFACE. `activeId` is the raw
// 'system' | 'on' | 'off' and `onChange` hands the same back — see the
// `onSelectReduceMotion` doc on `useReaderPrefs`. Resolving it to an effective
// boolean against live OS state is the reader's job, not this screen's.
//
// STATES — same three as Reading Preferences, and the same reasoning:
//   loading  Skeletons at the groups' own heights, so nothing jumps.
//   error    The first read failed. ErrorState with a retry, nothing else.
//   (no 'empty' or 'offline' — prefs are a per-user singleton with
//   DEFAULT_PREFS as a floor, and writes are local-first; see
//   ReaderPreferencesScreen.tsx's header for the full argument.)
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { ListRow } from '@components/ListRow';
import { ErrorState } from '@components/ErrorState';
import { OfflineBanner } from '@components/OfflineBanner';
import { SectionHeader } from '@components/SectionHeader';
import { Skeleton } from '@components/Skeleton';
import { Slider } from '@components/Slider';
import { Tabs } from '@components/Tabs';
import { useNetworkStatus } from '@hooks/useNetworkStatus';
import type { ReduceMotion } from '@/shared/contracts';
import { color, radius, space, type as typeScale } from '@theme/tokens';

import { useReaderPrefs, type PrefsSource } from '@/features/personalization/useReaderPrefs';
import { FONT_SCALE_MULTIPLIER, REDUCE_MOTION_OPTIONS } from '@/features/personalization/prefsOptions';

// Composed from the spacing scale (CONVENTIONS §5) — every group icon and
// the Restore-defaults row's own icon on this screen.
const SECTION_ICON_SIZE = space.md + space.xs;
// Letterform glyphs, not Ionicons — same call ReaderPreferencesScreen's own
// Font ("Aa") and Typography ("Tt") sections make: these name the setting
// (a text/scale choice) more directly than a generic icon would.
const TEXT_ICON_LABEL = 'Aa';
const TEXT_SCALE_ICON_LABEL = 'Tt';

const READ_FAILED_MESSAGE = "We couldn't load your accessibility settings.";
const SAVE_FAILED_MESSAGE = "That change didn't save. Try again.";

// One bar pair per group, at roughly the height each group occupies, so the
// page does not shorten when the values land.
const SKELETON_GROUPS = ['text', 'display', 'announce', 'hints'] as const;

export interface AccessibilityScreenProps {
  /**
   * TEST SEAM, and the only reason this screen takes a prop at all.
   *
   * `useReaderPrefs` defaults to the real `prefsStore` when this is absent, so
   * every real navigation into this screen is propless. It is here so a test
   * can inject a fake source instead of touching AsyncStorage.
   */
  prefsSource?: PrefsSource;
}

export default function AccessibilityScreen({ prefsSource }: AccessibilityScreenProps = {}) {
  const {
    state,
    prefs,
    saveFailed,
    onToggleDyslexiaFont,
    onToggleRespectOsFontScale,
    onToggleReadableSpacing,
    onChangeFontScaleMultiplier,
    onToggleBoldText,
    onToggleHighContrast,
    onToggleLargeTouchTargets,
    onToggleLargeAudioControls,
    onSelectReduceMotion,
    onToggleAnnouncePageChanges,
    onToggleAnnounceChapterChanges,
    onToggleScreenReaderHints,
    onRestoreAccessibilityDefaults,
    onRetry,
  } = useReaderPrefs({ source: prefsSource });

  const isOnline = useNetworkStatus();

  // Shown in every state — same reasoning as ProfileScreen's own
  // `pageTitle`/`pageSubtitle`. "Make reading comfortable for everyone" is
  // the accurate scope: several controls here (Bold text, High contrast,
  // Large touch/audio controls, Reduce motion) are app-wide, not EPUB-only,
  // so this deliberately drops the mockup's blanket "EPUB only" second
  // sentence — ReaderPreferencesScreen's own subtitle is the one screen
  // where every control really is EPUB-only.
  const pageHeader = (
    <View style={styles.pageHeader}>
      <Text style={styles.pageTitle}>Accessibility</Text>
      <Text style={styles.pageSubtitle}>Make reading comfortable for everyone.</Text>
    </View>
  );

  let body;

  if (state === 'loading') {
    body = (
      <>
        <View style={styles.pageHeaderStandalone}>{pageHeader}</View>
        <View style={styles.content} testID="accessibility-skeleton">
          {SKELETON_GROUPS.map((group) => (
            <View key={group} style={styles.skeletonGroup}>
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
    const { text, display, announce } = prefs.accessibility;

    body = (
      <ScrollView contentContainerStyle={styles.content} testID="accessibility-section">
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

        {/* ── Text ────────────────────────────────────────────────────────── */}
        <View style={styles.group} testID="accessibility-text-group">
          <SectionHeader
            title="Text"
            icon={<Text style={styles.iconLabel}>{TEXT_ICON_LABEL}</Text>}
          />
          <ListRow
            title="Dyslexia-friendly font"
            subtitle="Use OpenDyslexic for title content."
            variant="toggle"
            toggleValue={text.dyslexiaFont}
            onToggleChange={onToggleDyslexiaFont}
          />
          <ListRow
            title="Match device text size"
            subtitle="Follow the text size set in your device settings."
            variant="toggle"
            toggleValue={text.respectOsFontScale}
            onToggleChange={onToggleRespectOsFontScale}
          />
          <ListRow
            title="Readable spacing"
            subtitle="Looser line and word spacing."
            variant="toggle"
            toggleValue={text.readableSpacing}
            onToggleChange={onToggleReadableSpacing}
          />
        </View>

        {/* Own card, on explicit request — a slider reads as a distinct
            control from three toggles above it, the same separation
            ReaderPreferencesScreen's own sections already keep between
            single-control and multi-control cards. Still inside
            `accessibility-text-group`'s own describe block's reach: no
            testID moved, so existing tests still find it. */}
        <View style={styles.standaloneControl} testID="accessibility-text-scale-group">
          <SectionHeader
            title="Text scale"
            icon={<Text style={styles.iconLabel}>{TEXT_SCALE_ICON_LABEL}</Text>}
          />
          {/* "On top of", not "instead of" — the contract is explicit that this
              multiplies the OS scale rather than replacing it, and a reader who
              has both on should be able to predict the result. */}
          <Text style={styles.hint}>Applied on top of your device text size.</Text>
          <Slider
            testID="accessibility-font-scale-slider"
            value={text.fontScaleMultiplier}
            minimumValue={FONT_SCALE_MULTIPLIER.min}
            maximumValue={FONT_SCALE_MULTIPLIER.max}
            step={FONT_SCALE_MULTIPLIER.step}
            onSlidingComplete={onChangeFontScaleMultiplier}
          />
          <Text style={styles.readout}>{text.fontScaleMultiplier.toFixed(1)}×</Text>
        </View>

        {/* ── Display ─────────────────────────────────────────────────────── */}
        <View style={styles.group} testID="accessibility-display-group">
          <SectionHeader
            title="Display"
            icon={<Ionicons name="eye-outline" size={SECTION_ICON_SIZE} color={color.primary} />}
          />
          <ListRow
            title="Bold text"
            subtitle="Heavier weight throughout."
            variant="toggle"
            toggleValue={display.boldText}
            onToggleChange={onToggleBoldText}
          />
          {/* THE ONLY CONTRAST CONTROL IN THE APP — contract §2.2. The Theme
              picker on Reading Preferences deliberately offers only
              Light/Dark/Sepia/System and not the deprecated 'highContrast'
              theme; contrast is independent of theme, so dark plus high
              contrast is a valid combination. */}
          <ListRow
            title="High contrast"
            subtitle="Stronger contrast. Works with any theme."
            variant="toggle"
            toggleValue={display.highContrast}
            onToggleChange={onToggleHighContrast}
          />
          <ListRow
            title="Large touch targets"
            subtitle="Bigger hit areas for reader controls."
            variant="toggle"
            toggleValue={display.largeTouchTargets}
            onToggleChange={onToggleLargeTouchTargets}
          />
          <ListRow
            title="Large audio controls"
            subtitle="Bigger playback controls."
            variant="toggle"
            toggleValue={display.largeAudioControls}
            onToggleChange={onToggleLargeAudioControls}
          />

          {/* Stays NESTED inside `accessibility-display-group`, not its own
              card — `displayGroup()` in the test file scopes to this exact
              testID to reach these tabs, so moving it out would strand
              those assertions even though the mockup draws it separately. */}
          <View style={styles.control}>
            <SectionHeader
              title="Reduce motion"
              icon={<Ionicons name="sync-outline" size={SECTION_ICON_SIZE} color={color.primary} />}
            />
            <Text style={styles.hint}>
              System follows your device setting. On and Off override it.
            </Text>
            <Tabs
              tabs={[...REDUCE_MOTION_OPTIONS]}
              activeId={display.reduceMotion}
              variant="segmented"
              onChange={(id) => onSelectReduceMotion(id as ReduceMotion)}
            />
          </View>
        </View>

        {/* ── Announce ────────────────────────────────────────────────────── */}
        <View style={styles.group} testID="accessibility-announce-group">
          <SectionHeader
            title="Screen reader announcements"
            icon={<Ionicons name="volume-high-outline" size={SECTION_ICON_SIZE} color={color.primary} />}
          />
          <ListRow
            title="Page changes"
            subtitle="Announce each page turn."
            variant="toggle"
            toggleValue={announce.pageChanges}
            onToggleChange={onToggleAnnouncePageChanges}
          />
          <ListRow
            title="Chapter changes"
            subtitle="Announce when a new chapter starts."
            variant="toggle"
            toggleValue={announce.chapterChanges}
            onToggleChange={onToggleAnnounceChapterChanges}
          />
        </View>

        {/* ── Screen reader hints (top level, not a sub-block) ────────────── */}
        <View style={styles.group} testID="accessibility-hints-group">
          {/* The one group on this screen that used to open straight into its
              row — Text/Display/Announce above all open with their own
              `SectionHeader`, so this card's "heading" was really just
              `ListRow`'s own 15px title, a size smaller than every other
              card's 18px heading. This brings it in line. */}
          <SectionHeader
            title="Screen reader hints"
            icon={<Ionicons name="bulb-outline" size={SECTION_ICON_SIZE} color={color.primary} />}
          />
          {/* THE LIMIT IS IN THE COPY, NOT ONLY IN THE CONTRACT — §2.5. The flag
              reaches native controls only and cannot touch EPUB content inside
              the WebView, whose accessibility tree comes from the DOM. Wording
              it as if it improved book-content accessibility generally would be
              a promise the setting cannot keep. */}
          <ListRow
            title="Extra screen reader hints"
            subtitle="Adds labels to app controls. Does not change title content."
            variant="toggle"
            toggleValue={prefs.accessibility.screenReaderHints}
            onToggleChange={onToggleScreenReaderHints}
          />
          <Text style={styles.note}>
            Applies to this app&rsquo;s own buttons and menus only. Text inside a title is provided
            by the publisher and is not affected.
          </Text>
        </View>

        {/* ── Restore defaults ──────────────────────────────────────────────
            SCOPED TO THIS SCREEN'S OWN GROUP — see `onRestoreAccessibilityDefaults`
            on `useReaderPrefs`. Resetting theme/font/layout/typography from a
            screen that shows none of them would be surprising.

            A light-red CARD, matching ReaderPreferencesScreen's own Restore
            defaults exactly — same `errorTint`/`error` pairing, same
            left-aligned icon+title+subtitle shape, so a reader meets one
            affordance rather than two across the two screens. No
            confirmation sheet, for the same reason as there: the reset is
            one write the reader can immediately undo by re-picking. */}
        <Pressable
          style={styles.restore}
          onPress={onRestoreAccessibilityDefaults}
          accessibilityRole="button"
          accessibilityLabel="Restore defaults"
        >
          <Ionicons name="refresh-outline" size={SECTION_ICON_SIZE} color={color.error} />
          <View style={styles.restoreText}>
            <Text style={styles.restoreTitle}>Restore defaults</Text>
            <Text style={styles.restoreSubtitle}>
              Resets text, display and announcement settings
            </Text>
          </View>
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <View style={styles.screen}>
      {/* Overlays whatever is above it, in every state, and disables nothing —
          prefs are local-first, so offline never gates a write. */}
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
  content: {
    padding: space.md,
    paddingBottom: space.xl,
    gap: space.lg,
  },
  skeletonGroup: {
    gap: space.sm,
  },
  saveFailed: {
    fontWeight: typeScale.smallLabel.weight,
    fontSize: typeScale.smallLabel.size,
    lineHeight: typeScale.smallLabel.lineHeight,
    color: color.error,
  },
  // Bordered, rounded card — same treatment as ReaderPreferencesScreen's own
  // section files. `ListRow`'s own hairline separators inside still divide
  // the rows within it; this just gives the group itself an outer edge.
  group: {
    gap: space.sm,
    padding: space.md,
    backgroundColor: color.white,
    borderRadius: radius.sheet,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  // A single control that needs its own header and readout — used two ways:
  // NESTED (no border of its own) inside an already-carded `group` (Reduce
  // motion inside Display), or promoted to `standaloneControl` below when it
  // is its own top-level card (Text scale) — see each call site's own note.
  // `marginTop`, on top of `group`'s own `sm` gap, brings the space above
  // Reduce motion up to `lg` (24) — the same gap `content` puts between
  // separate cards. Without it, Reduce motion read as just another row in
  // the toggle list above it rather than the distinct control the mockup
  // draws it as.
  control: {
    gap: space.sm,
    marginTop: space.md,
  },
  standaloneControl: {
    gap: space.sm,
    padding: space.md,
    backgroundColor: color.white,
    borderRadius: radius.sheet,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
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
  // No longer cancels the content padding — this is now its own card, not an
  // edge-to-edge `ListRow`, matching ReaderPreferencesScreen's own Restore
  // defaults exactly.
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
    // header-to-first-card gap (32, from this padding stacking with the
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
