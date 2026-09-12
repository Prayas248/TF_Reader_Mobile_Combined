// src/model/detail.test.ts
//
// `buildItemDetail` only copies, so the tests that matter are the ones about what
// it DOES NOT copy. A mapper that quietly widened — pulling `acquisition` across,
// or flattening `access.tier` up to the top level — would still pass every
// present-tense assertion while undoing the reason the model exists.
//
// `subjects` moved from "deliberately excluded" to "shared" once screen 04's
// article view grew a real Subjects section (the journal-UI redesign) — it is
// no longer an example of unwanted widening, see the "stays narrow" tests below.
//
// Builders rather than shared literals, so no test can mutate another's fixture
// and none depends on a field it did not set itself — same approach as
// resolveAccess.test.ts.
import { buildItemDetail } from '@model/detail';
import type { AccessResult, Acquisition, Publication } from '@model/types';

const anAcquisition = (over: Partial<Acquisition> = {}): Acquisition => ({
  actionId: 'borrow',
  href: 'https://flambeau.test/api/v1/loans',
  licenceModel: 'SUBSCRIPTION',
  encryption: null,
  hasSearchIndex: false,
  canPersist: true,
  ...over,
});

// Every optional field populated, so a mapper that drops one is caught.
const aPublication = (over: Partial<Publication> = {}): Publication => ({
  id: 'item_42',
  isbn: '9780367211745',
  title: 'Rights for Robots',
  subtitle: 'Artificial Intelligence, Animal and Environmental Law',
  authors: ['Joshua C. Gellers'],
  publisher: 'Routledge',
  language: 'en',
  published: '2020-09-30',
  subjects: ['Law', 'Technology'],
  description: 'A study of legal personhood.',
  numberOfPages: 212,
  format: 'PDF',
  coverUrl: 'https://cdn.tf/covers/item_42.jpg',
  thumbnailUrl: 'https://cdn.tf/thumbs/item_42.jpg',
  acquisition: anAcquisition(),
  ...over,
});

const anAccessResult = (over: Partial<AccessResult> = {}): AccessResult => ({
  institutionId: 'inst_7f3',
  itemId: 'item_42',
  tier: 'SUBSCRIPTION',
  state: 'available',
  actions: ['read', 'download'],
  ...over,
});

describe('buildItemDetail copies the shared fields', () => {
  it('carries every shared field across from the publication', () => {
    const publication = aPublication();
    const access = anAccessResult();

    expect(buildItemDetail({ publication, workType: 'book', access })).toEqual({
      id: 'item_42',
      workType: 'book',
      title: 'Rights for Robots',
      subtitle: 'Artificial Intelligence, Animal and Environmental Law',
      authors: ['Joshua C. Gellers'],
      coverUrl: 'https://cdn.tf/covers/item_42.jpg',
      published: '2020-09-30',
      publisher: 'Routledge',
      isbn: '9780367211745',
      numberOfPages: 212,
      format: 'PDF',
      description: 'A study of legal personhood.',
      subjects: ['Law', 'Technology'],
      access,
    });
  });

  it('keeps the work type it was given', () => {
    const detail = buildItemDetail({
      publication: aPublication(),
      workType: 'article',
      access: anAccessResult(),
    });

    expect(detail.workType).toBe('article');
  });

  // The two screens differ by work type, so the model has to carry a value that
  // nothing in the feed produces yet without altering it.
  it('does not second-guess the work type against the publication', () => {
    const detail = buildItemDetail({
      publication: aPublication({ numberOfPages: 212, isbn: '9780367211745' }),
      workType: 'audiobook',
      access: anAccessResult(),
    });

    expect(detail.workType).toBe('audiobook');
  });

  it('carries the access result through unchanged', () => {
    const access = anAccessResult({
      state: 'offered',
      actions: ['acceptOffer', 'rejectOffer'],
      offerExpiresAt: '2026-08-17T10:10:00Z',
    });

    const detail = buildItemDetail({
      publication: aPublication(),
      workType: 'book',
      access,
    });

    // The same object, not a copy: one place a screen reads access from.
    expect(detail.access).toBe(access);
  });
});

describe('buildItemDetail with fields missing', () => {
  // "Render whatever fields are present; leave gaps blank rather than blocking."
  // Metadata is frequently incomplete, so the sparse case is normal, not an edge.
  it('leaves every optional field undefined when the publication has none', () => {
    const publication = aPublication({
      isbn: undefined,
      subtitle: undefined,
      publisher: undefined,
      published: undefined,
      description: undefined,
      numberOfPages: undefined,
      coverUrl: undefined,
      format: undefined,
    });

    const detail = buildItemDetail({
      publication,
      workType: 'article',
      access: anAccessResult(),
    });

    expect(detail.isbn).toBeUndefined();
    expect(detail.subtitle).toBeUndefined();
    expect(detail.publisher).toBeUndefined();
    expect(detail.published).toBeUndefined();
    expect(detail.description).toBeUndefined();
    expect(detail.numberOfPages).toBeUndefined();
    expect(detail.coverUrl).toBeUndefined();
    expect(detail.format).toBeUndefined();
  });

  it('still carries the required fields when the optional ones are gone', () => {
    const detail = buildItemDetail({
      publication: aPublication({ isbn: undefined, coverUrl: undefined }),
      workType: 'article',
      access: anAccessResult(),
    });

    expect(detail.id).toBe('item_42');
    expect(detail.title).toBe('Rights for Robots');
    expect(detail.authors).toEqual(['Joshua C. Gellers']);
  });

  it('keeps an empty author list empty rather than inventing one', () => {
    const detail = buildItemDetail({
      publication: aPublication({ authors: [] }),
      workType: 'book',
      access: anAccessResult(),
    });

    expect(detail.authors).toEqual([]);
  });

  // Publication.subjects is required by the real contract, but a handful of
  // existing tests build a Publication through an unsafe cast that skips it —
  // buildItemDetail must not crash on the resulting `undefined` at runtime.
  it('defaults subjects to an empty array when the publication has none', () => {
    const publication = { ...aPublication(), subjects: undefined } as unknown as Publication;

    const detail = buildItemDetail({ publication, workType: 'article', access: anAccessResult() });

    expect(detail.subjects).toEqual([]);
  });
});

// The tests with teeth. The model is a narrowing, and a narrowing that quietly
// widens is worth nothing.
describe('buildItemDetail stays narrow', () => {
  it('carries exactly the shared fields and no others', () => {
    const detail = buildItemDetail({
      publication: aPublication(),
      workType: 'book',
      access: anAccessResult(),
    });

    expect(Object.keys(detail).sort()).toEqual(
      [
        'access',
        'authors',
        'coverUrl',
        'description',
        'format',
        'id',
        'isbn',
        'numberOfPages',
        'published',
        'publisher',
        'subjects',
        'subtitle',
        'title',
        'workType',
      ].sort(),
    );
  });

  // `acquisition` and `language` are on Publication and deliberately left off
  // the shared model: both belong to the adapter and to resolveAccess rather
  // than to a screen. `format`/`subjects` USED to be on this list — screen 05's
  // format display strip and screen 04's Subjects section are real callers now,
  // so both moved to the model proper (see the top-level "carries every shared
  // field" test).
  it('does not copy publication fields the detail screens do not show', () => {
    const keys = Object.keys(
      buildItemDetail({
        publication: aPublication(),
        workType: 'book',
        access: anAccessResult(),
      }),
    );

    expect(keys).not.toContain('acquisition');
    expect(keys).not.toContain('language');
    expect(keys).not.toContain('thumbnailUrl');
  });

  // Flattening any of these upward would give a screen two places to read the
  // same fact from, and the copy would go stale the moment a resolve changed.
  it('does not flatten access fields onto the top level', () => {
    const detail = buildItemDetail({
      publication: aPublication(),
      workType: 'book',
      access: anAccessResult({ state: 'queued', actions: [], queuePosition: 3 }),
    });
    const keys = Object.keys(detail);

    expect(keys).not.toContain('tier');
    expect(keys).not.toContain('state');
    expect(keys).not.toContain('actions');
    expect(keys).not.toContain('queuePosition');
    expect(keys).not.toContain('itemId');

    // Still reachable where it belongs.
    expect(detail.access.queuePosition).toBe(3);
  });
});
