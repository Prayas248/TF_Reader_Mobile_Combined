// Owner: Reader (Ahana).
//
// The bookmarks panel: list, tap-to-navigate, tap-to-delete, tap-to-rename, and an
// add-current-position button. Presentational only, same split as SearchPanel — it does no storage
// and knows no bookId. Everything it does is a prop call, which is what lets ReaderScreen own the
// writes (via readerBookmarks.ts, Personalization's) and this file own layout.
//
// NO NEW BRIDGE COMMAND HERE. A bookmark does not paint — it is a place to jump to — and the jump is
// the existing `goTo` command every TOC entry and search hit already uses. See
// READER_BOOKMARKS_WIRING.md for the full writes/applies split.
//
// AN OVERLAY, matching Contents and Search, for the same reason those are: resizing the viewer
// re-paginates epub.js, and a CFI resolved under one pagination points at a different page under
// another. Overlaying keeps the viewer a fixed size for the whole time this panel is open.

import { useState } from 'react';
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

import type { ReaderBookmark } from '@/features/personalization/readerBookmarks';

export interface BookmarksPanelProps {
  bookmarks: readonly ReaderBookmark[];
  /**
   * Whether the initial `loadBookmarks()` has resolved at least once. Distinguishes "still reading
   * from storage" from "read storage and there is nothing there" — the same distinction Search's
   * `status` makes, collapsed to one boolean because there is no failure state worth its own copy:
   * `loadBookmarks()` surfaces unparsable rows as `skippedBookmarkCount`, not as a rejection.
   */
  loaded: boolean;
  /** Rows `toReaderBookmarks` set aside as corrupt rather than dropping silently. */
  skippedBookmarkCount: number;
  onSelect: (bookmark: ReaderBookmark) => void;
  onDelete: (id: string) => void;
  /**
   * Edit an EXISTING bookmark's name. Takes the id, matching `onDelete` beside it — the rename is an
   * update in place, so nothing about the bookmark except its name is needed to perform it.
   *
   * `name: undefined` for a field cleared back to blank, same convention as `onAddCurrent`: the row
   * falls back to `labelFor`'s own default (chapter id, then "Bookmark"/"Page N") rather than
   * displaying an empty label. ReaderScreen forwards that as the empty string the store's `name`
   * column takes, which `labelFor` reads as absent — see `submitBookmarkRename` there.
   */
  onRename: (id: string, name?: string) => void;
  /**
   * `name` is exactly what `addCurrentEpubBookmark`/`addCurrentPdfBookmark` accept — `undefined` for
   * a blank field, so an untouched input falls through to `labelFor`'s own fallback (chapter id, or
   * "Bookmark"/"Page N") rather than this panel inventing a second empty-label convention.
   */
  onAddCurrent: (name?: string) => void;
  /**
   * Whether the current reading position can be bookmarked right now. False before the first
   * `relocated` (EPUB's `cfi` starts `null` until epub.js resolves a location) and while the WebView
   * has not reported `ready` yet — the same two guards `submitPageJump` already applies to its own
   * `send`.
   */
  canAddCurrent: boolean;
  onClose: () => void;
}

export function BookmarksPanel({
  bookmarks,
  loaded,
  skippedBookmarkCount,
  onSelect,
  onDelete,
  onRename,
  onAddCurrent,
  canAddCurrent,
  onClose,
}: BookmarksPanelProps): React.JSX.Element {
  // Local, not lifted to ReaderScreen: this text means nothing outside the moment of pressing "Add" —
  // unlike the search query or the page-jump field, nothing else in the reader reads it, and it is
  // cleared the instant it is used. `useBookSearch`'s query lives in a hook because Search needs it
  // across re-opens of its own panel; a bookmark's label does not outlive the add it names.
  const [label, setLabel] = useState('');

  const submitAdd = (): void => {
    const trimmed = label.trim();
    onAddCurrent(trimmed === '' ? undefined : trimmed);
    setLabel('');
  };

  /**
   * At most ONE row edits at a time — same reasoning as `pageJump`'s single field in ReaderScreen:
   * there is one keyboard, so there is never a real case for two rows editing together. `editingText`
   * is separate from `bookmarks[].label` so typing does not need a round trip through `onRename` on
   * every keystroke — only Save commits it.
   */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

  const startEdit = (bookmark: ReaderBookmark): void => {
    setEditingId(bookmark.id);
    setEditingText(bookmark.label);
  };

  const cancelEdit = (): void => {
    setEditingId(null);
  };

  const saveEdit = (bookmark: ReaderBookmark): void => {
    const trimmed = editingText.trim();
    onRename(bookmark.id, trimmed === '' ? undefined : trimmed);
    setEditingId(null);
  };

  return (
    <View style={styles.panel}>
      <View style={styles.headerRow}>
        <View style={styles.headerTitleRow}>
          <Ionicons name="bookmark-outline" style={styles.headerIcon} />
          <Text style={styles.title}>Bookmarks</Text>
        </View>
        {/* Named for the same reason SearchPanel's is — see the note there. Icon, not text — same
            circular close-button convention as Search/Contents now use. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close bookmarks"
          onPress={onClose}
          style={styles.closeButton}
        >
          <Ionicons name="close" style={styles.closeIcon} />
        </Pressable>
      </View>

      <View style={styles.addRow}>
        <TextInput
          testID="reader-bookmark-label-input"
          accessibilityLabel="Bookmark label"
          style={styles.addInput}
          value={label}
          onChangeText={setLabel}
          onSubmitEditing={submitAdd}
          placeholder="Name this bookmark (optional)"
          placeholderTextColor={color.textSecondary}
          returnKeyType="done"
          editable={canAddCurrent}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Bookmark this page"
          disabled={!canAddCurrent}
          onPress={submitAdd}
          style={[styles.addButton, !canAddCurrent && styles.disabled]}
        >
          <Ionicons name="add" style={styles.addButtonIcon} />
        </Pressable>
      </View>

      {/*
        Same "wrapper carries flex: 1, ScrollView does not" split as SearchPanel and the Contents
        list — a plain View defaults to flexShrink: 0 and would otherwise grow to its content height,
        clipping everything past the first screenful rather than scrolling it.
      */}
      <View style={styles.listWrap}>
        {!loaded ? (
          <View style={styles.busyRow}>
            <Spinner />
            <Text style={styles.hint}>Loading bookmarks…</Text>
          </View>
        ) : bookmarks.length === 0 ? (
          <Text style={styles.hint}>No bookmarks yet. Add one from the button above.</Text>
        ) : (
          <ScrollView
            testID="reader-bookmarks-list"
            style={styles.list}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator
          >
            {bookmarks.map((bookmark) =>
              editingId === bookmark.id ? (
                <View key={bookmark.id} style={styles.row}>
                  <TextInput
                    testID={`reader-bookmark-edit-input-${bookmark.id}`}
                    accessibilityLabel={`Edit bookmark name: ${bookmark.label}`}
                    style={styles.editInput}
                    value={editingText}
                    onChangeText={setEditingText}
                    onSubmitEditing={() => {
                      saveEdit(bookmark);
                    }}
                    returnKeyType="done"
                    autoFocus
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Save bookmark name: ${bookmark.label}`}
                    onPress={() => {
                      saveEdit(bookmark);
                    }}
                    style={styles.editAction}
                  >
                    <Ionicons name="checkmark" style={styles.editActionIcon} />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    // Explicit rather than left to the (now-removed) Text child: an icon gives a
                    // screen reader nothing to say, unlike a bare "Cancel" label always would have.
                    accessibilityLabel="Cancel"
                    onPress={cancelEdit}
                    style={styles.editAction}
                  >
                    <Ionicons name="close" style={styles.editActionIcon} />
                  </Pressable>
                </View>
              ) : (
                <View key={bookmark.id} style={styles.row}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      onSelect(bookmark);
                    }}
                    style={styles.rowBody}
                  >
                    <Text style={styles.rowLabel}>{bookmark.label}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Edit bookmark: ${bookmark.label}`}
                    onPress={() => {
                      startEdit(bookmark);
                    }}
                    style={styles.editButton}
                  >
                    <Ionicons name="pencil-outline" style={styles.editButtonIcon} />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Delete bookmark: ${bookmark.label}`}
                    onPress={() => {
                      onDelete(bookmark.id);
                    }}
                    style={styles.deleteButton}
                  >
                    <Ionicons name="trash-outline" style={styles.deleteButtonIcon} />
                  </Pressable>
                </View>
              ),
            )}
          </ScrollView>
        )}
      </View>

      {/* Set aside, not dropped — same reasoning as the TOC's own hardeners: a stored bookmark this
          panel could not resolve is worth surfacing rather than silently shrinking the list by one. */}
      {loaded && skippedBookmarkCount > 0 && (
        <Text style={styles.hint}>
          {skippedBookmarkCount === 1
            ? '1 bookmark could not be read and was left out.'
            : `${skippedBookmarkCount} bookmarks could not be read and were left out.`}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Matching SearchPanel/Contents: absolutely filled over `viewer`, opaque — book text showing
  // faintly through a bookmarks list is as unreadable here as it is there.
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

  // Same header shape as SearchPanel — see that file's own comment on why: a title with a leading
  // icon plus a circular close button, one visual system rather than three panel-specific headers.
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

  addRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: 12 },
  addInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.card,
    backgroundColor: color.surface,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    color: color.textPrimary,
  },
  // Filled brand-blue circle — same "solid accent for the row's one primary action" treatment as
  // SearchPanel's own searchButton.
  addButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.card,
    backgroundColor: color.primary,
  },
  addButtonIcon: { fontSize: 22, color: color.white },
  disabled: { opacity: 0.4 },

  listWrap: { flex: 1, marginTop: 12 },
  list: { borderTopWidth: 1, borderTopColor: color.border },
  listContent: { paddingBottom: 48 },

  busyRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm },
  hint: { marginTop: 6, fontSize: 13, color: color.textSecondary },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: color.border,
  },
  rowBody: { flex: 1, paddingVertical: 12 },
  rowLabel: { fontSize: 15, color: color.textPrimary },
  // Icon buttons, not text — same 44pt touch target and glyph convention the rest of the reader's
  // controls use, rather than a fourth "Edit"/"Delete" text-button style of its own.
  editButton: {
    minWidth: 40,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.card,
  },
  editButtonIcon: { fontSize: 19, color: color.textSecondary },
  deleteButton: {
    minWidth: 40,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.card,
  },
  deleteButtonIcon: { fontSize: 19, color: color.error },

  editInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.card,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    marginVertical: space.sm,
    fontSize: 15,
    color: color.textPrimary,
  },
  editAction: {
    minWidth: 40,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.card,
  },
  editActionIcon: { fontSize: 19, color: color.textPrimary },
  editActionText: { fontSize: 13, fontWeight: '700', color: color.textPrimary },
});
