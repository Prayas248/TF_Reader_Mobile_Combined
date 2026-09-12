// src/screens/CatalogueScreen.test.tsx
// Wires the hero banner and ContentCard (one section per home-catalogue
// shelf) to the real DataSource seam. `catalogue.navigation` no longer
// renders its own strip of cards (see CatalogueScreen.tsx's header comment) —
// only its first entry is read, for the hero's own CTA.
//
// Injects a fake DataSource through `setCatalogueSource` — the test seam
// `src/config/catalogue.ts` was built with for exactly this — rather than
// hitting MockAdapter's fixtures, so these tests pin the screen's own wiring
// (loading → data → error → retry, and the press → navigate contract)
// independently of what the fixtures happen to contain.
//
// `await render(...)` is required — RTL 14's render is async. See
// ContentCard.test.tsx for why forgetting it fails silently.
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { DataSource } from '@adapters/InstitutionSource';
import { setCatalogueSource } from '@config/catalogue';
import { forgetFeedOffsets, rememberedFeedOffset } from '@hooks/useFeedScrollMemory';
import type { Institution } from '@model/institution';
import type { Catalogue } from '@model/types';
import homeCatalogueFixture from '@model/fixtures/OPDS-samples/01-home-catalogue.json';

import { normalizeCatalogue } from '@/model/opds/normalize';
import { useLibraryStore } from '@store/libraryStore';
import { useSessionStore } from '@store/sessionStore';
import CatalogueScreen from './CatalogueScreen';

// Controls what the licence source returns for the holdings cache.
// Defaults to empty so existing tests are unaffected.
const mockGetLibrary = jest.fn().mockResolvedValue({ loans: [], holds: [] });
// D12 — pressing a queue affordance makes a real call through this same seam.
const mockBorrow = jest.fn();
const mockPlaceHold = jest.fn();
const mockAcceptOffer = jest.fn();
const mockCancelHold = jest.fn();
jest.mock('@config/licence', () => ({
  // sessionStore.ts calls this at module load — the currentSession.ts import
  // chain (CatalogueScreen → currentSession → sessionStore) now pulls
  // sessionStore in even though this file never touches it directly.
  setLicenceToken: jest.fn(),
  getLicenceSource: () => ({
    getLibrary: () => mockGetLibrary(),
    borrow: (...args: [string]) => mockBorrow(...args),
    placeHold: (...args: [string]) => mockPlaceHold(...args),
    acceptOffer: (...args: [string]) => mockAcceptOffer(...args),
    cancelHold: (...args: [string]) => mockCancelHold(...args),
  }),
}));

// Must be prefixed `mock` — Jest's module-factory scope guard only allows
// referencing out-of-scope variables whose name starts with "mock".
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

// `useNetworkStatus` talks to NetInfo, which has no meaningful answer under
// Jest. Mocked per-test so the offline case can be driven directly — same
// pattern as ItemDetailScreen.test.tsx.
const mockUseNetworkStatus = jest.fn(() => true);
jest.mock('@hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => mockUseNetworkStatus(),
}));

const FAKE_CATALOGUE: Catalogue = {
  title: 'Test Institution',
  navigation: [
    { title: 'eBooks', href: 'https://x/groups/ebooks', shelfId: 'ebooks', target: 'shelf' },
    { title: 'Audiobooks', href: 'https://x/groups/audiobooks', shelfId: 'audiobooks', target: 'shelf' },
  ],
  shelves: [
    {
      id: 'new-this-term',
      title: 'New this term',
      publications: [
        {
          id: 'item_42',
          title: 'Rights for Robots',
          publisher: 'Routledge',
          authors: ['Joshua C. Gellers'],
          subjects: [],
          format: 'PDF',
          acquisition: {
            actionId: 'borrow',
            href: 'https://x/loan/item_42',
            licenceModel: 'SUBSCRIPTION',
            encryption: null,
            hasSearchIndex: true,
            canPersist: true,
          },
        },
      ],
    },
    {
      id: 'open-access',
      title: 'Free to read',
      publications: [
        {
          id: 'item_ab6',
          title: 'Ethnographies of Waiting',
          authors: [],
          subjects: [],
          format: 'EPUB',
          acquisition: {
            actionId: 'openAccess',
            href: 'https://x/download/item_ab6',
            licenceModel: 'OPEN_ACCESS',
            encryption: null,
            hasSearchIndex: false,
            canPersist: true,
          },
        },
      ],
    },
  ],
};

// Every method a real DataSource must have, so the fake typechecks as one.
// Only `getHomeCatalogue` is exercised — the rest throw if the screen ever
// reaches for them, which would mean it grew a dependency this suite does not
// know to fake.
function fakeSource(getHomeCatalogue: DataSource['getHomeCatalogue']): DataSource {
  const unused = () => Promise.reject(new Error('not stubbed for this test'));
  return {
    getHomeCatalogue,
    getShelf: unused,
    getPublication: unused,
    getPublicFeed: unused,
    getPublicPublication: unused,
    getInstitutions: unused,
    getInstitution: unused,
    getItemsBatch: unused,
    getWork: unused,
  };
}

// Deliberately NOT inst_7f3, the id this screen used to fall back to: a test
// that used the old default could not tell "read the prop" from "ignored it".
const OTHER_INSTITUTION: Institution = {
  id: 'inst_a21',
  name: 'Second Institution',
  country: 'GB',
  code: 'SEC',
  city: 'Leeds',
  catalogueUrl: 'https://api.tf/opds/v1/institutions/inst_a21/catalogue',
};

afterEach(() => {
  setCatalogueSource(undefined);
  mockNavigate.mockClear();
  mockUseNetworkStatus.mockReturnValue(true);
  mockGetLibrary.mockClear();
  mockGetLibrary.mockResolvedValue({ loans: [], holds: [] });
  useLibraryStore.setState({ loans: [], holds: [], loading: false });
  useSessionStore.getState().clearSession();
  // Module state, so it would otherwise carry into the next test.
  forgetFeedOffsets();
});

// A7 — the screen's half of the contract: the offset is recorded against THIS
// institution, so signing out and back in returns the reader where they were
// and a different institution starts fresh. The restoring itself is
// useFeedScrollMemory.test.tsx's job; this pins the wiring and the key.
describe('CatalogueScreen scroll position', () => {
  it('records the reader’s place under its own institution’s key', async () => {
    setCatalogueSource(fakeSource(async () => FAKE_CATALOGUE));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    await fireEvent.scroll(screen.getByTestId('catalogue-feed'), {
      nativeEvent: { contentOffset: { y: 512 }, contentSize: { height: 3000, width: 400 } },
    });

    expect(rememberedFeedOffset(OTHER_INSTITUTION.id)).toBe(512);
  });
});

// CatalogueScreen is only ever rendered for a reader who HAS an institution —
// CatalogueHomeScreen sends everyone else to the public feed. So the institution
// arrives as a prop and there is no fallback id here any more: a screen that
// defaulted to one would silently serve the wrong catalogue to an anonymous
// reader, which is the bug A1 exists to fix.
describe('CatalogueScreen institution', () => {
  it('fetches the catalogue for the institution it was given', async () => {
    const asked: string[] = [];
    setCatalogueSource(
      fakeSource(async (institutionId) => {
        asked.push(institutionId);
        return FAKE_CATALOGUE;
      }),
    );

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    expect(asked).toEqual([OTHER_INSTITUTION.id]);
  });

  // The institution is no longer named inside this screen's own body — it
  // moved into the persistent header (`AppHeader`'s institution pill,
  // RootNavigator.tsx), so the reader sees it above the tab bar on every
  // screen rather than repeated as a full-width row under the hero banner.
  // Pinned in RootNavigator.test.tsx, where that pill actually renders.
});

describe('CatalogueScreen loading', () => {
  it('shows skeletons before the catalogue arrives', async () => {
    // Never resolves within the test, so the screen is caught mid-load.
    setCatalogueSource(fakeSource(() => new Promise(() => {})));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    expect(screen.getByTestId('hero-banner-skeleton')).toBeTruthy();
    expect(screen.getAllByTestId('content-card-skeleton').length).toBeGreaterThan(0);
  });
});

describe('CatalogueScreen with data', () => {
  // The mockup's "Recently published" blocks are the home-catalogue's own
  // shelves, shown under their own heading — not filtered by which category card
  // was tapped. A shelf is not a filter (AGENTS.md L-5, settled 16 Aug 2026), so
  // there is no selection to build here; tapping a card opens that shelf.
  it('renders one section per shelf, each with its own publications', async () => {
    setCatalogueSource(fakeSource(async () => FAKE_CATALOGUE));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('New this term')).toBeTruthy());
    // Headings and rows together, in tree order, so the GROUPING is asserted and
    // not just the presence of four strings. Four separate getByText calls pass
    // even if every publication rendered under the first heading — which is the
    // one thing "each with its own publications" is actually claiming.
    const rendered = screen
      .getAllByTestId(/^(section-header-title|content-card-title)$/)
      .map((node) => node.props.children);

    expect(rendered).toEqual([
      'New this term',
      'Rights for Robots',
      'Free to read',
      'Ethnographies of Waiting',
    ]);
  });

  // The same claim with a shelf that holds more than one title, because a
  // one-publication-per-shelf fixture cannot tell "grouped correctly" from
  // "flattened and happened to line up".
  it('keeps each shelf’s publications under that shelf’s own heading', async () => {
    const twoThenOne: Catalogue = {
      ...FAKE_CATALOGUE,
      shelves: [
        {
          id: 'shelf_1',
          title: 'New this month',
          publications: [
            { ...FAKE_CATALOGUE.shelves[0].publications[0], id: 'item_1', title: 'First' },
            { ...FAKE_CATALOGUE.shelves[0].publications[0], id: 'item_2', title: 'Second' },
          ],
        },
        {
          id: 'shelf_2',
          title: 'Audio picks',
          publications: [
            { ...FAKE_CATALOGUE.shelves[0].publications[0], id: 'item_3', title: 'Third' },
          ],
        },
      ],
    };
    setCatalogueSource(fakeSource(async () => twoThenOne));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('First')).toBeTruthy());
    const rendered = screen
      .getAllByTestId(/^(section-header-title|content-card-title)$/)
      .map((node) => node.props.children);

    expect(rendered).toEqual([
      'New this month',
      'First',
      'Second',
      'Audio picks',
      'Third',
    ]);
  });

  // The Shelf route exists in the navigator, so the hero's own CTA sends the
  // user to the feed's first navigation entry — see ShelfScreen.test.tsx for
  // its own screen tests. `title` travels with the id so the pushed screen's
  // app bar can name the shelf before its feed has loaded.
  it('navigates to the Shelf route with the first navigation entry when the hero action is pressed', async () => {
    setCatalogueSource(fakeSource(async () => FAKE_CATALOGUE));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('Explore All Titles')).toBeTruthy());
    fireEvent.press(screen.getByText('Explore All Titles'));

    // The institution goes with it: ShelfScreen fetches the listing itself and
    // must fetch it for the institution whose catalogue named this shelf.
    expect(mockNavigate).toHaveBeenCalledWith('Shelf', {
      shelfId: 'ebooks',
      title: 'eBooks',
      institutionId: 'inst_a21',
    });
  });

  it('navigates to ItemDetail with the publication id when a row is pressed', async () => {
    setCatalogueSource(fakeSource(async () => FAKE_CATALOGUE));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    fireEvent.press(screen.getByRole('button', { name: 'Rights for Robots' }));

    expect(mockNavigate).toHaveBeenCalledWith('ItemDetail', { itemId: 'item_42' });
  });
});

describe('CatalogueScreen hero banner', () => {
  // Static editorial copy, matched against a reference design — see
  // CatalogueScreen.tsx's own HERO_* constants. None of this is derived from
  // the feed; only the action's destination is.
  it('shows the static stat, headline, subtitle and updated note once the catalogue loads', async () => {
    setCatalogueSource(fakeSource(async () => FAKE_CATALOGUE));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByTestId('hero-banner-title')).toBeTruthy());
    expect(screen.getByText('Over 140,000 peer-reviewed titles')).toBeTruthy();
    expect(screen.getByTestId('hero-banner-title').props.children).toBe('The Scholarly Archive');
    expect(
      screen.getByText(
        'Full-text access to world-leading research monographs, handbooks, and journal volumes.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Updated daily')).toBeTruthy();
  });

  // Position, never a name — `heroNavEntry` reads `navigation[0]`, the same
  // rule `isFeatured` follows for the carousel shelf.
  it('labels the action after the first navigation entry, real or not', async () => {
    setCatalogueSource(fakeSource(async () => FAKE_CATALOGUE));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('Explore All Titles')).toBeTruthy());
  });

  // No navigation entries is not reachable from a real feed (the contract
  // requires at least one), but the hero must not draw half an action if it
  // ever happens — both-or-neither, same rule HeroBanner's own action slot
  // follows.
  it('shows no action when the catalogue has no navigation entries', async () => {
    const noNavigation: Catalogue = { ...FAKE_CATALOGUE, navigation: [] };
    setCatalogueSource(fakeSource(async () => noNavigation));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByTestId('hero-banner-title')).toBeTruthy());
    expect(screen.queryByText('Explore All Titles')).toBeNull();
  });

  it('shows a skeleton, not the headline, before the catalogue loads', async () => {
    setCatalogueSource(fakeSource(() => new Promise(() => {})));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    expect(screen.queryByText('The Scholarly Archive')).toBeNull();
    expect(screen.getByTestId('hero-banner-skeleton')).toBeTruthy();
  });
});

// Position, not name: the feed's first shelf becomes a carousel of cover
// tiles, every other shelf keeps the existing row list. FAKE_CATALOGUE's
// first shelf ('New this term') exercises the carousel branch, its second
// ('Free to read') exercises the unchanged branch.
describe('CatalogueScreen first-shelf carousel', () => {
  it('renders the first shelf as cover tiles with no chevron, later shelves as rows with one', async () => {
    setCatalogueSource(fakeSource(async () => FAKE_CATALOGUE));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());

    // Both rows are still buttons that still navigate — only the tile shape
    // changes. See the 'navigates to ItemDetail' test above for the press.
    expect(screen.getByRole('button', { name: 'Rights for Robots' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ethnographies of Waiting' })).toBeTruthy();

    // Exactly one chevron: the second shelf's row, not the first shelf's tile.
    expect(screen.getAllByTestId('content-card-chevron')).toHaveLength(1);
  });

  it('still resolves and renders a badge for the carousel item, same as a row', async () => {
    setCatalogueSource(fakeSource(async () => FAKE_CATALOGUE));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    // FAKE_CATALOGUE's first item is a SUBSCRIPTION title.
    expect(screen.getByText('Subscription')).toBeTruthy();
  });
});

// A3 — every row carries its access tier. The label is asserted, not just the
// slot: a screen that filled the slot with the wrong publication's tier would
// still pass a count-only check.
describe('CatalogueScreen access-tier badges', () => {
  it('gives every publication row a badge', async () => {
    setCatalogueSource(fakeSource(async () => FAKE_CATALOGUE));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    // Two shelves, one publication each.
    expect(screen.getAllByTestId('content-card-badge')).toHaveLength(2);
  });

  // A3 lists four things on a card: title, publisher, file format, badge.
  // The format is read off the publication the feed sent, never guessed from
  // the id or the tier — the two fixture shelves deliberately carry different
  // ones. `new-this-term` is the feed's first shelf, so it renders as the
  // cover-tile carousel; the carousel's `MetaRow` shows the format chip the
  // same way a row does, so both fixture items appear, in feed order.
  it('gives every card its own file format', async () => {
    setCatalogueSource(fakeSource(async () => FAKE_CATALOGUE));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    const formats = screen
      .getAllByTestId('content-card-format')
      .map((node) => node.props.children);

    expect(formats).toEqual(['PDF', 'EPUB']);
  });

  it('labels a subscription title and an open access title differently', async () => {
    setCatalogueSource(fakeSource(async () => FAKE_CATALOGUE));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('Subscription')).toBeTruthy());
    expect(screen.getByText('Open Access')).toBeTruthy();
  });
});

// A row's own foot: a real page count (never an invented edition number).
// Rows do NOT get an inline "Read" action any more — an early pass drew one
// wherever `resolveAccess` put `read` first, and it read as a stray button
// scattered across the shelf rather than a real affordance; opening the
// title (the row's own `onPress`, still intact) is how the shelf reaches
// ItemDetailScreen, which is where a real action belongs.
describe('CatalogueScreen row meta and action', () => {
  it('shows the real page count on a row that has one, and none on one that does not', async () => {
    const withPages: Catalogue = {
      ...FAKE_CATALOGUE,
      shelves: [
        FAKE_CATALOGUE.shelves[0],
        {
          ...FAKE_CATALOGUE.shelves[1],
          publications: [
            { ...FAKE_CATALOGUE.shelves[1].publications[0], numberOfPages: 312 },
          ],
        },
      ],
    };
    setCatalogueSource(fakeSource(async () => withPages));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('Ethnographies of Waiting')).toBeTruthy());
    expect(screen.getByText('312 pp.')).toBeTruthy();
    // The carousel's own item (Rights for Robots) has no `numberOfPages` in
    // the fixture and, being featured, gets no meta line regardless — only
    // one `content-card-meta` should exist, not two.
    expect(screen.getAllByTestId('content-card-meta')).toHaveLength(1);
  });

  it('renders no meta line when the publication has no page count', async () => {
    setCatalogueSource(fakeSource(async () => FAKE_CATALOGUE));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('Ethnographies of Waiting')).toBeTruthy());
    expect(screen.queryByTestId('content-card-meta')).toBeNull();
  });

  // `item_ab6` (Ethnographies of Waiting) is OPEN_ACCESS, which resolveAccess
  // always puts `read` first for — the one case that used to draw an inline
  // action. Pressing the row itself still opens ItemDetailScreen either way.
  it('opens ItemDetailScreen when a row is pressed, with no inline action drawn', async () => {
    setCatalogueSource(fakeSource(async () => FAKE_CATALOGUE));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('Ethnographies of Waiting')).toBeTruthy());
    expect(screen.queryByTestId('content-card-action')).toBeNull();
    expect(screen.queryByText('Read')).toBeNull();

    fireEvent.press(screen.getByText('Ethnographies of Waiting'));

    expect(mockNavigate).toHaveBeenCalledWith('ItemDetail', { itemId: 'item_ab6' });
  });

  // The carousel item (Rights for Robots, SUBSCRIPTION, signed out) never got
  // an action either, back when rows could — confirms the carousel's own
  // absence of one is unchanged now that no row draws one.
  it('renders no action on the carousel item', async () => {
    setCatalogueSource(fakeSource(async () => FAKE_CATALOGUE));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('Ethnographies of Waiting')).toBeTruthy());
    expect(screen.queryAllByTestId('content-card-action')).toHaveLength(0);
  });
});

describe('CatalogueScreen error', () => {
  it('shows a retry affordance when the catalogue fails to load, and retrying re-fetches', async () => {
    let attempt = 0;
    setCatalogueSource(
      fakeSource(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('network down');
        return FAKE_CATALOGUE;
      }),
    );

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText(/couldn.?t load/i)).toBeTruthy());

    fireEvent.press(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    expect(attempt).toBe(2);
  });

  // getHomeCatalogue now requires a signed-in reader (appToken). CatalogueScreen
  // mounts off institution selection alone, ahead of sign-in — so the reader can
  // land here, fail once while signed out, then sign in from the sheet stacked
  // on top without this screen ever unmounting. The fetch effect used to depend
  // only on institutionId, so that sign-in never re-triggered it — the reader
  // was stuck on the stale failure until they pressed Retry themselves.
  it('re-fetches on its own once the reader signs in, without a manual retry', async () => {
    let attempt = 0;
    setCatalogueSource(
      fakeSource(async () => {
        attempt += 1;
        if (!useSessionStore.getState().isAuthenticated) throw new Error('401');
        return FAKE_CATALOGUE;
      }),
    );

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);
    await waitFor(() => expect(screen.getByText(/couldn.?t load/i)).toBeTruthy());

    // Sign-in completing elsewhere (SignInScreen's beginSamlSignIn) while this
    // screen stays mounted underneath the sign-in sheet — no press, no remount.
    useSessionStore.getState().setSession({
      accessToken: 'tok_abc123',
      expiresIn: 900,
      userId: 'user_1',
      institutionId: OTHER_INSTITUTION.id,
      roles: [],
      collections: [],
    });

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    expect(attempt).toBe(2);
  });

  // A prior institution's failure must not survive a switch to one that works —
  // the screen is reused rather than remounted when the reader picks a
  // different institution, so a leftover `failed`/`errorCode` from before would
  // otherwise mask a perfectly good catalogue underneath.
  it('clears a stale failure when switching to an institution whose fetch succeeds', async () => {
    const WORKING_INSTITUTION: Institution = {
      id: 'inst_working',
      name: 'Working Institution',
      country: 'GB',
      code: 'WRK',
      city: 'Bristol',
    };

    setCatalogueSource(
      fakeSource(async (institutionId) => {
        if (institutionId === OTHER_INSTITUTION.id) throw new Error('unknown institution');
        return FAKE_CATALOGUE;
      }),
    );

    const { rerender } = await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);
    await waitFor(() => expect(screen.getByText(/couldn.?t load/i)).toBeTruthy());

    rerender(<CatalogueScreen institution={WORKING_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    expect(screen.queryByText(/couldn.?t load/i)).toBeNull();
  });
});

// The real fixture, end to end — the range of navigation counts (none, one,
// many) that used to be proven against the category strip's own rendering is
// now moot: `catalogue.navigation` only ever feeds the hero's action label
// (`heroNavEntry`), which reads position 0 and does not care how many other
// entries exist behind it.
describe('CatalogueScreen with the real home-catalogue fixture', () => {
  it('renders the real fixture correctly', async () => {
    setCatalogueSource(fakeSource(async () => normalizeCatalogue(homeCatalogueFixture)));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    // The fixture's first navigation entry is "All titles" — the hero's own
    // action label names it.
    await waitFor(() => expect(screen.getByText('Explore All Titles')).toBeTruthy());

    // The fixture's shelves render under their own, real titles.
    expect(screen.getByText('New this month')).toBeTruthy();
    expect(screen.getByText('Criticism & theory, 1800–1899')).toBeTruthy();
  });
});

describe('CatalogueScreen renders whatever shelves arrive', () => {
  function catalogueWithShelves(titles: string[]): Catalogue {
    return {
      ...FAKE_CATALOGUE,
      shelves: titles.map((title, index) => ({
        id: `shelf${index}`,
        title,
        publications: [FAKE_CATALOGUE.shelves[0].publications[0]],
      })),
    };
  }

  it('renders exactly the shelves the feed sent, no hardcoded count', async () => {
    const titles = ['New this month', 'Criticism & theory', 'Audio picks'];
    setCatalogueSource(fakeSource(async () => catalogueWithShelves(titles)));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    for (const title of titles) {
      await waitFor(() => expect(screen.getByText(title)).toBeTruthy());
    }
  });

  // Contract caps this at 3, but the render loop has no cap of its own — this
  // just proves it wouldn't crash if that ever changed.
  it('does not crash if more than three shelves arrive', async () => {
    const titles = ['A', 'B', 'C', 'D', 'E'];
    setCatalogueSource(fakeSource(async () => catalogueWithShelves(titles)));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('E')).toBeTruthy());
  });

  // Contract fact: a shelf with nothing in it is OMITTED from the feed
  // entirely, never sent with an empty publications array. So a nav entry can
  // exist with no matching shelf — the two lists are independent, and the
  // screen must not assume they line up.
  // `navigation` and `shelves` are two independent lists — a nav entry with
  // no matching shelf (or vice versa) is a real, contract-legal case, not a
  // bug this screen should assume can't happen.
  it('renders only the shelves that exist, independently of whatever navigation carries', async () => {
    const catalogueWithGap: Catalogue = {
      ...FAKE_CATALOGUE,
      navigation: [
        { title: 'Shelf One', href: 'https://x/groups/shelf-one', shelfId: 'shelf1', target: 'shelf' },
      ],
      shelves: [
        {
          id: 'shelf1',
          // Deliberately different from the nav entry's title 'Shelf One' —
          // the two names can differ, and it keeps this text unambiguous for
          // getByText.
          title: 'One',
          publications: [FAKE_CATALOGUE.shelves[0].publications[0]],
        },
        {
          id: 'shelf3',
          title: 'Three',
          publications: [FAKE_CATALOGUE.shelves[1].publications[0]],
        },
      ],
    };

    setCatalogueSource(fakeSource(async () => catalogueWithGap));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('One')).toBeTruthy());
    expect(screen.getByText('Three')).toBeTruthy();
  });
});

describe('CatalogueScreen offline', () => {
  it('shows the offline banner over the loaded catalogue when the network is down', async () => {
    mockUseNetworkStatus.mockReturnValue(false);
    setCatalogueSource(fakeSource(async () => FAKE_CATALOGUE));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    // The banner is a notice, not a blocker — the catalogue underneath it
    // must still be there (AGENTS.md: offline is degraded, not disabled).
    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    expect(screen.getByText("You're offline")).toBeTruthy();
  });

  it('renders no offline banner while the network is up', async () => {
    setCatalogueSource(fakeSource(async () => FAKE_CATALOGUE));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    expect(screen.queryByText("You're offline")).toBeNull();
  });
});

describe('CatalogueScreen with no curated shelves', () => {
  // Zero shelves is legal (a brand-new institution) and different from zero
  // navigation entries, which the contract's own minItems: 1 rules out.
  it('renders EmptyState instead of silently showing nothing', async () => {
    const noShelves: Catalogue = { ...FAKE_CATALOGUE, shelves: [] };
    setCatalogueSource(fakeSource(async () => noShelves));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() =>
      expect(screen.getByText('Nothing to show here yet.')).toBeTruthy(),
    );
    // The hero is unaffected by an empty shelf list — it is static editorial
    // chrome, independent of what the shelves below it contain.
    expect(screen.getByTestId('hero-banner-title')).toBeTruthy();
  });
});

// F8 — list-level cache. The whole point of the library store is that forty
// cards share one GET /api/v1/library call rather than making forty. This
// verifies the screen calls getLibrary exactly once on mount, regardless of
// how many publications are in the catalogue.
describe('CatalogueScreen — list-level holdings cache', () => {
  it('calls getLibrary once on mount, not once per card', async () => {
    // Two shelves, three publications total — getLibrary must still be called once.
    const multiCardCatalogue: Catalogue = {
      ...FAKE_CATALOGUE,
      shelves: [
        {
          id: 'shelf_a',
          title: 'Shelf A',
          publications: [
            { ...FAKE_CATALOGUE.shelves[0].publications[0], id: 'item_1', title: 'Book One' },
            { ...FAKE_CATALOGUE.shelves[0].publications[0], id: 'item_2', title: 'Book Two' },
          ],
        },
        {
          id: 'shelf_b',
          title: 'Shelf B',
          publications: [
            { ...FAKE_CATALOGUE.shelves[0].publications[0], id: 'item_3', title: 'Book Three' },
          ],
        },
      ],
    };
    setCatalogueSource(fakeSource(async () => multiCardCatalogue));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('Book One')).toBeTruthy());
    expect(mockGetLibrary).toHaveBeenCalledTimes(1);
  });

  // D10 — holdings joined per item. Pre-populating the store verifies that the
  // badge resolves against the live loan rather than against empty holdings.
  it('reflects a held loan in the action tier when the library store has one', async () => {
    useLibraryStore.setState({
      loans: [{ loanId: 'loan_1', itemId: 'item_42', state: 'active', expiresAt: 9_999_999_999 }],
      holds: [],
    });
    // item_42 is ELITE in FAKE_CATALOGUE — with an active loan resolveAccess
    // resolves to 'available', which renders the ELITE tier badge regardless.
    // The important thing is the screen does not crash when a loan is present.
    setCatalogueSource(fakeSource(async () => FAKE_CATALOGUE));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('Rights for Robots')).toBeTruthy());
    // Screen rendered without error and the card is present — the holding was joined.
    expect(screen.getByText('Rights for Robots')).toBeTruthy();
  });
});

// ── D12 — the Elite queue affordance is ItemDetailScreen only ─────────────────
//
// CONFIRMED TEAM DECISION, 26 Aug. The Grant access / queue-position /
// Accept-Reject affordances live on the item detail screen and on no card
// surface, so a shelf row draws no queue button regardless of tier or holdings.
//
// TESTED AT EVERY HOLDING STATE, not just the simple one. An earlier pass put
// the affordance on this row for all three states, so "no button" has to hold
// when the reader has nothing, is queued, AND has an offer waiting — those are
// the three cases that would each have rendered something.
describe('CatalogueScreen — no Elite queue affordance', () => {
  function eliteCatalogue(id = 'item_elite'): Catalogue {
    return {
      ...FAKE_CATALOGUE,
      shelves: [
        {
          id: 'elite',
          title: 'Elite titles',
          publications: [
            {
              id,
              title: 'An Elite Title',
              publisher: 'Routledge',
              authors: [],
              subjects: [],
              format: 'EPUB',
              acquisition: {
                actionId: 'borrow',
                href: `https://x/loan/${id}`,
                licenceModel: 'ELITE',
                encryption: null,
                hasSearchIndex: false,
                canPersist: true,
              },
            },
          ],
        },
      ],
    };
  }

  it('draws no Grant access button when the reader holds nothing', async () => {
    setCatalogueSource(fakeSource(async () => eliteCatalogue()));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('An Elite Title')).toBeTruthy());
    expect(screen.queryByText('Grant access')).toBeNull();
    // No empty action wrapper either — the row should look untouched.
    expect(screen.queryByTestId('content-card-action')).toBeNull();
  });

  it('draws no queue position when the reader is queued', async () => {
    const queued = {
      loans: [],
      holds: [
        {
          holdId: 'hold_1',
          itemId: 'item_elite',
          state: 'queued' as const,
          position: 3,
          queueLength: 7,
          serverTime: '2026-08-26T09:00:00Z',
        },
      ],
    };
    useLibraryStore.setState({ ...queued, loading: false });
    mockGetLibrary.mockResolvedValue(queued);
    setCatalogueSource(fakeSource(async () => eliteCatalogue()));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('An Elite Title')).toBeTruthy());
    expect(screen.queryByText(/in queue/i)).toBeNull();
    expect(screen.queryByTestId('content-card-action')).toBeNull();
  });

  it('draws no Accept or Reject pair when a copy is offered', async () => {
    const offered = {
      loans: [],
      holds: [
        {
          holdId: 'hold_1',
          itemId: 'item_elite',
          state: 'offered' as const,
          offerExpiresAt: '2099-01-01T00:00:00Z',
          serverTime: '2026-08-26T09:00:00Z',
        },
      ],
    };
    useLibraryStore.setState({ ...offered, loading: false });
    mockGetLibrary.mockResolvedValue(offered);
    setCatalogueSource(fakeSource(async () => eliteCatalogue()));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('An Elite Title')).toBeTruthy());
    expect(screen.queryByText('Accept')).toBeNull();
    expect(screen.queryByText('Reject')).toBeNull();
    expect(screen.queryByTestId('content-card-action')).toBeNull();
  });

  // The row is still a navigation target — the detail screen is where the queue
  // lives, so getting there is the whole affordance.
  it('still navigates to the detail screen, which is where the queue lives', async () => {
    setCatalogueSource(fakeSource(async () => eliteCatalogue()));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);
    await waitFor(() => expect(screen.getByText('An Elite Title')).toBeTruthy());

    fireEvent.press(screen.getByText('An Elite Title'));

    expect(mockNavigate).toHaveBeenCalledWith('ItemDetail', { itemId: 'item_elite' });
  });
});

// ── D8 — the not-entitled state renders no buttons AND no badge ───────────────
//
// A publication with no acquisition link. `normalize.ts` rejects these at the
// adapter boundary, so a real feed cannot produce one — which is exactly why the
// fake source is handed one directly: the branch exists, `resolveAccess` has a
// test for it, and the surfaces have to honour it.
//
// THE BADGE IS THE HALF THAT NEEDED FIXING. `actions` is `[]` in this state, so
// nothing tappable was ever drawn; but `tier` is required on AccessResult and
// carries an OPEN_ACCESS filler, so a screen reading it without checking `state`
// labelled an unopenable title "Open Access".
describe('CatalogueScreen — D8 not entitled', () => {
  const NOT_ENTITLED: Catalogue = {
    ...FAKE_CATALOGUE,
    shelves: [
      {
        id: 'orphan',
        title: 'Orphans',
        publications: [
          {
            id: 'item_orphan',
            title: 'Metadata Only',
            publisher: 'Routledge',
            authors: [],
            subjects: [],
            // No `acquisition`, and no `format` either — there is no file.
          } as unknown as Catalogue['shelves'][number]['publications'][number],
        ],
      },
    ],
  };

  it('still renders the row, because the title is real', async () => {
    setCatalogueSource(fakeSource(async () => NOT_ENTITLED));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);

    await waitFor(() => expect(screen.getByText('Metadata Only')).toBeTruthy());
  });

  it('draws no access badge — not even the OPEN_ACCESS placeholder', async () => {
    setCatalogueSource(fakeSource(async () => NOT_ENTITLED));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);
    await waitFor(() => expect(screen.getByText('Metadata Only')).toBeTruthy());

    expect(screen.queryByText('Open Access')).toBeNull();
    expect(screen.queryByTestId('content-card-badge')).toBeNull();
  });

  it('draws no tappable action of any kind', async () => {
    setCatalogueSource(fakeSource(async () => NOT_ENTITLED));

    await render(<CatalogueScreen institution={OTHER_INSTITUTION} />);
    await waitFor(() => expect(screen.getByText('Metadata Only')).toBeTruthy());

    expect(screen.queryByTestId('content-card-action')).toBeNull();
    expect(screen.queryByText('Grant access')).toBeNull();
    expect(screen.queryByText('Read')).toBeNull();
    expect(screen.queryByText('Download')).toBeNull();
    expect(screen.queryByText('Sign in')).toBeNull();
    // No upsell either — index.html: "there is no endpoint behind one".
    expect(screen.queryByText('Subscribe')).toBeNull();
  });
});
