// Owner: Download (Abhinav).
//
// Download's OWN fail-loud error carrier — same shape as Encryption's ContentFailure
// (src/shared/contracts/errors.ts), but NOT added to that file: it's frozen and co-owned by
// Reader + Encryption, and none of its codes (INTEGRITY_FAILED, DECRYPTION_FAILED, ...) describe
// a download-side failure like "storage full" or "book limit reached". A ContentFailure the
// Encryption layer raises (e.g. from contentStore.store()) is left to bubble up UNWRAPPED by
// downloadManager.ts — it is already well-typed by its owning module, no need to double-wrap.
//
// bookId stays nullable on DownloadFailure's constructor for any future book-independent
// failure; every current call site happens to pass a real bookId now that REGISTRATION_FAILED
// (device-key provisioning, the one code that never had one) is gone — see the git history for
// that removal and src/features/download/API_CONTRACT_NOTES.md's finding B8.
//
// ADDITIONS 2026-08-14, for the real flambeau contract (reading-session.ts) — every member
// ABOVE this comment is untouched; nothing was renamed or removed. `LICENCE_FETCH_FAILED` and
// `fetchContentLicence`/`ContentLicenceResponse` (content-licence.ts) stay defined and exported,
// just unused by the new primary flow, per an explicit "don't remove functionality" instruction.
//
// LOAN_FAILED / SESSION_FETCH_FAILED are this app's own network/parse-failure codes (mirroring
// the shape of the old LICENCE_FETCH_FAILED, one per new network call). The rest are a DELIBERATE
// SUBSET of the real backend's own `FlambeauErrorCode` (reading-session.ts) — only the ones a
// caller here can actually act on differently get their own `DownloadError` member; the others
// (VALIDATION_FAILED, UNAUTHENTICATED, TOKEN_EXPIRED, FORBIDDEN_SCOPE,
// FORBIDDEN_INSTITUTION_MISMATCH, NOT_FOUND, NO_COPIES_AVAILABLE, LOAN_NOT_ACTIVE, OFFER_EXPIRED)
// fall back to the generic LOAN_FAILED/SESSION_FETCH_FAILED with the real `FlambeauError` attached
// as `cause` — nothing is silently swallowed, see readingSessionClient.ts.

export enum DownloadError {
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  INSUFFICIENT_STORAGE = 'INSUFFICIENT_STORAGE',
  BOOK_LIMIT_REACHED = 'BOOK_LIMIT_REACHED',
  LICENCE_FETCH_FAILED = 'LICENCE_FETCH_FAILED',
  ASSET_FETCH_FAILED = 'ASSET_FETCH_FAILED',
  CHECKSUM_MISMATCH = 'CHECKSUM_MISMATCH',
  // The book's decrypted size would exceed contentStore.ts's MAX_DECRYPTED_BYTES RAM budget, so
  // it could never be opened after download. Rejected BEFORE store() rather than after: a stored
  // oversized book burns one of the 5 offline slots and throws on every later decryptBook().
  BOOK_TOO_LARGE = 'BOOK_TOO_LARGE',

  // --- real flambeau contract, added 2026-08-14 ---
  /** POST /api/v1/loans failed at the network/parse level, or returned an error code with no
   * dedicated member below (see the fallback note above). */
  LOAN_FAILED = 'LOAN_FAILED',
  /** POST /api/v1/reading-sessions failed at the network/parse level, or ditto. */
  SESSION_FETCH_FAILED = 'SESSION_FETCH_FAILED',
  /** 403 NO_ENTITLEMENT — this institution/reader has no grant covering this book at all. */
  NO_ENTITLEMENT = 'NO_ENTITLEMENT',
  /** 403 ENTITLEMENT_EXPIRED — the grant has lapsed since it was checked at borrow time. */
  ENTITLEMENT_EXPIRED = 'ENTITLEMENT_EXPIRED',
  /** 403 ENTITLEMENT_SUSPENDED. */
  ENTITLEMENT_SUSPENDED = 'ENTITLEMENT_SUSPENDED',
  /** 403 INSTITUTION_INACTIVE — the institution's own account is suspended. */
  INSTITUTION_INACTIVE = 'INSTITUTION_INACTIVE',
  /** 403 DOWNLOAD_NOT_PERMITTED — an ELITE (copy-limited, online-only) title refused `intent:
   * DOWNLOAD`. `canPersist` on the loan already said so; this is the server enforcing it. */
  DOWNLOAD_NOT_PERMITTED = 'DOWNLOAD_NOT_PERMITTED',
  /** 403 DEVICE_LIMIT_REACHED — this reader is already reading on the maximum number of devices.
   * Not a revocation: entitlement is valid, but THIS device cannot read right now. The reader
   * can close another session to free a slot (fail-open does not apply — the server explicitly
   * refused this per-open attempt). See readingSessionClient.ts's FAIL_CLOSED_CODES comment. */
  DEVICE_LIMIT_REACHED = 'DEVICE_LIMIT_REACHED',
  /** 409 NO_ACTIVE_LOAN — a reading session was requested before borrowing (should not surface in
   * practice, since `downloadManager.ts`/`readingSessionClient.ts` always borrow first). */
  NO_ACTIVE_LOAN = 'NO_ACTIVE_LOAN',
  /** 409 CONTENT_NOT_READY — ingest hasn't finished on the server side yet. */
  CONTENT_NOT_READY = 'CONTENT_NOT_READY',

  // --- promoted out of the generic LOAN_FAILED/SESSION_FETCH_FAILED fallback, per
  // API_CONTRACT_NOTES.md's B10 — these three are actionable, not just informational. ---
  /** UNAUTHENTICATED — no valid credential at all. Distinct from TOKEN_EXPIRED: this means
   * re-authenticate from scratch, not just refresh. No caller reacts differently yet (auth
   * itself is unbuilt — B1), but the type exists so wiring it up later is additive, not a
   * breaking change to every existing switch on DownloadError. */
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  /** TOKEN_EXPIRED — the sole reason flambeau kept this code at all, over wokay's own objection
   * (API_CONTRACT_NOTES.md A1): the app must know to clear its keychain and re-authenticate,
   * which "access denied, try again" alone doesn't tell it. Same caveat as UNAUTHENTICATED
   * above — nothing acts on it yet, pending B1. */
  TOKEN_EXPIRED = 'TOKEN_EXPIRED',
  /** 409 NO_COPIES_AVAILABLE — a copy-limited (ELITE) title has none free. flambeau names the
   * hold queue endpoint specifically so the app can offer it as a choice instead of a dead end —
   * see API_CONTRACT_NOTES.md B5. The queue itself isn't built yet; this member exists so the UI
   * can at least say "join the waitlist" instead of a generic download failure. */
  NO_COPIES_AVAILABLE = 'NO_COPIES_AVAILABLE',
  /** `encryption.keyFingerprint` (the server's claim) disagrees with this device's own computed
   * key fingerprint — the anti-key-substitution check wokay's contract mandates
   * (API_CONTRACT_NOTES.md C7/B3). Raised in `downloadManager.ts`, BEFORE the asset fetch, not by
   * Encryption's `ContentFailure(LICENCE_INVALID)` — that check still runs too (defense in depth
   * for any caller that reaches `contentStore.store()` directly, e.g. `devContentSeed.ts`), but
   * for the real download path this member fails in milliseconds instead of after up to 25MB. */
  KEY_SUBSTITUTION = 'KEY_SUBSTITUTION',

  // --- offline fallback, added for the unified license gate (licenseCheck.ts) ---
  /** The device is offline and no persisted licence exists for this book (never downloaded, or the
   * licence was destroyed). Distinct from the server-side denial codes above: the server was never
   * contacted. A previously-downloaded book with a valid persisted licence succeeds via
   * `contentStore.getPersistedLicenceStatus()` instead — this code is specifically the "no local
   * fallback available" case. */
  OFFLINE_LICENSE_UNAVAILABLE = 'OFFLINE_LICENSE_UNAVAILABLE',
  /** 403 ENTITLEMENT_REVOKED — the entitlement has been administratively revoked (not merely
   * expired). The server-side licence is void; the local copy must be invalidated. Distinct from
   * ENTITLEMENT_EXPIRED: revocation is immediate and discretionary (a librarian pulled access back),
   * whereas expiry is a natural lapse of a time-bounded grant. The offline fallback's `is_valid`
   * check raises this on a pull-based revocation signal. */
  ENTITLEMENT_REVOKED = 'ENTITLEMENT_REVOKED',
  /** 503 SERVICE_UNAVAILABLE — a Redis/Mongo blip on the backend (GlobalExceptionHandler's
   * DataAccessException handler, added 2026-09-20). Transient and worth a plain retry, unlike
   * every denial code above — promoted out of the generic SESSION_FETCH_FAILED/LOAN_FAILED
   * fallback for the same reason DEVICE_LIMIT_REACHED etc. were: this name matches ErrorCode's
   * member exactly, so a WIRE_ERROR_COPY lookup by err.code finds real copy for it. */
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
}

export class DownloadFailure extends Error {
  readonly code: DownloadError;
  readonly bookId: string | null;
  readonly cause?: unknown;

  constructor(code: DownloadError, bookId: string | null, cause?: unknown) {
    super(`${code}${bookId ? ` for ${bookId}` : ''}`);
    this.name = 'DownloadFailure';
    this.code = code;
    this.bookId = bookId;
    this.cause = cause;
    // Preserve the prototype chain under downlevel targets so `instanceof` holds — same fix
    // ContentFailure applies, for the same reason.
    Object.setPrototypeOf(this, DownloadFailure.prototype);
  }
}

/**
 * readingSessionClient.ts's marker for "a `Response` came back, but its body didn't parse as a
 * `FlambeauError`" — used ONLY as the synthetic `cause` on that one fallback path, never thrown
 * or caught directly.
 *
 * WHY THIS EXISTS: licenseCheck.ts's `isGenuineNetworkError()` has to tell "the server answered
 * (even with a shape we don't recognise)" apart from "fetch/AbortController rejected before any
 * response arrived" — the whole reason the offline fallback exists is to trigger on the second
 * case only. It used to do this by checking `cause instanceof TypeError` (what the Fetch spec
 * documents for a network-level rejection) — confirmed by device testing, 2026-08-25, to be
 * unreliable: a genuine connection-refused on a real iOS simulator did not reliably produce that
 * exact constructor, so the offline fallback silently never fired for the one case it exists to
 * handle. This class makes the distinction explicit at the two throw sites that actually know it,
 * instead of trying to reverse-engineer it later from whatever error shape the platform's fetch
 * implementation happens to throw.
 */
export class UnmappedServerResponse extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnmappedServerResponse';
    Object.setPrototypeOf(this, UnmappedServerResponse.prototype);
  }
}
