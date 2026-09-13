// src/screens/InstitutionListScreen.test.tsx
// C8: the offline institution cache. Behaviours under test:
//   1. A successful page-0 unfiltered fetch writes the cache.
//   2. When offline and the cache is populated, the list renders from it without
//      calling the network.
//   3. When offline and the cache is empty, the screen shows an error (no cache
//      to serve, so an error is still the honest state).
//   4. When a mid-flight fetch fails and the cache is populated, the screen
//      falls back to the cache rather than showing an error.
//   5. Bug: a previous fetchError is cleared before the offline check, so going
//      offline with a populated cache shows the cache — not the old error screen.
//   6. Bug: a network error on getInstitution does not prune the recently-used
//      ID (only NOT_FOUND prunes); the ID can be retried after reconnecting.
//
// useNetworkStatus is mocked at the module level so individual tests can flip
// the online/offline flag without touching NetInfo. The data source goes in via
// setCatalogueSource, following the same pattern as InstitutionDetailScreen.test.tsx.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { DataSource } from '@adapters/InstitutionSource';
import { setCatalogueSource } from '@config/catalogue';
import { CatalogueError, CatalogueFailure } from '@model/errors';
import type { Institution } from '@model/institution';
import { useInstitutionStore } from '@store/institutionStore';
import { useNetworkStatus } from '@hooks/useNetworkStatus';

import InstitutionListScreen from './InstitutionListScreen';

const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
}));

jest.mock('@hooks/useNetworkStatus');
const mockIsOnline = useNetworkStatus as jest.MockedFunction<typeof useNetworkStatus>;

const IMPERIAL: Institution = {
  id: 'inst_7f3',
  name: 'Imperial College London',
  country: 'United Kingdom',
  code: 'ICL',
  city: 'London',
  catalogueUrl: 'https://api.tf/opds/v1/institutions/inst_7f3/catalogue',
  branding: { logoUrl: 'https://cdn.tf/crests/inst_7f3.png' },
};

const MANCHESTER: Institution = {
  id: 'inst_a21',
  name: 'University of Manchester',
  country: 'United Kingdom',
  code: 'UOM',
  city: 'Manchester',
  catalogueUrl: 'https://api.tf/opds/v1/institutions/inst_a21/catalogue',
  branding: { logoUrl: 'https://cdn.tf/crests/inst_a21.png' },
};

function fakeSource(
  getInstitutions: DataSource['getInstitutions'],
  getInstitution?: DataSource['getInstitution'],
): DataSource {
  const unused = () => Promise.reject(new Error('not stubbed for this test'));
  return {
    getHomeCatalogue: unused,
    getShelf: unused,
    getPublication: unused,
    getPublicFeed: unused,
    getPublicPublication: unused,
    getInstitutions,
    getInstitution: getInstitution ?? unused,
    getItemsBatch: unused,
    getWork: unused,
  };
}

afterEach(() => {
  setCatalogueSource(undefined);
  useInstitutionStore.setState({
    selectedInstitution: null,
    recentlyUsedIds: [],
    cachedInstitutions: [],
  });
  mockGoBack.mockClear();
  mockIsOnline.mockReset();
});

describe('InstitutionListScreen offline cache — write', () => {
  it('stores the first page of the unfiltered list after a successful fetch', async () => {
    mockIsOnline.mockReturnValue(true);
    setCatalogueSource(fakeSource(async () => [IMPERIAL, MANCHESTER]));

    await render(<InstitutionListScreen />);

    await waitFor(() =>
      expect(useInstitutionStore.getState().cachedInstitutions).toEqual([IMPERIAL, MANCHESTER]),
    );
  });
});

describe('InstitutionListScreen offline cache — read', () => {
  it('renders cached institutions when offline, without calling the network', async () => {
    mockIsOnline.mockReturnValue(false);
    useInstitutionStore.setState({ cachedInstitutions: [IMPERIAL, MANCHESTER] });
    const getInstitutions = jest.fn();
    setCatalogueSource(fakeSource(getInstitutions));

    await render(<InstitutionListScreen />);

    await waitFor(() => expect(screen.getByText('Imperial College London')).toBeTruthy());
    expect(screen.getByText('University of Manchester')).toBeTruthy();
    expect(getInstitutions).not.toHaveBeenCalled();
  });

  it('shows an error when offline and the cache is empty', async () => {
    mockIsOnline.mockReturnValue(false);
    // cachedInstitutions defaults to [] in afterEach reset — no pre-seeding needed
    const getInstitutions = jest.fn();
    setCatalogueSource(fakeSource(getInstitutions));

    await render(<InstitutionListScreen />);

    await waitFor(() =>
      expect(screen.getByText(/couldn.?t load institutions/i)).toBeTruthy(),
    );
    expect(getInstitutions).not.toHaveBeenCalled();
  });
});

describe('InstitutionListScreen offline cache — mid-flight fallback', () => {
  it('shows cached institutions when a network call fails and a cache exists', async () => {
    mockIsOnline.mockReturnValue(true);
    useInstitutionStore.setState({ cachedInstitutions: [IMPERIAL] });
    setCatalogueSource(fakeSource(async () => { throw new Error('network dropped'); }));

    await render(<InstitutionListScreen />);

    await waitFor(() => expect(screen.getByText('Imperial College London')).toBeTruthy());
  });

  it('shows an error when a network call fails and there is no cache', async () => {
    mockIsOnline.mockReturnValue(true);
    setCatalogueSource(fakeSource(async () => { throw new Error('network dropped'); }));

    await render(<InstitutionListScreen />);

    await waitFor(() =>
      expect(screen.getByText(/couldn.?t load institutions/i)).toBeTruthy(),
    );
  });

  // D14 — a real CatalogueFailure carries its own copy and variant (not the
  // hardcoded 'network' every other case here happens to also want), so a
  // code this project has real copy for must actually surface it.
  it('renders MALFORMED_FEED with D14\'s own copy, not the generic fallback', async () => {
    mockIsOnline.mockReturnValue(true);
    setCatalogueSource(
      fakeSource(async () => {
        throw new CatalogueFailure(CatalogueError.MALFORMED_FEED, 'institutions');
      }),
    );

    await render(<InstitutionListScreen />);

    await waitFor(() =>
      expect(screen.getByText('Something went wrong loading this content.')).toBeTruthy(),
    );
    expect(screen.queryByText(/couldn.?t load institutions/i)).toBeNull();
  });
});

describe('InstitutionListScreen offline cache — bug regressions', () => {
  // Bug: setFetchError(false) was inside the online branch, so a previous error
  // was never cleared when going offline with a populated cache — the ErrorState
  // stayed up instead of giving way to the cache.
  //
  // Sequence: offline with no cache → fetchError=true shown. Cache then arrives
  // in the store (e.g. AsyncStorage hydrates). Pressing Retry re-runs fetchPage
  // — fix ensures setFetchError(false) runs at the top, before the offline
  // branch checks the cache, so the error clears and the cache is displayed.
  it('clears a previous fetch error and shows the cache on retry', async () => {
    mockIsOnline.mockReturnValue(false); // offline, no cache
    setCatalogueSource(fakeSource(jest.fn()));

    await render(<InstitutionListScreen />);

    await waitFor(() =>
      expect(screen.getByText(/couldn.?t load institutions/i)).toBeTruthy(),
    );

    // Cache arrives — flush effects so cachedRef picks up the new value.
    await act(async () => {
      useInstitutionStore.setState({ cachedInstitutions: [IMPERIAL] });
    });

    // Retry re-runs fetchPage; fix ensures setFetchError(false) fires first.
    fireEvent.press(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.getByText('Imperial College London')).toBeTruthy());
    expect(screen.queryByText(/couldn.?t load institutions/i)).toBeNull();
  });

  // Bug: resolvedRef marked IDs before the fetch, so a network error permanently
  // suppressed the ID for the rest of the session. Only NOT_FOUND should prune.
  it('does not prune a recently-used ID after a network error — only NOT_FOUND prunes', async () => {
    mockIsOnline.mockReturnValue(true);
    useInstitutionStore.setState({ recentlyUsedIds: ['inst_7f3'] });
    setCatalogueSource(fakeSource(
      async () => [],
      async () => { throw new Error('network error'); },
    ));


    await render(<InstitutionListScreen />);

    await waitFor(() => expect(screen.queryByText(/loading/i)).toBeNull());

    expect(useInstitutionStore.getState().recentlyUsedIds).toEqual(['inst_7f3']);
  });

  it('prunes a recently-used ID that the server says no longer exists (NOT_FOUND)', async () => {
    mockIsOnline.mockReturnValue(true);
    useInstitutionStore.setState({ recentlyUsedIds: ['inst_gone'] });
    setCatalogueSource(fakeSource(
      async () => [],
      async () => { throw new CatalogueFailure(CatalogueError.NOT_FOUND, 'inst_gone'); },
    ));

    await render(<InstitutionListScreen />);

    await waitFor(() =>
      expect(useInstitutionStore.getState().recentlyUsedIds).toEqual([]),
    );
  });
});

// ─── Loading state ────────────────────────────────────────────────────────────

describe('InstitutionListScreen loading state', () => {
  it('shows skeleton rows while loading and hides institution content', async () => {
    mockIsOnline.mockReturnValue(true);
    // Never resolves — keeps the screen in the loading state.
    setCatalogueSource(fakeSource(() => new Promise(() => {})));

    await render(<InstitutionListScreen />);

    // Search bar is present in every state.
    expect(screen.getByTestId('search-input')).toBeTruthy();
    // No institution names while loading.
    expect(screen.queryByText('Imperial College London')).toBeNull();
    expect(screen.queryByText('University of Manchester')).toBeNull();
  });
});

// ─── Select and navigate ──────────────────────────────────────────────────────

describe('InstitutionListScreen select and navigate', () => {
  it('sets the selected institution and goes back when a row is tapped', async () => {
    mockIsOnline.mockReturnValue(true);
    setCatalogueSource(fakeSource(async () => [IMPERIAL, MANCHESTER]));

    await render(<InstitutionListScreen />);
    await waitFor(() => expect(screen.getByText('Imperial College London')).toBeTruthy());

    fireEvent.press(screen.getByLabelText('Imperial College London'));

    expect(useInstitutionStore.getState().selectedInstitution).toEqual(IMPERIAL);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('adds the selected institution to recentlyUsedIds', async () => {
    mockIsOnline.mockReturnValue(true);
    setCatalogueSource(fakeSource(async () => [IMPERIAL, MANCHESTER]));

    await render(<InstitutionListScreen />);
    await waitFor(() => expect(screen.getByText('University of Manchester')).toBeTruthy());

    fireEvent.press(screen.getByLabelText('University of Manchester'));

    expect(useInstitutionStore.getState().recentlyUsedIds).toContain('inst_a21');
  });
});

// ─── Recent institutions ────────────────────────────────────────────────────────────

describe('InstitutionListScreen recently used', () => {
  it('shows a "Recent institutions" section when a loaded institution is in recentlyUsedIds', async () => {
    mockIsOnline.mockReturnValue(true);
    useInstitutionStore.setState({ recentlyUsedIds: ['inst_7f3'] });
    setCatalogueSource(fakeSource(async () => [IMPERIAL, MANCHESTER]));

    await render(<InstitutionListScreen />);

    // Both section headers appear once the data lands.
    // Note: RNTL renders ListHeaderComponent twice in FlatList — getAllByText avoids the ambiguity.
    await waitFor(() => expect(screen.getAllByText('Recent institutions').length).toBeGreaterThan(0));
    expect(screen.getAllByText('All Institutions').length).toBeGreaterThan(0);
  });

  it('excludes a recently-used institution from the main list', async () => {
    mockIsOnline.mockReturnValue(true);
    useInstitutionStore.setState({ recentlyUsedIds: ['inst_7f3'] });
    setCatalogueSource(fakeSource(async () => [IMPERIAL, MANCHESTER]));

    await render(<InstitutionListScreen />);

    await waitFor(() => expect(screen.getAllByText('Recent institutions').length).toBeGreaterThan(0));

    // mainInstitutions filters out recentlyUsedIds — IMPERIAL must appear exactly
    // once (pinned), not a second time in the main list.
    expect(screen.getAllByText('Imperial College London')).toHaveLength(1);
    // MANCHESTER is not pinned so it appears in the main list.
    expect(screen.getByText('University of Manchester')).toBeTruthy();
  });

  it('resolves a recently-used institution not in the current page via getInstitution', async () => {
    mockIsOnline.mockReturnValue(true);
    useInstitutionStore.setState({ recentlyUsedIds: ['inst_7f3'] });
    // IMPERIAL is absent from the page — must be fetched separately.
    setCatalogueSource(fakeSource(
      async () => [MANCHESTER],
      async (id) => {
        if (id === 'inst_7f3') return IMPERIAL;
        return Promise.reject(new Error('unexpected id'));
      },
    ));

    await render(<InstitutionListScreen />);

    await waitFor(() => expect(screen.getAllByText('Recent institutions').length).toBeGreaterThan(0));
    expect(screen.getByText('Imperial College London')).toBeTruthy();
  });

  // The current institution already has its own "Current institution" card
  // above — showing it again here read as a duplicate row rather than a
  // genuinely different recent one, on explicit request.
  it('excludes the CURRENT institution from Recent institutions, even though it is recently used', async () => {
    mockIsOnline.mockReturnValue(true);
    useInstitutionStore.setState({
      selectedInstitution: IMPERIAL,
      recentlyUsedIds: ['inst_7f3', 'inst_a21'],
    });
    setCatalogueSource(fakeSource(async () => [IMPERIAL, MANCHESTER]));

    await render(<InstitutionListScreen />);

    await waitFor(() => expect(screen.getAllByText('Recent institutions').length).toBeGreaterThan(0));
    // Imperial appears once — in "Current institution" — not a second time
    // pinned in "Recent institutions".
    expect(screen.getAllByText('Imperial College London')).toHaveLength(1);
    expect(screen.getByText('University of Manchester')).toBeTruthy();
  });
});

// ─── Search ───────────────────────────────────────────────────────────────────

describe('InstitutionListScreen search', () => {
  it('passes the query to getInstitutions after debounce', async () => {
    mockIsOnline.mockReturnValue(true);
    const getInstitutions = jest.fn().mockResolvedValue([IMPERIAL]);
    setCatalogueSource(fakeSource(getInstitutions));

    await render(<InstitutionListScreen />);
    await waitFor(() => expect(getInstitutions).toHaveBeenCalledTimes(1));

    fireEvent.changeText(screen.getByTestId('search-input-field'), 'Imp');

    // The debounce is 300ms; waitFor polls for up to 1000ms.
    await waitFor(() => expect(getInstitutions).toHaveBeenCalledTimes(2));
    expect(getInstitutions).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'Imp', page: 0, size: 20 }),
    );
  });

  it('fetches without q immediately when the clear button is pressed', async () => {
    mockIsOnline.mockReturnValue(true);
    const getInstitutions = jest.fn().mockResolvedValue([IMPERIAL]);
    setCatalogueSource(fakeSource(getInstitutions));

    await render(<InstitutionListScreen />);
    await waitFor(() => expect(getInstitutions).toHaveBeenCalledTimes(1));

    // Type a query — starts debounce timer
    fireEvent.changeText(screen.getByTestId('search-input-field'), 'Imp');
    await waitFor(() => expect(getInstitutions).toHaveBeenCalledTimes(2));

    // Clear — query becomes '' with delay 0, fires immediately
    fireEvent.press(screen.getByTestId('search-input-clear'));

    await waitFor(() => expect(getInstitutions).toHaveBeenCalledTimes(3));
    // Last call must have no q
    const lastCall = getInstitutions.mock.calls[2][0] as Record<string, unknown>;
    expect(lastCall.q).toBeUndefined();
  });

  it('filters cached institutions by name when offline', async () => {
    mockIsOnline.mockReturnValue(false);
    useInstitutionStore.setState({ cachedInstitutions: [IMPERIAL, MANCHESTER] });
    setCatalogueSource(fakeSource(jest.fn()));

    await render(<InstitutionListScreen />);
    // Both institutions show initially (no query).
    await waitFor(() => expect(screen.getByText('Imperial College London')).toBeTruthy());
    expect(screen.getByText('University of Manchester')).toBeTruthy();

    // Type a query — offline path filters the cache client-side.
    fireEvent.changeText(screen.getByTestId('search-input-field'), 'Imp');

    await waitFor(() =>
      expect(screen.queryByText('University of Manchester')).toBeNull(),
    );
    expect(screen.getByText('Imperial College London')).toBeTruthy();
  });
});

// ─── Pagination ───────────────────────────────────────────────────────────────

describe('InstitutionListScreen pagination', () => {
  it('fetches the next page via onEndReached when more results exist', async () => {
    mockIsOnline.mockReturnValue(true);
    const PAGE_SIZE = 20;
    const page0 = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      ...IMPERIAL,
      id: `inst_${i}`,
      name: `Institution ${i}`,
    }));
    const getInstitutions = jest.fn()
      .mockResolvedValueOnce(page0)          // page 0 — hasMore=true
      .mockResolvedValue([MANCHESTER]);       // page 1

    setCatalogueSource(fakeSource(getInstitutions));

    await render(<InstitutionListScreen />);
    await waitFor(() => expect(screen.getByText('Institution 0')).toBeTruthy());

    // Simulate FlatList reaching the end.
    fireEvent(screen.getByText('Institution 0').parent?.parent?.parent as any, 'onEndReached');

    await waitFor(() => expect(getInstitutions).toHaveBeenCalledTimes(2));
    expect(getInstitutions).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, size: PAGE_SIZE }),
    );
  });
});

// ─── B10 ──────────────────────────────────────────────────────────────────────
//
// KEPT ALONGSIDE MAIN'S SEARCH TESTS ABOVE, not merged into them. The offline
// search describe proves the cache FILTERS to a match; these two prove what is
// shown when it filters to nothing, online and offline. Different behaviours,
// so both stay.

// ── B10 — the third search empty state: offline, nothing in the cache ─────────
//
// B10 is "three empty states" in the B-series, which is the search feature. Two
// of the three belong to the catalogue search on screen 17 (query matched
// nothing; filters matched nothing) and are covered in SearchScreen.test.tsx.
// The third belongs to the INSTITUTION search (B9, a separate pipeline sharing
// only the shell): offline, with a query typed, and no cached match for it.
//
// It had no test on any surface before this. The variant existed and was wired
// here, which is exactly the kind of state that regresses unnoticed.
describe('InstitutionListScreen — B10 offline empty state', () => {
  it('explains that the offline list has no match, rather than showing an error', async () => {
    mockIsOnline.mockReturnValue(false);
    useInstitutionStore.setState({ cachedInstitutions: [IMPERIAL, MANCHESTER] });
    setCatalogueSource(fakeSource(jest.fn()));

    await render(<InstitutionListScreen />);
    await waitFor(() => expect(screen.getByText('Imperial College London')).toBeTruthy());

    // A query no cached institution can satisfy.
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('search-input-field'), 'zzzz-no-such-place');
    });

    await waitFor(() =>
      expect(
        screen.getByText(
          'No matches in your offline list — connect to search the full directory.',
        ),
      ).toBeTruthy(),
    );
    // Empty is not an error, and the copy has to say what to do about it.
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  // The same zero-result query while ONLINE is a different fact, and says so —
  // there is nothing to "connect" to fix.
  it('uses the plain no-results copy when online', async () => {
    mockIsOnline.mockReturnValue(true);
    setCatalogueSource(fakeSource(jest.fn(async () => [])));

    await render(<InstitutionListScreen />);

    await act(async () => {
      fireEvent.changeText(screen.getByTestId('search-input-field'), 'zzzz-no-such-place');
    });

    await waitFor(() => expect(screen.queryByText(/offline list/i)).toBeNull());
  });
});
