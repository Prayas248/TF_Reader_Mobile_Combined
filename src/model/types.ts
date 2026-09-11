// src/model/types.ts
// Catalogue domain model — foundation for CAP-2 / CAP-3 (Discovery & Selection).
//
// THE CONTRACT for everything above the adapter layer. Screens, stores and the
// gallery code against these types and must never see an OPDS document: the
// nested metadata/links/properties shape and the full rel URIs stop at
// `opds/normalize.ts`. If a component ever needs to read `links[]` or match on
// 'http://opds-spec.org/acquisition/borrow', a field is missing here — add it
// here rather than leaking the wire format upward.
//
// Reuses `BookId` and `ContentFormat` from the frozen primitives rather than
// redeclaring them, so a catalogue publication and a decrypt session agree on
// identity and format by construction.
import type { BookId, ContentFormat } from '@/shared/types/primitives';

// The OPDS acquisition rel, normalized to a closed union. A union, not a
// string, so an unrecognised rel fails loudly in rels.ts instead of flowing
// onward as an arbitrary value.
//
// NOT THE BUTTON VOCABULARY, and the distinction now matters. `borrow` here is
// the wire rel — literally what wokay's feed sends, and the contract still lists
// it. It survived the 12 Aug flow change untouched even though the borrow BUTTON
// did not; see ACTION_IDS below. Two similar words, only one of them moved.
//
//   http://opds-spec.org/acquisition/borrow       → 'borrow'
//   http://opds-spec.org/acquisition              → 'acquire'
//   http://opds-spec.org/acquisition/open-access  → 'openAccess'
//   http://opds-spec.org/acquisition/subscribe    → 'subscribe'
//
// `subscribe` is the fourth rel, and it is the odd one: it leads to a page
// explaining how to get access, not to a file. So it carries no
// `indirectAcquisition`, which means no format can be derived from it.
export type AcquisitionRel = 'borrow' | 'acquire' | 'openAccess' | 'subscribe';

// The RESOLVED button vocabulary — what `AccessResult.actions` will hold once
// `src/access/resolveAccess` exists. Distinct from `AcquisitionRel` above: a
// rel says which acquisition mechanism a publication uses, this says which
// buttons to draw once session and licence state is folded in (e.g. an
// 'acquire' rel while signed out resolves to 'signIn', not 'acquire').
// Declared as a const array first, with the union derived from it, so
// validate.ts, the state gallery and ActionButton all enumerate the same
// runtime values the type is derived from — one definition, not several kept in
// sync by hand.
//
// EIGHT WORDS AS OF 16 AUG, and this is the first flow change that did not come
// free. `addToQueue` is GONE and three arrive in its place: `grantAccess`,
// `acceptOffer`, `rejectOffer`.
//
// The Elite flow it encodes: a reader holding nothing sees ONE button,
// `grantAccess`, on every surface. Tapping it either returns the offer straight
// away — nobody ahead of them — or puts them in the queue with a position and
// delivers the same offer later as a notification. Both routes end at the same
// `acceptOffer` / `rejectOffer` pair, which is the whole reason there is one
// offer surface and not two.
//
// WHY `addToQueue` HAD TO GO, and it is not just a rename. A queue position is a
// STATUS, not an action: a queued reader has nothing to do until their turn
// comes, so there is no button. Keeping `addToQueue` would have meant either a
// second button that does nothing or a Cancel dressed up as progress — one taps
// to no effect, the other silently costs the reader their place. See
// `ACCESS_STATES` below, where `queued` resolves to NO actions at all.
//
// A CONSEQUENCE FOR `ActionButtonState`: `grantAccess` needs no `doneLabel`. The
// old `addToQueue` flipped to "Added to queue" in place because the button had to
// represent its own aftermath. Here the aftermath is a different resolve
// entirely — `requires_grant` becomes `queued` or `offered` — so the bar redraws
// rather than the button relabelling. `done` may end up with no consumer at all.
//
// `subscribe` STAYS — decided 11 Aug. B2C is not cut. Tapping it resolves the
// title to read + download, if the title falls inside the reader's licence.
//
// `download` IS NOT AN ELITE ACTION — decided 13 Aug, unchanged by the 16 Aug
// flow change. Elite is read-only at every point in the sequence above: no
// offline copy after Accept, and none once a licence is held. That rule lives in
// resolveAccess and never in a component, which is exactly why `download` stays
// in this union — Open Access and Subscription both still use it.
// `play` IS NOT A SEPARATE ACCESS DECISION FROM `read` — it is the same
// entitlement ("this reader may consume this item"), worded for the medium.
// `resolveAccess` still only ever returns `read`; it has no business reading
// a `ContentFormat` (see its own header comment on staying narrow), so the
// `read`→`play` swap for an AUDIO item happens one layer up, in
// ItemDetailScreen, right before the actions reach `ActionBar`. Both ids are
// handled identically wherever a licence call is made, because they are.
export const ACTION_IDS = [
  'read',
  'play',
  'download',
  'grantAccess',
  'acceptOffer',
  'rejectOffer',
  'revokeLicence',
  'subscribe',
  'signIn',
] as const;
export type ActionId = (typeof ACTION_IDS)[number];

// The one tier vocabulary. Across wokay's whole surface the same three values
// appear in `licenceModel` in a feed, in `accessTier` on a book and in the
// `?accessTier=` filter, so there is nothing to translate.
//
// Beware flambeau's `ENTITLED_UNLIMITED` / `ENTITLED_CONCURRENT`: that is a
// different, live enum on the far side of the Java seam, not an older spelling of
// these. flambeau owns the translation — see docs/contracts/.
export const ACCESS_TIERS = ['OPEN_ACCESS', 'SUBSCRIPTION', 'ELITE'] as const;
export type AccessTier = (typeof ACCESS_TIERS)[number];

// The one sort vocabulary in the system (wokay-api.yaml `SortOrder`). Applies to
// `?sort=` on the "all" shelf only — a curated shelf ignores it, the operator's
// hand-picked order being the order. Not used by catalogue search: the search
// endpoint's own parameter list has no `sort`.
export const SORT_ORDERS = [
  'publishedAt.desc',
  'publishedAt.asc',
  'title.asc',
  'title.desc',
] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

// The subset of the OPDS `encrypted` block the catalogue legitimately knows.
//
// DELIBERATELY NARROW. `EncryptionDescriptor` in shared/contracts carries
// wrappedBek / keyId / keyFingerprint — those arrive with the download grant,
// NOT in a catalogue listing, and inventing them here would be fiction.
// `cipherLength` is likewise absent: the contract's
// `content.length === cipherLength === 12 + originalLength + 16` invariant is
// asserted at store() time, and deriving two of its three terms from a listing
// is exactly the silent drift that invariant exists to catch.
export interface CatalogueEncryption {
  // Normalized from the W3C URI in the feed ('...xmlenc11#aes256-gcm') to the
  // literal the frozen EncryptionDescriptor uses, so the two agree on sight.
  algorithm: 'AES-256-GCM';
  // PLAINTEXT byte length. Not derivable from the ciphertext without decrypting,
  // so it ships even though it looks redundant next to a download's byte count.
  originalLength: number;
}

// The single acquisition option for a publication, flattened from the OPDS
// acquisition link plus its `properties` bag.
//
// EVERY FIELD HERE IS AN INPUT TO ACCESS, NEVER A VERDICT. Design Spec §5.1:
// "the UI must never calculate access rights". `src/access/resolveAccess` is the
// only place licenceModel / copiesTotal / accessTier may be interpreted; a
// component that reads them to decide what to render has moved access logic into
// the view.
export interface Acquisition {
  actionId: AcquisitionRel;
  // Where the action is performed (loan creation, direct download). Absolute, as
  // supplied by the feed — the adapter does not rewrite hosts.
  href: string;
  // ALWAYS PRESENT, including for open access. The contract requires it on every
  // acquisition link: `rel` says how the book is obtained, `licenceModel` says
  // what to render, and one field is read rather than two.
  licenceModel: AccessTier;
  // Total copies the institution holds. Present only for ELITE.
  copiesTotal?: number;
  // null ⇒ plaintext: open access only. Not `undefined` — a missing `encrypted`
  // block is a meaningful value rather than absent data. AUDIO IS NOT
  // guaranteed plaintext any more: the backend team reversed that assumption
  // on 3 Sep 2026, so SUBSCRIPTION/ELITE audio can carry a real encryption
  // block here too, same as PDF/EPUB.
  encryption: CatalogueEncryption | null;
  // Whether a bundled search index ships with the book. Always false for AUDIO.
  //
  // OPTIONAL FOR THE SAME REASON `format` IS, and only for `subscribe`: both
  // describe a file, and a subscribe link leads to a page. `OpdsLinkProperties`
  // in wokay-api.yaml requires `licenceModel` alone, and the contract's own
  // subscribe examples carry only that plus `availability` — so demanding this
  // one rejected every real subscribe title at the boundary.
  hasSearchIndex?: boolean;
  // Whether the book may be written to device storage. false ⇒ memory-only.
  //
  // Absent for `subscribe` — see `hasSearchIndex`. Absence reads as "no
  // download", which is what `resolveAccess` already does with a falsy value,
  // and is correct: there is no file to persist.
  canPersist?: boolean;
  // STILL OPEN (CLAUDE.md Q-D), but narrower than it was: wokay do publish an
  // `accessTier` on their `/api/v1/catalogue/**` fetch surfaces, carrying the
  // same three values as `licenceModel` above. What is unsettled is whether we
  // ever read it, given the feed already answers the question. Kept optional
  // until someone decides — the feed path never populates it.
  accessTier?: string;
}

// One book or audiobook, flattened for display.
export interface Publication {
  // Stable identity, taken from the tail of the publication's `self` href
  // ('.../publications/item_42' → 'item_42'). NOT the ISBN: the backend keys by
  // itemId, and open-access titles may lack an ISBN entirely.
  id: BookId;
  // Bare ISBN, unwrapped from the 'urn:isbn:' prefix. Optional — it is a
  // display/lookup detail, never identity.
  isbn?: string;
  title: string;
  subtitle?: string;
  // Flattened from [{ name, sortAs? }]. Order preserved (it is credit order);
  // `sortAs` is dropped until something actually sorts by author.
  authors: string[];
  publisher?: string;
  language?: string;
  // Publication date as supplied by the feed ('2020-09-30'). Kept a string, not
  // a Timestamp: primitives.ts reserves Timestamp for epoch-ms client wall-time,
  // and a date-only value has no meaningful time component to invent.
  published?: string;
  subjects: string[];
  description?: string;
  numberOfPages?: number;
  // Derived from the acquisition link's mime type, not from metadata.
  //
  // OPTIONAL, AND ONLY FOR SUBSCRIBE TITLES — 17 Aug. A `subscribe` link leads to
  // a page explaining how to get access, not to a file, so it carries no
  // `indirectAcquisition` and there is no type to read. Before this these
  // publications were rejected as malformed at the adapter boundary, which meant
  // `resolveAccess`'s subscribe case was correct and unreachable: the only titles
  // that could produce it never got past normalize.
  //
  // ABSENCE MEANS "METADATA, NO FILE" AND NOTHING ELSE. It is not "unknown" and it
  // is not a default to fill in. Every other rel still throws when the type is
  // missing, because a borrowable title we cannot name a format for is a broken
  // feed and would surface later as a row that opens nothing.
  //
  // A CALLER THAT NEEDS A FORMAT SHOULD ASK FOR THE ACTION FIRST. There is no
  // Read or Download button on a subscribe title — `resolveAccess` returns
  // `requires_subscription` with `['subscribe']` — so no code path that opens a
  // file can reach a publication with no format.
  format?: ContentFormat;
  // Widest supplied image; the narrowest becomes thumbnailUrl. Both optional —
  // a publication with no cover renders a placeholder, it is not an error.
  coverUrl?: string;
  thumbnailUrl?: string;
  acquisition: Acquisition;
  // Derived from wokay's `metadata['@type']` — present when the value maps to a
  // known WorkType ('book', 'audiobook'). Optional because journal/article values
  // are Q-1b, still unanswered; callers fall back to BOOK_WORK_TYPE until the
  // contract grows the full vocabulary. The moment wokay answers, only the
  // normalizer needs updating — nothing else changes.
  workType?: WorkType;
}

// A tab/section pointer in the catalogue's navigation.
//
// NAVIGATION IS DATA, NOT CODE. Settled 16 Aug 2026 (AGENTS.md L-5): an
// administrator configures the shelves per institution, so the count, the titles
// and the ids are all theirs. The UI renders whatever array it is handed, in the
// order it arrives, and no shelf is named in a type or a branch anywhere.
export interface NavLink {
  title: string;
  href: string;
  // Tail of the href ('.../groups/shelf_2' → 'shelf_2'), so a nav tap maps
  // straight to getShelf(institutionId, shelfId) without re-parsing a URL.
  // An OPAQUE KEY: it is whatever the server put in the URL, and nothing may
  // read meaning into it.
  shelfId: string;
  // Whether `shelfId` actually names a shelf. Every entry in a catalogue's own
  // `navigation` is a real group link ('shelf'), but the zero-result "browse
  // instead" affordance (Shelf.browseInstead, SearchFeed.browseInstead) can
  // instead point at the catalogue root ('catalogue') — a link getShelf has no
  // group id for and will always 404 on. A caller opens 'shelf' via
  // getShelf(institutionId, shelfId); 'catalogue' has nothing to open by id and
  // goes to the catalogue home instead. 'works' is a journal/volume/issue drill-down
  // — opened via getWork(institutionId, workId).
  target: 'shelf' | 'catalogue' | 'works';
  // Tail of a works href ('.../works/item_88200446' → 'item_88200446'). Present
  // only when target === 'works'. Same opaque-key rule as shelfId.
  workId?: string;
  // Cover image URL, present when the feed supplies an images array on the
  // navigation entry. Optional — ContentCard shows a placeholder when absent.
  coverUrl?: string;
}

// Response from GET /works/{workId}. Two shapes depending on the work type:
//   'navigation' — Journal or Volume: children to drill into (volumes or issues)
//   'publications' — Issue: the articles inside it, same Publication shape as a shelf
// coverUrl is parsed from the feed's own metadata.images so JournalScreen can
// display the journal cover without a separate request.
export type WorkFeed =
  | { kind: 'navigation'; title: string; coverUrl?: string; children: NavLink[] }
  | { kind: 'publications'; title: string; coverUrl?: string; articles: Publication[] };

// A group of publications — one shelf/carousel on the home screen, or a full
// paginated listing when fetched on its own.
export interface Shelf {
  // Tail of the shelf's `self` href ('.../groups/shelf_2').
  //
  // IDENTITY, NOT TITLE. The two are independent in real data, and so are the two
  // titles for one shelf: a nav row and the shelf's own feed can name the same id
  // differently, and both are correct. Never key a shelf by its title.
  id: string;
  title: string;
  publications: Publication[];
  // Server-reported total across all pages. Absent on home-screen shelves,
  // which are previews rather than paginated listings.
  totalItems?: number;
  itemsPerPage?: number;
  // Next page index, derived from the presence of a `next` link. Absent ⇒ this
  // is the last page. A number rather than the raw href so callers page by
  // index and never hand-build a URL.
  nextPage?: number;
  // Where to send a reader when this shelf came back with nothing. The contract
  // does not require `publications`, and `all` never 404s — worst case it is a
  // feed carrying only a self link and a `navigation` entry back to the
  // catalogue, which is what this holds. Absent on any shelf that has results.
  //
  // Same name and shape as SearchFeed.browseInstead: one concept, one word.
  browseInstead?: NavLink[];
  // Templated search endpoint ('...{?query}'), present on top-level feeds that
  // advertise a search link (e.g. the public catalogue). Absent ⇒ not searchable.
  searchHref?: string;
}

// The institution's home catalogue: what tabs exist, plus preview shelves.
export interface Catalogue {
  title: string;
  // Feed's last-modified, ISO-8601 as supplied (wire string, not a Timestamp).
  modified?: string;
  navigation: NavLink[];
  shelves: Shelf[];
  // Templated search endpoint ('...{?query}'), kept raw for the search feature
  // to expand. Absent ⇒ this catalogue is not searchable.
  searchHref?: string;
}

// One page of catalogue search results — what `normalizeSearchFeed` produces and
// what the search pipeline (B1) hands the UI.
//
// SEARCH IS SERVER-SIDE AND ENTITLEMENT-SCOPED. Matching, tokenising and ranking
// all happen behind the search endpoint; nothing above the adapter re-orders or
// re-filters this list. "We filter, you render."
//
// THREE FIELDS THAT LOOK ALIKE AND ARE NOT:
//
//   `publications` is ALWAYS AN ARRAY HERE, even when the response omitted the
//   key entirely. A zero-result search legitimately comes back as a navigation
//   feed with no `publications` at all, and that is a valid empty state — not a
//   malformed feed. Defaulting it here is what stops every consumer having to
//   remember that.
//
//   `browseInstead` is what the server offers INSTEAD of results: somewhere to go
//   when the query matched nothing. Empty on a successful search. Reuses
//   `NavLink` because a browse target is exactly a navigation entry — same title,
//   same href, same precomputed shelfId.
//
//   `next` is the response's own `next` value, KEPT VERBATIM as an opaque string.
//   Deliberately NOT `Shelf.nextPage`: that is a page INDEX parsed out of the
//   href, which forces the client to understand the server's paging scheme and
//   throws MALFORMED_FEED on a cursor it cannot parse. A search response is
//   followed, not reconstructed — so no caller ever builds this value, and a
//   cursor-based server needs no change here. Absent ⇒ last page.
export interface SearchFeed {
  publications: Publication[];
  // Server-reported total across all pages. Absent ⇒ the server did not say.
  totalItems?: number;
  next?: string;
  browseInstead: NavLink[];
}

// What getItemsBatch (F9) returns for one requested id, from wokay's plain-JSON
// POST /catalogue/items:batch — deliberately NOT a Publication. That response is
// explicitly not OPDS and carries less than a publication detail does (no
// subtitle, description, page count, acquisition link) — a loan-record lookup
// only needs enough to draw a row; getPublication is one call away for the rest.
export interface BookSummary {
  id: BookId;
  title: string;
  authors?: string[];
  coverUrl?: string;
  isbn?: string;
  format: ContentFormat;
  accessTier: AccessTier;
  totalCopies?: number;
  hasSearchIndex: boolean;
}

// getItemsBatch's whole response. notFound/denied are ORDINARY DATA, not
// failures — one bad id in a batch must not fail the other 99.
export interface BatchItemsResult {
  items: BookSummary[];
  notFound: BookId[];
  denied: BookId[];
}

// ─────────────────────────────────────────────────────────────────────────────
// From Akriti's dcd04fe types.ts — net-new scope only. Everything below is
// additive: it does not touch OPDS normalization (rels.ts/normalize.ts) or
// re-shape Publication/Acquisition/Shelf/Catalogue above. Her ContentItem,
// AcquisitionLink/Properties, Group, CatalogueRoot, Feed, DataAdapter and the
// OPDS_REL_BY_URI/MIME_TO_CONTENT_FORMAT/SCHEMA_TYPE_TO_WORK_TYPE tables are
// deliberately NOT here — those compete with code already built and tested in
// this branch and need a real conversation with her before merging.
// ─────────────────────────────────────────────────────────────────────────────

// OURS. The *work* type, which decides whether we render article detail
// (screen 04) or book detail (screen 05). `@type` is OFFICIAL — confirmed
// 11 Aug. 'book' and 'audiobook' are confirmed values; journal and article are
// still to come (Q-1b).
export const WORK_TYPES = ['book', 'journal', 'article', 'audiobook'] as const;
export type WorkType = (typeof WORK_TYPES)[number];

// OURS. A UI state, not a wokay field — one value per distinct thing the action
// bar can render, so a state with no visible difference does not belong here.
//
// REBUILT AGAIN for the 16 Aug Elite flow. Three states carry the Elite sequence
// and they are in the order a reader meets them:
//
//   `requires_grant` — holding nothing, not queued. Resolves to `grantAccess`.
//   `queued`         — in the queue, waiting, others ahead. Resolves to NO
//                      actions; `queuePosition` on the result is what renders.
//   `offered`        — a copy is being offered right now. Resolves to
//                      `acceptOffer` + `rejectOffer`. Reached two ways — straight
//                      back from the tap when nobody was ahead, or later by
//                      notification — and IDENTICAL either way, which is what
//                      lets one surface serve both.
//
// `requires_queue` is gone: it named the button we no longer draw. `no_seats`
// stays deleted, and the 16 Aug change did not bring it back — see `Availability`
// below for why a seat count still decides nothing.
//
// `queued` IS THE UNUSUAL ONE, and it is deliberate: it is the only state that
// resolves to an empty `actions` array while still being something to look at.
// `not_entitled` also resolves empty but renders literally nothing. So the two
// are distinguishable here even though `actions` cannot tell them apart — which
// is precisely why `state` exists alongside `actions` rather than being derived
// from it.
//
// `available` covers two shapes rather than one, because the difference is in
// `actions` and not here: Open Access and Subscription resolve to
// read + download, Elite-with-a-licence to read + revokeLicence.
// `requires_subscription` is the `subscribe` rel's home — a title the caller
// cannot obtain, which wokay hands over with a route to access rather than a file.
// It is NOT `not_entitled`: one renders a Subscribe button and the other renders
// nothing, and a state whose bar looks different is a state of its own.
export const ACCESS_STATES = [
  'available',
  'requires_signin',
  'requires_subscription',
  'requires_grant',
  'queued',
  'offered',
  'not_entitled',
] as const;
export type AccessState = (typeof ACCESS_STATES)[number];

// BOTH BACKENDS' enumerated failure reasons, not just wokay's — the comment here
// used to say wokay and the list was short by nine as a result. ErrorState copy is
// keyed on these, and that copy is Moktik's D14 rather than this file's business:
// what lives here is only the vocabulary.
//
// KEYED ON `code`, NEVER ON HTTP STATUS. The two contracts already disagree once —
// `DOWNLOAD_NOT_PERMITTED` is 403 in wokay's document and 422 in flambeau's — and
// keying on the code costs us nothing when they do.
//
// WHAT IS DELIBERATELY ABSENT: wokay's `CODE_TAKEN` and `STALE_VERSION`. Both are
// admin-surface codes from the publisher and collection endpoints, which team1
// never calls, and a code we cannot receive is one nobody should be writing copy
// for.
export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'FORBIDDEN_INSTITUTION_MISMATCH',
  'NO_ENTITLEMENT',
  'ENTITLEMENT_EXPIRED',
  'ENTITLEMENT_SUSPENDED',
  'CONTENT_NOT_READY',
  'DOWNLOAD_NOT_PERMITTED',
  'INVALID_DEVICE_PUBLIC_KEY',
  'NOT_FOUND',
  // ── the licence calls ──────────────────────────────────────────────────────
  //
  // FIVE OF THESE ARE NEW WITH flambeau's CONTRACT and still need ratifying at
  // the Contracts Gate: NO_COPIES_AVAILABLE, NO_ACTIVE_LOAN, LOAN_NOT_ACTIVE,
  // DEVICE_LIMIT_REACHED, OFFER_EXPIRED. They go in now because the offer store
  // has to key on one of them this week, and a code absent from the union is a
  // code no error state can name.
  //
  // `OFFER_EXPIRED` IS AN ORDINARY REPLY, NOT AN ERROR STATE. flambeau are
  // explicit: "the ordinary failure, not an exceptional one" — offers lapse on a
  // schedule and the app is often a few seconds behind. It needs its own sentence
  // saying the window closed AND that the reader is now at the back of the queue,
  // because that second half is the part they will not guess.
  'NO_COPIES_AVAILABLE',
  'NO_ACTIVE_LOAN',
  'LOAN_NOT_ACTIVE',
  'DEVICE_LIMIT_REACHED',
  'OFFER_EXPIRED',
  // ── in both contracts, missing from ours ───────────────────────────────────
  'VALIDATION_FAILED',
  'FORBIDDEN_SCOPE',
  'INSTITUTION_INACTIVE',
  // wokay's `items:batch` refusing more than 100 ids. Prayas's get-many-books
  // call, which is Week 3 — but the code is receivable and costs one line.
  'TOO_MANY_IDS',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

// From `GET /api/v1/institutions` (list) and `/{id}` (detail). Both
// UNAUTHENTICATED, which is what the pre-sign-in flow needs. Only ACTIVE
// institutions appear; an inactive one is 404, not 403, so its existence is
// not disclosed.
//
// ⚠ No sample for this shape yet — hand-written from wokay's field names and
// the one part of this file still unverified against a fixture.
export interface Institution {
  id: string;
  code: string;
  name: string;
  // e.g. 'UNIVERSITY'
  type: string;
  country: string;
  city?: string;
  // Was `crestUrl`. May be absent — InstitutionRow initials fallback.
  logoUrl?: string;
  // `primaryColor` is per-institution and our token palette is fixed. DECIDED:
  // we do NOT theme per institution in the prototype — carried and
  // deliberately unused, so adopting it later is additive.
  branding?: { logoUrl?: string; primaryColor?: string };
  // Detail only. `method` is always SAML; stays in the payload so the client
  // needs no special case. `idpHint` is what we hand to flambeau.
  signIn?: { method: 'SAML'; idpHint: string };
  // Detail only. Handed to us so we never build wokay's URLs.
  catalogueUrl?: string;
}

// Issued by flambeau, `aud: 'tf-app'`. There is no service audience.
export interface Session {
  userId: string;
  institutionId?: string;
  roles: string[];
  collections: string[];
  exp: number;
  // RETAINED — decided 11 Aug. Individual (B2C) subscribers are not cut;
  // `subscribe` stays in `ActionId`, and the session payload is not settled to
  // `{ userId, institutionId, roles, exp }` because of it.
  type?: 'b2b' | 'b2c';
}

// Per-user, per-item, mutable. Never a property of the feed. Written for
// SUBSCRIPTION and ELITE. Never for OPEN_ACCESS.
//
// AN INPUT TO resolveAccess, and on the two unlimited tiers it is the only one
// that matters: held or not held. `state: 'none'` and a Loan that was never
// fetched are the same answer as far as the resolve is concerned, which is why
// there is no fourth `'unknown'` value — a resolve that cannot be trusted is the
// ActionBar's `error` state, not a licence state.
export interface Loan {
  // flambeau's id for this loan, and the ONLY thing that can revoke it:
  // `POST /api/v1/loans/{loanId}/return` takes it as a path parameter, on an
  // endpoint marked FROZEN. There is no item-keyed return.
  //
  // THIS QUALIFIES `LicenceRef`'s "deliberately not a loan id" below. That
  // reasoning is right about which calls are *addressed* by the triple — borrow
  // and open-a-reading-session are — but return is not one of them, so refusing
  // to carry the id is what makes a Revoke button unfireable. Carried here, on
  // the loan itself, rather than threaded through components.
  //
  // OPTIONAL BECAUSE `state: 'none'` MEANS ABSENCE. flambeau never sends a loan
  // with no id; `'none'` is our own sentinel for "nothing held", and nothing
  // held has no id to name. The invariant that matters is narrower: whenever
  // `state` is `'active'`, this is present, because that is the only state whose
  // resolve offers `revokeLicence`. A discriminated union would say so to the
  // compiler; it would also rewrite every fixture, so it is a candidate for
  // later rather than a thing to do while unblocking Task 1.
  loanId?: string;
  itemId: string;
  // Maps flambeau's `LoanStatus` plus one value of our own.
  //
  //   'none'      no loan at all — OURS, not theirs. A loan that was never fetched
  //               and a reader who holds nothing are the same answer to a resolve.
  //   'active'    ACTIVE
  //   'returned'  RETURNED — the reader closed it
  //   'expired'   EXPIRED — the sweep closed it at its due date
  //
  // `'returned'` AND `'expired'` ARE BOTH OVER AND STILL NOT THE SAME, which is why
  // there are two — 17 Aug. flambeau: "EXPIRED is a loan the sweep closed at its due
  // date; RETURNED is one the reader closed. Both are over, and the app shows them
  // differently." Collapsing them here would throw that away at the boundary and
  // leave the Library screen unable to tell "you returned this" from "this ran out",
  // which is the same mistake as dropping `serverTime`.
  //
  // NOTHING IN `resolveAccess` CHANGES. It tests `state === 'active'` and everything
  // else falls through to the same place, so this is information kept for the screens
  // rather than a new branch in the access table.
  state: 'none' | 'active' | 'returned' | 'expired';
  expiresAt?: number;
}

// The reader's place in the queue for one Elite title. Per-user, per-item, and
// flambeau's data rather than ours — never a property of the feed.
//
// THE SECOND INPUT TO THE ELITE BRANCH, added 16 Aug. Loan-plus-hold is the whole
// of the Elite decision, and this is the half that separates the three states a
// reader without a copy can be in:
//
//   'none'    → nothing asked for yet          → grantAccess
//   'queued'  → waiting, others ahead          → no actions, render `position`
//   'offered' → a copy is theirs to take now   → acceptOffer + rejectOffer
//
// WHY THIS AND NOT A SEAT COUNT. It would be tempting to ask "are copies free?"
// and branch on the answer. That is a second network call before anything can be
// drawn, and it would make an Elite row resolve differently on a list than on a
// detail screen. The empty-queue and busy-queue cases differ only in WHICH of
// these three values comes back, so the seat count is never needed to pick a
// button. See `Availability` below.
export interface Hold {
  // flambeau's id for this hold, and what Accept and Reject are addressed to:
  // `POST /api/v1/holds/{holdId}/accept` takes it as a path parameter. Same
  // argument as `Loan.loanId` above, and optional for the same reason — a
  // `state: 'none'` hold is absence and names nothing. Present whenever `state`
  // is `'queued'` or `'offered'`.
  //
  // NOTE THE STABILITY DIFFERENCE: the hold endpoints are `x-stability: DRAFT`
  // where the loan ones are FROZEN, so this field rests on a shape flambeau may
  // still change. Worth a heads-up to them rather than a guard here.
  holdId?: string;
  // flambeau's id for the OFFER, which is not the same identity as the hold.
  //
  // WHY BOTH. `holdId` is stable from the moment a reader joins the queue and
  // survives queued → offered → lapsed, so it cannot tell two successive offers
  // apart. The rule that the offer store must not let a second offer silently
  // replace a first one is therefore unenforceable on `holdId` alone: the same
  // hold legitimately produces offer after offer. This is what makes "is this the
  // offer I am already holding?" answerable.
  //
  // NOT WHAT ACCEPT AND REJECT ARE ADDRESSED TO — those take `holdId` in the
  // path. This is for identity, not for calls. Present only while state is
  // 'offered'.
  offerId?: string;
  itemId: string;
  // 'expired' IS A REAL STATE AND NOT A TIDY-UP. An offer that lapses does not
  // return the reader to their old place — flambeau: "the hold is gone rather
  // than restored to its old position: a reader who missed their turn rejoins at
  // the back". So a lapsed offer is behaviourally the same as never having asked,
  // which is why it resolves to `requires_grant` and not to `queued`. It is kept
  // distinct from 'none' anyway, because the two are the same ACTION and a very
  // different thing to say to the reader, and only the store can tell them apart.
  //
  // NOTHING DERIVES THIS FROM A CLOCK INSIDE resolveAccess. See `isOfferLapsed`
  // in src/access — the resolve stays pure and is handed the answer.
  state: 'none' | 'queued' | 'offered' | 'expired';
  // The reader's place, 1-based. Present when state is 'queued' — it is the whole
  // of what a waiting reader is shown. Absent when 'offered', because their turn
  // has arrived and a position is no longer a fact about them.
  position?: number;
  // How many are waiting in total, for context beside `position`. Informational:
  // nothing in `actions` reads it.
  queueLength?: number;
  // When an offer stops standing. ISO-8601 as supplied, and ABSOLUTE rather than
  // a duration — the countdown is rendered against the server's clock, never the
  // device's, because a device clock that is wrong turns a live offer into an
  // expired one on screen. Present when state is 'offered'.
  offerExpiresAt?: string;
  // The server's clock as at the response that carried this hold, ISO-8601.
  //
  // THE OTHER HALF OF `offerExpiresAt`, and without it that field's rule cannot
  // be honoured. An absolute expiry on its own only yields a countdown when
  // something subtracts a now from it, and the only now available to a component
  // is `Date.now()` — the device clock the comment above forbids. flambeau send
  // this on every loan and hold response and mark it required; we were dropping
  // it at this boundary, so the rule was unfollowable rather than unfollowed.
  //
  // NOT A CLOCK, AND IT GOES STALE. It is the instant the response was written,
  // so a countdown driven off it must add the elapsed time since the response
  // arrived. That belongs in the offer store, which knows when it fetched.
  serverTime?: string;
}

// Why one entry on the change feed (`GET /api/v1/loans/changes`) happened. flambeau's
// contract lists eight; D16 only ever reads `HOLD_PROMOTED` off this today — the queue
// offer poll is the one thing that needs the feed so far. The other seven are declared
// so a `ChangeEntry.reason` from the wire is a value in this union rather than an
// unchecked string, not because anything here reacts to them yet.
export type ChangeReason =
  | 'LOAN_CREATED'
  | 'LOAN_RETURNED'
  | 'LOAN_EXPIRED'
  | 'HOLD_PLACED'
  | 'HOLD_CANCELLED'
  | 'HOLD_PROMOTED'
  | 'HOLD_OFFER_EXPIRED'
  | 'ENTITLEMENT_REVOKED';

// One row of the change feed. `holdId`/`loanId` are each present only for the reasons
// that name a hold or a loan — a `HOLD_PROMOTED` entry carries `holdId`, never `loanId`.
//
// NO OFFER DETAIL HERE. flambeau's `ChangeEntry` schema does not carry `offerId` or an
// expiry — only that a hold changed, and which one. So `HOLD_PROMOTED` is a trigger to
// go read the real offer (`getLibrary`), never a `Hold` by itself; see the poll in
// `src/features/queue`.
export interface ChangeEntry {
  sequence: number;
  reason: ChangeReason;
  itemId: string;
  loanId?: string;
  holdId?: string;
  occurredAt: string;
}

// A page of the change feed, oldest first. Same shape-of-a-response pattern as
// `Library` above: a cursor for the next call and the server's clock alongside the
// data, never the device's.
export interface Changes {
  changes: ChangeEntry[];
  // Opaque — flambeau's own instruction is not to parse or construct one, only to hand
  // it back as the next call's `since`.
  nextCursor: string;
  // True when this page did not reach the end of the feed. The poll in
  // `src/features/queue` does not currently loop on this — a 60-second cadence catches
  // up on the next tick regardless — but it is read rather than discarded so that is a
  // choice, not an oversight.
  hasMore: boolean;
  serverTime: string;
}

// The three things that identify one reader's relationship to one title, which is
// what every licence-bearing call takes — DECIDED 16 Aug, and it is deliberately
// not a loan id.
//
// WHY NOT A LOAN ID. Revoking needs to name the thing being handed back, and the
// obvious candidate is the loan's own id. But that id only exists after a
// borrow has succeeded, so a component holding an `AccessResult` would have to
// carry it around and thread it through, and the one place it went missing would
// be a Revoke button that cannot fire. This triple is knowable from the session
// and the item at every point in the flow, including before anything is held.
//
// `institutionId` IS PART OF IDENTITY, not context. The same title resolves
// differently for two institutions, so a call that omits it is ambiguous even
// when it happens to work.
// A CACHE KEY, NOT A REQUEST PAYLOAD — corrected 17 Aug. The comment above is about
// identity, and it is right about that; what it got wrong is where this shape belongs.
//
// NOTHING SENDS THIS. flambeau's `BorrowRequest` and `HoldRequest` each declare exactly
// one property, `itemId`, and `required: [itemId]`. There is no field to put a user or an
// institution in, so passing them would not be redundant — it would be an unknown field.
// Identity arrives as the authenticated principal off the token: "there is nothing here
// for a caller to assert about itself."
//
// SO WHAT IS IT FOR. Keying anything that remembers a resolve. The same publication
// resolves differently for two institutions, so a cache keyed on `itemId` alone hands a
// reader who switched institution the buttons from the previous one. That is a real need
// and this is the right shape for it — see `AccessResult`, which carries the same two ids
// for the same reason.
//
// The calls take a `BookId`. Earlier drafts of the licence layer took this, on the
// strength of the sentence in `resolveAccess.ts` about the four calls being "keyed by
// `LicenceRef`" — which described the cache and got read as describing the wire.
export interface LicenceRef {
  userId: string;
  itemId: string;
  // OPTIONAL, because an individual subscriber has no institution — 17 Aug. flambeau omit
  // it rather than sending null, and their reasoning is worth keeping: an individual
  // "belongs to no institution, which is emphatically not 'every institution', and
  // `institutionId: null` reads to a consumer as 'belongs to one whose id we lost'."
  //
  // `Session.institutionId` has been optional all along, so this was the half of the pair
  // that could not describe a B2C reader. B2C is not cut — decided 11 Aug.
  institutionId?: string;
}

// Elite only, detail screen only. `GET /api/v1/items/{itemId}/availability` on
// flambeau — the app asks, wokay never do.
//
// STILL NOT AN INPUT TO resolveAccess — 13 Aug, and the 16 Aug flow change did not
// reinstate it. Every field here is informational: something to print beside the
// buttons, never something that picks one. That is what keeps an Elite row
// resolving identically on a list and on a detail screen, and it is the reason a
// list of forty cards costs zero extra requests.
//
// `queuePosition` USED TO LIVE HERE and has moved to `Hold.position`, which is
// where it belongs: a position is a fact about one reader's hold, not about the
// title's supply. Nothing should read a position from this shape.
export interface Availability {
  itemId: string;
  total: number;
  // OPTIONAL, and absent is not zero. Absent means "we do not know" — an
  // unlimited title has no number to report, and neither does one flambeau cannot
  // account for. Zero means every copy is genuinely out. Collapsing the two
  // renders "none free" over a title that is fine, so test for presence.
  available?: number;
  // How many are waiting. Absent for the same reasons as `available`.
  queueLength?: number;
}

// REST pagination, used ONLY by the institutions endpoint — a different model
// from the OPDS `nextPage` pagination on `Shelf` above.
export interface PagedList<T> {
  items: T[];
  page: number;
  size: number;
  total: number;
}

// The resolved badge + buttons for one publication — the single output of
// `src/access/resolveAccess`, and the only access-shaped thing a component ever
// receives.
//
// IT CARRIES ITS OWN IDENTITY, and the institution half is the point — 16 Aug.
// The same publication resolves differently for two institutions, so a result
// that names only the item is ambiguous. Anything that memoises a resolve keys on
// BOTH ids; keying on `itemId` alone is how a reader who switches institution
// keeps the buttons from the previous one.
//
// That is not a licence to store it. Resolved access lives nowhere and is
// recomputed per render — a cached result is how a stale button outlives the
// licence it was drawn from. The ids are here so that a key can be DERIVED
// correctly wherever one is unavoidable, not to make caching it safe.
//
// EVERYTHING A COMPONENT NEEDS IS ON THIS OBJECT. `queuePosition` and
// `offerExpiresAt` are copied out of the `Hold` rather than left there, so no
// screen ever reads a hold, a loan or a `licenceModel` to work out what to show.
// A component that reaches past this shape has moved access logic into the view
// (Design Spec §5.1).
export interface AccessResult {
  // Which institution this resolve was performed for. Part of the identity, not
  // context — see above.
  //
  // `null` IS A REAL VALUE, not missing data: it is the public open-access path,
  // where the reader has chosen no institution at all. Explicitly nullable rather
  // than optional so that anything deriving a cache key has to spell out the
  // no-institution case instead of quietly falling back to keying on the item.
  institutionId: string | null;
  itemId: string;
  // A badge label. Not an input to `actions`.
  tier: AccessTier;
  state: AccessState;
  // In the order they should be drawn. `[]` is a legitimate answer and appears in
  // two distinct states: `not_entitled`, which renders nothing at all, and
  // `queued`, which renders `queuePosition` and no buttons.
  actions: ActionId[];
  // The reader's place in the queue, 1-based. Present only when state is
  // `queued` — this is the whole of what a waiting reader is shown.
  queuePosition?: number;
  // How many are waiting in total, for context beside `queuePosition`. Optional
  // because it is a nicety and the position is not.
  queueLength?: number;
  // When the offer stops standing, ISO-8601 and absolute. Present only when state
  // is `offered`. Rendered against the server's clock, never the device's.
  offerExpiresAt?: string;
  // The server's clock as at the response the offer came from, ISO-8601, copied
  // out of the `Hold` alongside `offerExpiresAt`. Present only when state is
  // `offered`.
  //
  // HERE BECAUSE THE LINE ABOVE PROMISES IT. "Rendered against the server's
  // clock" is not something a component can do while the only now it can reach
  // is its own; shipping the expiry without the reference instant is what turns
  // that rule into a `Date.now()` call. See `Hold.serverTime` for why it is a
  // stale instant rather than a clock.
  serverTime?: string;
}

// wokay's error envelope, on every non-2xx. `code` is what ErrorState renders
// copy from.
//
// ⚠ No sample for this shape yet.
export interface ApiError {
  timestamp: string;
  status: number;
  code: ErrorCode;
  message: string;
  path: string;
  traceId: string;
}
