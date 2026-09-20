// Owner: Download (Abhinav).
//
// Real flambeau contract client — `POST /api/v1/loans` (borrow) and `POST /api/v1/reading-sessions`
// (permission to fetch bytes right now), replacing `contentLicenceClient.ts`'s
// `fetchContentLicence` as the primary flow. See `src/shared/contracts/reading-session.ts`'s
// header for the full loan-vs-session distinction and why a loan step exists here at all with no
// borrow UI anywhere in this repo.
//
// `fetchEncryptedAsset` is NOT duplicated here — it's generic over (bookId, url) and has no
// dependency on the OLD `ContentLicenceResponse` shape, so it's re-exported from
// `contentLicenceClient.ts` unchanged (including its `reachableAssetUrl` localhost-rewrite, which
// applies identically to a `SignedUrl.url` from this new flow).
//
// Both functions throw `DownloadFailure`, never a bare fetch/TypeError or a raw `FlambeauError` —
// same rule `contentLicenceClient.ts` follows, so `downloadManager.ts` (and any future caller)
// only ever switches on `.code`.

import type { BookId, BorrowRequest, Loan, ReadingFormat, ReadingSessionRequest, ReadingSessionResponse, FlambeauError } from '@/shared/contracts';
import { generateDeviceKeypair, publicKeyToRawBase64 } from '../encryption/deviceKeypair';
import { ensureFreshToken } from '@/auth/tokenRefresh';
import { API_BASE_URL, AUTH_REQUIRED } from './config';
import { DownloadError, DownloadFailure, UnmappedServerResponse } from './errors';

// Real-backend calls need a bearer token or the `tf-app` resource-server chain 401s before
// routing runs. The mock backend has no `/api/v1/auth/*` routes at all, so this must stay
// conditional on AUTH_REQUIRED rather than always fetching one.
//
// PREVIOUSLY: a `devAuthToken.ts` dev-only helper minted a token for a hardcoded identity
// (`usr_dev123`), completely disconnected from whoever actually signed in. Every open/borrow
// through this path spent that fake identity's own seat on any ELITE title — a title with only
// 2 copies (like `dev-sample-audio-encrypted`) was permanently exhausted between that identity
// and whatever the real signed-in user separately borrowed via ItemDetailScreen's own flow,
// with the dev-token loans never returned by anything (see this file's own missing release
// logic). `ensureFreshToken()` is the same real-session token source every other authenticated
// call in the app already uses (config/catalogue.ts, config/search.ts) — this now shares the
// real identity, real seat, and real returnLoan path with the rest of the app instead of a
// second, disconnected one.
async function authHeaders(): Promise<Record<string, string>> {
  if (!AUTH_REQUIRED) {
    return {};
  }
  const token = await ensureFreshToken();
  return token !== undefined ? { Authorization: `Bearer ${token}` } : {};
}

export { fetchEncryptedAsset } from './contentLicenceClient';

// React Native's `fetch` has no default timeout: a host that accepts the TCP connection and then
// never answers (dead proxy, captive portal, a firewall silently dropping packets) leaves `await
// fetch(...)` pending forever, and the fail-open catch in `verifyReadingAccess` below can only run
// once the call actually rejects. Same abort-controller-plus-timer shape as `sync/syncApi.ts`'s
// `request()` — not imported from there, since `sync/` and `download/` are separately owned
// modules with their own configs (see `config.ts`'s header on why `download/` never reaches into
// `sync/config.ts`).
//
// WAS 8000 — too tight specifically for `openReadingSession`'s POST /api/v1/reading-sessions,
// which for a copy-limited ELITE title does real work server-side in one call: entitlement
// check, a Redis copy-lease claim, a Mongo loan write, AND (for encrypted content) an RSA-OAEP
// key wrap to THIS device's real public key plus a signed asset URL from object storage. A
// timeout here doesn't surface as a clean, specific error — the abort makes `fetch` itself
// reject, which this file's own catch maps to the generic SESSION_FETCH_FAILED with no error
// code at all, indistinguishable from a genuine backend refusal. 20s matches ReaderScreen.tsx's
// own OPEN_TIMEOUT_MS budget for the whole "open a book" user action, which this call is one
// part of. See queue audit, 2026-09-20.
const REQUEST_TIMEOUT_MS = 20_000;

// A DELIBERATE SUBSET of FlambeauErrorCode gets its own DownloadError member (errors.ts) — only
// the ones a caller here can react to differently. Everything else falls back to the generic
// per-endpoint code with the real FlambeauError attached as `cause`, so nothing is silently lost.
const LOAN_ERROR_CODE_MAP: Partial<Record<FlambeauError['code'], DownloadError>> = {
  NO_ENTITLEMENT: DownloadError.NO_ENTITLEMENT,
  ENTITLEMENT_EXPIRED: DownloadError.ENTITLEMENT_EXPIRED,
  ENTITLEMENT_SUSPENDED: DownloadError.ENTITLEMENT_SUSPENDED,
  INSTITUTION_INACTIVE: DownloadError.INSTITUTION_INACTIVE,
  // Promoted per API_CONTRACT_NOTES.md B10 — on the LOAN map (not just SESSION's) since either
  // endpoint can fail auth once auth exists (B1), and SESSION_ERROR_CODE_MAP spreads this map in.
  UNAUTHENTICATED: DownloadError.UNAUTHENTICATED,
  TOKEN_EXPIRED: DownloadError.TOKEN_EXPIRED,
  // 409 on borrow only, but harmless to include here even before it's reachable from a session.
  NO_COPIES_AVAILABLE: DownloadError.NO_COPIES_AVAILABLE,
};

const SESSION_ERROR_CODE_MAP: Partial<Record<FlambeauError['code'], DownloadError>> = {
  ...LOAN_ERROR_CODE_MAP,
  DOWNLOAD_NOT_PERMITTED: DownloadError.DOWNLOAD_NOT_PERMITTED,
  DEVICE_LIMIT_REACHED: DownloadError.DEVICE_LIMIT_REACHED,
  NO_ACTIVE_LOAN: DownloadError.NO_ACTIVE_LOAN,
  CONTENT_NOT_READY: DownloadError.CONTENT_NOT_READY,
  SERVICE_UNAVAILABLE: DownloadError.SERVICE_UNAVAILABLE,
};

// Reads the real Error envelope (reading-session.ts's FlambeauError) off a non-ok response, if the
// body is shaped that way. Deliberately tolerant: a malformed/empty error body must not throw a
// SECOND, confusing error out of this helper — it just means the map lookup below misses and the
// caller gets the generic fallback code instead, with whatever we could parse (or nothing) as cause.
async function tryParseFlambeauError(response: Response): Promise<FlambeauError | null> {
  try {
    const body = (await response.json()) as unknown;
    if (body && typeof body === 'object' && 'code' in body) {
      return body as FlambeauError;
    }
  } catch {
    // not JSON, or not this shape — fall through to null.
  }
  return null;
}

/**
 * `POST /api/v1/loans` — take possession of a title. Idempotent by the real contract's own design:
 * a reader who already holds this title gets 200 with the existing loan, not an error.
 *
 * Called by `downloadManager.ts` as the FIRST step of every download, silently — this repo has no
 * borrow UI/screen anywhere (see reading-session.ts's header for why that's a pragmatic stand-in,
 * not a claim that Download owns borrowing).
 */
export async function borrowLoan(bookId: BookId): Promise<Loan> {
  const body: BorrowRequest = { itemId: bookId };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/v1/loans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause) {
    throw new DownloadFailure(DownloadError.LOAN_FAILED, bookId, cause);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const flambeauError = await tryParseFlambeauError(response);
    const mapped = flambeauError ? LOAN_ERROR_CODE_MAP[flambeauError.code] : undefined;
    throw new DownloadFailure(
      mapped ?? DownloadError.LOAN_FAILED,
      bookId,
      flambeauError ?? new UnmappedServerResponse(`POST /api/v1/loans responded ${response.status}`),
    );
  }

  return (await response.json()) as Loan;
}

/**
 * `POST /api/v1/reading-sessions` — permission to fetch bytes right now (~5 minutes). Re-checks
 * entitlement every single call, by design (the real contract's own words: "a subscription can
 * lapse between [borrow and read], and the second check is the only thing standing between a
 * revoked institution and a decryption key").
 *
 * @param intent - 'DOWNLOAD' persists the asset locally; refused server-side for ELITE regardless
 *   of what the caller asked for. 'STREAM' is the lighter-weight "just let me read this now" check
 *   — used for the per-open re-verification of an already-downloaded book (see ReaderScreen.tsx).
 */
export async function openReadingSession(
  bookId: BookId,
  request: Omit<ReadingSessionRequest, 'itemId'>,
): Promise<ReadingSessionResponse> {
  const body: ReadingSessionRequest = { itemId: bookId, ...request };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/v1/reading-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause) {
    throw new DownloadFailure(DownloadError.SESSION_FETCH_FAILED, bookId, cause);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const flambeauError = await tryParseFlambeauError(response);
    const mapped = flambeauError ? SESSION_ERROR_CODE_MAP[flambeauError.code] : undefined;
    throw new DownloadFailure(
      mapped ?? DownloadError.SESSION_FETCH_FAILED,
      bookId,
      flambeauError ?? new UnmappedServerResponse(`POST /api/v1/reading-sessions responded ${response.status}`),
    );
  }

  return (await response.json()) as ReadingSessionResponse;
}

// Fail-open / fail-closed policy for verifyReadingAccess below. The real contract's own design
// conversation doesn't resolve what a per-open call should do with NO network — flagged as an
// open question in this directory's `API_CONTRACT_NOTES.md` (`B7`: "call on every open doesn't
// say what happens reopening an already-downloaded book offline") — so this is a deliberate,
// documented choice, not an oversight. A reader must not lose access to a book already sitting on their
// device just because they're offline right now, or because this mock backend's in-memory loan
// state didn't survive a restart. Fail CLOSED only for the codes that mean the server explicitly,
// successfully told us this reader cannot proceed: genuine access revocations (NO_ENTITLEMENT,
// ENTITLEMENT_EXPIRED, ENTITLEMENT_SUSPENDED, INSTITUTION_INACTIVE) AND device-limit concurrency
// refusals (DEVICE_LIMIT_REACHED — reader is already reading on the max number of devices, so
// THIS device cannot read right now). See API_CONTRACT_NOTES.md B7. Never fail closed for
// network-level failures, and never for NO_ACTIVE_LOAN/CONTENT_NOT_READY (state-not-found reads
// as "can't confirm", not "confirmed denied").
//
// Exported — reused by `licenseCheck.ts` for the same online-fail-closed logic, so the set
// stays defined in ONE place.
export const FAIL_CLOSED_CODES: ReadonlySet<DownloadError> = new Set([
  DownloadError.NO_ENTITLEMENT,
  DownloadError.ENTITLEMENT_EXPIRED,
  DownloadError.ENTITLEMENT_SUSPENDED,
  DownloadError.INSTITUTION_INACTIVE,
  DownloadError.DEVICE_LIMIT_REACHED,
  // DOWNLOAD_NOT_PERMITTED: an ELITE title refused intent:DOWNLOAD. The loan already said
  // canPersist: false, and the server enforced it. This device cannot download this book —
  // fail closed rather than fall through to the offline fallback, which would mask the real
  // problem with a stale local licence (or OFFLINE_LICENSE_UNAVAILABLE for a never-downloaded
  // book). Added for the unified license gate (licenseCheck.ts).
  DownloadError.DOWNLOAD_NOT_PERMITTED,
]);

/**
 * Per-book-OPEN access re-verification — NOT per-download. This is the real contract's own
 * headline behavior (reading-session.ts's header): "entitlement is re-checked... because a
 * subscription can lapse between borrow and read." Requests a lightweight `'STREAM'` session
 * (never `'DOWNLOAD'` — this never persists anything, it only asks "am I still allowed to read
 * this right now").
 *
 * Called from `readerAssets.ts`'s `getBookBase64()`, ahead of every decrypt — including for a
 * book already fully downloaded and stored. FAILS OPEN for anything that isn't an explicit
 * server-side denial (see `FAIL_CLOSED_CODES` above): resolves silently, allowing the read to
 * proceed against the already-persisted ciphertext exactly as before this existed. REJECTS for
 * codes in `FAIL_CLOSED_CODES` — that set includes genuine access revocations (NO_ENTITLEMENT,
 * ENTITLEMENT_EXPIRED, ENTITLEMENT_SUSPENDED, INSTITUTION_INACTIVE) AND DEVICE_LIMIT_REACHED
 * (reader is at their device limit on *this* device, a concurrency refusal not a revocation, but
 * still fail-closed: this device cannot read right now). See API_CONTRACT_NOTES.md B7 for the
 * rationale — the caller should treat a DEVICE_LIMIT_REACHED as fatal to this per-open attempt.
 *
 * RETURNS whether this was a GENUINE server confirmation (`true`) or a fail-open (`false`) —
 * added for `readingAccessMonitor.ts`'s online-licence-rollover call, which must only bump
 * `lastValidatedAt` on a real "yes, still allowed", never on "couldn't tell, allowing anyway".
 * Existing callers (`readerAssets.ts`) that only `await` this for its side effect are unaffected —
 * `void` widened to `boolean` is not a breaking change for a caller that ignores the result.
 */
export async function verifyReadingAccess(bookId: BookId, format: ReadingFormat): Promise<boolean> {
  try {
    // Deliberately INSIDE the try, not above it: this fails open on the same terms as the
    // network call below. Found in review — with this call outside the try, a keychain hiccup
    // (device just booted and not yet unlocked, or `generateDeviceKeypair`'s own "keychain
    // rejected storing the private key" throw on a first-ever call) escaped uncaught, turning a
    // transient local error into "I lost my book" for content already sitting on the device —
    // exactly the harm this function's fail-open policy exists to prevent.
    const { publicKey } = await generateDeviceKeypair();
    await openReadingSession(bookId, {
      format,
      intent: 'STREAM',
      devicePublicKey: publicKeyToRawBase64(publicKey),
      wantSearchIndex: false,
    });
    return true;
  } catch (cause) {
    if (cause instanceof DownloadFailure && FAIL_CLOSED_CODES.has(cause.code)) {
      throw cause;
    }
    // Fail open — see the policy comment above. Logged, not swallowed silently, so a genuinely
    // unreachable backend is still visible somewhere.
    console.warn(
      `readingSessionClient: per-open access re-verification failed for ${bookId}, allowing the read (fail-open)`,
      cause,
    );
    return false;
  }
}
