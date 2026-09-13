// Issue Articles (screen 04's list) — the third step of the journal drill-down:
// Journal Details → Volumes & Issues → Issue Articles → Article Details.
//
// ONE FETCH, ON MOUNT. `workId` names either a real issue, or — see
// JournalVolumesScreen's own header — a volume standing in for one when a
// journal has no issue level. Either way this screen just asks "what
// articles does this work id have", the same lazy per-level fetch the old
// single-screen accordion made on expand.
//
// THE ARTICLE COUNT IS REAL, NOT A PLACEHOLDER. It is `articles.length`,
// known only once this fetch resolves — there is no count on the feed ahead
// of that, so none is shown while loading. No date either: a `WorkFeed`
// carries no per-issue publish date (see model/types.ts) and none is
// invented here.
//
// NO "READ ISSUE" BUTTON. There is no backend concept of reading an issue as
// one document — only its individual articles, each with their own licence —
// so nothing is rendered that would promise a feature this app cannot do.
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import Ionicons from '@expo/vector-icons/Ionicons';

import { ErrorState } from '@components/ErrorState';
import { EmptyState } from '@components/EmptyState';
import { SectionHeader } from '@components/SectionHeader';
import { useCurrentSession } from '@access/currentSession';
import { useLibraryStore } from '@store/libraryStore';
import { getCatalogueSource } from '../config/catalogue';
import type { Publication, WorkFeed } from '../model/types';
import type { CatalogueStackParamList } from '../navigation/types';
import { color, radius, space, type as typeScale } from '../theme/tokens';
import { ArticleList } from './journal/ArticleList';

type Nav = NativeStackNavigationProp<CatalogueStackParamList, 'JournalIssue'>;
type Props = NativeStackScreenProps<CatalogueStackParamList, 'JournalIssue'>;

export default function JournalIssueScreen({ route }: Props) {
  const { journalTitle, institutionId, volumeTitle, issueTitle, workId } = route.params;
  const navigation = useNavigation<Nav>();

  const session = useCurrentSession();
  const loans = useLibraryStore((s) => s.loans);
  const holds = useLibraryStore((s) => s.holds);

  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [articles, setArticles] = useState<Publication[]>([]);

  const fetchArticles = useCallback(() => {
    getCatalogueSource()
      .getWork(institutionId, workId)
      .then((feed: WorkFeed) => setArticles(feed.kind === 'publications' ? feed.articles : []))
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, [institutionId, workId]);

  const retry = useCallback(() => {
    setLoading(true);
    setFailed(false);
    fetchArticles();
  }, [fetchArticles]);

  useEffect(() => {
    fetchArticles();
  }, [fetchArticles]);

  const goToArticle = useCallback(
    (id: string) =>
      navigation.navigate('ItemDetail', {
        itemId: id,
        workType: 'article',
        articleContext: { journalTitle, volumeTitle, issueTitle },
      }),
    [navigation, journalTitle, volumeTitle, issueTitle],
  );

  if (failed) {
    return (
      <View style={styles.center}>
        <ErrorState variant="not_ready" message="Couldn't load these articles." onRetry={retry} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.journalEyebrow}>{journalTitle}</Text>
      <Text style={styles.issueTitle}>{issueTitle}</Text>

      {/* Volume and article count as pills, not stacked plain text — same
          brand "key stat" treatment JournalScreen's own volume count uses,
          so the two screens read as one visual language. `volumeTitle` is
          real, backend-supplied text (whatever the feed calls that volume);
          the article count is real too, just known only once loaded (see
          the file header on why nothing is shown for it before then). */}
      {(volumeTitle !== undefined || !loading) && (
        <View style={styles.statsRow}>
          {volumeTitle !== undefined && (
            <View style={styles.statPill}>
              <Ionicons name="albums-outline" size={typeScale.smallLabel.size} color={color.primary} />
              <Text style={styles.statPillLabel}>{volumeTitle}</Text>
            </View>
          )}
          {!loading && (
            <View style={styles.statPill}>
              <Ionicons name="document-text-outline" size={typeScale.smallLabel.size} color={color.primary} />
              <Text style={styles.statPillLabel}>
                {articles.length} {articles.length === 1 ? 'article' : 'articles'}
              </Text>
            </View>
          )}
        </View>
      )}

      <View style={styles.rule} />
      <SectionHeader title="Articles" emphasis="editorial" />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={color.textSecondary} />
        </View>
      ) : articles.length === 0 ? (
        <View style={styles.center}>
          <EmptyState variant="no_content" />
        </View>
      ) : (
        <ArticleList
          articles={articles}
          onPress={goToArticle}
          institutionId={institutionId}
          session={session}
          loans={loans}
          holds={holds}
        />
      )}
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
    gap: space.xs,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.lg,
  },
  journalEyebrow: {
    ...typeScale.cardMeta,
    color: color.primary,
    fontWeight: '700',
  },
  issueTitle: {
    fontFamily: typeScale.cardTitle.fontFamily,
    fontSize: typeScale.pageTitle.size,
    lineHeight: typeScale.pageTitle.lineHeight,
    letterSpacing: -0.3,
    color: color.textPrimary,
  },
  statsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginTop: space.xs,
  },
  // Same pill shape/typography as JournalScreen's volume-count pill — see
  // that file's own comment on why `keyStat` (Aleo Light) is the token for
  // a real, brand-blessed number, and `surface`/`primary` the pairing for a
  // plain white page.
  statPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    backgroundColor: color.surface,
  },
  statPillLabel: {
    fontFamily: typeScale.keyStat.fontFamily,
    fontSize: typeScale.keyStat.size,
    lineHeight: typeScale.keyStat.lineHeight,
    color: color.primary,
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.border,
    marginTop: space.sm,
    marginBottom: space.xs,
  },
});
