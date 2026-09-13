// A1 (Prayas) — the catalogue a reader sees before choosing an institution.
//
// A FLAT LIST, NOT A HOME SCREEN. Curated shelves are configured per institution
// and this reader has none, so there is no category strip — one list of open
// access titles, named by a single fixed SectionHeader, with the sheet's
// Filter & Sort action pinned to that heading's own trailing slot (the same
// slot ShelfScreen's shelf-title heading uses in task 3) rather than a second,
// separate button elsewhere on the screen.
//
// FILTER & SORT ARE CLIENT-SIDE ONLY HERE. `getPublicFeed` takes no query
// params (unlike `getShelf`'s `ShelfQuery`) — see `applyBrowseFilters`'s own
// header for what that means for "Load more".
//
// The feed is fetched with no institution id and no token (getPublicFeed), so
// nothing on this screen may reach for `institutionStore`.
//
// Paging is "Load more" rather than infinite scroll, and a failed later page
// leaves the loaded rows alone — both the same rules ShelfScreen already follows,
// for the same reasons.
//
// Rows are badged with `institutionId: null`, which resolveAccess treats as a
// real value — the public path — not as a missing one. Reading the store for an
// id here would break the rule above.
//
// ─── D12 — item detail only, not wired here ──────────────────────────────────
//
// D12's Elite queue button ("Grant access") is scoped to the item detail screen
// only. CatalogueScreen, ShelfScreen and SearchScreen carry the same note and
// none of them render it either — this is not a special case for this screen.
//
// TWO INDEPENDENT REASONS, either one sufficient. First, the team decision of
// 26 Aug: D12 is ItemDetailScreen only, so NO card surface carries it and this
// screen needs no special case. Second, and why it was never in question here
// even before that: a reader with no institution cannot join an institution's
// queue. `resolveAccess` §4 answers `requires_signin` for any licensed tier once
// the session is null, and this screen's session IS null — necessarily, because
// it has no institution to derive one from (see the rule above: it may not read
// `institutionStore`).
//
// IT IS ALSO A LIST OF OPEN ACCESS TITLES, whose resolve is `available` with
// Read — Elite rows are not what this feed carries in the first place.
//
// WHAT WOULD CHANGE THIS: the team revisiting the item-detail-only decision. The
// second reason would still stand on its own until this screen gains an
// institution, or flambeau grows a way to queue anonymously.
import { useCallback, useEffect, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import EmptyState from '@/components/EmptyState';
import OfflineBanner from '@/components/OfflineBanner';
import { isNotEntitled, resolveAccess } from '@access/resolveAccess';
import { AccessTierBadge } from '@components/AccessTierBadge';
import { ContentCard, COVER_TILE_WIDTH } from '../components/ContentCard';
import { ErrorState } from '@components/ErrorState';
import { FilterSortButton } from '@components/FilterSortButton';
import { FilterSortSheet } from '@components/FilterSortSheet';
import { SectionHeader } from '@components/SectionHeader';
import { getCatalogueSource } from '../config/catalogue';
import { type CatalogueError, isCatalogueFailure } from '@model/errors';
import { CATALOGUE_ERROR_COPY, catalogueErrorVariant } from '@model/errorCopy';
import type { Publication, SortOrder } from '../model/types';
import type { CatalogueStackParamList } from '../navigation/types';
import type { BrowseFilters } from '@search/browseLink';
import { PUBLIC_FEED, useFeedScrollMemory } from '@hooks/useFeedScrollMemory';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { color, space, type as typeScale } from '../theme/tokens';

type Nav = NativeStackNavigationProp<CatalogueStackParamList, 'CatalogueHome'>;

// State of a SUBSEQUENT page request only. A union rather than two booleans so
// "loading and failed at once" cannot be represented.
type MoreStatus = 'idle' | 'loading' | 'failed';

// How many skeleton cards to show before the first page arrives. Arbitrary —
// there is no data yet to size it from.
const SKELETON_COUNT = 3;

function moreLabelFor(status: MoreStatus): string {
  if (status === 'loading') return 'Loading…';
  if (status === 'failed') return "Couldn't load more — tap to retry";
  return 'Load more';
}

// Two-up grid rows for the cover tiles below. A trailing single item renders
// alone rather than being padded with an invisible placeholder — each tile
// carries its own explicit width regardless of how many share its row.
function chunkPairs<T>(items: T[]): T[][] {
  const pairs: T[][] = [];
  for (let i = 0; i < items.length; i += 2) {
    pairs.push(items.slice(i, i + 2));
  }
  return pairs;
}

// Client-side only — `getPublicFeed` takes no filter/sort query params
// (unlike `getShelf`'s `ShelfQuery`), so there is no server request to carry
// these. This filters/sorts whatever pages are ALREADY loaded, the same
// fields and comparators `MockAdapter`'s own `matchesShelfQuery`/
// `sortByShelfQuery` use server-side for the 'all' shelf. A real limitation,
// not hidden: "Load more" still fetches the next unfiltered page underneath,
// so narrowing the filter can reveal fewer rows than the feed actually has
// until more pages are pulled in.
function applyBrowseFilters(
  publications: Publication[],
  filters: BrowseFilters,
  sort: SortOrder | undefined,
): Publication[] {
  const filtered = publications.filter((publication) => {
    if (filters.contentType !== undefined && publication.format !== filters.contentType) {
      return false;
    }
    if (
      filters.accessTier !== undefined &&
      publication.acquisition.licenceModel !== filters.accessTier
    ) {
      return false;
    }
    return true;
  });

  if (sort === undefined) return filtered;

  const sorted = [...filtered];
  if (sort === 'title.asc') sorted.sort((a, b) => a.title.localeCompare(b.title));
  if (sort === 'title.desc') sorted.sort((a, b) => b.title.localeCompare(a.title));
  if (sort === 'publishedAt.asc') {
    sorted.sort((a, b) => (a.published ?? '').localeCompare(b.published ?? ''));
  }
  if (sort === 'publishedAt.desc') {
    sorted.sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''));
  }
  return sorted;
}

export default function PublicCatalogueScreen() {
  const navigation = useNavigation<Nav>();

  // Matches `COVER_TILE_WIDTH` — the same width CatalogueScreen's carousel
  // and ShelfScreen's grid use — whenever the screen is wide enough for two
  // of them plus the row's own gap. Below that, this is the fallback that
  // keeps two tiles from overflowing the row on a narrow phone; the cover
  // image's aspect ratio is never touched either way (ContentCard sets no
  // ratio override), so a tile only ever shrinks by getting narrower, not by
  // cropping.
  const { width: windowWidth } = useWindowDimensions();
  const columnWidth = Math.min(
    COVER_TILE_WIDTH,
    (windowWidth - space.md * 2 - space.sm) / 2,
  );

  const [publications, setPublications] = useState<Publication[]>([]);
  // The cursor, taken off the response's own `next` link. `undefined` means
  // there is no next page.
  const [nextPage, setNextPage] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [errorCode, setErrorCode] = useState<CatalogueError | undefined>(undefined);
  const [moreStatus, setMoreStatus] = useState<MoreStatus>('idle');

  // Filter & sort — see `applyBrowseFilters`'s own header for why this is
  // client-side only. APPLIED is what's currently narrowing the list; DRAFT
  // is what the sheet shows while the reader is still choosing, the same
  // draft/applied split ShelfScreen's sheet uses.
  const [appliedFilters, setAppliedFilters] = useState<BrowseFilters>({});
  const [appliedSort, setAppliedSort] = useState<SortOrder | undefined>(undefined);
  const [draftFilters, setDraftFilters] = useState<BrowseFilters>({});
  const [draftSort, setDraftSort] = useState<SortOrder | undefined>(undefined);
  const [sheetVisible, setSheetVisible] = useState(false);

  const isOnline = useNetworkStatus();

  // A7 — signing in swaps this screen for CatalogueScreen, so the reader's place
  // in this list has to be kept outside it. Signing back out returns them here,
  // where they were, rather than at the top.
  const { scrollRef, onScroll, onContentSizeChange } = useFeedScrollMemory(PUBLIC_FEED);

  // No synchronous setState in the effect body — that trips the cascading-renders
  // lint rule, and `loading`/`failed` already hold these values on mount. Retry
  // resets them from a press handler instead.
  const fetchFirstPage = useCallback(() => {
    getCatalogueSource()
      // Page omitted, not passed as 0, so the server applies its own default.
      .getPublicFeed()
      .then((feed) => {
        setPublications(feed.publications);
        setNextPage(feed.nextPage);
      })
      .catch((err: unknown) => {
        setErrorCode(isCatalogueFailure(err) ? err.code : undefined);
        setFailed(true);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchFirstPage();
  }, [fetchFirstPage]);

  const retry = useCallback(() => {
    setLoading(true);
    setFailed(false);
    fetchFirstPage();
  }, [fetchFirstPage]);

  const openSheet = useCallback(() => {
    // The sheet always opens showing what is actually applied, never a stale
    // draft left over from a previous open-then-dismiss.
    setDraftFilters(appliedFilters);
    setDraftSort(appliedSort);
    setSheetVisible(true);
  }, [appliedFilters, appliedSort]);

  const applyFilters = useCallback(() => {
    setSheetVisible(false);
    setAppliedFilters(draftFilters);
    setAppliedSort(draftSort);
  }, [draftFilters, draftSort]);

  const clearAllFilters = useCallback(() => {
    setDraftFilters({});
    setDraftSort(undefined);
    setSheetVisible(false);
    setAppliedFilters({});
    setAppliedSort(undefined);
  }, []);

  const loadMore = useCallback(() => {
    // A guard, not an assertion: the button is hidden with no next page and
    // disabled while a page is in flight, so reaching here in either state means
    // two taps landed in one tick.
    if (nextPage === undefined || moreStatus === 'loading') return;

    setMoreStatus('loading');
    getCatalogueSource()
      .getPublicFeed(nextPage)
      .then((feed) => {
        // Appended, never replaced. Deduped by id because overlapping pages are
        // a real server behaviour and a repeat would mean duplicate React keys.
        setPublications((previous) => {
          const seen = new Set(previous.map((publication) => publication.id));
          return [...previous, ...feed.publications.filter(({ id }) => !seen.has(id))];
        });
        setNextPage(feed.nextPage);
        setMoreStatus('idle');
      })
      // Deliberately does NOT set `failed`: the rows already on screen stay, and
      // the inline label below turns into a retry.
      .catch(() => setMoreStatus('failed'));
  }, [nextPage, moreStatus]);

  if (failed) {
    const variant = errorCode === undefined ? 'not_ready' : catalogueErrorVariant(errorCode);
    const message =
      errorCode === undefined ? "Couldn't load the catalogue." : CATALOGUE_ERROR_COPY[errorCode];

    return (
      <View style={styles.screen}>
        <OfflineBanner visible={!isOnline} />
        <View style={styles.center}>
          <ErrorState variant={variant} message={message} onRetry={retry} />
        </View>
      </View>
    );
  }

  const visiblePublications = applyBrowseFilters(publications, appliedFilters, appliedSort);
  const isEmpty = !loading && visiblePublications.length === 0;
  const hasActiveFilter =
    appliedSort !== undefined ||
    Object.values(appliedFilters).some((value) => value !== undefined);
  const moreLabel = moreLabelFor(moreStatus);

  return (
    <View style={styles.screen}>
      <OfflineBanner visible={!isOnline} />

      <ScrollView
        testID="public-catalogue-feed"
        ref={scrollRef}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onContentSizeChange={onContentSizeChange}
        style={styles.screen}
        contentContainerStyle={styles.content}
      >
        <SectionHeader
          title="Open Access Titles"
          emphasis="editorial"
          action={<FilterSortButton onPress={openSheet} accessibilityLabel="Filter & Sort Open Access Titles" />}
        />

        {loading &&
          chunkPairs(Array.from({ length: SKELETON_COUNT }, (_, index) => index)).map(
            (pair, rowIndex) => (
              <View key={rowIndex} style={styles.gridRow}>
                {pair.map((index) => (
                  <View key={index} style={{ width: columnWidth }}>
                    <ContentCard variant="cover" state="loading" title="" />
                  </View>
                ))}
              </View>
            ),
          )}

        {/* Nothing open access at all — or nothing matches the active
            filter (B10's "your filters matched nothing" vs "this list is
            empty" distinction, same as ShelfScreen). Not an error, so no
            Retry — see the EmptyState test. */}
        {isEmpty && (
          <EmptyState
            variant={hasActiveFilter ? 'no_filter_results' : 'no_content'}
            onClearFilters={clearAllFilters}
          />
        )}

        {chunkPairs(visiblePublications).map((pair, rowIndex) => (
          <View key={rowIndex} style={styles.gridRow}>
            {pair.map((publication) => {
              // Resolved once rather than inline in the badge, so D8 can ask
              // about the state before anything reads the tier.
              const access = resolveAccess({
                item: publication,
                institutionId: null,
                session: null,
              });

              return (
                <View key={publication.id} style={{ width: columnWidth }}>
                  <ContentCard
                    variant="cover"
                    title={publication.title}
                    publisher={publication.publisher}
                    imageUrl={publication.coverUrl}
                    format={publication.format}
                    // D8 — `not_entitled` renders nothing at all, badge
                    // included. The tier is an OPEN_ACCESS filler in that
                    // state, which on THIS screen would be doubly
                    // misleading: a list of open access titles is exactly
                    // where a false "Open Access" chip would go unnoticed.
                    badge={
                      isNotEntitled(access) ? undefined : (
                        <AccessTierBadge tier={access.tier} />
                      )
                    }
                    onPress={() =>
                      navigation.navigate('ItemDetail', { itemId: publication.id })
                    }
                  />
                </View>
              );
            })}
          </View>
        ))}

        {/* Absent, not disabled, on the last page: a permanently dead button
            reads as broken. */}
        {nextPage !== undefined && (
          <Pressable
            onPress={loadMore}
            disabled={moreStatus === 'loading'}
            style={styles.loadMore}
            accessibilityRole="button"
            accessibilityLabel={moreLabel}
            accessibilityState={{ disabled: moreStatus === 'loading' }}
          >
            <Text
              style={[
                styles.loadMoreLabel,
                moreStatus === 'loading' && styles.loadMoreLabelLoading,
                moreStatus === 'failed' && styles.loadMoreLabelFailed,
              ]}
            >
              {moreLabel}
            </Text>
          </Pressable>
        )}
      </ScrollView>

      {/* Sort is not shelf-restricted here — there is no curated-shelf
          "operator's order is the order" rule on this flat feed, so unlike
          ShelfScreen's non-'all' shelves, sort is never greyed. */}
      <FilterSortSheet
        visible={sheetVisible}
        onDismiss={() => setSheetVisible(false)}
        contentType={draftFilters.contentType}
        onSelectContentType={(contentType) =>
          setDraftFilters((previous) => ({ ...previous, contentType }))
        }
        accessTier={draftFilters.accessTier}
        onSelectAccessTier={(accessTier) =>
          setDraftFilters((previous) => ({ ...previous, accessTier }))
        }
        sort={draftSort}
        onSelectSort={setDraftSort}
        onApply={applyFilters}
        onClearAll={clearAllFilters}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: color.white,
  },
  content: {
    padding: space.md,
    gap: space.sm,
  },
  // Two cover tiles per row, each given an explicit `width` inline (the
  // `columnWidth` computed above) rather than `flex: 1` — a flexible fill
  // would size each tile off THIS row's own width, which is exactly what
  // made it differ from CatalogueScreen's carousel tiles. `space-between`
  // keeps the pair pinned to the row's outer edges instead of packing left
  // with a gap of dead space on the right once both are the same fixed
  // width as the carousel's.
  gridRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    backgroundColor: color.white,
  },
  loadMore: {
    alignSelf: 'center',
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
  },
  loadMoreLabel: {
    fontWeight: typeScale.button.weight,
    fontFamily: typeScale.button.fontFamily,
    fontSize: typeScale.button.size,
    lineHeight: typeScale.button.lineHeight,
    color: color.primary,
  },
  loadMoreLabelLoading: {
    color: color.textSecondary,
  },
  loadMoreLabelFailed: {
    color: color.error,
  },
});
