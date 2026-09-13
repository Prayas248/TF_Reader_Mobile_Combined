// App.startupGate.test.tsx — the post-splash sign-in gate (StartupGateScreen).
//
// A SEPARATE FILE FROM App.test.tsx ON PURPOSE. That file is a toolchain smoke
// test and deliberately does not assert on auth state. This one needs
// deterministic control over `isAuthenticated`/`_authReady` at the moment
// splash resolves, so `bootstrapAuth` (an async secure-storage read) is
// mocked out entirely rather than raced against — the same reason
// RootNavigator.test.tsx sets `_hasHydrated`/`_authReady` directly instead of
// going through the real boot sequence.
//
// `await render(...)` is required — RTL 14's render is async.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { useInstitutionStore } from '@store/institutionStore';
import { useSessionStore } from '@store/sessionStore';

import App from './App';

jest.mock('@hooks/useNetworkStatus', () => ({
  useNetworkStatus: () => true,
}));

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn(() => jest.fn()),
    fetch: jest.fn().mockResolvedValue({ isConnected: false }),
  },
}));

jest.mock('@/features/accessibility/tts/ttsEngine', () => ({
  __esModule: true,
  default: {
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    speak: jest.fn(() => Promise.resolve('utterance-1')),
    stop: jest.fn(() => Promise.resolve(true)),
    pause: jest.fn(() => Promise.resolve(true)),
    resume: jest.fn(() => Promise.resolve(true)),
    setDefaultRate: jest.fn(() => Promise.resolve(true)),
    setDefaultPitch: jest.fn(() => Promise.resolve(true)),
    setDefaultVoice: jest.fn(() => Promise.resolve(true)),
    setIgnoreSilentSwitch: jest.fn(() => Promise.resolve(true)),
    voices: jest.fn(() => Promise.resolve([])),
  },
}));

// Replaces the real boot-time secure-storage read with a no-op, so this
// file's own `useSessionStore.setState` calls are the only thing that ever
// sets `_authReady`/`isAuthenticated` — see the header comment above.
jest.mock('./src/auth/tokenRefresh', () => ({
  bootstrapAuth: jest.fn(),
}));

afterEach(() => {
  useInstitutionStore.setState({ _hasHydrated: false });
  useSessionStore.setState({ _authReady: false, isAuthenticated: false });
});

describe('App — startup sign-in gate', () => {
  it('shows the gate right after splash when nobody is signed in', async () => {
    await act(async () => {
      useInstitutionStore.setState({ _hasHydrated: true });
      useSessionStore.setState({ _authReady: true, isAuthenticated: false });
      render(<App />);
    });

    await waitFor(() =>
      expect(screen.getByText('Sign in for the full experience')).toBeTruthy(),
    );
  });

  it('does not show the gate when the reader is already signed in', async () => {
    await act(async () => {
      useInstitutionStore.setState({ _hasHydrated: true });
      useSessionStore.setState({ _authReady: true, isAuthenticated: true });
      render(<App />);
    });

    expect(screen.queryByText('Sign in for the full experience')).toBeNull();
  });

  it('dismisses to the home screen when "Continue without signing in" is pressed', async () => {
    await act(async () => {
      useInstitutionStore.setState({ _hasHydrated: true });
      useSessionStore.setState({ _authReady: true, isAuthenticated: false });
      render(<App />);
    });

    await waitFor(() => expect(screen.getByTestId('startup-gate-continue')).toBeTruthy());

    await act(async () => {
      fireEvent.press(screen.getByTestId('startup-gate-continue'));
    });

    expect(screen.queryByText('Sign in for the full experience')).toBeNull();
    await waitFor(() => expect(screen.getAllByText('Taylor & Francis').length).toBeGreaterThan(0));
  });
});
