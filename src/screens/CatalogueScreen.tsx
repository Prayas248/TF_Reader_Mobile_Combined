// P0-3/P0-4 (Prayas) — wires ContentCard to the DataSource seam.
//
// SHAPE FOLLOWS THE FEED. The hero banner is static editorial chrome, matched
// against a reference design; everything below it is the home catalogue's OWN
// shelves, each under its own heading, in feed order. That list comes from
// the feed and has neither a fixed length nor a known name — an administrator
// configures the shelves per institution (AGENTS.md L-5, settled 16 Aug 2026),
// so handle none, one and many.
//
// `catalogue.navigation` is no longer rendered as its own strip of cards — a
// reference-design pass (see git history for the CategoryCard strip this
// replaced) found it added a section with nothing in the reference and no
// content of its own beyond what a shelf's "See all" already reaches. The
// feed's first navigation entry is still read, just for the hero's own CTA
// (by position, same rule `isFeatured` below follows) rather than for a row
// of tappable cards.
//
// THE INSTITUTION ARRIVES AS A PROP, and there is no fallback id any more.
// CatalogueHomeScreen owns the choice: a reader without an institution gets
// PublicCatalogueScreen instead of this one, so by the time this renders there
// is always a real institution. The old `?? 'inst_7f3'` quietly served one
// institution's catalogue to a reader who had picked none — the bug A1 fixes.
// The institution itself is named in the header's own pill now (AppHeader,
// RootNavigator.tsx), not in this screen's body.
//
// THE BADGE IS RESOLVED, NEVER DERIVED HERE. Each row calls `resolveAccess` and
// passes only the resulting `.tier` into ContentCard's slot — reading
// `publication.acquisition.licenceModel` in this file would be the Design Spec
// §5.1 violation ("the UI must never calculate access rights"). The session
// comes from `handToggledSession` — A7's stand-in for real sign-in — which is
// never null here: CatalogueHomeScreen only renders this screen once an
// institution is selected. loan/hold are joined per item from the library cache
// so each badge reflects the reader's live holdings without a per-card call.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import EmptyState from '@/components/EmptyState';
import { useCurrentSession, useIsSignedIn } from '@access/currentSession';
import { isNotEntitled, resolveAccess } from '@access/resolveAccess';
import { AccessTierBadge } from '@components/AccessTierBadge';
import { ContentCard, COVER_TILE_WIDTH } from '../components/ContentCard';
import { ErrorState } from '@components/ErrorState';
import { HeroBanner } from '@components/HeroBanner';
import { SectionHeader } from '../components/SectionHeader';
import { getCatalogueSource } from '../config/catalogue';
import { type CatalogueError, isCatalogueFailure } from '@model/errors';
import { CATALOGUE_ERROR_COPY, catalogueErrorVariant } from '@model/errorCopy';
import type { Catalogue } from '../model/types';
import type { CatalogueStackParamList } from '../navigation/types';
import type { Institution } from '@model/institution';
import { color, space } from '../theme/tokens';
import { useFeedScrollMemory } from '@hooks/useFeedScrollMemory';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import OfflineBanner from '@/components/OfflineBanner';
import { useLibraryStore } from '@store/libraryStore';

type Nav = NativeStackNavigationProp<CatalogueStackParamList, 'CatalogueHome'>

// How many skeleton rows/cards to show before the first real payload arrives.
// Arbitrary — there is no data yet to size it from.
const SKELETON_COUNT = 3;

// Static editorial copy for the hero — matched verbatim against the reference
// design, the same way its gradient and layout are. None of this is derived
// from the feed: `statLabel` is not `Shelf.totalItems` (absent on these
// preview shelves) or any other real count, it is the reference design's own
// wording, same status as a magazine's own masthead copy.
const HERO_STAT = 'Over 140,000 peer-reviewed titles';
const HERO_TITLE = 'The Scholarly Archive';
const HERO_SUBTITLE =
  'Full-text access to world-leading research monographs, handbooks, and journal volumes.';
const HERO_ACTION_LABEL = 'Explore All Titles';
const HERO_UPDATED_LABEL = 'Updated daily';

// `COVER_TILE_WIDTH` (ContentCard's own export) is what this carousel was
// originally sized around — wide enough that two tiles fill most of the
// content width with only a small peek of a third. Now shared, not
// redeclared here: PublicCatalogueScreen's and ShelfScreen's two-up grids
// size their cover tiles off the same constant, on explicit instruction that
// a book cover must render at an identical width, and therefore an
// identical height, everywhere in the app.
//
// A tile's own width plus the gap the carousel puts after it (`styles.carousel`'s
// own `gap`) — the fixed distance from one tile's left edge to the next
// one's, which is what turns an index into an x-position for visibility
// math (see `isCoverTileVisible`) without needing a per-tile `onLayout`.
const COVER_CARD_STEP = COVER_TILE_WIDTH + space.md;

export interface CatalogueScreenProps {
  institution: Institution;
}

export default function CatalogueScreen({ institution }: CatalogueScreenProps) {
  const navigation = useNavigation<Nav>();
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // Undefined covers both "no failure" and "failed with something that was not
  // a CatalogueFailure" — the fallback copy below handles the second case, the
  // same way SearchScreen's own errorCode does.
  const [errorCode, setErrorCode] = useState<CatalogueError | undefined>(undefined);

  const isOnline = useNetworkStatus();

  const institutionId = institution.id;

  // Null unless the reader has actually signed in — selecting an institution
  // alone is no longer enough (see currentSession.ts's note on why this
  // replaced handToggledSession).
  const session = useCurrentSession();

  // getHomeCatalogue now requires this (wokay's contract: appToken), but this
  // screen mounts off institution selection alone, ahead of sign-in — a
  // reader can be looking at it, signed out and failed, with the sign-in
  // sheet stacked on top. Without isSignedIn in fetchCatalogue's deps, a
  // sign-in completing while this screen stays mounted would never re-run
  // the effect below, leaving the reader stuck on the earlier failure until
  // they pressed Retry themselves.
  const isSignedIn = useIsSignedIn();

  // Holdings joined per item so each badge reflects the reader's live state.
  // One fetch per mount — not one per card.
  const loans = useLibraryStore((s) => s.loans);
  const holds = useLibraryStore((s) => s.holds);

  const refresh = useLibraryStore((s) => s.refresh);

  // A7 — keyed on the institution, not one shared offset: signing out swaps this
  // screen for the public feed, and each has its own place to return to. Changing
  // institution is a different feed too, so it starts at the top.
  const { scrollRef, onScroll, onContentSizeChange } = useFeedScrollMemory(institutionId);

  // Feeds each featured tile's own visibility to its `ContentCard`, which
  // gates the title marquee's start delay (see that component's own note on
  // its `visible` prop). Every tile has the same known width and gap, so a
  // tile's x-position is `index * COVER_CARD_STEP` — no per-tile `onLayout`
  // needed, just this carousel's own scroll offset and viewport width.
  const [carouselScrollX, setCarouselScrollX] = useState(0);
  const [carouselViewportWidth, setCarouselViewportWidth] = useState(0);
  const handleCarouselScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    setCarouselScrollX(e.nativeEvent.contentOffset.x);
  }, []);
  const handleCarouselLayout = useCallback((e: LayoutChangeEvent) => {
    setCarouselViewportWidth(e.nativeEvent.layout.width);
  }, []);
  const isCoverTileVisible = useCallback(
    (index: number) => {
      const tileStart = index * COVER_CARD_STEP;
      const tileEnd = tileStart + COVER_TILE_WIDTH;
      return tileEnd > carouselScrollX && tileStart < carouselScrollX + carouselViewportWidth;
    },
    [carouselScrollX, carouselViewportWidth],
  );

  let body: ReactNode;
  // `loading`/`failed` ARE reset synchronously here, on purpose — this used to
  // skip the reset (leaving it to `retry`'s press handler only), reasoning
  // that a mount already starts at these values so it would be redundant.
  // That missed the OTHER caller of this identity change: `isSignedIn`
  // flipping mid-mount (see its own comment below) re-runs the effect below
  // with a stale `failed=true`/`errorCode=UNAUTHENTICATED` still on screen
  // from the signed-out fetch that failed moments earlier, and nothing
  // cleared it until the new fetch resolved — so a reader who just signed in
  // saw the "You need to sign in again" ErrorState (with its "Learn more"
  // button) flash back up before the real catalogue replaced it. Resetting
  // here closes that gap: whatever re-triggers a fetch, the screen goes back
  // to its loading skeleton for the duration, never the previous failure.
  const fetchCatalogue = useCallback(() => {
    setLoading(true);
    setFailed(false);
    setErrorCode(undefined);
    getCatalogueSource()
      .getHomeCatalogue(institutionId)
      .then((result) => {
        setCatalogue(result);
      })
      .catch((err: unknown) => {
        setErrorCode(isCatalogueFailure(err) ? err.code : undefined);
        setFailed(true);
      })
      .finally(() => setLoading(false));
    // isSignedIn is intentionally listed even though the body never reads it:
    // getHomeCatalogue's own success depends on it (appToken), so a sign-in
    // completing while this screen is mounted must give fetchCatalogue a new
    // identity to re-run the effect below — see the isSignedIn comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [institutionId, isSignedIn]);

  useEffect(() => {
    // The lint rule this disables is right that setState-in-effect can cause
    // needless cascading renders in general, but that is not what this is:
    // fetchCatalogue's synchronous reset (loading=true, failed=false) is the
    // fix for the bug this effect exists to close (see fetchCatalogue's own
    // comment) — every re-run of this effect starts a NEW async fetch, and
    // the reset is what stops the PREVIOUS fetch's stale result from staying
    // on screen for the duration of the new one.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchCatalogue();
    // Populate the holdings cache once per mount so every card's badge is live
    // rather than the empty-cache default. Runs in parallel with fetchCatalogue.
    void refresh();
  }, [fetchCatalogue, refresh]);

  const retry = useCallback(() => {
    fetchCatalogue();
  }, [fetchCatalogue]);

  if (failed) {
    body = (
      <View style={styles.center}>
        <ErrorState
          variant={errorCode === undefined ? 'not_ready' : catalogueErrorVariant(errorCode)}
          message={errorCode === undefined ? "Couldn't load the catalogue." : CATALOGUE_ERROR_COPY[errorCode]}
          onRetry={retry}
        />
      </View>
    );
  }
  else{
    // The first navigation entry, by POSITION — same rule `isFeatured` below
    // follows, never a name or an assumption about what an institution calls
    // it. Absent when a catalogue advertises none, in which case the hero
    // shows no action at all (both-or-neither — see HeroBanner's own header).
    const heroNavEntry = catalogue?.navigation[0];

    body = (
      <ScrollView
        testID="catalogue-feed"
        ref={scrollRef}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onContentSizeChange={onContentSizeChange}
        style={styles.screen}
        contentContainerStyle={styles.content}
      >
      <HeroBanner
        statLabel={loading ? undefined : HERO_STAT}
        title={loading ? '' : HERO_TITLE}
        subtitle={loading ? undefined : HERO_SUBTITLE}
        actionLabel={loading || heroNavEntry === undefined ? undefined : HERO_ACTION_LABEL}
        onPressAction={
          loading || heroNavEntry === undefined
            ? undefined
            : () =>
                navigation.navigate('Shelf', {
                  shelfId: heroNavEntry.shelfId,
                  title: heroNavEntry.title,
                  institutionId,
                })
        }
        updatedLabel={loading ? undefined : HERO_UPDATED_LABEL}
        state={loading ? 'loading' : 'idle'}
      />

      {loading
        ? Array.from({ length: SKELETON_COUNT }, (_, index) => (
            <ContentCard key={index} state="loading" title="" />
          ))
        :catalogue?.shelves.length !== 0 ? catalogue?.shelves.map((shelf, shelfIndex) => {
            // Position, never name or id — same rule ACCENTS already follows
            // below. Only the shelf in the feed's first slot becomes a
            // carousel; which shelf that is comes entirely from the feed.
            const isFeatured = shelfIndex === 0;

            const cards = shelf.publications.map((publication, publicationIndex) => {
              const pubLoan = loans.find((l) => l.itemId === publication.id);
              const pubHold = holds.find((h) => h.itemId === publication.id);
              const access = resolveAccess({
                item: publication,
                institutionId,
                session,
                loan: pubLoan,
                hold: pubHold,
              });
              // D8 — `not_entitled` renders nothing at all, badge included.
              // `tier` is a required field, so that state carries an
              // OPEN_ACCESS filler; drawing it would label a title the reader
              // cannot open as free to read. The carousel tile gets the
              // bigger `md` pill — it has the width a book cover affords;
              // the dense row list keeps `sm` (the component's own default).
              const badge = isNotEntitled(access) ? undefined : (
                <AccessTierBadge tier={access.tier} size={isFeatured ? 'md' : 'sm'} />
              );
              const onPress = () => navigation.navigate('ItemDetail', { itemId: publication.id });

              // `authors` is a real array that is sometimes empty — an empty
              // grey line where a name should be reads as a bug the same way
              // a blank publisher line would, so this only ever hands
              // ContentCard a non-empty string or nothing at all.
              const authors =
                publication.authors.length > 0 ? publication.authors.join(', ') : undefined;

              // Real page count, not an invented edition — `numberOfPages` is
              // the one printed-extent field the feed actually carries.
              const meta =
                publication.numberOfPages === undefined
                  ? undefined
                  : `${publication.numberOfPages} pp.`;

              return isFeatured ? (
                <View key={publication.id} style={styles.coverCard}>
                  <ContentCard
                    variant="cover"
                    title={publication.title}
                    publisher={publication.publisher}
                    imageUrl={publication.coverUrl}
                    format={publication.format}
                    authors={authors}
                    badge={badge}
                    onPress={onPress}
                    visible={isCoverTileVisible(publicationIndex)}
                  />
                </View>
              ) : (
                <ContentCard
                  key={publication.id}
                  title={publication.title}
                  publisher={publication.publisher}
                  imageUrl={publication.coverUrl}
                  format={publication.format}
                  authors={authors}
                  meta={meta}
                  badge={badge}
                  onPress={onPress}
                />
              );
            });

            return (
              <View key={shelf.id} style={styles.section}>
                <SectionHeader
                  title={shelf.title}
                  emphasis="editorial"
                  // `shelf.id` is the same opaque key `getShelf` already takes
                  // from a navigation entry's `shelfId` — a preview shelf can
                  // open its own full listing the same way, it just isn't one
                  // of the tappable categories in the strip above.
                  actionLabel="See all"
                  onAction={() =>
                    navigation.navigate('Shelf', {
                      shelfId: shelf.id,
                      title: shelf.title,
                      institutionId,
                    })
                  }
                />
                {isFeatured ? (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.carousel}
                    onScroll={handleCarouselScroll}
                    onLayout={handleCarouselLayout}
                    scrollEventThrottle={16}
                  >
                    {cards}
                  </ScrollView>
                ) : (
                  <View style={styles.list}>{cards}</View>
                )}
              </View>
            );
          }) : (
            <EmptyState variant="no_content"/>
          )}

      {/* Journal navigation entries — works hrefs from the catalogue navigation.
          Rendered as ContentCards so they match the existing book rows exactly.
          Only shown once data has loaded and journals exist. */}
      {!loading && (() => {
        const journals = catalogue?.navigation.filter((n) => n.target === 'works') ?? [];
        if (journals.length === 0) return null;
        return (
          <View style={styles.section}>
            <SectionHeader title="Journals" emphasis="editorial" />
            <View style={styles.list}>
              {journals.map((journal) => (
                <ContentCard
                  key={journal.workId}
                  title={journal.title}
                  imageUrl={journal.coverUrl}
                  onPress={() =>
                    navigation.navigate('Journal', {
                      workId: journal.workId!,
                      title: journal.title,
                      institutionId,
                      coverUrl: journal.coverUrl,
                    })
                  }
                />
              ))}
            </View>
          </View>
        );
      })()}
    </ScrollView>
    );
  }

  return (
    <View style={styles.screen}>
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
  // The first shelf's horizontal carousel. Gap between tiles, not around the
  // whole row — the row itself sits inside `content`'s own padding already.
  carousel: {
    gap: space.md,
  },
  // The carousel owns each cover tile's width — ContentCard sets none of its
  // own (CONVENTIONS §8).
  coverCard: {
    width: COVER_TILE_WIDTH,
  },
});
