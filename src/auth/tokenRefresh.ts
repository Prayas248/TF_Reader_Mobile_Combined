// src/auth/tokenRefresh.ts
// Keeps the access token fresh two ways: reactively, on demand right before
// an authenticated call needs one (ensureFreshToken), and proactively, once
// at app boot (bootstrapAuth). Both go through ensureFreshToken so there is
// exactly one place that decides whether a refresh is worth making and
// exactly one place that calls the refresh endpoint.
import { getToken, useSessionStore } from '@store/sessionStore';
import { useInstitutionStore } from '@store/institutionStore';
import { getRefreshToken, saveDeviceId, saveRefreshToken } from '@store/secureStorage';
import { setLicenceToken } from '@/config/licence';
import { AuthError, AuthFailure } from './AuthFailure';
import { getDefaultAuthClient } from './defaultAuthClient';
import type { ApiAuthClient, TokenPair } from './ApiAuthClient';

export interface EnsureFreshTokenDeps {
  authClient?: ApiAuthClient;
  // Set only by bootstrapAuth's one-shot boot-time check — see the note on
  // the REFUSED branch below for why this must not default on for every
  // on-demand call.
  clearInstitutionOnRefusal?: boolean;
}

// Concurrent callers (an auth-dependent call and a licence call landing in
// the same tick, say) must share one in-flight refresh rather than each
// starting their own. The refresh token always rotates, so a second,
// independent refresh would hand the endpoint a refresh token the first
// call already burned — that gets refused, and clears a session that was
// actually fine seconds earlier.
let inFlightRefresh: Promise<string | undefined> | null = null;

export async function ensureFreshToken(
  deps: EnsureFreshTokenDeps = {},
): Promise<string | undefined> {
  const currentToken = await getToken();
  if (currentToken !== undefined) {
    console.log('ensureFreshToken: current token is still valid, no refresh needed');
    return currentToken;
  }

  if (inFlightRefresh !== null) {
    console.log('ensureFreshToken: a refresh is already in flight, waiting on it');
    return inFlightRefresh;
  }

  console.log('ensureFreshToken: token missing/expired, starting a refresh');
  inFlightRefresh = refreshFromStoredToken(deps);
  try {
    return await inFlightRefresh;
  } finally {
    inFlightRefresh = null;
  }
}

async function refreshFromStoredToken(
  deps: EnsureFreshTokenDeps,
): Promise<string | undefined> {
  const storedRefreshToken = await getRefreshToken();
  if (storedRefreshToken === null) {
    console.log('ensureFreshToken: no refresh token in secure storage, clearing session');
    useSessionStore.getState().clearSession();
    return undefined;
  }

  const authClient = deps.authClient ?? getDefaultAuthClient();

  try {
    const tokenPair = await authClient.refreshSession(storedRefreshToken);
    console.log('ensureFreshToken: refresh succeeded, new token expires in', tokenPair.expiresIn, 's');
    await applyRefreshedToken(tokenPair, authClient);
    return tokenPair.accessToken;
  } catch (error) {
    // A network blip or timeout is not proof the refresh token is invalid —
    // only a genuine REFUSED (or a response we can't even parse) means the
    // token itself is bad. Clearing the session on a transient failure was
    // forcing a full sign-in from a dropped connection with a perfectly good
    // refresh token still sitting in secure storage.
    const isTransient =
      error instanceof AuthFailure &&
      (error.code === AuthError.NETWORK_UNAVAILABLE || error.code === AuthError.TIMEOUT);
    if (isTransient) {
      console.log('ensureFreshToken: refresh failed transiently, leaving session intact', error);
      return undefined;
    }
    console.log('ensureFreshToken: refresh was refused, clearing session', error);
    useSessionStore.getState().clearSession();
    // Only bootstrapAuth's one-shot boot check sets this. ensureFreshToken is
    // also called on demand by every authenticated request (catalogue fetches,
    // licence checks) for as long as the same dead refresh token sits in
    // secure storage — which is exactly the case while a reader is picking a
    // NEW institution to sign in to (institutionSignIn.ts hasn't overwritten
    // the old refresh token yet). Clearing selectedInstitution on every one of
    // those calls wiped out the institution the reader had just picked mid
    // sign-in, and SignInScreen's `if (!institution) navigation.goBack()`
    // guard bounced them straight back to the method chooser with no browser
    // ever opening. Restricted to the boot check, this still fixes the
    // original bug it was added for (Profile showing "Not signed in" next to a
    // stale institution and a still-visible Sign out row after a session died
    // silently while the app was closed) without touching institution
    // selection made during the app's normal, later lifetime.
    if (deps.clearInstitutionOnRefusal === true) {
      useInstitutionStore.getState().clearSelectedInstitution();
    }
    return undefined;
  }
}

// refreshSession() returns only {accessToken, refreshToken, expiresIn} — no
// identity. If the store already knows who's signed in (the normal
// in-session case), reuse that identity rather than asking again. Identity
// is only ever missing right after a cold boot, before anything has loaded
// it this process — that's the one case worth an extra getCurrentSession call.
async function applyRefreshedToken(
  tokenPair: TokenPair,
  authClient: ApiAuthClient,
): Promise<void> {
  // Saved first, before anything below that can still fail: refreshSession()
  // already rotated the token server-side by the time this runs, so the old
  // refresh token is already dead. If getCurrentSession times out below, the
  // caller's catch must not wipe the session out from under a refresh token
  // that was never written down.
  await saveRefreshToken(tokenPair.refreshToken);
  // The backend re-confirms this device's id on every refresh too (AuthController.java's
  // `/refresh` returns the same TokenResponse shape as `/token`) — keep it current here as
  // well, not just at the initial SAML sign-in, so a device's stored id can never drift out
  // of sync with what the backend actually issued.
  if (tokenPair.deviceId !== undefined) {
    await saveDeviceId(tokenPair.deviceId);
  }

  const existing = useSessionStore.getState();

  if (existing.userId !== null) {
    const institutionId = existing.institutionId === null ? undefined : existing.institutionId;
    useSessionStore.getState().setSession({
      accessToken: tokenPair.accessToken,
      expiresIn: tokenPair.expiresIn,
      userId: existing.userId,
      institutionId,
      roles: existing.roles,
      collections: existing.collections,
    });
  } else {
    const currentSession = await authClient.getCurrentSession(tokenPair.accessToken);
    useSessionStore.getState().setSession({
      accessToken: tokenPair.accessToken,
      expiresIn: tokenPair.expiresIn,
      userId: currentSession.userId,
      institutionId: currentSession.institutionId,
      roles: currentSession.roles,
      collections: currentSession.collections,
    });
  }
}

export interface BootstrapAuthDeps {
  authClient?: ApiAuthClient;
}

export async function bootstrapAuth(deps: BootstrapAuthDeps = {}): Promise<void> {
  // Wired here, not at module scope: a bare top-level setLicenceToken(...)
  // call used to run the instant ANYTHING imported this file — including
  // tests with no interest in auth at all, which mock '@config/licence' for
  // their own reasons and don't supply setLicenceToken in that mock, and
  // crashed on import as a result. Calling it here means it only ever runs
  // when bootstrapAuth is actually invoked (real app boot, or a test that
  // deliberately calls it), and it's idempotent — safe to call every time
  // bootstrapAuth runs, which is once, at app start.
  setLicenceToken(ensureFreshToken);

  console.log('bootstrapAuth: starting boot-time token check');
  await ensureFreshToken({ ...deps, clearInstitutionOnRefusal: true });
  console.log('bootstrapAuth: done, isAuthenticated =', useSessionStore.getState().isAuthenticated);
  useSessionStore.getState().setAuthReady(true);
}
