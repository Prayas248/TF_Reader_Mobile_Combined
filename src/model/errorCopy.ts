// src/model/errorCopy.ts
// The single CatalogueError → copy map. Every screen with a catalogue-backed
// error state (search, home catalogue, shelf) reads from here rather than
// keeping its own — SearchScreen used to carry its own `ERROR_COPY`, and
// CatalogueScreen/ShelfScreen carried no code-specific copy at all, just a
// fixed "couldn't load" string regardless of why. One list means a code's
// wording only ever changes in one place, and a new CatalogueError member is a
// compile error here rather than a screen quietly falling back to nothing.
//
// KEYED ON CODE, NEVER ON HTTP STATUS. wokay's own vocabulary, not the
// transport's — see errors.ts. A reader is never shown a number.
import { CatalogueError } from '@model/errors';
import { ERROR_CODES, type ErrorCode } from '@model/types';
import type { ErrorStateVariant } from '@components/ErrorState';

export const CATALOGUE_ERROR_COPY: Record<CatalogueError, string> = {
  [CatalogueError.NOT_FOUND]: 'This could not be found.',
  [CatalogueError.NETWORK_UNAVAILABLE]: 'You appear to be offline.',
  [CatalogueError.MALFORMED_FEED]: 'Something went wrong loading this content.',
  [CatalogueError.TIMEOUT]: 'This took too long to respond.',
  [CatalogueError.TOO_MANY_IDS]: 'Too many items requested at once.',
  [CatalogueError.UNAUTHENTICATED]: 'You need to sign in again to continue.',
};

// Which ErrorState affordance a code renders with. NOT_FOUND is the one code
// nothing can fix by trying again — the thing asked for genuinely is not
// there — so it is the only one that resolves to a non-retryable variant.
const ERROR_STATE_VARIANT: Record<CatalogueError, ErrorStateVariant> = {
  [CatalogueError.NOT_FOUND]: 'not_found',
  [CatalogueError.NETWORK_UNAVAILABLE]: 'network',
  [CatalogueError.MALFORMED_FEED]: 'not_ready',
  [CatalogueError.TIMEOUT]: 'not_ready',
  [CatalogueError.TOO_MANY_IDS]: 'not_ready',
  [CatalogueError.UNAUTHENTICATED]: 'access_restricted',
};

export function catalogueErrorVariant(code: CatalogueError): ErrorStateVariant {
  return ERROR_STATE_VARIANT[code];
}

// The published wire vocabulary (ERROR_CODES, model/types.ts) — a second, sibling
// map to CATALOGUE_ERROR_COPY above. CatalogueError is our own adapter-layer
// transport enum; this is wokay's/flambeau's actual error codes, the ones a
// licence or entitlement call rejects with. A `Record<ErrorCode, string>` means
// a code added to ERROR_CODES without copy here is a compile error, not a screen
// silently rendering nothing.
//
// KEYED ON CODE, NEVER ON HTTP STATUS — DOWNLOAD_NOT_PERMITTED is a different
// status in wokay's document than in flambeau's, and keying on the code costs
// nothing when they disagree.
export const WIRE_ERROR_COPY: Record<ErrorCode, string> = {
  UNAUTHENTICATED: 'You need to sign in to continue.',
  TOKEN_EXPIRED: 'Your session has expired. Sign in again to continue.',
  FORBIDDEN_INSTITUTION_MISMATCH: "This title isn't available through your institution.",
  NO_ENTITLEMENT: 'Your institution does not provide access to this title.',
  ENTITLEMENT_EXPIRED: "Your institution's access to this title has expired.",
  ENTITLEMENT_SUSPENDED: "Your institution's access to this title is currently suspended.",
  CONTENT_NOT_READY: 'This title is still being prepared. Try again in a moment.',
  DOWNLOAD_NOT_PERMITTED: 'This title is available to read online only.',
  INVALID_DEVICE_PUBLIC_KEY: 'Something went wrong setting up this device. Please try again.',
  NOT_FOUND: 'This could not be found.',
  NO_COPIES_AVAILABLE: 'There are no copies of this title available right now.',
  NO_ACTIVE_LOAN: "You don't currently have this title on loan.",
  LOAN_NOT_ACTIVE: 'This loan is no longer active.',
  DEVICE_LIMIT_REACHED: "You've reached the device limit for this title. Sign out of another device to continue.",
  // Ordinary reply, not an exceptional one (flambeau): offers lapse on a
  // schedule and the app is often a few seconds behind. Both halves matter —
  // the window closing, and rejoining the queue at the back — because the
  // second half is the part a reader will not guess on their own.
  OFFER_EXPIRED: "This offer expired before it was accepted, and you've rejoined the queue at the back.",
  VALIDATION_FAILED: 'That request could not be processed. Please try again.',
  FORBIDDEN_SCOPE: "This action isn't permitted for your account.",
  INSTITUTION_INACTIVE: "Your institution's access is currently inactive.",
  TOO_MANY_IDS: 'Something went wrong loading these items. Please try again.',
  SERVICE_UNAVAILABLE: 'This is taking longer than it should. Please try again in a moment.',
};

// Auth and entitlement codes are informational — nothing about pressing Retry
// changes who the reader is or what their institution provides. NOT_FOUND is
// the same "trying again cannot help" case as in CATALOGUE_ERROR_COPY. Everything
// else is either transient (server/queue state that can change) or an internal
// fault worth one more attempt.
export const WIRE_ERROR_VARIANT: Record<ErrorCode, ErrorStateVariant> = {
  UNAUTHENTICATED: 'access_restricted',
  TOKEN_EXPIRED: 'access_restricted',
  FORBIDDEN_INSTITUTION_MISMATCH: 'access_restricted',
  NO_ENTITLEMENT: 'access_restricted',
  ENTITLEMENT_EXPIRED: 'access_restricted',
  ENTITLEMENT_SUSPENDED: 'access_restricted',
  CONTENT_NOT_READY: 'not_ready',
  DOWNLOAD_NOT_PERMITTED: 'access_restricted',
  INVALID_DEVICE_PUBLIC_KEY: 'not_ready',
  NOT_FOUND: 'not_found',
  NO_COPIES_AVAILABLE: 'access_restricted',
  NO_ACTIVE_LOAN: 'access_restricted',
  LOAN_NOT_ACTIVE: 'access_restricted',
  DEVICE_LIMIT_REACHED: 'access_restricted',
  OFFER_EXPIRED: 'not_ready',
  VALIDATION_FAILED: 'not_ready',
  FORBIDDEN_SCOPE: 'access_restricted',
  INSTITUTION_INACTIVE: 'access_restricted',
  TOO_MANY_IDS: 'not_ready',
  // Transient infrastructure blip, not an access or data problem — 'not_ready' is the same
  // "retry, nothing about this is permanent" bucket TIMEOUT-shaped codes already use.
  SERVICE_UNAVAILABLE: 'not_ready',
};

export function wireErrorVariant(code: ErrorCode): ErrorStateVariant {
  return WIRE_ERROR_VARIANT[code];
}

// Re-exported so a test (or a caller) can assert exhaustiveness against the
// same array the Record types are checked against, without re-importing
// model/types directly.
export { ERROR_CODES };
