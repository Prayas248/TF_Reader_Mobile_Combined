// src/screens/ProfileScreen.test.tsx
// Screen 10 — profile and settings.
//
// WHAT IS NOT TESTED HERE, AND WHY: no name or email line, because
// `AuthMeResponse` carries neither — see the header comment on
// ProfileScreen.tsx. This file only asserts what ProfileScreen does with an
// already-set sessionStore; it does not exercise sign-in itself
// (ApiAuthClient / institutionSignIn.ts), which has no dedicated test yet.
//
// `await render(...)` is required — RTL 14's render is async. See App.test.tsx.
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { Institution } from '@model/institution';
import { deleteRefreshToken } from '@store/secureStorage';
import { useInstitutionStore } from '@store/institutionStore';
import { usePendingIntentStore } from '@store/pendingIntentStore';
import { useSessionStore } from '@store/sessionStore';

import ProfileScreen from './ProfileScreen';

// Must be prefixed `mock` — Jest's module-factory scope guard only allows
// referencing out-of-scope variables whose name starts with "mock". Same shape
// as CatalogueScreen.test.tsx and SearchScreen.test.tsx.
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

// Sign-out now awaits deleteRefreshToken before navigating (it deletes a real
// Keychain/Keystore entry via expo-secure-store, which has no Jest mock).
// Mocked resolved so the awaited handler settles on the same tick the tests
// already assumed.
jest.mock('@store/secureStorage', () => ({
  deleteRefreshToken: jest.fn().mockResolvedValue(undefined),
}));
const mockDeleteRefreshToken = deleteRefreshToken as jest.MockedFunction<typeof deleteRefreshToken>;

const OXFORD: Institution = {
  id: 'inst_7f3',
  name: 'University of Oxford',
  country: 'United Kingdom',
  code: 'OXF',
  city: 'Oxford',
  catalogueUrl: 'https://api.tf/opds/v1/institutions/inst_7f3/catalogue',
  branding: { logoUrl: 'https://cdn.tf/crests/inst_7f3.png' },
};

// Same institution with no branding asset — W-17's initials fallback.
const NO_CREST: Institution = {
  id: 'inst_a21',
  name: 'Deakin University',
  country: 'Australia',
  code: 'DKN',
  city: 'Melbourne',
  catalogueUrl: 'https://api.tf/opds/v1/institutions/inst_a21/catalogue',
};

function selectInstitution(institution: Institution | null) {
  useInstitutionStore.setState({
    selectedInstitution: institution,
    recentlyUsedIds: institution === null ? [] : [institution.id],
  });
}

beforeEach(() => {
  selectInstitution(OXFORD);
});

afterEach(() => {
  mockNavigate.mockClear();
  useInstitutionStore.setState({ selectedInstitution: null, recentlyUsedIds: [] });
  usePendingIntentStore.setState({ pending: null });
  useSessionStore.getState().clearSession();
});

// A personal (OIDC) session: no institutionId, so sessionStore reads it as an
// individual subscriber.
function signInPersonally() {
  useSessionStore.getState().setSession({
    accessToken: 'stub-personal:reader@tf.com',
    expiresIn: 3600,
    userId: 'reader@tf.com',
    roles: [],
    collections: [],
  });
}

// An institutional (SAML) session, which does carry one.
function signInInstitutionally(institution: Institution) {
  useSessionStore.getState().setSession({
    accessToken: `stub:${institution.id}`,
    expiresIn: 3600,
    userId: `stub:${institution.id}`,
    institutionId: institution.id,
    roles: [],
    collections: [],
  });
}

describe('ProfileScreen account header', () => {
  // The avatar is a generic glyph in the mockup, not a photograph, so it needs
  // no data and is drawn as designed. The name and email do need data, and have
  // none — see the header comment on ProfileScreen.tsx.
  it('draws the avatar', async () => {
    await render(<ProfileScreen />);
    expect(screen.getByTestId('profile-avatar', { includeHiddenElements: true })).toBeTruthy();
  });

  // Asserted as the outcome rather than as the prop spelling: RTL's default
  // queries skip elements hidden from the accessibility tree, so not finding it
  // IS the guarantee. `includeHiddenElements` above is what makes the pair
  // meaningful — the glyph is drawn, and it is not announced.
  it('keeps the decorative avatar out of the accessibility tree', async () => {
    await render(<ProfileScreen />);
    expect(screen.queryByTestId('profile-avatar')).toBeNull();
  });

  it('says so rather than inventing a name', async () => {
    await render(<ProfileScreen />);
    expect(screen.getByText('Not signed in')).toBeTruthy();
  });

  // Selecting an institution is not signing in — CAP-3 picks the institution
  // before any session exists (resolveAccess.ts states this directly). The
  // header must not start claiming an identity because a crest appeared.
  it('still says so once an institution is selected', async () => {
    selectInstitution(OXFORD);
    await render(<ProfileScreen />);
    expect(screen.getByText('Not signed in')).toBeTruthy();
  });
});

describe('ProfileScreen signed-out entry points', () => {
  it('offers both signing in and creating an account', async () => {
    await render(<ProfileScreen />);

    expect(screen.getByTestId('profile-sign-in')).toBeTruthy();
    expect(screen.getByTestId('profile-sign-up')).toBeTruthy();
  });

  it('sends Sign in to the method chooser', async () => {
    await render(<ProfileScreen />);

    fireEvent.press(screen.getByTestId('profile-sign-in'));

    expect(mockNavigate).toHaveBeenCalledWith('SignInMethod');
  });

  // Straight past the chooser: an institution already owns its readers'
  // accounts, so there is nothing to create on the SAML side.
  it('sends Create an account straight to the sign-up form', async () => {
    await render(<ProfileScreen />);

    fireEvent.press(screen.getByTestId('profile-sign-up'));

    expect(mockNavigate).toHaveBeenCalledWith('PersonalAccount', { mode: 'signUp' });
  });

  // A leftover intent would make PersonalAccountScreen reach for ItemDetail,
  // which the Profile stack does not have. Signing in from here is not resuming.
  it.each(['profile-sign-in', 'profile-sign-up'])(
    'clears a stale pending intent before navigating from %s',
    async (testID) => {
      usePendingIntentStore.getState().remember({
        action: 'read',
        itemId: 'item_42',
        institutionId: 'inst_7f3',
      });
      await render(<ProfileScreen />);

      fireEvent.press(screen.getByTestId(testID));

      expect(usePendingIntentStore.getState().pending).toBeNull();
    },
  );

  it('withdraws both once a session exists', async () => {
    signInPersonally();
    await render(<ProfileScreen />);

    expect(screen.queryByTestId('profile-sign-in')).toBeNull();
    expect(screen.queryByTestId('profile-sign-up')).toBeNull();
  });
});

describe('ProfileScreen account header, signed in', () => {
  // Still no name or email in AuthMeResponse, so the line shows the identifier
  // the session actually carries rather than an invented display name.
  it('shows the identifier and names the account type for a personal session', async () => {
    selectInstitution(null);
    signInPersonally();
    await render(<ProfileScreen />);

    expect(screen.getByText('reader@tf.com')).toBeTruthy();
    expect(screen.getByText('Individual account')).toBeTruthy();
  });

  it('shows the institution for an institutional session', async () => {
    selectInstitution(OXFORD);
    signInInstitutionally(OXFORD);
    await render(<ProfileScreen />);

    expect(screen.getByText('Institutional access')).toBeTruthy();
    expect(screen.queryByText('Not signed in')).toBeNull();
  });
});

// The identity card merges what used to be two separate blocks (a plain
// header plus a separate InstitutionRow) into one, and — per product
// decision — takes no press and draws no chevron: `Change institution` is
// the only real, working destination, and it stays its own row below the
// card rather than becoming the card's own tap target.
describe('ProfileScreen institutional identity card', () => {
  it('shows the institution, an active-access line and the address', async () => {
    selectInstitution(OXFORD);
    signInInstitutionally(OXFORD);
    await render(<ProfileScreen />);

    // ONCE, not twice. The card used to repeat the name in its address line
    // for want of a location field; the meta panel shows `city`/`code` there
    // now, so the headline is the only place the name appears.
    expect(screen.getAllByText('University of Oxford')).toHaveLength(1);
    expect(screen.getByText('ACTIVE ACCESS')).toBeTruthy();
    expect(screen.getByText('Oxford · OXF')).toBeTruthy();
    expect(screen.getByText('United Kingdom')).toBeTruthy();
  });

  it('is not itself pressable — only the separate Change institution row is', async () => {
    selectInstitution(OXFORD);
    signInInstitutionally(OXFORD);
    await render(<ProfileScreen />);

    expect(screen.queryAllByRole('button', { name: 'University of Oxford' })).toHaveLength(0);
  });

  it('does not also render the old, separate InstitutionRow section', async () => {
    selectInstitution(OXFORD);
    signInInstitutionally(OXFORD);
    await render(<ProfileScreen />);

    // The old section rendered the crest-and-name pair as its own pressable
    // row (accessibilityRole="button", labelled by the institution's name) —
    // gone now that the merged card draws the same pair non-interactively.
    expect(screen.queryAllByRole('button', { name: 'University of Oxford' })).toHaveLength(0);
    expect(screen.getAllByText('University of Oxford')).toHaveLength(1);
  });

  // `signIn` is only present on an institution fetched from the detail
  // endpoint, so the authentication half of the country line has to survive
  // its absence as well as its presence — OXFORD above covers the absent case.
  it('names the sign-in method beside the country when the detail fetch supplied one', async () => {
    const withSignIn: Institution = {
      ...OXFORD,
      signIn: { method: 'Shibboleth', idpHint: 'oxford' },
    };
    selectInstitution(withSignIn);
    signInInstitutionally(withSignIn);
    await render(<ProfileScreen />);

    expect(screen.getByText('United Kingdom · Shibboleth authenticated')).toBeTruthy();
  });

  it('still lets the reader change institution from the row beneath the card', async () => {
    selectInstitution(OXFORD);
    signInInstitutionally(OXFORD);
    await render(<ProfileScreen />);

    fireEvent.press(screen.getByRole('button', { name: 'Change institution' }));

    expect(mockNavigate).toHaveBeenCalledWith('Catalogue', { screen: 'InstitutionList' });
  });

  it('falls back to initials when the institution has no crest', async () => {
    selectInstitution(NO_CREST);
    signInInstitutionally(NO_CREST);
    await render(<ProfileScreen />);

    expect(screen.queryByLabelText('Deakin University logo')).toBeNull();
    expect(screen.getByText('DU')).toBeTruthy();
  });
});

// No account-details screen exists (and no name/email to show one — see the
// file header note), so this card is display only, the same as the
// institutional one above.
describe('ProfileScreen personal identity card', () => {
  it('is not itself pressable', async () => {
    selectInstitution(null);
    signInPersonally();
    await render(<ProfileScreen />);

    expect(screen.queryByRole('button', { name: 'reader@tf.com' })).toBeNull();
  });

  it('names the account type in a sub-row, not a fabricated email', async () => {
    selectInstitution(null);
    signInPersonally();
    await render(<ProfileScreen />);

    expect(screen.getByText('reader@tf.com')).toBeTruthy();
    expect(screen.getByText('Individual account')).toBeTruthy();
  });

  it('drops the Institution section entirely — a personal session has none to scope', async () => {
    selectInstitution(OXFORD);
    signInPersonally();
    await render(<ProfileScreen />);

    expect(screen.queryByText('Institution')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change institution' })).toBeNull();
  });
});

describe('ProfileScreen institution, from the store', () => {
  it('renders the selected institution name', async () => {
    await render(<ProfileScreen />);
    expect(screen.getByText('University of Oxford')).toBeTruthy();
  });

  it('renders the crest when the institution has branding', async () => {
    await render(<ProfileScreen />);
    expect(screen.getByLabelText('University of Oxford logo')).toBeTruthy();
  });

  it('falls back to initials when the institution has no crest', async () => {
    selectInstitution(NO_CREST);
    await render(<ProfileScreen />);
    expect(screen.queryByLabelText('Deakin University logo')).toBeNull();
    expect(screen.getByText('DU')).toBeTruthy();
  });
});

describe('ProfileScreen change institution', () => {
  // Screen 06 is `InstitutionList` in the Catalogue stack — the route
  // CatalogueScreen's own picker pushes. Asserted by name so a rename in
  // navigation/types.ts cannot silently strand this row.
  it('pushes screen 06 from the Change institution row', async () => {
    await render(<ProfileScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'Change institution' }));
    expect(mockNavigate).toHaveBeenCalledWith('Catalogue', { screen: 'InstitutionList' });
  });

  it('pushes screen 06 from the institution row itself', async () => {
    await render(<ProfileScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'University of Oxford' }));
    expect(mockNavigate).toHaveBeenCalledWith('Catalogue', { screen: 'InstitutionList' });
  });
});

describe('ProfileScreen sign out', () => {
  afterEach(() => {
    mockDeleteRefreshToken.mockClear();
  });

  it('drops the institution selection and lands on the catalogue', async () => {
    await render(<ProfileScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));

    expect(useInstitutionStore.getState().selectedInstitution).toBeNull();
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('Catalogue', { screen: 'CatalogueHome' }),
    );
  });

  it('deletes the stored refresh token before navigating away', async () => {
    await render(<ProfileScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(mockDeleteRefreshToken).toHaveBeenCalledTimes(1));
  });

  it('leaves the recently-used list alone — it is a device history, not a session', async () => {
    await render(<ProfileScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(mockDeleteRefreshToken).toHaveBeenCalled());
    expect(useInstitutionStore.getState().recentlyUsedIds).toEqual(['inst_7f3']);
  });

  it('is not offered when there is nothing to sign out of', async () => {
    selectInstitution(null);
    await render(<ProfileScreen />);
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });
});

describe('ProfileScreen rows with nothing behind them', () => {
  // Drawn, not dropped — the screen 12 rule, still true, but the redesign
  // changed HOW it holds: these are `variant="static"` now, not a disabled
  // `variant="chevron"`/`variant="toggle"`. A static row is not Pressable at
  // all, so it never announces a button or switch role — there is no press
  // affordance to grey out or refuse. Full text and icon opacity is the
  // point of the redesign, so nothing here checks for dimming.
  //
  // 'Reading Preferences' and 'Accessibility' HAVE LEFT THIS LIST — both push
  // real, already-working screens and stay `variant="chevron"`; their own
  // tests sit in the describes below.
  const UNAVAILABLE = ['Download & Offline', 'Notifications', 'Privacy & Security', 'About T&F Reader'];

  it.each(UNAVAILABLE)('renders %s with no button or switch role', async (title) => {
    await render(<ProfileScreen />);
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.queryByRole('button', { name: title })).toBeNull();
    expect(screen.queryByRole('switch', { name: title })).toBeNull();
  });

  it('navigates nowhere when a static row is tapped', async () => {
    await render(<ProfileScreen />);
    for (const title of UNAVAILABLE) {
      fireEvent.press(screen.getByText(title));
    }
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('ProfileScreen reading preferences', () => {
  // The row was disabled until `ReaderPreferences` existed. These three are what
  // stop it silently reverting: it must be enabled, it must push, and it must
  // push THAT route by name — a rename in navigation/types.ts strands this row
  // otherwise, the same reason the Change institution tests assert by name.
  it('offers Reading Preferences as an enabled row', async () => {
    await render(<ProfileScreen />);
    const row = screen.getByRole('button', { name: 'Reading Preferences' });
    expect(row.props.accessibilityState.disabled).toBe(false);
  });

  it('pushes ReaderPreferences when the row is tapped', async () => {
    await render(<ProfileScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'Reading Preferences' }));
    // No params and no tab target: prefs are a per-user singleton, and the route
    // sits on this screen's own stack rather than in a sibling tab.
    expect(mockNavigate).toHaveBeenCalledWith('ReaderPreferences');
  });

  it('keeps its subtitle and chevron, so only the destination changed', async () => {
    await render(<ProfileScreen />);
    expect(screen.getByText('Themes, fonts, margins & layout')).toBeTruthy();
  });
});

describe('ProfileScreen accessibility', () => {
  // A separate row beside Reading Preferences, pushing a separate screen —
  // see the header comment on AccessibilityScreen.tsx for why the two are not
  // one screen with two sections.
  it('offers Accessibility as an enabled row', async () => {
    await render(<ProfileScreen />);
    const row = screen.getByRole('button', { name: 'Accessibility' });
    expect(row.props.accessibilityState.disabled).toBe(false);
  });

  it('pushes Accessibility when the row is tapped', async () => {
    await render(<ProfileScreen />);
    fireEvent.press(screen.getByRole('button', { name: 'Accessibility' }));
    // No params: accessibility prefs are a per-user singleton, same reasoning
    // as ReaderPreferences.
    expect(mockNavigate).toHaveBeenCalledWith('Accessibility');
  });

  it('shows its subtitle', async () => {
    await render(<ProfileScreen />);
    expect(screen.getByText('High contrast, text scaling & screen reader')).toBeTruthy();
  });
});
