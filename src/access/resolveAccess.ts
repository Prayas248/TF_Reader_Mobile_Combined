// src/access/resolveAccess.ts
// The access spine. THE ONLY PLACE ACCESS LOGIC MAY EXIST.
//
// Design Spec §5.1: "the UI must never calculate access rights". Everything a
// screen needs to draw an action bar comes out of here as an `AccessResult`, and
// nothing above this file may read `licenceModel`, `canPersist`, a `Loan` or a
// `Hold` to decide what to render. A component that does has moved access logic
// into the view, and the review rule for `src/access/` exists to catch it.
//
// IT INTERPRETS THE FEED; IT IS NOT A RULES ENGINE. There is no configuration
// here, no table loaded at runtime, no per-institution branching. It is one
// function of five inputs, and the whole of it is the ordered list of cases below.
//
// IT IS PURE, AND IT NEVER THROWS. Given the same inputs it returns the same
// result, it makes no calls, and it reads no clock — which is what lets a list of
// forty cards resolve forty times per render for free. "We could not find out" is
// not a value it returns: a fetch that failed is the ActionBar's `error` state and
// the caller owns that decision, because a resolver that could fail would have to
// be awaited and the whole point is that it cannot be.
//
// WHY IT DOES NOT ALSO PERFORM THE ACTIONS. Deciding which button to draw and
// carrying out what the button does are different jobs with different failure
// modes; the four flambeau calls live behind the screens, keyed by `LicenceRef`.
// Keeping the decision pure is what makes it testable without a server.
import {
  type AccessResult,
  type AccessState,
  type Acquisition,
  type ActionId,
  type Hold,
  type Loan,
  type Session,
} from '@model/types';
import type { BookId } from '@/shared/types/primitives';

// The publication, narrowed to the two fields access actually depends on.
//
// A `Publication` satisfies this, so callers pass one straight in. It is declared
// as a subset rather than taking `Publication` for two reasons, and the second is
// the one that matters:
//
//   1. A resolve has no business reading a title, an author or a cover, and a
//      narrow parameter says so in a way a comment cannot.
//   2. `acquisition` is OPTIONAL HERE while `Publication.acquisition` is required.
//      That is deliberate — see `no acquisition link` below.
export interface ResolvableItem {
  id: BookId;
  acquisition?: Acquisition;
}

// WHERE EACH INPUT COMES FROM, as of 17 Aug. Three of the five have no source in
// the app yet, which is why this function is finished and unwired:
//
//   item           the feed, via `getCatalogueSource()`            — exists
//   institutionId  `useInstitutionStore` → selectedInstitution?.id — exists
//   session        a session store                                 — NOT BUILT
//   loan, hold     flambeau's loan and hold calls (D10/F8)         — NOT BUILT
//
// That is survivable rather than blocking, and it is the reason `loan` and `hold`
// are optional while `session` may be null: omit all three and Open Access,
// Subscription and Elite-with-nothing-held still resolve correctly, so a screen
// can be wired before flambeau exists. Only Elite's later steps — queued,
// offered, holding a copy — need the missing two. The State Gallery passes
// hand-written values and needs none of it.
export interface ResolveAccessInput {
  item: ResolvableItem;
  // The institution this resolve is for. `null` is the public open-access path,
  // where no institution has been chosen. NOT read off the session: the
  // institution is picked before sign-in (CAP-3), so it exists in states where a
  // session does not, and a caller that conflated the two would resolve a
  // pre-sign-in browse as if no institution had been selected.
  institutionId: string | null;
  // `null` when signed out. Open Access resolves the same either way.
  session: Session | null;
  // Both optional, and absent means the same as `state: 'none'` — nothing held,
  // nothing queued. A resolve is never blocked on having fetched them, which is
  // what lets a list row resolve from feed data alone.
  loan?: Loan;
  hold?: Hold;
}

// AN OBJECT AND NOT FIVE POSITIONAL ARGUMENTS, which departs from the signature
// index.html sketched (`resolveAccess(item, session, loan, hold)`) and is worth
// the departure. `Loan` and `Hold` are structurally alike — both carry `itemId`
// and a `state` — so `resolveAccess(item, session, hold, loan)` is a mistake that
// reads correctly, and one that only fails to typecheck when the state values
// happen to disagree. Named inputs make the transposition impossible to write.
export function resolveAccess({
  item,
  institutionId,
  session,
  loan,
  hold,
}: ResolveAccessInput): AccessResult {
  const { acquisition } = item;

  // ── 1 · no acquisition link ────────────────────────────────────────────────
  //
  // Nothing at all. Not an error, not an upsell — index.html §Access: "Do not
  // invent a 'request access' affordance for it; there is no endpoint behind one."
  //
  // CURRENTLY UNREACHABLE FROM REAL DATA, and kept anyway. `normalize.ts` rejects
  // a publication with no acquisition link at the adapter boundary, so a feed can
  // never produce this. It stays because the empty case has to be a branch
  // somebody can point at and test rather than a claim about code that does not
  // exist — and because the day `Publication` learns to represent "metadata, no
  // file" (see 2 below), this is the branch that catches it.
  // `OPEN_ACCESS` AS THE TIER IS A DELIBERATE PLACEHOLDER, settled 17 Aug. With no
  // acquisition link there is no `licenceModel` to read, but `AccessResult.tier` is
  // required — something has to go there. Open Access is the chosen filler because
  // B2B only ever surfaces the three real tiers, so this value is never the one a
  // reader is looking at: `not_entitled` renders nothing at all, badge included.
  //
  // WHAT WOULD MAKE IT WRONG: a caller that reads `tier` without first checking
  // `state`. `AccessTierBadge` takes a bare `AccessTier` and computes nothing, so
  // it would happily draw "OPEN ACCESS" over a title with no buttons. Nothing does
  // that today and nothing should; if a screen ever needs the badge in this state,
  // the fix is to make `tier` optional here, not to pick a different filler.
  if (acquisition === undefined) {
    return result(institutionId, item.id, 'OPEN_ACCESS', 'not_entitled', []);
  }

  const tier = acquisition.licenceModel;

  // ── 2 · a subscribe link contradicting an OPEN_ACCESS tier claim ───────────
  //
  // A NARROW GUARD, CHECKED BEFORE THE TIER — this is a data-integrity check,
  // not a sign-in question. wokay say to read `licenceModel` rather than `rel`,
  // and normally that is right. But `subscribe` is the one case where the two
  // can disagree in the dangerous direction: a link claiming `OPEN_ACCESS`
  // while carrying a subscribe rel would resolve to Read and Download under a
  // tier-first order below, and Read would open nothing — there is no file
  // behind a subscribe link at all, which is exactly why it has no format.
  // Guessing towards the more generous button is the failure this whole file
  // is arranged to avoid, so the rel wins here regardless of whether anyone is
  // signed in.
  //
  // ALSO CURRENTLY UNREACHABLE: `normalize.ts` rejects these publications while
  // deriving `format`. Giving them a home is a change to `normalize.ts` and to
  // `Publication.format`, in Prayas's file rather than this one.
  if (acquisition.actionId === 'subscribe' && tier === 'OPEN_ACCESS') {
    return result(institutionId, item.id, tier, 'requires_subscription', ['subscribe']);
  }

  // ── 3 · open access ───────────────────────────────────────────────────────
  //
  // BEFORE THE SESSION CHECK, deliberately: Open Access resolves identically
  // signed in and signed out. It is the only tier where the reader's identity
  // changes nothing, and the only one where the download is theirs to keep.
  if (tier === 'OPEN_ACCESS') {
    return result(institutionId, item.id, tier, 'available', withDownload(['read'], acquisition));
  }

  // ── 4 · signed out on a licensed tier ─────────────────────────────────────
  //
  // One button, and it is not the one they came for. BEFORE THE SUBSCRIBE
  // CHECK BELOW, settled 7 Sep: a subscribe link is one path to a title, not
  // proof no other path exists, and a signed-out reader has not yet been asked
  // whether their own institution already grants it. Sign in first, the same
  // as every other licensed tier — Subscribe is what a signed-in reader sees
  // once "does my institution cover this" already has an answer. Everything
  // past this point needs an identity to resolve against: a licence is held by
  // somebody, and a queue has somebody in it.
  if (session === null) {
    return result(institutionId, item.id, tier, 'requires_signin', ['signIn']);
  }

  // ── 5 · a subscribe link ────────────────────────────────────────────────────
  //
  // The reader cannot obtain this title through their institution, and wokay
  // has handed over a route to access instead of a file. Render the metadata
  // and the route — never a Read button, same reasoning as the OPEN_ACCESS
  // guard above.
  if (acquisition.actionId === 'subscribe') {
    return result(institutionId, item.id, tier, 'requires_subscription', ['subscribe']);
  }

  // ── 6 · elite ─────────────────────────────────────────────────────────────
  //
  // The four-step sequence, 16 Aug. Loan-plus-hold is the whole of the decision
  // and no seat count is consulted: whether the queue was empty or busy shows up
  // in WHICH hold state comes back, not in a number fetched beforehand. That is
  // what keeps an Elite row resolving identically on a list and on a detail
  // screen, and it is why `Availability` is not an input to this function.
  if (tier === 'ELITE') {
    // 5a · a copy is held. The terminal state, and checked FIRST — if the reader
    // can already read the title, nothing about a queue is worth telling them.
    // A held loan alongside a live hold should not occur; when it does, during the
    // moment an Accept becomes a loan, this order shows them the book rather than
    // the offer they have already answered.
    if (loan?.state === 'active') {
      // No Download, at any point — 13 Aug. Not filtered by `canPersist`: the rule
      // is the tier's, and it holds even if a feed were to claim otherwise.
      return result(institutionId, item.id, tier, 'available', ['read', 'revokeLicence']);
    }

    // 5b · a copy is being offered right now.
    //
    // CORRECTED 17 Aug. This used to say the offer could arrive "straight back
    // from the Request access tap when nobody was ahead". It cannot: `POST /holds`
    // documents only 200 and 201, and BOTH return `status: QUEUED`. There is no
    // response shape in which placing a hold hands back an offer, so nothing
    // should be wired to expect one.
    //
    // THE REASON THE CASE NEVER ARISES IS UPSTREAM OF THAT. Request access borrows
    // first — `POST /loans` refuses with `409 NO_COPIES_AVAILABLE` and names the
    // hold endpoint so the app can offer the queue as a choice. So a reader only
    // ever holds when there was no free copy to take, and a hold placed against a
    // free copy is not a case to handle.
    //
    // AN OFFER THEREFORE ALWAYS ARRIVES LATER, by one of the reads: `GET /holds`,
    // `GET /library`, or the change feed's `HOLD_PROMOTED`. One route, not two —
    // which makes this branch simpler than the old comment claimed, not harder.
    if (hold?.state === 'offered') {
      return result(
        institutionId,
        item.id,
        tier,
        'offered',
        ['acceptOffer', 'rejectOffer'],
        hold,
      );
    }

    // 5c · queued, with others ahead. NO ACTIONS, which is the unusual answer
    // here and the correct one: a waiting reader has nothing to do until their
    // turn arrives, so there is no button. Their position rides on the result and
    // the screen renders it — a position is a status, not an action.
    if (hold?.state === 'queued') {
      return result(institutionId, item.id, tier, 'queued', [], hold);
    }

    // 5d · nothing held, nothing asked for. One button, and it says nothing about
    // how busy the title is.
    //
    // ALSO THE LAPSED-OFFER CASE, and by fallthrough rather than by a branch of
    // its own — `hold.state === 'expired'` matches none of 5a–5c and lands here.
    // That is the correct answer and not an accident: flambeau do not restore a
    // missed offer to its old place, so a reader whose window closed has to ask
    // again from the back, which is the same button as never having asked. There
    // is no `offer_lapsed` access state for the same reason — a state whose bar
    // is identical is not a state, and "your offer expired" is a thing to SAY,
    // which the offer store says through QueueNotification.
    //
    // Nothing here reads a clock to discover the lapse. `isOfferLapsed` in
    // src/access does that, and hands this function a hold already marked.
    return result(institutionId, item.id, tier, 'requires_grant', ['grantAccess']);
  }

  // ── 7 · subscription ──────────────────────────────────────────────────────
  //
  // REVERSED on direct instruction, 14 Sep — the 12 Aug flow change above this
  // comment (borrow invisibly behind the first Read/Download tap) is no longer
  // the rule. A reader now sees the same explicit acquire step Elite already
  // has: nothing held means one button, `grantAccess`, and Read/Download only
  // appear once a loan is actually active. Mirrors ELITE's 5a/5d shape deliberately
  // (`loan?.state === 'active'` first, `requires_grant` otherwise) rather than
  // inventing a second one — the difference that remains is real, not cosmetic:
  // Subscription still downloads (`withDownload`), because canPersist is what
  // gates that, not the tier, and Subscription carries no queue/hold mechanics
  // of its own here (an entitlement's copy limit still applies server-side, and
  // a refused borrow surfaces through the same `licenceMessage` every other
  // refusal does — see `runLicenceCall`), because nothing asked for one.
  if (tier === 'SUBSCRIPTION') {
    if (loan?.state === 'active') {
      return result(institutionId, item.id, tier, 'available', withDownload(['read'], acquisition));
    }
    return result(institutionId, item.id, tier, 'requires_grant', ['grantAccess']);
  }

  // A fourth tier is a compile error here rather than a silent fall-through to
  // something generous. `tier` is `never` at this point, so adding one to
  // `ACCESS_TIERS` breaks this line until it has a case above.
  return assertNever(tier);
}

// Download is appended, never assumed — and `canPersist` is the only thing that
// decides it.
//
// index.html §Access: "canPersist: false → download hidden, whatever the row
// above says." Honoured as a belt-and-braces rule rather than derived from the
// tier, so it stops mattering which order the two are read in. Hiding the button
// is a UI decision and not a protection: the download endpoint enforces
// entitlement itself, whatever we draw.
function withDownload(actions: ActionId[], acquisition: Acquisition): ActionId[] {
  return acquisition.canPersist ? [...actions, 'download'] : actions;
}

// One constructor for every return above, so no branch can forget to stamp the
// institution onto its result — which is the bug the `institutionId` field exists
// to prevent. `hold` is threaded in rather than its three fields being passed
// separately, so a state that carries no queue detail cannot accidentally be
// given some.
function result(
  institutionId: string | null,
  itemId: BookId,
  tier: AccessResult['tier'],
  state: AccessState,
  actions: ActionId[],
  hold?: Hold,
): AccessResult {
  return {
    institutionId,
    itemId,
    tier,
    state,
    actions,
    // Spread conditionally rather than assigned as `undefined`, so a result is
    // deep-equal to the obvious literal in a test rather than carrying three
    // explicitly-undefined keys.
    ...(hold?.position !== undefined ? { queuePosition: hold.position } : {}),
    ...(hold?.queueLength !== undefined ? { queueLength: hold.queueLength } : {}),
    ...(hold?.offerExpiresAt !== undefined ? { offerExpiresAt: hold.offerExpiresAt } : {}),
    // Copied out beside `offerExpiresAt` and for its sake — an absolute expiry
    // with no reference instant can only be measured against the device clock,
    // which is the one thing the offer countdown may not do.
    //
    // GATED ON THE STATE, unlike the three above, and it is the only one that has
    // to be. flambeau mark `serverTime` required on every hold response, so a
    // QUEUED hold carries one too — and copying it across unasked is exactly the
    // "state given queue detail it has no use for" this constructor exists to
    // prevent. The other three need no gate because the hold itself withholds
    // them: `position` is absent when offered, `offerExpiresAt` when queued.
    ...(state === 'offered' && hold?.serverTime !== undefined
      ? { serverTime: hold.serverTime }
      : {}),
  };
}

// ── D8 — the not-entitled state, as a question a screen can ask ──────────────
//
// `not_entitled` renders NOTHING: no buttons, and no badge either. The buttons
// take care of themselves — `actions` is `[]`, and `ActionBar` returns null on an
// empty set. The BADGE does not, and that is the whole reason this predicate
// exists: `tier` is required on `AccessResult`, so this state has to put
// something there, and the filler is `OPEN_ACCESS` (settled 17 Aug). A caller
// that reads `tier` without first checking `state` therefore draws "Open Access"
// over a title the reader cannot open — which is the exact failure the comment on
// branch 1 above warns about.
//
// A PREDICATE RATHER THAN FIVE INLINE COMPARISONS. Five surfaces render the badge
// (item detail's two presentations, plus the catalogue, shelf, search and public
// rows), and a rule spelled out five times is a rule that will be four rules
// after the next refactor. Nothing is computed here — it reads the resolve and
// reports it, so this is not a second place where access is decided.
export function isNotEntitled(access: Pick<AccessResult, 'state'>): boolean {
  return access.state === 'not_entitled';
}

// Unreachable by construction. Throws rather than returning a fallback: reaching
// it means the tier vocabulary grew without this file being told, and a generous
// default there is precisely how an unentitled reader gets handed a file.
function assertNever(value: never): never {
  throw new Error(`resolveAccess: unhandled access tier ${String(value)}`);
}
