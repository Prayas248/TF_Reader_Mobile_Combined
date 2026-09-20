// Institutional (SAML) sign-in — the seam SignInScreen calls.
//
// REAL, end to end. The flow:
//   1. POST /api/v1/auth/saml/start with institutionId/idpHint as query
//      params. `idpHint` comes from GET /api/v1/institutions/{id} →
//      signIn.idpHint, already fetched by the caller.
//   2. Open the returned authorizationUrl in a browser; the IdP redirects to
//      tfreader://auth/callback?code=... on completion.
//   3. POST /api/v1/auth/token to exchange the code for an access+refresh
//      token pair.
//   4. GET /api/v1/auth/me with the access token, to learn who signed in —
//      the token exchange alone carries no userId/roles/collections.
//   5. Write the access token and identity to sessionStore (in memory) and
//      the refresh token to secureStorage (Keychain/Keystore) — the split
//      the flambeau auth design calls for, same one sessionStore.ts documents.
import { ApiAuthClient, type TokenPair } from './ApiAuthClient';
import { getDefaultAuthClient } from './defaultAuthClient';
import { openSamlBrowser } from './openSamlBrowser';
import { getDeviceId, saveDeviceId, saveRefreshToken } from '@store/secureStorage';
import { useSessionStore } from '@store/sessionStore';

// `idpHint` is accepted because the request needs it, and is currently inert
// once it reaches flambeau — the live contract's own note is that the field
// is unused server-side too (one SAML integration serves every institution).
export interface InstitutionSignInParams {
  institutionId: string;
  idpHint?: string;
}

export interface BeginSamlSignInDeps {
  authClient?: ApiAuthClient;
  openBrowser?: typeof openSamlBrowser;
}

export async function beginSamlSignIn(
  { institutionId, idpHint }: InstitutionSignInParams,
  deps: BeginSamlSignInDeps = {},
): Promise<TokenPair> {
  const authClient = deps.authClient ?? getDefaultAuthClient();
  const openBrowser = deps.openBrowser ?? openSamlBrowser;

  // Echo back whatever deviceId THIS device was given on a previous sign-in — null on this
  // device's first-ever sign-in, which the backend already treats as "mint a new one".
  // Previously never read at all, so the backend never saw a returning device as anything
  // but new: every sign-in spent a fresh institutional seat, indefinitely.
  const deviceId = (await getDeviceId()) ?? undefined;
  const start = await authClient.startSamlSignIn({ institutionId, idpHint, deviceId });
  const code = await openBrowser(start.authorizationUrl);
  const tokenPair = await authClient.exchangeSignInCode(code);
  console.log('beginSamlSignIn: token pair received', tokenPair);
  if (tokenPair.deviceId !== undefined) {
    await saveDeviceId(tokenPair.deviceId);
  }

  const currentSession = await authClient.getCurrentSession(tokenPair.accessToken);
  console.log('beginSamlSignIn: current session received', currentSession);

  useSessionStore.getState().setSession({
    accessToken: tokenPair.accessToken,
    expiresIn: tokenPair.expiresIn,
    userId: currentSession.userId,
    institutionId: currentSession.institutionId,
    roles: currentSession.roles,
    collections: currentSession.collections,
  });
  await saveRefreshToken(tokenPair.refreshToken);
  console.log('beginSamlSignIn: session stored, sessionStore state is now', useSessionStore.getState());

  return tokenPair;
}
