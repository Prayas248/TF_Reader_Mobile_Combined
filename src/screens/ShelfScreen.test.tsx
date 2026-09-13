// src/screens/ShelfScreen.test.tsx
// One shelf, fetched by id and rendered as a section + its publications.
//
// Same seam as CatalogueScreen.test.tsx: inject a fake DataSource through
// `setCatalogueSource` rather than hitting MockAdapter's fixtures, so these
// tests pin the screen's own wiring (loading -> data -> error -> retry, and
// the press -> navigate contract) independently of what the fixtures contain.
//
// `await render(...)` is required — RTL 14's render is async.
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { DataSource } from '@adapters/InstitutionSource';
import { setCatalogueSource } from '@config/catalogue';
import type { Shelf } from '@model/types';
import type { CatalogueStackParamList } from '@navigation/types';

import { useLibraryStore } from '@store/libraryStore';
import { useSessionStore } from '@store/sessionStore';

import ShelfScreen from './ShelfScreen';

// The licence seam is faked so nothing here reaches a real client. This screen
// makes no licence call of its own — D12 is item detail only — but the store it
// shares can, so the source has to answer.
jest.mock('@config/licence', () => ({
  // sessionStore.ts calls this at module load — the currentSession.ts import
  // chain (ShelfScreen → currentSession → sessionStore) now pulls sessionStore
  // in even though this file never touches it directly.
  setLicenceToken: jest.fn(),
  getLicenceSource: () => ({
    getLibrary: () => Promise.resolve({ loans: [], holds: [] }),
    borrow: jest.fn(),
    placeHold: jest.fn(),
    acceptOffer: jest.fn(),
    cancelHold: jest.fn(),
  }),
}));

// Must be prefixed `mock` — Jest's module-factory scope guard only allows
// referencing out-of-scope variables whose name starts with "mock".
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

// `useNetworkStatus` talks to NetInfo, which has no meaningful answer under Jest
// — left real, its `fetch()` throws on `isInternetReachable` and every test in
// this file dies at module level. Mocked per-test so the offline case can be
// driven directly, the same pattern CatalogueScreen.test.tsx uses.
const mockUseNetworkStatus = jest.fn(() => true);
jest.mock('@hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => mockUseNetworkStatus(),
}));

function publication(id: string, title: string): Shelf['publications'][number] {
  return {
    id,
    title,
    publisher: 'Routledge',
    authors: ['Joshua C. Gellers'],
    subjects: [],
    format: 'PDF',
    acquisition: {
      actionId: 'borrow',
      href: `https://x/loan/${id}`,
      licenceModel: 'SUBSCRIPTION',
      encryption: null,
      hasSearchIndex: true,
      canPersist: true,
    },
  };
}

// An open access title, for the badge tests: `publication` above is always
// SUBSCRIPTION, and a shelf of one tier cannot show that rows are badged
// individually rather than all from the first one.
function openAccessPublication(id: string, title: string): Shelf['publications'][number] {
  const base = publication(id, title);
  return {
    ...base,
    acquisition: { ...base.acquisition, actionId: 'openAccess', licenceModel: 'OPEN_ACCESS' },
  };
}

// A single-page shelf: no `next` link in the feed, so no `nextPage` and no
// "Load more".
const FAKE_SHELF: Shelf = {
  id: 'ebooks',
  title: 'eBooks',
  publications: [publication('item_42', 'Rights for Robots')],
};

// Two tiers on one shelf, like fixture 03 (ELITE + SUBSCRIPTION) and 04
// (ELITE + OPEN_ACCESS).
const MIXED_TIER_SHELF: Shelf = {
  id: 'all',
  title: 'All titles',
  publications: [
    publication('item_42', 'Rights for Robots'),
    openAccessPublication('item_ab6', 'Ethnographies of Waiting'),
  ],
};

// A shelf spread over two pages, shaped like 02-shelf-group.json: 3 items in
// pages of 2, page 0 advertising `nextPage: 1` and page 1 advertising none.
const PAGE_0: Shelf = {
  id: 'ebooks',
  title: 'eBooks',
  totalItems: 3,
  itemsPerPage: 2,
  nextPage: 1,
  publications: [
    publication('item_42', 'Rights for Robots'),
    publication('item_env', 'Environmental Policy and Air Pollution in China'),
  ],
};

const PAGE_1: Shelf = {
  id: 'ebooks',
  title: 'eBooks',
  totalItems: 3,
  itemsPerPage: 2,
  publications: [publication('item_stat', 'An Introduction to Statistics')],
};

// Every method a real DataSource must have, so the fake typechecks as one.
// Only `getShelf` is exercised — the rest throw if the screen ever reaches
// for them, which would mean it grew a dependency this suite does not know
// to fake.
function fakeSource(getShelf: DataSource['getShelf']): DataSource {
  const unused = () => Promise.reject(new Error('not stubbed for this test'));
  return {
    getHomeCatalogue: unused,
    getShelf,
    getPublication: unused,
    getPublicFeed: unused,
    getPublicPublication: unused,
    getInstitutions: unused,
    getInstitution: unused,
    getItemsBatch: unused,
    getWork: unused,
  };
}

// Serves a shelf page-by-page, indexed by the `page` argument, so a Load-more
// press exercises the real cursor rather than a hardcoded second response.
// An omitted page means the first one, matching how the adapters behave.
function pagedSource(pages: Shelf[]) {
  const getShelf = jest.fn(
    async (_institutionId: string, _shelfId: string, page?: number): Promise<Shelf> => {
      const requested = pages[page ?? 0];
      if (requested === undefined) throw new Error(`no fixture for page ${String(page)}`);
      return requested;
    },
  );
  setCatalogueSource(fakeSource(getShelf));
  return getShelf;
}

// Route props ShelfScreen reads (`shelfId` and `institutionId`). `title` is in
// the param list because RootNavigator uses it for the app bar, so it is supplied
// here for type parity even though the screen itself never reads it.
// `navigation` is never read from props — the screen gets it from the
// `useNavigation` mock above — so it is cast rather than fully constructed.
type ShelfProps = { route: { params: CatalogueStackParamList['Shelf'] } };
function propsFor(params: CatalogueStackParamList['Shelf']) {
  return { route: { params } } as unknown as Parameters<typeof ShelfScreen>[0] & ShelfProps;
}
const routeProps = propsFor({
  shelfId: 'ebooks',
  title: 'eBooks',
  institutionId: 'inst_7f3',
});

afterEach(() => {
  setCatalogueSource(undefined);
  mockNavigate.mockClear();
  mockUseNetworkStatus.mockReturnValue(true);
  useSessionStore.getState().clearSession();
});

describe('ShelfScreen loading', () => {
  it('shows skeletons before the shelf arrives', async () => {
    // Never resolves within the test, so the screen is caught mid-load.
    setCatalogueSource(fakeSource(() => new Promise(() => {})));

    await render(<ShelfScreen {...routeProps} />);

    expect(screen.getAllByTestId('content-card-skeleton').length).toBeGreaterThan(0);
  });
});

describe('ShelfScreen with data', () => {
  it('requests the shelf named in route.params, not a hardcoded id', async () => {
    const getShelf = jest.fn(async (_institutionId: string, _shelfId: string) => FAKE_SHELF);
    setCatalogueSource(fakeSource(getShelf));

    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(getShelf).toHaveBeenCalled());
    // Second argument is the shelfId — the first is the institution, asserted
    // in its own test below.
    expect(getShelf.mock.calls[0][1]).toBe('ebooks');
  });

  // A reader at one institution must never be served another's shelf. The id
  // here is deliberately NOT the fixture default 'inst_7f3', because the bug
  // this pins was a hardcoded constant that matched that default exactly and so
  // looked correct from every test that used it. The load-more call is asserted
  // too: the paging path built its own request and could pass a different id
  // from the first page's without anything on screen looking wrong.
  it('sends the route’s institution id on the first page and on load more', async () => {
    const getShelf = pagedSource([PAGE_0, PAGE_1]);

    await render(<ShelfScreen {...propsFor({ ...routeProps.route.params, institutionId: 'inst_a21' })} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy());

    await fireEvent.press(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(getShelf).toHaveBeenCalledTimes(2));
    expect(getShelf.mock.calls[0][0]).toBe('inst_a21');
    expect(getShelf.mock.calls[1][0]).toBe('inst_a21');
  });

  it('renders the publications the shelf carries', async () => {
    setCatalogueSource(fakeSource(async () => FAKE_SHELF));

    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
  });

  it('navigates to ItemDetail with the publication id when a row is pressed', async () => {
    setCatalogueSource(fakeSource(async () => FAKE_SHELF));

    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    fireEvent.press(screen.getByRole('button', { name: 'Rights for Robots' }));

    expect(mockNavigate).toHaveBeenCalledWith('ItemDetail', { itemId: 'item_42' });
  });
});

// A3 — every row carries its access tier, resolved per row rather than once for
// the shelf. Both labels are asserted because a single-tier shelf cannot tell
// the two apart.
describe('ShelfScreen access-tier badges', () => {
  it('gives every publication row a badge', async () => {
    setCatalogueSource(fakeSource(async () => MIXED_TIER_SHELF));

    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    expect(screen.getAllByTestId('content-card-badge')).toHaveLength(2);
  });

  it('labels a subscription title and an open access title differently', async () => {
    setCatalogueSource(fakeSource(async () => MIXED_TIER_SHELF));

    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Subscription')).toBeTruthy());
    expect(screen.getByText('Open Access')).toBeTruthy();
  });

  it('badges the rows a later page brings in too', async () => {
    pagedSource([PAGE_0, PAGE_1]);

    await render(<ShelfScreen {...routeProps} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy());

    await fireEvent.press(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(screen.getByText('An Introduction to Statistics')).toBeTruthy());
    // Two rows from page 0, one from page 1.
    expect(screen.getAllByTestId('content-card-badge')).toHaveLength(3);
  });
});

describe('ShelfScreen error', () => {
  it('shows a retry affordance when the shelf fails to load, and retrying re-fetches', async () => {
    let attempt = 0;
    setCatalogueSource(
      fakeSource(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('network down');
        return FAKE_SHELF;
      }),
    );

    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText(/couldn.?t load/i)).toBeTruthy());

    fireEvent.press(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    expect(attempt).toBe(2);
  });

  // getShelf now requires a signed-in reader (appToken). ShelfScreen mounts off
  // route params alone, ahead of sign-in — a reader can be looking at it, signed
  // out and failed, with the sign-in sheet stacked on top. Same bug and same
  // test shape as CatalogueScreen.test.tsx's "re-fetches on its own" case.
  it('re-fetches on its own once the reader signs in, without a manual retry', async () => {
    let attempt = 0;
    setCatalogueSource(
      fakeSource(async () => {
        attempt += 1;
        if (!useSessionStore.getState().isAuthenticated) throw new Error('401');
        return FAKE_SHELF;
      }),
    );

    await render(<ShelfScreen {...routeProps} />);
    await waitFor(() => expect(screen.getByText(/couldn.?t load/i)).toBeTruthy());

    useSessionStore.getState().setSession({
      accessToken: 'tok_abc123',
      expiresIn: 900,
      userId: 'user_1',
      institutionId: routeProps.route.params.institutionId,
      roles: [],
      collections: [],
    });

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    expect(attempt).toBe(2);
  });
});

describe('ShelfScreen pagination', () => {
  it('offers no Load more when the feed advertises no next page', async () => {
    // FAKE_SHELF has no `nextPage`, the normalized form of "no next link".
    setCatalogueSource(fakeSource(async () => FAKE_SHELF));

    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('offers Load more when the feed advertises a next page', async () => {
    pagedSource([PAGE_0, PAGE_1]);

    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy());
  });

  it('requests the page number the feed named, never first + 1', async () => {
    // PAGE_0 says `nextPage: 1`, so that exact value must reach the adapter —
    // arithmetic here would be a second source of truth for the cursor.
    const getShelf = pagedSource([PAGE_0, PAGE_1]);

    await render(<ShelfScreen {...routeProps} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy());

    await fireEvent.press(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(getShelf).toHaveBeenCalledTimes(2));
    // Third argument is the page; the first call omits it entirely.
    expect(getShelf.mock.calls[0][2]).toBeUndefined();
    expect(getShelf.mock.calls[1][2]).toBe(1);
  });

  it('appends the next page instead of replacing what is on screen', async () => {
    pagedSource([PAGE_0, PAGE_1]);

    await render(<ShelfScreen {...routeProps} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy());

    await fireEvent.press(screen.getByRole('button', { name: 'Load more' }));

    // Page 1's row arrives...
    await waitFor(() => expect(screen.getByText('An Introduction to Statistics')).toBeTruthy());
    // ...and page 0's rows are still there, which is the whole point of paging.
    expect(screen.getByText('Rights for Robots')).toBeTruthy();
    expect(screen.getByText('Environmental Policy and Air Pollution in China')).toBeTruthy();
  });

  it('withdraws Load more once a page arrives with no next page', async () => {
    pagedSource([PAGE_0, PAGE_1]);

    await render(<ShelfScreen {...routeProps} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy());

    await fireEvent.press(screen.getByRole('button', { name: 'Load more' }));

    // Gone, not disabled: PAGE_1 carries no `nextPage`, so there is nothing left
    // to fetch and a dead button would read as broken.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull(),
    );
  });

  it('counts loaded rows against the server-reported total, not the page size', async () => {
    pagedSource([PAGE_0, PAGE_1]);

    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText(/Showing 2 of 3/)).toBeTruthy());

    await fireEvent.press(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(screen.getByText(/Showing 3 of 3/)).toBeTruthy());
  });

  it('keeps the loaded rows when a later page fails, and retries in place', async () => {
    let pageOneAttempts = 0;
    const getShelf = jest.fn(
      async (_institutionId: string, _shelfId: string, page?: number): Promise<Shelf> => {
        if (page === undefined) return PAGE_0;
        pageOneAttempts += 1;
        if (pageOneAttempts === 1) throw new Error('network down mid-scroll');
        return PAGE_1;
      },
    );
    setCatalogueSource(fakeSource(getShelf));

    await render(<ShelfScreen {...routeProps} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy());

    await fireEvent.press(screen.getByRole('button', { name: 'Load more' }));

    // The failure is reported inline...
    await waitFor(() => expect(screen.getByText(/couldn.?t load more/i)).toBeTruthy());
    // ...and does NOT escalate to the full-screen error, so page 0 survives.
    expect(screen.getByText('Rights for Robots')).toBeTruthy();
    expect(screen.queryByText(/couldn.?t load this shelf/i)).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: /couldn.?t load more/i }));

    await waitFor(() => expect(screen.getByText('An Introduction to Statistics')).toBeTruthy());
    expect(pageOneAttempts).toBe(2);
  });

  it('ignores a second press while a page is already in flight', async () => {
    // Page 1 never resolves, so the button stays in its loading state and a
    // second press must not start a duplicate request.
    const getShelf = jest.fn(
      async (_institutionId: string, _shelfId: string, page?: number): Promise<Shelf> =>
        page === undefined ? PAGE_0 : new Promise<Shelf>(() => {}),
    );
    setCatalogueSource(fakeSource(getShelf));

    await render(<ShelfScreen {...routeProps} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy());

    await fireEvent.press(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByText('Loading…')).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Loading…' }));

    expect(getShelf).toHaveBeenCalledTimes(2);
  });
});

// `all` never 404s, so a shelf with nothing in it arrives as a SUCCESS with no
// publications — not a rejection. The screen has to read that as empty rather
// than broken. Rendering the empty state itself is Khushi's Week 3 work; what
// is pinned here is that the parse survives and the error path stays shut.
describe('ShelfScreen with a zero-result shelf', () => {
  const EMPTY_SHELF: Shelf = {
    id: 'all',
    title: 'All titles',
    totalItems: 0,
    publications: [],
    browseInstead: [
      {
        title: 'Browse the full catalogue',
        href: 'https://api.tf/opds/v1/institutions/inst_7f3/catalogue',
        shelfId: 'catalogue',
        target: 'catalogue',
      },
    ],
  };

  it('does not show the error state for a shelf that legitimately has nothing', async () => {
    setCatalogueSource(fakeSource(async () => EMPTY_SHELF));

    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText(/showing 0 of 0/i)).toBeTruthy());
    expect(screen.queryByText(/couldn.?t load/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('offers no Load more, since an empty feed carries no next link', async () => {
    setCatalogueSource(fakeSource(async () => EMPTY_SHELF));

    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText(/showing 0 of 0/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});

// Screen 12 — the filter & sort sheet.
describe('ShelfScreen filter & sort', () => {
  it('requests no filters or sort on first load', async () => {
    const getShelf = jest.fn<ReturnType<DataSource['getShelf']>, Parameters<DataSource['getShelf']>>(
      async () => FAKE_SHELF,
    );
    setCatalogueSource(fakeSource(getShelf));

    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(getShelf).toHaveBeenCalled());
    expect(getShelf.mock.calls[0][3]).toEqual({
      contentType: undefined,
      accessTier: undefined,
      sort: undefined,
    });
  });

  it('greys the sort row and explains why on a shelf other than all', async () => {
    setCatalogueSource(fakeSource(async () => FAKE_SHELF));
    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    fireEvent.press(screen.getByLabelText('Filter & Sort eBooks'));

    await waitFor(() => expect(screen.getByLabelText('Newest')).toBeTruthy());
    expect(screen.getByTestId('filter-sort-sheet-sort-note')).toBeTruthy();
    expect(screen.getByLabelText('Newest').props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });

  it('re-fetches with the chosen content type once Apply Filters is pressed', async () => {
    const getShelf = jest.fn<ReturnType<DataSource['getShelf']>, Parameters<DataSource['getShelf']>>(
      async () => FAKE_SHELF,
    );
    setCatalogueSource(fakeSource(getShelf));
    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Filter & Sort eBooks'));
    await waitFor(() => expect(screen.getByLabelText('Audiobooks')).toBeTruthy());

    await fireEvent.press(screen.getByLabelText('Audiobooks'));
    await fireEvent.press(screen.getByTestId('filter-sort-sheet-apply'));

    await waitFor(() => expect(getShelf).toHaveBeenCalledTimes(2));
    expect(getShelf.mock.calls[1][3]).toMatchObject({ contentType: 'AUDIO' });
    // Pressing Apply closes the sheet (BottomSheet animates its exit, hence waitFor).
    await waitFor(() => expect(screen.queryByTestId('filter-sort-sheet-apply')).toBeNull());
  });

  it('carries the applied filter into a subsequent Load more request', async () => {
    const getShelf = jest.fn<ReturnType<DataSource['getShelf']>, Parameters<DataSource['getShelf']>>(
      async (_institutionId, _shelfId, page) => (page === undefined ? PAGE_0 : PAGE_1),
    );
    setCatalogueSource(fakeSource(getShelf));
    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Filter & Sort eBooks'));
    await waitFor(() => expect(screen.getByLabelText('PDF')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('PDF'));
    await fireEvent.press(screen.getByTestId('filter-sort-sheet-apply'));

    await waitFor(() => expect(getShelf).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(getShelf).toHaveBeenCalledTimes(3));
    expect(getShelf.mock.calls[2][2]).toBe(1);
    expect(getShelf.mock.calls[2][3]).toMatchObject({ contentType: 'PDF' });
  });

  it('resets to no filters when Clear All is pressed', async () => {
    const getShelf = jest.fn<ReturnType<DataSource['getShelf']>, Parameters<DataSource['getShelf']>>(
      async () => FAKE_SHELF,
    );
    setCatalogueSource(fakeSource(getShelf));
    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Filter & Sort eBooks'));
    await waitFor(() => expect(screen.getByLabelText('Audiobooks')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Audiobooks'));
    await fireEvent.press(screen.getByTestId('filter-sort-sheet-apply'));
    await waitFor(() => expect(getShelf).toHaveBeenCalledTimes(2));

    await waitFor(() => expect(screen.getByLabelText('Filter & Sort eBooks')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Filter & Sort eBooks'));
    await waitFor(() => expect(screen.getByTestId('filter-sort-sheet-clear')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('filter-sort-sheet-clear'));

    await waitFor(() => expect(getShelf).toHaveBeenCalledTimes(3));
    expect(getShelf.mock.calls[2][3]).toEqual({
      contentType: undefined,
      accessTier: undefined,
      sort: undefined,
    });
  });
});

// ── D12 — the Elite queue affordance is ItemDetailScreen only ─────────────────
//
// CONFIRMED TEAM DECISION, 26 Aug. A shelf row draws no queue button regardless
// of tier. Asserted for a reader holding nothing and for a reader mid-queue,
// because an earlier pass rendered something in both cases.
describe('ShelfScreen — no Elite queue affordance', () => {
  function eliteShelf(...ids: string[]): Shelf {
    return {
      id: 'ebooks',
      title: 'eBooks',
      publications: ids.map((id) => {
        const base = publication(id, `Elite ${id}`);
        return { ...base, acquisition: { ...base.acquisition, licenceModel: 'ELITE' as const } };
      }),
    };
  }

  afterEach(() => {
    useLibraryStore.setState({ loans: [], holds: [], loading: false });
  });

  it('draws no Grant access button on an Elite row', async () => {
    setCatalogueSource(fakeSource(async () => eliteShelf('item_42')));

    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Elite item_42')).toBeTruthy());
    expect(screen.queryByText('Grant access')).toBeNull();
    expect(screen.queryByTestId('content-card-action')).toBeNull();
  });

  it('draws none on any row when several Elite titles are on screen', async () => {
    setCatalogueSource(fakeSource(async () => eliteShelf('item_42', 'item_99')));

    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Elite item_99')).toBeTruthy());
    expect(screen.queryByText('Grant access')).toBeNull();
  });

  // This screen no longer reads the holdings cache at all, so a queued hold
  // cannot reach it — asserted anyway, because that is the behaviour the
  // decision asks for rather than an accident of what the screen fetches.
  it('draws no queue position even when the reader is queued', async () => {
    useLibraryStore.setState({
      loans: [],
      holds: [
        {
          holdId: 'hold_1',
          itemId: 'item_42',
          state: 'queued',
          position: 2,
          queueLength: 5,
          serverTime: '2026-08-26T09:00:00Z',
        },
      ],
      loading: false,
    });
    setCatalogueSource(fakeSource(async () => eliteShelf('item_42')));

    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Elite item_42')).toBeTruthy());
    expect(screen.queryByText(/in queue/i)).toBeNull();
    expect(screen.queryByTestId('content-card-action')).toBeNull();
  });

  it('still navigates to the detail screen, which is where the queue lives', async () => {
    setCatalogueSource(fakeSource(async () => eliteShelf('item_42')));

    await render(<ShelfScreen {...routeProps} />);
    await waitFor(() => expect(screen.getByText('Elite item_42')).toBeTruthy());

    fireEvent.press(screen.getByText('Elite item_42'));

    expect(mockNavigate).toHaveBeenCalledWith('ItemDetail', { itemId: 'item_42' });
  });
});

// ── D8 — not entitled: no buttons, no badge ───────────────────────────────────
describe('ShelfScreen — D8 not entitled', () => {
  const ORPHAN_SHELF: Shelf = {
    id: 'ebooks',
    title: 'eBooks',
    publications: [
      {
        id: 'item_orphan',
        title: 'Metadata Only',
        publisher: 'Routledge',
        authors: [],
        subjects: [],
        // No acquisition link — the branch normalize.ts rejects upstream.
      } as unknown as Shelf['publications'][number],
    ],
  };

  it('renders the row with no badge and no action', async () => {
    setCatalogueSource(fakeSource(async () => ORPHAN_SHELF));

    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Metadata Only')).toBeTruthy());
    expect(screen.queryByText('Open Access')).toBeNull();
    expect(screen.queryByTestId('content-card-badge')).toBeNull();
    expect(screen.queryByTestId('content-card-action')).toBeNull();
    expect(screen.queryByText('Grant access')).toBeNull();
  });
});

// ── B10 — the shelf's empty state ─────────────────────────────────────────────
//
// This screen carries a filter and sort sheet, so narrowing to zero rows is an
// ordinary thing a reader can do. Before this it rendered nothing at all, which
// reads as a failed load.
describe('ShelfScreen — B10 empty state', () => {
  const EMPTY: Shelf = { id: 'ebooks', title: 'eBooks', totalItems: 0, publications: [] };

  it('says the shelf is empty when nothing was filtered', async () => {
    setCatalogueSource(fakeSource(async () => EMPTY));

    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Nothing to show here yet.')).toBeTruthy());
  });

  // "Your filters matched nothing" is a different fact from "this shelf is
  // empty", and only the first has an action worth offering.
  it('blames the filters, and offers to clear them, when a filter is applied', async () => {
    const getShelf = jest.fn(async () => EMPTY);
    setCatalogueSource(fakeSource(getShelf));

    await render(<ShelfScreen {...routeProps} />);
    await waitFor(() => expect(screen.getByText('Nothing to show here yet.')).toBeTruthy());

    await fireEvent.press(screen.getByLabelText('Filter & Sort eBooks'));
    await waitFor(() => expect(screen.getByLabelText('Audiobooks')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Audiobooks'));
    await fireEvent.press(screen.getByTestId('filter-sort-sheet-apply'));

    await waitFor(() => expect(screen.getByText('Try adjusting your filters.')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeTruthy();
  });

  it('offers no Clear filters affordance when no filter is to blame', async () => {
    setCatalogueSource(fakeSource(async () => EMPTY));

    await render(<ShelfScreen {...routeProps} />);
    await waitFor(() => expect(screen.getByText('Nothing to show here yet.')).toBeTruthy());

    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  // Empty is not an error, and the two must never be confused.
  it('shows no error copy and no retry for an empty shelf', async () => {
    setCatalogueSource(fakeSource(async () => EMPTY));

    await render(<ShelfScreen {...routeProps} />);
    await waitFor(() => expect(screen.getByText('Nothing to show here yet.')).toBeTruthy());

    expect(screen.queryByText(/couldn.?t load/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('keeps the honest count line beside the empty state', async () => {
    setCatalogueSource(fakeSource(async () => EMPTY));

    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText(/showing 0 of 0/i)).toBeTruthy());
  });
});

// ── F5 — offline is its own state ─────────────────────────────────────────────
//
// Not the same cell as a failed fetch. CONVENTIONS §6: "Offline? Different from
// failed, since it resolves itself." So the banner is a notice over whatever is
// already on screen, and the shelf underneath stays readable — AGENTS.md's
// "offline is degraded, not disabled".
//
// This screen had no offline handling at all before F5; the network-error copy it
// already had is the ERROR cell, reached by a rejected fetch, not this one.
describe('ShelfScreen offline', () => {
  it('shows the offline banner over the loaded shelf when the network is down', async () => {
    mockUseNetworkStatus.mockReturnValue(false);
    setCatalogueSource(fakeSource(async () => FAKE_SHELF));

    await render(<ShelfScreen {...routeProps} />);

    // The rows are still there — a notice, not a blocker.
    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    expect(screen.getByText("You're offline")).toBeTruthy();
  });

  it('renders no offline banner while the network is up', async () => {
    setCatalogueSource(fakeSource(async () => FAKE_SHELF));

    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    expect(screen.queryByText("You're offline")).toBeNull();
  });

  // Offline while the first page is still in flight: the banner has to be there
  // before there is any content to overlay, which is why it is rendered in the
  // list branch rather than only once rows exist.
  it('shows the banner while the shelf is still loading', async () => {
    mockUseNetworkStatus.mockReturnValue(false);
    setCatalogueSource(fakeSource(() => new Promise(() => {})));

    await render(<ShelfScreen {...routeProps} />);

    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.getAllByTestId('content-card-skeleton').length).toBeGreaterThan(0);
  });

  // The error branch is a separate early return, so it needs the banner too —
  // being offline is usually WHY the fetch failed, and the notice explains it.
  it('shows the banner alongside the error state when a failed fetch was offline', async () => {
    mockUseNetworkStatus.mockReturnValue(false);
    // A plain Error, the same way the existing failure test above rejects —
    // this cell is about the banner coexisting with the error, not about which
    // error copy is chosen.
    setCatalogueSource(fakeSource(async () => { throw new Error('network down'); }));

    await render(<ShelfScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy());
    expect(screen.getByText("You're offline")).toBeTruthy();
  });
});
