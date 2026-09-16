// src/config/search.ts
// The ONE place the Week-1 fixture pipeline vs wokay's real search endpoint is
// chosen — the same job `src/config/catalogue.ts` does for Mock vs Api, and
// deliberately the same shape so there is one pattern to learn rather than two.
//
// THIS FILE IS THE R3c ANSWER. Wokay's catalogue search endpoint arrives in Week 4,
// which is also Team 1's integration and BDD week. Every screen and every piece of
// query state above here depends on `CatalogueSearchPipeline` and takes its
// instance from this file, so the Week-4 change is: add `ApiSearchPipeline`,
// return it below. No search UI is rewritten, because none of it can name an
// implementation. CLAUDE.md L-2's rule, applied to search: "scope is config, not
// branching logic" — no `if (useFixture)` above this line.
import {
  FixtureSearchPipeline,
  type FixtureSearchPipelineOptions,
} from '@search/FixtureSearchPipeline';
import { ApiSearchPipeline } from '@search/ApiSearchPipeline';
import type { CatalogueSearchPipeline } from '@search/pipeline';
import { ensureFreshToken } from '@/auth/tokenRefresh';

export type SearchPipelineKind = 'fixture' | 'api';

// EXPO_PUBLIC_* is what reaches the client bundle, which is the idiomatic way to
// flip this per build without touching code.
const ENV_VAR = 'EXPO_PUBLIC_SEARCH_PIPELINE';

/**
 * Interprets the configured pipeline kind.
 *
 * Throws on an unrecognised value rather than defaulting, for the reason
 * `resolveCatalogueSourceKind` gives: a typo'd env var that quietly fell back to
 * fixtures would produce a build that looks fine, talks to nothing, and ships
 * canned search results — the failure that is hardest to notice.
 */
export function resolveSearchPipelineKind(raw: string | undefined): SearchPipelineKind {
  // Unset is not a mistake: the fixture is correct while the endpoint does not exist.
  if (raw === undefined || raw.trim() === '') return 'fixture';

  const normalized = raw.trim().toLowerCase();
  if (normalized === 'fixture' || normalized === 'api') return normalized;

  throw new Error(
    `${ENV_VAR} must be 'fixture' or 'api', got '${raw}'. ` +
      'Leave it unset to use the Week-1 fixture pipeline.',
  );
}

export interface CreateSearchPipelineOptions {
  kind?: SearchPipelineKind;
  // Latency / error injection, for the gallery and for demoing error states.
  fixture?: FixtureSearchPipelineOptions;
  // Overridable for tests. Defaults to ensureFreshToken.
  getToken?: () => Promise<string | undefined>;
}

export function createSearchPipeline(
  options: CreateSearchPipelineOptions = {},
): CatalogueSearchPipeline {
  // Must be static `process.env.EXPO_PUBLIC_SEARCH_PIPELINE`, not a computed
  // `process.env[ENV_VAR]` access — Expo's babel plugin only replaces the
  // former with its build-time value. The computed form survives untouched
  // into the release bundle, where there is no real `process.env` to read at
  // runtime, so it silently evaluated to `undefined` and fell back to the
  // fixture pipeline on every release build regardless of the configured env.
  const kind = options.kind ?? resolveSearchPipelineKind(process.env.EXPO_PUBLIC_SEARCH_PIPELINE);

  if (kind === 'api') {
    return new ApiSearchPipeline({
      getToken: options.getToken ?? ensureFreshToken,
      baseUrl: process.env.EXPO_PUBLIC_CATALOGUE_BASE_URL,
    });
  }

  return new FixtureSearchPipeline(options.fixture);
}

// Process-wide instance for app code.
//
// Lazy rather than constructed at import time, so importing anything in this tree
// never reads env vars or builds a pipeline as a side effect — tests and the
// gallery construct their own via createSearchPipeline().
let shared: CatalogueSearchPipeline | undefined;

export function getSearchPipeline(): CatalogueSearchPipeline {
  shared ??= createSearchPipeline();
  return shared;
}

// Test/story seam: replace or clear the shared instance. Kept explicit so no test
// has to reach into module internals to swap the pipeline.
export function setSearchPipeline(pipeline: CatalogueSearchPipeline | undefined): void {
  shared = pipeline;
}
