// The personal library — CAP-4 Module E (Library & Sync), flambeau.
//
// The screen the app opens on for a signed-in reader: what they can access,
// what they are holding, what is on this device, where they left off, and
// what Elite title needs their answer. Loans and holds come from
// `GET /api/v1/library`, reached through `LicenceSource.getLibrary()` rather
// than through HTTP (see `src/licence/`). Downloads and bookmarks are
// DEVICE-LOCAL — downloads from `downloadStore`, bookmarks from the REAL
// synced `bookmarkTable` (`src/features/sync/stores/bookmarkStore.ts`; an
// earlier version of this screen read a dead Zustand stand-in at
// `src/store/bookmarkStore.ts` that nothing ever wrote to, so the tab
// rendered empty regardless of what the reader had actually bookmarked) —
// that endpoint carries neither.
//
// REBUILT AROUND A PRODUCT MODEL, NOT FIVE BACKEND SECTIONS (product spec,
// Sept 2026, refined against a reference mockup the same month; Borrowed and
// Premium were later merged into one tab, and a Journals tab added, on
// direct instruction — see `partitionLoansByTier` and `articleJournalStore`'s
// own headers). The tab rail is real navigation — each tab renders a
// DIFFERENT view of the same underlying data. Five tabs:
//
//   All       — a genuine overview: a pending Elite offer first if one
//               exists (never a reserved empty slot for it), then "Your
//               content" (loans/downloads/bookmarks merged, one heading not
//               five) and, separately, "Premium waiting" if the reader is
//               queued for anything. A journal article inside "Your content"
//               renders as its JOURNAL (the same row `Journals` renders),
//               never by its own title and authors line — that line carries
//               no journal context, and duplicating the article there too
//               would just be `Journals`'s own row shown twice. See
//               `journalArticleIds`'s own comment.
//   Borrowed  — every reason a title is currently in this reader's hands
//               that ISN'T a plain download or a bookmark: a pending Elite
//               offer, a subscription loan, active Elite access, and a
//               waiting-queue position, each under its own heading. A title
//               can only ever be in one of the loan buckets at once —
//               `partitionLoansByTier`'s own invariant — so nothing here can
//               show twice.
//   Downloads — unchanged: content actually on this device, sourced from
//               `downloadStore`, never re-derived from a tier.
//   Bookmarks — GROUPED BY TITLE, not one row per bookmark. Tapping a title
//               expands that title's own bookmarks in place.
//   Journals  — articles reached through the journal drill-down, grouped by
//               which journal they came from rather than shown as bare
//               titles mixed in with books elsewhere on this screen. See
//               `articleJournalStore`'s own header for why this needed a new
//               store: nothing in the download/loan/bookmark data model
//               otherwise records which journal an article belongs to.
//
// EVERY TAB RESTATES ITS OWN NAME AS A HEADING, WITH A REAL COUNT BESIDE IT
// WHEN NON-ZERO ("Downloads   2 items"). Tapping a pill already tells the
// reader where they are; the heading is not decoration — the SAME row also
// carries the count, on explicit instruction against a badge on the pill
// itself ("a number beside every filter read as noise"). `All` gets no
// single count of its own (one number cannot honestly describe five kinds
// of row), but its two sub-headings ("Your content", "Premium waiting")
// follow the identical pattern.
//
// A QUIET HINT, NOT A GIANT EMPTY STATE, closes every single-purpose tab —
// `TabHint`. It always renders (an icon plus one line saying what belongs
// here), and gains a bold headline ONLY when the tab is genuinely empty.
// This is deliberately the return of the original screen's own "every
// section teaches itself" idea, at a size a later product pass asked to
// shrink: compact enough to sit under real content without reading as
// leftover space, not a full-page "nothing here" card.
//
// BORROWED IS THE ONE EXCEPTION, on direct instruction, 14 Sep: it holds up
// to four DIFFERENT facts (an offer, a loan, Elite access, a queue position)
// rather than one, and a permanent hint under each of the three that
// happened to be empty read as three stacked apologies rather than a tab
// with real content in it. That tab shows a hint only when ALL FOUR are
// empty — see `renderBorrowedTab`'s own comment.
//
// EVERY ROW ON THIS SCREEN IS ONE `ContentCard`, REGARDLESS OF TAB OR
// SOURCE. `EliteLoanRow`/`EliteQueueRow` (below, beside `BorrowedBookRow`/
// `DownloadRow`/`BookmarkGroupRow`) render Elite's two navigable states
// through it too — only the badge composition (an "Access expires" line, a
// queue position, a progress fraction) tells one row kind from another, the
// same device `BorrowedBookRow`'s due-date badge already used. The two
// bespoke Elite card components this replaced (`EliteActiveAccessCard`,
// `EliteQueueCard`) are gone — they had drifted from `ContentCard`'s own
// image-loading fix (a plain RN `Image` with no `onError` fallback), which
// is exactly the class of inconsistency one shared row shape stops from
// recurring. `ElitePendingAccessCard` is the one exception, and stays a
// dedicated component: it is an ACTION PROMPT (Accept/Reject buttons, no
// tap-through, no chevron), not a navigable content row, so forcing it
// through the same card would mean either losing its two buttons or
// misusing `ContentCard`'s single `action` slot for a two-button decision
// it was never shaped for. Shared between `All` and `Borrowed` regardless —
// one implementation of that state, composed into both views.
//
// EVERY ROW TAPS THROUGH TO THE ITEM'S OWN DETAIL PAGE, THE SAME AS
// CATALOGUE/SEARCH/SHELF. Reading itself happens from that page's own
// ActionBar, not from a direct open on the shelf — `LibraryStackParamList`
// registers `ItemDetail` for exactly this. The exception is a book with
// bookmarks: tapping it (Bookmarks tab, or the `All` tab when it has no
// active loan/download) expands its bookmarks in place instead, and tapping
// one of THOSE opens its own "Read" action, resuming at that bookmark's exact
// saved position through the provider seam below — a capability only this
// screen's own bookmark data can offer and `ItemDetail` cannot reproduce. A
// book that also has a loan/download still navigates to `ItemDetail` as
// before; its bookmark count is just a badge there.
//
// ACCEPT/DECLINE LIVE ON THE OFFER CARD ITSELF, via the same
// `getLicenceSource().acceptOffer`/`.cancelHold` calls `ItemDetailScreen`
// already makes for the identical actions on its own ActionBar — not a new
// implementation of the two buttons, and it deliberately does not silence
// `QueueNotificationHost`'s floating banner for the same offer, mirroring
// `ItemDetailScreen`'s own already-precedented coexistence with it.
//
// NO COMPONENT ON THIS SCREEN READS A CLOCK. Every countdown or due date is a
// difference against the `serverTime` that arrived with the holdings.
// `Date.now()` is called only inside `@hooks/useServerClock`, and only ever
// to measure an ELAPSED interval between two readings of the same clock —
// safe even when that clock is wrong.
//
// UNDER-SHOW, NEVER OVER-SHOW. An unhydrated loan is bucketed as subscription
// rather than briefly claiming Elite (see `partitionLoansByTier`), and an
// offer whose expiry cannot be read still renders rather than being hidden.
//
// TITLES ARE HYDRATED, NOT STORED. `getLibrary` carries item ids; titles,
// covers, formats and access tiers come from ONE `getItemsBatch` call. A
// title that fails to arrive leaves the row rendered against its id with a
// retry, because the reader still has the book — a title is decoration,
// possession is not.
//
// ─── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
//
// A NEW ROUTE FOR A TITLE'S BOOKMARKS. An in-place expansion under the title
// that was just tapped shows the same real rows a pushed screen would, at
// the cost of zero new navigation — a second place that rendered a bookmark
// row would be CONVENTIONS §7's duplication.
//
// A DOWNLOAD SIZE, A DOWNLOAD DATE, A READING-PROGRESS PERCENT, A LOAN
// DURATION, AN ESTIMATED WAIT, A FABRICATED ROW OF ANY KIND. None of these
// are in the data this screen can see — see `downloadedLabel`, `dueLabel`
// and `queueProgressFraction`'s own comments in `LibraryScreen.holdings.ts`
// for exactly which fields the contract drops and why guessing one would be
// worse than omitting it. Sparse real data (today, often exactly one item)
// is rendered exactly as sparse — `TabHint` is what keeps that from looking
// broken rather than a reason to invent more rows.
import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

import type { BookId, Bookmark } from '@/shared/contracts';
import type { ContentFormat, ReaderTargetLike } from '@/features/library/ports';
import { openBook } from '@/features/download/openBook';
import { contentStore } from '@/features/encryption/contentStore';
import { bookmarkTable } from '@/features/sync/stores/bookmarkStore';
import { USER_ID } from '@/features/sync/syncConfig';
import { AccessTierBadge } from '@components/AccessTierBadge';
import { ContentCard } from '@components/ContentCard';
import { ElitePendingAccessCard } from '@components/ElitePendingAccessCard';
import Loader from '@components/Loader';
import { OfflineBanner } from '@components/OfflineBanner';
import { Skeleton } from '@components/Skeleton';
import { type TabItem, Tabs } from '@components/Tabs';
import { getCatalogueSource } from '@config/catalogue';
import { getLicenceSource } from '@config/licence';
import { useNetworkStatus } from '@hooks/useNetworkStatus';
import { type ServerClock, useServerClock } from '@hooks/useServerClock';
import type { BookSummary, Loan } from '@model/types';
import { useArticleJournalStore } from '@store/articleJournalStore';
import { type DownloadRecord, useDownloadStore } from '@store/downloadStore';
import { useExpiredDownloadsStore } from '@store/expiredDownloadsStore';
import { useExpiredLoansStore } from '@store/expiredLoansStore';
import { useLibraryStore } from '@store/libraryStore';
import { useOfferStore } from '@store/offerStore';
import { color, radius, space, type } from '@theme/tokens';

import {
  activeLoans,
  bookmarkFromRow,
  bookmarkLocationLabel,
  type BookmarkGroup,
  collectItemIds,
  downloadedLabel,
  downloadsSummaryLabel,
  dueLabel,
  groupArticlesByJournal,
  groupBookmarksByTitle,
  mergeContentItems,
  type MergedLibraryItem,
  offerCountdownLabel,
  partitionHolds,
  partitionLoansByTier,
  queueLabel,
  queueProgressFraction,
  sortedBookmarks,
  sortedDownloads,
} from './LibraryScreen.holdings';

// How often the offer/queue countdowns re-render. `QueueNotification` also
// re-renders on this cadence; ticking faster would redraw the tree for a
// label that cannot change yet, and slower would let "Expiring now" arrive
// late in the one window that matters most.
const TICK_MS = 30_000;

// The holdings skeleton's row count — a plausible shape for a shelf whose
// length is not yet known, not a count of anything real.
const SKELETON_ROWS = 2;

// A single shared empty map, so "no titles yet" is the same object on every
// render. A fresh `new Map()` would be a new identity each time and re-run
// anything downstream that compares it.
const EMPTY_TITLES: Map<string, BookSummary> = new Map();

// The expiry sweep's own race window — see that effect's own comment. Real
// loan periods run for days; this only needs to outlast the gap between a
// fresh download's server-side borrow and this screen's next successful
// `libraryStore.refresh()`, so a couple of minutes is generous, not tight.
const EXPIRY_SWEEP_GRACE_MS = 2 * 60_000;

type LibraryTabId = 'all' | 'loans' | 'downloads' | 'bookmarks' | 'journals';

// Plain text, no count badge on the pill itself — on explicit instruction: a
// number beside every filter label ("Downloads 1", "Borrowed 0") read as
// noise before the reader had chosen anything. The identical count instead
// appears inside each tab's own content, beside its restated heading — see
// `TabHeading`.
//
// BORROWED NOW COVERS BOTH TIERS. This used to be four sections split across
// two tabs (Borrowed = subscription only; Premium = offered/Elite/waiting) —
// merged on explicit instruction, and safe to merge because
// `partitionLoansByTier`'s own invariant already guarantees the two loan
// lists are disjoint by item: nothing shows twice. The id stays `loans`.
const LIBRARY_TABS: TabItem[] = [
  { id: 'all', label: 'All' },
  { id: 'loans', label: 'Borrowed' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'bookmarks', label: 'Bookmarks' },
  // Articles reached through the journal drill-down, grouped by journal
  // rather than shown as bare titles — see `articleJournalStore`'s own
  // header for why this needs a store at all (nothing else in the
  // download/loan/bookmark data model records which journal an article came
  // from).
  { id: 'journals', label: 'Journals' },
];

// Hand-typed to the one real call this screen makes, the same reason
// `ItemDetailScreen`'s own `navigation` prop is hand-typed rather than one
// stack's generated `NativeStackScreenProps` — this screen's `navigation`
// prop is really `LibraryStackParamList`'s, but writing only the shape used
// means a test can hand it a plain `{ navigate: jest.fn() }` rather than
// standing up a real `NavigationContainer`.
interface LibraryScreenProps {
  navigation: {
    navigate(screen: 'ItemDetail', params: { itemId: string }): void;
    navigate(
      screen: 'LibraryJournal',
      params: { journalWorkId: string; journalTitle: string; itemIds: string[] },
    ): void;
    // A bookmark's own "Read" — see `openBookmark` — opens straight into the
    // real reader/player, the same two routes `ItemDetailScreen`'s Read/Play
    // action already uses, rather than a `LibraryProvider` seam with no real
    // reader wired behind it.
    navigate(
      screen: 'Reader',
      params: {
        bookId: BookId;
        format: ContentFormat;
        title?: string;
        initialTarget?: ReaderTargetLike;
      },
    ): void;
    navigate(
      screen: 'AudioPlayer',
      params: { bookId: BookId; title: string; coverUrl?: string },
    ): void;
  };
}

export default function LibraryScreen({ navigation }: LibraryScreenProps) {
  const loans = useLibraryStore((s) => s.loans);
  const holds = useLibraryStore((s) => s.holds);
  const loading = useLibraryStore((s) => s.loading);
  const refresh = useLibraryStore((s) => s.refresh);
  // See libraryStore.ts's own header: the loans/holds above may be the last
  // SUCCESSFUL read, not a confirmed current one, whenever this is true — most
  // visibly, a due date computed from a `loan.expiresAt` the server may have
  // already changed or dropped.
  const holdingsRefreshFailed = useLibraryStore((s) => s.refreshFailed);
  // Gate for the expiry sweep below — see that effect's own comment on why a
  // cold-start empty `loans` array must never be read as "confirmed: nothing
  // is held".
  const hasSyncedOnce = useLibraryStore((s) => s.hasSyncedOnce);
  // Device-local, so they are not part of `loading` and are not refetched by a
  // pull: there is nothing to fetch. A book on this phone is on this phone
  // whether or not the network answered.
  const downloadRecords = useDownloadStore((s) => s.downloads);
  const isOnline = useNetworkStatus();
  const journalMembership = useArticleJournalStore((s) => s.membership);

  // Titles for the ids the holdings carry. Empty until a batch call lands; a
  // row with no entry renders against its id, which is the documented fallback
  // rather than a missing state.
  const [titles, setTitles] = useState<Map<string, BookSummary>>(EMPTY_TITLES);
  const [hydrationFailed, setHydrationFailed] = useState(false);
  // LOCAL, NOT ROUTE STATE — a filter is not worth a back-stack entry, and it
  // resets to the overview when the reader returns to the tab.
  const [activeTab, setActiveTab] = useState<LibraryTabId>('all');
  // A transient line shown when a bookmark's own "Read" can't resume yet —
  // the reader isn't in this build. Cleared on a successful open once the
  // real provider is mounted.
  const [openNotice, setOpenNotice] = useState<string | undefined>(undefined);
  // Which offer/hold is mid-Accept-or-Decline, and which. One at a time: two
  // concurrent licence calls on the same reader's holds would race each
  // other's `refresh()`.
  const [pendingHoldAction, setPendingHoldAction] = useState<
    { holdId: string; action: 'accept' | 'reject' } | undefined
  >(undefined);
  // A generic failure line for an Elite action or a bookmark-title download —
  // deliberately not itemised per row: this screen has no per-row error
  // affordance today, and a shared pinned notice (same slot `openNotice`
  // already uses) is the smaller thing to build than one for every card.
  const [actionNotice, setActionNotice] = useState<string | undefined>(undefined);
  // Which bookmark GROUP (by book id) is expanded in place. One at a time —
  // the reference mockup shows one title's bookmarks at a time, and a reader
  // flicking between several would otherwise stack every group's rows into
  // one very long screen.
  const [expandedBookId, setExpandedBookId] = useState<string | undefined>(undefined);
  // Which single bookmark is mid-open right now — drives the spinner that
  // replaces its row's chevron, and also doubles as the concurrency guard
  // `openBookmark` used to need a separate ref for (one real state value,
  // not a ref plus a badge, now that the UI needs to observe it too).
  const [openingBookmarkId, setOpeningBookmarkId] = useState<string | undefined>(undefined);
  // Which download is mid-delete, from the Downloads tab's own row action.
  const [deletingItemId, setDeletingItemId] = useState<string | undefined>(undefined);
  // The REAL, synced bookmarks — `bookmarkTable.listActive(USER_ID)` with no
  // `bookId`, which already lists across every book for a user (confirmed:
  // `listActive`'s own SQL only filters on `book_id` when one is passed). An
  // earlier version of this screen read `src/store/bookmarkStore.ts`, a
  // Zustand stand-in that never had anything write to it — this fixes that
  // without changing anything downstream, which still consumes `Bookmark[]`.
  const [bookmarkRecords, setBookmarkRecords] = useState<Bookmark[]>([]);
  // Unlike loans/holds/downloads, bookmarks arrive from an async SQLite read
  // rather than already-hydrated store state, so they are not in hand on the
  // very first render. The hydration batch call below waits on this flag
  // rather than firing once with a bookmark-less id set and again the moment
  // the real bookmark ids arrive — see that effect's own comment.
  const [bookmarksLoaded, setBookmarksLoaded] = useState(false);

  // Loads on mount and again on every change to the real table — a bookmark
  // created just now while reading must show up here without a manual pull,
  // the same reason `ReaderScreen`'s own bookmarks effect subscribes rather
  // than loading once.
  useEffect(() => {
    let cancelled = false;
    const reload = () => {
      void bookmarkTable.listActive(USER_ID).then((rows) => {
        if (cancelled) return;
        // A row whose locator fails to parse is dropped, not surfaced as an
        // error — see `bookmarkFromRow`'s own comment.
        const parsed: Bookmark[] = [];
        for (const row of rows) {
          const bookmark = bookmarkFromRow(row);
          if (bookmark !== null) parsed.push(bookmark);
        }
        setBookmarkRecords(parsed);
        setBookmarksLoaded(true);
      });
    };
    reload();
    const unsubscribe = bookmarkTable.subscribe(reload);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const { offered, waiting } = partitionHolds(holds);
  const live = activeLoans(loans);
  const downloads = sortedDownloads(downloadRecords);
  const bookmarks = sortedBookmarks(bookmarkRecords);
  const { ids, truncated } = collectItemIds({
    offered,
    loans: live,
    downloads,
    bookmarks,
    waiting,
  });

  // The shelf is the launch screen, so it fetches on mount rather than waiting
  // for a pull. `refresh` never rejects — see the store — so there is nothing
  // to catch here, and equally nothing to report.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The identity of "this response". Keyed on the joined ids rather than on the
  // arrays themselves: the store replaces both objects on every refresh, so an
  // identity check would count a refresh that changed nothing as a new response
  // and re-anchor the clock on every poll.
  const idKey = ids.join(',');

  // ONE BATCH CALL PER DISTINCT SET OF IDS. Not per render, and not per row.
  // Gated on `bookmarksLoaded` so the very first call already carries any
  // bookmarked ids — without it, this fires once on mount (loans/downloads
  // only, bookmarks not back yet) and again the instant the async bookmark
  // read resolves and changes `idKey`, double-hitting the catalogue for
  // every load rather than once.
  useEffect(() => {
    if (!bookmarksLoaded || ids.length === 0) return;
    let cancelled = false;
    getCatalogueSource()
      .getItemsBatch(ids)
      .then((result) => {
        if (cancelled) return;
        setTitles(new Map(result.items.map((item) => [item.id, item])));
        setHydrationFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        // The reader still has their books. Fall back to rendering rows against
        // their ids with a retry rather than blanking a shelf over a title.
        setHydrationFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `ids` is rebuilt every render; `idKey` is its stable identity.
  }, [idKey, bookmarksLoaded]);

  const onRefresh = useCallback(() => {
    void refresh();
  }, [refresh]);

  const titleFor = (itemId: string): string => titles.get(itemId)?.title ?? itemId;
  const publisherFor = (itemId: string): string | undefined =>
    titles.get(itemId)?.authors?.join(', ');
  const summaryFor = (itemId: string): BookSummary | undefined => titles.get(itemId);

  // THE EXPIRY SWEEP, on direct instruction: a downloaded Elite or Subscription
  // title whose licence has actually lapsed is deleted from this device, not
  // merely hidden — a stale, unopenable ciphertext sitting in storage the reader
  // cannot read is worse than no file at all. OPEN_ACCESS is never swept (no
  // loan ever backs it, so "no active loan" is its permanent, correct state,
  // not a lapse) and an item whose tier isn't hydrated yet is left alone rather
  // than guessed at.
  //
  // GATED ON `hasSyncedOnce`, NOT JUST "loans is empty" — the cold-start value
  // of `loans` is also an empty array, and treating that as "confirmed: nothing
  // is held" would delete every downloaded Elite/Subscription title on every
  // app launch, before the real answer has even arrived. See libraryStore.ts's
  // own comment on the flag.
  //
  // A GRACE WINDOW, NOT AN IMMEDIATE CHECK — a Subscription download's own
  // borrow happens server-side, invisibly, ahead of the bytes (resolveAccess.ts
  // §7's own comment), so the loan already exists by the time this device's
  // download completes. But THIS screen's own `loans` cache only catches up on
  // its next successful refresh, which can genuinely land before that borrow's
  // effects are visible if Library happens to already be open. Without the
  // window, that ordinary race reads as "no active loan" and deletes a title
  // that was never actually unlicensed for even a moment.
  useEffect(() => {
    if (!hasSyncedOnce) return;
    // SEEDED ON THE NEXT MACROTASK, same reason `useServerClock.ts` reads
    // `Date.now()` inside a `setTimeout` rather than the effect body itself —
    // a direct call here is flagged as an impure read of the render path
    // (react-hooks/purity) even though this effect's own timing has nothing
    // to do with rendering. A `setTimeout(0)` costs nothing observable and
    // keeps the read out of that path.
    const timer = setTimeout(() => {
      const now = Date.now();
      const activeLoanItemIds = new Set(live.map((loan) => loan.itemId));
      for (const record of downloads) {
        const tier = summaryFor(record.itemId)?.accessTier;
        if (tier !== 'ELITE' && tier !== 'SUBSCRIPTION') continue;
        if (activeLoanItemIds.has(record.itemId)) continue;
        if (now - record.downloadedAt < EXPIRY_SWEEP_GRACE_MS) continue;

        const expiredTitle = titleFor(record.itemId);
        void contentStore.destroy(record.itemId as BookId).finally(() => {
          useDownloadStore.getState().removeDownload(record.itemId);
          useExpiredDownloadsStore.getState().recordExpired({
            itemId: record.itemId,
            title: expiredTitle,
            expiredAt: Date.now(),
          });
        });
      }
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `live`/`downloads`/`titleFor`/`summaryFor` are rebuilt every render from `loans`/`downloadRecords`/`titles`, which are already listed.
  }, [hasSyncedOnce, loans, downloadRecords, titles]);

  const expiredDownloadNotices = useExpiredDownloadsStore((s) => s.notices);

  // Every row taps through to the item's own detail page — see the file
  // header. `goToDetail` is the one place that navigation happens, so every
  // row/card below hands this the same itemId rather than building its own
  // `navigation.navigate` call.
  const goToDetail = useCallback(
    (itemId: string) => navigation.navigate('ItemDetail', { itemId }),
    [navigation],
  );

  // Subscription and Elite are still partitioned internally — a subscription
  // loan and an Elite loan render through different rows (`BorrowedBookRow`
  // vs `EliteLoanRow`) even though the Borrowed TAB now shows both together.
  // See `partitionLoansByTier`'s own comment.
  const { subscriptionLoans, eliteLoans } = partitionLoansByTier(live, (itemId) => summaryFor(itemId)?.accessTier);
  const bookmarkGroups = groupBookmarksByTitle(bookmarks);
  // Every id this reader holds, across the same universe `collectItemIds`
  // already gathers for hydration — an item with no journal membership entry
  // is a book (or an article reached some other way) and is silently
  // excluded, not an error. See `groupArticlesByJournal`'s own comment.
  const journalGroups = groupArticlesByJournal(ids, journalMembership);
  // Every article id folded into some journal group above — `All`'s merged
  // content excludes these (see `renderAllTab`) so a journal article shows
  // once, as its journal, rather than twice: once here by its own title and
  // authors line (which read as an unrelated "article + section" row with no
  // journal context at all) and again as its journal on the Journals tab.
  const journalArticleIds = new Set(journalGroups.flatMap((group) => group.articleItemIds));

  // The title shown on the full-screen `Loader` overlay while a bookmark
  // resume is in flight — see that overlay's own comment below. Looked up
  // from `bookmarks`, not `bookmarkGroups`, because a group only carries a
  // book id, and the overlay needs the book's real title the same way every
  // other row on this screen gets one (`titleFor`).
  const openingBookmark =
    openingBookmarkId === undefined ? undefined : bookmarks.find((b) => b.id === openingBookmarkId);
  const openingBookmarkTitle =
    openingBookmark === undefined ? undefined : titleFor(openingBookmark.bookId);

  // Resume a bookmark at its exact saved position: the same real
  // open-then-navigate path `ItemDetailScreen`'s own Read/Play action uses
  // (`openBook` from `@/features/download/openBook`, licence-checked, then
  // `navigation.navigate('Reader'|'AudioPlayer', ...)`) — not the
  // `LibraryProvider` seam, which has no real reader wired behind it (see
  // `standInProvider.ts`'s own header). `ItemDetail` cannot reproduce this
  // exact capability (it has no bookmark position to resume from), which is
  // why this is the one row that does not simply navigate there instead.
  //
  // `openingBookmarkId` guards against a second tap while one resume-open is
  // in flight — two concurrent `openBook` calls would race a licence
  // session — and doubles as the flag both the full-screen `Loader` overlay
  // and each row's own disabled state read, so there is one source of truth
  // instead of a ref plus state.
  const openBookmark = useCallback(
    async (bookmark: Bookmark) => {
      if (openingBookmarkId !== undefined) return;
      setOpeningBookmarkId(bookmark.id);
      try {
        const bookId = bookmark.bookId as BookId;
        const format = bookmark.locator.type;
        await openBook(bookId, format);
        setOpenNotice(undefined);
        if (format === 'AUDIO') {
          const summary = titles.get(bookmark.bookId);
          navigation.navigate('AudioPlayer', {
            bookId,
            title: summary?.title ?? bookmark.bookId,
            coverUrl: summary?.coverUrl,
          });
        } else {
          const summary = titles.get(bookmark.bookId);
          const target = bookmarkTarget(bookmark.locator);
          navigation.navigate('Reader', {
            bookId,
            format,
            title: summary?.title,
            ...(target === undefined ? {} : { initialTarget: target }),
          });
        }
      } catch (err) {
        console.error('[library] bookmark open failed:', err);
        setOpenNotice('Couldn’t open that title. Try again from its detail page.');
      } finally {
        setOpeningBookmarkId(undefined);
      }
    },
    [navigation, titles, openingBookmarkId],
  );

  // Accept/Decline an Elite offer — the same two `LicenceSource` calls
  // `ItemDetailScreen`'s own ActionBar makes for the identical actions. See
  // the file header for why this does not need `QueueNotificationHost` to
  // stand down.
  const handleAcceptOffer = useCallback(
    (holdId: string) => {
      setActionNotice(undefined);
      setPendingHoldAction({ holdId, action: 'accept' });
      getLicenceSource()
        .acceptOffer(holdId)
        // PREVIOUSLY MISSING: nothing here ever cleared offerStore, so QueueNotificationHost's
        // global banner kept offering a copy this exact call just consumed — a ghost offer that
        // survived until its own expiry, tapping it would then fail against a hold that no
        // longer exists. QueueNotificationHost.tsx's own accept/reject already does this; this
        // screen reaches the same LicenceSource action and needs the same cleanup.
        .then(() => useOfferStore.getState().clear())
        .catch(() => setActionNotice('Couldn’t accept that offer. Pull to refresh and try again.'))
        .then(() => refresh())
        .catch(() => {})
        .finally(() => setPendingHoldAction(undefined));
    },
    [refresh],
  );

  const handleRejectOffer = useCallback(
    (holdId: string) => {
      setActionNotice(undefined);
      setPendingHoldAction({ holdId, action: 'reject' });
      getLicenceSource()
        .cancelHold(holdId)
        .then(() => useOfferStore.getState().clear())
        .catch(() => setActionNotice('Couldn’t decline that offer. Pull to refresh and try again.'))
        .then(() => refresh())
        .catch(() => {})
        .finally(() => setPendingHoldAction(undefined));
    },
    [refresh],
  );


  // Delete a download from the Downloads tab's own row action — confirmed
  // first, since it frees real bytes on disk. `contentStore.destroy` (Content/
  // Encryption's own "book deleted" terminal action, `contentStore.ts`'s own
  // doc comment) drops the ciphertext, metadata and key; `removeDownload`
  // drops this device's tracking record so the row itself disappears. Run in
  // that order — a failed `destroy` leaves the row in place with a real error
  // rather than reporting a title as gone while its bytes still sit on disk.
  const handleDeleteDownload = useCallback((deleteItemId: string) => {
    Alert.alert(
      'Delete download?',
      'This removes it from your device. You can download it again anytime.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setActionNotice(undefined);
            setDeletingItemId(deleteItemId);
            contentStore
              .destroy(deleteItemId as BookId)
              .then(() => useDownloadStore.getState().removeDownload(deleteItemId))
              .catch(() => setActionNotice('Couldn’t delete that download. Try again.'))
              .finally(() => setDeletingItemId(undefined));
          },
        },
      ],
    );
  }, []);

  // Any row will do — `serverTime` is stamped once for the whole response, so
  // every loan and hold in one response carries the same value.
  const clock = useServerClock(offered[0]?.serverTime ?? waiting[0]?.serverTime, idKey, TICK_MS);

  // ELITE-LOAN-EXPIRY NOTICE — separate from the download-expiry sweep above,
  // and for a different reason: that sweep only ever fires for a title that
  // was also DOWNLOADED. An Elite title read online without ever being
  // downloaded just vanished from this screen the moment its loan lapsed,
  // with nothing to say why once it was gone — Library's own list already
  // drops it for free (it only ever renders `activeLoans(loans)`), but
  // dropping it silently is the gap this effect closes.
  //
  // A LOAN CAN ALSO DISAPPEAR BECAUSE THE READER CHOSE TO END IT.
  // `ItemDetailScreen`'s own "Revoke licence" action (the ELITE branch of
  // `resolveAccess.ts`) calls the identical `returnLoan` a real expiry would
  // eventually trigger server-side, and both leave the SAME footprint here —
  // the loan is just gone on the next refresh. They must not read the same to
  // the reader: telling someone "your access expired" for a title they just
  // chose to give back would be a wrong, confusing claim. The loan's own
  // `expiresAt` is what tells the two apart — a loan that vanished AFTER its
  // stated expiry has genuinely lapsed; one that vanished BEFORE it was ended
  // some other way, and gets no notice here.
  const prevEliteLoansRef = useRef<Loan[] | undefined>(undefined);
  useEffect(() => {
    if (!hasSyncedOnce || !clock.ready) return;
    const prevLoans = prevEliteLoansRef.current;
    prevEliteLoansRef.current = eliteLoans;
    // The FIRST successful sync only ever seeds the baseline — there is
    // nothing to compare a cold start against, and treating "nothing seen
    // yet" as "everything just expired" would fire a notice for every Elite
    // loan the reader already held before this screen ever opened.
    if (prevLoans === undefined) return;
    const stillHeld = new Set(eliteLoans.map((loan) => loan.itemId));
    const deviceNowMs = clock.nowMs + clock.offsetMs;
    const lapsed = prevLoans.filter(
      (loan) => !stillHeld.has(loan.itemId) && loan.expiresAt !== undefined && deviceNowMs >= loan.expiresAt,
    );
    if (lapsed.length === 0) return;
    // SEEDED ON THE NEXT MACROTASK — see the download-expiry sweep's own
    // comment above on why `Date.now()` cannot be read directly in an effect
    // body (react-hooks/purity).
    const timer = setTimeout(() => {
      for (const loan of lapsed) {
        useExpiredLoansStore.getState().recordExpired({
          itemId: loan.itemId,
          title: titleFor(loan.itemId),
          expiredAt: Date.now(),
        });
      }
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `titleFor` is rebuilt every render from `titles`, not an independent input.
  }, [hasSyncedOnce, eliteLoans, clock.ready, clock.nowMs, clock.offsetMs]);

  const expiredLoanNotices = useExpiredLoansStore((s) => s.notices);

  // FIRST LOAD OF THE SERVER-SOURCED HOLDINGS ONLY. Downloads and bookmarks are
  // already in hand — they came off this device — so a whole-screen skeleton
  // would hide rows that are ready in order to wait for rows that are not.
  const holdingsLoading = loading && live.length === 0 && holds.length === 0;

  function renderPendingOffers(): ReactNode {
    return offered.map((hold) => {
      const holdId = hold.holdId;
      if (holdId === undefined) return null;
      const expiryLabel = clock.ready ? offerCountdownLabel(hold, clock.offsetMs, clock.nowMs) : undefined;
      const pending = pendingHoldAction?.holdId === holdId ? pendingHoldAction.action : undefined;
      return (
        <View key={holdId} style={styles.row}>
          <ElitePendingAccessCard
            title={titleFor(hold.itemId)}
            {...(expiryLabel === undefined ? {} : { expiryLabel })}
            {...(pending === undefined ? {} : { pending })}
            onAccept={() => handleAcceptOffer(holdId)}
            onReject={() => handleRejectOffer(holdId)}
          />
        </View>
      );
    });
  }

  function renderEliteActiveLoans(): ReactNode {
    return eliteLoans.map((loan) => (
      <View key={loan.loanId ?? loan.itemId} style={styles.row}>
        <EliteLoanRow
          loan={loan}
          title={titleFor(loan.itemId)}
          publisher={publisherFor(loan.itemId)}
          summary={summaryFor(loan.itemId)}
          clock={clock}
          onPress={() => goToDetail(loan.itemId)}
        />
      </View>
    ));
  }

  function renderSubscriptionLoans(): ReactNode {
    return subscriptionLoans.map((loan) => (
      <View key={loan.loanId ?? loan.itemId} style={styles.row}>
        <BorrowedBookRow
          loan={loan}
          title={titleFor(loan.itemId)}
          publisher={publisherFor(loan.itemId)}
          summary={summaryFor(loan.itemId)}
          clock={clock}
          onPress={() => goToDetail(loan.itemId)}
        />
      </View>
    ));
  }

  function renderDownloadRows(): ReactNode {
    return downloads.map((record) => (
      <View key={record.itemId} style={styles.row}>
        <DownloadRow
          record={record}
          title={titleFor(record.itemId)}
          publisher={publisherFor(record.itemId)}
          summary={summaryFor(record.itemId)}
          onPress={() => goToDetail(record.itemId)}
          onDelete={() => handleDeleteDownload(record.itemId)}
          deleting={deletingItemId === record.itemId}
        />
      </View>
    ));
  }

  function renderBookmarkGroups(): ReactNode {
    return bookmarkGroups.map((group) => (
      <View key={group.bookId} style={styles.row}>
        <BookmarkGroupRow
          group={group}
          title={titleFor(group.bookId)}
          expanded={expandedBookId === group.bookId}
          openingBookmarkId={openingBookmarkId}
          onToggle={() =>
            setExpandedBookId((current) => (current === group.bookId ? undefined : group.bookId))
          }
          onRead={(bookmark) => void openBookmark(bookmark)}
        />
      </View>
    ));
  }

  function renderWaitingQueue(): ReactNode {
    return waiting.map((hold) => {
      const summary = summaryFor(hold.itemId);
      return (
        <View key={hold.holdId ?? hold.itemId} style={styles.row}>
          <EliteQueueRow
            title={titleFor(hold.itemId)}
            {...(summary?.coverUrl === undefined ? {} : { imageUrl: summary.coverUrl })}
            {...(summary?.format === undefined ? {} : { format: summary.format })}
            {...(queueLabel(hold) === undefined ? {} : { queueLabel: queueLabel(hold) })}
            {...(queueProgressFraction(hold) === undefined
              ? {}
              : { progressFraction: queueProgressFraction(hold) })}
            onPress={() => goToDetail(hold.itemId)}
          />
        </View>
      );
    });
  }

  // One row per BOOK, not per fact about it — see `mergeContentItems`'s own
  // comment. Replaces calling `renderEliteActiveLoans`/`renderSubscription-
  // Loans`/`renderDownloadRows`/`renderBookmarkGroups` back to back in
  // `All`, which is what put "Playful Identities" on screen twice (once for
  // its loan, once for its download) — a real reader-visible defect this
  // function exists to fix, not four separate lists this tab happens to
  // concatenate.
  function renderMergedContentRow(item: MergedLibraryItem): ReactNode {
    const summary = summaryFor(item.itemId);

    // An Elite loan still gets its own branch, whether or not it happens to
    // also be bookmarked — Elite can never also be a download (see
    // `mergeContentItems`'s own comment) and always shows the fixed "Access
    // expires" + ELITE-tier badge pair rather than the tier-from-summary
    // badge every other row below computes. It renders through the SAME
    // `EliteLoanRow` (→ `ContentCard`) as every other row on this screen —
    // only the badge composition differs, not the card.
    if (item.isElite && item.loan !== undefined) {
      return (
        <View key={item.itemId} style={styles.row}>
          <EliteLoanRow
            loan={item.loan}
            title={titleFor(item.itemId)}
            publisher={publisherFor(item.itemId)}
            summary={summary}
            clock={clock}
            onPress={() => goToDetail(item.itemId)}
          />
        </View>
      );
    }

    // Bookmark-only (no loan, no download): tapping expands this book's
    // bookmarks in place, same as the dedicated Bookmarks tab, instead of
    // navigating to ItemDetail — there is no borrow/download state here that
    // page would otherwise need to show. A book that ALSO has a loan or
    // download keeps navigating below; its bookmark count stays a badge.
    if (item.bookmarkGroup !== undefined && item.loan === undefined && item.download === undefined) {
      return (
        <View key={item.itemId} style={styles.row}>
          <BookmarkGroupRow
            group={item.bookmarkGroup}
            title={titleFor(item.itemId)}
            expanded={expandedBookId === item.itemId}
            openingBookmarkId={openingBookmarkId}
            onToggle={() =>
              setExpandedBookId((current) => (current === item.itemId ? undefined : item.itemId))
            }
            onRead={(bookmark) => void openBookmark(bookmark)}
          />
        </View>
      );
    }

    const badges: ReactNode[] = [];

    if (item.loan !== undefined) {
      const due = clock.ready ? dueLabel(item.loan, clock.offsetMs, clock.nowMs) : undefined;
      if (due !== undefined) badges.push(<Text key="due" style={styles.badgeLabel}>{due}</Text>);
    }
    if (summary !== undefined && item.loan !== undefined) {
      badges.push(<AccessTierBadge key="tier" tier={summary.accessTier} />);
    }
    if (item.download !== undefined) {
      badges.push(
        <Text key="download" style={styles.badgeLabel}>
          {downloadedLabel(item.download)}
        </Text>,
      );
    }
    if (item.bookmarkGroup !== undefined) {
      const count = item.bookmarkGroup.bookmarks.length;
      badges.push(
        <Text key="bookmarks" style={styles.badgeLabel}>
          {count === 1 ? '1 bookmark' : `${count} bookmarks`}
        </Text>,
      );
    }

    return (
      <View key={item.itemId} style={styles.row}>
        <ContentCard
          title={titleFor(item.itemId)}
          onPress={() => goToDetail(item.itemId)}
          {...(publisherFor(item.itemId) === undefined ? {} : { publisher: publisherFor(item.itemId) })}
          {...(summary?.coverUrl === undefined ? {} : { imageUrl: summary.coverUrl })}
          {...(summary?.format === undefined ? {} : { format: summary.format })}
          {...(badges.length === 0
            ? {}
            : { badge: <View style={styles.badgeStack}>{badges}</View> })}
          {...(item.download === undefined
            ? {}
            : {
                action: (
                  <DeleteDownloadButton
                    title={titleFor(item.itemId)}
                    onDelete={() => handleDeleteDownload(item.itemId)}
                    deleting={deletingItemId === item.itemId}
                  />
                ),
              })}
        />
      </View>
    );
  }

  function renderAllTab(): ReactNode {
    if (holdingsLoading) {
      return (
        <>
          {renderPendingOffers()}
          <HoldingsSkeleton />
        </>
      );
    }

    // A journal article is excluded here and rendered as its JOURNAL instead
    // (below) — otherwise it shows up by its own title with its authors line
    // underneath, which carries no journal context at all and reads as an
    // unrelated book. See `journalArticleIds`'s own comment.
    const mergedContent = mergeContentItems(eliteLoans, subscriptionLoans, downloads, bookmarkGroups).filter(
      (item) => !journalArticleIds.has(item.itemId),
    );
    const hasContent = mergedContent.length > 0 || journalGroups.length > 0;
    const hasWaiting = waiting.length > 0;

    if (!hasContent && !hasWaiting && offered.length === 0) {
      return <Text style={styles.sectionEmpty}>Your library is empty right now.</Text>;
    }

    return (
      <>
        {renderPendingOffers()}
        {hasContent && (
          <View style={styles.section}>
            <TabHeading title="Your content" count={mergedContent.length + journalGroups.length} />
            {mergedContent.map(renderMergedContentRow)}
            {journalGroups.length > 0 && renderJournalGroups()}
          </View>
        )}
        {hasWaiting && (
          <View style={styles.section}>
            <TabHeading title="Premium waiting" count={waiting.length} />
            {renderWaitingQueue()}
          </View>
        )}
      </>
    );
  }

  // Borrowed and Premium, merged into one tab on explicit instruction — safe
  // because `partitionLoansByTier`'s own invariant guarantees a title can
  // never be both a subscription and an Elite loan, so nothing here can show
  // twice. UNLIKE THE OTHER SINGLE-PURPOSE TABS, none of the four facts (an
  // offer, a subscription loan, an Elite loan, a queue position) gets a
  // permanent `TabHint` of its own any more — see `renderBorrowedTab`'s own
  // comment for why that reversed.
  function renderBorrowedTab(): ReactNode {
    if (holdingsLoading) return <HoldingsSkeleton />;

    // EACH OF THE FOUR FACTS RENDERS ONLY WHEN IT'S TRUE, on direct
    // instruction, 14 Sep — this used to always render all three of
    // Borrowed/Elite/Waiting, each with its own permanent `TabHint` even
    // while genuinely empty ("No items currently borrowed.", etc.), which
    // read as three stacked apologies rather than a tab with content in it.
    // A reader with only an Elite loan now sees exactly that one section,
    // not two empty ones either side of it.
    const hasAnything =
      offered.length > 0 || subscriptionLoans.length > 0 || eliteLoans.length > 0 || waiting.length > 0;

    if (!hasAnything) {
      return (
        <TabHint
          icon="library-outline"
          headline="Nothing borrowed or waiting on right now."
          caption="Titles you borrow, Elite access you hold, and any Elite queue you’re waiting in will all appear here."
        />
      );
    }

    return (
      <>
        {offered.length > 0 && (
          <View style={styles.section}>
            <TabHeading title="Access available" count={offered.length} />
            {renderPendingOffers()}
          </View>
        )}

        {subscriptionLoans.length > 0 && (
          <View style={styles.section}>
            <TabHeading title="Borrowed" count={subscriptionLoans.length} />
            {renderSubscriptionLoans()}
          </View>
        )}

        {eliteLoans.length > 0 && (
          <View style={styles.section}>
            <TabHeading title="Your Elite access" count={eliteLoans.length} />
            {renderEliteActiveLoans()}
          </View>
        )}

        {waiting.length > 0 && (
          <View style={styles.section}>
            <TabHeading title="Waiting for access" count={waiting.length} />
            {renderWaitingQueue()}
          </View>
        )}
      </>
    );
  }

  function renderDownloadsTab(): ReactNode {
    const count = downloads.length;
    // `downloadsSummaryLabel` restates the same count on its own ("1 item")
    // when no download reported a size — `TabHeading`'s count already says
    // that, so the caption only earns its own line when it adds the size
    // ("· 22.8 MB") on top.
    const sizeLabel = downloadsSummaryLabel(downloads);
    const showSizeCaption = sizeLabel !== undefined && sizeLabel.includes('·');
    return (
      <>
        <TabHeading title="Downloads" count={count} />
        {count > 0 && (
          <>
            {showSizeCaption && <Text style={styles.sizeCaption}>{sizeLabel}</Text>}
            {renderDownloadRows()}
          </>
        )}
        <TabHint
          icon="download-outline"
          headline={count === 0 ? 'No downloads yet.' : undefined}
          caption="Only items you’ve downloaded will appear here."
        />
      </>
    );
  }

  function renderBookmarksTab(): ReactNode {
    const count = bookmarkGroups.length;
    return (
      <>
        <TabHeading title="Bookmarks" count={count} />
        {count > 0 && renderBookmarkGroups()}
        <TabHint
          icon="bookmark-outline"
          headline={count === 0 ? 'No bookmarked pages yet.' : undefined}
          caption="Pages you bookmark while reading will appear here."
        />
      </>
    );
  }

  // One row per JOURNAL, not per article — an article with no membership
  // entry never reaches `journalGroups` at all (see `groupArticlesByJournal`),
  // so every row here is real. Tapping navigates to this reader's own
  // article list for that journal (`LibraryJournalScreen`), NOT the
  // catalogue's Journal Details/Volumes & Issues browse — that flow needs a
  // live `getWork` call and an institution context this screen has no
  // business repeating for a journal the reader has already been reading.
  function renderJournalGroups(): ReactNode {
    return journalGroups.map((group) => (
      <View key={group.journalWorkId} style={styles.row}>
        <ContentCard
          title={group.journalTitle}
          onPress={() =>
            navigation.navigate('LibraryJournal', {
              journalWorkId: group.journalWorkId,
              journalTitle: group.journalTitle,
              itemIds: group.articleItemIds,
            })
          }
          badge={
            <Text style={styles.badgeLabel}>
              {group.articleItemIds.length === 1
                ? '1 article'
                : `${group.articleItemIds.length} articles`}
            </Text>
          }
        />
      </View>
    ));
  }

  function renderJournalsTab(): ReactNode {
    const count = journalGroups.length;
    return (
      <>
        <TabHeading title="Journals" count={count} />
        {count > 0 && renderJournalGroups()}
        <TabHint
          icon="albums-outline"
          headline={count === 0 ? 'No journal articles yet.' : undefined}
          caption="Articles you open from a journal will appear here, grouped by journal."
        />
      </>
    );
  }

  return (
    <View style={styles.screen} testID="library-screen">
      <OfflineBanner visible={!isOnline} />

      {/* PINNED ABOVE THE SCROLL: a heading and a filter that scrolled away
          would leave a reader deep in Bookmarks with no way back to the
          overview but a flick to the top. */}
      <View style={styles.headerBlock}>
        <Text style={styles.libraryHeading}>Library</Text>
        <Text style={styles.librarySubtitle}>Your scholarly content and access in one place.</Text>
        {/* A real, accurate caveat, not a hedge — a downloaded title's bytes
            stay on this phone, but the LICENCE behind them is checked and
            can lapse automatically the next time the app syncs, even if
            that sync happens while the device is offline (a queued check
            resolving the moment connectivity returns). Telling the reader
            this in advance is cheaper than them discovering a "still
            downloaded" book that no longer opens — see `DownloadRow`'s own
            comment on why this screen cannot promise a download stays
            readable. */}
        
      </View>

      <View style={styles.tabBar}>
        <Tabs
          tabs={LIBRARY_TABS}
          activeId={activeTab}
          variant="pills"
          // The five partitions are fixed, so the bar is a control with a known
          // width rather than a strip that continues off-screen.
          fill
          onChange={(id) => setActiveTab(id as LibraryTabId)}
        />
      </View>

      {/* PINNED, not inside the scroll: feedback for a tap the reader just made
          on a row that may be well below the fold. */}
      {(openNotice !== undefined || actionNotice !== undefined) && (
        <Text style={[styles.notice, styles.pinnedNotice]} testID="library-open-notice">
          {openNotice ?? actionNotice}
        </Text>
      )}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={onRefresh} />}
        testID="library-scroll"
      >
        {expiredDownloadNotices.length > 0 && (
          <View style={styles.expiredNoticeContainer} testID="expired-downloads-notice">
            <Text style={styles.expiredNoticeText}>
              {expiredDownloadNotices.length === 1
                ? `“${expiredDownloadNotices[0].title}” was removed from this device because its licence ended.`
                : `${expiredDownloadNotices.length} downloads were removed from this device because their licences ended.`}
            </Text>
            <Pressable
              onPress={() => useExpiredDownloadsStore.getState().dismissAll()}
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
              hitSlop={8}
            >
              <Text style={styles.expiredNoticeDismiss}>Dismiss</Text>
            </Pressable>
          </View>
        )}

        {expiredLoanNotices.length > 0 && (
          <View style={styles.expiredNoticeContainer} testID="expired-loans-notice">
            <Text style={styles.expiredNoticeText}>
              {expiredLoanNotices.length === 1
                ? `Your access to “${expiredLoanNotices[0].title}” expired and it was removed from your library.`
                : `Your access to ${expiredLoanNotices.length} titles expired and they were removed from your library.`}
            </Text>
            <Pressable
              onPress={() => useExpiredLoansStore.getState().dismissAll()}
              accessibilityRole="button"
              accessibilityLabel="Dismiss"
              hitSlop={8}
            >
              <Text style={styles.expiredNoticeDismiss}>Dismiss</Text>
            </Pressable>
          </View>
        )}

        {holdingsRefreshFailed && (
          <Text style={styles.notice} testID="library-holdings-stale">
            Couldn’t confirm your current access. Due dates and loan status below may be out of
            date — pull to try again.
          </Text>
        )}

        {hydrationFailed && (
          <Text style={styles.notice}>
            Titles couldn’t be loaded. Pull to try again — your books are still here.
          </Text>
        )}

        {truncated > 0 && (
          <Text style={styles.notice}>
            Showing your {ids.length} most recent items. {truncated} more are in your loan history.
          </Text>
        )}

        {activeTab === 'all' && renderAllTab()}
        {activeTab === 'loans' && renderBorrowedTab()}
        {activeTab === 'downloads' && renderDownloadsTab()}
        {activeTab === 'bookmarks' && renderBookmarksTab()}
        {activeTab === 'journals' && renderJournalsTab()}
      </ScrollView>

      {/* `openBook()`'s real wait (licence check + decrypt) happens HERE, before
          navigation — same overlay-not-replacement shape as
          `ItemDetailScreen.tsx`'s own "Opening…" gate for its Read/Play
          action. The screen underneath stays mounted (every bookmark row's
          own `disabled={busy}` is still the real duplicate-press guard); this
          only replaces what used to be a small spinner swapped in for one
          row's chevron with the same full-screen loader every other "please
          wait" in this app uses. */}
      {openingBookmarkId !== undefined && (
        <View style={StyleSheet.absoluteFill}>
          <Loader
            title={openingBookmarkTitle === undefined ? undefined : `Opening ${openingBookmarkTitle}…`}
            testID="library-bookmark-opening"
          />
        </View>
      )}
    </View>
  );
}

// ─── loading ─────────────────────────────────────────────────────────────────

function HoldingsSkeleton() {
  return (
    <View testID="library-loading">
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <View key={i} style={styles.skeletonRow}>
          <Skeleton variant="block" width={48} height={64} />
          <View style={styles.skeletonText}>
            <Skeleton variant="text" width="70%" height={16} />
            <Skeleton variant="text" width="40%" height={12} />
          </View>
        </View>
      ))}
    </View>
  );
}

// ─── heading + hint ──────────────────────────────────────────────────────────

// A tab's own name, restated as a page heading, with a real count beside it
// when non-zero — see the file header for why this replaced a badge on the
// tab pill itself. `count === undefined` and `count === 0` both draw no
// number: a heading with "0 items" reads as an apology, where the hint
// block below already says the same thing at greater length.
function TabHeading({ title, count }: { title: string; count?: number }) {
  // A stable, title-derived testID — the tab pill and an Elite card can both
  // carry the exact same words ("Bookmarks", "Access available"), and a test
  // asserting on this specific heading needs a way to say which one it means.
  const testId = `tab-heading-${title.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <View style={styles.tabHeadingRow}>
      <Text testID={testId} style={styles.tabHeadingTitle}>
        {title}
      </Text>
      {count !== undefined && count > 0 && (
        <Text testID={`${testId}-count`} style={styles.tabHeadingCount}>
          {count === 1 ? '1 item' : `${count} items`}
        </Text>
      )}
    </View>
  );
}

// The compact, permanent footer under a single-purpose tab — see the file
// header's "A QUIET HINT" note. `headline` is optional and appears ONLY for
// the genuinely-empty case; a non-empty tab still gets the plain `caption`
// underneath its real rows, unchanged, so the explanation of what this tab
// is for never disappears just because it now has something in it.
function TabHint({
  icon,
  headline,
  caption,
  iconSet = 'ionicons',
}: {
  icon: string;
  headline?: string;
  caption: string;
  iconSet?: 'ionicons' | 'material';
}) {
  return (
    <View style={styles.hint}>
      <View style={styles.hintIconWrap}>
        {iconSet === 'material' ? (
          // Only `crown-outline` (Elite) needs MaterialCommunityIcons — every
          // other hint icon is a plain Ionicon, same as the rest of this file.
          <MaterialCommunityIcons
            name={icon as ComponentProps<typeof MaterialCommunityIcons>['name']}
            size={type.pageTitle.size}
            color={color.primary}
          />
        ) : (
          <Ionicons
            name={icon as ComponentProps<typeof Ionicons>['name']}
            size={type.pageTitle.size}
            color={color.primary}
          />
        )}
      </View>
      {headline !== undefined && <Text style={styles.hintHeadline}>{headline}</Text>}
      <Text style={styles.hintCaption}>{caption}</Text>
    </View>
  );
}

// ─── rows ────────────────────────────────────────────────────────────────────

// The mockup's "Reading Now" card, minus the one thing this app cannot know:
// the reading PROGRESS (percent, page x/y, "28 min left") lives behind CAP-7's
// reader, which is not in this repo, so inventing "64%" would be exactly the
// over-show the rest of this screen refuses. What the card CAN carry is real
// — the cover, the file format, the access tier, and the due date — so it
// carries those and stops there.
//
// SUBSCRIPTION LOANS ONLY reach this row now — an Elite loan uses
// `EliteLoanRow` instead, for its own Elite-flavoured badge (a fixed
// "Access expires" + ELITE-tier pair rather than the tier-from-summary
// badge below).
function BorrowedBookRow({
  loan,
  title,
  publisher,
  summary,
  clock,
  onPress,
}: {
  loan: Loan;
  title: string;
  publisher?: string;
  summary?: BookSummary;
  clock: ServerClock;
  /** Tap → this item's detail page. */
  onPress: () => void;
}) {
  // Held back until the clock has a sample, for the same reason as the offer
  // countdown. A due date is far less urgent than an offer, but a row that
  // said "Due in 19710 days" for one frame is worse than one that says nothing.
  const due = clock.ready ? dueLabel(loan, clock.offsetMs, clock.nowMs) : undefined;
  // The due date and the tier pill share one badge slot, stacked. Both are
  // optional: no tier until the batch call lands, no due line until the clock
  // has a sample, and an empty stack collapses to no badge at all.
  const badge =
    due === undefined && summary === undefined ? undefined : (
      <View style={styles.badgeStack}>
        {due !== undefined && <Text style={styles.badgeLabel}>{due}</Text>}
        {summary !== undefined && <AccessTierBadge tier={summary.accessTier} />}
      </View>
    );
  return (
    <ContentCard
      title={title}
      onPress={onPress}
      {...(publisher === undefined ? {} : { publisher })}
      {...(summary?.coverUrl === undefined ? {} : { imageUrl: summary.coverUrl })}
      {...(summary?.format === undefined ? {} : { format: summary.format })}
      {...(badge === undefined ? {} : { badge })}
    />
  );
}

// An Elite title the reader currently holds — access already granted, not
// queued. Same card as every other row on this screen (CONVENTIONS §7: one
// row shape, not a component per business state) — only the badge differs.
//
// FORMERLY ITS OWN COMPONENT (`EliteActiveAccessCard`), NOW RETIRED. That
// version drew its cover with plain RN `Image` and no `onError` fallback, so
// a signed URL that failed to load (this app's known cloud-storage rate-limit
// issue) rendered a blank box instead of `ContentCard`'s placeholder icon —
// a real, visible inconsistency between an Elite row and every other row on
// this same screen. Routing through `ContentCard` fixes that for free, since
// there is now only one image-loading path to keep correct.
function EliteLoanRow({
  loan,
  title,
  publisher,
  summary,
  clock,
  onPress,
}: {
  loan: Loan;
  title: string;
  publisher?: string;
  summary?: BookSummary;
  clock: ServerClock;
  /** Tap → this item's detail page. */
  onPress: () => void;
}) {
  const expiresLabel =
    clock.ready && loan.expiresAt !== undefined ? dueLabel(loan, clock.offsetMs, clock.nowMs) : undefined;
  return (
    <ContentCard
      title={title}
      onPress={onPress}
      {...(publisher === undefined ? {} : { publisher })}
      {...(summary?.coverUrl === undefined ? {} : { imageUrl: summary.coverUrl })}
      {...(summary?.format === undefined ? {} : { format: summary.format })}
      badge={
        <View style={styles.badgeStack}>
          {expiresLabel !== undefined && (
            <Text style={styles.badgeLabel}>{`Access expires: ${expiresLabel}`}</Text>
          )}
          <AccessTierBadge tier="ELITE" />
        </View>
      }
    />
  );
}

// An Elite title the reader is waiting for — a real place in a real queue,
// same card and same "formerly its own component" reasoning as
// `EliteLoanRow` above (the retired `EliteQueueCard` had the identical
// blank-cover-on-load-failure bug). `progress` is `ContentCard`'s own slot
// for exactly this fraction — see that file's header comment on why it takes
// an already-derived number rather than computing one itself.
function EliteQueueRow({
  title,
  imageUrl,
  format,
  queueLabel: label,
  progressFraction,
  onPress,
}: {
  title: string;
  imageUrl?: string;
  format?: string;
  /** "#3 of 7" — see `queueLabel`. Absent renders no line. */
  queueLabel?: string;
  /** 0–1 fill toward the front — see `queueProgressFraction`. Absent draws no bar. */
  progressFraction?: number;
  /** Tap → this item's detail page. */
  onPress: () => void;
}) {
  return (
    <ContentCard
      title={title}
      onPress={onPress}
      {...(imageUrl === undefined ? {} : { imageUrl })}
      {...(format === undefined ? {} : { format })}
      badge={
        <View style={styles.badgeStack}>
          {label !== undefined && <Text style={styles.badgeLabel}>{label}</Text>}
          <AccessTierBadge tier="ELITE" />
        </View>
      }
      {...(progressFraction === undefined ? {} : { progress: progressFraction })}
    />
  );
}

// A book whose bytes are on this phone.
//
// STILL NO "Read offline" BUTTON — opening it goes through `ItemDetail`'s own
// Read/Play action like every other row on this screen (see the file
// header), which decrypts through `openBook` regardless of tab. DELETE now
// IS WIRED: `onDelete` calls `contentStore.destroy` (takes the ciphertext,
// metadata and wrapped key with it, not just this device's tracking record —
// see `handleDeleteDownload`'s own comment), so this row no longer risks
// reporting free space that was never actually freed.
//
// IT DOES NOT SAY WHETHER THE BOOK STILL OPENS. See `downloadedLabel`: this
// screen knows a download happened, not that the licence behind it is still
// alive, and `isAvailableOffline` is the only thing that can tell them apart.
function DownloadRow({
  record,
  title,
  publisher,
  summary,
  onPress,
  onDelete,
  deleting,
}: {
  record: DownloadRecord;
  title: string;
  publisher?: string;
  summary?: BookSummary;
  /** Tap → this item's detail page. */
  onPress: () => void;
  /** Confirms, then deletes — see `handleDeleteDownload`'s own comment. */
  onDelete: () => void;
  /** This row's own delete call is in flight — disables the button so a
   * second tap cannot fire a second `contentStore.destroy` for the same id. */
  deleting: boolean;
}) {
  return (
    <ContentCard
      title={title}
      onPress={onPress}
      {...(publisher === undefined ? {} : { publisher })}
      {...(summary?.coverUrl === undefined ? {} : { imageUrl: summary.coverUrl })}
      // The format is the book's real type from the batch call; the
      // "Downloaded" badge stays on `downloadedLabel`'s own honest wording.
      {...(summary?.format === undefined ? {} : { format: summary.format })}
      badge={<Text style={styles.badgeLabel}>{downloadedLabel(record)}</Text>}
      action={<DeleteDownloadButton title={title} onDelete={onDelete} deleting={deleting} />}
    />
  );
}

// Shared between `DownloadRow` (the Downloads tab) and `renderMergedContentRow`
// (the All tab) — a download is a download regardless of which tab a reader
// found it on, and the All tab is the one most readers land on first, so
// scoping delete to the Downloads tab alone (the original shape here) left it
// looking missing entirely to a reader who never switches tabs.
//
// A nested Pressable inside `ContentCard`'s own — see that file's `action` doc
// comment: it claims the touch itself, so deleting never also navigates to
// the detail page.
function DeleteDownloadButton({
  title,
  onDelete,
  deleting,
}: {
  title: string;
  /** Confirms, then deletes — see `handleDeleteDownload`'s own comment. */
  onDelete: () => void;
  /** This row's own delete call is in flight — disables the button so a
   * second tap cannot fire a second `contentStore.destroy` for the same id. */
  deleting: boolean;
}) {
  return (
    <Pressable
      testID="download-delete-button"
      onPress={onDelete}
      disabled={deleting}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={`Delete ${title} from this device`}
    >
      <Ionicons name={deleting ? 'hourglass-outline' : 'trash-outline'} size={20} color={color.textSecondary} />
    </Pressable>
  );
}

// One book's worth of bookmarks, collapsed to a title row until tapped.
//
// GROUPED, NOT ONE ROW PER BOOKMARK. The count badge is
// `group.bookmarks.length`, the same array the list below renders, so the
// two cannot disagree. Each bookmark is its own single-tap row — tapping it
// resumes reading at THAT saved position directly, rather than opening a
// second menu underneath it (a menu with exactly one entry, "Read", was
// never earning the extra tap). Download has no place in this list either:
// it is a whole-book action that belongs on the item's own detail page, not
// mixed in among reading positions.
function BookmarkGroupRow({
  group,
  title,
  expanded,
  openingBookmarkId,
  onToggle,
  onRead,
}: {
  group: BookmarkGroup;
  title: string;
  expanded: boolean;
  /** Which bookmark, if any, is currently opening — drives its row's spinner
   * and disables every OTHER row for the same reason `openBookmark` itself
   * refuses a second concurrent open. */
  openingBookmarkId: string | undefined;
  onToggle: () => void;
  /** Tap a bookmark → resume at THAT bookmark's own saved position. */
  onRead: (bookmark: Bookmark) => void;
}) {
  const count = group.bookmarks.length;
  const busy = openingBookmarkId !== undefined;
  return (
    <View>
      <ContentCard
        title={title}
        onPress={onToggle}
        badge={<Text style={styles.badgeLabel}>{count === 1 ? '1 bookmark' : `${count} bookmarks`}</Text>}
      />

      {expanded && (
        <View testID={`bookmark-group-${group.bookId}`} style={styles.bookmarkList}>
          {group.bookmarks.map((bookmark, index) => {
            // A reader-typed name outranks a raw position — see
            // `bookmarkLocationLabel`'s own comment on why an EPUB CFI never
            // reaches the screen as text. Neither is invented: a bookmark with
            // no name and no derivable position falls back to its ordinal.
            const label = bookmark.name ?? bookmarkLocationLabel(bookmark) ?? `Bookmark ${index + 1}`;
            const isLast = index === group.bookmarks.length - 1;
            const isOpening = openingBookmarkId === bookmark.id;
            return (
              <Pressable
                key={bookmark.id}
                testID={`bookmark-line-${bookmark.id}`}
                onPress={() => onRead(bookmark)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={isOpening ? `Opening ${label}` : `Resume reading at ${label}`}
                accessibilityState={{ disabled: busy, busy: isOpening }}
                hitSlop={8}
                style={[
                  styles.bookmarkRow,
                  isLast && styles.bookmarkRowLast,
                  busy && !isOpening && styles.bookmarkRowDisabled,
                ]}
              >
                <MaterialCommunityIcons name="bookmark-outline" size={18} color={color.primary} />
                <Text style={styles.bookmarkLine} numberOfLines={1}>
                  {label}
                </Text>
                <Ionicons name="chevron-forward" size={16} color={color.textSecondary} />
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

// A bookmark's stored `Locator` → the reader target that reaches it, mirroring
// Team 4's `toTarget` (readerBookmarks.ts). EPUB anchors by CFI, PDF by page —
// the two schemes `ReaderTargetLike` carries. AUDIO has neither (matches the real
// `toTarget`, which also returns null for AUDIO locators) — `openBookmark`'s
// `target` param is optional, so callers fall back to the stored reading position.
function bookmarkTarget(locator: Bookmark['locator']): ReaderTargetLike | undefined {
  if (locator.type === 'EPUB') {
    return { kind: 'href', href: locator.cfi };
  }
  if (locator.type === 'PDF') {
    return { kind: 'page', page: locator.page };
  }
  return undefined;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.white },
  headerBlock: {
    paddingHorizontal: space.md,
    paddingTop: space.md,
    gap: space.xs,
  },
  // Aleo, compact — the screen's own editorial heading, distinct from the
  // shared navy TopAppBar's own "Library" title (Open Sans, UI chrome). Sized
  // below `editorialTitle` (the Catalogue hero's own headline): this is a
  // utility screen's page heading, not a promotional banner.
  libraryHeading: {
    fontFamily: type.cardTitle.fontFamily,
    fontSize: type.pageTitle.size,
    lineHeight: type.pageTitle.lineHeight,
    letterSpacing: -0.3,
    color: color.textPrimary,
  },
  librarySubtitle: {
    fontFamily: type.body.fontFamily,
    fontSize: type.body.size,
    lineHeight: type.body.lineHeight,
    color: color.textSecondary,
  },
  // A small, permanent caveat — not a coloured banner like `OfflineBanner`,
  // which is transient chrome for a real connectivity change. This is a
  // standing fact about how licences work, so it stays quiet and always
  // there rather than appearing/disappearing with the network.
  disclaimer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.xs,
    marginTop: space.xs / 2,
  },
  disclaimerText: {
    flex: 1,
    fontFamily: type.meta.fontFamily,
    fontSize: type.meta.size,
    lineHeight: type.meta.lineHeight,
    color: color.textSecondary,
  },
  // The bar owns its own inset because `Tabs` sets no outer margin, by its own
  // rule — the screen places the control. A touch of trailing room keeps the
  // last pill ("Premium") from sitting flush against the scroll edge.
  tabBar: { paddingHorizontal: space.md, paddingTop: space.sm },
  scroll: { flex: 1 },
  content: { padding: space.md },
  section: { gap: space.sm, marginBottom: space.md },
  row: { marginBottom: space.sm },
  skeletonRow: {
    flexDirection: 'row',
    padding: space.md,
    gap: space.md,
  },
  skeletonText: { flex: 1, gap: space.sm, justifyContent: 'center' },
  notice: {
    backgroundColor: color.surface,
    borderRadius: radius.card,
    padding: space.sm,
    marginBottom: space.md,
    color: color.textSecondary,
    fontFamily: type.smallLabel.fontFamily,
    fontSize: type.smallLabel.size,
    lineHeight: type.smallLabel.lineHeight,
  },
  // Same card as `notice` above, but a View rather than a Text — this one
  // carries its own Dismiss control alongside the message.
  expiredNoticeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    backgroundColor: color.surface,
    borderRadius: radius.card,
    padding: space.sm,
    marginBottom: space.md,
  },
  expiredNoticeText: {
    flex: 1,
    color: color.textSecondary,
    fontFamily: type.smallLabel.fontFamily,
    fontSize: type.smallLabel.size,
    lineHeight: type.smallLabel.lineHeight,
  },
  expiredNoticeDismiss: {
    color: color.primary,
    fontFamily: type.smallLabel.fontFamily,
    fontSize: type.smallLabel.size,
    lineHeight: type.smallLabel.lineHeight,
  },
  // The pinned open-notice sits outside the scroll's content padding, so it
  // carries its own horizontal inset to line up with the tab bar above it.
  pinnedNotice: {
    marginHorizontal: space.md,
    marginTop: space.sm,
  },
  sectionEmpty: {
    paddingHorizontal: space.xs,
    paddingTop: space.xs,
    color: color.textSecondary,
    fontFamily: type.meta.fontFamily,
    fontSize: type.meta.size,
    lineHeight: type.meta.lineHeight,
  },
  // A tab's own restated name, Aleo, with its real count on the same line —
  // see `TabHeading`'s own comment.
  tabHeadingRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  tabHeadingTitle: {
    fontFamily: type.sectionHeader.fontFamily,
    fontSize: type.sectionHeader.size,
    lineHeight: type.sectionHeader.lineHeight,
    color: color.textPrimary,
  },
  tabHeadingCount: {
    fontFamily: type.meta.fontFamily,
    fontSize: type.meta.size,
    lineHeight: type.meta.lineHeight,
    color: color.textSecondary,
  },
  // The download total ("2 items · 22.8 MB") — a plain caption line under
  // the heading, not a pill: `TabHeading`'s own count already carries the
  // pill-shaped emphasis for "how many"; this line only adds the size.
  sizeCaption: {
    marginTop: -space.xs,
    marginBottom: space.xs,
    fontFamily: type.meta.fontFamily,
    fontSize: type.meta.size,
    lineHeight: type.meta.lineHeight,
    color: color.textSecondary,
  },
  // The due date and the tier pill on a Borrowed row, side by side and
  // wrapping to a second line on a narrow phone rather than pushing either off.
  badgeStack: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.xs,
  },
  // ONE STYLE FOR EVERY ROW BADGE — a due date, a downloaded marker and a
  // bookmark count are three different sentences in the same slot, and they
  // looked identical because they ARE the same thing: the row's secondary
  // line. Byte-identical copies invited one of them drifting.
  badgeLabel: {
    color: color.textSecondary,
    fontFamily: type.smallLabel.fontFamily,
    fontSize: type.smallLabel.size,
    lineHeight: type.smallLabel.lineHeight,
  },
  // A bookmark group's own list — flush with the card above it (no extra
  // horizontal inset: the scroll container already pads every row by
  // `space.md`, so a second inset here only made this narrower than the
  // card it belongs to) and pulled up one pixel to sit against the card's
  // own bottom border, square top corners against its rounded bottom ones —
  // reads as one card growing a drawer open, not a second, separate box
  // floating just under the first.
  bookmarkList: {
    marginTop: -1,
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: color.border,
    borderBottomLeftRadius: radius.card,
    borderBottomRightRadius: radius.card,
    backgroundColor: color.surface,
    overflow: 'hidden',
  },
  // One tappable saved position. Icon–label–chevron reads as "go here", the
  // same shape a settings row uses, rather than the plain numbered text line
  // this replaced — which looked like a caption, not something to tap.
  bookmarkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.border,
  },
  bookmarkRowLast: {
    borderBottomWidth: 0,
  },
  // Every OTHER row while one bookmark is opening — same dimming
  // `ActionButton`'s own `disabled` style uses, so "you can't tap this right
  // now" reads consistently across the screen.
  bookmarkRowDisabled: {
    opacity: 0.4,
  },
  bookmarkLine: {
    flex: 1,
    fontFamily: type.body.fontFamily,
    fontSize: type.body.size,
    lineHeight: type.body.lineHeight,
    color: color.textPrimary,
  },
  // The permanent, compact footer under every single-purpose tab — see
  // `TabHint`'s own comment. Centred and quiet: this is a caption, not a
  // second empty-state card competing with real content above it.
  hint: {
    alignItems: 'center',
    paddingVertical: space.lg,
    gap: space.xs,
  },
  hintIconWrap: {
    width: space.xl * 1.5,
    height: space.xl * 1.5,
    borderRadius: radius.pill,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  hintHeadline: {
    fontFamily: type.sectionHeader.fontFamily,
    fontSize: type.body.size,
    lineHeight: type.body.lineHeight,
    color: color.textPrimary,
    textAlign: 'center',
  },
  hintCaption: {
    fontFamily: type.body.fontFamily,
    fontSize: type.meta.size,
    lineHeight: type.meta.lineHeight,
    color: color.textSecondary,
    textAlign: 'center',
    maxWidth: '80%',
  },
});
