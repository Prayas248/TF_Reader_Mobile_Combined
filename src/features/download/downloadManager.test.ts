// Integration-style test: real contentStore (real filesystem via __mocks__/expo-file-system.js,
// real AES-GCM math via the manual native-module mocks), real downloadTable (real SQLite via
// __mocks__/expo-sqlite.js), mocked global.fetch only. Proves the FULL orchestration order and
// every failure branch, and specifically the 5-book-limit-across-different-books behavior that
// motivated using downloadTable instead of downloadRepository (see the design doc).
//
// REAL FLAMBEAU CONTRACT (2026-08-14): downloadBook now hits THREE endpoints, not two —
// `POST /api/v1/loans` (borrowLoan), `POST /api/v1/reading-sessions` (openReadingSession), then
// the asset itself at `session.content.url` (and `session.index.url`, if present) — instead of the
// old mock-shaped `GET /books/:id/content-licence` + asset. See readingSessionClient.ts and
// src/shared/contracts/reading-session.ts for the real shapes being mocked here.

import * as crypto from 'crypto';
import * as Keychain from 'react-native-keychain';
import { clearAllDownloads, downloadBook } from './downloadManager';
import { downloadTable } from '../sync/stores/downloadStore';
import { USER_ID } from '../sync/syncConfig';
import { contentStore, decryptSearchIndex, MAX_DECRYPTED_BYTES } from '../encryption/contentStore';
import { encrypt } from '../encryption/aesGcm';
import { generateDeviceKeypair, wrapBek, publicKeyFingerprint } from '../encryption/deviceKeypair';
import { CHUNK_SIZE_BYTES } from './chunkedAssetFetcher';
import { DownloadError, DownloadFailure } from './errors';
import { Paths } from 'expo-file-system';
import { API_BASE_URL } from './config';
import { api } from '@/features/sync/syncApi';
import type { FlambeauError, Loan, ReadingSessionResponse } from '@/shared/contracts';

// downloadBook() now checks the server for existing history (any device, possibly tombstoned)
// before minting a new local id (2026-08-31, closes the downloads-CODE_TAKEN investigation) - this
// file's global.fetch mocks below are shaped for Download's own endpoints only (reading-sessions,
// asset bytes), so a real request through Sync's syncApi to /api/v1/downloads would 404 against
// them. Mocked separately: every test here is a fresh, first-time download, so "no existing
// record" is the correct default throughout.
jest.mock('@/features/sync/syncApi', () => ({
  api: {
    list: jest.fn().mockResolvedValue({ data: [], serverTime: '' }),
    restore: jest.fn().mockResolvedValue({ data: {}, serverTime: '' }),
  },
}));

// A plain OPEN_ACCESS loan — canPersist:true (open access always persists; there's no key
// material to protect by refusing to write it), no dueAt (open access never expires, per
// reading-session.ts's own header).
function openAccessLoanFor(bookId: string, overrides?: Partial<Loan>): Loan {
  return {
    loanId: `loan-${bookId}`,
    itemId: bookId,
    userId: USER_ID,
    licenceModel: 'OPEN_ACCESS',
    status: 'ACTIVE',
    borrowedAt: new Date().toISOString(),
    canPersist: true,
    serverTime: new Date().toISOString(),
    ...overrides,
  };
}

// `content.originalLength` defaults to `content.length` (open access: content IS plaintext, no
// nonce/tag overhead) — callers exercising the encrypted branch override it via `overrides`.
function sessionFor(
  bookId: string,
  content: Uint8Array,
  overrides?: Partial<ReadingSessionResponse>,
): ReadingSessionResponse {
  return {
    sessionId: `session-${bookId}`,
    itemId: bookId,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    serverTime: new Date().toISOString(),
    content: {
      url: `http://localhost:4000/fixtures/${bookId}.epub`,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      cipherLength: content.length,
      originalLength: content.length,
      mimeType: 'application/epub+zip',
    },
    ...overrides,
  };
}

// Mocks fetch across all the URLs downloadBook now hits: session, the main asset, and (if
// `session.index` is set) the index asset. `/api/v1/loans` is mocked too but never actually
// requested — checkLicense.ts no longer calls it (the real backend has no POST for it; see its
// header, D-020) — kept only so a stray call fails loudly with a real response instead of a
// silent 404, if that ever regresses.
//
// `loan`'s `licenceModel`/`canPersist`/`loanId` are merged onto the served session UNLESS the
// test's own `session` already set them explicitly (via `sessionFor`'s `overrides`) — the real
// backend puts these fields on `ReadingSessionResponse` itself now (reading-session.ts's header),
// so this is what keeps every existing `openAccessLoanFor(bookId, {...})` call driving the same
// behavior it did before, without touching every call site individually.
function mockFetchFor(
  loan: Loan,
  session: ReadingSessionResponse,
  content: Uint8Array<ArrayBuffer>,
  indexBytes?: Uint8Array<ArrayBuffer>,
) {
  const servedSession: ReadingSessionResponse = {
    licenceId: loan.loanId,
    licenceModel: loan.licenceModel,
    canPersist: loan.canPersist,
    ...session,
  };
  return jest.fn().mockImplementation(async (url: string) => {
    if (url === `${API_BASE_URL}/api/v1/loans`) {
      return new Response(JSON.stringify(loan), { status: 200 });
    }
    if (url === `${API_BASE_URL}/api/v1/reading-sessions`) {
      return new Response(JSON.stringify(servedSession), { status: 200 });
    }
    if (url === session.content.url) {
      return new Response(content, { status: 200 });
    }
    if (session.index && url === session.index.url) {
      return new Response(indexBytes ?? new Uint8Array(), { status: 200 });
    }
    return new Response(null, { status: 404 });
  });
}

describe('downloadBook — happy path', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('stores the book via contentStore and records a downloads row, never touching plaintext-on-disk outside contentStore', async () => {
    const bookId = 'happy-path-book';
    const content = new Uint8Array([10, 20, 30, 40, 50]); // open access: content IS plaintext
    const loan = openAccessLoanFor(bookId);
    const session = sessionFor(bookId, content);
    global.fetch = mockFetchFor(loan, session, content);

    await downloadBook(bookId);

    expect(await contentStore.isAvailableOffline(bookId)).toBe(true);
    const rows = await downloadTable.listActive(USER_ID);
    const row = rows.find((r) => r.book_id === bookId);
    expect(row).toBeDefined();
    expect(row!.status).toBe('COMPLETED');
    expect(row!.local_path).toBeNull();
  });

  it('re-downloading the SAME book updates its existing row rather than creating a second one', async () => {
    const bookId = 'repeat-download-book';
    const content = new Uint8Array([1, 2, 3]);
    const loan = openAccessLoanFor(bookId);
    const session = sessionFor(bookId, content);
    global.fetch = mockFetchFor(loan, session, content);

    await downloadBook(bookId);
    const firstRows = await downloadTable.listActive(USER_ID);
    const firstRow = firstRows.find((r) => r.book_id === bookId)!;

    await downloadBook(bookId);
    const secondRows = await downloadTable.listActive(USER_ID);
    const matching = secondRows.filter((r) => r.book_id === bookId);

    expect(matching).toHaveLength(1);
    expect(matching[0].id).toBe(firstRow.id);
  });

  // Found in review (D-16): `content.originalLength`/`mimeType` are OPTIONAL on the real spec (no
  // `*` on either in wokay's schema) — comparing a real number against an ABSENT field used to be
  // unconditional, so a response that legitimately omitted `originalLength` made every download
  // reject with a CHECKSUM_MISMATCH blaming a field that was never sent. `computeOriginalLength`
  // must be the FALLBACK VALUE when absent, not just a cross-check against one.
  it('succeeds when content.originalLength and mimeType are both absent from the response', async () => {
    const bookId = 'optional-fields-absent-book';
    const content = new Uint8Array([7, 8, 9, 10]); // open access: content IS plaintext
    const loan = openAccessLoanFor(bookId);
    const session = sessionFor(bookId, content);
    delete (session.content as { originalLength?: number }).originalLength;
    delete (session.content as { mimeType?: string }).mimeType;
    global.fetch = mockFetchFor(loan, session, content);

    await expect(downloadBook(bookId)).resolves.toBeUndefined();
    expect(await contentStore.isAvailableOffline(bookId)).toBe(true);

    await contentStore.openSession(bookId);
    const decrypted = await contentStore.decryptBook(bookId);
    expect(Array.from(decrypted)).toEqual(Array.from(content));
    await contentStore.close(bookId);
  });
});

// Matches deviceKeypair.ts's internal constant — duplicated here only for the scoped keychain
// cleanup below, exactly as contentStore.test.ts does it (deviceKeypair.ts exposes no reset).
const DEVICE_PRIVATE_KEY_SERVICE = 'tf-reader-device-private-key';

describe('downloadBook — the ENCRYPTED (Subscription) path, for real', () => {
  const originalFetch = global.fetch;
  afterEach(async () => {
    global.fetch = originalFetch;
    await Keychain.resetGenericPassword({ service: DEVICE_PRIVATE_KEY_SERVICE });
  });

  // Every other test in this file uses an open-access session (encryption/licence both null),
  // which never exercises computeOriginalLength's ENCRYPTED branch (cipherLength - NONCE - TAG).
  // This one does, against real AES-GCM bytes and a real RSA-OAEP-wrapped BEK — the same
  // generateDeviceKeypair -> wrapBek -> store -> decryptBook path contentStore.test.ts's
  // "end-to-end via the real device keypair" block proves for contentStore alone, driven here
  // through downloadBook instead. It CAN fail: an off-by-one in that subtraction makes
  // contentStore.store()'s own assertLengthInvariant reject the package outright
  // (ContentFailure(INTEGRITY_FAILED)), and a wrong nonce/tag split makes decryptBook reject.
  //
  // `loan.canPersist: true` is the load-bearing bit for THIS describe block's name: it is what
  // makes downloadManager.ts derive `intent: 'DOWNLOAD'` (not hardcoded) — see this file's header.
  it('downloads, stores and decrypts an AES-256-GCM book with a real wrapped BEK', async () => {
    const bookId = 'encrypted-subscription-book';
    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const bek = new Uint8Array(crypto.randomBytes(32));

    const { publicKey } = await generateDeviceKeypair();
    const wrappedBek = await wrapBek(bek, publicKey);

    // aesGcm.encrypt returns a CipherPayload whose `content` is nonce(12)||ciphertext||tag(16) —
    // exactly the bytes the mock backend would serve at content.url.
    const payload = await encrypt(plaintext, bek);
    const encryptedBytes = new Uint8Array(payload.content);

    // downloadManager.ts now derives LocalLicenceRecord.keyFingerprint from the device's OWN key
    // (publicKeyFingerprint), independently of whatever encryption.keyFingerprint the server
    // reports — contentStore.ts's licence/encryption fingerprint check only means anything if
    // this mock server "claim" genuinely matches the same device key downloadBook wraps the BEK
    // under below, same as a real backend fingerprinting the devicePublicKey it received.
    const keyFingerprint = await publicKeyFingerprint(publicKey);
    const loan = openAccessLoanFor(bookId, {
      licenceModel: 'SUBSCRIPTION',
      canPersist: true, // Subscription, not Elite: persists to disk
      dueAt: new Date(Date.now() + 86_400_000).toISOString(), // +1 day — the offline reopen window
    });
    const session = sessionFor(bookId, encryptedBytes, {
      content: {
        url: `http://localhost:4000/fixtures/${bookId}.epub.enc`,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        cipherLength: encryptedBytes.length,
        originalLength: plaintext.length, // the PLAINTEXT length, per SignedUrl's own shape
        mimeType: 'application/epub+zip',
      },
      encryption: {
        algorithm: 'AES-256-GCM',
        layout: 'nonce(12) || ciphertext || tag(16)',
        wrappedBek,
        wrapAlgorithm: 'RSA-OAEP-256',
        keyId: 'master-v1',
        keyFingerprint,
      },
    });
    global.fetch = mockFetchFor(loan, session, encryptedBytes);

    await expect(downloadBook(bookId)).resolves.toBeUndefined();
    expect(await contentStore.isAvailableOffline(bookId)).toBe(true);

    // Full round trip: the bytes downloadBook handed to store() really do decrypt back to the
    // original plaintext, via the real device private key and the real GCM tag check.
    await contentStore.openSession(bookId);
    const decrypted = await contentStore.decryptBook(bookId);
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
    await contentStore.close(bookId);
  });

  // The other real case `needsLicence` has to get right, and the one that was still wrong until
  // 2026-08-25: a dev fixture whose `licenceModel` is OPEN_ACCESS but whose grant still carries
  // `encryption` (tf_reader_backend_temp's dev-sample-epub — a documented quirk, since real
  // OPEN_ACCESS should never be encrypted). Gating solely on `license.mode !== 'open-access'`
  // left `pkg.licence` null here while `pkg.encryption` was not, and contentStore.ts's
  // assertLicenceMatchesPackage() correctly rejects exactly that combination with
  // LICENCE_INVALID — confirmed via device testing, on every single download of that fixture.
  it('an OPEN_ACCESS book that is still encrypted gets a licence attached, not LICENCE_INVALID', async () => {
    const bookId = 'open-access-but-encrypted-book';
    const plaintext = new Uint8Array([7, 8, 9, 10, 11, 12]);
    const bek = new Uint8Array(crypto.randomBytes(32));

    const { publicKey } = await generateDeviceKeypair();
    const wrappedBek = await wrapBek(bek, publicKey);
    const payload = await encrypt(plaintext, bek);
    const encryptedBytes = new Uint8Array(payload.content);
    const keyFingerprint = await publicKeyFingerprint(publicKey);

    const loan = openAccessLoanFor(bookId, { canPersist: true }); // licenceModel stays OPEN_ACCESS
    const session = sessionFor(bookId, encryptedBytes, {
      content: {
        url: `http://localhost:4000/fixtures/${bookId}.epub.enc`,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        cipherLength: encryptedBytes.length,
        originalLength: plaintext.length,
        mimeType: 'application/epub+zip',
      },
      encryption: {
        algorithm: 'AES-256-GCM',
        layout: 'nonce(12) || ciphertext || tag(16)',
        wrappedBek,
        wrapAlgorithm: 'RSA-OAEP-256',
        keyId: 'master-v1',
        keyFingerprint,
      },
    });
    global.fetch = mockFetchFor(loan, session, encryptedBytes);

    await expect(downloadBook(bookId)).resolves.toBeUndefined();
    expect(await contentStore.isAvailableOffline(bookId)).toBe(true);

    // Round trip proves a real licence was attached and matched the encryption block — store()
    // would have thrown LICENCE_INVALID on the old `needsLicence` before this can even resolve.
    await contentStore.openSession(bookId);
    const decrypted = await contentStore.decryptBook(bookId);
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
    await contentStore.close(bookId);

    // Clean up the persisted row this test adds — this file's later tests (the 5-book-limit
    // block especially) count real rows in the shared downloadTable, and this test's own
    // successful persist would otherwise silently eat one of their budget.
    await contentStore.destroy(bookId);
    const rows = await downloadTable.listActive(USER_ID);
    const row = rows.find((r) => r.book_id === bookId);
    if (row) {
      await downloadTable.softDeleteLocal(row.id);
    }
  });

  // The end-to-end wiring for the anti-key-substitution check, not just contentStore's own unit
  // coverage of it: downloadManager.ts derives `licence.keyFingerprint` from THIS device's own
  // key (`publicKeyFingerprint()`), independently of whatever `encryption.keyFingerprint` the
  // server sends — so a server claim that disagrees with this device's real key must be caught
  // and rejected before the book is ever persisted, not silently trusted.
  it('rejects — and never persists — when the server-claimed encryption.keyFingerprint does not match this device key', async () => {
    const bookId = 'encrypted-subscription-bad-fingerprint';
    const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
    const bek = new Uint8Array(crypto.randomBytes(32));

    const { publicKey } = await generateDeviceKeypair();
    const wrappedBek = await wrapBek(bek, publicKey); // wraps to the REAL device key — only the
    // claimed fingerprint below is wrong, isolating this test to the fingerprint check alone.
    const payload = await encrypt(plaintext, bek);
    const encryptedBytes = new Uint8Array(payload.content);

    const loan = openAccessLoanFor(bookId, {
      licenceModel: 'SUBSCRIPTION',
      canPersist: true,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const session = sessionFor(bookId, encryptedBytes, {
      content: {
        url: `http://localhost:4000/fixtures/${bookId}.epub.enc`,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        cipherLength: encryptedBytes.length,
        originalLength: plaintext.length,
        mimeType: 'application/epub+zip',
      },
      encryption: {
        algorithm: 'AES-256-GCM',
        layout: 'nonce(12) || ciphertext || tag(16)',
        wrappedBek,
        wrapAlgorithm: 'RSA-OAEP-256',
        keyId: 'master-v1',
        keyFingerprint: 'sha256:not-this-devices-key-at-all',
      },
    });
    const fetchMock = mockFetchFor(loan, session, encryptedBytes);
    global.fetch = fetchMock;

    // C7/B3 follow-up: this check now happens in downloadManager.ts, right after the session
    // response and BEFORE fetchEncryptedAsset — see this directory's API_CONTRACT_NOTES.md.
    // KEY_SUBSTITUTION, not ContentError.LICENCE_INVALID (contentStore.ts's own check is defense
    // in depth for direct callers, but the real download path never reaches it — proven below by
    // asserting the asset URL was never even requested).
    await expect(downloadBook(bookId)).rejects.toMatchObject({
      code: DownloadError.KEY_SUBSTITUTION,
    });
    expect(await contentStore.isAvailableOffline(bookId)).toBe(false);
    const requestedUrls = fetchMock.mock.calls.map((call) => call[0]);
    expect(requestedUrls).not.toContain(session.content.url);
  });
});

describe('downloadBook — the ELITE (online-only) path, for real', () => {
  const originalFetch = global.fetch;
  afterEach(async () => {
    global.fetch = originalFetch;
    await Keychain.resetGenericPassword({ service: DEVICE_PRIVATE_KEY_SERVICE });
  });

  // BEHAVIOR CHANGE (2026-08-23): this used to prove downloadManager.ts auto-downgraded
  // `intent: 'DOWNLOAD'` to `'STREAM'` for a canPersist:false loan (known ahead of the reading-
  // session call, from a separate borrow step) and succeeded anyway, non-persisted. There is no
  // borrow step anymore (checkLicense.ts calls openReadingSession() only — see its header,
  // D-020), so canPersist isn't known until that call already returns, and there is nothing left
  // to downgrade against beforehand. `downloadBook()` now sends 'DOWNLOAD' as requested and lets
  // the real server's refusal (403 DOWNLOAD_NOT_PERMITTED for ELITE) surface as a real failure —
  // the caller should use `openBook()` (`'STREAM'`) for this book instead. This proves the intent
  // sent really is 'DOWNLOAD' (not silently downgraded) AND that nothing persists on the refusal.
  it('rejects with DOWNLOAD_NOT_PERMITTED for an ELITE (canPersist:false) book, intent sent as DOWNLOAD', async () => {
    const bookId = 'elite-online-only-book';
    let requestedIntent: string | undefined;

    global.fetch = jest.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
      if (url === `${API_BASE_URL}/api/v1/reading-sessions`) {
        requestedIntent = init?.body ? (JSON.parse(init.body) as { intent?: string }).intent : undefined;
        return new Response(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            status: 403,
            code: 'DOWNLOAD_NOT_PERMITTED',
            message: 'ELITE titles are online-only',
            path: '/api/v1/reading-sessions',
          }),
          { status: 403 },
        );
      }
      return new Response(null, { status: 404 });
    });

    await expect(downloadBook(bookId)).rejects.toMatchObject({
      code: DownloadError.DOWNLOAD_NOT_PERMITTED,
      bookId,
    });
    expect(requestedIntent).toBe('DOWNLOAD');

    // Nothing persisted, and no row for a download that never happened.
    expect(await contentStore.isAvailableOffline(bookId)).toBe(false);
    const rows = await downloadTable.listActive(USER_ID);
    expect(rows.find((row) => row.book_id === bookId)).toBeUndefined();
  });
});

describe('downloadBook — unencrypted audio under a real tier (B15 regression)', () => {
  const originalFetch = global.fetch;
  afterEach(async () => {
    global.fetch = originalFetch;
    await Keychain.resetGenericPassword({ service: DEVICE_PRIVATE_KEY_SERVICE });
  });

  // Regression test for bug B15: the `needsLicence` logic must correctly distinguish Elite
  // (memory-only) from Subscription (persistable), regardless of encryption. This fixture uses
  // unencrypted content as a simplification (no nonce/tag overhead to handle), but real audio is
  // encrypted as of 2026-08-25. Before the `needsLicence` fix, `isEncrypted` gated the licence,
  // so this Elite audio book got `licence: null` — `contentStore.ts`'s `isElite()` read `pkg.licence`,
  // saw null, answered false, and persisted an Elite title permanently: unaccounted against the
  // 5-book limit and immune to licence expiry.
  it('an ELITE audio book is treated as Elite (memory-only), not open access', async () => {
    const bookId = 'elite-audio-book';
    const plaintext = new Uint8Array([40, 41, 42, 43, 44]); // unencrypted test content (simplification)
    const loan = openAccessLoanFor(bookId, {
      licenceModel: 'ELITE',
      canPersist: false,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    // No `encryption` field in this fixture — testing the licensing logic, not encryption.
    const session = sessionFor(bookId, plaintext);
    global.fetch = mockFetchFor(loan, session, plaintext);

    await expect(downloadBook(bookId, 'AUDIO')).resolves.toBeUndefined();

    // The crux of the regression: Elite writes nothing, even though nothing about this download
    // was encrypted. Before the fix this was `true` — indistinguishable from real open access.
    expect(await contentStore.isAvailableOffline(bookId)).toBe(false);

    const rows = await downloadTable.listActive(USER_ID);
    expect(rows.find((row) => row.book_id === bookId)).toBeUndefined();

    // The STREAM read itself must still succeed — Elite is "online-only", not "unreadable".
    await contentStore.openSession(bookId);
    const decrypted = await contentStore.decryptBook(bookId);
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
    await contentStore.close(bookId);
  });

  // The other half of bug B15: a real Subscription audio book must still persist (Subscription
  // IS a download tier) — the `needsLicence` fix must not turn EVERY book (encrypted or not)
  // memory-only just because it's audio. Real audio is encrypted as of 2026-08-25; this fixture
  // uses unencrypted content as a simplification.
  it('a SUBSCRIPTION audio book still persists, with a real (non-null) licence attached', async () => {
    const bookId = 'subscription-audio-book';
    const plaintext = new Uint8Array([50, 51, 52, 53, 54]); // unencrypted test content (simplification)
    const loan = openAccessLoanFor(bookId, {
      licenceModel: 'SUBSCRIPTION',
      canPersist: true,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const session = sessionFor(bookId, plaintext);
    global.fetch = mockFetchFor(loan, session, plaintext);

    await expect(downloadBook(bookId, 'AUDIO')).resolves.toBeUndefined();
    expect(await contentStore.isAvailableOffline(bookId)).toBe(true);

    await contentStore.openSession(bookId);
    const decrypted = await contentStore.decryptBook(bookId);
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
    await contentStore.close(bookId);

    // This test's whole point is that it DOES persist (unlike the Elite case above) — so, same
    // trap as the book-limit describe block's own comment: `downloadTable` is real and un-reset
    // across tests in this file. Soft-delete the row this test created rather than leaving it to
    // silently eat one of the 5 offline slots for every test that runs after this one.
    const rows = await downloadTable.listActive(USER_ID, bookId);
    for (const row of rows) {
      await downloadTable.softDeleteLocal(row.id);
    }
  });
});

describe('downloadBook — failure branches', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('rejects with INSUFFICIENT_STORAGE and never calls fetch when free space is below the floor', async () => {
    Object.defineProperty(Paths, 'availableDiskSpace', { get: () => 0, configurable: true });
    global.fetch = jest.fn();

    await expect(downloadBook('low-storage-book')).rejects.toMatchObject({
      code: DownloadError.INSUFFICIENT_STORAGE,
    });
    expect(global.fetch).not.toHaveBeenCalled();

    Object.defineProperty(Paths, 'availableDiskSpace', { get: () => 10 * 1024 * 1024 * 1024, configurable: true });
  });

  // Renamed from "the checksum is wrong": the real ReadingSessionResponse carries no checksum
  // field at all (downloadManager.ts's header, "CHECKSUM:") — this is now a cross-check between
  // computeOriginalLength(bytes.length, isEncrypted) and the server-supplied
  // session.content.originalLength, and a disagreement is treated exactly as loudly as the old
  // checksum mismatch was: CHECKSUM_MISMATCH, thrown BEFORE contentStore.store().
  it('rejects with CHECKSUM_MISMATCH when session.content.originalLength disagrees with the actual asset byte length', async () => {
    const bookId = 'tampered-length-book';
    const content = new Uint8Array([9, 9, 9]);
    const loan = openAccessLoanFor(bookId);
    // originalLength claims one more byte than the asset actually is — open access, so
    // computeOriginalLength(bytes.length, false) === bytes.length, which will disagree.
    const session = sessionFor(bookId, content, {
      content: {
        url: `http://localhost:4000/fixtures/${bookId}.epub`,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        cipherLength: content.length,
        originalLength: content.length + 1,
        mimeType: 'application/epub+zip',
      },
    });
    global.fetch = mockFetchFor(loan, session, content);

    await expect(downloadBook(bookId)).rejects.toMatchObject({
      code: DownloadError.CHECKSUM_MISMATCH,
      bookId,
    });
    expect(await contentStore.isAvailableOffline(bookId)).toBe(false);
  });

  // Same "never stored" assertion shape as the CHECKSUM_MISMATCH test above: isAvailableOffline
  // stays false, which is only true if contentStore.store() was never reached.
  it('rejects with BOOK_TOO_LARGE and never calls contentStore.store when the book exceeds the RAM budget', async () => {
    const bookId = 'oversized-book';
    // One byte over contentStore's MAX_DECRYPTED_BYTES. Open access, so originalLength ===
    // content.length — no nonce/tag overhead to reason about here.
    const content = new Uint8Array(MAX_DECRYPTED_BYTES + 1);
    const loan = openAccessLoanFor(bookId);
    const session = sessionFor(bookId, content);
    global.fetch = mockFetchFor(loan, session, content);

    await expect(downloadBook(bookId)).rejects.toMatchObject({
      code: DownloadError.BOOK_TOO_LARGE,
      bookId,
    });
    expect(await contentStore.isAvailableOffline(bookId)).toBe(false);
  });

  // Renamed from "rejects with LOAN_FAILED when the loan request 404s": there is no loan request
  // anymore (checkLicense.ts calls openReadingSession() only — see its header, D-020), so
  // openReadingSession() is the FIRST and ONLY network call downloadBook makes, and a 404 with no
  // FlambeauError-shaped body (tryParseFlambeauError finds no `code` field) falls back to the
  // generic SESSION_FETCH_FAILED.
  it('rejects with SESSION_FETCH_FAILED when the reading-session request 404s', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }));

    await expect(downloadBook('missing-book')).rejects.toMatchObject({
      code: DownloadError.SESSION_FETCH_FAILED,
    });
  });

  // Pins the same fix as openBook.test.ts's queued-session case: a copy-limited title with no
  // free copy gets queued INSIDE the reading-session response (no `content`, `holdCreatedAt`
  // set instead) rather than a separate refusal — see ReadBrokerService.queuedResponse() in
  // tf_reader_backend_temp. That must surface as the actionable NO_COPIES_AVAILABLE, not the
  // generic SESSION_FETCH_FAILED a genuinely malformed response gets.
  it('rejects with NO_COPIES_AVAILABLE, not SESSION_FETCH_FAILED, when the session is queued', async () => {
    const queuedSession = {
      sessionId: 'session-queued-book',
      itemId: 'queued-book',
      licenceModel: 'ELITE',
      canPersist: false,
      holdCreatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      serverTime: new Date().toISOString(),
    };
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url === `${API_BASE_URL}/api/v1/reading-sessions`) {
        return new Response(JSON.stringify(queuedSession), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    await expect(downloadBook('queued-book')).rejects.toMatchObject({
      code: DownloadError.NO_COPIES_AVAILABLE,
    });
  });
});

// New coverage for the real contract's FlambeauError -> DownloadError mapping
// (readingSessionClient.ts's LOAN_ERROR_CODE_MAP / SESSION_ERROR_CODE_MAP), which has zero
// coverage under the old mock (it never had a real error envelope to parse). One case per
// endpoint, not an exhaustive sweep of every mapped code — errors.ts documents the full list.
describe('downloadBook — flambeau error code mapping', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function flambeauError(code: FlambeauError['code'], path: string): FlambeauError {
    return {
      timestamp: new Date().toISOString(),
      status: 403,
      code,
      message: `mock ${code}`,
      path,
    };
  }

  it('rejects with NO_ENTITLEMENT when the reading-session request 403s with that flambeau code', async () => {
    const bookId = 'no-entitlement-book';
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url === `${API_BASE_URL}/api/v1/reading-sessions`) {
        return new Response(
          JSON.stringify(flambeauError('NO_ENTITLEMENT', '/api/v1/reading-sessions')),
          { status: 403 },
        );
      }
      return new Response(null, { status: 404 });
    });

    await expect(downloadBook(bookId)).rejects.toMatchObject({
      code: DownloadError.NO_ENTITLEMENT,
      bookId,
    });
  });

  it('rejects with DOWNLOAD_NOT_PERMITTED when the reading-session request 403s with that flambeau code', async () => {
    const bookId = 'download-not-permitted-book';
    const loan = openAccessLoanFor(bookId, { licenceModel: 'ELITE', canPersist: true }); // canPersist mis-set upstream; server is the real enforcer here
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url === `${API_BASE_URL}/api/v1/loans`) {
        return new Response(JSON.stringify(loan), { status: 200 });
      }
      if (url === `${API_BASE_URL}/api/v1/reading-sessions`) {
        return new Response(
          JSON.stringify(flambeauError('DOWNLOAD_NOT_PERMITTED', '/api/v1/reading-sessions')),
          { status: 403 },
        );
      }
      return new Response(null, { status: 404 });
    });

    await expect(downloadBook(bookId)).rejects.toMatchObject({
      code: DownloadError.DOWNLOAD_NOT_PERMITTED,
      bookId,
    });
  });
});

// Regression tests for the "no way to deliver a search index" gap (now `ReadingSessionResponse
// .index`, forwarded unchanged by the flambeau migration — see downloadManager.ts's header).
describe('downloadBook — search index delivery', () => {
  const originalFetch = global.fetch;
  const bookIds = ['book-with-index', 'book-with-unfetchable-index', 'book-without-index'];

  // Every other describe block in this file stays under the 5-book cap by construction (its
  // failure branches never reach contentStore.store(), and the happy-path tests reuse the same
  // book). This block stores 3 DIFFERENT books against the same real, un-reset downloadTable —
  // without cleanup, the 3rd test here would itself trip BOOK_LIMIT_REACHED before ever
  // exercising the "no index URL" assertion it's meant to test. Soft-delete keeps each test's
  // row from counting against the ones that run after it.
  afterEach(async () => {
    global.fetch = originalFetch;
    await contentStore.close('book-with-index');
    await contentStore.close('book-with-unfetchable-index');
    for (const bookId of bookIds) {
      const rows = await downloadTable.listActive(USER_ID, bookId);
      for (const row of rows) {
        await downloadTable.softDeleteLocal(row.id);
      }
    }
  });

  it('fetches and attaches the search index when the session has one', async () => {
    const bookId = 'book-with-index';
    const content = new Uint8Array([1, 2, 3, 4]);
    const indexBytes = new Uint8Array([9, 8, 7]);
    const loan = openAccessLoanFor(bookId);
    const session = sessionFor(bookId, content, {
      index: { url: `http://localhost:4000/fixtures/${bookId}.index.enc`, encrypted: false, termCount: 3 },
    });
    global.fetch = mockFetchFor(loan, session, content, indexBytes);

    await downloadBook(bookId);

    await contentStore.openSession(bookId);
    const decodedIndex = await decryptSearchIndex(bookId);
    expect(decodedIndex).not.toBeNull();
    expect(Array.from(decodedIndex!)).toEqual(Array.from(indexBytes));
  });

  it('still downloads the book successfully if fetching the index fails — independent failure domain', async () => {
    const bookId = 'book-with-unfetchable-index';
    const content = new Uint8Array([5, 6, 7]);
    const loan = openAccessLoanFor(bookId);
    const session = sessionFor(bookId, content, {
      index: { url: `http://localhost:4000/fixtures/${bookId}.index.enc`, encrypted: false },
    });
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (url === `${API_BASE_URL}/api/v1/loans`) return new Response(JSON.stringify(loan), { status: 200 });
      if (url === `${API_BASE_URL}/api/v1/reading-sessions`) return new Response(JSON.stringify(session), { status: 200 });
      if (url === session.content.url) return new Response(content, { status: 200 });
      if (url === session.index!.url) return new Response(null, { status: 500 });
      return new Response(null, { status: 404 });
    });

    await expect(downloadBook(bookId)).resolves.toBeUndefined();
    expect(await contentStore.isAvailableOffline(bookId)).toBe(true);

    await contentStore.openSession(bookId);
    expect(await decryptSearchIndex(bookId)).toBeNull(); // no index made it through
  });

  it('never requests an index URL when the session has none', async () => {
    const bookId = 'book-without-index';
    const content = new Uint8Array([1]);
    const loan = openAccessLoanFor(bookId);
    const session = sessionFor(bookId, content); // no .index field at all
    const fetchMock = mockFetchFor(loan, session, content);
    global.fetch = fetchMock;

    await downloadBook(bookId);

    // Exactly 2 requests: reading-session, then the main asset. No loan call (checkLicense.ts no
    // longer makes one — see its header, D-020) and no index URL was ever built.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// Regression test for the parked "rollback destroy() isn't guarded" finding: the in-lock
// re-check (downloadManager.ts's withWriteLock block) can lose a race that the pre-fetch check
// above didn't see, in which case it must roll back via contentStore.destroy(bookId) and still
// surface the ORIGINAL BOOK_LIMIT_REACHED DownloadFailure — even if destroy() itself throws.
describe('downloadBook — book-limit race rollback', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('still rejects with the original BOOK_LIMIT_REACHED error when the in-lock rollback destroy() itself throws', async () => {
    const bookId = 'race-rollback-book';
    const content = new Uint8Array([1, 2, 3]);
    const loan = openAccessLoanFor(bookId);
    const session = sessionFor(bookId, content);
    global.fetch = mockFetchFor(loan, session, content);

    // Pre-fetch check (outside the lock) sees room; the re-check INSIDE the lock sees 5 other
    // books already at the cap — simulating another download winning the race in between.
    const roomyRows = [] as unknown as Awaited<ReturnType<typeof downloadTable.listActive>>;
    const fullRows = Array.from({ length: 5 }, (_, i) => ({
      book_id: `other-book-${i}`,
    })) as unknown as Awaited<ReturnType<typeof downloadTable.listActive>>;
    jest.spyOn(downloadTable, 'listActive').mockResolvedValueOnce(roomyRows).mockResolvedValueOnce(fullRows);

    const destroySpy = jest
      .spyOn(contentStore, 'destroy')
      .mockRejectedValueOnce(new Error('keychain unavailable during rollback'));

    await expect(downloadBook(bookId)).rejects.toMatchObject({
      code: DownloadError.BOOK_LIMIT_REACHED,
      bookId,
    });
    expect(destroySpy).toHaveBeenCalledWith(bookId);
  });
});

// Regression test for the "unguarded findExistingDownload call" defect (Karthik's downloads-
// history reconciliation, added 2026-08-31): api.list() throws ApiError(_, 0) on an unreachable
// host — the routine dev-simulator state, not an edge case — and that call runs INSIDE
// withWriteLock, AFTER contentStore.store() already wrote the ciphertext. Without the rollback
// this proves, the failure would escape downloadBook with no downloads row ever written, leaving
// isAvailableOffline(bookId) permanently true for a book the app believes it never downloaded.
describe('downloadBook — remote-reconciliation network failure', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('rolls back contentStore.store() and rethrows when findExistingDownload (api.list) fails', async () => {
    const bookId = 'reconcile-network-failure-book';
    const content = new Uint8Array([1, 2, 3]);
    const loan = openAccessLoanFor(bookId);
    const session = sessionFor(bookId, content);
    global.fetch = mockFetchFor(loan, session, content);

    const listFailure = new Error('downloads: network request failed');
    (api.list as jest.Mock).mockRejectedValueOnce(listFailure);

    await expect(downloadBook(bookId)).rejects.toBe(listFailure);

    expect(await contentStore.isAvailableOffline(bookId)).toBe(false);
  });
});

// Every other describe block's `mockFetchFor` answers the content URL with a flat 200 — realistic
// for a server with no Range support, but it never actually exercises chunkedAssetFetcher.ts's
// chunking through the real downloadBook() pipeline, only its own unit tests
// (chunkedAssetFetcher.test.ts) do that in isolation. This block wires a real Range-aware mock —
// the same behavior confirmed live against the actual mock-backend (express.static) — so the full
// pipeline (loan -> session -> chunked fetch -> store -> downloads row) is proven end to end too.
describe('downloadBook — chunked asset fetch (real Range behavior)', () => {
  const originalFetch = global.fetch;
  // Same "soft-delete against the real, un-reset downloadTable" pattern as the search-index-
  // delivery block below: this describe block now persists TWO distinct books (the pre-existing
  // multi-chunk test's, and the new onProgress test's below), and this file never resets the
  // downloadTable between describe blocks — without this, the second persisting test here would
  // push a distinct book over BOOK_LIMIT (5), tripped by earlier describe blocks' own persisted
  // books, exactly the trap the search-index-delivery block's own comment already describes.
  const chunkedBookIds = ['chunked-download-multi', 'chunked-download-progress', 'chunked-download-resume'];
  afterEach(async () => {
    global.fetch = originalFetch;
    for (const bookId of chunkedBookIds) {
      const rows = await downloadTable.listActive(USER_ID, bookId);
      for (const row of rows) {
        await downloadTable.softDeleteLocal(row.id);
      }
    }
  });

  function mockFetchForChunked(
    loan: Loan,
    session: ReadingSessionResponse,
    content: Uint8Array<ArrayBuffer>,
  ): jest.Mock {
    return jest.fn().mockImplementation(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (url === `${API_BASE_URL}/api/v1/loans`) {
        return new Response(JSON.stringify(loan), { status: 200 });
      }
      if (url === `${API_BASE_URL}/api/v1/reading-sessions`) {
        return new Response(JSON.stringify(session), { status: 200 });
      }
      if (url === session.content.url) {
        const rangeHeader = init?.headers?.Range;
        const match = rangeHeader ? /^bytes=(\d+)-(\d+)$/.exec(rangeHeader) : null;
        if (!match) return new Response(content, { status: 200 });
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]), content.length - 1);
        return new Response(content.subarray(start, end + 1), {
          status: 206,
          headers: { 'Content-Range': `bytes ${start}-${end}/${content.length}` },
        });
      }
      return new Response(null, { status: 404 });
    });
  }

  it('downloads a book spanning multiple 1 MiB chunks, via real Range requests, and stores it correctly', async () => {
    const bookId = 'chunked-download-multi';
    const plaintext = new Uint8Array(Math.floor(CHUNK_SIZE_BYTES * 2.5)).map((_, i) => i % 256);
    const bek = new Uint8Array(crypto.randomBytes(32));
    const { publicKey } = await generateDeviceKeypair();
    const wrappedBek = await wrapBek(bek, publicKey);
    const payload = await encrypt(plaintext, bek);
    const encryptedBytes = new Uint8Array(payload.content);
    const keyFingerprint = await publicKeyFingerprint(publicKey);

    const loan = openAccessLoanFor(bookId, {
      licenceModel: 'SUBSCRIPTION',
      canPersist: true,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const session = sessionFor(bookId, encryptedBytes, {
      content: {
        url: `http://localhost:4000/fixtures/${bookId}.epub.enc`,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        cipherLength: encryptedBytes.length,
        originalLength: plaintext.length,
        mimeType: 'application/epub+zip',
      },
      encryption: {
        algorithm: 'AES-256-GCM',
        layout: 'nonce(12) || ciphertext || tag(16)',
        wrappedBek,
        wrapAlgorithm: 'RSA-OAEP-256',
        keyId: 'master-v1',
        keyFingerprint,
      },
    });
    const fetchMock = mockFetchForChunked(loan, session, encryptedBytes);
    global.fetch = fetchMock;

    await expect(downloadBook(bookId)).resolves.toBeUndefined();
    expect(await contentStore.isAvailableOffline(bookId)).toBe(true);

    // 3 real chunk requests against the content URL (2.5 chunks rounds up), not one big fetch.
    const contentRequests = fetchMock.mock.calls.filter((call) => call[0] === session.content.url);
    expect(contentRequests).toHaveLength(3);
    expect(contentRequests[0][1].headers.Range).toBe(`bytes=0-${CHUNK_SIZE_BYTES - 1}`);

    // The 5-book-limit bookkeeping (downloadTable write, under the write lock) ran to completion
    // too — chunking only changed how the bytes arrived, not the accounting around them.
    const rows = await downloadTable.listActive(USER_ID, bookId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('COMPLETED');

    await contentStore.openSession(bookId);
    const decrypted = await contentStore.decryptBook(bookId);
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
    await contentStore.close(bookId);
  });

  // Whole-file AES-GCM means ONE tag covers the ENTIRE ciphertext (cipherLayout.ts) — there is no
  // per-chunk verification. Chunking (and resuming) only changes how the bytes for that one
  // ciphertext arrive; decryptBook()'s tag check (aesGcm.ts) cannot tell a resumed reassembly from
  // a single whole-file fetch UNLESS the reassembly is byte-wrong, in which case it throws
  // INTEGRITY_FAILED exactly as whole-file corruption already does — no new error path needed
  // (this file's own header comment). This test is the one place that combines the two real
  // pieces that are each tested separately elsewhere: chunkedAssetFetcher.test.ts proves a resumed
  // fetch is byte-identical to a non-resumed one (via Buffer equality against random bytes, no
  // crypto involved), and the test above proves a real GCM payload survives a non-interrupted
  // chunked fetch. Neither proves the tag still validates when those two are combined — a resumed
  // reassembly is the one path most likely to introduce a byte-boundary bug (reopening a partial
  // file, appending onto it) if either implementation drifts.
  it('resumes a real AES-256-GCM-encrypted download after an interruption, and the reassembled ciphertext still passes the GCM tag check', async () => {
    const bookId = 'chunked-download-resume';
    const plaintext = new Uint8Array(Math.floor(CHUNK_SIZE_BYTES * 3.3)).map((_, i) => i % 256);
    const bek = new Uint8Array(crypto.randomBytes(32));
    const { publicKey } = await generateDeviceKeypair();
    const wrappedBek = await wrapBek(bek, publicKey);
    const payload = await encrypt(plaintext, bek);
    const encryptedBytes = new Uint8Array(payload.content);
    const keyFingerprint = await publicKeyFingerprint(publicKey);

    const loan = openAccessLoanFor(bookId, {
      licenceModel: 'SUBSCRIPTION',
      canPersist: true,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const session = sessionFor(bookId, encryptedBytes, {
      content: {
        url: `http://localhost:4000/fixtures/${bookId}.epub.enc`,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        cipherLength: encryptedBytes.length,
        originalLength: plaintext.length,
        mimeType: 'application/epub+zip',
      },
      encryption: {
        algorithm: 'AES-256-GCM',
        layout: 'nonce(12) || ciphertext || tag(16)',
        wrappedBek,
        wrapAlgorithm: 'RSA-OAEP-256',
        keyId: 'master-v1',
        keyFingerprint,
      },
    });

    // First attempt: the loan/session calls succeed (real endpoints), but the 3rd chunk of the
    // real ciphertext fails outright — simulating a dropped connection mid-asset, same shape as
    // chunkedAssetFetcher.test.ts's own resume test. Wraps the already-proven mockFetchForChunked
    // rather than reimplementing the loan/session branches, so only the interruption itself is new.
    let chunkCallCount = 0;
    const workingFetch = mockFetchForChunked(loan, session, encryptedBytes);
    const failingFetch = jest.fn().mockImplementation(async (url: string, init?: unknown) => {
      if (url === session.content.url) {
        chunkCallCount++;
        if (chunkCallCount === 3) {
          throw new TypeError('Network request failed');
        }
      }
      return workingFetch(url, init);
    });
    global.fetch = failingFetch;

    // A plain `try/catch` here, not `await expect(...).rejects...`: the throw above happens
    // inside an async mock nested one layer deeper than the other tests in this file (this mock
    // wraps mockFetchForChunked's own mock rather than being called directly), and that extra hop
    // trips Node's unhandled-rejection detection racing `.rejects`' own handler attachment —
    // confirmed empirically, not a style preference. The assertion is identical either way.
    let firstAttemptError: unknown;
    try {
      await downloadBook(bookId);
    } catch (error) {
      firstAttemptError = error;
    }
    expect(firstAttemptError).toBeInstanceOf(DownloadFailure);
    expect(await contentStore.isAvailableOffline(bookId)).toBe(false);

    // Second attempt: fails with fail-closed cleanup of partial files (new behavior), so it restarts
    // from chunk 0 rather than resuming from chunk 2. This is intentional — the fail-closed approach
    // (CLAUDE.md section on "Fail-closed + clean rollback on a mid-transfer abort") prioritizes
    // safety over efficiency: a mid-transfer failure may have corrupted the partial state, so
    // starting fresh is safer than trusting a partial manifest. Resumption is still possible when
    // the CALLER explicitly invokes discardPartialDownload() first (see chunkedAssetFetcher.test.ts),
    // but downloadBook itself cleans up on any error.
    const resumeFetch = mockFetchForChunked(loan, session, encryptedBytes);
    global.fetch = resumeFetch;

    await expect(downloadBook(bookId)).resolves.toBeUndefined();
    expect(await contentStore.isAvailableOffline(bookId)).toBe(true);

    // Restart from chunk 0, not resume from chunk 2 — all chunks re-requested due to cleanup.
    const restartedContentRequests = resumeFetch.mock.calls.filter((call) => call[0] === session.content.url);
    expect(restartedContentRequests.length).toBe(4); // 4 chunks for a 3.3-chunk asset, all fetched fresh
    expect(restartedContentRequests[0][1].headers.Range).toBe(`bytes=0-${CHUNK_SIZE_BYTES - 1}`);
    // This proves cleanup happened: if resume had worked, the first request would be for chunk 2,
    // not chunk 0.

    // THE ACTUAL CLAIM: decryptBook() calls decipher.final() (aesGcm.ts), which throws on a bad
    // GCM tag. Reaching this assertion at all — with the correct plaintext back out — is the
    // proof the resumed-then-reassembled ciphertext is byte-identical to what encrypt() produced,
    // not just "some bytes of the right length".
    await contentStore.openSession(bookId);
    const decrypted = await contentStore.decryptBook(bookId);
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext));
    await contentStore.close(bookId);
  });

  it('forwards onProgress through to the chunked fetcher, with the running byte total', async () => {
    const bookId = 'chunked-download-progress';
    const plaintext = new Uint8Array(Math.floor(CHUNK_SIZE_BYTES * 2.5)).map((_, i) => i % 256);
    const bek = new Uint8Array(crypto.randomBytes(32));
    const { publicKey } = await generateDeviceKeypair();
    const wrappedBek = await wrapBek(bek, publicKey);
    const payload = await encrypt(plaintext, bek);
    const encryptedBytes = new Uint8Array(payload.content);
    const keyFingerprint = await publicKeyFingerprint(publicKey);

    const loan = openAccessLoanFor(bookId, {
      licenceModel: 'SUBSCRIPTION',
      canPersist: true,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const session = sessionFor(bookId, encryptedBytes, {
      content: {
        url: `http://localhost:4000/fixtures/${bookId}.epub.enc`,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        cipherLength: encryptedBytes.length,
        originalLength: plaintext.length,
        mimeType: 'application/epub+zip',
      },
      encryption: {
        algorithm: 'AES-256-GCM',
        layout: 'nonce(12) || ciphertext || tag(16)',
        wrappedBek,
        wrapAlgorithm: 'RSA-OAEP-256',
        keyId: 'master-v1',
        keyFingerprint,
      },
    });
    global.fetch = mockFetchForChunked(loan, session, encryptedBytes);
    const onProgress = jest.fn();

    await expect(downloadBook(bookId, 'EPUB', { onProgress })).resolves.toBeUndefined();

    // downloadBook's chunked fetch deals in CIPHERTEXT bytes (nonce+ciphertext+tag), same as
    // fetchEncryptedAssetChunked's own onProgress contract — one call per chunk, running total.
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, CHUNK_SIZE_BYTES, encryptedBytes.length);
    expect(onProgress).toHaveBeenNthCalledWith(3, encryptedBytes.length, encryptedBytes.length);
  });

  it('still enforces the RAM budget in the chunked path, rejecting before all chunks are fetched', async () => {
    const bookId = 'chunked-too-large-e2e';
    // Bigger than MAX_DECRYPTED_BYTES so the FIRST chunk's Content-Range total already exceeds
    // the (encryption-adjusted) budget — the point being it must reject BEFORE fetching the rest.
    const oversized = new Uint8Array(MAX_DECRYPTED_BYTES + CHUNK_SIZE_BYTES * 3);
    // ELITE (not OPEN_ACCESS): downloadManager.ts only runs the 5-book-limit check when
    // `loan.canPersist` is true, and this suite's `downloadTable` is real and un-reset across
    // tests (see the book-limit-race describe block's own comment on the same trap) — by this
    // point in the file it's already at cap from earlier tests. ELITE isolates the assertion to
    // the budget check this test actually targets, instead of tripping BOOK_LIMIT_REACHED first.
    const loan = openAccessLoanFor(bookId, {
      licenceModel: 'ELITE',
      canPersist: false,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const session = sessionFor(bookId, oversized, {
      content: {
        url: `http://localhost:4000/fixtures/${bookId}.epub`,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        cipherLength: oversized.length,
        originalLength: oversized.length,
        mimeType: 'application/epub+zip',
      },
    });
    const fetchMock = mockFetchForChunked(loan, session, oversized);
    global.fetch = fetchMock;

    await expect(downloadBook(bookId)).rejects.toMatchObject({
      code: DownloadError.BOOK_TOO_LARGE,
      bookId,
    });
    expect(await contentStore.isAvailableOffline(bookId)).toBe(false);

    const contentRequests = fetchMock.mock.calls.filter((call) => call[0] === session.content.url);
    expect(contentRequests).toHaveLength(1); // rejected after the first chunk, never fetched chunks 2-4+
  });
});

describe('downloadBook — fail-closed cleanup on asset fetch failure', () => {
  it('discards partial downloads on mid-transfer abort/timeout, before re-throwing', async () => {
    const bookId = 'mid-transfer-abort';
    const plaintext = new Uint8Array(Math.floor(CHUNK_SIZE_BYTES * 3.2)).map((_, i) => i % 256);
    const bek = new Uint8Array(crypto.randomBytes(32));
    const { publicKey } = await generateDeviceKeypair();
    const wrappedBek = await wrapBek(bek, publicKey);
    const payload = await encrypt(plaintext, bek);
    const encryptedBytes = new Uint8Array(payload.content);
    const keyFingerprint = await publicKeyFingerprint(publicKey);

    const loan = openAccessLoanFor(bookId, {
      licenceModel: 'SUBSCRIPTION',
      canPersist: true,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const session = sessionFor(bookId, encryptedBytes, {
      content: {
        url: `http://localhost:4000/fixtures/${bookId}.epub.enc`,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        cipherLength: encryptedBytes.length,
        originalLength: plaintext.length,
        mimeType: 'application/epub+zip',
      },
      encryption: {
        algorithm: 'AES-256-GCM',
        layout: 'nonce(12) || ciphertext || tag(16)',
        wrappedBek,
        wrapAlgorithm: 'RSA-OAEP-256',
        keyId: 'master-v1',
        keyFingerprint,
      },
    });

    // Simulate mid-transfer abort: first chunk succeeds, second chunk fails (e.g., timeout).
    let contentCallCount = 0;
    const abortingFetch = jest.fn().mockImplementation(async (url: string, init?: { headers?: Record<string, string> }) => {
      // Handle loan and session requests normally
      if (url === `${API_BASE_URL}/api/v1/loans`) {
        return new Response(JSON.stringify(loan), { status: 200 });
      }
      if (url === `${API_BASE_URL}/api/v1/reading-sessions`) {
        return new Response(JSON.stringify(session), { status: 200 });
      }
      // Simulate mid-transfer abort on the asset fetch: first chunk succeeds, second fails
      if (url === session.content.url) {
        contentCallCount++;
        if (contentCallCount === 2) {
          // Simulate a timeout/abort after the first chunk arrived
          throw new Error('Network timeout during chunk 2 (simulated abort)');
        }
        const rangeHeader = init?.headers?.Range;
        if (!rangeHeader) {
          return new Response(encryptedBytes, { status: 200 });
        }
        const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
        if (!match) {
          return new Response(null, { status: 400 });
        }
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]), encryptedBytes.length - 1);
        const slice = encryptedBytes.subarray(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: { 'Content-Range': `bytes ${start}-${end}/${encryptedBytes.length}` },
        });
      }
      return new Response(null, { status: 404 });
    });
    global.fetch = abortingFetch;

    // downloadBook should reject with the asset fetch error
    await expect(downloadBook(bookId, 'EPUB')).rejects.toMatchObject({
      code: DownloadError.ASSET_FETCH_FAILED,
    });

    // Verify the book was NOT persisted
    expect(await contentStore.isAvailableOffline(bookId)).toBe(false);

    // Verify no partial download files remain — a second attempt should start fresh from chunk 0
    let successfulContentCount = 0;
    const retryFetch = jest.fn().mockImplementation(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (url === `${API_BASE_URL}/api/v1/loans`) {
        return new Response(JSON.stringify(loan), { status: 200 });
      }
      if (url === `${API_BASE_URL}/api/v1/reading-sessions`) {
        return new Response(JSON.stringify(session), { status: 200 });
      }
      if (url === session.content.url) {
        successfulContentCount++;
        const rangeHeader = init?.headers?.Range;
        if (!rangeHeader) {
          return new Response(encryptedBytes, { status: 200 });
        }
        const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
        if (!match) {
          return new Response(null, { status: 400 });
        }
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]), encryptedBytes.length - 1);
        const slice = encryptedBytes.subarray(start, end + 1);
        return new Response(slice, {
          status: 206,
          headers: { 'Content-Range': `bytes ${start}-${end}/${encryptedBytes.length}` },
        });
      }
      return new Response(null, { status: 404 });
    });
    global.fetch = retryFetch;

    // Re-attempt should succeed and start from 0 (not resume from chunk 2)
    await downloadBook(bookId, 'EPUB');
    expect(successfulContentCount).toBeGreaterThanOrEqual(4); // all chunks fetched from start, ~4 chunks total
    // First content request should be for chunk 0, not chunk 2 (resuming) — this proves cleanup worked
    const contentRequests = retryFetch.mock.calls.filter((call) => call[0] === session.content.url);
    expect(contentRequests[0][1].headers.Range).toBe(`bytes=0-${CHUNK_SIZE_BYTES - 1}`);
    expect(await contentStore.isAvailableOffline(bookId)).toBe(true);
  });
});

describe('clearAllDownloads', () => {
  const originalFetch = global.fetch;

  // Earlier describe blocks in this file don't all clean up their own persisted rows (the
  // "happy path" and "ENCRYPTED (Subscription)" blocks deliberately leave theirs, per their own
  // comments about counting real rows), so by the time this block runs, the real un-reset
  // downloadTable can already be near the 5-book BOOK_LIMIT. clearAllDownloads() is the function
  // under test and is exactly the right tool to guarantee a clean slate here — using it up front
  // makes this block self-contained instead of depending on every other block's cleanup discipline.
  beforeEach(async () => {
    await clearAllDownloads();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('destroys every downloaded book and tombstones its row, leaving nothing active', async () => {
    const bookIds = ['clear-all-book-1', 'clear-all-book-2', 'clear-all-book-3'];
    for (const bookId of bookIds) {
      const content = new Uint8Array([1, 2, 3]);
      const loan = openAccessLoanFor(bookId);
      const session = sessionFor(bookId, content);
      global.fetch = mockFetchFor(loan, session, content);
      await downloadBook(bookId);
    }
    for (const bookId of bookIds) {
      expect(await contentStore.isAvailableOffline(bookId)).toBe(true);
    }

    await clearAllDownloads();

    for (const bookId of bookIds) {
      expect(await contentStore.isAvailableOffline(bookId)).toBe(false);
    }
    const rows = await downloadTable.listActive(USER_ID);
    for (const bookId of bookIds) {
      expect(rows.find((row) => row.book_id === bookId)).toBeUndefined();
    }
  });

  it('is a no-op, not a throw, when nothing is downloaded', async () => {
    await expect(clearAllDownloads()).resolves.toBeUndefined();
  });

  // One book's destroy() throwing (a keychain/FS error) must not stop the others from being
  // cleared, and must still be reported rather than swallowed — same reasoning as the rollback
  // path downloadBook() itself uses elsewhere in this file.
  it('clears every other book even when one fails to destroy, then reports the failure', async () => {
    const okBookId = 'clear-all-ok-book';
    const failingBookId = 'clear-all-failing-book';
    for (const bookId of [okBookId, failingBookId]) {
      const content = new Uint8Array([4, 5, 6]);
      const loan = openAccessLoanFor(bookId);
      const session = sessionFor(bookId, content);
      global.fetch = mockFetchFor(loan, session, content);
      await downloadBook(bookId);
    }

    const realDestroy = contentStore.destroy;
    jest.spyOn(contentStore, 'destroy').mockImplementation(async (bookId) => {
      if (bookId === failingBookId) {
        throw new Error('keychain unavailable');
      }
      return realDestroy(bookId);
    });

    await expect(clearAllDownloads()).rejects.toThrow(/1 of 2/);

    // The row is still tombstoned even though destroy() failed for it — clearAllDownloads()
    // removes the row unconditionally, same as downloadBook()'s own rollback path does.
    expect(await contentStore.isAvailableOffline(okBookId)).toBe(false);
    const rows = await downloadTable.listActive(USER_ID);
    expect(rows.find((row) => row.book_id === okBookId)).toBeUndefined();
    expect(rows.find((row) => row.book_id === failingBookId)).toBeUndefined();

    jest.mocked(contentStore.destroy).mockRestore();
  });
});
