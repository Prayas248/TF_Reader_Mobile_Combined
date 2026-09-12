// Screen 10 — Profile and settings.
//
// THE ACCOUNT HEADER IS BUILT, BUT ITS NAME AND EMAIL ARE NOT AVAILABLE, and the
// difference between those two statements is the whole of this comment. The plan
// says "name, email and avatar from flambeau's GET /api/v1/auth/me". Taking that
// apart against what actually exists:
//
//   THE AVATAR NEEDS NO DATA. The mockup's avatar is a generic person glyph on a
//   teal disc, not a photograph — there is no avatar URL in it to fetch. So it is
//   drawn here as designed, and nothing is faked by drawing it.
//
//   THE NAME AND EMAIL HAVE NO SOURCE. THE CONTRACT HAS NO SUCH FIELDS —
//   `AuthMeResponse` requires exactly `userId, type, roles, collections,
//   expiresAt, serverTime`, with an optional `institutionId`. There is no
//   name, no email and no avatar anywhere in it, and the endpoint's own
//   description says every field is copied from the validated token. A
//   display name cannot be derived from `user_9c2`. That is a question for
//   flambeau, not grounds to invent one.
//
// SESSION IS REAL NOW — sessionStore, ApiAuthClient and institutionSignIn.ts's
// beginSamlSignIn are wired end to end, so `isAuthenticated`/`userId`/
// `institutionId` below read the actual signed-in state, not a stub. What
// remains missing is only what reason #1 above says: a name and an email.
// So the block shows the institution or the userId where a name would go —
// the same layout, holding an honest line rather than an invented one.
//
// IT IS LAID OUT INLINE RATHER THAN AS A COMPONENT. It has exactly one caller and
// no variants, so a shared component would be the speculative one CONVENTIONS §10
// rules out, and a screen-local copy is what §7 forbids. Screen composition it is.
//
// THE TOP IDENTITY CARD IS DISPLAY ONLY, ON PURPOSE — CONFIRMED, NOT AN OVERSIGHT.
// An institutional session merges what used to be two separate blocks (a plain
// "account" header plus a `InstitutionRow` underneath it, both rendering the
// same institution) into the one card the Sept 2026 mockup shows: crest, name,
// "Institutional access", an "Active access" pill and the address. It carries
// no `onPress` and draws no chevron. `Change institution` is a real,
// already-working destination — `InstitutionListScreen` — but it stays a
// SEPARATE row below the card rather than the card's own tap target, because a
// reader who taps the card to see "who am I signed in as" and one who taps a
// button to change that are two different intents, and the mockup draws them
// as two different rows for exactly that reason. Same story for the personal
// (OIDC) card: there is no "Account details" screen in this app and no name or
// email to show one even if there were (see the note above on `AuthMeResponse`),
// so it is drawn without a chevron too — a fake affordance pointing at nothing
// is worse than an honest, static card.
//
// THE SEPT 2026 "PREMIUM EDITORIAL" PASS, AND WHAT IT DID AND DID NOT TOUCH.
// The page title and both group headings now go through `editorialTitle`/
// `SectionHeader emphasis="editorial"` — the exact Aleo treatment
// CatalogueScreen's own hero and shelf headings already use, reused rather
// than reinvented so this screen reads as the same application. Every row
// icon sits in a light `rowIcon()` container, scoped to this screen's own
// composition (see that function's comment) rather than changed inside the
// shared `ListRow`, which `AccessibilityScreen` and `ReaderPreferencesScreen`
// also render through and which this pass does not touch.
//
// "STATIC" IS A GENUINELY DIFFERENT ROW FROM "DISABLED", NOT A RELABELLING.
// Download & Offline, Notifications, Privacy & Security and About T&F Reader
// have no destination and never did — they are `variant="static"` (full
// opacity, no chevron, not Pressable at all; see `ListRow.tsx`'s own note).
// Reading Preferences and Accessibility, in contrast, push real, already-
// working screens (`ReaderPreferencesScreen`, `AccessibilityScreen`) and stay
// `variant="chevron"` — confirmed explicitly rather than assumed, because an
// earlier draft of this pass's own brief asked for all five to go static on
// the mistaken premise that none of them had a destination.
import { useCallback, type ReactNode } from 'react';
import { useNavigation, type CompositeNavigationProp } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { InstitutionRow } from '@components/InstitutionRow';
import { ListRow } from '@components/ListRow';
import { PrimaryButton } from '@components/PrimaryButton';
import { SectionHeader } from '@components/SectionHeader';
import { deleteRefreshToken } from '@store/secureStorage';
import { useInstitutionStore } from '@store/institutionStore';
import { usePendingIntentStore } from '@store/pendingIntentStore';
import { useSessionStore } from '@store/sessionStore';
import type { ProfileStackParamList, RootTabParamList } from '@navigation/types';
import { color, radius, space, type } from '@theme/tokens';
import { getInitials } from '@utils/initials';

// This screen navigates in two directions, so the type composes two props.
// Same shape as SearchScreen, which has the same problem: its own stack first,
// then the tab prop.
//
//   ProfileStack   ReaderPreferences, pushed onto this screen's own stack
//   Tab            nested screens in sibling tabs (InstitutionList in Catalogue)
type Nav = CompositeNavigationProp<
  NativeStackNavigationProp<ProfileStackParamList, 'ProfileHome'>,
  BottomTabNavigationProp<RootTabParamList, 'Profile'>
>;

// Composed from the spacing scale rather than written as 20, so no bare number
// reaches a style or a size prop (CONVENTIONS §5) — the same trick as
// `HEIGHT = space.xl + space.md` in ActionButton. The value is unchanged; it is
// now traceable to the scale.
const SETTING_ICON_SIZE = space.md + space.xs;

// Every row icon on this screen sits in the same light, neutral container —
// the Sept 2026 redesign's "icon in a subtle container" language, scoped to
// this screen's own composition rather than `ListRow` itself: Accessibility
// and Reader Preferences also render through `ListRow` and were not part of
// this redesign, so the container is built here and handed to `ListRow`'s
// existing `icon` prop rather than changed inside that shared component.
function rowIcon(node: ReactNode) {
  return <View style={styles.rowIconContainer}>{node}</View>;
}

// Avatar sizes composed from the spacing scale rather than written as numbers.
// Matched to InstitutionRow's own CREST_SIZE rather than invented — the avatar
// and a crest are the same job, "identity glyph beside a name", so they read at
// the same scale wherever they appear.
const AVATAR_SIZE = space.xl + space.md;
const AVATAR_GLYPH_SIZE = space.md + space.xs;

// Larger than AVATAR_SIZE, and deliberately its own constant rather than a
// resize of it: on explicit request, the institution logo reads as the
// card's own visual anchor — vertically centered against the whole card,
// not just the name line beside it — so it earns a size the shared,
// smaller person-glyph avatar does not need.
const INSTITUTION_LOGO_SIZE = space.xl * 2;

export default function ProfileScreen() {
  const navigation = useNavigation<Nav>();

  const selectedInstitution = useInstitutionStore((s) => s.selectedInstitution);
  const clearSelectedInstitution = useInstitutionStore((s) => s.clearSelectedInstitution);
  const clearSession = useSessionStore((s) => s.clearSession);
  const isAuthenticated = useSessionStore((s) => s.isAuthenticated);
  const sessionUserId = useSessionStore((s) => s.userId);
  const sessionInstitutionId = useSessionStore((s) => s.institutionId);
  const clearPendingIntent = usePendingIntentStore((s) => s.clear);

  const handleChangeInstitution = useCallback(() => {
    // Screen 06 is the institution list, and it lives in the Catalogue stack as
    // `InstitutionList` — the same route CatalogueScreen's picker pushes. React
    // Navigation resolves cross-tab routes by switching to the owning tab first,
    // then pushing the screen.
    navigation.navigate('Catalogue', { screen: 'InstitutionList' });
  }, [navigation]);

  // Pushed onto this screen's own stack, so no tab or nested target is named —
  // unlike `handleChangeInstitution` above, which crosses into Catalogue.
  const handleReadingPreferences = useCallback(() => {
    navigation.navigate('ReaderPreferences');
  }, [navigation]);

  // Pushed onto this screen's own stack, same as Reading Preferences above —
  // a separate destination rather than a section of that screen, see the
  // header comment on AccessibilityScreen.tsx.
  const handleAccessibility = useCallback(() => {
    navigation.navigate('Accessibility');
  }, [navigation]);

  // WHY THE PENDING INTENT IS CLEARED FIRST, on both of these. An intent is set by
  // the access gate to mean "resume this item once you are signed in", and
  // PersonalAccountScreen replays it with `popTo('ItemDetail')`. There is no
  // ItemDetail in the Profile stack, so a leftover intent from an abandoned gate
  // visit would send the reader to a route that does not exist here. Signing in
  // from Profile is not resuming anything, and this says so.
  const handleSignIn = useCallback(() => {
    clearPendingIntent();
    navigation.navigate('SignInMethod');
  }, [clearPendingIntent, navigation]);

  // Straight to the form, skipping the method chooser: an institution already owns
  // its readers' accounts, so there is nothing to create on the SAML side and no
  // choice to offer here.
  const handleSignUp = useCallback(() => {
    clearPendingIntent();
    navigation.navigate('PersonalAccount', { mode: 'signUp' });
  }, [clearPendingIntent, navigation]);

  const handleSignOut = useCallback(async () => {
    // ORDER: session first, institution second, refresh token third, then
    // navigate. clearSession() drops the access token immediately so any
    // in-flight request that resolves after this sees no token.
    // clearSelectedInstitution() rescopes the catalogue before it mounts, so
    // it never flashes the wrong institution. deleteRefreshToken() removes
    // the one credential that would otherwise let a cold start sign back in
    // without the reader asking to.
    clearSession();
    clearSelectedInstitution();
    await deleteRefreshToken();
    navigation.navigate('Catalogue', { screen: 'CatalogueHome' });
  }, [clearSession, clearSelectedInstitution, navigation]);

  // Only reached by the two branches below that still use it — a signed-out
  // reader and a personal (OIDC) one. An institutional reader's card reads
  // `selectedInstitution` directly, never this pair. There is still no name or
  // email in AuthMeResponse (see the note at the top of this file), so a
  // personal reader gets the identifier the stub carries — never an invented
  // display name.
  let accountName = 'Not signed in';
  let accountCaption = 'Sign in to sync your library';
  if (isAuthenticated) {
    accountName = sessionUserId ?? 'Signed in';
    accountCaption = 'Individual account';
  }

  // The one condition that decides which identity card renders. Chained rather
  // than split into named booleans: TypeScript narrows `selectedInstitution` to
  // non-null inside the JSX branch this guards, which a precomputed boolean
  // would throw away.
  const institutionalSession =
    isAuthenticated && sessionInstitutionId !== null && selectedInstitution !== null;

  // A TINTED CARD, NOT A PLAIN LIST ROW — on explicit instruction to match the
  // light-blue "Change institution" card the mockup draws, not `ListRow`'s
  // own plain-white, hairline-separated look. Built here rather than as a
  // `ListRow` variant because the visual container itself differs (a rounded,
  // coloured card versus a flat list row), and there is exactly one real
  // caller for it — both places `selectedInstitution !== null` below reuse
  // this same element rather than a second, near-identical copy.
  const changeInstitutionAction = (
    <Pressable
      onPress={handleChangeInstitution}
      style={styles.actionCard}
      accessibilityRole="button"
      accessibilityLabel="Change institution"
    >
      <View style={styles.rowIconContainer}>
        <Ionicons name="sync-outline" size={SETTING_ICON_SIZE} color={color.primary} />
      </View>
      <Text style={styles.actionCardLabel}>Change institution</Text>
      <Ionicons name="chevron-forward" size={20} color={color.primary} />
    </Pressable>
  );

  return (
    // Scrolls because the row count is fixed and already taller than a small
    // handset — the settings block, sign out and the dev entry cannot all fit.
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.pageHeader}>
        <Text style={styles.pageTitle}>Profile</Text>
        <Text style={styles.pageSubtitle}>
          Manage your account, access and reading preferences.
        </Text>
      </View>

      {institutionalSession && selectedInstitution !== null ? (
        <>
          {/* THE MERGED, NON-INTERACTIVE IDENTITY CARD — see the file header
              note on why this carries no `onPress` and draws no chevron.
              `Change institution` below is the one real, working
              destination for this information. */}
          <View style={styles.identityCard}>
            <View style={styles.identityCardRow}>
              {/* The logo is a sibling of the whole text column now, not just
                  the name line beside it — on explicit request, so it reads
                  as the card's own visual anchor, vertically centered against
                  the full card (`identityCardRow`'s own `alignItems: 'center'`
                  does that centering), rather than pinned to the top row. */}
              {selectedInstitution.branding !== undefined ? (
                <Image
                  source={{ uri: selectedInstitution.branding.logoUrl }}
                  style={styles.institutionAvatar}
                  resizeMode="contain"
                  accessibilityLabel={`${selectedInstitution.name} logo`}
                />
              ) : (
                <View style={styles.institutionAvatar}>
                  <Text style={styles.institutionAvatarInitials}>
                    {getInitials(selectedInstitution.name)}
                  </Text>
                </View>
              )}

              <View style={styles.identityCardMain}>
                <View style={styles.accountText}>
                  <Text style={styles.accountName}>{selectedInstitution.name}</Text>
                  <Text style={styles.accountMeta}>Institutional access</Text>
                </View>

                {/* "Active access" is not a fetched flag — this branch already
                    requires a real, current session scoped to this institution,
                    so the line states a fact this render is conditioned on
                    rather than one it looks up. */}
                <View style={styles.identitySubRow}>
                  <Ionicons name="checkmark-circle" size={type.smallLabel.size} color={color.success} />
                  <Text style={styles.activeAccessLabel}>Active access</Text>
                </View>

                {/* The address is real data shown twice in two roles: the
                    headline above names the institution to identify it, this
                    line names it again to place it — the same pairing
                    `InstitutionRow` and `InstitutionDetailView` already show
                    as name-then-country elsewhere in this app. */}
                <View style={styles.identitySubRow}>
                  <Ionicons
                    name="business-outline"
                    size={type.smallLabel.size}
                    color={color.textSecondary}
                  />
                  <View>
                    <Text style={styles.institutionAddress}>{selectedInstitution.name}</Text>
                    <Text style={styles.institutionAddress}>{selectedInstitution.country}</Text>
                  </View>
                </View>
              </View>
            </View>
          </View>

          {changeInstitutionAction}
        </>
      ) : (
        <>
          {/* Account header — see the note at the top of this file for why the
              name slot reads the way it does and why there is no email line
              yet. Also carries no `onPress` for the personal-account case —
              see the file header note. Same shape as the institutional card
              above: the avatar is a sibling of the text column, not inline
              with just the name, and a decorative chevron sits opposite it. */}
          <View style={styles.identityCard}>
            <View style={styles.identityCardRow}>
              {/* Decorative: a generic glyph standing in for a person, carrying
                  no information a screen reader needs. Hidden from the
                  accessibility tree on both platforms, the way VoiceOverlay
                  hides its own. */}
              <View
                testID="profile-avatar"
                style={styles.avatar}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                <Ionicons name="person" size={AVATAR_GLYPH_SIZE} color={color.white} />
              </View>

              <View style={styles.identityCardMain}>
                <Text style={styles.accountName}>{accountName}</Text>

                {/* "Individual account" is the one real fact this session
                    carries beyond the identifier above — no email line
                    beside the name, because there is no email to show (see
                    the file header note on `AuthMeResponse`). */}
                {isAuthenticated && (
                  <View style={styles.identitySubRow}>
                    <Ionicons name="person-outline" size={type.smallLabel.size} color={color.textSecondary} />
                    <Text style={styles.institutionAddress}>{accountCaption}</Text>
                  </View>
                )}
              </View>

              {isAuthenticated && (
                <Ionicons name="chevron-forward" size={20} color={color.textSecondary} />
              )}
            </View>

            {/* THE TWO WAYS IN, side by side and matched — both `outlined`, no
                icons, each stretched to fill half the row so the pair spans the
                header the way the mockup does. `size="compact"` is what keeps
                that full-width pair from reading as heavy as the settings list
                below it — PrimaryButton's default height is ActionButton's own
                44pt target, right for a page's main action; this is a header
                prompt, so it takes the smaller size FilterChip already
                established for exactly that case (see PrimaryButton.tsx). They
                sit inside the account block rather than the settings list below:
                they belong to the account, not to a setting. Sign-up is the
                personal path only — see handleSignUp. */}
            {!isAuthenticated && (
              <View style={styles.authActions}>
                <View style={styles.authAction}>
                  <PrimaryButton
                    testID="profile-sign-in"
                    label="Sign in"
                    emphasis="outlined"
                    size="compact"
                    onPress={handleSignIn}
                  />
                </View>
                <View style={styles.authAction}>
                  <PrimaryButton
                    testID="profile-sign-up"
                    label="Create account"
                    emphasis="outlined"
                    size="compact"
                    onPress={handleSignUp}
                  />
                </View>
              </View>
            )}
          </View>

          {/* Only for a signed-out reader — see the file header note on why a
              personal (OIDC) session drops this section entirely rather than
              showing it empty: that mode has no institution to scope. */}
          {!isAuthenticated && (
            <View style={styles.section}>
              <View style={styles.sectionHeaderInset}>
                <SectionHeader title="Institution" emphasis="editorial" />
              </View>
              {selectedInstitution !== null && (
                <>
                  {/* Crest and name come from the store, and `InstitutionRow`
                      already renders exactly that pair with the initials
                      fallback for an institution with no branding asset
                      (W-17). A second component that draws a crest would be
                      the copy CONVENTIONS §7 forbids. */}
                  <InstitutionRow
                    institution={selectedInstitution}
                    onPress={handleChangeInstitution}
                  />
                  {changeInstitutionAction}
                </>
              )}
            </View>
          )}
        </>
      )}

      {/* TWO GENUINELY DIFFERENT KINDS OF ROW BELOW, NOT ONE "DISABLED" LIST —
          the Sept 2026 redesign's whole point. A row with a real destination
          (Reading Preferences, Accessibility) is `variant="chevron"`,
          actionable, unremarkable. A row with NO destination at all
          (Download & Offline, Notifications, Privacy & Security, About T&F
          Reader) is `variant="static"` — informational, full opacity, no
          chevron, no ripple, no `disabled` styling, because there was never
          an action for `disabled` to grey out. See `ListRow.tsx`'s own note
          on why that variant skips `Pressable` entirely rather than reusing
          `disabled`.

            · Reading Preferences and Accessibility have real destinations —
              `ReaderPreferences` and `Accessibility` on this screen's own
              stack — confirmed still live for this redesign.
            · Download & Offline still belongs to t4targaryen's reader, and
              there is no sub-screen on our side for it.
            · Notifications has no backing setting anywhere in the app —
              drawn with no switch now, rather than one that would silently
              do nothing when flipped.
            · Privacy & Security has no destination.
            · About T&F Reader has no destination either, and its version
              string has no source we can read without adding
              `expo-constants` as a declared dependency — a dependency
              decision, not this screen's. The row is drawn without the
              number rather than with an invented one. */}
      <View style={styles.section}>
        <View style={styles.sectionHeaderInset}>
          <SectionHeader title="Reader experience" emphasis="editorial" />
        </View>
        {/* ONE ROUNDED CARD PER GROUP, not three flat edge-to-edge rows — on
            explicit instruction to club the group's rows together the way
            the mockup does. `overflow: 'hidden'` is what clips `ListRow`'s
            own square corners to this wrapper's `radius.sheet`; the rows
            keep their own internal hairline separators unchanged. */}
        <View style={styles.groupCard}>
          <ListRow
            title="Reading Preferences"
            subtitle="Font size, theme"
            variant="chevron"
            emphasis="editorial"
            onPress={handleReadingPreferences}
            icon={rowIcon(<Ionicons name="book-outline" size={SETTING_ICON_SIZE} color={color.primary} />)}
          />
          <ListRow
            title="Accessibility"
            subtitle="Text, display and screen reader options"
            variant="chevron"
            emphasis="editorial"
            onPress={handleAccessibility}
            icon={rowIcon(
              <Ionicons name="accessibility-outline" size={SETTING_ICON_SIZE} color={color.primary} />,
            )}
          />
          <ListRow
            title="Download & Offline"
            subtitle="Wi-Fi only, storage location"
            variant="static"
            emphasis="editorial"
            icon={rowIcon(
              <Ionicons name="download-outline" size={SETTING_ICON_SIZE} color={color.primary} />,
            )}
          />
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeaderInset}>
          <SectionHeader title="Preferences & system" emphasis="editorial" />
        </View>
        <View style={styles.groupCard}>
          <ListRow
            title="Notifications"
            subtitle="Hold notices, new content, updates"
            variant="static"
            emphasis="editorial"
            icon={rowIcon(
              <Ionicons name="notifications-outline" size={SETTING_ICON_SIZE} color={color.primary} />,
            )}
          />
          <ListRow
            title="Privacy & Security"
            subtitle="Manage your data and security"
            variant="static"
            emphasis="editorial"
            icon={rowIcon(
              <Ionicons
                name="shield-checkmark-outline"
                size={SETTING_ICON_SIZE}
                color={color.primary}
              />,
            )}
          />
          <ListRow
            title="About T&F Reader"
            subtitle="Version, legal terms"
            variant="static"
            emphasis="editorial"
            icon={rowIcon(
              <Ionicons
                name="information-circle-outline"
                size={SETTING_ICON_SIZE}
                color={color.primary}
              />,
            )}
          />
        </View>
      </View>

      {/* A centred, light-red CARD, not a `ListRow` — the mockup centres the
          icon and label together rather than left-aligning them the way
          every other row on this screen does, which `ListRow`'s own layout
          has no variant for. Built inline for the same single-real-caller
          reason `changeInstitutionAction` is: this is the one row on the
          screen with this shape. `errorTint`/`error` is the same "light
          background, saturated foreground" pairing `subscriptionTint`
          already establishes for a badge, reused here for a row instead. */}
      {(isAuthenticated || selectedInstitution !== null) && (
        <Pressable
          onPress={handleSignOut}
          style={styles.signOut}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
        >
          <Ionicons name="log-out-outline" size={SETTING_ICON_SIZE} color={color.error} />
          <Text style={styles.signOutLabel}>Sign out</Text>
        </Pressable>
      )}

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // WHITE PAGE, TINTED ROWS — and this is a fix, not a preference. `ListRow`
  // paints itself `color.surface`, and this page was painting itself
  // `color.surface` too. That was invisible while `surface` was #F8F9FA, because
  // near-white on near-white still reads as one continuous sheet and the
  // hairlines did all the work. The brand palette makes `surface` #EBF0FF
  // Cornflower Neutral, and identical-on-identical is now a settings list with
  // no visible rows at all — see the emulator against the mockup.
  //
  // The page takes `white` and the rows keep `surface`, which is what tokens.ts
  // already says `surface` is for: "cards, section backgrounds". The rows are
  // the cards. The page showing through between the sections is what makes each
  // group read as a group, so the section gaps below are load-bearing now
  // rather than decorative.
  container: {
    flex: 1,
    backgroundColor: color.white,
  },
  content: {
    paddingBottom: space.xl,
  },
  // Shared by both the institutional and the personal/signed-out card — one
  // style, because the mockup gives both the same block treatment (crest- or
  // avatar-and-name row, then whatever comes under it: a badge and address for
  // an institution, the sign-in buttons for signed-out). `md` vertical padding
  // rather than `lg` — this is a compact header, the same weight as a ListRow's
  // own padding, not a hero banner.
  // Rounded, standalone card — bordered rather than shadowed, on the
  // redesign's own instruction ("a subtle border rather than a heavy
  // shadow"). `marginHorizontal` is new: the card used to run edge-to-edge
  // with a bottom hairline dividing it from the settings list below;
  // matching the mockup's floating card meant giving it a border and margin
  // on every side instead, not just the bottom.
  identityCard: {
    gap: space.sm,
    marginHorizontal: space.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    backgroundColor: color.surface,
    borderRadius: radius.sheet,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  accountIdentity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  pageHeader: {
    paddingHorizontal: space.md,
    paddingTop: space.md,
    paddingBottom: space.sm,
    gap: space.xs,
  },
  // `editorialTitle` — the exact Aleo Bold treatment CatalogueScreen's own
  // hero headline uses, reused rather than a bespoke size so "Profile" reads
  // as the same kind of heading elsewhere in the app. `fontWeight` is
  // deliberately absent: resolveFont.ts's own warning is that pairing an
  // explicit weight with a loaded Aleo family makes Android substitute the
  // system typeface instead of using the font that was just registered.
  pageTitle: {
    fontFamily: type.editorialTitle.fontFamily,
    fontSize: type.editorialTitle.size,
    lineHeight: type.editorialTitle.lineHeight,
    color: color.textPrimary,
  },
  // Aleo Light family, `body`'s own size/lineHeight — composed the same way
  // `SectionHeader`'s `titleEditorial` composes `cardTitle`'s family with a
  // different token's size, so the subtitle reads at a normal supporting-text
  // size rather than `editorialMeta`'s smaller caption scale.
  pageSubtitle: {
    fontFamily: type.editorialMeta.fontFamily,
    fontSize: type.body.size,
    lineHeight: type.body.lineHeight,
    color: color.textSecondary,
  },
  // A circle, same shape as the plain person-glyph avatar below, but its own
  // size (INSTITUTION_LOGO_SIZE, not AVATAR_SIZE) and centred against the
  // whole card by `identityCardRow`'s `alignItems: 'center'` rather than
  // pinned beside just the name line — both on explicit request.
  institutionAvatar: {
    width: INSTITUTION_LOGO_SIZE,
    height: INSTITUTION_LOGO_SIZE,
    borderRadius: radius.pill,
    backgroundColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Sized against the bigger circle above — `type.button`'s 15px read as a
  // dot inside a 64px initials circle. Aleo Bold, matching the rest of this
  // screen's headings.
  institutionAvatarInitials: {
    fontFamily: type.editorialTitle.fontFamily,
    fontSize: type.pageTitle.size,
    lineHeight: type.pageTitle.lineHeight,
    color: color.textSecondary,
  },
  // The card's own row: the logo, then the text column. `alignItems: 'center'`
  // is doing real work here — the text column is far taller than the logo
  // circle, and centering the row against it is what lands the logo at the
  // card's vertical middle without a hand-placed offset.
  identityCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  // `marginLeft: space.lg`, on top of the row's own `gap`, is the "move the
  // text right" half of the same request that made the logo bigger — extra
  // breathing room between a now-larger circle and the column beside it.
  identityCardMain: {
    flex: 1,
    gap: space.sm,
    marginLeft: space.lg,
  },
  // Shared by the "Active access" line and the address line below it — both
  // pair a small leading icon with text the same way. No left indent needed:
  // the logo is no longer inline with the name, so this column's own left
  // edge already lines up with the name above it.
  identitySubRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.xs,
  },
  // No pill fill — `AccessTierBadge` draws a solid tier pill because a tier is
  // an attribute of the ITEM being offered; this is a fact about the SESSION,
  // read as plain icon-and-text status rather than a badge, so it does not
  // borrow that component's vocabulary for something that is not a tier.
  // Aleo Light family, `smallLabel`'s own size — same composition pattern as
  // `pageSubtitle` above.
  activeAccessLabel: {
    fontFamily: type.editorialMeta.fontFamily,
    fontSize: type.smallLabel.size,
    lineHeight: type.smallLabel.lineHeight,
    color: color.success,
  },
  institutionAddress: {
    fontFamily: type.editorialMeta.fontFamily,
    fontSize: type.editorialMeta.size,
    lineHeight: type.editorialMeta.lineHeight,
    color: color.textSecondary,
  },
  // Side by side, not stacked — two full-height buttons stacked would double
  // the block's height. `flex: 1` on each of `authAction` below splits the
  // row evenly, so the pair spans the header the way the mockup does.
  authActions: {
    flexDirection: 'row',
    gap: space.sm,
  },
  authAction: {
    flex: 1,
  },
  avatar: {
    width: AVATAR_SIZE,
    height: AVATAR_SIZE,
    // A fixed-size square at pill radius is a circle; React Native clamps the
    // radius to half the side, so this needs no derived number.
    borderRadius: radius.pill,
    backgroundColor: color.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  accountText: {
    flex: 1,
    gap: space.xs / 2,
  },
  // sectionHeader's own size — the avatar dropped from a hero size to
  // CREST_SIZE, and a 24px heading next to a 48px glyph reads top-heavy. This
  // is a name label beside an icon, the same weight InstitutionRow gives its
  // own institution name. Aleo Bold family, on the same page-wide instruction
  // as `pageTitle`.
  accountName: {
    fontFamily: type.cardTitle.fontFamily,
    fontSize: type.sectionHeader.size,
    lineHeight: type.sectionHeader.lineHeight,
    color: color.textPrimary,
  },
  accountMeta: {
    fontFamily: type.editorialMeta.fontFamily,
    fontSize: type.editorialMeta.size,
    lineHeight: type.editorialMeta.lineHeight,
    color: color.textSecondary,
  },
  // Every row icon on this screen sits in the same light, rounded-square
  // container — `radius.tile`, not `radius.pill`: the mockup's icon chip is
  // a rounded square, the same corner language `identityCard`'s own
  // `radius.sheet` scales down from, not a circle.
  rowIconContainer: {
    width: space.xl,
    height: space.xl,
    borderRadius: radius.tile,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The tinted, rounded card the mockup draws for `changeInstitutionAction`,
  // deliberately not `ListRow`'s own plain white hairline-separated look (see
  // the note beside that element's own definition for why).
  // `marginTop: space.sm`, not `space.md` — the gap under the identity card
  // read as too large once the card itself stopped carrying a bottom
  // hairline/margin of its own (see `identityCard`'s note), so this is now
  // the ONLY gap between the two, and it stays deliberately tight.
  actionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.md,
    marginTop: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    backgroundColor: color.surface,
    borderRadius: radius.sheet,
  },
  actionCardLabel: {
    flex: 1,
    fontFamily: type.cardTitle.fontFamily,
    fontSize: type.body.size,
    lineHeight: type.body.lineHeight,
    color: color.textPrimary,
  },
  section: {
    marginTop: space.lg,
  },
  // `SectionHeader` sets no outer padding of its own — its doc says the
  // parent owns where it sits — but `section` above only ever set a vertical
  // margin, so the heading rendered flush against the screen edge while
  // `groupCard`/`actionCard` below it carry their own `marginHorizontal:
  // space.md`. This lines the heading up with everything under it.
  sectionHeaderInset: {
    paddingHorizontal: space.md,
  },
  // Clubs a group's rows into one bordered, rounded surface instead of three
  // flat edge-to-edge ones — see the note beside its own JSX for why
  // `overflow: 'hidden'` is load-bearing here rather than decorative.
  groupCard: {
    marginHorizontal: space.md,
    marginTop: space.sm,
    borderRadius: radius.sheet,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    overflow: 'hidden',
  },
  // A centred, light-red card rather than `ListRow`'s left-aligned layout —
  // see the note beside this element's own JSX for why it is built inline.
  // Sign out is not the sixth setting, and on a white page the gap and the
  // tint both say so: `xl` margin rather than the sections' `lg`, which is
  // how far the mockup holds it off the list above it.
  signOut: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: space.sm,
    marginHorizontal: space.md,
    marginTop: space.xl,
    paddingVertical: space.md,
    backgroundColor: color.errorTint,
    borderRadius: radius.sheet,
  },
  signOutLabel: {
    fontFamily: type.cardTitle.fontFamily,
    fontSize: type.button.size,
    lineHeight: type.button.lineHeight,
    color: color.error,
  },
});
