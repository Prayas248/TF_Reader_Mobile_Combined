// src/shared/contracts/reading-session.ts
// Real flambeau backend contract — Loans + Reading sessions. CAP-7 Reader & Offline (t4targaryen)
//
// Owner: Download + Encryption (Abhinav).
//
// Added 2026-08-14, replacing content-licence.ts's mock-shaped `GET /books/:id/content-licence`
// as the PRIMARY flow, against team flambeau's real, published OpenAPI spec
// (https://deepu1004.github.io/flambeau-api-contracts/, `x-stability: FROZEN` on every endpoint
// modeled here). `content-licence.ts` is left in place, untouched, per an explicit "don't remove
// functionality" instruction — nothing in this file deletes it, and downloadManager.ts's switch
// to this file's shapes doesn't remove `fetchContentLicence`/`ContentLicenceResponse` from the
// codebase, just stops calling them from the main flow.
//
// TWO REAL ENDPOINTS, TWO REAL OBJECTS — do not conflate them:
//   - A LOAN is possession, lasts ~2 weeks, written once per book (`POST /api/v1/loans`).
//   - A READING SESSION is permission to fetch bytes RIGHT NOW, lasts ~5 minutes, requested once
//     per book OPEN — download or read — never taking a lease itself (`POST /api/v1/reading-sessions`).
// Confusing the two is, per the spec's own words, "the most common design mistake in this system."
// `Loan.canPersist` (not tier, not licenceModel) is what actually gates whether `intent: DOWNLOAD`
// will be honoured — the server refuses it for ELITE regardless of what the UI offered.
//
// THERE IS NO BORROW STEP ON THE REAL BACKEND — `POST /api/v1/loans` DOES NOT EXIST (confirmed
// against `tf_reader_backend_temp`: only `GET /api/v1/loans`, a list, is mapped; `POST` 405s).
// `LoanController.java`'s own javadoc: "a licence is created when a reading session opens (D-020),
// not by a call to this controller." `BorrowRequest`/`borrowLoan()` below are kept for the mock
// backend and for any published contract that still describes a separate borrow step, but
// `checkLicense.ts` (download/) no longer calls them — `licenceId`/`licenceModel`/`canPersist` now
// come off `ReadingSessionResponse` directly, in the SAME call that fetches content. `Loan`/
// `LoanPage`/`ReturnRequest`/`ReturnResponse` are unused by app code today for the same reason;
// left in place rather than deleted because a published contract may still require them and
// deleting a type this app never calls is a no-op locally, not a proof nothing needs it.
//
// `licence: LocalLicenceRecord` DOES NOT EXIST ON THE REAL RESPONSE — content-provider.ts's frozen
// `EncryptedPackage`/`ContentStore.store()` require one (with `expiresAt`/`canPersist`/`rights`/
// `signature`) to decide Subscription-vs-Elite persistence, but the real backend never sends
// anything shaped like it. `checkLicense.ts` synthesizes one locally from `canPersist` (now on
// this response) — the real backend exposes NO long-term loan due-date at all (confirmed: the
// `GET /api/v1/loans` list returns `dueAt: null` for every seeded loan), so every synthesized
// licence gets the same far-future placeholder `expiresAt`, regardless of `licenceModel`. This is
// unresolved, not a design choice: without a due-date field anywhere on the real backend, an
// offline SUBSCRIPTION licence cannot expire until the backend adds one.
// `signature` has no real-backend counterpart at all (RS256 licence signing isn't part of this
// spec) — synthesized as an empty/unverified placeholder, matching `contentStore.ts`'s own
// already-documented, pre-existing gap (RS256 verification was never implemented, real or mock).
// That placeholder is not a small gap: it means `ContentError.LICENCE_INVALID` can never fire for
// a signature, and `content-provider.ts`'s frozen claim that the signature is "verified before
// expiry is trusted" is false in practice. Whether a signed licence exists in this system AT ALL
// is an open cohort question — B4 in `CONTRACT_ALIGNMENT.md` (this directory). Do not build
// anything new on `signature`; read that entry first.

import type { BookId, ContentFormat } from '../types/primitives';
import type { EncryptionDescriptor } from './content-provider';

// ── reading ───────────────────────────────────────────────────────────────

/** `Format` in the real spec — same three values as `ContentFormat`, kept as an alias so this
 * file's exports read the same as the spec rather than silently renaming it. */
export type ReadingFormat = ContentFormat;

/** `DOWNLOAD` is refused for ELITE whatever the UI offered. Audio may be encrypted or not. */
export type ReadingIntent = 'STREAM' | 'DOWNLOAD';

export interface ReadingSessionRequest {
  itemId: BookId;
  format: ReadingFormat;
  intent: ReadingIntent;
  /** Base64 SPKI DER — the body of a PEM public key with the armour and newlines stripped, which
   * for RSA-2048 is exactly 392 characters. NOT a PEM, NOT a JWK, and NOT the bare
   * modulus/exponent that flambeau's own looser wording ("base64 of raw bytes") suggests; wokay's
   * schema is the precise one and `deviceKeypair.ts`'s `publicKeyToRawBase64()` matches it. The
   * two specs word this differently — A6 in `CONTRACT_ALIGNMENT.md` — but only the wording is in
   * dispute, so do not "fix" the encoding to satisfy flambeau's prose. */
  devicePublicKey: string;
  /** Optional; wokay's schema states **`Default=true`** ("set false to skip signing an index URL,
   * saves a signature when the caller only wants to stream"), and flambeau's states no default at
   * all — A8 in `CONTRACT_ALIGNMENT.md`. Behaviour here does not depend on either: this client
   * always sends the field explicitly (`true` for a download, `false` for the per-open re-check),
   * so the two specs can disagree without changing what we get. */
  wantSearchIndex?: boolean;
}

/** wokay's `SignedUrl`, forwarded by flambeau unchanged. Carries its OWN `expiresAt` — the signed
 * URL's, not the session's or the loan's. Slightly outlives the session in the spec's own example
 * (content 10:15 vs session 10:05) so a slow download doesn't race the grant.
 *
 * `cipherLength`/`originalLength`/`mimeType` are OPTIONAL on the real spec (no `*` on any of the
 * three in wokay's schema) — only `url` and `expiresAt` are required. Marking them required here
 * was a real bug, found in review: `downloadManager.ts` trusted `originalLength` unconditionally,
 * so an absent field would make its own length cross-check compare a real number against
 * `undefined`, always fail, and reject every download with a `CHECKSUM_MISMATCH` that blames a
 * field that no longer exists. `computeOriginalLength` (downloadManager.ts) is the fallback for
 * exactly this case — test presence, per the real spec's own stated convention ("a null field is
 * omitted rather than sent as null; test for presence, not length"). */
export interface SignedUrl {
  url: string;
  expiresAt: string; // ISO-8601 UTC
  cipherLength?: number;
  originalLength?: number;
  mimeType?: string;
}

/** wokay's `IndexUrl`, forwarded by flambeau unchanged. Same shape `content-licence.ts`'s
 * `ContentLicenceIndexInfo` already models — kept as a separate named type here rather than
 * reused, so this file's exports mirror the spec 1:1 without a cross-file dependency on the
 * mock-shaped contract it's replacing.
 *
 * `url`/`encrypted` are OPTIONAL on the real spec too (same "test for presence" convention as
 * `SignedUrl` above) — only present when the caller asked for an index (`wantSearchIndex`) AND
 * the book actually has one.
 *
 * EXTENDED FOR MOCK/DEV: `encryptedBytes` carries embedded encrypted index bytes instead of a URL.
 * For a production backend with object storage, `url` would be a signed URL. For the mock backend,
 * `encryptedBytes` can be provided instead (embedded), and the app uses them directly. Both are
 * optional — either one can be present.
 *
 * `encryptedBytes` IS BASE64 TEXT, NOT `Uint8Array`, AND THAT IS NOT COSMETIC. This whole object
 * arrives inside a JSON body (`readingSessionClient.ts`'s `response.json()`), and JSON has no
 * binary type — Jackson's default `byte[]` serialization is a base64 string, so that is what is
 * actually on the wire whatever the in-memory shape ends up being. A `Uint8Array` annotation here
 * used to lie about that and let `openBook.ts` assign the raw string straight into a real
 * `Uint8Array` slot with no decode step and no compiler complaint — `contentStore.store()` then
 * persisted the base64 text itself as "the encrypted index", and decrypting it produced UTF-8
 * garbage (`queryBookIndex` failing with "invalid UTF-8 leading byte 0xfc at index 10", confirmed
 * on-device). The type now says what actually crosses the wire; `openBook.ts` decodes it with
 * `base64ToBytes` before it reaches `EncryptedPackage.index`. */
export interface IndexUrl {
  url?: string;
  encryptedBytes?: string;
  encrypted?: boolean;
  termCount?: number;
}

/** Where the reader stands for a copy-limited (ELITE) title. Absent for open access and
 * subscription — those tiers have no queue. `position: 0` means a copy is free now; the
 * `content` URL on the response carrying this will have expired by the time a queued reader is
 * promoted, so the app must call again rather than cache it. `estimatedAt` is a guess, named like
 * one — it knows nothing about early returns. */
export interface QueueState {
  queueId: string;
  position: number;
  queueLength: number;
  readNow: boolean;
  estimatedAt?: string;
}

export interface ReadingSessionResponse {
  /** For correlating logs. Not a credential, never presented back to the server. */
  sessionId: string;
  /** The licence this read was authorised against — what the real backend actually calls it.
   * Confirmed against `tf_reader_backend_temp`'s `ReadingSessionResponse` record; the published
   * flambeau spec this file originally modeled calls the same concept `loanId` (below), which the
   * real backend's response never sends. Absent for open access. */
  licenceId?: string;
  itemId: BookId;
  /** What the entitlement check returned: `OPEN_ACCESS`, `ENTITLED_UNLIMITED`,
   * `ENTITLED_CONCURRENT`. Present on the real backend; kept loose (not a union) since neither
   * published contract documents this field's exact value set. */
  accessLevel?: string;
  /** Same vocabulary the app already speaks from the catalogue feeds. Present on the real
   * backend's response — this is what lets `checkLicense.ts` skip a separate borrow/loan call
   * entirely (see this file's header). */
  licenceModel?: LicenceModel;
  /** THE download-button gate — not `licenceModel`. False for ELITE; the server refuses a
   * DOWNLOAD-intent reading session regardless of what the UI showed. Present on the real
   * backend's response, same field the old `Loan.canPersist` carried. */
  canPersist?: boolean;
  /** Present only for a copy-limited (ELITE) title with no copy free right now.
   * UNCONFIRMED against the real backend — no "Confirmed against tf_reader_backend_temp" note
   * ever existed for this field, unlike its siblings above, and it turns out not to match: the
   * real `ReadBrokerService.queuedResponse()` (reading/service/ReadBrokerService.java) sends no
   * nested queue object at all. It sends `holdCreatedAt` (below) instead — plain, flat, on the
   * response itself. Kept here rather than deleted only because nothing currently reads it and
   * removing an exported field is the Contracts Gate's call, not a drive-by decision; treat any
   * code that reads `.queue` as reading a field the server never populates. */
  queue?: QueueState;
  /** Present, and ONLY present, for a copy-limited (ELITE) title with no copy free right now —
   * the reader was placed in the wait queue as part of THIS SAME call rather than refused
   * outright. `content`/`index`/`encryption`/`licenceId` are all absent on this response: there
   * is nothing to read yet, only a place in line. Confirmed directly against
   * `ReadBrokerService.queuedResponse()` on 2026-09-20 — this is the field that field actually
   * sends; `queue` above is not. A caller that finds `content` missing must check this before
   * treating the response as malformed. */
  holdCreatedAt?: string;
  /** @deprecated Never sent by the real backend (confirmed) — it sends `licenceId` (above)
   * instead. Kept only because the published flambeau spec this file originally modeled names it;
   * nothing in this app reads it. */
  loanId?: string;
  /** ~5 minutes. This is the SESSION's expiry, not the licence's — see this file's header. */
  expiresAt: string;
  serverTime: string;
  content: SignedUrl;
  /** Absent when there is none, or when `wantSearchIndex` wasn't set. */
  index?: IndexUrl;
  /** Absent for open access only. Audio is encrypted as of 2026-08-25, the same AES-256-GCM
   * as EPUB/PDF. "Audio is never encrypted" was true through earlier build phases and is REVOKED.
   * Reused verbatim from content-provider.ts — same field names ARE the real wire format, per
   * that file's own header. */
  encryption?: EncryptionDescriptor;
}

// ── loans ─────────────────────────────────────────────────────────────────

/** wokay's vocabulary. `ENTITLED_UNLIMITED` is `SUBSCRIPTION`, `ENTITLED_CONCURRENT` is `ELITE`. */
export type LicenceModel = 'OPEN_ACCESS' | 'SUBSCRIPTION' | 'ELITE';

/** `EXPIRED` is a loan the server's own sweep closed at its due date; `RETURNED` is one the
 * reader closed. Both are over. */
export type LoanStatus = 'ACTIVE' | 'RETURNED' | 'EXPIRED';

export interface BorrowRequest {
  itemId: BookId;
}

export interface Loan {
  loanId: string;
  itemId: BookId;
  userId: string;
  /** Omitted for an individual subscriber (no institution). */
  institutionId?: string;
  licenceModel: LicenceModel;
  status: LoanStatus;
  borrowedAt: string;
  /** Absent for open access, which never expires. Otherwise borrowedAt + the entitlement's
   * loanPeriodDays — a real multi-week window, NOT the ~5-minute reading-session expiry. */
  dueAt?: string;
  returnedAt?: string;
  /** THE download-button gate — not `licenceModel`. False for ELITE; the server refuses a
   * DOWNLOAD-intent reading session regardless of what the UI showed. */
  canPersist: boolean;
  serverTime: string;
}

export interface LoanPage {
  loans: Loan[];
  page: number;
  size: number;
  total: number;
  serverTime: string;
}

export interface ReturnRequest {
  /** The reader's own timestamp, for an offline return reported late. Server clamps it to
   * [borrowedAt, serverTime] — omit to let the server timestamp the return itself. */
  returnedAt?: string;
}

export interface ReturnResponse {
  loanId: string;
  itemId: BookId;
  status: LoanStatus;
  borrowedAt: string;
  returnedAt: string;
  /** Whether freeing this copy promoted a queued reader. */
  promoted: boolean;
  serverTime: string;
}

// ── errors ────────────────────────────────────────────────────────────────

/**
 * The real backend's own error taxonomy (`common/error/ErrorCode`), field-for-field from the
 * spec's `Error`/`ErrorCode` schemas — NOT `DownloadError` (errors.ts), which is this app's own,
 * separate, already-existing carrier for client/device-side failures (storage, permissions, the
 * book limit). `downloadManager.ts`/`readingSessionClient.ts` map a subset of THESE onto specific
 * NEW `DownloadError` members (see errors.ts's additions) rather than replacing anything — every
 * pre-existing `DownloadError` member is untouched.
 *
 * THIS UNION TAKES A SIDE IN AN UNRESOLVED DISPUTE, and must be revisited when the Contracts Gate
 * rules — A1 in `CONTRACT_ALIGNMENT.md` (this directory). Both teams claim ONE shared
 * `common/error/ErrorCode` enum and publish different member lists: wokay excludes `TOKEN_EXPIRED`
 * and `INSTITUTION_INACTIVE` on a stated non-disclosure rationale, flambeau requires both, and
 * five more (`NO_COPIES_AVAILABLE`, `NO_ACTIVE_LOAN`, `LOAN_NOT_ACTIVE`, `DEVICE_LIMIT_REACHED`,
 * `OFFER_EXPIRED`) are flambeau's own and unratified. This union follows flambeau, because
 * flambeau is the surface these two endpoints live on. Consequence: an exhaustive `switch` over
 * this type is wrong against wokay's published enum, so do not write one that assumes
 * completeness.
 *
 * `INVALID_DEVICE_PUBLIC_KEY` is in NEITHER contract (B10) — wokay's prose says a short key "is
 * rejected" but names no code for it. Kept for now rather than dropped, because deleting a member
 * this app never raises itself is a no-op locally and the ratification list above has to be settled
 * as one question, not member by member. Nothing may start branching on it before then.
 */
export type FlambeauErrorCode =
  | 'VALIDATION_FAILED'
  | 'INVALID_DEVICE_PUBLIC_KEY'
  | 'UNAUTHENTICATED'
  | 'TOKEN_EXPIRED'
  | 'FORBIDDEN_SCOPE'
  | 'FORBIDDEN_INSTITUTION_MISMATCH'
  | 'NO_ENTITLEMENT'
  | 'ENTITLEMENT_EXPIRED'
  | 'ENTITLEMENT_SUSPENDED'
  | 'INSTITUTION_INACTIVE'
  | 'DOWNLOAD_NOT_PERMITTED'
  | 'DEVICE_LIMIT_REACHED'
  | 'NOT_FOUND'
  | 'CONTENT_NOT_READY'
  | 'NO_COPIES_AVAILABLE'
  | 'NO_ACTIVE_LOAN'
  | 'LOAN_NOT_ACTIVE'
  | 'OFFER_EXPIRED'
  // A Redis/Mongo blip on the backend (GlobalExceptionHandler's DataAccessException handler,
  // added 2026-09-20) — confirmed against the real backend, additive per this file's own freeze
  // rules (no member removed or renamed).
  | 'SERVICE_UNAVAILABLE';

/** One envelope for the whole backend, field-for-field wokay's `Error`. `message` is for a
 * human — switch on `code`, never on `message`. */
export interface FlambeauError {
  timestamp: string;
  status: number;
  code: FlambeauErrorCode;
  message: string;
  path: string;
  traceId?: string;
}
