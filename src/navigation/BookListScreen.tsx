// Owner: Reader (Ahana), same status as the App.tsx picker this replaces — TEMP, dev-only, and NOT
// the "Create book list page" this file's name might suggest to a real library screen. There is
// still no backend book catalogue to list, so this lists the four fixtures App.tsx used to,
// plus the audiobook row and sync mock, as real navigable routes instead of a state-swapped picker.
//
// FOUR BOOK FIXTURES, ALWAYS LISTED: the two bundled stand-ins and the two large books pushed
// into the container via EXPO_PUBLIC_READER_FIXTURE_EPUB/_PDF.
//
// THE UNRECOGNISED-ACTIVE-BOOK FALLBACK ROW FROM App.tsx's `devFixtureOptions` DOES NOT CARRY OVER.
// It existed because that picker always had exactly one "active" bookId that had to be represented
// somewhere in the list. A list screen with real routes has no such concept — nothing is "active"
// here, and Reader always opens exactly the bookId it was navigated to.
//
// OPEN BUTTON FLOWS THROUGH openBook(): tapping a row first calls openBook() (the unified
// STREAM-intent licence gate — checkLicense → fetch/store → openSession → decryptBook), which
// stores an Elite (in-memory, canPersist:false) package that ReaderScreen's getBookBase64()
// picks up. For already-downloaded books, openBook() short-circuits to the disk copy. If
// openBook() fails (offline with no local copy, entitlement revoked, etc.), the error is shown
// as an alert and the user stays on the list.

import { useState } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { color, radius, space } from '@theme/tokens';

import { DownloadProgressIndicator } from '@/features/download/DownloadProgressIndicator';
import { useDownloadProgress } from '@/features/download/useDownloadProgress';
import { openBook } from '@/features/download/openBook';
import { clearAllDownloads } from '@/features/download/downloadManager';
import { MiniAudioPlayer } from '@/features/reader/audio/MiniAudioPlayer';
import {
  selectAndPlayAudiobook,
  toggleAudioPlayback,
} from '@/features/reader/audio/audioQueueCoordinator';
import { audioQueueStore, useAudioQueueStore } from '@/features/reader/audio/audioQueueStore';
import { formatDiagnosticErrorMessage } from '@/shared/contracts/errors';
import type { BookId, ContentFormat } from '@/shared/contracts';

// Not registered in RootNavigator (integration_ref.md's "Scaffolding to NOT copy" names this
// screen's flat-shell entry point directly) — types itself against its own param shape rather
// than a live navigator's param list.
type BookListRouteParamList = {
  BookList: undefined;
  Reader: { bookId: BookId; format: ContentFormat; title?: string };
  AudioPlayer: { bookId: BookId; title: string };
  MockLibrary: undefined;
};

const DEV_SAMPLE_EPUB_BOOK_ID = 'dev-sample-epub' as BookId;
const DEV_SAMPLE_PDF_BOOK_ID = 'dev-sample-pdf' as BookId;
const DEV_FIXTURE_EPUB_BOOK_ID = 'dev-fixture-epub' as BookId;
const DEV_FIXTURE_PDF_BOOK_ID = 'dev-fixture-pdf' as BookId;

interface DevFixture {
  label: string;
  bookId: BookId;
  format: ContentFormat;
}

/**
 * The audiobook's id is a REAL BACKEND CATALOGUE ID, not a seeded one — which is why it is declared
 * here rather than imported from `devContentSeed.ts` like every other row.
 *
 * It matches `_id: "dev-sample-audio-encrypted"` in the backend's `demo-dataset.json` (SUBSCRIPTION
 * tier, publisher `pub_rtlg`, covered by entitlement `ent_imp2`), whose content grant resolves to
 * an encrypted `sample-small.wav.enc`. Nothing on the device seeds it: tapping the row acquires it
 * through `openBook()` (stream) or the row's own Download button (persist).
 *
 * If this id and the backend's ever drift apart, the symptom is a licence check that fails rather
 * than anything subtle — the catalogue simply has no such item.
 */
const BACKEND_AUDIO_BOOK_ID = 'dev-sample-audio-encrypted' as BookId;

/**
 * A SECOND real-backend-catalogue id, same reasoning as `BACKEND_AUDIO_BOOK_ID` above: nothing on
 * the device seeds it, tapping/downloading acquires it live. Added 2026-09-04 specifically to
 * verify a genuinely well-formed OPEN_ACCESS grant end-to-end — `licenceModel: 'OPEN_ACCESS'` with
 * NO `encryption` block at all on the reading-session response, unlike `dev-sample-epub` (that
 * fixture's own `licenceModel` says OPEN_ACCESS but its grant still carries a real `encryption`
 * block — a documented backend quirk `downloadManager.ts`'s `isEncrypted || license.mode !==
 * 'open-access'` check exists to survive; see that file's comment). This row is the control case:
 * no `encryption` field, so `isEncrypted` is false and the book should store/decrypt as genuine
 * plaintext with zero special-casing.
 */
const BACKEND_EPUB_OPEN_BOOK_ID = 'dev-sample-epub-open' as BookId;

/**
 * A SECOND real-backend audio book, added 2026-09-08 specifically so there is more than one
 * audiobook to open — `BACKEND_AUDIO_BOOK_ID` alone can't exercise "opening a different book
 * releases whatever was playing before" (`audioPlayerInstance.ts`'s `getAudioPlayerFor`), since
 * that path only runs when a SECOND bookId is opened while the first is still live.
 *
 * Unencrypted OPEN_ACCESS, matching `dev-sample-epub-open`'s pattern rather than
 * `BACKEND_AUDIO_BOOK_ID`'s — team wokay's own shared.md states audio is never encrypted in any
 * tier except that one named dev fixture, so a second encrypted audio item would need its own
 * carve-out in their `ContentAccessGrantImpl` and in `DemoDataSeederTest`'s
 * `seededAudioAssetsAreUnencryptedAndUnindexed`, which already asserts every OTHER audio asset is
 * unencrypted. Riding the existing exception was the wrong ask; this rides the existing rule.
 */
const BACKEND_AUDIO_OPEN_BOOK_ID = 'dev-sample-audio-open' as BookId;

const DEV_FIXTURES: readonly DevFixture[] = [
  { label: 'EPUB', bookId: DEV_SAMPLE_EPUB_BOOK_ID, format: 'EPUB' },
  { label: 'PDF', bookId: DEV_SAMPLE_PDF_BOOK_ID, format: 'PDF' },
  { label: 'Big EPUB', bookId: DEV_FIXTURE_EPUB_BOOK_ID, format: 'EPUB' },
  { label: 'Big PDF', bookId: DEV_FIXTURE_PDF_BOOK_ID, format: 'PDF' },
  // The one row backed by the REAL BACKEND rather than a local seed. Tapping it routes to the
  // AudioPlayer route (see onPress below); the row's Download button persists it for offline
  // playback through the same `useDownloadProgress` hook every other row uses.
  { label: 'Audiobook (Encrypted)', bookId: BACKEND_AUDIO_BOOK_ID, format: 'AUDIO' },
  // See BACKEND_AUDIO_OPEN_BOOK_ID's own comment — the second audiobook, for multi-book testing.
  { label: 'Audiobook (Open Access)', bookId: BACKEND_AUDIO_OPEN_BOOK_ID, format: 'AUDIO' },
  // See BACKEND_EPUB_OPEN_BOOK_ID's own comment — the genuinely-unencrypted OPEN_ACCESS control.
  { label: 'EPUB (Open Access)', bookId: BACKEND_EPUB_OPEN_BOOK_ID, format: 'EPUB' },
];

const AUDIO_FIXTURES: readonly DevFixture[] = DEV_FIXTURES.filter((f) => f.format === 'AUDIO');
const BOOK_FIXTURES: readonly DevFixture[] = DEV_FIXTURES.filter((f) => f.format !== 'AUDIO');

type TabType = 'all' | 'audio' | 'books';

type Props = NativeStackScreenProps<BookListRouteParamList, 'BookList'>;

function FixtureRow({
  fixture,
  isActive = false,
  isPlaying = false,
  isInQueue = false,
  onPress,
  onPlaySwitch,
  onOpenPlayer,
  onPlayNext,
  onAddToQueue,
}: {
  fixture: DevFixture;
  isActive?: boolean;
  isPlaying?: boolean;
  isInQueue?: boolean;
  onPress: () => void;
  onPlaySwitch?: () => void;
  onOpenPlayer?: () => void;
  onPlayNext?: () => void;
  onAddToQueue?: () => void;
}): React.JSX.Element {
  // One instance per row — see the header note on why this isn't one shared hook.
  const downloadProgress = useDownloadProgress();
  const isAudio = fixture.format === 'AUDIO';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={isAudio ? `Select audiobook: ${fixture.label}` : fixture.label}
      onPress={onPress}
      style={[
        styles.row,
        isAudio && styles.audioRow,
        isActive && styles.activeAudioRow,
      ]}
    >
      <View style={styles.rowHeader}>
        <View style={styles.labelWithIcon}>
          {isAudio && <Text style={styles.audioIcon}>🎧</Text>}
          <Text style={[styles.rowLabel, isActive && styles.activeRowLabel]}>
            {fixture.label}
          </Text>
        </View>

        {isAudio && isActive && (
          <View style={styles.statusBadge}>
            <Text style={styles.statusBadgeText}>
              {isPlaying ? '▶ Now Playing' : '⏸ Paused'}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.rowActions}>
        {isAudio && (
          <View style={styles.audioMainActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Play or switch to ${fixture.label}`}
              onPress={onPlaySwitch}
              style={[styles.primaryButton, isActive && isPlaying && styles.pauseButton]}
            >
              <Text style={styles.primaryButtonLabel}>
                {isActive ? (isPlaying ? '⏸ Pause' : '▶ Resume') : '▶ Play'}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open player for ${fixture.label}`}
              onPress={onOpenPlayer}
              style={styles.openPlayerButton}
            >
              <Text style={styles.openPlayerButtonLabel}>Open Player ↗</Text>
            </Pressable>
          </View>
        )}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Download ${fixture.label}`}
          onPress={() => downloadProgress.start(fixture.bookId, fixture.format)}
          disabled={downloadProgress.status === 'downloading'}
          style={[
            styles.downloadButton,
            downloadProgress.status === 'downloading' && styles.downloadButtonDisabled,
          ]}
        >
          <Text style={styles.downloadButtonLabel}>Download</Text>
        </Pressable>

        {isAudio && (
          <View style={styles.audioQueueActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Play next: ${fixture.label}`}
              onPress={onPlayNext}
              style={[styles.queueButton, isInQueue && styles.queueButtonDisabled]}
            >
              <Text style={[styles.queueButtonLabel, isInQueue && styles.queueButtonLabelDisabled]}>
                Play Next
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Add to queue: ${fixture.label}`}
              onPress={onAddToQueue}
              style={[styles.queueButton, isInQueue && styles.queueButtonDisabled]}
            >
              <Text style={[styles.queueButtonLabel, isInQueue && styles.queueButtonLabelDisabled]}>
                {isInQueue ? 'In Queue ✓' : '+ Queue'}
              </Text>
            </Pressable>
          </View>
        )}
      </View>

      <DownloadProgressIndicator {...downloadProgress} />
    </Pressable>
  );
}

export function BookListScreen({ navigation }: Props): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<TabType>('all');
  const [clearedGeneration, setClearedGeneration] = useState(0);
  const [clearingAll, setClearingAll] = useState(false);

  const currentItem = useAudioQueueStore((s) => s.getCurrentItem());
  const isPlaying = useAudioQueueStore((s) => s.isPlaying);
  const queueItems = useAudioQueueStore((s) => s.items);

  const handlePlayNext = (fixture: DevFixture) => {
    if (audioQueueStore.getState().isInQueue(fixture.bookId)) {
      Alert.alert('Already in Queue', `"${fixture.label}" is already in the queue.`);
      return;
    }
    audioQueueStore.getState().playNext({ bookId: fixture.bookId, title: fixture.label });
    Alert.alert('Queue Updated', `"${fixture.label}" will play next.`);
  };

  const handleAddToQueue = (fixture: DevFixture) => {
    if (audioQueueStore.getState().isInQueue(fixture.bookId)) {
      Alert.alert('Already in Queue', `"${fixture.label}" is already in the queue.`);
      return;
    }
    audioQueueStore.getState().enqueue({ bookId: fixture.bookId, title: fixture.label });
    Alert.alert('Queue Updated', `Added "${fixture.label}" to queue.`);
  };

  const handleSelectAudiobook = async (fixture: DevFixture) => {
    try {
      if (currentItem?.bookId === fixture.bookId) {
        if (!isPlaying) {
          await toggleAudioPlayback();
        }
        return;
      }
      await selectAndPlayAudiobook({
        bookId: fixture.bookId,
        title: fixture.label,
      });
    } catch (error) {
      const message = formatDiagnosticErrorMessage(error);
      Alert.alert('Cannot play audiobook', message);
    }
  };

  const handlePlaySwitch = async (fixture: DevFixture) => {
    if (currentItem?.bookId === fixture.bookId) {
      await toggleAudioPlayback();
    } else {
      await handleSelectAudiobook(fixture);
    }
  };

  const handleOpenPlayer = (fixture: DevFixture) => {
    navigation.navigate('AudioPlayer', { bookId: fixture.bookId, title: fixture.label });
  };

  const handleClearAllDownloads = async () => {
    setClearingAll(true);
    try {
      await clearAllDownloads();
      setClearedGeneration((generation) => generation + 1);
      Alert.alert('Cleared', 'All downloaded books have been removed from this device.');
    } catch (error) {
      Alert.alert('Could not clear all downloads', String(error));
    } finally {
      setClearingAll(false);
    }
  };

  const handleOpen = async (bookId: BookId, format: ContentFormat, title?: string) => {
    try {
      await openBook(bookId, format);
      navigation.navigate('Reader', { bookId, format, title });
    } catch (error) {
      const message = formatDiagnosticErrorMessage(error);
      Alert.alert('Cannot open book', message);
    }
  };

  return (
    <View style={styles.screenContainer}>
      {/* Segmented Filter Tabs */}
      <View style={styles.tabBar} accessibilityRole="tablist">
        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'all' }}
          accessibilityLabel="All items"
          onPress={() => setActiveTab('all')}
          style={[styles.tabButton, activeTab === 'all' && styles.tabButtonActive]}
        >
          <Text style={[styles.tabButtonText, activeTab === 'all' && styles.tabButtonTextActive]}>
            All ({DEV_FIXTURES.length})
          </Text>
        </Pressable>

        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'audio' }}
          accessibilityLabel="Audiobooks"
          onPress={() => setActiveTab('audio')}
          style={[styles.tabButton, activeTab === 'audio' && styles.tabButtonActive]}
        >
          <Text style={[styles.tabButtonText, activeTab === 'audio' && styles.tabButtonTextActive]}>
            🎧 Audiobooks ({AUDIO_FIXTURES.length})
          </Text>
        </Pressable>

        <Pressable
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'books' }}
          accessibilityLabel="Books and PDFs"
          onPress={() => setActiveTab('books')}
          style={[styles.tabButton, activeTab === 'books' && styles.tabButtonActive]}
        >
          <Text style={[styles.tabButtonText, activeTab === 'books' && styles.tabButtonTextActive]}>
            📖 Books ({BOOK_FIXTURES.length})
          </Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.container}
        contentContainerStyle={[
          styles.content,
          currentItem ? { paddingBottom: 88 + insets.bottom } : undefined,
        ]}
      >
        {/* Audiobooks Section */}
        {(activeTab === 'all' || activeTab === 'audio') && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>🎧 Audiobooks</Text>
              <Text style={styles.sectionSubtitle}>
                Select an audiobook to play and switch in the mini player
              </Text>
            </View>

            {AUDIO_FIXTURES.map((fixture) => {
              const isActive = currentItem?.bookId === fixture.bookId;
              const isInQueue = queueItems.some((i) => i.bookId === fixture.bookId);
              return (
                <FixtureRow
                  key={`${fixture.bookId}-${clearedGeneration}`}
                  fixture={fixture}
                  isActive={isActive}
                  isPlaying={isActive && isPlaying}
                  isInQueue={isInQueue}
                  onPress={() => {
                    void handleSelectAudiobook(fixture);
                  }}
                  onPlaySwitch={() => {
                    void handlePlaySwitch(fixture);
                  }}
                  onOpenPlayer={() => handleOpenPlayer(fixture)}
                  onPlayNext={() => handlePlayNext(fixture)}
                  onAddToQueue={() => handleAddToQueue(fixture)}
                />
              );
            })}
          </View>
        )}

        {/* E-Books & Documents Section */}
        {(activeTab === 'all' || activeTab === 'books') && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>📖 E-Books & Documents</Text>
              <Text style={styles.sectionSubtitle}>Tap a book to open in reader</Text>
            </View>

            {BOOK_FIXTURES.map((fixture) => (
              <FixtureRow
                key={`${fixture.bookId}-${clearedGeneration}`}
                fixture={fixture}
                onPress={() => {
                  void handleOpen(fixture.bookId, fixture.format, fixture.label);
                }}
              />
            ))}
          </View>
        )}

        {/* Dev & Testing Tools Section */}
        {activeTab === 'all' && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>⚙️ Dev & Testing Tools</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear all downloads"
              onPress={handleClearAllDownloads}
              disabled={clearingAll}
              style={[styles.clearAllButton, clearingAll && styles.clearAllButtonDisabled]}
            >
              <Text style={styles.clearAllButtonLabel}>
                {clearingAll ? 'Clearing…' : 'Clear All Downloads'}
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={() => navigation.navigate('MockLibrary')}
              style={styles.row}
            >
              <Text style={styles.rowLabel}>Sync Mock (Downloaded / Bookmarked)</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>

      {/* Persistent Bottom Mini Player */}
      <MiniAudioPlayer
        onExpand={(item) =>
          navigation.navigate('AudioPlayer', { bookId: item.bookId, title: item.title })
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screenContainer: { flex: 1, backgroundColor: color.white },
  container: { flex: 1 },
  content: { padding: space.md, gap: space.lg },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: color.surface,
    borderBottomWidth: 1,
    borderBottomColor: color.border,
    paddingHorizontal: 12,
    paddingVertical: space.sm,
    gap: space.sm,
  },
  tabButton: {
    paddingHorizontal: 12,
    paddingVertical: space.sm,
    borderRadius: 20,
    backgroundColor: 'transparent',
  },
  // `color.primary` — the brand's own "active tabs" colour.
  tabButtonActive: {
    backgroundColor: color.primary,
  },
  tabButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: color.textSecondary,
  },
  tabButtonTextActive: {
    color: color.white,
  },
  section: {
    gap: 10,
  },
  sectionHeader: {
    marginBottom: 4,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: color.textPrimary,
  },
  sectionSubtitle: {
    fontSize: 12,
    color: color.textSecondary,
    marginTop: 2,
  },
  row: {
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.tile,
    padding: 14,
    backgroundColor: color.white,
  },
  audioRow: {
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  activeAudioRow: {
    borderColor: color.primary,
    borderWidth: 2,
    backgroundColor: color.subscriptionTint,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  labelWithIcon: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  audioIcon: {
    fontSize: 18,
  },
  rowLabel: { fontSize: 16, fontWeight: '700', color: color.textPrimary },
  activeRowLabel: { fontWeight: '700' },
  // The brand palette has no light tint for `color.success` (Mint) the way it does for
  // subscription/error, so this keeps a neutral background rather than inventing an untracked
  // green hex (CONVENTIONS §5) — the border/text still carry the "downloaded" signal.
  statusBadge: {
    backgroundColor: color.surface,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.tile,
    borderWidth: 1,
    borderColor: color.success,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: color.success,
  },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
  },
  audioMainActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  primaryButton: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: color.primary,
  },
  pauseButton: {
    backgroundColor: color.textSecondary,
  },
  primaryButtonLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: color.white,
  },
  openPlayerButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.white,
  },
  openPlayerButtonLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: color.textPrimary,
  },
  // `color.primary` — the brand's own "primary buttons" colour, same call every other CTA fill in
  // the reader makes.
  downloadButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: color.primary,
  },
  downloadButtonDisabled: { backgroundColor: color.textSecondary },
  downloadButtonLabel: { fontSize: 13, fontWeight: '700', color: color.white },
  audioQueueActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  queueButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.white,
  },
  queueButtonDisabled: {
    backgroundColor: color.surface,
    borderColor: color.border,
  },
  queueButtonLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: color.textPrimary,
  },
  queueButtonLabelDisabled: {
    color: color.textSecondary,
  },
  clearAllButton: {
    borderWidth: 1,
    borderColor: color.error,
    borderRadius: radius.tile,
    padding: 12,
    alignItems: 'center',
    backgroundColor: color.errorTint,
  },
  clearAllButtonDisabled: { opacity: 0.5 },
  clearAllButtonLabel: { fontSize: 15, fontWeight: '700', color: color.error },
});
