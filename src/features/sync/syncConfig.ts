import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { resolveHostForAndroidEmulator } from '@/config/androidHost';

/**
 * Fixed prototype identity. Every local record and every synced record uses
 * these two values - no random ids anywhere. Overridable so the verification
 * harness can run against its own user without touching the app's data.
 */
export const USER_ID = process.env.EXPO_PUBLIC_USER_ID ?? 'user-001';
export const BOOK_ID = process.env.EXPO_PUBLIC_BOOK_ID ?? 'book-001';

// Was 9000 (a separate Mongo CRUD service) until the real backend consolidated onto one server -
// tf_reader_backend_temp on 8080 now serves BOTH api/v1/{entity} CRUD and Download's
// device-key/content-licence/signed-url/seat routes. Download's config.ts still has its own
// REAL_BACKEND_PORT = 8080 for the same server; that duplication is real (see this file's own
// resolveBackendHost, which already does correct LAN-host resolution that Download's hardcoded
// `localhost` fallback does not), and is worth a shared constant later, not fixed in this change.
const BACKEND_PORT = 8080;

/**
 * The book file and the pdf.js runtime are static resources, not CRUD, and the
 * Mongo backend does not serve them - `/api/books/{id}/file` is a 404 on 8080.
 * Until it does, they come from the old Spring app on 8090. Once the Mongo
 * service picks them up, set this to BACKEND_PORT and the SQLite backend can go.
 */
const ASSET_PORT = 8090;

/**
 * Expo Go runs on a physical device, so "localhost" would mean the phone itself.
 * The dev server's own LAN address is the machine running the backend, so we
 * reuse it and just swap the port.
 */
function resolveBackendHost(): string {
  const hostUri =
    Constants.expoConfig?.hostUri ??
    (Constants.expoGoConfig as { debuggerHost?: string } | undefined)?.debuggerHost ??
    '';

  const host = hostUri.split(':')[0];
  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    return host;
  }
  // hostUri gave nothing usable (empty, or itself localhost/127.0.0.1) - on a physical device or
  // the iOS simulator that correctly means the dev machine itself. An ANDROID EMULATOR is its own
  // VM though: "localhost" there is the emulator, not the host machine, and no hostUri lookup can
  // ever produce the host's real address from inside it - 10.0.2.2 is the documented emulator ->
  // host alias, not a value that comes from resolving anything. Confirmed 2026-08-26: without this,
  // sync silently posts into a black hole on the emulator (outbox never drains) while the same code
  // works fine on a physical device or iOS sim, because on those the hostUri branch above already
  // returns a real, reachable address.
  if (Platform.OS === 'android') return '10.0.2.2';
  return 'localhost';
}

/**
 * Override by setting EXPO_PUBLIC_API_URL, e.g. http://192.168.1.20:8080
 *
 * Normalized through `resolveHostForAndroidEmulator` even when explicitly overridden, so an
 * override copied from an iOS-only .env setup (a literal "localhost") can't silently bypass
 * `resolveBackendHost()`'s own Android handling above.
 */
export const API_BASE_URL = resolveHostForAndroidEmulator(
  process.env.EXPO_PUBLIC_API_URL ?? `http://${resolveBackendHost()}:${BACKEND_PORT}`,
);

/** Every CRUD collection lives under this prefix on the Mongo backend. */
export const API_V1 = '/api/v1';

/** Point EXPO_PUBLIC_ASSET_URL at whatever serves the book - see ASSET_PORT. */
export const ASSET_BASE_URL =
  process.env.EXPO_PUBLIC_ASSET_URL ?? `http://${resolveBackendHost()}:${ASSET_PORT}`;

/**
 * Set to true once the Mongo services compare `updatedAt` on write and answer
 * 409 when their copy is newer. Until then the device does the comparison
 * itself with a GET before each push, so a stale offline edit cannot overwrite
 * a newer server record.
 */
export const SERVER_RESOLVES_CONFLICTS = false;

/**
 * The Mongo services overwrite `updatedAt` with their own clock on every write:
 * a highlight made offline on Monday and pushed on Thursday is stored as
 * Thursday. The device therefore adopts whatever the server echoes back instead
 * of keeping its own guess - see `adoptPushResult`. Set to false if the request
 * DTOs are changed to store the timestamp as sent, which is the more faithful
 * Last-Write-Wins.
 */
export const SERVER_STAMPS_UPDATED_AT = true;

/**
 * Set to true once the collection GETs accept `?updatedAfter=<iso>`. Until then
 * a pull fetches every record for the user and relies on Last-Write-Wins to
 * discard what the device already has.
 */
export const SUPPORTS_UPDATED_AFTER = false;

/**
 * `PersonalizationRequest` rejects a body without `bookId`, even though
 * personalization is user scoped in the local schema. Until that validation is
 * relaxed the mapper sends {@link BOOK_ID} to satisfy it; nothing reads it back.
 */
export const PERSONALIZATION_REQUIRES_BOOK_ID = true;

/** A validation failure is retried this many times before the op is parked as DEAD. */
export const MAX_PUSH_RETRIES = 6;

/** How long a single network call may take before we treat the device as offline. */
export const REQUEST_TIMEOUT_MS = 8000;

/**
 * How long a local write waits, with no further write arriving, before it triggers a sync run -
 * see syncTrigger.ts. Long enough that a burst of writes to the same record (e.g. a page turn on
 * every relocate while flipping through a book) collapses into one run instead of one per write;
 * short enough that a single bookmark/highlight/prefs edit still reaches the server promptly
 * without waiting for the next connectivity edge (useAutoSync.ts) or app restart.
 */
export const PUSH_ON_ENQUEUE_DEBOUNCE_MS = 1500;
