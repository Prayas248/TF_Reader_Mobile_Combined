// openBook.test.ts — exercises the Open orchestrator (openBook) against a mocked checkLicense(),
// mocked contentStore, and mocked chunkedAssetFetcher. Proves the key behaviors:
//   1. Already-downloaded (any mode): reuses local copy (no fetch)
//   2. Not-yet-downloaded + online/open-access: fetches via chunked fetcher, stores ephemerally
//   3. Offline + valid local licence: decrypts existing content
//   4. checkLicense denial: rethrows as DownloadFailure
//   5. Chunked fetcher enforces maxBytes before the full payload is in memory (BOOK_TOO_LARGE)
//   6. content.originalLength cross-check rejects metadata disagreements (CHECKSUM_MISMATCH)
//
// ONE CALL, NOT TWO (2026-08-23): openBook.ts no longer calls readingSessionClient.ts directly —
// checkLicense() (licenseCheck.ts) is the only seam, so these tests mock that instead of the
// lower-level network client. See licenseCheck.ts's header for why there's no borrow step.

import type { ReadingSessionResponse, LocalLicenceRecord } from '@/shared/contracts';
import { openBook } from './openBook';
import { DownloadError, DownloadFailure } from './errors';
import { contentStore } from '../encryption/contentStore';
import { checkLicense } from './licenseCheck';
import { fetchEncryptedAssetChunked, discardPartialDownload } from './chunkedAssetFetcher';
import type { LicenseCheckResult } from './licenseCheck';

// ── helpers ───────────────────────────────────────────────────────────────

function makeSession(overrides?: Partial<ReadingSessionResponse>): ReadingSessionResponse {
  return {
    sessionId: 'session-test-book',
    licenceId: 'loan-test-book',
    itemId: 'test-book',
    licenceModel: 'SUBSCRIPTION',
    canPersist: true,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    serverTime: new Date().toISOString(),
    content: {
      url: 'http://localhost:4000/fixtures/test-book.epub',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      cipherLength: 28,
      originalLength: 0, // 28-byte ciphertext = 12 nonce + 0 plaintext + 16 tag, when encrypted
      mimeType: 'application/epub+zip',
    },
    encryption: {
      algorithm: 'AES-256-GCM',
      layout: 'nonce(12) || ciphertext || tag(16)',
      wrappedBek: 'base64wrapped',
      wrapAlgorithm: 'RSA-OAEP-256',
      keyFingerprint: 'sha256:mock-fingerprint',
    },
    ...overrides,
  };
}

function makeLicence(overrides?: Partial<LocalLicenceRecord>): LocalLicenceRecord {
  return {
    licenceId: 'loan-test-book',
    itemId: 'test-book',
    keyFingerprint: 'sha256:mock-fingerprint',
    expiresAt: '9999-12-31T23:59:59.000Z',
    canPersist: true,
    rights: { print: false },
    ...overrides,
  };
}

function onlineResult(overrides?: Partial<ReadingSessionResponse>): LicenseCheckResult {
  return { ok: true, mode: 'online', session: makeSession(overrides), licence: makeLicence() };
}

function openAccessLiveResult(overrides?: Partial<ReadingSessionResponse>): LicenseCheckResult {
  return {
    ok: true,
    mode: 'open-access',
    session: makeSession({ licenceModel: 'OPEN_ACCESS', encryption: undefined, ...overrides }),
    licence: makeLicence(),
  };
}

// ── module mocks ──────────────────────────────────────────────────────────

jest.mock('../encryption/contentStore', () => ({
  contentStore: {
    isAvailableOffline: jest.fn().mockResolvedValue(false),
    openSession: jest.fn().mockResolvedValue({ bookId: 'test', format: 'EPUB', openedAt: Date.now() }),
    decryptBook: jest.fn().mockResolvedValue(new Uint8Array([10, 20, 30])),
    close: jest.fn().mockResolvedValue(undefined),
    store: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
  },
  MAX_DECRYPTED_BYTES: 25 * 1024 * 1024,
  MAX_AUDIO_DECRYPTED_BYTES: 20 * 1024 * 1024,
  maxDecryptedBytesFor: (format: string) => (format === 'AUDIO' ? 20 * 1024 * 1024 : 25 * 1024 * 1024),
}));

jest.mock('./licenseCheck', () => ({
  checkLicense: jest.fn(),
}));

jest.mock('./chunkedAssetFetcher', () => ({
  fetchEncryptedAssetChunked: jest.fn(),
  discardPartialDownload: jest.fn(),
}));

// ── tests ─────────────────────────────────────────────────────────────────

describe('openBook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(contentStore.decryptBook).mockResolvedValue(new Uint8Array([10, 20, 30]));
    jest.mocked(contentStore.isAvailableOffline).mockResolvedValue(false);
    jest.mocked(contentStore.openSession).mockResolvedValue({ bookId: 'test', format: 'EPUB', openedAt: Date.now() });
    jest.mocked(contentStore.store).mockResolvedValue(undefined);
    jest.mocked(contentStore.close).mockResolvedValue(undefined);
    jest.mocked(checkLicense).mockResolvedValue(onlineResult());
    jest.mocked(fetchEncryptedAssetChunked).mockResolvedValue(new Uint8Array(28)); // 12 nonce + 0 plaintext + 16 tag
  });

  it('reuses local copy when content is already downloaded (online path)', async () => {
    jest.mocked(contentStore.isAvailableOffline).mockResolvedValue(true);

    const result = await openBook('test-book', 'EPUB');

    expect(result).toEqual(new Uint8Array([10, 20, 30]));
    expect(contentStore.isAvailableOffline).toHaveBeenCalledWith('test-book');
    expect(contentStore.openSession).toHaveBeenCalledWith('test-book');
    expect(contentStore.decryptBook).toHaveBeenCalledWith('test-book');
    // Should NOT have fetched the asset from the network.
    expect(fetchEncryptedAssetChunked).not.toHaveBeenCalled();
  });

  it('fetches via chunked fetcher and stores ephemerally when not yet downloaded', async () => {
    jest.mocked(contentStore.isAvailableOffline).mockResolvedValue(false);
    jest.mocked(fetchEncryptedAssetChunked).mockResolvedValue(new Uint8Array(28));

    const result = await openBook('test-book', 'EPUB');

    expect(result).toEqual(new Uint8Array([10, 20, 30]));
    // Should have fetched via the chunked fetcher, not the single-shot.
    expect(fetchEncryptedAssetChunked).toHaveBeenCalledWith('test-book', expect.any(String), {
      maxBytes: expect.any(Number),
    });
    // Should have stored the ephemeral package.
    expect(contentStore.store).toHaveBeenCalledTimes(1);
    const storedPkg = jest.mocked(contentStore.store).mock.calls[0][0];
    expect(storedPkg.bookId).toBe('test-book');
    // canPersist is forced false — ephemeral Elite path.
    expect(storedPkg.licence!.canPersist).toBe(false);
  });

  it('decrypts existing content via offline fallback when network is unreachable', async () => {
    jest.mocked(checkLicense).mockResolvedValue({
      ok: true,
      mode: 'offline-license',
      licence: makeLicence({ licenceId: 'old-licence' }),
    });

    const result = await openBook('test-book', 'EPUB');

    expect(result).toEqual(new Uint8Array([10, 20, 30]));
    expect(contentStore.openSession).toHaveBeenCalledWith('test-book');
    expect(contentStore.decryptBook).toHaveBeenCalledWith('test-book');
    // Should NOT have fetched from network or stored anything.
    expect(fetchEncryptedAssetChunked).not.toHaveBeenCalled();
    expect(contentStore.store).not.toHaveBeenCalled();
  });

  it('throws OFFLINE_LICENSE_UNAVAILABLE when checkLicense denies with that reason', async () => {
    jest.mocked(checkLicense).mockResolvedValue({
      ok: false,
      reason: DownloadError.OFFLINE_LICENSE_UNAVAILABLE,
    });

    await expect(openBook('test-book', 'EPUB')).rejects.toThrow(
      expect.objectContaining({ code: DownloadError.OFFLINE_LICENSE_UNAVAILABLE }),
    );
  });

  it('open-access: reads local copy offline when a licence-less open-access book was previously downloaded', async () => {
    // Offline fallback's open-access variant carries no session/licence at all (licenseCheck.ts).
    jest.mocked(checkLicense).mockResolvedValue({ ok: true, mode: 'open-access' });
    jest.mocked(contentStore.isAvailableOffline).mockResolvedValue(true);

    const result = await openBook('test-book', 'EPUB');

    expect(result).toEqual(new Uint8Array([10, 20, 30]));
    expect(contentStore.openSession).toHaveBeenCalledWith('test-book');
    expect(contentStore.decryptBook).toHaveBeenCalledWith('test-book');
    // No network calls of any kind — served entirely from disk.
    expect(fetchEncryptedAssetChunked).not.toHaveBeenCalled();
    expect(contentStore.store).not.toHaveBeenCalled();
  });

  it('open-access offline fallback with no local copy is a defensive failure, not a crash', async () => {
    // Should not happen in practice — the offline fallback only returns a session-less
    // open-access result when the book IS downloaded (licenseCheck.ts's offlineFallback). This
    // pins the defensive guard in openBook.ts for if that invariant is ever violated.
    jest.mocked(checkLicense).mockResolvedValue({ ok: true, mode: 'open-access' });
    jest.mocked(contentStore.isAvailableOffline).mockResolvedValue(false);

    await expect(openBook('test-book', 'EPUB')).rejects.toThrow(
      expect.objectContaining({ code: DownloadError.OFFLINE_LICENSE_UNAVAILABLE }),
    );
  });

  it('throws BOOK_TOO_LARGE when chunked fetcher aborts due to oversized asset', async () => {
    jest.mocked(contentStore.isAvailableOffline).mockResolvedValue(false);
    jest.mocked(fetchEncryptedAssetChunked).mockRejectedValue(
      new DownloadFailure(
        DownloadError.BOOK_TOO_LARGE,
        'test-book',
        new Error('asset is 30000000 bytes on the wire, exceeds the 25165843-byte budget'),
      ),
    );

    await expect(openBook('test-book', 'EPUB')).rejects.toThrow(
      expect.objectContaining({ code: DownloadError.BOOK_TOO_LARGE }),
    );
    // Partial state should be cleaned up on abort.
    expect(discardPartialDownload).toHaveBeenCalledWith('test-book');
  });

  it('throws CHECKSUM_MISMATCH when server originalLength disagrees with cipherLength', async () => {
    jest.mocked(contentStore.isAvailableOffline).mockResolvedValue(false);
    // 28-byte ciphertext (12 nonce + 0 plaintext + 16 tag) but server claims originalLength=999
    jest.mocked(checkLicense).mockResolvedValue(onlineResult({ content: { url: 'http://localhost:4000/fixtures/test-book.epub', expiresAt: '', cipherLength: 28, originalLength: 999, mimeType: 'application/epub+zip' } }));
    jest.mocked(fetchEncryptedAssetChunked).mockResolvedValue(new Uint8Array(28));

    await expect(openBook('test-book', 'EPUB')).rejects.toThrow(
      expect.objectContaining({ code: DownloadError.CHECKSUM_MISMATCH }),
    );
    // Nothing should be stored when the cross-check fails.
    expect(contentStore.store).not.toHaveBeenCalled();
  });

  // Pins the fix for "Read on a full Elite title shows a generic download failure instead of
  // joining the queue" — the real backend answers a copy-limited (ELITE) title with no free copy
  // by queuing the reader INSIDE the reading-session response itself: no `content`, but
  // `holdCreatedAt` set. That must throw the actionable NO_COPIES_AVAILABLE, not the generic
  // SESSION_FETCH_FAILED a genuinely malformed response gets.
  it('throws NO_COPIES_AVAILABLE, not SESSION_FETCH_FAILED, when the session is queued (no content, holdCreatedAt set)', async () => {
    jest.mocked(contentStore.isAvailableOffline).mockResolvedValue(false);
    jest.mocked(checkLicense).mockResolvedValue(
      onlineResult({
        licenceModel: 'ELITE',
        content: undefined as never,
        holdCreatedAt: new Date().toISOString(),
      }),
    );

    await expect(openBook('test-book', 'AUDIO')).rejects.toThrow(
      expect.objectContaining({ code: DownloadError.NO_COPIES_AVAILABLE }),
    );
    expect(fetchEncryptedAssetChunked).not.toHaveBeenCalled();
  });

  it('still throws the generic SESSION_FETCH_FAILED when content is missing and holdCreatedAt is absent too', async () => {
    jest.mocked(contentStore.isAvailableOffline).mockResolvedValue(false);
    jest.mocked(checkLicense).mockResolvedValue(
      onlineResult({ content: undefined as never, holdCreatedAt: undefined }),
    );

    await expect(openBook('test-book', 'EPUB')).rejects.toThrow(
      expect.objectContaining({ code: DownloadError.SESSION_FETCH_FAILED }),
    );
  });

  it('passes maxBytes budget to chunked fetcher accounting for nonce + tag overhead', async () => {
    jest.mocked(contentStore.isAvailableOffline).mockResolvedValue(false);
    jest.mocked(fetchEncryptedAssetChunked).mockResolvedValue(new Uint8Array(28));

    await openBook('test-book', 'EPUB');

    const MAX_DECRYPTED_BYTES = 25 * 1024 * 1024;
    expect(fetchEncryptedAssetChunked).toHaveBeenCalledWith('test-book', expect.any(String), {
      maxBytes: MAX_DECRYPTED_BYTES + 12 + 16, // NONCE_BYTES + GCM_TAG_BYTES
    });
  });

  it('reuses local copy when already downloaded, even for PDF', async () => {
    jest.mocked(contentStore.isAvailableOffline).mockResolvedValue(true);

    const result = await openBook('test-book', 'PDF');

    expect(result).toEqual(new Uint8Array([10, 20, 30]));
    expect(contentStore.openSession).toHaveBeenCalledWith('test-book');
    expect(contentStore.decryptBook).toHaveBeenCalledWith('test-book');
    expect(fetchEncryptedAssetChunked).not.toHaveBeenCalled();
    expect(contentStore.store).not.toHaveBeenCalled();
  });

  // ── open-access tests ─────────────────────────────────────────────────────

  it('fetches asset for a live open-access session, stores ephemerally', async () => {
    // checkLicense already resolved the session for open-access — no second fetch here.
    jest.mocked(checkLicense).mockResolvedValue(
      openAccessLiveResult({ content: { url: 'http://localhost:4000/fixtures/test-book.epub', expiresAt: '', cipherLength: 28, originalLength: 28, mimeType: 'application/epub+zip' } }),
    );
    jest.mocked(fetchEncryptedAssetChunked).mockResolvedValue(new Uint8Array(28));

    const result = await openBook('test-book', 'EPUB');

    expect(result).toEqual(new Uint8Array([10, 20, 30]));
    expect(fetchEncryptedAssetChunked).toHaveBeenCalled();
    expect(contentStore.store).toHaveBeenCalledTimes(1);
    expect(contentStore.openSession).toHaveBeenCalledWith('test-book');
    expect(contentStore.decryptBook).toHaveBeenCalledWith('test-book');
  });

  it('open-access: reuses local copy when already downloaded, without ever fetching the asset', async () => {
    jest.mocked(checkLicense).mockResolvedValue(openAccessLiveResult());
    jest.mocked(contentStore.isAvailableOffline).mockResolvedValue(true);

    const result = await openBook('test-book', 'EPUB');

    expect(result).toEqual(new Uint8Array([10, 20, 30]));
    expect(contentStore.openSession).toHaveBeenCalledWith('test-book');
    expect(contentStore.decryptBook).toHaveBeenCalledWith('test-book');
    expect(fetchEncryptedAssetChunked).not.toHaveBeenCalled();
    expect(contentStore.store).not.toHaveBeenCalled();
  });

  it('attaches a licence with canPersist: false (non-null) for open-access', async () => {
    jest.mocked(checkLicense).mockResolvedValue(
      openAccessLiveResult({ content: { url: 'http://localhost:4000/fixtures/test-book.epub', expiresAt: '', cipherLength: 28, originalLength: 28, mimeType: 'application/epub+zip' } }),
    );
    jest.mocked(fetchEncryptedAssetChunked).mockResolvedValue(new Uint8Array(28));

    await openBook('test-book', 'EPUB');

    expect(contentStore.store).toHaveBeenCalledTimes(1);
    const storedPkg = jest.mocked(contentStore.store).mock.calls[0][0];
    // KEY ASSERTION: non-null licence with canPersist: false → isElite() returns true → in-memory only.
    expect(storedPkg.licence).not.toBeNull();
    expect(storedPkg.licence!.canPersist).toBe(false);
  });

  it('open-access: cleans up partial download on fetch error', async () => {
    jest.mocked(checkLicense).mockResolvedValue(openAccessLiveResult());
    jest.mocked(fetchEncryptedAssetChunked).mockRejectedValue(
      new DownloadFailure(DownloadError.BOOK_TOO_LARGE, 'test-book', new Error('oversized')),
    );

    await expect(openBook('test-book', 'EPUB')).rejects.toThrow(
      expect.objectContaining({ code: DownloadError.BOOK_TOO_LARGE }),
    );
    expect(discardPartialDownload).toHaveBeenCalledWith('test-book');
  });

  it('open-access: throws BOOK_TOO_LARGE when oversized', async () => {
    jest.mocked(checkLicense).mockResolvedValue(openAccessLiveResult());
    jest.mocked(fetchEncryptedAssetChunked).mockRejectedValue(
      new DownloadFailure(
        DownloadError.BOOK_TOO_LARGE,
        'test-book',
        new Error('asset is 30000000 bytes on the wire, exceeds the 25165843-byte budget'),
      ),
    );

    await expect(openBook('test-book', 'EPUB')).rejects.toThrow(
      expect.objectContaining({ code: DownloadError.BOOK_TOO_LARGE }),
    );
  });
});
