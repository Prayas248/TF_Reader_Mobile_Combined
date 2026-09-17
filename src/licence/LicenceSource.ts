// src/licence/LicenceSource.ts
// The four licence calls, plus the two the offer needs and the one read they all
// depend on. THE SEAM: screens depend on this interface, never on HTTP.
//
// WHY THIS EXISTS SEPARATELY FROM `DataSource`. That seam is wokay's — a catalogue
// is public, cacheable, and the same for every reader in an institution. This one is
// flambeau's, and every call on it is about one reader: it needs a token, it mutates
// server state, and two readers asking the same question get different answers. Same
// Mock/Api pattern, different backend, different lifetime.
//
// WHY IT IS NOT PART OF `src/access`. `resolveAccess` decides which button to draw
// and is pure; this carries out what the button does and is all side effects. Keeping
// them apart is what lets a list of forty cards resolve for free — see the note at the
// top of `resolveAccess.ts`. The two meet in a screen, not in a file.
//
// EVERY METHOD IS NAMED FOR flambeau's OPERATION, not for what we used to call it.
// The old vocabulary — generate a licence, check a licence, revoke, join queue — is
// gone from the code. It survives only in the mapping table below, so that a message
// to flambeau and a function name in here cannot drift apart.
//
//   ours (13 Aug)        theirs                 here
//   generate a licence   borrow                 borrow
//   check a licence      open a reading session  openReadingSession
//   revoke               return                 returnLoan
//   join queue           place a hold           placeHold
//   —                    accept an offer        acceptOffer
//   —                    cancel a hold          cancelHold
import type { BookId } from '@/shared/types/primitives';
import type { Changes, Hold, Loan } from '@model/types';

// Everything a licence call rejects with.
//
// A SIBLING OF `CatalogueFailure`, NOT A SUBCLASS, for the reason set out in
// model/errors.ts: the carrier pattern is copied so catch sites read alike, but the
// shapes differ. A catalogue failure is about a URL; this is about one reader's
// relationship to one title, and it carries flambeau's own `code` because that is
// what the error copy is keyed on.
export enum LicenceError {
  // Offline, DNS, unreachable host. Retryable, expected on mobile.
  NETWORK_UNAVAILABLE = 'NETWORK_UNAVAILABLE',
  // Past the deadline. Kept apart from the above: a slow server and no connection
  // want different copy.
  TIMEOUT = 'TIMEOUT',
  // flambeau answered, and said no. `errorCode` carries their reason and is the
  // thing to render from — never the HTTP status. wokay say 403 for
  // DOWNLOAD_NOT_PERMITTED and flambeau's own reference says 422, so the status is
  // not a stable key even inside one contract.
  REFUSED = 'REFUSED',
  // A 2xx whose body is not the shape the contract promises. Loud on purpose: a
  // loan with no `loanId` cannot be returned later, and finding that out at the
  // Revoke tap is worse than finding it out here.
  MALFORMED_RESPONSE = 'MALFORMED_RESPONSE',
  // The call is real, in the contract, and not ours to make yet. Exactly one method
  // throws this — see `openReadingSession`.
  NOT_OURS_YET = 'NOT_OURS_YET',
}

export class LicenceFailure extends Error {
  readonly code: LicenceError;
  // flambeau's `code` from the error envelope, present only on REFUSED. This is
  // what error copy keys on — see `ERROR_CODES` in model/types.ts, and Moktik's D14
  // for the sentences.
  readonly errorCode?: string;
  // The item, loan or hold the call was about.
  readonly target?: string;
  readonly cause?: unknown;

  constructor(
    code: LicenceError,
    options: { errorCode?: string; target?: string; cause?: unknown } = {},
  ) {
    super(options.target ? `${code} for ${options.target}` : code);
    this.name = 'LicenceFailure';
    this.code = code;
    if (options.errorCode !== undefined) this.errorCode = options.errorCode;
    if (options.target !== undefined) this.target = options.target;
    if (options.cause !== undefined) this.cause = options.cause;
    // Prototype fixup, as in CatalogueFailure — without it `instanceof` fails
    // through the transpiled class hierarchy.
    Object.setPrototypeOf(this, LicenceFailure.prototype);
  }
}

export function isLicenceFailure(value: unknown): value is LicenceFailure {
  return value instanceof LicenceFailure;
}

// What the reader currently holds and waits for, from `GET /api/v1/library`.
//
// ONE CALL RATHER THAN THREE, which is flambeau's own reasoning: the alternative is
// loans, holds and wokay's items:batch on every resume, joined on the device. Their
// note is explicit that this is the read model and `GET /loans` remains the
// collection for history and paging.
export interface Library {
  loans: Loan[];
  holds: Hold[];
  // The change-feed cursor as at this response. `GET /loans/changes?since=` picks up
  // from here with no gap, which is what makes polling for offers safe rather than
  // sampled — see the transport answer of 15 Aug.
  cursor?: string;
  // The server's clock as at this response. Every countdown measures against this,
  // never `Date.now()`.
  serverTime?: string;
}

export interface LicenceSource {
  // Take possession. `POST /api/v1/loans`, FROZEN.
  //
  // CREATE OR VALIDATE, NOT CREATE: a reader who already holds this title gets their
  // existing loan and a 200 rather than an error, because a double tap is ordinary.
  // So this is safe to call twice and callers need no guard of their own.
  //
  // REFUSES WITH `NO_COPIES_AVAILABLE` RATHER THAN QUEUEING, which is the whole shape
  // of the Elite flow: Request access calls this first, and only offers the queue when
  // this says there is nothing free. Catch REFUSED with that code and call
  // `placeHold` — do not enqueue on the reader's behalf.
  borrow(itemId: BookId): Promise<Loan>;

  // Give the copy back. `POST /api/v1/loans/{loanId}/return`, FROZEN.
  //
  // TAKES A `loanId` AND NOT A `LicenceRef`, and that is the contract's choice rather
  // than ours. `LicenceRef` was picked on 16 Aug precisely to avoid threading a loan
  // id around; the frozen endpoint takes one in the path, so the id has to travel.
  // It rides on `Loan.loanId`, which every read and both writes supply.
  returnLoan(loanId: string): Promise<void>;

  // Join the queue. `POST /api/v1/holds`, DRAFT.
  //
  // ELITE ONLY — a title with no copy limit has nothing to queue for and answers 409.
  // Idempotent: a reader already queued gets their existing hold with the position
  // unchanged, so re-joining cannot send someone to the back of a queue they were
  // already in.
  //
  // ALWAYS COMES BACK QUEUED, NEVER OFFERED. Both documented responses carry
  // `status: QUEUED`; there is no shape in which placing a hold hands back an offer.
  // An offer arrives later, through `getLibrary` or the change feed.
  placeHold(itemId: BookId): Promise<Hold>;

  // Take the copy that was offered. `POST /api/v1/holds/{holdId}/accept`, DRAFT.
  //
  // RETURNS A LOAN — the same shape borrowing does, because the copy was already
  // leased in this reader's name and this only writes the loan.
  //
  // `OFFER_EXPIRED` IS THE ORDINARY FAILURE, NOT AN EXCEPTIONAL ONE. Offers lapse on
  // a schedule and the app is often a few seconds behind. When it comes back, the
  // hold is GONE rather than restored — the reader rejoins at the back, so the copy
  // for that state is "the window closed and you are back at the start", not "try
  // again".
  acceptOffer(holdId: string): Promise<Loan>;

  // Leave the queue — and also how an offer is declined. `DELETE
  // /api/v1/holds/{holdId}`, DRAFT.
  //
  // ONE CALL FOR TWO BUTTONS, which is flambeau's design and not a shortcut here:
  // "Declining an offer is a cancel; there is no separate decline endpoint."
  //
  // SO REJECT COSTS THE READER THEIR PLACE ENTIRELY. Cancelling an offered hold
  // releases the copy immediately and promotes the next waiter, and the hold is hard
  // deleted — "the only genuinely hard delete in this file". A reader who reads
  // "Reject" as "not now, keep my spot" is wrong, and that is a copy problem sitting
  // on the button rather than a problem with this call.
  cancelHold(holdId: string): Promise<void>;

  // Everything this reader holds or waits for. `GET /api/v1/library`, DRAFT.
  //
  // NOT OPTIONAL EXTRA, despite belonging to the caching task: without a read, the
  // ids the two id-keyed calls need only exist for as long as the app stays open.
  // After a cold start `returnLoan` and `acceptOffer` have nothing to name, so this
  // is what makes the rest of the interface usable rather than a nicety on top.
  getLibrary(): Promise<Library>;

  // The sync feed. `GET /api/v1/loans/changes`, DRAFT.
  //
  // `since` is the previous call's `nextCursor`; omit it for everything the feed has.
  // D16's whole use for this is noticing a `HOLD_PROMOTED` entry and then reading the
  // real offer off `getLibrary` — see `src/features/queue`. The other seven reasons on
  // `ChangeReason` are not acted on by anything yet.
  getChanges(since?: string): Promise<Changes>;

  // Permission to fetch the bytes. `POST /api/v1/reading-sessions`, FROZEN.
  //
  // IN THE INTERFACE, DELIBERATELY NOT IMPLEMENTED. It needs a `devicePublicKey` —
  // base64 of raw key bytes — and that key lives in t4targaryen's keystore, not ours.
  // Whether we ask them for the key and call this ourselves, or hand them the item
  // and they call it, is open question 6 and nobody has claimed it.
  //
  // PRESENT ANYWAY, because the shape of the answer does not depend on who wins: if
  // it turns out to be ours, this is where it goes and no caller has to be reshaped.
  // Every implementation throws `NOT_OURS_YET` until then, which is a louder and more
  // findable answer than the method simply being absent.
  openReadingSession(itemId: BookId): Promise<never>;
}
