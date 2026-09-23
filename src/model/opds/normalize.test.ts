// src/model/opds/normalize.test.ts
// Normalizer tests run against the REAL fixtures, not hand-written OPDS. A stub
// would only ever prove the normalizer agrees with my idea of the wire format;
// the fixtures are built from the pinned contracts in docs/contracts/, so they
// carry cases I would not have thought to invent (non-ISBN identifiers, an
// audiobook with no page count, a shelf whose title differs from its id).
//
// Hand-built documents appear below only for cases a legal feed cannot express —
// a malformed feed, or a shelf count no single institution would have.
import { resolveAccess } from '@access/resolveAccess';
import { loadContractExample } from '@model/contracts/contractExample';
import { CatalogueError } from '@model/errors';
import { normalizeCatalogue, normalizeShelf, normalizePublication } from '@model/opds/normalize';

import homeCatalogue from '@model/fixtures/OPDS-samples/01-home-catalogue.json';
import newInstitutionCatalogue from '@model/fixtures/OPDS-samples/02-home-catalogue-new-institution.json';
import shelfPage0 from '@model/fixtures/OPDS-samples/03-shelf-all-page0.json';
import publicationDetail from '@model/fixtures/OPDS-samples/07-publication-detail.json';

describe('normalizeCatalogue', () => {
  const catalogue = normalizeCatalogue(homeCatalogue);

  it('lifts the feed title and modified stamp', () => {
    expect(catalogue.title).toBe('Imperial College London Library');
    expect(catalogue.modified).toBe('2026-08-16T08:30:00Z');
  });

  it('keeps the templated search href unexpanded for the search feature', () => {
    expect(catalogue.searchHref).toBe(
      'https://api.tf/opds/v1/institutions/inst_7f3/search{?query}',
    );
  });

  it('turns navigation into data with a shelfId per entry', () => {
    expect(catalogue.navigation).toEqual([
      {
        title: 'All titles',
        href: 'https://api.tf/opds/v1/institutions/inst_7f3/groups/all',
        shelfId: 'all',
        target: 'shelf',
      },
      {
        title: 'New this month',
        href: 'https://api.tf/opds/v1/institutions/inst_7f3/groups/shelf_1',
        shelfId: 'shelf_1',
        target: 'shelf',
      },
      // A title an administrator typed. Long, and about a subject rather than a
      // content type — nothing may shorten, relabel or reorder it.
      {
        title: 'Nineteenth-century literary criticism',
        href: 'https://api.tf/opds/v1/institutions/inst_7f3/groups/shelf_2',
        shelfId: 'shelf_2',
        target: 'shelf',
      },
      {
        title: 'Audio picks',
        href: 'https://api.tf/opds/v1/institutions/inst_7f3/groups/shelf_3',
        shelfId: 'shelf_3',
        target: 'shelf',
      },
    ]);
  });

  it('normalizes each group into a shelf identified by href, not by title', () => {
    expect(catalogue.shelves.map((s) => [s.id, s.title])).toEqual([
      ['shelf_1', 'New this month'],
      // Title and id genuinely diverge, and so do the two titles for this same
      // shelf: the nav row calls it "Nineteenth-century literary criticism" while
      // its own feed calls it this. Both are correct. Render what you were given.
      ['shelf_2', 'Criticism & theory, 1800–1899'],
      ['shelf_3', 'Audio picks'],
    ]);
  });

  it('reports a home shelf total but no paging, since a preview has no next page', () => {
    const [firstShelf] = catalogue.shelves;
    expect(firstShelf.publications).toHaveLength(2);
    // Groups do carry numberOfItems...
    expect(firstShelf.totalItems).toBe(2);
    // ...but no `next` link and no itemsPerPage, so there is nothing to page to.
    expect(firstShelf.itemsPerPage).toBeUndefined();
    expect(firstShelf.nextPage).toBeUndefined();
  });

  // Range proven synthetically: a fixture can only ever show one institution's
  // choice, and the count is the administrator's (AGENTS.md L-5).
  function catalogueWithNavigation(entries: { title: string; href: string }[]) {
    return {
      metadata: { title: 'Somewhere Library' },
      links: [
        {
          rel: 'self',
          href: 'https://api.tf/opds/v1/institutions/inst_zzz/catalogue',
          type: 'application/opds+json',
        },
      ],
      navigation: entries.map((entry) => ({
        ...entry,
        type: 'application/opds+json',
        rel: 'subsection',
      })),
    };
  }

  it('keeps every navigation entry, in order, however many arrive', () => {
    const titles = [
      'All titles',
      'Nineteenth-century literary criticism',
      'Audio picks',
      'Reading lists, Michaelmas',
      'Open monographs',
      'Theses and dissertations',
      'Reference and dictionaries',
      'Recently returned',
    ];
    const entries = titles.map((title, index) => ({
      title,
      // Ids that mean nothing and are not in title order, so an implementation
      // that sorted or derived either one from the other would show up here.
      href: `https://api.tf/opds/v1/institutions/inst_zzz/groups/s${titles.length - index}`,
    }));

    const many = normalizeCatalogue(catalogueWithNavigation(entries));

    expect(many.navigation).toHaveLength(titles.length);
    expect(many.navigation.map((entry) => entry.title)).toEqual(titles);
    expect(many.navigation.map((entry) => entry.shelfId)).toEqual([
      's8', 's7', 's6', 's5', 's4', 's3', 's2', 's1',
    ]);
  });

  it('accepts a single navigation entry, the whole row for a new institution', () => {
    const one = normalizeCatalogue(
      catalogueWithNavigation([
        { title: 'All titles', href: 'https://api.tf/opds/v1/institutions/inst_zzz/groups/all' },
      ]),
    );

    expect(one.navigation.map((entry) => entry.shelfId)).toEqual(['all']);
  });

  it('reads a feed whose administrator has curated no shelves at all', () => {
    const bare = normalizeCatalogue(newInstitutionCatalogue);

    // No `groups` key. Absent is not malformed — the contract says an array with
    // nothing to put in it is omitted, and a brand new institution has none.
    expect(bare.shelves).toEqual([]);
    expect(bare.navigation).toHaveLength(1);
  });
});

describe('normalizeCatalogue journal covers', () => {
  // A journal's nav entry and its Journals-group container publication share
  // one href on the wire (both come from catalogueUrlBuilder.workUrlFor) — this
  // helper keeps that pairing explicit rather than hand-duplicating the href.
  function journalCatalogue(journals: { id: string; title: string; images?: unknown }[]) {
    const institution = 'inst_zzz';
    const workHref = (id: string) =>
      `https://api.tf/opds/v1/institutions/${institution}/works/${id}`;
    return {
      metadata: { title: 'Somewhere Library' },
      links: [
        {
          rel: 'self',
          href: `https://api.tf/opds/v1/institutions/${institution}/catalogue`,
          type: 'application/opds+json',
        },
      ],
      navigation: journals.map((journal) => ({
        rel: 'subsection',
        href: workHref(journal.id),
        type: 'application/opds+json',
        title: journal.title,
      })),
      groups: [
        {
          metadata: { title: 'Journals', numberOfItems: journals.length },
          publications: journals.map((journal) => ({
            metadata: { type: 'http://schema.org/Book', title: journal.title },
            links: [
              {
                rel: 'subsection',
                href: workHref(journal.id),
                type: 'application/opds+json',
                title: journal.title,
              },
            ],
            ...(journal.images !== undefined ? { images: journal.images } : {}),
          })),
        },
      ],
    };
  }

  it("attaches a journal's cover from the Journals group to its navigation entry", () => {
    const catalogue = normalizeCatalogue(
      journalCatalogue([
        {
          id: 'item_88200446',
          title: 'All life',
          images: [
            { href: 'https://cdn.tf/covers/all-life.jpg', type: 'image/jpeg', width: null, height: null },
          ],
        },
      ]),
    );

    expect(catalogue.navigation).toEqual([
      {
        title: 'All life',
        href: 'https://api.tf/opds/v1/institutions/inst_zzz/works/item_88200446',
        shelfId: 'item_88200446',
        target: 'works',
        workId: 'item_88200446',
        coverUrl: 'https://cdn.tf/covers/all-life.jpg',
      },
    ]);
  });

  it('leaves coverUrl undefined for a journal with no cover, whether images is null or the key is omitted', () => {
    const catalogue = normalizeCatalogue(
      journalCatalogue([
        { id: 'item_null_cover', title: 'Journal With Null Images', images: null },
        { id: 'item_no_cover', title: 'Journal With No Images Key' },
      ]),
    );

    expect(catalogue.navigation.map((entry) => entry.coverUrl)).toEqual([undefined, undefined]);
  });

  it('does not surface the Journals group as a browsable shelf', () => {
    const catalogue = normalizeCatalogue(journalCatalogue([{ id: 'item_1', title: 'A Journal' }]));

    expect(catalogue.shelves).toEqual([]);
  });

  it('does not throw for a Journals-group publication with only a subsection link (no self, no acquisition)', () => {
    expect(() =>
      normalizeCatalogue(journalCatalogue([{ id: 'item_1', title: 'A Journal' }])),
    ).not.toThrow();
  });

  it('leaves an ordinary shelf navigation entry untouched when a Journals group is also present', () => {
    const base = journalCatalogue([
      { id: 'item_1', title: 'A Journal', images: [{ href: 'https://cdn.tf/covers/a.jpg' }] },
    ]);
    const doc = {
      ...base,
      navigation: [
        {
          rel: 'subsection',
          href: 'https://api.tf/opds/v1/institutions/inst_zzz/groups/shelf_1',
          type: 'application/opds+json',
          title: 'New this month',
        },
        ...base.navigation,
      ],
    };

    const catalogue = normalizeCatalogue(doc);
    const shelfEntry = catalogue.navigation.find((entry) => entry.title === 'New this month');

    expect(shelfEntry).toEqual({
      title: 'New this month',
      href: 'https://api.tf/opds/v1/institutions/inst_zzz/groups/shelf_1',
      shelfId: 'shelf_1',
      target: 'shelf',
    });
  });
});

describe('normalizeCatalogue publications', () => {
  const catalogue = normalizeCatalogue(homeCatalogue);
  const rows = catalogue.shelves.flatMap((shelf) => shelf.publications);
  const find = (id: string) => {
    const found = rows.find((row) => row.id === id);
    if (found === undefined) throw new Error(`fixture has no ${id}`);
    return found;
  };
  const borrowable = find('item_42');
  const subscription = find('item_soc');
  const audiobook = find('item_stat');
  const openAccess = find('item_aud2');

  it('identifies a publication by its self-href tail, not its ISBN', () => {
    expect(borrowable.id).toBe('item_42');
  });

  it('flattens author objects to names and unwraps the ISBN urn', () => {
    expect(borrowable.title).toBe('Rights for Robots');
    expect(borrowable.authors).toEqual(['Joshua C. Gellers']);
    expect(borrowable.publisher).toBe('Routledge');
    expect(borrowable.subjects).toEqual(['Law', 'Technology']);
    expect(borrowable.isbn).toBe('9780367211745');
  });

  it('reads format from the acquisition link rather than the metadata type', () => {
    expect(borrowable.format).toBe('PDF');
  });

  it('carries licence inputs without interpreting them', () => {
    expect(borrowable.acquisition).toEqual({
      actionId: 'borrow',
      href: 'https://api.tf/api/v1/loans?itemId=item_42',
      licenceModel: 'ELITE',
      copiesTotal: 2,
      encryption: { algorithm: 'AES-256-GCM', originalLength: 6373752 },
      hasSearchIndex: true,
      canPersist: false,
    });
  });

  it('omits copies for a tier that has no copy limit', () => {
    // `copies` is ELITE-only; a subscription is not counted in seats.
    expect(subscription.acquisition.licenceModel).toBe('SUBSCRIPTION');
    expect(subscription.acquisition.copiesTotal).toBeUndefined();
  });

  it('maps a bare acquisition rel to acquire', () => {
    expect(audiobook.acquisition.actionId).toBe('acquire');
  });

  it('gives audio a null encryption and no search index', () => {
    expect(audiobook.format).toBe('AUDIO');
    // null, never undefined: the frozen contract defines null as "plaintext".
    expect(audiobook.acquisition.encryption).toBeNull();
    expect(audiobook.acquisition.hasSearchIndex).toBe(false);
  });

  it('leaves isbn undefined when the identifier is not an ISBN urn', () => {
    // 'urn:tf:catalogue:item_stat' is a catalogue urn — storing its tail as an
    // ISBN would be a plausible-looking lie.
    expect(audiobook.isbn).toBeUndefined();
  });

  it('gives open access an explicit tier, not an absent one', () => {
    expect(openAccess.acquisition.actionId).toBe('openAccess');
    expect(openAccess.acquisition.licenceModel).toBe('OPEN_ACCESS');
    expect(openAccess.acquisition.encryption).toBeNull();
    expect(openAccess.acquisition.canPersist).toBe(true);
  });

  it('reads the file type from indirectAcquisition, not the link type', () => {
    // Every acquisition link says 'application/json' — the href answers with JSON,
    // not with a book. A normalizer reading the link's own type would make every
    // publication in the feed an unknown format.
    expect(borrowable.format).toBe('PDF');
    expect(audiobook.format).toBe('AUDIO');
    expect(subscription.format).toBe('EPUB');
  });

  it('uses the only image as the cover and sets no thumbnail', () => {
    expect(borrowable.coverUrl).toBe('https://cdn.tf/covers/item_42.jpg');
    expect(borrowable.thumbnailUrl).toBeUndefined();
  });
});

describe('normalizeShelf', () => {
  const shelf = normalizeShelf(shelfPage0);

  it('identifies the shelf from its self href, ignoring the page query', () => {
    expect(shelf.id).toBe('all');
    expect(shelf.title).toBe('All titles');
  });

  it('carries server-reported pagination', () => {
    expect(shelf.totalItems).toBe(8);
    expect(shelf.itemsPerPage).toBe(4);
  });

  it('derives the next page index from the next link', () => {
    expect(shelf.nextPage).toBe(1);
  });

  it('normalizes every publication in the page', () => {
    expect(shelf.publications.map((p) => p.id)).toEqual([
      'item_42',
      'item_env',
      'item_stat',
      'item_soc',
    ]);
  });

  // The contract does not require `publications` on a publication feed, and
  // getGroupFeed says `all` never 404s — worst case it is a feed carrying only
  // a self link and a way back to the catalogue. So an absent array is the
  // zero-result case, not a malformed feed.
  const emptyAllShelf = {
    metadata: {
      title: 'All titles',
      numberOfItems: 0,
    },
    links: [
      {
        rel: 'self',
        href: 'https://api.tf/opds/v1/institutions/inst_zzz/groups/all',
        type: 'application/opds+json',
      },
    ],
    navigation: [
      {
        title: 'Browse the full catalogue',
        href: 'https://api.tf/opds/v1/institutions/inst_zzz/catalogue',
        type: 'application/opds+json',
        rel: 'subsection',
      },
    ],
  };

  it('treats a missing publications key as an empty shelf, not a broken one', () => {
    const shelf = normalizeShelf(emptyAllShelf);

    expect(shelf.publications).toEqual([]);
  });

  // `navigation` on a publication feed is documented as "Empty result only. A
  // way back to the catalogue." Dropping it would leave Week 3's empty state
  // with nothing to offer the reader.
  it('keeps the way back to the catalogue a zero-result feed carries', () => {
    const shelf = normalizeShelf(emptyAllShelf);

    expect(shelf.browseInstead).toEqual([
      {
        title: 'Browse the full catalogue',
        href: 'https://api.tf/opds/v1/institutions/inst_zzz/catalogue',
        shelfId: 'catalogue',
        target: 'catalogue',
      },
    ]);
  });

  // The catalogue root ('.../catalogue') is not a group wokay's getShelf
  // recognises — getGroupFeed only knows the curated shelf ids and 'all'. A
  // caller that opens this link the same way it opens a real shelf link (same
  // getShelf(institutionId, shelfId) call ShelfScreen makes for every other
  // NavLink) gets NOT_FOUND back for a link the server itself offered. `target`
  // is what lets a caller tell the two shapes apart without guessing from
  // `shelfId`'s string value, which types.ts's own NavLink doc says is opaque.
  it('marks the catalogue-root link as a catalogue target, not a shelf', () => {
    const shelf = normalizeShelf(emptyAllShelf);

    expect(shelf.browseInstead?.[0].target).toBe('catalogue');
  });

  it('marks a real group link as a shelf target', () => {
    expect(normalizeCatalogue(homeCatalogue).navigation[0].target).toBe('shelf');
  });

  it('offers no way back on a shelf that actually has results', () => {
    expect(shelf.browseInstead).toBeUndefined();
  });
});

describe('normalizePublication', () => {
  const publication = normalizePublication(publicationDetail);

  it('lifts the detail-only fields the summary lacks', () => {
    expect(publication.subtitle).toBe(
      'Artificial Intelligence, Animal and Environmental Law',
    );
    expect(publication.description).toContain('legal personhood');
    expect(publication.numberOfPages).toBe(212);
    expect(publication.language).toBe('en');
    expect(publication.published).toBe('2020-09-30');
  });

  it('picks the widest image as cover and the narrowest as thumbnail', () => {
    expect(publication.coverUrl).toBe('https://cdn.tf/covers/item_42.jpg');
    expect(publication.thumbnailUrl).toBe('https://cdn.tf/covers/item_42-thumb.jpg');
  });
});

// Q-1b (team1_README.md): resolved for ARTICLE — wokay's OpdsPublicationMapper always
// tags an ARTICLE work type as schema.org/ScholarlyArticle, agreed directly rather than
// guessed. 'journal' itself is still unmapped, because a journal is never a Publication
// in the first place (see Publication's own doc) — nothing on the wire could ever carry it.
describe('normalizePublication workType', () => {
  it('maps schema.org/ScholarlyArticle to workType "article"', () => {
    const articleDoc = {
      ...publicationDetail,
      metadata: { ...publicationDetail.metadata, '@type': 'http://schema.org/ScholarlyArticle' },
    };

    expect(normalizePublication(articleDoc).workType).toBe('article');
  });

  it('also accepts the https form of the article type', () => {
    const articleDoc = {
      ...publicationDetail,
      metadata: { ...publicationDetail.metadata, '@type': 'https://schema.org/ScholarlyArticle' },
    };

    expect(normalizePublication(articleDoc).workType).toBe('article');
  });

  it('leaves workType unmapped for a type this app has no producer for yet', () => {
    const unknownTypeDoc = {
      ...publicationDetail,
      metadata: { ...publicationDetail.metadata, '@type': 'http://schema.org/Periodical' },
    };

    expect(normalizePublication(unknownTypeDoc).workType).toBeUndefined();
  });
});

describe('normalizePublication rejects feeds it cannot honour', () => {
  it('rejects a publication with no acquisition link', () => {
    const noAcquisition = {
      metadata: { title: 'Orphan' },
      links: [
        {
          rel: 'self',
          href: 'https://api.tf/opds/v1/institutions/inst_7f3/publications/item_x',
          type: 'application/opds-publication+json',
        },
      ],
    };
    expect(() => normalizePublication(noAcquisition)).toThrow(
      expect.objectContaining({ code: CatalogueError.MALFORMED_FEED }),
    );
  });

  it('rejects a publication with no title', () => {
    const untitled = {
      metadata: {},
      links: [
        {
          rel: 'self',
          href: 'https://api.tf/opds/v1/institutions/inst_7f3/publications/item_y',
          type: 'application/opds-publication+json',
        },
        {
          rel: 'http://opds-spec.org/acquisition',
          href: 'https://api.tf/api/v1/loans?itemId=item_y',
          type: 'application/json',
          properties: {
            licenceModel: 'SUBSCRIPTION',
            indirectAcquisition: [{ type: 'application/pdf' }],
            hasSearchIndex: false,
            canPersist: true,
          },
        },
      ],
    };
    expect(() => normalizePublication(untitled)).toThrow(
      expect.objectContaining({ code: CatalogueError.MALFORMED_FEED }),
    );
  });

  it('rejects a publication with no self link, since it would have no id', () => {
    const noSelf = {
      metadata: { title: 'Anonymous' },
      links: [
        {
          rel: 'http://opds-spec.org/acquisition',
          href: 'https://api.tf/api/v1/loans?itemId=item_z',
          type: 'application/json',
          properties: {
            licenceModel: 'SUBSCRIPTION',
            indirectAcquisition: [{ type: 'application/pdf' }],
            hasSearchIndex: false,
            canPersist: true,
          },
        },
      ],
    };
    expect(() => normalizePublication(noSelf)).toThrow(
      expect.objectContaining({ code: CatalogueError.MALFORMED_FEED }),
    );
  });
});

// The file type moved to `properties.indirectAcquisition`, so every way that can
// be wrong is now a way a whole feed can fail. Each must be a MALFORMED_FEED with
// something to point at, never a crash and never a silent blank format.
describe('normalizePublication rejects a broken indirectAcquisition', () => {
  function publicationWithProperties(properties: unknown) {
    return {
      metadata: { title: 'Rights for Robots' },
      links: [
        {
          rel: 'self',
          href: 'https://api.tf/opds/v1/institutions/inst_7f3/publications/item_42',
          type: 'application/opds-publication+json',
        },
        {
          rel: 'http://opds-spec.org/acquisition/borrow',
          href: 'https://api.tf/api/v1/loans?itemId=item_42',
          type: 'application/json',
          properties,
        },
      ],
    };
  }

  const base = {
    licenceModel: 'SUBSCRIPTION',
    hasSearchIndex: false,
    canPersist: true,
  };

  const broken: [string, unknown][] = [
    ['absent', { ...base }],
    ['not an array', { ...base, indirectAcquisition: { type: 'application/pdf' } }],
    ['empty', { ...base, indirectAcquisition: [] }],
    ['an entry with no type', { ...base, indirectAcquisition: [{}] }],
    ['a media type we cannot render', { ...base, indirectAcquisition: [{ type: 'text/plain' }] }],
  ];

  for (const [what, properties] of broken) {
    it(`rejects indirectAcquisition that is ${what}`, () => {
      expect(() => normalizePublication(publicationWithProperties(properties))).toThrow(
        expect.objectContaining({ code: CatalogueError.MALFORMED_FEED }),
      );
    });
  }
});

// THE GAP THAT USED TO BE HERE IS CLOSED — 17 Aug. This block previously asserted
// that a subscribe publication was rejected, and said to replace it with the real
// behaviour once the gap closed. This is that replacement.
//
// Why it mattered: `resolveAccess` has handled the `subscribe` rel since it
// landed, but the only titles that can produce that case were being thrown out
// here, so the branch was correct and unreachable.
describe('a subscribe publication, which has no file at all', () => {
  const subscribeOnly = {
    metadata: { title: 'Rights for Robots' },
    links: [
      {
        rel: 'self',
        href: 'https://api.tf/opds/v1/public/publications/item_42',
        type: 'application/opds-publication+json',
      },
      {
        rel: 'http://opds-spec.org/acquisition/subscribe',
        href: 'https://api.tf/api/v1/institutions',
        type: 'application/json',
        title: 'Available through your institution',
        // EXACTLY what the contract sends, and nothing more — wokay-api.yaml
        // `getPublicPublication`/`searchPublic` both show a subscribe link
        // carrying only these two properties. `OpdsLinkProperties` requires
        // `licenceModel` alone, so `hasSearchIndex` and `canPersist` are absent
        // here on purpose: this fixture used to add them, which meant the block
        // below passed against a shape the server never sends.
        properties: {
          licenceModel: 'ELITE',
          availability: { state: 'unavailable' },
        },
      },
    ],
  };

  it('normalizes rather than throwing', () => {
    expect(() => normalizePublication(subscribeOnly)).not.toThrow();
  });

  it('carries the metadata it does have', () => {
    expect(normalizePublication(subscribeOnly).title).toBe('Rights for Robots');
  });

  // Absent, not a default and not a sentinel. There is no file, so there is no
  // type — and a filled-in format is how a Read button gets drawn over nothing.
  it('omits format entirely', () => {
    expect('format' in normalizePublication(subscribeOnly)).toBe(false);
  });

  it('keeps the rel, which is what resolveAccess keys the subscribe case on', () => {
    expect(normalizePublication(subscribeOnly).acquisition.actionId).toBe('subscribe');
  });

  // Same rule as `format`, and for the same reason: both describe a file, and a
  // subscribe link leads to a page. Omitted rather than defaulted to false, so
  // nothing can read a fabricated answer back as a real one.
  it('omits hasSearchIndex and canPersist, which describe a file it does not have', () => {
    const { acquisition } = normalizePublication(subscribeOnly);

    expect('hasSearchIndex' in acquisition).toBe(false);
    expect('canPersist' in acquisition).toBe(false);
  });

  // The consequence that matters: Download is appended off `canPersist`, so an
  // absent one must read as "no download" rather than throwing on the way in.
  //
  // A real session, not `null` — resolveAccess now asks Sign in first when
  // signed out (settled 7 Sep, see resolveAccess.test.ts), so a session is
  // what actually reaches the subscribe branch this test is about.
  it('resolves to a subscribe action with no Download', () => {
    const access = resolveAccess({
      item: normalizePublication(subscribeOnly),
      institutionId: 'inst_7f3',
      session: { userId: 'user_9c2', roles: [], collections: [], exp: 0 },
    });

    expect(access.actions).toEqual(['subscribe']);
  });
});

// THE SAME CASE, TAKEN STRAIGHT FROM THE CONTRACT instead of written out above.
// This is the guard the block above could not be: a hand-built document can
// drift from wokay's shape, and it had — it carried two properties the server
// never sends, so the subscribe case read as covered while the only shape that
// actually arrives still threw. Parsed from docs/contracts/wokay-api.yaml, so
// there is nothing left to keep in sync by hand.
describe("the contract's own subscribe example", () => {
  const example = loadContractExample('wokay-api.yaml', 'getPublicPublication');

  it('normalizes without throwing', () => {
    expect(() => normalizePublication(example)).not.toThrow();
  });

  it('is a subscribe title carrying none of the three file facts', () => {
    const publication = normalizePublication(example);

    expect(publication.acquisition.actionId).toBe('subscribe');
    expect('format' in publication).toBe(false);
    expect('hasSearchIndex' in publication.acquisition).toBe(false);
    expect('canPersist' in publication.acquisition).toBe(false);
  });
});

// The other half of the rule, and the more important half: absence is tolerated
// for `subscribe` ALONE. A borrowable title we cannot name a format for is a
// broken feed, and accepting it would surface later as a row that opens nothing.
it('still rejects a borrow publication with no indirectAcquisition', () => {
  const borrowNoFile = {
    metadata: { title: 'Jazz Perspectives' },
    links: [
      {
        rel: 'self',
        href: 'https://api.tf/opds/v1/public/publications/item_43',
        type: 'application/opds-publication+json',
      },
      {
        rel: 'http://opds-spec.org/acquisition/borrow',
        href: 'https://api.tf/api/v1/loans',
        type: 'application/json',
        properties: {
          licenceModel: 'ELITE',
          hasSearchIndex: false,
          canPersist: false,
        },
      },
    ],
  };

  expect(() => normalizePublication(borrowNoFile)).toThrow(
    expect.objectContaining({ code: CatalogueError.MALFORMED_FEED }),
  );
});
