// src/screens/ItemDetailScreen.test.tsx
// Screen 05 (book) and Screen 04 (article). Same seam as CatalogueScreen.test.tsx
// and ShelfScreen.test.tsx: inject a fake DataSource through `setCatalogueSource`
// rather than hitting MockAdapter's fixtures, so these tests pin the screen's own
// wiring (loading -> data -> error -> retry) independently of what the fixtures
// contain.
//
// THE ARTICLE TESTS RENDER `renderArticleContent` DIRECTLY, NOT THE FULL SCREEN.
// The fetch below always resolves `workType: 'book'` — see the header comment in
// ItemDetailScreen.tsx — so there is no fake `DataSource` response that makes the
// full screen choose the article presentation today. Testing the exported
// presentation function against a hand-built `ItemDetail` is the honest
// alternative: it proves the branch works without pretending the fetch can
// select it yet.
//
// `await render(...)` is required — RTL 14's render is async.
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { resolveAccess } from '@access/resolveAccess';
import type { DataSource } from '@adapters/InstitutionSource';
import { setCatalogueSource } from '@config/catalogue';
import { buildItemDetail } from '@model/detail';
import { CatalogueError, CatalogueFailure } from '@model/errors';
import type { Institution } from '@model/institution';
import type { Acquisition, Publication } from '@model/types';
import { LicenceError, LicenceFailure } from '@/licence/LicenceSource';
import { useDownloadStore } from '@store/downloadStore';
import { useInstitutionStore } from '@store/institutionStore';
import { useLibraryStore } from '@store/libraryStore';
import { useRecentlyViewedStore } from '@store/recentlyViewedStore';
import { useSessionStore } from '@store/sessionStore';

import ItemDetailScreen, {
  ARTICLE_WORK_TYPE,
  BOOK_WORK_TYPE,
  renderArticleContent,
  renderBookContent,
} from './ItemDetailScreen';

// `useNetworkStatus` talks to NetInfo, which has no meaningful answer under
// Jest. Mocked per-test so the offline case can be driven directly, the same way
// a screen consumes the hook's return value rather than the module underneath it.
const mockUseNetworkStatus = jest.fn(() => true);
jest.mock('@hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => mockUseNetworkStatus(),
}));

// Controls what the licence source does inside handleAction and refresh().
// All calls default to resolved so existing tests are unaffected.
const mockBorrow = jest
  .fn()
  .mockResolvedValue({
    loanId: 'loan_1',
    itemId: 'item_42',
    state: 'active',
    expiresAt: 9_999_999_999,
  });
const mockReturnLoan = jest.fn().mockResolvedValue(undefined);
const mockPlaceHold = jest
  .fn()
  .mockResolvedValue({
    holdId: 'hold_1',
    itemId: 'item_42',
    state: 'queued',
    position: 1,
    queueLength: 1,
    serverTime: '',
  });
const mockGetLibrary = jest.fn().mockResolvedValue({ loans: [], holds: [] });

jest.mock('@config/licence', () => ({
  // sessionStore.ts calls this at module load — the currentSession.ts import
  // chain (ItemDetailScreen → currentSession → sessionStore) now pulls
  // sessionStore in even though this file never touches it directly.
  setLicenceToken: jest.fn(),
  getLicenceSource: () => ({
    borrow: (...args: [string]) => mockBorrow(...args),
    returnLoan: (...args: [string]) => mockReturnLoan(...args),
    placeHold: (...args: [string]) => mockPlaceHold(...args),
    acceptOffer: jest
      .fn()
      .mockResolvedValue({
        loanId: 'loan_1',
        itemId: 'item_42',
        state: 'active',
        expiresAt: 9_999_999_999,
      }),
    cancelHold: jest.fn().mockResolvedValue(undefined),
    getLibrary: () => mockGetLibrary(),
  }),
}));

// Download no longer borrows — it hands off to useDownloadProgress's start(),
// which drives downloadManager.ts. Mocked at the hook boundary, same level the
// screen itself talks to, rather than pulling downloadManager's real network
// stack into these tests.
const mockDownloadStart = jest.fn();
let mockDownloadProgressState = {
  status: 'idle' as 'idle' | 'downloading' | 'completed' | 'error',
  bytesReceived: 0,
  expectedLength: null as number | null,
  errorMessage: null as string | null,
};
jest.mock('@/features/download/useDownloadProgress', () => ({
  useDownloadProgress: () => ({ ...mockDownloadProgressState, start: mockDownloadStart }),
}));

// Read/Play no longer borrow — they call openBook() directly (see
// ItemDetailScreen.tsx's 'read' || 'play' branch) and only navigate to the
// Reader once it resolves. Mocked at that boundary, same as
// ItemDetailScreen.loading.test.tsx's own note, so these tests exercise the
// screen's own wiring without pulling openBook's real network/decrypt stack
// into a render test.
const mockOpenBook = jest.fn().mockResolvedValue(new Uint8Array());
jest.mock('@/features/download/openBook', () => ({
  openBook: (...args: [string, string]) => mockOpenBook(...args),
}));

function anAcquisition(over: Partial<Acquisition> = {}): Acquisition {
  return {
    actionId: 'borrow',
    href: 'https://flambeau.test/api/v1/loans',
    licenceModel: 'SUBSCRIPTION',
    encryption: null,
    hasSearchIndex: false,
    canPersist: true,
    ...over,
  };
}

// Every optional field populated, so a test can knock one out at a time.
function aBook(over: Partial<Publication> = {}): Publication {
  return {
    id: 'item_42',
    isbn: '9780367211745',
    title: 'Rights for Robots',
    subtitle: 'Artificial Intelligence, Animal and Environmental Law',
    authors: ['Joshua C. Gellers'],
    publisher: 'Routledge',
    published: '2020-09-30',
    subjects: ['Law', 'Technology'],
    description: 'A study of legal personhood.',
    numberOfPages: 212,
    format: 'PDF',
    coverUrl: 'https://cdn.tf/covers/item_42.jpg',
    acquisition: anAcquisition(),
    ...over,
  };
}

// Every optional field populated, same reason as `aBook`. No `isbn`,
// `numberOfPages`, `publisher`, `subtitle` or `coverUrl` — real articles do not
// carry these on the model any more than a book publication is required to, and
// leaving them off here means a test that finds one anyway is finding a real
// leak rather than a fixture accident.
function anArticle(over: Partial<Publication> = {}): Publication {
  return {
    id: 'item_article_1',
    title: 'Rights for Robots: A Legal Framework',
    authors: ['Joshua C. Gellers'],
    published: '2021-03-15',
    subjects: ['Law', 'Technology'],
    description: 'An examination of legal personhood for artificial agents.',
    format: 'PDF',
    acquisition: anAcquisition({ licenceModel: 'OPEN_ACCESS' }),
    ...over,
  };
}

// Builds a real `ItemDetail` through the same chain the screen uses —
// `resolveAccess` then `buildItemDetail` — just with `workType` fixed to
// 'article' by hand, since nothing in the fetch can choose it yet.
function anArticleDetail(over: Partial<Publication> = {}) {
  const publication = anArticle(over);
  const access = resolveAccess({ item: publication, institutionId: 'inst_7f3', session: null });
  return buildItemDetail({ publication, workType: ARTICLE_WORK_TYPE, access });
}

// Every method a real DataSource must have, so the fake typechecks as one. The
// methods no test here calls reject, which turns an unexpected dependency into a
// loud failure instead of a silent one — same idiom as CatalogueScreen.test.tsx
// and InstitutionDetailScreen.test.tsx.
//
// BOTH detail methods are served by the one stub: which of them the screen calls
// depends on whether an institution is selected, and almost every test below
// cares about the rendering rather than the route. The two that DO care pin it
// directly — see 'ItemDetailScreen endpoint choice'.
function fakeSource(getPublication: DataSource['getPublication']): DataSource {
  const unused = () => Promise.reject(new Error('not stubbed for this test'));
  return {
    getHomeCatalogue: unused,
    getShelf: unused,
    getPublication,
    getPublicFeed: unused,
    getPublicPublication: (bookId) => getPublication('', bookId),
    getInstitutions: unused,
    getInstitution: unused,
    getItemsBatch: unused,
    getWork: unused,
  };
}

// Shared across every test below except the ones that specifically assert on
// navigation — those read `mockNavigate` directly rather than needing their
// own `navigation` object.
const mockNavigate = jest.fn();
// The header title call — see ItemDetailRouteProps's own comment for why the
// screen calls this itself rather than the stack registration knowing the
// title ahead of time. No test asserts on it directly; it exists so the
// mocked navigation prop satisfies the real type.
const mockSetOptions = jest.fn();
// Same reason: satisfies the real type for the tab-bar-hiding effect (see
// ItemDetailRouteProps's own comment), returning a fresh mock `setOptions`
// each call — no test asserts on it directly either.
const mockGetParent = jest.fn(() => ({ setOptions: jest.fn() }));
const routeProps = {
  route: { params: { itemId: 'item_42' } },
  navigation: { navigate: mockNavigate, setOptions: mockSetOptions, getParent: mockGetParent },
};

const INSTITUTION: Institution = {
  id: 'inst_a21',
  name: 'Second Institution',
  country: 'GB',
  code: 'SEC',
  city: 'Leeds',
  catalogueUrl: 'https://api.tf/opds/v1/institutions/inst_a21/catalogue',
};

// Selecting an institution no longer implies signing in (handToggledSession is
// gone — see currentSession.ts), so every test below that expects licensed-tier
// access (Grant access, borrow, hold) has to establish a real session too, not
// just a selected institution.
function selectAndSignIn(institution: Institution) {
  useInstitutionStore.setState({ selectedInstitution: institution });
  useSessionStore.setState({
    isAuthenticated: true,
    accessToken: 'test-access-token',
    expiresAt: Date.now() + 3_600_000,
    userId: `test-user:${institution.id}`,
    institutionId: institution.id,
    roles: [],
    collections: [],
  });
}

afterEach(() => {
  setCatalogueSource(undefined);
  mockUseNetworkStatus.mockReturnValue(true);
  mockNavigate.mockClear();
  mockSetOptions.mockClear();
  mockGetParent.mockClear();
  // CALL HISTORY, NOT JUST RETURN VALUES. These four had their resolved values
  // reset but never their call lists, so a `not.toHaveBeenCalled()` assertion
  // saw the PREVIOUS test's calls — which is why "does NOT fall through to
  // placeHold" failed once the suite stopped timing out. `mockReset` would drop
  // the implementations set below, so this is `mockClear` plus a fresh value.
  mockBorrow.mockClear();
  mockReturnLoan.mockClear();
  mockPlaceHold.mockClear();
  mockGetLibrary.mockClear();
  mockDownloadStart.mockClear();
  mockBorrow.mockResolvedValue({
    loanId: 'loan_1',
    itemId: 'item_42',
    state: 'active',
    expiresAt: 9_999_999_999,
  });
  mockReturnLoan.mockResolvedValue(undefined);
  mockPlaceHold.mockResolvedValue({
    holdId: 'hold_1',
    itemId: 'item_42',
    state: 'queued',
    position: 1,
    queueLength: 1,
    serverTime: '',
  });
  mockGetLibrary.mockResolvedValue({ loans: [], holds: [] });
  mockDownloadProgressState = {
    status: 'idle',
    bytesReceived: 0,
    expectedLength: null,
    errorMessage: null,
  };
  useInstitutionStore.setState({ selectedInstitution: null });
  useLibraryStore.setState({ loans: [], holds: [], loading: false });
  useDownloadStore.setState({ downloads: [] });
  useRecentlyViewedStore.getState().clear();
  useSessionStore.setState({
    isAuthenticated: false,
    accessToken: null,
    expiresAt: null,
    userId: null,
    institutionId: null,
    roles: [],
    collections: [],
  });
});

// A1. A reader who has picked no institution reached this screen from the public
// catalogue, so the detail must come from the public endpoint too. Falling back
// to some default institution's copy would answer a question nobody asked — and
// could show a Read button for a licence this reader does not hold.
describe('ItemDetailScreen endpoint choice', () => {
  function recordingSource(calls: string[]): DataSource {
    const unused = () => Promise.reject(new Error('not stubbed for this test'));
    return {
      getHomeCatalogue: unused,
      getShelf: unused,
      getPublication: async (institutionId) => {
        calls.push(`institution:${institutionId}`);
        return aBook();
      },
      getPublicFeed: unused,
      getPublicPublication: async () => {
        calls.push('public');
        return aBook();
      },
      getInstitutions: unused,
      getInstitution: unused,
      getItemsBatch: unused,
      getWork: unused,
    };
  }

  it('asks the public endpoint when no institution is selected', async () => {
    const calls: string[] = [];
    useInstitutionStore.setState({ selectedInstitution: null });
    setCatalogueSource(recordingSource(calls));

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(calls).toEqual(['public']));
  });

  it('asks the institution endpoint once one is selected', async () => {
    const calls: string[] = [];
    selectAndSignIn(INSTITUTION);
    setCatalogueSource(recordingSource(calls));

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(calls).toEqual([`institution:${INSTITUTION.id}`]));
  });

  // The picker's selection (browsable before sign-in) and the signed-in
  // session's own institution are two different stores and can disagree —
  // e.g. a reader browsed one institution's catalogue, then signed in as a
  // member of another. Fetching under the PICKED institution here would ask
  // wokay for a publication scoped to an institution the reader's token
  // doesn't belong to, which is exactly the shape of a NOT_FOUND report this
  // fixes: the signed-in institution is the one the backend will actually
  // recognise this reader against.
  it('asks the signed-in institution endpoint, not a differing picked one', async () => {
    const calls: string[] = [];
    const pickedInstitution: Institution = { ...INSTITUTION, id: 'inst_picked' };
    useInstitutionStore.setState({ selectedInstitution: pickedInstitution });
    useSessionStore.setState({
      isAuthenticated: true,
      accessToken: 'test-access-token',
      expiresAt: Date.now() + 3_600_000,
      userId: 'test-user:inst_a21',
      institutionId: INSTITUTION.id,
      roles: [],
      collections: [],
    });
    setCatalogueSource(recordingSource(calls));

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(calls).toEqual([`institution:${INSTITUTION.id}`]));
  });
});

// Search's own idle-state "Recently viewed" row (screen 09) is fed by this
// screen recording the view once a publication actually resolves — see
// recentlyViewedStore.ts's own note on why the snapshot is taken here.
describe('ItemDetailScreen — recording a recently-viewed item', () => {
  it('records the view once the publication resolves', async () => {
    setCatalogueSource(
      fakeSource(async () => aBook({ id: 'item_42', title: 'Rights for Robots' })),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() =>
      expect(useRecentlyViewedStore.getState().items.map((i) => i.id)).toEqual(['item_42']),
    );
    expect(useRecentlyViewedStore.getState().items[0].title).toBe('Rights for Robots');
  });

  it('does not record anything when the fetch fails', async () => {
    setCatalogueSource(
      fakeSource(async () => {
        throw new CatalogueFailure(CatalogueError.NOT_FOUND, 'item_42');
      }),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('This could not be found.')).toBeTruthy());
    expect(useRecentlyViewedStore.getState().items).toEqual([]);
  });
});

describe('ItemDetailScreen loading', () => {
  it('shows a skeleton, and no title, before the book arrives', async () => {
    // Never resolves within the test, so the screen is caught mid-load.
    setCatalogueSource(fakeSource(() => new Promise(() => {})));

    await render(<ItemDetailScreen {...routeProps} />);

    expect(screen.getByTestId('item-detail-skeleton')).toBeTruthy();
    expect(screen.queryByText('Rights for Robots')).toBeNull();
  });
});

describe('ItemDetailScreen with a book', () => {
  it('renders the title', async () => {
    setCatalogueSource(fakeSource(async () => aBook()));

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
  });

  it('renders the authors', async () => {
    setCatalogueSource(fakeSource(async () => aBook()));

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Joshua C. Gellers')).toBeTruthy());
  });

  it('renders the cover when a cover url is present', async () => {
    setCatalogueSource(fakeSource(async () => aBook()));

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByLabelText('Rights for Robots cover')).toBeTruthy());
  });

  it('renders the ISBN when present', async () => {
    setCatalogueSource(fakeSource(async () => aBook()));

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText(/9780367211745/)).toBeTruthy());
  });

  it('renders the page count when present', async () => {
    setCatalogueSource(fakeSource(async () => aBook()));

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('212 pages')).toBeTruthy());
  });

  it('renders the publisher when present', async () => {
    setCatalogueSource(fakeSource(async () => aBook()));

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText(/Routledge/)).toBeTruthy());
  });

  it('renders the published date when present, as a human date rather than the feed’s raw ISO string', async () => {
    setCatalogueSource(fakeSource(async () => aBook()));

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText(/30 September 2020/)).toBeTruthy());
    expect(screen.queryByText(/2020-09-30/)).toBeNull();
  });

  it('renders the access tier badge for the resolved tier', async () => {
    setCatalogueSource(fakeSource(async () => aBook({ acquisition: anAcquisition() })));

    await render(<ItemDetailScreen {...routeProps} />);

    // Subscription, no session: resolveAccess still resolves the tier for the
    // badge even though the reader is signed out.
    await waitFor(() => expect(screen.getByText('Subscription')).toBeTruthy());
  });

  it('renders the actions resolveAccess resolves, not an invented set', async () => {
    // Open Access resolves the same signed in or out, so this is a stable case
    // to pin the action bar against without a session.
    setCatalogueSource(
      fakeSource(async () =>
        aBook({ acquisition: anAcquisition({ licenceModel: 'OPEN_ACCESS' }) }),
      ),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Read')).toBeTruthy());
    expect(screen.getByText('Download')).toBeTruthy();
  });

  // `resolveAccess` itself still only ever returns `read` — it has no
  // business reading `format` (see ACTION_IDS's own note). The relabel to
  // `play` for an AUDIO item is this screen's own presentational remap, so
  // it is pinned here rather than in resolveAccess's own test suite.
  describe('an audiobook says Play, not Read', () => {
    it('shows Play instead of Read for an AUDIO item', async () => {
      setCatalogueSource(
        fakeSource(async () =>
          aBook({ format: 'AUDIO', acquisition: anAcquisition({ licenceModel: 'OPEN_ACCESS' }) }),
        ),
      );

      await render(<ItemDetailScreen {...routeProps} />);

      await waitFor(() => expect(screen.getByText('Play')).toBeTruthy());
      expect(screen.queryByText('Read')).toBeNull();
      // Download is a separate action and keeps its own label regardless.
      expect(screen.getByText('Download')).toBeTruthy();
    });

    it('still says Read for every non-AUDIO format', async () => {
      setCatalogueSource(
        fakeSource(async () =>
          aBook({ format: 'EPUB', acquisition: anAcquisition({ licenceModel: 'OPEN_ACCESS' }) }),
        ),
      );

      await render(<ItemDetailScreen {...routeProps} />);

      await waitFor(() => expect(screen.getByText('Read')).toBeTruthy());
      expect(screen.queryByText('Play')).toBeNull();
    });

    it('opens the book and navigates to the AudioPlayer, not the Reader', async () => {
      setCatalogueSource(
        fakeSource(async () =>
          aBook({ format: 'AUDIO', acquisition: anAcquisition({ licenceModel: 'OPEN_ACCESS' }) }),
        ),
      );

      await render(<ItemDetailScreen {...routeProps} />);

      await waitFor(() => expect(screen.getByText('Play')).toBeTruthy());
      fireEvent.press(screen.getByText('Play'));

      await waitFor(() => expect(mockOpenBook).toHaveBeenCalledWith('item_42', 'AUDIO'));
      // AUDIO opens the audio player, not the EPUB/PDF reader — the two are
      // separate screens with unrelated implementations underneath (expo-audio
      // vs. the epub.js/pdf.js WebView bridge). See ItemDetailScreen.tsx's
      // 'read'/'play' branch.
      await waitFor(() =>
        expect(mockNavigate).toHaveBeenCalledWith('AudioPlayer', {
          bookId: 'item_42',
          title: 'Rights for Robots',
        }),
      );
      expect(mockNavigate).not.toHaveBeenCalledWith('Reader', expect.anything());
    });
  });

  // Download no longer goes through the borrow-based licence flow — it hands
  // the tapped item straight to useDownloadProgress's start(), which drives
  // downloadManager.ts (and, from there, downloadTable — not this screen).
  it('starts the download via useDownloadProgress when Download is tapped', async () => {
    setCatalogueSource(
      fakeSource(async () =>
        aBook({ acquisition: anAcquisition({ licenceModel: 'OPEN_ACCESS' }) }),
      ),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Download')).toBeTruthy());
    fireEvent.press(screen.getByText('Download'));

    await waitFor(() => expect(mockDownloadStart).toHaveBeenCalledWith('item_42', 'PDF'));
    // The borrow-based licence call this used to make is gone entirely.
    expect(mockBorrow).not.toHaveBeenCalled();
  });

  it('does not start a second download while one is already in flight', async () => {
    mockDownloadProgressState = {
      status: 'downloading',
      bytesReceived: 0,
      expectedLength: null,
      errorMessage: null,
    };
    setCatalogueSource(
      fakeSource(async () =>
        aBook({ acquisition: anAcquisition({ licenceModel: 'OPEN_ACCESS' }) }),
      ),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Download')).toBeTruthy());
    fireEvent.press(screen.getByText('Download'));

    expect(mockDownloadStart).not.toHaveBeenCalled();
  });

  // Regression test: `useDownloadProgress`/`downloadManager` persist a
  // completed download to SQLite, but `LibraryScreen`'s Downloads tab still
  // reads the older `downloadStore` (see that file's own header on why it's
  // not yet retired). A merge dropped this screen's write-through to that
  // store without adding a replacement, so a real successful download never
  // showed up in Library — this pins the fix in the completion effect.
  it('records the download in downloadStore once it completes, so it shows up in Library', async () => {
    mockDownloadProgressState = {
      status: 'completed',
      bytesReceived: 4096,
      expectedLength: 4096,
      errorMessage: null,
    };
    setCatalogueSource(
      fakeSource(async () =>
        aBook({ acquisition: anAcquisition({ licenceModel: 'OPEN_ACCESS' }) }),
      ),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() =>
      expect(useDownloadStore.getState().downloads).toEqual([
        expect.objectContaining({ itemId: 'item_42', sizeBytes: 4096 }),
      ]),
    );
  });

  // The fixture this screen will meet in the real app is an Elite title, and
  // with no session store yet resolveAccess resolves it to sign-in — a real
  // access rule, not a stand-in for one.
  it('resolves an Elite title with no session to Sign in', async () => {
    setCatalogueSource(
      fakeSource(async () => aBook({ acquisition: anAcquisition({ licenceModel: 'ELITE' }) })),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Sign in')).toBeTruthy());
    expect(screen.queryByText('Read')).toBeNull();
  });

  // A7 — the other half of the promise: signing in is supposed to unlock
  // different buttons, not just a different set of books. Subscription rather
  // than Elite, so the contrast is the clean two-state one resolveAccess
  // documents (§6) — Elite's nothing-held case resolves to Grant access, not
  // Read, which is a second real distinction and not this test's point.
  it('resolves a Subscription title to Read once an institution is selected, instead of Sign in', async () => {
    selectAndSignIn(INSTITUTION);
    setCatalogueSource(
      fakeSource(async () =>
        aBook({ acquisition: anAcquisition({ licenceModel: 'SUBSCRIPTION' }) }),
      ),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Read')).toBeTruthy());
    expect(screen.queryByText('Sign in')).toBeNull();
  });

  // The Elite case, since it takes a different (and equally real) button —
  // "requires_grant" rather than "available" — and both must be reachable now
  // that session is no longer permanently null.
  it('resolves an Elite title to Grant access once an institution is selected, instead of Sign in', async () => {
    selectAndSignIn(INSTITUTION);
    setCatalogueSource(
      fakeSource(async () => aBook({ acquisition: anAcquisition({ licenceModel: 'ELITE' }) })),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Grant access')).toBeTruthy());
    expect(screen.queryByText('Sign in')).toBeNull();
  });

  it('opens AccessGate with the item id, title and authors when Sign in is tapped', async () => {
    setCatalogueSource(
      fakeSource(async () => aBook({ acquisition: anAcquisition({ licenceModel: 'ELITE' }) })),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Sign in')).toBeTruthy());
    fireEvent.press(screen.getByText('Sign in'));

    expect(mockNavigate).toHaveBeenCalledWith('AccessGate', {
      itemId: 'item_42',
      title: 'Rights for Robots',
      authors: 'Joshua C. Gellers',
    });
  });

  // Screen 03 is reachable from exactly one action. Every other resolved
  // action must still be untouched by this change. One press, not two — two
  // `fireEvent.press` calls in a single test open overlapping `act()` scopes
  // and corrupt every render after it in the file (same trap noted in
  // QueueNotification.test.tsx).
  it('still no-ops for actions other than signIn', async () => {
    setCatalogueSource(
      fakeSource(async () =>
        aBook({ acquisition: anAcquisition({ licenceModel: 'OPEN_ACCESS' }) }),
      ),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Read')).toBeTruthy());
    fireEvent.press(screen.getByText('Read'));

    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('ItemDetailScreen format, price and table of contents', () => {
  it('renders the confirmed format as a display strip', async () => {
    setCatalogueSource(fakeSource(async () => aBook({ format: 'PDF' })));

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByTestId('format-strip')).toBeTruthy());
    expect(screen.getByText('PDF')).toBeTruthy();
  });

  // Not `Tabs`, not `FilterChip` — there is exactly one value, so nothing
  // here should behave like a control with more than one state to switch.
  it('renders the format strip as non-interactive', async () => {
    setCatalogueSource(fakeSource(async () => aBook({ format: 'PDF' })));

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByTestId('format-strip')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'PDF' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'PDF' })).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  // A `subscribe` rel publication carries no file and therefore no format —
  // see normalize.ts. The strip must simply not appear, not crash the screen.
  it('renders no format strip, and does not crash, when the publication has none', async () => {
    setCatalogueSource(fakeSource(async () => aBook({ format: undefined })));

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    expect(screen.queryByTestId('format-strip')).toBeNull();
  });

  // Book-detail refinement §10: a meaningless "Price unavailable" pill is
  // worse than no price section at all — there is no price field in either
  // contract, so this omits the row entirely rather than naming the gap.
  it('never shows a price row, invented or otherwise', async () => {
    setCatalogueSource(fakeSource(async () => aBook()));

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    expect(screen.queryByText(/price/i)).toBeNull();
    // Nothing that looks like an actual price (a currency symbol and digits)
    // is ever built — there is no price field in either contract.
    expect(screen.queryByText(/[$£€]\s?\d/)).toBeNull();
  });

  // Book-detail refinement §11 (revised): no TOC field exists on the model at
  // all, so the section is omitted entirely rather than shown with an
  // honest-but-empty body — the earlier "not currently available" text read
  // as the page announcing its own unfinished-ness.
  it('renders no Table of Contents section at all, there being no TOC field on the model', async () => {
    setCatalogueSource(fakeSource(async () => aBook()));

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    expect(screen.queryByText('Table of Contents')).toBeNull();
    expect(screen.queryByText(/table of contents/i)).toBeNull();
  });

  // §9 (revised again): "About this title" is now a real, always-present
  // section — a genuine description (today's one-liners included) is shown
  // rather than withheld.
  describe('the "About this title" section', () => {
    it('shows a real, non-fixture description under "About this title"', async () => {
      setCatalogueSource(
        fakeSource(async () => aBook({ description: 'A study of legal personhood.' })),
      );

      await render(<ItemDetailScreen {...routeProps} />);

      await waitFor(() => expect(screen.getByText('About this title')).toBeTruthy());
      expect(screen.getByText('A study of legal personhood.')).toBeTruthy();
    });

    // This screen used to filter out the catalogue source's own dev-fixture
    // placeholder text here — reversed on explicit instruction, since every
    // current title's real `description` value happens to be exactly this
    // note, and hiding it left the section looking permanently empty. Shown
    // verbatim now, same as any other field.
    it.each([
      'Real EPUB fixture (ELITE), ingested from a real file.',
      'Real PDF fixture, ingested from a real file.',
      'Real audio fixture, ingested from a real file.',
    ])(
      "shows the feed's own description verbatim, dev-fixture note included: %s",
      async (description) => {
        setCatalogueSource(fakeSource(async () => aBook({ description })));

        await render(<ItemDetailScreen {...routeProps} />);

        await waitFor(() => expect(screen.getByText('About this title')).toBeTruthy());
        expect(screen.getByText(description)).toBeTruthy();
        expect(screen.queryByText('Description not available yet.')).toBeNull();
      },
    );

    it('shows the honest fallback when the feed sent no description at all', async () => {
      setCatalogueSource(fakeSource(async () => aBook({ description: undefined })));

      await render(<ItemDetailScreen {...routeProps} />);

      await waitFor(() => expect(screen.getByText('About this title')).toBeTruthy());
      expect(screen.getByText('Description not available yet.')).toBeTruthy();
    });

    it('offers no "Read more" for a short description', async () => {
      setCatalogueSource(
        fakeSource(async () => aBook({ description: 'A study of legal personhood.' })),
      );

      await render(<ItemDetailScreen {...routeProps} />);

      await waitFor(() => expect(screen.getByText('About this title')).toBeTruthy());
      expect(screen.queryByRole('button', { name: 'Read more' })).toBeNull();
    });

    it('clamps a long description behind "Read more", and expands it on press', async () => {
      const longDescription = 'A study of legal personhood. '.repeat(20);
      setCatalogueSource(fakeSource(async () => aBook({ description: longDescription })));

      await render(<ItemDetailScreen {...routeProps} />);

      await waitFor(() => expect(screen.getByText(longDescription)).toBeTruthy());
      expect(screen.getByText(longDescription).props.numberOfLines).toBe(4);

      await fireEvent.press(screen.getByRole('button', { name: 'Read more' }));

      expect(screen.getByText(longDescription).props.numberOfLines).toBeUndefined();
      expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
    });
  });

  it('shows the format strip without pulling in the unavailable-tag treatment', async () => {
    setCatalogueSource(fakeSource(async () => aBook({ format: 'PDF' })));

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByTestId('format-strip')).toBeTruthy());
    // `unavailable-tag` is screen 04's marker now (the research-article eyebrow
    // and the citation link) — screen 05 no longer has anything muted enough
    // to need it, price and Table of Contents having moved to their own shapes.
    expect(screen.queryAllByTestId('unavailable-tag')).toHaveLength(0);
  });
});

describe('ItemDetailScreen with metadata missing', () => {
  it('renders the title and authors with every optional field absent, and does not crash', async () => {
    setCatalogueSource(
      fakeSource(async () =>
        aBook({
          isbn: undefined,
          subtitle: undefined,
          publisher: undefined,
          published: undefined,
          description: undefined,
          numberOfPages: undefined,
          coverUrl: undefined,
        }),
      ),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    expect(screen.getByText('Joshua C. Gellers')).toBeTruthy();
    expect(screen.queryByLabelText('Rights for Robots cover')).toBeNull();
    expect(screen.queryByText(/9780367211745/)).toBeNull();
    expect(screen.queryByText(/pages/)).toBeNull();
  });

  it('renders no author line when the feed carries none', async () => {
    setCatalogueSource(fakeSource(async () => aBook({ authors: [] })));

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
  });
});

describe('ItemDetailScreen errors', () => {
  // "Empty/missing publication" — a stale deep link or a bad id, not a network
  // problem. No retry: repeating a well-formed request for a title that does not
  // exist cannot make it appear.
  it('shows a not-found message with no retry when the publication does not exist', async () => {
    setCatalogueSource(
      fakeSource(async () => {
        throw new CatalogueFailure(CatalogueError.NOT_FOUND, 'item_missing');
      }),
    );

    await render(
      <ItemDetailScreen
        {...{
          route: { params: { itemId: 'item_missing' } },
          navigation: {
            navigate: mockNavigate,
            getParent: mockGetParent,
          },
        }}
      />,
    );

    await waitFor(() => expect(screen.getByText('This could not be found.')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('shows a retryable message on a network failure, and retry re-fetches', async () => {
    let attempt = 0;
    setCatalogueSource(
      fakeSource(async () => {
        attempt += 1;
        if (attempt === 1)
          throw new CatalogueFailure(CatalogueError.NETWORK_UNAVAILABLE, 'item_42');
        return aBook();
      }),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText(/you appear to be offline/i)).toBeTruthy());

    fireEvent.press(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    expect(attempt).toBe(2);
  });

  // getPublication now requires a signed-in reader (appToken). ItemDetailScreen
  // mounts off the selected institution alone, ahead of sign-in — a reader can
  // be looking at it, signed out and failed, with the sign-in sheet stacked on
  // top. Same bug and same test shape as CatalogueScreen/ShelfScreen.
  it('re-fetches on its own once the reader signs in, without a manual retry', async () => {
    useInstitutionStore.setState({ selectedInstitution: INSTITUTION });
    let attempt = 0;
    setCatalogueSource(
      fakeSource(async () => {
        attempt += 1;
        if (!useSessionStore.getState().isAuthenticated) throw new Error('401');
        return aBook();
      }),
    );

    await render(<ItemDetailScreen {...routeProps} />);
    await waitFor(() => expect(screen.getByText(/couldn.?t load this title/i)).toBeTruthy());

    useSessionStore.setState({
      isAuthenticated: true,
      accessToken: 'tok_abc123',
      expiresAt: Date.now() + 3_600_000,
      userId: 'test-user',
      institutionId: INSTITUTION.id,
      roles: [],
      collections: [],
    });

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    expect(attempt).toBe(2);
  });

  it('falls back to one honest message when the rejection is not a CatalogueFailure', async () => {
    setCatalogueSource(
      fakeSource(async () => {
        throw new Error('something nobody modelled');
      }),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText(/couldn.?t load this title/i)).toBeTruthy());
    expect(screen.queryByText(/nobody modelled/i)).toBeNull();
  });
});

describe('ItemDetailScreen offline', () => {
  it('shows the offline banner over the loaded content when the network is down', async () => {
    mockUseNetworkStatus.mockReturnValue(false);
    setCatalogueSource(fakeSource(async () => aBook()));

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    expect(screen.getByText("You're offline")).toBeTruthy();
  });

  it('renders no offline banner while the network is up', async () => {
    setCatalogueSource(fakeSource(async () => aBook()));

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    expect(screen.queryByText("You're offline")).toBeNull();
  });
});

// Loading, not-found and offline are not repeated below for the article case.
// All three happen before `workType` is even read — they are generic screen
// states, not book or article ones, and the suites above already exercise the
// exact same code paths this screen uses regardless of which presentation it
// eventually picks.
describe('ItemDetailScreen article presentation (renderArticleContent)', () => {
  it('renders the article title', async () => {
    await render(renderArticleContent(anArticleDetail(), jest.fn()));

    expect(screen.getByText('Rights for Robots: A Legal Framework')).toBeTruthy();
  });

  it('renders the authors', async () => {
    await render(renderArticleContent(anArticleDetail(), jest.fn()));

    expect(screen.getByText('Joshua C. Gellers')).toBeTruthy();
  });

  // Lives inside the "Published in" card now, not a standalone line under the
  // title — see that describe block below for the rest of the card's tests.
  it('renders the published date, human-formatted, inside the Published in card', async () => {
    await render(renderArticleContent(anArticleDetail(), jest.fn()));

    expect(screen.getByText('Published online')).toBeTruthy();
    expect(screen.getByText('15 March 2021')).toBeTruthy();
  });

  it('renders the Subjects section when the article has subjects', async () => {
    await render(renderArticleContent(anArticleDetail(), jest.fn()));

    expect(screen.getByText('Subjects')).toBeTruthy();
    expect(screen.getByText('Law')).toBeTruthy();
    expect(screen.getByText('Technology')).toBeTruthy();
  });

  it('renders no Subjects section when the article has none', async () => {
    await render(renderArticleContent(anArticleDetail({ subjects: [] }), jest.fn()));

    expect(screen.queryByText('Subjects')).toBeNull();
  });

  // Only present when opened from the journal drill-down (a route param, not
  // anything on Publication — an article carries no parent-journal reference
  // of its own). Absent for every other caller, e.g. a Search result.
  // Journal/volume/issue lives in exactly ONE place on the page — the
  // "Published in" card, alongside whatever article-specific facts
  // (published date, page count) the publication also supplies. There is
  // deliberately no second, separate eyebrow above the title any more: an
  // earlier pass had both, and repeating the same three facts twice on one
  // screen was the problem, not a feature.
  describe('the "Published in" card', () => {
    it('renders nothing extra when there is no journal context and no published/numberOfPages', async () => {
      const detail = anArticleDetail({ published: undefined, numberOfPages: undefined });
      await render(renderArticleContent(detail, jest.fn()));

      expect(screen.queryByText('Published in')).toBeNull();
      expect(screen.queryByText('Published online')).toBeNull();
    });

    it('renders the journal name and the volume/issue line when all three are known', async () => {
      await render(
        renderArticleContent(anArticleDetail(), jest.fn(), undefined, undefined, {
          journalTitle: 'All Life',
          volumeTitle: 'Volume 19',
          issueTitle: 'Issue 4',
        }),
      );

      expect(screen.getByText('Published in')).toBeTruthy();
      expect(screen.getByText('All Life')).toBeTruthy();
      expect(screen.getByText('Volume 19 · Issue 4')).toBeTruthy();
    });

    it('renders just the journal name when there is no volume/issue level', async () => {
      await render(
        renderArticleContent(anArticleDetail(), jest.fn(), undefined, undefined, {
          journalTitle: 'All Life',
        }),
      );

      expect(screen.getByText('All Life')).toBeTruthy();
      expect(screen.queryByText(/volume|issue/i)).toBeNull();
    });

    it('renders the article-specific facts (published date, page count) alongside the journal identity', async () => {
      const detail = anArticleDetail({ numberOfPages: 8 });
      await render(
        renderArticleContent(detail, jest.fn(), undefined, undefined, {
          journalTitle: 'All Life',
        }),
      );

      expect(screen.getByText('Published online')).toBeTruthy();
      expect(screen.getByText('15 March 2021')).toBeTruthy();
      expect(screen.getByText('8 pages')).toBeTruthy();
    });

    // The card should still earn its place with no journal context at all
    // (e.g. an article opened outside the journal drill-down), as long as the
    // publication itself supplies a fact worth showing.
    it('renders with only article-specific facts when there is no journal context', async () => {
      const detail = anArticleDetail({ numberOfPages: 8 });
      await render(renderArticleContent(detail, jest.fn()));

      expect(screen.queryByText('Published in')).toBeNull();
      expect(screen.getByText('Published online')).toBeTruthy();
      expect(screen.getByText('8 pages')).toBeTruthy();
    });
  });

  it('renders the abstract under its own heading when present', async () => {
    await render(renderArticleContent(anArticleDetail(), jest.fn()));

    expect(screen.getByText('Abstract')).toBeTruthy();
    expect(
      screen.getByText('An examination of legal personhood for artificial agents.'),
    ).toBeTruthy();
  });

  it('renders no abstract heading when there is no description', async () => {
    await render(renderArticleContent(anArticleDetail({ description: undefined }), jest.fn()));

    expect(screen.queryByText('Abstract')).toBeNull();
  });

  it('renders the access tier badge for the resolved tier', async () => {
    const detail = anArticleDetail({
      acquisition: anAcquisition({ licenceModel: 'SUBSCRIPTION' }),
    });

    await render(renderArticleContent(detail, jest.fn()));

    expect(screen.getByText('Subscription')).toBeTruthy();
  });

  // `resolveAccess`/`handleAction`'s 'signIn' branch never branches on
  // workType — confirmed by reading the code, but nothing pinned it for the
  // ARTICLE presentation specifically before this (only the book layout had
  // an equivalent test, further down this file). `anArticleDetail`'s own
  // `session: null` plus a licensed tier is exactly "signed out, non-open-
  // access", the same scenario a journal article behind a Subscription/Elite
  // tier hits.
  it('offers Sign in, not Read, for a signed-out reader on a non-open-access article', async () => {
    const detail = anArticleDetail({
      acquisition: anAcquisition({ licenceModel: 'SUBSCRIPTION' }),
    });
    const onAction = jest.fn();

    await render(renderArticleContent(detail, onAction));

    expect(screen.getByText('Sign in')).toBeTruthy();
    expect(screen.queryByText('Read')).toBeNull();
    fireEvent.press(screen.getByText('Sign in'));
    expect(onAction).toHaveBeenCalledWith('signIn');
  });

  it('offers Read, not Sign in, for an open-access article regardless of session', async () => {
    const detail = anArticleDetail({ acquisition: anAcquisition({ licenceModel: 'OPEN_ACCESS' }) });

    await render(renderArticleContent(detail, jest.fn()));

    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.queryByText('Sign in')).toBeNull();
  });

  it('renders the actions resolveAccess resolves, not an invented set', async () => {
    const detail = anArticleDetail({ acquisition: anAcquisition({ licenceModel: 'OPEN_ACCESS' }) });

    await render(renderArticleContent(detail, jest.fn()));

    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.getByText('Download')).toBeTruthy();
  });

  it('does not crash and still renders title and authors with every optional field absent', async () => {
    const detail = anArticleDetail({ published: undefined, description: undefined });

    await render(renderArticleContent(detail, jest.fn()));

    expect(screen.getByText('Rights for Robots: A Legal Framework')).toBeTruthy();
    expect(screen.getByText('Joshua C. Gellers')).toBeTruthy();
  });

  // Publication has no field for a page range, and neither backend contract
  // mentions one — see the code comment above renderArticleContent in
  // ItemDetailScreen.tsx. This documents the gap rather than papering over it:
  // there is no "Page range" label anywhere on this screen, because there is no
  // data behind one to render.
  it('renders no page-range row, because Publication has no pageRange field', async () => {
    await render(renderArticleContent(anArticleDetail(), jest.fn()));

    expect(screen.queryByText(/page range/i)).toBeNull();
  });

  // DOI is a settled removal (never rendered, not even disabled) and the price
  // pair / Table of Contents are screen 05's gaps, not screen 04's — none of
  // the three belongs on this screen in any form.
  it("renders no DOI, and none of screen 05's price or table-of-contents gaps", async () => {
    await render(renderArticleContent(anArticleDetail(), jest.fn()));

    expect(screen.queryByText(/doi/i)).toBeNull();
    expect(screen.queryByText(/table of contents/i)).toBeNull();
    expect(screen.queryByText(/paperback|ebook price/i)).toBeNull();
  });

  // Citation, the five tabs, and the "Research article" type label were all
  // removed on explicit instruction (see ItemDetailScreen.tsx's own header):
  // none has real data behind it, and a placeholder that will never resolve
  // is worse than not showing it. These tests pin the removal.
  describe('citation, tabs and type label — removed, not shown even muted', () => {
    it('renders no Download citation row', async () => {
      await render(renderArticleContent(anArticleDetail(), jest.fn()));

      expect(screen.queryByText('Download citation')).toBeNull();
    });

    it('renders no tab strip', async () => {
      await render(renderArticleContent(anArticleDetail(), jest.fn()));

      expect(screen.queryByText('Full Article')).toBeNull();
      expect(screen.queryByText('Figures & data')).toBeNull();
      expect(screen.queryByText('Citations')).toBeNull();
      expect(screen.queryByText('Metrics')).toBeNull();
      expect(screen.queryByRole('tablist')).toBeNull();
      expect(screen.queryByRole('tab')).toBeNull();
    });

    it('renders no "Research article" type label', async () => {
      await render(renderArticleContent(anArticleDetail(), jest.fn()));

      expect(screen.queryByText('Research article')).toBeNull();
      expect(screen.queryByTestId('unavailable-tag')).toBeNull();
    });

    // These are metadata gaps, not access gaps — they must stay absent the
    // same way regardless of which tier or actions resolveAccess returned.
    it('stays absent regardless of the resolved access state', async () => {
      const detail = anArticleDetail({ acquisition: anAcquisition({ licenceModel: 'ELITE' }) });

      await render(renderArticleContent(detail, jest.fn()));

      expect(screen.queryByText('Download citation')).toBeNull();
      expect(screen.queryByText('Research article')).toBeNull();
      expect(screen.queryByText('PDF')).toBeNull();
    });
  });

  // ISBN, page count and publisher are on `ItemDetail` — buildItemDetail copies
  // them from any Publication that carries them — but the board's screen 04
  // field list never asked for them, so renderArticleContent must not read them
  // even when they are present on the object it was handed.
  // ISBN/publisher/format stay book-only. `numberOfPages` is the one
  // exception — see the "Published in" card tests above for why it moved
  // from "never read" to "read, inside the card".
  it('renders no ISBN, publisher or format strip even when the underlying data carries them', async () => {
    const detail = anArticleDetail({
      isbn: '9780367211745',
      numberOfPages: 212,
      publisher: 'Routledge',
      format: 'PDF',
    });

    await render(renderArticleContent(detail, jest.fn()));

    expect(screen.queryByText(/isbn/i)).toBeNull();
    expect(screen.queryByText(/publisher/i)).toBeNull();
    expect(screen.getByText('212 pages')).toBeTruthy();
    // `format` joined `ItemDetail` for screen 05's display strip; the article
    // branch must still never read it.
    expect(screen.queryByText('PDF')).toBeNull();
    expect(screen.queryByTestId('format-strip')).toBeNull();
  });
});

describe('ItemDetailScreen selects presentation by workType', () => {
  // Same underlying content, differing only in workType, rendered through each
  // exported presentation function directly — the same two calls the screen's
  // own one-line branch makes. Article-only and book-only affordances appear on
  // exactly one side each.
  it('renders the article layout for workType article and the book layout for workType book', async () => {
    const publication = aBook();
    const access = resolveAccess({ item: publication, institutionId: 'inst_7f3', session: null });
    const articleDetail = buildItemDetail({ publication, workType: ARTICLE_WORK_TYPE, access });
    const bookDetail = buildItemDetail({ publication, workType: BOOK_WORK_TYPE, access });

    const article = await render(renderArticleContent(articleDetail, jest.fn()));
    expect(screen.getByText('Abstract')).toBeTruthy();
    expect(screen.queryByText(/isbn/i)).toBeNull();
    // AWAITED. RTL 14 types `unmount` as returning a Promise, and an un-awaited
    // one leaves an open act() scope that corrupts every render AFTER it in this
    // file — which is what made the eight holdings/licence tests below fail while
    // passing in isolation. Same trap this file's own header records for two
    // presses in one test.
    await article.unmount();

    await render(renderBookContent(bookDetail, jest.fn()));
    expect(screen.queryByText('Abstract')).toBeNull();
    expect(screen.getByText(/9780367211745/)).toBeTruthy();
  });
});

// D10/F8 — holdings joined per item. The library store is pre-populated before
// render so the screen sees the loan/hold immediately without waiting for a real
// getLibrary call. This verifies that resolveAccess receives the holdings and
// picks the right action set — not that the fetch itself works (libraryStore.test.ts
// owns that).
describe('ItemDetailScreen — holdings joined from library store', () => {
  it('shows Revoke licence when the reader already holds an active loan for the item', async () => {
    selectAndSignIn(INSTITUTION);
    const loan = {
      loanId: 'loan_1',
      itemId: 'item_42',
      state: 'active' as const,
      expiresAt: 9_999_999_999,
    };
    // Pre-populate the store so the first resolved detail already sees the loan.
    // mockGetLibrary returns the same data so refresh() on mount does not overwrite it.
    useLibraryStore.setState({ loans: [loan], holds: [] });
    mockGetLibrary.mockResolvedValue({ loans: [loan], holds: [] });
    setCatalogueSource(
      fakeSource(async () => aBook({ acquisition: anAcquisition({ licenceModel: 'ELITE' }) })),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Revoke licence')).toBeTruthy());
    expect(screen.queryByText('Grant access')).toBeNull();
  });

  // LABELS ARE 'Accept' AND 'Reject', not "Accept offer"/"Reject offer". The
  // action IDS are `acceptOffer`/`rejectOffer`, but ActionButton's own table
  // renders the short pair — and the docs say the same: "offered shows
  // Accept · Reject" (D10–D12, 16 Aug). The old expectation was asserting a
  // label the app has never rendered; it only went unnoticed because this test
  // was timing out for an unrelated reason.
  it('shows Accept and Reject when the reader has a live hold offer', async () => {
    selectAndSignIn(INSTITUTION);
    const hold = {
      holdId: 'hold_1',
      itemId: 'item_42',
      state: 'offered' as const,
      offerId: 'offer_1',
      offerExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      serverTime: new Date().toISOString(),
    };
    useLibraryStore.setState({ loans: [], holds: [hold] });
    mockGetLibrary.mockResolvedValue({ loans: [], holds: [hold] });
    setCatalogueSource(
      fakeSource(async () => aBook({ acquisition: anAcquisition({ licenceModel: 'ELITE' }) })),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Accept')).toBeTruthy());
    expect(screen.getByText('Reject')).toBeTruthy();
  });

  it('shows no actions when the reader is queued (waiting for a copy)', async () => {
    selectAndSignIn(INSTITUTION);
    const hold = {
      holdId: 'hold_1',
      itemId: 'item_42',
      state: 'queued' as const,
      position: 3,
      queueLength: 7,
      serverTime: new Date().toISOString(),
    };
    useLibraryStore.setState({ loans: [], holds: [hold] });
    mockGetLibrary.mockResolvedValue({ loans: [], holds: [hold] });
    setCatalogueSource(
      fakeSource(async () => aBook({ acquisition: anAcquisition({ licenceModel: 'ELITE' }) })),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Elite')).toBeTruthy());
    // resolveAccess returns no actions for the queued state.
    expect(screen.queryByText('Grant access')).toBeNull();
    expect(screen.queryByText('Accept')).toBeNull();
    expect(screen.queryByText('Read')).toBeNull();
  });

  it('shows the reader their queue position when queued', async () => {
    selectAndSignIn(INSTITUTION);
    const hold = {
      holdId: 'hold_1',
      itemId: 'item_42',
      state: 'queued' as const,
      position: 3,
      queueLength: 7,
      serverTime: new Date().toISOString(),
    };
    useLibraryStore.setState({ loans: [], holds: [hold] });
    mockGetLibrary.mockResolvedValue({ loans: [], holds: [hold] });
    setCatalogueSource(
      fakeSource(async () => aBook({ acquisition: anAcquisition({ licenceModel: 'ELITE' }) })),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Position 3 of 7 in queue')).toBeTruthy());
  });

  it('ignores a loan for a different item — still shows Grant access for this one', async () => {
    selectAndSignIn(INSTITUTION);
    const otherLoan = {
      loanId: 'loan_x',
      itemId: 'item_OTHER',
      state: 'active' as const,
      expiresAt: 9_999_999_999,
    };
    // Loan for a different itemId — must not affect this screen's item_42.
    useLibraryStore.setState({ loans: [otherLoan], holds: [] });
    mockGetLibrary.mockResolvedValue({ loans: [otherLoan], holds: [] });
    setCatalogueSource(
      fakeSource(async () => aBook({ acquisition: anAcquisition({ licenceModel: 'ELITE' }) })),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Grant access')).toBeTruthy());
  });
});

// D10/F8 — invalidate on the four calls. Each action tap calls the right
// licence method, then refresh() re-fetches the library so the action bar
// reflects the new state without a page reload.
describe('ItemDetailScreen — invalidate cache after action', () => {
  it('calls borrow and refreshes the library when Grant access is tapped', async () => {
    selectAndSignIn(INSTITUTION);
    const loan = {
      loanId: 'loan_1',
      itemId: 'item_42',
      state: 'active' as const,
      expiresAt: 9_999_999_999,
    };
    mockBorrow.mockResolvedValue(loan);
    // First call on mount returns empty → Grant access shown.
    // Second call after borrow returns the new loan → Revoke licence shown.
    mockGetLibrary
      .mockResolvedValueOnce({ loans: [], holds: [] })
      .mockResolvedValue({ loans: [loan], holds: [] });
    setCatalogueSource(
      fakeSource(async () => aBook({ acquisition: anAcquisition({ licenceModel: 'ELITE' }) })),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Grant access')).toBeTruthy());
    fireEvent.press(screen.getByText('Grant access'));

    await waitFor(() => expect(mockBorrow).toHaveBeenCalledWith('item_42'));
    await waitFor(() => expect(screen.getByText('Revoke licence')).toBeTruthy());
  });

  it('calls returnLoan and refreshes when Revoke licence is tapped', async () => {
    selectAndSignIn(INSTITUTION);
    const loan = {
      loanId: 'loan_1',
      itemId: 'item_42',
      state: 'active' as const,
      expiresAt: 9_999_999_999,
    };
    useLibraryStore.setState({ loans: [loan], holds: [] });
    mockReturnLoan.mockResolvedValue(undefined);
    // First call on mount preserves the pre-set loan → Revoke licence shown.
    // Second call after return returns empty → Grant access shown.
    mockGetLibrary
      .mockResolvedValueOnce({ loans: [loan], holds: [] })
      .mockResolvedValue({ loans: [], holds: [] });
    setCatalogueSource(
      fakeSource(async () => aBook({ acquisition: anAcquisition({ licenceModel: 'ELITE' }) })),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Revoke licence')).toBeTruthy());
    fireEvent.press(screen.getByText('Revoke licence'));

    await waitFor(() => expect(mockReturnLoan).toHaveBeenCalledWith('loan_1'));
    await waitFor(() => expect(screen.getByText('Grant access')).toBeTruthy());
  });

  it('falls through to placeHold when borrow is refused with NO_COPIES_AVAILABLE', async () => {
    selectAndSignIn(INSTITUTION);
    mockBorrow.mockRejectedValue(
      new LicenceFailure(LicenceError.REFUSED, {
        errorCode: 'NO_COPIES_AVAILABLE',
        target: 'item_42',
      }),
    );
    const hold = {
      holdId: 'hold_1',
      itemId: 'item_42',
      state: 'queued' as const,
      position: 3,
      queueLength: 7,
      serverTime: new Date().toISOString(),
    };
    mockPlaceHold.mockResolvedValue(hold);
    // First call on mount returns empty → Grant access shown.
    // Second call after placeHold returns hold → no actions (queued state).
    mockGetLibrary
      .mockResolvedValueOnce({ loans: [], holds: [] })
      .mockResolvedValue({ loans: [], holds: [hold] });
    setCatalogueSource(
      fakeSource(async () => aBook({ acquisition: anAcquisition({ licenceModel: 'ELITE' }) })),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Grant access')).toBeTruthy());
    fireEvent.press(screen.getByText('Grant access'));

    await waitFor(() => expect(mockPlaceHold).toHaveBeenCalledWith('item_42'));
  });

  it('does NOT fall through to placeHold when borrow fails for a different reason', async () => {
    selectAndSignIn(INSTITUTION);
    mockBorrow.mockRejectedValue(
      new LicenceFailure(LicenceError.NETWORK_UNAVAILABLE, { target: 'item_42' }),
    );
    // Mount refresh returns empty — Grant access shown.
    mockGetLibrary.mockResolvedValue({ loans: [], holds: [] });
    setCatalogueSource(
      fakeSource(async () => aBook({ acquisition: anAcquisition({ licenceModel: 'ELITE' }) })),
    );

    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Grant access')).toBeTruthy());
    fireEvent.press(screen.getByText('Grant access'));

    await waitFor(() => expect(mockBorrow).toHaveBeenCalledWith('item_42'));
    // A network failure must not silently enqueue the reader.
    expect(mockPlaceHold).not.toHaveBeenCalled();
  });
});
