// Volumes & Issues (screen 03) — the middle of the journal drill-down:
// Journal Details → Volumes & Issues → Issue Articles → Article Details.
//
// `volumes` ARRIVES AS A ROUTE PARAM, ALREADY FETCHED. JournalScreen's root
// fetch already has this exact list (the journal's own `children`), so this
// screen makes no duplicate call for it — only each volume's own issues are
// fetched, lazily, on first expand, same lazy-per-level shape the old single-
// screen accordion used.
//
// THE NEWEST VOLUME OPENS EXPANDED. `volumes[0]` is assumed newest-first —
// the same ordering convention CatalogueScreen already relies on for shelves
// — so a reader lands on this screen already looking at current content
// instead of a wall of collapsed rows they have to open themselves. Every
// other volume stays collapsed: an archive going back years should not
// unfold itself in full on first paint.
//
// NO FABRICATED ISSUE OR ARTICLE COUNTS. A volume's own `getWork()` answers
// with a list of issue TITLES only (`NavLink[]`) — there is no per-issue
// article count or date at this level, and getting one for every issue in an
// expanded volume would mean fetching each of them just to populate a
// preview, which is exactly the eager-fetch this app avoids (see this
// screen's own per-volume fetch below, and JournalIssueScreen's header for
// where the real count is shown, once known). Issue rows here are titles,
// nothing invented beside them.
//
// A VOLUME WITH NO ISSUE LEVEL SKIPS THE ACCORDION ENTIRELY. Some journals
// put articles directly under a volume with no issue in between — that
// volume's own getWork() answers `kind: 'publications'` instead of
// `kind: 'navigation'`. Rather than expanding an inline article list here
// (which would make this screen do two jobs), that volume is pushed straight
// to JournalIssueScreen with its own workId — JournalIssueScreen only ever
// asks "does this workId's feed have articles", so a volume standing in for
// an issue is exactly the same call.
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import Ionicons from '@expo/vector-icons/Ionicons';

import { getCatalogueSource } from '../config/catalogue';
import type { NavLink, WorkFeed } from '../model/types';
import type { CatalogueStackParamList } from '../navigation/types';
import { color, radius, space, type as typeScale } from '../theme/tokens';

type Nav = NativeStackNavigationProp<CatalogueStackParamList, 'JournalVolumes'>;
type Props = NativeStackScreenProps<CatalogueStackParamList, 'JournalVolumes'>;

type VolumeRow = {
  link: NavLink;
  expanded: boolean;
  // null = not yet fetched. [] is a real, fetched-and-empty answer.
  issues: NavLink[] | null;
  loading: boolean;
  error: boolean;
};

export default function JournalVolumesScreen({ route }: Props) {
  const { journalTitle, institutionId, volumes: initialVolumes } = route.params;
  const navigation = useNavigation<Nav>();

  // The newest volume opens already expanded (see the file header) — seeded
  // straight into the initial state rather than flipped on by an effect, so
  // there is no synchronous setState to make from inside the mount effect
  // below; that effect only ever starts a promise.
  const [volumes, setVolumes] = useState<VolumeRow[]>(() =>
    initialVolumes.map((link, i) => ({
      link,
      expanded: false,
      issues: null,
      loading: i === 0 && link.workId !== undefined,
      error: false,
    })),
  );

  const goToIssue = useCallback(
    (workId: string, issueTitle: string, volumeTitle?: string) =>
      navigation.navigate('JournalIssue', {
        journalTitle,
        institutionId,
        volumeTitle,
        issueTitle,
        workId,
      }),
    [navigation, journalTitle, institutionId],
  );

  // Only ever called once a caller has already marked `vIdx` loading — a
  // fresh tap in `toggleVolume` (an event handler, so a synchronous setState
  // there is fine) or the initial state above (for the auto-expanded volume).
  // This function itself makes no synchronous setState call, only ones inside
  // the promise's own callbacks — the shape the mount effect below needs.
  const startFetch = useCallback(
    (vIdx: number, workId: string, title: string) => {
      getCatalogueSource()
        .getWork(institutionId, workId)
        .then((feed: WorkFeed) => {
          if (feed.kind === 'publications') {
            // No issue level under this volume — treat the volume itself as
            // the issue-articles target instead of expanding in place.
            goToIssue(workId, title);
            setVolumes((cur) => cur.map((row, i) => (i !== vIdx ? row : { ...row, loading: false })));
            return;
          }
          setVolumes((cur) =>
            cur.map((row, i) =>
              i !== vIdx ? row : { ...row, loading: false, expanded: true, issues: feed.children },
            ),
          );
        })
        .catch(() => {
          setVolumes((cur) =>
            cur.map((row, i) => (i !== vIdx ? row : { ...row, loading: false, expanded: true, error: true })),
          );
        });
    },
    [institutionId, goToIssue],
  );

  useEffect(() => {
    const first = initialVolumes[0];
    if (first?.workId !== undefined) startFetch(0, first.workId, first.title);
    // Mount-only: this starts the one auto-expand fetch seeded into initial
    // state above; `toggleVolume` owns every later fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleVolume = useCallback(
    (vIdx: number) => {
      const v = volumes[vIdx];
      if (v === undefined) return;

      // Already fetched — a plain expand/collapse, no network call.
      if (v.issues !== null) {
        setVolumes((prev) => prev.map((row, i) => (i !== vIdx ? row : { ...row, expanded: !row.expanded })));
        return;
      }
      if (v.loading) return;

      const workId = v.link.workId;
      if (workId === undefined) return;

      setVolumes((prev) => prev.map((row, i) => (i !== vIdx ? row : { ...row, loading: true })));
      startFetch(vIdx, workId, v.link.title);
    },
    [volumes, startFetch],
  );

  if (volumes.length === 0) {
    return (
      <View style={styles.screen}>
        <Text style={styles.emptyHint}>No volumes found.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.journalTitle}>{journalTitle}</Text>
      <Text style={styles.subtitle}>Browse the complete journal archive.</Text>

      {volumes.map((volume, vIdx) => (
        <View key={volume.link.workId ?? volume.link.href} style={styles.volumeContainer}>
          <Pressable
            style={styles.volumeRow}
            onPress={() => toggleVolume(vIdx)}
            accessibilityRole="button"
            accessibilityState={{ expanded: volume.expanded }}
            accessibilityLabel={volume.link.title}
          >
            <Text style={styles.volumeLabel} numberOfLines={2}>
              {volume.link.title}
            </Text>
            {volume.loading ? (
              <ActivityIndicator size="small" color={color.textSecondary} />
            ) : (
              <Ionicons
                name={volume.expanded ? 'chevron-down' : 'chevron-forward'}
                size={18}
                color={color.textSecondary}
              />
            )}
          </Pressable>

          {volume.expanded && !volume.loading && (
            <View style={styles.issuesBlock}>
              {volume.error && <Text style={styles.inlineError}>Couldn&apos;t load issues.</Text>}
              {volume.issues !== null && volume.issues.length === 0 && (
                <Text style={styles.emptyHint}>No issues found.</Text>
              )}
              {volume.issues?.map((issue) => (
                <Pressable
                  key={issue.workId ?? issue.href}
                  style={styles.issueRow}
                  onPress={() => {
                    if (issue.workId !== undefined) goToIssue(issue.workId, issue.title, volume.link.title);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={issue.title}
                >
                  <Text style={styles.issueLabel} numberOfLines={2}>
                    {issue.title}
                  </Text>
                  <Ionicons name="chevron-forward" size={16} color={color.textSecondary} />
                </Pressable>
              ))}
            </View>
          )}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: color.white,
  },
  content: {
    padding: space.lg,
    paddingBottom: space.xl,
    gap: space.sm,
  },
  journalTitle: {
    fontFamily: typeScale.cardTitle.fontFamily,
    fontSize: typeScale.pageTitle.size,
    lineHeight: typeScale.pageTitle.lineHeight,
    letterSpacing: -0.3,
    color: color.textPrimary,
  },
  subtitle: {
    ...typeScale.body,
    color: color.textSecondary,
    marginBottom: space.sm,
  },
  // Distinct from an issue row: filled surface tint, bold, slightly larger —
  // a volume is the archive's own organizing unit, not a peer of the issues
  // nested under it.
  volumeContainer: {
    borderRadius: radius.card,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.white,
  },
  volumeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    backgroundColor: color.surface,
  },
  volumeLabel: {
    flex: 1,
    fontFamily: typeScale.cardTitle.fontFamily,
    fontSize: 16,
    lineHeight: 20,
    color: color.textPrimary,
  },
  issuesBlock: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  issueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 4,
    backgroundColor: color.white,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  issueLabel: {
    flex: 1,
    ...typeScale.body,
    fontWeight: '600',
    color: color.textPrimary,
  },
  inlineError: {
    ...typeScale.meta,
    color: color.textSecondary,
    padding: space.sm,
    textAlign: 'center',
  },
  emptyHint: {
    ...typeScale.meta,
    color: color.textSecondary,
    padding: space.sm,
  },
});
