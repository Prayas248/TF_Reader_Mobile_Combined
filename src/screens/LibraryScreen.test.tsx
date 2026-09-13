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
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { Bookmark } from '@/shared/contracts';
import { LibraryProviderContext } from '@/features/library/context';
import type { LibraryProvider } from '@/features/library/ports';
import type { DataSource } from '@adapters/InstitutionSource';
import { setCatalogueSource } from '@config/catalogue';
import type { BookSummary, Hold, Loan } from '@model/types';
import { useBookmarkStore } from '@store/bookmarkStore';
import { useDownloadStore } from '@store/downloadStore';
import { useLibraryStore } from '@store/libraryStore';

import LibraryScreen from './LibraryScreen';

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
    getPublicPublication: unused,
    getInstitutions: unused,
    getInstitution: unused,
    getItemsBatch,
    getWork: unused,
  };
}

/** Seeds the store and makes the mount-time refresh return the same thing. */
function givenHoldings(loans: Loan[], holds: Hold[]): void {
  useLibraryStore.setState({ loans, holds, loading: false });
  mockGetLibrary.mockResolvedValue({ loans, holds });
}

function aBookmark(over: Partial<Bookmark> = {}): Bookmark {
  return {
    id: 'bm_1',
    userId: 'user_1',
    bookId: 'item_42',
    locator: { type: 'PDF', page: 12 },
    createdAt: SERVER_NOW_MS,
    updatedAt: SERVER_NOW_MS,
    isDeleted: false,
    synced: false,
    ...over,
  };
}

const mockNavigate = jest.fn();

/** `LibraryScreen`'s own minimal hand-typed navigation prop. */
function renderScreen(provider?: LibraryProvider) {
  const element = <LibraryScreen navigation={{ navigate: mockNavigate }} />;
  if (provider === undefined) return render(element);
  return render(<LibraryProviderContext.Provider value={provider}>{element}</LibraryProviderContext.Provider>);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseNetworkStatus.mockReturnValue(true);
  mockGetLibrary.mockResolvedValue({ loans: [], holds: [] });
  mockAcceptOffer.mockResolvedValue({ loanId: 'loan_new', itemId: 'item_99', state: 'active' });
  mockCancelHold.mockResolvedValue(undefined);
  mockBorrow.mockResolvedValue({ loanId: 'loan_new', itemId: 'item_42', state: 'active' });
  useLibraryStore.setState({ loans: [], holds: [], loading: false });
  // Device-local and persisted, so unlike libraryStore these survive a test and
  // would leak a download into the next one's "empty shelf".
  useDownloadStore.getState().clear();
  useBookmarkStore.getState().clear();
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
  it('names exactly five tabs: All, Borrowed, Downloads, Bookmarks, Premium', async () => {
    await renderScreen();

    await waitFor(() => expect(screen.getByTestId('tabs-tab-all')).toBeTruthy());
    expect(screen.getByTestId('tabs-label-loans').props.children).toBe('Borrowed');
    expect(screen.getByTestId('tabs-label-downloads').props.children).toBe('Downloads');
    expect(screen.getByTestId('tabs-label-bookmarks').props.children).toBe('Bookmarks');
    expect(screen.getByTestId('tabs-label-holds').props.children).toBe('Premium');
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
    givenHoldings([aLoan({ itemId: 'item_42', expiresAt: SERVER_NOW_MS + 86_400_000 })], []);
    useDownloadStore.getState().markDownloaded({ itemId: 'item_42', downloadedAt: 1 });

    await renderScreen();

    await waitFor(() => expect(screen.getAllByText('Playful Identities')).toHaveLength(1));
    expect(screen.getByText('1 item')).toBeTruthy();
    // Both facts about the one book still show, merged onto the same row.
    expect(screen.getByText('Due in 1 day')).toBeTruthy();
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
});

describe('LibraryScreen — Borrowed tab', () => {
  async function openBorrowed() {
    await fireEvent.press(screen.getByTestId('tabs-tab-loans'));
  }

  it('always shows the "Borrowed" heading and a compact hint, even when empty', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-loans')).toBeTruthy());

    await openBorrowed();

    expect(screen.getByTestId('tab-heading-borrowed')).toBeTruthy();
    expect(screen.getByText('No items currently borrowed.')).toBeTruthy();
    expect(screen.getByText('Items you borrow will appear here until they’re due.')).toBeTruthy();
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
    // The hint's plain caption stays, under the real row — it never
    // disappears just because the tab now has something in it.
    expect(screen.getByText('Items you borrow will appear here until they’re due.')).toBeTruthy();
  });

  it('excludes an Elite loan — Elite is Premium’s, not Borrowed’s', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_42', accessTier: 'ELITE' })],
        notFound: [],
        denied: [],
      })),
    );
    givenHoldings([aLoan({ itemId: 'item_42' })], []);

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-loans')).toBeTruthy());
    await openBorrowed();

    await waitFor(() => expect(screen.getByText('No items currently borrowed.')).toBeTruthy());
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
        items: [aSummary({ id: 'item_42', title: 'Applied Thermodynamics' })],
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
        items: [aSummary({ id: 'item_42', title: 'Applied Thermodynamics', format: 'PDF' })],
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
    useBookmarkStore.getState().addBookmark(aBookmark({ id: 'bm_1', bookId: 'item_42' }));
    useBookmarkStore.getState().addBookmark(aBookmark({ id: 'bm_2', bookId: 'item_42' }));

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-bookmarks')).toBeTruthy());
    await openBookmarks();

    await waitFor(() => expect(screen.getByText('2 bookmarks')).toBeTruthy());
  });

  it('shows a real count of bookmarked TITLES for the tab, not of bookmarks', async () => {
    useBookmarkStore.getState().addBookmark(aBookmark({ id: 'bm_1', bookId: 'item_42' }));
    useBookmarkStore.getState().addBookmark(aBookmark({ id: 'bm_2', bookId: 'item_42' }));
    useBookmarkStore.getState().addBookmark(aBookmark({ id: 'bm_3', bookId: 'item_99' }));

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-bookmarks')).toBeTruthy());
    await openBookmarks();

    // Two TITLES (item_42, item_99), even though there are three bookmarks.
    await waitFor(() => expect(screen.getByText('2 items')).toBeTruthy());
  });

  it('expands a title in place to show its real bookmarks, rather than navigating', async () => {
    useBookmarkStore
      .getState()
      .addBookmark(aBookmark({ id: 'bm_1', bookId: 'item_42', locator: { type: 'PDF', page: 12 } }));
    useBookmarkStore
      .getState()
      .addBookmark(aBookmark({ id: 'bm_2', bookId: 'item_42', locator: { type: 'PDF', page: 88 } }));

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
    useBookmarkStore.getState().addBookmark(aBookmark({ locator: { type: 'PDF', page: 12 } }));

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
    useBookmarkStore.getState().addBookmark(aBookmark({ name: 'The proof', locator: { type: 'PDF', page: 12 } }));

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-bookmarks')).toBeTruthy());
    await openBookmarks();
    await fireEvent.press(screen.getByTestId('content-card'));

    await waitFor(() => expect(screen.getByText(/The proof/)).toBeTruthy());
  });

  it('offers Download for a title not yet on this device', async () => {
    useBookmarkStore.getState().addBookmark(aBookmark({ bookId: 'item_42' }));

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-bookmarks')).toBeTruthy());
    await openBookmarks();
    await fireEvent.press(screen.getByTestId('content-card'));

    await waitFor(() => expect(screen.getByTestId('action-button-download')).toBeTruthy());
  });

  it('omits Download once the title is already on this device', async () => {
    useBookmarkStore.getState().addBookmark(aBookmark({ bookId: 'item_42' }));
    useDownloadStore.getState().markDownloaded({ itemId: 'item_42', downloadedAt: 1 });

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-bookmarks')).toBeTruthy());
    await openBookmarks();
    await fireEvent.press(screen.getByTestId('content-card'));

    await waitFor(() => expect(screen.getByText(/Page 12/)).toBeTruthy());
    expect(screen.queryByTestId('action-button-download')).toBeNull();
  });

  it('downloads the title through the same borrow-then-record call ItemDetailScreen uses', async () => {
    useBookmarkStore.getState().addBookmark(aBookmark({ bookId: 'item_42' }));

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-bookmarks')).toBeTruthy());
    await openBookmarks();
    await fireEvent.press(screen.getByTestId('content-card'));
    await waitFor(() => expect(screen.getByTestId('action-button-download')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('action-button-download'));

    await waitFor(() => expect(mockBorrow).toHaveBeenCalledWith('item_42'));
  });
});

describe('LibraryScreen — Premium tab', () => {
  async function openPremium() {
    await fireEvent.press(screen.getByTestId('tabs-tab-holds'));
  }

  it('always shows "Your Elite access" and "Waiting for access", each with its own compact hint when empty', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-holds')).toBeTruthy());

    await openPremium();

    expect(screen.getByText('Your Elite access')).toBeTruthy();
    expect(screen.getByText('No active Elite access.')).toBeTruthy();
    expect(screen.getByText('Waiting for access')).toBeTruthy();
    expect(screen.getByText('No items currently waiting.')).toBeTruthy();
  });

  it('reserves no heading or hint for a pending offer when there is none', async () => {
    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-holds')).toBeTruthy());

    await openPremium();

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
    await waitFor(() => expect(screen.getByTestId('tabs-tab-holds')).toBeTruthy());
    await openPremium();

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

  it('does not show a subscription loan here — Premium is Elite-only', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_42', accessTier: 'SUBSCRIPTION' })],
        notFound: [],
        denied: [],
      })),
    );
    givenHoldings([aLoan({ itemId: 'item_42' })], []);

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-holds')).toBeTruthy());
    await openPremium();

    await waitFor(() => expect(screen.getByText('No active Elite access.')).toBeTruthy());
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
    await waitFor(() => expect(screen.getByTestId('tabs-tab-holds')).toBeTruthy());
    await openPremium();
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
    useBookmarkStore.getState().addBookmark(aBookmark({ bookId: 'item_22' }));

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

describe('LibraryScreen — first load', () => {
  it('skeletons the All tab while holdings are still arriving', async () => {
    // A refresh that never answers. Seeding `loading: true` is not enough — the
    // mount-time refresh resolves and clears it before an assertion can run.
    mockGetLibrary.mockReturnValue(new Promise(() => {}));

    await renderScreen();

    await waitFor(() => expect(screen.getByTestId('library-loading')).toBeTruthy());
  });

  it('skeletons the Borrowed and Premium tabs the same way', async () => {
    mockGetLibrary.mockReturnValue(new Promise(() => {}));

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-loans')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('tabs-tab-loans'));
    expect(screen.getByTestId('library-loading')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('tabs-tab-holds'));
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

// The provider seam (src/features/library) is now used ONLY by a bookmark
// group's own "Read" action — it resumes at the exact saved position, which
// `ItemDetail` cannot reproduce. Every other row navigates instead (see the
// per-tab describe blocks above).
describe('LibraryScreen — resuming a bookmark through the provider', () => {
  function makeProvider(over: Partial<LibraryProvider> = {}): LibraryProvider {
    return {
      listDownloads: async () => [],
      listBookmarks: async () => [],
      openBook: jest.fn().mockResolvedValue(undefined),
      openReader: jest.fn(),
      ...over,
    };
  }

  it('opens a bookmarked title at its most recent bookmark through the group’s Read action', async () => {
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_42', title: 'Applied Thermodynamics', format: 'PDF' })],
        notFound: [],
        denied: [],
      })),
    );
    useBookmarkStore.getState().addBookmark(
      aBookmark({
        id: 'bm_old',
        bookId: 'item_42',
        locator: { type: 'PDF', page: 12 },
        updatedAt: SERVER_NOW_MS - 60_000,
      }),
    );
    useBookmarkStore.getState().addBookmark(
      aBookmark({ id: 'bm_new', bookId: 'item_42', locator: { type: 'PDF', page: 42 }, updatedAt: SERVER_NOW_MS }),
    );
    const provider = makeProvider();

    await renderScreen(provider);
    await waitFor(() => expect(screen.getByTestId('tabs-tab-bookmarks')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('tabs-tab-bookmarks'));
    await waitFor(() => expect(screen.getByText('2 bookmarks')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('content-card'));
    await waitFor(() => expect(screen.getByTestId('action-button-read')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('action-button-read'));

    await waitFor(() => expect(provider.openBook).toHaveBeenCalledWith('item_42', 'PDF'));
    expect(provider.openReader).toHaveBeenCalledWith({
      itemId: 'item_42',
      format: 'PDF',
      initialTarget: { kind: 'page', page: 42 },
    });
  });

  it('shows an honest, user-appropriate notice when the reader is not in this build — never the internal implementation note', async () => {
    useBookmarkStore.getState().addBookmark(aBookmark({ bookId: 'item_42' }));
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_42', title: 'Applied Thermodynamics', format: 'PDF' })],
        notFound: [],
        denied: [],
      })),
    );

    await renderScreen();
    await waitFor(() => expect(screen.getByTestId('tabs-tab-bookmarks')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('tabs-tab-bookmarks'));
    await waitFor(() => expect(screen.getByText('1 bookmark')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('content-card'));
    await waitFor(() => expect(screen.getByTestId('action-button-read')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('action-button-read'));

    await waitFor(() => expect(screen.getByText('This title isn’t available to read yet.')).toBeTruthy());
    expect(screen.queryByText(/merged app/)).toBeNull();
  });

  it('ignores a second tap while the first resume is still in flight', async () => {
    useBookmarkStore.getState().addBookmark(aBookmark({ bookId: 'item_42' }));
    setCatalogueSource(
      fakeSource(async () => ({
        items: [aSummary({ id: 'item_42', title: 'Applied Thermodynamics', format: 'PDF' })],
        notFound: [],
        denied: [],
      })),
    );
    let releaseOpen: () => void = () => {};
    const openBook = jest.fn(() => new Promise<void>((resolve) => (releaseOpen = resolve)));
    const provider = makeProvider({ openBook });

    await renderScreen(provider);
    await waitFor(() => expect(screen.getByTestId('tabs-tab-bookmarks')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('tabs-tab-bookmarks'));
    await waitFor(() => expect(screen.getByText('1 bookmark')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('content-card'));
    await waitFor(() => expect(screen.getByTestId('action-button-read')).toBeTruthy());

    const readButton = screen.getByTestId('action-button-read');
    await fireEvent.press(readButton);
    await fireEvent.press(readButton);

    await waitFor(() => expect(openBook).toHaveBeenCalledTimes(1));

    releaseOpen();
    await waitFor(() => expect(provider.openReader).toHaveBeenCalledTimes(1));
  });
});
