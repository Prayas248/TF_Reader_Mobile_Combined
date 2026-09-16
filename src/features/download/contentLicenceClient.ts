// Owner: Download (Abhinav).
//
// "Resolve encrypted asset by Book ID" — BuildPlan.md Phase 4 item 3: "Hit the content/licence
// endpoint; receive encrypted file + wrapped BEK + licence + validity dates." Two steps because
// the licence response only carries a URL (encryptedFileUrl) to the actual bytes, not the bytes
// themselves — mock-backend serves the fixture separately under /fixtures/*.enc (see
// mock-backend/server.js and mock-backend/routes/contentLicence.js).
//
// Both functions throw DownloadFailure, never a bare fetch/TypeError — downloadManager.ts (and
// any future caller) can switch on `.code` without also handling raw network exceptions.

import type { BookId, ContentLicenceResponse } from '@/shared/contracts';
import { API_BASE_URL } from './config';
import { DownloadError, DownloadFailure } from './errors';

// Same value and same abort-controller-plus-timer shape as readingSessionClient.ts's own
// REQUEST_TIMEOUT_MS (not imported from there — sibling files, not a shared config; see that
// file's comment on why `download/` doesn't reach into another module's config either). Small,
// metadata-shaped request — same budget as borrowLoan/openReadingSession.
const REQUEST_TIMEOUT_MS = 8000;

// `fetchEncryptedAsset` was the one call in the download flow that fetched the actual book
// payload — the largest, slowest request — with NO timeout at all: a stalled connection (dead
// proxy, captive portal) left `await fetch(...)` pending forever, with no way for downloadBook()
// to ever time out or reject. Fixed once by reusing REQUEST_TIMEOUT_MS above (8s) — found in
// review to be a SECOND bug, not a fix: React Native's `fetch` (whatwg-fetch over XHR) resolves
// only once the WHOLE response body has arrived, not at headers-received time, so that one timer
// bounded the entire transfer, body included. 8s caps a small JSON response fine; it caps a
// legitimate, licensed book (up to MAX_DECRYPTED_BYTES — 25MB, contentStore.ts) at a required
// throughput of over 3MB/s just to finish before being aborted — an ordinary slow/congested
// mobile connection would time out mid-download every time, not just a genuinely dead one.
// 60s assumes a conservative ~500KB/s (4 Mbps) floor for a still-legitimate connection; slower
// than that is arguably fair to fail on, same posture most download UIs take. Kept as a distinct
// constant, not a shared one, so nobody "fixes" this back down to the metadata-call value by
// deduplicating it.
const ASSET_FETCH_TIMEOUT_MS = 60_000;

export async function fetchContentLicence(bookId: BookId): Promise<ContentLicenceResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/books/${encodeURIComponent(bookId)}/content-licence`, {
      signal: controller.signal,
    });
  } catch (cause) {
    throw new DownloadFailure(DownloadError.LICENCE_FETCH_FAILED, bookId, cause);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new DownloadFailure(
      DownloadError.LICENCE_FETCH_FAILED,
      bookId,
      new Error(`content-licence responded ${response.status}`),
    );
  }
  return (await response.json()) as ContentLicenceResponse;
}

/**
 * `encryptedFileUrl` is an ABSOLUTE url the backend chose, and it always carries whatever host the
 * backend's OWN config names for the service that actually stores the bytes — `localhost` for a
 * local mock/MinIO, a real host in front of B2 in production. "localhost" is resolved by whoever
 * fetches it — on a physical device or an emulator that isn't the machine running that service,
 * that's the DEVICE, and the fetch fails. config.ts already went to the trouble of resolving a
 * LAN-reachable host for `API_BASE_URL` (the content-licence/reading-session request that produced
 * this url succeeded via it), so reuse that HOST here.
 *
 * EVERY OTHER WELL-KNOWN "THIS MEANS THE SERVER ITSELF" ALIAS GETS THE SAME TREATMENT AS
 * `localhost`, for the same reason and the same failure mode: each is meaningful only inside
 * whatever process/VM produced the url, never to a device fetching it from outside. `10.0.2.2` is
 * the Android EMULATOR's own alias for its host machine's loopback — a presigned B2/S3 url built
 * while the storage endpoint (or whatever produced this url) was pointed at it, e.g. left over
 * from a prior emulator-only test run, reaches a real device as `ConnectionException: Failed to
 * connect to /10.0.2.2:8080` — confirmed live, 2026-09-16, against a physical device on a release
 * build. `10.0.3.2` is Genymotion's equivalent. `0.0.0.0` and IPv6 `::1`/`[::1]` are the other
 * standard loopback spellings a misconfigured endpoint could just as easily emit.
 *
 * This is a fix for the whole CLASS of "the backend handed out its own idea of itself" bug, not
 * a guarantee against every possible misconfiguration — a stale-but-real LAN IP or an unrelated
 * wrong host is indistinguishable from a genuine CDN url from here, and rewriting on a guess would
 * risk breaking the one case this function must never touch (see "Any other host" below). Those
 * need fixing at the source, the same way this one was traced back to the backend's own storage
 * endpoint config rather than patched blindly on this side alone.
 *
 * THE HOST AND PROTOCOL, BUT NEVER THE PORT — this used to copy `base.port` too, back when the
 * mock backend served both the API and its mock asset files from the same port (4000), so copying
 * it was an unobservable no-op. It no longer is: the real backend's API is on :8080, but a signed
 * asset URL points at MinIO/S3 on a completely different port (:9000). Copying the API's port
 * turned a valid presigned MinIO url into a request AT THE BACKEND ITSELF for a path it has no
 * route for, which Spring Security correctly, and unhelpfully, answers with 401 UNAUTHENTICATED
 * rather than 404 — confirmed live, 2026-09-02: `ASSET_FETCH_FAILED: encrypted asset fetch
 * responded 401`, and the backend's own log for the same request names the giveaway path —
 * `/test-books/static/mock-content/...` — the S3 object key, arriving at the API server that has
 * never heard of it. A presigned URL's signature also covers its own host and port, so rewriting
 * either would invalidate it even if the backend did have a matching route. The protocol still
 * follows `API_BASE_URL`'s, deliberately — an https override (a tunnel/proxy) must not leave the
 * asset fetch stranded on http.
 *
 * Any other host is left completely alone — a real CDN url must not be rewritten.
 */
const LOOPBACK_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  '10.0.2.2', // Android emulator's alias for its host machine
  '10.0.3.2', // Genymotion's equivalent alias
]);

export function reachableAssetUrl(url: string): string {
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
    base = new URL(API_BASE_URL);
  } catch {
    // Not something the URL parser understands — hand it to fetch verbatim and let fetch's own
    // error be the one the caller sees, rather than inventing a different failure here.
    return url;
  }
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    return url;
  }
  if (base.hostname === parsed.hostname) {
    return url; // API_BASE_URL is itself localhost (e.g. a simulator on the dev machine) — no-op.
  }
  parsed.protocol = base.protocol;
  parsed.hostname = base.hostname;
  return parsed.toString();
}

export async function fetchEncryptedAsset(bookId: BookId, url: string): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASSET_FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(reachableAssetUrl(url), { signal: controller.signal });
  } catch (cause) {
    throw new DownloadFailure(DownloadError.ASSET_FETCH_FAILED, bookId, cause);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new DownloadFailure(
      DownloadError.ASSET_FETCH_FAILED,
      bookId,
      new Error(`encrypted asset fetch responded ${response.status}`),
    );
  }
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}
