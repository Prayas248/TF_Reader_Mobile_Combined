// src/adapters/CatalogueSource.ts
// The seam between the app and wherever catalogue data comes from.
//
// Screens, stores and hooks depend on THIS TYPE ONLY — never on MockAdapter or
// ApiAdapter directly, and never on the OPDS shapes behind them. `src/config/`
// picks the implementation once at startup; nothing downstream can tell which it
// got, which is what lets the whole app run on fixtures before api.tf exists.
//
// Both implementations are held to `conformance.ts`. If a method's contract
// changes, change it here and the suite will fail for both until they agree.
import type { BookId } from '@/shared/types/primitives';
import type { BatchItemsResult, Catalogue, Publication, Shelf, SortOrder, WorkFeed } from '@model/types';
import type { BrowseFilters } from '@search/browseLink';

// Everything a shelf request can narrow or order by, beyond page — an OPTIONAL
// fourth argument so every existing call site (which passes none of this)
// keeps compiling unchanged. Reuses `BrowseFilters` rather than redeclaring
// contentType/accessTier, so this seam and `browseParams` (src/search/browseLink.ts)
// cannot drift about which two dimensions a browse request carries.
export interface ShelfQuery extends BrowseFilters {
  // Accepted for every shelf, but only honoured on 'all' — see browseParams's
  // own comment. A curated shelf's adapter implementation is free to ignore it
  // rather than reject it: sending it is a no-op, not an error.
  sort?: SortOrder;
}

export interface CatalogueSource {
  // The institution's home screen: which sections exist, plus preview shelves.
  //
  // `institutionId` is a PARAMETER, not adapter state. CAP-3 lets the user switch
  // institutions at runtime, and an adapter that closed over one id would have to
  // be rebuilt on every switch — plus the same instance can then serve a
  // multi-institution cache later without changing this signature.
  //
  // Rejects CatalogueFailure(NOT_FOUND) if the institution is unknown.
  getHomeCatalogue(institutionId: string): Promise<Catalogue>;

  // One shelf/section as a paginated listing. `page` is a zero-based index, not a
  // URL: paging is the adapter's problem, so no caller ever builds an href.
  // Omitting it means the first page. `query` carries the filter/sort dimensions
  // screen 12 exposes — omitted entirely, it is "no constraint", matching the
  // shelf's own default order.
  //
  // Rejects CatalogueFailure(NOT_FOUND) if the institution or shelf is unknown.
  getShelf(institutionId: string, shelfId: string, page?: number, query?: ShelfQuery): Promise<Shelf>;

  // Full detail for one publication — richer than the summary the shelf carried
  // (subtitle, description, page count, larger imagery).
  //
  // Rejects CatalogueFailure(NOT_FOUND) if the institution or publication is
  // unknown.
  getPublication(institutionId: string, bookId: BookId): Promise<Publication>;

  // A1 — the open access catalogue, for a reader who has chosen no institution.
  //
  // TAKES NO institutionId, AND THAT IS THE POINT. Shelves belong to an
  // institution, so a reader without one has none: this is a single flat,
  // paginated list rather than a home screen, and it carries open access titles
  // only. Deliberately narrower than what public search would find — this feed
  // is what you can read right now.
  //
  // Returns `Shelf` because the wire shape IS a shelf's: one titled, paginated
  // OpdsPublicationFeed. The name is the odd part, not the type — there is no
  // second parser and no second set of paging rules to keep in step.
  getPublicFeed(page?: number): Promise<Shelf>;

  // One publication for that same reader. Separate from `getPublication` for the
  // same reason as above: there is no institution to scope it by, and falling
  // back to some default institution's copy would answer a question nobody asked.
  //
  // Rejects CatalogueFailure(NOT_FOUND) if the publication is unknown.
  getPublicPublication(bookId: BookId): Promise<Publication>;

  // F9 — turns a batch of item ids (what a loan/download record keys by) into
  // thin summaries in one call. wokay's batchGetItems.
  //
  // TAKES NO institutionId, same reasoning as getPublicFeed: the contract
  // scopes this by app token only, not by institution.
  //
  // notFound/denied are NOT failures — a batch with some bad ids still
  // resolves normally, so one bad id never fails the whole call. Only
  // rejects CatalogueFailure(TOO_MANY_IDS) if more than 100 ids are requested.
  getItemsBatch(ids: BookId[]): Promise<BatchItemsResult>;

  // Journal hierarchy — GET /opds/v1/institutions/{institutionId}/works/{workId}.
  // workId is a CatalogueItem whose workType is JOURNAL, VOLUME, or ISSUE.
  // Returns navigation children (volumes/issues) or publications (articles).
  // Rejects CatalogueFailure(NOT_FOUND) if the workId is unknown or not PUBLISHED.
  getWork(institutionId: string, workId: string): Promise<WorkFeed>;
}
