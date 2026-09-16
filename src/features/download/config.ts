// Owner: Download (Abhinav).
//
// Mock-backend's own base URL — port 4000, NOT sync/config.ts's port-9000 Mongo backend. The two
// are different servers with unrelated routes (device-key/content-licence/signed-url/seat vs.
// api/v1/{entity} CRUD) — see docs/build-status.md's "network error on both platforms is
// expected" note. Download must not import sync/config.ts's API_BASE_URL; it would silently
// point at the wrong server.
//
// Same LAN-host-resolution reasoning as sync/config.ts: Expo Go/dev-client runs on a physical
// device or simulator, so "localhost" only resolves when the backend runs on the SAME machine
// Metro's own dev server reports as its host.
//
// MOCK ↔ REAL FLAG (added per API_CONTRACT_NOTES.md B2's narrower half — the switch mechanism,
// not the cross-capability base-URL unification, which stays undone; see that file). Flipping
// EXPO_PUBLIC_USE_REAL_BACKEND does NOT mean the real backend is safe to point at today: `B1`
// (no auth at all) means every real-backend call still 401s. This flag exists so that once `B1`
// and `C6` close, switching is one env var, not a code edit — it is a structural readiness change,
// not a claim of readiness.

import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { resolveHostForAndroidEmulator } from '@/config/androidHost';

const MOCK_BACKEND_PORT = 4000;
// Both published contracts (wokay + flambeau) specify this exact value for everyone — see
// API_CONTRACT_NOTES.md B2. Not configurable by port the way the mock is; a real deployment at a
// different host is expected to be reached via EXPO_PUBLIC_REAL_BACKEND_URL instead.
const REAL_BACKEND_PORT = 8080;

function resolveBackendHost(): string {
  const hostUri =
    Constants.expoConfig?.hostUri ??
    (Constants.expoGoConfig as { debuggerHost?: string } | undefined)?.debuggerHost ??
    '';

  const host = hostUri.split(':')[0];
  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    return host;
  }
  // hostUri gave nothing usable (empty, or itself localhost/127.0.0.1) — on an Android emulator
  // this must resolve to 10.0.2.2 (the documented emulator -> host alias), not 'localhost' (the
  // emulator's own loopback, where nothing listens). Same fix as syncConfig.ts's
  // resolveBackendHost — ported here because this copy was still missing it: confirmed live,
  // 2026-09-04, `nc 10.0.2.2 8080` connects from inside the emulator while `nc 127.0.0.1 8080` is
  // refused, and without this every real-backend call here failed as a genuine network error,
  // which checkLicense() then reported as OFFLINE_LICENSE_UNAVAILABLE for any book not already
  // downloaded.
  if (Platform.OS === 'android') return '10.0.2.2';
  return 'localhost';
}

/**
 * Override by setting EXPO_PUBLIC_MOCK_BACKEND_URL, e.g. http://192.168.1.20:4000
 *
 * Normalized through `resolveHostForAndroidEmulator` even when explicitly overridden — an
 * override value copied verbatim into .env from an iOS-only setup (a literal "localhost") would
 * otherwise bypass `resolveBackendHost()`'s own Android handling entirely.
 */
const MOCK_BACKEND_URL = resolveHostForAndroidEmulator(
  process.env.EXPO_PUBLIC_MOCK_BACKEND_URL ?? `http://${resolveBackendHost()}:${MOCK_BACKEND_PORT}`,
);

/**
 * Override by setting EXPO_PUBLIC_REAL_BACKEND_URL, e.g. http://192.168.1.20:8080
 *
 * Same `resolveBackendHost()` as the mock, not a hardcoded `localhost` — this used to be
 * hardcoded, and it is exactly the trap this file's header warns about: on an Android
 * emulator "localhost" is the EMULATOR'S OWN loopback (nothing listens on :8080 there), not
 * the host machine running the backend. Confirmed live: `nc localhost 8080` from inside the
 * emulator refuses; `nc 10.0.2.2 8080` (or the LAN host Metro reports) connects. Every
 * real-backend call failed with a genuine network error as a result, which `checkLicense()`
 * treats as offline and reports `OFFLINE_LICENSE_UNAVAILABLE` for any book not already
 * downloaded — indistinguishable from a real outage without checking this default. iOS
 * Simulator never showed this, because it shares the host's network namespace and
 * `localhost` there really does mean the host.
 *
 * Also normalized through `resolveHostForAndroidEmulator` when explicitly overridden — some
 * .env setups pin this to a literal `http://localhost:8080` on purpose (see .env's own comment:
 * it keeps this host matching the MinIO-signed asset URL's host so `reachableAssetUrl()`'s
 * same-host no-op branch fires). That reasoning is iOS-Simulator-specific; on Android it would
 * silently reintroduce the exact bug this comment describes, so the swap applies unconditionally.
 */
const REAL_BACKEND_URL = resolveHostForAndroidEmulator(
  process.env.EXPO_PUBLIC_REAL_BACKEND_URL ?? `http://${resolveBackendHost()}:${REAL_BACKEND_PORT}`,
);

/** Defaults to the mock — false unless explicitly set. Flip with EXPO_PUBLIC_USE_REAL_BACKEND=true. */
const USE_REAL_BACKEND = process.env.EXPO_PUBLIC_USE_REAL_BACKEND === 'true';

export const API_BASE_URL = USE_REAL_BACKEND ? REAL_BACKEND_URL : MOCK_BACKEND_URL;

// The mock backend has no auth at all (see B1) and no `/api/v1/auth/*` routes, so attaching a
// bearer token there would just add a header nobody checks. Real-backend calls DO get rejected
// (401 UNAUTHENTICATED) without one — see devAuthToken.ts. Exported rather than duplicating the
// `EXPO_PUBLIC_USE_REAL_BACKEND` read, so the two never drift apart.
export const AUTH_REQUIRED = USE_REAL_BACKEND;
