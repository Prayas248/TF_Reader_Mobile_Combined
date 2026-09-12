// src/navigation/RootNavigator.test.tsx
//
// T3 — the wiring nobody owns. RootNavigator was built all-hands and sat at
// 64% statements / ~50% branches with no test asserting that a given route
// resolves to the right screen. The uncovered branches are:
//
//   1. The hydration gate — splash while _hasHydrated=false, full navigator
//      after. A stuck flag means a permanent white screen with no way out.
//   2. AppHeader's back-button branch — back ? goBack : undefined.
//   3. AppTabBar's activeKey fallback — routes[index]?.name ?? 'Catalogue'.
//
// All child screens are stubbed so this file tests the navigator wiring, not
// individual screen behaviour — that belongs in each screen's own test file.
//
// Note: jest.mock() factories are hoisted above imports by Babel, so they
// cannot reference imported variables. `require` inside each factory is the
// standard pattern for returning React components from a mock factory.
import { NavigationContainer } from '@react-navigation/native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { useInstitutionStore } from '@store/institutionStore';
import { useSessionStore } from '@store/sessionStore';
import RootNavigator from './RootNavigator';

// ─── Screen stubs ─────────────────────────────────────────────────────────────

jest.mock('../screens/CatalogueHomeScreen', () => ({
  __esModule: true,
  default: () => {
    const { Text } = require('react-native');
    return <Text testID="screen-catalogue-home">CatalogueHome</Text>;
  },
}));
jest.mock('../screens/SearchScreen', () => ({
  __esModule: true,
  default: () => {
    const { Text } = require('react-native');
    return <Text testID="screen-search-home">SearchHome</Text>;
  },
}));
jest.mock('../screens/LibraryScreen', () => ({
  __esModule: true,
  default: () => {
    const { Text } = require('react-native');
    return <Text testID="screen-library-home">LibraryHome</Text>;
  },
}));
jest.mock('../screens/ProfileScreen', () => ({
  __esModule: true,
  default: () => {
    const { Text } = require('react-native');
    return <Text testID="screen-profile-home">ProfileHome</Text>;
  },
}));
jest.mock('../screens/ItemDetailScreen', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../screens/ShelfScreen', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../screens/SignInScreen', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../screens/AccessGateScreen', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../screens/InstitutionListScreen', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../screens/InstitutionDetailScreen', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../screens/ReaderPreferencesScreen', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../screens/GalleryScreen', () => ({
  __esModule: true,
  default: () => null,
}));

// ReaderRouteScreen pulls in ReaderScreen -> useTtsSession -> ttsEngine.ts's
// `import Tts from '@iternio/react-native-tts'` at REQUIRE time (native-stack resolves the whole
// module graph eagerly, regardless of which route is on screen — see CLAUDE.md). Stubbed like
// every other screen here rather than mocking the native module directly, since this file only
// tests navigator wiring, not reader behaviour.
jest.mock('./ReaderRouteScreen', () => ({
  __esModule: true,
  ReaderRouteScreen: () => null,
}));
jest.mock('./BookInfoRouteScreen', () => ({
  __esModule: true,
  BookInfoRouteScreen: () => null,
}));

// QueueNotificationHost renders the D16 offer banner above every screen.
jest.mock('../features/queue/QueueNotificationHost', () => ({
  __esModule: true,
  default: () => {
    const { Text } = require('react-native');
    return <Text testID="queue-notification-host">QueueHost</Text>;
  },
}));

jest.mock('@hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => true,
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderNavigator() {
  return render(
    <NavigationContainer>
      <RootNavigator />
    </NavigationContainer>,
  );
}

const TEST_INSTITUTION = {
  id: 'inst_test',
  name: 'Imperial College London',
  country: 'United Kingdom',
  code: 'ICL',
  city: 'London',
};

afterEach(() => {
  useInstitutionStore.setState({ _hasHydrated: false, selectedInstitution: null });
  useSessionStore.setState({ _authReady: false });
});

// ─── Hydration gate ───────────────────────────────────────────────────────────

describe('RootNavigator — hydration gate', () => {
  // FL-5: the splash keeps the user on a white screen rather than flashing an
  // empty state or replaying a stale intent before the store has loaded.
  it('shows a blank splash while the store has not hydrated', async () => {
    await act(async () => {
      useInstitutionStore.setState({ _hasHydrated: false });
      renderNavigator();
    });

    expect(screen.queryByTestId('screen-catalogue-home')).toBeNull();
    expect(screen.queryByText('Catalogue')).toBeNull();
  });

  it('renders the full navigator once the store has hydrated', async () => {
    await act(async () => {
      useInstitutionStore.setState({ _hasHydrated: true });
      useSessionStore.setState({ _authReady: true });
      renderNavigator();
    });

    expect(screen.getByTestId('screen-catalogue-home')).toBeTruthy();
  });

  it('shows a blank splash while auth has not resolved, even if institutions have hydrated', async () => {
    await act(async () => {
      useInstitutionStore.setState({ _hasHydrated: true });
      useSessionStore.setState({ _authReady: false });
      renderNavigator();
    });

    expect(screen.queryByTestId('screen-catalogue-home')).toBeNull();
  });

  it('shows a blank splash while institutions have not hydrated, even if auth has resolved', async () => {
    await act(async () => {
      useInstitutionStore.setState({ _hasHydrated: false });
      useSessionStore.setState({ _authReady: true });
      renderNavigator();
    });

    expect(screen.queryByTestId('screen-catalogue-home')).toBeNull();
  });
});

// ─── Tab wiring ───────────────────────────────────────────────────────────────

describe('RootNavigator — tab wiring', () => {
  it('renders all four bottom tabs', async () => {
    await act(async () => {
      useInstitutionStore.setState({ _hasHydrated: true });
      useSessionStore.setState({ _authReady: true });
      renderNavigator();
    });

    expect(screen.getByText('Catalogue')).toBeTruthy();
    expect(screen.getByText('Search')).toBeTruthy();
    expect(screen.getByText('Library')).toBeTruthy();
    expect(screen.getByText('Profile')).toBeTruthy();
  });

  it('starts on the Catalogue tab with CatalogueHome as the initial screen', async () => {
    await act(async () => {
      useInstitutionStore.setState({ _hasHydrated: true });
      useSessionStore.setState({ _authReady: true });
      renderNavigator();
    });

    expect(screen.getByTestId('screen-catalogue-home')).toBeTruthy();
  });

  it('switches to Search when the Search tab is pressed', async () => {
    await act(async () => {
      useInstitutionStore.setState({ _hasHydrated: true });
      useSessionStore.setState({ _authReady: true });
      renderNavigator();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Search'));
    });

    expect(screen.getByTestId('screen-search-home')).toBeTruthy();
  });

  it('switches to Profile when the Profile tab is pressed', async () => {
    await act(async () => {
      useInstitutionStore.setState({ _hasHydrated: true });
      useSessionStore.setState({ _authReady: true });
      renderNavigator();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Profile'));
    });

    expect(screen.getByTestId('screen-profile-home')).toBeTruthy();
  });
});

// ─── AppHeader — institution pill ────────────────────────────────────────────

describe('RootNavigator — institution pill', () => {
  // The pill replaced CatalogueScreen's own in-body picker row — it now lives
  // beside the brand mark instead of repeated as a full-width row underneath.
  it('shows the selected institution on the Catalogue tab root', async () => {
    await act(async () => {
      useInstitutionStore.setState({ _hasHydrated: true, selectedInstitution: TEST_INSTITUTION });
      useSessionStore.setState({ _authReady: true });
      renderNavigator();
    });

    expect(screen.getByText('Imperial College London')).toBeTruthy();
  });

  it('shows no pill when no institution is selected', async () => {
    await act(async () => {
      useInstitutionStore.setState({ _hasHydrated: true, selectedInstitution: null });
      useSessionStore.setState({ _authReady: true });
      renderNavigator();
    });

    expect(screen.queryByText('Imperial College London')).toBeNull();
  });

  // The pill shows on every tab root, not just Catalogue's — Library/Search/
  // Profile all act on behalf of the same signed-in institution even though
  // they don't browse its feed directly (see AppHeader's own comment).
  it('shows the pill on the Search tab root too', async () => {
    await act(async () => {
      useInstitutionStore.setState({ _hasHydrated: true, selectedInstitution: TEST_INSTITUTION });
      useSessionStore.setState({ _authReady: true });
      renderNavigator();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Search'));
    });

    expect(screen.getByText('Imperial College London')).toBeTruthy();
  });

  it('shows the pill on the Library tab root too', async () => {
    await act(async () => {
      useInstitutionStore.setState({ _hasHydrated: true, selectedInstitution: TEST_INSTITUTION });
      useSessionStore.setState({ _authReady: true });
      renderNavigator();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Library'));
    });

    expect(screen.getByText('Imperial College London')).toBeTruthy();
  });

  it('shows the pill on the Profile tab root too', async () => {
    await act(async () => {
      useInstitutionStore.setState({ _hasHydrated: true, selectedInstitution: TEST_INSTITUTION });
      useSessionStore.setState({ _authReady: true });
      renderNavigator();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Profile'));
    });

    expect(screen.getByText('Imperial College London')).toBeTruthy();
  });

  it('navigates to InstitutionList when pressed', async () => {
    await act(async () => {
      useInstitutionStore.setState({ _hasHydrated: true, selectedInstitution: TEST_INSTITUTION });
      useSessionStore.setState({ _authReady: true });
      renderNavigator();
    });

    await act(async () => {
      fireEvent.press(screen.getByText('Imperial College London'));
    });

    // InstitutionListScreen itself is stubbed to null (see the mocks above) —
    // the header naming where "back" returns to is what confirms the
    // navigation (`pushedScreenHeaderTitle`'s own comment in
    // RootNavigator.tsx), so it shows CatalogueHome's own title rather than
    // InstitutionList's registered 'Change institution' fallback. The pill
    // itself disappears either way (this route pushes, so `back` is now set).
    expect(screen.getByText('Taylor & Francis')).toBeTruthy();
    expect(screen.queryByText('Imperial College London')).toBeNull();
  });
});

// ─── D16 — QueueNotificationHost ─────────────────────────────────────────────

describe('RootNavigator — QueueNotificationHost', () => {
  // D16: the offer banner must sit above every screen, mounted at the root so
  // it is answerable from wherever the reader is — not only from ItemDetail.
  it('mounts QueueNotificationHost above the tab navigator', async () => {
    await act(async () => {
      useInstitutionStore.setState({ _hasHydrated: true });
      useSessionStore.setState({ _authReady: true });
      renderNavigator();
    });

    expect(screen.getByTestId('queue-notification-host')).toBeTruthy();
  });
});
