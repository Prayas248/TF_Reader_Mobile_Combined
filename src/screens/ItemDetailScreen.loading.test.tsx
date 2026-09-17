// src/screens/ItemDetailScreen.loading.test.tsx
// Subtask 2 — ActionButton's loading state, wired at this call site.
//
// WHAT CHANGED IN THE SCREEN. Every licence call here used to be
// fire-and-forget: `source.borrow(itemId).then(refresh)` with nothing tracking
// that a call was open, so the button stayed idle for as long as flambeau took
// and Read could be tapped four times for four borrows. The screen now holds a
// `pendingAction` and hands it to `ActionBar`, whose `pending` prop was built for
// exactly this and had no caller.
//
// WHY THIS IS A SEPARATE FILE FROM ItemDetailScreen.test.tsx, and not a describe
// block appended to it. That suite has eight pre-existing failures whose tests
// leave licence promises unresolved at teardown, and an unresolved promise leaves
// an open act() scope that corrupts every render after it in the same file — the
// trap that file's own comments already document for two presses in one test.
// Tests appended there failed for that reason and passed in isolation. A separate
// file gets its own module registry and its own clean tree, and it also means
// this work touches none of the failing suite.
//
// OPEN ACCESS THROUGHOUT, deliberately. It resolves to Read + Download without a
// session, a loan or a hold, so these tests exercise the pending wiring rather
// than re-testing the Elite resolve.
//
// `await render(...)` is required — RTL 14's render is async. See App.test.tsx.
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { DataSource } from '@adapters/InstitutionSource';
import { setCatalogueSource } from '@config/catalogue';
import { buildItemDetail } from '@model/detail';
import type { Acquisition, Publication, Session } from '@model/types';
import { resolveAccess } from '@access/resolveAccess';
import { useLibraryStore } from '@store/libraryStore';

import ItemDetailScreen, {
  ARTICLE_WORK_TYPE,
  BOOK_WORK_TYPE,
  renderArticleContent,
  renderBookContent,
} from './ItemDetailScreen';

// Must be prefixed `mock` — Jest's module-factory scope guard only allows
// referencing out-of-scope variables whose name starts with "mock".
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

const mockUseNetworkStatus = jest.fn(() => true);
jest.mock('@hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => mockUseNetworkStatus(),
}));

const mockBorrow = jest.fn();
const mockGetLibrary = jest.fn();
jest.mock('@config/licence', () => ({
  // sessionStore.ts calls this at module load — the currentSession.ts import
  // chain (ItemDetailScreen → currentSession → sessionStore) now pulls
  // sessionStore in even though this file never touches it directly.
  setLicenceToken: jest.fn(),
  getLicenceSource: () => ({
    borrow: (...args: [string]) => mockBorrow(...args),
    getLibrary: () => mockGetLibrary(),
    returnLoan: jest.fn(),
    placeHold: jest.fn(),
    acceptOffer: jest.fn(),
    cancelHold: jest.fn(),
  }),
}));

// Read no longer borrows — it calls openBook() directly (see ItemDetailScreen.tsx's
// `handleAction`'s 'read' branch), bypassing runLicenceCall/mockBorrow entirely.
// Mocked at that boundary so these tests exercise the screen's own pending wiring
// without pulling openBook's real network/decrypt stack into a render test.
const mockOpenBook = jest.fn();
jest.mock('@/features/download/openBook', () => ({
  openBook: (...args: [string, string]) => mockOpenBook(...args),
}));

const LOAN = { loanId: 'loan_1', itemId: 'item_42', state: 'active' as const, expiresAt: 9_999 };

function anAcquisition(over: Partial<Acquisition> = {}): Acquisition {
  return {
    actionId: 'openAccess',
    href: 'https://flambeau.test/api/v1/loans',
    licenceModel: 'OPEN_ACCESS',
    encryption: null,
    hasSearchIndex: false,
    canPersist: true,
    ...over,
  };
}

function anOpenAccessBook(over: Partial<Publication> = {}): Publication {
  return {
    id: 'item_42',
    title: 'Rights for Robots',
    authors: ['Joshua C. Gellers'],
    publisher: 'Routledge',
    subjects: [],
    format: 'PDF',
    acquisition: anAcquisition(),
    ...over,
  } as Publication;
}

function fakeSource(getPublication: () => Promise<Publication>): DataSource {
  const unused = () => Promise.reject(new Error('not stubbed for this test'));
  return {
    getHomeCatalogue: unused,
    getShelf: unused,
    getPublication,
    getPublicPublication: getPublication,
    getPublicFeed: unused,
    getInstitutions: unused,
    getInstitution: unused,
    getItemsBatch: unused,
  } as unknown as DataSource;
}

/** An open-access article detail, for the "no queue" control cases. */
function anArticleDetailOpenAccess() {
  const publication = anOpenAccessBook();
  const access = resolveAccess({ item: publication, institutionId: 'inst_7f3', session: null });
  return buildItemDetail({ publication, workType: ARTICLE_WORK_TYPE, access });
}

const routeProps = {
  route: { params: { itemId: 'item_42' } },
  // `setOptions`/`getParent` satisfy the screen's own header-title and
  // tab-bar-hiding effects (see ItemDetailRouteProps's own comment) — no
  // test in this file asserts on either, so plain no-op mocks are enough.
  navigation: {
    navigate: mockNavigate,
    setOptions: jest.fn(),
    getParent: () => ({ setOptions: jest.fn() }),
  },
} as unknown as Parameters<typeof ItemDetailScreen>[0];

beforeEach(() => {
  mockBorrow.mockResolvedValue(LOAN);
  mockGetLibrary.mockResolvedValue({ loans: [], holds: [] });
  mockOpenBook.mockResolvedValue(new Uint8Array());
  setCatalogueSource(fakeSource(async () => anOpenAccessBook()));
});

afterEach(() => {
  setCatalogueSource(undefined);
  jest.clearAllMocks();
  mockUseNetworkStatus.mockReturnValue(true);
  useLibraryStore.setState({ loans: [], holds: [], loading: false });
});

describe('ItemDetailScreen — the bar before anything is tapped', () => {
  it('renders Read idle, with no spinner', async () => {
    await render(<ItemDetailScreen {...routeProps} />);

    await waitFor(() => expect(screen.getByText('Read')).toBeTruthy());
    expect(screen.getByTestId('action-button-read').props.accessibilityState).toEqual({
      disabled: false,
      busy: false,
    });
    expect(screen.queryByTestId('action-button-spinner')).toBeNull();
  });
});

describe('ItemDetailScreen — the licence call still happens', () => {
  // The pending wiring must not have changed WHAT the tap does. Read itself no
  // longer borrows — it calls openBook() directly (see ItemDetailScreen.tsx's
  // 'read' branch) — so this pins that call instead of the old borrow one.
  it('opens the book when Read is tapped', async () => {
    await render(<ItemDetailScreen {...routeProps} />);
    await waitFor(() => expect(screen.getByText('Read')).toBeTruthy());

    fireEvent.press(screen.getByTestId('action-button-read'));

    await waitFor(() => expect(mockOpenBook).toHaveBeenCalledWith('item_42', 'PDF'));
  });

  it('invalidates the holdings cache afterwards', async () => {
    await render(<ItemDetailScreen {...routeProps} />);
    await waitFor(() => expect(screen.getByText('Read')).toBeTruthy());

    fireEvent.press(screen.getByTestId('action-button-read'));

    await waitFor(() => expect(mockGetLibrary).toHaveBeenCalled());
  });
});

describe('ItemDetailScreen — the bar settles again', () => {
  it('returns Read to idle after the call succeeds', async () => {
    await render(<ItemDetailScreen {...routeProps} />);
    await waitFor(() => expect(screen.getByText('Read')).toBeTruthy());

    fireEvent.press(screen.getByTestId('action-button-read'));
    await waitFor(() => expect(mockGetLibrary).toHaveBeenCalled());

    await waitFor(() =>
      expect(screen.getByTestId('action-button-read').props.accessibilityState).toEqual({
        disabled: false,
        busy: false,
      }),
    );
    expect(screen.queryByTestId('action-button-spinner')).toBeNull();
  });

  // A stuck spinner is the worst outcome of a failed call, so failure gets its
  // own test rather than riding on the success path.
  it('returns Read to idle after the call fails', async () => {
    mockBorrow.mockRejectedValue(new Error('boom'));

    await render(<ItemDetailScreen {...routeProps} />);
    await waitFor(() => expect(screen.getByText('Read')).toBeTruthy());

    fireEvent.press(screen.getByTestId('action-button-read'));
    // The cache is invalidated on failure too: a borrow that threw may still
    // have created the loan.
    await waitFor(() => expect(mockGetLibrary).toHaveBeenCalled());

    await waitFor(() =>
      expect(screen.getByTestId('action-button-read').props.accessibilityState).toEqual({
        disabled: false,
        busy: false,
      }),
    );
  });
});

// The two presentations share one ActionBar, so `pending` has to reach both.
// Rendered directly from a hand-built detail, the way every other article test
// in this repo does — no fetch, so no promise to leave open.
describe('ItemDetailScreen — pending reaches both presentations', () => {
  function anArticleDetail() {
    const publication = anOpenAccessBook();
    const access = resolveAccess({
      item: publication,
      institutionId: 'inst_7f3',
      session: null,
    });
    return buildItemDetail({ publication, workType: ARTICLE_WORK_TYPE, access });
  }

  it('spins the pending action in the article presentation', async () => {
    await render(renderArticleContent(anArticleDetail(), jest.fn(), 'read'));

    expect(screen.getByTestId('action-button-spinner')).toBeTruthy();
    expect(screen.getByTestId('action-button-read').props.accessibilityState).toEqual({
      disabled: true,
      busy: true,
    });
  });

  it('leaves the other buttons in the bar alone', async () => {
    await render(renderArticleContent(anArticleDetail(), jest.fn(), 'read'));

    // Download is a sibling of the pending Read and must not spin as well —
    // ActionBar marks one action pending, not the bar.
    expect(screen.getByTestId('action-button-download').props.accessibilityState).toEqual({
      disabled: false,
      busy: false,
    });
  });

  it('spins nothing when no action is pending', async () => {
    await render(renderArticleContent(anArticleDetail(), jest.fn()));

    expect(screen.queryByTestId('action-button-spinner')).toBeNull();
  });
});

// ── D8 — not entitled renders nothing at all ─────────────────────────────────
//
// A publication with no acquisition link. Rendered through the presentation
// function directly, so there is no fetch and no promise left open.
describe('ItemDetailScreen — D8 not entitled', () => {
  function notEntitledDetail() {
    const publication = { id: 'item_orphan', title: 'Metadata Only', authors: [] } as never;
    const access = resolveAccess({
      item: publication,
      institutionId: 'inst_7f3',
      session: null,
    });
    return buildItemDetail({ publication, workType: ARTICLE_WORK_TYPE, access });
  }

  it('renders the title, because the metadata is real', async () => {
    await render(renderArticleContent(notEntitledDetail(), jest.fn()));

    expect(screen.getByText('Metadata Only')).toBeTruthy();
  });

  // The half that needed fixing: `tier` is required, so this state carries an
  // OPEN_ACCESS filler that must never reach the screen.
  it('draws no access badge, not even the OPEN_ACCESS placeholder', async () => {
    await render(renderArticleContent(notEntitledDetail(), jest.fn()));

    expect(screen.queryByText('Open Access')).toBeNull();
  });

  it('draws no action bar and nothing tappable', async () => {
    await render(renderArticleContent(notEntitledDetail(), jest.fn()));

    expect(screen.queryByTestId('action-bar')).toBeNull();
    for (const label of ['Read', 'Download', 'Request access', 'Sign in', 'Subscribe']) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  // BOTH PRESENTATIONS, because D8 is a rule about the screen and the screen has
  // two of them. The book layout carries extra furniture the article one does not
  // — the price tag, the table-of-contents row — and none of it may become
  // tappable just because there is no access.
  it('renders the book presentation with no badge and nothing tappable either', async () => {
    const publication = { id: 'item_orphan', title: 'Metadata Only', authors: [] } as never;
    const access = resolveAccess({
      item: publication,
      institutionId: 'inst_7f3',
      session: null,
    });
    const detail = buildItemDetail({ publication, workType: BOOK_WORK_TYPE, access });

    await render(renderBookContent(detail, jest.fn()));

    expect(screen.getByText('Metadata Only')).toBeTruthy();
    expect(screen.queryByText('Open Access')).toBeNull();
    expect(screen.queryByTestId('action-bar')).toBeNull();
    for (const label of ['Read', 'Download', 'Request access', 'Sign in', 'Subscribe']) {
      expect(screen.queryByText(label)).toBeNull();
    }
    // The muted mockup elements stay non-interactive rather than becoming the
    // "request access" affordance index.html rules out.
    expect(screen.queryByRole('button', { name: /table of contents/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /price/i })).toBeNull();
  });
});

// resolveAccess reads nothing off a Session but whether it is null (see that
// file's own note), so this fixture's field values don't matter — only its
// presence, standing in for a signed-in reader in the two hand-built
// resolveAccess calls below.
const SIGNED_IN_SESSION: Session = {
  userId: 'test-user:inst_7f3',
  institutionId: 'inst_7f3',
  roles: [],
  collections: [],
  exp: 0,
};

// ── D12 — the queued state on the detail screen ───────────────────────────────
//
// "Queued shows a position and nothing tappable." resolveAccess returns no
// actions when queued, so ActionBar draws nothing and the position line is the
// entire UI for this state — without it a waiting reader gets a detail screen
// that answers nothing.
describe('ItemDetailScreen — D12 queued', () => {
  function queuedDetail() {
    const publication = {
      id: 'item_42',
      title: 'An Elite Title',
      authors: [],
      acquisition: anAcquisition({ licenceModel: 'ELITE' }),
    } as never;
    const access = resolveAccess({
      item: publication,
      institutionId: 'inst_7f3',
      session: SIGNED_IN_SESSION,
      hold: {
        holdId: 'hold_1',
        itemId: 'item_42',
        state: 'queued',
        position: 3,
        queueLength: 7,
        serverTime: '2026-08-26T09:00:00Z',
      } as never,
    });
    return buildItemDetail({ publication, workType: ARTICLE_WORK_TYPE, access });
  }

  it('shows the reader their position', async () => {
    await render(renderArticleContent(queuedDetail(), jest.fn()));

    expect(screen.getByTestId('queue-position')).toBeTruthy();
    expect(screen.getByText('Position 3 of 7 in queue')).toBeTruthy();
  });

  it('shows nothing tappable alongside it', async () => {
    await render(renderArticleContent(queuedDetail(), jest.fn()));

    expect(screen.queryByText('Request access')).toBeNull();
    expect(screen.queryByText('Accept')).toBeNull();
    expect(screen.queryByTestId('action-bar')).toBeNull();
  });

  it('announces the position as text, not as a control', async () => {
    await render(renderArticleContent(queuedDetail(), jest.fn()));

    expect(screen.getByTestId('queue-position').props.accessibilityRole).toBe('text');
  });

  it('shows no position line when the reader is not queued', async () => {
    const detail = anArticleDetailOpenAccess();
    await render(renderArticleContent(detail, jest.fn()));

    expect(screen.queryByTestId('queue-position')).toBeNull();
  });
});

// ── D12 — the other two states on the detail screen ───────────────────────────
//
// Completes the matrix here rather than leaving it half-asserted: the card
// surfaces have all three, and the detail screen is a required surface too.
describe('ItemDetailScreen — D12 grant and offered', () => {
  function eliteDetail(hold?: unknown) {
    const publication = {
      id: 'item_42',
      title: 'An Elite Title',
      authors: [],
      acquisition: anAcquisition({ licenceModel: 'ELITE' }),
    } as never;
    const access = resolveAccess({
      item: publication,
      institutionId: 'inst_7f3',
      session: SIGNED_IN_SESSION,
      hold: hold as never,
    });
    return buildItemDetail({ publication, workType: ARTICLE_WORK_TYPE, access });
  }

  it('offers Request access when nothing is held', async () => {
    await render(renderArticleContent(eliteDetail(), jest.fn()));

    expect(screen.getByText('Request access')).toBeTruthy();
    expect(screen.queryByTestId('queue-position')).toBeNull();
  });

  it('offers Accept and Reject when a copy is offered, and no position line', async () => {
    const detail = eliteDetail({
      holdId: 'hold_1',
      itemId: 'item_42',
      state: 'offered',
      offerExpiresAt: '2099-01-01T00:00:00Z',
      serverTime: '2026-08-26T09:00:00Z',
    });

    await render(renderArticleContent(detail, jest.fn()));

    expect(screen.getByText('Accept')).toBeTruthy();
    expect(screen.getByText('Reject')).toBeTruthy();
    // A reader with an offer is no longer waiting, so no position.
    expect(screen.queryByTestId('queue-position')).toBeNull();
    expect(screen.queryByText('Request access')).toBeNull();
  });

  // No duplicates: the bar and the position line are mutually exclusive by
  // construction, because resolveAccess returns no actions when queued.
  it('never renders both a queue button and a position line', async () => {
    const queued = eliteDetail({
      holdId: 'hold_1',
      itemId: 'item_42',
      state: 'queued',
      position: 2,
      queueLength: 4,
      serverTime: '2026-08-26T09:00:00Z',
    });

    await render(renderArticleContent(queued, jest.fn()));

    expect(screen.getByTestId('queue-position')).toBeTruthy();
    expect(screen.queryByTestId('action-bar')).toBeNull();
  });
});

// LAST IN THE FILE, DELIBERATELY. This is the only test that holds the call
// open — the only way to render the busy state — and an unresolved promise at
// teardown is what corrupts a following render. Nothing follows it.
describe('ItemDetailScreen — busy while the call is in flight', () => {
  it('shows Read busy and inert, and takes only one openBook call', async () => {
    mockOpenBook.mockReturnValue(new Promise(() => {}));

    await render(<ItemDetailScreen {...routeProps} />);
    await waitFor(() => expect(screen.getByText('Read')).toBeTruthy());

    fireEvent.press(screen.getByTestId('action-button-read'));

    await waitFor(() => expect(screen.getByTestId('action-button-spinner')).toBeTruthy());
    // `disabled: true` IS the duplicate-press guard: ActionButton withholds its
    // onPress AND disables the Pressable at `state="loading"` (see its `inert`),
    // so a second tap cannot reach the handler at all.
    expect(screen.getByTestId('action-button-read').props.accessibilityState).toEqual({
      disabled: true,
      busy: true,
    });

    fireEvent.press(screen.getByTestId('action-button-read'));
    fireEvent.press(screen.getByTestId('action-button-read'));

    expect(mockOpenBook).toHaveBeenCalledTimes(1);
  });
});
