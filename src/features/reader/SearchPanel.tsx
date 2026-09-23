// Owner: Reader (Ahana).
//
// The in-book search panel: query box and results list. Presentational only — it does
// no querying and knows no bookId. Everything it does is a prop call, which is what
// lets ReaderScreen own navigation and this file own layout.
//
// AN OVERLAY, exactly like the Contents panel, and picking a result DISMISSES it.
// A previous version sat in the layout flow so it would never cover text, which sounds
// strictly better and was not: changing the viewer's height resizes the WebView, epub.js
// re-paginates on resize, and a CFI resolved under one pagination points at a different
// page under another — so every jump landed slightly off. Overlaying keeps the viewer a
// fixed size for the whole search, which is what makes a hit's CFI mean the same thing
// when it is tapped as when it was indexed.
//
// Covering the book while searching is therefore fine, because you are not reading then.
// What you read against afterwards is SearchMatchBar, which floats and also does not
// reflow. The stepper lives there rather than here for the same reason: stepping is
// something you do while looking at the page.

import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import Spinner from '@components/Spinner';
import { color, radius, space } from '@theme/tokens';

import { targetOf, locatorKey } from '@/features/reader/useBookSearch';
import type { SearchStatus } from '@/features/reader/useBookSearch';
// Search's own tokenizer, so the words named in the multi-word hint below are exactly
// the ones the query ran on. Re-splitting the term here would be a second, divergent
// implementation of a rule Search owns. text.ts is pure — no Node deps — and is
// already in the bundle via queryBookIndex → queryIndex.
import { termTokens } from '@/features/search/text';
import type { SearchHit } from '@/shared/contracts';

/**
 * How many result rows are actually rendered.
 *
 * Hits are one per WORD OCCURRENCE, not one per chapter, so a common word in a real
 * book returns hundreds — and a ScrollView renders every child it is given. Capping
 * the RENDER is not capping the RESULTS: `hits` stays whole, so the stepper below
 * still walks all of them. When the cap bites, the footer says so; a silently
 * truncated list would read as "that's all there is".
 *
 * FlatList would virtualize instead, and is the upgrade if 100 proves annoying in
 * use. It is not the choice today because under jest-expo it renders only its initial
 * window of 10, which quietly removes "the last result is present" from what a test
 * can assert.
 */
const MAX_RENDERED_HITS = 100;

export interface SearchPanelProps {
  query: string;
  onQueryChange: (next: string) => void;
  onSubmit: () => void;
  onClose: () => void;
  status: SearchStatus;
  hits: readonly SearchHit[];
  submittedTerm: string;
  failure: string | null;
  /** The empty result is "this book has no index", not "that word is absent". See `useBookSearch`. */
  indexMissing: boolean;
  activeIndex: number;
  /** Index into `hits`. The screen decides what selecting one means. */
  onSelectHit: (index: number) => void;
  /**
   * A hit was tapped but the WebView is not ready to seek yet — the screen has queued
   * the jump and will fire it the moment it can. Shown regardless of `status`: the
   * search itself already finished (that is how there is a hit to tap), so this is not
   * a search state, it is a "still opening the book" state.
   */
  awaitingSeek: boolean;
}

export function SearchPanel({
  query,
  onQueryChange,
  onSubmit,
  onClose,
  status,
  hits,
  submittedTerm,
  failure,
  indexMissing,
  activeIndex,
  onSelectHit,
  awaitingSeek,
}: SearchPanelProps): React.JSX.Element {
  const rendered = hits.slice(0, MAX_RENDERED_HITS);
  const tokens = termTokens(submittedTerm);

  return (
    <View style={styles.panel}>
      <View style={styles.headerRow}>
        <View style={styles.headerTitleRow}>
          <Ionicons name="search-outline" style={styles.headerIcon} />
          <Text style={styles.title}>Search</Text>
        </View>
        {/* Named, not just "Close": three panels in this reader have a close affordance, and a
            screen-reader user arriving at one out of visual context cannot tell which is which
            from the word alone. The counterpart labels live in BookmarksPanel and on
            ReaderScreen's Contents panel. Icon, not text — same circular close-button convention
            as the Contents/Bookmarks panels now use, "one visual system" rather than a fourth. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close search"
          onPress={onClose}
          style={styles.closeButton}
        >
          <Ionicons name="close" style={styles.closeIcon} />
        </Pressable>
      </View>

      <View style={styles.inputRow}>
        <TextInput
          testID="reader-search-input"
          // A placeholder is not a reliable accessible name on Android, so the label
          // is explicit even though the field looks self-evident.
          accessibilityLabel="Search in this title"
          style={styles.input}
          value={query}
          onChangeText={onQueryChange}
          onSubmitEditing={onSubmit}
          placeholder="Search in this title"
          placeholderTextColor={color.textSecondary}
          returnKeyType="search"
          autoFocus
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
        />
        {/* Both this and the return key call onSubmit: the return key is the faster
            path but is not discoverable on every keyboard. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Search"
          onPress={onSubmit}
          style={styles.searchButton}
        >
          <Ionicons name="arrow-forward" style={styles.searchButtonIcon} />
        </Pressable>
      </View>

      {/*
        ONE live region, on the line whose MEANING changes. Putting a second on the
        match counter would re-announce on every arrow press, which is the
        over-announcing failure mode that matters most in a reading app.
      */}
      <Text style={styles.status} accessibilityLiveRegion="polite">
        {statusLine(status, hits.length, submittedTerm, indexMissing)}
      </Text>

      {/*
        ORTHOGONAL TO `status`: the search already finished (there is a hit to have
        tapped), this is the book itself still opening. Its own live region, separate
        from the status line above, because it appears and disappears independently of
        anything a new search would change.
      */}
      {awaitingSeek && (
        <View style={styles.busyRow} accessibilityLiveRegion="polite">
          <Spinner />
          <Text style={styles.hint} testID="reader-search-awaiting-seek">
            Still opening this title — this result will open as soon as it&apos;s ready.
          </Text>
        </View>
      )}

      {status === 'searching' && (
        <View style={styles.busyRow}>
          <Spinner />
          <Text style={styles.hint}>Searching…</Text>
        </View>
      )}

      {status === 'idle' && (
        <Text style={styles.hint}>Type a word and press Search to find it in this title.</Text>
      )}

      {/*
        A MULTI-WORD SEARCH IS NOT A PHRASE SEARCH, and without saying so the count is
        actively misleading: "chapter 9" reports 91 matches, of which 88 are the word
        "chapter" on its own. Search ANDs the tokens at CHAPTER granularity and then
        returns every posting of EVERY query word in the chapters that qualify — so
        adding a word usually makes the list longer, which is the opposite of what
        anyone typing a second word expects.

        That is Search's documented prototype semantics (queryIndex.ts:12-14), not a
        defect, and not Reader's to change. Explaining it is Reader's job.
      */}
      {status === 'done' && hits.length > 0 && tokens.length > 1 && (
        <Text style={styles.hint}>
          {`Not a phrase search: this lists every occurrence of ` +
            `${tokens.map((token) => `“${token}”`).join(' and ')} ` +
            `in chapters that contain all of them.`}
        </Text>
      )}

      {status === 'done' && hits.length === 0 && (
        // The second line names an honest reason the answer is empty. It used to hedge, because
        // queryBookIndex returns [] both for "no matches" and for "this book shipped no index" and
        // did not say which — so copy asserting "this word is not in the book" was sometimes a lie.
        // `indexMissing` resolves that (see useBookSearch), and the two cases now read differently:
        // one is about the word, the other is about the book, and only the second is actionable.
        <Text style={styles.hint}>
          {indexMissing
            ? 'No text was indexed for this title, so no word can match. Searching needs an index ' +
              'built when the title is downloaded.'
            : tokens.length > 1
              ? 'Whole words only, and every word has to appear in the same chapter.'
              : 'Whole words only — “bio” will not match “biology”.'}
        </Text>
      )}

      {status === 'failed' && (
        <View style={styles.failure}>
          <Text style={styles.failureTitle}>Search is unavailable for this title.</Text>
          <Text style={styles.failureMessage}>{failure}</Text>
        </View>
      )}

      {/*
        THE WRAPPER IS WHAT MAKES THE LIST SCROLL, and it is not optional — the
        Contents panel learned this and the note there is easy to half-apply.
        `flex: 1` is needed HERE, on a plain View, because a View defaults to
        flexShrink: 0; without it this box grows to its content height and the
        overflow is simply clipped by the panel, so the results past the first
        screenful cannot be reached.

        It is deliberately NOT on the ScrollView itself: that carries
        flexGrow/flexShrink: 1 in its own base style, so once it has a bounded
        parent it is already constrained, and adding `flex: 1` there is the no-op
        recorded in ReaderScreen.tsx. Bounded parent, unstyled child.

        Everything above this is variable height (the status line, the multi-word
        hint, the failure box), which is the other reason the list needs a flexible
        box rather than a fixed height.
      */}
      <View style={styles.listWrap}>
        <ScrollView
          testID="reader-search-results"
          style={styles.list}
          contentContainerStyle={styles.listContent}
          // Without this the first tap on a result only dismisses the keyboard and the
          // user has to tap twice. It is the classic bug in exactly this UI.
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator
        >
          {rendered.map((hit, index) => {
            // Both formats seek now, so in practice every row is navigable — this used to be false
            // for every PDF hit, which rendered a real result as an unavailable one. Kept rather than
            // removed: it is the honest state for a locator shape the reader has no renderer for, and
            // a row that looks tappable and is not would be worse than one that says so.
            const navigable = targetOf(hit) !== null;
            // A run header, not a section list: chapterId is an extractor-side id, and
            // resolving it to a human chapter title would mean guessing that it shares a
            // namespace with the TOC's hrefs. Nothing states that it does.
            const startsChapter = index === 0 || hit.chapterId !== rendered[index - 1].chapterId;

            return (
              <View key={`${index}-${locatorKey(hit)}`}>
                {startsChapter && <Text style={styles.chapterCaption}>{hit.chapterId}</Text>}
                {/* Composed rather than left to implicit naming. The row's children concatenate
                    to "3 <snippet> Not available in this reader", which is the right information
                    in the wrong order — the ordinal arrives as a bare number before anything has
                    said what it counts. `hits.length`, not `rendered.length`: the ordinals are
                    positions in the whole result set (that is what "Match n of m" in
                    SearchMatchBar counts too), and the list is capped for rendering only. */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    `Result ${index + 1} of ${hits.length}: ${hit.snippet}` +
                    (navigable ? '' : '. Not available in this reader')
                  }
                  accessibilityState={{ disabled: !navigable }}
                  disabled={!navigable}
                  onPress={() => {
                    onSelectHit(index);
                  }}
                  style={[
                    styles.row,
                    index === activeIndex && styles.rowActive,
                    !navigable && styles.disabled,
                  ]}
                >
                  <Text style={styles.rowOrdinal}>{index + 1}</Text>
                  <View style={styles.rowBody}>
                    <Text style={styles.rowSnippet}>{hit.snippet}</Text>
                    {/* Listed rather than filtered out. Dropping it would desynchronise
                      the ordinals from "Match n of m", and an all-PDF result set would
                      render as an empty list under a "no matches" message. */}
                    {!navigable && (
                      <Text style={styles.rowUnavailable}>Not available in this reader</Text>
                    )}
                  </View>
                </Pressable>
              </View>
            );
          })}

          {hits.length > MAX_RENDERED_HITS && (
            <Text style={styles.hint}>
              {`Showing the first ${MAX_RENDERED_HITS} of ${hits.length} matches. ` +
                `Add another word to narrow it down.`}
            </Text>
          )}
        </ScrollView>
      </View>
    </View>
  );
}

function statusLine(
  status: SearchStatus,
  count: number,
  term: string,
  indexMissing: boolean,
): string {
  if (status === 'failed') return 'Search failed.';
  if (status === 'searching') return 'Searching…';
  if (status !== 'done') return '';
  // Before the term, not after it: an unindexed book gives the same answer for every word, so
  // naming the word would imply a search happened that never could have.
  if (count === 0 && indexMissing) return 'This title has no search index.';
  if (count === 0) return `No matches for “${term}” in this title.`;
  return `${count} ${count === 1 ? 'match' : 'matches'} for “${term}”.`;
}

const styles = StyleSheet.create({
  // Absolutely filled over `viewer`, matching the Contents panel. Explicit inset
  // rather than StyleSheet.absoluteFillObject for the same reason ReaderScreen gives:
  // RN 0.86's types export only `absoluteFill`, so the *Object form fails typecheck.
  // OPAQUE, not translucent — book text showing faintly through a results list is
  // unreadable for both.
  panel: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: color.white,
    borderTopWidth: 1,
    borderTopColor: color.border,
    paddingHorizontal: space.md,
    paddingTop: 12,
  },

  // Same header shape as BookmarksPanel/the Contents panel — a title (with a leading icon here,
  // since "Search" alone reads ambiguously next to Bookmarks/Contents in a screenshot, unlike
  // those two whose icon lives one level up, in the "⋯" menu row that opens them) plus a circular
  // close button, "one visual system" rather than three panels each inventing their own header.
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  headerIcon: { fontSize: 20, color: color.primary },
  title: { fontSize: 18, fontWeight: '700', color: color.textPrimary },
  closeButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.card,
  },
  closeIcon: { fontSize: 22, color: color.textSecondary },

  inputRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 12 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.card,
    backgroundColor: color.surface,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: color.textPrimary,
  },
  // Filled, brand-blue circle — the primary action in this row, same "solid accent for the one
  // action that matters most" treatment the reader's other primary buttons use, rather than the
  // same flat `color.surface` pill every secondary control gets.
  searchButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.card,
    backgroundColor: color.primary,
  },
  searchButtonIcon: { fontSize: 20, color: color.white },

  status: { marginTop: 10, fontSize: 13, fontWeight: '700', color: color.textPrimary },
  hint: { marginTop: 6, fontSize: 13, color: color.textSecondary },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm },

  failure: {
    marginTop: space.sm,
    backgroundColor: color.errorTint,
    borderWidth: 1,
    // No lighter/tint border token exists for error state, so this borrows `color.error`
    // itself rather than inventing an untracked hex (CONVENTIONS §5) — same call as
    // ReaderScreen's own errorBanner.
    borderColor: color.error,
    borderRadius: radius.card,
    padding: 10,
  },
  failureTitle: { fontSize: 13, fontWeight: '700', color: color.error },
  failureMessage: { marginTop: 4, fontSize: 12, color: color.error },

  disabled: { opacity: 0.4 },

  // `flex: 1` belongs on this plain View (which defaults to flexShrink: 0), not on the
  // ScrollView inside it — see the note at the JSX.
  listWrap: { flex: 1 },

  // No `flex: 1` here: the wrapper above bounds it, and ScrollView already carries
  // flexGrow/flexShrink: 1 in its own base style.
  list: { marginTop: 10, borderTopWidth: 1, borderTopColor: color.border },
  listContent: { paddingBottom: 48 },

  chapterCaption: {
    marginTop: 10,
    marginBottom: 2,
    fontSize: 11,
    fontWeight: '700',
    color: color.textSecondary,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: space.sm,
    borderRadius: radius.card,
    borderBottomWidth: 1,
    borderBottomColor: color.border,
  },
  rowActive: { backgroundColor: color.surface, borderBottomColor: 'transparent' },
  // A small round badge, not bare text — matches the ordinal treatment nowhere else in the reader
  // needed until this list existed, but reads as a deliberate counter rather than a stray number.
  rowOrdinal: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    textAlign: 'center',
    lineHeight: 22,
    fontSize: 11,
    fontWeight: '700',
    color: color.textSecondary,
    backgroundColor: color.surface,
    overflow: 'hidden',
  },
  rowBody: { flex: 1 },
  rowSnippet: { fontSize: 14, color: color.textPrimary },
  rowUnavailable: { marginTop: 2, fontSize: 11, color: color.textSecondary },
});
