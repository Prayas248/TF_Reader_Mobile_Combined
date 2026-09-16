// src/config/catalogue.ts
// The ONE place Mock vs Api is chosen.
//
// Everything else in the app depends on the `DataSource` interface (the six-method
// seam: catalogue + institutions) and takes its instance from here, so switching
// data sources is a config change rather than an edit spread across screens. This
// is the same principle CLAUDE.md's L-2 states for entitlement scoping: "scope is
// config, not branching logic" — no `if (__DEV__)` or `if (useMock)` anywhere
// above this file.
//
// Screens should narrow to the half they use (`CatalogueSource` or
// `InstitutionSource`) rather than taking the whole `DataSource`.
import type { DataSource } from '@adapters/InstitutionSource';
import { PartialApiAdapter } from '@adapters/PartialApiAdapter';
import { MockAdapter, type MockAdapterOptions } from '@adapters/MockAdapter';
import { ensureFreshToken } from '@/auth/tokenRefresh';
import { resolveHostForAndroidEmulator } from '@/config/androidHost';

export type CatalogueSourceKind = 'mock' | 'api';

// Expo exposes EXPO_PUBLIC_* to the client bundle, which is the idiomatic way to
// flip this per build without touching code.
const ENV_VAR = 'EXPO_PUBLIC_CATALOGUE_SOURCE';
const BASE_URL_VAR = 'EXPO_PUBLIC_CATALOGUE_BASE_URL';

/**
 * Interprets the configured source kind.
 *
 * Throws on an unrecognised value rather than defaulting. A typo'd env var that
 * quietly fell back to `mock` would produce a build that looks fine, talks to
 * nothing, and ships fixture data — the exact failure that is hardest to notice.
 */
export function resolveCatalogueSourceKind(raw: string | undefined): CatalogueSourceKind {
  // Unset is not a mistake: mock is the correct default while api.tf does not exist.
  if (raw === undefined || raw.trim() === '') return 'mock';

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'mock' || normalized === 'api') return normalized;

  throw new Error(
    `${ENV_VAR} must be 'mock' or 'api', got '${raw}'. ` +
      'Leave it unset to use fixtures.',
  );
}

export interface CreateCatalogueSourceOptions {
  kind?: CatalogueSourceKind;
  // Required when kind is 'api'. Not defaulted to the api.tf URL from the
  // fixtures: that host is unverified, and a default would let a misconfigured
  // build point at it silently.
  baseUrl?: string;
  // Latency / error injection, for the gallery and for demoing error states.
  mock?: MockAdapterOptions;
  // Overridable for tests. Defaults to the real ensureFreshToken, same
  // provider ApiLicenceClient's token wiring uses — one function, every
  // authenticated client reads from the same source of truth.
  getToken?: () => Promise<string | undefined>;
}

export function createCatalogueSource(
  options: CreateCatalogueSourceOptions = {},
): DataSource {
  const kind = options.kind ?? resolveCatalogueSourceKind(process.env.EXPO_PUBLIC_CATALOGUE_SOURCE);

  if (kind === 'api') {
    const configuredBaseUrl = options.baseUrl ?? process.env.EXPO_PUBLIC_CATALOGUE_BASE_URL;
    if (!configuredBaseUrl) {
      throw new Error(`${BASE_URL_VAR} must be set when ${ENV_VAR} is 'api'.`);
    }
    const baseUrl = resolveHostForAndroidEmulator(configuredBaseUrl);
    // Only institutions has a real endpoint today — everything else on this
    // DataSource still comes from fixtures until more of the backend ships.
    const getToken = options.getToken ?? ensureFreshToken;
    return new PartialApiAdapter(baseUrl, options.mock, getToken);
  }

  return new MockAdapter(options.mock);
}

// Process-wide instance for app code.
//
// Lazy rather than eagerly constructed at import time so that importing any
// module in this tree never reads env vars or builds an adapter as a side effect —
// tests and the gallery construct their own via createCatalogueSource().
let shared: DataSource | undefined;

export function getCatalogueSource(): DataSource {
  shared ??= createCatalogueSource();
  return shared;
}

// Test/story seam: replace or clear the shared instance. Kept explicit so no test
// has to reach into module internals to swap the data source.
export function setCatalogueSource(source: DataSource | undefined): void {
  shared = source;
}
