// src/model/detail.ts
// The shared detail model — one shape behind screen 04 (article) and screen 05
// (book). Week 2 plan: "Screens 04 and 05 are one screen with different fields.
// Build the common part once; both screens depend on it."
//
// WHAT THIS IS: A NARROWING, NOT A NEW SOURCE OF TRUTH. Every field below already
// exists on `Publication` or `AccessResult`. Naming them here states exactly which
// fields the SHARED half of the two screens may draw on, so a field only one
// screen shows — an article's page range, a book's table of contents — cannot be
// reached through it by accident. That is the whole value: the list is short on
// purpose.
//
// NOTHING IS DERIVED, PARSED OR FETCHED. `buildItemDetail` copies. Parsing wire
// data is `normalizePublication`'s job and deciding access is `resolveAccess`'s;
// this sits after both and invents nothing (CONVENTIONS §3 — the UI never
// computes access rights).
import type { BookId, ContentFormat } from '@/shared/types/primitives';
import type { AccessResult, Publication, WorkType } from '@model/types';

export interface ItemDetail {
  // The backend's itemId, never the ISBN — same identity as the Publication it
  // was built from.
  id: BookId;

  // Which of the two screens renders: 'article' → screen 04, 'book' → screen 05.
  //
  // THE CALLER STILL SUPPLIES IT because `Publication.workType` is optional —
  // wokay confirms Book and Audiobook (`@type` values), but journal/article are
  // Q-1b (unanswered). `normalizePublication` now fills the field when `@type`
  // maps to a known WorkType; callers fall back to BOOK_WORK_TYPE for everything
  // else. When Q-1b is answered, only `WOKAY_TYPE_MAP` in opds/normalize.ts needs
  // a new entry.
  workType: WorkType;

  title: string;
  subtitle?: string;
  // Credit order, as the feed supplied it.
  authors: string[];
  coverUrl?: string;
  // A date string exactly as the feed sent it ('2020-09-30'), not a timestamp.
  published?: string;
  publisher?: string;
  isbn?: string;
  numberOfPages?: number;
  // Carried through from Publication.subjects — previously read there but
  // dropped before reaching either detail screen. Screen 04 (article) renders
  // these as a Subjects section; screen 05 (book) does not read this field.
  subjects: string[];
  // The one confirmed format ('PDF' | 'EPUB' | 'AUDIO') — a publication has
  // exactly one, so this is display data, not a choice. Absent only when
  // normalize.ts could not derive one (a `subscribe` rel carries no file).
  format?: ContentFormat;
  // The abstract on screen 04, the blurb on screen 05 — one field, two labels.
  description?: string;

  // Carried whole rather than unpacked. The tier badge, the buttons, the queue
  // position and the offer expiry all live in here, so a screen reads access from
  // exactly one place and nothing can drift out of step with `resolveAccess`.
  access: AccessResult;
}

export interface BuildItemDetailInput {
  publication: Publication;
  workType: WorkType;
  access: AccessResult;
}

/**
 * Combines the three things a detail screen already has into the shape both
 * screens read from.
 *
 * A named object rather than three arguments, matching `resolveAccess` — the
 * call site says which input is which without anyone opening this file.
 */
export function buildItemDetail({
  publication,
  workType,
  access,
}: BuildItemDetailInput): ItemDetail {
  // Optional fields are copied straight across. A missing one stays `undefined`
  // rather than being omitted from the object, which is what the screens want:
  // "render whatever fields are present; leave gaps blank rather than blocking."
  return {
    id: publication.id,
    workType,
    title: publication.title,
    subtitle: publication.subtitle,
    authors: publication.authors,
    coverUrl: publication.coverUrl,
    published: publication.published,
    publisher: publication.publisher,
    isbn: publication.isbn,
    numberOfPages: publication.numberOfPages,
    // `?? []` rather than a bare copy: Publication.subjects is required by the
    // real contract, but several existing tests build a Publication through
    // an unsafe cast (`as never`/`as unknown as Publication`) that skips it
    // entirely — defend against that here rather than in every fixture.
    subjects: publication.subjects ?? [],
    format: publication.format,
    description: publication.description,
    access,
  };
}
