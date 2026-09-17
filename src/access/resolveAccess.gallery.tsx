// src/access/resolveAccess.gallery.tsx
// The access table, resolved by the real function rather than written out by hand.
//
// WHY THIS EXISTS ALONGSIDE ActionBar's GALLERY, which looks similar. That one
// hands the bar a list of buttons someone typed, and proves the bar lays them out.
// This one hands `resolveAccess` a tier, a session, a loan and a hold, and shows
// what it decided — so the thing under review is the RULE, not the rendering. If
// these two ever disagree about what Elite looks like, this is the one that is
// right, because the other is a person's opinion typed into an array.
//
// AND IT NEEDS NO BACKEND. Every input below is a literal. That is the whole point
// of the resolve being pure: the Elite sequence can be clicked through end to end
// with no session store and none of flambeau's four calls in existence.
import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import AccessTierBadge from '@components/AccessTierBadge';
import ActionBar from '@components/ActionBar';
import type { AccessResult, Acquisition, Hold, Loan, Session } from '@model/types';
import { color, radius, space, type } from '@theme/tokens';

import { resolveAccess, type ResolvableItem } from './resolveAccess';

const INSTITUTION_ID = 'inst_7f3';

const aSession = (): Session => ({
  userId: 'user_9c2',
  institutionId: INSTITUTION_ID,
  roles: ['MEMBER'],
  collections: [],
  exp: 0,
});

const anAcquisition = (over: Partial<Acquisition> = {}): Acquisition => ({
  actionId: 'borrow',
  href: 'https://flambeau.test/api/v1/loans',
  licenceModel: 'SUBSCRIPTION',
  encryption: null,
  hasSearchIndex: false,
  canPersist: true,
  ...over,
});

const anItem = (over: Partial<Acquisition> = {}): ResolvableItem => ({
  id: 'item_42',
  acquisition: anAcquisition(over),
});

// One row per case in index.html's access table, described by its INPUTS only.
// Nothing here names a button — that is what is being demonstrated.
const CASES: { caption: string; item: ResolvableItem; session: Session | null; loan?: Loan; hold?: Hold }[] = [
  {
    caption: 'Open Access — signed in',
    item: anItem({ actionId: 'openAccess', licenceModel: 'OPEN_ACCESS' }),
    session: aSession(),
  },
  {
    caption: 'Open Access — signed OUT. Must resolve identically to the row above',
    item: anItem({ actionId: 'openAccess', licenceModel: 'OPEN_ACCESS' }),
    session: null,
  },
  {
    caption: 'Open Access, canPersist: false — Download hidden, whatever the tier says',
    item: anItem({ actionId: 'openAccess', licenceModel: 'OPEN_ACCESS', canPersist: false }),
    session: aSession(),
  },
  {
    caption: 'Subscription — no licence held. The tap borrows',
    item: anItem(),
    session: aSession(),
  },
  {
    caption: 'Subscription — licence held. The SAME pair; the reader cannot tell',
    item: anItem(),
    session: aSession(),
    loan: { itemId: 'item_42', state: 'active' },
  },
  {
    caption: 'Signed out on a licensed tier',
    item: anItem(),
    session: null,
  },
  {
    caption: 'Elite — nothing held',
    item: anItem({ licenceModel: 'ELITE', canPersist: false }),
    session: aSession(),
  },
  {
    caption: 'Elite — queued, four ahead. No buttons; the position is the screen’s job',
    item: anItem({ licenceModel: 'ELITE', canPersist: false }),
    session: aSession(),
    hold: { itemId: 'item_42', state: 'queued', position: 4, queueLength: 11 },
  },
  {
    caption: 'Elite — a copy is offered',
    item: anItem({ licenceModel: 'ELITE', canPersist: false }),
    session: aSession(),
    hold: { itemId: 'item_42', state: 'offered', offerExpiresAt: '2026-08-17T10:30:00Z' },
  },
  {
    caption: 'Elite — a copy is held. Read and revoke, and NO Download at any point',
    item: anItem({ licenceModel: 'ELITE', canPersist: false }),
    session: aSession(),
    loan: { itemId: 'item_42', state: 'active' },
  },
  {
    caption: 'A subscribe link — cannot obtain, so a route to access and no Read',
    item: anItem({ actionId: 'subscribe', licenceModel: 'ELITE' }),
    session: aSession(),
  },
  {
    caption: 'No acquisition link — nothing at all. Not an error, not an upsell',
    item: { id: 'item_42' },
    session: aSession(),
  },
];

// The resolved answer, printed as text beside the rendered bar. Both are shown on
// purpose: the text is what a test asserts, the bar is what a reader sees, and a
// disagreement between them is the bug this surface is for.
function Resolved({ result }: { result: AccessResult }) {
  return (
    <View style={styles.resolved}>
      <Text style={styles.mono}>
        state={result.state} · actions=[{result.actions.join(', ')}]
        {result.queuePosition !== undefined && ` · position=${result.queuePosition}`}
        {result.queueLength !== undefined && ` of ${result.queueLength}`}
        {result.offerExpiresAt !== undefined && ` · expires=${result.offerExpiresAt}`}
      </Text>
      <Text style={styles.mono}>
        institutionId={String(result.institutionId)} · itemId={result.itemId}
      </Text>
    </View>
  );
}

// The Elite sequence, driven by taps rather than by reading a table.
//
// The queue switch is the only thing a backend would otherwise decide: it stands in
// for "was anybody ahead of me when I asked". Flip it before tapping Request access
// and the same tap leads to the two different paths, which is the clearest way to
// see that both end at the same Accept / Reject pair.
function EliteWalkthrough() {
  const [loan, setLoan] = useState<Loan>({ itemId: 'item_42', state: 'none' });
  const [hold, setHold] = useState<Hold>({ itemId: 'item_42', state: 'none' });
  const [othersAhead, setOthersAhead] = useState(false);
  const [log, setLog] = useState('nothing yet');

  const item = anItem({ licenceModel: 'ELITE', canPersist: false });
  const result = resolveAccess({ item, institutionId: INSTITUTION_ID, session: aSession(), loan, hold });

  const reset = () => {
    setLoan({ itemId: 'item_42', state: 'none' });
    setHold({ itemId: 'item_42', state: 'none' });
  };

  // Stands in for the four flambeau calls. Each branch is what the app would do
  // once the call came back, so the sequence is real even though the calls are not.
  const onAction = (action: string) => {
    setLog(action);
    if (action === 'grantAccess') {
      setHold(
        othersAhead
          ? { itemId: 'item_42', state: 'queued', position: 4, queueLength: 11 }
          : { itemId: 'item_42', state: 'offered', offerExpiresAt: '2026-08-17T10:30:00Z' },
      );
    }
    if (action === 'acceptOffer') {
      setHold({ itemId: 'item_42', state: 'none' });
      setLoan({ itemId: 'item_42', state: 'active' });
    }
    // Reject and Revoke both land back at the start: one gives up a place in the
    // queue, the other gives up a copy, and from the button's point of view the
    // title is simply unheld again.
    if (action === 'rejectOffer' || action === 'revokeLicence') reset();
  };

  return (
    <View style={styles.group}>
      <Text style={styles.label}>
        Elite, end to end. Tap through it — Request access, then Accept or Reject, then Revoke.
      </Text>

      <View style={styles.switchRow}>
        <Switch value={othersAhead} onValueChange={setOthersAhead} />
        <Text style={styles.caption}>
          {othersAhead
            ? 'Others ahead — Request access will queue you and show a position'
            : 'Queue empty — Request access offers the copy straight back'}
        </Text>
      </View>

      <View style={styles.badgeRow}>
        <AccessTierBadge tier={result.tier} />
        <Text style={styles.caption}>last tapped: {log}</Text>
      </View>

      <Resolved result={result} />

      {/* What a queued reader actually sees, and the gap this surfaces: the bar
          resolves to nothing, so SOMETHING has to render the position. Today that
          is this line in a gallery and nowhere in the app. */}
      {result.state === 'queued' && (
        <Text style={styles.position}>
          You are {result.queuePosition} of {result.queueLength} in the queue
        </Text>
      )}

      <ActionBar actions={result.actions} onAction={onAction} />

      {result.actions.length === 0 && result.state === 'queued' && (
        <Text style={styles.caption}>
          (No bar above — correct. There is nothing for a waiting reader to tap.)
        </Text>
      )}
    </View>
  );
}

export default function ResolveAccessGallery() {
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>resolveAccess</Text>
      <Text style={styles.caption}>
        Inputs are literals; every answer below came out of the real resolver.
      </Text>

      <EliteWalkthrough />

      <Text style={styles.caption}>Every row of the access table</Text>

      {CASES.map(({ caption, item, session, loan, hold }) => {
        const result = resolveAccess({ item, institutionId: INSTITUTION_ID, session, loan, hold });
        return (
          <View key={caption} style={styles.group}>
            <Text style={styles.label}>{caption}</Text>
            <View style={styles.badgeRow}>
              <AccessTierBadge tier={result.tier} />
            </View>
            <Resolved result={result} />
            {result.actions.length === 0 ? (
              <View style={styles.emptyProof} />
            ) : (
              <ActionBar actions={result.actions} onAction={() => undefined} />
            )}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { padding: space.md, gap: space.lg, paddingBottom: space.xl },
  heading: {
    fontWeight: type.sectionHeader.weight,
    fontFamily: type.sectionHeader.fontFamily,
    fontSize: type.sectionHeader.size,
    lineHeight: type.sectionHeader.lineHeight,
    color: color.textPrimary,
  },
  group: { gap: space.sm },
  label: {
    fontWeight: type.body.weight,
    fontFamily: type.body.fontFamily,
    fontSize: type.body.size,
    lineHeight: type.body.lineHeight,
    color: color.textPrimary,
  },
  caption: {
    fontWeight: type.meta.weight,
    fontFamily: type.meta.fontFamily,
    fontSize: type.meta.size,
    lineHeight: type.meta.lineHeight,
    color: color.textSecondary,
  },
  mono: {
    fontWeight: type.meta.weight,
    fontFamily: type.meta.fontFamily,
    fontSize: type.meta.size,
    lineHeight: type.meta.lineHeight,
    color: color.primary,
  },
  resolved: {
    gap: space.xs,
    padding: space.sm,
    borderRadius: radius.card,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.border,
  },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  position: {
    fontWeight: type.body.weight,
    fontFamily: type.body.fontFamily,
    fontSize: type.body.size,
    lineHeight: type.body.lineHeight,
    color: color.textPrimary,
  },
  // A dashed box that stays visible when the bar renders nothing, so "resolved to
  // no buttons" reads as an answer rather than as a missing row.
  emptyProof: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: color.border,
    height: space.xl,
  },
});
