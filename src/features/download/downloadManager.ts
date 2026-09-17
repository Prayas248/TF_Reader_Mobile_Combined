// Owner: Download (Abhinav).
//
// BuildPlan.md Phase 3 + Phase 4 items 1/3/4: the download skeleton's single entry point.
// Permission -> storage -> 5-book limit -> open a reading session (via checkLicense) -> resolve
// the encrypted asset -> reject if the decrypted size would exceed contentStore's RAM budget
// (MAX_DECRYPTED_BYTES, BOOK_TOO_LARGE) -> best-effort fetch the encrypted search index, if the
// session has one -> hand the bytes to Encryption's store() (never persist plaintext) -> record
// the download locally.
//
// REAL FLAMBEAU CONTRACT (2026-08-14), NO BORROW STEP (2026-08-23) — this file calls
// `checkLicense()` (licenseCheck.ts), which calls `readingSessionClient.ts`'s
// `openReadingSession()` (team flambeau's real, published `POST /api/v1/reading-sessions`), NOT
// `contentLicenceClient.ts`'s `fetchContentLicence` (the old mock-shaped
// `GET /books/:id/content-licence`) — that function, and `ContentLicenceResponse`
// (content-licence.ts), are left fully in place and still exported/tested, just no longer called
// from here. There is no separate borrow call: the real backend has no `POST /api/v1/loans`
// (confirmed 405 — see `reading-session.ts`'s header, D-020), so `licenceModel`/`canPersist` come
// off the session response itself, fetched once. `readingSessionClient.ts`'s `borrowLoan` stays
// for the mock backend/published-contract case; this file no longer calls it.
//
// `format` is a NEW required parameter (default 'EPUB' so every pre-existing call site — tests
// included — keeps compiling and behaving identically): the real request needs it up front
// (`ReadingSessionRequest.format`), unlike the old mock, which told the CLIENT the format instead
// of asking for it — there is no catalogue/browse step anywhere in this repo to source it from
// otherwise.
//
// INTENT IS 'DOWNLOAD', SENT AS-IS, NO CLIENT-SIDE DOWNGRADE — with no borrow step, `canPersist`
// isn't known until the reading-session call already returns, so there's nothing to downgrade
// against beforehand. An ELITE (online-only) book's `downloadBook()` call now fails outright with
// `DOWNLOAD_NOT_PERMITTED` — the real backend refuses that intent for ELITE unconditionally — and
// the caller should use `openBook()` (`intent: 'STREAM'`) for that book instead. This is a
// behavior change from when this file silently requested `'STREAM'` for a canPersist:false loan
// and returned a non-persisted read from `downloadBook()` itself; seeing `DOWNLOAD_NOT_PERMITTED`
// here now means "use Open", not "retry".
//
// CHECKSUM: the real `ReadingSessionResponse` carries no checksum field at all — GCM's own
// authentication tag (checked at decrypt time) is the integrity guarantee, not a separate SHA-256
// (see this directory's `API_CONTRACT_NOTES.md`, `B_ok4`). `verifyChecksum`/`bytesToHex` stay
// defined and EXPORTED below (not deleted, not orphaned-and-unused) for a caller that ever gets a
// checksum from a future response shape, but nothing here calls them today.
//
// `cipherLength`/`originalLength` now arrive directly on `content` (`SignedUrl`) instead of being
// derived — `computeOriginalLength` is kept and used as a defense-in-depth CROSS-CHECK against
// the server-supplied value instead, matching `content-provider.ts`'s own stated philosophy for
// `EncryptedPackage` ("REDUNDANT BY DESIGN, so the redundancy is made safe rather than removed").
//
// Uses `downloadTable` (the general primitive `downloadRepository.ts` is built on), NOT
// `downloadRepository`'s own convenience methods (list/currentForBook/recordCompleted) — those
// are hardcoded to sync/syncConfig.ts's single fixed BOOK_ID, a prototype shortcut that can't count
// across DIFFERENT books. downloadTable already supports multiple books; the wrapper just wasn't
// built for this case. See docs/superpowers/specs/2026-08-13-download-devicekey-skeleton-design.md.
//
// CHUNKED + RESUMABLE MAIN ASSET FETCH (added 2026-08-18): the main asset — the one that can
// actually be tens of megabytes — now goes through `chunkedAssetFetcher.ts`'s
// `fetchEncryptedAssetChunked` instead of the old single-`fetch()` `fetchEncryptedAsset`. Same
// RAM budget (`MAX_DECRYPTED_BYTES`) enforced, just earlier: converted to a ciphertext-byte
// ceiling and checked as soon as the total is known (first chunk, or immediately on a resume),
// before downloading further, in addition to the original post-fetch `BOOK_TOO_LARGE` check kept
// below as a backstop. The 5-book limit is untouched by this — it's checked before any fetch
// starts and re-checked under the write lock at the end, exactly as before; chunking only changed
// how the BYTES for one book arrive, not the accounting around it. `fetchEncryptedAsset` (plain,
// non-chunked) stays the call for the search index below — much smaller, no resumability need.
// See docs/superpowers/specs/2026-08-17-resumable-chunked-download-scoping.md for the design.
//
// SEARCH INDEX (added 2026-08-14, unchanged by the flambeau migration): `ReadingSessionResponse
// .index` (reading-session.ts) carries an optional `{ url, encrypted, termCount }`. Fetched the
// same way as the main asset and attached to `EncryptedPackage.index`, which contentStore.ts's
// decryptSearchIndex/getIndex already know how to decrypt. A failure fetching the index does NOT
// fail the whole download: contentStore.ts already treats the index as an independent failure
// domain from the book itself ("an index-only integrity failure has no business making the book
// unreadable too" — decryptSearchIndex's own doc comment).

import * as Crypto from 'expo-crypto';
import type { BookId, ContentFormat, EncryptedPackage, ReadingSessionResponse } from '@/shared/contracts';
import { base64ToBytes } from '../encryption/base64';
import { contentStore, maxDecryptedBytesFor } from '../encryption/contentStore';
import { NONCE_BYTES, GCM_TAG_BYTES } from '../encryption/cipherLayout';
import { downloadTable } from '../sync/stores/downloadStore';
import { withWriteLock } from '../sync/stores/syncableTable';
import { newId, nowIso } from '../sync/localDb/database';
import { USER_ID } from '../sync/syncConfig';
import type { DownloadRow } from '../sync/localDb/types';
import { checkStoragePermission } from './permissions';
import { checkAvailableStorage } from './storageCheck';
import { fetchEncryptedAssetChunked, discardPartialDownload } from './chunkedAssetFetcher';
import { fetchEncryptedAsset } from './readingSessionClient';
import { DownloadError, DownloadFailure } from './errors';
import { checkLicense } from './licenseCheck';
import { api } from '../sync/syncApi';
import { findExistingDownload } from '../sync/syncEngine';

export const BOOK_LIMIT = 5;

// Fallback for `SignedUrl.mimeType`, which is optional on the real spec — `EncryptedPackage
// .mimeType` (content-provider.ts) is NOT optional, so an absent server value needs a real one
// from somewhere. `format` alone can't name an exact audio codec, so AUDIO gets a generic
// container type rather than a guess at a specific one.
const FORMAT_MIME_TYPES: Record<ContentFormat, string> = {
  EPUB: 'application/epub+zip',
  PDF: 'application/pdf',
  AUDIO: 'application/octet-stream',
};

// Exported (not just used internally) so it stays a real, callable utility rather than orphaned
// dead code now that the main flow below no longer calls it — see this file's header.
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Throws BOOK_LIMIT_REACHED iff `bookId` is not already among `rows` AND the cap is full.
// Already-downloaded books don't count twice — re-download/update is allowed at the cap.
function assertBookLimitNotExceeded(bookId: BookId, rows: DownloadRow[]): void {
  const alreadyDownloaded = rows.some((row) => row.book_id === bookId);
  if (!alreadyDownloaded && rows.length >= BOOK_LIMIT) {
    throw new DownloadFailure(
      DownloadError.BOOK_LIMIT_REACHED,
      bookId,
      new Error(`already at the ${BOOK_LIMIT}-book offline limit`),
    );
  }
}

// Exported for the same reason as bytesToHex above — see this file's header ("CHECKSUM:").
export async function verifyChecksum(bookId: BookId, bytes: Uint8Array, expectedHex: string): Promise<void> {
  // `bytes` arrives typed as the bare (ArrayBufferLike-generic) Uint8Array — fetchEncryptedAsset's
  // declared return type (contentLicenceClient.ts, Task 4, not owned by this task) erases the
  // more specific inference its own body would otherwise carry. `Crypto.digest`'s BufferSource
  // param wants the ArrayBuffer-specific variant under TS 6's DOM lib; this is always a real
  // ArrayBuffer at runtime (never a SharedArrayBuffer), so the cast is safe.
  const digestBuffer = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes as BufferSource);
  const actualHex = bytesToHex(new Uint8Array(digestBuffer));
  if (actualHex.toLowerCase() !== expectedHex.toLowerCase()) {
    throw new DownloadFailure(
      DownloadError.CHECKSUM_MISMATCH,
      bookId,
      new Error(`expected checksum ${expectedHex}, got ${actualHex}`),
    );
  }
}

// Encrypted layout is nonce(12) || ciphertext || tag(16) (cipherLayout.ts) — ciphertext length
// equals plaintext length for AES-GCM, so originalLength is derivable from cipherLength alone,
// with no decrypt needed. Open access ships plaintext directly: cipherLength IS originalLength.
// Used below as a cross-check against the server-supplied value, not to derive it — see this
// file's header ("cipherLength/originalLength now arrive directly...").
export function computeOriginalLength(cipherLength: number, isEncrypted: boolean): number {
  return isEncrypted ? cipherLength - NONCE_BYTES - GCM_TAG_BYTES : cipherLength;
}

export interface DownloadOptions {
  /** Forwarded verbatim to `fetchEncryptedAssetChunked` — see its own doc comment. Only the main
   * asset reports progress; the search index fetch below is small enough that it doesn't need it. */
  onProgress?: (bytesReceived: number, expectedLength: number) => void;
}

export async function downloadBook(
  bookId: BookId,
  format: ContentFormat = 'EPUB',
  options: DownloadOptions = {},
): Promise<void> {
  const hasPermission = await checkStoragePermission();
  if (!hasPermission) {
    throw new DownloadFailure(DownloadError.PERMISSION_DENIED, bookId);
  }
  if (!checkAvailableStorage()) {
    throw new DownloadFailure(DownloadError.INSUFFICIENT_STORAGE, bookId);
  }

  // UNIFIED LICENSE GATE (licenseCheck.ts): the inline borrow + session + key-fingerprint +
  // licence-synthesis block that used to live here has been extracted into checkLicense(). That
  // function is shared by both downloadBook (this file, intent: 'DOWNLOAD') and openBook
  // (openBook.ts, intent: 'STREAM'). The licence is synthesised once, in checkLicense(), rather
  // than inline in both callers. checkLicense is called AFTER the storage-permission and
  // storage-availability checks above, because those are download-specific gating that a
  // network call would be wasteful to make first.
  //
  // NO SEPARATE BORROW STEP — checkLicense() makes exactly one call (openReadingSession), not a
  // borrow-then-session pair (see licenseCheck.ts's header, D-020). `licenceModel`/`canPersist`
  // come off the session response itself now, so both 'online' and 'open-access' (when reached
  // live rather than via the offline fallback) already carry a `session` — no second fetch here.
  const license = await checkLicense(bookId, format, 'DOWNLOAD');
  if (!license.ok) {
    throw new DownloadFailure(license.reason, bookId);
  }
  // Download requires a live session. The offline fallback produces a result for previously-
  // downloaded books only — 'offline-license' always lacks one, and 'open-access' lacks one only
  // when it came from that same fallback (checkLicense's own LicenseCheckResult doc comment) — a
  // newly-downloaded book can't come from either.
  if (license.mode === 'offline-license' || !license.session) {
    throw new DownloadFailure(DownloadError.SESSION_FETCH_FAILED, bookId);
  }
  const session: ReadingSessionResponse = license.session;
  // `session.content` is typed required but `readingSessionClient.ts` casts the raw response
  // body with no runtime check — see `openBook.ts`'s identical guard, including why
  // `holdCreatedAt` present means "queued", not "malformed" (a copy-limited title with none
  // free joins the queue inside this same call rather than a separate refusal). Kept here too
  // even though today's UI never offers Download on the one tier this applies to (ELITE) — see
  // this file's own `DOWNLOAD_NOT_PERMITTED`/`FAIL_CLOSED_CODES` handling, which already refuses
  // an ELITE `DOWNLOAD` intent before this line runs. Defense in depth, not dead code: a future
  // tier gaining a copy limit would hit this path with no other warning.
  if (session.content === undefined) {
    if (session.holdCreatedAt !== undefined) {
      throw new DownloadFailure(DownloadError.NO_COPIES_AVAILABLE, bookId);
    }
    throw new DownloadFailure(
      DownloadError.SESSION_FETCH_FAILED,
      bookId,
      new Error('reading session response is missing content'),
    );
  }
  // Moved up from further below — needed here now to decide whether a licence is attached at
  // all, not just to size the chunked fetch's RAM-budget ceiling later. Meaning unchanged:
  // session.encryption != null.
  const isEncrypted = session.encryption != null;
  // A licence is needed whenever EITHER is true: the package is actually encrypted (regardless
  // of what the licence model claims), or the licence model itself isn't open-access (regardless
  // of whether the bytes happen to be encrypted). Neither alone is right:
  //   - `license.mode !== 'open-access'` alone missed a real case: a dev fixture whose
  //     `licenceModel` is OPEN_ACCESS but whose grant still carries `encryption` (a documented
  //     tf_reader_backend_temp quirk — real OPEN_ACCESS should never be encrypted, but this dev
  //     fixture is). That left `licence` null while `pkg.encryption` below is not, and
  //     contentStore.ts's assertLicenceMatchesPackage() correctly rejects exactly that
  //     combination with LICENCE_INVALID — confirmed via device testing, 2026-08-25
  //     (dev-sample-epub), on every single download of that fixture. openBook.ts's STREAM path
  //     never hit this, because it always attaches the licence unconditionally — exactly why
  //     "opening the same book worked while downloading it didn't" was so confusing to spot.
  //   - `isEncrypted` alone would make a SUBSCRIPTION/ELITE *audio* book (which is encrypted by
  //     design — see content-provider.ts lines 85–92) indistinguishable from real open access:
  //     `licence` would end up null,
  //     `isElite()`/`isLicenceExpired()` (contentStore.ts) both read off `pkg.licence`, and a
  //     null licence makes both answer "no restriction" — an Elite audiobook would persist to
  //     disk forever instead of staying memory-only, and a Subscription audiobook's local copy
  //     would never expire.
  const licence = (isEncrypted || license.mode !== 'open-access') ? (license.licence ?? null) : null;
  // `session.canPersist` is optional on the type (a published contract might not send it — see
  // reading-session.ts) — default true, same as synthesiseLicence()'s own default (licenseCheck.ts)
  // does for the licence it hands back. Reading `session.canPersist` raw here would disagree with
  // that default whenever a caller omits the field, silently skipping the write-lock block below.
  const canPersist = session.canPersist ?? true;

  // Fast-fail before spending bandwidth on the asset — NOT the authoritative check (the one that
  // decides whether a row is written is re-run inside the write lock at the bottom of this
  // function). Gated on `canPersist`: an ELITE (STREAM-intent) read never persists anything and
  // never writes a downloads row (see the `withWriteLock` block below), so it must not count
  // against, or be blocked by, the 5-book limit either — found in review (D-18): without this
  // gate, a reader already at the cap on real downloads would get a bogus BOOK_LIMIT_REACHED
  // trying to just READ an ELITE book online, even though doing so would never actually consume a
  // slot. In practice `canPersist` is true whenever we reach this line with intent 'DOWNLOAD' —
  // the server would have refused with DOWNLOAD_NOT_PERMITTED otherwise (see checkLicense.ts) —
  // but the field is read here rather than assumed, since open access also reaches this line and
  // carries its own (true) canPersist.
  if (canPersist) {
    assertBookLimitNotExceeded(bookId, await downloadTable.listActive(USER_ID));
  }

  // Anti-key-substitution check (API_CONTRACT_NOTES.md C7/B3) is now done inside checkLicense()
  // (shared by both Open and Download). The check runs before the asset fetch, so a key mismatch
  // fails in milliseconds instead of after pulling up to 25MB. contentStore's own
  // assertLicenceMatchesPackage still runs too — defense in depth for any direct store() caller
  // (e.g. devContentSeed.ts).

  // Chunked + resumable (docs/superpowers/specs/2026-08-17-resumable-chunked-download-scoping.md):
  // the budget is on the DECRYPTED size; the fetcher deals in ciphertext bytes, which are 28 bytes
  // larger (nonce + tag) for encrypted content and identical for open access. Audio is encrypted
  // (2026-08-25), so it adds the nonce+tag overhead. Converting here, once, keeps
  // `chunkedAssetFetcher.ts` ignorant of encryption entirely — it only ever sees "a byte budget",
  // not why that number is what it is. Per-format since the 20 MB audio cap landed
  // (maxDecryptedBytesFor) — reading MAX_DECRYPTED_BYTES directly would let an oversized
  // audiobook pull 25 MB before store() refused it at 20.
  const maxCipherBytes = maxDecryptedBytesFor(format) + (isEncrypted ? NONCE_BYTES + GCM_TAG_BYTES : 0);
  let bytes: Uint8Array;
  try {
    bytes = await fetchEncryptedAssetChunked(bookId, session.content.url, {
      maxBytes: maxCipherBytes,
      onProgress: options.onProgress,
    });
  } catch (cause) {
    // Fail-closed: clean up any partial download state on mid-transfer abort/timeout.
    // This ensures incomplete ciphertext doesn't linger on disk, which would either:
    // - prevent the book from being downloaded again (resumption with a bad manifest)
    // - unnecessarily consume storage and persist stale data
    // The 60s ASSET_FETCH_TIMEOUT_MS is already the timeout per chunk; this cleanup is sync/instant.
    try {
      discardPartialDownload(bookId);
    } catch (cleanupCause) {
      console.warn(
        `downloadManager: rollback discardPartialDownload(${bookId}) failed during asset fetch cleanup`,
        cleanupCause,
      );
    }
    throw cause;
  }

  // `content.originalLength`/`mimeType` are OPTIONAL on the real spec (reading-session.ts's own
  // header — "test for presence, not length"). Found in review: comparing a real number against
  // an ABSENT field unconditionally made every download reject with a CHECKSUM_MISMATCH that
  // blamed a field the response never carried. Only cross-check when the server actually sent a
  // value; when it didn't, `computeOriginalLength` IS the value, not just a defense-in-depth
  // check against one.
  const expectedOriginalLength = computeOriginalLength(bytes.length, isEncrypted);
  if (
    session.content.originalLength !== undefined &&
    session.content.originalLength !== expectedOriginalLength
  ) {
    // The grant's own originalLength disagrees with what the ciphertext length implies — treat
    // this the same as a checksum mismatch would have been: a loud, typed rejection BEFORE
    // store(), never a silent trust of either number alone.
    throw new DownloadFailure(
      DownloadError.CHECKSUM_MISMATCH,
      bookId,
      new Error(
        `content.originalLength (${session.content.originalLength}) disagrees with cipherLength ` +
          `(${bytes.length}) for ${isEncrypted ? 'an encrypted' : 'an open-access'} book — expected ${expectedOriginalLength}`,
      ),
    );
  }

  // Reject an over-budget book BEFORE store(), with a DownloadFailure the download UI can speak
  // rather than the ContentFailure store() would throw. contentStore enforces the same budget on
  // both sides now, so this is no longer the only thing standing between an oversized book and
  // disk — but reaching store() would still mean the whole body was fetched first, and the error
  // the caller got back would be about decryption rather than about the download.
  const originalLength = session.content.originalLength ?? expectedOriginalLength;
  const budget = maxDecryptedBytesFor(format);
  if (originalLength > budget) {
    throw new DownloadFailure(
      DownloadError.BOOK_TOO_LARGE,
      bookId,
      new Error(
        `book decrypts to ${originalLength} bytes, over contentStore's ${budget}-byte budget for ` +
          `${format} — it could never be opened, so it is not stored`,
      ),
    );
  }

  let indexBytes: Uint8Array | undefined;
  // `session.index.url` is optional too (reading-session.ts) — `session.index` being present
  // doesn't guarantee a fetchable url came with it under the real spec's "absent means absent"
  // convention, even though every scenario this mock currently returns happens to include one.
  if (session.index?.url) {
    try {
      indexBytes = await fetchEncryptedAsset(bookId, session.index.url);
    } catch (cause) {
      console.warn(
        `downloadManager: failed to fetch search index for ${bookId}, continuing without it`,
        cause,
      );
    }
  } else if (session.index?.encryptedBytes) {
    // The embedded-bytes convention `openBook.ts` handles for STREAM sessions — added for the
    // mock backend alongside a signed `url`'s alternative, per reading-session.ts's `IndexUrl`.
    // Missing here until now: a DOWNLOAD-intent session that comes back with `encryptedBytes` and
    // no `url` fell through this whole block with `indexBytes` left `undefined`, silently
    // persisting the book with no search index at all rather than a corrupted one — a different
    // symptom from openBook.ts's bug (decode failure), but the same root gap. MUST base64-decode,
    // not assign directly — `encryptedBytes` is base64 text on the wire (JSON has no binary type;
    // see `IndexUrl`'s own doc comment for the on-device failure this caused when skipped once).
    indexBytes = base64ToBytes(session.index.encryptedBytes);
  }

  // Synthesized locally by checkLicense() — the real response has no `licence` field at all (see
  // reading-session.ts's header). `expiresAt` is a far-future placeholder today (the real backend
  // has no loan due-date — `GET /api/v1/loans` returns `dueAt: null`); the actual offline bound
  // is the 4-day cap applied by `computeOfflineLicenceExpiry()` at open-time, not at synthesis-
  // time. `signature` has no real-backend counterpart; contentStore.ts doesn't verify RS256 today
  // regardless (a pre-existing, documented gap — this placeholder doesn't create a new one).
  // Licence is now shared with openBook.ts (via licenseCheck.ts) — synthesis happens once, here,
  // not twice.

  const pkg: EncryptedPackage = {
    bookId,
    format,
    content: bytes,
    index: indexBytes,
    encryption: session.encryption ?? null,
    // `licence` is already correctly null-or-not (see its derivation, just above `canPersist`
    // near the top of this function) — not re-decided here.
    licence,
    cipherLength: bytes.length,
    originalLength,
    mimeType: session.content.mimeType ?? FORMAT_MIME_TYPES[format],
  };

  await contentStore.store(pkg);

  // Defense-in-depth, not the primary gate: an ELITE (canPersist:false) book now fails earlier,
  // at checkLicense(), with DOWNLOAD_NOT_PERMITTED (see this file's header) — the server refuses
  // intent:'DOWNLOAD' for it outright, so `canPersist` should always be true by this line. Kept
  // rather than assumed, same defense-in-depth reasoning as elsewhere here: `contentStore.store()` already
  // declines to persist a canPersist:false package regardless, and skipping the block below for
  // one avoids writing a `status: 'COMPLETED'` downloads row and burning one of the 5 offline
  // slots for a book that was never actually persisted (found in review, D-18).
  if (!canPersist) {
    return;
  }

  // Everything below runs under withWriteLock — the lock every other repository call site in this
  // repo takes, and the one that serializes writes onto the app's single SQLite connection
  // (syncableTable.ts's withWriteLock doc comment). `{ locked: true }` on saveLocal is correct
  // ONLY because this block already holds the lock.
  //
  // It deliberately RE-QUERIES listActive instead of reusing the pre-fetch result above (which
  // the design doc's step 9 suggested as an optimization): that result is now stale — a network
  // fetch, a checksum and a store() ago — and reusing it is exactly what makes
  // check-then-write non-atomic. The `downloads` schema has no unique constraint on
  // (user_id, book_id), so two concurrent downloads of the same book, each holding its own
  // pre-fetch snapshot, would each see "no existing row" and INSERT a duplicate. Re-reading
  // under the lock is what makes the decision (UPDATE vs CREATE) and the write one atomic unit.
  await withWriteLock(async () => {
    const rows = await downloadTable.listActive(USER_ID);
    // Re-assert the cap here too, for the same reason: the pre-fetch check above could have
    // raced another download that has since taken the last slot. If it did, roll back the
    // store() — leaving ciphertext on disk that no downloads row accounts for would make
    // isAvailableOffline(bookId) true for a book the app believes it never downloaded.
    try {
      assertBookLimitNotExceeded(bookId, rows);
    } catch (cause) {
      // Best-effort rollback: destroy() failing here (e.g. a keychain/FS error) must NOT replace
      // `cause` — the caller needs the coded BOOK_LIMIT_REACHED DownloadFailure to switch on, not
      // a raw, untyped error from the cleanup attempt. Swallow (log) any destroy failure and
      // still surface the original reason.
      try {
        await contentStore.destroy(bookId);
      } catch (destroyCause) {
        console.warn(`downloadManager: rollback contentStore.destroy(${bookId}) failed`, destroyCause);
      }
      throw cause;
    }

    const existing = rows.find((row) => row.book_id === bookId) ?? null;

    // No ACTIVE local row - but the server may already have history for this book (another
    // device downloaded it, or this device did and its local row was lost), possibly tombstoned
    // from an earlier delete. Minting a fresh id in that case is exactly what makes the server's
    // create answer 409 CODE_TAKEN - check first instead of reacting to that after the fact.
    // syncEngine.ts's DownloadRestoreCollision handling stays as the safety net for the race this
    // narrows but cannot close (two devices re-downloading the same book at nearly the same
    // moment), not the primary path for it.
    let downloadId = existing?.id ?? null;
    if (!downloadId) {
      // Same rollback reasoning as the BOOK_LIMIT check above, for the same reason: this
      // reconciliation call runs after contentStore.store() already wrote the ciphertext, so a
      // failure here (api.list -> ApiError(0) on an unreachable host is the routine dev-simulator
      // state, not an edge case) must not leave that ciphertext orphaned with no downloads row —
      // found in review, the defect isAvailableOffline(bookId)-true-with-no-row above warns about.
      try {
        const remote = await findExistingDownload({ userId: USER_ID, bookId, format });
        if (remote) {
          if (remote.isDeleted) {
            await api.restore<any>('downloads', remote.id);
          }
          downloadId = remote.id as string;
        }
      } catch (cause) {
        try {
          await contentStore.destroy(bookId);
        } catch (destroyCause) {
          console.warn(`downloadManager: rollback contentStore.destroy(${bookId}) failed`, destroyCause);
        }
        throw cause;
      }
    }

    const now = nowIso();
    const row: DownloadRow = {
      id: downloadId ?? newId(),
      user_id: USER_ID,
      book_id: bookId,
      format,
      local_path: null, // contentStore.ts does not expose its internal file path — see design doc.
      status: 'COMPLETED',
      is_valid: 1,
      downloaded_at: now,
      updated_at: now,
      is_deleted: 0,
      synced: 0,
    };
    await downloadTable.saveLocal(row, downloadId ? 'UPDATE' : 'CREATE', { locked: true });
  });
}

/**
 * DEV/TEST TOOLING — not part of the download feature's own surface. Wipes every persisted
 * download for this device: `contentStore.destroy()` (ciphertext, licence, keychain BEK) for
 * each book, then a tombstoned removal of its `downloads` row so it still propagates on the
 * next sync rather than just vanishing locally. Exists so BookListScreen's "Clear All Downloads"
 * button (and manual testing generally) doesn't need adb/sqlite3 by hand to reset to a clean
 * offline state — see ANDROID_UNAUTHENTICATED.md for how much of that this session did manually
 * before this existed.
 *
 * One book failing to destroy must not stop the rest — same reasoning as the rollback path
 * above: a keychain/FS error on one book is that book's problem, not a reason to leave nine
 * others still occupying the 5-book limit. Every failure is collected and thrown together at the
 * end, after every book has had its attempt, rather than surfacing (and stopping at) the first.
 */
export async function clearAllDownloads(): Promise<void> {
  const rows = await downloadTable.listActive(USER_ID);
  const failures: unknown[] = [];
  for (const row of rows) {
    try {
      await contentStore.destroy(row.book_id as BookId);
    } catch (cause) {
      failures.push(cause);
      console.warn(`clearAllDownloads: contentStore.destroy(${row.book_id}) failed`, cause);
    }
    await downloadTable.softDeleteLocal(row.id);
  }
  if (failures.length > 0) {
    // A plain Error, not a DownloadFailure — none of DownloadError's members describe "some
    // books failed to clear" (this is dev tooling, not a real download-feature failure mode),
    // and reusing an existing code here would just mean it, not this.
    throw new Error(
      `clearAllDownloads: ${failures.length} of ${rows.length} book(s) failed to fully destroy — see console`,
    );
  }
}
