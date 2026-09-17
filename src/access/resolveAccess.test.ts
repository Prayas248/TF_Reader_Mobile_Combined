// src/access/resolveAccess.test.ts
//
// One case per branch of the access table, plus the rules that cut across it.
//
// WHAT THESE TESTS ARE REALLY GUARDING. Almost every assertion below checks that
// a button is ABSENT as well as which are present, and that is the point rather
// than thoroughness for its own sake. index.html §Access: "Guessing towards the
// more generous button hands an unentitled reader a file." A resolver that
// over-offers passes a present-tense assertion and fails a reader, so the absence
// checks are the ones with teeth.
import { ACCESS_STATES, type Acquisition, type Hold, type Loan, type Session } from '@model/types';

import { isNotEntitled, resolveAccess, type ResolvableItem } from './resolveAccess';

// Builders rather than shared literals, so one test cannot mutate another's
// fixture and no test depends on a field it did not set itself.
const anAcquisition = (over: Partial<Acquisition> = {}): Acquisition => ({
  actionId: 'borrow',
  href: 'https://flambeau.test/api/v1/loans',
  licenceModel: 'SUBSCRIPTION',
  encryption: null,
  hasSearchIndex: false,
  canPersist: true,
  ...over,
});

const anItem = (over: Partial<ResolvableItem> = {}): ResolvableItem => ({
  id: 'item_42',
  acquisition: anAcquisition(),
  ...over,
});

const aSession = (over: Partial<Session> = {}): Session => ({
  userId: 'user_9c2',
  institutionId: 'inst_7f3',
  roles: ['MEMBER'],
  collections: [],
  exp: 0,
  ...over,
});

const aLoan = (state: Loan['state']): Loan => ({ itemId: 'item_42', state });

const aHold = (state: Hold['state'], over: Partial<Hold> = {}): Hold => ({
  itemId: 'item_42',
  state,
  ...over,
});

// The common shape of a call, so each test states only what it is about.
const resolve = (over: Partial<Parameters<typeof resolveAccess>[0]> = {}) =>
  resolveAccess({
    item: anItem(),
    institutionId: 'inst_7f3',
    session: aSession(),
    ...over,
  });

describe('resolveAccess', () => {
  describe('identity on the result', () => {
    // The PR's whole reason for existing: the same publication resolves
    // differently for two institutions, so a result naming only the item is
    // ambiguous and a cache keyed on it is wrong.
    it('stamps the institution onto every result', () => {
      expect(resolve({ institutionId: 'inst_2b9' }).institutionId).toBe('inst_2b9');
      expect(resolve({ institutionId: 'inst_2b9' }).itemId).toBe('item_42');
    });

    it('carries a null institution through rather than dropping the key', () => {
      const result = resolve({ institutionId: null, session: null });
      // Present and null, not absent — a caller building a key must be able to
      // tell "no institution" from "nobody told me".
      expect(result).toHaveProperty('institutionId', null);
    });

    // Two institutions, one publication, different answers — the case the
    // institution key exists for. Same item id, so keying on that alone would
    // collide.
    it('resolves one publication differently for two institutions', () => {
      const elite = anItem({ acquisition: anAcquisition({ licenceModel: 'ELITE' }) });
      const entitled = resolveAccess({
        item: elite,
        institutionId: 'inst_7f3',
        session: aSession(),
        loan: aLoan('active'),
      });
      const notEntitled = resolveAccess({
        item: elite,
        institutionId: 'inst_2b9',
        session: aSession({ institutionId: 'inst_2b9' }),
      });

      expect(entitled.itemId).toBe(notEntitled.itemId);
      expect(entitled.actions).toEqual(['read', 'revokeLicence']);
      expect(notEntitled.actions).toEqual(['grantAccess']);
    });
  });

  // The "done when" bullet: the empty case is explicit and renders as nothing,
  // not an error.
  describe('no acquisition link', () => {
    it('resolves to nothing at all, and does not throw', () => {
      const result = resolve({ item: { id: 'item_42' } });
      expect(result.state).toBe('not_entitled');
      expect(result.actions).toEqual([]);
    });

    it('offers no upsell, because there is no endpoint behind one', () => {
      const { actions } = resolve({ item: { id: 'item_42' } });
      expect(actions).not.toContain('subscribe');
      expect(actions).not.toContain('signIn');
      expect(actions).not.toContain('grantAccess');
    });
  });

  // ── D8 — the predicate screens ask before reading `tier` ────────────────────
  //
  // `tier` is required on AccessResult, so `not_entitled` has to put something
  // there and the filler is OPEN_ACCESS. A screen that reads the tier without
  // asking about the state therefore draws "Open Access" over a title the reader
  // cannot open. This predicate is what five surfaces ask instead.
  describe('isNotEntitled', () => {
    it('is true for the not-entitled resolve, whose tier is a placeholder', () => {
      const result = resolve({ item: { id: 'item_42' } });

      expect(isNotEntitled(result)).toBe(true);
      // The trap, spelled out: the tier looks free to read and is not.
      expect(result.tier).toBe('OPEN_ACCESS');
    });

    it('is false for every state that has something real to show', () => {
      const openAccess = resolve({
        item: { id: 'item_1', acquisition: anAcquisition({ licenceModel: 'OPEN_ACCESS' }) },
      });
      const signedOut = resolve({
        item: { id: 'item_2', acquisition: anAcquisition({ licenceModel: 'ELITE' }) },
        session: null,
      });

      expect(isNotEntitled(openAccess)).toBe(false);
      expect(isNotEntitled(signedOut)).toBe(false);
    });
  });

  describe('a subscribe link', () => {
    const subscribeItem = anItem({
      acquisition: anAcquisition({ actionId: 'subscribe', licenceModel: 'ELITE' }),
    });

    it('offers the route to access and no way to read', () => {
      const result = resolve({ item: subscribeItem });
      expect(result.state).toBe('requires_subscription');
      expect(result.actions).toEqual(['subscribe']);
    });

    // The ordering decision in the resolver, asserted so it cannot be quietly
    // reversed: a subscribe link has no file behind it, so even a contradictory
    // OPEN_ACCESS tier must not produce Read or Download.
    it('beats the tier, so a contradictory open-access claim cannot offer a file', () => {
      const contradictory = anItem({
        acquisition: anAcquisition({ actionId: 'subscribe', licenceModel: 'OPEN_ACCESS' }),
      });
      const { actions } = resolve({ item: contradictory });
      expect(actions).not.toContain('read');
      expect(actions).not.toContain('download');
    });

    // Settled 7 Sep: a subscribe link is still one path to a title, not proof no
    // other path exists. A signed-out reader has not yet been asked whether their
    // institution already grants this title, so Sign in comes first — the same
    // rule every other licensed tier already follows. Subscribe only appears once
    // signed in, once "does my institution cover this" has an answer.
    it('offers sign in first when signed out, even on a subscribe link', () => {
      const result = resolve({ item: subscribeItem, session: null });
      expect(result.state).toBe('requires_signin');
      expect(result.actions).toEqual(['signIn']);
    });

    // The contradiction guard above is about tier vs rel, not about sign-in —
    // it must still hold with no session at all.
    it('still beats a contradictory open-access claim with no session', () => {
      const contradictory = anItem({
        acquisition: anAcquisition({ actionId: 'subscribe', licenceModel: 'OPEN_ACCESS' }),
      });
      const { actions } = resolve({ item: contradictory, session: null });
      expect(actions).not.toContain('read');
      expect(actions).not.toContain('download');
      expect(actions).not.toContain('signIn');
    });
  });

  describe('open access', () => {
    const openAccess = anItem({
      acquisition: anAcquisition({ actionId: 'openAccess', licenceModel: 'OPEN_ACCESS' }),
    });

    it('offers read and download', () => {
      const result = resolve({ item: openAccess });
      expect(result.state).toBe('available');
      expect(result.actions).toEqual(['read', 'download']);
    });

    // The only tier where identity changes nothing.
    it('resolves identically signed out', () => {
      const signedIn = resolve({ item: openAccess, session: aSession() });
      const signedOut = resolve({ item: openAccess, session: null });
      expect(signedOut.actions).toEqual(signedIn.actions);
      expect(signedOut.state).toBe(signedIn.state);
    });

    it('never asks an open-access reader to sign in', () => {
      expect(resolve({ item: openAccess, session: null }).actions).not.toContain('signIn');
    });
  });

  describe('signed out on a licensed tier', () => {
    it('offers sign in, and nothing that could open a file', () => {
      const result = resolve({ session: null });
      expect(result.state).toBe('requires_signin');
      expect(result.actions).toEqual(['signIn']);
    });

    it('does the same on Elite', () => {
      const elite = anItem({ acquisition: anAcquisition({ licenceModel: 'ELITE' }) });
      expect(resolve({ item: elite, session: null }).actions).toEqual(['signIn']);
    });
  });

  describe('subscription', () => {
    // REVERSED on direct instruction, 14 Sep — see resolveAccess.ts's own comment
    // on this branch. Nothing held now offers exactly one button, the same shape
    // as ELITE's `requires_grant`, rather than the old "borrow invisibly behind
    // Read/Download" flow this describe block used to pin.
    it('offers only Request access with no licence held', () => {
      const result = resolve();
      expect(result.state).toBe('requires_grant');
      expect(result.actions).toEqual(['grantAccess']);
    });

    it('offers read and download once a licence is actually held', () => {
      const result = resolve({ loan: aLoan('active') });
      expect(result.state).toBe('available');
      expect(result.actions).toEqual(['read', 'download']);
    });

    it('offers no revoke, which would cost the reader something and gain them nothing', () => {
      expect(resolve({ loan: aLoan('active') }).actions).not.toContain('revokeLicence');
    });
  });

  // The 16 Aug flow, in the order a reader meets it.
  describe('elite', () => {
    const elite = (over: Partial<Acquisition> = {}) =>
      anItem({ acquisition: anAcquisition({ licenceModel: 'ELITE', canPersist: false, ...over }) });

    it('1 · nothing held offers one button, and it is Request access', () => {
      const result = resolve({ item: elite() });
      expect(result.state).toBe('requires_grant');
      expect(result.actions).toEqual(['grantAccess']);
    });

    it('1 · says nothing about the queue before the reader has asked', () => {
      const result = resolve({ item: elite() });
      expect(result.queuePosition).toBeUndefined();
      expect(result.queueLength).toBeUndefined();
    });

    it('2 · queued resolves to no actions, and carries the position instead', () => {
      const result = resolve({
        item: elite(),
        hold: aHold('queued', { position: 4, queueLength: 11 }),
      });
      expect(result.state).toBe('queued');
      expect(result.actions).toEqual([]);
      expect(result.queuePosition).toBe(4);
      expect(result.queueLength).toBe(11);
    });

    // A waiting reader must not be handed a second Request access — tapping it
    // would either do nothing or move them down their own queue.
    it('2 · offers a queued reader nothing to tap', () => {
      const { actions } = resolve({ item: elite(), hold: aHold('queued', { position: 4 }) });
      expect(actions).not.toContain('grantAccess');
      expect(actions).not.toContain('acceptOffer');
    });

    it('3 · an offer resolves to Accept and Reject, with its expiry', () => {
      const result = resolve({
        item: elite(),
        hold: aHold('offered', { offerExpiresAt: '2026-08-17T10:30:00Z' }),
      });
      expect(result.state).toBe('offered');
      expect(result.actions).toEqual(['acceptOffer', 'rejectOffer']);
      expect(result.offerExpiresAt).toBe('2026-08-17T10:30:00Z');
    });

    // An expiry without a reference instant is only measurable against the device
    // clock, which is the one clock the countdown may not use. The two travel
    // together or the rule on `offerExpiresAt` cannot be kept.
    it('3 · carries the server clock alongside the expiry, not just the expiry', () => {
      const result = resolve({
        item: elite(),
        hold: aHold('offered', {
          offerExpiresAt: '2026-08-17T10:30:00Z',
          serverTime: '2026-08-17T10:00:00Z',
        }),
      });
      expect(result.serverTime).toBe('2026-08-17T10:00:00Z');
    });

    // Absent rather than explicitly undefined, so a result stays deep-equal to the
    // obvious literal — the same rule the other three optional fields follow.
    it('3 · omits the server clock entirely when the hold carries none', () => {
      const result = resolve({ item: elite(), hold: aHold('offered') });
      expect('serverTime' in result).toBe(false);
    });

    // The server clock rides with the OFFER and nothing else. flambeau mark it
    // required on every hold response, so a queued hold has one to leak — and
    // `AccessResult.serverTime` promises it appears only when state is 'offered'.
    // Without the gate the constructor copies it across and quietly breaks that
    // promise, which is a comment going stale rather than a screen going wrong:
    // there is no countdown in the queued state to render it against.
    it('2 · withholds the server clock from a queued reader, who has no countdown', () => {
      const result = resolve({
        item: elite(),
        hold: aHold('queued', { position: 4, serverTime: '2026-08-17T10:00:00Z' }),
      });
      expect(result.state).toBe('queued');
      expect('serverTime' in result).toBe(false);
      // The position still travels — the gate is on the clock alone, not on the
      // whole hold.
      expect(result.queuePosition).toBe(4);
    });

    // A missed offer is not restored to its old place, so the reader is back to
    // asking from scratch — the same button as never having asked.
    it('3 · a lapsed offer resolves to Request access, not back to queued', () => {
      const result = resolve({ item: elite(), hold: aHold('expired') });
      expect(result.state).toBe('requires_grant');
      expect(result.actions).toEqual(['grantAccess']);
    });

    // The reader lost their place, so there is no position to report. Reporting the
    // one they used to have would be worse than reporting none.
    it('3 · a lapsed offer carries no queue position', () => {
      const result = resolve({ item: elite(), hold: aHold('expired', { position: 1 }) });
      expect('queuePosition' in result).toBe(false);
    });

    // Both routes to an offer must be indistinguishable, because one component
    // serves both. An offer straight back from the tap and one that arrived by
    // notification differ only in when they happened.
    it('3 · resolves the same whether the offer was immediate or awaited', () => {
      const immediate = resolve({ item: elite(), hold: aHold('offered') });
      const awaited = resolve({
        item: elite(),
        hold: aHold('offered', { position: 1, queueLength: 7 }),
      });
      expect(awaited.state).toBe(immediate.state);
      expect(awaited.actions).toEqual(immediate.actions);
    });

    it('4 · a held copy offers read and revoke', () => {
      const result = resolve({ item: elite(), loan: aLoan('active') });
      expect(result.state).toBe('available');
      expect(result.actions).toEqual(['read', 'revokeLicence']);
    });

    // 13 Aug, and the rule most likely to be broken by a later edit: Elite is
    // read-only at EVERY step, so Download must not appear anywhere in the
    // sequence — not even when a feed contradicts the tier by claiming the copy
    // may be persisted.
    it('never offers Download at any step, whatever canPersist says', () => {
      const persistable = { canPersist: true };
      const steps = [
        resolve({ item: elite(persistable) }),
        resolve({ item: elite(persistable), hold: aHold('queued', { position: 2 }) }),
        resolve({ item: elite(persistable), hold: aHold('offered') }),
        resolve({ item: elite(persistable), loan: aLoan('active') }),
      ];
      steps.forEach(({ actions }) => expect(actions).not.toContain('download'));
    });

    // Should not occur — one hold per item, and accepting consumes it. When it
    // does, during the moment an Accept becomes a loan, showing the book beats
    // re-offering something already answered.
    it('prefers a held copy over a live offer', () => {
      const result = resolve({
        item: elite(),
        loan: aLoan('active'),
        hold: aHold('offered'),
      });
      expect(result.state).toBe('available');
      expect(result.actions).toEqual(['read', 'revokeLicence']);
    });

    it('treats an expired loan as nothing held', () => {
      expect(resolve({ item: elite(), loan: aLoan('expired') }).actions).toEqual(['grantAccess']);
    });
  });

  // index.html §Access: "canPersist: false → download hidden, whatever the row
  // above says." A belt-and-braces rule, so it stops mattering which order the
  // tier and the field are read in.
  describe('canPersist', () => {
    it('hides Download on open access', () => {
      const item = anItem({
        acquisition: anAcquisition({
          actionId: 'openAccess',
          licenceModel: 'OPEN_ACCESS',
          canPersist: false,
        }),
      });
      expect(resolve({ item }).actions).toEqual(['read']);
    });

    it('hides Download on subscription', () => {
      const item = anItem({ acquisition: anAcquisition({ canPersist: false }) });
      expect(resolve({ item, loan: aLoan('active') }).actions).toEqual(['read']);
    });

    it('never hides Read, which is what the reader came for', () => {
      const item = anItem({ acquisition: anAcquisition({ canPersist: false }) });
      expect(resolve({ item, loan: aLoan('active') }).actions).toContain('read');
    });
  });

  describe('the badge', () => {
    // The tier drives the badge only, never an action — confirmed to wokay in
    // writing. Reported unchanged even in states that offer nothing, so a queued
    // or unobtainable title still shows what it is.
    it('reports the tier verbatim, in every state', () => {
      expect(resolve().tier).toBe('SUBSCRIPTION');

      const elite = anItem({ acquisition: anAcquisition({ licenceModel: 'ELITE' }) });
      expect(resolve({ item: elite, hold: aHold('queued', { position: 3 }) }).tier).toBe('ELITE');
      expect(resolve({ item: elite, session: null }).tier).toBe('ELITE');
    });
  });

  describe('purity', () => {
    it('returns the same result for the same inputs', () => {
      const input = { item: anItem(), institutionId: 'inst_7f3', session: aSession() };
      expect(resolveAccess(input)).toEqual(resolveAccess(input));
    });

    it('does not mutate what it is handed', () => {
      const item = anItem();
      const session = aSession();
      const hold = aHold('queued', { position: 4 });
      const before = JSON.stringify({ item, session, hold });

      resolveAccess({ item, institutionId: 'inst_7f3', session, hold });

      expect(JSON.stringify({ item, session, hold })).toBe(before);
    });
  });

  // A state nothing can produce is a state that should not be in the contract.
  // This fails when a state is added without a branch, or when a branch is
  // deleted and its state left behind.
  describe('coverage of the contract', () => {
    it('can produce every declared access state', () => {
      const elite = anItem({ acquisition: anAcquisition({ licenceModel: 'ELITE' }) });
      const produced = new Set(
        [
          resolve(),
          // Subscription's own `available` — `resolve()` alone no longer reaches
          // it now that nothing held resolves to `requires_grant` instead.
          resolve({ loan: aLoan('active') }),
          resolve({ session: null }),
          resolve({ item: { id: 'item_42' } }),
          resolve({
            item: anItem({ acquisition: anAcquisition({ actionId: 'subscribe' }) }),
          }),
          resolve({ item: elite }),
          resolve({ item: elite, hold: aHold('queued', { position: 1 }) }),
          resolve({ item: elite, hold: aHold('offered') }),
        ].map((result) => result.state),
      );

      expect([...ACCESS_STATES].filter((state) => !produced.has(state))).toEqual([]);
    });
  });
});
