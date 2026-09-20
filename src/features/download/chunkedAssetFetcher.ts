// Owner: Download (Abhinav).
//
// Chunked, resumable replacement for `contentLicenceClient.ts`'s `fetchEncryptedAsset` on the ONE
// call that actually moves the book payload. Scoped per
// `docs/superpowers/specs/2026-08-17-resumable-chunked-download-scoping.md` — read that first for
// the reasoning this file only summarizes:
//
// - Chunk size is 1 MiB, fixed. Reused REQUEST_TIMEOUT_MS's 8s shape per chunk (not the whole-
//   asset ASSET_FETCH_TIMEOUT_MS, which was sized for the full transfer, not one slice of it).
// - Whole-file AES-GCM means the tag covers the ENTIRE ciphertext — there is no partial
//   verification, no streaming decrypt. Chunking buys network resilience and (if a caller wants
//   it) progress reporting; it does NOT reduce peak memory. This function still returns the whole
//   assembled Uint8Array, same as the non-chunked version — the RAM cost of holding it is
//   unchanged, only how it got there changed.
// - Partial progress is persisted to disk (not just RAM) specifically so it survives an app
//   kill, not just a dropped connection — see PARTIAL_DIR below. Ciphertext at rest before its
//   GCM tag is ever checked is not a new risk: contentStore.ts already writes ciphertext to disk
//   for Subscription-tier books; this is the same posture, just incomplete.
//
// What this file deliberately does NOT do: verify anything cryptographic (that's Encryption's
// job, after assembly, via the existing GCM tag check — a wrong chunk order or a corrupted chunk
// simply fails that check exactly as whole-file corruption already does, no new error path
// needed). It also does not decide the RAM/size budget itself — `maxBytes` is a caller-supplied
// ceiling on the CIPHERTEXT byte count, so `downloadManager.ts` (which knows whether the content
// is encrypted, and therefore the DECRYPTED-vs-ciphertext relationship) stays the one place that
// derives it from `MAX_DECRYPTED_BYTES`.

import { Directory, File, Paths } from 'expo-file-system';
import type { BookId } from '@/shared/contracts';
import { reachableAssetUrl } from './contentLicenceClient';
import { DownloadError, DownloadFailure } from './errors';

export const CHUNK_SIZE_BYTES = 1024 * 1024; // 1 MiB — see this file's header for the reasoning

// Same abort-controller-plus-timer shape as every other network call in this directory. Smaller
// than ASSET_FETCH_TIMEOUT_MS (60s) on purpose: that value was sized for the WHOLE asset; one
// 1 MiB chunk taking longer than 8s (~128 KiB/s floor) means the connection is bad enough that
// waiting on THIS chunk isn't worth it — a fresh chunk request (still resumable from here) is a
// better use of the time than one long wait.
//
// BRIEFLY RAISED TO 25000 ON 2026-09-21, THEN REVERTED THE SAME DAY — an EPUB open was aborting
// with "Fetch request has been canceled" (this file's own AbortController firing), which looked
// like this timeout being too tight for a slow connection. It was not: the real cause, found right
// after via adb logcat, was the dev emulator's DNS being broken outright (`UnknownHostException`
// resolving `s3.amazonaws.com`, confirmed by `ping google.com` also failing the same way) — a
// stale emulator network cache, fixed by restarting the emulator with an explicit DNS server, not
// by anything in this file. 8s is fine once DNS actually resolves; raising it only masked the
// symptom for one more request before the real (still-broken) lookup failed anyway.
const CHUNK_TIMEOUT_MS = 8000;

// Deliberately its own directory, separate from contentStore.ts's `tf-reader-content/` — a
// partial file must never be mistaken for a complete, verified package by anything that scans
// the content store's own directory (e.g. a future cleanup sweep).
const PARTIAL_DIR = new Directory(Paths.document, 'tf-reader-partial-downloads');

interface PartialManifest {
  url: string;
  expectedLength: number;
  bytesReceived: number;
}

function partialContentFile(bookId: BookId): File {
  return new File(PARTIAL_DIR, `${encodeURIComponent(bookId)}.partial.bin`);
}
function partialManifestFile(bookId: BookId): File {
  return new File(PARTIAL_DIR, `${encodeURIComponent(bookId)}.partial.json`);
}

function readManifest(bookId: BookId): PartialManifest | null {
  const file = partialManifestFile(bookId);
  if (!file.exists) return null;
  try {
    return JSON.parse(file.textSync()) as PartialManifest;
  } catch {
    return null; // corrupted sidecar — treated as "no usable partial state", not a crash
  }
}

function writeManifest(bookId: BookId, manifest: PartialManifest): void {
  const file = partialManifestFile(bookId);
  if (!PARTIAL_DIR.exists) PARTIAL_DIR.create({ intermediates: true });
  if (file.exists) file.delete();
  file.create();
  file.write(JSON.stringify(manifest));
}

/**
 * Deletes any partial state for `bookId` — the completed-download cleanup path, and also the
 * "this partial can't be trusted" path (mismatched manifest/file, or a caller giving up for
 * good). Safe to call when nothing exists.
 */
export function discardPartialDownload(bookId: BookId): void {
  const content = partialContentFile(bookId);
  const manifest = partialManifestFile(bookId);
  if (content.exists) content.delete();
  if (manifest.exists) manifest.delete();
}

function appendOrCreate(file: File, bytes: Uint8Array, append: boolean): void {
  if (!file.parentDirectory.exists) {
    file.parentDirectory.create({ intermediates: true });
  }
  if (!append) {
    if (file.exists) file.delete();
    file.create();
  }
  file.write(bytes, append ? { append: true } : undefined);
}

/** Parses "bytes 0-1048575/25000000" → 25000000. Null if the header is absent or unparseable. */
function parseContentRangeTotal(response: Response): number | null {
  const header = response.headers.get('content-range');
  if (!header) return null;
  const match = /\/(\d+)\s*$/.exec(header);
  return match ? Number(match[1]) : null;
}

async function fetchRange(bookId: BookId, url: string, start: number, end: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHUNK_TIMEOUT_MS);
  try {
    return await fetch(reachableAssetUrl(url), {
      headers: { Range: `bytes=${start}-${end}` },
      signal: controller.signal,
    });
  } catch (cause) {
    throw new DownloadFailure(DownloadError.ASSET_FETCH_FAILED, bookId, cause);
  } finally {
    clearTimeout(timer);
  }
}

export interface ChunkedDownloadOptions {
  /** Ceiling on the CIPHERTEXT byte count (not the decrypted size) — see this file's header on
   * why the caller derives this, not this function. Checked as soon as the total is known
   * (first chunk of a fresh download, or immediately on a resume), before any further chunk is
   * requested. */
  maxBytes?: number;
  /** Invoked after every chunk that lands, with the running total — real download-progress
   * reporting, which the non-chunked path never had. */
  onProgress?: (bytesReceived: number, expectedLength: number) => void;
}

/**
 * Chunked, resumable replacement for `fetchEncryptedAsset`. Same signature shape (bookId, url) →
 * whole assembled `Uint8Array`, so callers that don't care about resumability see no difference.
 *
 * Resumability: if a partial download for this exact `bookId` already exists on disk (from a
 * previous call that didn't finish — network drop, app kill, anything), this picks up from
 * `bytesReceived` via `Range: bytes=${bytesReceived}-` instead of starting over. Resuming trusts
 * the existing manifest's `expectedLength` rather than re-validating it against a fresh probe —
 * the scoping doc flags "the asset's total length changed between attempts" as a real but rare
 * edge case deliberately left for a future pass, not resolved here.
 *
 * A server that ignores the `Range` header entirely (200, not 206) is handled too: whatever comes
 * back is treated as the complete asset, any partial state is discarded, and this returns
 * immediately — matching `fetchEncryptedAsset`'s old behavior for a server with no Range support.
 */
export async function fetchEncryptedAssetChunked(
  bookId: BookId,
  url: string,
  options: ChunkedDownloadOptions = {},
): Promise<Uint8Array> {
  const contentFile = partialContentFile(bookId);
  const existing = readManifest(bookId);

  let bytesReceived = 0;
  let expectedLength: number | null = null;

  if (existing && contentFile.exists && contentFile.size === existing.bytesReceived) {
    bytesReceived = existing.bytesReceived;
    expectedLength = existing.expectedLength;
    assertWithinBudget(bookId, expectedLength, options.maxBytes);
    // Report the resumed baseline immediately — otherwise a caller sees stale/zero progress for
    // up to CHUNK_TIMEOUT_MS until the next chunk lands, even though bytesReceived is already
    // known and correct from the manifest.
    options.onProgress?.(bytesReceived, expectedLength);
  } else {
    // Either nothing to resume, or an inconsistent leftover (manifest without matching bytes on
    // disk, or vice versa) — don't trust a state that can't verify itself. Start clean.
    discardPartialDownload(bookId);
  }

  while (expectedLength === null || bytesReceived < expectedLength) {
    const rangeEnd = bytesReceived + CHUNK_SIZE_BYTES - 1;
    const response = await fetchRange(bookId, url, bytesReceived, rangeEnd);

    if (!response.ok) {
      throw new DownloadFailure(
        DownloadError.ASSET_FETCH_FAILED,
        bookId,
        new Error(`encrypted asset fetch responded ${response.status}`),
      );
    }

    const total = response.status === 206 ? parseContentRangeTotal(response) : null;
    const chunkBytes = new Uint8Array(await response.arrayBuffer());

    if (total === null) {
      // No Range support on the server's side — this response IS the whole asset, regardless of
      // how much we thought we already had. Any partial state is now meaningless; drop it.
      discardPartialDownload(bookId);
      appendOrCreate(contentFile, chunkBytes, false);
      const whole = contentFile.bytesSync();
      discardPartialDownload(bookId); // the file we just wrote is now the RETURNED buffer, not a partial
      // This path never sees a 206/Content-Range, so the loop below's per-chunk onProgress never
      // fires — without this, a caller on a non-Range server gets no progress signal at all.
      options.onProgress?.(whole.length, whole.length);
      return whole;
    }

    if (expectedLength === null) {
      expectedLength = total;
      assertWithinBudget(bookId, expectedLength, options.maxBytes);
    }

    appendOrCreate(contentFile, chunkBytes, bytesReceived > 0);
    bytesReceived += chunkBytes.length;
    writeManifest(bookId, { url, expectedLength, bytesReceived });
    options.onProgress?.(bytesReceived, expectedLength);
  }

  const assembled = contentFile.bytesSync();
  discardPartialDownload(bookId);
  return assembled;
}

function assertWithinBudget(bookId: BookId, expectedLength: number, maxBytes: number | undefined): void {
  if (maxBytes !== undefined && expectedLength > maxBytes) {
    discardPartialDownload(bookId);
    throw new DownloadFailure(
      DownloadError.BOOK_TOO_LARGE,
      bookId,
      new Error(`asset is ${expectedLength} bytes on the wire, exceeds the ${maxBytes}-byte budget`),
    );
  }
}
