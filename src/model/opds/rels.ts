// src/model/opds/rels.ts
// The vocabulary seams between the OPDS wire format and our domain model.
//
// Every function here is TOTAL AND STRICT: it either returns a value from a
// closed union or throws MALFORMED_FEED. None of them fall back to a default.
// That is deliberate — a silent default here becomes a wrong button, a wrong
// reader, or an unhonourable cipher much further downstream, with nothing left
// in the stack to explain why. Failing at the boundary keeps the blame local.
import type { AcquisitionRel } from '@model/types';
import type { ContentFormat } from '@/shared/types/primitives';
import { CatalogueError, CatalogueFailure } from '@model/errors';

function malformed(what: string, value: string): CatalogueFailure {
  return new CatalogueFailure(CatalogueError.MALFORMED_FEED, `${what}: ${value}`);
}

// OPDS acquisition rel → what the user can do. Exhaustive by design: L-3 says the
// action vocabulary is still moving, so an unrecognised rel is news, not noise.
//
// All four rels the contract defines. `subscribe` means "not obtainable by you,
// here is how to get access" — it points at the public institution list rather
// than at a file, so it is the one rel that carries no `indirectAcquisition`.
const ACTION_BY_REL: Record<string, AcquisitionRel> = {
  'http://opds-spec.org/acquisition/borrow': 'borrow',
  'http://opds-spec.org/acquisition': 'acquire',
  'http://opds-spec.org/acquisition/open-access': 'openAccess',
  'http://opds-spec.org/acquisition/subscribe': 'subscribe',
};

export function toActionId(rel: string): AcquisitionRel {
  const action = ACTION_BY_REL[rel];
  if (!action) throw malformed('unknown acquisition rel', rel);
  return action;
}

// The book's media type → ContentFormat.
//
// NOT the acquisition link's own `type`, which is 'application/json': the href
// answers with JSON rather than with a book. The real media type lives in
// `properties.indirectAcquisition` — normalize.ts's toFileType pulls it out and
// hands it here. Not from metadata either, which says "a Book" for both a PDF and
// an audiobook.
const FORMAT_BY_MIME: Record<string, ContentFormat> = {
  'application/pdf': 'PDF',
  'application/epub+zip': 'EPUB',
  'audio/mpeg': 'AUDIO',
  // The contract's own indirectAcquisition.type is a free-form string, not an
  // enum — wokay's real backend sends this for at least one shelf.
  'audio/wav': 'AUDIO',
};

export function toContentFormat(mime: string): ContentFormat {
  const format = FORMAT_BY_MIME[mime];
  if (!format) throw malformed('unknown acquisition mime type', mime);
  return format;
}

// Seam 1: the feed identifies the cipher by W3C xmlenc URI; the frozen
// EncryptionDescriptor names it with a literal. Mapping here means the crypto
// layer never sees a URI and the two representations cannot drift apart.
const ALGORITHM_BY_URI: Record<string, 'AES-256-GCM'> = {
  'http://www.w3.org/2009/xmlenc11#aes256-gcm': 'AES-256-GCM',
};

export function toAlgorithm(uri: string): 'AES-256-GCM' {
  const algorithm = ALGORITHM_BY_URI[uri];
  if (!algorithm) throw malformed('unsupported encryption algorithm', uri);
  return algorithm;
}

// Last path segment of an href, used for publication and shelf ids.
//
// Ids come from the `self` href rather than from `metadata.identifier` because
// the backend keys by itemId while `identifier` is an ISBN — which open-access
// titles may lack entirely, and which is not what any other endpoint accepts.
export function idFromHref(href: string): string {
  // Strip query and fragment before splitting: shelf self-hrefs are paginated
  // ('.../groups/shelf_2?page=1') and the page must not become part of the id.
  const path = href.split(/[?#]/)[0].replace(/\/+$/, '');
  // Drop scheme://host FIRST. Without this, 'https://api.tf' has a plausible
  // last segment ('api.tf' — the `//` in the scheme provides the slash), so a
  // host-only href would silently yield the domain as an id.
  const pathOnly = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  const segment = pathOnly.slice(pathOnly.lastIndexOf('/') + 1);
  if (!segment) throw malformed('href has no id segment', href);
  return segment;
}

// A navigation entry's href is either a real shelf/group ('.../groups/{id}')
// or the catalogue root itself ('.../catalogue', '.../public/catalogue') — the
// zero-result "browse instead" affordance can point at either. `idFromHref`
// above still yields a string for both ('all', 'catalogue', ...), but only the
// first is a group getShelf recognises; the second always 404s there. This is
// what lets a caller route the two differently without reading meaning into
// the id itself, which NavLink's own doc says stays opaque.
export function isShelfHref(href: string): boolean {
  return /\/groups\//.test(href.split(/[?#]/)[0]);
}

export function isWorksHref(href: string): boolean {
  return /\/works\//.test(href.split(/[?#]/)[0]);
}
