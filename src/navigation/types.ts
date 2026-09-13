// Route param types for the entire navigation tree — P0-6 (Keshav)
// Keep in sync with RootNavigator.tsx. If a param changes here, update the navigator.
import type { NavigatorScreenParams } from '@react-navigation/native';
import type { BookId, ContentFormat } from '@/shared/contracts';
import type { ReaderTarget } from '@/features/reader/readerBridge';
import type { NavLink, WorkType } from '@model/types';

/**
 * Carried only when ItemDetail is reached from the journal drill-down —
 * absent for an ordinary book/audiobook push. `workType: 'article'` is what
 * makes ItemDetailScreen render screen 04 instead of falling back to screen
 * 05 (Publication.workType is never 'article' — wokay's @type enum has no
 * value for it yet, Q-1b). `articleContext` supplies the journal/volume/issue
 * names for screen 04's context line — a Publication has no parent-journal
 * reference of its own, so this is display data the caller already has,
 * exactly like Shelf's own `title` param.
 */
export interface ArticleContext {
  journalTitle: string;
  volumeTitle?: string;
  issueTitle?: string;
}

/**
 * Which form PersonalAccountScreen shows. It rides in the route params rather than
 * the screen's own state so the header title and the form cannot disagree.
 */
export type PersonalAccountMode = 'signIn' | 'signUp';

/** Root stack wraps the tab navigator + the dev Gallery modal. */
export type RootStackParamList = {
  // Typed as NavigatorScreenParams (not `undefined`) so StartupGate's "Sign
  // In" tap can deep-link straight to Profile's SignInMethod chooser —
  // `navigate('Main', { screen: 'Profile', params: { screen: 'SignInMethod' } })`.
  Main: NavigatorScreenParams<RootTabParamList> | undefined;
  Gallery: undefined;
  // Screen 00b — raised once, right after splash, when nobody is signed in.
  // Registered at the root rather than per-tab-stack (unlike AccessGate/SignIn)
  // because it isn't reached from any specific item or tab — it's a startup
  // interruption over whichever tab root the reader lands on.
  StartupGate: undefined;
};

/** Four bottom tabs. */
export type RootTabParamList = {
  // NavigatorScreenParams allows cross-tab navigation with a nested screen target,
  // e.g. navigation.navigate('Catalogue', { screen: 'InstitutionList' }) from Profile.
  Catalogue: NavigatorScreenParams<CatalogueStackParamList> | undefined;
  Search: undefined;
  Library: undefined;
  // NavigatorScreenParams, same reason Catalogue is: StartupGate's "Sign In"
  // deep-links to Profile's SignInMethod screen rather than switching tabs
  // with nothing else specified.
  Profile: NavigatorScreenParams<ProfileStackParamList> | undefined;
};

/** Catalogue nested stack — has pushed detail screens. */
export type CatalogueStackParamList = {
  CatalogueHome: undefined;
  // Institution picker — CAP-3 selection flow.
  InstitutionList: undefined;
  InstitutionDetail: { institutionId: string };
  ItemDetail: { itemId: string; workType?: WorkType; articleContext?: ArticleContext };
  // Screen 02 — sign-in sheet. Institution is read from institutionStore;
  // no params needed because selection always precedes navigation here.
  SignIn: undefined;
  // Screen 03 — access gate, raised when `resolveAccess` returns
  // `requires_signin`. title/authors ride along with itemId for the same
  // reason `Shelf`'s `title` does: display data the caller already has,
  // rather than a second fetch for a value that never changes here.
  AccessGate: { itemId: string; title: string; authors: string };
  // Shelf detail — Prayas wires CategoryCard.onPress to this route (C1).
  // title is passed so the AppHeader can display it without a network call.
  //
  // `title` is the NAV ENTRY's label, not the shelf feed's own title: the two
  // legitimately differ (the "Open access" nav entry points at a shelf the feed
  // titles "Free to read"), and only the nav label is known at push time.
  //
  // `institutionId` is a param rather than something ShelfScreen reads from the
  // store, so a caller cannot reach the screen without naming an institution.
  // A shelf only exists inside one institution's catalogue.
  Shelf: { shelfId: string; title: string; institutionId: string };
  // Journal hierarchy drill-down — Journal Details → Volumes & Issues → Issue
  // Articles → ItemDetail (screen 04). title/coverUrl are passed so the header
  // and cover render without a network call.
  Journal: { workId: string; title: string; institutionId: string; coverUrl?: string };
  // Volumes & Issues (screen 03). `volumes` is the journal's own already-
  // fetched `children` list — JournalScreen has just made this exact call, so
  // this screen makes no duplicate fetch of the same root work feed. No
  // cover — the reference layout for this screen is a plain list, not a
  // cover-led page.
  JournalVolumes: {
    journalTitle: string;
    institutionId: string;
    volumes: NavLink[];
  };
  // Issue Articles (screen 04's list). workId is the ISSUE's own work id —
  // this screen makes the one lazy getWork() call for it, same as today's
  // per-issue expand in JournalScreen used to. volumeTitle is absent when the
  // journal has no volume level (an issue sitting directly under the journal).
  JournalIssue: {
    journalTitle: string;
    institutionId: string;
    volumeTitle?: string;
    issueTitle: string;
    workId: string;
  };
  // Personal-account (OIDC) form, reached from the access gate's "Personal
  // account" card. Registered here as well as in Profile for the same reason
  // SignIn is: a flow that started in this tab finishes in it.
  PersonalAccount: { mode: PersonalAccountMode };
  // Reader engine integration seam (integration_ref.md Phase 2.1) — pushed from
  // ItemDetailScreen's 'read' action after openBook() resolves. `initialTarget` is
  // optional and orthogonal to progressStore's own resume mechanism: most callers never
  // pass it and let the reader resume from the last saved position.
  Reader: { bookId: BookId; format: ContentFormat; initialTarget?: ReaderTarget };
  // Accessibility's publication-info screen, pushed from ReaderRouteScreen's info button.
  // No `format` param — re-derived via getPublicationAccessibility's own getFormat(bookId).
  BookInfo: { bookId: BookId };
  // AUDIO's own destination — ItemDetailScreen's 'read'/'play' action pushes
  // this instead of 'Reader' when the item's format is AUDIO. A separate
  // route, not a `Reader` param, because the two screens have unrelated
  // implementations underneath (expo-audio vs. the epub.js/pdf.js WebView
  // bridge) — see AudioPlayerRouteScreen.tsx's own header.
  AudioPlayer: { bookId: BookId; title: string };
};

/** Search nested stack — shares ItemDetail shape. */
export type SearchStackParamList = {
  SearchHome: undefined;
  ItemDetail: { itemId: string; workType?: WorkType; articleContext?: ArticleContext };
  // Same reason ItemDetail is registered in both stacks: the gate can be
  // raised from either origin. SignIn and InstitutionList are registered here
  // too, for the same reason — so "Through my institution" can stay on
  // whichever tab it started on instead of jumping to Catalogue. See
  // AccessGateScreen.tsx.
  AccessGate: { itemId: string; title: string; authors: string };
  SignIn: undefined;
  InstitutionList: undefined;
  PersonalAccount: { mode: PersonalAccountMode };
  // Same reader engine seam as CatalogueStackParamList.Reader — registered here too so
  // "Read" from a Search result doesn't have to jump to the Catalogue tab.
  Reader: { bookId: BookId; format: ContentFormat; initialTarget?: ReaderTarget };
  BookInfo: { bookId: BookId };
  // Same reason as CatalogueStackParamList.AudioPlayer — see its own comment.
  AudioPlayer: { bookId: BookId; title: string };
};

/**
 * Library nested stack. `InstitutionList` is registered here for the same
 * reason it is in Search/Profile: the institution pill in `AppHeader` shows
 * on every tab-root screen now (Catalogue, Search, Library, Profile), so
 * each of their stacks needs the destination it pushes to.
 *
 * `ItemDetail` is registered for the same reason it is in Catalogue/Search:
 * tapping an item ROW anywhere in the app goes to its detail page first —
 * Library's own cards are no different, and reading itself happens from
 * that page's own ActionBar, not from a direct open on the shelf.
 *
 * `AccessGate`/`SignIn`/`PersonalAccount`/`Reader`/`BookInfo` are registered
 * here for the SAME reason they are duplicated into the Search stack rather
 * than shared from Catalogue's copy (see `SearchStackParamList`'s own
 * comment): `ItemDetail`'s "read"/"play" action pushes 'Reader' directly,
 * `ItemDetail`'s access check can raise 'AccessGate', and `AccessGate` can in
 * turn push 'SignIn'/'PersonalAccount', and 'Reader' can push 'BookInfo' —
 * every one of those routes has to exist in WHICHEVER stack pushed
 * `ItemDetail` in the first place, or navigation.navigate throws "was not
 * handled by any navigator" the moment a Library-opened book is read.
 */
export type LibraryStackParamList = {
  LibraryHome: undefined;
  InstitutionList: undefined;
  ItemDetail: { itemId: string; workType?: WorkType; articleContext?: ArticleContext };
  AccessGate: { itemId: string; title: string; authors: string };
  SignIn: undefined;
  PersonalAccount: { mode: PersonalAccountMode };
  Reader: { bookId: BookId; format: ContentFormat; initialTarget?: ReaderTarget };
  BookInfo: { bookId: BookId };
  // Same reason as CatalogueStackParamList.AudioPlayer — see its own comment.
  AudioPlayer: { bookId: BookId; title: string };
};

/** Profile stack — screen 10, plus the settings screens it pushes. */
export type ProfileStackParamList = {
  ProfileHome: undefined;
  // Reader preferences — theme, font, layout and typography, pushed from the
  // "Reading Preferences" row on screen 10.
  //
  // NO PARAMS, and that is the contract rather than a simplification: prefs are
  // a per-user SINGLETON applied across every book, not scoped per book (see
  // `src/shared/contracts/prefs.ts`, which removed `bookId` for exactly this
  // reason). There is no id to pass, so a caller cannot reach this screen with
  // the wrong one.
  ReaderPreferences: undefined;
  // Accessibility settings (Hruthik's contract) — pushed from the
  // "Accessibility" row on screen 10, beside Reading Preferences rather than
  // inside it. Same NO PARAMS reasoning as ReaderPreferences above: this is
  // also a per-user singleton with no id to pass.
  Accessibility: undefined;

  // ─── Signed-out sign-in flow, pushed from the account block on screen 10 ────
  //
  // ALL FOUR LIVE IN THIS STACK ON PURPOSE. Sending the reader to Catalogue's
  // copies would relocate them to a tab they never chose, and land them there
  // after signing in. Same argument that already registers SignIn and
  // InstitutionList in the Search stack.
  SignInMethod: undefined;
  PersonalAccount: { mode: PersonalAccountMode };
  InstitutionList: undefined;
  SignIn: undefined;
};
