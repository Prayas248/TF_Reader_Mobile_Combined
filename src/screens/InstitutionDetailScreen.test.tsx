// src/screens/InstitutionDetailScreen.test.tsx
// C2's wiring rather than its looks: route param in, adapter call out, one of
// three states rendered, two intentions reported.
//
// The fake DataSource goes in through `setCatalogueSource` — the seam
// config/catalogue.ts exists for — instead of letting MockAdapter read
// institutions.json, so these tests pin the screen's own behaviour independently
// of what the fixtures happen to contain.
//
// `await render(...)` is required — RTL 14's render is async. See
// ContentCard.test.tsx for why forgetting it fails silently.
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { DataSource } from '@adapters/InstitutionSource';
import { setCatalogueSource } from '@config/catalogue';
import { CatalogueError, CatalogueFailure } from '@model/errors';
import type { Institution } from '@model/institution';
import { useInstitutionStore } from '@store/institutionStore';
import type { CatalogueStackParamList } from '../navigation/types';

import InstitutionDetailScreen from './InstitutionDetailScreen';

// `useNetworkStatus` talks to NetInfo, which has no meaningful answer under Jest
// — left real, its `fetch()` throws on `isInternetReachable` and every test in
// this file dies. Mocked per-test so the offline case can be driven directly, the
// same pattern CatalogueScreen.test.tsx uses.
//
// Must be prefixed `mock` — Jest's module-factory scope guard only allows
// referencing out-of-scope variables whose name starts with "mock".
const mockUseNetworkStatus = jest.fn(() => true);
jest.mock('@hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => mockUseNetworkStatus(),
}));

const IMPERIAL: Institution = {
  id: 'inst_7f3',
  name: 'Imperial College London',
  country: 'United Kingdom',
  code: 'ICL',
  city: 'London',
  catalogueUrl: 'https://api.tf/opds/v1/institutions/inst_7f3/catalogue',
  branding: { logoUrl: 'https://cdn.tf/crests/inst_7f3.png' },
};

// Two of the eight fixture institutions carry no branding, so initials are the
// common path for a quarter of the directory (W-17), not an edge case.
const NO_CREST: Institution = {
  id: 'inst_9a1',
  name: 'Universidad de Buenos Aires',
  country: 'Argentina',
  code: 'UBA',
  city: 'Buenos Aires',
  catalogueUrl: 'https://api.tf/opds/v1/institutions/inst_9a1/catalogue',
};

// Every method a real DataSource must have, so the fake typechecks as one. Only
// getInstitution is exercised; the rest reject, which turns an unexpected
// dependency into a loud failure instead of a silent one.
function fakeSource(getInstitution: DataSource['getInstitution']): DataSource {
  const unused = () => Promise.reject(new Error('not stubbed for this test'));
  return {
    getHomeCatalogue: unused,
    getShelf: unused,
    getPublication: unused,
    getPublicFeed: unused,
    getPublicPublication: unused,
    getInstitutions: unused,
    getInstitution,
    getItemsBatch: unused,
    getWork: unused,
  };
}

// `navigation` IS read from props here, unlike ShelfScreen: this screen takes it
// from its own typed NativeStackScreenProps rather than useNavigation, so goBack
// is injected instead of module-mocked. The rest of the navigation object is never
// touched, so it is cast rather than constructed.
type DetailProps = {
  route: { params: CatalogueStackParamList['InstitutionDetail'] };
  navigation: { goBack: jest.Mock };
};

function makeProps(institutionId = 'inst_7f3') {
  const goBack = jest.fn();
  const props = {
    route: { params: { institutionId } },
    navigation: { goBack },
  } as unknown as Parameters<typeof InstitutionDetailScreen>[0] & DetailProps;
  return { props, goBack };
}

afterEach(() => {
  setCatalogueSource(undefined);
  // Zustand state is module-global, so a selection made by one test would
  // otherwise still be there for the next one.
  useInstitutionStore.setState({ selectedInstitution: null, recentlyUsedIds: [] });
  mockUseNetworkStatus.mockReturnValue(true);
});

describe('InstitutionDetailScreen loading', () => {
  it('shows skeletons, and no content, before the institution arrives', async () => {
    // Never resolves within the test, so the screen is caught mid-load.
    setCatalogueSource(fakeSource(() => new Promise(() => {})));
    const { props } = makeProps();

    await render(<InstitutionDetailScreen {...props} />);

    expect(screen.getByTestId('institution-detail-skeleton')).toBeTruthy();
    expect(screen.queryByText('Imperial College London')).toBeNull();
  });
});

describe('InstitutionDetailScreen with data', () => {
  it('requests the institution named in route.params, not a hardcoded id', async () => {
    const getInstitution = jest.fn(async () => NO_CREST);
    setCatalogueSource(fakeSource(getInstitution));
    const { props } = makeProps('inst_9a1');

    await render(<InstitutionDetailScreen {...props} />);

    await waitFor(() => expect(getInstitution).toHaveBeenCalledWith('inst_9a1'));
  });

  it('renders the name and country, and drops the skeleton', async () => {
    setCatalogueSource(fakeSource(async () => IMPERIAL));
    const { props } = makeProps();

    await render(<InstitutionDetailScreen {...props} />);

    await waitFor(() => expect(screen.getByText('Imperial College London')).toBeTruthy());
    expect(screen.getByText('United Kingdom')).toBeTruthy();
    expect(screen.queryByTestId('institution-detail-skeleton')).toBeNull();
  });

  it('maps branding.logoUrl so the logo renders', async () => {
    setCatalogueSource(fakeSource(async () => IMPERIAL));
    const { props } = makeProps();

    await render(<InstitutionDetailScreen {...props} />);

    await waitFor(() => expect(screen.getByLabelText('Imperial College London logo')).toBeTruthy());
  });

  it('leaves logoUrl undefined when there is no crest, so initials show instead', async () => {
    setCatalogueSource(fakeSource(async () => NO_CREST));
    const { props } = makeProps('inst_9a1');

    await render(<InstitutionDetailScreen {...props} />);

    await waitFor(() => expect(screen.getByText('UD')).toBeTruthy());
    expect(screen.queryByLabelText('Universidad de Buenos Aires logo')).toBeNull();
  });

  // The view takes primitives precisely so flambeau's sign-in vocabulary cannot
  // reach a screen. This asserts the absence in executable form.
  it('never renders authType', async () => {
    setCatalogueSource(fakeSource(async () => IMPERIAL));
    const { props } = makeProps();

    await render(<InstitutionDetailScreen {...props} />);

    await waitFor(() => expect(screen.getByText('Imperial College London')).toBeTruthy());
    expect(screen.queryByText(/saml/i)).toBeNull();
  });
});

describe('InstitutionDetailScreen errors', () => {
  it('offers no retry on NOT_FOUND, because repeating the request cannot help', async () => {
    setCatalogueSource(
      fakeSource(async () => {
        throw new CatalogueFailure(CatalogueError.NOT_FOUND, 'inst_missing');
      }),
    );
    const { props } = makeProps('inst_missing');

    await render(<InstitutionDetailScreen {...props} />);

    await waitFor(() => expect(screen.getByText('This could not be found.')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('shows the offline line with a retry when the network is unavailable, and retrying re-fetches', async () => {
    let attempt = 0;
    setCatalogueSource(
      fakeSource(async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new CatalogueFailure(CatalogueError.NETWORK_UNAVAILABLE, 'inst_7f3');
        }
        return IMPERIAL;
      }),
    );
    const { props } = makeProps();

    await render(<InstitutionDetailScreen {...props} />);

    await waitFor(() => expect(screen.getByText(/you appear to be offline/i)).toBeTruthy());

    fireEvent.press(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.getByText('Imperial College London')).toBeTruthy());
    expect(attempt).toBe(2);
  });

  // errors.ts keeps TIMEOUT and NETWORK_UNAVAILABLE apart on the grounds that a
  // slow server and no connection call for different copy. This is that claim,
  // asserted.
  it('gives a timeout its own copy rather than the offline line', async () => {
    setCatalogueSource(
      fakeSource(async () => {
        throw new CatalogueFailure(CatalogueError.TIMEOUT, 'inst_7f3');
      }),
    );
    const { props } = makeProps();

    await render(<InstitutionDetailScreen {...props} />);

    await waitFor(() => expect(screen.getByText(/took too long to respond/i)).toBeTruthy());
    expect(screen.queryByText(/you appear to be offline/i)).toBeNull();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('falls back to one honest message when the rejection is not a CatalogueFailure', async () => {
    setCatalogueSource(
      fakeSource(async () => {
        throw new Error('something nobody modelled');
      }),
    );
    const { props } = makeProps();

    await render(<InstitutionDetailScreen {...props} />);

    await waitFor(() => expect(screen.getByText(/couldn.?t load this institution/i)).toBeTruthy());
    // No stack trace or raw message reaches the screen — ErrorState takes a
    // string, never an Error.
    expect(screen.queryByText(/nobody modelled/i)).toBeNull();
  });
});

describe('InstitutionDetailScreen intentions', () => {
  it('persists the whole institution on select, and dismisses', async () => {
    setCatalogueSource(fakeSource(async () => IMPERIAL));
    const { props, goBack } = makeProps();

    await render(<InstitutionDetailScreen {...props} />);

    await waitFor(() => expect(screen.getByText('Imperial College London')).toBeTruthy());
    fireEvent.press(screen.getByRole('button', { name: 'Select this institution' }));

    const state = useInstitutionStore.getState();
    expect(state.selectedInstitution).toEqual(IMPERIAL);
    // The store action maintains this itself; the screen does not touch it.
    expect(state.recentlyUsedIds).toEqual(['inst_7f3']);
    expect(goBack).toHaveBeenCalled();
  });

  it('goes back without selecting anything on back', async () => {
    setCatalogueSource(fakeSource(async () => IMPERIAL));
    const { props, goBack } = makeProps();

    await render(<InstitutionDetailScreen {...props} />);

    await waitFor(() => expect(screen.getByText('Imperial College London')).toBeTruthy());
    fireEvent.press(screen.getByRole('button', { name: 'Back' }));

    expect(goBack).toHaveBeenCalled();
    expect(useInstitutionStore.getState().selectedInstitution).toBeNull();
  });
});

// ── F5 — offline is its own state ─────────────────────────────────────────────
//
// DISTINCT FROM THE NETWORK-ERROR TESTS ABOVE, and the distinction is the point.
// "shows the offline line with a retry when the network is unavailable" covers the
// ERROR cell: a fetch rejected with NETWORK_UNAVAILABLE, so ErrorState renders
// offline-flavoured copy and a retry. This block covers the OFFLINE cell:
// `useNetworkStatus` reports no connection, so the banner overlays whatever is on
// screen and the content behind it stays usable. CONVENTIONS §6 — "Offline?
// Different from failed, since it resolves itself."
//
// The screen returns early four times, so the banner is asserted in the three
// reachable branches. There is no empty branch: a detail screen either resolves
// or fails, and `institution === null` is documented unreachable.
describe('InstitutionDetailScreen offline', () => {
  it('shows the banner over the loaded institution, which stays readable', async () => {
    mockUseNetworkStatus.mockReturnValue(false);
    setCatalogueSource(fakeSource(async () => IMPERIAL));
    const { props } = makeProps();

    await render(<InstitutionDetailScreen {...props} />);

    // A notice, not a blocker — the content is still there behind it.
    await waitFor(() => expect(screen.getByText('Imperial College London')).toBeTruthy());
    expect(screen.getByText("You're offline")).toBeTruthy();
  });

  it('renders no banner while the network is up', async () => {
    setCatalogueSource(fakeSource(async () => IMPERIAL));
    const { props } = makeProps();

    await render(<InstitutionDetailScreen {...props} />);

    await waitFor(() => expect(screen.getByText('Imperial College London')).toBeTruthy());
    expect(screen.queryByText("You're offline")).toBeNull();
  });

  // The banner has to be there before there is any content to overlay, which is
  // why the loading branch renders it too.
  it('shows the banner while the institution is still loading', async () => {
    mockUseNetworkStatus.mockReturnValue(false);
    setCatalogueSource(fakeSource(() => new Promise(() => {})));
    const { props } = makeProps();

    await render(<InstitutionDetailScreen {...props} />);

    expect(screen.getByTestId('institution-detail-skeleton')).toBeTruthy();
    expect(screen.getByText("You're offline")).toBeTruthy();
  });

  // Both cells at once: being offline is usually WHY the fetch failed, so the
  // notice and the error belong on screen together rather than one replacing the
  // other.
  it('shows the banner alongside the error state, not instead of it', async () => {
    mockUseNetworkStatus.mockReturnValue(false);
    setCatalogueSource(
      fakeSource(() => Promise.reject(new CatalogueFailure(CatalogueError.NETWORK_UNAVAILABLE))),
    );
    const { props } = makeProps();

    await render(<InstitutionDetailScreen {...props} />);

    await waitFor(() => expect(screen.getByText(/you appear to be offline/i)).toBeTruthy());
    expect(screen.getByText("You're offline")).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });
});
