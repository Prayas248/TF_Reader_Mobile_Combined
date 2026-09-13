// A4 (Prayas) — one shelf as a full, paginated listing.
//
// Replaces the navigation stub that landed on main as scaffolding for this work
// ("renders the shelfId so Prayas can verify navigation is wired"). The route is
// `Shelf`, carrying `{ shelfId, title, institutionId }`.
//
// THE APP BAR ALSO OWNS THE TITLE, so a SectionHeader here prints the shelf
// name a second time. That duplication is deliberate now, on explicit
// instruction: the heading is where Filter & Sort's trailing action lives
// (SectionHeader's own action slot), the same placement PublicCatalogueScreen
// uses for its one fixed heading — so scrolling past the app bar still leaves
// the filter reachable next to a label, not as a bare icon.
//

// Reached by tapping a CategoryCard on CatalogueScreen, which pushes
// ShelfDetail with the tapped nav entry's `shelfId`. This screen fetches that
// shelf on its own (getShelf) rather than receiving it as a route param: the
// home feed only carries previews, and a listing is a different document.
//
// PAGING IS "LOAD MORE", NOT INFINITE SCROLL. The app has no FlatList anywhere
// yet — every list is a ScrollView + map — so `onEndReached` would introduce a
// new list primitive and a scroll threshold to tune. An explicit button reuses
// the Pressable pattern already here for retry, and it is honest about cost on
// a metered connection. Swap it for onEndReached later if the design asks; the
// state below does not change, only what calls `loadMore`.
//
// THE CURSOR COMES OFF THE RESPONSE, never `page + 1`. normalize.ts derives
// `nextPage` from the feed's `next` link and throws MALFORMED_FEED if that link
// has no page parameter, so arithmetic here would be a second, silently wrong
// source of truth the day wokay switch to cursor paging.
//
// A LOAD-MORE FAILURE MUST NOT WIPE THE SCREEN. `failed` is first-page-only and
// still renders the full-screen error; a later page failing shows an inline
// retry under the rows the user already has.
//
// `institutionId` ARRIVES IN THE ROUTE PARAMS, from the catalogue that
// advertised this shelf. Not read from the store here: a param cannot be
// omitted, so there is no fallback id for a reader who has chosen no
// institution to fall through to.
//
// THE BADGE IS RESOLVED, NEVER DERIVED HERE. Each row calls `resolveAccess` and
// passes only the resulting `.tier` into ContentCard's slot — see the same note
// in `CatalogueScreen`. The session comes from `useCurrentSession` (real
// sign-in, see currentSession.ts) and CAN be null here even though
// `institutionId` cannot: a reader can browse an institution's catalogue
// before signing in.
//
// 'all' IS THE ONLY SHELF THAT PAGES on mock data today: it is the one with both
// a page-0 and a page-1 fixture (03 and 04). 'shelf_1' and 'shelf_2' have
// single-page feeds (05 and 06), and 'shelf_3' is advertised in navigation with
// no feed behind it, so it keeps the NOT_FOUND path exercised — MockAdapter
// returns NOT_FOUND and the error state above renders. Nothing here is
// shelf-specific; they will page the moment their fixtures land.
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
import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from '@react-navigation/native-stack';

import { useCurrentSession, useIsSignedIn } from '@access/currentSession';
import { isNotEntitled, resolveAccess } from '@access/resolveAccess';
import { AccessTierBadge } from '@components/AccessTierBadge';
import { EmptyState } from '@components/EmptyState';
import { ContentCard, COVER_TILE_WIDTH } from '../components/ContentCard';
import { ErrorState } from '@components/ErrorState';
import { FilterSortButton } from '@components/FilterSortButton';
import { FilterSortSheet } from '@components/FilterSortSheet';
import { OfflineBanner } from '@components/OfflineBanner';
import { SectionHeader } from '@components/SectionHeader';
import { getCatalogueSource } from '../config/catalogue';
import { useNetworkStatus } from '@hooks/useNetworkStatus';
import { type CatalogueError, isCatalogueFailure } from '@model/errors';
import { CATALOGUE_ERROR_COPY, catalogueErrorVariant } from '@model/errorCopy';
import type { Publication, Shelf, SortOrder } from '../model/types';
import type { CatalogueStackParamList } from '../navigation/types';
import type { BrowseFilters } from '@search/browseLink';
import { color, space, type as typeScale } from '../theme/tokens';

type Nav = NativeStackNavigationProp<CatalogueStackParamList, 'Shelf'>;

type Props = NativeStackScreenProps<CatalogueStackParamList, 'Shelf'>;

// State of a SUBSEQUENT page request only. A union rather than two booleans so
// "loading and failed at once" cannot be represented.
type MoreStatus = 'idle' | 'loading' | 'failed';

// How many skeleton cards to show before the first page arrives. Arbitrary —
// there is no data yet to size it from.
const SKELETON_COUNT = 3;

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

export default function ShelfScreen({ route }: Props) {
  const { shelfId, institutionId, title } = route.params;
  const navigation = useNavigation<Nav>();

  // Matches `COVER_TILE_WIDTH` — the same width CatalogueScreen's carousel
  // and PublicCatalogueScreen's grid use — whenever the screen is wide
  // enough for two of them plus the row's own gap. See that screen's own
  // comment on this same computation for why the fallback exists and why
  // the cover image's aspect ratio is never touched either way.
  const { width: windowWidth } = useWindowDimensions();
  const columnWidth = Math.min(
    COVER_TILE_WIDTH,
    (windowWidth - space.md * 2 - space.sm) / 2,
  );

  // Null unless the reader has actually signed in — see currentSession.ts's
  // note on why this replaced handToggledSession.
  const session = useCurrentSession();

  // getShelf now requires this (wokay's contract: appToken), but this screen
  // mounts off route params alone, ahead of sign-in — same reasoning as
  // CatalogueScreen.tsx's isSignedIn: without it in fetchPage's deps, a
  // sign-in completing while this screen stays mounted would never re-run
  // the effect below.
  const isSignedIn = useIsSignedIn();

  // F5 — offline is its own state, independent of loading/empty/error: a shelf
  // already on screen stays readable behind the banner, and a shelf that failed
  // gets an explanation for why. Rendered in BOTH branches below rather than
  // once, the same way InstitutionListScreen renders it in each of its three.
  const isOnline = useNetworkStatus();

  // The shelf's IDENTITY, taken from the first page and then left alone: title
  // and totalItems describe the whole shelf, not the page that carried them.
  // Re-setting this on every page would let the header flicker if a later
  // response's metadata differed.
  const [shelf, setShelf] = useState<Shelf | null>(null);
  // Every page so far, concatenated. Separate from `shelf.publications`, which
  // is only ever one page's worth.
  const [publications, setPublications] = useState<Publication[]>([]);
  // The cursor. `undefined` means "no next page" — which is also the absence of
  // a `next` link in the feed, so the two agree by construction.
  const [nextPage, setNextPage] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [errorCode, setErrorCode] = useState<CatalogueError | undefined>(undefined);
  const [moreStatus, setMoreStatus] = useState<MoreStatus>('idle');

  // Screen 12 — filter & sort. APPLIED is what the last request actually used
  // (carried forward into loadMore's follow-up pages); DRAFT is what the sheet
  // shows while the reader is still choosing. They only agree the moment the
  // sheet opens and the moment Apply/Clear All commits — see openSheet below.
  const [appliedFilters, setAppliedFilters] = useState<BrowseFilters>({});
  const [appliedSort, setAppliedSort] = useState<SortOrder | undefined>(undefined);
  const [draftFilters, setDraftFilters] = useState<BrowseFilters>({});
  const [draftSort, setDraftSort] = useState<SortOrder | undefined>(undefined);
  const [sheetVisible, setSheetVisible] = useState(false);
  // Sort is honoured only on 'all' (browseLink.ts) — the sheet still renders
  // the row, greyed, rather than hiding it on every other shelf.
  const sortDisabled = shelfId !== 'all';

  // No synchronous setState here — only inside the async continuations. A
  // setState reachable directly from an effect body triggers a lint error
  // ("cascading renders"); `loading`/`failed` are also already at these exact
  // values on mount, so resetting them here would be redundant anyway. Retry
  // and a filter Apply/Clear All are the paths that truly need to reset them,
  // and they run from a press handler, not an effect — see below.
  const fetchPage = useCallback(
    (filters: BrowseFilters, sort: SortOrder | undefined) => {
      getCatalogueSource()
        // Page omitted, not passed as 0: the adapter forwards it to the server
        // as a query param only when present, so the server applies its own
        // default.
        .getShelf(institutionId, shelfId, undefined, { ...filters, sort })
        .then((page) => {
          setShelf(page);
          setPublications(page.publications);
          setNextPage(page.nextPage);
          // Clears a failure left over from an earlier attempt on this same
          // shelf — e.g. the reader signing in after a signed-out 401 — so a
          // stale error state does not survive a fetch that just succeeded.
          setFailed(false);
          setErrorCode(undefined);
        })
        .catch((err: unknown) => {
          // Logged rather than swallowed: the screen only shows generic copy,
          // and CatalogueFailure's `target` carries the exact field that
          // failed validation (see normalize.ts's `malformed()`) — the one
          // piece of information that tells a MALFORMED_FEED apart from a
          // network failure when both look the same on screen.
          console.error('ShelfScreen: fetch failed', err);
          setErrorCode(isCatalogueFailure(err) ? err.code : undefined);
          setFailed(true);
        })
        .finally(() => setLoading(false));
    },
    // isSignedIn is intentionally listed even though the body never reads it
    // — see the isSignedIn comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [institutionId, shelfId, isSignedIn],
  );

  useEffect(() => {
    fetchPage(appliedFilters, appliedSort);
    // Only on mount (or a shelfId change, which never happens on a live
    // screen — see the file header). appliedFilters/appliedSort changes are
    // driven by applyFilters/clearAllFilters below, which fetch directly
    // rather than through this effect, the same reasoning `retry` already
    // documents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchPage]);

  const retry = useCallback(() => {
    setLoading(true);
    setFailed(false);
    fetchPage(appliedFilters, appliedSort);
  }, [fetchPage, appliedFilters, appliedSort]);

  const openSheet = useCallback(() => {
    // The sheet always opens showing what is actually applied, never a stale
    // draft left over from a previous open-then-dismiss.
    setDraftFilters(appliedFilters);
    setDraftSort(appliedSort);
    setSheetVisible(true);
  }, [appliedFilters, appliedSort]);

  const applyFilters = useCallback(() => {
    setSheetVisible(false);
    setLoading(true);
    setFailed(false);
    setPublications([]);
    setNextPage(undefined);
    setAppliedFilters(draftFilters);
    setAppliedSort(draftSort);
    fetchPage(draftFilters, draftSort);
  }, [draftFilters, draftSort, fetchPage]);

  // Whether the CURRENT results were fetched with a filter or sort — the applied
  // pair, not the draft one, because the draft is whatever is half-typed in the
  // sheet and says nothing about why the list is empty.
  const hasActiveFilter =
    appliedSort !== undefined ||
    Object.values(appliedFilters).some((value) => value !== undefined);

  const clearAllFilters = useCallback(() => {
    setDraftFilters({});
    setDraftSort(undefined);
    setSheetVisible(false);
    setLoading(true);
    setFailed(false);
    setPublications([]);
    setNextPage(undefined);
    setAppliedFilters({});
    setAppliedSort(undefined);
    fetchPage({}, undefined);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    // A guard, not an assertion: the button is hidden when there is no next page
    // and disabled while a page is in flight, so arriving here in either state
    // means a race (two taps landing in one tick). Doing nothing is the right
    // answer — fetching page `undefined`, or the same page twice, is not.
    if (nextPage === undefined || moreStatus === 'loading') return;

    setMoreStatus('loading');
    getCatalogueSource()
      // The same filters/sort the current page was fetched with — a further
      // page of the same request, never a fresh, unfiltered one.
      .getShelf(institutionId, shelfId, nextPage, {
        ...appliedFilters,
        sort: appliedSort,
      })
      .then((page) => {
        // Appended, never replaced — earlier pages staying on screen is the
        // whole point. Deduped by id because overlapping pages are a real
        // server behaviour, and a repeat would otherwise mean duplicate React
        // keys and a row rendered twice.
        setPublications((previous) => {
          const seen = new Set(previous.map((publication) => publication.id));
          return [...previous, ...page.publications.filter(({ id }) => !seen.has(id))];
        });
        setNextPage(page.nextPage);
        setMoreStatus('idle');
      })
      // Deliberately does NOT set `failed`: the rows already on screen stay,
      // and the inline label below turns into a retry.
      .catch(() => setMoreStatus('failed'));
  }, [nextPage, moreStatus, institutionId, shelfId, appliedFilters, appliedSort]);

  if (failed) {
    return (
      <View style={styles.center}>
        <ErrorState
          variant={errorCode === undefined ? 'not_ready' : catalogueErrorVariant(errorCode)}
          message={errorCode === undefined ? "Couldn't load this shelf." : CATALOGUE_ERROR_COPY[errorCode]}
          onRetry={retry}
        />
        <OfflineBanner visible={!isOnline} />
      </View>
    );
  }

  const moreLabel =
    moreStatus === 'loading'
      ? 'Loading…'
      : moreStatus === 'failed'
        ? "Couldn't load more — tap to retry"
        : 'Load more';

  return (
    <View style={styles.screen}>
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <SectionHeader
          title={title}
          emphasis="editorial"
          action={<FilterSortButton onPress={openSheet} accessibilityLabel={`Filter & Sort ${title}`} />}
        />

        {loading ? (
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
          )
        ) : (
          <View style={styles.section}>
          {/* B10 — the shelf's own empty state, INSIDE the section rather than
              instead of it, so the "Showing 0 of 0" count below still renders. A
              reader who filtered to nothing needs both facts: that the filter
              matched nothing, and that the shelf itself is not broken.

              THIS SCREEN COULD PREVIOUSLY GO BLANK. It carries a filter and sort
              sheet, so narrowing to zero results is an ordinary thing to do — and
              with no empty state the list rendered nothing at all, which reads as
              a failed load rather than as an answer.

              TWO VARIANTS, for the reason SearchScreen distinguishes them:
              "your filters matched nothing" is a different fact from "this shelf
              is empty", and only the first has an action worth offering.

              NOT A CONTRADICTION OF THE FEED RULE. index.html's "a shelf with
              nothing in it is absent from the feed, not empty" is about the HOME
              screen's preview shelves, which are omitted rather than sent empty.
              This is the shelf a reader has navigated INTO, where a filtered
              fetch legitimately returns zero rows. */}
          {/* TODO: Shelf.browseInstead (NavLink[], target: 'shelf' | 'catalogue') is
              populated on the model but never read here — this empty state has no
              "browse instead" affordance, unlike SearchScreen's zero-result state,
              which already does target-based routing (see SearchScreen.tsx's
              browseInstead block). Wire it up here the same way if this screen is
              meant to offer it too. */}
          {publications.length === 0 ? (
            <EmptyState
              variant={hasActiveFilter ? 'no_filter_results' : 'no_content'}
              onClearFilters={clearAllFilters}
            />
          ) : (
          <View style={styles.list}>
            {chunkPairs(publications).map((pair, rowIndex) => (
              <View key={rowIndex} style={styles.gridRow}>
                {pair.map((publication) => {
                  // Hoisted out of the `badge` prop: D12 needs the resolved
                  // ACTIONS as well as the tier, and resolving twice per row
                  // would be two answers to one question.
                  const access = resolveAccess({
                    item: publication,
                    institutionId,
                    session,
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
                        // included: `tier` carries an OPEN_ACCESS filler in
                        // that state, and drawing it would label an
                        // unopenable title free.
                        badge={
                          isNotEntitled(access) ? undefined : (
                            <AccessTierBadge tier={access.tier} />
                          )
                        }
                        // NO `action` PROP. D12's Elite queue affordance is
                        // ItemDetailScreen only — confirmed team decision, 26
                        // Aug. The cover variant has no action slot anyway
                        // (see ContentCard's own header).
                        onPress={() =>
                          navigation.navigate('ItemDetail', { itemId: publication.id })
                        }
                      />
                    </View>
                  );
                })}
              </View>
            ))}
          </View>
          )}

          {/* Server-reported total, so the count stays honest across pages.
              Rendered only when the feed supplies one — inventing "of 2" from
              what happens to be loaded would tell the user the shelf ends here. */}
          {shelf?.totalItems !== undefined && (
            <Text style={styles.count}>
              Showing {publications.length} of {shelf.totalItems}
            </Text>
          )}

          {/* Absent, not disabled, on the last page: a permanently dead button
              reads as broken. `nextPage === undefined` is exactly "no more". */}
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
        </View>
        )}
      </ScrollView>

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
        sortDisabled={sortDisabled}
        onApply={applyFilters}
        onClearAll={clearAllFilters}
      />

      {/* Last in the tree, so it overlays the list and the sheet rather than
          being covered by them — the placement InstitutionListScreen uses. */}
      <OfflineBanner visible={!isOnline} />
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
    gap: space.lg,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    backgroundColor: color.white,
  },
  section: {
    gap: space.sm,
  },
  list: {
    gap: space.sm,
  },
  // Two cover tiles per row, each given an explicit `width` inline
  // (`columnWidth`, computed above) rather than `flex: 1` — see
  // PublicCatalogueScreen's identical comment for why a flexible fill would
  // size this screen's tiles differently from CatalogueScreen's carousel.
  // `space-between` keeps the pair pinned to the row's outer edges.
  gridRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  count: {
    alignSelf: 'center',
    fontWeight: typeScale.meta.weight,
    fontFamily: typeScale.meta.fontFamily,
    fontSize: typeScale.meta.size,
    lineHeight: typeScale.meta.lineHeight,
    color: color.textSecondary,
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
