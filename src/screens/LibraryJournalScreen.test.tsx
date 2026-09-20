// src/screens/LibraryJournalScreen.test.tsx
// This reader's own article list for one journal — a route param in, one
// `getItemsBatch` hydration, one due-date badge per row sourced from the
// same `libraryStore` LibraryScreen.tsx itself reads. See the screen's own
// header for why this makes no query of its own for the article ids or the
// loans behind them.
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { DataSource } from '@adapters/InstitutionSource';
import { setCatalogueSource } from '@config/catalogue';
import type { BookSummary, Loan } from '@model/types';
import { useLibraryStore } from '@store/libraryStore';
import type { LibraryStackParamList } from '../navigation/types';

import LibraryJournalScreen from './LibraryJournalScreen';

const SERVER_NOW_MS = Date.parse(new Date().toISOString());

function aSummary(over: Partial<BookSummary> = {}): BookSummary {
  return {
    id: 'item_a1',
    title: 'On the Nature of Things',
    format: 'PDF',
    accessTier: 'SUBSCRIPTION',
    hasSearchIndex: false,
    ...over,
  };
}

function aLoan(over: Partial<Loan> = {}): Loan {
  return { loanId: 'loan_1', itemId: 'item_a1', state: 'active', ...over };
}

/** Every method a real DataSource must have — only `getItemsBatch` is exercised. */
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

type Props = { route: { params: LibraryStackParamList['LibraryJournal'] }; navigation: { navigate: jest.Mock } };

async function renderScreen(params: LibraryStackParamList['LibraryJournal']) {
  const navigate = jest.fn();
  const props = { route: { params }, navigation: { navigate } } as unknown as Parameters<
    typeof LibraryJournalScreen
  >[0] &
    Props;
  return { ...(await render(<LibraryJournalScreen {...props} />)), navigate };
}

beforeEach(() => {
  useLibraryStore.setState({ loans: [], holds: [], loading: false, refreshFailed: false, hasSyncedOnce: false });
});

afterEach(() => {
  setCatalogueSource(undefined);
});

describe('LibraryJournalScreen', () => {
  it('shows the journal title and a real article count', async () => {
    setCatalogueSource(fakeSource(async () => ({ items: [aSummary()], notFound: [], denied: [] })));

    await renderScreen({ journalWorkId: 'journal_1', journalTitle: 'Journal of Applied Thermodynamics', itemIds: ['item_a1'] });

    expect(screen.getByText('Journal of Applied Thermodynamics')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('On the Nature of Things')).toBeTruthy());
    expect(screen.getByText('1 article in your library')).toBeTruthy();
  });

  it('shows a due-date badge for an article this reader currently holds an active loan for', async () => {
    setCatalogueSource(fakeSource(async () => ({ items: [aSummary()], notFound: [], denied: [] })));
    useLibraryStore.setState({
      loans: [aLoan({ itemId: 'item_a1', expiresAt: SERVER_NOW_MS + 14 * 86_400_000 })],
      hasSyncedOnce: true,
    });

    await renderScreen({ journalWorkId: 'journal_1', journalTitle: 'Journal', itemIds: ['item_a1'] });

    await waitFor(() => expect(screen.getByText('Due in 14 days')).toBeTruthy());
  });

  it('shows no due-date badge for an article with no matching active loan', async () => {
    setCatalogueSource(fakeSource(async () => ({ items: [aSummary()], notFound: [], denied: [] })));

    await renderScreen({ journalWorkId: 'journal_1', journalTitle: 'Journal', itemIds: ['item_a1'] });

    await waitFor(() => expect(screen.getByText('On the Nature of Things')).toBeTruthy());
    expect(screen.queryByText(/^Due /)).toBeNull();
  });

  it('navigates to the article’s own detail page when a row is tapped', async () => {
    setCatalogueSource(fakeSource(async () => ({ items: [aSummary()], notFound: [], denied: [] })));

    const { navigate } = await renderScreen({ journalWorkId: 'journal_1', journalTitle: 'Journal', itemIds: ['item_a1'] });
    await waitFor(() => expect(screen.getByText('On the Nature of Things')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('content-card'));

    expect(navigate).toHaveBeenCalledWith('ItemDetail', { itemId: 'item_a1' });
  });

  it('falls back to the raw item id when a title fails to hydrate', async () => {
    setCatalogueSource(fakeSource(async () => ({ items: [], notFound: ['item_a1'], denied: [] })));

    await renderScreen({ journalWorkId: 'journal_1', journalTitle: 'Journal', itemIds: ['item_a1'] });

    await waitFor(() => expect(screen.getByText('item_a1')).toBeTruthy());
  });

  it('shows a retryable error state when hydration itself fails', async () => {
    const getItemsBatch = jest
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ items: [aSummary()], notFound: [], denied: [] });
    setCatalogueSource(fakeSource(getItemsBatch));

    await renderScreen({ journalWorkId: 'journal_1', journalTitle: 'Journal', itemIds: ['item_a1'] });

    await waitFor(() => expect(screen.getByText("Couldn't load these articles.")).toBeTruthy());

    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.getByText('On the Nature of Things')).toBeTruthy());
  });
});
