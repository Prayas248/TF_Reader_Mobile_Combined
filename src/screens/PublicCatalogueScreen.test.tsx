// A1 — the signed-out catalogue: one flat list of open access titles.
//
// Injects a fake DataSource through `setCatalogueSource` rather than hitting
// MockAdapter's fixtures, so these pin the screen's own wiring independently of
// what the fixtures happen to contain — same approach as CatalogueScreen.test.tsx.
//
// `await render(...)` is required — RTL 14's render is async.
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { DataSource } from '@adapters/InstitutionSource';
import { setCatalogueSource } from '@config/catalogue';
import {
  PUBLIC_FEED,
  forgetFeedOffsets,
  rememberedFeedOffset,
} from '@hooks/useFeedScrollMemory';
import type { Publication, Shelf } from '@model/types';

import PublicCatalogueScreen from './PublicCatalogueScreen';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

const mockUseNetworkStatus = jest.fn(() => true);
jest.mock('@hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => mockUseNetworkStatus(),
}));

function openAccessTitle(id: string, title: string): Publication {
  return {
    id,
    title,
    publisher: 'Routledge',
    authors: [],
    subjects: [],
    format: 'PDF',
    acquisition: {
      actionId: 'openAccess',
      href: `https://flambeau.tf/api/v1/content/${id}/access`,
      licenceModel: 'OPEN_ACCESS',
      encryption: null,
      hasSearchIndex: true,
      canPersist: true,
    },
  };
}

const FIRST_PAGE: Shelf = {
  id: 'catalogue',
  title: 'Open access titles',
  totalItems: 3,
  nextPage: 1,
  publications: [
    openAccessTitle('item_oa1', 'Coastal Wetlands of the Bay of Bengal'),
    openAccessTitle('item_oa2', 'Teaching Mathematics in Multilingual Classrooms'),
  ],
};

const SECOND_PAGE: Shelf = {
  id: 'catalogue',
  title: 'Open access titles',
  totalItems: 3,
  publications: [openAccessTitle('item_oa3', 'Listening to Cities')],
};

// Every method a real DataSource must have, so the fake typechecks as one. Only
// `getPublicFeed` is exercised — the rest reject, so a screen that reached for
// one would fail loudly rather than quietly work off the wrong endpoint.
function fakeSource(getPublicFeed: DataSource['getPublicFeed']): DataSource {
  const unused = () => Promise.reject(new Error('not stubbed for this test'));
  return {
    getPublicFeed,
    getHomeCatalogue: unused,
    getShelf: unused,
    getPublication: unused,
    getPublicPublication: unused,
    getInstitutions: unused,
    getInstitution: unused,
    getItemsBatch: unused,
    getWork: unused,
  };
}

afterEach(() => {
  setCatalogueSource(undefined);
  mockNavigate.mockClear();
  mockUseNetworkStatus.mockReturnValue(true);
  // Module state, so it would otherwise carry into the next test.
  forgetFeedOffsets();
});

describe('PublicCatalogueScreen loading', () => {
  it('shows skeletons before the feed arrives', async () => {
    // Never resolves within the test, so the screen is caught mid-load.
    setCatalogueSource(fakeSource(() => new Promise(() => {})));

    await render(<PublicCatalogueScreen />);

    expect(screen.getAllByTestId('content-card-skeleton').length).toBeGreaterThan(0);
  });

  // The whole point of A1: shelves belong to an institution and this reader has
  // none, so a category strip here would be inventing one.
  it('shows no category-card skeletons, because there are no shelves to load', async () => {
    setCatalogueSource(fakeSource(() => new Promise(() => {})));

    await render(<PublicCatalogueScreen />);

    expect(screen.queryAllByTestId('category-card-skeleton')).toHaveLength(0);
  });
});

describe('PublicCatalogueScreen with data', () => {
  it('renders every publication the feed returned', async () => {
    setCatalogueSource(fakeSource(async () => FIRST_PAGE));

    await render(<PublicCatalogueScreen />);

    await waitFor(() =>
      expect(screen.getByText('Coastal Wetlands of the Bay of Bengal')).toBeTruthy(),
    );
    expect(screen.getByText('Teaching Mathematics in Multilingual Classrooms')).toBeTruthy();
  });

  // A flat list, not a home screen. The feed's own title is metadata for the app
  // bar, not a section heading, and rendering it would make one list look like
  // the first of several.
  it('renders no category cards, and one fixed section heading naming the list', async () => {
    setCatalogueSource(fakeSource(async () => FIRST_PAGE));

    await render(<PublicCatalogueScreen />);

    await waitFor(() =>
      expect(screen.getByText('Coastal Wetlands of the Bay of Bengal')).toBeTruthy(),
    );
    expect(screen.queryAllByTestId('category-card-title')).toHaveLength(0);
    expect(screen.getByText('Open Access Titles')).toBeTruthy();
  });

  it('navigates to ItemDetail with the publication id when a row is pressed', async () => {
    setCatalogueSource(fakeSource(async () => FIRST_PAGE));

    await render(<PublicCatalogueScreen />);

    await waitFor(() =>
      expect(screen.getByText('Coastal Wetlands of the Bay of Bengal')).toBeTruthy(),
    );
    fireEvent.press(
      screen.getByRole('button', { name: 'Coastal Wetlands of the Bay of Bengal' }),
    );

    expect(mockNavigate).toHaveBeenCalledWith('ItemDetail', { itemId: 'item_oa1' });
  });

  it('asks for the feed without an institution id', async () => {
    const calls: unknown[][] = [];
    setCatalogueSource(
      fakeSource(async (...args) => {
        calls.push(args);
        return FIRST_PAGE;
      }),
    );

    await render(<PublicCatalogueScreen />);

    await waitFor(() =>
      expect(screen.getByText('Coastal Wetlands of the Bay of Bengal')).toBeTruthy(),
    );
    // First page is requested with no page argument at all, so the server picks
    // its own default rather than being told "page 0".
    expect(calls).toEqual([[undefined]]);
  });
});

describe('PublicCatalogueScreen error', () => {
  it('shows a retry affordance when the feed fails, and retrying re-fetches', async () => {
    let attempt = 0;
    setCatalogueSource(
      fakeSource(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('network down');
        return FIRST_PAGE;
      }),
    );

    await render(<PublicCatalogueScreen />);

    await waitFor(() => expect(screen.getByText(/couldn.?t load/i)).toBeTruthy());

    fireEvent.press(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() =>
      expect(screen.getByText('Coastal Wetlands of the Bay of Bengal')).toBeTruthy(),
    );
    expect(attempt).toBe(2);
  });
});

describe('PublicCatalogueScreen empty', () => {
  it('renders EmptyState rather than a blank screen when nothing is open access', async () => {
    const nothing: Shelf = { ...FIRST_PAGE, publications: [], nextPage: undefined };
    setCatalogueSource(fakeSource(async () => nothing));

    await render(<PublicCatalogueScreen />);

    await waitFor(() => expect(screen.getByText('Nothing to show here yet.')).toBeTruthy());
    // An empty feed is not a failure — offering Retry would say it was.
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});

describe('PublicCatalogueScreen offline', () => {
  it('shows the offline banner over the loaded list', async () => {
    mockUseNetworkStatus.mockReturnValue(false);
    setCatalogueSource(fakeSource(async () => FIRST_PAGE));

    await render(<PublicCatalogueScreen />);

    // Degraded, not disabled: the list underneath the banner is still there.
    await waitFor(() =>
      expect(screen.getByText('Coastal Wetlands of the Bay of Bengal')).toBeTruthy(),
    );
    expect(screen.getByText("You're offline")).toBeTruthy();
  });

  it('renders no offline banner while the network is up', async () => {
    setCatalogueSource(fakeSource(async () => FIRST_PAGE));

    await render(<PublicCatalogueScreen />);

    await waitFor(() =>
      expect(screen.getByText('Coastal Wetlands of the Bay of Bengal')).toBeTruthy(),
    );
    expect(screen.queryByText("You're offline")).toBeNull();
  });
});

// A7 — the screen's half of the contract: the offset is recorded under the
// PUBLIC feed's own key, so signing in and back out returns the reader here
// rather than to the top. What it does with that offset is
// useFeedScrollMemory.test.tsx's job; this pins the wiring and the key.
describe('PublicCatalogueScreen scroll position', () => {
  it('records the reader’s place under the public feed’s key', async () => {
    setCatalogueSource(fakeSource(async () => FIRST_PAGE));

    await render(<PublicCatalogueScreen />);

    await waitFor(() =>
      expect(screen.getByText('Coastal Wetlands of the Bay of Bengal')).toBeTruthy(),
    );
    await fireEvent.scroll(screen.getByTestId('public-catalogue-feed'), {
      nativeEvent: { contentOffset: { y: 275 }, contentSize: { height: 2000, width: 400 } },
    });

    expect(rememberedFeedOffset(PUBLIC_FEED)).toBe(275);
  });
});

// A3 — the card's fourth field, alongside title, publisher and badge.
describe('PublicCatalogueScreen file format', () => {
  it('gives every row its file format', async () => {
    setCatalogueSource(fakeSource(async () => FIRST_PAGE));

    await render(<PublicCatalogueScreen />);

    await waitFor(() =>
      expect(screen.getByText('Coastal Wetlands of the Bay of Bengal')).toBeTruthy(),
    );
    expect(screen.getAllByTestId('content-card-format')).toHaveLength(
      FIRST_PAGE.publications.length,
    );
  });
});

describe('PublicCatalogueScreen paging', () => {
  function pagedSource(): DataSource {
    return fakeSource(async (page?: number) => (page === undefined ? FIRST_PAGE : SECOND_PAGE));
  }

  it('appends the next page rather than replacing what is on screen', async () => {
    setCatalogueSource(pagedSource());

    await render(<PublicCatalogueScreen />);

    await waitFor(() =>
      expect(screen.getByText('Coastal Wetlands of the Bay of Bengal')).toBeTruthy(),
    );
    await fireEvent.press(screen.getByRole('button', { name: /load more/i }));

    await waitFor(() => expect(screen.getByText('Listening to Cities')).toBeTruthy());
    // Page 0's rows are still there — appended, not replaced.
    expect(screen.getByText('Coastal Wetlands of the Bay of Bengal')).toBeTruthy();
  });

  it('requests the page the feed itself advertised, never page + 1', async () => {
    const requested: (number | undefined)[] = [];
    setCatalogueSource(
      fakeSource(async (page?: number) => {
        requested.push(page);
        return page === undefined ? FIRST_PAGE : SECOND_PAGE;
      }),
    );

    await render(<PublicCatalogueScreen />);

    await waitFor(() =>
      expect(screen.getByText('Coastal Wetlands of the Bay of Bengal')).toBeTruthy(),
    );
    await fireEvent.press(screen.getByRole('button', { name: /load more/i }));

    await waitFor(() => expect(screen.getByText('Listening to Cities')).toBeTruthy());
    expect(requested).toEqual([undefined, FIRST_PAGE.nextPage]);
  });

  // Absent rather than disabled: a permanently dead button reads as broken.
  it('offers no Load more once the last page has arrived', async () => {
    setCatalogueSource(pagedSource());

    await render(<PublicCatalogueScreen />);

    await waitFor(() =>
      expect(screen.getByText('Coastal Wetlands of the Bay of Bengal')).toBeTruthy(),
    );
    await fireEvent.press(screen.getByRole('button', { name: /load more/i }));

    await waitFor(() => expect(screen.getByText('Listening to Cities')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });

  it('offers no Load more when the first page is already the last', async () => {
    setCatalogueSource(fakeSource(async () => SECOND_PAGE));

    await render(<PublicCatalogueScreen />);

    await waitFor(() => expect(screen.getByText('Listening to Cities')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });

  // A later page failing must not wipe the rows the reader already has — the
  // full-screen error state is first-page-only, same rule as ShelfScreen.
  it('keeps the loaded rows and offers an inline retry when a later page fails', async () => {
    setCatalogueSource(
      fakeSource(async (page?: number) => {
        if (page === undefined) return FIRST_PAGE;
        throw new Error('network down');
      }),
    );

    await render(<PublicCatalogueScreen />);

    await waitFor(() =>
      expect(screen.getByText('Coastal Wetlands of the Bay of Bengal')).toBeTruthy(),
    );
    await fireEvent.press(screen.getByRole('button', { name: /load more/i }));

    await waitFor(() => expect(screen.getByText(/couldn.?t load more/i)).toBeTruthy());
    expect(screen.getByText('Coastal Wetlands of the Bay of Bengal')).toBeTruthy();
  });

  // Overlapping pages are a real server behaviour, not a hypothetical — a row
  // the server sends again must not become a second row (and a second React
  // key) on screen.
  it('drops a row the later page repeats instead of showing it twice', async () => {
    const overlappingSecondPage: Shelf = {
      id: 'catalogue',
      title: 'Open access titles',
      totalItems: 3,
      publications: [
        openAccessTitle('item_oa2', 'Teaching Mathematics in Multilingual Classrooms'),
        openAccessTitle('item_oa3', 'Listening to Cities'),
      ],
    };
    setCatalogueSource(
      fakeSource(async (page?: number) => (page === undefined ? FIRST_PAGE : overlappingSecondPage)),
    );

    await render(<PublicCatalogueScreen />);

    await waitFor(() =>
      expect(screen.getByText('Coastal Wetlands of the Bay of Bengal')).toBeTruthy(),
    );
    await fireEvent.press(screen.getByRole('button', { name: /load more/i }));

    await waitFor(() => expect(screen.getByText('Listening to Cities')).toBeTruthy());
    expect(
      screen.getAllByText('Teaching Mathematics in Multilingual Classrooms'),
    ).toHaveLength(1);
  });
});

// A3 — every row carries its access tier. Everything on this screen is Open
// Access by definition, so the label is the assertion that matters: a screen
// resolving with an institution it does not have could still produce a badge,
// just the wrong one.
describe('PublicCatalogueScreen access-tier badges', () => {
  it('gives every publication row a badge', async () => {
    setCatalogueSource(fakeSource(async () => FIRST_PAGE));

    await render(<PublicCatalogueScreen />);

    await waitFor(() =>
      expect(screen.getByText('Coastal Wetlands of the Bay of Bengal')).toBeTruthy(),
    );
    expect(screen.getAllByTestId('content-card-badge')).toHaveLength(2);
  });

  it('labels them Open Access', async () => {
    setCatalogueSource(fakeSource(async () => FIRST_PAGE));

    await render(<PublicCatalogueScreen />);

    await waitFor(() => expect(screen.getAllByText('Open Access')).toHaveLength(2));
  });
});

// ── D8 — not entitled: no buttons, no badge ───────────────────────────────────
//
// This screen is the most dangerous place for the OPEN_ACCESS placeholder to
// leak: it is a list OF open access titles, so a false "Open Access" chip on an
// unopenable row would look completely at home.
describe('PublicCatalogueScreen — D8 not entitled', () => {
  it('renders the row with no badge and no action', async () => {
    const orphan = {
      id: 'item_orphan',
      title: 'Metadata Only',
      publisher: 'Routledge',
      authors: [],
      subjects: [],
    } as unknown as Publication;
    setCatalogueSource(
      fakeSource(async () => ({ id: 'public', title: 'Open access', publications: [orphan] })),
    );

    await render(<PublicCatalogueScreen />);

    await waitFor(() => expect(screen.getByText('Metadata Only')).toBeTruthy());
    expect(screen.queryByText('Open Access')).toBeNull();
    expect(screen.queryByTestId('content-card-badge')).toBeNull();
    expect(screen.queryByTestId('content-card-action')).toBeNull();
  });
});

// ── D12 — audited, and excluded here on purpose ───────────────────────────────
//
// The deliverable names four surfaces; this is the one that does NOT get the
// queue affordance, and the exclusion is verified rather than only commented.
//
// WHY, IN ONE LINE: with no institution there is no session, and `resolveAccess`
// §4 answers `requires_signin` for every licensed tier once the session is null.
// The queue is unreachable by construction here, so a button could never appear
// however hard this screen tried — and this screen may not read
// `institutionStore` to obtain one (see the file header).
//
// THIS TEST IS THE RECORD. If someone later gives this screen an institution,
// it fails, and whoever changed it has to decide about D12 deliberately rather
// than discovering a missing button in review.
describe('PublicCatalogueScreen — D12 exclusion', () => {
  it('offers no queue affordance on an Elite row, because there is no session', async () => {
    const elite = {
      id: 'item_elite',
      title: 'An Elite Title',
      publisher: 'Routledge',
      authors: [],
      subjects: [],
      format: 'EPUB',
      acquisition: {
        actionId: 'borrow',
        href: 'https://x/loan/item_elite',
        licenceModel: 'ELITE',
        encryption: null,
        hasSearchIndex: false,
        canPersist: true,
      },
    } as unknown as Publication;
    setCatalogueSource(
      fakeSource(async () => ({ id: 'public', title: 'Open access', publications: [elite] })),
    );

    await render(<PublicCatalogueScreen />);

    await waitFor(() => expect(screen.getByText('An Elite Title')).toBeTruthy());
    expect(screen.queryByText('Grant access')).toBeNull();
    expect(screen.queryByTestId('queue-action-position')).toBeNull();
    expect(screen.queryByTestId('queue-action-offer')).toBeNull();
    expect(screen.queryByTestId('content-card-action')).toBeNull();
  });
});
