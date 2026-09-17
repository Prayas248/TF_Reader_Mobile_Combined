// Owner: Sync (Karthik).
//
// TEMPORARY DEV SCAFFOLDING — mirrors download/devAuthToken.ts for the same reason: the real
// backend's `tf-app` resource-server chain rejects every `/api/v1/*` call with 401 UNAUTHENTICATED
// before routing even runs unless a bearer token is attached (API_CONTRACT_NOTES.md B1/C6;
// confirmed against tf_reader_backend_temp — every sync write 401s without this). Sync's
// syncConfig.ts has no mock-backend alternative the way download/config.ts does (API_BASE_URL is
// always the real backend), so this always applies — there is no AUTH_REQUIRED flag to gate it.
//
// Not imported from download/devAuthToken.ts: sync/ and download/ keep separately owned configs
// on purpose (see syncConfig.ts's header on the same duplication for API_BASE_URL), so each
// capability's own token client stays paired with its own base URL. Delete this file (and the
// getAuthToken() call in syncApi.ts's request()) once a real token source exists — same removal
// shape as download/devAuthToken.ts.

import { API_BASE_URL } from './syncConfig';
import { generateDeviceKeypair, publicKeyFingerprint } from '../encryption/deviceKeypair';

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

let cached: CachedToken | null = null;

// Refetch a little before the token's real expiry — see download/devAuthToken.ts's identical note.
const REFRESH_SKEW_MS = 30_000;

// Same fix, same reasoning as download/devAuthToken.ts's identical helper (duplicated rather than
// imported — see this file's header on sync/download keeping separately owned configs): the real
// dev-token endpoint defaults `userId` to the shared `usr_dev123` for every caller that omits it,
// so every device/teammate was colliding on one sync namespace. Deriving userId from this
// device's own already-stable key fingerprint gives each physical device its own identity
// instead.
async function devUserId(): Promise<string> {
  const { publicKey } = await generateDeviceKeypair();
  const fingerprint = await publicKeyFingerprint(publicKey);
  return `dev-${fingerprint.replace('sha256:', '')}`;
}

async function fetchDevToken(): Promise<CachedToken> {
  const userId = await devUserId();
  const response = await fetch(
    `${API_BASE_URL}/api/v1/auth/dev-token?userId=${encodeURIComponent(userId)}`,
    { method: 'POST' },
  );
  if (!response.ok) {
    throw new Error(`POST /api/v1/auth/dev-token responded ${response.status}`);
  }
  const body = (await response.json()) as { token: string; expiresAt: string };
  return { token: body.token, expiresAtMs: Date.parse(body.expiresAt) };
}

/**
 * The bearer token for every sync write against the real backend. Cached in memory until close
 * to expiry — callers do not need to know this is dev-only.
 */
export async function getAuthToken(): Promise<string> {
  if (cached && cached.expiresAtMs - REFRESH_SKEW_MS > Date.now()) {
    return cached.token;
  }
  cached = await fetchDevToken();
  return cached.token;
}

/**
 * Clears the cached token immediately. Called when the server rejects the current token with 401,
 * indicating it has been invalidated server-side (e.g., password changed on another device). Without
 * this, the app would continue using the rejected token until expiresAtMs elapses, blocking all sync
 * traffic silently.
 */
export function invalidateAuthToken(): void {
  cached = null;
}
