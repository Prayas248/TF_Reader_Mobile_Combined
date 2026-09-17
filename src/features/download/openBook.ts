// Owner: Download (Abhinav).
//
// Open orchestrator — read a book NOW without persisting anything. License check first,
// then either decrypt from an existing local copy or stream the signed URL into memory
// (ephemeral Elite package, canPersist forced false), then decrypt and return the bytes.
//
// Nothing is saved — no licence, no ciphertext. close(bookId) drops the in-memory
// package from packageCache, exactly as it does for Elite today.
//
// NOT wired into Reader's call site yet — that change is in Ahana's directory
// (src/features/reader/readerAssets.ts). This file and its tests land first so the
// seam is proven before the Reader-side boundary is crossed.

import type { BookId, ContentFormat, EncryptedPackage } from '@/shared/contracts';
import { base64ToBytes } from '../encryption/base64';
import { contentStore, maxDecryptedBytesFor } from '../encryption/contentStore';
import { NONCE_BYTES, GCM_TAG_BYTES } from '../encryption/cipherLayout';
import { fetchEncryptedAssetChunked, discardPartialDownload } from './chunkedAssetFetcher';
import { checkLicense } from './licenseCheck';
import { fetchEncryptedAsset } from './readingSessionClient';
import { DownloadError, DownloadFailure } from './errors';

// Same MIME-type fallback as downloadManager.ts — EncryptedPackage.mimeType is not optional.
const FORMAT_MIME_TYPES: Record<ContentFormat, string> = {
  EPUB: 'application/epub+zip',
  PDF: 'application/pdf',
  AUDIO: 'application/octet-stream',
};

/**
 * Open a book for immediate reading — nothing persists. The caller MUST call
 * `contentProvider.closeBook(bookId)` (or `contentStore.close(bookId)`) when done to
 * drop the in-memory package and zero the decrypted buffer.
 *
 * @returns the decrypted book bytes (same as `contentProvider.getBook`).
 * @throws `DownloadFailure` on licence denial, network failure, or offline-with-no-valid-licence.
 */
export async function openBook(bookId: BookId, format: ContentFormat): Promise<Uint8Array> {
  const license = await checkLicense(bookId, format, 'STREAM');
  if (!license.ok) {
    throw new DownloadFailure(license.reason, bookId);
  }

  // Content already on disk — decrypt the local copy directly, for every mode. Covers the
  // offline fallback outright (guaranteed true whenever 'offline-license', or a session-less
  // 'open-access', comes back — see checkLicense.ts's LicenseCheckResult doc comment) and the
  // common case of re-opening an already-downloaded book while online, without re-fetching it.
  if (license.mode === 'offline-license' || (await contentStore.isAvailableOffline(bookId))) {
    await contentStore.openSession(bookId);
    return contentStore.decryptBook(bookId);
  }

  // Not on disk. checkLicense() always returns `session`+`licence` TOGETHER for a live call, for
  // both 'online' and 'open-access' — the only way to reach here with either missing is a
  // session-less 'open-access' from the offline fallback, and the isAvailableOffline() check
  // above already returned for that case (its own precondition guarantees the content exists).
  // This guard is defense-in-depth for that invariant, not an expected path.
  if (!license.session || !license.licence) {
    throw new DownloadFailure(DownloadError.OFFLINE_LICENSE_UNAVAILABLE, bookId);
  }
  const { session, licence } = license;

  // `session.content` is typed required (`ReadingSessionResponse`, reading-session.ts) but
  // `readingSessionClient.ts` casts the raw response body with no runtime check, so a server
  // response that omits it reaches here as `undefined` despite the type. Without this guard,
  // `session.content.url` below throws a bare `TypeError: Cannot read property 'url' of
  // undefined` instead of a caught, reportable failure.
  //
  // `holdCreatedAt` PRESENT IS NOT THAT CASE — it means this ELITE title had no free copy right
  // now, and the real backend joined the queue on this reader's behalf inside this very call
  // (`ReadBrokerService.queuedResponse()`, confirmed in `tf_reader_backend_temp`) rather than
  // making the app turn around and call `POST /api/v1/holds` itself. There is genuinely nothing
  // to read yet — but that is the SAME "no copies, here is the queue" outcome
  // `LOAN_ERROR_CODE_MAP`'s `NO_COPIES_AVAILABLE` already names for the borrow path, not a
  // malformed response. Throwing the generic `SESSION_FETCH_FAILED` here (what this used to do)
  // is exactly why tapping Read/Play on a full Elite title showed "download failed" instead of
  // going into the queue: the hold was already created server-side, but the caller only ever saw
  // an unexplained failure with nothing to distinguish it from a real one.
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

  // Stream the signed URL into memory via the chunked fetcher, build an ephemeral Elite
  // package (canPersist forced false regardless of the real session.canPersist), and store()
  // it. contentStore.store()'s existing Elite branch caches the package in RAM only, nothing
  // written to disk — zero new decrypt/cache logic, and the same treatment whether the book is
  // a real SUBSCRIPTION/ELITE title or genuinely open access.
  //
  // fetchEncryptedAssetChunked (not the single-shot fetchEncryptedAsset) because it
  // enforces a maxBytes ceiling on the ciphertext as soon as the total is known (first
  // chunk / Content-Range), aborting mid-transfer before the oversized payload is fully
  // assembled in memory. The single-shot variant only checks AFTER the full fetch
  // completes, defeating the purpose of the RAM budget for Open-path books that aren't
  // already on disk.
  const isEncrypted = session.encryption != null;
  const maxCipherBytes = maxDecryptedBytesFor(format) + (isEncrypted ? NONCE_BYTES + GCM_TAG_BYTES : 0);

  // Search index can be provided as embedded encrypted bytes or a signed URL.
  //
  // CONFIRMED LIVE, 2026-08-31, AGAINST tf_reader_backend_temp: for a real book on the real
  // backend, `index` carries `{ url, encrypted, termCount }` - no `encryptedBytes` at all. The
  // embedded convention is the MOCK backend's own shortcut (added so it could skip standing up
  // object storage for a small dev payload; see `IndexUrl`'s doc comment) - a real deployment
  // signs a URL like every other asset. The `url` branch below used to be a bare TODO, so every
  // STREAM open against the real backend silently got no index at all - "This book has no search
  // index," which is honest but wrong: the book HAS one, this call just never fetched it.
  // `downloadManager.ts` already does this fetch for the DOWNLOAD-intent path (`fetchEncryptedAsset`);
  // this mirrors it for STREAM. Best-effort, like that call site - a failed index fetch must not
  // fail the book open itself.
  //
  // MUST BASE64-DECODE THE EMBEDDED CASE, NOT ASSIGN DIRECTLY. `IndexUrl.encryptedBytes` is typed
  // `string` (base64) precisely because this value crosses the wire inside a JSON body
  // (`readingSessionClient.ts`'s `response.json()`) - JSON has no binary type, so what actually
  // arrives is base64 text (Jackson's default `byte[]` serialization), never a real `Uint8Array`.
  // An earlier version of this line assigned that string straight into a slot typed
  // `Uint8Array | undefined` with no runtime check to catch the mismatch, so `contentStore.store()`
  // persisted the base64 text itself as though it were the encrypted bytes. Decrypting THAT then
  // "succeeded" (AES-GCM doesn't know the ciphertext is wrong) and handed `utf8Decode` garbage -
  // confirmed on-device: `queryBookIndex` failed with "invalid UTF-8 leading byte 0xfc at index
  // 10", index 10 landing inside where the 12-byte nonce would be if this were the raw undecoded
  // string's char codes. `base64ToBytes` is Encryption's own portable codec (`base64.ts`) - no
  // native module needed for a payload this small.
  //
  // Kicked off here, before the content fetch, so its network time overlaps the content fetch's
  // instead of stacking on top of it — best-effort either way, so starting it early costs nothing
  // on a content-fetch failure (the promise already swallows its own errors below, so it's simply
  // never awaited again).
  const indexPromise: Promise<Uint8Array | undefined> = session.index?.encryptedBytes
    ? Promise.resolve(base64ToBytes(session.index.encryptedBytes))
    : session.index?.url
      ? fetchEncryptedAsset(bookId, session.index.url).catch((cause) => {
          console.warn(
            `openBook: failed to fetch search index for ${bookId}, continuing without it`,
            cause,
          );
          return undefined;
        })
      : Promise.resolve(undefined);

  let bytes: Uint8Array;
  try {
    bytes = await fetchEncryptedAssetChunked(bookId, session.content.url, {
      maxBytes: maxCipherBytes,
    });
  } catch (cause) {
    // Fail-closed: clean up any partial download state on mid-transfer abort/timeout.
    // Incomplete ciphertext must not linger on disk.
    try {
      discardPartialDownload(bookId);
    } catch (cleanupCause) {
      console.warn(
        `openBook: rollback discardPartialDownload(${bookId}) failed during asset fetch cleanup`,
        cleanupCause,
      );
    }
    throw cause;
  }

  // Cross-check: if the server supplied content.originalLength, verify it against what
  // the ciphertext length implies. A disagreement means the metadata record is corrupted
  // — reject before store(), same as downloadManager.ts does. The GCM tag catches real
  // byte-level corruption on decrypt; this is the less-precise metadata-layer check.
  const expectedOriginalLength = isEncrypted
    ? bytes.length - NONCE_BYTES - GCM_TAG_BYTES
    : bytes.length;

  if (
    session.content.originalLength !== undefined &&
    session.content.originalLength !== expectedOriginalLength
  ) {
    throw new DownloadFailure(
      DownloadError.CHECKSUM_MISMATCH,
      bookId,
      new Error(
        `content.originalLength (${session.content.originalLength}) disagrees with cipherLength ` +
          `(${bytes.length}) for ${isEncrypted ? 'an encrypted' : 'an open-access'} book — expected ${expectedOriginalLength}`,
      ),
    );
  }

  const originalLength = session.content.originalLength ?? expectedOriginalLength;

  const budget = maxDecryptedBytesFor(format);
  if (originalLength > budget) {
    throw new DownloadFailure(
      DownloadError.BOOK_TOO_LARGE,
      bookId,
      new Error(`book decrypts to ${originalLength} bytes, over the ${budget}-byte budget for ${format}`),
    );
  }

  const searchIndex = await indexPromise;

  const pkg: EncryptedPackage = {
    bookId,
    format,
    content: bytes,
    index: searchIndex,
    encryption: session.encryption ?? null,
    licence: {
      ...licence,
      // KEY MOVE: force canPersist false so store() treats this as Elite (in-memory only,
      // nothing written to disk) regardless of the real session.canPersist — same treatment
      // for a real SUBSCRIPTION/ELITE title and a genuinely open-access one.
      canPersist: false,
    },
    cipherLength: bytes.length,
    originalLength,
    mimeType: session.content.mimeType ?? FORMAT_MIME_TYPES[format],
  };

  await contentStore.store(pkg);
  await contentStore.openSession(bookId);
  return contentStore.decryptBook(bookId);
}
