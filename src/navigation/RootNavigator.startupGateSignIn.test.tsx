// src/navigation/RootNavigator.startupGateSignIn.test.tsx
//
// A SEPARATE FILE FROM RootNavigator.test.tsx ON PURPOSE. That file stubs
// StartupGateScreen and SignInMethodScreen out entirely (it only tests
// navigator wiring), which cannot see this bug: it lives in how those two
// REAL screens compose a nested stack's history, not in either screen's own
// isolated behaviour. Unlike SignInMethodScreen.test.tsx, which mocks
// `navigation.popToTop` directly and so cannot see whether ProfileStack even
// HAS a 'ProfileHome' entry underneath for it to pop to.
//
// THE BUG: a reader who signs in via StartupGateScreen (the post-splash
// gate) without ever having pressed the Profile tab first landed on
// SignInMethodScreen forever after switching to Profile — sign-in succeeded,
// but the Profile tab stayed stuck showing the sign-in chooser.
//
// THE CAUSE: StartupGateScreen.handleSignIn deep-links straight into
// `Main -> Profile -> SignInMethod`. Since this was the reader's first ever
// visit to the Profile tab, React Navigation initialized ProfileStack's
// entire history as JUST ['SignInMethod'] — no 'ProfileHome' underneath.
// SignInMethodScreen's own `if (isAuthenticated) navigation.popToTop()`
// (see its own test file) then popped to the top of the stack it was
// ALREADY at the top of — a no-op — leaving no way back to ProfileHome.
//
// THE FIX: StartupGateScreen passes `initial: false` on the SignInMethod
// target, which makes ProfileStack push 'SignInMethod' on top of its normal
// 'ProfileHome' start instead of replacing it. This test proves the fix by
// going through the real flow end to end: press "Sign In" on the real
// StartupGateScreen, let the real SignInMethodScreen see `isAuthenticated`
// flip, then switch to the Profile tab and confirm ProfileHome — not the
// sign-in chooser — is what's there.
import { NavigationContainer } from '@react-navigation/native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { useInstitutionStore } from '@store/institutionStore';
import { useSessionStore } from '@store/sessionStore';
import RootNavigator from './RootNavigator';

// StartupGateScreen and SignInMethodScreen are deliberately NOT mocked here —
// they are the two screens under test. Everything else is stubbed the same
// way RootNavigator.test.tsx does, since this file isn't testing them.
jest.mock('../screens/CatalogueHomeScreen', () => ({
  __esModule: true,
  default: () => {
    const { Text } = require('react-native');
    return <Text testID="screen-catalogue-home">CatalogueHome</Text>;
  },
}));
jest.mock('../screens/SearchScreen', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../screens/LibraryScreen', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../screens/ProfileScreen', () => ({
  __esModule: true,
  default: () => {
    const { Text } = require('react-native');
    return <Text testID="screen-profile-home">ProfileHome</Text>;
  },
}));
jest.mock('../screens/ItemDetailScreen', () => ({ __esModule: true, default: () => null }));
jest.mock('../screens/ShelfScreen', () => ({ __esModule: true, default: () => null }));
jest.mock('../screens/SignInScreen', () => ({ __esModule: true, default: () => null }));
jest.mock('../screens/AccessGateScreen', () => ({ __esModule: true, default: () => null }));
jest.mock('../screens/InstitutionListScreen', () => ({ __esModule: true, default: () => null }));
jest.mock('../screens/InstitutionDetailScreen', () => ({ __esModule: true, default: () => null }));
jest.mock('../screens/ReaderPreferencesScreen', () => ({ __esModule: true, default: () => null }));
jest.mock('../screens/GalleryScreen', () => ({ __esModule: true, default: () => null }));
jest.mock('../screens/PersonalAccountScreen', () => ({ __esModule: true, default: () => null }));

jest.mock('./ReaderRouteScreen', () => ({ __esModule: true, ReaderRouteScreen: () => null }));
jest.mock('./BookInfoRouteScreen', () => ({ __esModule: true, BookInfoRouteScreen: () => null }));

jest.mock('../features/queue/QueueNotificationHost', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => true,
}));

function renderNavigator() {
  return render(
    <NavigationContainer>
      <RootNavigator />
    </NavigationContainer>,
  );
}

afterEach(() => {
  useInstitutionStore.setState({ _hasHydrated: false, selectedInstitution: null });
  useSessionStore.getState().clearSession();
  useSessionStore.setState({ _authReady: false });
});

describe('RootNavigator — signing in from the startup gate on a fresh Profile tab', () => {
  it('lands on ProfileHome, not stuck on the sign-in chooser, after signing in', async () => {
    await act(async () => {
      useInstitutionStore.setState({ _hasHydrated: true });
      useSessionStore.setState({ _authReady: true, isAuthenticated: false });
      renderNavigator();
    });

    // The gate is the initial route for a signed-out cold start.
    expect(screen.getByTestId('startup-gate-sign-in')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('startup-gate-sign-in'));
    });

    // Deep-linked straight into Profile's SignInMethod chooser.
    expect(screen.getByText('Through my institution')).toBeTruthy();

    // Sign-in completing elsewhere (SignInScreen/PersonalAccountScreen) —
    // simulated directly on the store, the same way
    // SignInMethodScreen.test.tsx's own "a session arriving" test does.
    await act(async () => {
      useSessionStore.getState().setSession({
        accessToken: 'tok_abc123',
        expiresIn: 900,
        userId: 'user_1',
        roles: [],
        collections: [],
      });
    });

    // The whole point of the fix: switching tabs away and back to Profile
    // must show ProfileHome, not the sign-in chooser it just finished with.
    await act(async () => {
      fireEvent.press(screen.getByText('Catalogue'));
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Profile'));
    });

    expect(screen.getByTestId('screen-profile-home')).toBeTruthy();
    expect(screen.queryByText('Through my institution')).toBeNull();
  });
});
