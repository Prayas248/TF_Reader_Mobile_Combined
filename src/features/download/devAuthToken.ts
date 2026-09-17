// Owner: Download (Abhinav).
//
// TEMPORARY DEV SCAFFOLDING — stands in for the real sign-in flow, which does not exist yet (see
// API_CONTRACT_NOTES.md B1: no auth flow client-side; C6: the SAML-browser-round-trip token
// handoff is still an open question for another team). Until one of those lands, every real-
// backend call needs SOME bearer token or the `tf-app` resource-server chain refuses it with
// 401 UNAUTHENTICATED before routing even runs — confirmed against tf_reader_backend_temp,
// 2026-08-23.
//
// The real backend ships its own dev-only shortcut for exactly this gap:
// `POST /api/v1/auth/dev-token` (tf_reader_backend_temp's AuthController.java), which mints a
// real signed access token with no credential at all. This module is nothing but a thin, cached
// client for that one endpoint. It has no mock-backend equivalent and must never be called when
// `AUTH_REQUIRED` (config.ts) is false — the mock has no `/api/v1/auth/*` routes at all.
//
// Delete this file (and the `getAuthToken()` call sites in readingSessionClient.ts) once a real
// token source exists — same removal shape as devContentSeed.ts.

import { API_BASE_URL } from './config';
import { generateDeviceKeypair, publicKeyFingerprint } from '../encryption/deviceKeypair';

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

let cached: CachedToken | null = null;

// Refetch a little before the token's real expiry, not exactly at it — a token that expires
// mid-flight (between this check and the server receiving the request) fails the same way a
// network blip would, so a small margin trades a handful of extra dev-token calls for one fewer
// class of flaky failure.
const REFRESH_SKEW_MS = 30_000;

// The real dev-token endpoint (tf_reader_backend_temp's TempDevAuthController) defaults `userId`
// to the SAME shared `usr_dev123` for every caller that omits it — every device and every
// teammate testing against this backend was colliding on that one account's identity, including
// its per-user ELITE device cap (5, DeviceCapService) and its sync namespace. The seed data
// starts that shared account 4/5 full specifically so a manual tester could immediately exercise
// the cap, and it is now exhausted for good (no self-heal on retry, only a 90-day stale-device
// prune). Deriving userId from this device's own already-stable key fingerprint
// (deviceKeypair.ts, also used for the anti-key-substitution check) gives each physical device
// its own account instead, at no extra cost — the fingerprint already exists and is already
// stable across app restarts.
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
 * The bearer token for every authenticated download/reading-session call against the real
 * backend. Cached in memory until close to expiry — callers do not need to know this is dev-only.
 */
export async function getAuthToken(): Promise<string> {
  if (cached && cached.expiresAtMs - REFRESH_SKEW_MS > Date.now()) {
    return cached.token;
  }
  cached = await fetchDevToken();
  return cached.token;
}
