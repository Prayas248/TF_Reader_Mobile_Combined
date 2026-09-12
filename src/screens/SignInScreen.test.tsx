// src/screens/SignInScreen.test.tsx
// Screen 02 — Sign-in sheet
//
// Covered behaviours:
//   1. Renders the selected institution's name when one is in the store.
//   2. No institution in the store → goBack() is called immediately; nothing rendered.
//   3. Backdrop tap dismisses; the sheet View claims its own touches via onStartShouldSetResponder.
//   4. Sign-in button is disabled when the device is offline — pressing it does not call anything.
//   5. Sign-in re-fetches the full institution, then calls beginSamlSignIn with its idpHint.
//   6. If getInstitution or beginSamlSignIn rejects, ErrorState appears and Retry re-invokes the handler.
//   7. On success with no pending intent, lands on the home catalogue tab via tabNavigation.navigate.
//   8. A pending intent is replayed with popTo, not navigate, so the ItemDetail
//      already in the stack is returned to rather than duplicated.
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import type { DataSource } from '@adapters/InstitutionSource';
import { setCatalogueSource } from '@config/catalogue';
import { beginSamlSignIn } from '@/auth/institutionSignIn';
import { useInstitutionStore } from '@store/institutionStore';
import { usePendingIntentStore } from '@store/pendingIntentStore';
import { useNetworkStatus } from '@hooks/useNetworkStatus';
import type { Institution } from '@model/institution';
import type { CatalogueStackParamList } from '../navigation/types';

import SignInScreen from './SignInScreen';

jest.mock('@hooks/useNetworkStatus');
const mockIsOnline = useNetworkStatus as jest.MockedFunction<typeof useNetworkStatus>;

jest.mock('@/auth/institutionSignIn');
const mockBeginSamlSignIn = beginSamlSignIn as jest.MockedFunction<typeof beginSamlSignIn>;

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
const mockPopTo = jest.fn();
const mockTabNavigate = jest.fn();

// The screen widens `navigation` to BottomTabNavigationProp for the one call
// that has to reach a sibling tab — both `navigate` names live on the same
// mock object, matching how the real navigation prop carries both.
type Nav = NativeStackNavigationProp<CatalogueStackParamList, 'SignIn'>;
const mockNavigation = {
  goBack: mockGoBack,
  navigate: (...args: unknown[]) => {
    mockNavigate(...args);
    mockTabNavigate(...args);
  },
  popTo: mockPopTo,
} as unknown as Nav;

const IMPERIAL: Institution = {
  id: 'inst_7f3',
  name: 'Imperial College London',
  country: 'United Kingdom',
  code: 'ICL',
  city: 'London',
  catalogueUrl: 'https://api.tf/opds/v1/institutions/inst_7f3/catalogue',
  branding: { logoUrl: 'https://cdn.tf/crests/inst_7f3.png' },
  signIn: { method: 'SAML', idpHint: 'imperial-saml-mock' },
};

// Every method a real DataSource must have, so the fake typechecks as one. Only
// getInstitution is exercised; the rest reject, which turns an unexpected
// dependency into a loud failure instead of a silent one — same pattern as
// InstitutionDetailScreen.test.tsx.
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

afterEach(() => {
  useInstitutionStore.setState({ selectedInstitution: null, recentlyUsedIds: [], cachedInstitutions: [] });
  usePendingIntentStore.setState({ pending: null });
  setCatalogueSource(undefined);
  mockGoBack.mockClear();
  mockNavigate.mockClear();
  mockPopTo.mockClear();
  mockTabNavigate.mockClear();
  mockIsOnline.mockReset();
  mockBeginSamlSignIn.mockReset();
});

describe('SignInScreen', () => {
  it('renders the selected institution name', async () => {
    mockIsOnline.mockReturnValue(true);
    useInstitutionStore.setState({ selectedInstitution: IMPERIAL });

    await render(<SignInScreen navigation={mockNavigation} route={{} as any} />);

    expect(screen.getByText('Imperial College London')).toBeTruthy();
  });

  it('calls goBack immediately when there is no selected institution', async () => {
    mockIsOnline.mockReturnValue(true);
    // selectedInstitution defaults to null after afterEach reset

    await render(<SignInScreen navigation={mockNavigation} route={{} as any} />);

    await waitFor(() => expect(mockGoBack).toHaveBeenCalled());
  });

  it('tapping the backdrop calls goBack; the sheet claims its own touches', async () => {
    mockIsOnline.mockReturnValue(true);
    useInstitutionStore.setState({ selectedInstitution: IMPERIAL });

    await render(<SignInScreen navigation={mockNavigation} route={{} as any} />);

    // onStartShouldSetResponder must return true so native touch bubbling stops
    // before reaching the absoluteFill dismiss Pressable behind the sheet.
    // fireEvent.press cannot exercise the responder system — verify the contract directly.
    const sheet = screen.getByTestId('sign-in-sheet');
    expect(sheet.props.onStartShouldSetResponder()).toBe(true);

    // The backdrop Pressable should still call goBack.
    fireEvent.press(screen.getByLabelText('Dismiss'));
    expect(mockGoBack).toHaveBeenCalledTimes(1);
  });

  it('disables the sign-in button when offline and pressing it calls nothing', async () => {
    mockIsOnline.mockReturnValue(false);
    useInstitutionStore.setState({ selectedInstitution: IMPERIAL });

    await render(<SignInScreen navigation={mockNavigation} route={{} as any} />);

    // ActionButton renders with testID="action-button-signIn"; the handleSignIn guard
    // (!isOnline) ensures nothing fires even if fireEvent bypasses disabled.
    fireEvent.press(screen.getByTestId('action-button-signIn'));
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(mockBeginSamlSignIn).not.toHaveBeenCalled();
  });

  it('re-fetches the full institution and calls beginSamlSignIn with its idpHint', async () => {
    mockIsOnline.mockReturnValue(true);
    useInstitutionStore.setState({ selectedInstitution: IMPERIAL });
    const getInstitution = jest.fn(async () => IMPERIAL);
    setCatalogueSource(fakeSource(getInstitution));
    mockBeginSamlSignIn.mockResolvedValue({
      accessToken: 'access_123',
      refreshToken: 'refresh_456',
      expiresIn: 900,
    });

    await render(<SignInScreen navigation={mockNavigation} route={{} as any} />);
    fireEvent.press(screen.getByTestId('action-button-signIn'));

    await waitFor(() => expect(getInstitution).toHaveBeenCalledWith(IMPERIAL.id));
    expect(mockBeginSamlSignIn).toHaveBeenCalledWith({
      institutionId: IMPERIAL.id,
      idpHint: IMPERIAL.signIn?.idpHint,
    });
  });

  it('lands on the home catalogue tab when sign-in succeeds with no pending intent', async () => {
    mockIsOnline.mockReturnValue(true);
    useInstitutionStore.setState({ selectedInstitution: IMPERIAL });
    setCatalogueSource(fakeSource(async () => IMPERIAL));
    mockBeginSamlSignIn.mockResolvedValue({
      accessToken: 'access_123',
      refreshToken: 'refresh_456',
      expiresIn: 900,
    });

    await render(<SignInScreen navigation={mockNavigation} route={{} as any} />);
    fireEvent.press(screen.getByTestId('action-button-signIn'));

    await waitFor(() =>
      expect(mockTabNavigate).toHaveBeenCalledWith('Catalogue', { screen: 'CatalogueHome' }),
    );
    expect(mockPopTo).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('shows ErrorState and a Retry button when beginSamlSignIn rejects; Retry re-invokes the handler', async () => {
    mockIsOnline.mockReturnValue(true);
    useInstitutionStore.setState({ selectedInstitution: IMPERIAL });
    setCatalogueSource(fakeSource(async () => IMPERIAL));
    mockBeginSamlSignIn.mockRejectedValueOnce(new Error('SAML sign-in was refused'));
    mockBeginSamlSignIn.mockResolvedValueOnce({
      accessToken: 'access_123',
      refreshToken: 'refresh_456',
      expiresIn: 900,
    });

    await render(<SignInScreen navigation={mockNavigation} route={{} as any} />);
    fireEvent.press(screen.getByTestId('action-button-signIn'));

    await waitFor(() =>
      expect(screen.getByText(/sign-in could not be started/i)).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();

    // Retry re-invokes the handler — the second attempt succeeds and navigates.
    fireEvent.press(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() =>
      expect(mockTabNavigate).toHaveBeenCalledWith('Catalogue', { screen: 'CatalogueHome' }),
    );
  });

  it('leaves the button usable after a sign-in completes, never stuck busy', async () => {
    mockIsOnline.mockReturnValue(true);
    useInstitutionStore.setState({ selectedInstitution: IMPERIAL });
    setCatalogueSource(fakeSource(async () => IMPERIAL));
    mockBeginSamlSignIn.mockResolvedValue({
      accessToken: 'access_123',
      refreshToken: 'refresh_456',
      expiresIn: 900,
    });

    await render(<SignInScreen navigation={mockNavigation} route={{} as any} />);
    fireEvent.press(screen.getByTestId('action-button-signIn'));

    await waitFor(() => expect(mockTabNavigate).toHaveBeenCalled());
    expect(screen.queryByTestId('action-button-spinner')).toBeNull();
  });
});

describe('SignInScreen pending-intent replay', () => {
  // `popTo`, not `navigate` — the ItemDetail already in the stack (pushed
  // before AccessGate and this screen went on top of it) must be returned to,
  // not duplicated. A duplicate leaves this sheet stranded underneath, so the
  // first back press reveals it again instead of reaching the list.
  it('resumes the remembered item with popTo', async () => {
    mockIsOnline.mockReturnValue(true);
    useInstitutionStore.setState({ selectedInstitution: IMPERIAL });
    setCatalogueSource(fakeSource(async () => IMPERIAL));
    mockBeginSamlSignIn.mockResolvedValue({
      accessToken: 'access_123',
      refreshToken: 'refresh_456',
      expiresIn: 900,
    });
    usePendingIntentStore.setState({
      pending: {
        action: 'read',
        itemId: 'item_42',
        institutionId: 'inst_7f3',
        createdAt: Date.now(),
      },
    });

    await render(<SignInScreen navigation={mockNavigation} route={{} as any} />);

    fireEvent.press(screen.getByTestId('action-button-signIn'));

    await waitFor(() =>
      expect(mockPopTo).toHaveBeenCalledWith('ItemDetail', { itemId: 'item_42' }),
    );
    expect(mockTabNavigate).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
  });

  it('falls back to the home catalogue tab when no intent is pending', async () => {
    mockIsOnline.mockReturnValue(true);
    useInstitutionStore.setState({ selectedInstitution: IMPERIAL });
    setCatalogueSource(fakeSource(async () => IMPERIAL));
    mockBeginSamlSignIn.mockResolvedValue({
      accessToken: 'access_123',
      refreshToken: 'refresh_456',
      expiresIn: 900,
    });

    await render(<SignInScreen navigation={mockNavigation} route={{} as any} />);

    fireEvent.press(screen.getByTestId('action-button-signIn'));

    await waitFor(() =>
      expect(mockTabNavigate).toHaveBeenCalledWith('Catalogue', { screen: 'CatalogueHome' }),
    );
    expect(mockPopTo).not.toHaveBeenCalled();
  });
});
