// src/screens/LibraryScreen.test.tsx
// The personal library — CAP-4 Module E, rebuilt around the product model
// (Sept 2026, refined against a reference mockup the same month). See
// LibraryScreen.tsx's own header for the full model.
//
// `navigation` IS HAND-TYPED, LIKE ItemDetailScreen.test.tsx's OWN ROUTE
// PROPS — this screen's real prop is `LibraryStackParamList`'s navigation,
// but the screen only ever calls `navigate('ItemDetail', …)`, so a plain
// `{ navigate: jest.fn() }` is enough and no `NavigationContainer` is needed.
//
// Same seam as the other screen tests otherwise: a fake `DataSource`
// injected through `setCatalogueSource`, and `@config/licence` mocked so
// `libraryStore.refresh()` resolves whatever a test needs.
//
// `await render(...)` and `await fireEvent(...)` are required — RTL 14's
// render and event helpers are async.
import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { getDatabase } from '@/features/sync/localDb/database';
import { bookmarkStore } from '@/features/sync/stores/bookmarkStore';
import type { DataSource } from '@adapters/InstitutionSource';
import { setCatalogueSource } from '@config/catalogue';
import type { BookSummary, Hold, Loan } from '@model/types';
import { useArticleJournalStore } from '@store/articleJournalStore';
import { useDownloadStore } from '@store/downloadStore';
import { useExpiredDownloadsStore } from '@store/expiredDownloadsStore';
import { useExpiredLoansStore } from '@store/expiredLoansStore';
import { useLibraryStore } from '@store/libraryStore';

import LibraryScreen from './LibraryScreen';

// Mocked at the module boundary, same reason ItemDetailScreen.test.tsx mocks
// `@/features/download/openBook` rather than reaching into real Encryption
// internals: `destroy` really does touch Keychain/expo-file-system, and this
// screen only cares that it gets called with the right id and that a
// rejection is handled, not that a real key gets wiped.
const mockDestroy = jest.fn().mockResolvedValue(undefined);
jest.mock('@/features/encryption/contentStore', () => ({
  contentStore: { destroy: (...args: unknown[]) => mockDestroy(...args) },
}));

// A bookmark's own "Read" calls this directly now (see LibraryScreen.tsx's
// `openBookmark`), the same real open-then-navigate path ItemDetailScreen's
// Read/Play action uses — mocked at the same module boundary
// ItemDetailScreen.test.tsx already mocks it at, so these tests exercise the
// screen's own wiring without pulling the real network/decrypt stack in.
const mockOpenBook = jest.fn().mockResolvedValue(new Uint8Array());
jest.mock('@/features/download/openBook', () => ({
  openBook: (...args: [string, string]) => mockOpenBook(...args),
}));

// Same auto-press shape ReaderRouteScreen.test.tsx's own `mockAlert` uses —
// pressing synchronously inside `Alert.alert`'s own mocked call keeps it in
// the same microtask the real confirm dialog's tap would be.
let mockAlertAutoPress: string | null = null;
const mockAlert = jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
  if (mockAlertAutoPress === null) return;
  const button = (buttons as { text: string; onPress?: () => void }[] | undefined)?.find(
    (candidate) => candidate.text === mockAlertAutoPress,
  );
  button?.onPress?.();
});

const SERVER_NOW = new Date().toISOString();
const SERVER_NOW_MS = Date.parse(SERVER_NOW);

const mockUseNetworkStatus = jest.fn(() => true);
jest.mock('@hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => mockUseNetworkStatus(),
}));

const mockGetLibrary = jest.fn().mockResolvedValue({ loans: [], holds: [] });
const mockAcceptOffer = jest.fn().mockResolvedValue({ loanId: 'loan_new', itemId: 'item_99', state: 'active' });
const mockCancelHold = jest.fn().mockResolvedValue(undefined);
const mockBorrow = jest.fn().mockResolvedValue({ loanId: 'loan_new', itemId: 'item_42', state: 'active' });

jest.mock('@config/licence', () => ({
  getLicenceSource: () => ({
    borrow: (...args: unknown[]) => mockBorrow(...args),
    returnLoan: jest.fn(),
    placeHold: jest.fn(),
    acceptOffer: (...args: unknown[]) => mockAcceptOffer(...args),
    cancelHold: (...args: unknown[]) => mockCancelHold(...args),
    getLibrary: () => mockGetLibrary(),
  }),
}));

function aLoan(over: Partial<Loan> = {}): Loan {
  return { loanId: 'loan_1', itemId: 'item_42', state: 'active', ...over };
}

function aHold(over: Partial<Hold> = {}): Hold {
  return { holdId: 'hold_1', itemId: 'item_77', state: 'queued', serverTime: SERVER_NOW, ...over };
}

function aSummary(over: Partial<BookSummary> = {}): BookSummary {
  return {
    id: 'item_42',
    title: 'Applied Thermodynamics',
    format: 'EPUB',
    accessTier: 'SUBSCRIPTION',
    hasSearchIndex: false,
    ...over,
  };
}

/** A source whose only stubbed method is the one this screen actually calls. */
function fakeSource(getItemsBatch: DataSource['getItemsBatch']): DataSource {
  const unused = () => Promise.reject(new Error('not stubbed for this test'));
  return {
    getHomeCatalogue: unused,
    getShelf: unused,
    getPublication: unused,
    getPublicFeed: unused,
    getPublicJournals: unused,
    getPublicPublication: unused,
    getInstitutions: unused,
    getInstitution: unused,
    getItemsBatch,
    getWork: unused,
    getPublicWork: unused,
  };
}

/** Seeds the store and makes the mount-time refresh return the same thing. */
function givenHoldings(loans: Loan[], holds: Hold[]): void {
  useLibraryStore.setState({ loans, holds, loading: false });
  mockGetLibrary.mockResolvedValue({ loans, holds });
}

// Seeds a bookmark through the REAL, synced store `LibraryScreen.tsx` now
// reads (`bookmarkTable.listActive`), not the dead Zustand stand-in this
// screen used to read. Defaults to `item_42`/page 12, matching the old
// `aBookmark()` fixture's own defaults, so most call sites below are an
// `await` and an API-name change, nothing more. `userId` is left at
// `bookmarkStore`'s own default (`USER_ID` from `syncConfig.ts`) — the exact
// id `LibraryScreen.tsx` queries with — so a caller never needs to pass one.
function aBookmark(bookId = 'item_42', page = 12, name?: string) {
  return bookmarkStore.addForPage(page, name, bookId);
}

// Same reset shape `src/features/sync/stores/bookmarkStore.test.ts` already
// uses: `getDatabase()` caches its instance at module scope (Jest resets
// modules per FILE, not per test), so a clean table between tests means
// deleting rows, not recreating the database.
async function resetBookmarksTable(): Promise<void> {
  const db = await getDatabase();
  await db.execAsync(`DELETE FROM bookmarks; DELETE FROM outbox;`);
}

const mockNavigate = jest.fn();

/** `LibraryScreen`'s own minimal hand-typed navigation prop. */
function renderScreen() {
  return render(<LibraryScreen navigation={{ navigate: mockNavigate }} />);
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockUseNetworkStatus.mockReturnValue(true);
  mockGetLibrary.mockResolvedValue({ loans: [], holds: [] });
  mockAcceptOffer.mockResolvedValue({ loanId: 'loan_new', itemId: 'item_99', state: 'active' });
  mockCancelHold.mockResolvedValue(undefined);
  mockBorrow.mockResolvedValue({ loanId: 'loan_new', itemId: 'item_42', state: 'active' });
  useLibraryStore.setState({ loans: [], holds: [], loading: false, refreshFailed: false, hasSyncedOnce: false });
  // Device-local and persisted, so unlike libraryStore these survive a test and
  // would leak a download into the next one's "empty shelf".
  useDownloadStore.getState().clear();
  useArticleJournalStore.getState().clear();
  useExpiredDownloadsStore.getState().dismissAll();
  useExpiredLoansStore.getState().dismissAll();
  mockAlertAutoPress = null;
  mockDestroy.mockReset().mockResolvedValue(undefined);
  mockOpenBook.mockReset().mockResolvedValue(new Uint8Array());
  await resetBookmarksTable();
  setCatalogueSource(fakeSource(async () => ({ items: [], notFound: [], denied: [] })));
});

afterEach(() => {
  setCatalogueSource(undefined);
});

describe('LibraryScreen — header', () => {
  it('shows a compact editorial heading and its supporting line', async () => {
    await renderScreen();

    expect(screen.getByText('Library')).toBeTruthy();
    expect(screen.getByText('Your scholarly content and access in one place.')).toBeTruthy();
  });

  it('shows the offline-sync disclaimer, so a reader knows access can lapse without a connection', async () => {
    await renderScreen();

    expect(
      screen.getByText('Access is checked automatically and can expire even while you’re offline.'),
    ).toBeTruthy();
  });
});

describe('LibraryScreen — tab bar', () => {
  it('names exactly five tabs: All, Borrowed, Downloads, Bookmarks, Journals', async () => {
    await renderScreen();

    await waitFor(() => expect(screen.getByTestId('tabs-tab-all')).toBeTruthy());
    expect(screen.getByTestId('tabs-label-loans').props.children).toBe('Borrowed');
    expect(screen.getByTestId('tabs-label-downloads').props.children).toBe('Downloads');
    expect(screen.getByTestId('tabs-label-bookmarks').props.children).toBe('Bookmarks');
    expect(screen.getByTestId('tabs-label-journals').props.children).toBe('Journals');
  });

  it('opens on the All tab by default', async () => {
    await renderScreen();

    await waitFor(() => expect(screen.getByTestId('tabs-tab-all')).toBeTruthy());
    expect(screen.getByTestId('tabs-tab-all').props.accessibilityState.selected).toBe(true);
  });

  it('carries no count badge on the pill itself — the count lives in the tab’s own content', async () => {
    useDownloadStore.getState().markDownloaded({ itemId: 'item_a', downloadedAt: 1 });

    await renderScreen();

    await waitFor(() => expect(screen.getByTestId('tabs-tab-downloads')).toBeTruthy());
    expect(screen.queryByTestId('tabs-count-downloads')).toBeNull();
  });

  it('shows a different view per tab, not the same content everywhere', async () => {
    useDownloadStore.getState().markDownloaded({ itemId: 'item_dl', downloadedAt: 1 });
    givenHoldings([aLoan({ itemId: 'item_loan' })], []);

    await renderScreen();

    await waitFor(() => expect(screen.getByTestId('tabs-tab-downloads')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('tabs-tab-downloads'));

    await waitFor(() => expect(screen.getByText('item_dl')).toBeTruthy());
    // The Borrowed loan is a different view — not shown on the Downloads tab.
    expect(screen.queryByText('item_loan')).toBeNull();
  });

  it('does not refetch the library when the reader changes tab', async () => {
    await renderScreen();

    await waitFor(() => expect(mockGetLibrary).toHaveBeenCalledTimes(1));

    await fireEvent.press(screen.getByTestId('tabs-tab-bookmarks'));
    await fireEvent.press(screen.getByTestId('tabs-tab-loans'));

    expect(mockGetLibrary).toHaveBeenCalledTimes(1);
  });
});

describe('LibraryScreen — All tab', () => {
  it('shows a compact line when the library is entirely empty', async () => {
    await renderScreen();

    await waitFor(() => expect(screen.getByText('Your library is empty right now.')).toBeTruthy());
  });

  it('shows a pending Elite offer first, with no heading reserved for an empty one', async () => {
    givenHoldings(
      [],
      [
        aHold({
          holdId: 'h_offer',
          itemId: 'item_99',
          state: 'offered',
          offerExpiresAt: new Date(SERVER_NOW_MS + 15 * 60_000).toISOString(),
        }),
      ],
    );

    await renderScreen();

    await waitFor(() => expect(screen.getByTestId('elite-pending-access-card')).toBeTruthy());
    expect(screen.getByText('Access available')).toBeTruthy();
    expect(screen.getByText('Expires in 15:00')).toBeTruthy();
  });

  it('composes real holdings under one "Your content" heading rather than five sections', async () => {
    givenHoldings([aLoan({ itemId: 'item_loan' })], []);
    useDownloadStore.getState().markDownloaded({ itemId: 'item_dl', downloadedAt: 1 });

    await renderScreen();

    await waitFor(() => expect(screen.getByText('Your content')).toBeTruthy());
    expect(screen.queryByText('Offered to you')).toBeNull();
    expect(screen.queryByText('Waiting')).toBeNull();
    expect(screen.queryByText('Your library')).toBeNull();
  });

  it('merges a loan and a download of the SAME book into ONE row, not two', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_42', title: 'Playful Identities', accessTier: 'SUBSCRIPTION' })],
        notFound: [],
        denied: [],
      })),
    );
    // 2 days, not exactly 1 — see the "stale holdings" describe block's own
    // note on why a due date right on the day boundary is flaky here.
    givenHoldings([aLoan({ itemId: 'item_42', expiresAt: SERVER_NOW_MS + 2 * 86_400_000 })], []);
    useDownloadStore.getState().markDownloaded({ itemId: 'item_42', downloadedAt: 1 });

    await renderScreen();

    await waitFor(() => expect(screen.getAllByText('Playful Identities')).toHaveLength(1));
    expect(screen.getByText('1 item')).toBeTruthy();
    // Both facts about the one book still show, merged onto the same row.
    expect(screen.getByText('Due in 2 days')).toBeTruthy();
    expect(screen.getByText('Downloaded')).toBeTruthy();
  });

  it('surfaces an Elite loan as active access, not as a Borrowed row', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_42', accessTier: 'ELITE' })],
        notFound: [],
        denied: [],
      })),
    );
    givenHoldings([aLoan({ itemId: 'item_42' })], []);

    await renderScreen();

    // Same `ContentCard` as every other row now — see LibraryScreen.tsx's
    // header comment — so "active access, not Borrowed" is asserted by the
    // fixed ELITE badge `EliteLoanRow` always draws, not by a separate
    // component's own testID. `BorrowedBookRow`'s own tier badge (which a
    // subscription loan draws instead) reads from `summary.accessTier`, so
    // this also confirms the row did NOT take that branch.
    await waitFor(() => expect(screen.getByText('Elite')).toBeTruthy());
  });

  it('lists a waiting hold under its own "Premium waiting" heading, separate from "Your content"', async () => {
    givenHoldings([], [aHold({ state: 'queued', position: 1 })]);

    await renderScreen();

    await waitFor(() => expect(screen.getByText('Premium waiting')).toBeTruthy());
    expect(screen.queryByText('Your content')).toBeNull();
  });

  it('goes to the item’s detail page when a merged content row is tapped', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_42', title: 'Applied Thermodynamics' })],
        notFound: [],
        denied: [],
      })),
    );
    givenHoldings([aLoan({ itemId: 'item_42' })], []);

    await renderScreen();

    await waitFor(() => expect(screen.getByText('Applied Thermodynamics')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('content-card'));

    expect(mockNavigate).toHaveBeenCalledWith('ItemDetail', { itemId: 'item_42' });
  });

  // Found live: delete used to exist only on the Downloads tab's own row, which
  // reads as "there is no delete" to a reader who never leaves the default All
  // tab. Every merged row for a download now carries the same action.
  it('offers delete on a downloaded title from the All tab too, not only the Downloads tab', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        // OPEN_ACCESS, deliberately — no loan ever backs one, so it is immune
        // to the expiry sweep (see that effect's own comment) and this test
        // is not accidentally about that mechanism.
        items: [aSummary({ id: 'item_42', title: 'Applied Thermodynamics', accessTier: 'OPEN_ACCESS' })],
        notFound: [],
        denied: [],
      })),
    );
    useDownloadStore.getState().markDownloaded({ itemId: 'item_42', downloadedAt: 1 });

    await renderScreen();

    await waitFor(() => expect(screen.getByText('Applied Thermodynamics')).toBeTruthy());
    expect(screen.getByTestId('download-delete-button')).toBeTruthy();
  });

  it('offers no delete on a merged row that is only a loan or a bookmark, never downloaded', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_42', title: 'Applied Thermodynamics' })],
        notFound: [],
        denied: [],
      })),
    );
    givenHoldings([aLoan({ itemId: 'item_42' })], []);

    await renderScreen();

    await waitFor(() => expect(screen.getByText('Applied Thermodynamics')).toBeTruthy());
    expect(screen.queryByTestId('download-delete-button')).toBeNull();
  });

  it('expands a bookmark-only row in place from the All tab too, instead of navigating', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_42', title: 'Applied Thermodynamics', format: 'PDF' })],
        notFound: [],
        denied: [],
      })),
    );
    const bookmark = await aBookmark('item_42', 12);

    await renderScreen();

    await waitFor(() => expect(screen.getByText('Applied Thermodynamics')).toBeTruthy());
    expect(screen.getByText('1 bookmark')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('content-card'));

    await waitFor(() => expect(screen.getByTestId(`bookmark-line-${bookmark.id}`)).toBeTruthy());
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('keeps navigating from the All tab when a bookmarked book also has an active loan', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_42', title: 'Applied Thermodynamics' })],
        notFound: [],
        denied: [],
      })),
    );
    givenHoldings([aLoan({ itemId: 'item_42' })], []);
    await aBookmark('item_42', 12);

    await renderScreen();

    await waitFor(() => expect(screen.getByText('Applied Thermodynamics')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('content-card'));

    expect(mockNavigate).toHaveBeenCalledWith('ItemDetail', { itemId: 'item_42' });
  });

  it('shows a journal-linked article under its journal, not its own title and authors', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        // OPEN_ACCESS — see the All tab delete test's own comment on why.
        items: [
          aSummary({
            id: 'item_a1',
            title: 'A Specific Article',
            authors: ['Some Author'],
            accessTier: 'OPEN_ACCESS',
          }),
        ],
        notFound: [],
        denied: [],
      })),
    );
    useDownloadStore.getState().markDownloaded({ itemId: 'item_a1', downloadedAt: 1 });
    useArticleJournalStore.getState().recordMembership('item_a1', {
      journalWorkId: 'journal_1',
      institutionId: 'inst_1',
      journalTitle: 'Journal of Applied Thermodynamics',
    });

    await renderScreen();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Journal of Applied Thermodynamics' })).toBeTruthy(),
    );
    expect(screen.queryByText('A Specific Article')).toBeNull();
    expect(screen.queryByText('Some Author')).toBeNull();
  });

  it('navigates to this reader’s own article list for that journal when its row is tapped from "Your content"', async () => {
    useDownloadStore.getState().markDownloaded({ itemId: 'item_a1', downloadedAt: 1 });
    useArticleJournalStore.getState().recordMembership('item_a1', {
      journalWorkId: 'journal_1',
      institutionId: 'inst_1',
      journalTitle: 'Journal of Applied Thermodynamics',
    });

    await renderScreen();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Journal of Applied Thermodynamics' })).toBeTruthy(),
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Journal of Applied Thermodynamics' }));

    expect(mockNavigate).toHaveBeenCalledWith('LibraryJournal', {
      journalWorkId: 'journal_1',
      journalTitle: 'Journal of Applied Thermodynamics',
      itemIds: ['item_a1'],
    });
  });
});

describe('LibraryScreen — Borrowed tab', () => {
  async function openBorrowed() {
    await fireEvent.press(screen.getByTestId('tabs-tab-loans'));
  }

  it('shows one combined hint, and no per-section heading, when nothing is borrowed, held or waited on', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-loans')).toBeTruthy());

    await openBorrowed();

    expect(screen.queryByTestId('tab-heading-borrowed')).toBeNull();
    expect(screen.getByText('Nothing borrowed or waiting on right now.')).toBeTruthy();
  });

  it('lists a subscription loan with its due date and a real count', async () => {
    givenHoldings([aLoan({ itemId: 'item_42', expiresAt: SERVER_NOW_MS + 14 * 86_400_000 })], []);
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_42', accessTier: 'SUBSCRIPTION' })],
        notFound: [],
        denied: [],
      })),
    );

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-loans')).toBeTruthy());
    await openBorrowed();

    await waitFor(() => expect(screen.getByText('Due in 14 days')).toBeTruthy());
    expect(screen.getByText('1 item')).toBeTruthy();
    // No hint caption once the section has real content — see
    // `renderBorrowedTab`'s own comment on why the per-section hint went.
    expect(screen.queryByText('Items you borrow will appear here until they’re due.')).toBeNull();
  });

  it('keeps an unhydrated loan here until its tier is known', async () => {
    givenHoldings([aLoan({ itemId: 'item_42' })], []);

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-loans')).toBeTruthy());
    await openBorrowed();

    await waitFor(() => expect(screen.getByText('item_42')).toBeTruthy());
  });

  it('says "No due date" for an open-access loan rather than inventing one', async () => {
    givenHoldings([aLoan()], []);

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-loans')).toBeTruthy());
    await openBorrowed();

    await waitFor(() => expect(screen.getByText('No due date')).toBeTruthy());
  });

  it('goes to the item’s detail page when a Borrowed row is tapped', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_42', title: 'Applied Thermodynamics', accessTier: 'SUBSCRIPTION' })],
        notFound: [],
        denied: [],
      })),
    );
    givenHoldings([aLoan({ itemId: 'item_42' })], []);

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-loans')).toBeTruthy());
    await openBorrowed();
    await waitFor(() => expect(screen.getByText('Applied Thermodynamics')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('content-card'));

    expect(mockNavigate).toHaveBeenCalledWith('ItemDetail', { itemId: 'item_42' });
  });
});

describe('LibraryScreen — Downloads tab', () => {
  async function openDownloads() {
    await fireEvent.press(screen.getByTestId('tabs-tab-downloads'));
  }

  it('always shows the "Downloads" heading and a compact hint, even when empty', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-downloads')).toBeTruthy());

    await openDownloads();

    expect(screen.getByTestId('tab-heading-downloads')).toBeTruthy();
    expect(screen.getByText('No downloads yet.')).toBeTruthy();
    expect(screen.getByText('Only items you’ve downloaded will appear here.')).toBeTruthy();
  });

  it('lists a downloaded book with a real count', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        // OPEN_ACCESS — see the All tab delete test's own comment on why.
        items: [aSummary({ id: 'item_42', title: 'Applied Thermodynamics', accessTier: 'OPEN_ACCESS' })],
        notFound: [],
        denied: [],
      })),
    );
    useDownloadStore.getState().markDownloaded({ itemId: 'item_42', downloadedAt: 1 });

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-downloads')).toBeTruthy());
    await openDownloads();

    await waitFor(() => expect(screen.getByText('Applied Thermodynamics')).toBeTruthy());
    expect(screen.getByText('Downloaded')).toBeTruthy();
    expect(screen.getByText('1 item')).toBeTruthy();
  });

  it('summarises the tab as a count and total size', async () => {
    useDownloadStore
      .getState()
      .markDownloaded({ itemId: 'item_a', downloadedAt: 2, sizeBytes: 14.2 * 1_048_576 });
    useDownloadStore
      .getState()
      .markDownloaded({ itemId: 'item_b', downloadedAt: 1, sizeBytes: 8.6 * 1_048_576 });

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-downloads')).toBeTruthy());
    await openDownloads();

    await waitFor(() => expect(screen.getByText('2 items · 22.8 MB')).toBeTruthy());
  });

  it('goes to the item’s detail page when a Downloads row is tapped', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        // OPEN_ACCESS — see the All tab delete test's own comment on why.
        items: [
          aSummary({
            id: 'item_42',
            title: 'Applied Thermodynamics',
            format: 'PDF',
            accessTier: 'OPEN_ACCESS',
          }),
        ],
        notFound: [],
        denied: [],
      })),
    );
    useDownloadStore.getState().markDownloaded({ itemId: 'item_42', downloadedAt: 1 });

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-downloads')).toBeTruthy());
    await openDownloads();
    await waitFor(() => expect(screen.getByText('Applied Thermodynamics')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('content-card'));

    expect(mockNavigate).toHaveBeenCalledWith('ItemDetail', { itemId: 'item_42' });
  });

  it('confirms, then deletes the real content and this device’s tracking record together', async () => {
    useDownloadStore.getState().markDownloaded({ itemId: 'item_42', downloadedAt: 1 });
    mockAlertAutoPress = 'Delete';

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-downloads')).toBeTruthy());
    await openDownloads();
    await waitFor(() => expect(screen.getByTestId('download-delete-button')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('download-delete-button'));

    expect(mockAlert).toHaveBeenCalledWith(
      'Delete download?',
      'This removes it from your device. You can download it again anytime.',
      expect.anything(),
    );
    await waitFor(() => expect(mockDestroy).toHaveBeenCalledWith('item_42'));
    await waitFor(() => expect(screen.getByText('No downloads yet.')).toBeTruthy());
  });

  it('keeps the download when the confirm is cancelled', async () => {
    useDownloadStore.getState().markDownloaded({ itemId: 'item_42', downloadedAt: 1 });
    mockAlertAutoPress = 'Cancel';

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-downloads')).toBeTruthy());
    await openDownloads();
    await waitFor(() => expect(screen.getByTestId('download-delete-button')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('download-delete-button'));

    expect(mockDestroy).not.toHaveBeenCalled();
    expect(screen.getByTestId('download-delete-button')).toBeTruthy();
  });

  it('reports a real failure and keeps the row rather than reporting a title as gone while its bytes remain', async () => {
    useDownloadStore.getState().markDownloaded({ itemId: 'item_42', downloadedAt: 1 });
    mockDestroy.mockRejectedValue(new Error('disk error'));
    mockAlertAutoPress = 'Delete';

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-downloads')).toBeTruthy());
    await openDownloads();
    await waitFor(() => expect(screen.getByTestId('download-delete-button')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('download-delete-button'));

    await waitFor(() => expect(screen.getByText('Couldn’t delete that download. Try again.')).toBeTruthy());
    expect(screen.getByTestId('download-delete-button')).toBeTruthy();
  });
});

describe('LibraryScreen — Bookmarks tab', () => {
  async function openBookmarks() {
    await fireEvent.press(screen.getByTestId('tabs-tab-bookmarks'));
  }

  it('always shows the "Bookmarks" heading and a compact hint, even when empty', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-bookmarks')).toBeTruthy());

    await openBookmarks();

    expect(screen.getByTestId('tab-heading-bookmarks')).toBeTruthy();
    expect(screen.getByText('No bookmarked pages yet.')).toBeTruthy();
    expect(screen.getByText('Pages you bookmark while reading will appear here.')).toBeTruthy();
  });

  it('groups every bookmark in one book under its title, with a real count', async () => {
    // Distinct pages: the real store dedups on (user, book, locator), so two
    // bookmarks meant to be genuinely distinct need different positions.
    await aBookmark('item_42', 12);
    await aBookmark('item_42', 88);

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-bookmarks')).toBeTruthy());
    await openBookmarks();

    await waitFor(() => expect(screen.getByText('2 bookmarks')).toBeTruthy());
  });

  it('shows a real count of bookmarked TITLES for the tab, not of bookmarks', async () => {
    await aBookmark('item_42', 12);
    await aBookmark('item_42', 88);
    await aBookmark('item_99', 12);

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-bookmarks')).toBeTruthy());
    await openBookmarks();

    // Two TITLES (item_42, item_99), even though there are three bookmarks.
    await waitFor(() => expect(screen.getByText('2 items')).toBeTruthy());
  });

  it('expands a title in place to show its real bookmarks, rather than navigating', async () => {
    await aBookmark('item_42', 12);
    await aBookmark('item_42', 88);

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-bookmarks')).toBeTruthy());
    await openBookmarks();

    await waitFor(() => expect(screen.getByText('2 bookmarks')).toBeTruthy());
    expect(screen.queryByText(/Page 12/)).toBeNull();

    await fireEvent.press(screen.getByTestId('content-card'));

    await waitFor(() => expect(screen.getByText(/Page 12/)).toBeTruthy());
    expect(screen.getByText(/Page 88/)).toBeTruthy();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('collapses an expanded title on a second tap', async () => {
    await aBookmark();

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-bookmarks')).toBeTruthy());
    await openBookmarks();
    await waitFor(() => expect(screen.getByText('1 bookmark')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('content-card'));
    await waitFor(() => expect(screen.getByText(/Page 12/)).toBeTruthy());

    await fireEvent.press(screen.getByTestId('content-card'));

    await waitFor(() => expect(screen.queryByText(/Page 12/)).toBeNull());
  });

  it('renders a reader-typed name ahead of a raw position, inventing neither', async () => {
    await aBookmark('item_42', 12, 'The proof');

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-bookmarks')).toBeTruthy());
    await openBookmarks();
    await fireEvent.press(screen.getByTestId('content-card'));

    await waitFor(() => expect(screen.getByText(/The proof/)).toBeTruthy());
  });

  it('resumes reading directly when a bookmark is tapped, with no separate Download action anywhere in the list', async () => {
    const bookmark = await aBookmark('item_42');

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-bookmarks')).toBeTruthy());
    await openBookmarks();
    await fireEvent.press(screen.getByTestId('content-card'));
    await waitFor(() => expect(screen.getByTestId(`bookmark-line-${bookmark.id}`)).toBeTruthy());
    expect(screen.queryByTestId('action-button-download')).toBeNull();

    await fireEvent.press(screen.getByTestId(`bookmark-line-${bookmark.id}`));

    await waitFor(() => expect(mockOpenBook).toHaveBeenCalledWith('item_42', 'PDF'));
    expect(mockNavigate).toHaveBeenCalledWith('Reader', {
      bookId: 'item_42',
      format: 'PDF',
      initialTarget: { kind: 'page', page: 12 },
    });
  });
});

describe('LibraryScreen — Journals tab', () => {
  async function openJournals() {
    await fireEvent.press(screen.getByTestId('tabs-tab-journals'));
  }

  it('always shows the "Journals" heading and a compact hint, even when empty', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-journals')).toBeTruthy());

    await openJournals();

    expect(screen.getByTestId('tab-heading-journals')).toBeTruthy();
    expect(screen.getByText('No journal articles yet.')).toBeTruthy();
    expect(
      screen.getByText('Articles you open from a journal will appear here, grouped by journal.'),
    ).toBeTruthy();
  });

  it('groups every downloaded article from the same journal under one row, with a real count', async () => {
    useDownloadStore.getState().markDownloaded({ itemId: 'item_a1', downloadedAt: 1 });
    useDownloadStore.getState().markDownloaded({ itemId: 'item_a2', downloadedAt: 2 });
    useArticleJournalStore.getState().recordMembership('item_a1', {
      journalWorkId: 'journal_1',
      institutionId: 'inst_1',
      journalTitle: 'Journal of Applied Thermodynamics',
    });
    useArticleJournalStore.getState().recordMembership('item_a2', {
      journalWorkId: 'journal_1',
      institutionId: 'inst_1',
      journalTitle: 'Journal of Applied Thermodynamics',
    });

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-journals')).toBeTruthy());
    await openJournals();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Journal of Applied Thermodynamics' })).toBeTruthy(),
    );
    expect(screen.getByText('2 articles')).toBeTruthy();
  });

  it('excludes an item with no recorded journal membership — a book, or an article reached some other way', async () => {
    useDownloadStore.getState().markDownloaded({ itemId: 'item_book', downloadedAt: 1 });

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-journals')).toBeTruthy());
    await openJournals();

    await waitFor(() => expect(screen.getByText('No journal articles yet.')).toBeTruthy());
  });

  it('navigates to this reader’s own article list for that journal when a journal row is tapped', async () => {
    useDownloadStore.getState().markDownloaded({ itemId: 'item_a1', downloadedAt: 1 });
    useArticleJournalStore.getState().recordMembership('item_a1', {
      journalWorkId: 'journal_1',
      institutionId: 'inst_1',
      journalTitle: 'Journal of Applied Thermodynamics',
    });

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-journals')).toBeTruthy());
    await openJournals();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Journal of Applied Thermodynamics' })).toBeTruthy(),
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Journal of Applied Thermodynamics' }));

    expect(mockNavigate).toHaveBeenCalledWith('LibraryJournal', {
      journalWorkId: 'journal_1',
      journalTitle: 'Journal of Applied Thermodynamics',
      itemIds: ['item_a1'],
    });
  });
});

describe('LibraryScreen — Borrowed tab (Elite access & waiting)', () => {
  async function openBorrowed() {
    await fireEvent.press(screen.getByTestId('tabs-tab-loans'));
  }

  it('shows neither "Your Elite access" nor "Waiting for access" while both are empty', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-loans')).toBeTruthy());

    await openBorrowed();

    expect(screen.queryByText('Your Elite access')).toBeNull();
    expect(screen.queryByText('Waiting for access')).toBeNull();
    expect(screen.getByText('Nothing borrowed or waiting on right now.')).toBeTruthy();
  });

  it('reserves no heading or hint for a pending offer when there is none', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-loans')).toBeTruthy());

    await openBorrowed();

    expect(screen.queryByText('Access available')).toBeNull();
  });

  it('shows a pending offer, active access and the waiting queue together, each under its own heading', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_active', accessTier: 'ELITE' })],
        notFound: [],
        denied: [],
      })),
    );
    givenHoldings(
      [aLoan({ loanId: 'loan_active', itemId: 'item_active' })],
      [
        aHold({ holdId: 'h_offer', itemId: 'item_offer', state: 'offered' }),
        aHold({ holdId: 'h_wait', itemId: 'item_wait', state: 'queued', position: 3, queueLength: 7 }),
      ],
    );

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-loans')).toBeTruthy());
    await openBorrowed();

    await waitFor(() => expect(screen.getByTestId('elite-pending-access-card')).toBeTruthy());
    expect(screen.getByTestId('tab-heading-access-available')).toBeTruthy();
    // `EliteLoanRow`/`EliteQueueRow` — both `ContentCard` now, so each row is
    // found by its own accessible name rather than a bespoke component's
    // testID. `item_active` has a summary (`aSummary`'s own default title,
    // "Applied Thermodynamics"); `item_wait` does not, so `titleFor` falls
    // back to its raw id.
    expect(screen.getByRole('button', { name: 'Applied Thermodynamics' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'item_wait' })).toBeTruthy();
    expect(screen.getByText('#3 of 7')).toBeTruthy();
  });

  it('lists a subscription loan under "Borrowed" and an Elite loan under "Your Elite access" — together, not either-or', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [
          aSummary({ id: 'item_sub', title: 'A Subscription Title', accessTier: 'SUBSCRIPTION' }),
          aSummary({ id: 'item_elite', title: 'An Elite Title', accessTier: 'ELITE' }),
        ],
        notFound: [],
        denied: [],
      })),
    );
    givenHoldings(
      [aLoan({ loanId: 'loan_sub', itemId: 'item_sub' }), aLoan({ loanId: 'loan_elite', itemId: 'item_elite' })],
      [],
    );

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-loans')).toBeTruthy());
    await openBorrowed();

    await waitFor(() => expect(screen.getByRole('button', { name: 'A Subscription Title' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'An Elite Title' })).toBeTruthy();
  });

  it('goes to the item’s detail page when an active-access or waiting card is tapped', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_active', title: 'Digital Media Cultures', accessTier: 'ELITE' })],
        notFound: [],
        denied: [],
      })),
    );
    givenHoldings([aLoan({ loanId: 'loan_active', itemId: 'item_active' })], []);

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-loans')).toBeTruthy());
    await openBorrowed();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Digital Media Cultures' })).toBeTruthy(),
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Digital Media Cultures' }));

    expect(mockNavigate).toHaveBeenCalledWith('ItemDetail', { itemId: 'item_active' });
  });
});

describe('LibraryScreen — accepting and declining an Elite offer', () => {
  function offerHolding() {
    givenHoldings(
      [],
      [aHold({ holdId: 'h_offer', itemId: 'item_99', state: 'offered', offerExpiresAt: SERVER_NOW })],
    );
  }

  it('accepts an offer through the same acceptOffer call ItemDetailScreen makes', async () => {
    offerHolding();

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('action-button-acceptOffer')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('action-button-acceptOffer'));

    await waitFor(() => expect(mockAcceptOffer).toHaveBeenCalledWith('h_offer'));
  });

  it('declines an offer through the same cancelHold call', async () => {
    offerHolding();

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('action-button-rejectOffer')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('action-button-rejectOffer'));

    await waitFor(() => expect(mockCancelHold).toHaveBeenCalledWith('h_offer'));
  });

  it('refreshes the library after a successful accept', async () => {
    offerHolding();

    await renderScreen();
    await waitFor(() => expect(mockGetLibrary).toHaveBeenCalledTimes(1));

    await fireEvent.press(screen.getByTestId('action-button-acceptOffer'));

    await waitFor(() => expect(mockGetLibrary).toHaveBeenCalledTimes(2));
  });

  it('shows a notice and keeps the offer when the call is refused', async () => {
    offerHolding();
    mockAcceptOffer.mockRejectedValue(new Error('refused'));

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('action-button-acceptOffer')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('action-button-acceptOffer'));

    await waitFor(() =>
      expect(screen.getByText('Couldn’t accept that offer. Pull to refresh and try again.')).toBeTruthy(),
    );
  });
});

describe('LibraryScreen — hydration', () => {
  it('asks for every id across offers, loans, downloads, bookmarks and waiting in ONE batch call', async () => {
    const getItemsBatch = jest.fn().mockResolvedValue({ items: [], notFound: [], denied: [] });
    setCatalogueSource(fakeSource(getItemsBatch));
    givenHoldings(
      [aLoan({ itemId: 'item_42' })],
      [
        aHold({ holdId: 'h_o', itemId: 'item_99', state: 'offered', offerExpiresAt: SERVER_NOW }),
        aHold({ holdId: 'h_w', itemId: 'item_77', state: 'queued', position: 1 }),
      ],
    );
    useDownloadStore.getState().markDownloaded({ itemId: 'item_11', downloadedAt: 1 });
    await aBookmark('item_22');

    await renderScreen();

    await waitFor(() => expect(getItemsBatch).toHaveBeenCalledTimes(1));
    expect(getItemsBatch.mock.calls[0][0].sort()).toEqual([
      'item_11',
      'item_22',
      'item_42',
      'item_77',
      'item_99',
    ]);
  });

  it('renders the hydrated title rather than the item id', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_42', title: 'Applied Thermodynamics' })],
        notFound: [],
        denied: [],
      })),
    );
    givenHoldings([aLoan({ itemId: 'item_42' })], []);

    await renderScreen();

    await waitFor(() => expect(screen.getByText('Applied Thermodynamics')).toBeTruthy());
    expect(screen.queryByText('item_42')).toBeNull();
  });

  it('keeps the row against its id when the catalogue cannot resolve it', async () => {
    setCatalogueSource(fakeSource(async () => ({ items: [], notFound: ['item_42'], denied: [] })));
    givenHoldings([aLoan({ itemId: 'item_42' })], []);

    await renderScreen();

    await waitFor(() => expect(screen.getByText('item_42')).toBeTruthy());
  });

  it('keeps the shelf and offers a retry when the batch call fails outright', async () => {
    setCatalogueSource(fakeSource(async () => Promise.reject(new Error('offline'))));
    givenHoldings([aLoan({ itemId: 'item_42' })], []);

    await renderScreen();

    await waitFor(() =>
      expect(
        screen.getByText('Titles couldn’t be loaded. Pull to try again — your books are still here.'),
      ).toBeTruthy(),
    );
    expect(screen.getByText('item_42')).toBeTruthy();
  });
});

describe('LibraryScreen — the batch cap', () => {
  it('says how many rows it could not show rather than truncating silently', async () => {
    const loans = Array.from({ length: 107 }, (_, i) => aLoan({ loanId: `loan_${i}`, itemId: `item_${i}` }));
    givenHoldings(loans, []);

    await renderScreen();

    await waitFor(() =>
      expect(
        screen.getByText('Showing your 100 most recent items. 7 more are in your loan history.'),
      ).toBeTruthy(),
    );
  });
});

describe('LibraryScreen — offline', () => {
  it('shows the offline banner when the device has no connection', async () => {
    mockUseNetworkStatus.mockReturnValue(false);

    await renderScreen();

    await waitFor(() => expect(screen.getByText("You're offline")).toBeTruthy());
  });

  it('shows no offline banner when connected', async () => {
    await renderScreen();

    await waitFor(() => expect(screen.getByText('Library')).toBeTruthy());
    expect(screen.queryByText("You're offline")).toBeNull();
  });
});

// Found live: a loan already on screen with a real due date kept showing that
// exact date through an entire window where refresh() was actually failing —
// nothing on screen said the number might be wrong. See libraryStore.ts's own
// header on `refreshFailed`.
describe('LibraryScreen — stale holdings', () => {
  it('flags a due date as unconfirmed when the mount-time refresh fails', async () => {
    // 2 days, not exactly 1 — dueLabel now buckets by day/hour/minute (see its
    // own header), so an expiry sitting right on the day boundary is one real
    // clock tick from crossing into the next bucket by the time this test's
    // own assertion runs. A due date safely inside the "days" bucket is the
    // point of this test; the exact number is not.
    useLibraryStore.setState({ loans: [aLoan({ itemId: 'item_42', expiresAt: SERVER_NOW_MS + 2 * 86_400_000 })] });
    mockGetLibrary.mockRejectedValueOnce(new Error('network error'));

    await renderScreen();

    await waitFor(() => expect(screen.getByTestId('library-holdings-stale')).toBeTruthy());
    // The stale loan itself is still shown — see libraryStore's own
    // "stale beats blank" reasoning — just now flagged as unconfirmed.
    expect(screen.getByText('Due in 2 days')).toBeTruthy();
  });

  it('shows no stale-holdings notice once a refresh succeeds', async () => {
    givenHoldings([aLoan({ itemId: 'item_42' })], []);

    await renderScreen();

    await waitFor(() => expect(screen.getByText('Library')).toBeTruthy());
    expect(screen.queryByTestId('library-holdings-stale')).toBeNull();
  });
});

// On direct instruction: a downloaded Elite/Subscription title whose licence
// has actually lapsed is deleted from this device, not merely hidden, and the
// reader is told so. See LibraryScreen.tsx's own comment on the sweep effect.
describe('LibraryScreen — expiry sweep', () => {
  const LONG_AGO = SERVER_NOW_MS - 10 * 60_000; // outside the 2-minute race grace window

  it('deletes a downloaded Elite title once a confirmed refresh shows no matching active loan', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_42', title: 'Applied Thermodynamics', accessTier: 'ELITE' })],
        notFound: [],
        denied: [],
      })),
    );
    useDownloadStore.getState().markDownloaded({ itemId: 'item_42', downloadedAt: LONG_AGO });
    givenHoldings([], []); // a confirmed refresh; nothing held

    await renderScreen();

    await waitFor(() => expect(mockDestroy).toHaveBeenCalledWith('item_42'));
    await waitFor(() => expect(screen.getByTestId('expired-downloads-notice')).toBeTruthy());
    expect(
      screen.getByText('“Applied Thermodynamics” was removed from this device because its licence ended.'),
    ).toBeTruthy();
  });

  it('leaves a downloaded Subscription title alone while its own loan is still active', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_42', title: 'Applied Thermodynamics', accessTier: 'SUBSCRIPTION' })],
        notFound: [],
        denied: [],
      })),
    );
    useDownloadStore.getState().markDownloaded({ itemId: 'item_42', downloadedAt: LONG_AGO });
    givenHoldings([aLoan({ itemId: 'item_42' })], []);

    await renderScreen();
    await waitFor(() => expect(screen.getByText('Applied Thermodynamics')).toBeTruthy());

    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('never sweeps an Open Access download, which no loan ever backs', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_42', title: 'Applied Thermodynamics', accessTier: 'OPEN_ACCESS' })],
        notFound: [],
        denied: [],
      })),
    );
    useDownloadStore.getState().markDownloaded({ itemId: 'item_42', downloadedAt: LONG_AGO });
    givenHoldings([], []);

    await renderScreen();
    await waitFor(() => expect(screen.getByText('Applied Thermodynamics')).toBeTruthy());

    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('does not sweep a download still inside its own race-grace window', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_42', title: 'Applied Thermodynamics', accessTier: 'SUBSCRIPTION' })],
        notFound: [],
        denied: [],
      })),
    );
    // Downloaded moments ago — this device's own loans cache may simply not
    // have caught up yet with the borrow that happened server-side to grant
    // this download, not a genuinely expired licence.
    useDownloadStore.getState().markDownloaded({ itemId: 'item_42', downloadedAt: Date.now() });
    givenHoldings([], []);

    await renderScreen();
    await waitFor(() => expect(screen.getByText('Applied Thermodynamics')).toBeTruthy());

    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('dismisses the notice on tap, all at once', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_42', title: 'Applied Thermodynamics', accessTier: 'ELITE' })],
        notFound: [],
        denied: [],
      })),
    );
    useDownloadStore.getState().markDownloaded({ itemId: 'item_42', downloadedAt: LONG_AGO });
    givenHoldings([], []);

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('expired-downloads-notice')).toBeTruthy());

    await fireEvent.press(screen.getByText('Dismiss'));

    await waitFor(() => expect(screen.queryByTestId('expired-downloads-notice')).toBeNull());
  });
});

describe('LibraryScreen — Elite loan expiry notice', () => {
  it('tells the reader when a held Elite loan disappears after its own expiry', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_elite', title: 'Digital Media Cultures', accessTier: 'ELITE' })],
        notFound: [],
        denied: [],
      })),
    );
    const lapsedLoan = aLoan({ loanId: 'loan_elite', itemId: 'item_elite', expiresAt: SERVER_NOW_MS - 60_000 });
    givenHoldings([lapsedLoan], []);

    await renderScreen();
    await waitFor(() => expect(screen.getByText('Digital Media Cultures')).toBeTruthy());

    // The next refresh confirms the loan is genuinely gone — past its own
    // stated expiry, so this is a real lapse, not a voluntary give-back.
    mockGetLibrary.mockResolvedValue({ loans: [], holds: [] });
    await act(async () => {
      await useLibraryStore.getState().refresh();
    });

    await waitFor(() => expect(screen.getByTestId('expired-loans-notice')).toBeTruthy());
    expect(
      screen.getByText('Your access to “Digital Media Cultures” expired and it was removed from your library.'),
    ).toBeTruthy();
  });

  it('says nothing when an Elite loan disappears before its own expiry — a voluntary revoke, not a lapse', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_elite', title: 'Digital Media Cultures', accessTier: 'ELITE' })],
        notFound: [],
        denied: [],
      })),
    );
    const activeLoan = aLoan({
      loanId: 'loan_elite',
      itemId: 'item_elite',
      expiresAt: SERVER_NOW_MS + 3 * 86_400_000,
    });
    givenHoldings([activeLoan], []);

    await renderScreen();
    await waitFor(() => expect(screen.getByText('Digital Media Cultures')).toBeTruthy());

    // Gone on the next refresh, but well before its own `expiresAt` — the
    // same footprint `ItemDetailScreen`'s "Revoke licence" action leaves.
    mockGetLibrary.mockResolvedValue({ loans: [], holds: [] });
    await act(async () => {
      await useLibraryStore.getState().refresh();
    });

    await waitFor(() => expect(screen.queryByText('Digital Media Cultures')).toBeNull());
    expect(screen.queryByTestId('expired-loans-notice')).toBeNull();
  });

  it('dismisses the Elite-expiry notice on tap, all at once', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_elite', title: 'Digital Media Cultures', accessTier: 'ELITE' })],
        notFound: [],
        denied: [],
      })),
    );
    const lapsedLoan = aLoan({ loanId: 'loan_elite', itemId: 'item_elite', expiresAt: SERVER_NOW_MS - 60_000 });
    givenHoldings([lapsedLoan], []);

    await renderScreen();
    await waitFor(() => expect(screen.getByText('Digital Media Cultures')).toBeTruthy());

    mockGetLibrary.mockResolvedValue({ loans: [], holds: [] });
    await act(async () => {
      await useLibraryStore.getState().refresh();
    });

    await waitFor(() => expect(screen.getByTestId('expired-loans-notice')).toBeTruthy());
    await fireEvent.press(screen.getByText('Dismiss'));

    await waitFor(() => expect(screen.queryByTestId('expired-loans-notice')).toBeNull());
  });
});

describe('LibraryScreen — first load', () => {
  it('skeletons the All tab while holdings are still arriving', async () => {
    // A refresh that never answers. Seeding `loading: true` is not enough — the
    // mount-time refresh resolves and clears it before an assertion can run.
    mockGetLibrary.mockReturnValue(new Promise(() => {}));

    await renderScreen();

    await waitFor(() => expect(screen.getByTestId('library-loading')).toBeTruthy());
  });

  it('skeletons the Borrowed tab the same way', async () => {
    mockGetLibrary.mockReturnValue(new Promise(() => {}));

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-loans')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('tabs-tab-loans'));
    expect(screen.getByTestId('library-loading')).toBeTruthy();
  });

  // Nothing is pending behind them — they came off this device — so a
  // skeleton would hide rows that are already ready.
  it('never skeletons Downloads or Bookmarks, which cannot be loading', async () => {
    mockGetLibrary.mockReturnValue(new Promise(() => {}));
    useDownloadStore.getState().markDownloaded({ itemId: 'item_42', downloadedAt: 1 });

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-downloads')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('tabs-tab-downloads'));

    await waitFor(() => expect(screen.getByText('Downloaded')).toBeTruthy());
    expect(screen.queryByTestId('library-loading')).toBeNull();
  });
});

describe('LibraryScreen — the shelf is the launch screen', () => {
  it('refreshes on mount rather than waiting for a pull', async () => {
    await renderScreen();

    await waitFor(() => expect(mockGetLibrary).toHaveBeenCalled());
  });
});

// A bookmark's own "Read" opens the real reader directly — the same
// open-then-navigate path ItemDetailScreen's Read/Play action uses
// (`mockOpenBook`, mocked at the module boundary above) — rather than the
// inert `LibraryProvider` seam. Every other row navigates to `ItemDetail`
// instead (see the per-tab describe blocks above); this is the one row that
// cannot, because `ItemDetail` has no bookmark position to resume from.
describe('LibraryScreen — resuming a bookmark by tapping it directly', () => {
  it('opens a bookmarked title at the TAPPED bookmark’s own saved position, not just the most recent one', async () => {
    const older = await aBookmark('item_42', 12);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await aBookmark('item_42', 42);

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-bookmarks')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('tabs-tab-bookmarks'));
    await waitFor(() => expect(screen.getByText('2 bookmarks')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('content-card'));
    await waitFor(() => expect(screen.getByTestId(`bookmark-line-${older.id}`)).toBeTruthy());

    // Tap the OLDER bookmark's own line, not the newest one — proves Read
    // targets whichever bookmark was tapped rather than always the latest.
    await fireEvent.press(screen.getByTestId(`bookmark-line-${older.id}`));

    await waitFor(() => expect(mockOpenBook).toHaveBeenCalledWith('item_42', 'PDF'));
    expect(mockNavigate).toHaveBeenCalledWith('Reader', {
      bookId: 'item_42',
      format: 'PDF',
      initialTarget: { kind: 'page', page: 12 },
    });
  });

  it('shows a notice and stays put when opening a bookmark fails', async () => {
    const bookmark = await aBookmark('item_42');
    mockOpenBook.mockRejectedValueOnce(new Error('network unavailable'));

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-bookmarks')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('tabs-tab-bookmarks'));
    await waitFor(() => expect(screen.getByText('1 bookmark')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('content-card'));
    await waitFor(() => expect(screen.getByTestId(`bookmark-line-${bookmark.id}`)).toBeTruthy());

    await fireEvent.press(screen.getByTestId(`bookmark-line-${bookmark.id}`));

    await waitFor(() =>
      expect(screen.getByText('Couldn’t open that title. Try again from its detail page.')).toBeTruthy(),
    );
    expect(mockNavigate).not.toHaveBeenCalledWith('Reader', expect.anything());
  });

  it('ignores a second tap while the first resume is still in flight', async () => {
    const bookmark = await aBookmark('item_42');
    let releaseOpen: () => void = () => {};
    mockOpenBook.mockImplementationOnce(
      () => new Promise<Uint8Array>((resolve) => (releaseOpen = () => resolve(new Uint8Array()))),
    );

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-bookmarks')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('tabs-tab-bookmarks'));
    await waitFor(() => expect(screen.getByText('1 bookmark')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('content-card'));
    await waitFor(() => expect(screen.getByTestId(`bookmark-line-${bookmark.id}`)).toBeTruthy());

    const bookmarkLine = screen.getByTestId(`bookmark-line-${bookmark.id}`);
    await fireEvent.press(bookmarkLine);
    await waitFor(() => expect(screen.getByTestId('library-bookmark-opening')).toBeTruthy());
    await fireEvent.press(bookmarkLine);

    await waitFor(() => expect(mockOpenBook).toHaveBeenCalledTimes(1));

    releaseOpen();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('Reader', expect.anything()));
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('library-bookmark-opening')).toBeNull();
  });
});
