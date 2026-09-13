// src/screens/SearchScreen.test.tsx
// The B1 query surface, driven through a stub pipeline.
//
// WHAT THIS SUITE IS FOR: proving the surface tells the three outcomes apart —
// results, a successful empty answer, and an actual failure — and that a filter
// leaves as part of the request rather than being applied to whatever came back.
// Those are the claims that cannot be checked from a screenshot.
//
// `await render(...)` is required — @testing-library/react-native v14 returns a
// Promise. See the note in App.test.tsx.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';

import { setSearchPipeline } from '@config/search';
// The Jest double registered globally in jest.setup.js — importing it here is
// how the voice block below states the permission answer and drives the
// recogniser's events. See the file for what it does and does not fake.
import { mockSpeechRecognition } from '@search/MockSpeechRecognition';
import { CatalogueError, CatalogueFailure } from '@model/errors';
import type { NavLink, Publication, SearchFeed } from '@model/types';
import type { CatalogueSearchPipeline, SearchRequest } from '@/search';
import { useRecentlyViewedStore } from '@store/recentlyViewedStore';
import { useRecentSearchesStore } from '@store/recentSearchesStore';
import { useSessionStore } from '@store/sessionStore';

import { useLibraryStore } from '@store/libraryStore';

import SearchScreen from './SearchScreen';

// The licence seam is faked so nothing here reaches a real client. This screen
// makes no licence call of its own — D12 is item detail only.
jest.mock('@config/licence', () => ({
  // sessionStore.ts calls this at module load — the currentSession.ts import
  // chain (SearchScreen → currentSession → sessionStore) now pulls
  // sessionStore in even though this file never touches it directly.
  setLicenceToken: jest.fn(),
  getLicenceSource: () => ({
    getLibrary: () => Promise.resolve({ loans: [], holds: [] }),
    borrow: jest.fn(),
    placeHold: jest.fn(),
    acceptOffer: jest.fn(),
    cancelHold: jest.fn(),
  }),
}));

const mockNavigate = jest.fn();

// The screen calls `useNavigation`, which needs a navigation container it has no
// business owning in a unit test. Mocked rather than wrapped: what is under test
// is the query surface, and a real navigator would only add a tree to search
// through.
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

// ─── Test doubles ────────────────────────────────────────────────────────────

function publication(
  id: string,
  title: string,
  publisher: string,
  licenceModel: Publication['acquisition']['licenceModel'] = 'OPEN_ACCESS',
): Publication {
  return {
    id,
    title,
    publisher,
    authors: [],
    subjects: [],
    format: 'EPUB',
    acquisition: {
      actionId: licenceModel === 'OPEN_ACCESS' ? 'openAccess' : 'borrow',
      href: `https://api.tf/api/v1/reading-sessions?itemId=${id}`,
      licenceModel,
      encryption: null,
      hasSearchIndex: true,
      canPersist: true,
    },
  };
}

const FIRST = publication('item_env', 'Environmental Policy in China', 'Routledge');
const SECOND = publication('item_ab6', 'Ethnographies of Waiting', 'CRC Press');

const BROWSE: NavLink[] = [
  { title: 'eBooks', href: 'https://api.tf/groups/ebooks', shelfId: 'ebooks', target: 'shelf' },
  { title: 'Open access', href: 'https://api.tf/groups/open-access', shelfId: 'open-access', target: 'shelf' },
];

function feed(overrides: Partial<SearchFeed> = {}): SearchFeed {
  return { publications: [], browseInstead: [], ...overrides };
}

// Records what it was asked for, so a test can assert the REQUEST rather than
// inferring it from the response.
interface Stub extends CatalogueSearchPipeline {
  searchCalls: SearchRequest[];
  nextCalls: string[];
}

function stub(
  onSearch: (request: SearchRequest) => Promise<SearchFeed>,
  onNext: (next: string) => Promise<SearchFeed> = () => Promise.resolve(feed()),
): Stub {
  const searchCalls: SearchRequest[] = [];
  const nextCalls: string[] = [];

  return {
    searchCalls,
    nextCalls,
    search(request) {
      searchCalls.push(request);
      return onSearch(request);
    },
    next(value) {
      nextCalls.push(value);
      return onNext(value);
    },
  };
}

async function submit(query: string) {
  await fireEvent.changeText(screen.getByTestId('search-input-field'), query);
  await fireEvent(screen.getByTestId('search-input-field'), 'submitEditing');
}

// The recent-searches/recently-viewed dropdown is focus-driven now — nothing
// in it renders until the field itself reports focus, same signal SearchInput
// bubbles up for real via its own onFocus/onBlur.
async function focusField() {
  await fireEvent(screen.getByTestId('search-input-field'), 'focus');
}

// Signed in with an institution for every test — SearchScreen reads the real
// institutionId off the session now, so a test that cares about it (the
// request-shape and browse-instead assertions below) needs one present.
beforeEach(() => {
  useSessionStore.getState().setSession({
    accessToken: 'test_token',
    expiresIn: 3600,
    userId: 'user_1',
    institutionId: 'inst_7f3',
    roles: ['read'],
    collections: [],
  });
});

afterEach(() => {
  setSearchPipeline(undefined);
  mockNavigate.mockClear();
  // The recent-searches store is a module singleton — every submit() in this
  // file writes to it, so it must not leak from one test into the next.
  useRecentSearchesStore.getState().clear();
  useRecentlyViewedStore.getState().clear();
  useSessionStore.getState().clearSession();
});

// ─── Metadata-only copy ──────────────────────────────────────────────────────

// The failure this guards against is silent: a reader searches for a phrase they
// remember from chapter nine, gets nothing, and concludes the app is broken. The
// copy has to rule that expectation out before they type.
describe('the surface says what it searches', () => {
  it('names the four metadata fields in the placeholder', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed())));
    await render(<SearchScreen />);

    expect(screen.getByTestId('search-input-field').props.placeholder).toBe(
      'Search titles, authors, subjects, and descriptions',
    );
  });

  it('says outright that it does not search inside titles', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed())));
    await render(<SearchScreen />);

    expect(screen.getByTestId('search-helper').props.children).toBe(
      'Catalogue metadata only — this does not search inside titles.',
    );
  });
});

// ─── Query state ─────────────────────────────────────────────────────────────

describe('query state', () => {
  it('asks nothing until a query is submitted', async () => {
    const pipeline = stub(() => Promise.resolve(feed({ publications: [FIRST] })));
    setSearchPipeline(pipeline);
    await render(<SearchScreen />);

    await fireEvent.changeText(screen.getByTestId('search-input-field'), 'clim');

    expect(pipeline.searchCalls).toEqual([]);
    expect(screen.getByTestId('search-idle')).toBeTruthy();
  });

  it('sends the committed query on submit', async () => {
    const pipeline = stub(() => Promise.resolve(feed({ publications: [FIRST] })));
    setSearchPipeline(pipeline);
    await render(<SearchScreen />);

    await submit('climate');

    await waitFor(() => expect(pipeline.searchCalls).toHaveLength(1));
    expect(pipeline.searchCalls[0]).toEqual({
      institutionId: 'inst_7f3',
      query: 'climate',
      filters: {},
    });
  });

  it('shows skeletons while the request is in flight', async () => {
    // Never resolves — the loading state is the whole assertion.
    setSearchPipeline(stub(() => new Promise<SearchFeed>(() => {})));
    await render(<SearchScreen />);

    await submit('climate');

    await waitFor(() => expect(screen.getAllByTestId('content-card-skeleton')).toHaveLength(3));
  });
});

// ─── Recent searches ─────────────────────────────────────────────────────────
// Client-side only (recentSearchesStore.ts) — nothing here goes near a pipeline.

describe('recent searches', () => {
  it('shows nothing before any search has been submitted, even while focused', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed())));
    await render(<SearchScreen />);

    await focusField();

    expect(screen.queryByTestId('search-recent')).toBeNull();
  });

  it('shows nothing while unfocused, even with a remembered query', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed({ publications: [FIRST] }))));
    await render(<SearchScreen />);

    await submit('climate');
    await fireEvent.press(screen.getByTestId('search-input-clear'));

    expect(screen.queryByTestId('search-recent')).toBeNull();
  });

  it('remembers a submitted query and offers it back once the field is focused', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed({ publications: [FIRST] }))));
    await render(<SearchScreen />);

    await submit('climate');
    await fireEvent.press(screen.getByTestId('search-input-clear'));
    await focusField();

    await waitFor(() => expect(screen.getByTestId('search-recent')).toBeTruthy());
    expect(screen.getByText('climate')).toBeTruthy();
  });

  it('re-runs a recent query when it is tapped, and closes the dropdown', async () => {
    const pipeline = stub(() => Promise.resolve(feed({ publications: [FIRST] })));
    setSearchPipeline(pipeline);
    await render(<SearchScreen />);

    await submit('climate');
    await fireEvent.press(screen.getByTestId('search-input-clear'));
    await focusField();
    await waitFor(() => expect(screen.getByText('climate')).toBeTruthy());

    await fireEvent.press(screen.getByText('climate'));

    await waitFor(() => expect(pipeline.searchCalls).toHaveLength(2));
    expect(pipeline.searchCalls[1]).toMatchObject({ query: 'climate' });
    expect(screen.queryByTestId('search-recent')).toBeNull();
  });

  it('narrows to queries that start with the draft as the reader types', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed())));
    await render(<SearchScreen />);

    await submit('climate policy');
    await fireEvent.press(screen.getByTestId('search-input-clear'));
    await submit('open access');
    await fireEvent.press(screen.getByTestId('search-input-clear'));
    await focusField();
    await waitFor(() => expect(screen.getByText('climate policy')).toBeTruthy());
    expect(screen.getByText('open access')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('search-input-field'), 'clim');

    expect(screen.getByText('climate policy')).toBeTruthy();
    expect(screen.queryByText('open access')).toBeNull();
  });

  it('hides the list again once no remembered query matches the draft', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed({ publications: [FIRST] }))));
    await render(<SearchScreen />);

    await submit('climate');
    await fireEvent.press(screen.getByTestId('search-input-clear'));
    await focusField();
    await waitFor(() => expect(screen.getByTestId('search-recent')).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId('search-input-field'), 'open');

    expect(screen.queryByTestId('search-recent')).toBeNull();
  });

  it('clears every remembered query', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed({ publications: [FIRST] }))));
    await render(<SearchScreen />);

    await submit('climate');
    await fireEvent.press(screen.getByTestId('search-input-clear'));
    await focusField();
    // The "Clear" action now comes from SectionHeader's own action slot —
    // same component Catalogue's shelf headers use, accessibilityLabel names
    // the section per that component's own header comment.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Clear Recent searches' })).toBeTruthy(),
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Clear Recent searches' }));

    expect(screen.queryByTestId('search-recent')).toBeNull();
  });

  it('closes on an outside tap, dropping the keyboard without submitting anything', async () => {
    const pipeline = stub(() => Promise.resolve(feed({ publications: [FIRST] })));
    setSearchPipeline(pipeline);
    await render(<SearchScreen />);

    await submit('climate');
    await fireEvent.press(screen.getByTestId('search-input-clear'));
    await focusField();
    await waitFor(() => expect(screen.getByTestId('search-dropdown-scrim')).toBeTruthy());

    await fireEvent.press(screen.getByTestId('search-dropdown-scrim'));

    expect(screen.queryByTestId('search-recent')).toBeNull();
    expect(screen.queryByTestId('search-dropdown-scrim')).toBeNull();
    expect(pipeline.searchCalls).toHaveLength(1);
  });
});

describe('recently viewed', () => {
  it('shows nothing when the reader has viewed nothing yet', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed())));
    await render(<SearchScreen />);

    expect(screen.queryByTestId('search-recently-viewed')).toBeNull();
  });

  // Drawn with the exact same `ContentCard` row Catalogue and the results
  // list use — on explicit instruction not to invent a second display for
  // the same kind of data. Always visible before a fresh query — unlike
  // Recent searches, this stays out of the focus-driven dropdown, since a
  // publication isn't a text suggestion.
  it('lists a real viewed item through the same ContentCard row as a search result', async () => {
    useRecentlyViewedStore.getState().recordView({
      id: 'item_viewed',
      title: 'Rights for Robots',
      publisher: 'Routledge',
      authors: ['Joshua C. Gellers'],
      subjects: [],
      format: 'PDF',
      acquisition: { actionId: 'openAccess', href: 'https://x', licenceModel: 'OPEN_ACCESS', encryption: null },
    });
    setSearchPipeline(stub(() => Promise.resolve(feed())));
    await render(<SearchScreen />);

    expect(screen.getByTestId('search-recently-viewed')).toBeTruthy();
    expect(screen.getByTestId('content-card')).toBeTruthy();
    expect(screen.getByText('Rights for Robots')).toBeTruthy();
    expect(screen.getByText('Joshua C. Gellers')).toBeTruthy();
    expect(screen.getByText('Open Access')).toBeTruthy();
  });

  // The store itself remembers more (MAX_RECENTLY_VIEWED in
  // recentlyViewedStore.ts) — this pins Search's own display cap, on
  // explicit request, at a number below that store cap so the two are
  // provably different limits rather than one accidentally matching the
  // other.
  it('shows at most 3 recently viewed items, most recent first', async () => {
    for (let i = 0; i < 5; i += 1) {
      useRecentlyViewedStore.getState().recordView({
        id: `item_${i}`,
        title: `Title ${i}`,
        authors: [],
        subjects: [],
        acquisition: { actionId: 'openAccess', href: 'https://x', licenceModel: 'OPEN_ACCESS', encryption: null },
      });
    }
    setSearchPipeline(stub(() => Promise.resolve(feed())));
    await render(<SearchScreen />);

    await waitFor(() => expect(screen.getAllByTestId('content-card')).toHaveLength(3));
    expect(screen.getByText('Title 4')).toBeTruthy();
    expect(screen.getByText('Title 3')).toBeTruthy();
    expect(screen.getByText('Title 2')).toBeTruthy();
    expect(screen.queryByText('Title 1')).toBeNull();
    expect(screen.queryByText('Title 0')).toBeNull();
  });

  it('goes straight to the item’s detail page when tapped, not through a search', async () => {
    const pipeline = stub(() => Promise.resolve(feed()));
    setSearchPipeline(pipeline);
    useRecentlyViewedStore.getState().recordView({
      id: 'item_viewed',
      title: 'Rights for Robots',
      authors: [],
      subjects: [],
      acquisition: { actionId: 'openAccess', href: 'https://x', licenceModel: 'OPEN_ACCESS', encryption: null },
    });
    await render(<SearchScreen />);

    await fireEvent.press(screen.getByText('Rights for Robots'));

    expect(mockNavigate).toHaveBeenCalledWith('ItemDetail', { itemId: 'item_viewed' });
    expect(pipeline.searchCalls).toHaveLength(0);
  });

  it('stays visible while a fresh query is being typed, not yet submitted', async () => {
    useRecentlyViewedStore.getState().recordView({
      id: 'item_viewed',
      title: 'Rights for Robots',
      authors: [],
      subjects: [],
      acquisition: { actionId: 'openAccess', href: 'https://x', licenceModel: 'OPEN_ACCESS', encryption: null },
    });
    setSearchPipeline(stub(() => Promise.resolve(feed())));
    await render(<SearchScreen />);
    await waitFor(() => expect(screen.getByTestId('search-recently-viewed')).toBeTruthy());

    await fireEvent.changeText(screen.getByTestId('search-input-field'), 'open');

    expect(screen.getByTestId('search-recently-viewed')).toBeTruthy();
  });

  it('hides once that query is actually submitted', async () => {
    useRecentlyViewedStore.getState().recordView({
      id: 'item_viewed',
      title: 'Rights for Robots',
      authors: [],
      subjects: [],
      acquisition: { actionId: 'openAccess', href: 'https://x', licenceModel: 'OPEN_ACCESS', encryption: null },
    });
    setSearchPipeline(stub(() => Promise.resolve(feed())));
    await render(<SearchScreen />);
    await waitFor(() => expect(screen.getByTestId('search-recently-viewed')).toBeTruthy());

    await submit('open access');

    expect(screen.queryByTestId('search-recently-viewed')).toBeNull();
  });
});

// ─── Results ─────────────────────────────────────────────────────────────────

describe('successful results', () => {
  it('renders a row per publication, in the order the server sent them', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed({ publications: [FIRST, SECOND] }))));
    await render(<SearchScreen />);

    await submit('climate');

    await waitFor(() => expect(screen.getAllByTestId('content-card-title')).toHaveLength(2));
    expect(screen.getAllByTestId('content-card-title')[0].props.children).toBe(
      'Environmental Policy in China',
    );
  });

  it('reports the server total rather than the page length', async () => {
    setSearchPipeline(
      stub(() => Promise.resolve(feed({ publications: [FIRST], totalItems: 3 }))),
    );
    await render(<SearchScreen />);

    await submit('climate');

    await waitFor(() => expect(screen.getByTestId('search-total')).toBeTruthy());
    expect(screen.getByText('Showing 1 of 3')).toBeTruthy();
  });

  it('shows the server total once, above the list', async () => {
    setSearchPipeline(
      stub(() => Promise.resolve(feed({ publications: [FIRST], totalItems: 3 }))),
    );
    await render(<SearchScreen />);

    await submit('climate');

    await waitFor(() => expect(screen.getByTestId('search-results-count')).toBeTruthy());
    expect(screen.getByText('3 results')).toBeTruthy();
  });

  it('singularises a total of exactly one', async () => {
    setSearchPipeline(
      stub(() => Promise.resolve(feed({ publications: [FIRST], totalItems: 1 }))),
    );
    await render(<SearchScreen />);

    await submit('climate');

    await waitFor(() => expect(screen.getByText('1 result')).toBeTruthy());
  });

  it('shows no count line when the server did not report a total', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed({ publications: [FIRST] }))));
    await render(<SearchScreen />);

    await submit('climate');

    await waitFor(() => expect(screen.getByTestId('content-card')).toBeTruthy());
    expect(screen.queryByTestId('search-results-count')).toBeNull();
  });

  it('opens detail for a row that was tapped', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed({ publications: [FIRST] }))));
    await render(<SearchScreen />);

    await submit('climate');
    await waitFor(() => expect(screen.getByTestId('content-card')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('content-card'));

    expect(mockNavigate).toHaveBeenCalledWith('ItemDetail', { itemId: 'item_env' });
  });

  it('renders no empty state and no error alongside results', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed({ publications: [FIRST] }))));
    await render(<SearchScreen />);

    await submit('climate');

    await waitFor(() => expect(screen.getByTestId('content-card')).toBeTruthy());
    expect(screen.queryByTestId('search-empty')).toBeNull();
    expect(screen.queryByTestId('search-error')).toBeNull();
  });
});

// ─── Filters as query parameters, before pagination ──────────────────────────

// Every dimension lives behind one "Filter and sort" trigger and a sheet —
// same component ShelfScreen already uses. A chip is never reachable until the
// sheet is open, and nothing re-searches until Apply is pressed.
async function openFilterSheet() {
  await fireEvent.press(screen.getByLabelText('Filter and sort'));
}

async function applyFilters() {
  await fireEvent.press(screen.getByTestId('filter-sort-sheet-apply'));
}

describe('filters are part of the request', () => {
  it('sends a selected contentType as part of the search', async () => {
    const pipeline = stub(() => Promise.resolve(feed({ publications: [FIRST] })));
    setSearchPipeline(pipeline);
    await render(<SearchScreen />);

    await submit('climate');
    await waitFor(() => expect(pipeline.searchCalls).toHaveLength(1));

    await openFilterSheet();
    await waitFor(() => expect(screen.getByLabelText('Audiobooks')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Audiobooks'));
    await applyFilters();

    await waitFor(() => expect(pipeline.searchCalls).toHaveLength(2));
    expect(pipeline.searchCalls[1]).toEqual({
      institutionId: 'inst_7f3',
      query: 'climate',
      filters: { contentType: 'AUDIO' },
    });
  });

  // The banned flow is fetch a page, then narrow it locally. A filter change
  // starts a NEW search, which is why the cursor is not followed here.
  it('re-searches from the beginning rather than paging or filtering in place', async () => {
    const pipeline = stub(() =>
      Promise.resolve(feed({ publications: [FIRST], next: 'https://api.tf/search?page=1' })),
    );
    setSearchPipeline(pipeline);
    await render(<SearchScreen />);

    await submit('climate');
    await waitFor(() => expect(screen.getByTestId('search-load-more')).toBeTruthy());

    await openFilterSheet();
    await waitFor(() => expect(screen.getByLabelText('eBooks')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('eBooks'));
    await applyFilters();

    await waitFor(() => expect(pipeline.searchCalls).toHaveLength(2));
    expect(pipeline.nextCalls).toEqual([]);
  });

  it('clears the dimension again through the All chip', async () => {
    const pipeline = stub(() => Promise.resolve(feed({ publications: [FIRST] })));
    setSearchPipeline(pipeline);
    await render(<SearchScreen />);

    await submit('climate');
    await openFilterSheet();
    await waitFor(() => expect(screen.getByLabelText('Audiobooks')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Audiobooks'));
    await applyFilters();
    await waitFor(() => expect(pipeline.searchCalls).toHaveLength(2));

    await openFilterSheet();
    // Both dimensions offer an "All" chip inside the sheet — content type's
    // renders first, so index 0 is the one this test means to press.
    await waitFor(() => expect(screen.getAllByLabelText('All')).toHaveLength(2));
    await fireEvent.press(screen.getAllByLabelText('All')[0]);
    await applyFilters();

    await waitFor(() => expect(pipeline.searchCalls).toHaveLength(3));
    expect(pipeline.searchCalls[2].filters).toEqual({});
  });

  it('records a filter without searching when no query has been committed', async () => {
    const pipeline = stub(() => Promise.resolve(feed()));
    setSearchPipeline(pipeline);
    await render(<SearchScreen />);

    await openFilterSheet();
    await waitFor(() => expect(screen.getByLabelText('Audiobooks')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Audiobooks'));
    await applyFilters();

    expect(pipeline.searchCalls).toEqual([]);
  });
});

// Q-12 resolved: wokay's contract confirms `accessTier` as a real filter
// parameter, so the dimension is enabled and a selected tier is sent.
describe('access tier is enabled now that Q-12 is resolved', () => {
  it('renders a chip per tier', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed())));
    await render(<SearchScreen />);

    await openFilterSheet();

    await waitFor(() => expect(screen.getByLabelText('Open access')).toBeTruthy());
    expect(screen.getByLabelText('Subscription')).toBeTruthy();
    expect(screen.getByLabelText('Elite')).toBeTruthy();
  });

  it('announces every tier chip as enabled', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed())));
    await render(<SearchScreen />);

    await openFilterSheet();
    await waitFor(() => expect(screen.getByLabelText('Open access')).toBeTruthy());

    for (const label of ['Open access', 'Subscription', 'Elite']) {
      expect(screen.getByLabelText(label).props.accessibilityState).toMatchObject({
        disabled: false,
      });
    }
  });

  it('starts a new search carrying the tier when a tier chip is pressed', async () => {
    const pipeline = stub(() => Promise.resolve(feed({ publications: [FIRST] })));
    setSearchPipeline(pipeline);
    await render(<SearchScreen />);

    await submit('climate');
    await waitFor(() => expect(pipeline.searchCalls).toHaveLength(1));

    await openFilterSheet();
    await waitFor(() => expect(screen.getByLabelText('Elite')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Elite'));
    await applyFilters();

    await waitFor(() => expect(pipeline.searchCalls).toHaveLength(2));
    expect(pipeline.searchCalls[1]?.filters).toEqual({ accessTier: 'ELITE' });
  });
});

// Both dimensions live in one sheet session, so one Apply press must commit
// both together rather than one silently overwriting the other.
describe('applying more than one filter dimension at once', () => {
  it('sends both filters together from a single Apply press', async () => {
    const pipeline = stub(() => Promise.resolve(feed({ publications: [FIRST] })));
    setSearchPipeline(pipeline);
    await render(<SearchScreen />);

    await submit('climate');
    await waitFor(() => expect(pipeline.searchCalls).toHaveLength(1));

    await openFilterSheet();
    await waitFor(() => expect(screen.getByLabelText('Audiobooks')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Audiobooks'));
    await fireEvent.press(screen.getByLabelText('Elite'));
    await applyFilters();

    await waitFor(() => expect(pipeline.searchCalls).toHaveLength(2));
    expect(pipeline.searchCalls[1].filters).toEqual({
      contentType: 'AUDIO',
      accessTier: 'ELITE',
    });
  });

  it('shows the real active-filter count on the button, not a boolean', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed())));
    await render(<SearchScreen />);

    await openFilterSheet();
    await waitFor(() => expect(screen.getByLabelText('Audiobooks')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Audiobooks'));
    await fireEvent.press(screen.getByLabelText('Elite'));
    await applyFilters();

    await waitFor(() => expect(screen.getByText('Filter & Sort (2)')).toBeTruthy());
  });
});

// Search has no sort parameter at all (searchCatalogue's own contract carries
// none) — unlike ShelfScreen, this is not conditional on which shelf is open.
describe('sort is not offered for search', () => {
  it('always greys the sort row with an explanatory note', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed())));
    await render(<SearchScreen />);

    await openFilterSheet();

    await waitFor(() => expect(screen.getByLabelText('Newest')).toBeTruthy());
    expect(screen.getByTestId('filter-sort-sheet-sort-note')).toBeTruthy();
    expect(screen.getByLabelText('Newest').props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });
});

// ─── Zero results ────────────────────────────────────────────────────────────

// A SUCCESSFUL RESPONSE WITH NOTHING IN IT. The distinction this suite protects
// is that none of it renders as an error.
describe('a zero-result response', () => {
  it('says no publications were found', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed({ publications: [] }))));
    await render(<SearchScreen />);

    await submit('quantum basket weaving');

    await waitFor(() => expect(screen.getByTestId('search-empty')).toBeTruthy());
    expect(
      screen.getByText('No articles or books match “quantum basket weaving”.'),
    ).toBeTruthy();
  });

  it('shows the filter-narrowed message instead when a filter is active', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed({ publications: [] }))));
    await render(<SearchScreen />);

    await openFilterSheet();
    await waitFor(() => expect(screen.getByLabelText('Audiobooks')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Audiobooks'));
    await applyFilters();
    await submit('quantum basket weaving');

    await waitFor(() => expect(screen.getByTestId('search-empty')).toBeTruthy());
    expect(screen.getByText('Try adjusting your filters.')).toBeTruthy();
  });

  it('offers real, actionable tips, not a bare message', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed({ publications: [] }))));
    await render(<SearchScreen />);

    await submit('quantum basket weaving');

    await waitFor(() => expect(screen.getByTestId('search-empty-tips')).toBeTruthy());
    expect(screen.getByText('Checking your spelling')).toBeTruthy();
    expect(screen.getByText('Using different keywords')).toBeTruthy();
    expect(screen.getByText('Searching for a broader topic')).toBeTruthy();
    // No filters are active in this case, so removing one is not real advice.
    expect(screen.queryByText('Removing some filters')).toBeNull();
  });

  it('adds "Removing some filters" as a tip once a filter actually narrowed the result to nothing', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed({ publications: [] }))));
    await render(<SearchScreen />);

    await openFilterSheet();
    await waitFor(() => expect(screen.getByLabelText('Audiobooks')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Audiobooks'));
    await applyFilters();
    await submit('quantum basket weaving');

    await waitFor(() => expect(screen.getByText('Removing some filters')).toBeTruthy());
  });

  it('clearing filters from the empty state starts a new, unfiltered search', async () => {
    const pipeline = stub(() => Promise.resolve(feed({ publications: [] })));
    setSearchPipeline(pipeline);
    await render(<SearchScreen />);

    await openFilterSheet();
    await waitFor(() => expect(screen.getByLabelText('Audiobooks')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Audiobooks'));
    await applyFilters();
    await submit('quantum basket weaving');
    await waitFor(() => expect(screen.getByText('Clear filters')).toBeTruthy());

    await fireEvent.press(screen.getByText('Clear filters'));

    await waitFor(() => expect(pipeline.searchCalls).toHaveLength(2));
    expect(pipeline.searchCalls[1].filters).toEqual({});
  });

  it('does NOT render the error state', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed({ publications: [] }))));
    await render(<SearchScreen />);

    await submit('quantum basket weaving');

    await waitFor(() => expect(screen.getByTestId('search-empty')).toBeTruthy());
    expect(screen.queryByTestId('search-error')).toBeNull();
    expect(screen.queryByTestId('search-retry')).toBeNull();
  });

  it('names the query that found nothing', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed({ publications: [] }))));
    await render(<SearchScreen />);

    await submit('quantum basket weaving');

    await waitFor(() =>
      expect(screen.getByText(/quantum basket weaving/)).toBeTruthy(),
    );
  });

  it('offers no next page', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed({ publications: [] }))));
    await render(<SearchScreen />);

    await submit('quantum basket weaving');

    await waitFor(() => expect(screen.getByTestId('search-empty')).toBeTruthy());
    expect(screen.queryByTestId('search-load-more')).toBeNull();
  });
});

// The response the whole zero-result design is for: a navigation feed with NO
// `publications` key at all, carrying browse targets instead.
describe('a response with no publications key, carrying browseInstead', () => {
  // What normalizeSearchFeed hands over for exactly that payload.
  const asNormalized = feed({ browseInstead: BROWSE });

  it('is a valid empty state, not a malformed feed', async () => {
    setSearchPipeline(stub(() => Promise.resolve(asNormalized)));
    await render(<SearchScreen />);

    await submit('quantum basket weaving');

    await waitFor(() => expect(screen.getByTestId('search-empty')).toBeTruthy());
    expect(screen.queryByTestId('search-error')).toBeNull();
  });

  it('renders the browse-instead affordance from the returned data', async () => {
    setSearchPipeline(stub(() => Promise.resolve(asNormalized)));
    await render(<SearchScreen />);

    await submit('quantum basket weaving');

    await waitFor(() => expect(screen.getByTestId('search-browse-instead')).toBeTruthy());
    expect(screen.getByText('Browse instead')).toBeTruthy();
  });

  it('renders a card per returned target', async () => {
    setSearchPipeline(stub(() => Promise.resolve(asNormalized)));
    await render(<SearchScreen />);

    await submit('quantum basket weaving');

    await waitFor(() => expect(screen.getAllByTestId('search-browse-item')).toHaveLength(2));
  });

  it('shows no browse section when the response offered none', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed())));
    await render(<SearchScreen />);

    await submit('quantum basket weaving');

    await waitFor(() => expect(screen.getByTestId('search-empty')).toBeTruthy());
    expect(screen.queryByTestId('search-browse-instead')).toBeNull();
  });
});

// A real shelf link (rel="subsection", ".../groups/{id}") and the catalogue
// root itself (".../catalogue", offered when there is no group to point at —
// see OpdsSearchQuery's own zero-result branch) both arrive as browseInstead
// entries. Opening the second one the same way as the first — a
// getShelf(institutionId, shelfId) call — asks wokay for a group named
// "catalogue", which does not exist and always answers NOT_FOUND. `target`
// is what tells the two apart before either one is opened.
describe('tapping a browse-instead card routes by its target', () => {
  it('opens Shelf for a real shelf target', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed({ browseInstead: BROWSE }))));
    await render(<SearchScreen />);
    await submit('quantum basket weaving');
    await waitFor(() => expect(screen.getAllByTestId('search-browse-item')).toHaveLength(2));

    fireEvent.press(screen.getAllByTestId('search-browse-item')[0]);

    expect(mockNavigate).toHaveBeenCalledWith('Catalogue', {
      screen: 'Shelf',
      params: { shelfId: 'ebooks', title: 'eBooks', institutionId: 'inst_7f3' },
    });
  });

  it('opens the catalogue home for a catalogue-root target, not Shelf', async () => {
    const catalogueRoot: NavLink = {
      title: 'Browse the full catalogue',
      href: 'https://api.tf/opds/v1/institutions/inst_7f3/catalogue',
      shelfId: 'catalogue',
      target: 'catalogue',
    };
    setSearchPipeline(stub(() => Promise.resolve(feed({ browseInstead: [catalogueRoot] }))));
    await render(<SearchScreen />);
    await submit('quantum basket weaving');
    await waitFor(() => expect(screen.getAllByTestId('search-browse-item')).toHaveLength(1));

    fireEvent.press(screen.getAllByTestId('search-browse-item')[0]);

    expect(mockNavigate).toHaveBeenCalledWith('Catalogue', { screen: 'CatalogueHome' });
  });
});

// ─── Pagination ──────────────────────────────────────────────────────────────

describe('pagination is driven by the next value', () => {
  const CURSOR = 'https://api.tf/opds/v1/institutions/inst_7f3/search?query=climate&page=1';

  function paged() {
    return stub(
      () => Promise.resolve(feed({ publications: [FIRST], totalItems: 2, next: CURSOR })),
      () => Promise.resolve(feed({ publications: [SECOND], totalItems: 2 })),
    );
  }

  it('offers a next affordance only when the response carried a next', async () => {
    setSearchPipeline(paged());
    await render(<SearchScreen />);

    await submit('climate');

    await waitFor(() => expect(screen.getByTestId('search-load-more')).toBeTruthy());
  });

  it('offers none on a response with no next', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed({ publications: [FIRST] }))));
    await render(<SearchScreen />);

    await submit('climate');

    await waitFor(() => expect(screen.getByTestId('content-card')).toBeTruthy());
    expect(screen.queryByTestId('search-load-more')).toBeNull();
  });

  it('requests the next value verbatim, never a page number', async () => {
    const pipeline = paged();
    setSearchPipeline(pipeline);
    await render(<SearchScreen />);

    await submit('climate');
    await waitFor(() => expect(screen.getByTestId('search-load-more')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('search-load-more'));

    await waitFor(() => expect(pipeline.nextCalls).toEqual([CURSOR]));
  });

  it('appends the next page below the results already read', async () => {
    setSearchPipeline(paged());
    await render(<SearchScreen />);

    await submit('climate');
    await waitFor(() => expect(screen.getByTestId('search-load-more')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('search-load-more'));

    await waitFor(() => expect(screen.getAllByTestId('content-card-title')).toHaveLength(2));
    const titles = screen.getAllByTestId('content-card-title').map((node) => node.props.children);
    expect(titles).toEqual(['Environmental Policy in China', 'Ethnographies of Waiting']);
  });

  it('withdraws the affordance once the last page has no next', async () => {
    setSearchPipeline(paged());
    await render(<SearchScreen />);

    await submit('climate');
    await waitFor(() => expect(screen.getByTestId('search-load-more')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('search-load-more'));

    await waitFor(() => expect(screen.queryByTestId('search-load-more')).toBeNull());
  });

  it('does not re-send the search when paging', async () => {
    const pipeline = paged();
    setSearchPipeline(pipeline);
    await render(<SearchScreen />);

    await submit('climate');
    await waitFor(() => expect(screen.getByTestId('search-load-more')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('search-load-more'));

    await waitFor(() => expect(pipeline.nextCalls).toHaveLength(1));
    expect(pipeline.searchCalls).toHaveLength(1);
  });
});

// ─── Errors ──────────────────────────────────────────────────────────────────

describe('an actual failure', () => {
  function failing(code: CatalogueError) {
    return stub(() => Promise.reject(new CatalogueFailure(code, 'search')));
  }

  it('renders the error state', async () => {
    setSearchPipeline(failing(CatalogueError.NETWORK_UNAVAILABLE));
    await render(<SearchScreen />);

    await submit('climate');

    await waitFor(() => expect(screen.getByTestId('search-error')).toBeTruthy());
  });

  it('says what went wrong in wokay’s own vocabulary, never an HTTP status', async () => {
    setSearchPipeline(failing(CatalogueError.NETWORK_UNAVAILABLE));
    await render(<SearchScreen />);

    await submit('climate');

    await waitFor(() => expect(screen.getByText('You appear to be offline.')).toBeTruthy());
  });

  it('distinguishes a timeout from being offline', async () => {
    setSearchPipeline(failing(CatalogueError.TIMEOUT));
    await render(<SearchScreen />);

    await submit('climate');

    await waitFor(() =>
      expect(screen.getByText('This took too long to respond.')).toBeTruthy(),
    );
  });

  it('is not the empty state', async () => {
    setSearchPipeline(failing(CatalogueError.TIMEOUT));
    await render(<SearchScreen />);

    await submit('climate');

    await waitFor(() => expect(screen.getByTestId('search-error')).toBeTruthy());
    expect(screen.queryByTestId('search-empty')).toBeNull();
  });

  it('retries the search', async () => {
    let attempt = 0;
    const pipeline = stub(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new CatalogueFailure(CatalogueError.TIMEOUT, 'search'))
        : Promise.resolve(feed({ publications: [FIRST] }));
    });
    setSearchPipeline(pipeline);
    await render(<SearchScreen />);

    await submit('climate');
    await waitFor(() => expect(screen.getByLabelText('Retry')).toBeTruthy());
    await fireEvent.press(screen.getByLabelText('Retry'));

    await waitFor(() => expect(screen.getByTestId('content-card')).toBeTruthy());
  });

  // A next page that failed is no reason to throw away what the reader is
  // part-way through, so this is a different treatment from a failed search.
  it('keeps the results already read when a next page fails', async () => {
    const pipeline = stub(
      () => Promise.resolve(feed({ publications: [FIRST], next: 'cursor' })),
      () => Promise.reject(new CatalogueFailure(CatalogueError.TIMEOUT, 'next')),
    );
    setSearchPipeline(pipeline);
    await render(<SearchScreen />);

    await submit('climate');
    await waitFor(() => expect(screen.getByTestId('search-load-more')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('search-load-more'));

    await waitFor(() => expect(screen.getByTestId('search-page-error')).toBeTruthy());
    expect(screen.getByTestId('content-card')).toBeTruthy();
    expect(screen.queryByTestId('search-error')).toBeNull();
  });
});

// ─── Screen 11 — voice search ────────────────────────────────────────────────

// WHAT THIS BLOCK IS FOR: proving that speech becomes an ORDINARY query. Voice
// adds no endpoint, no second pipeline and no new error surface, so almost every
// assertion below is that an existing path was reached — `searchCalls`,
// `search-error`, `search-empty`, the recent-searches store. The genuinely new
// claims are narrow: a refusal must not search, a silence must not search, and a
// cancel must not search.
//
// The native module is mocked globally (jest.setup.js → MockSpeechRecognition).
// It fakes the module surface and the event stream; the permission answer and
// the recognition events are stated by each test, because those are exactly what
// a real device decides. No microphone and no OS dialog is exercised here.
describe('voice search', () => {
  beforeEach(() => {
    mockSpeechRecognition.reset();
  });

  // Opens the overlay and gets as far as an open microphone.
  async function pressMic() {
    await fireEvent.press(screen.getByTestId('search-input-voice'));
    await waitFor(() => expect(mockSpeechRecognition.isRunning()).toBe(true));
    await act(async () => {
      mockSpeechRecognition.emit('start', null);
    });
  }

  async function say(words: string) {
    await act(async () => {
      mockSpeechRecognition.emitTranscript(words);
    });
  }

  // The recogniser stops hearing speech, resolves a final, and closes.
  async function stopSpeaking() {
    await act(async () => {
      mockSpeechRecognition.emit('speechend', null);
      mockSpeechRecognition.emit('end', null);
    });
  }

  it('opens the listening surface when the mic is pressed', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed())));
    await render(<SearchScreen />);

    await pressMic();

    expect(screen.getByTestId('voice-overlay')).toBeTruthy();
    expect(screen.getByText('Listening…')).toBeTruthy();
  });

  // The transcript has to appear as it is spoken — it is the only evidence the
  // microphone is working, and the mockup shows it growing under the disc.
  it('asks the recogniser for interim results', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed())));
    await render(<SearchScreen />);

    await pressMic();

    expect(mockSpeechRecognition.startCalls()).toHaveLength(1);
    expect(mockSpeechRecognition.startCalls()[0]).toMatchObject({ interimResults: true });
  });

  it('shows partial results as they arrive', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed())));
    await render(<SearchScreen />);

    await pressMic();
    await say('machine');
    expect(screen.getByText('machine')).toBeTruthy();

    await say('machine learning');
    expect(screen.getByText('machine learning')).toBeTruthy();
  });

  // ── Regression: the session-counter race ───────────────────────────────────

  // Two mic presses committed in ONE React batch. `fireEvent` is act()-wrapped,
  // so nesting both inside an outer act() defers the passive effects until the
  // batch closes — which is exactly the window the bug needed, and the one a
  // pair of ordinary awaited presses can never produce.
  //
  // The bug: the hook kept its own session counter beside the reducer's and
  // guarded it with a copy of the state that a passive effect updated. Batched
  // presses advanced that counter twice while the reducer accepted one session,
  // and the two never resynchronised — every event belonging to the session that
  // actually ran was then rejected as stale.
  //
  // It does not crash and it does not look broken: `checkingPermission` renders
  // as "Listening…", so the overlay sits there looking healthy over a live
  // microphone it is ignoring. The assertion therefore has to be that speech
  // still reaches the surface, not that something threw.
  describe('two mic presses in a single React batch', () => {
    async function doublePressMic() {
      await act(async () => {
        fireEvent.press(screen.getByTestId('search-input-voice'));
        fireEvent.press(screen.getByTestId('search-input-voice'));
      });
      await waitFor(() => expect(mockSpeechRecognition.isRunning()).toBe(true));
    }

    it('starts exactly one recogniser', async () => {
      setSearchPipeline(stub(() => Promise.resolve(feed())));
      await render(<SearchScreen />);

      await doublePressMic();

      expect(mockSpeechRecognition.startCalls()).toHaveLength(1);
    });

    // The discriminator. Under the old counter this transcript never arrived.
    it('still delivers the transcript to the surface', async () => {
      setSearchPipeline(stub(() => Promise.resolve(feed())));
      await render(<SearchScreen />);

      await doublePressMic();
      await act(async () => {
        mockSpeechRecognition.emit('start', null);
        mockSpeechRecognition.emitTranscript('machine learning');
      });

      expect(screen.getByText('machine learning')).toBeTruthy();
    });

    // The drift was permanent, not per-session: once the two counters parted,
    // every later session was dead too. So the cycle after it has to work.
    it('leaves the next session working after a cancel', async () => {
      const pipeline = stub(() => Promise.resolve(feed({ publications: [FIRST] })));
      setSearchPipeline(pipeline);
      await render(<SearchScreen />);

      await doublePressMic();
      await fireEvent.press(screen.getByTestId('voice-overlay-cancel'));

      // A whole fresh session, end to end.
      await pressMic();
      await say('climate');
      await stopSpeaking();
      await fireEvent.press(screen.getByTestId('voice-overlay-submit'));

      await waitFor(() => expect(pipeline.searchCalls).toHaveLength(1));
      expect(pipeline.searchCalls[0].query).toBe('climate');
    });
  });

  // ── Permission ─────────────────────────────────────────────────────────────

  describe('when the microphone is refused', () => {
    it('says so, in copy that names the fix', async () => {
      mockSpeechRecognition.setPermissionGranted(false);
      setSearchPipeline(stub(() => Promise.resolve(feed())));
      await render(<SearchScreen />);

      await fireEvent.press(screen.getByTestId('search-input-voice'));

      await waitFor(() => expect(screen.getByTestId('voice-overlay-error')).toBeTruthy());
      expect(
        screen.getByText('Microphone access is off. Turn it on in Settings to search by voice.'),
      ).toBeTruthy();
    });

    it('never opens the microphone', async () => {
      mockSpeechRecognition.setPermissionGranted(false);
      setSearchPipeline(stub(() => Promise.resolve(feed())));
      await render(<SearchScreen />);

      await fireEvent.press(screen.getByTestId('search-input-voice'));

      await waitFor(() => expect(screen.getByTestId('voice-overlay-error')).toBeTruthy());
      expect(mockSpeechRecognition.startCalls()).toHaveLength(0);
    });

    // The one that matters: a refusal is not a query.
    it('starts no search', async () => {
      mockSpeechRecognition.setPermissionGranted(false);
      const pipeline = stub(() => Promise.resolve(feed()));
      setSearchPipeline(pipeline);
      await render(<SearchScreen />);

      await fireEvent.press(screen.getByTestId('search-input-voice'));

      await waitFor(() => expect(screen.getByTestId('voice-overlay-error')).toBeTruthy());
      expect(pipeline.searchCalls).toHaveLength(0);
    });
  });

  // ── The transcript becomes a query ─────────────────────────────────────────

  describe('a recognised transcript', () => {
    it('sends the transcript to the search pipeline, unchanged', async () => {
      const pipeline = stub(() => Promise.resolve(feed({ publications: [FIRST] })));
      setSearchPipeline(pipeline);
      await render(<SearchScreen />);

      await pressMic();
      await say('machine learning in healthcare');
      await stopSpeaking();

      await fireEvent.press(screen.getByTestId('voice-overlay-submit'));

      await waitFor(() => expect(pipeline.searchCalls).toHaveLength(1));
      expect(pipeline.searchCalls[0].query).toBe('machine learning in healthcare');
    });

    // Same store, same cap, same dedupe as a typed query — a voice search is a
    // search, so it belongs in the list of recent ones.
    it('is remembered as a recent search', async () => {
      setSearchPipeline(stub(() => Promise.resolve(feed({ publications: [FIRST] }))));
      await render(<SearchScreen />);

      await pressMic();
      await say('climate');
      await stopSpeaking();
      await fireEvent.press(screen.getByTestId('voice-overlay-submit'));

      await waitFor(() =>
        expect(useRecentSearchesStore.getState().queries).toContain('climate'),
      );
    });

    it('closes the overlay, revealing the results underneath', async () => {
      setSearchPipeline(stub(() => Promise.resolve(feed({ publications: [FIRST] }))));
      await render(<SearchScreen />);

      await pressMic();
      await say('climate');
      await stopSpeaking();
      await fireEvent.press(screen.getByTestId('voice-overlay-submit'));

      await waitFor(() => expect(screen.getByTestId('content-card')).toBeTruthy());
      expect(screen.queryByTestId('voice-overlay')).toBeNull();
      expect(screen.getByText('Environmental Policy in China')).toBeTruthy();
    });

    // The mockup shows Search live while the title still reads "Listening…",
    // so a reader may commit before the recogniser decides they have stopped.
    // The overlay must still close, and the microphone must still shut.
    it('can be committed mid-utterance, closing the microphone with it', async () => {
      const pipeline = stub(() => Promise.resolve(feed({ publications: [FIRST] })));
      setSearchPipeline(pipeline);
      await render(<SearchScreen />);

      await pressMic();
      await say('machine learning');
      await fireEvent.press(screen.getByTestId('voice-overlay-submit'));

      await waitFor(() => expect(pipeline.searchCalls).toHaveLength(1));
      expect(pipeline.searchCalls[0].query).toBe('machine learning');
      expect(screen.queryByTestId('voice-overlay')).toBeNull();
      expect(mockSpeechRecognition.isRunning()).toBe(false);
    });

    // Voice adds no error surface of its own. Once the transcript is submitted
    // it is an ordinary search and fails like one.
    it('renders a post-recognition failure through the existing search error', async () => {
      setSearchPipeline(
        stub(() => Promise.reject(new CatalogueFailure(CatalogueError.TIMEOUT, 'search'))),
      );
      await render(<SearchScreen />);

      await pressMic();
      await say('climate');
      await stopSpeaking();
      await fireEvent.press(screen.getByTestId('voice-overlay-submit'));

      await waitFor(() => expect(screen.getByTestId('search-error')).toBeTruthy());
      expect(screen.getByText('This took too long to respond.')).toBeTruthy();
    });

    it('renders zero results through the existing empty state, not an error', async () => {
      setSearchPipeline(stub(() => Promise.resolve(feed())));
      await render(<SearchScreen />);

      await pressMic();
      await say('quantum basket weaving');
      await stopSpeaking();
      await fireEvent.press(screen.getByTestId('voice-overlay-submit'));

      await waitFor(() => expect(screen.getByTestId('search-empty')).toBeTruthy());
      expect(screen.queryByTestId('search-error')).toBeNull();
    });
  });

  // ── The two ways a session ends without a query ────────────────────────────

  describe('when nothing was heard', () => {
    it('says so rather than reporting a breakage', async () => {
      setSearchPipeline(stub(() => Promise.resolve(feed())));
      await render(<SearchScreen />);

      await pressMic();
      await stopSpeaking();

      expect(screen.getByText('No speech was heard. Try again.')).toBeTruthy();
    });

    it('starts no search', async () => {
      const pipeline = stub(() => Promise.resolve(feed()));
      setSearchPipeline(pipeline);
      await render(<SearchScreen />);

      await pressMic();
      await stopSpeaking();

      expect(pipeline.searchCalls).toHaveLength(0);
      expect(screen.queryByTestId('search-empty')).toBeNull();
    });

    // THE OTHER ROUTE TO THE SAME OUTCOME, and the one nothing else in this
    // suite exercises: `nomatch` is a final result the recogniser could not make
    // anything of. The partials already on screen are exactly what it is
    // declining to confirm, so they are dropped rather than searched — see the
    // reducer's `noMatch`. Emitted with the `end` that follows it on a device,
    // because `end` is what retires the session.
    it('drops an unconfirmed partial rather than searching it', async () => {
      const pipeline = stub(() => Promise.resolve(feed()));
      setSearchPipeline(pipeline);
      await render(<SearchScreen />);

      await pressMic();
      await say('quantum bask');
      await act(async () => {
        mockSpeechRecognition.emit('nomatch', null);
        mockSpeechRecognition.emit('end', null);
      });

      expect(screen.getByText('No speech was heard. Try again.')).toBeTruthy();
      // The guess the recogniser withdrew is gone from the surface, not left
      // sitting there submittable.
      expect(screen.queryByText('quantum bask')).toBeNull();
      expect(screen.getByTestId('voice-overlay-error')).toBeTruthy();
      expect(pipeline.searchCalls).toHaveLength(0);
    });

    // Clear is the recovery, and it must reopen the microphone rather than
    // leaving the reader on a dead surface.
    it('offers a retry that listens again', async () => {
      setSearchPipeline(stub(() => Promise.resolve(feed())));
      await render(<SearchScreen />);

      await pressMic();
      await stopSpeaking();
      await fireEvent.press(screen.getByTestId('voice-overlay-clear'));

      await waitFor(() => expect(mockSpeechRecognition.startCalls()).toHaveLength(2));
      expect(screen.queryByTestId('voice-overlay-error')).toBeNull();
    });
  });

  describe('when the reader cancels', () => {
    it('starts no search, even with a transcript on screen', async () => {
      const pipeline = stub(() => Promise.resolve(feed({ publications: [FIRST] })));
      setSearchPipeline(pipeline);
      await render(<SearchScreen />);

      await pressMic();
      await say('climate');
      await fireEvent.press(screen.getByTestId('voice-overlay-cancel'));

      expect(pipeline.searchCalls).toHaveLength(0);
      expect(screen.queryByTestId('voice-overlay')).toBeNull();
    });

    it('closes the microphone', async () => {
      setSearchPipeline(stub(() => Promise.resolve(feed())));
      await render(<SearchScreen />);

      await pressMic();
      await fireEvent.press(screen.getByTestId('voice-overlay-cancel'));

      expect(mockSpeechRecognition.isRunning()).toBe(false);
    });

    // The native recogniser keeps emitting after abort(). A trailing end would
    // otherwise put a dismissed overlay back on screen as "no speech heard".
    it('ignores the events the recogniser emits after it was stopped', async () => {
      const pipeline = stub(() => Promise.resolve(feed()));
      setSearchPipeline(pipeline);
      await render(<SearchScreen />);

      await pressMic();
      await say('climate');
      await fireEvent.press(screen.getByTestId('voice-overlay-cancel'));

      await act(async () => {
        mockSpeechRecognition.emitTranscript('climate change', true);
        mockSpeechRecognition.emit('end', null);
      });

      expect(screen.queryByTestId('voice-overlay')).toBeNull();
      expect(pipeline.searchCalls).toHaveLength(0);
    });
  });

  // ── A recogniser that broke ────────────────────────────────────────────────

  it('reports a recogniser failure without starting a search', async () => {
    const pipeline = stub(() => Promise.resolve(feed()));
    setSearchPipeline(pipeline);
    await render(<SearchScreen />);

    await pressMic();
    await act(async () => {
      mockSpeechRecognition.emit('error', { error: 'network', message: 'no connection' });
      mockSpeechRecognition.emit('end', null);
    });

    expect(screen.getByText('You appear to be offline.')).toBeTruthy();
    expect(pipeline.searchCalls).toHaveLength(0);
  });

  it('keeps a device with no recogniser out of the retry loop', async () => {
    setSearchPipeline(stub(() => Promise.resolve(feed())));
    await render(<SearchScreen />);

    await pressMic();
    await act(async () => {
      mockSpeechRecognition.emit('error', {
        error: 'service-not-allowed',
        message: 'no recognition service',
      });
    });

    expect(
      screen.getByText('Voice search is not available on this device. Type your search instead.'),
    ).toBeTruthy();
  });

  // A REFUSAL HAS TWO ROUTES IN, and only one of them is the permission response
  // the block above drives. iOS authorises the microphone and speech recognition
  // separately, so a reader who has granted the mic can still be refused — and
  // that arrives as a `not-allowed` error event, not as `granted: false`. Both
  // must land on the same state and the same copy; the reducer routes on the
  // code for exactly this reason.
  it('reports a refusal that arrives as a native error the same way', async () => {
    const pipeline = stub(() => Promise.resolve(feed()));
    setSearchPipeline(pipeline);
    await render(<SearchScreen />);

    await pressMic();
    await act(async () => {
      mockSpeechRecognition.emit('error', { error: 'not-allowed', message: 'denied' });
      // `end` follows every error on a device. It must not overwrite the refusal
      // with a cheerful "no speech was heard".
      mockSpeechRecognition.emit('end', null);
    });

    expect(
      screen.getByText('Microphone access is off. Turn it on in Settings to search by voice.'),
    ).toBeTruthy();
    expect(pipeline.searchCalls).toHaveLength(0);
  });

  // Android reports a silence as a TIMEOUT rather than as `no-speech`, and it is
  // the commoner of the two in practice. It is an answer, not a breakage, so it
  // has to land on the same copy an `end`-with-nothing-heard produces — the
  // distinction `searchState` keeps between `empty` and `error`, one layer down.
  it('reports an Android silence timeout as nothing heard, not a breakage', async () => {
    const pipeline = stub(() => Promise.resolve(feed()));
    setSearchPipeline(pipeline);
    await render(<SearchScreen />);

    await pressMic();
    await act(async () => {
      mockSpeechRecognition.emit('error', { error: 'speech-timeout', message: 'no speech' });
      mockSpeechRecognition.emit('end', null);
    });

    expect(screen.getByText('No speech was heard. Try again.')).toBeTruthy();
    expect(pipeline.searchCalls).toHaveLength(0);
  });
});

// ── D12 — the Elite queue affordance is ItemDetailScreen only ─────────────────
//
// CONFIRMED TEAM DECISION, 26 Aug. A search result row draws no queue button
// regardless of tier.
describe('SearchScreen — no Elite queue affordance', () => {
  function eliteFeed(id = 'item_elite') {
    return feed({ publications: [publication(id, 'An Elite Title', 'Routledge', 'ELITE')] });
  }

  afterEach(() => {
    useLibraryStore.setState({ loans: [], holds: [], loading: false });
  });

  it('draws no Grant access button on an Elite result', async () => {
    setSearchPipeline(stub(() => Promise.resolve(eliteFeed())));
    await render(<SearchScreen />);

    await submit('elite');

    await waitFor(() => expect(screen.getByText('An Elite Title')).toBeTruthy());
    expect(screen.queryByText('Grant access')).toBeNull();
  });

  it('draws no queue position even when the reader is queued', async () => {
    useLibraryStore.setState({
      loans: [],
      holds: [
        {
          holdId: 'hold_1',
          itemId: 'item_elite',
          state: 'queued',
          position: 4,
          queueLength: 9,
          serverTime: '2026-08-26T09:00:00Z',
        },
      ],
      loading: false,
    });
    setSearchPipeline(stub(() => Promise.resolve(eliteFeed())));
    await render(<SearchScreen />);

    await submit('elite');

    await waitFor(() => expect(screen.getByText('An Elite Title')).toBeTruthy());
    expect(screen.queryByText(/in queue/i)).toBeNull();
  });

  it('still navigates to the detail screen, which is where the queue lives', async () => {
    setSearchPipeline(stub(() => Promise.resolve(eliteFeed())));
    await render(<SearchScreen />);
    await submit('elite');
    await waitFor(() => expect(screen.getByText('An Elite Title')).toBeTruthy());

    fireEvent.press(screen.getByText('An Elite Title'));

    expect(mockNavigate).toHaveBeenCalledWith('ItemDetail', { itemId: 'item_elite' });
  });
});

// ── D8 — not entitled: no buttons, no badge ───────────────────────────────────
describe('SearchScreen — D8 not entitled', () => {
  it('renders the result with no badge and no action', async () => {
    const orphan = {
      id: 'item_orphan',
      title: 'Metadata Only',
      publisher: 'Routledge',
      authors: [],
      subjects: [],
      // No acquisition link.
    } as unknown as Publication;
    setSearchPipeline(stub(() => Promise.resolve(feed({ publications: [orphan] }))));
    await render(<SearchScreen />);

    await submit('metadata');

    await waitFor(() => expect(screen.getByText('Metadata Only')).toBeTruthy());
    expect(screen.queryByText('Open Access')).toBeNull();
  });
});

// ── Screen 17 — the empty-search panels ───────────────────────────────────────
//
// The design shows two: "No results found" with a Clear search way out, and "No
// matching content" with Clear filters. Both were rendered already; the Clear
// search affordance was the missing half.
describe('SearchScreen — screen 17 empty search', () => {
  const emptyFeed = () => feed({ publications: [] });

  it('names the query that matched nothing', async () => {
    setSearchPipeline(stub(() => Promise.resolve(emptyFeed())));
    await render(<SearchScreen />);

    await submit('xyz123');

    await waitFor(() => expect(screen.getByTestId('search-empty')).toBeTruthy());
    expect(screen.getByText(/xyz123/)).toBeTruthy();
  });

  // SCOPED TO THE PANEL, and the reason is worth recording: `SearchInput`'s own
  // clear affordance already carries the accessible name "Clear search", so at
  // screen level the query is ambiguous. Two controls with one accessible name is
  // a real (small) accessibility smell — the design asks for both, so this is
  // raised for the accessibility pass rather than resolved by dropping one.
  it('offers Clear search in the panel, and clearing it drops the query', async () => {
    setSearchPipeline(stub(() => Promise.resolve(emptyFeed())));
    await render(<SearchScreen />);
    await submit('xyz123');
    await waitFor(() => expect(screen.getByTestId('search-empty')).toBeTruthy());

    const panel = within(screen.getByTestId('search-empty'));
    fireEvent.press(panel.getByRole('button', { name: 'Clear search' }));

    await waitFor(() => expect(screen.queryByTestId('search-empty')).toBeNull());
  });

  // Empty is not an error and must never render as one.
  it('shows no error copy and no retry for a zero-result response', async () => {
    setSearchPipeline(stub(() => Promise.resolve(emptyFeed())));
    await render(<SearchScreen />);

    await submit('xyz123');

    await waitFor(() => expect(screen.getByTestId('search-empty')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});
