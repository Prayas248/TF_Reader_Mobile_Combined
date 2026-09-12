// P0-6 — App shell and navigation (Keshav, paired with Khushi on BottomTabBar)
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackHeaderProps, NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { BottomTabBarProps as RNBottomTabBarProps } from '@react-navigation/bottom-tabs';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useInstitutionStore } from '@store/institutionStore';
import { useSessionStore } from '@store/sessionStore';
import { color, radius, space, type } from '@theme/tokens';
import QueueNotificationHost from '../features/queue/QueueNotificationHost';

import { TopAppBar } from '../components/TopAppBar';
import { BottomTabBar } from '../components/BottomTabBar';
import type { TabItem } from '../components/BottomTabBar';

// Picks between the institution catalogue and the public one — see the file.
import CatalogueHomeScreen from '../screens/CatalogueHomeScreen';
import SearchScreen from '../screens/SearchScreen';
import LibraryScreen from '../screens/LibraryScreen';
import ProfileScreen from '../screens/ProfileScreen';
import ReaderPreferencesScreen from '../screens/ReaderPreferencesScreen';
import AccessibilityScreen from '../screens/AccessibilityScreen';
import GalleryScreen from '../screens/GalleryScreen';
import InstitutionDetailScreen from '../screens/InstitutionDetailScreen';
import InstitutionListScreen from '../screens/InstitutionListScreen';
import ItemDetailScreen from '../screens/ItemDetailScreen';
import ShelfScreen from '../screens/ShelfScreen';
import SignInScreen from '../screens/SignInScreen';
import AccessGateScreen from '../screens/AccessGateScreen';
import SignInMethodScreen from '../screens/SignInMethodScreen';
import PersonalAccountScreen from '../screens/PersonalAccountScreen';

// Reader engine integration seam (integration_ref.md Phase 2.1) — the reader team's own route
// screens, mounted directly into the Catalogue/Search stacks rather than a separate flat shell.
import { ReaderRouteScreen } from './ReaderRouteScreen';
import { BookInfoRouteScreen } from './BookInfoRouteScreen';
import { AudioPlayerRouteScreen } from './AudioPlayerRouteScreen';

import type {
  RootStackParamList,
  RootTabParamList,
  CatalogueStackParamList,
  SearchStackParamList,
  LibraryStackParamList,
  ProfileStackParamList,
  PersonalAccountMode,
} from './types';

// The header echoes the form the reader is looking at, and that form comes off the
// route param, so the title is read from it rather than fixed per registration.
function personalAccountTitle(mode: PersonalAccountMode) {
  if (mode === 'signUp') return 'Create account';
  return 'Sign in';
}

const styles = StyleSheet.create({
  splash: { flex: 1, backgroundColor: color.white },
  root: { flex: 1 },
});

// A translucent fill on the header's own navy rather than a flat white pill —
// reads as part of the bar's chrome instead of a card floating on top of it.
const headerStyles = StyleSheet.create({
  institutionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255, 255, 255, 0.14)',
    maxWidth: space.xl * 5,
  },
  institutionPillLabel: {
    flexShrink: 1,
    fontFamily: type.smallLabel.fontFamily,
    fontSize: type.smallLabel.size,
    lineHeight: type.smallLabel.lineHeight,
    color: color.white,
  },
});

// ─── Navigator instances ──────────────────────────────────────────────────────

const RootStack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<RootTabParamList>();
const CatalogueStack = createNativeStackNavigator<CatalogueStackParamList>();
const SearchStack = createNativeStackNavigator<SearchStackParamList>();
const LibraryStack = createNativeStackNavigator<LibraryStackParamList>();
const ProfileStack = createNativeStackNavigator<ProfileStackParamList>();

// ─── Tab config — drives both the navigator and BottomTabBar ─────────────────

const TAB_CONFIG: TabItem[] = [
  { key: 'Catalogue', label: 'Catalogue', iconActive: 'book', iconInactive: 'book-outline' },
  { key: 'Search', label: 'Search', iconActive: 'search', iconInactive: 'search-outline' },
  { key: 'Library', label: 'Library', iconActive: 'library', iconInactive: 'library-outline' },
  { key: 'Profile', label: 'Profile', iconActive: 'person', iconInactive: 'person-outline' },
];

// ─── Header wrapper — reads safe-area inset and passes it to TopAppBar ───────

// The institution pill replaces CatalogueScreen's own in-body picker row —
// it names the scope the reader is signed in under, which belongs beside the
// brand mark, not repeated as a full-width row under it. Tab-root-only (no
// `back`): a pushed screen already has its own title in that slot.
//
// SHOWN ON ALL FOUR TAB ROOTS, ON EXPLICIT INSTRUCTION — an earlier version
// of this comment restricted it to Catalogue ("no other tab reads from an
// institution's catalogue"), but Library/Search/Profile all still act on
// behalf of the SAME signed-in institution even though they don't browse its
// feed directly, and the reader is expected to see which one they are in
// from any of the four. `InstitutionList` is registered in every stack below
// for exactly this reason.
function InstitutionPill({ name, onPress }: { name: string; onPress: () => void }) {
  return (
    <Pressable
      style={headerStyles.institutionPill}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Change institution, currently ${name}`}
    >
      <Ionicons name="business" size={14} color={color.white} />
      <Text style={headerStyles.institutionPillLabel} numberOfLines={1}>
        {name}
      </Text>
      <Ionicons name="checkmark-circle" size={14} color={color.white} />
    </Pressable>
  );
}

// The four tab-root route names the pill shows on — every stack's own
// `Home` screen, and nothing pushed under it (see `showInstitutionPill`).
const TAB_ROOT_ROUTE_NAMES = new Set([
  'CatalogueHome',
  'SearchHome',
  'LibraryHome',
  'ProfileHome',
]);

// EVERY PUSHED SCREEN'S HEADER NAMES WHERE "BACK" RETURNS TO, NOT ITSELF —
// on explicit request, so the title beside the chevron reads the way a
// native iOS back button does. This custom header has only one text slot
// there (no separate back-label and centred current-title, the way a native
// header splits them), so that slot has to pick one job, and this makes it
// "where back goes" for every push. `back.title` is React Navigation's own
// resolved title for whichever screen is actually underneath on THIS push.
// `options.title` (each screen's own registered title, e.g. "Item Details"
// or a route param like a book's title) is now only the fallback for the
// one case `back` cannot cover: no previous screen in the stack — a tab
// root, or a screen pushed directly onto the root stack with nothing under
// it. `ItemDetail` used to be the one screen special-cased this way, because
// it is reachable from several different screens and a fixed "Item
// Details" label could not say which one "back" returns to — that
// reasoning now applies uniformly rather than just to the one screen it was
// first solved for.
function pushedScreenHeaderTitle(
  routeName: string,
  options: NativeStackHeaderProps['options'],
  back: NativeStackHeaderProps['back'],
) {
  if (back?.title !== undefined) return back.title;
  return options.title ?? routeName;
}

function AppHeader({ route, options, back, navigation }: NativeStackHeaderProps) {
  const insets = useSafeAreaInsets();
  const selectedInstitution = useInstitutionStore((s) => s.selectedInstitution);

  const showInstitutionPill =
    back === undefined && TAB_ROOT_ROUTE_NAMES.has(route.name) && selectedInstitution !== null;

  return (
    <TopAppBar
      title={pushedScreenHeaderTitle(route.name, options, back)}
      onBack={back ? navigation.goBack : undefined}
      topInset={insets.top}
      action={
        showInstitutionPill ? (
          <InstitutionPill
            name={selectedInstitution.name}
            // `AppHeader` serves all four tab stacks, so `navigation` here is
            // typed against the generic base param list. Each of the four
            // stacks registers its own `InstitutionList` screen with the
            // identical `undefined` param shape (see `types.ts`), so a cast
            // against that one shared shape is valid for whichever stack this
            // instance actually renders inside — `showInstitutionPill` above
            // already restricts this branch to a tab root.
            onPress={() =>
              (navigation as NativeStackNavigationProp<{ InstitutionList: undefined }>).navigate(
                'InstitutionList',
              )
            }
          />
        ) : undefined
      }
    />
  );
}

// ─── Tab bar wrapper — bridges React Navigation props to BottomTabBar ─────────

// Screens that own their own navigation/action chrome rather than the shared
// four-tab shell — a detail page, not one of Catalogue/Search/Library/Profile
// — hide it by calling `navigation.getParent()?.setOptions({ tabBarStyle:
// { display: 'none' } })` on mount and restoring it on unmount (see
// ItemDetailScreen.tsx). That is the ONLY reliable trigger: `state` (a plain
// nested-navigation push, no `setOptions` call) does NOT re-render this
// custom tabBar — confirmed by instrumenting it directly, not assumed —
// whereas a screen's own `setOptions` call always does, because it is a real
// navigation action dispatched through context rather than a state field the
// tabBar happens to read. `descriptors[route.key].options` is where that
// per-screen option lands; `getFocusedRouteNameFromRoute` was the wrong tool
// for this specific job even though it is the right one for setting a STATIC
// `tabBarStyle` in a `Tab.Screen`'s own `options` — this app's `AppTabBar` is
// fully custom and does not consult that option at all on its own.
function AppTabBar({ state, navigation, insets, descriptors }: RNBottomTabBarProps) {
  const activeRoute = state.routes[state.index];
  const activeKey = activeRoute?.name ?? 'Catalogue';
  const hidden = activeRoute !== undefined && descriptors[activeRoute.key]?.options.tabBarStyle !== undefined;

  if (hidden) {
    return null;
  }

  return (
    <BottomTabBar
      tabs={TAB_CONFIG}
      activeKey={activeKey}
      onTabPress={(key) => navigation.navigate(key)}
      bottomInset={insets.bottom}
    />
  );
}

// ─── Nested stack navigators ─────────────────────────────────────────────────

function CatalogueNavigator() {
  return (
    <CatalogueStack.Navigator screenOptions={{ header: (props) => <AppHeader {...props} /> }}>
      <CatalogueStack.Screen
        name="CatalogueHome"
        component={CatalogueHomeScreen}
        options={{ title: 'Taylor & Francis' }}
      />
      <CatalogueStack.Screen
        name="InstitutionDetail"
        component={InstitutionDetailScreen}
        options={{ title: 'Institution' }}
      />
      {/* The header shows where "back" returns to, not this title — see
          `pushedScreenHeaderTitle`'s own comment above. `title` here is only
          the fallback for no previous screen, and it stays work-type-
          agnostic on purpose: a book, a journal article and an audiobook all
          push this same route, and 'Book Details' used to stay on screen for
          an audiobook (only 'article' ever narrowed it, to 'Article
          Details') even though nothing here is a book. See
          ItemDetailScreen.tsx's own header for the shared route reasoning. */}
      <CatalogueStack.Screen
        name="ItemDetail"
        component={ItemDetailScreen}
        options={{ title: 'Item Details' }}
      />
      <CatalogueStack.Screen
        name="InstitutionList"
        component={InstitutionListScreen}
        options={{ title: 'Change institution' }}
      />
      <CatalogueStack.Screen
        name="Shelf"
        component={ShelfScreen}
        options={({ route }) => ({ title: route.params.title })}
      />
      {/* 'fade', not 'slide_from_bottom' — the sheet's navy backdrop is part of
          this screen, so a slide animation would translate the backdrop along
          with the sheet, reading as a dark tint wiping up from the bottom.
          The sheet still slides up on its own — see its Animated.View. */}
      <CatalogueStack.Screen
        name="SignIn"
        component={SignInScreen}
        options={{ presentation: 'transparentModal', animation: 'fade', headerShown: false }}
      />
      <CatalogueStack.Screen
        name="AccessGate"
        component={AccessGateScreen}
        options={{ presentation: 'transparentModal', animation: 'fade', headerShown: false }}
      />
      <CatalogueStack.Screen
        name="PersonalAccount"
        component={PersonalAccountScreen}
        options={({ route }) => ({ title: personalAccountTitle(route.params.mode) })}
      />
      {/* Reader engine integration seam — the screen sets its own header title via
          navigation.setOptions (depends on the route's `format` param, not known here), so this
          keeps the stack's own AppHeader rather than hiding it. `gestureEnabled: false` per
          integration_ref.md: native-stack's default edge-swipe-back can conflict with the WebView's
          own internal gesture recognizer — see ReaderRouteScreen.tsx's own note. */}
      <CatalogueStack.Screen
        name="Reader"
        component={ReaderRouteScreen}
        options={{ gestureEnabled: false }}
      />
      {/* headerShown: false + presentation: 'modal': this screen adds its own close control
          rather than relying on native-stack's default header back button. */}
      <CatalogueStack.Screen
        name="BookInfo"
        component={BookInfoRouteScreen}
        options={{ headerShown: false, presentation: 'modal' }}
      />
      {/* AUDIO's own destination — see ItemDetailScreen's 'read'/'play' branch
          and AudioPlayerRouteScreen.tsx's own header for why this is a
          separate route from 'Reader' rather than a format branch inside it.
          Title comes from the route param (the book's own title), the same
          pattern `Shelf`/`PersonalAccount` already use for a per-push title
          the stack registration cannot know ahead of time. No gesture/WebView
          conflict here (a native player, not a WebView), so this keeps
          native-stack's default swipe-back unlike 'Reader'. */}
      <CatalogueStack.Screen
        name="AudioPlayer"
        component={AudioPlayerRouteScreen}
        options={({ route }) => ({ title: route.params.title })}
      />
    </CatalogueStack.Navigator>
  );
}

function SearchNavigator() {
  return (
    <SearchStack.Navigator screenOptions={{ header: (props) => <AppHeader {...props} /> }}>
      <SearchStack.Screen
        name="SearchHome"
        component={SearchScreen}
        options={{ title: 'Search' }}
      />
      {/* See CatalogueNavigator's identical registration for why the title
          here is only the default. */}
      <SearchStack.Screen
        name="ItemDetail"
        component={ItemDetailScreen}
        options={{ title: 'Item Details' }}
      />
      <SearchStack.Screen
        name="AccessGate"
        component={AccessGateScreen}
        options={{ presentation: 'transparentModal', animation: 'fade', headerShown: false }}
      />
      <SearchStack.Screen
        name="SignIn"
        component={SignInScreen}
        options={{ presentation: 'transparentModal', animation: 'fade', headerShown: false }}
      />
      <SearchStack.Screen
        name="InstitutionList"
        component={InstitutionListScreen}
        options={{ title: 'Change institution' }}
      />
      <SearchStack.Screen
        name="PersonalAccount"
        component={PersonalAccountScreen}
        options={({ route }) => ({ title: personalAccountTitle(route.params.mode) })}
      />
      {/* Same reader engine seam as CatalogueNavigator.Reader — see its own comment there. */}
      <SearchStack.Screen
        name="Reader"
        component={ReaderRouteScreen}
        options={{ gestureEnabled: false }}
      />
      <SearchStack.Screen
        name="BookInfo"
        component={BookInfoRouteScreen}
        options={{ headerShown: false, presentation: 'modal' }}
      />
      {/* Same reader engine seam as CatalogueNavigator.AudioPlayer — see its own comment there. */}
      <SearchStack.Screen
        name="AudioPlayer"
        component={AudioPlayerRouteScreen}
        options={({ route }) => ({ title: route.params.title })}
      />
    </SearchStack.Navigator>
  );
}

function LibraryNavigator() {
  return (
    <LibraryStack.Navigator screenOptions={{ header: (props) => <AppHeader {...props} /> }}>
      <LibraryStack.Screen
        name="LibraryHome"
        component={LibraryScreen}
        options={{ title: 'Library' }}
      />
      <LibraryStack.Screen
        name="InstitutionList"
        component={InstitutionListScreen}
        options={{ title: 'Change institution' }}
      />
      {/* See CatalogueNavigator's identical registration for why the title
          here is only the default. */}
      <LibraryStack.Screen
        name="ItemDetail"
        component={ItemDetailScreen}
        options={{ title: 'Item Details' }}
      />
      {/* AccessGate/SignIn/PersonalAccount/Reader/BookInfo — same reason as
          SearchNavigator's identical set: `ItemDetail`'s access check and its
          "read"/"play" action push these directly, so whichever stack pushed
          `ItemDetail` needs its own copies rather than reaching across tabs. */}
      <LibraryStack.Screen
        name="AccessGate"
        component={AccessGateScreen}
        options={{ presentation: 'transparentModal', animation: 'fade', headerShown: false }}
      />
      <LibraryStack.Screen
        name="SignIn"
        component={SignInScreen}
        options={{ presentation: 'transparentModal', animation: 'fade', headerShown: false }}
      />
      <LibraryStack.Screen
        name="PersonalAccount"
        component={PersonalAccountScreen}
        options={({ route }) => ({ title: personalAccountTitle(route.params.mode) })}
      />
      {/* Same reader engine seam as CatalogueNavigator.Reader — see its own comment there. */}
      <LibraryStack.Screen
        name="Reader"
        component={ReaderRouteScreen}
        options={{ gestureEnabled: false }}
      />
      <LibraryStack.Screen
        name="BookInfo"
        component={BookInfoRouteScreen}
        options={{ headerShown: false, presentation: 'modal' }}
      />
      {/* Same reader engine seam as CatalogueNavigator.AudioPlayer — see its own comment there. */}
      <LibraryStack.Screen
        name="AudioPlayer"
        component={AudioPlayerRouteScreen}
        options={({ route }) => ({ title: route.params.title })}
      />
    </LibraryStack.Navigator>
  );
}

function ProfileNavigator() {
  return (
    <ProfileStack.Navigator screenOptions={{ header: (props) => <AppHeader {...props} /> }}>
      <ProfileStack.Screen
        name="ProfileHome"
        component={ProfileScreen}
        options={{ title: 'Profile' }}
      />
      {/* Pushed from the "Reading Preferences" row on screen 10. `title` here
          is now only the no-back fallback — see `pushedScreenHeaderTitle`'s
          own comment — since the header actually shown names "Profile", the
          screen back returns to. `AppHeader` supplies the back chevron
          because this is a pushed screen rather than a tab root. */}
      <ProfileStack.Screen
        name="ReaderPreferences"
        component={ReaderPreferencesScreen}
        options={{ title: 'Reading Preferences' }}
      />
      {/* Pushed from the "Accessibility" row on screen 10, beside Reading
          Preferences rather than inside it — see the header comment on
          AccessibilityScreen.tsx for why the two are separate destinations. */}
      <ProfileStack.Screen
        name="Accessibility"
        component={AccessibilityScreen}
        options={{ title: 'Accessibility' }}
      />
      {/* The signed-out sign-in flow. All four are registered here rather than
          reused from Catalogue so the reader stays on the Profile tab they
          started from — see the note on ProfileStackParamList. */}
      <ProfileStack.Screen
        name="SignInMethod"
        component={SignInMethodScreen}
        options={{ title: 'Sign in' }}
      />
      <ProfileStack.Screen
        name="PersonalAccount"
        component={PersonalAccountScreen}
        options={({ route }) => ({ title: personalAccountTitle(route.params.mode) })}
      />
      <ProfileStack.Screen
        name="InstitutionList"
        component={InstitutionListScreen}
        options={{ title: 'Change institution' }}
      />
      <ProfileStack.Screen
        name="SignIn"
        component={SignInScreen}
        options={{ presentation: 'transparentModal', animation: 'fade', headerShown: false }}
      />
    </ProfileStack.Navigator>
  );
}

// ─── Bottom tab navigator ─────────────────────────────────────────────────────

function TabNavigator() {
  return (
    <Tab.Navigator
      tabBar={(props) => <AppTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tab.Screen name="Catalogue" component={CatalogueNavigator} />
      <Tab.Screen name="Search" component={SearchNavigator} />
      <Tab.Screen name="Library" component={LibraryNavigator} />
      <Tab.Screen name="Profile" component={ProfileNavigator} />
    </Tab.Navigator>
  );
}

// ─── Root navigator (wraps tabs + Gallery modal) ──────────────────────────────

export default function RootNavigator() {
  const hasHydrated = useInstitutionStore((s) => s._hasHydrated);
  const authReady = useSessionStore((s) => s._authReady);

  if (!hasHydrated || !authReady) {
    return <View style={styles.splash} />;
  }

  return (
    <View style={styles.root}>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        <RootStack.Screen name="Main" component={TabNavigator} />
        <RootStack.Screen
          name="Gallery"
          component={GalleryScreen}
          options={{
            headerShown: true,
            header: (props) => <AppHeader {...props} />,
            title: 'State Gallery',
          }}
        />
      </RootStack.Navigator>
      {/* D16 — global queue-offer banner. Sits above every screen so an offer is
          answerable from wherever the reader is, not only from the item's own
          detail screen. See QueueNotificationHost for why it lives here. */}
      <QueueNotificationHost />
    </View>
  );
}
