// Journal hierarchy drill-down: Journal → Volumes → Issues → Articles.
//
// LOOKS LIKE ITEMDETAILSCREEN. Cover + title at the top (same dimensions,
// same placeholder icon), then a "Table of Contents" section with the
// accordion below. This reuses the established detail-page visual language
// without modifying ItemDetailScreen itself — the 404 from
// GET /publications/{journalWorkId} confirmed journals are not publications
// and cannot go through that screen's own fetch.
//
// THE APP BAR OWNS THE TITLE. RootNavigator sets it from route.params.title.
//
// COVER AND TITLE COME FROM ROUTE PARAMS — no extra network call at mount.
// CatalogueScreen already has coverUrl from the navigation feed's images array
// (parsed by toNavLink); passing it as a param means the cover renders
// immediately, same behaviour as ItemDetailScreen which gets coverUrl from
// the publication it fetched for the previous screen.
//
// LAZY FETCHING PER LEVEL. Mount fetches the journal's own feed (volumes or
// flat articles). Each volume fetches its issues on first expand; each issue
// fetches its articles on first expand.
//
// ARTICLES NAVIGATE TO ITEM DETAIL. Tapping an article goes to ItemDetail —
// the detail screen owns access-tier resolution, download state and the
// Read/Download action bar.
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from '@react-navigation/native-stack';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { ErrorState } from '@components/ErrorState';
import { EmptyState } from '@components/EmptyState';
import { SectionHeader } from '@components/SectionHeader';
import { AccessTierBadge } from '@components/AccessTierBadge';
import { useCurrentSession } from '@access/currentSession';
import { isNotEntitled, resolveAccess } from '@access/resolveAccess';
import { useLibraryStore } from '@store/libraryStore';
import { getCatalogueSource } from '../config/catalogue';
import type { Hold, Loan, NavLink, Publication, Session, WorkFeed } from '../model/types';
import type { CatalogueStackParamList } from '../navigation/types';
import { color, elevation, radius, space, type as typeScale } from '../theme/tokens';

type Nav = NativeStackNavigationProp<CatalogueStackParamList, 'Journal'>;
type Props = NativeStackScreenProps<CatalogueStackParamList, 'Journal'>;

// Same dimensions as ItemDetailScreen — cover sits ON the page the same way.
const COVER_WIDTH = space.xl * 6;
const COVER_HEIGHT = space.xl * 9;

// ── state shapes ──────────────────────────────────────────────────────────────

type IssueRow = {
  link: NavLink;
  expanded: boolean;
  articles: Publication[] | null;
  loading: boolean;
  error: boolean;
};

type VolumeRow = {
  link: NavLink;
  expanded: boolean;
  issues: IssueRow[] | null;
  directArticles: Publication[] | null;
  loading: boolean;
  error: boolean;
};

// ── component ─────────────────────────────────────────────────────────────────

export default function JournalScreen({ route }: Props) {
  const { workId, title, institutionId, coverUrl } = route.params;
  const navigation = useNavigation<Nav>();

  const session = useCurrentSession();
  const loans = useLibraryStore((s) => s.loans);
  const holds = useLibraryStore((s) => s.holds);

  const [coverFailed, setCoverFailed] = useState(false);
  // Start with whatever the route param carried (may be undefined if the nav
  // entry had no images array). Updated when the work feed resolves — the feed's
  // own metadata.images is the authoritative source for the journal cover.
  const [resolvedCoverUrl, setResolvedCoverUrl] = useState<string | undefined>(coverUrl);
  const showPlaceholder = resolvedCoverUrl === undefined || coverFailed;

  const [topLoading, setTopLoading] = useState(true);
  const [topError, setTopError] = useState(false);
  const [flatArticles, setFlatArticles] = useState<Publication[] | null>(null);
  const [volumes, setVolumes] = useState<VolumeRow[]>([]);

  // No synchronous setState here — only inside the async continuations. A
  // setState reachable directly from an effect body triggers a lint error
  // ("cascading renders"); topLoading/topError are already at these values on
  // mount. Retry is the one path that resets them, and it runs from a press
  // handler — see `retry` below.
  const fetchRoot = useCallback(() => {
    getCatalogueSource()
      .getWork(institutionId, workId)
      .then((feed: WorkFeed) => {
        // Update cover from feed metadata if available and not already set.
        if (feed.coverUrl !== undefined) {
          setResolvedCoverUrl(feed.coverUrl);
        }
        if (feed.kind === 'publications') {
          setFlatArticles(feed.articles);
        } else {
          setVolumes(
            feed.children.map((link) => ({
              link,
              expanded: false,
              issues: null,
              directArticles: null,
              loading: false,
              error: false,
            })),
          );
        }
      })
      .catch(() => setTopError(true))
      .finally(() => setTopLoading(false));
  }, [institutionId, workId]);

  const retry = useCallback(() => {
    setTopLoading(true);
    setTopError(false);
    fetchRoot();
  }, [fetchRoot]);

  useEffect(() => {
    fetchRoot();
  }, [fetchRoot]);

  const toggleVolume = useCallback(
    (vIdx: number) => {
      setVolumes((prev) => {
        const v = prev[vIdx];
        if (v === undefined) return prev;

        const toggled = prev.map((row, i) =>
          i !== vIdx ? row : { ...row, expanded: !row.expanded },
        );

        if (!v.expanded && v.issues === null && !v.loading) {
          const volumeWorkId = v.link.workId;
          if (volumeWorkId !== undefined) {
            const loading = toggled.map((row, i) =>
              i !== vIdx ? row : { ...row, loading: true },
            );
            getCatalogueSource()
              .getWork(institutionId, volumeWorkId)
              .then((feed: WorkFeed) => {
                setVolumes((cur) =>
                  cur.map((row, i) => {
                    if (i !== vIdx) return row;
                    if (feed.kind === 'publications') {
                      return { ...row, loading: false, issues: [], directArticles: feed.articles };
                    }
                    return {
                      ...row,
                      loading: false,
                      issues: feed.children.map((link) => ({
                        link,
                        expanded: false,
                        articles: null,
                        loading: false,
                        error: false,
                      })),
                      directArticles: null,
                    };
                  }),
                );
              })
              .catch(() => {
                setVolumes((cur) =>
                  cur.map((row, i) =>
                    i !== vIdx ? row : { ...row, loading: false, error: true },
                  ),
                );
              });
            return loading;
          }
        }
        return toggled;
      });
    },
    [institutionId],
  );

  const toggleIssue = useCallback(
    (vIdx: number, iIdx: number) => {
      setVolumes((prev) => {
        const v = prev[vIdx];
        if (v === undefined || v.issues === null) return prev;
        const iss = v.issues[iIdx];
        if (iss === undefined) return prev;

        const toggledIssues = v.issues.map((row, i) =>
          i !== iIdx ? row : { ...row, expanded: !row.expanded },
        );
        const toggled = prev.map((row, i) =>
          i !== vIdx ? row : { ...row, issues: toggledIssues },
        );

        if (!iss.expanded && iss.articles === null && !iss.loading) {
          const issueWorkId = iss.link.workId;
          if (issueWorkId !== undefined) {
            const loadingIssues = toggledIssues.map((row, i) =>
              i !== iIdx ? row : { ...row, loading: true },
            );
            const loading = prev.map((row, i) =>
              i !== vIdx ? row : { ...row, issues: loadingIssues },
            );
            getCatalogueSource()
              .getWork(institutionId, issueWorkId)
              .then((feed: WorkFeed) => {
                setVolumes((cur) =>
                  cur.map((vRow, vi) => {
                    if (vi !== vIdx || vRow.issues === null) return vRow;
                    return {
                      ...vRow,
                      issues: vRow.issues.map((iRow, ii) => {
                        if (ii !== iIdx) return iRow;
                        return {
                          ...iRow,
                          loading: false,
                          articles: feed.kind === 'publications' ? feed.articles : [],
                        };
                      }),
                    };
                  }),
                );
              })
              .catch(() => {
                setVolumes((cur) =>
                  cur.map((vRow, vi) => {
                    if (vi !== vIdx || vRow.issues === null) return vRow;
                    return {
                      ...vRow,
                      issues: vRow.issues.map((iRow, ii) =>
                        ii !== iIdx ? iRow : { ...iRow, loading: false, error: true },
                      ),
                    };
                  }),
                );
              });
            return loading;
          }
        }
        return toggled;
      });
    },
    [institutionId],
  );

  const goToDetail = useCallback(
    (id: string) => navigation.navigate('ItemDetail', { itemId: id }),
    [navigation],
  );

  // ── cover header — same shape as ItemDetailScreen ─────────────────────────

  const coverHeader = (
    <View style={styles.coverWrap}>
      {showPlaceholder ? (
        <View style={[styles.cover, styles.coverPlaceholder]}>
          <MaterialCommunityIcons
            name="book-open-page-variant-outline"
            size={COVER_WIDTH / 2}
            color={color.textSecondary}
          />
        </View>
      ) : (
        <Image
          source={{ uri: resolvedCoverUrl, cacheKey: resolvedCoverUrl?.split('?')[0] }}
          style={styles.cover}
          contentFit="contain"
          cachePolicy="memory-disk"
          transition={200}
          accessibilityLabel={`${title} cover`}
          onError={() => setCoverFailed(true)}
        />
      )}
    </View>
  );

  // ── render ────────────────────────────────────────────────────────────────

  if (topError) {
    return (
      <View style={styles.screen}>
        {coverHeader}
        <View style={styles.center}>
          <ErrorState
            variant="not_ready"
            message="Couldn't load this journal."
            onRetry={retry}
          />
        </View>
      </View>
    );
  }

  const tocContent = topLoading ? (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={color.textSecondary} />
    </View>
  ) : flatArticles !== null ? (
    flatArticles.length === 0 ? (
      <View style={styles.center}>
        <EmptyState variant="no_content" />
      </View>
    ) : (
      <ArticleList
        articles={flatArticles}
        onPress={goToDetail}
        institutionId={institutionId}
        session={session}
        loans={loans}
        holds={holds}
      />
    )
  ) : volumes.length === 0 ? (
    <View style={styles.center}>
      <EmptyState variant="no_content" />
    </View>
  ) : (
    <>
      {volumes.map((volume, vIdx) => (
        <VolumeSection
          key={volume.link.workId ?? volume.link.href}
          volume={volume}
          onToggle={() => toggleVolume(vIdx)}
          onToggleIssue={(iIdx) => toggleIssue(vIdx, iIdx)}
          onPressArticle={goToDetail}
          institutionId={institutionId}
          session={session}
          loans={loans}
          holds={holds}
        />
      ))}
    </>
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {coverHeader}
      <Text style={styles.journalTitle}>{title}</Text>
      <SectionHeader title="Table of Contents" emphasis="editorial" />
      {tocContent}
    </ScrollView>
  );
}

// ── sub-components ────────────────────────────────────────────────────────────

function VolumeSection({
  volume,
  onToggle,
  onToggleIssue,
  onPressArticle,
  institutionId,
  session,
  loans,
  holds,
}: {
  volume: VolumeRow;
  onToggle: () => void;
  onToggleIssue: (iIdx: number) => void;
  onPressArticle: (id: string) => void;
  institutionId: string;
  session: Session | null;
  loans: Loan[];
  holds: Hold[];
}) {
  return (
    <View style={styles.volumeContainer}>
      <Pressable
        style={styles.accordionRow}
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: volume.expanded }}
        accessibilityLabel={volume.link.title}
      >
        <Ionicons
          name={volume.expanded ? 'chevron-down' : 'chevron-forward'}
          size={16}
          color={color.textSecondary}
        />
        <Text style={styles.accordionLabel} numberOfLines={2}>
          {volume.link.title}
        </Text>
        {volume.loading && (
          <ActivityIndicator size="small" color={color.textSecondary} />
        )}
      </Pressable>

      {volume.expanded && !volume.loading && (
        <View style={styles.accordionBody}>
          {volume.error && (
            <Text style={styles.inlineError}>{"Couldn't load issues."}</Text>
          )}
          {volume.directArticles !== null && volume.directArticles.length > 0 && (
            <ArticleList
              articles={volume.directArticles}
              onPress={onPressArticle}
              indent
              institutionId={institutionId}
              session={session}
              loans={loans}
              holds={holds}
            />
          )}
          {volume.issues !== null &&
            volume.issues.map((issue, iIdx) => (
              <IssueSection
                key={issue.link.workId ?? issue.link.href}
                issue={issue}
                onToggle={() => onToggleIssue(iIdx)}
                onPressArticle={onPressArticle}
                institutionId={institutionId}
                session={session}
                loans={loans}
                holds={holds}
              />
            ))}
          {volume.issues !== null &&
            volume.issues.length === 0 &&
            volume.directArticles === null && (
              <Text style={styles.emptyHint}>No issues found.</Text>
            )}
        </View>
      )}
    </View>
  );
}

function IssueSection({
  issue,
  onToggle,
  onPressArticle,
  institutionId,
  session,
  loans,
  holds,
}: {
  issue: IssueRow;
  onToggle: () => void;
  onPressArticle: (id: string) => void;
  institutionId: string;
  session: Session | null;
  loans: Loan[];
  holds: Hold[];
}) {
  return (
    <View>
      <Pressable
        style={[styles.accordionRow, styles.issueRow]}
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: issue.expanded }}
        accessibilityLabel={issue.link.title}
      >
        <Ionicons
          name={issue.expanded ? 'chevron-down' : 'chevron-forward'}
          size={14}
          color={color.textSecondary}
        />
        <Text style={styles.issueLabel} numberOfLines={2}>
          {issue.link.title}
        </Text>
        {issue.loading && (
          <ActivityIndicator size="small" color={color.textSecondary} />
        )}
      </Pressable>

      {issue.expanded && !issue.loading && (
        <View style={styles.accordionBody}>
          {issue.error && (
            <Text style={styles.inlineError}>{"Couldn't load articles."}</Text>
          )}
          {issue.articles !== null && issue.articles.length === 0 && (
            <Text style={styles.emptyHint}>No articles found.</Text>
          )}
          {issue.articles !== null && issue.articles.length > 0 && (
            <ArticleList
              articles={issue.articles}
              onPress={onPressArticle}
              indent
              institutionId={institutionId}
              session={session}
              loans={loans}
              holds={holds}
            />
          )}
        </View>
      )}
    </View>
  );
}

function ArticleList({
  articles,
  onPress,
  indent = false,
  institutionId,
  session,
  loans,
  holds,
}: {
  articles: Publication[];
  onPress: (id: string) => void;
  indent?: boolean;
  institutionId: string;
  session: Session | null;
  loans: Loan[];
  holds: Hold[];
}) {
  return (
    <View style={[styles.articleList, indent && styles.articleListIndent]}>
      {articles.map((article) => {
        const loan = loans.find((l) => l.itemId === article.id);
        const hold = holds.find((h) => h.itemId === article.id);
        const access = resolveAccess({ item: article, institutionId, session, loan, hold });
        const badge = isNotEntitled(access) ? undefined : (
          <AccessTierBadge tier={access.tier} size="sm" />
        );
        return (
          <Pressable
            key={article.id}
            style={styles.articleRow}
            onPress={() => onPress(article.id)}
            accessibilityRole="button"
            accessibilityLabel={article.title}
          >
            <View style={styles.articleBody}>
              <Text style={styles.articleTitle} numberOfLines={3}>
                {article.title}
              </Text>
              {article.authors.length > 0 && (
                <Text style={styles.articleMeta} numberOfLines={1}>
                  {article.authors.join(', ')}
                </Text>
              )}
              <View style={styles.articleFooter}>
                {badge !== undefined && (
                  <View style={styles.articleBadge}>{badge}</View>
                )}
                <View style={styles.readButton} accessibilityElementsHidden>
                  <Text style={styles.readButtonText}>Read</Text>
                </View>
              </View>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

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
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.lg,
  },
  // ── cover — mirrors ItemDetailScreen exactly ─────────────────────────────
  coverWrap: {
    alignItems: 'center',
    marginBottom: space.lg,
  },
  cover: {
    width: COVER_WIDTH,
    height: COVER_HEIGHT,
    borderRadius: radius.card,
    backgroundColor: color.border,
    ...elevation.card.ios,
    ...elevation.card.android,
  },
  coverPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Matches ItemDetailScreen's title exactly: Aleo, pageTitle size, tight tracking.
  journalTitle: {
    fontFamily: typeScale.cardTitle.fontFamily,
    fontSize: typeScale.pageTitle.size,
    lineHeight: typeScale.pageTitle.lineHeight,
    letterSpacing: -0.3,
    color: color.textPrimary,
    textAlign: 'center',
    marginBottom: space.xs,
  },
  // ── accordion ─────────────────────────────────────────────────────────────
  volumeContainer: {
    borderRadius: radius.card,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.white,
  },
  accordionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    backgroundColor: color.surface,
  },
  issueRow: {
    backgroundColor: color.white,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    paddingLeft: space.lg + space.sm,
  },
  accordionLabel: {
    flex: 1,
    fontFamily: typeScale.body.fontFamily,
    fontSize: typeScale.body.size,
    lineHeight: typeScale.body.lineHeight,
    fontWeight: '700',
    color: color.textPrimary,
  },
  issueLabel: {
    flex: 1,
    ...typeScale.body,
    color: color.textPrimary,
  },
  accordionBody: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
  },
  // ── articles ──────────────────────────────────────────────────────────────
  articleList: {
    gap: 0,
  },
  articleListIndent: {
    paddingLeft: space.md,
  },
  articleRow: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  articleBody: {
    gap: space.xs,
  },
  articleFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.xs,
  },
  articleBadge: {
    flex: 1,
  },
  articleTitle: {
    fontFamily: typeScale.body.fontFamily,
    fontSize: typeScale.body.size,
    lineHeight: typeScale.body.lineHeight,
    color: color.textPrimary,
  },
  articleMeta: {
    ...typeScale.meta,
    color: color.textSecondary,
  },
  readButton: {
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.card,
    backgroundColor: color.primary,
  },
  readButtonText: {
    ...typeScale.smallLabel,
    color: color.white,
    fontWeight: '700',
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
    paddingLeft: space.lg,
  },
});
