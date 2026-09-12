// src/adapters/MockAdapter.ts
// CatalogueSource backed by the frozen OPDS fixtures.
//
// This is the adapter the whole app runs on until api.tf exists, so it is held to
// the same conformance suite as ApiAdapter rather than being treated as test
// scaffolding.
//
// IT PARSES THE REAL WIRE FORMAT. The fixtures go through normalize.ts exactly as
// an HTTP response would — no hand-authored domain objects anywhere. That is the
// point: if the normalizer mishandles wokay's OPDS, this adapter surfaces it
// today instead of the day the backend lands.
import type { BookId } from '@/shared/types/primitives';
import type { BatchItemsResult, Catalogue, Publication, Shelf, SortOrder, WorkFeed } from '@model/types';
import type { DataSource, InstitutionQueryParams } from '@adapters/InstitutionSource';
import type { ShelfQuery } from '@adapters/CatalogueSource';
import { CatalogueError, CatalogueFailure } from '@model/errors';
import { normalizeCatalogue, normalizePublication, normalizeShelf } from '@model/opds/normalize';
import { MAX_BATCH_IDS, normalizeBatchItemsResponse } from '@model/batchItems';
import { type Institution, normalizeInstitutionList } from '@model/institution';
import { assertPublication } from '@model/validate';

import batchItemsFixture from '@model/fixtures/batch-items.json';
import homeCatalogueFixture from '@model/fixtures/OPDS-samples/01-home-catalogue.json';
import newInstitutionCatalogueFixture from '@model/fixtures/OPDS-samples/02-home-catalogue-new-institution.json';
import allTitlesPage0Fixture from '@model/fixtures/OPDS-samples/03-shelf-all-page0.json';
import allTitlesPage1Fixture from '@model/fixtures/OPDS-samples/04-shelf-all-page1.json';
import curatedShelfFixture from '@model/fixtures/OPDS-samples/05-shelf-curated-page0.json';
import curatedShelfAltFixture from '@model/fixtures/OPDS-samples/06-shelf-curated-alt-page0.json';
import publicationDetailFixture from '@model/fixtures/OPDS-samples/07-publication-detail.json';
import publicCataloguePage0Fixture from '@model/fixtures/OPDS-samples/08-public-catalogue-page0.json';
import publicCataloguePage1Fixture from '@model/fixtures/OPDS-samples/09-public-catalogue-page1.json';
import institutionsFixture from '@model/fixtures/institutions.json';

// Strip combining diacritical marks so "Zurich" matches "Zürich".
function fold(str: string): string {
  return str.normalize('NFD').replace(/\p{M}/gu, '');
}

// Screen 12 — filter, applied against the whole shelf before paging, the same
// order a real server has to do it in: filter decides which rows exist at
// all, page decides which slice of THOSE this response carries. Filtering
// each fixture page independently would answer a different, wrong question —
// what's left of the page that happened to load, not what matches shelf-wide.
//
// `licenceModel` read directly off the publication's own acquisition data,
// not via `resolveAccess` — this mirrors a server matching a stored field,
// not the UI computing entitlement (Design Spec §5.1 is about the latter).
function matchesShelfQuery(publications: Publication[], query: ShelfQuery | undefined): Publication[] {
  if (query === undefined) return publications;

  return publications.filter((publication) => {
    if (query.contentType !== undefined && publication.format !== query.contentType) {
      return false;
    }
    if (query.accessTier !== undefined && publication.acquisition.licenceModel !== query.accessTier) {
      return false;
    }
    return true;
  });
}

// Only ever called for the 'all' shelf — ShelfQuery.sort's own comment: sent
// for every shelf, honoured only here, a no-op elsewhere. `undefined`
// `published` sorts last on both directions rather than throwing off the
// comparator with a mixed string/undefined compare.
function sortByShelfQuery(publications: Publication[], sort: SortOrder | undefined): Publication[] {
  if (sort === undefined) return publications;

  const sorted = [...publications];
  if (sort === 'title.asc') sorted.sort((a, b) => a.title.localeCompare(b.title));
  if (sort === 'title.desc') sorted.sort((a, b) => b.title.localeCompare(a.title));
  if (sort === 'publishedAt.asc') {
    sorted.sort((a, b) => (a.published ?? '').localeCompare(b.published ?? ''));
  }
  if (sort === 'publishedAt.desc') {
    sorted.sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''));
  }
  return sorted;
}

// Two institutions have their own root feed; the rest are served the first one
// (see assertKnownInstitution). The second exists to make the nothing-curated
// case reachable without editing a file — admins configure the shelves, so an
// institution with none is a state the app must survive, not a bug.
const CATALOGUE_BY_INSTITUTION: Record<string, unknown> = {
  inst_7f3: homeCatalogueFixture,
  inst_a21: newInstitutionCatalogueFixture,
};

export interface MockAdapterOptions {
  // Artificial delay before every resolve OR reject. Defaults to 0 so the
  // conformance suite stays fast; set it in the gallery to exercise spinners.
  latencyMs?: number;
  // When set, EVERY method rejects with this code. The only way to build and
  // review error states before a real network can fail.
  failWith?: CatalogueError;
}

export class MockAdapter implements DataSource {
  private readonly latencyMs: number;
  private readonly failWith?: CatalogueError;

  constructor(options: MockAdapterOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
    this.failWith = options.failWith;
  }

  async getHomeCatalogue(institutionId: string): Promise<Catalogue> {
    await this.simulate(institutionId);
    // Every LISTED institution is served this one fixture catalogue; an id that
    // is in no fixture at all is NOT_FOUND. See assertKnownInstitution.
    this.assertKnownInstitution(institutionId);

    const fixture = CATALOGUE_BY_INSTITUTION[institutionId] ?? homeCatalogueFixture;
    const catalogue = normalizeCatalogue(fixture);
    catalogue.shelves.flatMap((shelf) => shelf.publications).forEach(assertPublication);
    return catalogue;
  }

  // `query` (contentType/accessTier/sort) is accepted, per the CatalogueSource
  // contract, but not applied: none of the fixtures have a filtered or sorted
  // variant to serve, so honouring it here would mean silently inventing
  // narrowed data ApiAdapter has no way to match. Screen 12 still exercises the
  // whole round trip against this adapter — request in, one unfiltered page
  // back — same as any other capability the fixtures do not yet model.
  async getShelf(
    institutionId: string,
    shelfId: string,
    page?: number,
    query?: ShelfQuery,
  ): Promise<Shelf> {
    await this.simulate(shelfId);
    this.assertKnownInstitution(institutionId);

    const pages = this.pagesByShelfId().get(shelfId);
    // A shelf no standalone feed fixture backs is NOT_FOUND, not an empty shelf.
    // 'shelf_3' is the deliberate case: it is advertised in navigation and has a
    // preview group, but no listing fixture — a preview is not a listing, see
    // pagesByShelfId. An empty result would read as "this shelf has no titles"
    // and quietly hide the missing fixture.
    if (pages === undefined) {
      throw new CatalogueFailure(CatalogueError.NOT_FOUND, shelfId);
    }

    // Every fixture page concatenated, filtered and (on 'all' only) sorted as
    // one shelf-wide list, THEN re-paged — see matchesShelfQuery's comment for
    // why that order matters. Unfiltered, this reproduces the fixtures' own
    // page split exactly: slicing an unchanged list by its first page's own
    // length just hands back the same pages it started as.
    const whole = pages.flatMap((shelfPage) => shelfPage.publications);
    const matching = matchesShelfQuery(whole, query);
    const ordered = shelfId === 'all' ? sortByShelfQuery(matching, query?.sort) : matching;

    // Page omitted means the first one, matching ApiAdapter: it sends no `page`
    // query param at all in that case and lets the server pick its default.
    const pageSize = pages[0].publications.length;
    const start = (page ?? 0) * pageSize;
    const slice = ordered.slice(start, start + pageSize);

    // Running off the end (of the real data, or of what a filter left behind)
    // is normal paging, not a missing shelf — an empty page, not NOT_FOUND.
    slice.forEach(assertPublication);
    return {
      id: pages[0].id,
      title: pages[0].title,
      publications: slice,
      totalItems: ordered.length,
      itemsPerPage: pageSize,
      nextPage: start + pageSize < ordered.length ? (page ?? 0) + 1 : undefined,
    };
  }

  async getPublication(institutionId: string, bookId: BookId): Promise<Publication> {
    await this.simulate(bookId);
    this.assertKnownInstitution(institutionId);

    const publication = this.publicationsById().get(bookId);
    if (publication === undefined) {
      throw new CatalogueFailure(CatalogueError.NOT_FOUND, bookId);
    }

    assertPublication(publication);
    return publication;
  }

  // A1. No institution argument and no assertKnownInstitution call — the whole
  // point of this feed is that there is no institution to check.
  async getPublicFeed(page?: number): Promise<Shelf> {
    await this.simulate('public catalogue');

    const pages = this.publicPages();
    // Page omitted means the first one, matching ApiAdapter, which sends no
    // `page` param at all in that case and lets the server pick its default.
    const feed = pages[page ?? 0];

    // Past the last page of fixture data: an empty final page rather than
    // NOT_FOUND, for the same reason getShelf does it — running off the end of a
    // listing is normal paging, not a missing feed.
    if (feed === undefined) {
      const { nextPage: _nextPage, ...lastPage } = pages[pages.length - 1];
      return { ...lastPage, publications: [] };
    }

    feed.publications.forEach(assertPublication);
    return feed;
  }

  async getPublicPublication(bookId: BookId): Promise<Publication> {
    await this.simulate(bookId);

    const publication = this.publicPublicationsById().get(bookId);
    if (publication === undefined) {
      throw new CatalogueFailure(CatalogueError.NOT_FOUND, bookId);
    }

    assertPublication(publication);
    return publication;
  }

  // F9. One canonical fixture, shaped like the contract's own batchGetItems
  // example, normalized fresh per call (same "no shared mutable state between
  // callers" rule as publicationsById()/publicPublicationsById() below) into
  // an id-keyed map plus a denied-id set. Every REQUESTED id is then bucketed
  // against those — this generalizes to any subset/superset of ids, not just
  // the fixture's own canonical request.
  async getItemsBatch(ids: BookId[]): Promise<BatchItemsResult> {
    await this.simulate('items:batch');
    if (ids.length > MAX_BATCH_IDS) {
      throw new CatalogueFailure(CatalogueError.TOO_MANY_IDS, `${ids.length} ids`);
    }

    const canonical = normalizeBatchItemsResponse(batchItemsFixture);
    const knownById = new Map(canonical.items.map((item) => [item.id, item]));
    const deniedIds = new Set(canonical.denied);

    const items: BatchItemsResult['items'] = [];
    const notFound: BookId[] = [];
    const denied: BookId[] = [];
    for (const id of ids) {
      if (deniedIds.has(id)) {
        denied.push(id);
        continue;
      }
      const item = knownById.get(id);
      if (item === undefined) {
        notFound.push(id);
        continue;
      }
      items.push(item);
    }
    return { items, notFound, denied };
  }

  async getWork(institutionId: string, workId: string): Promise<WorkFeed> {
    await this.simulate(workId);
    this.assertKnownInstitution(institutionId);
    // Mock returns a simple two-volume navigation feed for any workId so the
    // JournalScreen can be exercised without a real backend.
    return {
      kind: 'navigation',
      title: 'Mock Journal',
      children: [
        {
          title: 'Volume 01',
          href: `/opds/v1/institutions/${institutionId}/works/mock-vol-1`,
          shelfId: 'mock-vol-1',
          target: 'works',
          workId: 'mock-vol-1',
        },
        {
          title: 'Volume 02',
          href: `/opds/v1/institutions/${institutionId}/works/mock-vol-2`,
          shelfId: 'mock-vol-2',
          target: 'works',
          workId: 'mock-vol-2',
        },
      ],
    };
  }

  async getInstitutions(params?: InstitutionQueryParams): Promise<Institution[]> {
    await this.simulate('institutions');

    let results = normalizeInstitutionList(institutionsFixture);

    if (params?.institutionId !== undefined) {
      results = results.filter((i) => i.id === params.institutionId);
    }

    if (params?.q !== undefined && params.q.length > 0) {
      const needle = fold(params.q.toLowerCase());
      results = results.filter((i) => fold(i.name.toLowerCase()).includes(needle));
    }

    if (params?.country !== undefined) {
      const target = params.country.toLowerCase();
      results = results.filter((i) => i.country.toLowerCase() === target);
    }

    const size = params?.size ?? results.length;
    const page = params?.page ?? 0;
    results = results.slice(page * size, page * size + size);

    return results;
  }

  async getInstitution(institutionId: string): Promise<Institution> {
    await this.simulate(institutionId);

    const institution = normalizeInstitutionList(institutionsFixture).find(
      (candidate) => candidate.id === institutionId,
    );
    // Rejects rather than resolving undefined — called out by name in the
    // Foundation Spec's conformance requirements.
    if (institution === undefined) {
      throw new CatalogueFailure(CatalogueError.NOT_FOUND, institutionId);
    }

    return institution;
  }

  // Latency and injected failure, applied to every method in one place.
  // Latency comes FIRST so an injected failure still takes time to arrive —
  // an instant error cannot exercise the loading-then-error transition.
  private async simulate(target: string): Promise<void> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
    if (this.failWith !== undefined) {
      throw new CatalogueFailure(this.failWith, target);
    }
  }

  // An institution the fixtures have never heard of is NOT_FOUND; one that is
  // listed in institutions.json is served the single fixture catalogue.
  //
  // THE LINE IS "LISTED", NOT "HAS ITS OWN FEED". Two things pull in opposite
  // directions here and this is where they meet:
  //
  //   - CAP-3's picker offers all eight institutions, so rejecting seven of them
  //     would make the feature look broken for 7/8 of its own choices.
  //   - ApiAdapter maps a 404 to NOT_FOUND, so a mock that resolved for LITERALLY
  //     any string would no longer agree with it, and the conformance suite the
  //     two share exists precisely to stop them drifting apart.
  //
  // Keying on the institution list satisfies both: `inst_does_not_exist` is
  // rejected by both adapters, while every id a user can actually select works.
  // What it deliberately gives up is catching a caller that invents a plausible
  // id — acceptable, because the id now comes from the picker's own list rather
  // than a hardcoded constant.
  private assertKnownInstitution(institutionId: string): void {
    const listed = normalizeInstitutionList(institutionsFixture).some(
      (candidate) => candidate.id === institutionId,
    );
    if (!listed) {
      throw new CatalogueFailure(CatalogueError.NOT_FOUND, institutionId);
    }
  }

  // Standalone feed fixtures only, keyed by id, each value being ITS PAGES IN
  // ORDER — index 0 is page 0.
  //
  // Home-catalogue groups are deliberately NOT registered. A group in the home
  // feed is a PREVIEW, not the paginated document its self href returns, so
  // serving one here would fake pages out of data that has none while ApiAdapter
  // fetched the real feed for the same id. A preview-only shelf is NOT_FOUND
  // until its own listing fixture exists.
  //
  // Keyed off each fixture's own self href rather than a literal written here, so
  // the ids live in one place. idFromHref strips the `?page=`, which is how two
  // files become one shelf's two pages.
  //
  // Rebuilt per call rather than cached, so each caller gets fresh objects. A
  // shared instance handing out the same mutable arrays would let one screen's
  // edit surface in another — a bug class the real adapter could never have.
  private pagesByShelfId(): Map<string, Shelf[]> {
    const pages = new Map<string, Shelf[]>();

    const allTitles = [normalizeShelf(allTitlesPage0Fixture), normalizeShelf(allTitlesPage1Fixture)];
    pages.set(allTitles[0].id, allTitles);

    const curated = normalizeShelf(curatedShelfFixture);
    pages.set(curated.id, [curated]);

    const curatedAlt = normalizeShelf(curatedShelfAltFixture);
    pages.set(curatedAlt.id, [curatedAlt]);

    return pages;
  }

  // The public feed's pages in order — index 0 is page 0.
  //
  // Rebuilt per call for the same reason as pagesByShelfId: a shared instance
  // handing out the same mutable arrays would let one screen's edit surface in
  // another.
  private publicPages(): Shelf[] {
    return [
      normalizeShelf(publicCataloguePage0Fixture),
      normalizeShelf(publicCataloguePage1Fixture),
    ];
  }

  // The PUBLIC feed's own titles, plus one locked title reachable only by id —
  // NOT by browsing. `publicPages()` (the anonymous Catalogue tab) still lists
  // open access titles exclusively, per the ratified "the logged-out feed is
  // open-access only" decision; nothing here adds a locked card to that feed.
  //
  // An anonymous reader can open an open access title and nothing else BY
  // BROWSING. Discovery search is different: the real route
  // (/opds/v1/public/publications) does return locked titles for a reader who
  // found the id some other way (search), which is the gap this fills — the
  // same `item_42` detail already used by `publicationsById()` below, so a
  // reader who finds it via search and one who finds it once signed in land on
  // the identical detail. Still one fixture short of the real thing: a search
  // fixture that could surface *any* id here, not just this one.
  private publicPublicationsById(): Map<BookId, Publication> {
    const publications = new Map<BookId, Publication>();
    for (const page of this.publicPages()) {
      for (const publication of page.publications) {
        publications.set(publication.id, publication);
      }
    }
    const locked = normalizePublication(publicationDetailFixture);
    publications.set(locked.id, locked);
    return publications;
  }

  // Every publication the fixtures mention, detail feed preferred over summary.
  //
  // Reads the home catalogue DIRECTLY rather than only through pagesByShelfId():
  // a preview group is not a drillable listing, but its rows are still real
  // publications, and a row rendered on the home screen must open its detail
  // screen. Listing identity and publication identity are separate concerns.
  private publicationsById(): Map<BookId, Publication> {
    const publications = new Map<BookId, Publication>();
    const shelves = [
      ...normalizeCatalogue(homeCatalogueFixture).shelves,
      // Empty today: that institution has curated nothing. Included so a shelf
      // added to its feed is picked up without touching this method.
      ...normalizeCatalogue(newInstitutionCatalogueFixture).shelves,
      // Standalone feeds last: a full listing's summary is the one a drill-down
      // would have shown, and they carry titles no home preview does. Flattened
      // across pages — a title on page 2 is no less openable than one on page 0.
      ...[...this.pagesByShelfId().values()].flat(),
    ];
    for (const shelf of shelves) {
      for (const publication of shelf.publications) {
        publications.set(publication.id, publication);
      }
    }
    // Overwrites the summary: the detail feed carries subtitle, description and
    // page count that a listing omits.
    const detail = normalizePublication(publicationDetailFixture);
    publications.set(detail.id, detail);
    return publications;
  }
}
