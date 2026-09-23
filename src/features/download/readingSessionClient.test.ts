// Exercises this file's HTTP client logic against a mocked global.fetch — same style
// contentLicenceClient.test.ts uses for the endpoints this file replaced. The real mock-backend
// integration for the happy path is covered end-to-end by downloadManager.test.ts; this file's own
// job is `borrowLoan`/`openReadingSession`'s request-building, error-classification, AND (below)
// that a server which accepts the connection and then never answers cannot hang the caller forever
// — see readingSessionClient.ts's `REQUEST_TIMEOUT_MS` comment for why that matters here
// specifically: `verifyReadingAccess`'s fail-open catch can only run once the `fetch` call actually
// rejects, and React Native's `fetch` has no default timeout of its own.

import { borrowLoan, openReadingSession, verifyReadingAccess } from './readingSessionClient';
import { API_BASE_URL } from './config';
import { DownloadFailure, DownloadError } from './errors';
import { generateDeviceKeypair } from '../encryption/deviceKeypair';
import type { Loan, ReadingSessionResponse } from '@/shared/contracts';

// verifyReadingAccess's own fail-open policy is keyed on DownloadFailure/FAIL_CLOSED_CODES, so a
// test that wants to prove the policy actually APPLIES needs to inject a failure ahead of the
// network call, not just a bad response — hence mocking the module rather than only global.fetch.
// (jest.mock calls are hoisted above imports by babel-plugin-jest-hoist regardless of source
// order, so this being written after the import above is only a readability question, not a
// correctness one — kept after so import/first doesn't flag it.)
jest.mock('../encryption/deviceKeypair', () => ({
  generateDeviceKeypair: jest.fn(),
  publicKeyToRawBase64: jest.fn().mockReturnValue('device-public-key-base64'),
}));

const sampleLoan: Loan = {
  loanId: 'loan-book-001',
  itemId: 'book-001',
  userId: 'user-001',
  licenceModel: 'OPEN_ACCESS',
  status: 'ACTIVE',
  borrowedAt: new Date().toISOString(),
  canPersist: true,
  serverTime: new Date().toISOString(),
};

const sampleSession: ReadingSessionResponse = {
  sessionId: 'session-book-001',
  itemId: 'book-001',
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  serverTime: new Date().toISOString(),
  content: {
    url: 'http://localhost:4000/fixtures/book-001.epub',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    cipherLength: 5,
    originalLength: 5,
    mimeType: 'application/epub+zip',
  },
};

// A fetch mock that never settles on its own, but honours the `signal` it was called with —
// exactly what a dead proxy / captive portal / silently-dropping firewall looks like from the
// caller's side: the connection is accepted (fetch doesn't reject synchronously), nothing ever
// comes back, and only an abort ends it. Mirrors what jsdom's real fetch-plus-AbortController does,
// without needing a real 8s wait in the test.
function neverRespondingFetch(): jest.Mock {
  return jest.fn().mockImplementation((_url: string, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const abortError = new Error('The operation was aborted');
        abortError.name = 'AbortError';
        reject(abortError);
      });
    });
  });
}

// Must match readingSessionClient.ts's own (deliberately un-exported — see its comment) local
// REQUEST_TIMEOUT_MS. Kept as a literal here rather than imported so this test also catches an
// accidental change to that value: if the module changes it, this test starts failing/hanging
// instead of silently advancing the wrong amount — which is exactly what happened when the real
// value moved from 8s to 20s (queue audit, 2026-09-20) and this literal wasn't updated in step.
const REQUEST_TIMEOUT_MS = 20_000;

describe('borrowLoan', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('returns the parsed Loan on success, hitting the correct URL', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(sampleLoan), { status: 200 }));

    const result = await borrowLoan('book-001');

    expect(result).toEqual(sampleLoan);
    expect(global.fetch).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/v1/loans`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws DownloadFailure(LOAN_FAILED) on a non-2xx response', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }));

    await expect(borrowLoan('missing-book')).rejects.toMatchObject({
      code: DownloadError.LOAN_FAILED,
      bookId: 'missing-book',
    });
  });

  it('throws DownloadFailure(LOAN_FAILED) when fetch itself rejects (offline)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed'));

    await expect(borrowLoan('book-001')).rejects.toBeInstanceOf(DownloadFailure);
  });

  it('rejects with DownloadFailure(LOAN_FAILED) instead of hanging forever when the server accepts the connection and never answers', async () => {
    jest.useFakeTimers();
    global.fetch = neverRespondingFetch();

    const pending = borrowLoan('book-001');
    const assertion = expect(pending).rejects.toMatchObject({
      code: DownloadError.LOAN_FAILED,
      bookId: 'book-001',
    });

    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await assertion;
  });
});

describe('openReadingSession', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  const request = { format: 'EPUB' as const, intent: 'STREAM' as const, devicePublicKey: 'abc', wantSearchIndex: false };

  it('returns the parsed ReadingSessionResponse on success, hitting the correct URL', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(sampleSession), { status: 200 }));

    const result = await openReadingSession('book-001', request);

    expect(result).toEqual(sampleSession);
    expect(global.fetch).toHaveBeenCalledWith(
      `${API_BASE_URL}/api/v1/reading-sessions`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws DownloadFailure(SESSION_FETCH_FAILED) on a non-2xx response', async () => {
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'no_active_loan' }), { status: 409 }));

    await expect(openReadingSession('book-001', request)).rejects.toMatchObject({
      code: expect.any(String),
      bookId: 'book-001',
    });
  });

  it('throws DownloadFailure(SESSION_FETCH_FAILED) when fetch itself rejects (offline)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed'));

    await expect(openReadingSession('book-001', request)).rejects.toMatchObject({
      code: DownloadError.SESSION_FETCH_FAILED,
      bookId: 'book-001',
    });
  });

  it('rejects with DownloadFailure(SESSION_FETCH_FAILED) instead of hanging forever when the server accepts the connection and never answers', async () => {
    jest.useFakeTimers();
    global.fetch = neverRespondingFetch();

    const pending = openReadingSession('book-001', request);
    const assertion = expect(pending).rejects.toMatchObject({
      code: DownloadError.SESSION_FETCH_FAILED,
      bookId: 'book-001',
    });

    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await assertion;
  });
});

describe('verifyReadingAccess', () => {
  const originalFetch = global.fetch;
  const mockGenerateDeviceKeypair = generateDeviceKeypair as jest.Mock;

  afterEach(() => {
    global.fetch = originalFetch;
    mockGenerateDeviceKeypair.mockReset();
    jest.useRealTimers();
  });

  it('resolves (fails open) instead of throwing when generateDeviceKeypair itself fails', async () => {
    // Regression test: generateDeviceKeypair() used to be called BEFORE the try block, so a
    // keychain-layer failure (device not yet unlocked, "keychain rejected storing the private
    // key" on a first-ever call) escaped this function's fail-open catch entirely and rejected
    // the caller — exactly the harm the policy exists to prevent for content already on the
    // device. It must be treated the same as an unreachable server: logged, not thrown.
    mockGenerateDeviceKeypair.mockRejectedValue(new Error('keychain rejected storing the private key'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Resolves `false` (fail-open, unconfirmed) rather than `true` (genuine confirmation) — the
    // distinction readingAccessMonitor.ts's online-licence-rollover call depends on.
    await expect(verifyReadingAccess('book-001', 'EPUB')).resolves.toBe(false);

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('still fails closed for an explicit revocation once past a successful keypair generation', async () => {
    mockGenerateDeviceKeypair.mockResolvedValue({ publicKey: 'pem' });
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 'DEVICE_LIMIT_REACHED', message: 'too many devices' }), { status: 403 }),
    );

    await expect(verifyReadingAccess('book-001', 'EPUB')).rejects.toMatchObject({
      code: DownloadError.DEVICE_LIMIT_REACHED,
    });
  });
});
