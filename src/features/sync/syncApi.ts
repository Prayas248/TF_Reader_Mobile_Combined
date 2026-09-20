import { ensureFreshToken } from '@/auth/tokenRefresh';
import { useSessionStore } from '@store/sessionStore';
import { API_BASE_URL, API_V1, REQUEST_TIMEOUT_MS } from './syncConfig';

/**
 * A thin client over the Mongo backend's per-entity CRUD endpoints.
 *
 * There is no batch sync endpoint, so the Sync Manager drives these one
 * operation at a time. The contract, as the running server actually behaves:
 *
 *   - `POST /api/v1/{entity}` stores the `id` in the body, so ids stay
 *     device-minted. A second POST with the same id answers **409**.
 *   - `PUT /api/v1/{entity}/{id}` does **not** upsert: an unknown id is 404.
 *     Push therefore falls back between the two - see `syncEngine`.
 *   - `updatedAt` is always overwritten with the server clock. `createdAt` is
 *     stored as sent; `isDeleted` on a create is ignored.
 *   - `DELETE` without `?hard=true` writes a tombstone and returns it.
 */

/**
 * WIRE FORMAT — timestamps.
 *
 * Every `…At` field crosses this boundary as an ISO-8601 UTC string, because that is what the
 * Mongo services emit and accept. The frozen contract's `Timestamp` is epoch-ms (a number), and
 * both are correct in their own layer: the contract describes the in-memory object Reader and
 * Personalization pass around, this describes the HTTP body. Personalization's adapter already
 * converts between them in the same direction (`msToText` / `textToMs`), and
 * `sharedPrefs.timestampCodec` is the sync-side equivalent, so local storage stays consistent.
 *
 * OPEN, and worth confirming before anyone POSTs a contract object straight at the backend:
 * a caller who skipped the adapters and sent `updatedAt` as a raw number would be sending a
 * shape these endpoints have not been tested against. Nothing in this feature does that today.
 *
 * `serverTime` below is a separate, coarser thing - see its own note.
 */

/** Carries the HTTP status so the Sync Manager can tell transient from permanent. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Parsed response body, when there was one. A 409 carries the server's record. */
    readonly body: any = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Network failure, timeout, or a server fault: worth retrying unchanged. */
  get isTransient(): boolean {
    return this.status === 0 || this.status >= 500;
  }

  /** The payload itself is unacceptable. Retrying it verbatim will not help. */
  get isValidation(): boolean {
    return this.status === 400 || this.status === 422;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }
}

export interface ApiResponse<T> {
  data: T;
  /**
   * The server's own clock, from the HTTP `Date` header. Used for the pull
   * checkpoint so it never depends on the device clock. Second precision, and
   * truncated downwards, which is the safe direction - it can only widen the
   * next pull window, never skip a record.
   *
   * That truncation is currently free, because SUPPORTS_UPDATED_AFTER is off and the
   * checkpoint is stored but never sent. It stops being free the moment that flag flips: a
   * checkpoint a fraction of a second early means the next pull re-fetches a handful of records
   * it already has, which Last-Write-Wins then discards. Wasteful, not wrong - but if the
   * collection GETs ever gain a millisecond-precision `updatedAfter`, take the checkpoint from
   * a record's own `updatedAt` rather than from this header.
   */
  serverTime: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    // Real backend, always (see syncConfig.ts) — a bearer token is required or the resource-server
    // chain 401s before routing runs, same as download/readingSessionClient.ts's real-backend calls.
    // Fetched inside this try so a token-fetch failure surfaces as the same transient ApiError(0) a
    // network failure below would, rather than an uncaught bare Error.
    //
    // PREVIOUSLY: devAuthToken.ts minted a token for a hardcoded dev identity, disconnected from
    // whoever actually signed in — every synced bookmark/highlight/progress/preference record was
    // written under that fake identity, never the real account. ensureFreshToken() is the same
    // real-session source every other authenticated call in the app uses.
    const token = await ensureFreshToken();
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    // Unreachable host, DNS failure, or the abort above. Status 0 = transient.
    const reason = error instanceof Error ? error.message : String(error);
    throw new ApiError(`${path}: ${reason}`, 0);
  } finally {
    clearTimeout(timer);
  }

  const serverTime = parseServerDate(response.headers.get('date'));

  if (!response.ok) {
    // If the token was rejected, clear the session so the next request forces a real refresh
    // (or a fresh sign-in, if the refresh token is dead too) rather than the same session store
    // handing ensureFreshToken() the identical rejected access token again. A 401 means the
    // server invalidated it (e.g., signed out on another device, session revoked).
    if (response.status === 401) {
      useSessionStore.getState().clearSession();
    }
    throw new ApiError(
      `${response.status} ${response.statusText} on ${path}`,
      response.status,
      await safeJson(response),
    );
  }

  if (response.status === 204) {
    return { data: undefined as T, serverTime };
  }
  return { data: normalize(await safeJson(response)) as T, serverTime };
}

async function safeJson(response: Response): Promise<any> {
  try {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function parseServerDate(header: string | null): string {
  if (header) {
    const parsed = new Date(header);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Rewrites every `…At` field to millisecond ISO-8601.
 *
 * This is not cosmetic. The same document comes back with two different
 * precisions depending on the endpoint: a write echoes the in-memory Instant
 * (`…:54.199801Z`, microseconds) while a collection GET reads it back out of
 * Mongo (`…:54.199Z`, milliseconds, which is all BSON stores). Last-Write-Wins
 * compares these as plain strings, and `'…54.199801Z' < '…54.199Z'` because
 * `'8' < 'Z'` - so the record the device just pushed would look *newer* on
 * every subsequent pull and be re-applied forever. Truncating both to
 * milliseconds on the way in makes the comparison mean what it says.
 */
function canonicalTimestamps(record: Record<string, any>): Record<string, any> {
  let result = record;
  for (const [key, value] of Object.entries(record)) {
    if (!key.endsWith('At') || typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) {
      continue;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) continue;
    if (result === record) result = { ...record };
    result[key] = parsed.toISOString();
  }
  return result;
}

/**
 * Mongo documents serialize their key as `id` under Spring Data's default
 * mapping, but a `@Field("_id")` or a raw driver response can surface `_id`
 * instead. Accept either so the mappers only ever see `id`.
 */
function normalize(value: any): any {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;

  const record = canonicalTimestamps(value);
  if (record._id != null && record.id == null) {
    return { ...record, id: String(record._id) };
  }
  return record;
}

const collection = (entityPath: string) => `${API_V1}/${entityPath}`;

function queryString(params: Record<string, string | undefined>): string {
  const pairs = Object.entries(params)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${key}=${encodeURIComponent(value as string)}`);
  return pairs.length ? `?${pairs.join('&')}` : '';
}

export const api = {
  /**
   * Reachability probe, against a real collection because the backend exposes
   * no health endpoint. Any answer at all, including an error status, means the
   * host is up - only a transport failure counts as unreachable.
   */
  async health(): Promise<boolean> {
    try {
      await request(`${collection('progress')}${queryString({ userId: '__ping__' })}`);
      return true;
    } catch (error) {
      return error instanceof ApiError && !error.isTransient;
    }
  },

  /**
   * PUSH, create. The device-minted `id` in the body is honoured, so the server
   * never assigns one. A repeat of a create that already landed answers 409.
   */
  create: <T>(entityPath: string, body: unknown) =>
    request<T>(collection(entityPath), {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** PUSH, update. 404 when the server has never seen this id - it is not an upsert. */
  update: <T>(entityPath: string, id: string, body: unknown) =>
    request<T>(`${collection(entityPath)}/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  /** PUSH, delete. `hard` is left at its default so this writes a tombstone. */
  remove: <T>(entityPath: string, id: string) =>
    request<T>(`${collection(entityPath)}/${id}`, { method: 'DELETE' }),

  /** Used by the conflict pre-check. Throws ApiError 404 when absent. */
  findById: <T>(entityPath: string, id: string) =>
    request<T>(`${collection(entityPath)}/${id}`),

  /**
   * PULL. `includeDeleted` is mandatory: without the tombstones a record
   * deleted on another device would be resurrected on the next sync.
   */
  list: <T>(
    entityPath: string,
    params: { userId: string; bookId?: string; updatedAfter?: string },
  ) =>
    request<T[]>(
      `${collection(entityPath)}${queryString({ ...params, includeDeleted: 'true' })}`,
    ),

  /**
   * Un-deletes a tombstoned record in place, under its OWN id. `downloads` only today: a create
   * for a (bookId, format) that already has a record - even a soft-deleted one - answers 409
   * CODE_TAKEN rather than creating a second one, and the only path back from that tombstone is
   * this endpoint on the record's real id (confirmed against the real backend, 2026-08-31) - see
   * `DownloadRestoreCollision` in syncEngine.ts.
   */
  restore: <T>(entityPath: string, id: string) =>
    request<T>(`${collection(entityPath)}/${id}/restore`, { method: 'POST' }),
};
