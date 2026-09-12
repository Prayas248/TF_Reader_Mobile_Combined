// A1 (Prayas) — the catalogue a reader sees before choosing an institution.
//
// A FLAT LIST, NOT A HOME SCREEN. Curated shelves are configured per institution
// and this reader has none, so there is no category strip and no section heading
// here — one list of open access titles and nothing else. That absence is the
// feature, not an unfinished screen.
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
//
// ─── NO JOURNALS HERE, AND IT IS A REAL BACKEND GAP, NOT A TODO ─────────────
//
// CatalogueScreen.tsx (the institution-selected screen) has a "Journals"
// section, built from that institution's own `getHomeCatalogue()` navigation
// entries and browsed with `getWork(institutionId, workId)`. Neither has a
// no-institution counterpart: `getPublicFeed()` (what THIS screen calls)
// returns a `Shelf` — a flat publications list with no `navigation` field at
// all — and `CatalogueSource`'s interface has no `getPublicWork`. wokay's
// contract has never published a "list every public journal" endpoint or a
// way to fetch a journal/volume/issue feed without an institution id (the
// real endpoint is literally `/opds/v1/institutions/{id}/works/{workId}`).
//
// A client-side workaround was considered — fetch every known institution's
// catalogue and merge their journal entries into one list — and rejected: it
// does not scale (N full catalogue fetches for one preview section, against
// however many institutions the real backend has, not the two dev fixtures),
// and the same journal held by several institutions would show up once per
// institution rather than once. This needs a real backend capability (a
// public journals list, and a public work-fetch), not a screen change.
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import EmptyState from '@/components/EmptyState';
import OfflineBanner from '@/components/OfflineBanner';
import { isNotEntitled, resolveAccess } from '@access/resolveAccess';
import { AccessTierBadge } from '@components/AccessTierBadge';
import { ContentCard } from '../components/ContentCard';
import { ErrorState } from '@components/ErrorState';
import { getCatalogueSource } from '../config/catalogue';
import { type CatalogueError, isCatalogueFailure } from '@model/errors';
import { CATALOGUE_ERROR_COPY, catalogueErrorVariant } from '@model/errorCopy';
import type { Publication } from '../model/types';
import type { CatalogueStackParamList } from '../navigation/types';
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

export default function PublicCatalogueScreen() {
  const navigation = useNavigation<Nav>();

  const [publications, setPublications] = useState<Publication[]>([]);
  // The cursor, taken off the response's own `next` link. `undefined` means
  // there is no next page.
  const [nextPage, setNextPage] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [errorCode, setErrorCode] = useState<CatalogueError | undefined>(undefined);
  const [moreStatus, setMoreStatus] = useState<MoreStatus>('idle');

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

  const isEmpty = !loading && publications.length === 0;
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
        {loading &&
          Array.from({ length: SKELETON_COUNT }, (_, index) => (
            <ContentCard key={index} state="loading" title="" />
          ))}

        {/* Nothing open access at all. Not an error, so no Retry — see the
            EmptyState test. */}
        {isEmpty && <EmptyState variant="no_content" />}

        {publications.map((publication) => {
          // Resolved once rather than inline in the badge, so D8 can ask about
          // the state before anything reads the tier.
          const access = resolveAccess({
            item: publication,
            institutionId: null,
            session: null,
          });

          return (
            <ContentCard
              key={publication.id}
              title={publication.title}
              publisher={publication.publisher}
              imageUrl={publication.coverUrl}
              format={publication.format}
              // D8 — `not_entitled` renders nothing at all, badge included. The
              // tier is an OPEN_ACCESS filler in that state, which on THIS
              // screen would be doubly misleading: a list of open access titles
              // is exactly where a false "Open Access" chip would go unnoticed.
              badge={
                isNotEntitled(access) ? undefined : <AccessTierBadge tier={access.tier} />
              }
              // No `action` — D12 is audited and excluded here. See the file
              // header for why: with no institution there is no session, so
              // resolveAccess answers `requires_signin` for every licensed tier
              // and the queue is unreachable by construction.
              onPress={() => navigation.navigate('ItemDetail', { itemId: publication.id })}
            />
          );
        })}

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
