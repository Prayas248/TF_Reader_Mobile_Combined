// Journal Details (screen 02) — the top of the journal drill-down:
// Journal Details → Volumes & Issues → Issue Articles → Article Details.
//
// MATCHES ITEMDETAILSCREEN'S BOOK LAYOUT, ON EXPLICIT INSTRUCTION: the same
// cover size, the same "cover is centred, nothing else is" rule, the same
// title treatment — a journal is a peer of a book on this app's shelves, and
// the two detail pages should read as the same product. (An earlier pass
// shrank the cover and put it beside the title instead, to fight empty
// space; that traded consistency for density, and consistency was what this
// change asked for back — the "Published in"/Volumes & Issues content below
// is what now fills the space a book detail page fills with a description.)
//
// THE APP BAR OWNS THE TITLE. RootNavigator sets it from route.params.title.
//
// COVER AND TITLE COME FROM ROUTE PARAMS — no extra network call at mount.
// CatalogueScreen already has coverUrl from the navigation feed's images array
// (parsed by toNavLink); passing it as a param means the cover renders
// immediately, same behaviour as ItemDetailScreen which gets coverUrl from
// the publication it fetched for the previous screen.
//
// ONE FETCH ONLY. Mount fetches the journal's own root feed. If it is
// `kind: 'publications'` (a journal with no volume level — its articles sit
// at the root), the article list renders directly on THIS screen. If it is
// `kind: 'navigation'` (has volumes), this screen shows a "Browse this
// journal" card and pushes the volumes list — already in hand from this one
// fetch — to JournalVolumesScreen, which makes no duplicate root fetch.
//
// EVERY OPTIONAL SECTION IS OMITTED, NOT SHOWN EMPTY. wokay's work-feed
// contract does not promise description/subjects/publisher (see WorkFeed's
// own comment in model/types.ts). Unlike ItemDetailScreen's book "About this
// title" (a structural section that always renders, with an honest "not
// available yet" fallback — that section owns a specific field the mockup
// always draws a box for), a journal with no description simply has no About
// section at all: there is no equivalent always-drawn box in the reference
// design, so a fallback line here would be manufactured copy with nothing to
// anchor it. Same reasoning for Subjects/publisher.
//
// NO JOURNAL-LEVEL ACCESS BADGE. `AccessTierBadge` renders an `AccessTier`
// resolved from a Publication's `acquisition.licenceModel` — a `WorkFeed` has
// no acquisition of its own (access is decided per ARTICLE, at whatever tier
// each one's own acquisition link carries), so there is no tier to badge here
// without inventing one.
//
// NO "LATEST ISSUE" SHORTCUT. Resolving the true latest issue means fetching
// one level past this screen's own root fetch (the latest volume's own
// issues) — an eager fetch this app deliberately avoids for a preview (see
// JournalVolumesScreen's own header). A button that only ever opens the
// generic volume list would be a "Latest issue" label on ordinary navigation,
// which is worse than not offering the shortcut at all.
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
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
import { Skeleton } from '@components/Skeleton';
import { SectionHeader } from '@components/SectionHeader';
import { DescriptionSection } from '@components/DescriptionSection';
import { useCurrentSession } from '@access/currentSession';
import { useLibraryStore } from '@store/libraryStore';
import { getCatalogueSource } from '../config/catalogue';
import type { WorkFeed } from '../model/types';
import type { CatalogueStackParamList } from '../navigation/types';
import { color, elevation, radius, space, type as typeScale } from '../theme/tokens';
import { ArticleList } from './journal/ArticleList';

type Nav = NativeStackNavigationProp<CatalogueStackParamList, 'Journal'>;
type Props = NativeStackScreenProps<CatalogueStackParamList, 'Journal'>;

// Same dimensions as ItemDetailScreen's book jacket — see the file header.
const COVER_WIDTH = space.xl * 6;
const COVER_HEIGHT = space.xl * 9;

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

  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [feed, setFeed] = useState<WorkFeed | null>(null);

  // No synchronous setState here — only inside the async continuations. A
  // setState reachable directly from an effect body triggers a lint error
  // ("cascading renders"); loading/failed are already at these values on
  // mount. Retry is the one path that resets them, and it runs from a press
  // handler — see `retry` below.
  const fetchRoot = useCallback(() => {
    getCatalogueSource()
      .getWork(institutionId, workId)
      .then((result: WorkFeed) => {
        if (result.coverUrl !== undefined) setResolvedCoverUrl(result.coverUrl);
        setFeed(result);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, [institutionId, workId]);

  const retry = useCallback(() => {
    setLoading(true);
    setFailed(false);
    fetchRoot();
  }, [fetchRoot]);

  useEffect(() => {
    fetchRoot();
  }, [fetchRoot]);

  const goToArticle = useCallback(
    (id: string) =>
      navigation.navigate('ItemDetail', {
        itemId: id,
        workType: 'article',
        articleContext: { journalTitle: title },
      }),
    [navigation, title],
  );

  const goToVolumes = useCallback(() => {
    if (feed === null || feed.kind !== 'navigation') return;
    navigation.navigate('JournalVolumes', {
      journalTitle: title,
      institutionId,
      volumes: feed.children,
    });
  }, [navigation, feed, title, institutionId]);

  const onShare = useCallback(() => {
    void Share.share({ message: title });
  }, [title]);

  const coverHeader = (
    <View style={styles.coverWrap}>
      {showPlaceholder ? (
        <View style={[styles.cover, styles.coverPlaceholder]}>
          <MaterialCommunityIcons
            name="book-open-page-variant-outline"
            size={COVER_WIDTH * 0.4}
            color={color.primary}
          />
          <Text style={styles.coverPlaceholderLabel}>JOURNAL</Text>
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

  if (failed) {
    return (
      <View style={styles.screen}>
        {coverHeader}
        <View style={styles.center}>
          <ErrorState variant="not_ready" message="Couldn't load this journal." onRetry={retry} />
        </View>
      </View>
    );
  }

  if (loading || feed === null) {
    return (
      <View style={styles.screen}>
        <View style={styles.loading}>
          <Skeleton variant="block" width={COVER_WIDTH} height={COVER_HEIGHT} />
          <Skeleton variant="text" width={COVER_WIDTH * 2} height={typeScale.pageTitle.lineHeight} />
          <Skeleton variant="text" width={COVER_WIDTH} height={typeScale.body.lineHeight} />
        </View>
      </View>
    );
  }

  const hasSubjects = feed.kind === 'navigation' && feed.subjects !== undefined && feed.subjects.length > 0;
  const hasAbout = feed.kind === 'navigation' && feed.description !== undefined;
  const hasMetaSection = (feed.kind === 'navigation' && feed.publisher !== undefined) || hasSubjects || hasAbout;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {coverHeader}

      {/* Title/type on the left, Share as a small icon button on the right —
          under the cover, beside the name, not paired with Volumes & Issues
          at the bottom any more. */}
      <View style={styles.titleRow}>
        <View style={styles.titleColumn}>
          <Text style={styles.journalTitle}>{title}</Text>
          <Text style={styles.journalType}>Journal</Text>
        </View>
        <Pressable
          style={styles.shareIconButton}
          onPress={onShare}
          accessibilityRole="button"
          accessibilityLabel="Share"
        >
          <Ionicons name="share-outline" size={18} color={color.primary} />
        </Pressable>
      </View>

      {feed.kind === 'navigation' && feed.publisher !== undefined && (
        <Text style={styles.publisherLine} numberOfLines={2}>
          Published by <Text style={styles.publisherName}>{feed.publisher}</Text>
        </Text>
      )}

      {hasMetaSection && <View style={styles.rule} />}

      {hasSubjects && feed.kind === 'navigation' && feed.subjects !== undefined && (
        <View style={styles.subjectsRow}>
          {feed.subjects.map((subject) => (
            <View key={subject} style={styles.subjectChip}>
              <Text style={styles.subjectChipLabel} numberOfLines={1}>
                {subject}
              </Text>
            </View>
          ))}
        </View>
      )}

      {hasAbout && feed.kind === 'navigation' && (
        <DescriptionSection title="About this journal" description={feed.description} />
      )}

      {feed.kind === 'publications' ? (
        <>
          <View style={styles.rule} />
          <SectionHeader title="Articles" emphasis="editorial" />
          {feed.articles.length === 0 ? (
            <View style={styles.center}>
              <EmptyState variant="no_content" />
            </View>
          ) : (
            <ArticleList
              articles={feed.articles}
              onPress={goToArticle}
              institutionId={institutionId}
              session={session}
              loans={loans}
              holds={holds}
            />
          )}
        </>
      ) : (
        <>
          <View style={styles.rule} />

          {/* The one count this screen actually knows without an extra
              fetch — feed.children is the journal's own root feed, already
              in hand. Issues/articles totals are deliberately NOT shown here:
              those live inside volumes this screen has not fetched, and
              eager-fetching every one of them just to total a preview line
              is exactly what this app avoids elsewhere in the journal flow
              (see JournalVolumesScreen's own header). */}
          <View style={styles.statPill}>
            <Ionicons name="albums-outline" size={typeScale.smallLabel.size} color={color.primary} />
            <Text style={styles.statPillLabel}>
              {feed.children.length} {feed.children.length === 1 ? 'volume' : 'volumes'}
            </Text>
          </View>

          {/* A real button, not a list row — this is the one action this
              page exists to lead to, the same weight a book's own ActionBar
              gives Read. Full width: Share moved up beside the title, so
              this no longer shares the row with a second action. */}
          <Pressable
            style={[styles.actionButton, styles.actionButtonFilled]}
            onPress={goToVolumes}
            accessibilityRole="button"
            accessibilityLabel="Volumes and issues, browse the complete journal archive"
          >
            <Ionicons name="albums-outline" size={18} color={color.white} />
            <Text style={styles.actionButtonFilledLabel}>Volumes & Issues</Text>
          </Pressable>
        </>
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
    gap: space.md,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.lg,
  },
  loading: {
    alignItems: 'center',
    padding: space.lg,
    gap: space.md,
  },
  // THE COVER IS CENTRED; NOTHING ELSE IS — same rule, same wording, as
  // ItemDetailScreen's own `coverWrap` comment. Everything below it (title,
  // type, publisher, subjects, About, the action row) is left-ranged off the
  // page's own margin, matching the book layout exactly.
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
  // A journal-specific placeholder, not a generic broken-image icon: a tinted
  // surface, an outline and the word JOURNAL underneath the glyph, so an
  // absent cover still reads as "this is a journal" rather than "this image
  // failed to load".
  coverPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  coverPlaceholderLabel: {
    fontFamily: typeScale.smallLabel.fontFamily,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 1,
    fontWeight: '700',
    color: color.primary,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
  },
  titleColumn: {
    flex: 1,
    gap: space.xs,
  },
  journalTitle: {
    fontFamily: typeScale.cardTitle.fontFamily,
    fontSize: typeScale.pageTitle.size,
    lineHeight: typeScale.pageTitle.lineHeight,
    letterSpacing: -0.3,
    color: color.textPrimary,
  },
  journalType: {
    ...typeScale.meta,
    color: color.textSecondary,
  },
  // A small, secondary icon button — Share is not this page's main action,
  // so it takes none of the visual weight the Volumes & Issues button below
  // gets.
  shareIconButton: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: color.border,
  },
  // A pill, not plain text — same "real stat, brand-blessed Aleo Light
  // treatment" shape HeroBanner's own `statLabel` uses for "Over 140,000
  // peer-reviewed titles" (tokens.ts's `keyStat` is the guide's own named
  // example for exactly this). `surface`/`primary` here rather than
  // HeroBanner's `subscriptionTint`/`navy` — this pill sits on a plain white
  // page, not a navy gradient, so it takes this file's own tint pairing
  // instead of copying colours chosen for a different background.
  statPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
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
  publisherLine: {
    ...typeScale.cardMeta,
    color: color.textSecondary,
    marginTop: space.xs,
  },
  publisherName: {
    color: color.textPrimary,
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.border,
  },
  subjectsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  subjectChip: {
    alignSelf: 'flex-start',
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: color.primary,
  },
  subjectChipLabel: {
    fontFamily: typeScale.smallLabel.fontFamily,
    fontSize: typeScale.smallLabel.size,
    lineHeight: typeScale.smallLabel.lineHeight,
    color: color.primary,
  },
  // Full width (the `content` container's default `alignItems: 'stretch'`
  // does this without an explicit width) — the one action this page exists
  // to lead to, so it gets the same prominence a book's Read button gets.
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    paddingVertical: space.sm + 2,
    borderRadius: radius.card,
  },
  actionButtonFilled: {
    backgroundColor: color.primary,
  },
  actionButtonFilledLabel: {
    ...typeScale.button,
    color: color.white,
    fontWeight: '700',
  },
});
