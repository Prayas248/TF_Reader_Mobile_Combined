// src/config/licence.ts
// The ONE place Mock vs Api is chosen for the licence calls.
//
// Same principle as config/catalogue.ts, and separate from it on purpose: the catalogue
// is wokay's and the licence calls are flambeau's, and the two backends will not become
// real on the same day. flambeau have built no licence endpoint at all — the two they
// have are both authentication — and wokay's catalogue endpoints arrive Week 3 at the
// earliest. One switch for both would force a choice nobody wants to make: real licences
// against fixture books, or the reverse.
//
// No `if (__DEV__)` and no `useMock` anywhere above this file.
import { ApiLicenceClient, MockLicenceClient, type LicenceSource } from '@/licence';
import { resolveHostForAndroidEmulator } from '@/config/androidHost';

export type LicenceSourceKind = 'mock' | 'api';

// Named only for error messages. THE READS BELOW USE THE LITERALS, and that is not
// lint-appeasement: Expo's babel plugin replaces `process.env.EXPO_PUBLIC_*` with the
// value at BUILD time by matching the text. A dynamic `process.env[SOME_VAR]` is not
// matched, so it survives into the bundle as a lookup on an object that is not there and
// evaluates to `undefined` — silently, and only in a production build.
//
// For this file that would mean a release build ignoring `api` and using the mock: a
// reader shown a borrow that never happened. `resolveLicenceSourceKind` throws on a typo
// precisely to stop that, and a dynamic read would walk straight around it.
const ENV_VAR = 'EXPO_PUBLIC_LICENCE_SOURCE';
const BASE_URL_VAR = 'EXPO_PUBLIC_FLAMBEAU_BASE_URL';

/**
 * Interprets the configured source kind.
 *
 * Throws on an unrecognised value rather than defaulting, for the reason
 * config/catalogue.ts gives: a typo that quietly fell back to `mock` produces a build
 * that looks fine, talks to nothing, and would show a reader a borrow that never
 * happened.
 */
export function resolveLicenceSourceKind(raw: string | undefined): LicenceSourceKind {
  // Unset is not a mistake. Mock is correct while four of the six calls do not exist.
  if (raw === undefined || raw.trim() === '') return 'mock';

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'mock' || normalized === 'api') return normalized;

  throw new Error(
    `${ENV_VAR} must be 'mock' or 'api', got '${raw}'. Leave it unset to use the mock.`,
  );
}

export interface LicenceSourceDeps {
  // Where the bearer token comes from.
  //
  // SUPPLYING THIS LATE IS THE NORMAL CASE, not an edge one, which is why it is read
  // through `setLicenceToken` below rather than captured at construction. The session
  // store is Keshav's and unbuilt, so the first thing to ask for a licence source —
  // a gallery screen, a preload, anything at module scope — will have no token to give.
  // Capturing "no token" at that moment used to pin the client to it for the whole
  // process, and every later caller passing a real one was silently dropped.
  getToken?: () => Promise<string | undefined>;
  // Items with no free copies, so `borrow` refuses and the queue becomes reachable.
  // Mock only, ignored for `api`. Without one of these the Elite sequence cannot be
  // demonstrated at all, because every borrow succeeds.
  contendedItems?: string[];
}

let cached: LicenceSource | undefined;

// The current token provider, held here rather than inside the client.
//
// THE CLIENT GETS A STABLE CLOSURE THAT DELEGATES TO THIS, so replacing the provider
// takes effect on the next request rather than needing a new client. That is what makes
// the ordering above harmless: an instance built before sign-in starts sending an
// Authorization header the moment the session store calls `setLicenceToken`.
//
// Defaults to no token, which stays the honest answer until then — flambeau's 401 for a
// missing token is clearer than their response to a fabricated one.
let tokenProvider: () => Promise<string | undefined> = async () => undefined;

/**
 * Points the licence client at a source of bearer tokens.
 *
 * Call this from the session store once it can mint one. Safe to call before or after
 * `getLicenceSource`, and safe to call again when the session changes.
 */
export function setLicenceToken(provider: () => Promise<string | undefined>): void {
  tokenProvider = provider;
}

// What the cached instance was built from, so a later caller asking for something
// different is told rather than ignored.
let cachedContendedItems: string | undefined;

/**
 * The app's licence source. One instance, because `MockLicenceClient` holds state — a
 * second one would forget the loan the first just wrote, and the Elite sequence would
 * come apart between two screens.
 *
 * THROWS RATHER THAN IGNORING A CONFLICTING `contendedItems`. Returning the cached
 * instance and quietly discarding what the caller asked for is how a second screen ends
 * up demonstrating a different flow from the first and nobody can see why. `getToken`
 * needs no such guard because it is no longer captured — see `setLicenceToken`.
 */
export function getLicenceSource(deps: LicenceSourceDeps = {}): LicenceSource {
  // Accepted whenever it is offered, including on a call that then returns the cache.
  // A caller with a token has one whether or not it happens to be the first caller.
  if (deps.getToken !== undefined) setLicenceToken(deps.getToken);

  const wanted = deps.contendedItems === undefined ? undefined : JSON.stringify(deps.contendedItems);

  if (cached !== undefined) {
    if (wanted !== undefined && cachedContendedItems !== wanted) {
      throw new Error(
        'getLicenceSource: the licence source already exists with different ' +
          `contendedItems (${cachedContendedItems ?? 'default'} vs ${wanted}). ` +
          'Call resetLicenceSource() first, or ask for it once at startup.',
      );
    }
    return cached;
  }

  const kind = resolveLicenceSourceKind(process.env.EXPO_PUBLIC_LICENCE_SOURCE);

  if (kind === 'mock') {
    // A default so the flow is demonstrable out of the box. Overridable, and it has to
    // line up with an ELITE title in the catalogue fixtures to be reachable.
    const contendedItems = deps.contendedItems ?? ['item_42'];
    cachedContendedItems = JSON.stringify(contendedItems);
    cached = new MockLicenceClient({ contendedItems });
    return cached;
  }

  const raw = process.env.EXPO_PUBLIC_FLAMBEAU_BASE_URL;
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`${BASE_URL_VAR} must be set when ${ENV_VAR} is 'api'.`);
  }
  // TRIMMED HERE, not only tested for emptiness. The guard above already tolerates
  // surrounding whitespace, and the client strips trailing slashes but not spaces — so
  // an env var of " https://flambeau.tf " used to pass and then put whitespace in every
  // request URL.
  const baseUrl = resolveHostForAndroidEmulator(raw.trim());

  cachedContendedItems = wanted;
  cached = new ApiLicenceClient({
    baseUrl,
    // Delegates rather than captures, so a provider set later is honoured.
    getToken: () => tokenProvider(),
  });
  return cached;
}

/**
 * Drops the cached instance and the token provider. Tests only — it is how one test's
 * loans, and one test's token, stay out of the next.
 */
export function resetLicenceSource(): void {
  cached = undefined;
  cachedContendedItems = undefined;
  tokenProvider = async () => undefined;
}
