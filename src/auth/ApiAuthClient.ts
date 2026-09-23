// src/auth/ApiAuthClient.ts
// Real HTTP client for flambeau's institutional (SAML) auth surface.
//
// The contract's own preamble says only saml/start and /me are "built today,"
// but that text is stale — verified directly against the flambeau backend
// (tf_reader_backend_temp's AuthController) that all four of saml/start,
// token, refresh and me are real, wired implementations. The known gap is
// the SAML browser leg itself failing on a SameSite=Lax session-cookie issue
// against a cross-origin mock IdP (backend-side, not this client's problem)
// — once that's past, all four calls here should genuinely answer.
//
// NO TOKEN PROVIDER INDIRECTION. Unlike ApiLicenceClient's getToken (needed
// because the licence token arrives long after construction), getCurrentSession
// takes the access token as a direct parameter — the caller always has it in
// hand at the moment it calls, fresh off the token exchange.
//
// TWO SEPARATE IDENTITY SOURCES for individual (non-institutional) readers, do
// not cross them: signUpWithPassword/login check flambeau's own Mongo
// credential store; startOidcSignIn/exchangeOidcTxn check an external OIDC
// provider instead and will never find an account signup/login created (or
// vice versa). personalAccount.ts's signInWithPassword uses login, matching
// signUpWithPassword's store — see AUTH_CONTEXT.md's "signup vs OIDC sign-in"
// update for the bug this distinction fixed.
import { AuthError, AuthFailure } from './AuthFailure';

// Only the parts of Response this client touches. Structural rather than the
// DOM type, so tests hand over a plain object and nothing here depends on
// which fetch React Native ships.
export interface AuthResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type AuthFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<AuthResponse>;

export interface ApiAuthClientOptions {
  // e.g. 'http://10.0.2.2:8080'. Trailing slashes are tolerated. No `/api/v1`
  // suffix — every call path below already includes it.
  baseUrl: string;
  fetch?: AuthFetch;
  timeoutMs?: number;
}

export interface SamlStart {
  authTxnId: string;
  // Resolved to an absolute URL here — the contract sends a relative path
  // (e.g. '/saml2/authenticate?...') because it assumes the caller already
  // knows the host, which openSamlBrowser.ts does not.
  authorizationUrl: string;
  institution: { institutionId: string; name: string };
  expiresAt: string;
  serverTime: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  // Institutional (SAML) sign-ins only — echo this back on the NEXT `saml/start` call
  // (as `deviceId`) so this device reclaims the same concurrent seat instead of the
  // institution spending a new one. Previously parsed and dropped entirely, which meant
  // this reclaim never happened — every sign-in, even on an already-known device, minted
  // a brand-new seat until the institution's cap (default 50, unconfigured anywhere) was
  // exhausted and every further sign-in failed with SEAT_LIMIT_REACHED.
  deviceId?: string;
}

export interface OidcStart {
  oidcTxnId: string;
  expiresAt: string;
  serverTime: string;
}

export interface CurrentSession {
  userId: string;
  type: 'INSTITUTION' | 'INDIVIDUAL';
  // Absent for an individual subscriber — never null. See AuthMeResponse's own
  // note in the contract: "institutionId is omitted, not null".
  institutionId?: string;
  roles: string[];
  collections: string[];
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class ApiAuthClient {
  private readonly baseUrl: string;
  private readonly fetch: AuthFetch;
  private readonly timeoutMs: number;

  constructor(options: ApiAuthClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetch = options.fetch ?? (globalThis.fetch as unknown as AuthFetch);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // Query params, not a JSON body — the live contract changed this from the
  // vendored copy's request shape. Hand-built rather than via URLSearchParams:
  // see FixtureSearchPipeline.ts's paramsOf for why (RN's polyfill is partial
  // enough to behave differently under Jest and on a device).
  async startSamlSignIn(params: {
    institutionId: string;
    idpHint?: string;
    // Omit on this device's first-ever sign-in; pass the deviceId a previous TokenPair
    // returned on every sign-in after that. See TokenPair.deviceId's own comment.
    deviceId?: string;
  }): Promise<SamlStart> {
    let query = `institutionId=${encodeURIComponent(params.institutionId)}`;
    if (params.idpHint !== undefined) {
      query += `&idpHint=${encodeURIComponent(params.idpHint)}`;
    }
    if (params.deviceId !== undefined) {
      query += `&deviceId=${encodeURIComponent(params.deviceId)}`;
    }
    const body = await this.send('POST', `/api/v1/auth/saml/start?${query}`);
    const parsed = parseSamlStart(body);
    return { ...parsed, authorizationUrl: this.resolveUrl(parsed.authorizationUrl) };
  }

  async exchangeSignInCode(code: string): Promise<TokenPair> {
    const body = await this.send('POST', '/api/v1/auth/token', { code });
    return parseTokenPair(body);
  }

  // No browser leg at all — unlike SAML, the caller supplies the credentials
  // directly and the backend exchanges them with the OIDC provider server-side.
  async startOidcSignIn(params: { username: string; password: string }): Promise<OidcStart> {
    const body = await this.send('POST', '/api/v1/auth/oidc/start', {
      username: params.username,
      password: params.password,
    });
    return parseOidcStart(body);
  }

  // oidcTxnId is single-use — redeeming it twice returns TOKEN_INVALID the
  // second time.
  async exchangeOidcTxn(oidcTxnId: string): Promise<TokenPair> {
    const body = await this.send('POST', '/api/v1/auth/oidc/token', { oidcTxnId });
    return parseTokenPair(body);
  }

  // No OIDC provider involved — this is flambeau's own Mongo-backed credential
  // store. Signs the reader in immediately, so a TokenPair comes back directly
  // rather than through a two-step start/exchange like OIDC. Duplicate email
  // refuses with errorCode EMAIL_TAKEN.
  async signUpWithPassword(params: { email: string; password: string }): Promise<TokenPair> {
    const body = await this.send('POST', '/api/v1/auth/signup', {
      email: params.email,
      password: params.password,
    });
    return parseTokenPair(body);
  }

  // The counterpart to signUpWithPassword — checks the SAME Mongo credential
  // store signup writes to. NOT the OIDC endpoints: those authenticate against
  // an external OIDC provider and never see an account signup created. Unknown
  // email and wrong password both refuse identically with errorCode
  // UNAUTHENTICATED (401), so this never leaks which one was wrong.
  async login(params: { email: string; password: string }): Promise<TokenPair> {
    const body = await this.send('POST', '/api/v1/auth/login', {
      email: params.email,
      password: params.password,
    });
    return parseTokenPair(body);
  }

  async refreshSession(refreshToken: string): Promise<TokenPair> {
    const body = await this.send('POST', '/api/v1/auth/refresh', { refreshToken });
    return parseTokenPair(body);
  }

  // The only one of the four that carries a bearer token — the others are
  // security: [] per the contract and must never send Authorization.
  async getCurrentSession(accessToken: string): Promise<CurrentSession> {
    const body = await this.send('GET', '/api/v1/auth/me', undefined, accessToken);
    return parseCurrentSession(body);
  }

  private resolveUrl(path: string): string {
    return path.startsWith('http') ? path : `${this.baseUrl}${path}`;
  }

  // One place that does the request, so no call can forget the deadline or the
  // error mapping. Returns `unknown`, never a parsed shape — parsing is the
  // module-scope parse* functions' job, kept out of here for the same reason
  // ApiLicenceClient keeps it out of `send`.
  private async send(
    method: string,
    path: string,
    body?: unknown,
    accessToken?: string,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    // THE DEADLINE COVERS THE BODY TOO — see ApiLicenceClient.send for why the
    // finally sits outside the fetch alone.
    try {
      let response: AuthResponse;
      try {
        response = await this.fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            ...(accessToken !== undefined ? { Authorization: `Bearer ${accessToken}` } : {}),
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });
      } catch (cause) {
        throw this.transportFailure(controller, cause);
      }

      if (!response.ok) throw await this.refusal(response);

      try {
        return await response.json();
      } catch (cause) {
        if (controller.signal.aborted) throw this.transportFailure(controller, cause);
        throw new AuthFailure(AuthError.MALFORMED_RESPONSE, { cause });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // Reads signal.aborted rather than inspecting the thrown value — Hermes does
  // not guarantee an aborted fetch rejects with an Error instance. See the same
  // note on ApiLicenceClient.transportFailure.
  private transportFailure(controller: AbortController, cause: unknown): AuthFailure {
    const code = controller.signal.aborted ? AuthError.TIMEOUT : AuthError.NETWORK_UNAVAILABLE;
    return new AuthFailure(code, { cause });
  }

  private async refusal(response: AuthResponse): Promise<AuthFailure> {
    let errorCode: string | undefined;
    try {
      const body = await response.json();
      if (typeof body === 'object' && body !== null) {
        const code = (body as Record<string, unknown>).code;
        if (typeof code === 'string' && code.length > 0) errorCode = code;
      }
    } catch {
      // A refusal with no readable body is still a refusal.
    }
    return new AuthFailure(AuthError.REFUSED, {
      ...(errorCode !== undefined ? { errorCode } : {}),
      cause: `HTTP ${response.status}`,
    });
  }
}

function asRecord(doc: unknown, what: string): Record<string, unknown> {
  if (typeof doc !== 'object' || doc === null) {
    throw new AuthFailure(AuthError.MALFORMED_RESPONSE, { cause: `${what} is not an object` });
  }
  return doc as Record<string, unknown>;
}

function reqString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AuthFailure(AuthError.MALFORMED_RESPONSE, { cause: `missing ${field}` });
  }
  return value;
}

function reqStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new AuthFailure(AuthError.MALFORMED_RESPONSE, { cause: `missing ${field}` });
  }
  return value;
}

function parseSamlStart(doc: unknown): SamlStart {
  const raw = asRecord(doc, 'SamlStartResponse');
  const institutionRaw = asRecord(raw.institution, 'institution');
  return {
    authTxnId: reqString(raw.authTxnId, 'authTxnId'),
    authorizationUrl: reqString(raw.authorizationUrl, 'authorizationUrl'),
    institution: {
      institutionId: reqString(institutionRaw.institutionId, 'institution.institutionId'),
      name: reqString(institutionRaw.name, 'institution.name'),
    },
    expiresAt: reqString(raw.expiresAt, 'expiresAt'),
    serverTime: reqString(raw.serverTime, 'serverTime'),
  };
}

function parseOidcStart(doc: unknown): OidcStart {
  const raw = asRecord(doc, 'OidcStartResponse');
  return {
    oidcTxnId: reqString(raw.oidcTxnId, 'oidcTxnId'),
    expiresAt: reqString(raw.expiresAt, 'expiresAt'),
    serverTime: reqString(raw.serverTime, 'serverTime'),
  };
}

function parseTokenPair(doc: unknown): TokenPair {
  const raw = asRecord(doc, 'TokenResponse');
  if (typeof raw.expiresIn !== 'number') {
    throw new AuthFailure(AuthError.MALFORMED_RESPONSE, { cause: 'missing expiresIn' });
  }
  const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId : undefined;
  return {
    accessToken: reqString(raw.accessToken, 'accessToken'),
    refreshToken: reqString(raw.refreshToken, 'refreshToken'),
    expiresIn: raw.expiresIn,
    ...(deviceId !== undefined ? { deviceId } : {}),
  };
}

function parseCurrentSession(doc: unknown): CurrentSession {
  const raw = asRecord(doc, 'AuthMeResponse');
  if (raw.type !== 'INSTITUTION' && raw.type !== 'INDIVIDUAL') {
    throw new AuthFailure(AuthError.MALFORMED_RESPONSE, { cause: 'missing or invalid type' });
  }
  const institutionId = typeof raw.institutionId === 'string' ? raw.institutionId : undefined;
  return {
    userId: reqString(raw.userId, 'userId'),
    type: raw.type,
    ...(institutionId !== undefined ? { institutionId } : {}),
    roles: reqStringArray(raw.roles, 'roles'),
    collections: reqStringArray(raw.collections, 'collections'),
  };
}
