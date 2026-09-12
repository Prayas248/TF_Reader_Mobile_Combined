// src/model/opds/normalize.ts
// OPDS 2.0 → domain model. PURE: no fetch, no fs, no clock, no config.
//
// This file is the ONLY place in the app that understands the OPDS wire format.
// MockAdapter and ApiAdapter both funnel through it, which is what makes them
// interchangeable by construction rather than by convention — there is no second
// parser that could drift.
//
// Input is typed `unknown` on purpose. It is untrusted JSON off the wire (or off
// disk), so every field is checked on the way in and anything unexpected becomes
// a loud MALFORMED_FEED rather than an `undefined` that surfaces three screens
// later as a blank row.
import type {
  AccessTier,
  Acquisition,
  Catalogue,
  CatalogueEncryption,
  NavLink,
  Publication,
  SearchFeed,
  Shelf,
  WorkFeed,
  WorkType,
} from '@model/types';
import { ACCESS_TIERS } from '@model/types';
import { CatalogueError, CatalogueFailure } from '@model/errors';
import { idFromHref, isShelfHref, isWorksHref, toActionId, toAlgorithm, toContentFormat } from '@model/opds/rels';

type Json = Record<string, unknown>;

const ACQUISITION_REL_PREFIX = 'http://opds-spec.org/acquisition';

function malformed(what: string): CatalogueFailure {
  return new CatalogueFailure(CatalogueError.MALFORMED_FEED, what);
}

function asRecord(value: unknown, what: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw malformed(`${what} is not an object`);
  }
  return value as Json;
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw malformed(`${what} is not an array`);
  return value;
}

function optString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function reqString(value: unknown, what: string): string {
  const str = optString(value);
  if (str === undefined) throw malformed(`missing ${what}`);
  return str;
}

function optNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function reqBoolean(value: unknown, what: string): boolean {
  // Not defaulted to false: `canPersist` silently defaulting would make a
  // downloadable book quietly undownloadable, with nothing to point at.
  if (typeof value !== 'boolean') throw malformed(`missing ${what}`);
  return value;
}

// OPDS spells repeated people/subjects as [{ name }]; the UI wants ['name'].
// A bare string is accepted too — the spec permits it and real feeds use it.
function toNames(value: unknown): string[] {
  if (value === undefined) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries
    .map((entry) => (typeof entry === 'string' ? entry : optString(asRecord(entry, 'name').name)))
    .filter((name): name is string => name !== undefined);
}

function findLink(links: unknown[], predicate: (rel: string) => boolean): Json | undefined {
  for (const raw of links) {
    const link = asRecord(raw, 'link');
    const rel = optString(link.rel);
    if (rel !== undefined && predicate(rel)) return link;
  }
  return undefined;
}

// `page` index out of a paginated href. Strict rather than assuming "current + 1":
// if the server paginates by cursor instead, we want to hear about it now.
function pageFromHref(href: string): number {
  const match = /[?&]page=(\d+)/.exec(href);
  if (!match) throw malformed(`next link has no page parameter: ${href}`);
  return Number(match[1]);
}

// ISBNs arrive as 'urn:isbn:9780367211745', but plenty of titles are identified by
// a catalogue urn instead ('urn:tf:catalogue:item_ab6'). Only unwrap a real ISBN —
// keeping the tail of any other urn would be a plausible-looking lie.
function toIsbn(identifier: unknown): string | undefined {
  const urn = optString(identifier);
  if (urn === undefined) return undefined;
  const prefix = 'urn:isbn:';
  return urn.startsWith(prefix) ? urn.slice(prefix.length) : undefined;
}

function toEncryption(properties: Json): CatalogueEncryption | null {
  // Absent `encrypted` is a STATE, not missing data: open access ships
  // plaintext, and null is that state, never `undefined`. Audio is NOT
  // guaranteed plaintext any more (reversed 3 Sep 2026) — a publication with
  // format AUDIO can legitimately carry a real `encrypted` block here.
  if (properties.encrypted === undefined) return null;
  const encrypted = asRecord(properties.encrypted, 'encrypted');
  const originalLength = optNumber(encrypted.originalLength);
  if (originalLength === undefined) throw malformed('encrypted block has no originalLength');
  return {
    algorithm: toAlgorithm(reqString(encrypted.algorithm, 'encryption algorithm')),
    originalLength,
  };
}

// Required on every acquisition link, including open access. The contract is
// explicit that `rel` says how a book is obtained and `licenceModel` says what to
// render, so an absent tier is a broken feed rather than a default to guess at.
function toAccessTier(properties: Json): AccessTier {
  const raw = reqString(properties.licenceModel, 'licenceModel');
  for (const tier of ACCESS_TIERS) {
    if (raw === tier) return tier;
  }
  throw malformed(`unknown licenceModel: ${raw}`);
}

// The book's own media type, which is NOT the acquisition link's `type`. The
// href points at flambeau and answers with JSON, so the link says
// 'application/json' and the real type sits under `indirectAcquisition` — the
// standard OPDS field for a link that leads to a file rather than being one.
//
// The contract pins the array to exactly one entry. Read the first and reject an
// empty array rather than indexing blind, because a blank format would surface
// later as a row that cannot be opened.
//
// SUBSCRIBE LINKS DO NOT COME HERE — 17 Aug, and that is the whole of how the gap
// closed. A `subscribe` link leads to a page rather than a file, so it carries no
// `indirectAcquisition` and there is no type for this function to find. Rather
// than teach it to return nothing, the caller does not ask: see the `format` line
// in `normalizePublication`, which now omits the field for that one rel.
//
// SO THIS STAYS STRICT, deliberately. Every other rel promises a file, and a
// borrowable title whose type we cannot read is a broken feed — throwing here is
// what stops it surfacing later as a row that opens nothing.
function toFileType(link: Json): string {
  const properties = asRecord(link.properties, 'acquisition properties');
  const entries = asArray(properties.indirectAcquisition, 'indirectAcquisition');
  const first = entries[0];
  if (first === undefined) throw malformed('indirectAcquisition is empty');
  return reqString(asRecord(first, 'indirectAcquisition entry').type, 'indirect acquisition type');
}

function toAcquisition(link: Json): Acquisition {
  const properties = link.properties === undefined ? {} : asRecord(link.properties, 'properties');
  const copies = properties.copies === undefined ? undefined : asRecord(properties.copies, 'copies');

  const actionId = toActionId(reqString(link.rel, 'acquisition rel'));

  const acquisition: Acquisition = {
    actionId,
    href: reqString(link.href, 'acquisition href'),
    licenceModel: toAccessTier(properties),
    ...(copies !== undefined && optNumber(copies.total) !== undefined
      ? { copiesTotal: optNumber(copies.total) as number }
      : {}),
    encryption: toEncryption(properties),
    ...(optString(properties.accessTier) !== undefined
      ? { accessTier: optString(properties.accessTier) as string }
      : {}),
  };

  // BOTH OF THESE DESCRIBE A FILE, so they are absent for `subscribe` and
  // required for everything else — the same split, and the same reason, as
  // `format` in normalizePublication. `OpdsLinkProperties` requires
  // `licenceModel` alone; the contract's subscribe examples send only that and
  // `availability`, so reading these unconditionally rejected every real
  // subscribe title as MALFORMED_FEED before resolveAccess could see it.
  //
  // Keyed on the normalized `actionId` rather than the raw rel, so this and the
  // `format` rule cannot drift apart.
  if (actionId !== 'subscribe') {
    acquisition.hasSearchIndex = reqBoolean(properties.hasSearchIndex, 'hasSearchIndex');
    acquisition.canPersist = reqBoolean(properties.canPersist, 'canPersist');
  }

  return acquisition;
}

// Widest image is the cover; the narrowest is the thumbnail, but only when the
// feed actually supplies more than one. With a single image, claiming a thumbnail
// would hand the UI a full-size asset to render in a list row.
function toImages(value: unknown): { coverUrl?: string; thumbnailUrl?: string } {
  if (value === undefined) return {};
  const images = asArray(value, 'images')
    .map((raw) => asRecord(raw, 'image'))
    .map((image) => ({ href: optString(image.href), width: optNumber(image.width) ?? 0 }))
    .filter((image): image is { href: string; width: number } => image.href !== undefined)
    .sort((a, b) => b.width - a.width);

  if (images.length === 0) return {};
  return {
    coverUrl: images[0].href,
    ...(images.length > 1 ? { thumbnailUrl: images[images.length - 1].href } : {}),
  };
}

// Maps wokay's `metadata['@type']` to our WorkType. Both http and https forms
// are accepted — feeds in the wild use both. Returns undefined for any value not
// yet in the published contract (journal, article — Q-1b unanswered); callers
// fall back to BOOK_WORK_TYPE. Adding a mapping here is the only change needed
// once wokay confirms the missing values.
const WOKAY_TYPE_MAP: Record<string, WorkType> = {
  'http://schema.org/Book': 'book',
  'https://schema.org/Book': 'book',
  'http://schema.org/Audiobook': 'audiobook',
  'https://schema.org/Audiobook': 'audiobook',
};

function toWorkType(value: unknown): WorkType | undefined {
  return typeof value === 'string' ? WOKAY_TYPE_MAP[value] : undefined;
}

export function normalizePublication(doc: unknown): Publication {
  const publication = asRecord(doc, 'publication');
  const metadata = asRecord(publication.metadata, 'publication metadata');
  const links = asArray(publication.links, 'publication links');

  const self = findLink(links, (rel) => rel === 'self');
  if (self === undefined) throw malformed('publication has no self link');

  const acquisitionLink = findLink(links, (rel) => rel.startsWith(ACQUISITION_REL_PREFIX));
  // No acquisition link means nothing can be done with the title. Rendering it
  // would produce a row with no working action, so reject it at the boundary.
  if (acquisitionLink === undefined) throw malformed('publication has no acquisition link');

  const publisher = publication.metadata && metadata.publisher !== undefined
    ? optString(asRecord(metadata.publisher, 'publisher').name)
    : undefined;

  // Normalized once, before the object, because `format` below has to branch on
  // its `actionId`. It used to be built inline in the return.
  const acquisition = toAcquisition(acquisitionLink);

  return {
    id: idFromHref(reqString(self.href, 'publication self href')),
    ...(toIsbn(metadata.identifier) !== undefined
      ? { isbn: toIsbn(metadata.identifier) as string }
      : {}),
    title: reqString(metadata.title, 'publication title'),
    ...(optString(metadata.subtitle) !== undefined
      ? { subtitle: optString(metadata.subtitle) as string }
      : {}),
    authors: toNames(metadata.author),
    ...(publisher !== undefined ? { publisher } : {}),
    ...(optString(metadata.language) !== undefined
      ? { language: optString(metadata.language) as string }
      : {}),
    ...(optString(metadata.published) !== undefined
      ? { published: optString(metadata.published) as string }
      : {}),
    subjects: toNames(metadata.subject),
    ...(optString(metadata.description) !== undefined
      ? { description: optString(metadata.description) as string }
      : {}),
    ...(optNumber(metadata.numberOfPages) !== undefined
      ? { numberOfPages: optNumber(metadata.numberOfPages) as number }
      : {}),
    // OMITTED FOR `subscribe` AND FOR NOTHING ELSE. That rel leads to a page
    // rather than a file and carries no `indirectAcquisition`, so there is no type
    // to read; every other rel promises a file and still throws without one. The
    // rel is read from the already-normalized `acquisition` rather than off the
    // raw link, so this test and `resolveAccess`'s subscribe case cannot drift
    // apart — they are both keyed on `actionId`.
    ...(acquisition.actionId === 'subscribe'
      ? {}
      : { format: toContentFormat(toFileType(acquisitionLink)) }),
    ...toImages(publication.images),
    acquisition,
    ...(toWorkType(metadata['@type']) !== undefined
      ? { workType: toWorkType(metadata['@type']) as WorkType }
      : {}),
  };
}

// Handles both a standalone shelf feed (02) and a `groups[]` entry inside the
// home catalogue (01) — they are the same shape, the group just omits pagination.
export function normalizeShelf(doc: unknown): Shelf {
  const shelf = asRecord(doc, 'shelf');
  const metadata = asRecord(shelf.metadata, 'shelf metadata');
  const links = asArray(shelf.links, 'shelf links');

  const self = findLink(links, (rel) => rel === 'self');
  if (self === undefined) throw malformed('shelf has no self link');
  const next = findLink(links, (rel) => rel === 'next');
  const search = findLink(links, (rel) => rel === 'search');

  const totalItems = optNumber(metadata.numberOfItems);
  const itemsPerPage = optNumber(metadata.itemsPerPage);

  return {
    id: idFromHref(reqString(self.href, 'shelf self href')),
    title: reqString(metadata.title, 'shelf title'),
    // Absent is the zero-result case, not a malformed feed: the contract does
    // not require `publications`, and getGroupFeed says `all` never 404s.
    publications:
      shelf.publications === undefined
        ? []
        : asArray(shelf.publications, 'shelf publications').map(normalizePublication),
    ...(totalItems !== undefined ? { totalItems } : {}),
    ...(itemsPerPage !== undefined ? { itemsPerPage } : {}),
    ...(next !== undefined
      ? { nextPage: pageFromHref(reqString(next.href, 'next href')) }
      : {}),
    // Only ever sent on an empty result — "a way back to the catalogue".
    ...(shelf.navigation !== undefined
      ? { browseInstead: asArray(shelf.navigation, 'shelf navigation').map(toNavLink) }
      : {}),
    ...(search !== undefined
      ? { searchHref: reqString(search.href, 'shelf search href') }
      : {}),
  };
}

function toNavLink(doc: unknown): NavLink {
  const entry = asRecord(doc, 'navigation entry');
  const href = reqString(entry.href, 'navigation href');
  const works = isWorksHref(href);
  const { coverUrl } = entry.images !== undefined ? toImages(entry.images) : {};
  return {
    title: reqString(entry.title, 'navigation title'),
    href,
    // Precomputed so a nav tap goes straight to getShelf() without any screen
    // needing to parse a URL.
    shelfId: idFromHref(href),
    target: works ? 'works' : isShelfHref(href) ? 'shelf' : 'catalogue',
    ...(works ? { workId: idFromHref(href) } : {}),
    ...(coverUrl !== undefined ? { coverUrl } : {}),
  };
}

export function normalizeWorkFeed(doc: unknown): WorkFeed {
  const feed = asRecord(doc, 'work feed');
  const metadata = asRecord(feed.metadata, 'work feed metadata');
  const title = reqString(metadata.title, 'work feed title');

  // Cover image: check metadata.images first (OPDS 2.0 spec placement), then
  // top-level feed.images (some implementations hoist it). Silently absent when
  // neither is present — JournalScreen falls back to its placeholder.
  const imageSource = metadata.images ?? feed.images;
  const { coverUrl } = imageSource !== undefined ? toImages(imageSource) : {};
  const cover = coverUrl !== undefined ? { coverUrl } : {};

  if (feed.publications !== undefined) {
    const articles = asArray(feed.publications, 'work feed publications').map(normalizePublication);
    return { kind: 'publications', title, ...cover, articles };
  }

  const children =
    feed.navigation !== undefined
      ? asArray(feed.navigation, 'work feed navigation').map(toNavLink)
      : [];
  return { kind: 'navigation', title, ...cover, children };
}

export function normalizeCatalogue(doc: unknown): Catalogue {
  const catalogue = asRecord(doc, 'catalogue');
  const metadata = asRecord(catalogue.metadata, 'catalogue metadata');
  const links = asArray(catalogue.links, 'catalogue links');
  const search = findLink(links, (rel) => rel === 'search');

  return {
    title: reqString(metadata.title, 'catalogue title'),
    ...(optString(metadata.modified) !== undefined
      ? { modified: optString(metadata.modified) as string }
      : {}),
    // Navigation and groups are both optional: a brand-new institution may have
    // neither, which is an empty catalogue rather than a broken feed.
    navigation:
      catalogue.navigation === undefined
        ? []
        : asArray(catalogue.navigation, 'navigation').map(toNavLink),
    shelves:
      catalogue.groups === undefined
        ? []
        : asArray(catalogue.groups, 'groups').map(normalizeShelf),
    // Kept templated ('...{?query}') for the search feature to expand itself.
    ...(search !== undefined
      ? { searchHref: reqString(search.href, 'search href') }
      : {}),
  };
}

// The two keys a zero-result search may offer browse targets under.
//
// `browseInstead` is the name the B1 spec gives it; `navigation` is the OPDS
// equivalent for the same thing (a feed of places to go rather than results).
// BOTH ARE ACCEPTED because neither has been confirmed against a real response
// from wokay — the search endpoint is R3c and does not exist yet. Accepting two
// spellings of one concept is cheaper than being wrong about which one arrives,
// and the day it is confirmed this list loses an entry rather than gaining logic.
const BROWSE_INSTEAD_KEYS = ['browseInstead', 'navigation'] as const;

/**
 * OPDS search response → one page of results.
 *
 * DELIBERATELY THE MOST PERMISSIVE NORMALIZER IN THIS FILE, and for one specific
 * reason: **a missing `publications` key is not an error.** A search that matched
 * nothing legitimately comes back as a navigation feed — browse targets, no
 * results array at all — and treating that as MALFORMED_FEED would turn the most
 * ordinary outcome in the whole feature into a red error screen.
 *
 * So absence is tolerated everywhere and only CONTRADICTION is rejected: a
 * `publications` key that is not an array, or a link list that is not a list, is
 * still a broken feed and still fails loudly. Absent ≠ wrong; wrong is wrong.
 *
 * Pagination is the response's `next` href KEPT WHOLE. `normalizeShelf` above
 * parses a page index out of it and throws when there isn't one — correct for a
 * shelf listing whose paging scheme we have seen, wrong for a search endpoint
 * whose paging scheme we have not. See the note on `SearchFeed.next`.
 */
export function normalizeSearchFeed(doc: unknown): SearchFeed {
  const feed = asRecord(doc, 'search feed');

  const metadata =
    feed.metadata === undefined ? {} : asRecord(feed.metadata, 'search feed metadata');
  const links = feed.links === undefined ? [] : asArray(feed.links, 'search feed links');
  const next = findLink(links, (rel) => rel === 'next');

  const totalItems = optNumber(metadata.numberOfItems);
  const browseInstead = BROWSE_INSTEAD_KEYS.map((key) => feed[key]).find(
    (value) => value !== undefined,
  );

  return {
    publications:
      feed.publications === undefined
        ? []
        : asArray(feed.publications, 'search feed publications').map(normalizePublication),
    ...(totalItems !== undefined ? { totalItems } : {}),
    ...(next !== undefined ? { next: reqString(next.href, 'next href') } : {}),
    browseInstead:
      browseInstead === undefined
        ? []
        : asArray(browseInstead, 'browse instead').map(toNavLink),
  };
}
